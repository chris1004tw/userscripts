// ==UserScript==
// @name         移除 URL 追蹤
// @namespace    https://chris.taipei
// @version      0.4.6
// @description  自動移除 URL 中的追蹤參數，保護您的隱私（部分規則引用自 ClearURLs Project）
// @author       chris1004tw
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        window.onurlchange
// @connect      rules1.clearurls.xyz
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
     * @property {RegExp[]} [regexParams] 容易誤殺、僅限該站點套用的參數名稱規則。
     * @property {RegExp[]} [except] 不應套用規則的完整 URL 例外。
     */

    /**
     * @typedef {Object} RemoteRule
     * @property {RegExp} pattern ClearURLs provider 的完整 URL 規則。
     * @property {RegExp[]} exceptions provider 的完整 URL 例外。
     * @property {Set<string>} stringRules 完全相符的參數名稱。
     * @property {RegExp[]} regexRules 以正規表示式比對的參數名稱。
     */

    const RULE_URL = 'https://rules1.clearurls.xyz/data.minify.json';
    const ONE_HOUR = 3600000;
    const SKIP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '']);
    const SKIP_PROTOCOLS = new Set(['file:', 'data:', 'javascript:']);

    // 特定網域只保留可能承載功能狀態的歧義參數；hostnamePattern 必須錨定結尾以排除 lookalike。
    /** @type {SiteRule[]} */
    const SITE_RULES = [
        {
            hostnamePattern: /^(?:[a-z0-9-]+\.)*google\.(?:(?:com|co)\.)?[a-z]{2}$|^(?:[a-z0-9-]+\.)*google\.com$/i,
            params: new Set(["source", "ei", "sxsrf"]),
            except: [/^https?:\/\/mail\.google\.com\//i]
        },
        {
            hostnamePattern: /^(?:[a-z0-9-]+\.)*facebook\.com$/i,
            params: new Set(["share_url", "type", "ref", "ref_url", "hoisted_section_header_type"])
        },
        {
            hostnamePattern: /^(?:[a-z0-9-]+\.)*(?:twitter\.com|x\.com)$/i,
            params: new Set(["s", "t"])
        },
        {
            hostnamePattern: /^(?:[a-z0-9-]+\.)*youtube\.com$/i,
            params: new Set(["feature", "kw", "pp", "si"]),
            except: [/^https?:\/\/(?:[a-z0-9-]+\.)*?youtube\.com\/redirect/i]
        },
        {
            hostnamePattern: /^(?:[a-z0-9-]+\.)*amazon\.(?:(?:com|co)\.)?[a-z]{2}$|^(?:[a-z0-9-]+\.)*amazon\.com$/i,
            params: new Set(["tag", "psc", "ufe", "linkCode", "linkId", "camp", "creative"])
        },
        {
            hostnamePattern: /^(?:[a-z0-9-]+\.)*(?:taobao\.com|tmall\.com|tmall\.hk)$/i,
            // sku_properties 代表使用者選定的商品款式，刻意不列入任何移除規則。
            params: new Set([
                "ns", "source", "xxc", "mi_id", "initiative_id", "clientPreloadId",
                "preLoadOrigin", "rn", "sourceId", "ssid", "suggest_query", "wq"
            ]),
            // mm_ 是常見自訂欄位前綴，只有阿里系站點才能安全移除。
            regexParams: [/^mm_/]
        },
        {
            hostnamePattern: /^(?:[a-z0-9-]+\.)*shopee\.(?:(?:com|co)\.)?[a-z]{2}$|^(?:[a-z0-9-]+\.)*shopee\.(?:sg|ph|vn|tw|cl|pl)$/i,
            params: new Set(["seoName", "d_id"])
        },
        {
            hostnamePattern: /^(?:[a-z0-9-]+\.)*linkedin\.com$/i,
            params: new Set(["trk"])
        }
    ];

    // 高辨識度追蹤名稱直接跨站清除，避免同一參數出現在導轉站或合作網域時還要逐站加規則。
    const GENERAL_STRING_PARAMS = new Set([
        // 跨站 Click ID
        "yclid", "fbclid", "gclid", "dclid", "msclkid", "twclid", "igshid", "mibextid", "srsltid",
        // 平台產生、名稱具高辨識度的追蹤欄位
        "ved", "gs_l", "gs_lcp", "sclient", "rlz", "ICID",
        "action_history", "action_type_map", "action_ref_map", "referrer", "origin_source",
        "rdid", "idorvanity", "referral_story_type", "ref_src",
        "ascsubtag", "ref_",
        "priceTId", "abbucket", "pisk", "spm", "scm", "xmt", "slof",
        "uls_trackid",
        "masterhotelid_tracelogid", "trip_sub1", "hasAidInUrl",
        "trkCampaign",
        // Email 行銷追蹤
        "mc_cid", "mc_eid", "mkt_tok", "nr_email_referer", "vero_conv", "vero_id",
        // 名稱具跨站唯一性的分析識別碼
        "oly_anon_id", "oly_enc_id", "wickedid"
    ]);
    const GENERAL_REGEX_PARAMS = [
        /^utm_/, /^ga_/, /^fb_/, /^pf_rd_/, /^pd_rd_/, /^ali_/
    ];

    /** @type {RemoteRule[]} */
    let remoteRules = [];

    /**
     * 判斷解析後 URL 是否符合一條本地站點規則。
     *
     * @param {URL} urlObj 已完成解析的網址物件。
     * @param {SiteRule} rule 待驗證的站點規則。
     * @returns {boolean} hostname 符合且未命中例外時為 true。
     */
    function matchesSiteRule(urlObj, rule) {
        if (!rule.hostnamePattern.test(urlObj.hostname)) return false;
        return !rule.except?.some(ex => ex.test(urlObj.href));
    }

    /**
     * 清除網址中的本地與遠端追蹤參數。
     *
     * @param {string} url 要清理的絕對網址。
     * @returns {string | null} 有變更時回傳清理後網址，無變更或解析失敗時回傳 null。
     */
    function cleanURL(url) {
        try {
            const urlObj = new URL(url);
            if (SKIP_HOSTS.has(urlObj.hostname) || SKIP_PROTOCOLS.has(urlObj.protocol)) {
                return null;
            }

            const params = urlObj.searchParams;
            const keys = [...params.keys()];
            if (keys.length === 0) return null;

            // 預先收集匹配此 URL 的特定網域參數
            const matchedSiteParams = new Set();
            const matchedSiteRegexes = [];
            for (const rule of SITE_RULES) {
                if (!matchesSiteRule(urlObj, rule)) continue;
                for (const p of rule.params) matchedSiteParams.add(p);
                matchedSiteRegexes.push(...(rule.regexParams || []));
            }

            // 預先收集匹配此 URL 的遠端規則
            const matchedRemoteStrings = new Set();
            const matchedRemoteRegexes = [];
            for (const provider of remoteRules) {
                if (!provider.pattern.test(urlObj.href)) continue;
                if (provider.exceptions?.some(ex => ex.test(urlObj.href))) continue;
                for (const s of provider.stringRules) matchedRemoteStrings.add(s);
                matchedRemoteRegexes.push(...provider.regexRules);
            }

            let changed = false;

            for (const key of keys) {
                if (
                    GENERAL_STRING_PARAMS.has(key) ||
                    matchedSiteParams.has(key) ||
                    matchedSiteRegexes.some(r => r.test(key)) ||
                    matchedRemoteStrings.has(key) ||
                    GENERAL_REGEX_PARAMS.some(r => r.test(key)) ||
                    matchedRemoteRegexes.some(r => r.test(key))
                ) {
                    params.delete(key);
                    changed = true;
                }
            }

            // 直接使用 URL.href，避免手動重組時遺失 username／password 等合法 URL 元件。
            return changed ? urlObj.href : null;
        } catch {
            return null;
        }
    }

    /**
     * 將 ClearURLs JSON provider 預編譯為可重複使用的正規表示式與 Set。
     *
     * @param {Record<string, unknown>} data ClearURLs provider 集合或含 providers 的回應物件。
     * @returns {RemoteRule[]} 可安全套用的有效遠端規則；無效 provider 會被略過。
     */
    function compileRemoteRules(data) {
        const providers = data.providers || data;
        return Object.values(providers).filter(p => p.urlPattern).map(provider => {
            try {
                return {
                    pattern: new RegExp(provider.urlPattern, 'i'),
                    exceptions: provider.exceptions?.map(ex => new RegExp(ex, 'i')) || [],
                    stringRules: new Set(provider.rules?.filter(r => !/[\\^$.*+?()[\]{}|]/.test(r)) || []),
                    regexRules: provider.rules?.filter(r => /[\\^$.*+?()[\]{}|]/.test(r)).map(r => new RegExp('^' + r + '$', 'i')) || []
                };
            } catch {
                return null;
            }
        }).filter(Boolean);
    }

    /**
     * 背景下載並快取 ClearURLs 規則，成功後重新清理目前頁面。
     *
     * @returns {void}
     * @sideeffect 發出 GM_xmlhttpRequest、寫入 GM 儲存空間，並可能改寫目前網址。
     */
    function loadRemoteRules() {
        GM_xmlhttpRequest({
            method: 'GET',
            url: RULE_URL,
            timeout: 10000,
            onload: (res) => {
                if (res.status === 200) {
                    try {
                        const data = JSON.parse(res.responseText);
                        remoteRules = compileRemoteRules(data);
                        GM_setValue('cachedRules', res.responseText);
                        GM_setValue('cacheTime', Date.now());
                        // 新規則載入後重新清理當前 URL
                        cleanCurrentURL();
                    } catch { }
                }
            },
            onerror: () => { },
            ontimeout: () => { }
        });
    }

    // 載入快取的遠端規則
    const cached = GM_getValue('cachedRules', null);
    const cacheTime = GM_getValue('cacheTime', 0);
    if (cached) {
        try {
            remoteRules = compileRemoteRules(JSON.parse(cached));
        } catch { }
    }

    // 超過一小時則背景更新
    if (!cached || Date.now() - cacheTime >= ONE_HOUR) {
        loadRemoteRules();
    }

    // 攔截 pushState/replaceState 支援 SPA
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    let cleaning = false;

    /**
     * 清理目前頁面網址，並隔離 userscript 自己 replaceState 失敗造成的例外。
     *
     * @returns {void}
     * @sideeffect 需要清理時透過原生 replaceState 更新網址；finally 保證解除重入鎖。
     */
    function cleanCurrentURL() {
        if (cleaning) return;
        const cleaned = cleanURL(location.href);
        if (cleaned) {
            cleaning = true;
            try {
                originalReplaceState.call(history, history.state, '', cleaned);
            } catch { }
            finally {
                cleaning = false;
            }
        }
    }

    /** 攔截頁面的 pushState，保留原生例外與回傳值，成功後再執行追蹤清理。 */
    history.pushState = function (state, title, url) {
        const result = originalPushState.call(this, state, title, url);
        cleanCurrentURL();
        return result;
    };

    /** 攔截頁面的 replaceState，保留原生例外與回傳值，成功後再執行追蹤清理。 */
    history.replaceState = function (state, title, url) {
        const result = originalReplaceState.call(this, state, title, url);
        cleanCurrentURL();
        return result;
    };

    // Tampermonkey 原生事件能跨越 sandbox，捕捉 Facebook 等 SPA 在頁面 context 執行的 History API 更新。
    if (window.onurlchange === null) {
        window.addEventListener('urlchange', cleanCurrentURL);
    }

    // popstate 事件（上一頁/下一頁）
    window.addEventListener('popstate', cleanCurrentURL);

    // bfcache 恢復時重新清理 URL
    window.addEventListener('pageshow', (e) => {
        if (e.persisted) cleanCurrentURL();
    });

    // 清理當前頁面（多時機觸發，防止 MV3 延遲注入）
    cleanCurrentURL();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', cleanCurrentURL, { once: true });
    }
})();
