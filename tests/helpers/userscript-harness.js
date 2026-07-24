'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 讀取專案根目錄中的 userscript 原始碼，供行為測試與靜態斷言共用。
 *
 * @param {string} fileName 相對於專案根目錄的 userscript 檔名。
 * @returns {string} UTF-8 編碼的完整原始碼。
 * @throws {Error} 檔案不存在或無法讀取時，由 Node.js 檔案 API 原樣拋出。
 */
function readUserScript(fileName) {
  return fs.readFileSync(path.resolve(PROJECT_ROOT, fileName), 'utf8');
}

/**
 * 在隔離的 VM context 中執行 userscript，讓測試以最小 DOM／GM stub 驗證外部行為。
 *
 * 設計意圖是測試正式 IIFE 本身，而不是在 production 暴露測試專用 API；呼叫端只需
 * 注入該腳本實際依賴的瀏覽器介面，避免建立超出測試需求的通用 DOM 模擬器。
 *
 * @param {string} fileName 相對於專案根目錄的 userscript 檔名。
 * @param {Record<string, unknown>} [sandbox={}] 要注入 VM 的瀏覽器與 GM API stub。
 * @returns {vm.Context} 已執行腳本的 VM context，供測試觀察被覆寫的 API 與狀態。
 * @throws {Error} userscript 執行失敗時保留原始例外與檔名資訊。
 */
function runUserScript(fileName, sandbox = {}) {
  const context = vm.createContext({
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    ...sandbox,
  });

  vm.runInContext(readUserScript(fileName), context, {
    filename: path.resolve(PROJECT_ROOT, fileName),
  });

  return context;
}

module.exports = {
  PROJECT_ROOT,
  readUserScript,
  runUserScript,
};
