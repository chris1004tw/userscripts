'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readUserScript, runUserScript } = require('./helpers/userscript-harness');

const TEXT_RULE_URLS = {
  adguard: 'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_17_TrackParam/filter.txt',
  dandelion: 'https://raw.githubusercontent.com/DandelionSprout/adfilt/refs/heads/master/LegitimateURLShortener.txt',
  ublock: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/privacy-removeparam.txt',
};

/**
 * 建立通過遠端完整性門檻的小型測試清單，避免單行截斷內容被誤認為完整更新。
 *
 * @param {string} primaryRule 測試要觀察的主要規則。
 * @returns {string} 含主要規則與安全填充規則的 TXT 回應。
 */
function createValidTextRuleResponse(primaryRule) {
  const paddingRules = Array.from(
    { length: 500 },
    (_, index) => `$removeparam=test_padding_${index}`,
  );
  const exceptionRules = Array.from(
    { length: 10 },
    (_, index) => `@@||cache-validation.invalid^$removeparam=test_exception_${index}`,
  );
  return [primaryRule, ...paddingRules, ...exceptionRules].join('\n');
}

/**
 * 建立 URL 清理腳本需要的最小瀏覽器環境，並以實際 history 副作用觀察清理結果。
 *
 * @param {string} initialHref 測試起始網址。
 * @param {{cachedRules?: string, cachedTextRules?: Record<string, string | null>, textCacheTimes?: Record<string, number>, replaceFailures?: number, allowRequests?: boolean}} [options={}] 遠端規則快取、更新時間與模擬失敗次數。
 * @returns {{history: object, href: () => string, pageUrlChange: (url: string) => void, replaceAttempts: () => number, requestedSources: () => string[], respondTextSource: (sourceId: string, responseText: string, status?: number) => void, failTextSource: (sourceId: string, failure?: 'error' | 'timeout') => void}} 可操作的測試環境。
 */
function createUrlEnvironment(initialHref, options = {}) {
  let currentHref = initialHref;
  let remainingReplaceFailures = options.replaceFailures || 0;
  let replaceAttempts = 0;
  const listeners = new Map();
  const cachedRules = options.cachedRules || JSON.stringify({ providers: {} });
  const rawCachedTextRules = options.cachedTextRules || {
    adguard: '',
    dandelion: '',
    ublock: '',
  };
  const cachedTextRules = Object.fromEntries(
    Object.entries(rawCachedTextRules).map(([sourceId, text]) => [
      sourceId,
      text === null ? null : createValidTextRuleResponse(text),
    ]),
  );
  const textCacheTimes = options.textCacheTimes || {
    adguard: Date.now(),
    dandelion: Date.now(),
    ublock: Date.now(),
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
    onurlchange: null,
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
      for (const sourceId of Object.keys(TEXT_RULE_URLS)) {
        if (key === `textRules:${sourceId}`) {
          return Object.hasOwn(cachedTextRules, sourceId) ? cachedTextRules[sourceId] : fallback;
        }
        if (key === `textRulesTime:${sourceId}`) {
          return Object.hasOwn(textCacheTimes, sourceId) ? textCacheTimes[sourceId] : fallback;
        }
      }
      return fallback;
    },
    GM_setValue() {},
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
      // 模擬不同 JavaScript context 的頁面路由器改寫 URL，因此刻意不呼叫 userscript 包裝的 History API。
      updateLocation(url);
      listeners.get('urlchange')?.({ url: currentHref });
    },
    replaceAttempts: () => replaceAttempts,
    requestedSources() {
      return Object.entries(TEXT_RULE_URLS)
        .filter(([, url]) => pendingRequests.has(url))
        .map(([sourceId]) => sourceId);
    },
    respondTextSource(sourceId, responseText, status = 200) {
      const request = pendingRequests.get(TEXT_RULE_URLS[sourceId]);
      assert.ok(request, `找不到 ${sourceId} 的待處理請求`);
      request.onload({ status, responseText });
    },
    failTextSource(sourceId, failure = 'error') {
      const request = pendingRequests.get(TEXT_RULE_URLS[sourceId]);
      assert.ok(request, `找不到 ${sourceId} 的待處理請求`);
      if (failure === 'timeout') request.ontimeout();
      else request.onerror();
    },
  };
}

test('Given 一般網站的功能性短參數，When 清理 URL，Then 只移除跨站 click ID', () => {
  const env = createUrlEnvironment(
    'https://example.com/search?gclid=click&hl=zh-TW&tag=books&ufe=layout&from=home&src=nav&set=compact',
  );

  assert.equal(
    env.href(),
    'https://example.com/search?hl=zh-TW&tag=books&ufe=layout&from=home&src=nav&set=compact',
  );
});

test('Given Amazon 與淘寶追蹤參數，When 在對應站點清理，Then 站點參數被移除', () => {
  const amazon = createUrlEnvironment(
    'https://www.amazon.co.jp/dp/B0H17FSSHV?ufe=app_do%3Aamzn1.fos.35785624-70c4-44ae-a5c3-3f044f475d63&tag=affiliate&psc=1&item=kept',
  );
  const taobao = createUrlEnvironment(
    'https://item.taobao.com/item.htm?id=42&sku_properties=1627207%3A28341&pisk=token&rn=nonce&sourceId=campaign',
  );

  assert.equal(amazon.href(), 'https://www.amazon.co.jp/dp/B0H17FSSHV?item=kept');
  assert.equal(
    taobao.href(),
    'https://item.taobao.com/item.htm?id=42&sku_properties=1627207%3A28341',
  );
});

test('Given 未列名網域含高辨識度追蹤參數，When 清理 URL，Then 跨站移除並保留功能性資料', () => {
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

test('Given 長得像 Trip 的非 Trip hostname，When 清理 URL，Then 仍套用跨站追蹤規則', () => {
  const env = createUrlEnvironment(
    'https://trip.com.evil.example/hotel?trip_sub1=keep&gclid=remove',
  );

  assert.equal(env.href(), 'https://trip.com.evil.example/hotel');
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

test('Given 三份 TXT 各含精確或正規式規則，When 從快取載入，Then 合併清理且保留既有本地規則', () => {
  const env = createUrlEnvironment(
    'https://example.com/?ag_fixture=1&DS_FIXTURE_CAMPAIGN=2&ubo_fixture=3&ds_other=4&gclid=local&keep=yes',
    {
      cachedTextRules: {
        adguard: '! AdGuard 測試\n$removeparam=ag_fixture',
        dandelion: '! Dandelion 測試\n$doc,removeparam=/^ds_fixture_/i',
        ublock: '[Adblock Plus 2.0]\n$removeparam=ubo_fixture',
      },
    },
  );

  assert.equal(env.href(), 'https://example.com/?ds_other=4&keep=yes');
});

test('Given TXT 含已知與未知前處理器條件，When 以非 MV3 userscript 能力解析，Then 只套用確定啟用的分支', () => {
  const env = createUrlEnvironment(
    'https://example.com/?enabled=1&non_mv3=2&disabled=3&conditional_safe=4&unknown_safe=5&unknown=6&unknown_else=7&keep=yes',
    {
      cachedTextRules: {
        adguard: [
          '$removeparam=conditional_safe',
          '!#if (adguard_ext_chromium_mv3 || ext_ublock)',
          '$removeparam=disabled',
          '@@||example.com^$removeparam=conditional_safe',
          '!#else',
          '$removeparam=non_mv3',
          '!#endif',
        ].join('\n'),
        dandelion: [
          '$removeparam=unknown_safe',
          '!#if !ext_ubol',
          '$removeparam=enabled',
          '!#endif',
          '!#if unknown_capability',
          '$removeparam=unknown',
          '@@||example.com^$removeparam=unknown_safe',
          '!#else',
          '$removeparam=unknown_else',
          '!#endif',
        ].join('\n'),
        ublock: '',
      },
    },
  );

  assert.equal(
    env.href(),
    'https://example.com/?disabled=3&conditional_safe=4&unknown_safe=5&unknown=6&unknown_else=7&keep=yes',
  );
});

test('Given TXT 規則含 URL 與 hostname 範圍，When 清理不同網址，Then 只在符合範圍且非排除站點時移除', () => {
  const cachedTextRules = {
    adguard: '||shop.example/products/$removeparam=scoped_fixture',
    dandelion: '$removeparam=domain_fixture,domain=shop.example|~checkout.shop.example',
    ublock: '$to=target.example|~safe.target.example,removeparam=to_fixture\n$denyallow=login.example|safe.example,removeparam=deny_fixture\n||amazon.*^$removeparam=entity_url_fixture\n$removeparam=entity_scope_fixture,to=amazon.*',
  };

  assert.equal(
    createUrlEnvironment(
      'https://cdn.shop.example/products/42?scoped_fixture=1&domain_fixture=2&keep=yes',
      { cachedTextRules },
    ).href(),
    'https://cdn.shop.example/products/42?keep=yes',
  );
  assert.equal(
    createUrlEnvironment(
      'https://checkout.shop.example/products/42?scoped_fixture=1&domain_fixture=2&keep=yes',
      { cachedTextRules },
    ).href(),
    'https://checkout.shop.example/products/42?domain_fixture=2&keep=yes',
  );
  assert.equal(
    createUrlEnvironment(
      'https://safe.target.example/?to_fixture=1&deny_fixture=2&keep=yes',
      { cachedTextRules },
    ).href(),
    'https://safe.target.example/?to_fixture=1&keep=yes',
  );
  assert.equal(
    createUrlEnvironment(
      'https://shop.example.evil/products/42?scoped_fixture=1&domain_fixture=2&deny_fixture=3&keep=yes',
      { cachedTextRules },
    ).href(),
    'https://shop.example.evil/products/42?scoped_fixture=1&domain_fixture=2&keep=yes',
  );
  assert.equal(
    createUrlEnvironment(
      'https://amazon.com.evil/?entity_url_fixture=1&entity_scope_fixture=2&keep=yes',
      { cachedTextRules },
    ).href(),
    'https://amazon.com.evil/?entity_url_fixture=1&entity_scope_fixture=2&keep=yes',
  );
});

test('Given 一來源要求移除且另一來源提供例外，When URL 命中例外，Then 例外跨遠端來源優先但不覆寫本地規則', () => {
  const cachedTextRules = {
    adguard: '$removeparam=shared_fixture\n$removeparam=other_fixture',
    dandelion: '',
    ublock: '@@||safe.example^$removeparam=shared_fixture\n@@||safe.example^$removeparam=gclid',
  };
  const safe = createUrlEnvironment(
    'https://safe.example/?shared_fixture=1&other_fixture=2&gclid=local&keep=yes',
    { cachedTextRules },
  );
  const lookalike = createUrlEnvironment(
    'https://safe.example.evil/?shared_fixture=1&other_fixture=2&keep=yes',
    { cachedTextRules },
  );

  assert.equal(safe.href(), 'https://safe.example/?shared_fixture=1&keep=yes');
  assert.equal(lookalike.href(), 'https://safe.example.evil/?keep=yes');
});

test('Given TXT 規則含依參數值比對的正規式，When 同名參數有不同值，Then 只移除符合的項目並保留原始編碼', () => {
  const env = createUrlEnvironment(
    'https://example.com/?campaign=tracking&campaign=functional&signed=a%20b~c&keep=yes',
    {
      cachedTextRules: {
        adguard: '$removeparam=/^campaign=tracking$/',
        dandelion: '',
        ublock: '',
      },
    },
  );

  assert.equal(
    env.href(),
    'https://example.com/?campaign=functional&signed=a%20b~c&keep=yes',
  );
});

test('Given 三份 TXT 快取的新鮮度不同，When 啟動並更新過期來源，Then 只替換該來源規則', () => {
  const env = createUrlEnvironment(
    'https://example.com/?ag_cached=1&ds_old=1&ubo_cached=1&keep=yes',
    {
      cachedTextRules: {
        adguard: '$removeparam=ag_cached',
        dandelion: '$removeparam=ds_old',
        ublock: '$removeparam=ubo_cached',
      },
      textCacheTimes: {
        adguard: Date.now(),
        dandelion: 0,
        ublock: Date.now(),
      },
      allowRequests: true,
    },
  );

  assert.equal(env.href(), 'https://example.com/?keep=yes');
  assert.deepEqual(env.requestedSources(), ['dandelion']);

  env.respondTextSource(
    'dandelion',
    createValidTextRuleResponse('$removeparam=ds_new'),
  );
  env.history.pushState(
    {},
    '',
    'https://example.com/?ag_cached=1&ds_old=1&ds_new=1&ubo_cached=1&keep=yes',
  );

  assert.equal(env.href(), 'https://example.com/?ds_old=1&keep=yes');
});

test('Given 一來源更新失敗且另一來源成功，When 後續再次清理，Then 失敗來源沿用舊規則', () => {
  const env = createUrlEnvironment(
    'https://example.com/?ag_old=1&ds_old=1&ubo_cached=1&keep=yes',
    {
      cachedTextRules: {
        adguard: '$removeparam=ag_old',
        dandelion: '$removeparam=ds_old',
        ublock: '$removeparam=ubo_cached',
      },
      textCacheTimes: {
        adguard: 0,
        dandelion: 0,
        ublock: Date.now(),
      },
      allowRequests: true,
    },
  );

  assert.deepEqual(env.requestedSources(), ['adguard', 'dandelion']);
  env.failTextSource('adguard', 'timeout');
  env.respondTextSource(
    'dandelion',
    createValidTextRuleResponse('$removeparam=ds_new'),
  );
  env.history.pushState(
    {},
    '',
    'https://example.com/?ag_old=1&ds_old=1&ds_new=1&ubo_cached=1&keep=yes',
  );

  assert.equal(env.href(), 'https://example.com/?ds_old=1&keep=yes');
});

test('Given 過期來源只回傳截斷規則，When HTTP 狀態成功，Then 仍拒絕取代最後成功快取', () => {
  const env = createUrlEnvironment(
    'https://example.com/?ag_old=1&keep=yes',
    {
      cachedTextRules: {
        adguard: '$removeparam=ag_old',
        dandelion: '',
        ublock: '',
      },
      textCacheTimes: {
        adguard: 0,
        dandelion: Date.now(),
        ublock: Date.now(),
      },
      allowRequests: true,
    },
  );

  env.respondTextSource('adguard', '$removeparam=ag_truncated');
  env.history.pushState(
    {},
    '',
    'https://example.com/?ag_old=1&ag_truncated=1&keep=yes',
  );

  assert.equal(env.href(), 'https://example.com/?ag_truncated=1&keep=yes');
});

test('Given 首次安裝沒有 TXT 快取，When 三來源尚未全部完成，Then 先清本地規則並延後遠端清理', () => {
  const env = createUrlEnvironment(
    'https://example.com/?gclid=local&ag_first_install=1&keep=yes',
    {
      cachedTextRules: {
        adguard: null,
        dandelion: null,
        ublock: null,
      },
      textCacheTimes: {
        adguard: 0,
        dandelion: 0,
        ublock: 0,
      },
      allowRequests: true,
    },
  );

  assert.equal(env.href(), 'https://example.com/?ag_first_install=1&keep=yes');
  assert.deepEqual(env.requestedSources(), ['adguard', 'dandelion', 'ublock']);

  env.respondTextSource(
    'adguard',
    createValidTextRuleResponse('$removeparam=ag_first_install'),
  );
  env.respondTextSource('dandelion', createValidTextRuleResponse(''));
  assert.equal(env.href(), 'https://example.com/?ag_first_install=1&keep=yes');

  env.failTextSource('ublock');
  assert.equal(env.href(), 'https://example.com/?keep=yes');
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
  assert.match(
    readUserScript('remove-url-tracker.user.js'),
    /^\/\/ @grant\s+window\.onurlchange$/m,
  );
});
