'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readUserScript, runUserScript } = require('./helpers/userscript-harness');

const SCRIPT_FILE = 'gemini-fixed-mode.user.js';

/**
 * 建立具有指定顯示模式的 Gemini 切換按鈕。
 *
 * @param {string} modeName 按鈕目前顯示的模式名稱。
 * @returns {object} 可記錄點擊並回傳模式標籤的按鈕 stub；呼叫 click 時會累加次數。
 */
function createSwitchButton(modeName) {
  return {
    clickCount: 0,
    click() {
      this.clickCount += 1;
    },
    querySelector(selector) {
      assert.equal(selector, '.input-area-switch-label span');
      return { textContent: modeName };
    },
  };
}

/**
 * 在最小 Gemini DOM／GM 環境執行正式 userscript，並保留 observer、timer 與選單狀態。
 *
 * @param {{ savedMode?: string, buttonModeName?: string | null }} [options={}] 儲存模式及初始切換按鈕模式。
 * @returns {object} 測試操作介面；建立時會註冊正式腳本的選單、observer、timer 與卸載事件。
 */
function createEnvironment(options = {}) {
  let switchButton = options.buttonModeName == null
    ? null
    : createSwitchButton(options.buttonModeName);
  let selectedMode = options.savedMode ?? 'pro';
  let nextMenuId = 1;
  let nextTimerId = 1;

  const menuRegistrations = [];
  const observers = [];
  const timers = new Map();
  const clearedTimerIds = [];
  const windowListeners = new Map();

  const body = {
    clickCount: 0,
    click() {
      this.clickCount += 1;
    },
    appendChild() {},
  };
  const head = { appendChild() {} };
  const documentElement = { appendChild() {} };

  const documentStub = {
    body,
    head,
    documentElement,
    querySelector(selector) {
      if (selector === 'button.input-area-switch') return switchButton;
      if (selector === '.ql-editor[contenteditable="true"]') return null;
      if (selector.startsWith('[data-test-id=')) return null;
      return null;
    },
    getElementById() {
      return null;
    },
    createElement(tagName) {
      return {
        tagName: tagName.toUpperCase(),
        id: '',
        textContent: '',
        remove() {},
      };
    },
  };

  /** 記錄監聽、斷線及手動 mutation 觸發行為。 */
  class FakeMutationObserver {
    /**
     * @param {(mutations: Array<object>) => void} callback DOM 變動回呼。
     */
    constructor(callback) {
      this.callback = callback;
      this.observeCalls = [];
      this.disconnected = false;
      observers.push(this);
    }

    /**
     * 記錄監聽目標與選項。
     *
     * @param {object} target 監聽目標。
     * @param {MutationObserverInit} observerOptions 監聽選項。
     * @returns {void} 無回傳值；副作用是新增監聽紀錄。
     */
    observe(target, observerOptions) {
      this.observeCalls.push({ target, observerOptions });
      this.disconnected = false;
    }

    /**
     * 標記 observer 已中止。
     *
     * @returns {void} 無回傳值；副作用是更新斷線狀態。
     */
    disconnect() {
      this.disconnected = true;
    }

    /**
     * 將 mutation records 同步交給正式 callback。
     *
     * @param {Array<object>} mutations 要模擬的 DOM 變動。
     * @returns {void} 無回傳值；副作用由正式 callback 決定。
     */
    emit(mutations) {
      if (!this.disconnected) this.callback(mutations);
    }
  }

  /**
   * 建立可由測試手動觸發的計時器。
   *
   * @param {Function} callback 到期回呼。
   * @param {number} [delay=0] 延遲毫秒數。
   * @returns {number} 計時器識別碼。
   */
  function setTimeoutStub(callback, delay = 0) {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, { callback, delay });
    return id;
  }

  /**
   * 清除指定計時器並記錄清理行為。
   *
   * @param {number | null} id 計時器識別碼。
   * @returns {void} 無回傳值；副作用是移除計時器及保存清理紀錄。
   */
  function clearTimeoutStub(id) {
    clearedTimerIds.push(id);
    timers.delete(id);
  }

  const location = { href: 'https://gemini.google.com/app/example' };
  const windowStub = {
    location,
    addEventListener(type, callback) {
      const callbacks = windowListeners.get(type) ?? [];
      callbacks.push(callback);
      windowListeners.set(type, callbacks);
    },
    removeEventListener(type, callback) {
      const callbacks = windowListeners.get(type) ?? [];
      windowListeners.set(type, callbacks.filter((registered) => registered !== callback));
    },
  };

  runUserScript(SCRIPT_FILE, {
    window: windowStub,
    location,
    document: documentStub,
    MutationObserver: FakeMutationObserver,
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimeoutStub,
    console: { log() {}, error() {} },
    GM_getValue(key, fallback) {
      return key === 'selectedMode' ? selectedMode : fallback;
    },
    GM_setValue(key, value) {
      assert.equal(key, 'selectedMode');
      selectedMode = value;
    },
    GM_registerMenuCommand(label, callback, menuOptions) {
      const id = menuOptions?.id ?? nextMenuId;
      if (menuOptions?.id == null) nextMenuId += 1;
      menuRegistrations.push({ label, callback, menuOptions, id });
      return id;
    },
  });

  return {
    observers,
    timers,
    clearedTimerIds,
    menuRegistrations,
    setSwitchButton(modeName) {
      switchButton = createSwitchButton(modeName);
      return switchButton;
    },
    findTimerIdByDelay(delay) {
      return [...timers.entries()].find(([, timer]) => timer.delay === delay)?.[0];
    },
    runTimer(id) {
      const timer = timers.get(id);
      assert.ok(timer, `計時器 ${id} 必須存在`);
      timers.delete(id);
      timer.callback();
    },
    dispatchWindow(eventOrType) {
      const event = typeof eventOrType === 'string' ? { type: eventOrType } : eventOrType;
      (windowListeners.get(event.type) ?? []).forEach((callback) => callback(event));
    },
  };
}

test('保存 Fast 或 Thinking 時主選單標籤反映目前固定模式', () => {
  const cases = [
    ['fast', 'Fast', '🚀'],
    ['thinking', 'Thinking', '🧠'],
  ];

  cases.forEach(([savedMode, modeName, icon]) => {
    const env = createEnvironment({ savedMode, buttonModeName: modeName });
    assert.equal(env.menuRegistrations[0].label, `🔄 固定模式（${icon} ${modeName}）`);
  });
});

test('無效的保存模式會安全回退至 Pro', () => {
  const env = createEnvironment({ savedMode: 'unknown-mode', buttonModeName: 'Pro' });

  assert.equal(env.menuRegistrations[0].label, '🔄 固定模式（⭐ Pro）');
});

test('waitForElement 找到稍後出現的元素時會斷開 observer 並清除 timeout', async () => {
  const env = createEnvironment();
  const waitObserver = env.observers[1];
  const timeoutId = env.findTimerIdByDelay(5000);

  assert.ok(waitObserver);
  assert.ok(timeoutId);
  env.setSwitchButton('Pro');
  waitObserver.emit([{ addedNodes: [] }]);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(waitObserver.disconnected, true);
  assert.equal(env.timers.has(timeoutId), false);
  assert.equal(env.clearedTimerIds.includes(timeoutId), true);
});

test('waitForElement 逾時時會斷開 observer 並結束 timeout', async () => {
  const env = createEnvironment();
  const waitObserver = env.observers[1];
  const timeoutId = env.findTimerIdByDelay(5000);

  env.runTimer(timeoutId);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(waitObserver.disconnected, true);
  assert.equal(env.timers.has(timeoutId), false);
});

test('beforeunload 與 bfcache pagehide 後主 observer、debounce 與 retry 仍有效', () => {
  const env = createEnvironment();
  const mainObserver = env.observers[0];
  const elementMutation = [{ addedNodes: [{ nodeType: 1 }] }];

  mainObserver.emit(elementMutation);
  const debounceId = env.findTimerIdByDelay(300);
  assert.ok(debounceId);

  env.dispatchWindow({ type: 'beforeunload' });
  env.dispatchWindow({ type: 'pagehide', persisted: true });

  assert.equal(mainObserver.disconnected, false);
  assert.equal(env.timers.has(debounceId), true);
  env.runTimer(debounceId);
  assert.ok(env.findTimerIdByDelay(500), '續存頁面的 debounce 應能執行並建立 retry');

  mainObserver.emit(elementMutation);
  assert.ok(env.findTimerIdByDelay(300), '續存頁面的 observer 應能繼續建立 debounce');
});

test('非 bfcache pagehide 才斷開主 observer 並清除同時存在的 debounce 與 retry', () => {
  const env = createEnvironment();
  const mainObserver = env.observers[0];
  const elementMutation = [{ addedNodes: [{ nodeType: 1 }] }];

  mainObserver.emit(elementMutation);
  const firstDebounceId = env.findTimerIdByDelay(300);
  env.runTimer(firstDebounceId);
  const retryId = env.findTimerIdByDelay(500);

  mainObserver.emit(elementMutation);
  const activeDebounceId = env.findTimerIdByDelay(300);
  assert.ok(retryId);
  assert.ok(activeDebounceId);

  env.dispatchWindow({ type: 'pagehide', persisted: false });

  assert.equal(mainObserver.disconnected, true);
  assert.equal(env.timers.has(retryId), false);
  assert.equal(env.timers.has(activeDebounceId), false);
  assert.equal(env.clearedTimerIds.includes(retryId), true);
  assert.equal(env.clearedTimerIds.includes(activeDebounceId), true);
});

test('metadata description 同步列出 Pro、Fast 與 Thinking', () => {
  const source = readUserScript(SCRIPT_FILE);
  const description = source.split('\n').find((line) => line.startsWith('// @description'));

  assert.match(description, /Pro.*Fast.*Thinking/);
});

test('metadata 後包含統一 README 維護索引反向連結', () => {
  const source = readUserScript(SCRIPT_FILE);

  assert.match(source, /\/\/ 維護索引：README\.md「維護索引」/);
});
