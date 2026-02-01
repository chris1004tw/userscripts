// ==UserScript==
// @name         替換字體為 AppleGothic
// @namespace    https://chris.taipei
// @version      0.1
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
// Co-authored with Claude Opus 4.5

(function () {
    'use strict';

    // ===== 目標字體（統一定義）=====
    const TARGET_FONT = 'AppleGothic, AppleGothicSC, "Apple Monochrome Emoji Ind", "SF Pro Icons", "SF Pro Text", sans-serif';

    // ===== Canvas API 攔截（必須最早執行）=====
    // Canvas 文字是用 JS 繪製的，CSS 無法控制，需要攔截 API
    (function interceptCanvasText() {
        // 解析 CSS font 字串，替換字體部分
        // font 格式: [font-style] [font-variant] [font-weight] font-size [/line-height] font-family
        // 例如: "12px Arial", "bold 14px sans-serif", "italic 12px/1.5 'Helvetica Neue'"
        function replaceFont(fontStr) {
            if (!fontStr) return `12px ${TARGET_FONT}`;

            // 找到 font-size 的位置（數字+單位）
            const sizeMatch = fontStr.match(/(\d+(?:\.\d+)?(?:px|pt|em|rem|%|vh|vw|ex|ch|vmin|vmax))/i);
            if (!sizeMatch) return fontStr; // 無法解析，返回原值

            const sizeIndex = fontStr.indexOf(sizeMatch[0]);
            const sizeEnd = sizeIndex + sizeMatch[0].length;

            // size 之前的部分（style, variant, weight）
            const prefix = fontStr.substring(0, sizeEnd);

            // 檢查是否有 line-height（/後面的數字）
            const afterSize = fontStr.substring(sizeEnd);
            const lineHeightMatch = afterSize.match(/^(\/[\d.]+(?:px|pt|em|rem|%)?)?/);
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

            /* 通配符強制套用所有元素（排除表單元素，由下方規則單獨處理）*/
            /* data-no-font-parent: icon 元素的父元素，避免子元素繼承 AppleGothic */
            /* 字體 stack 包含 Apple emoji/icon 字體作為 fallback，確保 SF Symbols 可顯示 */
            html body *:not([data-no-font]):not([data-no-font-parent]):not([class*="icon"]):not([class*="Icon"]):not([class*="fa-"]):not([class*="material"]):not([class*="glyph"]):not([class*="symbol"]):not([class*="Symbol"]):not([data-icon]):not([class*="bx"]):not([class*="boxicon"]):not([class*="checkbox"]):not([class*="radio"]):not(input):not(select):not(textarea):not(button) {
                font-family: AppleGothic, AppleGothicSC, "Apple Monochrome Emoji Ind", "SF Pro Icons", "SF Pro Text", sans-serif !important;
            }

            /* 表單元素額外強制（排除 checkbox/radio，因為它們常用 icon 字體顯示勾選狀態）*/
            select, option, input:not([type="checkbox"]):not([type="radio"]), textarea, button {
                font-family: AppleGothic, AppleGothicSC, "Apple Monochrome Emoji Ind", "SF Pro Icons", "SF Pro Text", sans-serif !important;
            }
        `);
    }

    // ===== 常數與狀態 =====
    // 詞邊界 \b 避免誤判（如 "lexicon" 不應匹配 "icon"）
    const iconClassPattern = /\b(icon|iconfont|icomoon|fontawesome|material|glyph|symbol|octicon|feather|ionicon|themify|alibaba|anticon|boxicon)\b|global-iconfont/i;
    // font-family 檢測用（不需要詞邊界）
    const iconFontPattern = /icon|iconfont|icomoon|fontawesome|material|glyph|symbol|boxicon/i;
    const iconPrefixPattern = /^(fa|fas|far|fal|fad|fab|bi|ri|mdi|mi|oi|ti|si|gi|ai|di|fi|hi|pi|vi|wi|ci|bx|bxs|bxl)-/;
    const checkboxRadioPattern = /checkbox|radio/i;
    const selector = 'p,span,a,h1,h2,h3,h4,h5,h6,li,td,th,label,article,blockquote,figcaption,cite,div';
    let processed = new WeakSet();

    // ===== 狀態重置（供重新掃描使用）=====
    function resetState() {
        // 移除所有 data-no-font 和 data-no-font-parent 屬性
        document.querySelectorAll('[data-no-font]').forEach(el => el.removeAttribute('data-no-font'));
        document.querySelectorAll('[data-no-font-parent]').forEach(el => el.removeAttribute('data-no-font-parent'));
        processed = new WeakSet();
    }

    function forceRescan() {
        resetState();
        const els = document.querySelectorAll(selector);
        let stats = { total: els.length, iconMarked: 0, inlineOverride: 0 };
        for (let i = 0; i < els.length; i++) {
            const el = els[i];
            if (isIconElement(el)) {
                el.setAttribute('data-no-font', '');
                // 標記父元素，打破 CSS 繼承鏈
                if (el.parentElement && el.parentElement !== document.body) {
                    el.parentElement.setAttribute('data-no-font-parent', '');
                }
                stats.iconMarked++;
            } else if (!shouldSkipElement(el) && el.style.fontFamily) {
                el.style.setProperty('font-family', TARGET_FONT, 'important');
                stats.inlineOverride++;
            }
        }
        alert('[強制字體] 掃描完成:\n' +
            '總元素: ' + stats.total + '\n' +
            '標記為 icon: ' + stats.iconMarked + '\n' +
            'Inline style 覆蓋: ' + stats.inlineOverride + '\n' +
            '套用字體: ' + (stats.total - stats.iconMarked));
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
    function isIconElement(el) {
        // 1. 檢查 class（用詞邊界避免誤判）
        const cls = el.className;
        if (cls && typeof cls === 'string') {
            if (iconClassPattern.test(cls)) return true;
        }

        // 2. 檢查 icon prefix class（fa-, mdi-, bi- 等）
        const classList = el.classList;
        if (classList) {
            for (let i = 0; i < classList.length; i++) {
                if (iconPrefixPattern.test(classList[i])) return true;
            }
        }

        // 3. 檢查屬性（快速檢查）
        // aria-hidden="true" 需要排除標準 emoji（U+1F000+），因為 emoji 選擇器也用這個屬性
        if (el.getAttribute('aria-hidden') === 'true') {
            if (!containsStandardEmoji(el)) return true;
        }
        if (el.getAttribute('role') === 'img') return true;
        if (el.hasAttribute('data-icon')) return true;

        // 4. 檢查 Unicode icon 文字（PUA 區域）
        const nodes = el.childNodes;
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            if (node.nodeType === 3) {
                const t = node.textContent.trim();
                if (t.length > 0 && t.length <= 2) {
                    const code = t.charCodeAt(0);
                    // 只檢測 PUA 區塊，不再檢測 U+2600-U+27BF（常用符號如 ★☆♥）
                    if (code >= 0xE000 && code <= 0xF8FF) {
                        return true;
                    }
                }
            }
        }

        // 5. 檢查 font-family（最昂貴的操作，放最後）
        try {
            const fontFam = getComputedStyle(el).fontFamily;
            // 排除 Apple 系統字體（SF Pro Icons 包含 "icon" 會誤判）
            if (fontFam.includes('SF Pro')) return false;
            if (iconFontPattern.test(fontFam)) return true;
        } catch (e) {
            // 元素可能已從 DOM 移除或不可見，忽略錯誤
        }

        return false;
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

    function processElement(el) {
        if (processed.has(el)) return;
        processed.add(el);

        // 1. 如果是 icon 元素，標記並跳過
        if (isIconElement(el)) {
            el.setAttribute('data-no-font', '');
            // 標記父元素，打破 CSS 繼承鏈
            if (el.parentElement && el.parentElement !== document.body) {
                el.parentElement.setAttribute('data-no-font-parent', '');
            }
            return;
        }

        // 2. 如果是需要跳過的表單元素，跳過
        if (shouldSkipElement(el)) return;

        // 3. 如果有 inline style 設定 font-family，用 JS 覆蓋
        if (el.style.fontFamily) {
            el.style.setProperty('font-family', TARGET_FONT, 'important');
        }
    }

    // ===== 分批處理 =====
    const CHUNK_SIZE = 300;

    function processInChunks(els, callback) {
        const len = els.length;
        if (len === 0) {
            if (callback) callback();
            return;
        }

        if (len < 1000) {
            for (let i = 0; i < len; i++) processElement(els[i]);
            if (callback) callback();
            return;
        }

        let i = 0;
        function step() {
            const end = Math.min(i + CHUNK_SIZE, len);
            while (i < end) processElement(els[i++]);
            if (i < len) {
                requestAnimationFrame(step);
            } else if (callback) {
                callback();
            }
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
        '[class*="boxicon"]'
    ].join(', ');

    // ===== 主處理函數 =====
    function processAll() {
        // 1. 先快速標記明顯的 icon（同步，減少閃爍）
        const iconCandidates = document.querySelectorAll(iconCandidateSelector);
        for (let i = 0; i < iconCandidates.length; i++) {
            processElement(iconCandidates[i]);
        }

        // 2. 再處理其他元素
        const els = document.querySelectorAll(selector);
        processInChunks(els);
    }

    // ===== 初始化 =====
    function init() {
        // 立即注入 CSS（最重要！）
        initStyles();

        // 等 DOM 準備好後掃描 icon
        if (document.body) {
            processAll();
            setupMutationObserver();
        } else {
            document.addEventListener('DOMContentLoaded', () => {
                processAll();
                setupMutationObserver();
            });
        }
    }

    // ===== MutationObserver =====
    function setupMutationObserver() {
        if (!document.body) return;

        let queue = new Set();
        let scheduled = false;

        function flush() {
            const q = Array.from(queue);
            queue.clear();
            scheduled = false;
            processInChunks(q);
        }

        new MutationObserver(mutations => {
            for (let i = 0; i < mutations.length; i++) {
                const nodes = mutations[i].addedNodes;
                for (let j = 0; j < nodes.length; j++) {
                    const n = nodes[j];
                    if (n.nodeType !== 1) continue;
                    if (n.matches?.(selector)) queue.add(n);
                    const children = n.querySelectorAll?.(selector);
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
