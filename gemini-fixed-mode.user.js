// ==UserScript==
// @name         Gemini 固定使用模型
// @namespace    https://chris.taipei
// @version      0.1
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
// Co-authored with Claude Opus 4.5

(function() {
    'use strict';

    const MODES = [
        { key: 'pro', name: 'Pro', icon: '⭐', testId: 'bard-mode-option-pro' },
        { key: 'fast', name: 'Fast', icon: '🚀', testId: 'bard-mode-option-fast' },
        { key: 'thinking', name: 'Thinking', icon: '🧠', testId: 'bard-mode-option-thinking' }
    ];

    const DEFAULT_MODE = 'pro';

    let mainMenuId = null; // 儲存主選單的 ID

    function getModeIndex(key) {
        return MODES.findIndex(m => m.key === key);
    }

    function getSelectedMode() {
        return GM_getValue('selectedMode', DEFAULT_MODE);
    }

    function setSelectedMode(mode) {
        GM_setValue('selectedMode', mode);
    }

    function getNextMode(currentKey) {
        const currentIndex = getModeIndex(currentKey);
        const nextIndex = (currentIndex + 1) % MODES.length;
        return MODES[nextIndex];
    }

    function getCurrentMode() {
        const key = getSelectedMode();
        return MODES.find(m => m.key === key) || MODES[0];
    }

    function switchToMode(modeKey, silent = false) {
        const mode = MODES.find(m => m.key === modeKey);
        if (!mode) return;

        const switchButton = document.querySelector('button.input-area-switch');
        if (!switchButton) {
            console.log('[Gemini] 找不到模式切換按鈕');
            return;
        }

        if (silent) {
            // 靜默模式：隱藏選單彈出過程
            const style = document.createElement('style');
            style.id = 'gemini-silent-switch';
            style.textContent = `
                .cdk-overlay-container { visibility: hidden !important; }
                .mat-mdc-menu-panel { visibility: hidden !important; }
            `;
            document.head.appendChild(style);

            switchButton.click();

            setTimeout(() => {
                const option = document.querySelector(`[data-test-id="${mode.testId}"]`);
                if (option) {
                    option.click();
                    setSelectedMode(modeKey);
                    console.log(`[Gemini] 已切換至 ${mode.name} 模式`);
                } else {
                    document.body.click();
                    console.log(`[Gemini] 找不到 ${mode.name} 選項`);
                }
                // 移除隱藏樣式
                setTimeout(() => style.remove(), 100);
            }, 50);
        } else {
            // 一般模式：顯示選單
            switchButton.click();

            setTimeout(() => {
                const option = document.querySelector(`[data-test-id="${mode.testId}"]`);
                if (option) {
                    option.click();
                    setSelectedMode(modeKey);
                    console.log(`[Gemini] 已切換至 ${mode.name} 模式`);
                } else {
                    document.body.click();
                    console.log(`[Gemini] 找不到 ${mode.name} 選項`);
                }
            }, 300);
        }
    }

    function cycleMode() {
        const current = getCurrentMode();
        const next = getNextMode(current.key);
        switchToMode(next.key, true); // 靜默切換

        // 更新主選單項目顯示新的固定模式
        GM_registerMenuCommand(`🔄 固定模式（${next.icon} ${next.name}）`, cycleMode, { id: mainMenuId });
    }

    function autoSwitchOnLoad() {
        const mode = getCurrentMode();

        const switchButton = document.querySelector('button.input-area-switch');
        if (!switchButton) return false;

        const currentLabel = switchButton.querySelector('.input-area-switch-label span');
        if (currentLabel && currentLabel.textContent.trim() === mode.name) {
            console.log(`[Gemini] 已經是 ${mode.name} 模式`);
            return true;
        }

        switchToMode(mode.key, true); // 靜默切換
        return true;
    }

    function init() {
        const current = getCurrentMode();
        mainMenuId = GM_registerMenuCommand(`🔄 固定模式（${current.icon} ${current.name}）`, cycleMode);

        let lastUrl = location.href;
        let switching = false;

        // 監聽 URL 變化（SPA 導航）
        const observer = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                switching = false; // 重設狀態，允許再次切換
            }

            if (switching) return;

            const switchButton = document.querySelector('button.input-area-switch');
            if (switchButton) {
                switching = true;
                setTimeout(() => autoSwitchOnLoad(), 500); // 等待 UI 穩定
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        // 初始載入也執行一次
        setTimeout(autoSwitchOnLoad, 1000);
    }

    init();
})();
