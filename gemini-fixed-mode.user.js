// ==UserScript==
// @name         Gemini 固定使用模型
// @namespace    https://chris.taipei
// @version      0.4.5
// @description  固定 Gemini 的 Flash-Lite、Flash 或 Pro 模型，並獨立控制延伸思考開關
// @author       chris1004tw
// @match        https://gemini.google.com/*
// @noframes
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @updateURL    https://github.com/chris1004tw/userscripts/raw/main/gemini-fixed-mode.user.js
// @downloadURL  https://github.com/chris1004tw/userscripts/raw/main/gemini-fixed-mode.user.js
// ==/UserScript==
// Co-authored with Claude Opus 4.6 Thinking
// 維護索引：README.md「維護索引」

(function() {
    'use strict';
    // Gemini 會建立同源 `/_/bscframe`；runtime 防線避免舊版管理器忽略 @noframes 時重複註冊選單。
    if (window.self !== window.top) return;

    /**
     * Gemini 可選模式的資料形狀。
     *
     * @typedef {Object} GeminiMode
     * @property {string} key 寫入設定的穩定模式識別碼。
     * @property {string} name Tampermonkey 選單顯示的模式名稱。
     * @property {string} icon Tampermonkey 選單顯示的模式圖示。
     * @property {string[]} labels Gemini 按鈕與選單可能顯示的語意標籤，不含版本前綴。
     */

    const SWITCH_BUTTON_SELECTOR = 'button.input-area-switch';
    const MODE_OPTION_SELECTOR = 'gem-menu-item[role="menuitem"]';

    /** @type {GeminiMode[]} 支援的固定模型與對應介面語意標籤。 */
    const MODES = [
        { key: 'flash-lite', name: 'Flash-Lite', icon: '⚡', labels: ['Flash-Lite'] },
        { key: 'flash', name: 'Flash', icon: '🚀', labels: ['Flash'] },
        { key: 'pro', name: 'Pro', icon: '⭐', labels: ['Pro'] }
    ];
    const THINKING_LABELS = ['延伸思考', 'Extended thinking', 'Thinking'];

    const DEFAULT_MODE = 'pro';
    const AUTO_RETRY_DELAY = 500;
    const MAX_AUTO_SWITCH_ATTEMPTS = 3;
    let modelMenuId = null;
    let thinkingMenuId = null;

    /**
     * 等待查找函式回傳元素，並以 timeout 保證 Promise 最終完成。
     *
     * @param {() => Element | null} findMatch 每次 DOM 變動後查找目標的函式。
     * @param {number} timeout 最長等待毫秒數。
     * @returns {Promise<Element|null>} 找到時回傳元素，逾時回傳 null；等待期間會建立並對稱清理 observer 與 timer。
     */
    function waitForMatch(findMatch, timeout) {
        return new Promise((resolve) => {
            const existing = findMatch();
            if (existing) { resolve(existing); return; }

            let timeoutId = null;
            const observer = new MutationObserver(() => {
                const element = findMatch();
                if (!element) return;
                if (timeoutId !== null) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
                observer.disconnect();
                resolve(element);
            });
            observer.observe(document.body, { childList: true, subtree: true });

            timeoutId = setTimeout(() => {
                timeoutId = null;
                observer.disconnect();
                resolve(null);
            }, timeout);
        });
    }

    /**
     * 等待指定 selector 的第一個元素出現。
     *
     * @param {string} selector 要查找的 CSS 選擇器。
     * @param {number} [timeout=3000] 最長等待毫秒數。
     * @returns {Promise<Element|null>} 找到時回傳元素，逾時回傳 null。
     */
    function waitForElement(selector, timeout = 3000) {
        return waitForMatch(() => document.querySelector(selector), timeout);
    }

    /**
     * 正規化 Gemini 模式標籤，移除 `3.5` 等會隨部署變動的版本前綴。
     *
     * @param {string | null | undefined} label 按鈕或選單顯示文字。
     * @returns {string} 去除版本前綴、空白並轉小寫的穩定比較值。
     */
    function normalizeModeLabel(label) {
        return (label || '').trim().replace(/^\d+(?:\.\d+)*\s+/, '').toLowerCase();
    }

    /**
     * 判斷介面標籤是否代表指定模式。
     *
     * @param {string | null | undefined} label Gemini 顯示的模式文字。
     * @param {GeminiMode} mode 目標模式。
     * @returns {boolean} 去除版本前綴後符合任一語系標籤時為 true。
     */
    function matchesModeLabel(label, mode) {
        const normalized = normalizeModeLabel(label);
        return mode.labels.some(candidate => normalizeModeLabel(candidate) === normalized);
    }

    /**
     * 從新版 Gemini mode picker 依語意標籤找出 menuitem。
     *
     * @param {string[]} labels 不含版本前綴的候選標籤。
     * @returns {Element | null} 標籤符合的 menuitem；尚未渲染時回傳 null。
     */
    function findMenuOption(labels) {
        for (const option of document.querySelectorAll(MODE_OPTION_SELECTOR)) {
            const label = option.querySelector('.label')?.textContent;
            const normalized = normalizeModeLabel(label);
            if (labels.some(candidate => normalizeModeLabel(candidate) === normalized)) return option;
        }
        return null;
    }

    /**
     * 從新版 Gemini mode picker 找出指定固定模型。
     *
     * @param {GeminiMode} mode 目標模型。
     * @returns {Element | null} 標籤符合的模型 menuitem；尚未渲染時回傳 null。
     */
    function findModeOption(mode) {
        return findMenuOption(mode.labels);
    }

    /**
     * 等待新版 Gemini mode picker 渲染指定固定模型。
     *
     * @param {GeminiMode} mode 目標模型。
     * @param {number} [timeout=1000] 最長等待毫秒數。
     * @returns {Promise<Element|null>} 找到對應模型 menuitem 時回傳，逾時回傳 null。
     */
    function waitForModeOption(mode, timeout = 1000) {
        return waitForMatch(() => findModeOption(mode), timeout);
    }

    /**
     * 等待新版 Gemini mode picker 渲染獨立的延伸思考勾選項目。
     *
     * @param {number} [timeout=1000] 最長等待毫秒數。
     * @returns {Promise<Element|null>} 找到延伸思考 menuitem 時回傳，逾時回傳 null。
     */
    function waitForThinkingOption(timeout = 1000) {
        return waitForMatch(() => findMenuOption(THINKING_LABELS), timeout);
    }

    /**
     * 判斷延伸思考 menuitem 目前是否已勾選。
     *
     * @param {Element} option 延伸思考 menuitem。
     * @returns {boolean} 任一原生選取狀態或勾選圖示存在時為 true。
     */
    function isMenuOptionActive(option) {
        if (option.getAttribute?.('data-active') === 'true' ||
            option.getAttribute?.('aria-checked') === 'true') return true;
        if (option.classList?.contains('selected') || option.classList?.contains('active')) return true;
        return option.querySelector('[fonticon="check"], [data-mat-icon-name="check"]') !== null;
    }

    /**
     * 判斷新增元素本身或 subtree 是否含可恢復自動切換的新版介面目標。
     *
     * @param {Element} element MutationObserver 回報的新增元素。
     * @returns {boolean} 含切換按鈕或模式選單項目時為 true。
     */
    function containsAutoSwitchTarget(element) {
        if (typeof element.matches === 'function' &&
            (element.matches(SWITCH_BUTTON_SELECTOR) || element.matches(MODE_OPTION_SELECTOR))) {
            return true;
        }
        return typeof element.querySelector === 'function' &&
            (element.querySelector(SWITCH_BUTTON_SELECTOR) !== null ||
                element.querySelector(MODE_OPTION_SELECTOR) !== null);
    }

    /**
     * 讀取使用者保存的模式識別碼，並一次遷移舊版 Fast 設定。
     *
     * @returns {string} 保存的模式 key；舊 Fast 會遷移至最快的 Flash-Lite，未設定時為 Pro。
     * @sideeffect 讀取 GM 儲存空間；遇到舊 Fast key 時寫回新的 Flash-Lite key。
     */
    function getSavedModeKey() {
        const savedMode = GM_getValue('selectedMode', DEFAULT_MODE);
        if (savedMode !== 'fast') return savedMode;
        setSelectedMode('flash-lite');
        return 'flash-lite';
    }

    /**
     * 保存成功切換的模式識別碼。
     *
     * @param {string} mode 要保存的模式 key。
     * @returns {void} 無回傳值；副作用是寫入 GM 儲存空間。
     */
    function setSelectedMode(mode) {
        GM_setValue('selectedMode', mode);
    }

    /**
     * 讀取獨立保存的延伸思考設定。
     *
     * @returns {boolean} 使用者是否要求啟用延伸思考。副作用是讀取 GM 儲存空間。
     */
    function getSavedExtendedThinking() {
        return GM_getValue('extendedThinking', false) === true;
    }

    /**
     * 保存延伸思考開關。
     *
     * @param {boolean} enabled 是否啟用延伸思考。
     * @returns {void} 無回傳值；副作用是寫入 GM 儲存空間。
     */
    function setSavedExtendedThinking(enabled) {
        GM_setValue('extendedThinking', enabled);
    }

    /**
     * 依固定順序取得下一個可選模式。
     *
     * @param {string} currentKey 目前模式 key。
     * @returns {GeminiMode} 下一個模式；目前 key 無效時安全回傳 Pro。此函式不產生副作用。
     */
    function getNextMode(currentKey) {
        const currentIndex = MODES.findIndex(m => m.key === currentKey);
        const nextIndex = (currentIndex + 1) % MODES.length;
        return MODES[nextIndex];
    }

    /**
     * 將保存的 key 解析為完整模式資料。
     *
     * @returns {GeminiMode} 有效的保存模式；無效值安全回退 Pro。副作用是讀取 GM 儲存空間。
     */
    function getCurrentMode() {
        const key = getSavedModeKey();
        return MODES.find(m => m.key === key) ||
            MODES.find(m => m.key === DEFAULT_MODE) ||
            MODES[0];
    }

    /**
     * 依修改前已驗證的 ID 模式原地更新固定模型選單文字。
     *
     * @param {GeminiMode} [mode=getCurrentMode()] 要顯示的模型資料。
     * @returns {void} 無回傳值；已註冊時以首次回傳 ID 更新同一列。
     */
    function updateMainMenuLabel(mode = getCurrentMode()) {
        if (modelMenuId == null) return;
        GM_registerMenuCommand(
            `🔄 固定模型（${mode.icon} ${mode.name}）`,
            cycleMode,
            { id: modelMenuId }
        );
    }

    /**
     * 依修改前已驗證的 ID 模式原地更新延伸思考選單文字。
     *
     * @param {boolean} [enabled=getSavedExtendedThinking()] 目前保存的思考設定。
     * @returns {void} 無回傳值；已註冊時以首次回傳 ID 更新同一列。
     */
    function updateThinkingMenuLabel(enabled = getSavedExtendedThinking()) {
        if (thinkingMenuId == null) return;
        const state = enabled ? '開啟' : '關閉';
        GM_registerMenuCommand(
            `🧠 延伸思考（${state}）`,
            toggleExtendedThinking,
            { id: thinkingMenuId }
        );
    }

    /**
     * 切換延伸思考設定，只有介面同步成功時才保存並更新選單。
     *
     * @returns {Promise<void>} 操作完成後結束；可能開啟 mode picker、點擊勾選項及寫入設定。
     */
    async function toggleExtendedThinking() {
        const desired = !getSavedExtendedThinking();
        const success = await syncExtendedThinking(desired, true);
        if (!success) return;
        setSavedExtendedThinking(desired);
        updateThinkingMenuLabel(desired);
    }

    /**
     * 等待並點擊指定 Gemini 模式選項。
     *
     * @param {GeminiMode} mode 要選取的模式資料。
     * @returns {Promise<boolean>} 點擊並保存成功時為 true；找不到選項時為 false。副作用包含 DOM 點擊、設定寫入與主控台紀錄。
     */
    async function selectModeOption(mode) {
        const option = await waitForModeOption(mode);
        if (option) {
            option.click();
            setSelectedMode(mode.key);
            console.log(`[Gemini] 已切換至 ${mode.name} 模型`);
            return true;
        }
        // 找不到選項時關閉選單
        document.body?.click();
        console.log(`[Gemini] 找不到 ${mode.name} 選項`);
        return false;
    }

    /**
     * 建立隱藏 mode picker 動畫的暫時樣式。
     *
     * @param {boolean} silent 是否需要隱藏介面動畫。
     * @returns {HTMLElement | null} 已加入頁面的 style；非靜默模式回傳 null。
     */
    function createSilentPickerStyle(silent) {
        if (!silent) return null;
        document.getElementById('gemini-silent-switch')?.remove();
        const style = document.createElement('style');
        style.id = 'gemini-silent-switch';
        style.textContent = `
            .cdk-overlay-container { visibility: hidden !important; }
            .mat-mdc-menu-panel { visibility: hidden !important; }
        `;
        (document.head || document.documentElement).appendChild(style);
        return style;
    }

    /**
     * 延後移除 mode picker 暫時隱藏樣式，避免關閉動畫閃爍。
     *
     * @param {HTMLElement | null} style 先前建立的暫時 style。
     * @returns {void} 無回傳值；有效 style 會建立一次清理 timer。
     */
    function releaseSilentPickerStyle(style) {
        if (style) setTimeout(() => style.remove(), 100);
    }

    /**
     * 開啟 Gemini 模式選單並切換至指定模式。
     *
     * @param {string} modeKey 目標模式 key。
     * @param {boolean} [silent=false] 是否暫時隱藏模式選單動畫。
     * @returns {Promise<boolean>} 切換成功時為 true，模式無效或缺少按鈕時為 false；會操作 DOM，並可能建立聚焦及樣式清理 timer。
     */
    async function switchToMode(modeKey, silent = false) {
        const mode = MODES.find(m => m.key === modeKey);
        if (!mode) return false;

        const switchButton = document.querySelector('button.input-area-switch');
        if (!switchButton) {
            console.log('[Gemini] 找不到模式切換按鈕');
            return false;
        }

        const style = createSilentPickerStyle(silent);

        try {
            switchButton.click();
            const success = await selectModeOption(mode);

            // 選完模式後自動聚焦輸入框
            if (success) {
                setTimeout(() => {
                    const inputEl = document.querySelector('.ql-editor[contenteditable="true"]');
                    if (inputEl) inputEl.focus();
                }, 200);
            }

            return success;
        } finally {
            releaseSilentPickerStyle(style);
        }
    }

    /**
     * 將獨立保存的延伸思考設定同步至新版 mode picker 勾選項目。
     *
     * @param {boolean} enabled 期望的延伸思考狀態。
     * @param {boolean} [silent=false] 是否隱藏 mode picker 動畫。
     * @returns {Promise<boolean>} 介面已符合或切換成功時為 true；找不到選項時一律為 false。
     */
    async function syncExtendedThinking(enabled, silent = false) {
        const switchButton = document.querySelector(SWITCH_BUTTON_SELECTOR);
        if (!switchButton) return false;

        const style = createSilentPickerStyle(silent);
        try {
            switchButton.click();
            const option = await waitForThinkingOption();
            if (!option) {
                document.body?.click();
                // 找不到選項代表本輪同步失敗；即使期望關閉也不能推定介面已符合。
                return false;
            }
            if (isMenuOptionActive(option) !== enabled) option.click();
            document.body?.click();
            return true;
        } finally {
            releaseSilentPickerStyle(style);
        }
    }

    /**
     * 將目前保存模式循環切換至下一個模式，並同步主選單標籤。
     *
     * @returns {Promise<void>} 切換流程完成後結束；副作用是操作 Gemini 介面、更新設定與 GM 選單。
     */
    async function cycleMode() {
        const current = getCurrentMode();
        const next = getNextMode(current.key);
        let success = false;
        try {
            success = await switchToMode(next.key, true);
            if (success) await syncExtendedThinking(getSavedExtendedThinking(), true);
        } catch (error) {
            console.error('[Gemini] 手動切換失敗:', error);
        }
        updateMainMenuLabel(success ? next : current);
    }

    /**
     * 在載入或 SPA 更新後確認並套用保存模式。
     *
     * @returns {Promise<boolean>} 已是目標模式或切換成功時為 true，缺少按鈕或切換失敗時為 false；可能操作 DOM 並輸出紀錄。
     */
    async function autoSwitchOnLoad() {
        const mode = getCurrentMode();
        const switchButton = document.querySelector(SWITCH_BUTTON_SELECTOR);
        if (!switchButton) return false;

        const currentLabel = switchButton.querySelector('.input-area-switch-label span');
        const modelReady = currentLabel && matchesModeLabel(currentLabel.textContent, mode)
            ? true
            : await switchToMode(mode.key, true);
        if (!modelReady) return false;

        console.log(`[Gemini] 已固定 ${mode.name} 模型`);
        return await syncExtendedThinking(getSavedExtendedThinking(), true);
    }

    /**
     * 初始化主選單、自動切換重試、DOM 監聽與終局 pagehide 清理。
     *
     * @returns {void} 無回傳值；副作用是註冊 GM 選單、MutationObserver、timer 與 pagehide 事件。
     */
    function init() {
        const current = getCurrentMode();
        modelMenuId = GM_registerMenuCommand(
            `🔄 固定模型（${current.icon} ${current.name}）`,
            cycleMode
        );
        const thinkingEnabled = getSavedExtendedThinking();
        thinkingMenuId = GM_registerMenuCommand(
            `🧠 延伸思考（${thinkingEnabled ? '開啟' : '關閉'}）`,
            toggleExtendedThinking
        );
        let lastUrl = location.href;
        let switching = false;
        let debounceTimer = null;
        let retryTimer = null;
        let disposed = false;
        /**
         * 表示目前 URL 的三次自動切換嘗試是否已耗盡。
         *
         * 設計意圖：耗盡後停止讓無關 DOM 變化反覆重啟整輪重試；
         * 只有 URL 改變或實際新增切換按鈕時才解除。
         *
         * @type {boolean}
         */
        let retryExhausted = false;

        /**
         * 清除尚未執行的 DOM debounce timer。
         *
         * @returns {void} 無回傳值；副作用是取消 timer 並清空其識別碼。
         */
        function clearDebounceTimer() {
            if (debounceTimer == null) return;
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }

        /**
         * 清除尚未執行的自動切換 retry timer。
         *
         * @returns {void} 無回傳值；副作用是取消 timer 並清空其識別碼。
         */
        function clearRetryTimer() {
            if (retryTimer == null) return;
            clearTimeout(retryTimer);
            retryTimer = null;
        }

        /**
         * 在重試上限內排程下一次自動切換，超過上限時鎖定目前 URL。
         *
         * 設計意圖：上限代表完整一輪嘗試已結束，因此同時清除可能殘留的
         * debounce，避免它在沒有新切換按鈕的情況下偷偷開啟下一輪。
         *
         * @param {number} nextAttemptNumber 下一次嘗試的序號。
         * @returns {void} 無回傳值；有效序號會建立延遲 timer，超過上限則標記耗盡。
         */
        function scheduleAutoRetry(nextAttemptNumber) {
            if (disposed) return;
            if (nextAttemptNumber > MAX_AUTO_SWITCH_ATTEMPTS) {
                clearRetryTimer();
                clearDebounceTimer();
                retryExhausted = true;
                return;
            }
            clearRetryTimer();
            retryTimer = setTimeout(() => {
                retryTimer = null;
                attemptAutoSwitch(nextAttemptNumber, true);
            }, AUTO_RETRY_DELAY);
        }

        /**
         * 執行一次自動模式切換，並依結果管理目前 URL 的重試狀態。
         *
         * 設計意圖：一般 DOM 觸發可取代尚未執行的 retry；成功後則同步清除
         * timer 與耗盡標記，確保狀態不會殘留到後續導覽。
         *
         * @param {number} [attemptNumber=1] 本次嘗試序號。
         * @param {boolean} [isRetry=false] 是否由 retry timer 觸發。
         * @returns {Promise<boolean>} 成功切換時為 true，忙碌、缺少按鈕或失敗時為 false；可能操作 DOM、更新狀態並排程 retry。
         */
        async function attemptAutoSwitch(attemptNumber = 1, isRetry = false) {
            if (disposed) return false;
            if (!isRetry) {
                clearRetryTimer();
            }
            if (switching) return false;

            const switchButton = document.querySelector('button.input-area-switch');
            if (!switchButton) {
                scheduleAutoRetry(attemptNumber + 1);
                return false;
            }

            switching = true;
            try {
                const success = await autoSwitchOnLoad();
                if (!success) {
                    switching = false;
                    scheduleAutoRetry(attemptNumber + 1);
                } else {
                    clearRetryTimer();
                    retryExhausted = false;
                }
                return success;
            } catch (error) {
                switching = false;
                console.error('[Gemini] 自動切換失敗:', error);
                scheduleAutoRetry(attemptNumber + 1);
                return false;
            }
        }

        /**
         * 監聽 SPA 導覽與新增節點，並依目前 URL 的重試狀態決定是否 debounce。
         *
         * 設計意圖：一般初載仍接受任何新增元素；一輪重試耗盡後則只檢查
         * mutation 已提供的節點，避免同步掃描整份 document 或受無關更新喚醒。
         *
         * @param {MutationRecord[]} mutations 本批 DOM 變更紀錄。
         * @returns {void} 無回傳值；符合條件時可能重設狀態並建立 debounce timer。
         */
        const observer = new MutationObserver((mutations) => {
            if (disposed) return;
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                clearRetryTimer();
                retryExhausted = false;
                switching = false; // URL 已改變，允許新頁面重新嘗試完整一輪
            }

            if (switching) return;

            let hasAcceptedElement = false;
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (!retryExhausted) {
                        hasAcceptedElement = true;
                        break;
                    }

                    const element = /** @type {Element} */ (node);
                    const hasAutoSwitchTarget = containsAutoSwitchTarget(element);
                    if (hasAutoSwitchTarget) {
                        hasAcceptedElement = true;
                        retryExhausted = false;
                        break;
                    }
                }
                if (hasAcceptedElement) break;
            }
            if (!hasAcceptedElement) return;

            // 沿用既有 debounce，避免短時間內大量符合條件的 mutation 重複觸發。
            clearDebounceTimer();
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                attemptAutoSwitch();
            }, 300);
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        /**
         * 清理 Gemini 的長期 DOM observer 與尚未執行的 debounce／retry timer。
         *
         * @returns {void} 無回傳值；副作用是永久停用本頁監聽並移除 pagehide handler。
         */
        function cleanup() {
            if (disposed) return;
            disposed = true;
            observer.disconnect();
            clearDebounceTimer();
            clearRetryTimer();
            window.removeEventListener('pagehide', handlePageHide);
        }

        /**
         * 只在頁面未進入 bfcache 的終局 pagehide 執行長期資源清理。
         *
         * @param {PageTransitionEvent} event pagehide 事件；persisted 為 true 表示頁面仍會續存。
         * @returns {void} bfcache 情境保留 observer／timer，終局離開時呼叫 cleanup。
         */
        function handlePageHide(event) {
            if (event.persisted === true) return;
            cleanup();
        }

        window.addEventListener('pagehide', handlePageHide);

        // 初始載入：等待切換按鈕出現
        waitForElement('button.input-area-switch', 5000).then(btn => {
            if (btn) attemptAutoSwitch();
        });
    }

    init();
})();
