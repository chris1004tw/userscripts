'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readUserScript,
  runUserScript,
} = require('./helpers/userscript-harness');

/**
 * 遞迴更新最小 DOM 節點的連線狀態。
 *
 * @param {FakeElement | FakeTextNode} node 要更新的節點。
 * @param {boolean} isConnected 是否連接至 document。
 * @returns {void} 無回傳值；會同步更新全部後代。
 */
function setConnected(node, isConnected) {
  node.isConnected = isConnected;
  if (node instanceof FakeElement) {
    node.children.forEach((child) => setConnected(child, isConnected));
  }
}

/** 供 TreeWalker 使用的最小文字節點。 */
class FakeTextNode {
  /**
   * @param {string} textContent 節點文字。
   */
  constructor(textContent) {
    this.nodeType = 3;
    this.textContent = textContent;
    this.parentElement = null;
    this.parentNode = null;
    this.isConnected = false;
  }

  /** @returns {null} 文字節點沒有子節點，因此固定回傳 null。 */
  get firstChild() {
    return null;
  }

  /** @returns {FakeElement | FakeTextNode | null} 下一個兄弟節點；不存在時回傳 null。 */
  get nextSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
}

/** 只實作 Threads 腳本實際使用介面的最小 Element。 */
class FakeElement {
  /**
   * @param {string} tagName 元素標籤名稱。
   */
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.isConnected = false;
    this.clickCount = 0;
  }

  /** @returns {FakeElement | FakeTextNode | null} 第一個子節點；不存在時回傳 null。 */
  get firstChild() {
    return this.children[0] ?? null;
  }

  /** @returns {FakeElement | FakeTextNode | null} 下一個兄弟節點；不存在時回傳 null。 */
  get nextSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  /**
   * 設定元素屬性。
   *
   * @param {string} name 屬性名稱。
   * @param {string} value 屬性值。
   * @returns {void} 無回傳值；會更新 attributes。
   */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  /**
   * 掛載子節點並同步連線狀態。
   *
   * @param {FakeElement | FakeTextNode} child 子節點。
   * @returns {FakeElement | FakeTextNode} 原子節點。
   */
  appendChild(child) {
    if (child.parentElement) child.remove?.();
    this.children.push(child);
    child.parentElement = this;
    child.parentNode = this;
    setConnected(child, this.isConnected);
    return child;
  }

  /**
   * 從父元素移除此元素。
   *
   * @returns {void} 無回傳值；會將整個 subtree 標為未連線。
   */
  remove() {
    if (this.parentElement) {
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
    }
    this.parentElement = null;
    this.parentNode = null;
    setConnected(this, false);
  }

  /**
   * 比對腳本使用的簡單 CSS 選擇器。
   *
   * @param {string} selector CSS 選擇器。
   * @returns {boolean} 符合任一逗號分隔條件時回傳 true。
   */
  matches(selector) {
    return selector.split(',').some((part) => {
      const normalized = part.trim();
      if (normalized === '[role="button"]') {
        return this.attributes.get('role') === 'button';
      }
      if (normalized === '[data-text-fragment="spoiler"]') {
        return this.attributes.get('data-text-fragment') === 'spoiler';
      }
      return ['img', 'video', 'picture'].includes(normalized)
        && this.tagName === normalized.toUpperCase();
    });
  }

  /**
   * 尋找最近且符合選擇器的祖先（含自身）。
   *
   * @param {string} selector CSS 選擇器。
   * @returns {FakeElement | null} 最近的符合元素，找不到時回傳 null。
   */
  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  /**
   * 尋找第一個符合條件的後代。
   *
   * @param {string} selector CSS 選擇器。
   * @returns {FakeElement | null} 第一個符合元素，找不到時回傳 null。
   */
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  /**
   * 尋找全部符合條件的元素後代。
   *
   * @param {string} selector CSS 選擇器。
   * @returns {FakeElement[]} 符合條件的元素陣列。
   */
  querySelectorAll(selector) {
    const matches = [];
    /** @param {FakeElement} parent 目前走訪的父元素。 */
    const visit = (parent) => {
      for (const child of parent.children) {
        if (!(child instanceof FakeElement)) continue;
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  /**
   * 判斷指定節點是否位於此 subtree；僅供偵測舊版平方級合併行為。
   *
   * @param {FakeElement | FakeTextNode} target 目標節點。
   * @returns {boolean} target 為自身或後代時回傳 true。
   */
  contains(target) {
    if (target === this) return true;
    return this.children.some((child) => (
      child === target || (child instanceof FakeElement && child.contains(target))
    ));
  }

  /**
   * 模擬使用者腳本呼叫元素 click。
   *
   * @returns {void} 無回傳值；會累加 clickCount。
   */
  click() {
    this.clickCount += 1;
  }
}

/**
 * 建立可手動推進與取消的 animation frame 排程器。
 *
 * @returns {{
 *   requestAnimationFrame: (callback: (timestamp: number) => void) => number,
 *   cancelAnimationFrame: (id: number) => void,
 *   runNext: () => boolean,
 *   activeCount: () => number,
 * }} 排程器 API。
 */
function createAnimationFrameScheduler() {
  let nextId = 1;
  /** @type {Map<number, (timestamp: number) => void>} */
  const frames = new Map();

  return {
    requestAnimationFrame: (callback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => {
      frames.delete(id);
    },
    runNext: () => {
      const entry = frames.entries().next().value;
      if (!entry) return false;
      const [id, callback] = entry;
      frames.delete(id);
      callback(0);
      return true;
    },
    activeCount: () => frames.size,
  };
}

/**
 * 建立只支援註冊、移除與同步派送的事件目標。
 *
 * @returns {{
 *   addEventListener: (type: string, callback: (event: Record<string, unknown>) => void) => void,
 *   removeEventListener: (type: string, callback: (event: Record<string, unknown>) => void) => void,
 *   dispatchEvent: (event: Record<string, unknown>) => void,
 * }} 事件目標 API。
 */
function createEventTarget() {
  /** @type {Map<string, Set<(event: Record<string, unknown>) => void>>} */
  const listeners = new Map();
  return {
    addEventListener: (type, callback) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener: (type, callback) => {
      listeners.get(type)?.delete(callback);
    },
    dispatchEvent: (event) => {
      for (const callback of listeners.get(String(event.type)) || []) callback(event);
    },
  };
}

/**
 * 建立最小 document、MutationObserver 與瀏覽器生命週期環境。
 *
 * @returns {{
 *   sandbox: Record<string, unknown>,
 *   body: FakeElement,
 *   window: ReturnType<typeof createEventTarget>,
 *   scheduler: ReturnType<typeof createAnimationFrameScheduler>,
 *   observers: FakeMutationObserver[],
 * }} 可執行正式 userscript 並觀察副作用的環境。
 */
function createBrowserEnvironment() {
  const scheduler = createAnimationFrameScheduler();
  const body = new FakeElement('body');
  setConnected(body, true);
  const window = createEventTarget();
  window.self = window;
  window.top = window;
  const document = { body };

  /** @type {FakeMutationObserver[]} */
  const observers = [];
  class FakeMutationObserver {
    /** @param {(mutations: Array<Record<string, unknown>>) => void} callback observer 回呼。 */
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }

    /** @returns {void} 標示 observer 已開始監聽。 */
    observe() {
      this.disconnected = false;
    }

    /** @returns {void} 停止後續測試 mutation 派送。 */
    disconnect() {
      this.disconnected = true;
    }

    /**
     * @param {Array<Record<string, unknown>>} mutations DOM 變更紀錄。
     * @returns {void} observer 未停止時同步觸發回呼。
     */
    emit(mutations) {
      if (!this.disconnected) this.callback(mutations);
    }
  }

  return {
    sandbox: {
      window,
      document,
      Element: FakeElement,
      MutationObserver: FakeMutationObserver,
      requestAnimationFrame: scheduler.requestAnimationFrame,
      cancelAnimationFrame: scheduler.cancelAnimationFrame,
    },
    body,
    window,
    scheduler,
    observers,
  };
}

/**
 * 建立以 data-text-fragment 標記的文字 Spoiler 按鈕。
 *
 * @returns {FakeElement} 尚未掛載的按鈕。
 */
function createTextSpoilerButton() {
  const button = new FakeElement('div');
  button.setAttribute('role', 'button');
  const spoiler = new FakeElement('span');
  spoiler.setAttribute('data-text-fragment', 'spoiler');
  button.appendChild(spoiler);
  return button;
}

/**
 * 建立帶標籤的圖片或影片 Spoiler 按鈕。
 *
 * @param {'img' | 'video'} mediaTag 媒體標籤。
 * @param {string} [label='Spoiler'] overlay 標籤文字。
 * @returns {FakeElement} 尚未掛載的媒體按鈕。
 */
function createMediaSpoilerButton(mediaTag, label = 'Spoiler') {
  const button = new FakeElement('div');
  button.setAttribute('role', 'button');
  button.appendChild(new FakeElement(mediaTag));
  button.appendChild(new FakeTextNode(label));
  return button;
}

/**
 * 執行正式 Threads userscript。
 *
 * @param {ReturnType<typeof createBrowserEnvironment>} environment 瀏覽器環境。
 * @returns {void} 無回傳值；會建立 observer 並執行初次掃描。
 */
function runThreadsScript(environment) {
  runUserScript('threads-auto-reveal-spoiler.user.js', environment.sandbox);
}

/**
 * 執行目前排定的全部 animation frame。
 *
 * @param {ReturnType<typeof createBrowserEnvironment>} environment 要推進的瀏覽器環境。
 * @returns {void} 無回傳值；會同步執行佇列直到沒有待處理 frame。
 */
function finishScheduledFrames(environment) {
  while (environment.scheduler.runNext()) {
    // 排程器每次回呼可能再排下一幀，持續推進到 traversal 完成。
  }
}

test('初次掃描使用逐幀 traversal 揭露文字、圖片與影片 Spoiler', () => {
  const environment = createBrowserEnvironment();
  const textButton = createTextSpoilerButton();
  const imageButton = createMediaSpoilerButton('img', '劇透');
  const videoButton = createMediaSpoilerButton('video', 'Spoiler');
  const normalImageButton = createMediaSpoilerButton('img', '一般內容');
  [textButton, imageButton, videoButton, normalImageButton]
    .forEach((button) => environment.body.appendChild(button));
  let bodyQuerySelectorAllCalls = 0;
  const originalBodyQuerySelectorAll = environment.body.querySelectorAll.bind(environment.body);
  environment.body.querySelectorAll = (selector) => {
    bodyQuerySelectorAllCalls += 1;
    return originalBodyQuerySelectorAll(selector);
  };

  runThreadsScript(environment);

  assert.equal(textButton.clickCount, 0, '初次掃描不得同步遍歷整個 body');
  assert.equal(bodyQuerySelectorAllCalls, 0, '初次掃描不得使用全頁 querySelectorAll');
  assert.equal(environment.scheduler.activeCount(), 1);
  finishScheduledFrames(environment);

  assert.equal(textButton.clickCount, 1);
  assert.equal(imageButton.clickCount, 1);
  assert.equal(videoButton.clickCount, 1);
  assert.equal(normalImageButton.clickCount, 0);
  assert.equal(bodyQuerySelectorAllCalls, 0);
});

test('大量兄弟根節點入列不呼叫 contains 做平方級合併', () => {
  const environment = createBrowserEnvironment();
  runThreadsScript(environment);
  finishScheduledFrames(environment);
  let containsCalls = 0;
  const roots = Array.from({ length: 150 }, () => {
    const root = new FakeElement('div');
    root.contains = () => {
      containsCalls += 1;
      return false;
    };
    environment.body.appendChild(root);
    return root;
  });

  environment.observers[0].emit([{ addedNodes: roots }]);

  assert.equal(containsCalls, 0);
  assert.equal(environment.scheduler.activeCount(), 1);
});

test('單一大型新增 subtree 的探索與揭露都受每幀 100 節點預算限制', () => {
  const environment = createBrowserEnvironment();
  runThreadsScript(environment);
  finishScheduledFrames(environment);

  const root = new FakeElement('section');
  const nonElementResumeSibling = new FakeTextNode(' ');
  const buttons = Array.from({ length: 150 }, (_, index) => {
    const button = new FakeElement('span');
    button.setAttribute('role', 'button');
    button.setAttribute('data-text-fragment', 'spoiler');
    root.appendChild(button);
    if (index === 51) root.appendChild(nonElementResumeSibling);
    return button;
  });
  const mediaButton = createMediaSpoilerButton('video', 'Spoiler');
  root.appendChild(mediaButton);
  const nonSpoilerMediaButton = createMediaSpoilerButton('video', '一般內容');
  for (let index = 1; index < 120; index++) {
    nonSpoilerMediaButton.appendChild(new FakeElement('video'));
  }
  root.appendChild(nonSpoilerMediaButton);
  environment.body.appendChild(root);

  let rootQuerySelectorAllCalls = 0;
  const originalQuerySelectorAll = root.querySelectorAll.bind(root);
  root.querySelectorAll = (selector) => {
    rootQuerySelectorAllCalls += 1;
    return originalQuerySelectorAll(selector);
  };

  let mediaButtonQuerySelectorAllCalls = 0;
  const originalMediaButtonQuerySelectorAll = nonSpoilerMediaButton.querySelectorAll
    .bind(nonSpoilerMediaButton);
  nonSpoilerMediaButton.querySelectorAll = (selector) => {
    mediaButtonQuerySelectorAllCalls += 1;
    return originalMediaButtonQuerySelectorAll(selector);
  };

  let prefixButtonMatchCalls = 0;
  const originalPrefixButtonMatches = buttons[0].matches.bind(buttons[0]);
  buttons[0].matches = (selector) => {
    prefixButtonMatchCalls += 1;
    return originalPrefixButtonMatches(selector);
  };

  environment.observers[0].emit([{ addedNodes: [root] }]);
  assert.equal(rootQuerySelectorAllCalls, 0, 'observer callback 不得同步探索大型 subtree');

  assert.equal(environment.scheduler.runNext(), true);
  assert.equal(rootQuerySelectorAllCalls, 0, '逐幀工作不得以 querySelectorAll 一次展開整棵 subtree');
  assert.equal(
    buttons.filter((button) => button.clickCount === 1).length,
    50,
    '100 個固定工作額度須同時涵蓋節點判定與按鈕完成標記',
  );
  assert.equal(mediaButton.clickCount, 0, 'subtree 尾端的媒體候選不可繞過本幀節點預算');
  assert.equal(environment.scheduler.activeCount(), 1);
  const prefixButtonMatchCallsBeforeRemoval = prefixButtonMatchCalls;

  // 第 52 個按鈕此時只被前一個 work item 保存為 nextSibling；移除後須越過文字 sibling 局部續接。
  const removedMiddleButton = buttons[51];
  assert.equal(removedMiddleButton.nextSibling, nonElementResumeSibling);
  removedMiddleButton.remove();
  const sameBatchAddedButton = createTextSpoilerButton();
  const resumeIndex = root.children.indexOf(nonElementResumeSibling);
  root.children.splice(resumeIndex, 0, sameBatchAddedButton);
  sameBatchAddedButton.parentElement = root;
  sameBatchAddedButton.parentNode = root;
  setConnected(sameBatchAddedButton, true);
  environment.observers[0].emit([{
    type: 'childList',
    target: root,
    addedNodes: [sameBatchAddedButton],
    removedNodes: [removedMiddleButton],
    nextSibling: nonElementResumeSibling,
  }]);

  let remainingFrames = 0;
  while (environment.scheduler.runNext()) {
    remainingFrames += 1;
    assert.ok(remainingFrames < 10, '大型 subtree 應在有限幀數內完成');
  }
  assert.equal(removedMiddleButton.clickCount, 0, '已離線的中間節點不可被處理');
  assert.equal(
    buttons.filter((button) => button !== removedMiddleButton && button.clickCount === 1).length,
    149,
    'removedNodes 造成的斷鏈須從 nextSibling 局部補齊後方兄弟',
  );
  assert.equal(sameBatchAddedButton.clickCount, 1, '同批 addedNodes 仍須獨立排入並揭露');
  assert.equal(
    prefixButtonMatchCalls,
    prefixButtonMatchCallsBeforeRemoval,
    '局部續接不得從大型 mutation target 開頭重掃已處理節點',
  );
  assert.equal(mediaButton.clickCount, 1, '後續幀仍須保留媒體 Spoiler 判定');
  assert.equal(nonSpoilerMediaButton.clickCount, 0, '沒有 Spoiler 標籤的媒體按鈕不可被點擊');
  assert.equal(
    mediaButtonQuerySelectorAllCalls,
    0,
    '動態媒體候選不得反覆對整個按鈕執行 descendant query',
  );
  assert.equal(environment.scheduler.activeCount(), 0);
});

test('閒置時的 removedNodes 不會啟動整棵增量重掃', () => {
  const environment = createBrowserEnvironment();
  runThreadsScript(environment);
  finishScheduledFrames(environment);
  const container = new FakeElement('div');
  const removedNode = new FakeElement('span');
  const nonElementResumeSibling = new FakeTextNode(' ');
  const followingButton = createTextSpoilerButton();
  environment.body.appendChild(container);
  container.appendChild(removedNode);
  container.appendChild(nonElementResumeSibling);
  container.appendChild(followingButton);
  removedNode.remove();

  environment.observers[0].emit([{
    type: 'childList',
    target: container,
    addedNodes: [],
    removedNodes: [removedNode],
    nextSibling: nonElementResumeSibling,
  }]);

  assert.equal(environment.scheduler.activeCount(), 0, '閒置 removal 不得建立新的 animation frame');
  assert.equal(environment.scheduler.runNext(), false, '沒有既有 traversal 時不需要補掃 sibling 鏈');
  assert.equal(followingButton.clickCount, 0, '閒置 removal 不得沿 nextSibling 啟動局部續接');
});

test('入列後已斷線的根節點不會被掃描', () => {
  const environment = createBrowserEnvironment();
  runThreadsScript(environment);
  finishScheduledFrames(environment);
  const button = createTextSpoilerButton();
  environment.body.appendChild(button);
  environment.observers[0].emit([{ addedNodes: [button] }]);
  button.remove();

  environment.scheduler.runNext();

  assert.equal(button.clickCount, 0);
  assert.equal(environment.scheduler.activeCount(), 0);
});

test('beforeunload 與 bfcache pagehide 後仍會揭露續存頁面的新增 Spoiler', () => {
  const environment = createBrowserEnvironment();
  runThreadsScript(environment);
  finishScheduledFrames(environment);

  environment.window.dispatchEvent({ type: 'beforeunload' });
  environment.window.dispatchEvent({ type: 'pagehide', persisted: true });

  assert.equal(environment.observers[0].disconnected, false);
  const button = createTextSpoilerButton();
  environment.body.appendChild(button);
  environment.observers[0].emit([{ addedNodes: [button] }]);
  assert.equal(environment.scheduler.runNext(), true);
  assert.equal(button.clickCount, 1);
});

test('非 bfcache pagehide 才中斷 observer、取消 rAF 並清空待掃描根節點', () => {
  const environment = createBrowserEnvironment();
  runThreadsScript(environment);
  finishScheduledFrames(environment);
  const button = createTextSpoilerButton();
  environment.body.appendChild(button);
  environment.observers[0].emit([{ addedNodes: [button] }]);
  assert.equal(environment.scheduler.activeCount(), 1);

  environment.window.dispatchEvent({ type: 'pagehide', persisted: false });

  assert.equal(environment.observers[0].disconnected, true);
  assert.equal(environment.scheduler.activeCount(), 0);
  assert.equal(environment.scheduler.runNext(), false);
  assert.equal(button.clickCount, 0);
});

test('metadata 禁止 iframe，並說明影片功能與提供 README 維護索引反向連結', () => {
  const source = readUserScript('threads-auto-reveal-spoiler.user.js');
  const metadataEnd = source.indexOf('// ==/UserScript==');
  const metadata = source.slice(0, metadataEnd);
  const iifeStart = source.indexOf('(function ()');

  assert.match(metadata, /^\/\/ @noframes\s*$/m);
  assert.match(metadata, /^\/\/ @description\s+.*影片.*$/m);
  assert.ok(metadataEnd >= 0 && iifeStart > metadataEnd);
  assert.match(source.slice(metadataEnd, iifeStart), /README\.md.*維護索引/);
});

test('進行中 traversal 忽略 activeRoot 外部 removal 的續接節點', () => {
  const environment = createBrowserEnvironment();
  runThreadsScript(environment);
  finishScheduledFrames(environment);

  const activeRoot = new FakeElement('section');
  for (let index = 0; index < 120; index++) {
    activeRoot.appendChild(createTextSpoilerButton());
  }
  environment.body.appendChild(activeRoot);
  environment.observers[0].emit([{ addedNodes: [activeRoot], removedNodes: [] }]);
  assert.equal(environment.scheduler.runNext(), true);
  assert.equal(environment.scheduler.activeCount(), 1, '大型 activeRoot 應保留後續幀工作');

  const unrelatedContainer = new FakeElement('section');
  const removedNode = new FakeElement('span');
  const unrelatedButton = createTextSpoilerButton();
  unrelatedContainer.appendChild(removedNode);
  unrelatedContainer.appendChild(unrelatedButton);
  environment.body.appendChild(unrelatedContainer);
  removedNode.remove();
  environment.observers[0].emit([{
    type: 'childList',
    target: unrelatedContainer,
    addedNodes: [],
    removedNodes: [removedNode],
    nextSibling: unrelatedButton,
  }]);

  finishScheduledFrames(environment);
  assert.equal(unrelatedButton.clickCount, 0);
});

test('runtime iframe 防線不建立 observer 或初始掃描工作', () => {
  const environment = createBrowserEnvironment();
  environment.window.top = {};

  runThreadsScript(environment);

  assert.equal(environment.observers.length, 0);
  assert.equal(environment.scheduler.activeCount(), 0);
});

test('簡體中文媒體 Spoiler 標籤可以被揭露', () => {
  const environment = createBrowserEnvironment();
  const simplifiedChineseButton = createMediaSpoilerButton('img', '剧透');
  environment.body.appendChild(simplifiedChineseButton);

  runThreadsScript(environment);
  finishScheduledFrames(environment);

  assert.equal(simplifiedChineseButton.clickCount, 1);
});

test('單一按鈕 click 拋錯不會中斷後續 Spoiler 掃描', () => {
  const environment = createBrowserEnvironment();
  const faultyButton = createTextSpoilerButton();
  const validButton = createTextSpoilerButton();
  let faultyClickAttempts = 0;
  faultyButton.click = () => {
    faultyClickAttempts += 1;
    throw new Error('模擬非標準按鈕 click 失敗');
  };
  environment.body.appendChild(faultyButton);
  environment.body.appendChild(validButton);

  assert.doesNotThrow(() => {
    runThreadsScript(environment);
    finishScheduledFrames(environment);
  });
  assert.equal(faultyClickAttempts, 1);
  assert.equal(validButton.clickCount, 1);
});
