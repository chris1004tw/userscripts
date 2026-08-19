// ==UserScript==
// @name         社群媒體影片音量鎖定
// @namespace    https://chris.taipei
// @version      0.1.4
// @description  為 Facebook、Instagram、Threads、X 影片設定播放初始音量，並保留平台內建音量滑桿
// @author       chris1004tw
// @match        https://*.facebook.com/*
// @match        https://*.instagram.com/*
// @match        https://*.threads.com/*
// @match        https://*.x.com/*
// @noframes
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @updateURL    https://github.com/chris1004tw/userscripts/raw/main/social-media-volume-fix.user.js
// @downloadURL  https://github.com/chris1004tw/userscripts/raw/main/social-media-volume-fix.user.js
// ==/UserScript==
// Co-authored with Claude Opus 4.6 Thinking
// Co-authored with ChatGPT 5.6 Sol Ultra
// 維護索引：README.md「維護索引」
// 原始版本由 ttoan12 開發 (https://github.com/ttoan12/social-network-video-volume-fix)
// 使用方式：Tampermonkey 選單保存的音量會在每支影片開始播放時重新套用。
// 平台內建音量滑桿仍可臨時調整目前影片；切換到下一支影片時會恢復預設音量，
// 避免沿用上一支影片臨時拉高的音量。

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
    syncToPage(true);
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
  //  原生媒體設定同步
  // ═══════════════════════════════════════════

  var browserWindow = window;
  var volDesc = Object.getOwnPropertyDescriptor(browserWindow.HTMLMediaElement.prototype, 'volume');
  var mutDesc = Object.getOwnPropertyDescriptor(browserWindow.HTMLMediaElement.prototype, 'muted');
  if (!volDesc || !mutDesc) return;

  // 快取目前的 eased 音量和靜音狀態，避免媒體事件中跨 context 呼叫 GM_getValue。
  var initSettings = getSettings();
  var cachedVolume = ease(initSettings.volume);
  var cachedMuted = initSettings.muted;
  var VOLUMECHANGE_QUIET_MS = 1000;
  var MAX_CORRECTION_BATCHES_PER_BURST = 2;
  /** @type {WeakMap<HTMLVideoElement, {lastEventAt: number, correctionBatches: number}>} */
  var volumeChangeCorrectionStates = new WeakMap();

  /**
   * 判斷指定節點是否為頁面環境中的影片元素。
   *
   * @param {Node | null} node 要檢查的 DOM 節點。
   * @returns {boolean} 節點為 HTMLVideoElement 時回傳 true；不產生副作用。
   */
  function isVideoElement(node) {
    return node instanceof browserWindow.HTMLVideoElement;
  }

  /**
   * 以原生 descriptor 將目前快取設定套用到指定影片。
   *
   * 設計意圖：不覆寫頁面 prototype，避免 Firefox／Tampermonkey 跨 context setter
   * 中斷平台播放流程。使用者選擇未靜音時，暫停中的影片可保留平台為 autoplay
   * 設定的暫時靜音，直到 playing 事件再恢復。
   *
   * @param {HTMLVideoElement} video 要更新的影片元素。
   * @param {boolean} [forceMuted=false] 是否不考慮播放狀態、立即套用靜音設定。
   * @returns {boolean} 本次至少修改一個媒體屬性時回傳 true；否則回傳 false。
   * @sideeffect 按需修改該影片的音量與靜音狀態。
   */
  function applySettingsToVideo(video, forceMuted) {
    var changed = false;
    if (volDesc.get.call(video) !== cachedVolume) {
      volDesc.set.call(video, cachedVolume);
      changed = true;
    }

    var shouldApplyMuted = forceMuted === true || cachedMuted || video.paused === false;
    if (shouldApplyMuted && mutDesc.get.call(video) !== cachedMuted) {
      mutDesc.set.call(video, cachedMuted);
      changed = true;
    }
    return changed;
  }

  /**
   * 取得影片目前的 volumechange burst 狀態，安靜滿一秒後建立新的修正額度。
   *
   * 設計意圖：每次事件都更新最後時間，不能因腳本自己的 setter 事件已符合鎖定值就
   * 提前重設額度，否則 X 在 capture handler 後回寫時仍可重新啟動無限事件鏈。
   *
   * @param {HTMLVideoElement} video 發生 volumechange 的影片。
   * @returns {{lastEventAt: number, correctionBatches: number}} 該影片可直接更新的 burst 狀態。
   * @sideeffect 讀取目前時間並更新 WeakMap；不建立 timer 或其他非同步工作。
   */
  function getVolumeChangeCorrectionState(video) {
    var now = Date.now();
    var state = volumeChangeCorrectionStates.get(video);
    if (!state || now - state.lastEventAt >= VOLUMECHANGE_QUIET_MS) {
      state = { lastEventAt: now, correctionBatches: 0 };
      volumeChangeCorrectionStates.set(video, state);
    } else {
      state.lastEventAt = now;
    }
    return state;
  }

  /**
   * 重新讀取設定、更新記憶體快取，並套用到頁面上所有既有影片。
   *
   * @param {boolean} [forceMuted=false] 是否立即套用靜音設定；GM 選單操作時傳入 true。
   * @returns {void} 無回傳值；副作用是讀取設定並修改所有影片的音量與靜音狀態。
   */
  function syncToPage(forceMuted) {
    var s = getSettings();
    cachedVolume = ease(s.volume);
    cachedMuted = s.muted;
    document.querySelectorAll('video').forEach(function (video) {
      if (forceMuted === true) volumeChangeCorrectionStates.delete(video);
      applySettingsToVideo(video, forceMuted === true);
    });
  }

  /**
   * 在影片開始播放時套用預設設定；volumechange 衝突時僅有限次恢復，
   * 之後放行平台內建滑桿的目前影片調整，並保留播放前的 autoplay 暫時靜音。
   *
   * @param {Event} event playing 或 volumechange 媒體事件。
   * @returns {void} 無回傳值；副作用是依影片播放狀態恢復音量與靜音。
   */
  function handleMediaStateChange(event) {
    if (!isVideoElement(event.target)) return;

    if (event.type === 'playing') {
      volumeChangeCorrectionStates.delete(event.target);
      applySettingsToVideo(event.target, true);
      return;
    }

    var correctionState = getVolumeChangeCorrectionState(event.target);
    // 額度用盡後直接 fail-open，避免讀取已不會修正的媒體屬性。
    if (correctionState.correctionBatches >= MAX_CORRECTION_BATCHES_PER_BURST) return;

    // 套用函式會同時判斷差異；自己的 setter 事件已符合預設值，不會消耗額度。
    if (applySettingsToVideo(event.target, false)) {
      correctionState.correctionBatches += 1;
    }
  }

  // 媒體事件不保證冒泡，因此用 userscript document 的 capture 統一監聽動態影片。
  // 所有 DOM API 保持在同一個 userscript realm，避免 Firefox 跨 context 權限例外。
  document.addEventListener('playing', handleMediaStateChange, true);
  document.addEventListener('volumechange', handleMediaStateChange, true);

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
    videoScanFrameId = browserWindow.requestAnimationFrame(processVideoScanQueue);
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
      var firstChild = item.node.firstElementChild;
      if (firstChild) {
        enqueueVideoScanNode(firstChild, firstChild.nextElementSibling, true);
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

  /**
   * 從移除區段後方的第一個元素接續既有 traversal，不重新掃描整個 mutation target。
   *
   * 設計意圖：MutationRecord.nextSibling 精確指出斷鏈後方；X 虛擬化時間軸頻繁移除
   * 貼文時，從這裡局部續掃可避免同一大型父層反覆入列。
   *
   * @param {Node | null} node 移除區段後的原生 sibling，可能是文字、註解或元素。
   * @returns {void} 無回傳值；找到仍連線的元素時會保存後續兄弟鏈並排程掃描。
   */
  function queueVideoScanContinuation(node) {
    var resumeNode = node;
    while (resumeNode && resumeNode.nodeType !== 1) resumeNode = resumeNode.nextSibling;
    if (!resumeNode || resumeNode.isConnected === false) return;

    enqueueVideoScanNode(resumeNode, resumeNode.nextElementSibling, false);
    scheduleVideoScan();
  }

  // 只監聽新增節點；屬性與文字變動不會觸發不必要的影片掃描。
  var videoObserver = new browserWindow.MutationObserver(function (records) {
    records.forEach(function (record) {
      // 移除等待中的 sibling 會截斷原 traversal；從瀏覽器提供的後方 sibling 局部續接。
      if (pendingVideoScanHead && record.removedNodes && record.removedNodes.length > 0) {
        queueVideoScanContinuation(record.nextSibling);
      }
      record.addedNodes.forEach(queueAddedVideoNode);
    });
  });
  videoObserver.observe(document, { childList: true, subtree: true });

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
      browserWindow.cancelAnimationFrame(videoScanFrameId);
      videoScanFrameId = undefined;
    }
    pendingVideoScanHead = null;
    pendingVideoScanTail = null;
    queuedVideoScanItems.clear();
    document.removeEventListener('playing', handleMediaStateChange, true);
    document.removeEventListener('volumechange', handleMediaStateChange, true);
    browserWindow.removeEventListener('pagehide', cleanupVideoScanning);
  }

  // beforeunload 可能被取消；pagehide 才代表頁面確實離開。
  // bfcache 會以 persisted=true 暫存頁面，此時保留 observer 與待執行 traversal。
  browserWindow.addEventListener('pagehide', cleanupVideoScanning);

  registerMenu();

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', function () { syncToPage(); }, { once: true });
  } else {
    syncToPage();
  }
})();
