// ==UserScript==
// @name         Gemini 固定使用模型
// @namespace    https://chris.taipei
// @version      0.4.1
// @description  自動將 Gemini 模型切換為 Pro，並提供選單固定切換模型
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

(function() {
    'use strict';

    const MODES = [
        { key: 'pro', name: 'Pro', icon: '⭐', testId: 'bard-mode-option-pro' },
        { key: 'fast', name: 'Fast', icon: '🚀', testId: 'bard-mode-option-fast' },
        { key: 'thinking', name: 'Thinking', icon: '🧠', testId: 'bard-mode-option-thinking' }
    ];

    const DEFAULT_MODE = 'pro';

    let mainMenuId = null; // 儲存主選單的 ID

    // 等待元素出現，比固定 setTimeout 更可靠
    function waitForElement(selector, timeout = 3000) {
        return new Promise((resolve) => {
            const existing = document.querySelector(selector);
            if (existing) { resolve(existing); return; }

            let timeoutId;
            const observer = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) {
                    clearTimeout(timeoutId);
                    observer.disconnect();
                    resolve(el);
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });

            timeoutId = setTimeout(() => {
                observer.disconnect();
                resolve(null);
            }, timeout);
        });
    }

    function getSavedModeKey() {
        return GM_getValue('selectedMode', DEFAULT_MODE);
    }

    function setSelectedMode(mode) {
        GM_setValue('selectedMode', mode);
    }

    function getNextMode(currentKey) {
        const currentIndex = MODES.findIndex(m => m.key === currentKey);
        const nextIndex = (currentIndex + 1) % MODES.length;
        return MODES[nextIndex];
    }

    function getCurrentMode() {
        const key = getSavedModeKey();
        return MODES.find(m => m.key === key) || MODES[0];
    }

    // 提取共用的模式選取邏輯
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

    async function switchToMode(modeKey, silent = false) {
        const mode = MODES.find(m => m.key === modeKey);
        if (!mode) return;

        const switchButton = document.querySelector('button.input-area-switch');
        if (!switchButton) {
            console.log('[Gemini] 找不到模式切換按鈕');
            return;
        }

        let style = null;
        if (silent) {
            // 靜默模式：隱藏選單彈出過程
            style = document.createElement('style');
            style.id = 'gemini-silent-switch';
            style.textContent = `
                .cdk-overlay-container { visibility: hidden !important; }
                .mat-mdc-menu-panel { visibility: hidden !important; }
            `;
            document.head.appendChild(style);
        }

        switchButton.click();
        const success = await selectModeOption(mode);

        if (style) {
            // 稍等一下再移除隱藏樣式，確保動畫不閃爍
            setTimeout(() => style.remove(), 100);
        }

        // 選完模式後自動聚焦輸入框
        if (success) {
            setTimeout(() => {
                const inputEl = document.querySelector('.ql-editor[contenteditable="true"]');
                if (inputEl) inputEl.focus();
            }, 200);
        }
    }

    function cycleMode() {
        const current = getCurrentMode();
        const next = getNextMode(current.key);
        switchToMode(next.key, true); // 靜默切換

        // 更新主選單項目顯示新的固定模式
        GM_registerMenuCommand(`🔄 固定模式（${next.icon} ${next.name}）`, cycleMode, { id: mainMenuId });
    }

    async function autoSwitchOnLoad() {
        const mode = getCurrentMode();

        const switchButton = document.querySelector('button.input-area-switch');
        if (!switchButton) return false;

        const currentLabel = switchButton.querySelector('.input-area-switch-label span');
        if (currentLabel && currentLabel.textContent.trim() === mode.name) {
            console.log(`[Gemini] 已經是 ${mode.name} 模式`);
            return true;
        }

        await switchToMode(mode.key, true); // 靜默切換
        return true;
    }

    function init() {
        const current = getCurrentMode();
        mainMenuId = GM_registerMenuCommand(`🔄 固定模式（${current.icon} ${current.name}）`, cycleMode);

        let lastUrl = location.href;
        let switching = false;
        let debounceTimer = null;

        // 監聽 DOM 變化（SPA 導航 + 偵測切換按鈕出現）
        const observer = new MutationObserver((mutations) => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
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
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const switchButton = document.querySelector('button.input-area-switch');
                if (switchButton) {
                    switching = true;
                    autoSwitchOnLoad();
                }
            }, 300);
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // 頁面卸載時清理
        window.addEventListener('beforeunload', () => {
            observer.disconnect();
            clearTimeout(debounceTimer);
        });

        // 初始載入：等待切換按鈕出現
        waitForElement('button.input-area-switch', 5000).then(btn => {
            if (btn) autoSwitchOnLoad();
        });
    }

    init();
})();
