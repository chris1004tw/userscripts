'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readUserScript,
  runUserScript,
} = require('./helpers/userscript-harness');

const SCRIPT_FILE = 'social-media-volume-fix.user.js';

/**
 * 建立社群影片腳本所需的最小瀏覽器環境，並保留可觀察的 DOM、計時器與 GM 寫入紀錄。
 *
 * @param {{ volume?: number, muted?: boolean }} [initialSettings={}] 初始音量百分比與靜音狀態。
 * @param {{
 *   denyUnsafeDocumentEvents?: boolean,
 *   denyUnsafeObserverOptions?: boolean,
 *   isIframe?: boolean,
 *   simulateMediaEvents?: boolean,
 *   platformVolume?: number,
 *   platformMuted?: boolean
 * }} [environmentOptions={}] Firefox 權限邊界與媒體事件回授模擬選項。
 * @returns {object} 測試操作介面；建立時會立即執行正式 userscript，副作用侷限於 VM stub。
 */
function createEnvironment(initialSettings = {}, environmentOptions = {}) {
  let savedSettings = {
    volume: initialSettings.volume ?? 30,
    muted: initialSettings.muted ?? false,
  };
  let nextMenuId = 1;
  let nextTimerId = 1;
  let nextFrameId = 1;
  let subtreeQueryCount = 0;
  let currentTime = 1000;

  const settingsWrites = [];
  const clearedTimerIds = [];
  const timers = new Map();
  const animationFrames = new Map();
  const observers = [];
  const menuRegistrations = [];
  const currentVideos = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const pendingMediaEvents = [];

  /** 模擬頁面原生媒體元素，讓測試能區分原生狀態與 userscript setter。 */
  class FakeMediaElement {
    /** 建立採用瀏覽器預設音量與靜音狀態的媒體元素。 */
    constructor() {
      this.nativeVolume = 1;
      this.nativeMuted = false;
      this.paused = true;
      this.nodeType = 1;
      this.isConnected = true;
      this.parentElement = null;
      this.children = [];
    }

    /** @returns {FakeMediaElement | null} 第一個直接子元素；影片固定沒有後代。 */
    get firstElementChild() {
      return this.children[0] ?? null;
    }

    /** @returns {FakeMediaElement | FakeElement | null} 同一父層中的下一個元素兄弟。 */
    get nextElementSibling() {
      if (!this.parentElement) return null;
      const siblings = this.parentElement.children;
      const index = siblings.indexOf(this);
      return index >= 0 ? (siblings[index + 1] ?? null) : null;
    }
  }

  Object.defineProperties(FakeMediaElement.prototype, {
    volume: {
      get() { return this.nativeVolume; },
      set(value) {
        if (this.nativeVolume === value) return;
        this.nativeVolume = value;
        if (environmentOptions.simulateMediaEvents) pendingMediaEvents.push(this);
      },
      configurable: true,
      enumerable: true,
    },
    muted: {
      get() { return this.nativeMuted; },
      set(value) {
        const normalized = Boolean(value);
        if (this.nativeMuted === normalized) return;
        this.nativeMuted = normalized;
        if (environmentOptions.simulateMediaEvents) pendingMediaEvents.push(this);
      },
      configurable: true,
      enumerable: true,
    },
  });

  /** 模擬實際 video 節點，供事件目標識別與新增節點套用設定。 */
  class FakeVideoElement extends FakeMediaElement {
    /** 建立沒有後代節點的 video 元素。 */
    constructor() {
      super();
      this.tagName = 'VIDEO';
    }

    /**
     * 回傳 video 節點的後代查詢結果。
     *
     * @param {string} selector CSS 選擇器。
     * @returns {FakeVideoElement[]} video 自身沒有 video 後代，因此固定回傳空陣列。
     */
    querySelectorAll(selector) {
      assert.equal(selector, 'video');
      subtreeQueryCount += 1;
      return [];
    }
  }

  /** 模擬可包含動態影片的普通 DOM 子樹。 */
  class FakeElement {
    /**
     * @param {Array<FakeElement | FakeVideoElement>} [children=[]] 此節點包含的後代節點。
     */
    constructor(children = []) {
      this.tagName = 'DIV';
      this.nodeType = 1;
      this.isConnected = true;
      this.parentElement = null;
      this.children = [];
      children.forEach((child) => this.appendChild(child));
    }

    /** @returns {FakeElement | FakeVideoElement | null} 第一個直接子元素。 */
    get firstElementChild() {
      return this.children[0] ?? null;
    }

    /** @returns {FakeElement | FakeVideoElement | null} 同一父層中的下一個元素兄弟。 */
    get nextElementSibling() {
      if (!this.parentElement) return null;
      const siblings = this.parentElement.children;
      const index = siblings.indexOf(this);
      return index >= 0 ? (siblings[index + 1] ?? null) : null;
    }

    /**
     * 加入直接子元素並建立父子關係。
     *
     * @param {FakeElement | FakeVideoElement} child 要加入的元素。
     * @returns {FakeElement | FakeVideoElement} 原子元素；副作用是更新 children 與 parentElement。
     */
    appendChild(child) {
      child.parentElement = this;
      child.isConnected = this.isConnected;
      this.children.push(child);
      return child;
    }

    /**
     * 以深度優先方式回傳子樹內所有 video，模擬 `querySelectorAll('video')`。
     *
     * @param {string} selector CSS 選擇器。
     * @returns {FakeVideoElement[]} 子樹內的所有影片節點。
     */
    querySelectorAll(selector) {
      assert.equal(selector, 'video');
      subtreeQueryCount += 1;
      const videos = [];
      this.children.forEach((child) => {
        if (child instanceof FakeVideoElement) videos.push(child);
        videos.push(...child.querySelectorAll(selector));
      });
      return videos;
    }
  }

  /** 記錄 observer 設定與清理狀態，並允許測試主動送入 mutation records。 */
  class FakeMutationObserver {
    /**
     * @param {(records: Array<object>) => void} callback DOM 變動時執行的回呼。
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
     * @param {object} target 被監聽的 DOM 目標。
     * @param {MutationObserverInit} options 監聽選項。
     * @returns {void} 無回傳值；副作用是新增一筆監聽紀錄。
     */
    observe(target, options) {
      this.observeCalls.push({ target, options });
    }

    /**
     * 標記 observer 已釋放。
     *
     * @returns {void} 無回傳值；副作用是更新清理狀態。
     */
    disconnect() {
      this.disconnected = true;
    }

    /**
     * 將指定 records 同步交給正式 observer callback。
     *
     * @param {Array<object>} records 要模擬的 DOM 變動紀錄。
     * @returns {void} 無回傳值；副作用由正式 callback 決定。
     */
    emit(records) {
      if (!this.disconnected) this.callback(records);
    }
  }

  /**
   * 將事件處理器加入指定事件表。
   *
   * @param {Map<string, Function[]>} listenerMap 目標的事件表。
   * @param {string} type 事件類型。
   * @param {Function} callback 事件回呼。
   * @returns {void} 無回傳值；副作用是保存事件回呼。
   */
  function addListener(listenerMap, type, callback) {
    const callbacks = listenerMap.get(type) ?? [];
    callbacks.push(callback);
    listenerMap.set(type, callbacks);
  }

  /**
   * 從指定事件表移除完全相同的事件處理器。
   *
   * @param {Map<string, Function[]>} listenerMap 目標的事件表。
   * @param {string} type 事件類型。
   * @param {Function} callback 要移除的事件回呼。
   * @returns {void} 無回傳值；副作用是更新事件表。
   */
  function removeListener(listenerMap, type, callback) {
    const callbacks = listenerMap.get(type) ?? [];
    listenerMap.set(type, callbacks.filter((candidate) => candidate !== callback));
  }

  /**
   * 執行指定事件表中的全部回呼。
   *
   * @param {Map<string, Function[]>} listenerMap 目標的事件表。
   * @param {string} type 事件類型。
   * @param {object} event 事件內容。
   * @returns {void} 無回傳值；副作用是觸發正式事件邏輯。
   */
  function dispatch(listenerMap, type, event) {
    if (event.type === undefined) event.type = type;
    (listenerMap.get(type) ?? []).forEach((callback) => callback(event));
  }

  const documentStub = {
    readyState: 'complete',
    querySelectorAll(selector) {
      assert.equal(selector, 'video');
      return currentVideos;
    },
    addEventListener(type, callback) {
      addListener(documentListeners, type, callback);
    },
    removeEventListener(type, callback) {
      removeListener(documentListeners, type, callback);
    },
  };

  // 模擬 Firefox 中 unsafeWindow.document 與 userscript document 具有不同權限邊界。
  const unsafeDocumentStub = Object.create(documentStub);
  if (environmentOptions.denyUnsafeDocumentEvents) {
    unsafeDocumentStub.addEventListener = function () {
      throw new Error('Permission denied to access unsafeWindow.document');
    };
    unsafeDocumentStub.removeEventListener = function () {
      throw new Error('Permission denied to access unsafeWindow.document');
    };
  }

  const pageWindow = {
    document: documentStub,
    HTMLMediaElement: FakeMediaElement,
    HTMLVideoElement: FakeVideoElement,
    MutationObserver: FakeMutationObserver,
    requestAnimationFrame(callback) {
      const id = nextFrameId;
      nextFrameId += 1;
      animationFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      animationFrames.delete(id);
    },
    addEventListener(type, callback) {
      addListener(windowListeners, type, callback);
    },
    removeEventListener(type, callback) {
      removeListener(windowListeners, type, callback);
    },
  };
  pageWindow.self = pageWindow;
  pageWindow.top = environmentOptions.isIframe ? {} : pageWindow;

  // unsafeWindow 使用獨立物件，讓測試能偵測頁面 realm 與 userscript realm 混用。
  const unsafeWindowStub = Object.create(pageWindow);
  unsafeWindowStub.document = unsafeDocumentStub;
  if (environmentOptions.denyUnsafeObserverOptions) {
    /** 模擬 Firefox 拒絕頁面 realm observer 讀取 userscript realm observe options。 */
    class UnsafeMutationObserver extends FakeMutationObserver {
      /**
       * @returns {void} 固定拋出跨 context 權限錯誤，不建立觀察。
       */
      observe() {
        throw new Error('Permission denied to access property "attributeFilter"');
      }
    }
    unsafeWindowStub.MutationObserver = UnsafeMutationObserver;
  }

  /**
   * 建立可由測試控制的計時器。
   *
   * @param {Function} callback 到期時執行的回呼。
   * @param {number} [delay=0] 延遲毫秒數。
   * @returns {number} 可供取消的計時器識別碼。
   */
  function setTimeoutStub(callback, delay = 0) {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, { callback, delay });
    return id;
  }

  /**
   * 取消指定計時器並記錄清理行為。
   *
   * @param {number} id 計時器識別碼。
   * @returns {void} 無回傳值；副作用是移除計時器並保存識別碼。
   */
  function clearTimeoutStub(id) {
    clearedTimerIds.push(id);
    timers.delete(id);
  }

  /** 提供可由測試推進的時間來源，避免 burst 熔斷測試依賴真實等待。 */
  class FakeDate extends Date {
    /** @returns {number} 目前測試控制的 Unix 毫秒時間。 */
    static now() {
      return currentTime;
    }
  }

  runUserScript(SCRIPT_FILE, {
    window: pageWindow,
    unsafeWindow: unsafeWindowStub,
    document: documentStub,
    MutationObserver: FakeMutationObserver,
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimeoutStub,
    requestAnimationFrame: pageWindow.requestAnimationFrame,
    cancelAnimationFrame: pageWindow.cancelAnimationFrame,
    Date: FakeDate,
    GM_getValue() {
      return { ...savedSettings };
    },
    GM_setValue(key, value) {
      assert.equal(key, 'vvf_settings');
      savedSettings = { ...value };
      settingsWrites.push({ ...value });
    },
    GM_registerMenuCommand(label, callback, menuOptions) {
      const id = menuOptions?.id ?? nextMenuId;
      if (menuOptions?.id == null) nextMenuId += 1;
      menuRegistrations.push({ label, callback, menuOptions, id });
      return id;
    },
    prompt() {
      return null;
    },
  });

  return {
    FakeElement,
    FakeVideoElement,
    observers,
    menuRegistrations,
    settingsWrites,
    clearedTimerIds,
    timers,
    animationFrames,
    getSavedSettings: () => ({ ...savedSettings }),
    addCurrentVideo(video) {
      currentVideos.push(video);
    },
    dispatchDocument(type, event) {
      dispatch(documentListeners, type, event);
    },
    dispatchWindow(type, event = {}) {
      dispatch(windowListeners, type, event);
    },
    /**
     * 依序派送原生 setter 產生的 volumechange，並在 capture listener 後模擬平台恢復自身狀態。
     *
     * @param {number} [limit=50] 判定事件活鎖的安全上限。
     * @returns {number} 實際派送的媒體事件數；副作用是執行 userscript 與平台回寫邏輯。
     */
    flushMediaEvents(limit = 50) {
      let dispatched = 0;
      while (pendingMediaEvents.length > 0) {
        assert.ok(dispatched < limit, 'volumechange 事件佇列不應形成活鎖');
        const video = pendingMediaEvents.shift();
        dispatch(documentListeners, 'volumechange', { type: 'volumechange', target: video });

        // 真實頁面 listener 會在 userscript 的 capture handler 後執行，並可能恢復平台狀態。
        if (environmentOptions.platformVolume !== undefined) {
          video.volume = environmentOptions.platformVolume;
        }
        if (environmentOptions.platformMuted !== undefined) {
          video.muted = environmentOptions.platformMuted;
        }
        dispatched += 1;
      }
      return dispatched;
    },
    pendingMediaEventCount: () => pendingMediaEvents.length,
    /**
     * 更新後續媒體事件要模擬的平台回寫狀態；傳入 undefined 可停止對應欄位的回寫。
     *
     * @param {{ volume?: number, muted?: boolean }} state 平台希望維持的媒體狀態。
     * @returns {void} 無回傳值；副作用是更新測試環境選項。
     */
    setPlatformMediaState(state) {
      environmentOptions.platformVolume = state.volume;
      environmentOptions.platformMuted = state.muted;
    },
    /**
     * 推進 volumechange burst 判定所使用的測試時間。
     *
     * @param {number} milliseconds 要增加的毫秒數。
     * @returns {void} 無回傳值；副作用是更新 FakeDate.now() 的結果。
     */
    advanceTime(milliseconds) {
      currentTime += milliseconds;
    },
    flushTimers() {
      let safetyCount = 0;
      while (timers.size > 0) {
        const pending = [...timers.entries()];
        timers.clear();
        pending.forEach(([, timer]) => timer.callback());
        safetyCount += 1;
        assert.ok(safetyCount < 10, '計時器不應無限重排');
      }
    },
    /**
     * 執行目前最早的一個動畫幀。
     *
     * @returns {boolean} 有動畫幀可執行時為 true；副作用是推進正式逐幀工作。
     */
    runAnimationFrame() {
      const next = animationFrames.entries().next();
      if (next.done) return false;
      const [id, callback] = next.value;
      animationFrames.delete(id);
      callback(0);
      return true;
    },
    /**
     * 在安全上限內執行全部動畫幀。
     *
     * @param {number} [limit=20] 防止錯誤排程無限循環的最大幀數。
     * @returns {void} 無回傳值；副作用是執行正式逐幀工作直到佇列清空。
     */
    drainAnimationFrames(limit = 20) {
      let count = 0;
      while (animationFrames.size > 0 && count < limit) {
        this.runAnimationFrame();
        count += 1;
      }
      assert.equal(animationFrames.size, 0, '動畫幀應在安全上限內清空');
    },
    getSubtreeQueryCount: () => subtreeQueryCount,
    resetSubtreeQueryCount() {
      subtreeQueryCount = 0;
    },
  };
}

test('metadata 宣告 @noframes，避免在社群網站 iframe 建立 userscript realm', () => {
  const source = readUserScript(SCRIPT_FILE);
  const metadataEnd = source.indexOf('// ==/UserScript==');

  assert.ok(metadataEnd >= 0, '必須存在完整的 userscript metadata');
  assert.match(source.slice(0, metadataEnd), /^\/\/ @noframes\s*$/m);
});

test('runtime iframe 防線仍會在任何事件、observer 與選單註冊前返回', () => {
  const env = createEnvironment({}, { isIframe: true });

  assert.equal(env.observers.length, 0);
  assert.equal(env.menuRegistrations.length, 0);
  assert.equal(env.timers.size, 0);
  assert.equal(env.animationFrames.size, 0);
});

test('observer callback 不掃描新增子樹，影片改由逐幀 traversal 套用設定', () => {
  const env = createEnvironment({ volume: 50, muted: true });
  const directVideo = new env.FakeVideoElement();
  const nestedVideo = new env.FakeVideoElement();
  const subtree = new env.FakeElement([new env.FakeElement([nestedVideo])]);

  assert.equal(env.observers.length, 1);
  assert.equal(env.observers[0].observeCalls[0].options.childList, true);
  assert.equal(env.observers[0].observeCalls[0].options.subtree, true);

  env.resetSubtreeQueryCount();
  env.observers[0].emit([{ addedNodes: [directVideo, subtree] }]);
  assert.equal(env.getSubtreeQueryCount(), 0, 'observer callback 不可 querySelectorAll 整棵新增 subtree');
  assert.equal(directVideo.volume, 1, '正式處理應延到 animation frame');

  assert.equal(env.runAnimationFrame(), true);
  assert.equal(directVideo.volume, 0.25);
  assert.equal(directVideo.muted, true);
  assert.equal(nestedVideo.volume, 0.25);
  assert.equal(nestedVideo.muted, true);
});

test('大型新增子樹每幀最多探索 100 個節點並將剩餘工作排到下一幀', () => {
  const env = createEnvironment({ volume: 50, muted: true });
  const videos = Array.from({ length: 101 }, () => new env.FakeVideoElement());
  const subtree = new env.FakeElement(videos);

  env.observers[0].emit([{ addedNodes: [subtree] }]);
  assert.equal(env.runAnimationFrame(), true);
  assert.equal(videos.filter((video) => video.volume === 0.25).length, 99);
  assert.equal(env.animationFrames.size, 1, '剩餘節點應排入下一個 animation frame');

  assert.equal(env.runAnimationFrame(), true);
  assert.equal(videos.every((video) => video.volume === 0.25 && video.muted === true), true);
  assert.equal(env.animationFrames.size, 0);
});

test('持續大量 mutation 不會讓較早入列的影片工作無限延後', () => {
  const env = createEnvironment({ volume: 50, muted: true });
  const olderVideos = Array.from({ length: 101 }, () => new env.FakeVideoElement());
  env.observers[0].emit([{ addedNodes: [new env.FakeElement(olderVideos)] }]);
  env.runAnimationFrame();
  assert.equal(olderVideos.at(-1).volume, 1);

  const newerVideos = Array.from({ length: 100 }, () => new env.FakeVideoElement());
  env.observers[0].emit([{ addedNodes: newerVideos }]);
  env.runAnimationFrame();

  assert.equal(olderVideos.at(-1).volume, 0.25, 'FIFO 應先完成較早入列的 subtree');
});

test('跨幀等待的中間 sibling 被移除後會從 nextSibling 接續且不重掃父層', () => {
  const env = createEnvironment({ volume: 50, muted: true });
  const videos = Array.from({ length: 150 }, () => new env.FakeVideoElement());
  const subtree = new env.FakeElement(videos);
  let rootFirstChildReads = 0;
  Object.defineProperty(subtree, 'firstElementChild', {
    get() {
      rootFirstChildReads += 1;
      return subtree.children[0] ?? null;
    },
  });
  env.observers[0].emit([{ addedNodes: [subtree] }]);
  env.runAnimationFrame();
  const initialRootFirstChildReads = rootFirstChildReads;

  const removedVideo = videos[100];
  const nextVideo = videos[101];
  subtree.children.splice(subtree.children.indexOf(removedVideo), 1);
  removedVideo.parentElement = null;
  removedVideo.isConnected = false;
  env.observers[0].emit([{
    target: subtree,
    addedNodes: [],
    removedNodes: [removedVideo],
    nextSibling: nextVideo,
  }]);
  env.drainAnimationFrames();

  assert.equal(videos.at(-1).volume, 0.25, '移除中間節點不可截斷後方兄弟鏈');
  assert.equal(
    rootFirstChildReads,
    initialRootFirstChildReads,
    '修復斷鏈只能從 nextSibling 接續，不可重掃大型父層',
  );
});

test('沒有待處理 traversal 時的無關 DOM 移除不會建立影片掃描 rAF', () => {
  const env = createEnvironment({ volume: 50, muted: true });
  const parent = new env.FakeElement([new env.FakeElement()]);
  const removed = parent.children[0];
  parent.children = [];
  removed.parentElement = null;
  removed.isConnected = false;

  env.observers[0].emit([{
    target: parent,
    addedNodes: [],
    removedNodes: [removed],
  }]);

  assert.equal(env.animationFrames.size, 0, '閒置時的 removal 不應觸發整個父層重掃');
});

test('beforeunload 後 observer 仍會同步動態影片', () => {
  const env = createEnvironment({ volume: 50, muted: true });
  const video = new env.FakeVideoElement();

  env.dispatchWindow('beforeunload');
  env.observers[0].emit([{ addedNodes: [video] }]);
  env.runAnimationFrame();

  assert.equal(env.observers[0].disconnected, false);
  assert.equal(video.volume, 0.25);
  assert.equal(video.muted, true);
});

test('pagehide persisted 為 true 時保留 observer 供 bfcache 恢復後使用', () => {
  const env = createEnvironment({ volume: 50, muted: true });
  const video = new env.FakeVideoElement();

  env.dispatchWindow('pagehide', { persisted: true });
  env.observers[0].emit([{ addedNodes: [video] }]);

  assert.equal(env.observers[0].disconnected, false);
  assert.equal(env.animationFrames.size, 1);
  env.runAnimationFrame();
  assert.equal(video.volume, 0.25);
  assert.equal(video.muted, true);
});

test('pagehide persisted 為 false 時中止 observer、取消 rAF 並清空待掃描節點', () => {
  const env = createEnvironment({ volume: 50, muted: true });
  const video = new env.FakeVideoElement();

  env.observers[0].emit([{ addedNodes: [video] }]);
  assert.equal(env.animationFrames.size, 1);
  env.dispatchWindow('pagehide', { persisted: false });

  assert.equal(env.observers[0].disconnected, true);
  assert.equal(env.animationFrames.size, 0);
  assert.equal(env.runAnimationFrame(), false);
  assert.equal(video.volume, 1);
  assert.equal(video.muted, false);
});

test('不覆寫頁面的原生 video volume 與 muted prototype descriptor', () => {
  const env = createEnvironment({ volume: 50, muted: false });

  assert.equal(Object.hasOwn(env.FakeVideoElement.prototype, 'volume'), false);
  assert.equal(Object.hasOwn(env.FakeVideoElement.prototype, 'muted'), false);
});

test('Firefox 拒絕 unsafeWindow.document 事件存取時仍會註冊 Tampermonkey 選單', () => {
  const env = createEnvironment(
    { volume: 50, muted: false },
    { denyUnsafeDocumentEvents: true }
  );

  assert.equal(env.menuRegistrations.length, 2);
  assert.equal(env.menuRegistrations[0].label.includes('音量：50%'), true);
  assert.equal(env.menuRegistrations[1].label.includes('未靜音'), true);
});

test('Firefox 拒絕 unsafeWindow observer 讀取 options 時仍會註冊選單', () => {
  const env = createEnvironment(
    { volume: 50, muted: false },
    { denyUnsafeObserverOptions: true }
  );

  assert.equal(env.menuRegistrations.length, 2);
  assert.equal(env.observers.length, 1);
  assert.equal(env.observers[0].observeCalls.length, 1);
});

test('平台可在播放前暫時靜音，playing 後才恢復使用者的未靜音設定', () => {
  const env = createEnvironment({ volume: 50, muted: false });
  const video = new env.FakeVideoElement();

  video.muted = true;
  assert.equal(video.muted, true, '平台的原生 muted setter 不可被 userscript 攔截');

  env.observers[0].emit([{ addedNodes: [video] }]);
  env.runAnimationFrame();
  assert.equal(video.volume, 0.25);
  assert.equal(video.muted, true, '影片尚未播放時須保留 autoplay 所需的暫時靜音');

  video.paused = false;
  env.dispatchDocument('playing', { target: video });

  assert.equal(video.muted, false);
  assert.equal(env.getSavedSettings().muted, false);
  assert.equal(env.settingsWrites.length, 0);
});

test('播放中被平台程式改寫音量與靜音時，volumechange 會恢復預設值', () => {
  const env = createEnvironment({ volume: 50, muted: false });
  const video = new env.FakeVideoElement();
  video.paused = false;

  video.volume = 1;
  video.muted = true;
  env.dispatchDocument('volumechange', { target: video });

  assert.equal(video.volume, 0.25);
  assert.equal(video.muted, false);
  assert.equal(env.settingsWrites.length, 0);
});

test('平台與預設值持續衝突時，volumechange 回授必須在有限事件內停止並放行平台調整', () => {
  const env = createEnvironment(
    { volume: 50, muted: false },
    {
      simulateMediaEvents: true,
      platformVolume: 1,
      platformMuted: true,
    },
  );
  const video = new env.FakeVideoElement();
  video.paused = false;

  video.volume = 0.75;
  video.muted = true;
  const dispatched = env.flushMediaEvents();

  assert.equal(env.pendingMediaEventCount(), 0);
  assert.ok(dispatched < 50, `事件回授應收斂，實際派送 ${dispatched} 次`);
  assert.equal(env.settingsWrites.length, 0);
});

test('單一影片用盡回授額度時，不得阻止其他影片恢復預設值', () => {
  const env = createEnvironment(
    { volume: 50, muted: false },
    {
      simulateMediaEvents: true,
      platformVolume: 1,
      platformMuted: true,
    },
  );
  const conflictingVideo = new env.FakeVideoElement();
  conflictingVideo.paused = false;
  conflictingVideo.volume = 0.75;
  conflictingVideo.muted = true;
  env.flushMediaEvents();

  env.setPlatformMediaState({ volume: undefined, muted: undefined });
  const independentVideo = new env.FakeVideoElement();
  independentVideo.paused = false;
  independentVideo.volume = 0.75;
  independentVideo.muted = true;
  env.flushMediaEvents();

  assert.equal(independentVideo.volume, 0.25);
  assert.equal(independentVideo.muted, false);
});

test('衝突事件安靜一秒後，同一影片可重新取得有限修正額度', () => {
  const env = createEnvironment(
    { volume: 50, muted: false },
    {
      simulateMediaEvents: true,
      platformVolume: 1,
      platformMuted: true,
    },
  );
  const video = new env.FakeVideoElement();
  video.paused = false;
  video.volume = 0.75;
  video.muted = true;
  env.flushMediaEvents();

  env.setPlatformMediaState({ volume: undefined, muted: undefined });
  video.volume = 0.75;
  env.flushMediaEvents();
  assert.equal(video.volume, 0.75, '同一 burst 用盡額度後必須停止對抗');

  env.advanceTime(1001);
  video.volume = 0.5;
  env.flushMediaEvents();
  assert.equal(video.volume, 0.25);
  assert.equal(video.muted, false);
});

test('切換到下一次播放時，playing 會重新套用預設音量並重設回授額度', () => {
  const env = createEnvironment(
    { volume: 50, muted: false },
    {
      simulateMediaEvents: true,
      platformVolume: 1,
      platformMuted: true,
    },
  );
  const video = new env.FakeVideoElement();
  video.paused = false;
  video.volume = 0.75;
  video.muted = true;
  env.flushMediaEvents();

  env.setPlatformMediaState({ volume: undefined, muted: undefined });
  env.dispatchDocument('playing', { target: video });

  assert.equal(video.volume, 0.25);
  assert.equal(video.muted, false);
});

test('只有 Tampermonkey 靜音選單會保存並同步 muted 設定', () => {
  const env = createEnvironment({ muted: false });
  const video = new env.FakeVideoElement();
  env.addCurrentVideo(video);
  const muteMenu = env.menuRegistrations.find((menu) => menu.label.includes('未靜音'));

  assert.ok(muteMenu);
  assert.equal(video.muted, false);
  muteMenu.callback();

  assert.deepEqual(env.settingsWrites, [{ volume: 30, muted: true }]);
  assert.equal(env.getSavedSettings().muted, true);
  assert.equal(video.muted, true);
});
