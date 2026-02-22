// ==UserScript==
// @name         Medium 付費牆繞過
// @namespace    https://chris.taipei
// @version      0.1
// @description  自動跳轉至第三方服務閱讀 Medium 全文
// @author       chris1004tw
// @match        *://medium.com/*
// @match        *://*.medium.com/*
// @match        *://*.towardsdatascience.com/*
// @match        *://freedium-mirror.cfd/*
// @match        *://archive.ph/*
// @match        *://readmedium.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// @updateURL    https://github.com/chris1004tw/userscripts/raw/main/bypass-medium-paywall.user.js
// @downloadURL  https://github.com/chris1004tw/userscripts/raw/main/bypass-medium-paywall.user.js
// ==/UserScript==
// Co-authored with Claude Opus 4.6 Thinking

(function () {
    'use strict';

    const SERVICES = [
        { key: 'freedium', name: 'Freedium', url: 'https://freedium-mirror.cfd/' },
        { key: 'archive', name: 'Archive.today', url: 'https://archive.ph/newest/' },
        { key: 'readmedium', name: 'ReadMedium', url: 'https://readmedium.com/' }
    ];

    const currentUrl = window.location.href;
    const isServiceSite = SERVICES.some(s => currentUrl.startsWith(s.url.replace(/\/$/, '')));

    function getServiceIndex() {
        const key = GM_getValue('defaultService', 'freedium');
        return Math.max(0, SERVICES.findIndex(s => s.key === key));
    }

    function redirect() {
        const idx = getServiceIndex();
        window.location.href = SERVICES[idx].url + currentUrl;
    }

    // --- 選單：切換預設服務（點擊循環） ---
    function registerServiceMenu() {
        const idx = getServiceIndex();
        GM_registerMenuCommand(
            '預設服務: ' + SERVICES[idx].name,
            () => {
                const nextIndex = (idx + 1) % SERVICES.length;
                GM_setValue('defaultService', SERVICES[nextIndex].key);
                registerServiceMenu();
            },
            { id: 'cycle-service' }
        );
    }
    registerServiceMenu();

    // 選單：自動跳轉開關
    function registerAutoToggle() {
        const auto = GM_getValue('autoRedirect', true);
        GM_registerMenuCommand(
            '自動跳轉: ' + (auto ? '開' : '關'),
            () => {
                GM_setValue('autoRedirect', !auto);
                registerAutoToggle();
            },
            { id: 'toggle-auto-redirect' }
        );
    }
    registerAutoToggle();

    // 以下只在 Medium 頁面執行（不在第三方服務頁面）
    if (isServiceSite) return;

    // 選單：立即跳轉（手動用）
    GM_registerMenuCommand('立即跳轉', redirect, { id: 'go-now' });

    // 自動跳轉
    if (GM_getValue('autoRedirect', true)) {
        redirect();
    }
})();
