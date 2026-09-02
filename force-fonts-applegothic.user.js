// ==UserScript==
// @name         替換字體為 AppleGothic
// @namespace    https://chris.taipei
// @version      0.4.13
// @description  使用 CSS 將一般頁面字體改為 AppleGothic，並保留常見 Icon Font 與程式碼字體
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

    const TARGET_FONT = 'AppleGothic, AppleGothicSC, "Malgun Gothic", "Apple Monochrome Emoji Ind", "SF Pro Icons", "SF Pro Text", sans-serif';
    const CODE_FONT = '"Cascadia Code", "Cascadia Mono", Consolas, "SF Mono", "JetBrains Mono", AppleGothic, AppleGothicSC, monospace';

    // 完整 class token 僅涵蓋具有明確 Icon 語意的常見名稱，避免把 iconic 等一般文字 class 誤排除。
    const ICON_CLASS_TOKENS = Object.freeze([
        'icon', 'ficon', 'iconfont', 'icomoon', 'fontawesome', 'material-icons', 'material-icons-extended',
        'google-material-icons', 'google-symbols',
        'material-symbols-outlined', 'material-symbols-rounded', 'material-symbols-sharp',
        'octicon', 'feather', 'ionicon', 'themify', 'anticon', 'boxicon',
        'global-iconfont', 'woo-font', 'x-tool', 'x-tool-tool-el', 'x-tool-img'
    ]);
    const ICON_CLASS_PREFIXES = Object.freeze([
        'fa-', 'fas-', 'far-', 'fal-', 'fad-', 'fab-', 'bi-', 'ri-', 'mdi-', 'mi-',
        'oi-', 'ti-', 'si-', 'gi-', 'ai-', 'di-', 'fi-', 'hi-', 'pi-', 'vi-', 'wi-',
        'ci-', 'bx-', 'bxs-', 'bxl-'
    ]);

    // 天貓以自訂字型把隨機漢字碼位映射為價格數字；必須保留其原始 font-family 才能正確解碼。
    const PRESERVED_FONT_CLASS_TOKENS = Object.freeze(['c-price']);

    /**
     * 將需保留頁面原始字型的完整 class token 轉為不分大小寫的 CSS selector。
     *
     * @param {string} token 要排除全域字型覆寫的完整 class token。
     * @returns {string} 使用 `~=` 比對單一 class token 的 selector；不會產生副作用。
     */
    function createClassTokenSelector(token) {
        return `[class~="${token}" i]`;
    }

    /**
     * 將 Icon class prefix 轉為首個與後續 class token 的兩個 CSS selector。
     *
     * @param {string} prefix 要排除的 class token 前綴。
     * @returns {string[]} 分別涵蓋 class 屬性開頭與空白後 token 的 selector；不會產生副作用。
     */
    function createClassPrefixSelectors(prefix) {
        return [`[class^="${prefix}" i]`, `[class*=" ${prefix}" i]`];
    }

    const ICON_SELECTORS = Object.freeze([
        '[data-icon]',
        'i[style*="font-family" i]',
        '[style*="Anthropicons-Variable" i]',
        '[class^="icon-" i]',
        '[class*=" icon-" i]',
        '[class$="-icon" i]',
        '[class*="-icon " i]',
        '[class*="-icon-" i]',
        ...ICON_CLASS_TOKENS.map(createClassTokenSelector),
        ...ICON_CLASS_PREFIXES.flatMap(createClassPrefixSelectors)
    ]);
    const PRESERVED_FONT_SELECTORS = Object.freeze([
        ...ICON_SELECTORS,
        ...PRESERVED_FONT_CLASS_TOKENS.map(createClassTokenSelector)
    ]);
    const PRESERVED_FONT_NOT_SELECTOR = `:not(${PRESERVED_FONT_SELECTORS.join(', ')})`;
    const NATIVE_CONTROL_NOT_SELECTOR = ':not(input[type="checkbox"]):not(input[type="radio"])';
    const TEXT_SELECTOR = `:where(html body *${PRESERVED_FONT_NOT_SELECTOR}${NATIVE_CONTROL_NOT_SELECTOR})`;

    /**
     * 建立一般文字、程式碼及需保留頁面原始字型的排除規則。
     *
     * @returns {string} 可直接交給 GM_addStyle 的完整 CSS；不讀取或修改 DOM。
     */
    function buildStyles() {
        return `
            @font-face { font-family: 'AppleGothic'; src: local('AppleGothic'); }
            @font-face { font-family: 'AppleGothicSC'; src: local('AppleGothicSC'); }
            /* AppleGothic 的 cmap 可能宣告卻缺少韓文字形，以相同 family 的 unicode-range 修正回退。 */
            @font-face {
                font-family: 'AppleGothic';
                src: local('Malgun Gothic');
                unicode-range: U+1100-11FF, U+3130-318F, U+A960-A97F, U+AC00-D7AF, U+D7B0-D7FF;
            }

            html,
            body,
            ${TEXT_SELECTOR} {
                font-family: ${TARGET_FONT} !important;
            }


            /* 放在一般規則之後，確保程式碼英數仍優先使用等寬字體。 */
            /* GitHub 只使用程式碼語意 class；不得用會命中首頁版面 utility 的 class 子字串。 */
            #read-only-cursor-text-area,
            :where(.react-code-lines *),
            :where(.blob-code *),
            :where(pre *),
            :where(code *),
            .react-code-lines,
            .react-code-text,
            .react-file-line,
            .react-line-number,
            .blob-code,
            .blob-num,
            .highlight pre,
            .highlight code,
            code,
            pre:has(code),
            kbd,
            samp,
            tt {
                font-family: ${CODE_FONT} !important;
            }
        `;
    }

    /**
     * 註冊目前網站切換、查看及清空黑名單選單。
     *
     * @param {string} currentHost 目前頁面的 hostname。
     * @param {boolean} isEnabled 目前網站是否啟用字體替換。
     * @returns {void} 會註冊三個 Tampermonkey 選單；callback 可能更新儲存值並顯示提示。
     */
    function registerMenuCommands(currentHost, isEnabled) {
        GM_registerMenuCommand(isEnabled ? '停用此網站' : '啟用此網站', () => {
            // 執行時重新讀取，避免其他分頁更新後沿用過期快照。
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

        GM_registerMenuCommand('查看黑名單', () => {
            const list = Array.from(new Set(GM_getValue('blacklist', [])));
            alert(list.length ? `黑名單：\n${list.join('\n')}` : '黑名單是空的');
        });

        GM_registerMenuCommand('清空黑名單', () => {
            if (!confirm('確定要清空黑名單嗎？')) return;
            GM_setValue('blacklist', []);
            alert('黑名單已清空，重新整理後生效');
        });
    }

    /**
     * 依目前 hostname 初始化選單與 CSS 字體規則。
     *
     * @returns {void} 主框架會註冊選單；未列入黑名單的所有框架會注入一份 CSS。
     */
    function init() {
        const currentHost = location.hostname;
        const blacklist = new Set(GM_getValue('blacklist', []));
        const isEnabled = !blacklist.has(currentHost);

        if (window.self === window.top) {
            registerMenuCommands(currentHost, isEnabled);
        }
        if (isEnabled) {
            GM_addStyle(buildStyles());
        }
    }

    init();
})();
