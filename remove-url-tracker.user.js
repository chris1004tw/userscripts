// ==UserScript==
// @name         移除 URL 追蹤
// @namespace    https://chris.taipei
// @version      0.4.7
// @description  自動移除網址中的追蹤參數，簡化分享連結並保護隱私
// @author       chris1004tw
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        window.onurlchange
// @connect      rules1.clearurls.xyz
// @connect      raw.githubusercontent.com
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

    /**
     * @typedef {Object} HostScope
     * @property {RegExp[]} include 允許套用的目的 hostname 規則；空陣列代表不限制。
     * @property {RegExp[]} exclude 禁止套用的目的 hostname 規則。
     */

    /**
     * @typedef {Object} TextRule
     * @property {boolean} exception 是否為 `@@` 保留規則。
     * @property {RegExp | null} urlPattern URL 範圍；null 代表所有 URL。
     * @property {HostScope[]} hostScopes `domain`、`to` 與 `denyallow` 的 hostname 限制。
     * @property {'name' | 'regex' | 'all'} actionType 查詢參數的比對方式。
     * @property {string | null} paramName 精確比對的參數名稱。
     * @property {RegExp | null} paramPattern 比對 `name=value` 的正規表示式。
     * @property {string} canonical 跨來源去重使用的標準字串。
     */

    /**
     * @typedef {Object} TextRuleSource
     * @property {string} id 穩定的來源識別字。
     * @property {string} url 原始 TXT 下載網址。
     * @property {number} maxAge 快取有效毫秒數。
     * @property {number} minRules 新內容可取代 last-known-good 的最低有效規則數。
     * @property {number} minExceptions 新內容必須保有的最低安全例外數。
     * @property {number} minBytes 首次下載可接受的最低文字大小。
     */

    /**
     * @typedef {Object} QueryPair
     * @property {string} raw 未改寫的原始查詢片段。
     * @property {string} name 解碼後的參數名稱。
     * @property {string} value 解碼後的參數值。
     * @property {string} normalized 正規式使用的 `name=value` 字串。
     */

    const CLEARURLS_RULE_URL = 'https://rules1.clearurls.xyz/data.minify.json';
    const ONE_HOUR = 3600000;
    const MAX_TEXT_RESPONSE_SIZE = 2000000;
    const SKIP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '']);
    const SKIP_PROTOCOLS = new Set(['file:', 'data:', 'javascript:']);

    /** @type {TextRuleSource[]} */
    const TEXT_RULE_SOURCES = [
        {
            id: 'adguard',
            url: 'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_17_TrackParam/filter.txt',
            maxAge: 5 * 24 * ONE_HOUR,
            minRules: 500,
            minExceptions: 10,
            minBytes: 10000
        },
        {
            id: 'dandelion',
            url: 'https://raw.githubusercontent.com/DandelionSprout/adfilt/refs/heads/master/LegitimateURLShortener.txt',
            maxAge: 12 * ONE_HOUR,
            minRules: 500,
            minExceptions: 10,
            minBytes: 10000
        },
        {
            id: 'ublock',
            url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/refs/heads/master/filters/privacy-removeparam.txt',
            maxAge: 7 * 24 * ONE_HOUR,
            minRules: 500,
            minExceptions: 10,
            minBytes: 10000
        }
    ];

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
    /** @type {Map<string, TextRule[]>} */
    const textRulesBySource = new Map();
    /** @type {Map<string, number>} */
    const textRuleSourceLengths = new Map();
    /** @type {TextRule[]} */
    let textRules = [];
    /** @type {TextRule[]} */
    let textExceptions = [];
    let textRulesReady = false;

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
     * 解碼單一查詢參數元件，解析失敗時保留可比較的原字串。
     *
     * @param {string} value 尚未解碼的名稱或值。
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
     * 解析查詢片段並保留原始編碼，讓移除單一重複參數時不改寫其他簽章值。
     *
     * @param {string} raw 未含 `&` 的原始查詢片段。
     * @returns {QueryPair} 可供精確名稱與 `name=value` 正規式比對的資料。
     */
    function parseQueryPair(raw) {
        const separatorIndex = raw.indexOf('=');
        const rawName = separatorIndex >= 0 ? raw.slice(0, separatorIndex) : raw;
        const rawValue = separatorIndex >= 0 ? raw.slice(separatorIndex + 1) : '';
        const name = decodeQueryComponent(rawName);
        const value = decodeQueryComponent(rawValue);
        return { raw, name, value, normalized: `${name}=${value}` };
    }

    /**
     * 將 `domain`／`to` 中的 hostname glob 編譯成具邊界的正規表示式。
     *
     * @param {string} pattern 單一 hostname pattern。
     * @returns {RegExp | null} 有效規則；需 Public Suffix 的 entity wildcard 或完整 regex 回傳 null。
     */
    function compileHostPattern(pattern) {
        const normalized = pattern.trim().toLowerCase();
        if (!normalized || normalized.includes('*') ||
            (normalized.startsWith('/') && normalized.lastIndexOf('/') > 0)) {
            return null;
        }

        let source = '';
        for (const char of normalized) {
            source += char.replace(/[\\.^$+?()[\]{}|]/g, '\\$&');
        }

        try {
            return new RegExp(`(?:^|\\.)${source}$`, 'i');
        } catch {
            return null;
        }
    }

    /**
     * 解析 `domain`、`to` 或 `denyallow` hostname 清單。
     *
     * @param {string} value 以 `|` 分隔的 hostname 清單。
     * @param {boolean} denyOnly 是否將所有項目視為排除條件。
     * @returns {HostScope | null} 有效的 hostname 限制；含不支援語法時回傳 null。
     */
    function parseHostScope(value, denyOnly) {
        const include = [];
        const exclude = [];
        const tokens = value.split('|').filter(Boolean);
        if (tokens.length === 0) return null;

        for (const token of tokens) {
            const negated = token.startsWith('~');
            const pattern = compileHostPattern(negated ? token.slice(1) : token);
            if (!pattern) return null;
            if (denyOnly || negated) exclude.push(pattern);
            else include.push(pattern);
        }
        return { include, exclude };
    }

    /**
     * 判斷目前目的 hostname 是否符合一組正向與負向限制。
     *
     * @param {string} hostname 已解析的目的 hostname。
     * @param {HostScope} scope 待套用的 hostname 限制。
     * @returns {boolean} 符合正向範圍且未命中排除條件時為 true。
     */
    function matchesHostScope(hostname, scope) {
        if (scope.exclude.some(pattern => pattern.test(hostname))) return false;
        return scope.include.length === 0 || scope.include.some(pattern => pattern.test(hostname));
    }

    /**
     * 把 Adblock URL mask 轉為完整 URL 正規表示式。
     *
     * @param {string} pattern `$` 前方的 URL mask。
     * @returns {RegExp | null | undefined} null 代表全域規則，undefined 代表不支援或無效。
     */
    function compileNetworkPattern(pattern) {
        let remaining = pattern.trim();
        if (!remaining || remaining === '*') return null;
        if (remaining.startsWith('/') && /^\/.+\/[a-z]*$/i.test(remaining)) return undefined;

        let source = '';
        let anchoredAtEnd = false;
        if (remaining.startsWith('||')) {
            const hostAndPath = remaining.slice(2);
            const hostEnd = hostAndPath.search(/[\/^?&#:]/);
            const hostPattern = hostEnd >= 0 ? hostAndPath.slice(0, hostEnd) : hostAndPath;
            // `example.*` 是 Public Suffix entity 語法；無 PSL 時整條略過，避免命中 example.com.evil。
            if (!hostPattern || hostPattern.includes('*') || hostPattern.endsWith('.')) {
                return undefined;
            }
            source = '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#@]+@)?(?:[^/?#]*\\.)?';
            remaining = remaining.slice(2);
        } else if (remaining.startsWith('|')) {
            source = '^';
            remaining = remaining.slice(1);
        }
        if (remaining.endsWith('|')) {
            anchoredAtEnd = true;
            remaining = remaining.slice(0, -1);
        }

        for (const char of remaining) {
            if (char === '*') source += '.*';
            else if (char === '^') source += '(?:[^A-Za-z0-9_.%\\-]|$)';
            else source += char.replace(/[\\.^$+?()[\]{}|/]/g, '\\$&');
        }
        if (anchoredAtEnd) source += '$';

        try {
            return new RegExp(source, 'i');
        } catch {
            return undefined;
        }
    }

    /**
     * 依 regex slash 與跳脫狀態切分 modifiers，避免 `{6\,}` 內的逗號被誤切。
     *
     * @param {string} value `$` 後方的 modifiers 字串。
     * @returns {string[]} 去除空白後的 modifier 清單。
     */
    function splitModifiers(value) {
        const modifiers = [];
        let current = '';
        let escaped = false;
        let inRegex = false;

        for (const char of value) {
            if (escaped) {
                current += char;
                escaped = false;
                continue;
            }
            if (char === '\\') {
                current += char;
                escaped = true;
                continue;
            }
            if (char === '/') {
                current += char;
                inRegex = !inRegex;
                continue;
            }
            if (char === ',' && !inRegex) {
                if (current.trim()) modifiers.push(current.trim());
                current = '';
                continue;
            }
            current += char;
        }
        if (current.trim()) modifiers.push(current.trim());
        return modifiers;
    }

    /**
     * 解析 `$removeparam` action；值正規式會比對解碼後的 `name=value`。
     *
     * @param {string} modifier 完整 removeparam modifier。
     * @returns {{actionType: 'name' | 'regex' | 'all', paramName: string | null, paramPattern: RegExp | null} | null} 可安全執行的 action。
     */
    function parseRemoveParamAction(modifier) {
        if (modifier === 'removeparam') {
            return { actionType: 'all', paramName: null, paramPattern: null };
        }
        if (!modifier.startsWith('removeparam=')) return null;

        const value = modifier.slice('removeparam='.length);
        if (!value || value.startsWith('~')) return null;
        if (value.startsWith('/')) {
            const closingSlash = value.lastIndexOf('/');
            if (closingSlash <= 0) return null;
            const flags = value.slice(closingSlash + 1);
            if (!/^(?:i)?$/.test(flags)) return null;
            try {
                return {
                    actionType: 'regex',
                    paramName: null,
                    paramPattern: new RegExp(value.slice(1, closingSlash), flags)
                };
            } catch {
                return null;
            }
        }
        // 未正式文件化的 `name=value` action 採 fail-safe 跳過，避免猜錯語意後誤刪。
        if (value.includes('=')) return null;
        return { actionType: 'name', paramName: value, paramPattern: null };
    }

    /**
     * 以非 MV3 userscript 能力評估 `!#if` 條件；未知能力回傳 null 並跳過互斥分支。
     *
     * @param {string} expression 前處理器布林運算式。
     * @returns {boolean | null} 已知結果；語法或能力未知時為 null。
     */
    function evaluatePreprocessorCondition(expression) {
        const compact = expression.replace(/\s+/g, '');
        const tokens = compact.match(/&&|\|\||!|\(|\)|[A-Za-z_][A-Za-z0-9_]*/g) || [];
        if (tokens.join('') !== compact) return null;

        const capabilities = new Map([
            ['ext_ublock', false],
            ['ext_ubol', false],
            ['adguard_ext_chromium_mv3', false],
            ['adguard_ext_chromium', false],
            ['adguard_ext_edge', false],
            ['adguard_ext_firefox', false],
            ['adguard_ext_opera', false],
            ['adguard_ext_safari', false],
            ['adguard_app_windows', false],
            ['adguard_app_mac', false],
            ['adguard_app_android', false],
            ['adguard_app_linux', false]
        ]);
        let index = 0;
        let valid = true;

        /** @returns {boolean | null} 解析原子、括號或反相條件。 */
        const parsePrimary = () => {
            const token = tokens[index];
            if (token === '!') {
                index += 1;
                const result = parsePrimary();
                return result === null ? null : !result;
            }
            if (token === '(') {
                index += 1;
                const result = parseOr();
                if (tokens[index] !== ')') valid = false;
                else index += 1;
                return result;
            }
            if (!token || !/^[A-Za-z_]/.test(token)) {
                valid = false;
                return null;
            }
            index += 1;
            return capabilities.has(token) ? capabilities.get(token) : null;
        };

        /** @returns {boolean | null} 解析 AND 並保留未知值的三態邏輯。 */
        const parseAnd = () => {
            let result = parsePrimary();
            while (tokens[index] === '&&') {
                index += 1;
                const right = parsePrimary();
                if (result === false || right === false) result = false;
                else if (result === null || right === null) result = null;
                else result = true;
            }
            return result;
        };

        /** @returns {boolean | null} 解析 OR 並保留未知值的三態邏輯。 */
        const parseOr = () => {
            let result = parseAnd();
            while (tokens[index] === '||') {
                index += 1;
                const right = parseAnd();
                if (result === true || right === true) result = true;
                else if (result === null || right === null) result = null;
                else result = false;
            }
            return result;
        };

        const result = parseOr();
        return valid && index === tokens.length ? result : null;
    }

    /**
     * 將單行 AdGuard/uBO `$removeparam` 規則編譯成安全的文件 URL 規則。
     *
     * @param {string} line 已去除前後空白的規則行。
     * @returns {TextRule | null} 支援的規則；不明 modifier 或危險降級情況回傳 null。
     */
    function parseTextRule(line) {
        let ruleText = line;
        const exception = ruleText.startsWith('@@');
        if (exception) ruleText = ruleText.slice(2);

        const modifierIndex = ruleText.indexOf('$');
        if (modifierIndex < 0) return null;
        const rawUrlPattern = ruleText.slice(0, modifierIndex);
        const modifiers = splitModifiers(ruleText.slice(modifierIndex + 1));
        const actionModifier = modifiers.find(modifier =>
            modifier === 'removeparam' || modifier.startsWith('removeparam='));
        if (!actionModifier) return null;

        const action = parseRemoveParamAction(actionModifier);
        const urlPattern = compileNetworkPattern(rawUrlPattern);
        if (!action || urlPattern === undefined) return null;

        const hostScopes = [];
        const positiveContentTypes = new Set();
        const nonDocumentTypes = new Set([
            'xhr', 'xmlhttprequest', 'image', 'media', 'script', 'stylesheet', 'font',
            'subdocument', 'object', 'ping', 'websocket', 'other'
        ]);

        for (const modifier of modifiers) {
            if (modifier === actionModifier) continue;
            if (modifier === 'doc' || modifier === 'document') {
                positiveContentTypes.add('document');
                continue;
            }
            if (nonDocumentTypes.has(modifier)) {
                positiveContentTypes.add(modifier);
                continue;
            }
            if (modifier === '~doc' || modifier === '~document' || modifier === '3p' || modifier === 'third-party') {
                return null;
            }
            if (modifier === '~3p' || modifier === '~third-party' || modifier === '1p' ||
                modifier === 'first-party' || modifier === 'important' || /^_+$/.test(modifier)) {
                continue;
            }
            if (modifier.startsWith('~') && nonDocumentTypes.has(modifier.slice(1))) continue;

            const scopeMatch = /^(domain|to|denyallow)=(.+)$/.exec(modifier);
            if (scopeMatch) {
                const scope = parseHostScope(scopeMatch[2], scopeMatch[1] === 'denyallow');
                if (!scope) return null;
                hostScopes.push(scope);
                continue;
            }
            return null;
        }

        if (positiveContentTypes.size > 0 && !positiveContentTypes.has('document')) return null;
        if (action.actionType === 'all' && !exception && urlPattern === null &&
            !hostScopes.some(scope => scope.include.length > 0)) {
            return null;
        }

        return {
            exception,
            urlPattern,
            hostScopes,
            actionType: action.actionType,
            paramName: action.paramName,
            paramPattern: action.paramPattern,
            canonical: line
        };
    }

    /**
     * 解析一份 TXT 清單並套用 userscript 的非 MV3 前處理器能力設定。
     *
     * @param {string} text 完整 AdGuard/uBO 格式文字。
     * @returns {TextRule[]} 成功編譯且可安全套用於目前文件 URL 的規則。
     */
    function compileTextRules(text) {
        const rules = [];
        /** @type {{parentActive: boolean, condition: boolean | null}[]} */
        const conditions = [];
        let active = true;

        for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
            const line = rawLine.trim();
            if (line.startsWith('!#if ')) {
                const condition = evaluatePreprocessorCondition(line.slice('!#if '.length));
                conditions.push({ parentActive: active, condition });
                active = active && condition === true;
                continue;
            }
            if (line === '!#else') {
                const frame = conditions[conditions.length - 1];
                active = Boolean(frame?.parentActive && frame.condition === false);
                continue;
            }
            if (line === '!#endif') {
                const frame = conditions.pop();
                active = frame?.parentActive ?? true;
                continue;
            }
            if (!line || line.startsWith('!') || line.startsWith('[')) continue;
            // 平台條件內的 removal 不冒險啟用，但 `@@` 例外可保守保護其他遠端來源。
            if (!active && !line.startsWith('@@')) continue;
            const rule = parseTextRule(line);
            if (rule) rules.push(rule);
        }
        return rules;
    }

    /**
     * 驗證 TXT 是否保有足夠規則、例外與相對 last-known-good 大小，避免截斷檔覆蓋快取。
     *
     * @param {TextRuleSource} source 來源完整性門檻。
     * @param {string} text 待驗證的原始文字。
     * @param {TextRule[]} rules 已編譯的安全規則。
     * @param {number} [lastKnownLength=0] 上一份有效文字長度。
     * @returns {boolean} 通過固定與相對完整性門檻時為 true。
     */
    function isValidTextRuleSet(source, text, rules, lastKnownLength = 0) {
        if (text.length < source.minBytes || rules.length < source.minRules) return false;
        if (rules.filter(rule => rule.exception).length < source.minExceptions) return false;
        return lastKnownLength === 0 || text.length >= lastKnownLength * 0.8;
    }

    /**
     * 合併各 TXT 來源並按原始標準規則去重，例外另行保存以便優先判定。
     *
     * @returns {void}
     * @sideeffect 更新目前頁面共用的 TXT 移除與例外規則陣列。
     */
    function rebuildTextRules() {
        const uniqueRules = new Map();
        for (const sourceRules of textRulesBySource.values()) {
            for (const rule of sourceRules) {
                const key = `${rule.exception ? 'exception' : 'remove'}:${rule.canonical}`;
                if (!uniqueRules.has(key)) uniqueRules.set(key, rule);
            }
        }
        const merged = [...uniqueRules.values()];
        textRules = merged.filter(rule => !rule.exception);
        textExceptions = merged.filter(rule => rule.exception);
    }

    /**
     * 判斷一條 TXT 規則是否適用目前完整 URL 與目的 hostname。
     *
     * @param {TextRule} rule 待判斷規則。
     * @param {URL} urlObj 已解析的網址。
     * @param {string} originalHref 尚未移除任何參數的完整網址。
     * @returns {boolean} URL mask 與所有 hostname scope 都符合時為 true。
     */
    function matchesTextRuleURL(rule, urlObj, originalHref) {
        if (rule.urlPattern && !rule.urlPattern.test(originalHref)) return false;
        return rule.hostScopes.every(scope => matchesHostScope(urlObj.hostname, scope));
    }

    /**
     * 判斷 TXT removeparam action 是否符合單一查詢參數。
     *
     * @param {TextRule} rule 已符合 URL 範圍的規則。
     * @param {QueryPair} pair 單一查詢參數。
     * @returns {boolean} action 要移除或保護該參數時為 true。
     */
    function matchesTextRuleAction(rule, pair) {
        if (rule.actionType === 'all') return true;
        if (rule.actionType === 'name') return pair.name === rule.paramName;
        return Boolean(rule.paramPattern?.test(pair.normalized));
    }

    /**
     * 清除網址中的本地、ClearURLs 與三份 TXT 追蹤參數。
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
            if (!urlObj.search || urlObj.search === '?') return null;

            const originalHref = urlObj.href;
            const pairs = urlObj.search.slice(1).split('&').map(parseQueryPair);

            // 本地規則維持獨立且最高優先，遠端例外不會改變既有清理行為。
            const matchedSiteParams = new Set();
            const matchedSiteRegexes = [];
            for (const rule of SITE_RULES) {
                if (!matchesSiteRule(urlObj, rule)) continue;
                for (const param of rule.params) matchedSiteParams.add(param);
                matchedSiteRegexes.push(...(rule.regexParams || []));
            }

            // ClearURLs provider 仍使用既有完整 URL pattern 與 provider 例外。
            const matchedRemoteStrings = new Set();
            const matchedRemoteRegexes = [];
            if (textRulesReady) {
                for (const provider of remoteRules) {
                    if (!provider.pattern.test(originalHref)) continue;
                    if (provider.exceptions?.some(ex => ex.test(originalHref))) continue;
                    for (const name of provider.stringRules) matchedRemoteStrings.add(name);
                    matchedRemoteRegexes.push(...provider.regexRules);
                }
            }

            // 所有 URL scope 都以尚未刪除參數的網址計算，避免條件規則受處理順序影響。
            const matchedTextRules = textRulesReady ? textRules.filter(rule =>
                matchesTextRuleURL(rule, urlObj, originalHref)) : [];
            const matchedTextExceptions = textRulesReady ? textExceptions.filter(rule =>
                matchesTextRuleURL(rule, urlObj, originalHref)) : [];
            const keptPairs = [];

            for (const pair of pairs) {
                const localRemoval = GENERAL_STRING_PARAMS.has(pair.name) ||
                    matchedSiteParams.has(pair.name) ||
                    matchedSiteRegexes.some(pattern => pattern.test(pair.name)) ||
                    GENERAL_REGEX_PARAMS.some(pattern => pattern.test(pair.name));
                const remoteException = matchedTextExceptions.some(rule =>
                    matchesTextRuleAction(rule, pair));
                const clearUrlsRemoval = matchedRemoteStrings.has(pair.name) ||
                    matchedRemoteRegexes.some(pattern => pattern.test(pair.name));
                const textRemoval = matchedTextRules.some(rule => matchesTextRuleAction(rule, pair));

                if (!localRemoval && (remoteException || (!clearUrlsRemoval && !textRemoval))) {
                    keptPairs.push(pair.raw);
                }
            }

            if (keptPairs.length === pairs.length) return null;
            urlObj.search = keptPairs.length > 0 ? `?${keptPairs.join('&')}` : '';
            return urlObj.href;
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
            url: CLEARURLS_RULE_URL,
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

    /**
     * 取得單一 TXT 來源的規則快取鍵。
     *
     * @param {string} sourceId 遠端來源識別字。
     * @returns {string} GM 儲存空間中的規則鍵。
     */
    function getTextRulesCacheKey(sourceId) {
        return `textRules:${sourceId}`;
    }

    /**
     * 取得單一 TXT 來源的更新時間快取鍵。
     *
     * @param {string} sourceId 遠端來源識別字。
     * @returns {string} GM 儲存空間中的時間鍵。
     */
    function getTextRulesTimeKey(sourceId) {
        return `textRulesTime:${sourceId}`;
    }

    /**
     * 背景下載並原子替換單一 TXT 來源；失敗時保留該來源的最後成功規則。
     *
     * @param {TextRuleSource} source 待更新的來源設定。
     * @param {(updated: boolean) => void} onSettled 請求完成後通知初始化屏障的 callback。
     * @returns {void}
     * @sideeffect 發出 GM_xmlhttpRequest、寫入該來源快取，並可能重新清理目前網址。
     */
    function loadTextRuleSource(source, onSettled) {
        GM_xmlhttpRequest({
            method: 'GET',
            url: source.url,
            timeout: 10000,
            onload: (res) => {
                if (res.status !== 200 || typeof res.responseText !== 'string' ||
                    res.responseText.length === 0 || res.responseText.length > MAX_TEXT_RESPONSE_SIZE) {
                    onSettled(false);
                    return;
                }

                const compiled = compileTextRules(res.responseText);
                const lastKnownLength = textRuleSourceLengths.get(source.id) || 0;
                if (!isValidTextRuleSet(source, res.responseText, compiled, lastKnownLength)) {
                    onSettled(false);
                    return;
                }
                textRulesBySource.set(source.id, compiled);
                textRuleSourceLengths.set(source.id, res.responseText.length);
                rebuildTextRules();
                GM_setValue(getTextRulesCacheKey(source.id), res.responseText);
                GM_setValue(getTextRulesTimeKey(source.id), Date.now());
                onSettled(true);
            },
            onerror: () => onSettled(false),
            ontimeout: () => onSettled(false)
        });
    }

    /**
     * 從三份獨立快取載入 TXT 規則，並只背景更新缺少或過期的來源。
     *
     * @returns {void}
     * @sideeffect 讀取 GM 儲存空間，重建合併規則，並可能發出三個獨立請求。
     */
    function initializeTextRuleSources() {
        const now = Date.now();
        const sourcesToUpdate = [];
        const sourcesMissingCache = new Set();
        for (const source of TEXT_RULE_SOURCES) {
            const cachedText = GM_getValue(getTextRulesCacheKey(source.id), null);
            const cacheTime = GM_getValue(getTextRulesTimeKey(source.id), 0);
            let hasValidCache = false;
            if (typeof cachedText === 'string') {
                const compiled = compileTextRules(cachedText);
                if (isValidTextRuleSet(source, cachedText, compiled)) {
                    textRulesBySource.set(source.id, compiled);
                    textRuleSourceLengths.set(source.id, cachedText.length);
                    hasValidCache = true;
                }
            }
            if (!hasValidCache || now - cacheTime >= source.maxAge) {
                sourcesToUpdate.push(source);
                if (!hasValidCache) sourcesMissingCache.add(source.id);
            }
        }
        rebuildTextRules();
        textRulesReady = sourcesMissingCache.size === 0;
        let pendingMissingSources = sourcesMissingCache.size;

        for (const source of sourcesToUpdate) {
            loadTextRuleSource(source, (updated) => {
                if (sourcesMissingCache.has(source.id)) {
                    pendingMissingSources -= 1;
                    if (pendingMissingSources === 0) {
                        textRulesReady = true;
                        cleanCurrentURL();
                    }
                    return;
                }
                if (updated && textRulesReady) cleanCurrentURL();
            });
        }
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

    // 三份 TXT 各自使用來源宣告的更新週期；任何來源失敗都不會清空其他來源或本地規則。
    initializeTextRuleSources();

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
