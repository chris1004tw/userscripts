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
    nodeType: 1,
    clickCount: 0,
    matches(selector) {
      return selector === 'button.input-area-switch';
    },
    click() {
      this.clickCount += 1;
    },
    querySelector(selector) {
      if (selector === '.input-area-switch-label span') {
        return { textContent: modeName };
      }
      return null;
    },
  };
}

/**
 * 建立新版 Gemini 模式選單項目。
 *
 * @param {string} label 模式選單顯示的主標籤，可包含版本前綴。
 * @param {boolean} [hasBardModeId=true] 是否具有 `bard-mode-option-*` 舊式雜湊 ID。
 * @param {boolean} [active=false] menuitem 是否已有勾選狀態。
 * @returns {object} 可記錄點擊、切換勾選並提供 `.label` 文字的 menuitem stub。
 */
function createModeOption(label, hasBardModeId = true, active = false) {
  return {
    nodeType: 1,
    clickCount: 0,
    hasBardModeId,
    active,
    click() {
      this.clickCount += 1;
      this.active = !this.active;
    },
    getAttribute(name) {
      if (name === 'data-active' || name === 'aria-checked') return String(this.active);
      return null;
    },
    querySelector(selector) {
      return selector === '.label' ? { textContent: label } : null;
    },
  };
}

/**
 * 建立可精確模擬一般元素或含切換按鈕子樹的元素節點。
 *
 * @param {{ containsSwitchButton?: boolean }} [options={}] 是否在子樹中提供 Gemini 切換按鈕。
 * @returns {object} 僅對實際存在的切換按鈕選擇器回報匹配的元素 stub。
 */
function createElementNode(options = {}) {
  const descendantSwitchButton = options.containsSwitchButton
    ? createSwitchButton('Pro')
    : null;

  return {
    nodeType: 1,
    matches() {
      return false;
    },
    querySelector(selector) {
      if (selector === 'button.input-area-switch') return descendantSwitchButton;
      return null;
    },
  };
}

/**
 * 在最小 Gemini DOM／GM 環境執行正式 userscript，並保留 observer、timer 與選單狀態。
 *
 * @param {{ savedMode?: string, savedThinking?: boolean, thinkingActive?: boolean, buttonModeName?: string | null, modeOptionLabels?: string[], roleOnlyModeOptionLabels?: string[], isIframe?: boolean }} [options={}] 儲存模式、延伸思考設定／實際勾選、初始按鈕／選單及 frame 執行環境。
 * @returns {object} 測試操作介面；頂層建立模型／思考選單、observer、timer 與卸載事件，並以 `switchButton()` 讀取目前按鈕，iframe 應完全不註冊。
 */
function createEnvironment(options = {}) {
  let switchButton = options.buttonModeName == null
    ? null
    : createSwitchButton(options.buttonModeName);
  const createConfiguredOption = (label, hasBardModeId) => createModeOption(
    label,
    hasBardModeId,
    /^(?:延伸思考|extended thinking|thinking)$/i.test(label) && options.thinkingActive === true,
  );
  const modeOptions = [
    ...(options.modeOptionLabels || []).map(label => createConfiguredOption(label, true)),
    ...(options.roleOnlyModeOptionLabels || []).map(label => createConfiguredOption(label, false)),
  ];
  let selectedMode = options.savedMode ?? 'pro';
  let extendedThinking = options.savedThinking ?? false;
  let nextMenuId = 1;
  let nextTimerId = 1;

  const menuRegistrations = [];
  const observers = [];
  const timers = new Map();
  const scheduledTimers = [];
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
    querySelectorAll(selector) {
      if (selector === 'gem-menu-item[data-test-id^="bard-mode-option-"]') {
        return modeOptions.filter(option => option.hasBardModeId);
      }
      if (selector === 'gem-menu-item[role="menuitem"]') return modeOptions;
      return [];
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
    scheduledTimers.push({ id, delay });
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
  const selfRealm = {};
  const topRealm = options.isIframe ? {} : selfRealm;
  const windowStub = {
    location,
    self: selfRealm,
    top: topRealm,
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
      if (key === 'selectedMode') return selectedMode;
      if (key === 'extendedThinking') return extendedThinking;
      return fallback;
    },
    GM_setValue(key, value) {
      if (key === 'selectedMode') selectedMode = value;
      else if (key === 'extendedThinking') extendedThinking = value;
      else assert.fail(`非預期的 GM key：${key}`);
    },
    GM_registerMenuCommand(label, callback, menuOptions) {
      const id = menuOptions?.id ?? nextMenuId;
      if (menuOptions?.id == null) nextMenuId += 1;
      const registration = { label, callback, menuOptions, id };
      const existingIndex = menuRegistrations.findIndex(item => item.id === id);
      if (existingIndex >= 0) menuRegistrations[existingIndex] = registration;
      else menuRegistrations.push(registration);
      return id;
    },
    GM_unregisterMenuCommand(id) {
      const existingIndex = menuRegistrations.findIndex(item => item.id === id);
      if (existingIndex >= 0) menuRegistrations.splice(existingIndex, 1);
    },
  });

  return {
    observers,
    timers,
    scheduledTimers,
    location,
    clearedTimerIds,
    menuRegistrations,
    modeOptions,
    selectedMode: () => selectedMode,
    extendedThinking: () => extendedThinking,
    switchButton: () => switchButton,
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

test('保存新版 Gemini 模型時主選單標籤反映目前固定模型', () => {
  const cases = [
    ['flash-lite', 'Flash-Lite', '⚡'],
    ['flash', 'Flash', '🚀'],
    ['pro', 'Pro', '⭐'],
  ];

  cases.forEach(([savedMode, modeName, icon]) => {
    const env = createEnvironment({ savedMode, buttonModeName: modeName });
    assert.equal(env.menuRegistrations[0].label, `🔄 固定模型（${icon} ${modeName}）`);
  });
});

test('無效的保存模式會安全回退至 Pro', () => {
  const env = createEnvironment({ savedMode: 'unknown-mode', buttonModeName: 'Pro' });

  assert.equal(env.menuRegistrations[0].label, '🔄 固定模型（⭐ Pro）');
});

test('舊 Fast 設定會一次遷移至最快的 Flash-Lite 模式', () => {
  const env = createEnvironment({ savedMode: 'fast', buttonModeName: 'Flash-Lite' });

  assert.equal(env.selectedMode(), 'flash-lite');
  assert.equal(env.menuRegistrations[0].label, '🔄 固定模型（⚡ Flash-Lite）');
});

test('模型與思考選單沿用修改前的回傳 ID 更新模式，連續操作始終維持兩列', async () => {
  const env = createEnvironment({
    savedMode: 'pro',
    savedThinking: false,
    thinkingActive: false,
    buttonModeName: 'Pro',
    modeOptionLabels: ['3.5 Flash-Lite', '3.7 Flash'],
    roleOnlyModeOptionLabels: ['延伸思考'],
  });
  for (let index = 0; index < 6; index += 1) await Promise.resolve();

  assert.equal(env.menuRegistrations.length, 2);
  for (let round = 0; round < 2; round += 1) {
    const modelMenu = env.menuRegistrations.find(({ label }) => label.startsWith('🔄 固定模型'));
    await modelMenu.callback();
    const thinkingMenu = env.menuRegistrations.find(({ label }) => label.startsWith('🧠 延伸思考'));
    await thinkingMenu.callback();
    assert.equal(
      env.menuRegistrations.length,
      2,
      `第 ${round + 1} 輪更新後只能保留模型與思考兩列`,
    );
  }
});

test('metadata 與 runtime 雙重禁止 Gemini iframe 註冊重複選單', () => {
  const source = readUserScript(SCRIPT_FILE);
  assert.match(source, /^\/\/ @noframes\s*$/m);

  const env = createEnvironment({ isIframe: true });
  assert.equal(env.menuRegistrations.length, 0);
  assert.equal(env.observers.length, 0);
  assert.equal(env.timers.size, 0);
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
  const elementMutation = [{ addedNodes: [createElementNode()] }];

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
  const elementMutation = [{ addedNodes: [createElementNode()] }];

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

test('同 URL 重試耗盡後忽略無關 mutation，新增切換按鈕才恢復 debounce', () => {
  const env = createEnvironment();
  const mainObserver = env.observers[0];
  const unchangedUrl = env.location.href;
  const unrelatedMutation = [{ addedNodes: [createElementNode()] }];

  mainObserver.emit(unrelatedMutation);
  const attemptOneDebounceId = env.findTimerIdByDelay(300);
  assert.ok(attemptOneDebounceId, 'attempt 1 應先建立 300ms debounce');
  env.runTimer(attemptOneDebounceId);

  const attemptTwoRetryId = env.findTimerIdByDelay(500);
  assert.ok(attemptTwoRetryId, '找不到按鈕時 attempt 1 應建立 attempt 2 的 500ms retry');
  env.runTimer(attemptTwoRetryId);

  const attemptThreeRetryId = env.findTimerIdByDelay(500);
  assert.ok(attemptThreeRetryId, '找不到按鈕時 attempt 2 應建立 attempt 3 的 500ms retry');
  env.runTimer(attemptThreeRetryId);

  assert.equal(env.location.href, unchangedUrl, '重試期間 URL 必須維持不變');
  assert.equal(env.findTimerIdByDelay(300), undefined);
  assert.equal(env.findTimerIdByDelay(500), undefined, 'attempt 3 後不應再建立 retry');

  const scheduledDebounceCount = env.scheduledTimers.filter(({ delay }) => delay === 300).length;
  const scheduledRetryCount = env.scheduledTimers.filter(({ delay }) => delay === 500).length;
  mainObserver.emit(unrelatedMutation);

  assert.equal(
    env.scheduledTimers.filter(({ delay }) => delay === 300).length,
    scheduledDebounceCount,
    '同 URL 耗盡後的無關元素 mutation 不應重啟 debounce',
  );
  assert.equal(
    env.scheduledTimers.filter(({ delay }) => delay === 500).length,
    scheduledRetryCount,
    '同 URL 耗盡後的無關元素 mutation 不應重啟 retry',
  );

  const directSwitchButton = createSwitchButton('Pro');
  mainObserver.emit([{ addedNodes: [directSwitchButton] }]);
  assert.equal(
    env.scheduledTimers.filter(({ delay }) => delay === 300).length,
    scheduledDebounceCount + 1,
    '新增節點本身是切換按鈕時應恢復一次 debounce',
  );

  const subtreeWithSwitchButton = createElementNode({ containsSwitchButton: true });
  mainObserver.emit([{ addedNodes: [subtreeWithSwitchButton] }]);
  assert.equal(
    env.scheduledTimers.filter(({ delay }) => delay === 300).length,
    scheduledDebounceCount + 2,
    '新增節點的 subtree 含切換按鈕時也應恢復一次 debounce',
  );
  assert.equal(
    [...env.timers.values()].filter(({ delay }) => delay === 300).length,
    1,
    '連續目標 mutation 應只保留一個 active debounce',
  );
});

test('新版 Gemini 模型以穩定 menuitem 結構與語意標籤選取，不依賴易變的雜湊 ID', async () => {
  const optionLabels = ['3.5 Flash-Lite', '3.7 Flash', '3.1 Pro', '延伸思考'];
  const cases = [
    ['flash-lite', '3.5 Flash-Lite'],
    ['flash', '3.7 Flash'],
    ['pro', '3.1 Pro'],
  ];

  for (const [savedMode, expectedLabel] of cases) {
    const env = createEnvironment({
      savedMode,
      buttonModeName: '尚未切換',
      modeOptionLabels: optionLabels,
    });
    for (let index = 0; index < 6; index += 1) await Promise.resolve();

    const clickedLabels = env.modeOptions
      .filter((option) => option.clickCount === 1)
      .map((option) => option.querySelector('.label').textContent);
    assert.deepEqual(clickedLabels, [expectedLabel]);
  }
});

test('固定模型從 Pro 循環時會回到 Flash-Lite，而不把延伸思考當成模型', async () => {
  const env = createEnvironment({
    savedMode: 'pro',
    buttonModeName: 'Pro',
    modeOptionLabels: ['3.5 Flash-Lite'],
    roleOnlyModeOptionLabels: ['延伸思考'],
  });
  await Promise.resolve();
  await Promise.resolve();

  const cyclePromise = env.menuRegistrations[0].callback();
  for (let index = 0; index < 6; index += 1) await Promise.resolve();

  assert.equal(env.modeOptions[0].clickCount, 1, 'Pro 的下一個固定模型須為 Flash-Lite');
  assert.equal(env.modeOptions[1].clickCount, 0, '模型循環不得點擊延伸思考');
  await cyclePromise;
  assert.equal(env.selectedMode(), 'flash-lite');
});

test('延伸思考以獨立 Tampermonkey 選單切換並保存勾選狀態', async () => {
  for (const [savedThinking, thinkingActive, expectedThinking, expectedLabel] of [
    [false, false, true, '🧠 延伸思考（開啟）'],
    [true, true, false, '🧠 延伸思考（關閉）'],
  ]) {
    const env = createEnvironment({
      savedMode: 'pro',
      savedThinking,
      thinkingActive,
      buttonModeName: 'Pro',
      roleOnlyModeOptionLabels: ['延伸思考'],
    });
    for (let index = 0; index < 6; index += 1) await Promise.resolve();

    const thinkingMenu = env.menuRegistrations.find(({ label }) => label.startsWith('🧠 延伸思考'));
    assert.ok(thinkingMenu, '須註冊獨立的延伸思考選單');
    await thinkingMenu.callback();

    assert.equal(env.modeOptions[0].clickCount, 1);
    assert.equal(env.extendedThinking(), expectedThinking);
    assert.equal(env.menuRegistrations.at(-1).label, expectedLabel);
  }
});

test('初始載入與 DOM debounce 同一輪只同步一次延伸思考', async () => {
  const env = createEnvironment({
    savedMode: 'pro',
    savedThinking: true,
    thinkingActive: false,
    buttonModeName: null,
    roleOnlyModeOptionLabels: ['延伸思考'],
  });
  const mainObserver = env.observers[0];
  const initialWaitObserver = env.observers[1];
  const switchButton = env.setSwitchButton('Pro');

  mainObserver.emit([{ addedNodes: [switchButton] }]);
  const debounceId = env.findTimerIdByDelay(300);
  assert.ok(debounceId, '新增切換按鈕應建立 DOM debounce');

  initialWaitObserver.emit([{ addedNodes: [switchButton] }]);
  for (let index = 0; index < 8; index += 1) await Promise.resolve();

  assert.equal(env.switchButton().clickCount, 1, '初始 wait 只應開啟一次 mode picker');
  assert.equal(env.modeOptions[0].clickCount, 1, '初始 wait 只應同步一次延伸思考');

  env.runTimer(debounceId);
  for (let index = 0; index < 4; index += 1) await Promise.resolve();

  assert.equal(env.switchButton().clickCount, 1, '同一輪 DOM debounce 不得再次開啟 mode picker');
  assert.equal(env.modeOptions[0].clickCount, 1, '同一輪 DOM debounce 不得再次同步延伸思考');
  env.location.href = 'https://gemini.google.com/app/next';
  mainObserver.emit([{ addedNodes: [switchButton] }]);
  const spaDebounceId = env.findTimerIdByDelay(300);
  assert.ok(spaDebounceId, 'SPA 導覽應建立新的 DOM debounce');
  env.runTimer(spaDebounceId);
  for (let index = 0; index < 4; index += 1) await Promise.resolve();

  assert.equal(env.switchButton().clickCount, 2, 'SPA 每次自動 attempt 只應開啟一次 mode picker');
  assert.equal(env.modeOptions[0].clickCount, 1, 'SPA 每次自動 attempt 只應同步一次延伸思考');
});

test('自動流程找不到延伸思考選項時開關狀態都必須失敗並保留三次重試', async () => {
  for (const savedThinking of [false, true]) {
    const env = createEnvironment({
      savedMode: 'pro',
      savedThinking,
      buttonModeName: 'Pro',
    });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const thinkingTimeoutId = env.findTimerIdByDelay(1000);
      assert.ok(thinkingTimeoutId, `第 ${attempt} 次嘗試應等待延伸思考選項`);
      env.runTimer(thinkingTimeoutId);
      for (let index = 0; index < 8; index += 1) await Promise.resolve();

      if (attempt < 3) {
        const retryId = env.findTimerIdByDelay(500);
        assert.ok(retryId, `第 ${attempt} 次失敗後應排程下一次重試`);
        env.runTimer(retryId);
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
      }
    }

    assert.equal(env.switchButton().clickCount, 3, '找不到選項時應恰好執行三次自動嘗試');
    assert.equal(
      env.scheduledTimers.filter(({ delay }) => delay === 500).length,
      2,
      '三次上限內只能排程兩次 retry',
    );
    assert.equal(env.findTimerIdByDelay(500), undefined, '第三次失敗後不得再排程 retry');
    assert.equal(env.extendedThinking(), savedThinking, '自動失敗不得改寫保存的思考狀態');
  }
});

test('手動切換找不到延伸思考選項時不保存錯誤狀態', async () => {
  for (const savedThinking of [false, true]) {
    const env = createEnvironment({
      savedMode: 'pro',
      savedThinking,
      buttonModeName: null,
    });
    const thinkingMenu = env.menuRegistrations.find(({ label }) => label.startsWith('🧠 延伸思考'));
    env.setSwitchButton('Pro');

    const togglePromise = thinkingMenu.callback();
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    const thinkingTimeoutId = env.findTimerIdByDelay(1000);
    assert.ok(thinkingTimeoutId, '手動同步應等待延伸思考選項');
    env.runTimer(thinkingTimeoutId);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await togglePromise;

    assert.equal(env.extendedThinking(), savedThinking, '手動失敗不得保存錯誤狀態');
    assert.equal(
      env.menuRegistrations.find(({ label }) => label.startsWith('🧠 延伸思考')).label,
      `🧠 延伸思考（${savedThinking ? '開啟' : '關閉'}）`,
      '手動失敗不得更新思考選單標籤',
    );
  }
});

test('初始載入會把保存的延伸思考設定同步到實際勾選', async () => {
  const env = createEnvironment({
    savedMode: 'pro',
    savedThinking: true,
    thinkingActive: false,
    buttonModeName: 'Pro',
    roleOnlyModeOptionLabels: ['延伸思考'],
  });
  for (let index = 0; index < 8; index += 1) await Promise.resolve();

  assert.equal(env.modeOptions[0].clickCount, 1);
  assert.equal(env.modeOptions[0].active, true);
});

test('metadata description 同步列出三種模型與獨立延伸思考開關', () => {
  const source = readUserScript(SCRIPT_FILE);
  const description = source.split('\n').find((line) => line.startsWith('// @description'));

  assert.match(description, /Flash-Lite.*Flash.*Pro.*延伸思考/);
});

test('metadata 後包含統一 README 維護索引反向連結', () => {
  const source = readUserScript(SCRIPT_FILE);

  assert.match(source, /\/\/ 維護索引：README\.md「維護索引」/);
});
