// ==UserScript==
// @name         NCC 驗證碼自動辨識
// @namespace    https://chris.taipei
// @version      0.1
// @description  在 NCC 型式認證查詢頁面本機辨識並填入五位數字驗證碼，提供重新辨識按鈕，不自動送出查詢。
// @author       chris1004tw
// @match        https://nccmember.ncc.gov.tw/etrade2/QRY/QRY02*
// @noframes
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js
// @run-at       document-idle
// @updateURL    https://github.com/chris1004tw/userscripts/raw/main/ncc-captcha-solver.user.js
// @downloadURL  https://github.com/chris1004tw/userscripts/raw/main/ncc-captcha-solver.user.js
// ==/UserScript==
// Co-authored with Claude Opus 4.6 Thinking
// 維護索引：README.md「維護索引」
// 架構文件：CLAUDE.md「NCC 驗證碼辨識」

(() => {
  'use strict';

  if (window.self !== window.top) return;

  const OCR_TIMEOUT_MS = 60_000;
  const CAPTCHA_WAIT_TIMEOUT_MS = 15_000;
  let captchaObserver = null;
  let waitObserver = null;
  let waitTimeout = null;
  let statusElement = null;
  let retryButton = null;
  let captchaInput = null;
  let recognitionQueue = Promise.resolve();
  let cancelRecognition = null;
  let solveGeneration = 0;
  let inputRevision = 0;
  let lastQueuedSource = '';
  let lastQueuedImage = null;
  let lastAutoValue = '';
  let writingInput = false;
  let destroyed = false;

  /**
   * 以主色分離字元，不以固定字槽或亮度門檻裁掉淺色、位移的數字。
   * @param {HTMLImageElement} image 已解碼的目前圖片。
   * @returns {Array<{canvas: HTMLCanvasElement, angle: number, center: number}>} 左至右五個字元。
   */
  function extractDigitMasks(image) {
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('圖片尚未載入');
    const source = document.createElement('canvas');
    // 統一為 NCC 原生 200px 寬度，讓形態學半徑不受輸入縮放影響。
    source.width = 200;
    source.height = Math.round(image.naturalHeight * 200 / image.naturalWidth);
    const context = source.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('瀏覽器不支援 Canvas 2D');
    context.drawImage(image, 0, 0, source.width, source.height);
    const pixels = context.getImageData(0, 0, source.width, source.height).data;
    const counts = new Map();
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 220) continue;
      const color = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
      counts.set(color, (counts.get(color) || 0) + 1);
    }
    const colors = [];
    for (const [color, count] of [...counts].sort((a, b) => b[1] - a[1])) {
      if (count < 4) break;
      const rgb = [color >> 16, (color >> 8) & 255, color & 255];
      if (colors.some(other => (
        (other[0] - rgb[0]) ** 2 + (other[1] - rgb[1]) ** 2
        + (other[2] - rgb[2]) ** 2 <= 25
      ))) continue;
      colors.push(rgb);
      if (colors.length === 5) break;
    }
    if (colors.length !== 5) throw new Error('無法分離五個驗證碼字元');
    return colors.map(color => createDigitMask(pixels, source.width, source.height, color))
      .sort((a, b) => a.center - b.center);
  }

  /**
   * 用 opening 找出粗筆畫的最大近接區域，再還原該範圍內的原始筆畫。
   * opening 只決定邊界，不直接當 OCR 影像，避免侵蝕細筆畫與孔洞。
   * @param {Uint8ClampedArray} pixels RGBA 圖片。
   * @param {number} width 原圖寬度。
   * @param {number} height 原圖高度。
   * @param {number[]} color 字元主色 RGB。
   * @returns {{canvas: HTMLCanvasElement, angle: number, center: number}} 字元影像與幾何資訊。
   */
  function createDigitMask(pixels, width, height, color) {
    const size = width * height;
    const mask = new Uint8Array(size);
    const opened = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) {
      const offset = i * 4;
      mask[i] = pixels[offset + 3] >= 10
        && (pixels[offset] - color[0]) ** 2
        + (pixels[offset + 1] - color[1]) ** 2
        + (pixels[offset + 2] - color[2]) ** 2 <= 25 ? 1 : 0;
    }
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) count += mask[(y + dy) * width + x + dx];
        }
        if (count !== 9) continue;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) opened[(y + dy) * width + x + dx] = 1;
        }
      }
    }
    const queue = new Int32Array(size);
    let largest = 0;
    let bounds = null;
    for (let start = 0; start < size; start += 1) {
      if (!opened[start]) continue;
      queue[0] = start;
      opened[start] = 0;
      let length = 1;
      let left = width;
      let right = 0;
      let top = height;
      let bottom = 0;
      for (let at = 0; at < length; at += 1) {
        const x = queue[at] % width;
        const y = Math.floor(queue[at] / width);
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        // 連接被干擾線切開的小間隙，不把遠處殘留的線段算進字元。
        for (let ny = Math.max(0, y - 3); ny <= Math.min(height - 1, y + 3); ny += 1) {
          for (let nx = Math.max(0, x - 3); nx <= Math.min(width - 1, x + 3); nx += 1) {
            const next = ny * width + nx;
            if (!opened[next]) continue;
            opened[next] = 0;
            queue[length++] = next;
          }
        }
      }
      if (length > largest) {
        largest = length;
        bounds = [left, right, top, bottom];
      }
    }
    if (!bounds) throw new Error('驗證碼字元沒有有效筆畫');
    const left = Math.max(0, bounds[0] - 1);
    const right = Math.min(width - 1, bounds[1] + 1);
    const top = Math.max(0, bounds[2] - 1);
    const bottom = Math.min(height - 1, bounds[3] + 1);
    const canvas = document.createElement('canvas');
    canvas.width = right - left + 1;
    canvas.height = bottom - top + 1;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const output = context.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        if (!mask[y * width + x]) continue;
        const offset = ((y - top) * canvas.width + x - left) * 4;
        output.data[offset] = output.data[offset + 1] = output.data[offset + 2] = 0;
        count += 1;
        sumX += x;
        sumY += y;
        sumXX += x * x;
        sumYY += y * y;
        sumXY += x * y;
      }
    }
    context.putImageData(output, 0, 0);
    const xx = sumXX - sumX * sumX / count;
    const yy = sumYY - sumY * sumY / count;
    const xy = sumXY - sumX * sumY / count;
    return { canvas, center: sumX / count, angle: Math.atan2(2 * xy, yy - xx) / 2 };
  }

  /**
   * 重組等高且互不重疊的字元，另產生幾何校正版本供整行辨識。
   * @param {Array<{canvas: HTMLCanvasElement, angle: number}>} digits 字元影像。
   * @param {boolean} deskew 是否依像素共變異量校正傾斜。
   * @returns {HTMLCanvasElement} 白底黑字整行影像。
   */
  function prepareCaptchaCanvas(digits, deskew) {
    const canvas = document.createElement('canvas');
    canvas.width = 420;
    canvas.height = 100;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    digits.forEach((digit, index) => {
      const source = digit.canvas;
      const scale = 60 / source.height;
      context.save();
      context.translate(50 + index * 80, 50);
      if (deskew) context.rotate(digit.angle);
      context.drawImage(source, -source.width * scale / 2, -30, source.width * scale, 60);
      context.restore();
    });
    return canvas;
  }

  /**
   * 旋轉後依實際墨跡重新裁切，正規化字寬，避免傾斜造成的空白影響 OCR。
   * @param {HTMLCanvasElement} digit 單字遮罩。
   * @param {number} angle 旋轉角度。
   * @returns {HTMLCanvasElement} 具有留白邊界的單字影像。
   */
  function renderDigitCanvas(digit, angle) {
    const rotated = document.createElement('canvas');
    rotated.width = rotated.height = 120;
    const context = rotated.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 120, 120);
    context.translate(60, 60);
    context.rotate(angle * Math.PI / 180);
    const scale = 60 / Math.max(digit.width, digit.height);
    context.drawImage(digit, -digit.width * scale / 2, -digit.height * scale / 2,
      digit.width * scale, digit.height * scale);
    const pixels = context.getImageData(0, 0, 120, 120).data;
    let left = 120;
    let right = -1;
    let top = 120;
    let bottom = -1;
    for (let y = 0; y < 120; y += 1) {
      for (let x = 0; x < 120; x += 1) {
        if (pixels[(y * 120 + x) * 4] >= 128) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    if (right < left) throw new Error('旋轉後字元沒有有效筆畫');
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 100;
    const target = canvas.getContext('2d');
    target.fillStyle = '#fff';
    target.fillRect(0, 0, 80, 100);
    target.drawImage(rotated, left, top, right - left + 1, bottom - top + 1, 20, 20, 40, 60);
    return canvas;
  }

  /**
   * 有限角度搜尋；同分的不同字元視為不確定，不任意挑選其中一個。
   * @param {object} worker Tesseract worker。
   * @param {HTMLCanvasElement} digit 單字遮罩。
   * @param {() => boolean} isStopped 是否已逾時或卸載。
   * @returns {Promise<{text: string, confidence: number}>} 最佳單字，或空白不確定結果。
   */
  async function classifyDigit(worker, digit, isStopped) {
    let text = '';
    let confidence = 0;
    let ambiguous = false;
    for (const angle of [-45, -30, -15, 0, 15, 30, 45]) {
      if (isStopped()) throw new Error('辨識已取消');
      const { data } = await worker.recognize(renderDigitCanvas(digit, angle));
      const candidate = data.text.replace(/\s/g, '');
      if (!/^\d$/.test(candidate) || !Number.isFinite(data.confidence)) continue;
      if (data.confidence > confidence) {
        text = candidate;
        confidence = data.confidence;
        ambiguous = false;
      } else if (data.confidence === confidence && candidate !== text) {
        ambiguous = true;
      }
    }
    return { text: ambiguous ? '' : text, confidence };
  }

  /**
   * 在有限時間內完成圖片解碼、worker 建立與本機辨識；每輪釋放 worker。
   * @param {HTMLImageElement} image 目前圖片。
   * @returns {Promise<{text: string, confidence: number}>} OCR 原始結果。
   */
  async function solveCaptcha(image) {
    let worker = null;
    let stopped = false;
    let timeout;
    const stop = () => {
      stopped = true;
      if (worker) {
        const current = worker;
        worker = null;
        void Promise.resolve(current.terminate()).catch(() => {});
      }
    };
    const interrupted = new Promise((resolve, reject) => {
      cancelRecognition = () => {
        stop();
        reject(new Error('辨識已取消'));
      };
      timeout = setTimeout(() => {
        stop();
        reject(new Error('辨識逾時，請重新辨識或手動輸入'));
      }, OCR_TIMEOUT_MS);
    });
    const recognition = (async () => {
      await image.decode();
      if (stopped) throw new Error('辨識已取消');
      const digits = extractDigitMasks(image);
      const created = await Tesseract.createWorker('eng', 1, {
        workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js',
        corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0',
        langPath: 'https://tessdata.projectnaptha.com/4.0.0',
      });
      if (stopped) {
        await created.terminate();
        throw new Error('辨識已取消');
      }
      worker = created;
      await worker.setParameters({
        tessedit_char_whitelist: '0123456789',
        tessedit_pageseg_mode: '7',
      });
      let candidate = '';
      let confidence = 100;
      for (const deskew of [false, true]) {
        if (stopped) throw new Error('辨識已取消');
        const { data } = await worker.recognize(prepareCaptchaCanvas(digits, deskew));
        const text = data.text.replace(/\s/g, '');
        if (!/^\d{5}$/.test(text) || !Number.isFinite(data.confidence) || data.confidence < 80) continue;
        if (candidate && candidate !== text) return { text: '', confidence: 0 };
        candidate = text;
        confidence = Math.min(confidence, data.confidence);
      }
      if (!candidate) return { text: '', confidence: 0 };
      if (stopped) throw new Error('辨識已取消');
      await worker.setParameters({ tessedit_pageseg_mode: '10' });
      for (let index = 0; index < digits.length; index += 1) {
        const result = await classifyDigit(worker, digits[index].canvas, () => stopped);
        if (result.text !== candidate[index] || result.confidence < 80) {
          return { text: '', confidence: 0 };
        }
        confidence = Math.min(confidence, result.confidence);
      }
      return { text: candidate, confidence };
    })();
    try {
      return await Promise.race([recognition, interrupted]);
    } finally {
      clearTimeout(timeout);
      cancelRecognition = null;
      stop();
    }
  }

  /**
   * 同步 Blazor backing value，避免自己的事件被視為手動輸入。
   * @param {HTMLInputElement} input 驗證碼欄位。
   * @param {string} value 新值。
   * @returns {void} 派送 bubbling input/change。
   */
  function setInputValue(input, value) {
    writingInput = true;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (descriptor?.set) descriptor.set.call(input, value);
      else input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } finally {
      writingInput = false;
    }
  }

  /** @returns {void} 手動輸入（包括清空）使進行中结果失效。 */
  function handleInput() {
    if (writingInput) return;
    inputRevision += 1;
    lastAutoValue = '';
    statusElement.textContent = '已手動修改；如需 OCR，請清空後按重新辨識。';
  }

  /**
   * 僅填入最新圖片的可信五位結果，保護辨識期間的手動操作。
   * @param {number} generation 圖片／請求世代。
   * @param {number} revision 排隊時的輸入版本。
   * @returns {Promise<void>} 完成本輪辨識或提示。
   */
  async function processCaptcha(generation, revision) {
    if (destroyed || generation !== solveGeneration || revision !== inputRevision) return;
    const image = document.querySelector('.divCaptach')?.querySelector('img[src^="data:image/"]');
    const input = captchaInput;
    if (!image || !input) return;
    if (input.value && input.value !== lastAutoValue) {
      statusElement.textContent = '保留手動輸入；如需 OCR，請先清空。';
      return;
    }
    const source = image.src;
    retryButton.disabled = true;
    statusElement.textContent = '本機 OCR 辨識中，首次需下載辨識模型…';
    try {
      const result = await solveCaptcha(image);
      if (destroyed || generation !== solveGeneration || revision !== inputRevision
        || image.src !== source || image !== lastQueuedImage) return;
      if (input.value && input.value !== lastAutoValue) return;
      const text = result.text.replace(/\s/g, '');
      if (!/^\d{5}$/.test(text) || !Number.isFinite(result.confidence) || result.confidence < 80) {
        statusElement.textContent = '辨識不確定，請手動輸入或更新圖片後重試。';
        return;
      }
      setInputValue(input, text);
      lastAutoValue = text;
      statusElement.textContent = `已填入 ${text}；請核對圖片後手動送出。`;
    } catch (error) {
      if (destroyed || generation !== solveGeneration || revision !== inputRevision) return;
      statusElement.textContent = 'OCR 辨識失敗，請手動輸入或按重新辨識。';
      console.warn('[NCC 驗證碼辨識]', error);
    } finally {
      if (!destroyed) retryButton.disabled = false;
    }
  }

  /**
   * 合併圖片更新並串行辨識；重試可對相同圖片再次執行。
   * @param {boolean} force 是否由重新辨識按鈕觸發。
   * @returns {void} 更新辨識佇列。
   */
  function queueCaptchaRecognition(force = false) {
    if (destroyed) return;
    const image = document.querySelector('.divCaptach')?.querySelector('img[src^="data:image/"]');
    if (!image) {
      solveGeneration += 1;
      lastQueuedImage = null;
      return;
    }
    if (!force && image === lastQueuedImage && image.src === lastQueuedSource) return;
    if (captchaInput.value && captchaInput.value === lastAutoValue) setInputValue(captchaInput, '');
    lastAutoValue = '';
    lastQueuedSource = image.src;
    lastQueuedImage = image;
    const generation = ++solveGeneration;
    const revision = inputRevision;
    recognitionQueue = recognitionQueue.then(() => processCaptcha(generation, revision));
  }

  /** @returns {void} 重試目前圖片，不刷新伺服器驗證碼。 */
  function retryRecognition() {
    queueCaptchaRecognition(true);
  }

  /**
   * 在輸入列加入按鈕與狀態，監聽動態驗證碼。
   * @param {HTMLElement} container NCC captcha 容器。
   * @returns {boolean} 是否成功找到欄位並啟用。
   */
  function activate(container) {
    if (destroyed || captchaObserver) return false;
    captchaInput = container.parentElement?.querySelector('input[maxlength="5"]');
    if (!captchaInput) return false;
    retryButton = document.createElement('button');
    retryButton.type = 'button';
    retryButton.className = 'ncc-captcha-solver-retry';
    retryButton.textContent = '重新辨識驗證碼';
    retryButton.style.marginInlineStart = '0.75rem';
    statusElement = document.createElement('span');
    statusElement.className = 'ncc-captcha-solver-status';
    statusElement.role = 'status';
    statusElement.style.marginInlineStart = '0.75rem';
    container.parentElement.append(retryButton);
    container.parentElement.append(statusElement);
    captchaInput.addEventListener('input', handleInput);
    retryButton.addEventListener('click', retryRecognition);
    captchaObserver = new MutationObserver(() => queueCaptchaRecognition());
    captchaObserver.observe(container, {
      attributes: true, attributeFilter: ['src'], childList: true, subtree: true,
    });
    queueCaptchaRecognition();
    return true;
  }

  /** @returns {void} 有期限地等待 Blazor 建立完整輸入列。 */
  function waitForCaptcha() {
    const existing = document.querySelector('.divCaptach');
    if (existing && activate(existing)) return;
    if (!document.body) return;
    waitObserver = new MutationObserver(() => {
      const container = document.querySelector('.divCaptach');
      if (!container || !activate(container)) return;
      waitObserver.disconnect();
      waitObserver = null;
      clearTimeout(waitTimeout);
      waitTimeout = null;
    });
    waitObserver.observe(document.body, { childList: true, subtree: true });
    waitTimeout = setTimeout(() => {
      waitObserver?.disconnect();
      waitObserver = null;
      waitTimeout = null;
    }, CAPTCHA_WAIT_TIMEOUT_MS);
  }

  /**
   * 真正卸載時中止工作；bfcache 保留可用狀態。
   * @param {PageTransitionEvent} event 頁面生命週期事件。
   * @returns {void} 清理 observer、timer、worker 與事件。
   */
  function cleanup(event) {
    if (event.persisted) return;
    destroyed = true;
    solveGeneration += 1;
    captchaObserver?.disconnect();
    waitObserver?.disconnect();
    clearTimeout(waitTimeout);
    cancelRecognition?.();
    captchaInput?.removeEventListener('input', handleInput);
    retryButton?.removeEventListener('click', retryRecognition);
    if (retryButton) retryButton.disabled = true;
    window.removeEventListener('pagehide', cleanup);
  }

  window.addEventListener('pagehide', cleanup);
  waitForCaptcha();
})();
