// ==UserScript==
// @name         PVE 自動關閉訂閱提示
// @namespace    https://chris.taipei
// @version      0.1
// @description  自動確認 PVE 的無有效訂閱提示，保留其他警告與操作確認，不修改訂閱狀態
// @author       chris1004tw
// @include      /^https?:\/\/[^/?#]+:8006\/.*/
// @noframes
// @grant        none
// @run-at       document-idle
// @updateURL    https://github.com/chris1004tw/userscripts/raw/main/pve-hide-subscription.user.js
// @downloadURL  https://github.com/chris1004tw/userscripts/raw/main/pve-hide-subscription.user.js
// ==/UserScript==
// Co-authored with Claude Opus 4.6 Thinking
// 維護索引：README.md「維護索引」

(function () {
    'use strict';

    if (window.self !== window.top) return;

    const DIALOG_SELECTOR = '.x-message-box[role="alertdialog"]';
    const pendingDialogs = new Set();
    let frameId;

    /**
     * 僅透過唯一的 OK 按鈕確認英文訂閱提示，讓 Ext JS 正常清除遮罩並執行 callback。
     * @param {Element} dialog 待檢查的 Ext JS 訊息視窗。
     * @returns {void} 不符合完整提示或含其他可操作按鈕時不處理。
     */
    function dismissSubscriptionNotice(dialog) {
        if (!dialog.isConnected || dialog.getAttribute('aria-hidden') === 'true' || !dialog.getClientRects().length) return;
        if (dialog.querySelector('.x-title-text')?.textContent.trim() !== 'No valid subscription') return;
        const message = dialog.querySelector('.x-window-text')?.textContent.replace(/\s+/g, ' ').trim();
        if (message !== 'You do not have a valid subscription for this server. Please visit www.proxmox.com to get a list of available options.') return;

        const buttons = Array.from(dialog.querySelectorAll('[role="button"]')).filter(button =>
            button.getAttribute('aria-hidden') !== 'true' && button.getClientRects().length,
        );
        if (buttons.length !== 1) return;
        const button = buttons[0];
        if (button.textContent.trim() !== 'OK' || button.getAttribute('aria-disabled') === 'true' || button.disabled) return;
        button.click();
    }

    /**
     * 合併同一幀內的視窗更新；Ext JS 重用視窗時仍重新判斷內容。
     * @param {Element | null} dialog 待檢查視窗。
     * @returns {void} 最多安排一個下一幀工作。
     */
    function queueDialog(dialog) {
        if (!dialog || !dialog.isConnected) return;
        pendingDialogs.add(dialog);
        if (frameId !== undefined) return;
        frameId = requestAnimationFrame(() => {
            frameId = undefined;
            for (const pending of pendingDialogs) dismissSubscriptionNotice(pending);
            pendingDialogs.clear();
        });
    }

    // Ext JS 的浮動 MessageBox 直接加入 body；不探索一般頁面的新增 subtree。
    const observer = new MutationObserver(records => {
        for (const record of records) {
            const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            queueDialog(target?.closest(DIALOG_SELECTOR));
            for (const node of record.addedNodes) {
                if (node.nodeType === 1 && node.matches(DIALOG_SELECTOR)) queueDialog(node);
            }
        }
    });
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-hidden', 'aria-disabled', 'style', 'class'],
    });
    document.querySelectorAll(DIALOG_SELECTOR).forEach(queueDialog);

    window.addEventListener('pagehide', event => {
        if (event.persisted) return;
        observer.disconnect();
        if (frameId !== undefined) cancelAnimationFrame(frameId);
        frameId = undefined;
        pendingDialogs.clear();
    });
})();
