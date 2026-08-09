// ==UserScript==
// @name         複製當前網址
// @namespace    https://chris.taipei
// @version      0.4.4
// @description  按下 Ctrl+Shift+C 複製當前網址（X/Twitter、Threads、Amazon.co.jp、PChome 與 Shopee 網址轉換）
// @author       chris1004tw
// @match        *://*/*
// @grant        GM_setClipboard
// @run-at       document-end
// @updateURL    https://github.com/chris1004tw/userscripts/raw/main/copy-current-url.user.js
// @downloadURL  https://github.com/chris1004tw/userscripts/raw/main/copy-current-url.user.js
// ==/UserScript==
// Co-authored with Claude Opus 4.6 Thinking
// Co-authored with ChatGPT 5.6 Sol Ultra
// 維護索引：README.md「維護索引」
// Shopee 短網址轉換參考自 https://github.com/gnehs/userscripts
// PChome 短網址服務由 https://p.pancake.tw/ 提供
// X/Twitter 短網址服務由 https://fxtwitter.com/ 提供
// Threads 嵌入修復服務由 https://github.com/everettsouthwick/vxThreads 提供

(function () {
    'use strict';

    const NOTIFICATION_DURATION = 2000;

    // 只在主框架執行，避免 iframe 內重複顯示通知
    try {
        if (window.self !== window.top) return;
    } catch {
        // 跨域 iframe 中存取 window.top 可能拋出 SecurityError，視為 iframe 跳過
        return;
    }

    /**
     * 等待 document.body 建立，最長等待五秒以避免 Promise 永久 pending。
     *
     * @returns {Promise<void>} body 出現或逾時後完成的 Promise。
     * 副作用：等待期間建立暫時的 MutationObserver 與 timeout，完成時會自行清理。
     */
    function waitForBody() {
        return new Promise((resolve) => {
            if (document.body) {
                resolve();
                return;
            }
            let timeoutId;
            const observer = new MutationObserver(() => {
                if (document.body) {
                    clearTimeout(timeoutId);
                    observer.disconnect();
                    resolve();
                }
            });
            observer.observe(document.documentElement, { childList: true });

            timeoutId = setTimeout(() => {
                observer.disconnect();
                resolve();
            }, 5000);
        });
    }

    /**
     * 確保複製通知所需的動畫樣式只注入一次。
     *
     * @returns {void} 無回傳值。
     * 副作用：樣式不存在時會在 head 或 documentElement 新增 style 元素。
     */
    function ensureStyleExists() {
        if (document.getElementById('copy-url-notification-style')) {
            return;
        }
        const style = document.createElement('style');
        style.id = 'copy-url-notification-style';
        style.textContent = `
            @keyframes copyUrlFadeInOut {
                0% { opacity: 0; transform: translateY(-10px); }
                15% { opacity: 1; transform: translateY(0); }
                85% { opacity: 1; transform: translateY(0); }
                100% { opacity: 0; transform: translateY(-10px); }
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    /**
     * 在頁面右上角顯示複製結果，通知到期後自動移除。
     *
     * @param {string} url 要顯示的已複製網址。
     * @param {string} [title='已複製網址！'] 通知標題。
     * @returns {Promise<void>} 通知完成建立後結束；顯示失敗會被攔截。
     * 副作用：可能注入樣式、建立通知元素、排程移除 timeout，失敗時輸出警告。
     */
    async function showNotification(url, title = '已複製網址！') {
        try {
            await waitForBody();
            ensureStyleExists();

            const notification = document.createElement('div');

            // 使用 DOM API 而非 innerHTML，避免 Trusted Types CSP 問題
            const titleDiv = document.createElement('div');
            titleDiv.textContent = title;
            titleDiv.style.cssText = 'font-weight: bold; margin-bottom: 4px;';

            const urlDiv = document.createElement('div');
            urlDiv.textContent = url;
            urlDiv.style.cssText = 'font-size: 12px; opacity: 0.8; word-break: break-all;';

            notification.appendChild(titleDiv);
            notification.appendChild(urlDiv);
            notification.style.cssText = `
                position: fixed !important;
                top: 20px !important;
                right: 20px !important;
                background-color: #000 !important;
                color: #fff !important;
                padding: 12px 20px !important;
                border-radius: 8px !important;
                z-index: 2147483647 !important;
                font-size: 14px !important;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3) !important;
                animation: copyUrlFadeInOut ${NOTIFICATION_DURATION / 1000}s ease-in-out !important;
                max-width: 400px !important;
                pointer-events: none !important;
            `;

            document.body.appendChild(notification);
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.remove();
                }
            }, NOTIFICATION_DURATION);
        } catch (err) {
            // 通知顯示失敗不影響複製功能
            console.warn('[Copy URL] 通知顯示失敗:', err);
        }
    }

    /**
     * 判斷目前頁面是否為支援的 X/Twitter 主機。
     *
     * @returns {boolean} 位於 x.com 或 twitter.com（含 www）時回傳 true。
     * 此函式只讀取 location，無副作用。
     */
    function isXTwitter() {
        const host = window.location.hostname;
        return host === 'x.com' || host === 'twitter.com' ||
            host === 'www.x.com' || host === 'www.twitter.com';
    }

    /**
     * 將 X/Twitter 網址的主機轉換為 fxTwitter。
     * 嵌入修復服務由 https://fxtwitter.com/ 提供。
     *
     * @param {string} url 原始 X/Twitter 網址。
     * @returns {string} 主機已轉換的網址；非支援主機則維持原字串。
     * 此函式無副作用。
     */
    function convertToFxTwitter(url) {
        return url
            .replace(/https?:\/\/(www\.)?x\.com/, 'https://fxtwitter.com')
            .replace(/https?:\/\/(www\.)?twitter\.com/, 'https://fxtwitter.com');
    }

    /**
     * 判斷目前頁面是否為支援的 Threads 主機。
     *
     * @returns {boolean} 位於 threads.com（含 www）時回傳 true。
     * 此函式只讀取 location，無副作用。
     */
    function isThreads() {
        const host = window.location.hostname;
        return host === 'threads.com' || host === 'www.threads.com';
    }

    /**
     * 將 Threads 網址的主機轉換為 vxThreads。
     * 嵌入修復服務由 https://github.com/everettsouthwick/vxThreads 提供。
     *
     * @param {string} url 原始 Threads 網址。
     * @returns {string} 使用 HTTPS 與 vxthreads.com 主機，並保留路徑、查詢參數及片段的網址。
     * @throws {TypeError} 傳入無法由 URL API 解析的字串時拋出。
     * 此函式無副作用。
     */
    function convertToVxThreads(url) {
        const parsed = new URL(url);
        parsed.protocol = 'https:';
        parsed.host = 'vxthreads.com';
        return parsed.href;
    }

    /**
     * 判斷目前頁面是否為日本 Amazon。
     *
     * @returns {boolean} hostname 精確為 amazon.co.jp 或 www.amazon.co.jp 時回傳 true。
     * 此函式只讀取 location，無副作用。
     */
    function isAmazonJapan() {
        const host = window.location.hostname;
        return host === 'amazon.co.jp' || host === 'www.amazon.co.jp';
    }

    /**
     * 將日本 Amazon 商品網址轉換為只保留 ASIN 的標準短網址。
     *
     * 設計意圖：商品標題、推薦來源、工作階段路徑與查詢參數不影響商品識別，
     * 因此僅保留 dp 路徑與固定為十碼的 ASIN，產生穩定且可分享的網址。
     *
     * @param {string} url 原始 Amazon.co.jp 網址。
     * @returns {string} 可辨識商品頁時回傳 https://www.amazon.co.jp/dp/ASIN，否則回傳原網址。
     * @throws {TypeError} 傳入無法由 URL API 解析的字串時拋出。
     * 此函式無副作用。
     */
    function convertToAmazonShort(url) {
        const parsed = new URL(url);
        const match = parsed.pathname.match(
            /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i
        );

        return match
            ? `https://www.amazon.co.jp/dp/${match[1].toUpperCase()}`
            : url;
    }

    /**
     * 判斷目前頁面是否為台灣 Shopee。
     *
     * @returns {boolean} hostname 為 shopee.tw 時回傳 true。
     * 此函式只讀取 location，無副作用。
     */
    function isShopee() {
        return window.location.hostname === 'shopee.tw';
    }

    /**
     * 將 Shopee 商品網址轉換為穩定的 product 路徑短網址。
     * 轉換規則參考自 https://github.com/gnehs/userscripts。
     *
     * @param {string} url 原始 Shopee 網址。
     * @returns {string} 可辨識商品頁時回傳短網址，否則回傳原網址。
     * @throws {TypeError} 傳入無法由 URL API 解析的字串時拋出。
     * 此函式無副作用。
     */
    function convertToShopeeShort(url) {
        const parsed = new URL(url);

        // 取路徑最後一段，以 - 分隔
        const pathParts = parsed.pathname.split('-');
        const lastPart = pathParts[pathParts.length - 1];

        // 檢查是否為 i.shopId.itemId 格式
        const shopeePath = lastPart.split('.');
        if (shopeePath[0] === 'i' && shopeePath.length === 3) {
            return 'https://shopee.tw/product/' + shopeePath[1] + '/' + shopeePath[2];
        }

        // 非商品頁面，回傳原網址
        return url;
    }

    /**
     * 判斷目前頁面是否為 PChome 24h。
     *
     * @returns {boolean} hostname 為 24h.pchome.com.tw 時回傳 true。
     * 此函式只讀取 location，無副作用。
     */
    function isPChome24h() {
        return window.location.hostname === '24h.pchome.com.tw';
    }

    /**
     * 將 PChome 24h 商品網址轉換為 Pancake 短網址。
     * 短網址服務由 https://p.pancake.tw/ 提供。
     *
     * @param {string} url 原始 PChome 網址。
     * @returns {string} 商品頁回傳 Pancake 網址，其他頁面回傳原網址。
     * 此函式無副作用。
     */
    function convertToPancake(url) {
        // 只處理商品頁面 /prod/xxx
        const match = url.match(/^https?:\/\/24h\.pchome\.com\.tw(\/prod\/[^?#]+)/);
        if (match) {
            return 'https://p.pancake.tw' + match[1];
        }
        // 非商品頁面，回傳原網址
        return url;
    }

    /**
     * 依目前網站轉換網址後寫入剪貼簿，並顯示結果通知。
     *
     * @returns {void} 無回傳值。
     * 副作用：呼叫 GM_setClipboard，並非同步建立頁面通知。
     */
    function copyCurrentUrl() {
        let url = window.location.href;
        let notificationTitle = '已複製網址！';

        if (isXTwitter()) {
            url = convertToFxTwitter(url);
            notificationTitle = '已複製 fxTwitter 網址！';
        } else if (isThreads()) {
            url = convertToVxThreads(url);
            notificationTitle = '已複製 vxThreads 網址！';
        } else if (isAmazonJapan()) {
            const shortUrl = convertToAmazonShort(url);
            if (shortUrl !== url) {
                url = shortUrl;
                notificationTitle = '已複製 Amazon 短網址！';
            }
        } else if (isShopee()) {
            const shortUrl = convertToShopeeShort(url);
            if (shortUrl !== url) {
                url = shortUrl;
                notificationTitle = '已複製 Shopee 短網址！';
            }
        } else if (isPChome24h()) {
            const shortUrl = convertToPancake(url);
            if (shortUrl !== url) {
                url = shortUrl;
                notificationTitle = '已複製 PChome Pancake 網址！';
            }
        }

        GM_setClipboard(url, 'text');
        showNotification(url, notificationTitle);
    }

    // ========== 初始化 ==========

    // 監聽鍵盤事件（所有網站）；只接受瀏覽器產生的可信使用者操作。
    document.addEventListener('keydown', function (e) {
        if (!e.isTrusted) return;

        // Ctrl+Shift+C
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
            e.preventDefault();
            e.stopPropagation();
            copyCurrentUrl();
        }
    }, true);

})();
