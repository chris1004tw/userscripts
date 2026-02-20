// ==UserScript==
// @name         社群媒體影片音量鎖定
// @namespace    https://chris.taipei
// @version      0.1
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
// 原始版本由 ttoan12 開發 (https://github.com/ttoan12/social-network-video-volume-fix)

(function () {
  'use strict';

  // 只在主框架執行，避免 iframe 內重複註冊選單與衝突
  try { if (window.self !== window.top) return; } catch (e) { return; }

  // ═══════════════════════════════════════════
  //  儲存（GM_setValue / GM_getValue）
  // ═══════════════════════════════════════════

  function getSettings() {
    return GM_getValue('vvf_settings', { volume: 30, muted: false });
  }

  function saveSettings(patch) {
    var cur = getSettings();
    var next = { volume: cur.volume, muted: cur.muted };
    if (patch.volume !== undefined) next.volume = Math.max(0, Math.min(100, patch.volume));
    if (patch.muted !== undefined) next.muted = patch.muted;
    GM_setValue('vvf_settings', next);
    syncToPage();
    registerMenu();
  }

  // 二次 easing：低音量區間更精確控制
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

  // 更新快取並套用到所有 video 元素
  function syncToPage() {
    var s = getSettings();
    cachedVolume = ease(s.volume);
    cachedMuted = s.muted;
    w.document.querySelectorAll('video').forEach(function (el) {
      volDesc.set.call(el, cachedVolume);
      mutDesc.set.call(el, cachedMuted);
    });
  }

  // exportFunction 相容性：Firefox/Greasemonkey 需要，Chrome Tampermonkey 可直接使用
  var wrapFn = typeof exportFunction === 'function'
    ? function (fn) { return exportFunction(fn, w); }
    : function (fn) { return fn; };

  var volumeSetter = volDesc.set;
  var mutedSetter = mutDesc.set;

  // 追蹤使用者互動，讓原生靜音按鈕可用
  var userClicking = false;
  document.addEventListener('pointerdown', function (e) {
    if (!e.isTrusted) return;
    userClicking = true;
    setTimeout(function () { userClicking = false; }, 200);
  }, true);

  Object.defineProperty(w.HTMLVideoElement.prototype, 'volume', {
    get: wrapFn(function () { return volDesc.get.call(this); }),
    set: wrapFn(function (_) { volumeSetter.call(this, cachedVolume); }),
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(w.HTMLVideoElement.prototype, 'muted', {
    get: wrapFn(function () { return mutDesc.get.call(this); }),
    set: wrapFn(function (v) {
      if (userClicking) {
        // 使用者點擊原生靜音按鈕，尊重操作並同步設定
        cachedMuted = !!v;
        mutedSetter.call(this, cachedMuted);
        setTimeout(function () {
          var s = getSettings();
          GM_setValue('vvf_settings', { volume: s.volume, muted: cachedMuted });
          registerMenu();
        }, 0);
      } else {
        mutedSetter.call(this, cachedMuted);
      }
    }),
    configurable: true,
    enumerable: true,
  });

  // ═══════════════════════════════════════════
  //  Tampermonkey 選單
  // ═══════════════════════════════════════════

  var volumeMenuId = null;
  var muteMenuId = null;

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

  registerMenu();

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', function () { syncToPage(); }, { once: true });
  } else {
    syncToPage();
  }
})();
