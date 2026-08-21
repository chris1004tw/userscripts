'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readUserScript, runUserScript } = require('./helpers/userscript-harness');

const REMOTE_SOURCE_URLS = {
  clearurls: 'https://rules1.clearurls.xyz/data.minify.json',
  brave: 'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/clean-urls.json',
  firefox: 'https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/query-stripping/records',
};

const EMPTY_SOURCE_DATA = {
  clearurls: JSON.stringify({ providers: {} }),
  brave: JSON.stringify([]),
  firefox: JSON.stringify({ data: [] }),
};

/**
 * 建立 URL 清理腳本需要的最小瀏覽器環境，並觀察 History API 與 GM 儲存副作用。
 *
 * @param {string} initialHref 測試起始網址。
 * @param {{cachedSources?: Record<string, string | null>, cacheTimes?: Record<string, number>, storage?: Map<string, unknown>, replaceFailures?: number, allowRequests?: boolean, supportsUrlChange?: boolean}} [options={}] 遠端快取、更新時間、共用 GM 儲存與瀏覽器能力。
 * @returns {{history: object, href: () => string, pageUrlChange: (url: string) => void, replaceAttempts: () => number, requestedSources: () => string[], requestedUrls: () => string[], gmGetKeys: () => string[], gmSetValues: () => Array<[string, unknown]>, gmDeletedKeys: () => string[], urlParseCount: () => number, historyWasWrapped: () => boolean, respondSource: (sourceId: string, responseText: string, status?: number) => void, failSource: (sourceId: string, failure?: 'error' | 'timeout') => void}} 可操作的測試環境。
 * @sideeffect 執行正式 userscript 並記錄 URL、History API、GM 讀取、寫入、刪除與網路請求。
 */
function createUrlEnvironment(initialHref, options = {}) {
  let currentHref = initialHref;
  let remainingReplaceFailures = options.replaceFailures || 0;
  let replaceAttempts = 0;
  let urlParseCount = 0;
  const listeners = new Map();
  const gmGetKeys = [];
  const gmSetValues = [];
  const gmDeletedKeys = [];
  const storage = options.storage || new Map();
  const supportsUrlChange = options.supportsUrlChange !== false;
  const cachedSources = { ...EMPTY_SOURCE_DATA, ...(options.cachedSources || {}) };
  const cacheTimes = {
    clearurls: Date.now(),
    brave: Date.now(),
    firefox: Date.now(),
    ...(options.cacheTimes || {}),
  };
  const pendingRequests = new Map();

  const location = {};
  Object.defineProperty(location, 'href', {
    get: () => currentHref,
    set: value => { currentHref = new URL(String(value), currentHref).href; },
  });

  /**
   * 依照 History API 的相對網址語意更新測試 location。
   *
   * @param {string | URL | null | undefined} url 新網址；省略時維持原值。
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
      if (supportsUrlChange) listeners.get('urlchange')?.({ url: currentHref });
    },
    replaceState(state, _title, url) {
      replaceAttempts += 1;
      if (remainingReplaceFailures > 0) {
        remainingReplaceFailures -= 1;
        throw new Error('模擬 replaceState 失敗');
      }
      this.state = state;
      updateLocation(url);
      if (supportsUrlChange) listeners.get('urlchange')?.({ url: currentHref });
    },
  };
  const nativePushState = history.pushState;
  const nativeReplaceState = history.replaceState;

  const window = {
    onurlchange: supportsUrlChange ? null : undefined,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };
  const document = {
    readyState: 'complete',
    addEventListener() {},
  };

  class CountingURL extends URL {
    /**
     * 計數 userscript 建立 URL 的次數。
     *
     * @param {...ConstructorParameters<typeof URL>} args 原生 URL 建構參數。
     */
    constructor(...args) {
      super(...args);
      urlParseCount += 1;
    }
  }

  runUserScript('remove-url-tracker.user.js', {
    URL: CountingURL,
    window,
    document,
    history,
    location,
    GM_getValue(key, fallback) {
      gmGetKeys.push(key);
      for (const sourceId of Object.keys(REMOTE_SOURCE_URLS)) {
        if (key === `remoteRules:${sourceId}`) {
          return Object.hasOwn(cachedSources, sourceId) ? cachedSources[sourceId] : fallback;
        }
        if (key === `remoteRulesTime:${sourceId}`) {
          return Object.hasOwn(cacheTimes, sourceId) ? cacheTimes[sourceId] : fallback;
        }
      }
      return storage.has(key) ? storage.get(key) : fallback;
    },
    GM_setValue(key, value) {
      gmSetValues.push([key, value]);
      storage.set(key, value);
    },
    GM_deleteValue(key) {
      gmDeletedKeys.push(key);
      storage.delete(key);
    },
    GM_xmlhttpRequest(request) {
      if (!options.allowRequests) {
        throw new Error('有效快取存在時不應發出遠端請求');
      }
      pendingRequests.set(request.url, request);
    },
  });

  return {
    history,
    href: () => currentHref,
    pageUrlChange(url) {
      updateLocation(url);
      listeners.get('urlchange')?.({ url: currentHref });
    },
    replaceAttempts: () => replaceAttempts,
    requestedSources() {
      return Object.entries(REMOTE_SOURCE_URLS)
        .filter(([, url]) => pendingRequests.has(url))
        .map(([sourceId]) => sourceId);
    },
    requestedUrls: () => [...pendingRequests.keys()],
    gmGetKeys: () => [...gmGetKeys],
    gmSetValues: () => [...gmSetValues],
    gmDeletedKeys: () => [...gmDeletedKeys],
    urlParseCount: () => urlParseCount,
    historyWasWrapped: () => history.pushState !== nativePushState ||
      history.replaceState !== nativeReplaceState,
    respondSource(sourceId, responseText, status = 200) {
      const request = pendingRequests.get(REMOTE_SOURCE_URLS[sourceId]);
      assert.ok(request, `找不到 ${sourceId} 的待處理請求`);
      request.onload({ status, responseText });
    },
    failSource(sourceId, failure = 'error') {
      const request = pendingRequests.get(REMOTE_SOURCE_URLS[sourceId]);
      assert.ok(request, `找不到 ${sourceId} 的待處理請求`);
      if (failure === 'timeout') request.ontimeout();
      else request.onerror();
    },
  };
}

test('Given userscript metadata，When Tampermonkey 判斷注入與來源權限，Then 禁止子 frame 並只連線三個 JSON 來源', () => {
  const source = readUserScript('remove-url-tracker.user.js');
  assert.match(source, /^\/\/ @noframes\s*$/m);
  assert.match(source, /^\/\/ @connect\s+rules1\.clearurls\.xyz$/m);
  assert.match(source, /^\/\/ @connect\s+raw\.githubusercontent\.com$/m);
  assert.match(source, /^\/\/ @connect\s+firefox\.settings\.services\.mozilla\.com$/m);
  assert.match(source, /^\/\/ @grant\s+GM_deleteValue$/m);
  assert.doesNotMatch(source, /AdguardTeam|DandelionSprout|uBlockOrigin|\$removeparam/);
});
test('Given 舊版八個遠端快取鍵存在，When 腳本首次啟動，Then 一次清除舊鍵並以版本標記避免再次遷移', () => {
  const legacyKeys = [
    'cachedRules',
    'cacheTime',
    'textRules:adguard',
    'textRulesTime:adguard',
    'textRules:dandelion',
    'textRulesTime:dandelion',
    'textRules:ublock',
    'textRulesTime:ublock',
  ];
  const storage = new Map(legacyKeys.map(key => [key, 'legacy']));
  storage.set('unrelatedKey', 'keep');
  const first = createUrlEnvironment('https://example.com/path', { storage });

  assert.deepEqual(first.gmDeletedKeys(), legacyKeys);
  assert.equal(storage.get('remoteRulesMigrationVersion'), 1);
  assert.equal(storage.get('unrelatedKey'), 'keep');

  const second = createUrlEnvironment('https://example.com/path', { storage });
  assert.deepEqual(second.gmDeletedKeys(), []);
});


test('Given 頁面尚無 query，When SPA 首次加入 query，Then 延後且只初始化一次三來源快取', () => {
  const env = createUrlEnvironment('https://example.com/path', {
    cachedSources: {
      clearurls: JSON.stringify({ providers: { example: {
        urlPattern: '^https?://example\\.com/',
        rules: ['clearurls_fixture'],
      } } }),
      brave: JSON.stringify([{
        include: ['*://example.com/*'],
        exclude: [],
        params: ['brave_fixture'],
      }]),
      firefox: JSON.stringify({ data: [{
        stripList: ['firefox_fixture'],
        allowList: [],
      }] }),
    },
  });

  assert.deepEqual(env.gmGetKeys(), ['remoteRulesMigrationVersion']);
  env.pageUrlChange('https://example.com/path?clearurls_fixture=1&brave_fixture=2&firefox_fixture=3&keep=yes');
  assert.equal(env.href(), 'https://example.com/path?keep=yes');

  const readsAfterInitialization = env.gmGetKeys();
  env.pageUrlChange('https://example.com/next?brave_fixture=1&keep=next');
  assert.equal(env.href(), 'https://example.com/next?keep=next');
  assert.deepEqual(env.gmGetKeys(), readsAfterInitialization);
});

test('Given query 可由本地規則全部移除，When 啟動與後續 SPA 出現未知參數，Then 只在需要時初始化遠端來源', () => {
  const env = createUrlEnvironment('https://example.com/path?gclid=click&utm_source=campaign#section', {
    cachedSources: {
      brave: JSON.stringify([{
        include: ['*://example.com/*'],
        exclude: [],
        params: ['remote_after_local'],
      }]),
    },
  });

  assert.equal(env.href(), 'https://example.com/path#section');
  assert.deepEqual(env.gmGetKeys(), ['remoteRulesMigrationVersion']);
  env.pageUrlChange('https://example.com/path?remote_after_local=remove&keep=yes#section');
  assert.equal(env.href(), 'https://example.com/path?keep=yes#section');
  assert.ok(env.gmGetKeys().length > 0);
});

test('Given ClearURLs provider 依賴完整原始 URL 且有例外，When 清理 query，Then 使用刪除前網址並尊重 provider 例外', () => {
  const cachedSources = {
    clearurls: JSON.stringify({ providers: { example: {
      urlPattern: '^https?://example\\.com/path\\?gclid=local',
      rules: ['remote_tracking'],
      exceptions: ['[?&]safe=1(?:&|$)'],
    } } }),
  };
  const cleaned = createUrlEnvironment(
    'https://example.com/path?gclid=local&remote_tracking=remove&keep=yes',
    { cachedSources },
  );
  const excepted = createUrlEnvironment(
    'https://example.com/path?gclid=local&remote_tracking=keep&safe=1',
    { cachedSources },
  );

  assert.equal(cleaned.href(), 'https://example.com/path?keep=yes');
  assert.equal(excepted.href(), 'https://example.com/path?remote_tracking=keep&safe=1');
});

test('Given Brave include 與 exclude URL glob，When 清理符合、排除與 lookalike 網址，Then 只套用精確範圍', () => {
  const cachedSources = {
    brave: JSON.stringify([{
      include: ['*://*.example.com/products/*'],
      exclude: ['*://checkout.example.com/*'],
      params: ['brave_tracking'],
    }]),
  };

  assert.equal(
    createUrlEnvironment('https://shop.example.com/products/42?brave_tracking=1&keep=yes', { cachedSources }).href(),
    'https://shop.example.com/products/42?keep=yes',
  );
  assert.equal(
    createUrlEnvironment('https://checkout.example.com/products/42?brave_tracking=1&keep=yes', { cachedSources }).href(),
    'https://checkout.example.com/products/42?brave_tracking=1&keep=yes',
  );
  assert.equal(
    createUrlEnvironment('https://shop.example.com.evil/products/42?brave_tracking=1&keep=yes', { cachedSources }).href(),
    'https://shop.example.com.evil/products/42?brave_tracking=1&keep=yes',
  );
});

test('Given Firefox stripList、allowList 與不支援的 filter_expression，When 編譯來源，Then 套用全域清單並安全跳過條件紀錄', () => {
  const cachedSources = {
    firefox: JSON.stringify({ data: [
      { stripList: ['firefox_tracking'], allowList: ['safe.example'] },
      { stripList: ['conditional_tracking'], allowList: [], filter_expression: 'env.version|versionCompare("120") >= 0' },
    ] }),
  };

  assert.equal(
    createUrlEnvironment('https://example.com/?firefox_tracking=1&conditional_tracking=2&keep=yes', { cachedSources }).href(),
    'https://example.com/?conditional_tracking=2&keep=yes',
  );
  assert.equal(
    createUrlEnvironment('https://sub.safe.example/?firefox_tracking=1&keep=yes', { cachedSources }).href(),
    'https://sub.safe.example/?firefox_tracking=1&keep=yes',
  );
});

test('Given 沒有 last-known-good，When 三來源首次回應可解析但編譯為空陣列，Then 不寫入快取、不推進世代且不改網址', () => {
  const emptyResponses = {
    clearurls: JSON.stringify({ providers: {} }),
    brave: JSON.stringify([]),
    firefox: JSON.stringify({ data: [] }),
  };

  for (const sourceId of Object.keys(emptyResponses)) {
    const env = createUrlEnvironment(`https://example.com/?${sourceId}_empty=1&keep=yes`, {
      cachedSources: { clearurls: null, brave: null, firefox: null },
      cacheTimes: { clearurls: 0, brave: 0, firefox: 0 },
      allowRequests: true,
    });
    const initialHref = env.href();
    const initialParseCount = env.urlParseCount();

    env.respondSource(sourceId, emptyResponses[sourceId]);

    assert.equal(env.href(), initialHref);
    assert.deepEqual(
      env.gmSetValues().filter(([key]) => key.startsWith('remoteRules:') || key.startsWith('remoteRulesTime:')),
      [],
    );
    env.pageUrlChange(initialHref);
    assert.equal(env.urlParseCount(), initialParseCount);
  }
});

test('Given 三來源皆無快取，When 首個 JSON 來源成功回應，Then 不等待其他來源即可發布新規則', () => {
  const env = createUrlEnvironment('https://example.com/?remote_first=1&keep=yes', {
    cachedSources: { clearurls: null, brave: null, firefox: null },
    cacheTimes: { clearurls: 0, brave: 0, firefox: 0 },
    allowRequests: true,
  });

  assert.deepEqual(env.requestedSources(), ['clearurls', 'brave', 'firefox']);
  assert.equal(env.href(), 'https://example.com/?remote_first=1&keep=yes');

  env.respondSource('clearurls', JSON.stringify({ providers: { example: {
    urlPattern: '^https?://example\\.com/',
    rules: ['remote_first'],
  } } }));
  assert.equal(env.href(), 'https://example.com/?keep=yes');
});

test('Given 過期來源有最後成功快取，When 更新失敗或 JSON 無效，Then 繼續使用舊規則', () => {
  const cachedSources = {
    clearurls: JSON.stringify({ providers: { example: {
      urlPattern: '^https?://example\\.com/',
      rules: ['old_rule'],
    } } }),
  };
  const env = createUrlEnvironment('https://example.com/?old_rule=1&keep=yes', {
    cachedSources,
    cacheTimes: { clearurls: 0 },
    allowRequests: true,
  });

  assert.equal(env.href(), 'https://example.com/?keep=yes');
  assert.deepEqual(env.requestedSources(), ['clearurls']);
  env.respondSource('clearurls', '{"providers":');
  env.history.pushState({}, '', 'https://example.com/?old_rule=2&new_rule=3&keep=next');
  assert.equal(env.href(), 'https://example.com/?new_rule=3&keep=next');
});

test('Given 相同 href 已處理，When 過期 Brave 來源發布新規則，Then 規則世代會重新清理', () => {
  const env = createUrlEnvironment('https://example.com/?new_generation=1&keep=yes', {
    cacheTimes: { brave: 0 },
    allowRequests: true,
  });

  assert.equal(env.href(), 'https://example.com/?new_generation=1&keep=yes');
  env.respondSource('brave', JSON.stringify([{
    include: ['*://example.com/*'],
    exclude: [],
    params: ['new_generation'],
  }]));
  assert.equal(env.href(), 'https://example.com/?keep=yes');
});

test('Given Tampermonkey 支援或不支援 urlchange，When 安裝 SPA 監聽，Then 優先原生事件並保留 History fallback', () => {
  const nativeEnv = createUrlEnvironment('https://example.com/?keep=yes');
  assert.equal(nativeEnv.historyWasWrapped(), false);
  nativeEnv.history.pushState({}, '', '?gclid=remove&keep=native');
  assert.equal(nativeEnv.href(), 'https://example.com/?keep=native');

  const fallbackEnv = createUrlEnvironment('https://example.com/?keep=yes', { supportsUrlChange: false });
  assert.equal(fallbackEnv.historyWasWrapped(), true);
  fallbackEnv.history.pushState({}, '', '?gclid=remove&keep=fallback');
  assert.equal(fallbackEnv.href(), 'https://example.com/?keep=fallback');
});

test('Given 相同 href 重複發出導航事件，When 規則世代未改變，Then 不重複解析 URL', () => {
  const env = createUrlEnvironment('https://example.com/?keep=yes');
  const parsesAfterFirstClean = env.urlParseCount();
  env.pageUrlChange(env.href());
  env.pageUrlChange(env.href());
  assert.equal(env.urlParseCount(), parsesAfterFirstClean);
});

test('Given 一般網站的功能性短參數，When 清理 URL，Then 只移除跨站 click ID', () => {
  const env = createUrlEnvironment(
    'https://example.com/search?gclid=click&hl=zh-TW&tag=books&ufe=layout&from=home&src=nav&set=compact',
  );
  assert.equal(
    env.href(),
    'https://example.com/search?hl=zh-TW&tag=books&ufe=layout&from=home&src=nav&set=compact',
  );
});

test('Given Instagram 與其他網站都含 igsi，When 清理 URL，Then 只移除 Instagram 分享追蹤參數', () => {
  const instagram = createUrlEnvironment(
    'https://www.instagram.com/p/DcNVSvfAfiV/?igsi=NTc4MTIwNjQ2YQ%3D%3D',
  );
  const otherSite = createUrlEnvironment('https://example.com/search?igsi=functional&keep=yes');
  assert.equal(instagram.href(), 'https://www.instagram.com/p/DcNVSvfAfiV/');
  assert.equal(otherSite.href(), 'https://example.com/search?igsi=functional&keep=yes');
});

test('Given Amazon 與淘寶追蹤參數，When 在對應站點清理，Then 站點參數被移除且商品狀態保留', () => {
  const amazon = createUrlEnvironment(
    'https://www.amazon.co.jp/dp/B0H17FSSHV?ufe=layout&tag=affiliate&psc=1&item=kept',
  );
  const taobao = createUrlEnvironment(
    'https://item.taobao.com/item.htm?id=42&sku_properties=1627207%3A28341&pisk=token&rn=nonce&sourceId=campaign',
  );
  assert.equal(amazon.href(), 'https://www.amazon.co.jp/dp/B0H17FSSHV?item=kept');
  assert.equal(taobao.href(), 'https://item.taobao.com/item.htm?id=42&sku_properties=1627207%3A28341');
});

test('Given 未列名網域含高辨識度參數，When 清理 URL，Then 跨站移除並保留功能性資料', () => {
  const env = createUrlEnvironment(
    'https://shop.example.com/item?ved=google&action_ref_map=facebook&ref_src=x&ascsubtag=amazon&pisk=taobao&uls_trackid=shopee&trip_sub1=trip&trkCampaign=linkedin&source=search&type=book&ref=detail&s=sort&t=tab&feature=grid&si=session&tag=category&linkId=record&rn=page&sourceId=source&seoName=slug&d_id=device&trk=route&mm_unit=layout',
  );
  assert.equal(
    env.href(),
    'https://shop.example.com/item?source=search&type=book&ref=detail&s=sort&t=tab&feature=grid&si=session&tag=category&linkId=record&rn=page&sourceId=source&seoName=slug&d_id=device&trk=route&mm_unit=layout',
  );
});

test('Given 未列名網域含平台專用追蹤前綴，When 清理 URL，Then 跨站移除高辨識度前綴', () => {
  const env = createUrlEnvironment(
    'https://example.com/page?fb_action_ids=facebook&pf_rd_p=amazon&pd_rd_r=amazon&ali_trackid=taobao&keep=yes',
  );
  assert.equal(env.href(), 'https://example.com/page?keep=yes');
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

test('Given 含 credentials 與原始編碼的 URL，When 清理追蹤參數，Then 保留其他 URL 元件與 query 編碼', () => {
  const env = createUrlEnvironment(
    'https://user:pass@example.com/private?gclid=remove&signed=a%20b~c&keep=yes#section',
  );
  assert.equal(
    env.href(),
    'https://user:pass@example.com/private?signed=a%20b~c&keep=yes#section',
  );
});

test('Given IPv6 loopback URL，When userscript 啟動，Then 與其他本機 hostname 一樣完全略過', () => {
  const initialUrl = 'http://[::1]/dev?gclid=keep&state=local';
  const env = createUrlEnvironment(initialUrl);
  assert.equal(env.href(), initialUrl);
  assert.equal(env.replaceAttempts(), 0);
});

test('Given userscript 的 replaceState 暫時失敗，When 後續 history 再變更，Then 不向頁面拋錯且會重試', () => {
  let env;
  assert.doesNotThrow(() => {
    env = createUrlEnvironment('https://example.com/page?gclid=first&keep=one', { replaceFailures: 1 });
  });
  assert.equal(env.replaceAttempts(), 1);
  assert.doesNotThrow(() => {
    env.history.pushState({}, '', '?gclid=second&keep=two');
  });
  assert.equal(env.replaceAttempts(), 2);
  assert.equal(env.href(), 'https://example.com/page?keep=two');
});

test('Given Facebook SPA 在頁面 context 寫回追蹤參數，When Tampermonkey 發出 urlchange，Then 再次清除參數', () => {
  const env = createUrlEnvironment(
    'https://www.facebook.com/groups/382189418643825/?multi_permalinks=3121063718089701',
  );
  env.pageUrlChange(
    'https://www.facebook.com/groups/382189418643825/?multi_permalinks=3121063718089701&hoisted_section_header_type=recently_seen',
  );
  assert.equal(
    env.href(),
    'https://www.facebook.com/groups/382189418643825/?multi_permalinks=3121063718089701',
  );
  assert.match(readUserScript('remove-url-tracker.user.js'), /^\/\/ @grant\s+window\.onurlchange$/m);
});
