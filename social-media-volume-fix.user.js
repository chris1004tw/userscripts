// ==UserScript==
// @name         社群媒體影片音量鎖定
// @namespace    https://chris.taipei
// @version      0.1.1
// @description  鎖定 Facebook、Instagram、Threads、X 影片音量，防止被平台覆蓋
// @author       chris1004tw
// @match        https://*.facebook.com/*
// @match        https://*.instagram.com/*
// @match        https://*.threads.com/*
// @match        https://*.x.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// @updateURL    https://github.com/chris1004tw/userscripts/raw/main/social-media-volume-fix.user.js
// @downloadURL  https://github.com/chris1004tw/userscripts/raw/main/social-media-volume-fix.user.js
// ==/UserScript==
// Co-authored with Claude Opus 4.6 Thinking
// Co-authored with ChatGPT 5.6 Sol Ultra
// 維護索引：README.md「維護索引」
// 原始版本由 ttoan12 開發 (https://github.com/ttoan12/social-network-video-volume-fix)

(function () {
  'use strict';

  // 只在主框架執行，避免 iframe 內重複註冊選單與衝突
  try { if (window.self !== window.top) return; } catch (e) { return; }

  // ═══════════════════════════════════════════
  //  儲存（GM_setValue / GM_getValue）
  // ═══════════════════════════════════════════

  /**
   * 讀取使用者儲存的音量與靜音設定。
   *
   * @returns {{ volume: number, muted: boolean }} 音量百分比與靜音狀態；副作用是讀取 Tampermonkey 儲存空間。
   */
  function getSettings() {
    return GM_getValue('vvf_settings', { volume: 30, muted: false });
  }

  /**
   * 合併並保存指定設定，再同步目前頁面與 Tampermonkey 選單。
   *
   * @param {{ volume?: number, muted?: boolean }} patch 要更新的音量百分比或靜音狀態。
   * @returns {void} 無回傳值；副作用是寫入設定、更新所有影片並重繪選單。
   */
  function saveSettings(patch) {
    var cur = getSettings();
    var next = { volume: cur.volume, muted: cur.muted };
    if (patch.volume !== undefined) next.volume = Math.max(0, Math.min(100, patch.volume));
    if (patch.muted !== undefined) next.muted = patch.muted;
    GM_setValue('vvf_settings', next);
    syncToPage();
    registerMenu();
  }

  /**
   * 將百分比音量轉換為二次 easing 後的媒體音量，讓低音量區間更精確。
   *
   * @param {number} pct 介於 0 到 100 的音量百分比。
   * @returns {number} 介於 0 到 1 的媒體音量；不產生副作用。
   */
  function ease(pct) { return (pct / 100) * (pct / 100); }

  // ═══════════════════════════════════════════
  //  Prototype 覆寫（透過 unsafeWindow 存取頁面）
  // ═══════════════════════════════════════════

  var w = unsafeWindow;
  var volDesc = Object.getOwnPropertyDescriptor(w.HTMLMediaElement.prototype, 'volume');
  var mutDesc = Object.getOwnPropertyDescriptor(w.HTMLMediaElement.prototype, 'muted');
  if (!volDesc || !mutDesc) return;

  // 快取目前的 eased 音量和靜音狀態，供 setter 同步讀取
  // （避免在 setter 中跨 context 呼叫 GM_getValue）
  var initSettings = getSettings();
  var cachedVolume = ease(initSettings.volume);
  var cachedMuted = initSettings.muted;

  /**
   * 以原生 descriptor 將目前快取設定套用到指定影片，繞過受保護的 prototype setter。
   *
   * @param {HTMLVideoElement} video 要更新的影片元素。
   * @returns {void} 無回傳值；副作用是修改該影片的音量與靜音狀態。
   */
  function applySettingsToVideo(video) {
    volDesc.set.call(video, cachedVolume);
    mutDesc.set.call(video, cachedMuted);
  }

  /**
   * 重新讀取設定、更新記憶體快取，並套用到頁面上所有既有影片。
   *
   * @returns {void} 無回傳值；副作用是讀取設定並修改所有影片的音量與靜音狀態。
   */
  function syncToPage() {
    var s = getSettings();
    cachedVolume = ease(s.volume);
    cachedMuted = s.muted;
    w.document.querySelectorAll('video').forEach(applySettingsToVideo);
  }

  // exportFunction 相容性：Firefox/Greasemonkey 需要，Chrome Tampermonkey 可直接使用
  var wrapFn = typeof exportFunction === 'function'
    ? function (fn) { return exportFunction(fn, w); }
    : function (fn) { return fn; };

  var volumeSetter = volDesc.set;
  var mutedSetter = mutDesc.set;

  /**
   * 判斷指定節點是否為頁面環境中的影片元素。
   *
   * @param {Node | null} node 要檢查的 DOM 節點。
   * @returns {boolean} 節點為 HTMLVideoElement 時回傳 true；不產生副作用。
   */
  function isVideoElement(node) {
    return node instanceof w.HTMLVideoElement;
  }

  Object.defineProperty(w.HTMLVideoElement.prototype, 'volume', {
    get: wrapFn(function () { return volDesc.get.call(this); }),
    set: wrapFn(function (_) { volumeSetter.call(this, cachedVolume); }),
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(w.HTMLVideoElement.prototype, 'muted', {
    get: wrapFn(function () { return mutDesc.get.call(this); }),
    // 無法跨平台可靠區分原生控制與頁面程式 setter，因此設定只允許由 GM 選單變更。
    set: wrapFn(function (_) { mutedSetter.call(this, cachedMuted); }),
    configurable: true,
    enumerable: true,
  });

  // ═══════════════════════════════════════════
  //  Tampermonkey 選單
  // ═══════════════════════════════════════════

  var volumeMenuId = null;
  var muteMenuId = null;

  /**
   * 建立或原地更新音量與靜音 Tampermonkey 選單。
   *
   * @returns {void} 無回傳值；副作用是讀取設定並註冊兩個選單指令。
   */
  function registerMenu() {
    var s = getSettings();

    var volOpts = volumeMenuId != null ? { id: volumeMenuId } : undefined;
    volumeMenuId = GM_registerMenuCommand(
      '\uD83D\uDD0A 音量：' + s.volume + '%（點擊調整）',
      function () {
        var input = prompt('請輸入音量（0～100）：', getSettings().volume);
        if (input === null) return;
        var v = parseInt(input, 10);
        if (isNaN(v)) return;
        saveSettings({ volume: v, muted: false });
      },
      volOpts
    );

    var muteOpts = muteMenuId != null ? { id: muteMenuId } : undefined;
    muteMenuId = GM_registerMenuCommand(
      (s.muted ? '\uD83D\uDD07 已靜音' : '\uD83D\uDD0A 未靜音') + '（點擊切換）',
      function () {
        saveSettings({ muted: !getSettings().muted });
      },
      muteOpts
    );
  }

  // ═══════════════════════════════════════════
  //  初始化
  // ═══════════════════════════════════════════

  var MAX_VIDEO_NODES_PER_FRAME = 100;

  /**
   * @typedef {Object} VideoScanWorkItem
   * @property {Element} node 要探索的目前元素。
   * @property {Element | null} nextSibling 入列時保存的下一個元素兄弟。
   * @property {VideoScanWorkItem | null} queueNext FIFO／優先 traversal 佇列中的下一項。
   */

  /** @type {VideoScanWorkItem | null} 待掃描工作佇列首項。 */
  var pendingVideoScanHead = null;

  /** @type {VideoScanWorkItem | null} 待掃描工作佇列尾項。 */
  var pendingVideoScanTail = null;

  /** @type {Map<Element, VideoScanWorkItem>} 尚未執行的元素工作，用於常數時間去重。 */
  var queuedVideoScanItems = new Map();

  /** @type {number | undefined} 目前等待執行的影片掃描 animation frame。 */
  var videoScanFrameId;

  /** @type {boolean} 終局離頁後阻止重新排程的生命週期旗標。 */
  var videoScanStopped = false;

  /**
   * 將單一元素加入逐幀 traversal 堆疊，並合併較完整的兄弟鏈資訊。
   *
   * @param {Element} node 要延後探索的元素。
   * @param {Element | null} [nextSibling=null] 同一新增 subtree 中的下一個元素兄弟。
   * @param {boolean} [prioritize=false] 是否插入佇列前端，讓已開始的舊 subtree 優先完成。
   * @returns {void} 無回傳值；副作用是更新待掃描堆疊，但不會同步讀取後代。
   */
  function enqueueVideoScanNode(node, nextSibling, prioritize) {
    if (!node || node.nodeType !== 1 || videoScanStopped) return;

    var existingItem = queuedVideoScanItems.get(node);
    if (existingItem) {
      if (!existingItem.nextSibling && nextSibling) existingItem.nextSibling = nextSibling;
      return;
    }

    var item = { node: node, nextSibling: nextSibling || null, queueNext: null };
    queuedVideoScanItems.set(node, item);

    if (prioritize && pendingVideoScanHead) {
      item.queueNext = pendingVideoScanHead;
      pendingVideoScanHead = item;
      return;
    }

    if (pendingVideoScanTail) {
      pendingVideoScanTail.queueNext = item;
    } else {
      pendingVideoScanHead = item;
    }
    pendingVideoScanTail = item;
  }

  /**
   * 在佇列非空且尚未排程時建立唯一影片掃描 animation frame。
   *
   * @returns {void} 無回傳值；必要時會呼叫 requestAnimationFrame 並保存識別碼。
   */
  function scheduleVideoScan() {
    if (videoScanStopped || videoScanFrameId !== undefined || !pendingVideoScanHead) return;
    videoScanFrameId = w.requestAnimationFrame(processVideoScanQueue);
  }

  /**
   * 在固定節點預算內探索影片 subtree，剩餘工作延到下一幀。
   *
   * 設計意圖：每個工作只讀取 firstElementChild 與 nextElementSibling，讓寬、深 subtree
   * 都受相同的每幀上限約束；已離線元素不再套用設定，但仍延續入列時保存的兄弟鏈。
   *
   * @returns {void} 無回傳值；副作用是套用影片設定、消耗工作堆疊並可能排程下一幀。
   */
  function processVideoScanQueue() {
    videoScanFrameId = undefined;
    var nodesThisFrame = 0;

    while (pendingVideoScanHead && nodesThisFrame < MAX_VIDEO_NODES_PER_FRAME) {
      var item = pendingVideoScanHead;
      pendingVideoScanHead = item.queueNext;
      item.queueNext = null;
      if (!pendingVideoScanHead) pendingVideoScanTail = null;
      queuedVideoScanItems.delete(item.node);
      nodesThisFrame += 1;

      if (item.nextSibling) {
        enqueueVideoScanNode(item.nextSibling, item.nextSibling.nextElementSibling, true);
      }

      if (item.node.isConnected === false) continue;

      if (isVideoElement(item.node)) applySettingsToVideo(item.node);
      if (item.node.firstElementChild) {
        enqueueVideoScanNode(
          item.node.firstElementChild,
          item.node.firstElementChild.nextElementSibling,
          true
        );
      }
    }

    if (!pendingVideoScanHead) queuedVideoScanItems.clear();
    scheduleVideoScan();
  }

  /**
   * 將 MutationObserver 回報的元素根節點交給逐幀影片 traversal。
   *
   * @param {Node} node MutationObserver 回報的新增節點。
   * @returns {void} 無回傳值；元素節點會延後處理，文字等非元素節點直接略過。
   */
  function queueAddedVideoNode(node) {
    if (!node || node.nodeType !== 1 || node.isConnected === false) return;

    enqueueVideoScanNode(node, null, false);
    scheduleVideoScan();
  }

  // 只監聽新增節點；屬性與文字變動不會觸發不必要的影片掃描。
  var videoObserver = new w.MutationObserver(function (records) {
    records.forEach(function (record) {
      // 移除等待中的 sibling 可能讓瀏覽器斷開其 nextElementSibling；重掃父層可確保後方節點不漏。
      if (pendingVideoScanHead && record.removedNodes && record.removedNodes.length > 0) {
        queueAddedVideoNode(record.target);
      }
      record.addedNodes.forEach(queueAddedVideoNode);
    });
  });
  videoObserver.observe(w.document, { childList: true, subtree: true });

  /**
   * 在非 bfcache 的終局 pagehide 釋放影片 observer 與逐幀工作。
   *
   * @param {PageTransitionEvent} event pagehide 事件；persisted=true 表示頁面仍由 bfcache 保存。
   * @returns {void} bfcache 情境不修改狀態；終局離頁會中斷 observer、取消 rAF、清空佇列並移除監聽器。
   */
  function cleanupVideoScanning(event) {
    if (event.persisted) return;

    videoScanStopped = true;
    videoObserver.disconnect();
    if (videoScanFrameId !== undefined) {
      w.cancelAnimationFrame(videoScanFrameId);
      videoScanFrameId = undefined;
    }
    pendingVideoScanHead = null;
    pendingVideoScanTail = null;
    queuedVideoScanItems.clear();
    w.removeEventListener('pagehide', cleanupVideoScanning);
  }

  // beforeunload 可能被取消；pagehide 才代表頁面確實離開。
  // bfcache 會以 persisted=true 暫存頁面，此時保留 observer 與待執行 traversal。
  w.addEventListener('pagehide', cleanupVideoScanning);

  registerMenu();

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', function () { syncToPage(); }, { once: true });
  } else {
    syncToPage();
  }
})();
