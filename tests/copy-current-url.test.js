'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readUserScript,
  runUserScript,
} = require('./helpers/userscript-harness');

/** @typedef {{ callback: (...args: unknown[]) => void, delay: number }} ScheduledTimeout */

/**
 * 建立可由測試精確推進的 timeout 與 animation frame 排程器。
 *
 * @returns {{
 *   setTimeout: (callback: (...args: unknown[]) => void, delay?: number) => number,
 *   clearTimeout: (id: number) => void,
 *   requestAnimationFrame: (callback: (timestamp: number) => void) => number,
 *   cancelAnimationFrame: (id: number) => void,
 *   runTimeoutByDelay: (delay: number) => boolean,
 *   runNextAnimationFrame: () => boolean,
 *   timeoutIdsByDelay: (delay: number) => number[],
 *   activeTimeoutCount: () => number,
 *   activeAnimationFrameCount: () => number,
 * }} 排程器 API；所有副作用都保留在測試個案內。
 */
function createScheduler() {
  let nextId = 1;
  /** @type {Map<number, ScheduledTimeout>} */
  const timeouts = new Map();
  /** @type {Map<number, (timestamp: number) => void>} */
  const animationFrames = new Map();

  return {
    setTimeout: (callback, delay = 0) => {
      const id = nextId++;
      timeouts.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => {
      timeouts.delete(id);
    },
    requestAnimationFrame: (callback) => {
      const id = nextId++;
      animationFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => {
      animationFrames.delete(id);
    },
    runTimeoutByDelay: (delay) => {
      const entry = [...timeouts.entries()].find(([, timeout]) => timeout.delay === delay);
      if (!entry) return false;

      const [id, timeout] = entry;
      timeouts.delete(id);
      timeout.callback();
      return true;
    },
    runNextAnimationFrame: () => {
      const entry = animationFrames.entries().next().value;
      if (!entry) return false;

      const [id, callback] = entry;
      animationFrames.delete(id);
      callback(0);
      return true;
    },
    timeoutIdsByDelay: (delay) => [...timeouts.entries()]
      .filter(([, timeout]) => timeout.delay === delay)
      .map(([id]) => id),
    activeTimeoutCount: () => timeouts.size,
    activeAnimationFrameCount: () => animationFrames.size,
  };
}

/**
 * 建立支援 add/remove/dispatch 的最小事件目標。
 *
 * @returns {{
 *   addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => void,
 *   removeEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => void,
 *   dispatchEvent: (event: Record<string, unknown>) => boolean,
 * }} 事件目標；派送事件時會同步呼叫目前註冊的監聽器。
 */
function createEventTarget() {
  /** @type {Map<string, Set<(event: Record<string, unknown>) => void>>} */
  const listeners = new Map();

  return {
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event) => {
      for (const listener of listeners.get(String(event.type)) || []) {
        listener(event);
      }
      return true;
    },
  };
}

/**
 * 判斷最小 DOM 元素是否符合本腳本使用的選擇器。
 *
 * @param {FakeElement} element 要比對的元素。
 * @param {string} selector CSS 選擇器，僅實作受測腳本實際使用的形式。
 * @returns {boolean} 元素符合任一逗號分隔選擇器時回傳 true。
 */
function elementMatches(element, selector) {
  return selector.split(',').some((part) => {
    const normalized = part.trim();
    if (normalized === '*') return true;
    if (normalized === 'article') return element.tagName === 'ARTICLE';
    if (normalized === 'div[role="group"]') {
      return element.tagName === 'DIV' && element.attributes.get('role') === 'group';
    }

    const testIdMatch = normalized.match(/^\[data-testid="([^"]+)"\]$/);
    if (testIdMatch) return element.attributes.get('data-testid') === testIdMatch[1];
    return false;
  });
}

/**
 * 遞迴同步元素及其後代的連線狀態。
 *
 * @param {FakeElement} element 要更新的根元素。
 * @param {boolean} isConnected 是否連接至 document。
 * @returns {void} 無回傳值；會修改根元素與全部後代的 isConnected。
 */
function setConnected(element, isConnected) {
  element.isConnected = isConnected;
  element.children.forEach((child) => setConnected(child, isConnected));
}

/**
 * @typedef {{
 *   nodeType: number,
 *   tagName: string,
 *   id: string,
 *   textContent: string,
 *   type: string,
 *   parentNode: FakeElement | null,
 *   children: FakeElement[],
 *   attributes: Map<string, string>,
 *   style: Record<string, string>,
 *   isConnected: boolean,
 *   firstElementChild: FakeElement | null,
 *   nextElementSibling: FakeElement | null,
 *   setAttribute: (name: string, value: string) => void,
 *   appendChild: (child: FakeElement) => FakeElement,
 *   remove: () => void,
 *   contains: (target: FakeElement) => boolean,
 *   matches: (selector: string) => boolean,
 *   closest: (selector: string) => FakeElement | null,
 *   querySelector: (selector: string) => FakeElement | null,
 *   querySelectorAll: (selector: string) => FakeElement[],
 *   addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => void,
 *   removeEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => void,
 *   dispatchEvent: (event: Record<string, unknown>) => boolean,
 * }} FakeElement
 */

/**
 * 建立足以執行 Copy URL userscript 的最小 DOM 元素。
 *
 * @param {string} tagName 元素標籤名稱。
 * @returns {FakeElement} 可查詢、掛載與派送事件的元素；掛載會同步連線狀態。
 */
function createElement(tagName) {
  const eventTarget = createEventTarget();
  /** @type {FakeElement} */
  const element = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    id: '',
    textContent: '',
    type: '',
    parentNode: null,
    children: [],
    attributes: new Map(),
    style: {},
    isConnected: false,
    get firstElementChild() {
      return element.children[0] ?? null;
    },
    get nextElementSibling() {
      if (!element.parentNode) return null;
      const siblings = element.parentNode.children;
      const index = siblings.indexOf(element);
      return index >= 0 ? (siblings[index + 1] ?? null) : null;
    },
    setAttribute: (name, value) => {
      element.attributes.set(name, String(value));
      if (name === 'id') element.id = String(value);
    },
    appendChild: (child) => {
      child.remove();
      element.children.push(child);
      child.parentNode = element;
      setConnected(child, element.isConnected);
      return child;
    },
    remove: () => {
      if (element.parentNode) {
        const index = element.parentNode.children.indexOf(element);
        if (index >= 0) element.parentNode.children.splice(index, 1);
      }
      element.parentNode = null;
      setConnected(element, false);
    },
    contains: (target) => target === element || element.children.some((child) => child.contains(target)),
    matches: (selector) => elementMatches(element, selector),
    closest: (selector) => {
      let current = element;
      while (current) {
        if (current.matches(selector)) return current;
        current = current.parentNode;
      }
      return null;
    },
    querySelector: (selector) => element.querySelectorAll(selector)[0] || null,
    querySelectorAll: (selector) => {
      const matches = [];
      /** @param {FakeElement} parent 目前走訪的父元素。 */
      const visit = (parent) => {
        for (const child of parent.children) {
          if (child.matches(selector)) matches.push(child);
          visit(child);
        }
      };
      visit(element);
      return matches;
    },
    ...eventTarget,
  };
  return element;
}

/**
 * 建立包含 document、window、observer 與剪貼簿 stub 的隔離瀏覽器環境。
 *
 * @param {string} url 測試頁面網址。
 * @returns {{
 *   sandbox: Record<string, unknown>,
 *   document: FakeElement & Record<string, unknown>,
 *   window: Record<string, unknown>,
 *   scheduler: ReturnType<typeof createScheduler>,
 *   observers: Array<Record<string, unknown>>,
 *   clipboardWrites: Array<{ value: string, type: string }>,
 * }} 測試環境；執行 userscript 後可從回傳物件觀察所有副作用。
 */
function createBrowserEnvironment(url) {
  const scheduler = createScheduler();
  const documentEvents = createEventTarget();
  const windowEvents = createEventTarget();
  const documentElement = createElement('html');
  const head = createElement('head');
  const body = createElement('body');
  documentElement.isConnected = true;
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const document = {
    ...documentEvents,
    nodeType: 9,
    documentElement,
    head,
    body,
    createElement,
    createElementNS: (_namespace, tagName) => createElement(tagName),
    getElementById: (id) => {
      if (documentElement.id === id) return documentElement;
      return documentElement.querySelectorAll('*').find((element) => element.id === id) || null;
    },
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
  };

  const location = new URL(url);
  const history = {
    pushState() {},
    replaceState() {},
  };
  const window = {
    ...windowEvents,
    location,
    history,
  };
  window.self = window;
  window.top = window;

  /** @type {Array<Record<string, unknown>>} */
  const observers = [];
  class FakeMutationObserver {
    /**
     * 建立可由測試主動送入 mutation records 的 observer。
     *
     * @param {(mutations: Array<Record<string, unknown>>) => void} callback 受測回呼。
     */
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }

    /**
     * 記錄監聽已啟動。
     *
     * @returns {void} 無回傳值；會更新 observer 狀態。
     */
    observe() {
      this.disconnected = false;
    }

    /**
     * 模擬停止監聽。
     *
     * @returns {void} 無回傳值；後續 emit 不再呼叫回呼。
     */
    disconnect() {
      this.disconnected = true;
    }

    /**
     * 將 mutation records 同步交給受測回呼。
     *
     * @param {Array<Record<string, unknown>>} mutations DOM 變更紀錄。
     * @returns {void} 無回傳值；未停止時會觸發 userscript 排程。
     */
    emit(mutations) {
      if (!this.disconnected) this.callback(mutations);
    }
  }

  const clipboardWrites = [];
  return {
    sandbox: {
      window,
      document,
      location,
      history,
      Node: { ELEMENT_NODE: 1 },
      MutationObserver: FakeMutationObserver,
      GM_setClipboard: (value, type) => clipboardWrites.push({ value, type }),
      setTimeout: scheduler.setTimeout,
      clearTimeout: scheduler.clearTimeout,
      requestAnimationFrame: scheduler.requestAnimationFrame,
      cancelAnimationFrame: scheduler.cancelAnimationFrame,
    },
    document,
    window,
    scheduler,
    observers,
    clipboardWrites,
  };
}

/**
 * 在指定環境執行正式 Copy URL userscript。
 *
 * @param {string} [url] 頁面網址。
 * @returns {ReturnType<typeof createBrowserEnvironment>} 已執行腳本的環境。
 */
function runCopyUrlScript(url = 'https://example.com/path?utm_source=test') {
  const environment = createBrowserEnvironment(url);
  runUserScript('copy-current-url.user.js', environment.sandbox);
  return environment;
}

/**
 * 建立 X/Twitter action group 與指定數量的原生操作按鈕。
 *
 * @param {number} actionCount 要建立的原生操作按鈕數量。
 * @returns {FakeElement} 尚未掛載的 action group。
 */
function createActionGroup(actionCount) {
  const group = createElement('div');
  group.setAttribute('role', 'group');
  const actionNames = ['reply', 'retweet', 'like', 'share'];
  actionNames.slice(0, actionCount).forEach((name) => {
    const action = createElement('button');
    action.setAttribute('data-testid', name);
    group.appendChild(action);
  });
  return group;
}

/**
 * 尋找 action group 內由 userscript 注入的複製按鈕。
 *
 * @param {FakeElement} group action group。
 * @returns {FakeElement | null} 注入按鈕；尚未注入時回傳 null。
 */
function findCopyButton(group) {
  return group.querySelectorAll('*').find((element) => (
    element.tagName === 'BUTTON' &&
    element.attributes.get('aria-label') === '複製 fxTwitter 連結'
  )) || null;
}

/**
 * 建立含 preventDefault 與 stopPropagation 計數的滑鼠／鍵盤事件。
 *
 * @param {Record<string, unknown>} values 事件欄位。
 * @returns {Record<string, unknown> & { prevented: number, stopped: number }} 可觀察攔截副作用的事件。
 */
function createObservedEvent(values) {
  const event = {
    ...values,
    prevented: 0,
    stopped: 0,
    preventDefault: () => {
      event.prevented += 1;
    },
    stopPropagation: () => {
      event.stopped += 1;
    },
  };
  return event;
}

/**
 * 模擬使用者按下可信的複製網址快捷鍵。
 *
 * @param {ReturnType<typeof createBrowserEnvironment>} environment 要接收鍵盤事件的測試環境。
 * @returns {void} 無回傳值；會同步派送 Ctrl+Shift+C 鍵盤事件。
 */
function triggerTrustedCopyShortcut(environment) {
  environment.document.dispatchEvent(createObservedEvent({
    type: 'keydown',
    isTrusted: true,
    ctrlKey: true,
    shiftKey: true,
    code: 'KeyC',
  }));
}

test('合成鍵盤事件不得寫入剪貼簿，可信事件仍可複製', () => {
  const environment = runCopyUrlScript();
  const syntheticEvent = createObservedEvent({
    type: 'keydown',
    isTrusted: false,
    ctrlKey: true,
    shiftKey: true,
    code: 'KeyC',
  });

  environment.document.dispatchEvent(syntheticEvent);
  assert.equal(environment.clipboardWrites.length, 0);
  assert.equal(syntheticEvent.prevented, 0);
  assert.equal(syntheticEvent.stopped, 0);

  triggerTrustedCopyShortcut(environment);
  assert.deepEqual(environment.clipboardWrites, [{
    value: 'https://example.com/path?utm_source=test',
    type: 'text',
  }]);
});

test('Threads 網址會轉成 vxthreads.com 並保留路徑、查詢參數與片段', () => {
  const cases = [
    {
      input: 'https://www.threads.com/@user/post/Ab_C?x=1#media',
      expected: 'https://vxthreads.com/@user/post/Ab_C?x=1#media',
    },
    {
      input: 'https://threads.com/t/Ab_C?foo=bar#reply',
      expected: 'https://vxthreads.com/t/Ab_C?foo=bar#reply',
    },
  ];

  for (const { input, expected } of cases) {
    const environment = runCopyUrlScript(input);
    triggerTrustedCopyShortcut(environment);
    assert.deepEqual(environment.clipboardWrites, [{
      value: expected,
      type: 'text',
    }], input);
  }
});

test('相似但非 Threads 的 hostname 不得轉成 vxthreads.com', () => {
  const input = 'https://threads.com.example.org/@user/post/Ab_C?x=1#media';
  const environment = runCopyUrlScript(input);

  triggerTrustedCopyShortcut(environment);

  assert.deepEqual(environment.clipboardWrites, [{
    value: input,
    type: 'text',
  }]);
});

test('注入按鈕忽略合成 click，可信 click 仍可複製', () => {
  const environment = createBrowserEnvironment('https://x.com/user/status/123');
  const group = createActionGroup(2);
  environment.document.body.appendChild(group);
  runUserScript('copy-current-url.user.js', environment.sandbox);

  assert.equal(environment.scheduler.runTimeoutByDelay(1000), true);
  environment.scheduler.runNextAnimationFrame();
  const button = findCopyButton(group);
  assert.ok(button, '應先注入 fxTwitter 複製按鈕');

  const syntheticEvent = createObservedEvent({ type: 'click', isTrusted: false });
  button.dispatchEvent(syntheticEvent);
  assert.equal(environment.clipboardWrites.length, 0);
  assert.equal(syntheticEvent.prevented, 0);
  assert.equal(syntheticEvent.stopped, 0);

  button.dispatchEvent(createObservedEvent({ type: 'click', isTrusted: true }));
  assert.deepEqual(environment.clipboardWrites, [{
    value: 'https://fxtwitter.com/user/status/123',
    type: 'text',
  }]);
});

test('未完整載入的 action group 補上子節點後會重試並插入按鈕', () => {
  const environment = createBrowserEnvironment('https://x.com/user/status/123');
  const group = createActionGroup(1);
  environment.document.body.appendChild(group);
  runUserScript('copy-current-url.user.js', environment.sandbox);

  environment.scheduler.runTimeoutByDelay(1000);
  environment.scheduler.runNextAnimationFrame();
  assert.equal(findCopyButton(group), null);

  const secondAction = createElement('button');
  secondAction.setAttribute('data-testid', 'retweet');
  group.appendChild(secondAction);
  environment.observers[0].emit([{
    type: 'childList',
    target: group,
    addedNodes: [secondAction],
  }]);

  assert.equal(environment.scheduler.runTimeoutByDelay(500), true);
  environment.scheduler.runNextAnimationFrame();
  assert.ok(findCopyButton(group));
});

test('React 只移除注入根時，保留的 action group 會重新插入按鈕', () => {
  const environment = createBrowserEnvironment('https://x.com/user/status/123');
  const group = createActionGroup(2);
  environment.document.body.appendChild(group);
  runUserScript('copy-current-url.user.js', environment.sandbox);

  environment.scheduler.runTimeoutByDelay(1000);
  environment.scheduler.runNextAnimationFrame();
  const firstButton = findCopyButton(group);
  assert.ok(firstButton);

  const injectedRoot = firstButton.parentNode.parentNode;
  injectedRoot.remove();
  environment.observers[0].emit([{
    type: 'childList',
    target: group,
    addedNodes: [],
    removedNodes: [injectedRoot],
  }]);

  assert.equal(environment.scheduler.runTimeoutByDelay(500), true);
  environment.scheduler.runNextAnimationFrame();
  const replacementButton = findCopyButton(group);
  assert.ok(replacementButton);
  assert.notEqual(replacementButton, firstButton);
});

test('探索閒置且 copy button 完整時 article 內無關移除不排重掃', () => {
  const environment = createBrowserEnvironment('https://x.com/user/status/123');
  const article = createElement('article');
  const group = createActionGroup(2);
  const unrelatedNode = createElement('div');
  article.appendChild(group);
  article.appendChild(unrelatedNode);
  environment.document.body.appendChild(article);
  runUserScript('copy-current-url.user.js', environment.sandbox);

  assert.equal(environment.scheduler.runTimeoutByDelay(1000), true);
  assert.equal(environment.scheduler.runNextAnimationFrame(), true);
  assert.ok(findCopyButton(group));
  assert.deepEqual(environment.scheduler.timeoutIdsByDelay(500), []);

  unrelatedNode.remove();
  environment.observers[0].emit([{
    type: 'childList',
    target: article,
    addedNodes: [],
    removedNodes: [unrelatedNode],
  }]);

  assert.deepEqual(
    environment.scheduler.timeoutIdsByDelay(500),
    [],
    '閒置時不需要為無關 removal 重掃整個 article',
  );
  assert.ok(findCopyButton(group), '既有完整按鈕不應受影響');
});

test('action group 外的無關 removedNodes 不會從 mutation target 掃描整頁 group', () => {
  const environment = runCopyUrlScript('https://x.com/user/status/123');
  const group = createActionGroup(2);
  const unrelatedNode = createElement('div');
  environment.document.body.appendChild(group);
  environment.document.body.appendChild(unrelatedNode);
  unrelatedNode.remove();

  environment.observers[0].emit([{
    type: 'childList',
    target: environment.document.body,
    addedNodes: [],
    removedNodes: [unrelatedNode],
  }]);

  assert.deepEqual(environment.scheduler.timeoutIdsByDelay(500), []);
});

test('observer callback 不同步查詢新增的大型 subtree', () => {
  const environment = runCopyUrlScript('https://x.com/user/status/123');
  const root = createElement('div');
  const article = createElement('article');
  article.appendChild(createActionGroup(2));
  root.appendChild(article);
  environment.document.body.appendChild(root);

  let subtreeQueryCount = 0;
  const originalQuerySelector = root.querySelector;
  const originalQuerySelectorAll = root.querySelectorAll;
  root.querySelector = (selector) => {
    subtreeQueryCount += 1;
    return originalQuerySelector(selector);
  };
  root.querySelectorAll = (selector) => {
    subtreeQueryCount += 1;
    return originalQuerySelectorAll(selector);
  };

  environment.observers[0].emit([{
    type: 'childList',
    target: environment.document.body,
    addedNodes: [root],
  }]);

  assert.equal(subtreeQueryCount, 0, 'observer callback 只能排程，不能同步探索新增 subtree');
  assert.equal(environment.scheduler.timeoutIdsByDelay(500).length, 1);
});

test('連續 DOM 變更共用同一個固定節流 timeout，不會無限延後', () => {
  const environment = runCopyUrlScript('https://x.com/user/status/123');
  const firstArticle = createElement('article');
  const secondArticle = createElement('article');
  environment.document.body.appendChild(firstArticle);
  environment.document.body.appendChild(secondArticle);

  environment.observers[0].emit([{
    type: 'childList',
    target: environment.document.body,
    addedNodes: [firstArticle],
  }]);
  const [firstTimeoutId] = environment.scheduler.timeoutIdsByDelay(500);
  assert.ok(firstTimeoutId);

  environment.observers[0].emit([{
    type: 'childList',
    target: environment.document.body,
    addedNodes: [secondArticle],
  }]);
  assert.deepEqual(environment.scheduler.timeoutIdsByDelay(500), [firstTimeoutId]);
});

test('節流期間已斷線的 action group 不會被處理', () => {
  const environment = runCopyUrlScript('https://x.com/user/status/123');
  const group = createActionGroup(2);
  environment.document.body.appendChild(group);
  environment.observers[0].emit([{
    type: 'childList',
    target: environment.document.body,
    addedNodes: [group],
  }]);
  group.remove();

  assert.equal(environment.scheduler.runTimeoutByDelay(500), true);
  environment.scheduler.runNextAnimationFrame();
  assert.equal(findCopyButton(group), null);
});

test('action group 每幀最多處理 100 組，剩餘工作排到下一幀', () => {
  const environment = runCopyUrlScript('https://x.com/user/status/123');
  const article = createElement('article');
  const groups = Array.from({ length: 101 }, () => createActionGroup(2));
  groups.forEach((group) => article.appendChild(group));
  environment.document.body.appendChild(article);
  environment.observers[0].emit([{
    type: 'childList',
    target: environment.document.body,
    addedNodes: [article],
  }]);

  environment.scheduler.runTimeoutByDelay(500);
  assert.equal(groups.filter(findCopyButton).length, 0);
  assert.equal(environment.scheduler.runNextAnimationFrame(), true);
  assert.equal(groups.filter(findCopyButton).length, 100);
  assert.equal(environment.scheduler.activeAnimationFrameCount(), 1);
  environment.scheduler.runNextAnimationFrame();
  assert.equal(groups.filter(findCopyButton).length, 101);
});

test('深層 action group 的 subtree 探索也受逐幀預算限制', () => {
  const environment = runCopyUrlScript('https://x.com/user/status/123');
  const article = createElement('article');
  let cursor = article;
  for (let index = 0; index < 300; index++) {
    const wrapper = createElement('div');
    cursor.appendChild(wrapper);
    cursor = wrapper;
  }
  const group = createActionGroup(2);
  cursor.appendChild(group);
  environment.document.body.appendChild(article);

  environment.observers[0].emit([{
    type: 'childList',
    target: environment.document.body,
    addedNodes: [article],
  }]);

  assert.equal(environment.scheduler.runTimeoutByDelay(500), true);
  assert.equal(environment.scheduler.runNextAnimationFrame(), true);
  assert.equal(findCopyButton(group), null, '單一大型 subtree 不可在首幀同步探索到底');
  assert.equal(environment.scheduler.activeAnimationFrameCount(), 1, '未完成探索應延到下一幀');

  for (let frame = 0; frame < 5 && !findCopyButton(group); frame++) {
    environment.scheduler.runNextAnimationFrame();
  }
  assert.ok(findCopyButton(group), '逐幀探索完成後仍須注入按鈕');
});

test('極寬 subtree 的直接 children 工作建立也受逐幀預算限制', () => {
  const environment = runCopyUrlScript('https://x.com/user/status/123');
  const article = createElement('article');
  for (let index = 0; index < 1000; index++) {
    article.appendChild(createElement('div'));
  }
  const group = createActionGroup(2);
  article.appendChild(group);
  environment.document.body.appendChild(article);

  let directChildConnectivityReads = 0;
  for (const child of article.children) {
    let connected = child.isConnected;
    Object.defineProperty(child, 'isConnected', {
      configurable: true,
      get() {
        directChildConnectivityReads += 1;
        return connected;
      },
      set(value) {
        connected = value;
      },
    });
  }

  environment.observers[0].emit([{
    type: 'childList',
    target: environment.document.body,
    addedNodes: [article],
  }]);
  assert.equal(environment.scheduler.runTimeoutByDelay(500), true);
  assert.equal(environment.scheduler.runNextAnimationFrame(), true);

  assert.ok(
    directChildConnectivityReads <= 400,
    `首幀不可同步建立全部 children 工作，實際讀取 ${directChildConnectivityReads} 次`,
  );
  assert.equal(Boolean(findCopyButton(group)), false, '寬樹尾端 group 應延到後續幀');
  assert.equal(environment.scheduler.activeAnimationFrameCount(), 1);

  for (let frame = 0; frame < 10 && !findCopyButton(group); frame++) {
    environment.scheduler.runNextAnimationFrame();
  }
  assert.ok(findCopyButton(group), '逐幀走訪全部兄弟後仍須注入按鈕');
});

test('待處理 sibling 離線後仍會從快照延續後方兄弟鏈', () => {
  const environment = runCopyUrlScript('https://x.com/user/status/123');
  const article = createElement('article');
  const wrappers = Array.from({ length: 200 }, () => createElement('div'));
  wrappers.forEach((wrapper) => article.appendChild(wrapper));
  const group = createActionGroup(2);
  article.appendChild(group);
  environment.document.body.appendChild(article);

  environment.observers[0].emit([{
    type: 'childList',
    target: environment.document.body,
    addedNodes: [article],
  }]);
  assert.equal(environment.scheduler.runTimeoutByDelay(500), true);
  assert.equal(environment.scheduler.runNextAnimationFrame(), true);
  assert.equal(Boolean(findCopyButton(group)), false);
  assert.equal(environment.scheduler.activeAnimationFrameCount(), 1);

  // 首幀處理 article 與前 199 個 child；最後一個 wrapper 已入列但尚未處理。
  wrappers[199].remove();
  assert.equal(environment.scheduler.runNextAnimationFrame(), true);
  assert.ok(findCopyButton(group), '離線工作應先排入快照的下一個 sibling，再略過自身');
});

test('尚未入列的 saved-next 被移除時會由 article removal 增量重掃續鏈', () => {
  const environment = runCopyUrlScript('https://x.com/user/status/123');
  const article = createElement('article');
  const wrappers = Array.from({ length: 201 }, () => createElement('div'));
  wrappers.forEach((wrapper) => article.appendChild(wrapper));
  const group = createActionGroup(2);
  article.appendChild(group);
  environment.document.body.appendChild(article);

  environment.observers[0].emit([{
    type: 'childList',
    target: environment.document.body,
    addedNodes: [article],
  }]);
  assert.equal(environment.scheduler.runTimeoutByDelay(500), true);
  assert.equal(environment.scheduler.runNextAnimationFrame(), true);
  assert.equal(Boolean(findCopyButton(group)), false);

  // 首幀待處理的是 wrapper[199]，其快照 nextSibling wrapper[200] 尚未入列。
  wrappers[200].remove();
  environment.observers[0].emit([{
    type: 'childList',
    target: article,
    addedNodes: [],
    removedNodes: [wrappers[200]],
  }]);

  // 舊鏈會在 wrapper[199] 嘗試排入已離線 saved-next 時中斷。
  assert.equal(environment.scheduler.runNextAnimationFrame(), true);
  assert.equal(Boolean(findCopyButton(group)), false);
  assert.equal(environment.scheduler.runTimeoutByDelay(500), true, 'article removal 應排程增量重掃');

  for (let frame = 0; frame < 5 && !findCopyButton(group); frame++) {
    environment.scheduler.runNextAnimationFrame();
  }
  assert.ok(findCopyButton(group), '重掃 relevant ancestor 後應找到 saved-next 後方 group');
});

test('beforeunload 可取消，因此不得停止 observer、timer、rAF 或 history 攔截', () => {
  const environment = runCopyUrlScript('https://x.com/user/status/123');
  const group = createActionGroup(2);
  environment.document.body.appendChild(group);
  const patchedPushState = environment.window.history.pushState;
  const patchedReplaceState = environment.window.history.replaceState;
  environment.observers[0].emit([{
    type: 'childList',
    target: environment.document.body,
    addedNodes: [group],
  }]);
  environment.scheduler.runTimeoutByDelay(500);
  assert.equal(environment.scheduler.activeAnimationFrameCount(), 1);

  environment.window.dispatchEvent({ type: 'beforeunload' });

  assert.equal(environment.observers[0].disconnected, false);
  assert.equal(environment.scheduler.activeTimeoutCount(), 2);
  assert.equal(environment.scheduler.activeAnimationFrameCount(), 1);
  assert.equal(environment.window.history.pushState, patchedPushState);
  assert.equal(environment.window.history.replaceState, patchedReplaceState);
  environment.scheduler.runNextAnimationFrame();
  assert.ok(findCopyButton(group));
});

test('persisted pagehide 保留所有資源，bfcache 恢復後仍可處理新 group', () => {
  const environment = runCopyUrlScript('https://x.com/user/status/123');
  const patchedPushState = environment.window.history.pushState;
  const patchedReplaceState = environment.window.history.replaceState;

  environment.window.dispatchEvent({ type: 'pagehide', persisted: true });

  assert.equal(environment.observers[0].disconnected, false);
  assert.equal(environment.scheduler.activeTimeoutCount(), 2);
  assert.equal(environment.window.history.pushState, patchedPushState);
  assert.equal(environment.window.history.replaceState, patchedReplaceState);

  const group = createActionGroup(2);
  environment.document.body.appendChild(group);
  environment.observers[0].emit([{
    type: 'childList',
    target: environment.document.body,
    addedNodes: [group],
    removedNodes: [],
  }]);
  environment.scheduler.runTimeoutByDelay(500);
  environment.scheduler.runNextAnimationFrame();
  assert.ok(findCopyButton(group));
});

test('非 persisted pagehide 才完整清理 observer、timer、rAF 並還原 history', () => {
  const environment = createBrowserEnvironment('https://x.com/user/status/123');
  const originalPushState = environment.window.history.pushState;
  const originalReplaceState = environment.window.history.replaceState;
  runUserScript('copy-current-url.user.js', environment.sandbox);
  const group = createActionGroup(2);
  environment.document.body.appendChild(group);
  environment.observers[0].emit([{
    type: 'childList',
    target: environment.document.body,
    addedNodes: [group],
    removedNodes: [],
  }]);
  environment.scheduler.runTimeoutByDelay(500);
  assert.equal(environment.scheduler.activeAnimationFrameCount(), 1);

  environment.window.dispatchEvent({ type: 'pagehide', persisted: false });

  assert.equal(environment.observers[0].disconnected, true);
  assert.equal(environment.scheduler.activeTimeoutCount(), 0);
  assert.equal(environment.scheduler.activeAnimationFrameCount(), 0);
  assert.equal(environment.window.history.pushState, originalPushState);
  assert.equal(environment.window.history.replaceState, originalReplaceState);
});

test('metadata 後提供 README 維護索引反向連結', () => {
  const source = readUserScript('copy-current-url.user.js');
  const metadataEnd = source.indexOf('// ==/UserScript==');
  const iifeStart = source.indexOf('(function ()');
  assert.ok(metadataEnd >= 0 && iifeStart > metadataEnd);
  assert.match(source.slice(metadataEnd, iifeStart), /README\.md.*維護索引/);
});
