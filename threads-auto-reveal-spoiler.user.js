// ==UserScript==
// @name         Threads 自動點擊 Spoiler
// @namespace    https://chris.taipei
// @version      0.1.2
// @description  自動點擊 Threads 的 Spoiler 按鈕，揭露被隱藏的文字、圖片與影片內容
// @author       chris1004tw
// @match        https://www.threads.com/*
// @noframes
// @grant        none
// @run-at       document-idle
// @updateURL    https://github.com/chris1004tw/userscripts/raw/main/threads-auto-reveal-spoiler.user.js
// @downloadURL  https://github.com/chris1004tw/userscripts/raw/main/threads-auto-reveal-spoiler.user.js
// ==/UserScript==
// Co-authored with Claude Opus 4.6 Thinking
// Co-authored with ChatGPT 5.6 Sol Ultra
// 維護索引：README.md「維護索引」

(function () {
  'use strict';

  // Metadata 已禁止 iframe；runtime 防線避免管理器忽略 metadata 時重複掃描。
  try {
    if (window.self !== window.top) return;
  } catch {
    return;
  }

  const BUTTON_SELECTOR = '[role="button"]';
  const TEXT_SPOILER_SELECTOR = '[data-text-fragment="spoiler"]';
  const MEDIA_CONTENT_SELECTOR = 'img, video, picture';
  const MAX_SCAN_WORK_PER_FRAME = 100;
  const MAX_SPOILER_LABEL_LENGTH = 32;
  const MEDIA_SPOILER_LABELS = new Set([
    'spoiler',
    '劇透',
    '剧透',
    '爆雷',
    '스포일러',
    'ネタバレ',
  ]);

  /** @type {WeakSet<Element>} 已處理的 spoiler 按鈕，避免重複點擊 */
  const processed = new WeakSet();

  /**
   * @typedef {Object} ScanWorkItem
   * @property {Node | null} node 本次要判定並向下探索的 DOM 節點；完成標記則為 null。
   * @property {Node | null} nextSibling 此節點原本的下一個兄弟，用來逐步延續同一 subtree。
   * @property {Element | null} finalizeButton subtree 探索完成時要結算的媒體按鈕。
   */

  /**
   * @typedef {Object} RootScanItem
   * @property {Element} root 等待開始 traversal 的新增根元素。
   * @property {RootScanItem | null} next 下一個根工作，形成常數時間 FIFO linked queue。
   */

  /**
   * @typedef {Object} MediaButtonState
   * @property {boolean} hasMedia 是否已在按鈕 subtree 內遇到圖片或影片元素。
   * @property {boolean} hasTextSpoiler 是否已遇到文字 Spoiler 標記。
   * @property {boolean} hasLabel 是否已遇到支援語系的 Spoiler 純文字節點。
   */

  /** @type {ScanWorkItem[]} 目前根元素的深度優先 traversal 工作堆疊 */
  const activeScanItems = [];

  /** @type {Set<Element>} 已在根 FIFO 中等待的元素，用於常數時間去重 */
  const queuedRoots = new Set();

  /** @type {RootScanItem | null} 根 FIFO 的首項 */
  let pendingRootHead = null;

  /** @type {RootScanItem | null} 根 FIFO 的尾項 */
  let pendingRootTail = null;

  /** @type {Element | null} 目前正在逐節點探索的根元素 */
  let activeRoot = null;

  /** @type {Map<Element, MediaButtonState>} 本輪 traversal 逐節點累積的媒體按鈕狀態 */
  const mediaButtonStates = new Map();

  /** @type {boolean} rAF 工作旗標，表示佇列正在等待或分批處理 */
  let pending = false;

  /** @type {number | undefined} 可在終局 pagehide 時取消的 rAF 識別碼 */
  let scanFrameId;

  /**
   * 對尚未處理且支援 click 的 Spoiler 按鈕執行點擊。
   *
   * @param {Element | null} btn 待揭露的按鈕；null、已處理或無 click 方法時直接略過。
   * @returns {void} 無回傳值；成功點擊後加入 processed，單一按鈕失敗不影響後續掃描。
   */
  function clickIfNeeded(btn) {
    if (!btn || processed.has(btn) || typeof btn.click !== 'function') return;

    try {
      btn.click();
      processed.add(btn);
    } catch {
      // Threads 的非標準 role=button 不得中斷整個逐幀 traversal。
    }
  }

  /**
   * 將文字正規化為較穩定的 Spoiler 標籤比對格式。
   *
   * @param {string | null | undefined} value 待正規化的文字；空值視為空字串。
   * @returns {string} 壓縮空白、去除首尾空白並轉為小寫的文字；不修改 DOM。
   */
  function normalizeText(value) {
    return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * 判斷單一文字節點是否為支援語系的 Spoiler 標籤。
   *
   * 設計意圖：多數動態牆文字都不是短標籤，先直接查 Set 並排除長文字，
   * 避免對每個文字節點都執行會配置新字串的空白正規化與小寫轉換。
   *
   * @param {string | null | undefined} value 待判定的文字內容。
   * @returns {boolean} 完全相符或正規化後相符時回傳 true；不修改 DOM。
   */
  function isSpoilerLabel(value) {
    if (!value) return false;
    if (MEDIA_SPOILER_LABELS.has(value)) return true;
    if (value.length > MAX_SPOILER_LABEL_LENGTH) return false;
    return MEDIA_SPOILER_LABELS.has(normalizeText(value));
  }

  /**
   * 取得本輪 traversal 中指定媒體按鈕的累積狀態。
   *
   * @param {Element} button 要追蹤的最近 role=button 元素。
   * @returns {MediaButtonState} 既有或新建的可變狀態；副作用是必要時寫入 mediaButtonStates。
   */
  function getMediaButtonState(button) {
    let state = mediaButtonStates.get(button);
    if (!state) {
      state = { hasMedia: false, hasTextSpoiler: false, hasLabel: false };
      mediaButtonStates.set(button, state);
    }
    return state;
  }

  /**
   * 由指定元素向上走訪目前 traversal 根內的 role=button 祖先。
   *
   * 文字標記與標籤會影響所有包含它的媒體按鈕；逐層 closest 能保留原本 descendant
   * query／TreeWalker 的語意，同時把成本限制在 DOM 祖先深度。
   *
   * @param {Element} startElement 尋找最近按鈕的起始元素。
   * @param {(button: Element) => void} callback 每個按鈕祖先要執行的狀態更新。
   * @returns {void} 無回傳值；副作用由 callback 決定。
   */
  function forEachAncestorButton(startElement, callback) {
    let btn = startElement.closest(BUTTON_SELECTOR);
    while (btn) {
      callback(btn);
      if (btn === activeRoot) return;
      btn = btn.parentElement?.closest(BUTTON_SELECTOR) || null;
    }
  }

  /**
   * 以單一 DOM 節點更新文字與媒體 Spoiler 狀態，不向下查詢任何後代。
   *
   * 元素節點只用 matches／closest 判定標記；文字節點只正規化自己的 textContent。
   * 媒體按鈕會等自己的 subtree traversal 完成後才決定是否點擊，確保能看見稍後出現的文字 Spoiler 標記。
   *
   * @param {Node} node 本幀要判定的單一 DOM 節點。
   * @returns {void} 無回傳值；可能更新 mediaButtonStates 或立即揭露文字 Spoiler。
   */
  function collectSpoilerNode(node) {
    const element = node instanceof Element ? node : null;
    const closestSource = element || node.parentElement;
    if (!closestSource) return;

    const isTextSpoiler = Boolean(element?.matches(TEXT_SPOILER_SELECTOR));
    const isMedia = Boolean(element?.matches(MEDIA_CONTENT_SELECTOR));
    const isLabel = node.nodeType === 3 && isSpoilerLabel(node.textContent);
    if (!isTextSpoiler && !isMedia && !isLabel) return;

    if (isTextSpoiler) {
      clickIfNeeded(closestSource.closest(BUTTON_SELECTOR));
      forEachAncestorButton(closestSource, btn => {
        getMediaButtonState(btn).hasTextSpoiler = true;
      });
    }
    if (isMedia) {
      const btn = closestSource.closest(BUTTON_SELECTOR);
      if (btn) getMediaButtonState(btn).hasMedia = true;
    }
    if (isLabel) {
      forEachAncestorButton(closestSource, btn => {
        getMediaButtonState(btn).hasLabel = true;
      });
    }
  }

  /**
   * 在單一按鈕 subtree 探索完成時，以累積狀態判定媒體 Spoiler。
   *
   * @param {Element} btn 已完成逐節點探索的 role=button 元素。
   * @returns {void} 無回傳值；符合媒體與標籤條件時會點擊按鈕，並刪除本輪暫存狀態。
   */
  function finalizeMediaButton(btn) {
    const state = mediaButtonStates.get(btn);
    mediaButtonStates.delete(btn);
    if (!state || !btn.isConnected || processed.has(btn)) return;
    if (state.hasMedia && state.hasLabel && !state.hasTextSpoiler) clickIfNeeded(btn);
  }

  /**
   * 將新增根元素加入常數時間 FIFO，避免持續 mutation 讓較早工作無限延後。
   *
   * @param {Element} root 已正規化為最近按鈕或原新增 subtree 的根元素。
   * @returns {void} 無回傳值；尚未排程的根會加入 linked queue 與 queuedRoots。
   */
  function enqueueScanRoot(root) {
    if (queuedRoots.has(root)) return;

    const item = { root, next: null };
    queuedRoots.add(root);
    if (pendingRootTail) {
      pendingRootTail.next = item;
    } else {
      pendingRootHead = item;
    }
    pendingRootTail = item;
  }

  /**
   * 從 FIFO 取出下一個仍連線的根，建立其深度優先 traversal 堆疊。
   *
   * @returns {boolean} 成功開始一個根時為 true；沒有可用根時為 false。
   * 副作用：推進 pendingRootHead、更新 activeRoot，並建立第一個 ScanWorkItem。
   */
  function startNextScanRoot() {
    while (pendingRootHead) {
      const item = pendingRootHead;
      pendingRootHead = item.next;
      if (!pendingRootHead) pendingRootTail = null;
      queuedRoots.delete(item.root);
      if (!item.root.isConnected) continue;

      activeRoot = item.root;
      activeScanItems.push({ node: item.root, nextSibling: null, finalizeButton: null });
      return true;
    }
    return false;
  }

  /**
   * 結束目前根的 traversal 並丟棄未結算的防禦性暫存狀態。
   *
   * @returns {void} 無回傳值；副作用是清空 mediaButtonStates 並重設 activeRoot。
   */
  function finishActiveScanRoot() {
    mediaButtonStates.clear();
    activeRoot = null;
  }

  /**
   * 處理一幀允許的 traversal 節點，並將剩餘工作延到下一幀。
   *
   * 每個節點工作只讀取 nextSibling 與 firstChild；按鈕完成標記也占一個固定工作額度。
   * 根工作採 FIFO、單一根內採 DFS，因此持續 mutation 不會插隊拖延已開始的 subtree。
   *
   * @returns {void} 無回傳值。
   * 副作用：最多消耗 MAX_SCAN_WORK_PER_FRAME 個工作、揭露 Spoiler，並可能排程下一幀。
   */
  function processPendingNodes() {
    scanFrameId = undefined;
    let workThisFrame = 0;

    while (workThisFrame < MAX_SCAN_WORK_PER_FRAME) {
      if (activeScanItems.length === 0) {
        if (activeRoot) finishActiveScanRoot();
        if (!startNextScanRoot()) {
          pending = false;
          return;
        }
      }

      const item = activeScanItems.pop();
      workThisFrame += 1;

      if (item.finalizeButton) {
        finalizeMediaButton(item.finalizeButton);
        continue;
      }

      const node = item.node;
      if (!node) continue;

      // 先放兄弟，再放完成標記與子節點；LIFO 會先走完整個目前 subtree，再處理兄弟。
      if (item.nextSibling) {
        activeScanItems.push({
          node: item.nextSibling,
          nextSibling: item.nextSibling.nextSibling,
          finalizeButton: null,
        });
      }

      if (!node.isConnected) continue;

      collectSpoilerNode(node);
      const element = node instanceof Element ? node : null;
      if (element?.matches(BUTTON_SELECTOR)) {
        activeScanItems.push({ node: null, nextSibling: null, finalizeButton: element });
      }

      const firstChild = node.firstChild;
      if (firstChild) {
        activeScanItems.push({
          node: firstChild,
          nextSibling: firstChild.nextSibling,
          finalizeButton: null,
        });
      }
    }

    if (activeScanItems.length === 0 && activeRoot) finishActiveScanRoot();
    if (activeScanItems.length > 0 || pendingRootHead) {
      scanFrameId = requestAnimationFrame(processPendingNodes);
      return;
    }

    pending = false;
  }

  /**
   * 將仍連接頁面的新增根節點加入逐幀掃描佇列。
   *
   * Set 只對相同待處理根做常數時間去重，不做兄弟或祖先 contains 交叉比較；
   * FIFO 保留到達順序，processPendingNodes 再逐節點探索，避免 O(n²) 與同步整棵掃描。
   *
   * @param {Element} root 要加入佇列的 subtree 根元素。
   * @returns {void} 無回傳值。
   * 副作用：更新根 FIFO／pending，並在需要時排程 animation frame。
   */
  function queueScan(root) {
    if (!root.isConnected) return;

    // 新節點可能只是既有媒體按鈕的一小部分；從最近按鈕重掃才能完整判定標籤與排除文字 Spoiler。
    enqueueScanRoot(root.closest(BUTTON_SELECTOR) || root);
    if (pending) return;

    pending = true;
    scanFrameId = requestAnimationFrame(processPendingNodes);
  }

  /**
   * 從 childList removal 後方的原生 nextSibling 局部接續既有 traversal。
   *
   * 設計意圖：ScanWorkItem 本來就支援任意 Node，因此直接保留文字或註解 sibling
   * 才能維持完整鏈結，並避免回到 mutation.target 重掃大型動態牆容器。同批
   * addedNodes 仍由 observer 的既有新增節點分支獨立入列。
   *
   * @param {Node | null} node 移除區段後方的第一個原生 sibling，可能是元素或非元素節點。
   * @returns {void} 只有既有 traversal 尚未完成、節點仍連線且位於 activeRoot 時，
   * 才會加入局部續接工作。
   */
  function queueScanContinuation(node) {
    if (!pending || !activeRoot || !node || node.isConnected === false) return;
    if (!activeRoot.contains(node)) return;

    activeScanItems.push({
      node,
      nextSibling: node.nextSibling,
      finalizeButton: null,
    });
  }

  // ═══════════════════════════════════════════
  //  MutationObserver：監聽動態載入的內容
  // ═══════════════════════════════════════════

  /**
   * 監聽 DOM 變化，使用 requestAnimationFrame 節流
   * 避免大量 DOM 變動時重複全頁掃描造成效能問題
   */
  const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      if ((mutation.removedNodes?.length || 0) > 0) {
        queueScanContinuation(mutation.nextSibling);
      }

      mutation.addedNodes.forEach(node => {
        if (node instanceof Element) {
          queueScan(node);
          return;
        }

        if (node.parentElement) {
          queueScan(node.parentElement);
        }
      });
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // 初次內容沿用相同逐幀 traversal，避免 document-idle 同步掃描整個頁面。
  queueScan(document.body);

  /**
   * 終局 pagehide 時停止 DOM 監聽並丟棄尚未執行的逐幀工作。
   *
   * @returns {void} 無回傳值。
   * 副作用：中斷 observer、取消待執行 rAF、清空根 FIFO／active traversal，
   * 重設媒體狀態與排程旗標，並移除 pagehide 監聽器。
   */
  function cleanup() {
    observer.disconnect();

    if (scanFrameId !== undefined) {
      cancelAnimationFrame(scanFrameId);
      scanFrameId = undefined;
    }

    activeScanItems.length = 0;
    queuedRoots.clear();
    pendingRootHead = null;
    pendingRootTail = null;
    activeRoot = null;
    mediaButtonStates.clear();
    pending = false;
    window.removeEventListener('pagehide', handlePageHide);
  }

  /**
   * 只在頁面確定離開且未進入 bfcache 時執行終局清理。
   *
   * @param {PageTransitionEvent} event pagehide 事件；persisted 為 true 表示頁面仍會續存。
   * @returns {void} bfcache 情境不產生副作用，終局離開時呼叫 cleanup。
   */
  function handlePageHide(event) {
    if (event.persisted === true) return;
    cleanup();
  }

  window.addEventListener('pagehide', handlePageHide);
})();
