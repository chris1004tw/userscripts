// ==UserScript==
// @name         Facebook 自動最高畫質
// @namespace    https://chris.taipei
// @version      0.1
// @description  播放 Facebook 影片時自動選擇畫質選單中的最高解析度，省去每次手動切換
// @author       chris1004tw
// @match        https://www.facebook.com/*
// @match        https://web.facebook.com/*
// @noframes
// @grant        none
// @run-at       document-idle
// @updateURL    https://github.com/chris1004tw/userscripts/raw/main/facebook-highest-quality.user.js
// @downloadURL  https://github.com/chris1004tw/userscripts/raw/main/facebook-highest-quality.user.js
// ==/UserScript==
// Co-authored with Claude Opus 4.6 Thinking
// 維護索引：README.md「維護索引」

(function () {
    'use strict';

    if (window.self !== window.top) return;

    const BUTTONS = '[role="button"], [role="menuitemradio"]';
    const SETTINGS = /^(?:Settings|設定|设置)$/;
    const QUALITY = /^(?:Quality|畫質|画质|影片畫質|视频画质)/;
    const attempted = new WeakMap();
    const hiddenMenus = new Map();
    let restoreFrame;
    let active;
    let timer;
    let stopped = false;

    /**
     * 僅接受可操作的播放器控制項。
     * @param {Element} button 控制項。
     * @returns {boolean} 是否可操作。
     */
    function isAvailable(button) {
        return button.isConnected && !button.disabled && button.getAttribute('aria-disabled') !== 'true' &&
            button.getAttribute('aria-hidden') !== 'true' && button.getClientRects().length > 0;
    }

    /**
     * 限定在只包含此影片的最近祖先與其播放器 group，避免跨影片或頁面設定誤點。
     * @param {HTMLVideoElement} video 正在播放的影片。
     * @returns {{group: Element, settings: Element} | null} 對應播放器控制項。
     */
    function findControls(video) {
        let parent = video.parentElement;
        for (let depth = 0; parent && parent !== document.body && depth < 12; depth++, parent = parent.parentElement) {
            if (parent.querySelectorAll('video').length !== 1) return null;
            for (const group of parent.querySelectorAll('[role="group"]')) {
                const settings = Array.from(group.querySelectorAll(BUTTONS)).filter(button =>
                    SETTINGS.test(button.getAttribute('aria-label') || '') && isAvailable(button),
                );
                if (settings.length === 1) return { group, settings: settings[0] };
            }
        }
        return null;
    }

    /**
     * 在 mutation microtask 內隱藏自動選單，保留排版與程式 click；不隱藏影片或設定按鈕。
     * @returns {void} 選單重建時重新定位，只保存本輪修改的樣式。
     */
    function hideAutomaticMenus() {
        if (!active?.opened) return;
        const { group, settings } = active;
        for (const button of group.querySelectorAll(BUTTONS)) {
            if (!QUALITY.test(button.textContent.trim())) continue;
            let menu = button;
            while (menu.parentElement && menu.parentElement !== group && !menu.parentElement.contains(settings)) {
                menu = menu.parentElement;
            }
            if (menu === button || menu.contains(settings) || menu.querySelector('video') || hiddenMenus.has(menu)) continue;
            const original = ['opacity', 'transition', 'pointer-events'].map(property =>
                [property, menu.style.getPropertyValue(property), menu.style.getPropertyPriority(property)],
            );
            hiddenMenus.set(menu, original);
            menu.style.setProperty('transition', 'none', 'important');
            menu.style.setProperty('opacity', '0', 'important');
            menu.style.setProperty('pointer-events', 'none', 'important');
        }
    }

    /**
     * 還原選單原有樣式及 priority，包括已被 React 移除的舊選單。
     * @returns {void} 取消延後還原並釋放所有 DOM 引用。
     */
    function restoreMenus() {
        if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame);
        restoreFrame = undefined;
        for (const [menu, original] of hiddenMenus) {
            for (const [property, value, priority] of original) {
                if (value) menu.style.setProperty(property, value, priority);
                else menu.style.removeProperty(property);
            }
        }
        hiddenMenus.clear();
    }

    /**
     * 停止本輪；只收起本輪開啟且仍有畫質內容的選單。
     * @param {boolean} closeMenu 是否收起自動開啟的選單。
     * @returns {void} 清除 observer、計時器與 DOM 引用。
     */
    function finish(closeMenu) {
        const state = active;
        active = undefined;
        clearTimeout(timer);
        timer = undefined;
        state?.observer?.disconnect();
        try {
            if (closeMenu && state?.opened && state.settings.isConnected &&
                Array.from(state.group.querySelectorAll(BUTTONS)).some(button => QUALITY.test(button.textContent.trim()))) {
                state.settings.click();
            }
        } finally {
            // 等 React 完成關閉再還原，避免關閉前閃一幀；手動介入／卸載則立即還原。
            if (closeMenu && hiddenMenus.size) {
                if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame);
                restoreFrame = requestAnimationFrame(restoreMenus);
            } else restoreMenus();
        }
    }

    /**
     * 合併選單 mutation 與有限等待；不建立永久輪詢。
     * @returns {void} 每輪最多執行 30 次、每次間隔 150ms。
     */
    function scheduleStep() {
        if (active && timer === undefined) timer = setTimeout(selectHighestQuality, 150);
    }

    /**
     * 依序開設定、畫質子選單並點擊數字最大的解析度，不猜測 HD 對應值。
     * @returns {void} 無法識別的播放器在有限等待後保留原設定。
     */
    function selectHighestQuality() {
        timer = undefined;
        const state = active;
        if (!state) return;
        const video = state.video;
        if (!video.isConnected || video.paused || video.ended || location.href !== state.href ||
            video.currentSrc !== state.src || video.srcObject !== state.srcObject) {
            finish(true);
            return;
        }
        if (++state.steps > 30) {
            finish(true);
            return;
        }
        if (!state.group) {
            const controls = findControls(video);
            if (!controls) {
                scheduleStep();
                return;
            }
            Object.assign(state, controls);
            // 已由使用者開啟的選單不接管。
            if (Array.from(state.group.querySelectorAll(BUTTONS)).some(button => QUALITY.test(button.textContent.trim()))) {
                finish(false);
                return;
            }
            state.observer = new MutationObserver(() => {
                hideAutomaticMenus();
                scheduleStep();
            });
            state.observer.observe(state.group, { childList: true, subtree: true, characterData: true });
            state.opened = true;
            state.settings.click();
            hideAutomaticMenus();
        } else {
            const buttons = Array.from(state.group.querySelectorAll(BUTTONS)).filter(isAvailable);
            const quality = buttons.find(button => QUALITY.test(button.textContent.trim()));
            if (state.entered && quality) {
                let best;
                let highest = 0;
                for (const button of buttons) {
                    const match = /^(\d{3,4})p(?:\s*(?:HD|60))?$/i.exec(button.textContent.trim());
                    if (match && Number(match[1]) > highest) {
                        highest = Number(match[1]);
                        best = button;
                    }
                }
                if (best) {
                    best.click();
                    finish(true);
                    return;
                }
            } else if (quality && !state.entered) {
                state.entered = true;
                quality.click();
            }
        }
        scheduleStep();
    }

    /**
     * 每個媒體來源只嘗試一次；playing capture 同時涵蓋 SPA 後新增的影片。
     * @param {Event | {target: HTMLVideoElement}} event 播放事件或初始掃描。
     * @returns {void} 同影片重入不重設等待額度。
     */
    function handlePlaying(event) {
        const video = event.target;
        if (stopped || video.tagName !== 'VIDEO' || video.paused || video.ended || !video.isConnected) return;
        const rect = video.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= window.innerHeight ||
            rect.right <= 0 || rect.left >= window.innerWidth) return;
        const previous = attempted.get(video);
        if (previous && previous.href === location.href && previous.src === video.currentSrc && previous.srcObject === video.srcObject) return;
        finish(true);
        active = { video, href: location.href, src: video.currentSrc, srcObject: video.srcObject, steps: 0 };
        attempted.set(video, { href: active.href, src: active.src, srcObject: active.srcObject });
        scheduleStep();
    }

    // 真實滑鼠／鍵盤操作優先；腳本自己的 click 不會取消本輪。
    const cancelForUser = event => { if (event.isTrusted) finish(false); };
    document.addEventListener('playing', handlePlaying, true);
    document.addEventListener('pointerdown', cancelForUser, true);
    document.addEventListener('keydown', cancelForUser, true);
    document.querySelectorAll('video').forEach(video => handlePlaying({ target: video }));
    window.addEventListener('pagehide', event => {
        if (event.persisted) return;
        stopped = true;
        finish(false);
        document.removeEventListener('playing', handlePlaying, true);
        document.removeEventListener('pointerdown', cancelForUser, true);
        document.removeEventListener('keydown', cancelForUser, true);
    });
})();
