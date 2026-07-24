// ==UserScript==
// @name         Gemini 固定使用模型
// @namespace    https://chris.taipei
// @version      0.4.4
// @description  自動將 Gemini 模型切換為 Pro、Fast 或 Thinking，並提供選單固定切換模型
// @author       chris1004tw
// @match        https://gemini.google.com/*
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

    /**
     * Gemini 可選模式的資料形狀。
     *
     * @typedef {Object} GeminiMode
     * @property {string} key 寫入設定的穩定模式識別碼。
     * @property {string} name Gemini 介面顯示的模式名稱。
     * @property {string} icon Tampermonkey 選單顯示的模式圖示。
     * @property {string} testId Gemini 模式選項的 data-test-id。
     */

    /** @type {GeminiMode[]} 支援的模式與對應介面識別資料。 */
    const MODES = [
        { key: 'pro', name: 'Pro', icon: '⭐', testId: 'bard-mode-option-pro' },
        { key: 'fast', name: 'Fast', icon: '🚀', testId: 'bard-mode-option-fast' },
        { key: 'thinking', name: 'Thinking', icon: '🧠', testId: 'bard-mode-option-thinking' }
    ];

    const DEFAULT_MODE = 'pro';
    const AUTO_RETRY_DELAY = 500;
    const MAX_AUTO_SWITCH_ATTEMPTS = 3;

    let mainMenuId = null; // 儲存主選單的 ID

    /**
     * 等待指定元素出現，並以 timeout 保證 Promise 最終完成。
     *
     * @param {string} selector 要查找的 CSS 選擇器。
     * @param {number} [timeout=3000] 最長等待毫秒數。
     * @returns {Promise<Element|null>} 找到時回傳元素，逾時回傳 null；等待期間會建立並在完成時清理 observer 與 timer。
     */
    function waitForElement(selector, timeout = 3000) {
        return new Promise((resolve) => {
            const existing = document.querySelector(selector);
            if (existing) { resolve(existing); return; }

            let timeoutId = null;
            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) {
                    if (timeoutId !== null) {
                        clearTimeout(timeoutId);
                        timeoutId = null;
                    }
                    observer.disconnect();
                    resolve(el);
                }
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
     * 讀取使用者保存的模式識別碼。
     *
     * @returns {string} 保存的模式 key；未設定時為 Pro 的 key。副作用是讀取 GM 儲存空間。
     */
    function getSavedModeKey() {
        return GM_getValue('selectedMode', DEFAULT_MODE);
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
        return MODES.find(m => m.key === key) || MODES[0];
    }

    /**
     * 原地更新已註冊的主選單標籤。
     *
     * @param {GeminiMode} [mode=getCurrentMode()] 要顯示的模式資料。
     * @returns {void} 無回傳值；主選單存在時會重新註冊同一 ID 的 GM 選單指令。
     */
    function updateMainMenuLabel(mode = getCurrentMode()) {
        if (mainMenuId == null) return;
        GM_registerMenuCommand(`🔄 固定模式（${mode.icon} ${mode.name}）`, cycleMode, { id: mainMenuId });
    }

    /**
     * 等待並點擊指定 Gemini 模式選項。
     *
     * @param {GeminiMode} mode 要選取的模式資料。
     * @returns {Promise<boolean>} 點擊並保存成功時為 true；找不到選項時為 false。副作用包含 DOM 點擊、設定寫入與主控台紀錄。
     */
    async function selectModeOption(mode) {
        const option = await waitForElement(`[data-test-id="${mode.testId}"]`, 1000);
        if (option) {
            option.click();
            setSelectedMode(mode.key);
            console.log(`[Gemini] 已切換至 ${mode.name} 模式`);
            return true;
        }
        // 找不到選項時關閉選單
        document.body?.click();
        console.log(`[Gemini] 找不到 ${mode.name} 選項`);
        return false;
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

        let style = null;
        if (silent) {
            // 靜默模式：隱藏選單彈出過程
            document.getElementById('gemini-silent-switch')?.remove();
            style = document.createElement('style');
            style.id = 'gemini-silent-switch';
            style.textContent = `
                .cdk-overlay-container { visibility: hidden !important; }
                .mat-mdc-menu-panel { visibility: hidden !important; }
            `;
            (document.head || document.documentElement).appendChild(style);
        }

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
            if (style) {
                // 稍等一下再移除隱藏樣式，確保動畫不閃爍
                setTimeout(() => style.remove(), 100);
            }
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
            success = await switchToMode(next.key, true); // 靜默切換
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

        const switchButton = document.querySelector('button.input-area-switch');
        if (!switchButton) return false;

        const currentLabel = switchButton.querySelector('.input-area-switch-label span');
        if (currentLabel && currentLabel.textContent.trim() === mode.name) {
            console.log(`[Gemini] 已經是 ${mode.name} 模式`);
            return true;
        }

        return await switchToMode(mode.key, true); // 靜默切換
    }

    /**
     * 初始化主選單、自動切換重試、DOM 監聽與終局 pagehide 清理。
     *
     * @returns {void} 無回傳值；副作用是註冊 GM 選單、MutationObserver、timer 與 pagehide 事件。
     */
    function init() {
        const current = getCurrentMode();
        mainMenuId = GM_registerMenuCommand(`🔄 固定模式（${current.icon} ${current.name}）`, cycleMode);

        let lastUrl = location.href;
        let switching = false;
        let debounceTimer = null;
        let retryTimer = null;
        let disposed = false;

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
         * 在重試上限內排程下一次自動切換。
         *
         * @param {number} nextAttemptNumber 下一次嘗試的序號。
         * @returns {void} 無回傳值；有效序號會先清除舊 retry，再建立新的延遲 timer。
         */
        function scheduleAutoRetry(nextAttemptNumber) {
            if (disposed || nextAttemptNumber > MAX_AUTO_SWITCH_ATTEMPTS) return;
            clearRetryTimer();
            retryTimer = setTimeout(() => {
                retryTimer = null;
                attemptAutoSwitch(nextAttemptNumber, true);
            }, AUTO_RETRY_DELAY);
        }

        /**
         * 執行一次自動模式切換，並依結果管理重試狀態。
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
                }
                return success;
            } catch (error) {
                switching = false;
                console.error('[Gemini] 自動切換失敗:', error);
                scheduleAutoRetry(attemptNumber + 1);
                return false;
            }
        }

        // 監聽 DOM 變化（SPA 導航 + 偵測切換按鈕出現）
        const observer = new MutationObserver((mutations) => {
            if (disposed) return;
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                clearRetryTimer();
                switching = false; // 重設狀態，允許再次切換
            }

            if (switching) return;

            // 快速路徑：只在有新增元素節點時才觸發
            let hasNewElements = false;
            for (const m of mutations) {
                if (m.addedNodes.length > 0) {
                    for (const node of m.addedNodes) {
                        if (node.nodeType === 1) { hasNewElements = true; break; }
                    }
                    if (hasNewElements) break;
                }
            }
            if (!hasNewElements) return;

            // debounce：避免短時間內大量觸發
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
