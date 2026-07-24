'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { readUserScript, runUserScript } = require('./helpers/userscript-harness');

const SCRIPT_FILE = 'force-fonts-applegothic.user.js';
const TARGET_FONT = 'AppleGothic, AppleGothicSC, "Malgun Gothic", "Apple Monochrome Emoji Ind", "SF Pro Icons", "SF Pro Text", sans-serif';
const ICON_TOKENS = [
  'icon', 'iconfont', 'icomoon', 'fontawesome', 'material', 'glyph', 'symbol',
  'octicon', 'feather', 'ionicon', 'themify', 'alibaba', 'anticon', 'boxicon',
  'kt-player', 'global-iconfont', 'woo-font',
];
const ICON_PREFIXES = [
  'fa-', 'fas-', 'far-', 'fal-', 'fad-', 'fab-', 'bi-', 'ri-', 'mdi-', 'mi-',
  'oi-', 'ti-', 'si-', 'gi-', 'ai-', 'di-', 'fi-', 'hi-', 'pi-', 'vi-', 'wi-',
  'ci-', 'bx-', 'bxs-', 'bxl-',
];

/**
 * 建立足以執行字體 userscript 的最小 DOM 與瀏覽器環境。
 *
 * @param {{ hostname?: string, blacklist?: string[] }} [options] 測試主機名稱與初始黑名單。
 * @returns {object} VM sandbox、DOM 操作工具、observer 與 GM API 紀錄。
 */
function createEnvironment(options = {}) {
  const hostname = options.hostname ?? 'example.com';
  let storedBlacklist = [...(options.blacklist ?? [])];
  let querySelectorAllCalls = 0;
  let nextFrameId = 1;
  const animationFrames = new Map();
  const mutationObservers = [];
  const menuCommands = [];
  const addedStyles = [];
  const queriedSelectors = [];
  const windowListeners = new Map();

  /** 模擬元素的 inline style 宣告。 */
  class FakeStyle {
    /**
     * @param {string} [fontFamily] 初始 font-family。
     */
    constructor(fontFamily = '') {
      this.fontFamily = fontFamily;
      this.priority = '';
    }

    /** @returns {number} 已設定的 style 宣告數量。 */
    get length() {
      return this.fontFamily ? 1 : 0;
    }

    /**
     * 設定測試需要的 CSS 屬性。
     *
     * @param {string} name CSS 屬性名稱。
     * @param {string} value CSS 屬性值。
     * @param {string} priority CSS 優先權。
     * @returns {void}
     */
    setProperty(name, value, priority) {
      if (name === 'font-family') {
        this.fontFamily = value;
        this.priority = priority;
      }
    }

    /**
     * @param {string} name CSS 屬性名稱。
     * @returns {string} 該屬性的優先權。
     */
    getPropertyPriority(name) {
      return name === 'font-family' ? this.priority : '';
    }

    /**
     * 移除測試需要的 CSS 屬性。
     *
     * @param {string} name CSS 屬性名稱。
     * @returns {string} 移除前的值。
     */
    removeProperty(name) {
      if (name !== 'font-family') return '';
      const previous = this.fontFamily;
      this.fontFamily = '';
      this.priority = '';
      return previous;
    }
  }

  /** 模擬文字節點，供 characterData 與 PUA 測試使用。 */
  class FakeText {
    /**
     * @param {string} text 文字內容。
     */
    constructor(text) {
      this.nodeType = 3;
      this.textContent = text;
      this.parentElement = null;
      this.isConnected = false;
    }
  }

  /** 模擬本測試會用到的 Element 行為。 */
  class FakeElement {
    /**
     * @param {string} tagName 標籤名稱。
     * @param {{ className?: string, text?: string, fontFamily?: string }} [settings] 初始元素內容。
     */
    constructor(tagName, settings = {}) {
      this.nodeType = 1;
      this.tagName = tagName.toUpperCase();
      this.className = settings.className ?? '';
      this.attributes = new Map();
      this.childNodes = [];
      this.children = [];
      this.parentElement = null;
      this.isConnected = false;
      this.style = new FakeStyle(settings.fontFamily ?? '');
      this.computedFontFamily = settings.fontFamily ?? 'Arial';
      if (settings.text !== undefined) this.appendChild(new FakeText(settings.text));
    }

    /** @returns {string[]} 當前 class token 清單。 */
    get classList() {
      return this.className.trim() ? this.className.trim().split(/\s+/) : [];
    }

    /** @returns {FakeElement | null} 第一個元素子節點。 */
    get firstElementChild() {
      return this.children[0] ?? null;
    }

    /** @returns {FakeElement | null} 同一父元素中的下一個元素兄弟。 */
    get nextElementSibling() {
      if (!this.parentElement) return null;
      const siblings = this.parentElement.children;
      const index = siblings.indexOf(this);
      return index >= 0 ? (siblings[index + 1] ?? null) : null;
    }

    /** @returns {string} 包含後代的文字內容。 */
    get textContent() {
      return this.childNodes.map(node => node.textContent).join('');
    }

    /**
     * @param {string} value 取代既有子節點的文字。
     */
    set textContent(value) {
      this.childNodes = [];
      this.children = [];
      if (value !== '') this.appendChild(new FakeText(value));
    }

    /**
     * 加入元素或文字子節點，並同步連線狀態。
     *
     * @param {FakeElement | FakeText} child 子節點。
     * @returns {FakeElement | FakeText} 原子節點。
     */
    appendChild(child) {
      child.parentElement = this;
      child.isConnected = this.isConnected;
      this.childNodes.push(child);
      if (child.nodeType === 1) this.children.push(child);
      return child;
    }

    /**
     * 遞迴更新自身與後代的 DOM 連線狀態。
     *
     * @param {boolean} connected 是否連接文件。
     * @returns {void}
     */
    setConnected(connected) {
      this.isConnected = connected;
      for (const child of this.childNodes) {
        child.isConnected = connected;
        if (child.nodeType === 1) child.setConnected(connected);
      }
    }

    /**
     * @param {string} name 屬性名稱。
     * @param {string} value 屬性值。
     * @returns {void}
     */
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    /**
     * @param {string} name 屬性名稱。
     * @returns {string | null} 屬性值。
     */
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    /**
     * @param {string} name 屬性名稱。
     * @returns {boolean} 是否存在該屬性。
     */
    hasAttribute(name) {
      return this.attributes.has(name);
    }

    /**
     * @param {string} name 屬性名稱。
     * @returns {void}
     */
    removeAttribute(name) {
      this.attributes.delete(name);
    }

    /**
     * 判斷元素是否符合測試會遇到的簡化 selector。
     *
     * @param {string} selector 逗號分隔的 selector。
     * @returns {boolean} 是否至少符合一項。
     */
    matches(selector) {
      return selector.split(',').some(rawSelector => {
        const part = rawSelector.trim();
        if (part === '*') return true;
        if (/^[a-z][a-z0-9-]*$/i.test(part)) return this.tagName === part.toUpperCase();

        const classContains = part.match(/^\[class\*="([^"]+)"(?: i)?\]$/i);
        if (classContains) return this.className.toLowerCase().includes(classContains[1].toLowerCase());

        if (part === '[aria-hidden="true"]') return this.getAttribute('aria-hidden') === 'true';
        if (part === '[role="img"]') return this.getAttribute('role') === 'img';
        if (part === '[data-icon]') return this.hasAttribute('data-icon');
        if (part === 'i[style*="font-family"]') return this.tagName === 'I' && Boolean(this.style.fontFamily);
        return false;
      });
    }

    /**
     * 搜尋所有符合 selector 的後代元素。
     *
     * @param {string} selector 要比對的 selector。
     * @returns {FakeElement[]} 符合的後代元素。
     */
    querySelectorAll(selector) {
      querySelectorAllCalls++;
      queriedSelectors.push(selector);
      const matches = [];
      const pending = [...this.children];
      while (pending.length) {
        const child = pending.shift();
        if (child.matches(selector)) matches.push(child);
        pending.push(...child.children);
      }
      return matches;
    }
  }

  const body = new FakeElement('body');
  body.setConnected(true);
  const documentListeners = new Map();
  const document = {
    body,
    readyState: 'complete',
    fonts: [],
    querySelectorAll(selector) {
      return body.querySelectorAll(selector);
    },
    addEventListener(type, callback) {
      documentListeners.set(type, callback);
    },
  };

  /** 模擬 MutationObserver 並保留 callback 與 observe 選項。 */
  class FakeMutationObserver {
    /**
     * @param {Function} callback observer callback。
     */
    constructor(callback) {
      this.callback = callback;
      this.options = null;
      this.disconnected = false;
      mutationObservers.push(this);
    }

    /**
     * @param {FakeElement} target 觀察根節點。
     * @param {object} observerOptions 觀察選項。
     * @returns {void}
     */
    observe(target, observerOptions) {
      this.target = target;
      this.options = observerOptions;
    }

    /** @returns {void} 標記 observer 已釋放。 */
    disconnect() {
      this.disconnected = true;
    }
  }

  const windowObject = {
    addEventListener(type, callback) {
      windowListeners.set(type, callback);
    },
    removeEventListener(type, callback) {
      if (windowListeners.get(type) === callback) windowListeners.delete(type);
    },
  };
  windowObject.self = windowObject;
  windowObject.top = windowObject;

  const sandbox = {
    window: windowObject,
    document,
    location: { hostname },
    MutationObserver: FakeMutationObserver,
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      animationFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      animationFrames.delete(id);
    },
    getComputedStyle(element) {
      return { fontFamily: element.computedFontFamily || element.style.fontFamily || 'Arial' };
    },
    GM_addStyle(css) {
      addedStyles.push(css);
    },
    GM_getValue(key, fallback) {
      return key === 'blacklist' ? [...storedBlacklist] : fallback;
    },
    GM_setValue(key, value) {
      if (key === 'blacklist') storedBlacklist = [...value];
    },
    GM_registerMenuCommand(label, callback) {
      menuCommands.push({ label, callback });
    },
    alert() {},
    confirm() { return true; },
  };

  /**
   * 執行目前排定的所有動畫幀；新排定的 callback 留到下一輪。
   *
   * @returns {number} 此輪執行的 callback 數量。
   */
  function runAnimationFrame() {
    const callbacks = [...animationFrames.entries()];
    animationFrames.clear();
    for (const [, callback] of callbacks) callback();
    return callbacks.length;
  }

  return {
    FakeElement,
    FakeText,
    addedStyles,
    animationFrames,
    body,
    menuCommands,
    mutationObservers,
    queriedSelectors,
    runAnimationFrame,
    sandbox,
    windowListeners,
    dispatchWindow(event) {
      windowListeners.get(event.type)?.(event);
    },
    getBlacklist: () => [...storedBlacklist],
    setBlacklist: value => { storedBlacklist = [...value]; },
    getQuerySelectorAllCalls: () => querySelectorAllCalls,
    resetQuerySelectorAllCalls: () => { querySelectorAllCalls = 0; },
  };
}

/**
 * 將元素接到 body，供初始化掃描使用。
 *
 * @param {object} environment createEnvironment 的回傳值。
 * @param {object} element 要加入的元素。
 * @returns {object} 原元素。
 */
function appendToBody(environment, element) {
  environment.body.appendChild(element);
  element.setConnected(true);
  return element;
}

/**
 * 執行指定次數上限內的所有排定動畫幀。
 *
 * @param {object} environment createEnvironment 的回傳值。
 * @param {number} [limit] 防止失控排程的最大幀數。
 * @returns {void}
 */
function drainAnimationFrames(environment, limit = 20) {
  for (let i = 0; i < limit && environment.animationFrames.size; i++) {
    environment.runAnimationFrame();
  }
  assert.equal(environment.animationFrames.size, 0, '動畫幀佇列應在上限內清空');
}

test('icon token 與 prefix 由單一資料來源同步產生三條保護路徑', () => {
  const source = readUserScript(SCRIPT_FILE);
  assert.match(source, /const ICON_CLASS_TOKENS = Object\.freeze\(/);
  assert.match(source, /const ICON_CLASS_PREFIXES = Object\.freeze\(/);

  const environment = createEnvironment();
  const prefixElements = ICON_PREFIXES.map(prefix => (
    appendToBody(environment, new environment.FakeElement('span', { className: `${prefix}sample` }))
  ));
  const tokenElements = ICON_TOKENS.map(token => (
    appendToBody(environment, new environment.FakeElement('span', { className: `sample-${token}-value` }))
  ));
  const falsePositive = appendToBody(
    environment,
    new environment.FakeElement('span', { className: 'lexicon-content' }),
  );

  runUserScript(SCRIPT_FILE, environment.sandbox);

  const css = environment.addedStyles.join('\n');
  const candidateSelector = environment.queriedSelectors.find(selector => selector.includes('[aria-hidden="true"]'));
  assert.equal(typeof candidateSelector, 'string', '初始化掃描應使用 icon 候選 selector');
  assert.ok(css.includes(':not([data-icon])'), '既有 data-icon CSS 排除必須保留');
  for (let index = 0; index < ICON_TOKENS.length; index++) {
    const token = ICON_TOKENS[index];
    assert.equal(tokenElements[index].hasAttribute('data-no-font'), true, `${token} class 應被判定為 icon`);
    assert.ok(css.includes(`[class*="${token}" i]`), `${token} 應出現在 CSS 排除條件`);
    assert.ok(candidateSelector.includes(`[class*="${token}" i]`), `${token} 應出現在候選 selector`);
  }
  for (let index = 0; index < ICON_PREFIXES.length; index++) {
    const prefix = ICON_PREFIXES[index];
    assert.equal(prefixElements[index].hasAttribute('data-no-font'), true, `${prefix} class 應被判定為 icon`);
    assert.ok(css.includes(`[class*="${prefix}" i]`), `${prefix} 應出現在 CSS 排除條件`);
    assert.ok(candidateSelector.includes(`[class*="${prefix}" i]`), `${prefix} 應出現在候選 selector`);
  }
  assert.equal(falsePositive.hasAttribute('data-no-font'), false, 'lexicon 不可被 icon 詞邊界誤判');
});

test('BMP 與補充私用區 code point 都會被標記為 icon', () => {
  const environment = createEnvironment();
  const bmpPua = appendToBody(environment, new environment.FakeElement('span', { text: '\uE000' }));
  const supplementaryPuaA = appendToBody(environment, new environment.FakeElement('span', { text: String.fromCodePoint(0xF0000) }));
  const supplementaryPuaB = appendToBody(environment, new environment.FakeElement('span', { text: String.fromCodePoint(0x100000) }));

  runUserScript(SCRIPT_FILE, environment.sandbox);

  assert.equal(bmpPua.hasAttribute('data-no-font'), true);
  assert.equal(supplementaryPuaA.hasAttribute('data-no-font'), true);
  assert.equal(supplementaryPuaB.hasAttribute('data-no-font'), true);
});

test('相關屬性與文字變化會讓已處理元素重新判定', () => {
  const environment = createEnvironment();
  const classTarget = appendToBody(environment, new environment.FakeElement('span', { text: 'A' }));
  const styleTarget = appendToBody(environment, new environment.FakeElement('span', { text: 'B' }));
  const textTarget = appendToBody(environment, new environment.FakeElement('span', { text: 'C' }));

  runUserScript(SCRIPT_FILE, environment.sandbox);
  const observer = environment.mutationObservers[0];
  assert.ok(observer, '應建立 MutationObserver');
  assert.deepEqual(
    [...observer.options.attributeFilter].sort(),
    ['aria-hidden', 'class', 'data-icon', 'role', 'style'].sort(),
  );
  assert.equal(observer.options.attributes, true);
  assert.equal(observer.options.characterData, true);

  classTarget.className = 'bi-alarm';
  observer.callback([{ type: 'attributes', target: classTarget, attributeName: 'class', addedNodes: [] }]);
  drainAnimationFrames(environment);
  assert.equal(classTarget.hasAttribute('data-no-font'), true);

  classTarget.className = '';
  observer.callback([{ type: 'attributes', target: classTarget, attributeName: 'class', addedNodes: [] }]);
  drainAnimationFrames(environment);
  assert.equal(classTarget.hasAttribute('data-no-font'), false, '移除 icon class 後應撤銷舊標記');

  styleTarget.style.fontFamily = 'Material Icons';
  styleTarget.computedFontFamily = 'Material Icons';
  observer.callback([{ type: 'attributes', target: styleTarget, attributeName: 'style', addedNodes: [] }]);
  drainAnimationFrames(environment);
  assert.equal(styleTarget.hasAttribute('data-no-font'), true);

  const textNode = textTarget.childNodes[0];
  textNode.textContent = String.fromCodePoint(0x100000);
  observer.callback([{ type: 'characterData', target: textNode, addedNodes: [] }]);
  drainAnimationFrames(environment);
  assert.equal(textTarget.hasAttribute('data-no-font'), true);
});

test('Icon 容器內的普通後代發生 mutation 後仍維持字體排除', () => {
  const environment = createEnvironment();
  const container = appendToBody(
    environment,
    new environment.FakeElement('span', { className: 'material-icons' }),
  );
  const descendant = new environment.FakeElement('span', { text: '普通後代' });
  container.appendChild(descendant);
  descendant.setConnected(true);

  runUserScript(SCRIPT_FILE, environment.sandbox);
  const observer = environment.mutationObservers[0];
  assert.equal(descendant.hasAttribute('data-no-font'), true, '初始掃描應繼承 Icon 容器保護');

  descendant.className = 'layout-child';
  observer.callback([{ type: 'attributes', target: descendant, attributeName: 'class', addedNodes: [] }]);
  drainAnimationFrames(environment);

  assert.equal(descendant.hasAttribute('data-no-font'), true, '重新判定不可移除容器繼承的排除標記');
  assert.notEqual(descendant.style.fontFamily, TARGET_FONT, '容器後代不可套用全域目標字體');

  container.childNodes = [];
  container.children = [];
  environment.body.appendChild(descendant);
  descendant.setConnected(true);
  observer.callback([
    { type: 'childList', target: container, addedNodes: [], removedNodes: [descendant] },
  ]);
  drainAnimationFrames(environment);

  assert.equal(descendant.hasAttribute('data-no-font'), false, '移出 Icon 容器後應對稱解除繼承標記');
});

test('普通 inline 字體容器動態轉為 Icon 時會還原後代原始字體', () => {
  const environment = createEnvironment();
  const container = appendToBody(
    environment,
    new environment.FakeElement('span', { fontFamily: 'Arial' }),
  );
  const descendant = new environment.FakeElement('span', {
    text: '普通後代',
    fontFamily: 'Tahoma',
  });
  container.appendChild(descendant);
  descendant.setConnected(true);

  runUserScript(SCRIPT_FILE, environment.sandbox);
  const observer = environment.mutationObservers[0];
  assert.equal(container.style.fontFamily, TARGET_FONT);
  assert.equal(descendant.style.fontFamily, TARGET_FONT);

  container.className = 'material-icons';
  observer.callback([{ type: 'attributes', target: container, attributeName: 'class', addedNodes: [] }]);
  drainAnimationFrames(environment);

  assert.equal(container.hasAttribute('data-no-font'), true);
  assert.equal(descendant.hasAttribute('data-no-font'), true);
  assert.equal(container.style.fontFamily, 'Arial');
  assert.equal(descendant.style.fontFamily, 'Tahoma', '容器保護前須先撤銷腳本留下的 inline !important');
});

test('獨立 Icon 移入另一個 Icon 容器時會清除舊父層標記', () => {
  const environment = createEnvironment();
  const oldParent = appendToBody(environment, new environment.FakeElement('div'));
  const icon = new environment.FakeElement('span', { className: 'material-icons' });
  oldParent.appendChild(icon);
  icon.setConnected(true);
  const newContainer = appendToBody(
    environment,
    new environment.FakeElement('span', { className: 'material-icons' }),
  );

  runUserScript(SCRIPT_FILE, environment.sandbox);
  const observer = environment.mutationObservers[0];
  assert.equal(oldParent.hasAttribute('data-no-font-parent'), true);

  oldParent.childNodes = [];
  oldParent.children = [];
  newContainer.appendChild(icon);
  icon.setConnected(true);
  observer.callback([
    { type: 'childList', target: oldParent, addedNodes: [], removedNodes: [icon] },
    { type: 'childList', target: newContainer, addedNodes: [icon], removedNodes: [] },
  ]);
  drainAnimationFrames(environment);

  assert.equal(icon.hasAttribute('data-no-font'), true);
  assert.equal(oldParent.hasAttribute('data-no-font-parent'), false, '舊父層不可保留失效的 Icon 子元素標記');
});

test('手動重掃後的動態 Icon 仍會還原原始 inline font-family', () => {
  const environment = createEnvironment();
  const target = appendToBody(environment, new environment.FakeElement('div', { fontFamily: 'Arial' }));

  runUserScript(SCRIPT_FILE, environment.sandbox);
  assert.equal(target.style.fontFamily, TARGET_FONT);

  const rescanCommand = environment.menuCommands.find(command => command.label.includes('重新掃描'));
  rescanCommand.callback();
  target.className = 'mdi-account';
  environment.mutationObservers[0].callback([
    { type: 'attributes', target, attributeName: 'class', addedNodes: [], removedNodes: [] },
  ]);
  drainAnimationFrames(environment);

  assert.equal(target.hasAttribute('data-no-font'), true);
  assert.equal(target.style.fontFamily, 'Arial');
});

test('移除 Icon 節點時會對稱清除原父元素標記', () => {
  const environment = createEnvironment();
  const parent = appendToBody(environment, new environment.FakeElement('div'));
  const icon = new environment.FakeElement('span', { className: 'ri-home-line' });
  parent.appendChild(icon);
  icon.setConnected(true);

  runUserScript(SCRIPT_FILE, environment.sandbox);
  assert.equal(parent.hasAttribute('data-no-font-parent'), true);

  parent.childNodes = [];
  parent.children = [];
  icon.parentElement = null;
  icon.setConnected(false);
  environment.mutationObservers[0].callback([
    { type: 'childList', target: parent, addedNodes: [], removedNodes: [icon] },
  ]);
  drainAnimationFrames(environment);

  assert.equal(parent.hasAttribute('data-no-font-parent'), false);
});

test('observer 以每幀上限增量探索後代，且略過脫離 DOM 的節點', () => {
  const environment = createEnvironment();
  runUserScript(SCRIPT_FILE, environment.sandbox);
  const observer = environment.mutationObservers[0];
  const root = new environment.FakeElement('section');
  const descendants = [];
  for (let index = 0; index < 250; index++) {
    const child = new environment.FakeElement('span', { text: '\uE000' });
    root.appendChild(child);
    descendants.push(child);
  }
  appendToBody(environment, root);

  environment.resetQuerySelectorAllCalls();
  observer.callback([{ type: 'childList', target: environment.body, addedNodes: [root] }]);
  assert.equal(environment.getQuerySelectorAllCalls(), 0, 'observer callback 不應同步 querySelectorAll 整棵新增子樹');

  environment.runAnimationFrame();
  const firstFrameCount = descendants.filter(element => element.hasAttribute('data-no-font')).length;
  assert.ok(firstFrameCount > 0 && firstFrameCount <= 100, `首幀應只處理上限內元素，實際 ${firstFrameCount}`);
  drainAnimationFrames(environment);
  assert.equal(descendants.every(element => element.hasAttribute('data-no-font')), true);

  const detached = new environment.FakeElement('span', { text: '\uE000' });
  observer.callback([{ type: 'childList', target: environment.body, addedNodes: [detached] }]);
  drainAnimationFrames(environment);
  assert.equal(detached.hasAttribute('data-no-font'), false);
});

test('動態大型 Icon 容器不會同步查詢後代且逐幀套用排除', () => {
  const environment = createEnvironment();
  runUserScript(SCRIPT_FILE, environment.sandbox);
  const observer = environment.mutationObservers[0];
  const root = new environment.FakeElement('section', { className: 'material-icons' });
  const descendants = [];
  for (let index = 0; index < 250; index++) {
    const child = new environment.FakeElement('span', { text: `後代-${index}` });
    root.appendChild(child);
    descendants.push(child);
  }
  appendToBody(environment, root);

  let rootQuerySelectorAllCalls = 0;
  const originalQuerySelectorAll = root.querySelectorAll.bind(root);
  root.querySelectorAll = (selector) => {
    rootQuerySelectorAllCalls += 1;
    return originalQuerySelectorAll(selector);
  };

  observer.callback([{ type: 'childList', target: environment.body, addedNodes: [root] }]);
  assert.equal(rootQuerySelectorAllCalls, 0, 'observer callback 不可同步展開 Icon subtree');

  environment.runAnimationFrame();
  const firstFrameCount = descendants.filter(element => element.hasAttribute('data-no-font')).length;
  assert.equal(rootQuerySelectorAllCalls, 0, '逐幀工作不可用 querySelectorAll 一次標記整棵 Icon subtree');
  assert.ok(firstFrameCount < descendants.length, '首幀不可處理完整大型 Icon subtree');

  drainAnimationFrames(environment);
  assert.equal(descendants.every(element => element.hasAttribute('data-no-font')), true);
});

test('大型 Icon 容器失去 Icon 身分時逐幀拆除並重新判定後代', () => {
  const environment = createEnvironment();
  const root = new environment.FakeElement('section', { className: 'material-icons' });
  const ordinaryDescendants = [];
  for (let index = 0; index < 249; index++) {
    const child = new environment.FakeElement('span', { text: `普通-${index}` });
    root.appendChild(child);
    ordinaryDescendants.push(child);
  }
  const nestedIcon = new environment.FakeElement('span', { className: 'ri-home-line' });
  root.appendChild(nestedIcon);
  appendToBody(environment, root);

  runUserScript(SCRIPT_FILE, environment.sandbox);
  const observer = environment.mutationObservers[0];
  assert.equal(ordinaryDescendants.every(element => element.hasAttribute('data-no-font')), true);

  let rootQuerySelectorAllCalls = 0;
  const originalQuerySelectorAll = root.querySelectorAll.bind(root);
  root.querySelectorAll = (selector) => {
    rootQuerySelectorAllCalls += 1;
    return originalQuerySelectorAll(selector);
  };
  root.className = 'content-container';
  observer.callback([{ type: 'attributes', target: root, attributeName: 'class', addedNodes: [] }]);
  assert.equal(rootQuerySelectorAllCalls, 0);

  environment.runAnimationFrame();
  const stillProtected = ordinaryDescendants.filter(element => element.hasAttribute('data-no-font')).length;
  assert.equal(rootQuerySelectorAllCalls, 0, '反向轉態不可重新同步查詢整棵 subtree');
  assert.ok(stillProtected > 0 && stillProtected < ordinaryDescendants.length, '首幀只可拆除預算內的後代標記');

  const protectedAfterFirstFrame = ordinaryDescendants
    .filter(element => element.hasAttribute('data-no-font'));
  const detachedDuringTraversal = protectedAfterFirstFrame[1];
  root.childNodes = root.childNodes.filter(node => node !== detachedDuringTraversal);
  root.children = root.children.filter(node => node !== detachedDuringTraversal);
  detachedDuringTraversal.parentElement = null;
  detachedDuringTraversal.setConnected(false);
  observer.callback([{
    type: 'childList',
    target: root,
    addedNodes: [],
    removedNodes: [detachedDuringTraversal],
  }]);

  drainAnimationFrames(environment);
  assert.equal(
    ordinaryDescendants
      .filter(element => element !== detachedDuringTraversal)
      .every(element => !element.hasAttribute('data-no-font')),
    true,
    '中途移除一個 traversal 節點不可截斷後續兄弟的重新判定',
  );
  assert.equal(nestedIcon.hasAttribute('data-no-font'), true, '後代中的獨立 Icon 必須重新判定並保留排除');
});

test('beforeunload 與 bfcache pagehide 後 mutation 仍可重新判定元素', () => {
  const environment = createEnvironment();
  const target = appendToBody(environment, new environment.FakeElement('span', { text: 'A' }));
  runUserScript(SCRIPT_FILE, environment.sandbox);
  const observer = environment.mutationObservers[0];

  environment.dispatchWindow({ type: 'beforeunload' });
  environment.dispatchWindow({ type: 'pagehide', persisted: true });

  assert.equal(observer.disconnected, false);
  target.className = 'bi-alarm';
  observer.callback([{ type: 'attributes', target, attributeName: 'class', addedNodes: [] }]);
  drainAnimationFrames(environment);
  assert.equal(target.hasAttribute('data-no-font'), true);
});

test('非 bfcache pagehide 才中斷 observer、取消動畫幀並清空待處理佇列', () => {
  const environment = createEnvironment();
  for (let index = 0; index < 1001; index++) {
    appendToBody(environment, new environment.FakeElement('span', { text: `初始-${index}` }));
  }
  runUserScript(SCRIPT_FILE, environment.sandbox);
  const observer = environment.mutationObservers[0];
  const pending = appendToBody(environment, new environment.FakeElement('span', { text: '\uE000' }));

  observer.callback([{ type: 'childList', target: environment.body, addedNodes: [pending] }]);
  assert.ok(environment.animationFrames.size > 0);

  environment.dispatchWindow({ type: 'pagehide', persisted: false });
  assert.equal(observer.disconnected, true);
  assert.equal(environment.animationFrames.size, 0);
  assert.equal(pending.hasAttribute('data-no-font'), false, '清理後不可再處理原佇列');
});

test('黑名單選單每次重讀設定、以 Set 去重並移除全部目前 hostname', () => {
  const enabledEnvironment = createEnvironment({ blacklist: [] });
  runUserScript(SCRIPT_FILE, enabledEnvironment.sandbox);
  enabledEnvironment.setBlacklist(['other.example', 'other.example']);
  enabledEnvironment.menuCommands[0].callback();
  assert.deepEqual(enabledEnvironment.getBlacklist(), ['other.example', 'example.com']);

  const disabledEnvironment = createEnvironment({
    blacklist: ['example.com', 'example.com', 'other.example', 'other.example'],
  });
  runUserScript(SCRIPT_FILE, disabledEnvironment.sandbox);
  disabledEnvironment.setBlacklist(['example.com', 'other.example', 'example.com', 'other.example']);
  disabledEnvironment.menuCommands[0].callback();
  assert.deepEqual(disabledEnvironment.getBlacklist(), ['other.example']);
});

test('核心 CSS 只引用 TARGET_FONT，程式碼字體順序與文件反向連結維持正確', () => {
  const source = readUserScript(SCRIPT_FILE);
  const styleSource = source.slice(source.indexOf('function initStyles'), source.indexOf('// ===== 常數與狀態'));
  assert.equal((styleSource.match(/\$\{TARGET_FONT\}/g) ?? []).length, 3);
  assert.match(
    source,
    /font-family: "Cascadia Code", "Cascadia Mono", Consolas, "SF Mono", "JetBrains Mono", monospace, AppleGothic, AppleGothicSC !important;/,
  );
  assert.match(source, /維護索引：README\.md「維護索引」/);

  const environment = createEnvironment();
  runUserScript(SCRIPT_FILE, environment.sandbox);
  const css = environment.addedStyles.join('\n');
  assert.ok(css.includes(`font-family: ${TARGET_FONT} !important;`));
});

test('正式腳本全部具名函式都有繁體中文 JSDoc', () => {
  const source = readUserScript(SCRIPT_FILE);
  const namedFunctions = [...source.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1]);
  assert.ok(namedFunctions.length > 0);
  for (const name of namedFunctions) {
    const declarationIndex = source.indexOf(`function ${name}`);
    const leadingSource = source.slice(0, declarationIndex);
    const lastDocStart = leadingSource.lastIndexOf('/**');
    const lastDocEnd = leadingSource.lastIndexOf('*/');
    assert.ok(lastDocStart !== -1 && lastDocEnd > lastDocStart, `${name} 前方缺少 JSDoc`);
    const between = leadingSource.slice(lastDocEnd + 2);
    assert.match(between, /^\s*(?:\(\s*)?$/, `${name} 的 JSDoc 與函式之間不應夾雜其他敘述`);
    assert.match(leadingSource.slice(lastDocStart, lastDocEnd + 2), /[\u3400-\u9FFF]/, `${name} 的 JSDoc 應使用繁體中文說明`);
  }
});
