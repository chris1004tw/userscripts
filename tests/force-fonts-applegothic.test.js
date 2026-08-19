'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { readUserScript, runUserScript } = require('./helpers/userscript-harness');

const SCRIPT_FILE = 'force-fonts-applegothic.user.js';
const TARGET_FONT = 'AppleGothic, AppleGothicSC, "Malgun Gothic", "Apple Monochrome Emoji Ind", "SF Pro Icons", "SF Pro Text", sans-serif';
const CODE_FONT = '"Cascadia Code", "Cascadia Mono", Consolas, "SF Mono", "JetBrains Mono", AppleGothic, AppleGothicSC, monospace';

/**
 * 建立只包含 CSS 注入、黑名單與選單 API 的 userscript 執行環境。
 *
 * @param {{ hostname?: string, blacklist?: string[], confirmResult?: boolean }} [options={}] 測試網址、初始黑名單與確認結果。
 * @returns {{ styles: string[], menus: Array<{ label: string, callback: Function }>, writes: Array<{ key: string, value: unknown }>, alerts: string[], run: () => void }} 可執行腳本並觀察外部副作用的測試環境。
 */
function createEnvironment(options = {}) {
  const hostname = options.hostname || 'example.com';
  let blacklist = [...(options.blacklist || [])];
  const styles = [];
  const menus = [];
  const writes = [];
  const alerts = [];
  const window = {};
  window.self = window;
  window.top = window;

  return {
    styles,
    menus,
    writes,
    alerts,
    run() {
      runUserScript(SCRIPT_FILE, {
        window,
        location: { hostname },
        GM_addStyle(css) {
          styles.push(css);
        },
        GM_getValue(key, fallback) {
          return key === 'blacklist' ? [...blacklist] : fallback;
        },
        GM_setValue(key, value) {
          const normalizedValue = Array.isArray(value) ? [...value] : value;
          writes.push({ key, value: normalizedValue });
          if (key === 'blacklist') blacklist = normalizedValue;
        },
        GM_registerMenuCommand(label, callback) {
          menus.push({ label, callback });
        },
        alert(message) {
          alerts.push(message);
        },
        confirm() {
          return options.confirmResult !== false;
        },
      });
    },
  };
}

test('Given 網站未停用，When 腳本啟動，Then 只需注入一份 CSS 即完成字體替換', () => {
  const environment = createEnvironment();

  assert.doesNotThrow(() => environment.run());
  assert.equal(environment.styles.length, 1);
  assert.equal(environment.menus.length, 3);
});

test('Given 網站位於黑名單，When 腳本啟動，Then 保留管理選單但不注入 CSS', () => {
  const environment = createEnvironment({ blacklist: ['example.com'] });

  environment.run();

  assert.equal(environment.styles.length, 0);
  assert.match(environment.menus[0].label, /啟用此網站/);
});

test('Given 多分頁可能修改黑名單，When 切換目前網站，Then callback 重新讀取並以 Set 去重', () => {
  const environment = createEnvironment({ blacklist: ['other.example', 'other.example'] });
  environment.run();

  environment.menus[0].callback();

  assert.deepEqual(environment.writes, [{
    key: 'blacklist',
    value: ['other.example', 'example.com'],
  }]);
  assert.match(environment.alerts[0], /重新整理後生效/);
});

test('Given 一般、簡體與程式碼內容，When 產生 CSS，Then中文一律優先使用 AppleGothic', () => {
  const environment = createEnvironment();
  environment.run();
  const css = environment.styles[0];

  assert.ok(css.includes(`font-family: ${TARGET_FONT} !important`));
  assert.doesNotMatch(css, /font-family:\s*AppleGothicSC,\s*AppleGothic/);
  assert.ok(css.includes(`font-family: ${CODE_FONT} !important`));
  assert.ok(css.includes('#read-only-cursor-text-area'));
  assert.ok(css.includes('pre'));
  assert.ok(css.includes('code'));
});
test('Given GitHub Code view 程式碼區塊，When 產生 CSS，Then 保留專屬 selector 並套用等寬字體', () => {
  const environment = createEnvironment();
  environment.run();
  const css = environment.styles[0];
  const codeRule = css.match(/([^{}]+)\{\s*font-family:\s*"Cascadia Code"[^{}]*\}/s)?.[0];
  const githubCodeSelectors = [
    '.react-code-lines',
    ':where(.react-code-lines *)',
    '.react-code-text',
    '.react-file-line',
    '.react-line-number',
    '.blob-code',
    '.blob-num',
    '.highlight pre',
    '.highlight code',
    'code',
    'pre:has(code)',
    ':where(pre *)',
    ':where(code *)',
    'kbd',
    'samp',
    'tt',
  ];

  assert.ok(codeRule, '應存在程式碼字體規則');
  for (const selector of githubCodeSelectors) {
    assert.ok(codeRule.includes(selector), `程式碼字體規則應包含 selector：${selector}`);
  }
  assert.match(codeRule, /font-family:\s*"Cascadia Code"/);
});

test('Given GitHub 首頁共用 data-hpc 與 padding utility class，When 產生程式碼 CSS，Then 不得把版面容器改成等寬字體', () => {
  const environment = createEnvironment();
  environment.run();
  const css = environment.styles[0];
  const codeRule = css.match(/([^{}]+)\{\s*font-family:\s*"Cascadia Code"[^{}]*\}/s)?.[0];

  assert.ok(codeRule, '應存在程式碼字體規則');
  assert.doesNotMatch(codeRule, /\[data-hpc="true"\]/);
  assert.doesNotMatch(codeRule, /\[class\*="pl-"\]/);
  assert.doesNotMatch(codeRule, /\[class\*="react-code"\]/);
  assert.doesNotMatch(codeRule, /\[class\*="react-blob"\]/);
});

test('Given GitHub Code view 的可選取程式碼 textarea，When 產生 CSS，Then exact selector 保有一般規則無法覆蓋的特異性', () => {
  const environment = createEnvironment();
  environment.run();
  const css = environment.styles[0];
  const codeRule = css.match(/([^{}]+)\{\s*font-family:\s*"Cascadia Code"[^{}]*\}/s)?.[1];

  assert.ok(codeRule, '應存在程式碼字體規則');
  assert.match(codeRule, /#read-only-cursor-text-area/);
  assert.doesNotMatch(codeRule, /:where\([^)]*#read-only-cursor-text-area[^)]*\)/s);
});


test('Given 淘寶 site-nav-icon 與常見 Icon class，When 產生排除 selector，Then 保留邊界明確的 Icon Font', () => {
  const environment = createEnvironment();
  environment.run();
  const css = environment.styles[0];

  assert.ok(css.includes('[class~="icon" i]'));
  assert.ok(css.includes('[class^="fa-" i]'));
  assert.ok(css.includes('[class*=" fa-" i]'));
  assert.ok(css.includes('[class$="-icon" i]'));
  assert.ok(css.includes('[class*="-icon " i]'));
  assert.ok(css.includes('[class*="-icon-" i]'));
  assert.ok(css.includes('[data-icon]'));
  assert.doesNotMatch(css, /\[class\*="icon" i\]/);
  assert.doesNotMatch(css, /aria-hidden|role="img"/);
});

test('Given checkbox 與 radio，When 套用全域字體，Then 保留原生控制元件字體', () => {
  const environment = createEnvironment();
  environment.run();
  const css = environment.styles[0];

  assert.ok(css.includes(':not(input[type="checkbox"])'));
  assert.ok(css.includes(':not(input[type="radio"])'));
});

test('Given CSS 優先架構，When 檢查正式腳本，Then 不再掃描 DOM 或攔截 Canvas', () => {
  const source = readUserScript(SCRIPT_FILE);

  assert.doesNotMatch(source, /MutationObserver|CanvasRenderingContext2D/);
  assert.doesNotMatch(source, /querySelectorAll|requestAnimationFrame|getComputedStyle/);
  assert.doesNotMatch(source, /data-no-font|processElement|forceRescan/);
});

test('Given 精簡版功能範圍，When 檢查 metadata，Then 明確描述 CSS 與常見 Icon 保護', () => {
  const source = readUserScript(SCRIPT_FILE);

  assert.match(source, /^\/\/ @version\s+0\.4\.8$/m);
  assert.match(source, /^\/\/ @description\s+使用 CSS 將一般頁面字體改為 AppleGothic，並保留常見 Icon Font 與程式碼字體$/m);
});
