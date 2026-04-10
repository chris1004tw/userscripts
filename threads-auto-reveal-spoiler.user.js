// ==UserScript==
// @name         Threads 自動點擊 Spoiler
// @namespace    https://chris.taipei
// @version      0.1
// @description  自動點擊 Threads 的 Spoiler 按鈕，揭露被隱藏的文字與圖片內容
// @author       chris1004tw
// @match        https://www.threads.com/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://github.com/chris1004tw/userscripts/raw/main/threads-auto-reveal-spoiler.user.js
// @downloadURL  https://github.com/chris1004tw/userscripts/raw/main/threads-auto-reveal-spoiler.user.js
// ==/UserScript==
// Co-authored with Claude Opus 4.6 Thinking

(function () {
  'use strict';

  const BUTTON_SELECTOR = '[role="button"]';
  const TEXT_SPOILER_SELECTOR = '[data-text-fragment="spoiler"]';
  const MEDIA_CONTENT_SELECTOR = 'img, video, picture';
  const MEDIA_SPOILER_LABELS = new Set([
    'spoiler',
    '劇透',
    '爆雷',
    '스포일러',
    'ネタバレ',
  ]);

  /** @type {WeakSet<Element>} 已處理的 spoiler 按鈕，避免重複點擊 */
  const processed = new WeakSet();

  /** @type {Set<Element>} 等待掃描的新增節點根元素 */
  const pendingRoots = new Set();

  /** @type {boolean} rAF 節流旗標，確保每幀最多掃描一次 */
  let pending = false;

  /**
   * 對尚未處理的 Spoiler 按鈕執行點擊
   *
   * @param {Element | null} btn
   */
  function clickIfNeeded(btn) {
    if (!btn || processed.has(btn)) return;

    processed.add(btn);
    btn.click();
  }

  /**
   * 在 root 與其 subtree 內執行 selector 掃描
   *
   * @param {ParentNode} root
   * @param {string} selector
   * @param {(element: Element) => void} callback
   */
  function forEachMatch(root, selector, callback) {
    if (root instanceof Element && root.matches(selector)) {
      callback(root);
    }

    if ('querySelectorAll' in root) {
      root.querySelectorAll(selector).forEach(callback);
    }
  }

  /**
   * 將文字正規化後轉為較穩定的比對格式
   *
   * @param {string | null | undefined} value
   * @returns {string}
   */
  function normalizeText(value) {
    return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * 判斷節點是否包含 Spoiler 標籤文案
   *
   * @param {ParentNode} root
   * @returns {boolean}
   */
  function hasSpoilerLabel(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return MEDIA_SPOILER_LABELS.has(normalizeText(node.textContent))
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });

    return walker.nextNode() !== null;
  }

  /**
   * 判斷按鈕是否看起來像媒體 spoiler overlay
   *
   * @param {Element | null} btn
   * @returns {boolean}
   */
  function isMediaSpoilerButton(btn) {
    if (!btn || processed.has(btn)) return false;
    if (btn.querySelector(TEXT_SPOILER_SELECTOR)) return false;
    if (!btn.querySelector(MEDIA_CONTENT_SELECTOR)) return false;

    return hasSpoilerLabel(btn);
  }

  /**
   * 掃描指定 subtree 中的 Spoiler 元素並自動點擊揭露
   *
   * 處理兩種 Spoiler 類型：
   * 1. 文字 spoiler — 透過 [data-text-fragment="spoiler"] 屬性定位，
   *    往上找到 [role="button"] 祖先後點擊
   * 2. 媒體 spoiler（圖片/影片）— 從媒體節點回推按鈕，再用 overlay label 驗證
   *
   * @param {ParentNode} root
   */
  function revealSpoilersIn(root) {
    // 文字 spoiler：data-text-fragment="spoiler" 標記
    forEachMatch(root, TEXT_SPOILER_SELECTOR, el => {
      clickIfNeeded(el.closest(BUTTON_SELECTOR));
    });

    // 媒體 spoiler（圖片/影片）：先找到媒體節點，再回推最外層按鈕做結構驗證
    const mediaButtons = new Set();
    forEachMatch(root, MEDIA_CONTENT_SELECTOR, el => {
      const btn = el.closest(BUTTON_SELECTOR);
      if (btn) {
        mediaButtons.add(btn);
      }
    });

    mediaButtons.forEach(btn => {
      if (!isMediaSpoilerButton(btn)) return;

      clickIfNeeded(btn);
    });
  }

  /**
   * 將新增節點加入下一幀的掃描佇列，並盡量以祖先節點合併重複工作
   *
   * @param {Element} root
   */
  function queueScan(root) {
    const redundantRoots = [];
    for (const existingRoot of pendingRoots) {
      if (existingRoot === root || existingRoot.contains(root)) {
        return;
      }

      if (root.contains(existingRoot)) {
        redundantRoots.push(existingRoot);
      }
    }

    redundantRoots.forEach(existingRoot => pendingRoots.delete(existingRoot));
    pendingRoots.add(root);

    if (pending) return;

    pending = true;
    requestAnimationFrame(() => {
      pendingRoots.forEach(revealSpoilersIn);
      pendingRoots.clear();
      pending = false;
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

  // 初次掃描
  revealSpoilersIn(document.body);

  // 頁面卸載時清理 observer
  window.addEventListener('beforeunload', () => observer.disconnect());
})();
