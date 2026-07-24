// ==UserScript==
// @name         替換字體為 AppleGothic
// @namespace    https://chris.taipei
// @version      0.4.6
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
// Co-authored with ChatGPT 5.6 Sol Ultra
// 維護索引：README.md「維護索引」

(function () {
    'use strict';

    // ===== 目標字體（統一定義）=====
    const TARGET_FONT = 'AppleGothic, AppleGothicSC, "Malgun Gothic", "Apple Monochrome Emoji Ind", "SF Pro Icons", "SF Pro Text", sans-serif';
    const TEXT_ELEMENT_SELECTORS = ['p', 'span', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'label', 'article', 'blockquote', 'figcaption', 'cite', 'div'];
    const TEXT_ELEMENT_SELECTOR = TEXT_ELEMENT_SELECTORS.join(',');

    // Icon class 的 token 與 prefix 是唯一資料來源；CSS、候選掃描及 JS 判定皆由此產生。
    const ICON_CLASS_TOKENS = Object.freeze([
        'icon', 'iconfont', 'icomoon', 'fontawesome', 'material', 'glyph', 'symbol',
        'octicon', 'feather', 'ionicon', 'themify', 'alibaba', 'anticon', 'boxicon',
        'kt-player', 'global-iconfont', 'woo-font'
    ]);
    const ICON_CLASS_PREFIXES = Object.freeze([
        'fa-', 'fas-', 'far-', 'fal-', 'fad-', 'fab-', 'bi-', 'ri-', 'mdi-', 'mi-',
        'oi-', 'ti-', 'si-', 'gi-', 'ai-', 'di-', 'fi-', 'hi-', 'pi-', 'vi-', 'wi-',
        'ci-', 'bx-', 'bxs-', 'bxl-'
    ]);

    /**
     * 將字串轉成可安全放入 RegExp 的字面值。
     *
     * @param {string} value Icon token 或 prefix。
     * @returns {string} 已跳脫正規表示式特殊字元的字串；不會產生副作用。
     */
    function escapeRegExp(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * 建立 class 子字串 CSS selector，讓所有 Icon 規則共用相同資料來源。
     *
     * @param {string} value Icon token 或 prefix。
     * @returns {string} 不區分大小寫的 class 屬性 selector；不會修改 DOM。
     */
    function createIconClassSelector(value) {
        return `[class*="${value}" i]`;
    }

    const ICON_CLASS_SELECTORS = Object.freeze(
        [...ICON_CLASS_TOKENS, ...ICON_CLASS_PREFIXES].map(createIconClassSelector)
    );
    // 主規則與 scoped 規則共用相同排除條件，避免新增前綴時只有部分路徑更新。
    const ICON_CSS_EXCLUSION_SELECTORS = Object.freeze([...ICON_CLASS_SELECTORS, '[data-icon]']);
    const ICON_NOT_SELECTORS = ICON_CSS_EXCLUSION_SELECTORS
        .map(selector => `:not(${selector})`)
        .join('');
    const SCOPED_TEXT_SELECTOR = TEXT_ELEMENT_SELECTORS
        .map(selector => `[data-inline-font-scope] ${selector}:not([data-no-font]):not([data-no-font-parent])${ICON_NOT_SELECTORS}`)
        .join(',\n            ');
    const FORM_FONT_SELECTORS = [
        'select:not([data-no-font])',
        'option:not([data-no-font])',
        'input:not([type="checkbox"]):not([type="radio"]):not([data-no-font])',
        'textarea:not([data-no-font])',
        `button:not([data-no-font])${ICON_NOT_SELECTORS}`
    ];
    const FORM_FONT_SELECTOR = FORM_FONT_SELECTORS.join(',\n            ');
    const SCOPED_FORM_SELECTOR = FORM_FONT_SELECTORS
        .map(selector => `[data-inline-font-scope] ${selector}`)
        .join(',\n            ');

    // ===== 黑名單管理 =====
    const currentHost = location.hostname;
    const blacklist = GM_getValue('blacklist', []);
    const isEnabled = !blacklist.includes(currentHost);

    // 選單指令（只在主框架註冊，避免 iframe 導致多個 alert）
    if (window.self === window.top) {
        GM_registerMenuCommand(isEnabled ? '🚫 停用此網站' : '✅ 啟用此網站', () => {
            // callback 每次重新讀取，避免其他分頁或重複操作讓閉包內資料過期。
            const latestBlacklist = new Set(GM_getValue('blacklist', []));
            if (isEnabled) {
                latestBlacklist.add(currentHost);
                GM_setValue('blacklist', Array.from(latestBlacklist));
                alert(`已將 ${currentHost} 加入黑名單，重新整理後生效`);
            } else {
                latestBlacklist.delete(currentHost);
                GM_setValue('blacklist', Array.from(latestBlacklist));
                alert(`已將 ${currentHost} 從黑名單移除，重新整理後生效`);
            }
        });

        GM_registerMenuCommand('📋 查看黑名單', () => {
            const list = Array.from(new Set(GM_getValue('blacklist', [])));
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

    // ===== Canvas API 攔截（只在啟用網站執行）=====
    /**
     * 攔截 Canvas 文字繪製 API，在繪製前套用目標字體。
     *
     * @returns {void} 沒有 Canvas API 時直接返回；否則會覆寫原型的 fillText 與 strokeText。
     */
    (function interceptCanvasText() {
        if (typeof CanvasRenderingContext2D === 'undefined') return;

        // 解析 CSS font 字串，替換字體部分
        // font 格式: [font-style] [font-variant] [font-weight] font-size [/line-height] font-family
        // 例如: "12px Arial", "bold 14px sans-serif", "italic 12px/1.5 'Helvetica Neue'"
        const fontSizeRegex = /(\d+(?:\.\d+)?(?:px|pt|em|rem|%|vh|vw|ex|ch|vmin|vmax))/i;
        const lineHeightRegex = /^(\/[\d.]+(?:px|pt|em|rem|%)?)?/;
        const FONT_CACHE_LIMIT = 256;
        const fontCache = new Map();

        /**
         * 保留 Canvas font 的樣式、尺寸與行高，僅替換字體家族。
         *
         * @param {string} fontStr Canvas 目前的 font 字串。
         * @returns {string} 套用目標字體後的 font 字串；結果會寫入有限大小快取。
         */
        function replaceFont(fontStr) {
            const cacheKey = fontStr || '';
            const cached = fontCache.get(cacheKey);
            if (cached !== undefined) return cached;

            let replaced = fontStr || `12px ${TARGET_FONT}`;

            if (fontStr && !fontStr.includes('AppleGothic') && !fontStr.includes('AppleGothicSC')) {
                const sizeMatch = fontStr.match(fontSizeRegex);
                if (sizeMatch) {
                    const sizeIndex = fontStr.indexOf(sizeMatch[0]);
                    const sizeEnd = sizeIndex + sizeMatch[0].length;
                    const prefix = fontStr.substring(0, sizeEnd);
                    const afterSize = fontStr.substring(sizeEnd);
                    const lineHeightMatch = afterSize.match(lineHeightRegex);
                    const lineHeight = lineHeightMatch ? lineHeightMatch[0] : '';
                    replaced = prefix + lineHeight + ' ' + TARGET_FONT;
                }
            }

            if (fontCache.size >= FONT_CACHE_LIMIT) {
                fontCache.clear();
            }
            fontCache.set(cacheKey, replaced);
            return replaced;
        }

        /**
         * 將單一 Canvas context 的目前字體更新為替換結果。
         *
         * @param {CanvasRenderingContext2D} ctx 即將繪製文字的 Canvas context。
         * @returns {void} 字體不同時會修改 ctx.font。
         */
        function applyCanvasFont(ctx) {
            const currentFont = ctx.font;
            const replacedFont = replaceFont(currentFont);
            if (currentFont !== replacedFont) {
                ctx.font = replacedFont;
            }
        }

        const proto = CanvasRenderingContext2D.prototype;
        const originalFillText = proto.fillText;
        const originalStrokeText = proto.strokeText;

        proto.fillText = function (text, x, y, maxWidth) {
            applyCanvasFont(this);
            if (maxWidth !== undefined) {
                return originalFillText.call(this, text, x, y, maxWidth);
            }
            return originalFillText.call(this, text, x, y);
        };

        proto.strokeText = function (text, x, y, maxWidth) {
            applyCanvasFont(this);
            if (maxWidth !== undefined) {
                return originalStrokeText.call(this, text, x, y, maxWidth);
            }
            return originalStrokeText.call(this, text, x, y);
        };
    })();

    // ===== CSS 樣式（核心：用 CSS 強制套用字體）=====
    /**
     * 注入頁面字體、程式碼字體、Icon 排除與表單元素規則。
     *
     * @returns {void} 透過 GM_addStyle 寫入全域 CSS，不回傳樣式節點。
     */
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
            pre:has(code),
            kbd,
            samp,
            tt {
                font-family: "Cascadia Code", "Cascadia Mono", Consolas, "SF Mono", "JetBrains Mono", monospace, AppleGothic, AppleGothicSC !important;
            }

            /* 主規則：:where() 使特異性歸零（後宣告，同特異性時覆蓋程式碼區域的 :where() 子代選擇器） */
            /* 移除程式碼相關 :not()，靠宣告順序處理，減少 14 個 :not() 條件 */
            :where(html body *:not([data-no-font]):not([data-no-font-parent])${ICON_NOT_SELECTORS}:not([class*="checkbox"]):not([class*="radio"]):not(input):not(select):not(textarea):not(button)) {
                font-family: ${TARGET_FONT} !important;
            }

            /* 對帶 inline style 的容器，用作用域規則取代逐一覆寫整個子樹 */
            ${SCOPED_TEXT_SELECTOR} {
                font-family: ${TARGET_FONT} !important;
            }

            /* 表單元素額外強制（排除 checkbox/radio 及 icon 按鈕）*/
            ${FORM_FONT_SELECTOR},
            ${SCOPED_FORM_SELECTOR} {
                font-family: ${TARGET_FONT} !important;
            }
        `);
    }

    // ===== 常數與狀態 =====
    // 非英數邊界避免誤判（如 "lexicon" 不應匹配 "icon"）。
    const iconClassPattern = new RegExp(
        `(?:^|[^a-z0-9])(?:${ICON_CLASS_TOKENS.map(escapeRegExp).join('|')})(?:$|[^a-z0-9])`,
        'i'
    );
    // font-family 檢測用（不需要詞邊界）
    const iconFontPattern = /icon|iconfont|icomoon|fontawesome|material|glyph|symbol|boxicon|ktplayer/i;
    const iconPrefixPattern = new RegExp(`^(?:${ICON_CLASS_PREFIXES.map(escapeRegExp).join('|')})`, 'i');
    const checkboxRadioPattern = /checkbox|radio/i;
    // 排除自訂字體檢測時的白名單（我們自己定義的 @font-face）
    const ourFonts = new Set(['AppleGothic', 'AppleGothicSC']);
    let processed = new WeakSet();
    let iconChildrenByParent = new WeakMap();
    let iconParentByChild = new WeakMap();
    let iconDescendantsByContainer = new WeakMap();
    let iconContainerByDescendant = new WeakMap();
    let managedInlineFonts = new WeakMap();

    // ===== 狀態重置（供重新掃描使用）=====
    /**
     * 清除腳本產生的 DOM 標記、處理快取與網頁字體快取。
     *
     * @returns {void} 會修改既有元素屬性並重建 Icon 與處理快取；保留原始 inline 字體快照。
     */
    function resetState() {
        // 移除掃描過程中加入的標記，避免重新掃描時殘留舊狀態
        document.querySelectorAll('[data-no-font], [data-no-font-parent], [data-inline-font-scope]').forEach(el => {
            el.removeAttribute('data-no-font');
            el.removeAttribute('data-no-font-parent');
            el.removeAttribute('data-inline-font-scope');
        });
        processed = new WeakSet();
        iconChildrenByParent = new WeakMap();
        iconParentByChild = new WeakMap();
        iconDescendantsByContainer = new WeakMap();
        iconContainerByDescendant = new WeakMap();
        webFontCache = null;
    }

    /**
     * 清除現有標記後同步重掃全部文字元素，並向使用者顯示統計。
     *
     * @returns {void} 會修改頁面元素並顯示 alert；只由使用者選單觸發。
     */
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
    /**
     * 判斷元素文字是否含標準 Emoji，避免 aria-hidden 的 Emoji 被誤標成 Icon。
     *
     * @param {Element} el 要檢查文字內容的元素。
     * @returns {boolean} 含 U+1F300 至 U+1FAFF 時為 true；不會修改元素。
     */
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

    /**
     * 依共用 token 與 prefix 規則檢查元素 class。
     *
     * @param {Element} el 要判定的元素。
     * @returns {boolean} 任一 class 符合 Icon token 或 prefix 時為 true；不會修改 DOM。
     */
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

    /**
     * 檢查 aria-hidden、role 與 data-icon 等 Icon 語意屬性。
     *
     * @param {Element} el 要判定的元素。
     * @returns {boolean} 屬性表明元素為 Icon 時為 true；標準 Emoji 例外不會被誤判。
     */
    function hasIconAttribute(el) {
        if (el.getAttribute('aria-hidden') === 'true' && !containsStandardEmoji(el)) return true;
        if (el.getAttribute('role') === 'img') return true;
        if (el.hasAttribute('data-icon')) return true;
        return false;
    }

    /**
     * 判斷 Unicode code point 是否位於 BMP、SPUA-A 或 SPUA-B 私用區。
     *
     * @param {number} codePoint 要判定的 Unicode code point。
     * @returns {boolean} 位於任一有效私用區時為 true；不會產生副作用。
     */
    function isPrivateUseCodePoint(codePoint) {
        return (codePoint >= 0xE000 && codePoint <= 0xF8FF)
            || (codePoint >= 0xF0000 && codePoint <= 0xFFFFD)
            || (codePoint >= 0x100000 && codePoint <= 0x10FFFD);
    }

    /**
     * 檢查元素的直接文字節點是否使用 Icon 常見的 Unicode 私用區。
     *
     * @param {Element} el 要判定的元素。
     * @returns {boolean} 短文字的首個 code point 位於私用區時為 true；不會修改節點。
     */
    function hasPuaText(el) {
        const nodes = el.childNodes;
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            if (node.nodeType === 3) {
                const t = node.textContent.trim();
                if (t.length > 0 && Array.from(t).length <= 2) {
                    const codePoint = t.codePointAt(0);
                    if (isPrivateUseCodePoint(codePoint)) return true;
                }
            }
        }
        return false;
    }

    /**
     * 以計算後 font-family 判斷元素是否使用 Icon 字體。
     *
     * @param {Element} el 要判定的元素。
     * @returns {boolean} 使用已知 Icon 字體時為 true；樣式讀取失敗時安全回傳 false。
     */
    function hasIconFont(el) {
        try {
            const fontFam = getComputedStyle(el).fontFamily;
            if (fontFam.includes('SF Pro')) return false;
            if (iconFontPattern.test(fontFam)) return true;
        } catch {
            return false;
        }
        return false;
    }

    /**
     * 判斷 i 元素是否直接宣告 font-family，涵蓋 quark、slick 等 Icon 實作。
     *
     * @param {Element} el 要判定的元素。
     * @returns {boolean} i 元素具有 inline font-family 時為 true；不會修改樣式。
     */
    function hasInlineIconFont(el) {
        return el.tagName === 'I' && Boolean(el.style.fontFamily);
    }

    /**
     * 依成本由低至高執行完整 Icon 判定管線。
     *
     * @param {Element} el 要判定的元素。
     * @returns {boolean} 任一 class、屬性、PUA 或字體規則符合時為 true。
     */
    function isIconElement(el) {
        if (hasInlineIconFont(el)) return true;
        if (hasIconClass(el)) return true;
        if (hasIconAttribute(el)) return true;
        if (hasPuaText(el)) return true;
        // 快速路徑：文字內容超過 2 字元的元素幾乎不是 icon，跳過昂貴的 getComputedStyle
        const text = el.textContent;
        if (text && text.length > 2) return false;
        return hasIconFont(el);
    }

    /**
     * 判斷元素是否為不應覆寫字體的 checkbox／radio 控制。
     *
     * @param {Element} el 要判定的元素。
     * @returns {boolean} 原生類型或 class 表明為 checkbox／radio 時為 true。
     */
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

    /**
     * 收集頁面已載入的 @font-face 名稱並在本輪掃描中快取。
     *
     * @returns {Set<string>} 去除引號的字體名稱集合；首次呼叫會讀取 document.fonts。
     */
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

    /**
     * 判斷 font-family 首選字體是否為頁面自訂字體，並排除腳本自己的字體。
     *
     * @param {string} fontFamilyStr CSS font-family 字串。
     * @returns {boolean} 首選字體來自 document.fonts 且非本腳本字體時為 true。
     */
    function isCustomWebFont(fontFamilyStr) {
        const firstName = fontFamilyStr.split(',')[0].trim().replace(/['"]/g, '');
        if (ourFonts.has(firstName)) return false;
        return getWebFontNames().has(firstName);
    }

    // 處理結果常數（供 forceRescan 統計使用）
    const RESULT_ICON = 1;
    const RESULT_OVERRIDE = 2;

    /**
     * 判斷元素目前是否仍位於指定 Icon 容器內。
     *
     * @param {Element} el 要驗證的可能後代。
     * @param {Element} container 候選 Icon 容器。
     * @returns {boolean} 從 el 向上可到達 container 時為 true；只讀取 DOM。
     */
    function isDescendantOf(el, container) {
        let current = el.parentElement;
        while (current) {
            if (current === container) return true;
            current = current.parentElement;
        }
        return false;
    }

    /**
     * 尋找目前仍有效且應保護指定元素的最近 Icon 容器。
     *
     * @param {Element} el 要查找保護來源的元素。
     * @returns {Element | null} 仍連線、保有排除標記且包含 el 的 Icon 容器；找不到時為 null。
     */
    function findActiveIconContainer(el) {
        const recorded = iconContainerByDescendant.get(el);
        if (recorded
            && recorded.isConnected !== false
            && recorded.hasAttribute('data-no-font')
            && iconDescendantsByContainer.has(recorded)
            && isDescendantOf(el, recorded)) {
            return recorded;
        }

        let current = el.parentElement;
        while (current) {
            if (current.isConnected !== false
                && current.hasAttribute('data-no-font')
                && iconDescendantsByContainer.has(current)) {
                return current;
            }
            current = current.parentElement;
        }
        return null;
    }

    /**
     * 將元素登記為 Icon 容器後代並套用字體排除標記。
     *
     * @param {Element} descendant 需要繼承容器保護的後代元素。
     * @param {Element} container 已確認的 Icon 容器。
     * @returns {void} 會更新雙向關係、processed 快取與 data-no-font 屬性。
     */
    function protectIconDescendant(descendant, container) {
        // 排除標記無法覆蓋本腳本先前寫入的 inline !important，必須先還原原值。
        restoreManagedInlineFont(descendant);
        descendant.removeAttribute('data-inline-font-scope');

        const previousContainer = iconContainerByDescendant.get(descendant);
        if (previousContainer && previousContainer !== container) {
            iconDescendantsByContainer.get(previousContainer)?.delete(descendant);
        }

        let descendants = iconDescendantsByContainer.get(container);
        if (!descendants) {
            descendants = new Set();
            iconDescendantsByContainer.set(container, descendants);
        }
        descendants.add(descendant);
        iconContainerByDescendant.set(descendant, container);
        descendant.setAttribute('data-no-font', '');
        processed.add(descendant);
    }

    /**
     * 將 Icon 元素與其現有後代加上字體排除標記，並記錄父子關係供重新判定清理。
     *
     * @param {Element} el 已確認為 Icon 的元素。
     * @param {boolean} [includeDescendants=true] 是否立即標記既有後代；observer 路徑傳 false，改由逐幀佇列探索。
     * @returns {void} 會設定 data-no-font／data-no-font-parent 並更新處理快取。
     */
    function markIconElement(el, includeDescendants = true) {
        el.setAttribute('data-no-font', '');
        iconDescendantsByContainer.set(el, new Set());

        const parent = el.parentElement;
        if (parent && parent !== document.body) {
            let iconChildren = iconChildrenByParent.get(parent);
            if (!iconChildren) {
                iconChildren = new Set();
                iconChildrenByParent.set(parent, iconChildren);
            }
            iconChildren.add(el);
            iconParentByChild.set(el, parent);
            parent.setAttribute('data-no-font-parent', '');
        }

        // Icon 容器需排除現有後代，防止 scoped CSS 規則重新覆寫其 Icon 字體。
        if (includeDescendants && el.firstElementChild) {
            const descendants = Array.from(el.querySelectorAll('*'));
            for (let i = 0; i < descendants.length; i++) {
                protectIconDescendant(descendants[i], el);
            }
        }
    }

    /**
     * 還原單一元素由腳本管理的 inline font-family，以便重新進入判定管線。
     *
     * @param {Element} el 即將重新判定的元素。
     * @returns {void} 只在目前值仍是腳本目標字體時還原原值，避免覆蓋頁面後續修改。
     */
    function restoreManagedInlineFont(el) {
        const originalFont = managedInlineFonts.get(el);
        if (!originalFont) return;

        if (el.style.fontFamily === TARGET_FONT) {
            if (originalFont.value) {
                el.style.setProperty('font-family', originalFont.value, originalFont.priority);
            } else {
                el.style.removeProperty('font-family');
            }
        }
        managedInlineFonts.delete(el);
    }

    /**
     * 移除元素先前判定產生的標記與快取，讓動態屬性／文字可重新分類。
     *
     * @param {Element} el observer 判定需要重查的元素。
     * @returns {boolean} 元素原本擁有 Icon 後代時為 true；呼叫端須將後代排入逐幀重新判定。
     * 會清理元素與父元素狀態；後代標記刻意延後到佇列逐一拆除，避免單幀遍歷大型 Set。
     */
    function clearElementProcessingState(el) {
        // 先記住有效祖先；舊分類仍須完整拆除，最後才把元素掛回祖先保護。
        const activeIconContainer = findActiveIconContainer(el);
        processed.delete(el);
        restoreManagedInlineFont(el);
        el.removeAttribute('data-no-font');
        el.removeAttribute('data-inline-font-scope');

        const recordedContainer = iconContainerByDescendant.get(el);
        if (recordedContainer) {
            iconDescendantsByContainer.get(recordedContainer)?.delete(el);
            iconContainerByDescendant.delete(el);
        }

        // 元素可能已被搬移或移除，因此使用判定當時記錄的父元素清理舊標記。
        const parent = iconParentByChild.get(el);
        const iconChildren = parent ? iconChildrenByParent.get(parent) : null;
        if (iconChildren) {
            iconChildren.delete(el);
            if (iconChildren.size === 0) {
                parent.removeAttribute('data-no-font-parent');
                iconChildrenByParent.delete(parent);
            }
        }
        iconParentByChild.delete(el);

        const releasedIconDescendants = iconDescendantsByContainer.has(el);
        if (releasedIconDescendants) {
            // 反向關係與 DOM 標記由 observer traversal 逐節點清理；此處只釋放容器 ownership。
            iconDescendantsByContainer.delete(el);
        }

        if (activeIconContainer) {
            protectIconDescendant(el, activeIconContainer);
        }

        return releasedIconDescendants;
    }

    /**
     * 處理單一元素的 Icon 排除、表單略過、自訂字體保護與 inline 字體覆寫。
     *
     * @param {Element} el 要處理的頁面元素。
     * @param {boolean} [includeIconDescendants=true] Icon 命中時是否立即掃描後代；動態 observer 會關閉並逐幀處理。
     * @returns {number} RESULT_ICON、RESULT_OVERRIDE 或 0；會修改符合條件的元素與快取。
     */
    function processElement(el, includeIconDescendants = true) {
        if (el.isConnected === false) return 0;

        const activeIconContainer = findActiveIconContainer(el);
        if (activeIconContainer) {
            protectIconDescendant(el, activeIconContainer);
            return RESULT_ICON;
        }

        if (processed.has(el)) return 0;
        processed.add(el);

        // 1. 如果是 icon 元素，標記並跳過
        if (isIconElement(el)) {
            markIconElement(el, includeIconDescendants);
            return RESULT_ICON;
        }

        // 2. 如果是需要跳過的表單元素，跳過
        if (shouldSkipElement(el)) return 0;

        // 3. 如果有 inline style，用 inline !important 保住此元素的字體
        // 子元素則改用 CSS 作用域，避免每個 styled 容器都重掃整棵子樹
        // inline !important 能打贏所有 CSS !important 規則，確保 CMS 生成的內容也被覆蓋
        if (el.style.length > 0) {
            const originalFontFamily = el.style.fontFamily;
            // 若已有 font-family 且為自訂 @font-face（如淘寶反爬蟲字體），標記排除避免亂碼
            if (originalFontFamily && isCustomWebFont(originalFontFamily)) {
                el.setAttribute('data-no-font', '');
                return 0;
            }
            if (!managedInlineFonts.has(el)) {
                managedInlineFonts.set(el, {
                    value: originalFontFamily,
                    priority: el.style.getPropertyPriority('font-family')
                });
            }
            el.style.setProperty('font-family', TARGET_FONT, 'important');
            if (el.firstElementChild) {
                el.setAttribute('data-inline-font-scope', '');
            }
            return RESULT_OVERRIDE;
        }

        return 0;
    }

    // ===== 分批處理 =====
    const CHUNK_SIZE = 300;
    /** @type {number | null} 大型初始掃描尚未執行的 rAF，可在重掃或終局離頁時取消。 */
    let initialScanFrameId = null;

    /**
     * 依元素數量同步或分幀處理初始掃描結果，避免大型頁面形成 long task。
     *
     * @param {NodeListOf<Element> | Element[]} els 要處理的穩定元素集合。
     * @returns {void} 大型集合會排定 requestAnimationFrame，並逐一修改仍連線的元素。
     */
    function processInChunks(els) {
        // 新掃描會取代舊掃描，避免覆寫 frame id 後失去取消既有工作的能力。
        if (initialScanFrameId !== null) {
            cancelAnimationFrame(initialScanFrameId);
            initialScanFrameId = null;
        }

        const len = els.length;
        if (len === 0) return;

        if (len < 1000) {
            for (let i = 0; i < len; i++) processElement(els[i]);
            return;
        }

        let i = 0;
        /**
         * 執行一批初始元素，未完成時再排定下一幀。
         *
         * @returns {void} 會推進外層索引並可能建立下一個動畫幀。
         */
        function step() {
            initialScanFrameId = null;
            const end = Math.min(i + CHUNK_SIZE, len);
            while (i < end) processElement(els[i++]);
            if (i < len) initialScanFrameId = requestAnimationFrame(step);
        }
        initialScanFrameId = requestAnimationFrame(step);
    }

    // ===== Icon 候選選擇器（用於快速標記）=====
    const ICON_ATTRIBUTE_SELECTORS = Object.freeze([
        '[aria-hidden="true"]',
        '[role="img"]',
        '[data-icon]',
        'i[style*="font-family"]'
    ]);
    const iconCandidateSelector = [
        ...ICON_CLASS_SELECTORS,
        ...ICON_ATTRIBUTE_SELECTORS
    ].join(', ');

    // ===== 主處理函數 =====
    /**
     * 先同步處理明顯 Icon 候選，再分批掃描其餘文字元素。
     *
     * @returns {void} 會查詢目前文件並修改符合條件的 DOM 元素。
     */
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
    /**
     * 注入 CSS，並在 DOM 可用時啟動初始掃描與動態 observer。
     *
     * @returns {void} 會註冊 DOM 事件、掃描頁面及建立 MutationObserver。
     */
    function init() {
        // 立即注入 CSS（最重要！）
        initStyles();

        // 等 DOM 準備好後掃描 icon（多重備案，防止 MV3 延遲注入漏掉事件）
        let domReady = false;
        /**
         * 確保 DOM 初始化流程只執行一次，避免多個 readiness 事件重複建立 observer。
         *
         * @returns {void} body 可用時會掃描頁面並啟動 observer。
         */
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
    /**
     * 建立具有每幀上限的增量 DOM 探索與重新判定管線。
     *
     * @returns {void} 會觀察 body，並在終局 pagehide 中斷 observer、取消動畫幀及清空佇列。
     */
    function setupMutationObserver() {
        if (!document.body) return;

        const QUEUE_RECHECK = 1;
        const QUEUE_EXPLORE_CHILDREN = 2;
        const QUEUE_EXPLORE_SIBLINGS = 4;
        const QUEUE_RECHECK_SUBTREE = 8;
        const BATCH_SIZE = 100;
        /** @type {Map<Element, { flags: number, nextSibling: Element | null }>} */
        const queue = new Map();
        let frameId = null;
        let stopped = false;

        // 合併文字元素與 Icon 候選 selector，讓動態新增及變更後的 Icon 都能被偵測。
        const observerSelector = `${TEXT_ELEMENT_SELECTOR}, ${iconCandidateSelector}`;

        /**
         * 將元素與工作旗標合併進佇列，避免同一幀重複保留相同 DOM 參照。
         *
         * @param {Element} element 要排入的元素。
         * @param {number} flags 重新判定與／或探索後代的位元旗標。
         * @param {Element | null} [nextSibling=null] 入列時保存的下一個兄弟，避免 element 先被移除而截斷 traversal。
         * @returns {void} 只更新記憶體佇列，不會同步掃描後代或修改 DOM。
         */
        function queueElement(element, flags, nextSibling = null) {
            if (!element || element.nodeType !== 1 || stopped) return;

            const existing = queue.get(element);
            if (existing) {
                existing.flags |= flags;
                if (!existing.nextSibling && nextSibling) existing.nextSibling = nextSibling;
                return;
            }
            queue.set(element, { flags, nextSibling });
        }

        /**
         * 在尚未排程且佇列非空時建立唯一動畫幀。
         *
         * @returns {void} 可能呼叫 requestAnimationFrame 並更新 frameId。
         */
        function scheduleFlush() {
            if (stopped || frameId !== null || queue.size === 0) return;
            frameId = requestAnimationFrame(flush);
        }

        /**
         * 以固定上限處理佇列，並用直接 children 增量展開後代。
         *
         * @returns {void} 會重新判定元素、擴充佇列，未完成時排定下一幀。
         */
        function flush() {
            frameId = null;
            let handled = 0;

            while (handled < BATCH_SIZE && queue.size > 0) {
                const next = queue.entries().next().value;
                const element = next[0];
                const workItem = next[1];
                const flags = workItem.flags;
                const queuedNextSibling = workItem.nextSibling;
                queue.delete(element);
                handled++;

                let releasedIconDescendants = false;

                // 脫離文件的元素不再分類；若它曾是 Icon 容器，仍須逐幀清除後代狀態。
                if (element.isConnected === false) {
                    if (flags & QUEUE_RECHECK) {
                        releasedIconDescendants = clearElementProcessingState(element);
                    }
                    const recheckDetachedSubtree = releasedIconDescendants ||
                        Boolean(flags & QUEUE_RECHECK_SUBTREE);
                    if (recheckDetachedSubtree && element.firstElementChild) {
                        const firstChild = element.firstElementChild;
                        queueElement(
                            firstChild,
                            QUEUE_RECHECK | QUEUE_RECHECK_SUBTREE |
                                QUEUE_EXPLORE_CHILDREN | QUEUE_EXPLORE_SIBLINGS,
                            firstChild.nextElementSibling
                        );
                    }
                    if ((flags & QUEUE_EXPLORE_SIBLINGS) && queuedNextSibling) {
                        queueElement(
                            queuedNextSibling,
                            QUEUE_RECHECK | QUEUE_RECHECK_SUBTREE |
                                QUEUE_EXPLORE_CHILDREN | QUEUE_EXPLORE_SIBLINGS,
                            queuedNextSibling.nextElementSibling
                        );
                    }
                    continue;
                }

                if (flags & QUEUE_RECHECK) {
                    releasedIconDescendants = clearElementProcessingState(element);
                }
                const isProtectedDescendant = findActiveIconContainer(element) !== null;
                let processResult = 0;
                if (isProtectedDescendant || element.matches?.(observerSelector)) {
                    // 動態路徑只處理單一元素；Icon 後代由下方相同佇列逐層展開。
                    processResult = processElement(element, false);
                }

                // 每個工作只展開第一個子元素與下一個兄弟，探索成本也受 BATCH_SIZE 限制。
                const recheckDescendants = releasedIconDescendants ||
                    processResult === RESULT_ICON ||
                    Boolean(flags & QUEUE_RECHECK_SUBTREE);
                if (((flags & QUEUE_EXPLORE_CHILDREN) || recheckDescendants) && element.firstElementChild) {
                    const firstChild = element.firstElementChild;
                    queueElement(
                        firstChild,
                        QUEUE_EXPLORE_CHILDREN | QUEUE_EXPLORE_SIBLINGS |
                            (recheckDescendants ? QUEUE_RECHECK | QUEUE_RECHECK_SUBTREE : 0),
                        firstChild.nextElementSibling
                    );
                }
                if ((flags & QUEUE_EXPLORE_SIBLINGS) && queuedNextSibling) {
                    queueElement(
                        queuedNextSibling,
                        QUEUE_EXPLORE_CHILDREN | QUEUE_EXPLORE_SIBLINGS |
                            ((flags & QUEUE_RECHECK_SUBTREE) ? QUEUE_RECHECK | QUEUE_RECHECK_SUBTREE : 0),
                        queuedNextSibling.nextElementSibling
                    );
                }
            }

            scheduleFlush();
        }

        /**
         * 將新增的元素根節點或文字節點父元素排入對應工作。
         *
         * @param {Node} node MutationRecord 中的新增節點。
         * @returns {void} 元素會延後增量探索；文字節點只讓父元素重新判定。
         */
        function queueAddedNode(node) {
            if (node.nodeType === 1) {
                // 新增根不追蹤其兄弟；同批其他新增根會由 addedNodes 各自排入。
                const recheckFlag = processed.has(node) ? QUEUE_RECHECK : 0;
                queueElement(node, QUEUE_EXPLORE_CHILDREN | recheckFlag);
            } else if (node.nodeType === 3 && node.parentElement) {
                queueElement(node.parentElement, QUEUE_RECHECK);
            }
        }

        /**
         * 將 DOM mutation 轉換為有限佇列工作；callback 本身不掃描完整子樹。
         *
         * @param {MutationRecord[]} mutations 本批 DOM 變更紀錄。
         * @returns {void} 會更新佇列並至多建立一個動畫幀。
         */
        function handleMutations(mutations) {
            if (stopped) return;
            for (let i = 0; i < mutations.length; i++) {
                const mutation = mutations[i];

                if (mutation.type === 'attributes') {
                    // 忽略本腳本剛寫入的目標 font-family，避免 style observer 自我重入。
                    if (mutation.attributeName === 'style'
                        && managedInlineFonts.has(mutation.target)
                        && mutation.target.style.fontFamily === TARGET_FONT) {
                        continue;
                    }
                    queueElement(mutation.target, QUEUE_RECHECK);
                    continue;
                }

                if (mutation.type === 'characterData') {
                    queueElement(mutation.target.parentElement, QUEUE_RECHECK);
                    continue;
                }

                if (mutation.type === 'childList') {
                    // 新增或移除文字都可能改變父元素的 PUA／短文字判定。
                    const removedNodes = mutation.removedNodes || [];
                    const targetFlags = removedNodes.length > 0
                        ? QUEUE_RECHECK | QUEUE_RECHECK_SUBTREE | QUEUE_EXPLORE_CHILDREN
                        : QUEUE_RECHECK;
                    // 移除可能截斷已保存的兄弟鏈；從 target 逐幀重走 subtree，避免漏掉後方節點。
                    queueElement(mutation.target, targetFlags);
                    const nodes = mutation.addedNodes;
                    for (let j = 0; j < nodes.length; j++) {
                        queueAddedNode(nodes[j]);
                    }
                    for (let j = 0; j < removedNodes.length; j++) {
                        const removedNode = removedNodes[j];
                        if (removedNode.nodeType === 1 && processed.has(removedNode)) {
                            queueElement(removedNode, QUEUE_RECHECK);
                        }
                    }
                }
            }

            scheduleFlush();
        }

        const observer = new MutationObserver(handleMutations);
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'aria-hidden', 'role', 'data-icon', 'style'],
            characterData: true
        });

        /**
         * 完整釋放動態掃描生命週期資源，避免終局離開後保留 DOM 參照。
         *
         * @returns {void} 會中斷 observer、取消增量與初始掃描動畫幀、清空佇列並移除 pagehide 監聽器。
         */
        function cleanupObserver() {
            if (stopped) return;
            stopped = true;
            observer.disconnect();
            if (frameId !== null) {
                cancelAnimationFrame(frameId);
                frameId = null;
            }
            if (initialScanFrameId !== null) {
                cancelAnimationFrame(initialScanFrameId);
                initialScanFrameId = null;
            }
            queue.clear();
            window.removeEventListener('pagehide', handlePageHide);
        }

        /**
         * 只在頁面未進入 bfcache 的終局 pagehide 執行 observer 清理。
         *
         * @param {PageTransitionEvent} event pagehide 事件；persisted 為 true 表示頁面仍會續存。
         * @returns {void} bfcache 情境保留 observer／rAF／佇列，終局離開時呼叫 cleanupObserver。
         */
        function handlePageHide(event) {
            if (event.persisted === true) return;
            cleanupObserver();
        }

        window.addEventListener('pagehide', handlePageHide);
    }

    init();

})();
