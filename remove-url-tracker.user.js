// ==UserScript==
// @name         移除 URL 追蹤
// @namespace    https://chris.taipei
// @version      0.4.2
// @description  自動移除 URL 中的追蹤參數，保護您的隱私（部分規則引用自 ClearURLs Project）
// @author       chris1004tw
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      rules1.clearurls.xyz
// @run-at       document-start
// @updateURL    https://github.com/chris1004tw/userscripts/raw/main/remove-url-tracker.user.js
// @downloadURL  https://github.com/chris1004tw/userscripts/raw/main/remove-url-tracker.user.js
// ==/UserScript==
// Co-authored with Claude Opus 4.6 Thinking

(function () {
    'use strict';

    const RULE_URL = 'https://rules1.clearurls.xyz/data.minify.json';
    const ONE_HOUR = 3600000;
    const SKIP_HOSTS = new Set(['localhost', '127.0.0.1', '']);
    const SKIP_PROTOCOLS = new Set(['file:', 'data:', 'javascript:']);

    // 特定網域規則（只放太通用會誤殺的參數）
    const SITE_RULES = [
        {
            pattern: /^https?:\/\/(?:[a-z0-9-]+\.)*?google(?:\.[a-z]{2,}){1,}/i,
            params: new Set(["source"]),
            except: [/^https?:\/\/mail\.google\.com\//i]
        },
        {
            pattern: /^https?:\/\/(?:[a-z0-9-]+\.)*?facebook\.com/i,
            params: new Set(["action_history", "action_type_map", "action_ref_map", "share_url", "type"])
        },
        {
            pattern: /^https?:\/\/(?:[a-z0-9-]+\.)*?(?:twitter\.com|x\.com)/i,
            params: new Set(["s", "t"])
        },
        {
            pattern: /^https?:\/\/(?:[a-z0-9-]+\.)*?youtube\.com/i,
            params: new Set(["feature", "kw", "pp"]),
            except: [/^https?:\/\/(?:[a-z0-9-]+\.)*?youtube\.com\/redirect/i]
        },
        {
            pattern: /^https?:\/\/(?:[a-z0-9-]+\.)*?(?:taobao\.com|tmall\.com|tmall\.hk)/i,
            params: new Set(["ns", "source"])
        },
        {
            pattern: /^https?:\/\/(?:[a-z0-9-]+\.)*?shopee\.[a-z.]+/i,
            params: new Set(["seoName"])
        },
        {
            pattern: /^https?:\/\/(?:[a-z0-9-]+\.)*?trip\.com/i,
            params: new Set([
                "cityEnName", "cityId", "ages", "barcurr", "mincurr", "minprice",
                "fgt", "subStamp", "isCT", "isFlexible", "isFirstEnterDetail",
                "hoteluniquekey", "masterhotelid_tracelogid",
                "detailFilters", "hotelType", "display",
                "roomkey", "roomToken", "msr", "mproom",
                "trip_sub1", "hasAidInUrl"
            ])
        }
    ];

    // 通用規則（所有網站都套用，不需要 pattern 匹配）
    const GENERAL_STRING_PARAMS = new Set([
        // 各平台 Click ID
        "yclid", "fbclid", "gclid", "dclid", "msclkid", "twclid", "igshid", "mibextid", "hl",
        // Google 追蹤
        "ved", "ei", "gs_l", "gs_lcp", "sclient", "sxsrf", "rlz", "ICID",
        // Amazon 追蹤
        "tag", "ascsubtag", "ref_", "psc", "linkCode", "linkId", "camp", "creative",
        // YouTube 追蹤
        "si",
        // 淘寶追蹤
        "sku_properties", "priceTId", "abbucket", "xxc", "mi_id",
        "initiative_id", "clientPreloadId", "preLoadOrigin", "sourceId", "ssid", "suggest_query", "wq",
        // Email 行銷追蹤
        "mc_cid", "mc_eid", "mkt_tok", "nr_email_referer", "vero_conv", "vero_id",
        // 其他追蹤
        "trk", "trkCampaign", "oly_anon_id", "oly_enc_id", "otc", "__s", "wickedid", "dicbo", "spm", "scm",
        "ref", "ref_src", "ref_url", "src", "referrer", "origin_source",
        "xmt", "slof", "referral_code", "referral_story_type", "tracking", "hoisted_section_header_type", "rdid", "srsltid", "idorvanity", "set"
    ]);
    const GENERAL_REGEX_PARAMS = [
        /^utm_/, /^ga_/, /^sc_/, /^from_/, /^edn_/, /^fb_/, /^hmb_/, /^pf_rd_/, /^pd_rd_/, /^ali_/, /^mm_/
    ];

    let remoteRules = [];

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
            for (const rule of SITE_RULES) {
                if (!rule.pattern.test(url)) continue;
                if (rule.except?.some(ex => ex.test(url))) continue;
                for (const p of rule.params) matchedSiteParams.add(p);
            }

            // 預先收集匹配此 URL 的遠端規則
            const matchedRemoteStrings = new Set();
            const matchedRemoteRegexes = [];
            for (const provider of remoteRules) {
                if (!provider.pattern.test(url)) continue;
                if (provider.exceptions?.some(ex => ex.test(url))) continue;
                for (const s of provider.stringRules) matchedRemoteStrings.add(s);
                matchedRemoteRegexes.push(...provider.regexRules);
            }

            let changed = false;

            for (const key of keys) {
                if (
                    GENERAL_STRING_PARAMS.has(key) ||
                    matchedSiteParams.has(key) ||
                    matchedRemoteStrings.has(key) ||
                    GENERAL_REGEX_PARAMS.some(r => r.test(key)) ||
                    matchedRemoteRegexes.some(r => r.test(key))
                ) {
                    params.delete(key);
                    changed = true;
                }
            }

            return changed ? urlObj.origin + urlObj.pathname + (params.toString() ? '?' + params : '') + urlObj.hash : null;
        } catch {
            return null;
        }
    }

    // 預編譯遠端規則
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

    function cleanCurrentURL() {
        if (cleaning) return;
        const cleaned = cleanURL(location.href);
        if (cleaned) {
            cleaning = true;
            originalReplaceState.call(history, history.state, '', cleaned);
            cleaning = false;
        }
    }

    history.pushState = function (state, title, url) {
        originalPushState.call(this, state, title, url);
        cleanCurrentURL();
    };

    history.replaceState = function (state, title, url) {
        originalReplaceState.call(this, state, title, url);
        cleanCurrentURL();
    };

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
