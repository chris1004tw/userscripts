'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROJECT_ROOT,
  readUserScript,
} = require('./helpers/userscript-harness');

const SCRIPT_INDEX = [
  { file: 'remove-url-tracker.user.js', entry: 'cleanURL', test: 'tests/remove-url-tracker.test.js' },
  { file: 'copy-current-url.user.js', entry: 'copyCurrentUrl', test: 'tests/copy-current-url.test.js' },
  { file: 'social-media-volume-fix.user.js', entry: 'syncToPage', test: 'tests/social-media-volume-fix.test.js' },
  { file: 'bypass-medium-paywall.user.js', entry: 'redirect', test: 'tests/bypass-medium-paywall.test.js' },
  { file: 'threads-auto-reveal-spoiler.user.js', entry: 'queueScan', test: 'tests/threads-auto-reveal-spoiler.test.js' },
  { file: 'gemini-fixed-mode.user.js', entry: 'switchToMode', test: 'tests/gemini-fixed-mode.test.js' },
  { file: 'force-fonts-applegothic.user.js', entry: 'init', test: 'tests/force-fonts-applegothic.test.js' },
];

const TYPED_SCRIPT_FILES = SCRIPT_INDEX.map(script => script.file);

/**
 * 從 userscript metadata block 解析單值欄位。
 *
 * @param {string} source userscript 完整原始碼。
 * @returns {Record<string, string>} 以 metadata 名稱為 key 的字串資料。
 */
function parseMetadata(source) {
  const metadata = {};
  for (const match of source.matchAll(/^\/\/ @(\S+)\s+(.+)$/gm)) {
    metadata[match[1]] = match[2].trim();
  }
  return metadata;
}

/**
 * 從 README 安裝表格找出指定 userscript 的版本欄位。
 *
 * @param {string} readme README 完整文字。
 * @param {string} fileName userscript 檔名。
 * @returns {string | null} 表格版本；找不到對應列時回傳 null。
 */
function findReadmeVersion(readme, fileName) {
  const row = readme.split(/\r?\n/).find(line => line.includes(`/raw/main/${fileName})`));
  if (!row) return null;

  const columns = row.split('|').map(column => column.trim());
  return columns[3] || null;
}

/**
 * 找出具名 function 宣告及其參數字串，供 T15 型別文件完整性檢查。
 *
 * @param {string} source userscript 完整原始碼。
 * @returns {Array<{name: string, params: string, index: number}>} 具名函式的位置與簽章。
 */
function findNamedFunctions(source) {
  const functions = [];
  const patterns = [
    /^\s*\(?\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gm,
    /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\(([^)]*)\)/gm,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      functions.push({ name: match[1], params: match[2].trim(), index: match.index });
    }
  }
  return functions.sort((left, right) => left.index - right.index);
}

/**
 * 取得緊鄰指定位置前方的 JSDoc；一般區塊註解不視為型別文件。
 *
 * @param {string} source userscript 完整原始碼。
 * @param {number} index 具名函式起始位置。
 * @returns {string | null} JSDoc 文字，找不到時回傳 null。
 */
function findLeadingJsdoc(source, index) {
  const prefix = source.slice(0, index).trimEnd();
  if (!prefix.endsWith('*/')) return null;

  const commentStart = prefix.lastIndexOf('/*');
  if (commentStart < 0 || !prefix.startsWith('/**', commentStart)) return null;
  return prefix.slice(commentStart);
}

test('Given README 安裝表格，When 比對 metadata，Then 七支腳本版本完全同步', () => {
  const readme = fs.readFileSync(path.join(PROJECT_ROOT, 'README.md'), 'utf8');

  for (const script of SCRIPT_INDEX) {
    const metadata = parseMetadata(readUserScript(script.file));
    assert.equal(findReadmeVersion(readme, script.file), metadata.version, script.file);
  }
});

test('Given 七支正式腳本，When 檢查可追溯性，Then 都有 README 反向連結與行為測試', () => {
  for (const script of SCRIPT_INDEX) {
    assert.match(
      readUserScript(script.file),
      /^\/\/ 維護索引：README\.md「維護索引」$/m,
      script.file,
    );
    assert.equal(fs.existsSync(path.join(PROJECT_ROOT, script.test)), true, script.test);
  }
});

test('Given README 維護索引，When 查找每支腳本，Then 同列列出來源入口與測試檔', () => {
  const readme = fs.readFileSync(path.join(PROJECT_ROOT, 'README.md'), 'utf8');
  const indexStart = readme.indexOf('## 維護索引');
  assert.notEqual(indexStart, -1, 'README 缺少維護索引章節');
  const indexSection = readme.slice(indexStart);

  for (const script of SCRIPT_INDEX) {
    const row = indexSection.split(/\r?\n/).find(line => line.includes(script.file));
    assert.ok(row, `${script.file} 缺少維護索引列`);
    assert.match(row, new RegExp(`\\b${script.entry}\\b`), `${script.file} 缺少入口函式`);
    assert.ok(row.includes(script.test), `${script.file} 缺少測試路徑`);
  }
});

test('Given Gemini 與 Threads metadata，When 顯示功能摘要，Then 涵蓋三模型、思考開關與影片', () => {
  const gemini = parseMetadata(readUserScript('gemini-fixed-mode.user.js'));
  const threads = parseMetadata(readUserScript('threads-auto-reveal-spoiler.user.js'));

  assert.match(gemini.description, /Flash-Lite.*Flash.*Pro.*延伸思考/);
  assert.match(threads.description, /影片/);
});

test('Given 七支正式 userscript，When 掃描具名函式，Then 每個簽章都有相鄰 JSDoc 型別', () => {
  for (const fileName of TYPED_SCRIPT_FILES) {
    const source = readUserScript(fileName);
    const functions = findNamedFunctions(source);
    assert.ok(functions.length > 0, `${fileName} 應至少有一個具名函式`);

    for (const declaration of functions) {
      const jsdoc = findLeadingJsdoc(source, declaration.index);
      assert.ok(jsdoc, `${fileName}:${declaration.name} 缺少相鄰 JSDoc`);
      assert.match(jsdoc, /@returns\s+\{/, `${fileName}:${declaration.name} 缺少回傳型別`);
      if (declaration.params) {
        assert.match(jsdoc, /@param\s+\{/, `${fileName}:${declaration.name} 缺少參數型別`);
      }
    }
  }
});
