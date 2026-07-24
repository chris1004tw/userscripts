'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runUserScript } = require('./helpers/userscript-harness');

/**
 * 建立 URL 清理腳本需要的最小瀏覽器環境，並以實際 history 副作用觀察清理結果。
 *
 * @param {string} initialHref 測試起始網址。
 * @param {{cachedRules?: string, replaceFailures?: number}} [options={}] 遠端規則快取與模擬失敗次數。
 * @returns {{history: object, href: () => string, replaceAttempts: () => number}} 可操作的測試環境。
 */
function createUrlEnvironment(initialHref, options = {}) {
  let currentHref = initialHref;
  let remainingReplaceFailures = options.replaceFailures || 0;
  let replaceAttempts = 0;
  const listeners = new Map();
  const cachedRules = options.cachedRules || JSON.stringify({ providers: {} });

  const location = {};
  Object.defineProperty(location, 'href', {
    get: () => currentHref,
    set: value => { currentHref = new URL(String(value), currentHref).href; },
  });

  /**
   * 依照 History API 的相對網址語意更新測試 location。
   *
   * @param {string | URL | null | undefined} url 新的網址；省略時維持原值。
   * @returns {void}
   */
  function updateLocation(url) {
    if (url == null) return;
    currentHref = new URL(String(url), currentHref).href;
  }

  const history = {
    state: null,
    pushState(state, _title, url) {
      this.state = state;
      updateLocation(url);
    },
    replaceState(state, _title, url) {
      replaceAttempts += 1;
      if (remainingReplaceFailures > 0) {
        remainingReplaceFailures -= 1;
        throw new Error('模擬 replaceState 失敗');
      }
      this.state = state;
      updateLocation(url);
    },
  };

  const window = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };

  const document = {
    readyState: 'complete',
    addEventListener() {},
  };

  runUserScript('remove-url-tracker.user.js', {
    window,
    document,
    history,
    location,
    GM_getValue(key, fallback) {
      if (key === 'cachedRules') return cachedRules;
      if (key === 'cacheTime') return Date.now();
      return fallback;
    },
    GM_setValue() {},
    GM_xmlhttpRequest() {
      throw new Error('有效快取存在時不應發出遠端請求');
    },
  });

  return {
    history,
    href: () => currentHref,
    replaceAttempts: () => replaceAttempts,
  };
}

test('Given 一般網站的功能性短參數，When 清理 URL，Then 只移除跨站 click ID', () => {
  const env = createUrlEnvironment(
    'https://example.com/search?gclid=click&hl=zh-TW&tag=books&from=home&src=nav&set=compact',
  );

  assert.equal(
    env.href(),
    'https://example.com/search?hl=zh-TW&tag=books&from=home&src=nav&set=compact',
  );
});

test('Given Amazon 與淘寶追蹤參數，When 在對應站點清理，Then 站點參數被移除', () => {
  const amazon = createUrlEnvironment(
    'https://www.amazon.com/dp/item?tag=affiliate&psc=1&item=kept',
  );
  const taobao = createUrlEnvironment(
    'https://item.taobao.com/item.htm?id=42&pisk=token&rn=nonce&sourceId=campaign',
  );

  assert.equal(amazon.href(), 'https://www.amazon.com/dp/item?item=kept');
  assert.equal(taobao.href(), 'https://item.taobao.com/item.htm?id=42');
});

test('Given 其他網域使用平台同名參數，When 清理 URL，Then 不誤刪功能性資料', () => {
  const env = createUrlEnvironment(
    'https://shop.example.com/item?tag=category&pisk=state&rn=page&sourceId=source',
  );

  assert.equal(
    env.href(),
    'https://shop.example.com/item?tag=category&pisk=state&rn=page&sourceId=source',
  );
});

test('Given Trip 訂房狀態與追蹤欄位，When 清理 URL，Then 保留功能狀態並移除明確追蹤值', () => {
  const env = createUrlEnvironment(
    'https://hk.trip.com/hotels/detail?ages=7%2C10&cityId=1&roomkey=deluxe&roomToken=secret&trip_sub1=campaign&hasAidInUrl=true',
  );

  assert.equal(
    env.href(),
    'https://hk.trip.com/hotels/detail?ages=7%2C10&cityId=1&roomkey=deluxe&roomToken=secret',
  );
});

test('Given 長得像 Trip 的非 Trip hostname，When 清理 URL，Then 不套用 Trip 站點規則', () => {
  const env = createUrlEnvironment(
    'https://trip.com.evil.example/hotel?trip_sub1=keep&gclid=remove',
  );

  assert.equal(env.href(), 'https://trip.com.evil.example/hotel?trip_sub1=keep');
});

test('Given ClearURLs 遠端 provider，When URL pattern 符合，Then 仍以完整 URL 套用遠端規則', () => {
  const cachedRules = JSON.stringify({
    providers: {
      example: {
        urlPattern: '^https?://example\\.com/path',
        rules: ['remote_tracking'],
      },
    },
  });
  const env = createUrlEnvironment(
    'https://example.com/path?remote_tracking=remove&keep=yes',
    { cachedRules },
  );

  assert.equal(env.href(), 'https://example.com/path?keep=yes');
});

test('Given 含 credentials 的 URL，When 清理追蹤參數，Then 保留帳號密碼與其他 URL 元件', () => {
  const env = createUrlEnvironment(
    'https://user:pass@example.com/private?gclid=remove&keep=yes#section',
  );

  assert.equal(
    env.href(),
    'https://user:pass@example.com/private?keep=yes#section',
  );
});

test('Given IPv6 loopback URL，When userscript 啟動，Then 與其他本機 hostname 一樣完全略過', () => {
  const initialUrl = 'http://[::1]/dev?gclid=keep&state=local';
  const env = createUrlEnvironment(initialUrl);

  assert.equal(env.href(), initialUrl);
  assert.equal(env.replaceAttempts(), 0);
});

test('Given userscript 自己的 replaceState 暫時失敗，When 後續 history 再變更，Then 不向頁面拋錯且會重試清理', () => {
  let env;

  assert.doesNotThrow(() => {
    env = createUrlEnvironment(
      'https://example.com/page?gclid=first&keep=one',
      { replaceFailures: 1 },
    );
  });
  assert.equal(env.replaceAttempts(), 1);

  assert.doesNotThrow(() => {
    env.history.pushState({}, '', '?gclid=second&keep=two');
  });
  assert.equal(env.replaceAttempts(), 2);
  assert.equal(env.href(), 'https://example.com/page?keep=two');
});
