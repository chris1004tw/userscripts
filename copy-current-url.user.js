// ==UserScript==
// @name         複製當前網址
// @namespace    https://chris.taipei
// @version      0.3
// @description  按下 Ctrl+Shift+C 複製當前網址（X/Twitter 轉 fxTwitter，PChome 轉 Pancake，Shopee 轉短網址）
// @author       chris1004tw
// @match        *://*/*
// @grant        GM_setClipboard
// @run-at       document-end
// @updateURL    https://github.com/chris1004tw/userscripts/raw/main/copy-current-url.user.js
// @downloadURL  https://github.com/chris1004tw/userscripts/raw/main/copy-current-url.user.js
// ==/UserScript==
// Co-authored with Claude Opus 4.5
// Shopee 短網址轉換參考自 https://github.com/gnehs/userscripts
// PChome 短網址服務由 https://p.pancake.tw/ 提供
// X/Twitter 短網址服務由 https://fxtwitter.com/ 提供

(function () {
    'use strict';

    // 只在主框架執行，避免 iframe 內重複顯示通知
    if (window.self !== window.top) {
        return;
    }

    // 等待 body 存在
    function waitForBody() {
        return new Promise((resolve) => {
            if (document.body) {
                resolve();
                return;
            }
            const observer = new MutationObserver(() => {
                if (document.body) {
                    observer.disconnect();
                    resolve();
                }
            });
            observer.observe(document.documentElement, { childList: true });
        });
    }

    // 確保動畫樣式存在
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

    // 顯示通知
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
                animation: copyUrlFadeInOut 2s ease-in-out !important;
                max-width: 400px !important;
                pointer-events: none !important;
            `;

            document.body.appendChild(notification);
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.remove();
                }
            }, 2000);
        } catch (err) {
            // 通知顯示失敗不影響複製功能
            console.warn('[Copy URL] 通知顯示失敗:', err);
        }
    }

    // 檢查是否為 X/Twitter 網站
    function isXTwitter() {
        const host = window.location.hostname;
        return host === 'x.com' || host === 'twitter.com' ||
            host === 'www.x.com' || host === 'www.twitter.com';
    }

    // 將 X/Twitter 網址轉換為 fxTwitter
    // 嵌入修復服務由 https://fxtwitter.com/ 提供
    function convertToFxTwitter(url) {
        return url
            .replace(/https?:\/\/(www\.)?x\.com/, 'https://fxtwitter.com')
            .replace(/https?:\/\/(www\.)?twitter\.com/, 'https://fxtwitter.com');
    }

    // 檢查是否為 Shopee 網站
    function isShopee() {
        return window.location.hostname === 'shopee.tw';
    }

    // 將 Shopee 網址轉換為短網址
    // 參考自 https://github.com/gnehs/userscripts
    function convertToShopeeShort(url) {
        const parser = document.createElement('a');
        parser.href = url;

        // 取路徑最後一段，以 - 分隔
        const pathParts = parser.pathname.split('-');
        const lastPart = pathParts[pathParts.length - 1];

        // 檢查是否為 i.shopId.itemId 格式
        const shopeePath = lastPart.split('.');
        if (shopeePath[0] === 'i' && shopeePath.length === 3) {
            return 'https://shopee.tw/product/' + shopeePath[1] + '/' + shopeePath[2];
        }

        // 非商品頁面，回傳原網址
        return url;
    }

    // 檢查是否為 PChome 24h 網站
    function isPChome24h() {
        return window.location.hostname === '24h.pchome.com.tw';
    }

    // 將 PChome 24h 網址轉換為 pancake.tw 短網址
    // 短網址服務由 https://p.pancake.tw/ 提供
    function convertToPancake(url) {
        // 只處理商品頁面 /prod/xxx
        const match = url.match(/^https?:\/\/24h\.pchome\.com\.tw(\/prod\/[^?#]+)/);
        if (match) {
            return 'https://p.pancake.tw' + match[1];
        }
        // 非商品頁面，回傳原網址
        return url;
    }

    // 複製網址並顯示通知
    function copyCurrentUrl() {
        let url = window.location.href;
        let notificationTitle = '已複製網址！';

        if (isXTwitter()) {
            url = convertToFxTwitter(url);
            notificationTitle = '已複製 fxTwitter 網址！';
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

    // ========== X/Twitter 專屬功能（按鈕） ==========

    // 檢查是否在單篇推文頁面
    function isStatusPage() {
        return /\/(status|statuses)\/\d+/.test(window.location.pathname);
    }

    // 創建內嵌按鈕（模仿 X.com 分享按鈕樣式）
    function createInlineButton() {
        const outerContainer = document.createElement('div');
        outerContainer.setAttribute('class', 'css-175oi2r');
        outerContainer.style.cssText = 'justify-content: inherit; display: inline-grid; transform: rotate(0deg) scale(1) translate3d(0px, 0px, 0px);';
        outerContainer.id = 'fxtwitter-copy-container';

        const innerContainer = document.createElement('div');
        innerContainer.setAttribute('class', 'css-175oi2r r-18u37iz r-1h0z5md');

        const button = document.createElement('button');
        button.setAttribute('aria-label', '複製 fxTwitter 連結');
        button.setAttribute('role', 'button');
        button.setAttribute('class', 'css-175oi2r r-1777fci r-bt1l66 r-bztko3 r-lrvibr r-1loqt21 r-1ny4l3l');
        button.type = 'button';
        button.id = 'fxtwitter-copy-btn';
        button.setAttribute('title', '複製 fxTwitter 連結');

        const buttonContent = document.createElement('div');
        buttonContent.setAttribute('dir', 'ltr');
        buttonContent.setAttribute('class', 'css-146c3p1 r-bcqeeo r-1ttztb7 r-qvutc0 r-37j5jr r-a023e6 r-rjixqe r-16dba41 r-1awozwy r-6koalj r-1h0z5md r-o7ynqc r-clp7b1 r-3s2u2q');
        buttonContent.style.color = 'rgb(113, 118, 123)';

        const iconContainer = document.createElement('div');
        iconContainer.setAttribute('class', 'css-175oi2r r-xoduu5');

        const iconBackground = document.createElement('div');
        iconBackground.setAttribute('class', 'css-175oi2r r-xoduu5 r-1p0dtai r-1d2f490 r-u8s1d r-zchlnj r-ipm5af r-1niwhzg r-sdzlij r-xf4iuw r-o7ynqc r-6416eg r-1ny4l3l');

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('class', 'r-4qtqp9 r-yyyyoo r-dnmrzs r-bnwqim r-lrvibr r-m6rgpd r-50lct3 r-1srniue');

        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z');

        g.appendChild(path);
        svg.appendChild(g);
        iconContainer.appendChild(iconBackground);
        iconContainer.appendChild(svg);
        buttonContent.appendChild(iconContainer);
        button.appendChild(buttonContent);
        innerContainer.appendChild(button);
        outerContainer.appendChild(innerContainer);

        // 懸停效果
        button.addEventListener('mouseenter', () => {
            buttonContent.style.color = 'rgb(29, 155, 240)';
            iconBackground.style.backgroundColor = 'rgba(29, 155, 240, 0.1)';
        });
        button.addEventListener('mouseleave', () => {
            buttonContent.style.color = 'rgb(113, 118, 123)';
            iconBackground.style.backgroundColor = '';
        });

        return outerContainer;
    }

    // 添加按鈕到推文操作區域
    function addButtonToTweets() {
        if (!isStatusPage()) return;

        const actionGroups = document.querySelectorAll('div[role="group"]');

        actionGroups.forEach(group => {
            if (group.querySelector('#fxtwitter-copy-container')) return;

            const hasReply = group.querySelector('[data-testid="reply"]');
            const hasRetweet = group.querySelector('[data-testid="retweet"]');
            const hasLike = group.querySelector('[data-testid="like"]');
            const hasShare = group.querySelector('[data-testid="share"]');

            const actionCount = [hasReply, hasRetweet, hasLike, hasShare].filter(Boolean).length;

            if (actionCount >= 2) {
                const buttonContainer = createInlineButton();
                const button = buttonContainer.querySelector('#fxtwitter-copy-btn');
                button.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    copyCurrentUrl();
                });
                group.appendChild(buttonContainer);
            }
        });
    }

    // 初始化 X/Twitter 專屬功能
    function initXTwitterFeatures() {
        // 初始添加按鈕
        setTimeout(addButtonToTweets, 1000);
        setTimeout(addButtonToTweets, 2000);

        // MutationObserver 監聽頁面變化
        const observer = new MutationObserver((mutations) => {
            let shouldUpdate = false;
            mutations.forEach((mutation) => {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.tagName === 'ARTICLE' ||
                                (node.querySelector && node.querySelector('article'))) {
                                shouldUpdate = true;
                            }
                        }
                    });
                }
            });

            if (shouldUpdate) {
                clearTimeout(window.fxTwitterTimeout);
                window.fxTwitterTimeout = setTimeout(addButtonToTweets, 500);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // 監聽 URL 變化（SPA）
        let lastUrl = location.href;
        setInterval(() => {
            const url = location.href;
            if (url !== lastUrl) {
                lastUrl = url;
                setTimeout(addButtonToTweets, 1000);
            }
        }, 1000);
    }

    // ========== 初始化 ==========

    // 監聽鍵盤事件（所有網站）
    document.addEventListener('keydown', function (e) {
        // Ctrl+Shift+C
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
            e.preventDefault();
            e.stopPropagation();
            copyCurrentUrl();
        }
    }, true);

    // X/Twitter 專屬功能（按鈕 + MutationObserver）
    if (isXTwitter()) {
        initXTwitterFeatures();
    }

})();
