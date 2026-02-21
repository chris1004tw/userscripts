// ==UserScript==
// @name         替換字體為 AppleGothic
// @namespace    https://chris.taipei
// @version      0.4.2
// @description  將頁面字體改為 AppleGothic（簡體用 AppleGothicSC），且還原字體替換對 Icon 的影響
// @author       chris1004tw
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @updateURL    https://github.com/chris1004tw/userscripts/raw/main/force-fonts-applegothic.user.js
// @downloadURL  https://github.com/chris1004tw/userscripts/raw/main/force-fonts-applegothic.user.js
// ==/UserScript==
// Co-authored with Claude Opus 4.6 Thinking

(function () {
    'use strict';

    // ===== 目標字體（統一定義）=====
    const TARGET_FONT = 'AppleGothic, AppleGothicSC, "Malgun Gothic", "Apple Monochrome Emoji Ind", "SF Pro Icons", "SF Pro Text", sans-serif';

    // ===== Canvas API 攔截（必須最早執行）=====
    // Canvas 文字是用 JS 繪製的，CSS 無法控制，需要攔截 API
    (function interceptCanvasText() {
        // 解析 CSS font 字串，替換字體部分
        // font 格式: [font-style] [font-variant] [font-weight] font-size [/line-height] font-family
        // 例如: "12px Arial", "bold 14px sans-serif", "italic 12px/1.5 'Helvetica Neue'"
        const fontSizeRegex = /(\d+(?:\.\d+)?(?:px|pt|em|rem|%|vh|vw|ex|ch|vmin|vmax))/i;
        const lineHeightRegex = /^(\/[\d.]+(?:px|pt|em|rem|%)?)?/;

        function replaceFont(fontStr) {
            if (!fontStr) return `12px ${TARGET_FONT}`;

            // 找到 font-size 的位置（數字+單位）
            const sizeMatch = fontStr.match(fontSizeRegex);
            if (!sizeMatch) return fontStr; // 無法解析，返回原值

            const sizeIndex = fontStr.indexOf(sizeMatch[0]);
            const sizeEnd = sizeIndex + sizeMatch[0].length;

            // size 之前的部分（style, variant, weight）
            const prefix = fontStr.substring(0, sizeEnd);

            // 檢查是否有 line-height（/後面的數字）
            const afterSize = fontStr.substring(sizeEnd);
            const lineHeightMatch = afterSize.match(lineHeightRegex);
            const lineHeight = lineHeightMatch ? lineHeightMatch[0] : '';

            return prefix + lineHeight + ' ' + TARGET_FONT;
        }

        const proto = CanvasRenderingContext2D.prototype;
        const originalFillText = proto.fillText;
        const originalStrokeText = proto.strokeText;

        proto.fillText = function (text, x, y, maxWidth) {
            this.font = replaceFont(this.font);
            if (maxWidth !== undefined) {
                return originalFillText.call(this, text, x, y, maxWidth);
            }
            return originalFillText.call(this, text, x, y);
        };

        proto.strokeText = function (text, x, y, maxWidth) {
            this.font = replaceFont(this.font);
            if (maxWidth !== undefined) {
                return originalStrokeText.call(this, text, x, y, maxWidth);
            }
            return originalStrokeText.call(this, text, x, y);
        };
    })();

    // ===== 黑名單管理 =====
    const currentHost = location.hostname;
    const blacklist = GM_getValue('blacklist', []);
    let isEnabled = !blacklist.includes(currentHost);

    // 選單指令（只在主框架註冊，避免 iframe 導致多個 alert）
    if (window.self === window.top) {
        GM_registerMenuCommand(isEnabled ? '🚫 停用此網站' : '✅ 啟用此網站', () => {
            if (isEnabled) {
                blacklist.push(currentHost);
                GM_setValue('blacklist', blacklist);
                alert(`已將 ${currentHost} 加入黑名單，重新整理後生效`);
            } else {
                const idx = blacklist.indexOf(currentHost);
                if (idx > -1) blacklist.splice(idx, 1);
                GM_setValue('blacklist', blacklist);
                alert(`已將 ${currentHost} 從黑名單移除，重新整理後生效`);
            }
        });

        GM_registerMenuCommand('📋 查看黑名單', () => {
            const list = GM_getValue('blacklist', []);
            alert(list.length ? '黑名單：\n' + list.join('\n') : '黑名單是空的');
        });

        GM_registerMenuCommand('🗑️ 清空黑名單', () => {
            if (confirm('確定要清空黑名單嗎？')) {
                GM_setValue('blacklist', []);
                alert('黑名單已清空，重新整理後生效');
            }
        });

        GM_registerMenuCommand('🔄 重新掃描頁面', () => {
            if (isEnabled) {
                forceRescan();
            } else {
                alert('此網站已被停用');
            }
        });
    }

    if (!isEnabled) return;

    // ===== CSS 樣式（核心：用 CSS 強制套用字體）=====
    function initStyles() {
        GM_addStyle(`
            @font-face { font-family: 'AppleGothic'; src: local('AppleGothic'); }
            @font-face { font-family: 'AppleGothicSC'; src: local('AppleGothicSC'); }
            /* 韓文 Hangul 字元強制使用 Malgun Gothic（AppleGothic cmap 聲稱涵蓋但字形缺失） */
            @font-face { font-family: 'AppleGothic'; src: local('Malgun Gothic'); unicode-range: U+1100-11FF, U+3130-318F, U+A960-A97F, U+AC00-D7AF, U+D7B0-D7FF; }

            /* 程式碼區域 - Cascadia Code 等寬字體（先宣告） */
            /* 廣泛子代選擇器用 :where() 包裹，避免非程式碼子元素被套用 monospace */
            :where([data-hpc="true"] *),
            :where(.react-code-lines *),
            :where(.blob-code *),
            [data-hpc="true"],
            .react-code-lines,
            .react-code-text,
            .react-file-line,
            .react-line-number,
            [class*="react-code"],
            [class*="react-blob"],
            [class*="pl-"],
            .blob-code,
            .blob-num,
            .highlight pre,
            .highlight code,
            code,
            pre,
            kbd,
            samp,
            tt {
                font-family: "Cascadia Code", "Cascadia Mono", Consolas, "SF Mono", "JetBrains Mono", monospace, AppleGothic, AppleGothicSC !important;
            }

            /* 主規則：:where() 使特異性歸零（後宣告，同特異性時覆蓋程式碼區域的 :where() 子代選擇器） */
            /* 移除程式碼相關 :not()，靠宣告順序處理，減少 14 個 :not() 條件 */
            :where(html body *:not([data-no-font]):not([data-no-font-parent]):not([class*="icon"]):not([class*="Icon"]):not([class*="fa-"]):not([class*="material"]):not([class*="glyph"]):not([class*="symbol"]):not([class*="Symbol"]):not([data-icon]):not([class*="bx"]):not([class*="boxicon"]):not([class*="checkbox"]):not([class*="radio"]):not(input):not(select):not(textarea):not(button)) {
                font-family: AppleGothic, AppleGothicSC, "Malgun Gothic", "Apple Monochrome Emoji Ind", "SF Pro Icons", "SF Pro Text", sans-serif !important;
            }

            /* 表單元素額外強制（排除 checkbox/radio，因為它們常用 icon 字體顯示勾選狀態）*/
            select, option, input:not([type="checkbox"]):not([type="radio"]), textarea, button {
                font-family: AppleGothic, AppleGothicSC, "Malgun Gothic", "Apple Monochrome Emoji Ind", "SF Pro Icons", "SF Pro Text", sans-serif !important;
            }
        `);
    }

    // ===== 常數與狀態 =====
    // 詞邊界 \b 避免誤判（如 "lexicon" 不應匹配 "icon"）
    const iconClassPattern = /\b(icon|iconfont|icomoon|fontawesome|material|glyph|symbol|octicon|feather|ionicon|themify|alibaba|anticon|boxicon)\b|global-iconfont|woo-font/i;
    // font-family 檢測用（不需要詞邊界）
    const iconFontPattern = /icon|iconfont|icomoon|fontawesome|material|glyph|symbol|boxicon/i;
    const iconPrefixPattern = /^(fa|fas|far|fal|fad|fab|bi|ri|mdi|mi|oi|ti|si|gi|ai|di|fi|hi|pi|vi|wi|ci|bx|bxs|bxl)-/;
    const checkboxRadioPattern = /checkbox|radio/i;
    const TEXT_ELEMENT_SELECTOR = 'p,span,a,h1,h2,h3,h4,h5,h6,li,td,th,label,article,blockquote,figcaption,cite,div';
    // 排除自訂字體檢測時的白名單（我們自己定義的 @font-face）
    const ourFonts = new Set(['AppleGothic', 'AppleGothicSC']);
    let processed = new WeakSet();

    // ===== 狀態重置（供重新掃描使用）=====
    function resetState() {
        // 移除所有 data-no-font 和 data-no-font-parent 屬性（合併為單次查詢）
        document.querySelectorAll('[data-no-font], [data-no-font-parent]').forEach(el => {
            el.removeAttribute('data-no-font');
            el.removeAttribute('data-no-font-parent');
        });
        processed = new WeakSet();
        webFontCache = null;
    }

    function forceRescan() {
        resetState();
        const els = document.querySelectorAll(TEXT_ELEMENT_SELECTOR);
        let iconMarked = 0, inlineOverride = 0;
        for (let i = 0; i < els.length; i++) {
            const result = processElement(els[i]);
            if (result === RESULT_ICON) iconMarked++;
            else if (result === RESULT_OVERRIDE) inlineOverride++;
        }
        alert('[強制字體] 掃描完成:\n' +
            '總元素: ' + els.length + '\n' +
            '標記為 icon: ' + iconMarked + '\n' +
            'Inline style 覆蓋: ' + inlineOverride + '\n' +
            '套用字體: ' + (els.length - iconMarked));
    }

    // ===== Emoji 檢測（用於排除標準 emoji 被誤判為 icon）=====
    function containsStandardEmoji(el) {
        const text = el.textContent;
        if (!text) return false;
        // 標準 emoji 範圍: U+1F300 到 U+1FAFF
        // 注意：排除 Supplementary Private Use Area-B (U+100000+)
        // Apple SF Symbols 使用 U+100000+ 範圍，這些應視為 icon
        for (let i = 0; i < text.length; i++) {
            const code = text.codePointAt(i);
            if (code >= 0x1F300 && code <= 0x1FAFF) return true;
            // 處理 surrogate pair（emoji 是 32-bit，佔兩個 char）
            if (code > 0xFFFF) i++;
        }
        return false;
    }

    // ===== Icon 檢測 =====

    // 1. 檢查 class 名稱（用詞邊界避免誤判，如 "lexicon" 不應匹配 "icon"）
    function hasIconClass(el) {
        const cls = el.className;
        if (cls && typeof cls === 'string' && iconClassPattern.test(cls)) return true;
        const classList = el.classList;
        if (classList) {
            for (let i = 0; i < classList.length; i++) {
                if (iconPrefixPattern.test(classList[i])) return true;
            }
        }
        return false;
    }

    // 2. 檢查 icon 相關屬性（aria-hidden, role=img, data-icon）
    function hasIconAttribute(el) {
        if (el.getAttribute('aria-hidden') === 'true' && !containsStandardEmoji(el)) return true;
        if (el.getAttribute('role') === 'img') return true;
        if (el.hasAttribute('data-icon')) return true;
        return false;
    }

    // 3. 檢查 Unicode Private Use Area 文字（icon 字體常用）
    function hasPuaText(el) {
        const nodes = el.childNodes;
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            if (node.nodeType === 3) {
                const t = node.textContent.trim();
                if (t.length > 0 && t.length <= 2) {
                    const code = t.charCodeAt(0);
                    if (code >= 0xE000 && code <= 0xF8FF) return true;
                }
            }
        }
        return false;
    }

    // 4. 檢查 font-family 是否為 icon 字體（最昂貴的操作）
    function hasIconFont(el) {
        try {
            const fontFam = getComputedStyle(el).fontFamily;
            if (fontFam.includes('SF Pro')) return false;
            if (iconFontPattern.test(fontFam)) return true;
        } catch { }
        return false;
    }

    // 主函式：漸進式 icon 檢測管線（快→慢）
    function isIconElement(el) {
        if (hasIconClass(el)) return true;
        if (hasIconAttribute(el)) return true;
        if (hasPuaText(el)) return true;
        // 快速路徑：文字內容超過 2 字元的元素幾乎不是 icon，跳過昂貴的 getComputedStyle
        const text = el.textContent;
        if (text && text.length > 2) return false;
        return hasIconFont(el);
    }

    // 需要排除的表單元素
    function shouldSkipElement(el) {
        const tag = el.tagName;
        if (tag === 'INPUT') {
            const type = el.type;
            if (type === 'checkbox' || type === 'radio') return true;
        }
        // 檢查 class 是否包含 checkbox/radio
        const cls = el.className;
        if (cls && typeof cls === 'string') {
            if (checkboxRadioPattern.test(cls)) return true;
        }
        return false;
    }

    // ===== 自訂 @font-face 檢測（避免覆蓋反爬蟲字體導致亂碼）=====
    let webFontCache = null;

    function getWebFontNames() {
        if (webFontCache) return webFontCache;
        webFontCache = new Set();
        if (document.fonts) {
            for (const face of document.fonts) {
                webFontCache.add(face.family.replace(/['"]/g, ''));
            }
        }
        return webFontCache;
    }

    function isCustomWebFont(fontFamilyStr) {
        const firstName = fontFamilyStr.split(',')[0].trim().replace(/['"]/g, '');
        if (ourFonts.has(firstName)) return false;
        return getWebFontNames().has(firstName);
    }

    // 處理結果常數（供 forceRescan 統計使用）
    const RESULT_ICON = 1;
    const RESULT_OVERRIDE = 2;

    // 對有 inline font-family 的父元素，子元素也強制套用 inline font-family
    // 避免頁面 CSS 的 !important 規則覆蓋 :where() 零特異性選擇器
    function overrideDescendants(parent) {
        const children = parent.querySelectorAll(TEXT_ELEMENT_SELECTOR);
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (processed.has(child)) continue;
            processed.add(child);
            if (isIconElement(child)) {
                child.setAttribute('data-no-font', '');
                continue;
            }
            if (shouldSkipElement(child)) continue;
            if (child.style.fontFamily && isCustomWebFont(child.style.fontFamily)) {
                child.setAttribute('data-no-font', '');
                continue;
            }
            child.style.setProperty('font-family', TARGET_FONT, 'important');
        }
    }

    function processElement(el) {
        if (processed.has(el)) return 0;
        processed.add(el);

        // 1. 如果是 icon 元素，標記並跳過
        if (isIconElement(el)) {
            el.setAttribute('data-no-font', '');
            // 標記父元素，打破 CSS 繼承鏈
            if (el.parentElement && el.parentElement !== document.body) {
                el.parentElement.setAttribute('data-no-font-parent', '');
            }
            return RESULT_ICON;
        }

        // 2. 如果是需要跳過的表單元素，跳過
        if (shouldSkipElement(el)) return 0;

        // 3. 如果有任何 inline style（包含沒設 font-family 的情況）
        // inline !important 能打贏所有 CSS !important 規則，確保 CMS 生成的內容也被覆蓋
        if (el.hasAttribute('style')) {
            const originalFontFamily = el.style.fontFamily;
            // 若已有 font-family 且為自訂 @font-face（如淘寶反爬蟲字體），標記排除避免亂碼
            if (originalFontFamily && isCustomWebFont(originalFontFamily)) {
                el.setAttribute('data-no-font', '');
                return 0;
            }
            el.style.setProperty('font-family', TARGET_FONT, 'important');
            // 子元素可能被頁面 CSS 的 !important 規則（如 .ipmImport *）覆蓋
            // :where() 零特異性選擇器無法勝出，需對子元素也套用 inline 覆蓋
            overrideDescendants(el);
            return RESULT_OVERRIDE;
        }

        return 0;
    }

    // ===== 分批處理 =====
    const CHUNK_SIZE = 300;

    function processInChunks(els) {
        const len = els.length;
        if (len === 0) return;

        if (len < 1000) {
            for (let i = 0; i < len; i++) processElement(els[i]);
            return;
        }

        let i = 0;
        function step() {
            const end = Math.min(i + CHUNK_SIZE, len);
            while (i < end) processElement(els[i++]);
            if (i < len) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    }

    // ===== Icon 候選選擇器（用於快速標記）=====
    const iconCandidateSelector = [
        '[class*="icon"]',
        '[class*="Icon"]',
        '[class*="fa-"]',
        '[class*="material"]',
        '[class*="glyph"]',
        '[class*="symbol"]',
        '[class*="Symbol"]',
        '[aria-hidden="true"]',
        '[role="img"]',
        '[data-icon]',
        '[class*="bx"]',
        '[class*="boxicon"]',
        '[class*="woo-font"]'
    ].join(', ');

    // ===== 主處理函數 =====
    function processAll() {
        // 1. 先快速標記明顯的 icon（同步，減少閃爍）
        const iconCandidates = document.querySelectorAll(iconCandidateSelector);
        for (let i = 0; i < iconCandidates.length; i++) {
            processElement(iconCandidates[i]);
        }

        // 2. 再處理其他元素
        const els = document.querySelectorAll(TEXT_ELEMENT_SELECTOR);
        processInChunks(els);
    }

    // ===== 初始化 =====
    function init() {
        // 立即注入 CSS（最重要！）
        initStyles();

        // 等 DOM 準備好後掃描 icon（多重備案，防止 MV3 延遲注入漏掉事件）
        let domReady = false;
        function onDomReady() {
            if (domReady || !document.body) return;
            domReady = true;
            processAll();
            setupMutationObserver();
        }

        if (document.readyState !== 'loading') {
            onDomReady();
        } else {
            document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
            document.addEventListener('readystatechange', () => {
                if (document.readyState !== 'loading') onDomReady();
            });
        }
    }

    // ===== MutationObserver =====
    function setupMutationObserver() {
        if (!document.body) return;

        let queue = new Set();
        let scheduled = false;
        const BATCH_SIZE = 100;

        function flush() {
            const items = Array.from(queue);
            queue.clear();
            scheduled = false;

            // 分批處理：每幀最多處理 BATCH_SIZE 個元素，避免無限滾動頁面卡頓
            const batchEnd = Math.min(items.length, BATCH_SIZE);
            for (let i = 0; i < batchEnd; i++) {
                processElement(items[i]);
            }

            // 超出批次的元素放回 queue，排定下一幀繼續
            for (let i = batchEnd; i < items.length; i++) {
                queue.add(items[i]);
            }

            if (queue.size && !scheduled) {
                scheduled = true;
                requestAnimationFrame(flush);
            }
        }

        // 合併文字元素與 icon 候選選擇器，讓動態新增的 icon 也能被偵測
        const observerSelector = `${TEXT_ELEMENT_SELECTOR}, ${iconCandidateSelector}`;

        new MutationObserver(mutations => {
            for (let i = 0; i < mutations.length; i++) {
                const nodes = mutations[i].addedNodes;
                for (let j = 0; j < nodes.length; j++) {
                    const n = nodes[j];
                    if (n.nodeType !== 1) continue;
                    if (n.matches?.(observerSelector)) queue.add(n);
                    const children = n.querySelectorAll?.(observerSelector);
                    if (children) {
                        for (let k = 0; k < children.length; k++) queue.add(children[k]);
                    }
                }
            }
            if (queue.size && !scheduled) {
                scheduled = true;
                requestAnimationFrame(flush);
            }
        }).observe(document.body, { childList: true, subtree: true });
    }

    init();

})();
