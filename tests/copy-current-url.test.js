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

test('metadata 宣告 @noframes，避免注入 iframe', () => {
  const source = readUserScript('copy-current-url.user.js');
  const metadataEnd = source.indexOf('// ==/UserScript==');

  assert.ok(metadataEnd >= 0, '必須存在完整的 userscript metadata');
  assert.match(source.slice(0, metadataEnd), /^\/\/ @noframes\s*$/m);
});

test('iframe 防禦性 early return 不得註冊複製快捷鍵', () => {
  const environment = createBrowserEnvironment(
    'https://www.browserbench.org/Speedometer3.1/suites/todomvc/index.html'
  );
  environment.window.top = {};

  runUserScript('copy-current-url.user.js', environment.sandbox);
  triggerTrustedCopyShortcut(environment);

  assert.equal(environment.clipboardWrites.length, 0);
  assert.equal(environment.observers.length, 0);
  assert.equal(environment.scheduler.activeTimeoutCount(), 0);
  assert.equal(environment.scheduler.activeAnimationFrameCount(), 0);
});

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

test('Threads 網址維持原網址，不再轉換成 vxthreads.com', () => {
  const cases = [
    {
      input: 'https://www.threads.com/@user/post/Ab_C?x=1#media',
      expected: 'https://www.threads.com/@user/post/Ab_C?x=1#media',
    },
    {
      input: 'https://threads.com/t/Ab_C?foo=bar#reply',
      expected: 'https://threads.com/t/Ab_C?foo=bar#reply',
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

test('Amazon.co.jp 商品網址會簡化為只保留 ASIN 的標準網址', () => {
  const cases = [
    {
      input: 'https://www.amazon.co.jp/%E8%B3%87%E7%94%9F%E5%A0%82%E3%82%AF%E3%83%AC%E3%83%BB%E3%83%89%E3%83%BB%E3%83%9D%E3%83%BC%E3%83%9C%E3%83%BC%E3%83%86-%E3%83%97%E3%83%BC%E3%83%89%E3%83%AB%E3%83%88%E3%83%A9%E3%83%B3%E3%82%B9%E3%83%91%E3%83%A9%E3%83%B3%E3%83%88%EF%BD%8E-1%E3%83%A9%E3%82%A4%E3%83%88-26g-%E3%81%8A%E4%B8%80%E4%BA%BA%E6%A7%98%EF%BC%91%E5%80%8B%E9%99%90%E3%82%8A-%E5%9B%BD%E5%86%85%E6%AD%A3%E8%A6%8F%E5%93%81/dp/B09PQSG597/357-9689399-6882450',
      expected: 'https://www.amazon.co.jp/dp/B09PQSG597',
    },
    {
      input: 'https://amazon.co.jp/dp/4062881721?th=1&psc=1#details',
      expected: 'https://www.amazon.co.jp/dp/4062881721',
    },
    {
      input: 'https://www.amazon.co.jp/gp/product/B09PQSG597/ref=ox_sc_act_title_1?smid=example',
      expected: 'https://www.amazon.co.jp/dp/B09PQSG597',
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

test('Amazon.co.jp 非商品頁與相似 hostname 不得改寫', () => {
  const inputs = [
    'https://www.amazon.co.jp/s?k=face+powder',
    'https://www.amazon.co.jp/gp/help/customer/display.html',
    'https://www.amazon.co.jp.example.org/title/dp/B09PQSG597/tracking',
  ];

  for (const input of inputs) {
    const environment = runCopyUrlScript(input);
    triggerTrustedCopyShortcut(environment);
    assert.deepEqual(environment.clipboardWrites, [{
      value: input,
      type: 'text',
    }], input);
  }
});

test('X 頁面只保留快捷鍵轉換，不顯示 Icon 或啟動介面掃描', () => {
  const environment = createBrowserEnvironment('https://x.com/user/status/123');
  const originalPushState = environment.window.history.pushState;
  const originalReplaceState = environment.window.history.replaceState;

  runUserScript('copy-current-url.user.js', environment.sandbox);

  assert.equal(environment.observers.length, 0, '不得建立 X action bar 的 MutationObserver');
  assert.equal(environment.scheduler.activeTimeoutCount(), 0, '不得排程 X Icon 注入工作');
  assert.equal(environment.scheduler.activeAnimationFrameCount(), 0, '不得排程 X Icon 掃描工作');
  assert.equal(environment.window.history.pushState, originalPushState, '不得為 Icon 掃描攔截 pushState');
  assert.equal(environment.window.history.replaceState, originalReplaceState, '不得為 Icon 掃描攔截 replaceState');

  triggerTrustedCopyShortcut(environment);
  assert.deepEqual(environment.clipboardWrites, [{
    value: 'https://fxtwitter.com/user/status/123',
    type: 'text',
  }]);
});

test('metadata 後提供 README 維護索引反向連結', () => {
  const source = readUserScript('copy-current-url.user.js');
  const metadataEnd = source.indexOf('// ==/UserScript==');
  const iifeStart = source.indexOf('(function ()');
  assert.ok(metadataEnd >= 0 && iifeStart > metadataEnd);
  assert.match(source.slice(metadataEnd, iifeStart), /README\.md.*維護索引/);
});

test('PChome 商品頁轉換為 Pancake 網址，其他頁面維持原網址', () => {
  const cases = [
    {
      input: 'https://24h.pchome.com.tw/prod/DSAA31-A900H4QXL?fq=/S/DSAA31#detail',
      expected: 'https://p.pancake.tw/prod/DSAA31-A900H4QXL',
    },
    {
      input: 'https://24h.pchome.com.tw/search/?q=keyboard',
      expected: 'https://24h.pchome.com.tw/search/?q=keyboard',
    },
    {
      input: 'https://24h.pchome.com.tw.example.org/prod/DSAA31-A900H4QXL',
      expected: 'https://24h.pchome.com.tw.example.org/prod/DSAA31-A900H4QXL',
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

test('Shopee 商品網址只接受數字 ID，並統一成無追蹤參數的 product 路徑', () => {
  const cases = [
    {
      input: 'https://shopee.tw/example-product-i.123456.987654?sp_atk=tracking#detail',
      expected: 'https://shopee.tw/product/123456/987654',
    },
    {
      input: 'https://shopee.tw/product/123456/987654?sp_atk=tracking#detail',
      expected: 'https://shopee.tw/product/123456/987654',
    },
    {
      input: 'https://shopee.tw/example-product-i.foo.bar?sp_atk=tracking',
      expected: 'https://shopee.tw/example-product-i.foo.bar?sp_atk=tracking',
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

test('X 轉換透過 URL 欄位正規化協定、主機與連接埠', () => {
  const environment = runCopyUrlScript(
    'http://www.twitter.com:8080/user/status/123?lang=zh-TW#media'
  );

  triggerTrustedCopyShortcut(environment);

  assert.deepEqual(environment.clipboardWrites, [{
    value: 'https://fxtwitter.com/user/status/123?lang=zh-TW#media',
    type: 'text',
  }]);
});

test('快捷鍵只接受未重複且沒有 Alt 或 Meta 的 Ctrl+Shift+C', () => {
  const environment = runCopyUrlScript();
  const invalidEvents = [
    { altKey: true, metaKey: false, repeat: false },
    { altKey: false, metaKey: true, repeat: false },
    { altKey: false, metaKey: false, repeat: true },
  ];

  for (const modifiers of invalidEvents) {
    const event = createObservedEvent({
      type: 'keydown',
      isTrusted: true,
      ctrlKey: true,
      shiftKey: true,
      code: 'KeyC',
      ...modifiers,
    });
    environment.document.dispatchEvent(event);
    assert.equal(event.prevented, 0);
    assert.equal(event.stopped, 0);
  }

  assert.equal(environment.clipboardWrites.length, 0);
  triggerTrustedCopyShortcut(environment);
  assert.equal(environment.clipboardWrites.length, 1);
});

test('複製通知建立一次樣式，並在顯示時間結束後移除', async () => {
  const environment = runCopyUrlScript('https://example.com/path');

  triggerTrustedCopyShortcut(environment);
  await Promise.resolve();

  assert.equal(environment.document.head.children.length, 1);
  assert.equal(environment.document.head.children[0].id, 'copy-url-notification-style');
  assert.equal(environment.document.body.children.length, 1);
  assert.equal(environment.document.body.children[0].children[0].textContent, '已複製網址！');
  assert.equal(
    environment.document.body.children[0].children[1].textContent,
    'https://example.com/path'
  );
  assert.deepEqual(environment.scheduler.timeoutIdsByDelay(2000).length, 1);

  assert.equal(environment.scheduler.runTimeoutByDelay(2000), true);
  assert.equal(environment.document.body.children.length, 0);

  triggerTrustedCopyShortcut(environment);
  await Promise.resolve();
  assert.equal(environment.document.head.children.length, 1);
});
