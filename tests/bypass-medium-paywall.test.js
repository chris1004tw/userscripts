'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runUserScript } = require('./helpers/userscript-harness');

const SCRIPT_FILE = 'bypass-medium-paywall.user.js';

/**
 * 在指定網址執行 Medium userscript，並保留跳轉結果、選單與設定寫入供斷言。
 *
 * @param {string} currentUrl 腳本啟動時的完整頁面網址。
 * @param {{ defaultService?: string, autoRedirect?: boolean }} [options={}] 預設服務與自動跳轉設定。
 * @returns {{ location: { href: string }, menus: Array<object>, settingsWrites: Array<object> }}
 * 測試可觀察狀態；副作用侷限於 VM 中的 location 與 GM stub。
 */
function createEnvironment(currentUrl, options = {}) {
  const location = { href: currentUrl };
  const menus = [];
  const settingsWrites = [];
  const settings = new Map([
    ['defaultService', options.defaultService ?? 'freedium'],
    ['autoRedirect', options.autoRedirect ?? true],
  ]);

  runUserScript(SCRIPT_FILE, {
    window: { location },
    GM_getValue(key, fallback) {
      return settings.has(key) ? settings.get(key) : fallback;
    },
    GM_setValue(key, value) {
      settings.set(key, value);
      settingsWrites.push({ key, value });
    },
    GM_registerMenuCommand(label, callback, menuOptions) {
      menus.push({ label, callback, menuOptions });
      return menuOptions?.id;
    },
  });

  return { location, menus, settingsWrites };
}

test('三個第三方服務的任意路徑都視為服務站且不再重導', () => {
  const serviceUrls = [
    ['Freedium', 'https://freedium-mirror.cfd/article/example'],
    ['Archive.today', 'https://archive.ph/AbCdE'],
    ['ReadMedium', 'https://readmedium.com/story/example'],
  ];

  serviceUrls.forEach(([serviceName, serviceUrl]) => {
    const env = createEnvironment(serviceUrl);

    assert.equal(env.location.href, serviceUrl, `${serviceName} 不應再次跳轉`);
    assert.equal(
      env.menus.some((menu) => menu.label === '立即跳轉'),
      false,
      `${serviceName} 不應註冊立即跳轉選單`,
    );
  });
});

test('服務站識別使用 hostname，因此 HTTP 的 archive.ph 任意路徑也不重導', () => {
  const serviceUrl = 'http://archive.ph/another-path';
  const env = createEnvironment(serviceUrl);

  assert.equal(env.location.href, serviceUrl);
  assert.equal(env.menus.some((menu) => menu.label === '立即跳轉'), false);
});

test('看似服務站的 hostname 不會被字串前綴誤判', () => {
  const lookalikeUrls = [
    'https://freedium-mirror.cfd.evil.example/article',
    'https://archive.ph.evil.example/newest/article',
    'https://readmedium.com.evil.example/story',
  ];

  lookalikeUrls.forEach((lookalikeUrl) => {
    const env = createEnvironment(lookalikeUrl, { defaultService: 'freedium' });

    assert.equal(env.location.href, `https://freedium-mirror.cfd/${lookalikeUrl}`);
    assert.equal(env.menus.some((menu) => menu.label === '立即跳轉'), true);
  });
});

test('Medium 頁面仍依選定服務使用各自的跳轉 endpoint', () => {
  const mediumUrl = 'https://medium.com/@author/example-story-123';
  const redirectCases = [
    ['freedium', 'https://freedium-mirror.cfd/'],
    ['archive', 'https://archive.ph/newest/'],
    ['readmedium', 'https://readmedium.com/'],
  ];

  redirectCases.forEach(([serviceKey, endpoint]) => {
    const env = createEnvironment(mediumUrl, { defaultService: serviceKey });

    assert.equal(env.location.href, endpoint + mediumUrl);
    assert.equal(env.menus.some((menu) => menu.label === '立即跳轉'), true);
  });
});
