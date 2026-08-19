// ==UserScript==
// @name         移除 URL 追蹤
// @namespace    https://chris.taipei
// @version      0.4.8
// @description  自動移除網址中的追蹤參數，簡化分享連結並保護隱私
// @author       chris1004tw
// @match        *://*/*
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        window.onurlchange
// @connect      rules1.clearurls.xyz
// @connect      raw.githubusercontent.com
// @connect      firefox.settings.services.mozilla.com
// @run-at       document-start
// @updateURL    https://github.com/chris1004tw/userscripts/raw/main/remove-url-tracker.user.js
// @downloadURL  https://github.com/chris1004tw/userscripts/raw/main/remove-url-tracker.user.js
// ==/UserScript==
// Co-authored with Claude Opus 4.6 Thinking
// Co-authored with ChatGPT 5.6 Sol Ultra
// 維護索引：README.md「維護索引」

(function () {
    'use strict';

    /**
     * @typedef {Object} SiteRule
     * @property {RegExp} hostnamePattern 精確比對解析後 hostname 的規則。
     * @property {Set<string>} params 容易誤殺、僅限該站點移除的查詢參數。
     * @property {RegExp[]} [regexParams] 僅限該站點套用的參數名稱規則。
     * @property {RegExp[]} [except] 不應套用規則的完整 URL 例外。
     */

    /**
     * @typedef {Object} RemoteRule
     * @property {RegExp} pattern 允許套用規則的完整 URL pattern。
     * @property {RegExp[]} exceptions 禁止套用規則的完整 URL 例外。
     * @property {Set<string>} stringRules 完全相符的參數名稱。
     * @property {RegExp[]} regexRules 以正規表示式比對的參數名稱。
     */

    /**
     * @typedef {Object} RemoteRuleSource
     * @property {string} id 穩定的快取識別字。
     * @property {string} url 官方 JSON 下載網址。
     * @property {number} maxAge 快取有效毫秒數。
     * @property {(data: unknown) => RemoteRule[] | null} compile 將來源格式正規化為共用規則。
     */

    /**
     * @typedef {Object} QueryPair
     * @property {string} raw 未改寫的原始查詢片段。
     * @property {string} name 解碼後的參數名稱。
     */

    /**
     * @typedef {Object} LocalCleaningContext
     * @property {QueryPair[]} pairs 保留原始編碼與順序的查詢參數。
     * @property {Set<string>} siteParams 目前 hostname 可安全移除的站點限定名稱。
     * @property {RegExp[]} siteRegexes 目前 hostname 可安全套用的站點限定名稱規則。
     */

    const ONE_HOUR = 3600000;
    const MAX_REMOTE_RESPONSE_SIZE = 2000000;
    const SKIP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '']);
    const SKIP_PROTOCOLS = new Set(['file:', 'data:', 'javascript:']);
    const REMOTE_CACHE_MIGRATION_KEY = 'remoteRulesMigrationVersion';
    const REMOTE_CACHE_MIGRATION_VERSION = 1;
    const LEGACY_REMOTE_CACHE_KEYS = [
        'cachedRules',
        'cacheTime',
        'textRules:adguard',
        'textRulesTime:adguard',
        'textRules:dandelion',
        'textRulesTime:dandelion',
        'textRules:ublock',
        'textRulesTime:ublock'
    ];

    /** @type {RemoteRuleSource[]} */
    const REMOTE_RULE_SOURCES = [
        {
            id: 'clearurls',
            url: 'https://rules1.clearurls.xyz/data.minify.json',
            maxAge: ONE_HOUR,
            compile: compileClearUrlsRules
        },
        {
            id: 'brave',
            url: 'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/clean-urls.json',
            maxAge: 24 * ONE_HOUR,
            compile: compileBraveRules
        },
        {
            id: 'firefox',
            url: 'https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/query-stripping/records',
            maxAge: 24 * ONE_HOUR,
            compile: compileFirefoxRules
        }
    ];

    // 特定網域只保留可能承載功能狀態的歧義參數；hostnamePattern 必須錨定結尾以排除 lookalike。
    /** @type {SiteRule[]} */
    const SITE_RULES = [
        {
            hostnamePattern: /^(?:[a-z0-9-]+\.)*google\.(?:(?:com|co)\.)?[a-z]{2}$|^(?:[a-z0-9-]+\.)*google\.com$/i,
            params: new Set(['source', 'ei', 'sxsrf']),
            except: [/^https?:\/\/mail\.google\.com\//i]
        },
        {
            hostnamePattern: /^(?:[a-z0-9-]+\.)*facebook\.com$/i,
            params: new Set(['share_url', 'type', 'ref', 'ref_url', 'hoisted_section_header_type'])
        },
        {
            hostnamePattern: /^(?:[a-z0-9-]+\.)*(?:twitter\.com|x\.com)$/i,
            params: new Set(['s', 't'])
        },
        {
            hostnamePattern: /^(?:[a-z0-9-]+\.)*youtube\.com$/i,
            params: new Set(['feature', 'kw', 'pp', 'si']),
            except: [/^https?:\/\/(?:[a-z0-9-]+\.)*?youtube\.com\/redirect/i]
        },
        {
            hostnamePattern: /^(?:[a-z0-9-]+\.)*amazon\.(?:(?:com|co)\.)?[a-z]{2}$|^(?:[a-z0-9-]+\.)*amazon\.com$/i,
            params: new Set(['tag', 'psc', 'ufe', 'linkCode', 'linkId', 'camp', 'creative'])
        },
        {
            hostnamePattern: /^(?:[a-z0-9-]+\.)*(?:taobao\.com|tmall\.com|tmall\.hk)$/i,
            // sku_properties 代表使用者選定的商品款式，刻意不列入任何移除規則。
            params: new Set([
                'ns', 'source', 'xxc', 'mi_id', 'initiative_id', 'clientPreloadId',
                'preLoadOrigin', 'rn', 'sourceId', 'ssid', 'suggest_query', 'wq'
            ]),
            // mm_ 是常見自訂欄位前綴，只有阿里系站點才能安全移除。
            regexParams: [/^mm_/]
        },
        {
            hostnamePattern: /^(?:[a-z0-9-]+\.)*shopee\.(?:(?:com|co)\.)?[a-z]{2}$|^(?:[a-z0-9-]+\.)*shopee\.(?:sg|ph|vn|tw|cl|pl)$/i,
            params: new Set(['seoName', 'd_id'])
        },
        {
            hostnamePattern: /^(?:[a-z0-9-]+\.)*linkedin\.com$/i,
            params: new Set(['trk'])
        }
    ];

    // 高辨識度追蹤名稱直接跨站清除，避免同一參數出現在導轉站或合作網域時還要逐站加規則。
    const GENERAL_STRING_PARAMS = new Set([
        'yclid', 'fbclid', 'gclid', 'dclid', 'msclkid', 'twclid', 'igshid', 'mibextid', 'srsltid',
        'ved', 'gs_l', 'gs_lcp', 'sclient', 'rlz', 'ICID',
        'action_history', 'action_type_map', 'action_ref_map', 'referrer', 'origin_source',
        'rdid', 'idorvanity', 'referral_story_type', 'ref_src',
        'ascsubtag', 'ref_',
        'priceTId', 'abbucket', 'pisk', 'spm', 'scm', 'xmt', 'slof',
        'uls_trackid',
        'masterhotelid_tracelogid', 'trip_sub1', 'hasAidInUrl',
        'trkCampaign',
        'mc_cid', 'mc_eid', 'mkt_tok', 'nr_email_referer', 'vero_conv', 'vero_id',
        'oly_anon_id', 'oly_enc_id', 'wickedid'
    ]);
    const GENERAL_REGEX_PARAMS = [
        /^utm_/, /^ga_/, /^fb_/, /^pf_rd_/, /^pd_rd_/, /^ali_/
    ];

    /** @type {Map<string, RemoteRule[]>} */
    const remoteRulesBySource = new Map();
    /** @type {Map<string, number>} */
    const remoteSourceLengths = new Map();
    /** @type {RemoteRule[]} */
    let remoteRules = [];
    let remoteRulesInitialized = false;
    let ruleGeneration = 0;
    let lastProcessedHref = null;
    let lastProcessedRuleGeneration = -1;
    let cleaning = false;

    /**
     * 判斷解析後 URL 是否符合一條本地站點規則。
     *
     * @param {URL} urlObj 已完成解析的網址物件。
     * @param {SiteRule} rule 待驗證的站點規則。
     * @returns {boolean} hostname 符合且未命中例外時為 true。
     */
    function matchesSiteRule(urlObj, rule) {
        if (!rule.hostnamePattern.test(urlObj.hostname)) return false;
        return !rule.except?.some(exception => exception.test(urlObj.href));
    }

    /**
     * 解碼單一查詢參數名稱，解析失敗時保留可比較的原字串。
     *
     * @param {string} value 尚未解碼的參數名稱。
     * @returns {string} 解碼後字串。
     */
    function decodeQueryComponent(value) {
        try {
            return decodeURIComponent(value.replace(/\+/g, ' '));
        } catch {
            return value.replace(/\+/g, ' ');
        }
    }

    /**
     * 解析查詢片段並保留原始編碼，只解碼規則判定需要的參數名稱。
     *
     * @param {string} raw 未含 `&` 的原始查詢片段。
     * @returns {QueryPair} 可判定名稱且能原樣重建 query 的資料。
     */
    function parseQueryPair(raw) {
        const separatorIndex = raw.indexOf('=');
        const rawName = separatorIndex >= 0 ? raw.slice(0, separatorIndex) : raw;
        return { raw, name: decodeQueryComponent(rawName) };
    }

    /**
     * 解析一次 query 並收集目前 hostname 適用的本地站點規則。
     *
     * @param {URL} urlObj 已解析且含可處理 query 的網址。
     * @returns {LocalCleaningContext} 可供本地快路徑與完整清理重用的資料。
     */
    function createLocalCleaningContext(urlObj) {
        const siteParams = new Set();
        const siteRegexes = [];
        for (const rule of SITE_RULES) {
            if (!matchesSiteRule(urlObj, rule)) continue;
            for (const param of rule.params) siteParams.add(param);
            siteRegexes.push(...(rule.regexParams || []));
        }
        return {
            pairs: urlObj.search.slice(1).split('&').map(parseQueryPair),
            siteParams,
            siteRegexes
        };
    }

    /**
     * 判斷單一 query pair 是否由本地明確規則移除。
     *
     * @param {QueryPair} pair 待判斷的查詢參數。
     * @param {LocalCleaningContext} context 目前網址的本地規則 context。
     * @returns {boolean} 本地通用或站點限定規則命中時為 true。
     */
    function isLocalRemoval(pair, context) {
        return GENERAL_STRING_PARAMS.has(pair.name) ||
            context.siteParams.has(pair.name) ||
            context.siteRegexes.some(pattern => pattern.test(pair.name)) ||
            GENERAL_REGEX_PARAMS.some(pattern => pattern.test(pair.name));
    }

    /**
     * 將 Brave 的 URL glob 編譯成錨定正規表示式。
     *
     * 只支援 Brave 清單目前使用的 `*` wildcard；其他字元一律視為 literal，避免網域
     * 邊界被正規表示式語法放寬。
     *
     * @param {string} glob Brave include 或 exclude pattern。
     * @returns {RegExp | null} 可安全比對完整 URL 的規則；格式無效時為 null。
     */
    function compileUrlGlob(glob) {
        if (typeof glob !== 'string' || !glob) return null;
        let remaining = glob;
        let source = '^';
        if (remaining.startsWith('*://')) {
            source += 'https?:\\/\\/';
            remaining = remaining.slice(4);
        }
        for (const char of remaining) {
            source += char === '*' ? '.*' : char.replace(/[\\.^$+?()[\]{}|/]/g, '\\$&');
        }
        try {
            return new RegExp(`${source}$`, 'i');
        } catch {
            return null;
        }
    }

    /**
     * 將 Firefox allowList hostname 編譯成具有 hostname 邊界的完整 URL 規則。
     *
     * @param {string} hostname Firefox 允許保留參數的 hostname。
     * @returns {RegExp | null} 可匹配該 hostname 及子網域的 URL；輸入無效時為 null。
     */
    function compileHostnameUrlPattern(hostname) {
        const normalized = typeof hostname === 'string' ? hostname.trim().toLowerCase() : '';
        if (!/^[a-z0-9.-]+$/.test(normalized) || normalized.startsWith('.') || normalized.endsWith('.')) {
            return null;
        }
        const escaped = normalized.replace(/[\\.^$+?()[\]{}|]/g, '\\$&');
        try {
            return new RegExp(
                `^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#@]+@)?(?:[^/?#]*\\.)?${escaped}(?::\\d+)?(?:[/?#]|$)`,
                'i'
            );
        } catch {
            return null;
        }
    }

    /**
     * 將 ClearURLs catalog 編譯成共用遠端規則。
     *
     * @param {unknown} data ClearURLs providers 物件或含 providers 的回應。
     * @returns {RemoteRule[] | null} 正規化規則；頂層格式錯誤時為 null。
     */
    function compileClearUrlsRules(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        const providers = Object.hasOwn(data, 'providers') ? data.providers : data;
        if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return null;

        const compiled = [];
        for (const provider of Object.values(providers)) {
            if (!provider || typeof provider !== 'object' || typeof provider.urlPattern !== 'string') continue;
            try {
                const stringRules = [];
                const regexRules = [];
                for (const rule of Array.isArray(provider.rules) ? provider.rules : []) {
                    if (typeof rule !== 'string' || !rule) continue;
                    if (/[\\^$.*+?()[\]{}|]/.test(rule)) regexRules.push(new RegExp(`^${rule}$`, 'i'));
                    else stringRules.push(rule);
                }
                compiled.push({
                    pattern: new RegExp(provider.urlPattern, 'i'),
                    exceptions: (Array.isArray(provider.exceptions) ? provider.exceptions : [])
                        .filter(exception => typeof exception === 'string')
                        .map(exception => new RegExp(exception, 'i')),
                    stringRules: new Set(stringRules),
                    regexRules
                });
            } catch {
                // 單一 provider 格式錯誤時跳過，不能讓其破壞其他有效 provider。
            }
        }
        return compiled;
    }

    /**
     * 將 Brave clean-urls JSON 的 include／exclude glob 正規化為共用遠端規則。
     *
     * @param {unknown} data Brave clean-urls 規則陣列。
     * @returns {RemoteRule[] | null} 每個 include 各自成為一條規則；頂層格式錯誤時為 null。
     */
    function compileBraveRules(data) {
        if (!Array.isArray(data)) return null;
        const compiled = [];
        for (const rule of data) {
            if (!rule || typeof rule !== 'object' || !Array.isArray(rule.include) || !Array.isArray(rule.params)) {
                continue;
            }
            const exceptions = (Array.isArray(rule.exclude) ? rule.exclude : [])
                .map(compileUrlGlob)
                .filter(Boolean);
            const stringRules = new Set(rule.params.filter(param => typeof param === 'string' && param));
            if (stringRules.size === 0) continue;
            for (const include of rule.include) {
                const pattern = compileUrlGlob(include);
                if (!pattern) continue;
                compiled.push({ pattern, exceptions, stringRules, regexRules: [] });
            }
        }
        return compiled;
    }

    /**
     * 將 Firefox Remote Settings 的 stripList／allowList 正規化為一條全域規則。
     *
     * 帶 `filter_expression` 的紀錄需要 Mozilla JEXL 執行環境，因此整條跳過，不可錯誤
     * 降級成全域清理。
     *
     * @param {unknown} data Firefox Remote Settings 回應。
     * @returns {RemoteRule[] | null} 全域清理規則；頂層格式錯誤時為 null。
     */
    function compileFirefoxRules(data) {
        if (!data || typeof data !== 'object' || !Array.isArray(data.data)) return null;
        const params = new Set();
        const exceptions = [];
        for (const record of data.data) {
            if (!record || typeof record !== 'object' || record.filter_expression) continue;
            for (const param of Array.isArray(record.stripList) ? record.stripList : []) {
                if (typeof param === 'string' && param) params.add(param);
            }
            for (const hostname of Array.isArray(record.allowList) ? record.allowList : []) {
                const pattern = compileHostnameUrlPattern(hostname);
                if (pattern) exceptions.push(pattern);
            }
        }
        if (params.size === 0) return [];
        return [{
            pattern: /^https?:\/\//i,
            exceptions,
            stringRules: params,
            regexRules: []
        }];
    }

    /**
     * 合併各來源目前的最後成功規則。
     *
     * @returns {void}
     * @sideeffect 更新頁面生命週期共用的 remoteRules 快照。
     */
    function rebuildRemoteRules() {
        remoteRules = [...remoteRulesBySource.values()].flat();
    }

    /**
     * 發布已可套用的遠端規則世代，讓相同 href 重新接受清理。
     *
     * @returns {void}
     * @sideeffect 增加規則世代並可能透過 History API 更新目前網址。
     */
    function publishRuleGeneration() {
        ruleGeneration += 1;
        cleanCurrentURL();
    }

    /**
     * 清除網址中的本地、ClearURLs、Brave 與 Firefox 追蹤參數。
     *
     * @param {string} url 要清理的絕對網址。
     * @param {URL | null} [parsedUrl=null] 呼叫端已解析的同一網址，避免重複建立 URL。
     * @param {LocalCleaningContext | null} [localContext=null] 呼叫端已建立的本地規則 context。
     * @returns {string | null} 有變更時回傳清理後網址；無變更或解析失敗時回傳 null。
     */
    function cleanURL(url, parsedUrl = null, localContext = null) {
        try {
            const urlObj = parsedUrl || new URL(url);
            if (SKIP_HOSTS.has(urlObj.hostname) || SKIP_PROTOCOLS.has(urlObj.protocol)) return null;
            if (!urlObj.search || urlObj.search === '?') return null;

            const originalHref = urlObj.href;
            const context = localContext || createLocalCleaningContext(urlObj);
            const matchedStrings = new Set();
            const matchedRegexes = [];

            // 所有 provider 都以尚未刪除參數的網址判斷 scope，避免處理順序改變規則結果。
            for (const provider of remoteRules) {
                if (!provider.pattern.test(originalHref)) continue;
                if (provider.exceptions.some(exception => exception.test(originalHref))) continue;
                for (const name of provider.stringRules) matchedStrings.add(name);
                matchedRegexes.push(...provider.regexRules);
            }

            const keptPairs = [];
            for (const pair of context.pairs) {
                if (isLocalRemoval(pair, context)) continue;
                const remoteRemoval = matchedStrings.has(pair.name) ||
                    matchedRegexes.some(pattern => pattern.test(pair.name));
                if (!remoteRemoval) keptPairs.push(pair.raw);
            }

            if (keptPairs.length === context.pairs.length) return null;
            urlObj.search = keptPairs.length > 0 ? `?${keptPairs.join('&')}` : '';
            return urlObj.href;
        } catch {
            return null;
        }
    }

    /**
     * 一次性移除早期版本使用的固定遠端快取鍵。
     *
     * @returns {void} 無回傳值。
     * @sideeffect 讀取並寫入遷移版本標記，且刪除八個已知舊 GM 鍵；不掃描其他鍵。
     * @design 將版本標記寫在刪除成功之後，讓中途中斷的遷移可於下一頁重試而不留下半套狀態。
     */
    function migrateLegacyRemoteCacheOnce() {
        if (GM_getValue(REMOTE_CACHE_MIGRATION_KEY, 0) === REMOTE_CACHE_MIGRATION_VERSION) return;
        for (const key of LEGACY_REMOTE_CACHE_KEYS) GM_deleteValue(key);
        GM_setValue(REMOTE_CACHE_MIGRATION_KEY, REMOTE_CACHE_MIGRATION_VERSION);
    }

    /**
     * 取得遠端來源內容快取鍵。
     *
     * @param {string} sourceId 遠端來源識別字。
     * @returns {string} GM 儲存空間中的內容鍵。
     */
    function getRemoteRulesCacheKey(sourceId) {
        return `remoteRules:${sourceId}`;
    }

    /**
     * 取得遠端來源更新時間快取鍵。
     *
     * @param {string} sourceId 遠端來源識別字。
     * @returns {string} GM 儲存空間中的時間鍵。
     */
    function getRemoteRulesTimeKey(sourceId) {
        return `remoteRulesTime:${sourceId}`;
    }

    /**
     * 解析並編譯單一來源 JSON，隔離 JSON 與來源格式錯誤。
     *
     * @param {RemoteRuleSource} source 來源設定與 adapter。
     * @param {string} rawData 原始 JSON 字串。
     * @returns {RemoteRule[] | null} 正規化規則；資料無效時為 null。
     */
    function parseRemoteSource(source, rawData) {
        if (typeof rawData !== 'string' || rawData.length === 0 || rawData.length > MAX_REMOTE_RESPONSE_SIZE) {
            return null;
        }
        try {
            return source.compile(JSON.parse(rawData));
        } catch {
            return null;
        }
    }

    /**
     * 背景更新單一 JSON 來源，失敗時保留該來源最後成功規則。
     *
     * @param {RemoteRuleSource} source 待更新的來源。
     * @returns {void}
     * @sideeffect 發出 GM_xmlhttpRequest、更新非空遠端快取並可能重新清理目前網址；空編譯結果保留既有規則。
     */
    function loadRemoteRuleSource(source) {
        GM_xmlhttpRequest({
            method: 'GET',
            url: source.url,
            timeout: 10000,
            onload: response => {
                if (response.status !== 200 || typeof response.responseText !== 'string') return;
                const previousLength = remoteSourceLengths.get(source.id) || 0;
                if (previousLength > 0 && response.responseText.length < previousLength * 0.8) return;
                const compiled = parseRemoteSource(source, response.responseText);
                // 空陣列代表來源沒有可用規則，不能取代 last-known-good 或推進規則世代。
                if (!compiled || compiled.length === 0) return;

                remoteRulesBySource.set(source.id, compiled);
                remoteSourceLengths.set(source.id, response.responseText.length);
                rebuildRemoteRules();
                GM_setValue(getRemoteRulesCacheKey(source.id), response.responseText);
                GM_setValue(getRemoteRulesTimeKey(source.id), Date.now());
                publishRuleGeneration();
            },
            onerror: () => {},
            ontimeout: () => {}
        });
    }

    /**
     * 首次需要遠端判斷時載入三來源快取，並只更新缺少或過期的來源。
     *
     * 各來源的 exceptions 只屬於自身 provider，因此不需要跨來源初始化 barrier；任一
     * 來源成功後可以立即發布，其他來源失敗不會清空 last-known-good。
     *
     * @returns {void}
     * @sideeffect 讀取 GM 快取、編譯遠端規則並可能發出背景請求。
     */
    function initializeRemoteRuleSourcesOnce() {
        if (remoteRulesInitialized) return;
        remoteRulesInitialized = true;

        const now = Date.now();
        for (const source of REMOTE_RULE_SOURCES) {
            const cachedData = GM_getValue(getRemoteRulesCacheKey(source.id), null);
            const cacheTime = GM_getValue(getRemoteRulesTimeKey(source.id), 0);
            let hasValidCache = false;
            const compiled = parseRemoteSource(source, cachedData);
            if (compiled) {
                remoteRulesBySource.set(source.id, compiled);
                remoteSourceLengths.set(source.id, cachedData.length);
                hasValidCache = true;
            }
            if (!hasValidCache || now - cacheTime >= source.maxAge) loadRemoteRuleSource(source);
        }
        rebuildRemoteRules();
    }

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    /**
     * 依 href 與規則世代去重後清理目前網址，並隔離 History API 失敗。
     *
     * @returns {void}
     * @sideeffect 本地無法清空 query 時初始化遠端來源；需要清理時更新目前網址。
     */
    function cleanCurrentURL() {
        if (cleaning) return;
        const currentHref = location.href;
        if (currentHref === lastProcessedHref && ruleGeneration === lastProcessedRuleGeneration) return;

        cleaning = true;
        try {
            let urlObj;
            try {
                urlObj = new URL(currentHref);
            } catch {
                lastProcessedHref = currentHref;
                lastProcessedRuleGeneration = ruleGeneration;
                return;
            }

            const hasProcessableQuery = !SKIP_HOSTS.has(urlObj.hostname) &&
                !SKIP_PROTOCOLS.has(urlObj.protocol) && Boolean(urlObj.search && urlObj.search !== '?');
            if (!hasProcessableQuery) {
                lastProcessedHref = currentHref;
                lastProcessedRuleGeneration = ruleGeneration;
                return;
            }

            const localContext = createLocalCleaningContext(urlObj);
            if (localContext.pairs.every(pair => isLocalRemoval(pair, localContext))) {
                urlObj.search = '';
                originalReplaceState.call(history, history.state, '', urlObj.href);
                lastProcessedHref = location.href;
                lastProcessedRuleGeneration = ruleGeneration;
                return;
            }

            initializeRemoteRuleSourcesOnce();
            const processingGeneration = ruleGeneration;
            const cleaned = cleanURL(currentHref, urlObj, localContext);
            if (cleaned) originalReplaceState.call(history, history.state, '', cleaned);
            lastProcessedHref = location.href;
            lastProcessedRuleGeneration = processingGeneration;
        } catch {
            // 網頁 History API、sandbox 或遠端初始化失敗不得干擾原頁面執行。
        } finally {
            cleaning = false;
        }
    }

    // Tampermonkey 原生事件能跨越 sandbox，捕捉 Facebook 等 SPA 在頁面 context 執行的 History API 更新。
    if (window.onurlchange === null) {
        window.addEventListener('urlchange', cleanCurrentURL);
    } else {
        /**
         * 攔截頁面的 pushState，保留原生例外與回傳值，成功後再執行追蹤清理。
         *
         * @param {unknown} state 要寫入 history 的狀態物件。
         * @param {string} title History API 保留的標題參數。
         * @param {string | URL | null | undefined} url 可省略的新網址。
         * @returns {unknown} 原生 pushState 的回傳值。
         */
        history.pushState = function (state, title, url) {
            const result = originalPushState.call(this, state, title, url);
            cleanCurrentURL();
            return result;
        };

        /**
         * 攔截頁面的 replaceState，保留原生例外與回傳值，成功後再執行追蹤清理。
         *
         * @param {unknown} state 要寫入 history 的狀態物件。
         * @param {string} title History API 保留的標題參數。
         * @param {string | URL | null | undefined} url 可省略的新網址。
         * @returns {unknown} 原生 replaceState 的回傳值。
         */
        history.replaceState = function (state, title, url) {
            const result = originalReplaceState.call(this, state, title, url);
            cleanCurrentURL();
            return result;
        };
    }

    window.addEventListener('popstate', cleanCurrentURL);
    window.addEventListener('pageshow', event => {
        if (event.persisted) cleanCurrentURL();
    });

    migrateLegacyRemoteCacheOnce();

    cleanCurrentURL();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', cleanCurrentURL, { once: true });
    }
})();
