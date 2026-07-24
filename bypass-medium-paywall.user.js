// ==UserScript==
// @name         Medium 付費牆繞過
// @namespace    https://chris.taipei
// @version      0.1.1
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
// Co-authored with ChatGPT 5.6 Sol Ultra
// 維護索引：README.md「維護索引」

(function () {
    'use strict';

    /**
     * @typedef {Object} ReadingService
     * @property {string} key 儲存在 GM 設定中的穩定識別碼。
     * @property {string} name 顯示於 Tampermonkey 選單的服務名稱。
     * @property {string} endpoint 接收原始文章網址的跳轉端點。
     * @property {string} hostname 用於辨識已位於服務站的精確 hostname。
     */

    /** @type {ReadingService[]} */
    const SERVICES = [
        {
            key: 'freedium',
            name: 'Freedium',
            endpoint: 'https://freedium-mirror.cfd/',
            hostname: 'freedium-mirror.cfd'
        },
        {
            key: 'archive',
            name: 'Archive.today',
            endpoint: 'https://archive.ph/newest/',
            hostname: 'archive.ph'
        },
        {
            key: 'readmedium',
            name: 'ReadMedium',
            endpoint: 'https://readmedium.com/',
            hostname: 'readmedium.com'
        }
    ];

    /**
     * 判斷指定網址是否位於已知的第三方閱讀服務站。
     *
     * 設計意圖是以 URL 解析後的完整 hostname 比對，讓 Archive 的任意路徑都能識別，
     * 同時避免 `readmedium.com.evil.example` 這類字串前綴相似站點被誤判。
     *
     * @param {string} url 要判斷的完整網址。
     * @returns {boolean} hostname 精確符合任一服務時回傳 true；解析失敗時回傳 false，且不產生副作用。
     */
    function isServiceUrl(url) {
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            return SERVICES.some(service => service.hostname === hostname);
        } catch (error) {
            return false;
        }
    }

    const currentUrl = window.location.href;
    const isServiceSite = isServiceUrl(currentUrl);

    /**
     * 讀取預設服務 key 並轉換成 SERVICES 中的有效索引。
     *
     * @returns {number} 已選服務的索引；設定不存在或無效時回傳 0。副作用是讀取 GM 儲存空間。
     */
    function getServiceIndex() {
        const key = GM_getValue('defaultService', 'freedium');
        return Math.max(0, SERVICES.findIndex(s => s.key === key));
    }

    /**
     * 使用目前選定服務的跳轉 endpoint 開啟啟動時的文章網址。
     *
     * @returns {void} 無回傳值；副作用是指定 `window.location.href` 並觸發頁面導覽。
     */
    function redirect() {
        const idx = getServiceIndex();
        window.location.href = SERVICES[idx].endpoint + currentUrl;
    }

    // --- 選單：切換預設服務（點擊循環） ---
    /**
     * 建立或更新預設服務循環選單。
     *
     * @returns {void} 無回傳值；副作用是註冊 GM 選單，點擊時寫入下一個服務並更新選單。
     */
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
    /**
     * 建立或更新自動跳轉開關選單。
     *
     * @returns {void} 無回傳值；副作用是註冊 GM 選單，點擊時反轉設定並更新選單。
     */
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
