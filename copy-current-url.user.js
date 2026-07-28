// ==UserScript==
// @name         複製當前網址
// @namespace    https://chris.taipei
// @version      0.4.3
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

    // X/Twitter 功能的延遲與單幀工作量常數
    const DELAY_INITIAL = 1000;
    const DELAY_RETRY = 2000;
    const DELAY_TWEET_SCAN = 500;
    const MAX_TWEET_NODES_PER_FRAME = 200;
    const MAX_ACTION_GROUPS_PER_FRAME = 100;
    const NOTIFICATION_DURATION = 2000;
    const TWEET_ACTION_GROUP_SELECTOR = 'div[role="group"]';
    const TWEET_RELEVANT_SELECTOR = `article, ${TWEET_ACTION_GROUP_SELECTOR}`;

    /**
     * @typedef {Object} TweetNodeWork
     * @property {Element} node 要探索的目前元素。
     * @property {boolean} includeNextSiblings 是否要延續同層兄弟鏈。
     * @property {Element | null} nextSibling 入列當下的下一個兄弟快照，供目前節點離線時續接。
     */

    // 所有排程狀態都留在閉包中，避免全域汙染並讓卸載清理可完整配對。
    let fxTwitterTimeout;
    let initialScanTimeout;
    let retryScanTimeout;
    let actionGroupFrameId;
    const pendingTweetRoots = new Set();
    /** @type {TweetNodeWork[]} */
    const pendingTweetNodes = [];
    let pendingTweetNodeIndex = 0;
    /** @type {WeakMap<Element, TweetNodeWork>} */
    const queuedTweetNodes = new WeakMap();
    const pendingActionGroups = [];
    const queuedActionGroups = new WeakSet();
    let pendingFullTweetScan = false;

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

    // ========== X/Twitter 專屬功能（按鈕） ==========

    /**
     * 判斷目前路徑是否為單篇推文頁面。
     *
     * @returns {boolean} 路徑含 status 或 statuses 加數字識別碼時回傳 true。
     * 此函式只讀取 location，無副作用。
     */
    function isStatusPage() {
        return /\/(status|statuses)\/\d+/.test(window.location.pathname);
    }

    // 創建內嵌按鈕（模仿 X.com 分享按鈕樣式）
    const BUTTON_COLOR = 'rgb(113, 118, 123)';
    const BUTTON_HOVER_COLOR = 'rgb(29, 155, 240)';
    const BUTTON_HOVER_BG = 'rgba(29, 155, 240, 0.1)';

    /**
     * 建立符合 X action bar 樣式的 fxTwitter 複製按鈕。
     *
     * @returns {HTMLDivElement} 包住按鈕與圖示的最外層容器。
     * 副作用：在新建按鈕上註冊 hover 與 click 監聽器；尚不修改現有頁面 DOM。
     */
    function createInlineButton() {
        const outerContainer = document.createElement('div');
        outerContainer.setAttribute('class', 'css-175oi2r');
        outerContainer.style.cssText = 'justify-content: inherit; display: inline-grid; transform: rotate(0deg) scale(1) translate3d(0px, 0px, 0px);';

        const innerContainer = document.createElement('div');
        innerContainer.setAttribute('class', 'css-175oi2r r-18u37iz r-1h0z5md');

        const button = document.createElement('button');
        button.setAttribute('aria-label', '複製 fxTwitter 連結');
        button.setAttribute('role', 'button');
        button.setAttribute('class', 'css-175oi2r r-1777fci r-bt1l66 r-bztko3 r-lrvibr r-1loqt21 r-1ny4l3l');
        button.type = 'button';
        button.setAttribute('title', '複製 fxTwitter 連結');

        const buttonContent = document.createElement('div');
        buttonContent.setAttribute('dir', 'ltr');
        buttonContent.setAttribute('class', 'css-146c3p1 r-bcqeeo r-1ttztb7 r-qvutc0 r-37j5jr r-a023e6 r-rjixqe r-16dba41 r-1awozwy r-6koalj r-1h0z5md r-o7ynqc r-clp7b1 r-3s2u2q');
        buttonContent.style.color = BUTTON_COLOR;

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
            buttonContent.style.color = BUTTON_HOVER_COLOR;
            iconBackground.style.backgroundColor = BUTTON_HOVER_BG;
        });
        button.addEventListener('mouseleave', () => {
            buttonContent.style.color = BUTTON_COLOR;
            iconBackground.style.backgroundColor = '';
        });
        button.addEventListener('click', (e) => {
            if (!e.isTrusted) return;

            e.stopPropagation();
            e.preventDefault();
            copyCurrentUrl();
        });

        return outerContainer;
    }

    // 保存 group 與實際注入根的對應；站點移除根節點後，同一 group 仍可重新插入。
    const injectedRoots = new WeakMap();

    /**
     * 判斷 action group 目前是否仍包含本腳本最後一次插入的根節點。
     *
     * @param {Element} group 要檢查的 action group。
     * @returns {boolean} WeakMap 中的注入根仍位於 group 內時回傳 true。
     * 此函式只讀取 WeakMap 與 DOM 關係，無副作用。
     */
    function hasAttachedInlineButton(group) {
        const injectedRoot = injectedRoots.get(group);
        return Boolean(injectedRoot && group.contains(injectedRoot));
    }

    /**
     * 在單一 X action group 具備足夠原生操作時插入複製按鈕。
     *
     * @param {Element} group 要檢查的 action group。
     * @returns {boolean} 本次成功插入按鈕時回傳 true；按鈕仍存在、不完整或已斷線時回傳 false。
     * 副作用：成功時修改 group DOM，並在 injectedRoots 保存實際注入根。
     */
    function processActionGroup(group) {
        if (!group.isConnected || hasAttachedInlineButton(group)) return false;

        const hasReply = group.querySelector('[data-testid="reply"]');
        const hasRetweet = group.querySelector('[data-testid="retweet"]');
        const hasLike = group.querySelector('[data-testid="like"]');
        const hasShare = group.querySelector('[data-testid="share"]');
        const actionCount = [hasReply, hasRetweet, hasLike, hasShare].filter(Boolean).length;

        if (actionCount < 2) return false;

        const injectedRoot = createInlineButton();
        group.appendChild(injectedRoot);
        injectedRoots.set(group, injectedRoot);
        return true;
    }

    /**
     * 從元素自身向上尋找仍連接頁面的最近 action group。
     *
     * @param {Node} node 要回推祖先的 DOM 節點。
     * @returns {Element | null} 最近且仍連線的 action group；找不到時回傳 null。
     * 此函式只讀取 DOM 關係，無副作用。
     */
    function findClosestConnectedActionGroup(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
        const group = node.closest?.(TWEET_ACTION_GROUP_SELECTOR);
        return group?.isConnected ? group : null;
    }

    /**
     * 從 mutation target 向上尋找仍連接頁面的最近 article 或 action group。
     *
     * @param {Node} node childList mutation 的 target。
     * @returns {Element | null} 最近的相關掃描根；body 等無關區域回傳 null。
     * 此函式只走訪祖先，不會同步查詢 target 的後代。
     */
    function findClosestConnectedTweetRoot(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
        const root = node.closest?.(TWEET_RELEVANT_SELECTOR);
        return root?.isConnected ? root : null;
    }

    /**
     * 將單一仍連接的 DOM 節點加入逐幀探索佇列。
     *
     * @param {Element | null} node 要加入探索佇列的元素。
     * @param {boolean} [includeNextSiblings=false] 處理後是否沿 nextElementSibling 繼續同層探索。
     * @returns {void} 無回傳值。
     * 副作用：更新 pendingTweetNodes／queuedTweetNodes，並可能排程 animation frame。
     */
    function enqueueTweetNode(node, includeNextSiblings = false) {
        if (!node?.isConnected) return;

        const existingWork = queuedTweetNodes.get(node);
        if (existingWork) {
            // 同一節點可能先以獨立 root 入列，之後才從父節點取得兄弟走訪責任。
            if (includeNextSiblings && !existingWork.includeNextSiblings) {
                existingWork.includeNextSiblings = true;
                existingWork.nextSibling = node.nextElementSibling;
            }
            return;
        }

        const work = {
            node,
            includeNextSiblings,
            nextSibling: includeNextSiblings ? node.nextElementSibling : null
        };
        queuedTweetNodes.set(node, work);
        pendingTweetNodes.push(work);
        scheduleActionGroupFrame();
    }

    /**
     * 將一組獨立掃描根加入探索佇列，不讓任一 root 走訪到集合外的兄弟。
     *
     * 設計意圖：後代只由 firstElementChild／nextElementSibling 逐節點展開，
     * 避免極寬 subtree 在單一工作中同步迭代全部直接 children。
     *
     * @param {ArrayLike<Element>} nodes 要加入探索佇列的元素集合。
     * @returns {void} 無回傳值。
     * 副作用：逐一呼叫 enqueueTweetNode，並可能排程 animation frame。
     */
    function enqueueTweetNodes(nodes) {
        for (let index = 0; index < nodes.length; index++) {
            enqueueTweetNode(nodes[index]);
        }
    }

    /**
     * 探索單一 DOM 節點；找到 action group 時停止向內展開，否則只排入直接子元素。
     *
     * @param {Element} node 本幀要探索的元素。
     * @returns {void} 無回傳值。
     * 副作用：至多排入第一個子元素，或加入 action group；兄弟鏈由 work item 快照續接。
     */
    function exploreTweetNode(node) {
        const closestGroup = findClosestConnectedActionGroup(node);
        if (closestGroup) {
            enqueueActionGroups([closestGroup]);
        } else if (node.firstElementChild) {
            enqueueTweetNode(node.firstElementChild, true);
        }
    }

    /**
     * 確保 DOM 探索或 action group 佇列已有一個待執行的 animation frame。
     *
     * @returns {void} 無回傳值。
     * 副作用：必要時呼叫 requestAnimationFrame 並更新 actionGroupFrameId。
     */
    function scheduleActionGroupFrame() {
        if (actionGroupFrameId !== undefined ||
            (pendingTweetNodeIndex >= pendingTweetNodes.length && pendingActionGroups.length === 0)) {
            return;
        }

        actionGroupFrameId = requestAnimationFrame(processQueuedActionGroups);
    }

    /**
     * 將尚未排程且仍連接頁面的 action group 加入逐幀處理佇列。
     *
     * @param {Iterable<Element>} groups 要排程的 action group 集合。
     * @returns {void} 無回傳值。
     * 副作用：更新 pendingActionGroups／queuedActionGroups，並可能排程 animation frame。
     */
    function enqueueActionGroups(groups) {
        for (const group of groups) {
            if (!group.isConnected || hasAttachedInlineButton(group) || queuedActionGroups.has(group)) {
                continue;
            }

            queuedActionGroups.add(group);
            pendingActionGroups.push(group);
        }

        scheduleActionGroupFrame();
    }

    /**
     * 處理一幀內允許的 DOM 探索與 action group，剩餘項目延到下一幀。
     *
     * @returns {void} 無回傳值。
     * 副作用：最多探索 MAX_TWEET_NODES_PER_FRAME 個節點、處理
     * MAX_ACTION_GROUPS_PER_FRAME 個 action group，並在尚有工作時排程下一幀。
     */
    function processQueuedActionGroups() {
        try {
            let exploredNodeCount = 0;
            while (exploredNodeCount < MAX_TWEET_NODES_PER_FRAME &&
                pendingTweetNodeIndex < pendingTweetNodes.length) {
                const work = pendingTweetNodes[pendingTweetNodeIndex++];
                const node = work.node;
                exploredNodeCount += 1;
                queuedTweetNodes.delete(node);

                // 兄弟快照必須先續接；即使目前節點已離線，後方仍連線的兄弟也不能漏掃。
                if (work.includeNextSiblings && work.nextSibling) {
                    enqueueTweetNode(work.nextSibling, true);
                }

                const isConnected = node.isConnected;
                if (isConnected) exploreTweetNode(node);
            }
            if (pendingTweetNodeIndex >= pendingTweetNodes.length) {
                pendingTweetNodes.length = 0;
                pendingTweetNodeIndex = 0;
            }

            const groupsThisFrame = pendingActionGroups.splice(0, MAX_ACTION_GROUPS_PER_FRAME);
            for (const group of groupsThisFrame) {
                queuedActionGroups.delete(group);
                if (group.isConnected) processActionGroup(group);
            }
        } finally {
            // 執行期間保留 frame id，讓探索途中加入的新工作不會額外排出重複 rAF。
            actionGroupFrameId = undefined;
            scheduleActionGroupFrame();
        }
    }

    /**
     * 以固定節流排程 X action group 掃描；連續呼叫不重設既有 deadline。
     *
     * @param {boolean} [full=false] 是否捨棄局部根節點並在 deadline 到達時完整掃描頁面。
     * @returns {void} 無回傳值。
     * 副作用：更新待掃描集合，並在尚未排程時建立 DELAY_TWEET_SCAN timeout。
     */
    function scheduleTweetScan(full = false) {
        if (full) {
            pendingFullTweetScan = true;
            pendingTweetRoots.clear();
        }

        // 固定節流不重設既有 timeout，確保高頻 DOM 變更最晚仍會在固定期限內處理。
        if (fxTwitterTimeout !== undefined) return;

        fxTwitterTimeout = setTimeout(() => {
            fxTwitterTimeout = undefined;

            const roots = pendingFullTweetScan ? null : Array.from(pendingTweetRoots);
            pendingTweetRoots.clear();
            pendingFullTweetScan = false;
            addButtonToTweets(roots);
        }, DELAY_TWEET_SCAN);
    }

    /**
     * 以 O(1) 的自身／祖先資訊決定新增節點的探索起點。
     *
     * 設計意圖：observer callback 不查詢新增 subtree；有子元素的未知容器先保留，
     * 交由逐幀探索判斷其中是否存在 article 或 action group。
     *
     * @param {Node} node MutationObserver 回報的新增節點。
     * @returns {Element | null} 最近 action group、可探索元素，或不需處理時的 null。
     * 此函式只讀取節點自身與祖先，不會同步探索後代。
     */
    function getTweetExplorationRoot(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE || !node.isConnected) return null;

        const closestGroup = findClosestConnectedActionGroup(node);
        if (closestGroup) return closestGroup;
        if (node.matches?.(TWEET_RELEVANT_SELECTOR)) return node;
        return node.firstElementChild ? node : null;
    }

    /**
     * 將完整頁面或指定新增根節點交由逐幀探索佇列處理。
     *
     * @param {Element[] | null} [roots=null] 局部掃描根節點；null 代表完整頁面掃描。
     * @returns {void} 無回傳值。
     * 副作用：在單篇推文頁面更新 DOM 探索佇列並排程 animation frame。
     */
    function addButtonToTweets(roots = null) {
        if (!isStatusPage()) return;

        if (!roots) {
            enqueueTweetNodes([document.body]);
            return;
        }

        enqueueTweetNodes(roots);
    }

    /**
     * 初始化 X/Twitter 按鈕注入、DOM 監聽與 SPA 導航監聽。
     *
     * @returns {void} 無回傳值。
     * 副作用：建立初始／重試 timeout 與 MutationObserver、覆寫 history 方法，並註冊
     * popstate／pagehide 監聽器；只有離開 bfcache 的 pagehide 才會對稱清理所有資源。
     */
    function initXTwitterFeatures() {
        // 初始添加按鈕
        initialScanTimeout = setTimeout(() => {
            initialScanTimeout = undefined;
            addButtonToTweets();
        }, DELAY_INITIAL);
        retryScanTimeout = setTimeout(() => {
            retryScanTimeout = undefined;
            addButtonToTweets();
        }, DELAY_RETRY);

        // MutationObserver 監聽頁面變化
        const observer = new MutationObserver((mutations) => {
            let shouldUpdate = false;
            for (const mutation of mutations) {
                if (mutation.type !== 'childList') continue;

                const removedNodes = mutation.removedNodes || [];
                if (removedNodes.length > 0) {
                    // 只有探索尚未完成時，saved-next removal 才可能截斷兄弟鏈並需要祖先增量重掃。
                    if (pendingTweetNodeIndex < pendingTweetNodes.length) {
                        const relevantRoot = findClosestConnectedTweetRoot(mutation.target);
                        if (relevantRoot) {
                            if (!pendingFullTweetScan) pendingTweetRoots.add(relevantRoot);
                            shouldUpdate = true;
                        }
                    }

                    const affectedGroups = new Set();
                    const targetGroup = findClosestConnectedActionGroup(mutation.target);
                    if (targetGroup) affectedGroups.add(targetGroup);

                    // removedNodes 可能已脫離 group，因此也要從仍連線的 mutation.target 回推。
                    for (const node of removedNodes) {
                        const closestGroup = findClosestConnectedActionGroup(node);
                        if (closestGroup) affectedGroups.add(closestGroup);
                    }

                    for (const group of affectedGroups) {
                        if (hasAttachedInlineButton(group)) continue;
                        if (!pendingFullTweetScan) pendingTweetRoots.add(group);
                        shouldUpdate = true;
                    }
                }

                for (const node of mutation.addedNodes) {
                    const explorationRoot = getTweetExplorationRoot(node);
                    if (!explorationRoot) continue;

                    // 子節點補齊 action bar 時從最近 group 重試；未知容器則延後逐幀探索。
                    if (!pendingFullTweetScan) {
                        pendingTweetRoots.add(explorationRoot);
                    }
                    shouldUpdate = true;
                }
            }

            if (shouldUpdate) {
                scheduleTweetScan();
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // 攔截 history API 偵測 SPA 導航（取代 setInterval 輪詢）
        let lastUrl = location.href;
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        /**
         * 在 history 或 popstate 事件後偵測實際網址變化並排程完整掃描。
         *
         * @returns {void} 無回傳值。
         * 副作用：網址改變時更新 lastUrl，並排程完整推文掃描。
         */
        function onUrlChange() {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                scheduleTweetScan(true);
            }
        }

        /**
         * 保留原 pushState 回傳值，並在呼叫後檢查網址變化。
         *
         * @param {...unknown} args 原始 pushState 參數。
         * @returns {unknown} 原始 pushState 的回傳值。
         * 副作用：執行原 history 操作，並可能排程完整推文掃描。
         */
        const patchedPushState = function (...args) {
            const result = originalPushState.apply(this, args);
            onUrlChange();
            return result;
        };

        /**
         * 保留原 replaceState 回傳值，並在呼叫後檢查網址變化。
         *
         * @param {...unknown} args 原始 replaceState 參數。
         * @returns {unknown} 原始 replaceState 的回傳值。
         * 副作用：執行原 history 操作，並可能排程完整推文掃描。
         */
        const patchedReplaceState = function (...args) {
            const result = originalReplaceState.apply(this, args);
            onUrlChange();
            return result;
        };

        history.pushState = patchedPushState;
        history.replaceState = patchedReplaceState;

        window.addEventListener('popstate', onUrlChange);

        /**
         * 在確定離開頁面且不進入 bfcache 時停止非同步工作並還原瀏覽器 API。
         *
         * @param {PageTransitionEvent} event pagehide 事件；persisted=true 代表頁面將進入 bfcache。
         * @returns {void} 無回傳值。
         * 副作用：非 persisted 時中斷 observer，清除三類 timeout 與 animation frame、清空探索／處理佇列，
         * 移除事件監聽器並還原 history；persisted 時不修改任何資源。
         */
        function cleanupXTwitterFeatures(event) {
            if (event.persisted) return;

            observer.disconnect();

            for (const timeoutId of [initialScanTimeout, retryScanTimeout, fxTwitterTimeout]) {
                if (timeoutId !== undefined) clearTimeout(timeoutId);
            }
            initialScanTimeout = undefined;
            retryScanTimeout = undefined;
            fxTwitterTimeout = undefined;

            if (actionGroupFrameId !== undefined) {
                cancelAnimationFrame(actionGroupFrameId);
                actionGroupFrameId = undefined;
            }

            pendingTweetRoots.clear();
            pendingTweetNodes.length = 0;
            pendingTweetNodeIndex = 0;
            pendingActionGroups.length = 0;
            pendingFullTweetScan = false;

            window.removeEventListener('popstate', onUrlChange);
            window.removeEventListener('pagehide', cleanupXTwitterFeatures);
            if (history.pushState === patchedPushState) history.pushState = originalPushState;
            if (history.replaceState === patchedReplaceState) history.replaceState = originalReplaceState;
        }

        window.addEventListener('pagehide', cleanupXTwitterFeatures);
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

    // X/Twitter 專屬功能（按鈕 + MutationObserver）
    if (isXTwitter()) {
        initXTwitterFeatures();
    }

})();
