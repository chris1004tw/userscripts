'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runUserScript,
} = require('./helpers/userscript-harness');

/** A deliberately small DOM/event surface used by the userscript. */
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.className = '';
    this.type = '';
    this.textContent = '';
    this.style = {};
    this.listeners = new Map();
  }

  append(...children) {
    for (const child of children) {
      this.children.push(child);
      child.parentElement = this;
    }
  }

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }

  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }

  dispatchEvent(event) {
    for (const callback of this.listeners.get(event.type) || []) callback(event);
    return true;
  }

  click() {
    this.dispatchEvent({ type: 'click', bubbles: true, isTrusted: true });
  }

  matches(selector) {
    if (selector === 'img[src^="data:image/"]') {
      return this.tagName === 'IMG' && this.src.startsWith('data:image/');
    }
    if (selector === 'input[maxlength="5"]') {
      return this.tagName === 'INPUT' && this.maxLength === 5;
    }
    if (selector === 'button.ncc-captcha-solver-retry') {
      return this.tagName === 'BUTTON' && this.className.split(/\s+/).includes('ncc-captcha-solver-retry');
    }
    if (selector === '.ncc-captcha-solver-status') {
      return this.className.split(/\s+/).includes('ncc-captcha-solver-status');
    }
    return false;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const descendant = child.querySelector(selector);
      if (descendant) return descendant;
    }
    return null;
  }
}

class FakeImageElement extends FakeElement {
  constructor(options = {}) {
    super('img');
    this.src = options.src || 'data:image/gif;base64,first';
    this.naturalWidth = 200;
    this.naturalHeight = 60;
    this.decodeCalls = 0;
    this.decodeError = options.decodeError || null;
  }

  decode() {
    this.decodeCalls += 1;
    if (this.decodeError) return Promise.reject(this.decodeError);
    return Promise.resolve();
  }
}

class FakeInputElement extends FakeElement {
  constructor() {
    super('input');
    this.maxLength = 5;
    this._value = '';
    this.dispatchedEvents = [];
  }

  get value() {
    return this._value;
  }

  set value(value) {
    this._value = String(value);
  }

  dispatchEvent(event) {
    this.dispatchedEvents.push(event.type);
    return super.dispatchEvent(event);
  }
}

/** Canvas methods are real enough to exercise mask extraction and rendering. */
class FakeCanvasContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#000';
    this.imageSmoothingEnabled = false;
    this.calls = [];
    this.stateStack = [];
    this.pixels = null;
  }

  ensurePixels() {
    const length = Math.max(0, this.canvas.width * this.canvas.height * 4);
    if (!this.pixels || this.pixels.length !== length) {
      this.pixels = new Uint8ClampedArray(length);
    }
    return this.pixels;
  }

  color() {
    if (this.fillStyle === '#fff' || this.fillStyle === 'white') return [255, 255, 255, 255];
    if (this.fillStyle === '#000' || this.fillStyle === 'black') return [0, 0, 0, 255];
    const match = String(this.fillStyle).match(/^#([0-9a-f]{6})$/i);
    if (!match) return [0, 0, 0, 255];
    return [
      Number.parseInt(match[1].slice(0, 2), 16),
      Number.parseInt(match[1].slice(2, 4), 16),
      Number.parseInt(match[1].slice(4, 6), 16),
      255,
    ];
  }

  fillRect(x, y, width, height) {
    this.calls.push(['fillRect', x, y, width, height]);
    const pixels = this.ensurePixels();
    const rgba = this.color();
    const left = Math.max(0, Math.floor(x));
    const top = Math.max(0, Math.floor(y));
    const right = Math.min(this.canvas.width, Math.ceil(x + width));
    const bottom = Math.min(this.canvas.height, Math.ceil(y + height));
    for (let row = top; row < bottom; row += 1) {
      for (let column = left; column < right; column += 1) {
        const offset = (row * this.canvas.width + column) * 4;
        pixels.set(rgba, offset);
      }
    }
  }

  drawImage(source, ...args) {
    this.calls.push(['drawImage', source, ...args]);
    const pixels = this.ensurePixels();
    const sourceWidth = source.width || source.naturalWidth || 1;
    const sourceHeight = source.height || source.naturalHeight || 1;
    const sourcePixels = source instanceof FakeImageElement
      ? source.pixelData
      : source.context?.pixels || source.imageData?.data;
    const destinationX = Number(args[0] || 0);
    const destinationY = Number(args[1] || 0);
    const destinationWidth = Number(args[2] || sourceWidth);
    const destinationHeight = Number(args[3] || sourceHeight);
    if (source instanceof FakeCanvasElement && (destinationX < 0 || destinationY < 0)) {
      // The fake context does not model transforms; provide bounded ink for
      // rotated renderer output so its crop pass observes a real foreground.
      this.fillStyle = '#000';
      this.fillRect(
        Math.max(0, Math.floor(this.canvas.width / 2 - 10)),
        Math.max(0, Math.floor(this.canvas.height / 2 - 15)),
        Math.min(20, this.canvas.width),
        Math.min(30, this.canvas.height),
      );
      return;
    }
    if (!sourcePixels) {
      // Renderers only need a bounded foreground region to exercise cropping.
      this.fillStyle = '#000';
      this.fillRect(
        Math.max(0, Math.floor(this.canvas.width / 2 - 5)),
        Math.max(0, Math.floor(this.canvas.height / 2 - 10)),
        Math.min(10, this.canvas.width),
        Math.min(20, this.canvas.height),
      );
      return;
    }
    for (let row = 0; row < destinationHeight; row += 1) {
      const y = Math.floor(destinationY + row);
      if (y < 0 || y >= this.canvas.height) continue;
      const sourceY = Math.min(sourceHeight - 1, Math.max(0, Math.floor(row * sourceHeight / destinationHeight)));
      for (let column = 0; column < destinationWidth; column += 1) {
        const x = Math.floor(destinationX + column);
        if (x < 0 || x >= this.canvas.width) continue;
        const sourceX = Math.min(sourceWidth - 1, Math.max(0, Math.floor(column * sourceWidth / destinationWidth)));
        const sourceOffset = (sourceY * sourceWidth + sourceX) * 4;
        const destinationOffset = (y * this.canvas.width + x) * 4;
        pixels[destinationOffset] = sourcePixels[sourceOffset] || 0;
        pixels[destinationOffset + 1] = sourcePixels[sourceOffset + 1] || 0;
        pixels[destinationOffset + 2] = sourcePixels[sourceOffset + 2] || 0;
        pixels[destinationOffset + 3] = sourcePixels[sourceOffset + 3] || 0;
      }
    }
  }

  getImageData(x = 0, y = 0, width = this.canvas.width, height = this.canvas.height) {
    this.calls.push(['getImageData', x, y, width, height]);
    const pixels = this.ensurePixels();
    const data = new Uint8ClampedArray(Math.max(0, width * height * 4));
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const sourceX = x + column;
        const sourceY = y + row;
        if (sourceX < 0 || sourceY < 0 || sourceX >= this.canvas.width || sourceY >= this.canvas.height) continue;
        const sourceOffset = (sourceY * this.canvas.width + sourceX) * 4;
        const destinationOffset = (row * width + column) * 4;
        data.set(pixels.slice(sourceOffset, sourceOffset + 4), destinationOffset);
      }
    }
    return { data, width, height };
  }

  putImageData(imageData, ...args) {
    this.calls.push(['putImageData', imageData, ...args]);
    this.canvas.imageData = imageData;
    this.pixels = new Uint8ClampedArray(imageData.data);
  }

  save() {
    this.calls.push(['save']);
    this.stateStack.push({ fillStyle: this.fillStyle, imageSmoothingEnabled: this.imageSmoothingEnabled });
  }

  restore() {
    this.calls.push(['restore']);
    const state = this.stateStack.pop();
    if (state) Object.assign(this, state);
  }

  translate(x, y) {
    this.calls.push(['translate', x, y]);
  }

  rotate(angle) {
    this.calls.push(['rotate', angle]);
  }
}

class FakeCanvasElement extends FakeElement {
  constructor() {
    super('canvas');
    this.width = 0;
    this.height = 0;
    this.imageData = null;
    this.context = new FakeCanvasContext(this);
  }

  getContext() {
    return this.context;
  }
}

function createCaptchaPixels() {
  const width = 200;
  const height = 60;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const colors = [
    [220, 40, 40],
    [40, 220, 40],
    [40, 40, 220],
    [220, 180, 20],
    [180, 40, 220],
  ];
  for (let digit = 0; digit < colors.length; digit += 1) {
    const left = 8 + digit * 38;
    const right = left + 20;
    const color = colors[digit];
    for (let y = 14; y < 46; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = (y * width + x) * 4;
        pixels[offset] = color[0];
        pixels[offset + 1] = color[1];
        pixels[offset + 2] = color[2];
        pixels[offset + 3] = 255;
      }
    }
  }
  return pixels;
}

function createWindow() {
  const listeners = new Map();
  const window = {
    self: null,
    top: null,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) {
      listeners.get(type)?.delete(callback);
    },
    dispatch(type, event = {}) {
      for (const callback of listeners.get(type) || []) callback({ type, ...event });
    },
    listenerCount(type) {
      return listeners.get(type)?.size || 0;
    },
  };
  window.self = window;
  window.top = window;
  return window;
}

/**
 * Tesseract mock: each worker runs the line pass and the seven-angle digit
 * passes. A hold gate applies only to that worker's first recognition so
 * lifecycle tests can interrupt a job without blocking its later work.
 */
function createTesseractMock(results, options = {}) {
  const state = {
    createCalls: 0,
    recognizeCalls: 0,
    terminateCalls: 0,
  };
  const gates = [];
  const releases = [];

  function gateFor(index) {
    if (!options.hold?.includes(index)) return Promise.resolve();
    let resolve;
    const gate = new Promise(done => { resolve = done; });
    gates[index] = gate;
    releases[index] = resolve;
    return gate;
  }

  function jobResult(result = {}) {
    const fallbackText = String(result.text ?? '12345');
    const lineValues = result.lines ?? result.line ?? [
      { text: fallbackText, confidence: result.confidence ?? 96 },
      { text: fallbackText, confidence: result.confidence ?? 96 },
    ];
    const lines = Array.isArray(lineValues) ? lineValues : [lineValues, lineValues];
    const digits = result.digits ?? [...fallbackText];
    return {
      lines,
      digits: typeof digits === 'string' ? [...digits] : digits,
      digitResults: result.digitResults,
      confidence: result.confidence ?? 96,
      digitConfidence: result.digitConfidence ?? result.confidence ?? 96,
    };
  }

  const Tesseract = {
    createWorker(language, oem, workerOptions) {
      const index = state.createCalls;
      state.createCalls += 1;
      const result = jobResult(results[Math.min(index, results.length - 1)]);
      const worker = {
        terminated: false,
        recognitionNumber: 0,
        lineNumber: 0,
        digitNumber: 0,
        async setParameters(parameters) {
          worker.parameters = parameters;
        },
        async recognize(canvas) {
          const callNumber = worker.recognitionNumber;
          worker.recognitionNumber += 1;
          state.recognizeCalls += 1;
          if (callNumber === 0) await gateFor(index);
          if (options.fail?.includes(index) && callNumber === 0) {
            throw new Error(`job ${index} failed`);
          }
          const mode = String(worker.parameters?.tessedit_pageseg_mode ?? '');
          if (mode === '7') {
            const line = result.lines[Math.min(worker.lineNumber, result.lines.length - 1)] || {};
            worker.lineNumber += 1;
            return {
              data: {
                text: String(line.text ?? ''),
                confidence: line.confidence ?? result.confidence,
              },
            };
          }
          const digitIndex = Math.floor(worker.digitNumber / 7);
          const angleIndex = worker.digitNumber % 7;
          worker.digitNumber += 1;
          const configured = result.digitResults?.[digitIndex];
          const digit = Array.isArray(configured)
            ? configured[Math.min(angleIndex, configured.length - 1)]
            : configured;
          const fallback = result.digits[digitIndex] ?? '';
          const output = digit && typeof digit === 'object'
            ? digit
            : { text: digit ?? fallback, confidence: result.digitConfidence };
          return {
            data: {
              text: String(output.text ?? ''),
              confidence: output.confidence ?? result.digitConfidence,
            },
          };
        },
        async terminate() {
          if (!worker.terminated) {
            worker.terminated = true;
            state.terminateCalls += 1;
          }
        },
      };
      return Promise.resolve(worker);
    },
  };

  return {
    Tesseract,
    state,
    release(index) {
      releases[index]?.();
    },
  };
}

function createEnvironment(results = [{ text: '12345', confidence: 96 }], options = {}) {
  const image = new FakeImageElement(options.image);
  image.pixelData = createCaptchaPixels();
  const input = new FakeInputElement();
  const container = new FakeElement('div');
  container.className = 'divCaptach';
  container.append(image);
  const field = new FakeElement('div');
  field.append(container, input);
  const body = new FakeElement('body');
  body.append(field);
  const window = createWindow();
  const tesseract = createTesseractMock(results, options);
  const observers = [];

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      this.options = null;
      observers.push(this);
    }

    observe(target, observerOptions) {
      this.target = target;
      this.options = observerOptions;
    }

    disconnect() {
      this.disconnected = true;
    }

    emit(records) {
      if (!this.disconnected) this.callback(records);
    }
  }

  const document = {
    body,
    querySelector(selector) {
      if (selector === '.divCaptach') return container;
      return body.querySelector(selector);
    },
    createElement(tagName) {
      if (tagName.toLowerCase() === 'canvas') return new FakeCanvasElement();
      return new FakeElement(tagName);
    },
  };

  return {
    sandbox: {
      window,
      document,
      HTMLInputElement: FakeInputElement,
      MutationObserver: FakeMutationObserver,
      Event: class FakeEvent {
        constructor(type, init = {}) {
          this.type = type;
          Object.assign(this, init);
        }
      },
      Tesseract: tesseract.Tesseract,
    },
    body,
    field,
    container,
    image,
    input,
    window,
    observers,
    tesseractState: tesseract.state,
    releaseWorker: tesseract.release,
  };
}

function runNccScript(environment) {
  runUserScript('ncc-captcha-solver.user.js', environment.sandbox);
}

function findRetryButton(environment) {
  return environment.field.querySelector('button.ncc-captcha-solver-retry');
}

function findStatus(environment) {
  return environment.field.querySelector('.ncc-captcha-solver-status');
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('timed out waiting for NCC recognition');
}

test('matching high-confidence line and character evidence fills five digits and dispatches form events', async () => {
  const environment = createEnvironment([{ text: '12345', confidence: 96 }]);
  runNccScript(environment);

  await waitFor(() => environment.input.value === '12345');

  assert.deepEqual(environment.input.dispatchedEvents, ['input', 'change']);
});

test('conflicting high-confidence line outputs refuse to fill', async () => {
  const environment = createEnvironment([{
    lines: [
      { text: '12345', confidence: 96 },
      { text: '54321', confidence: 95 },
    ],
    digits: '12345',
  }]);
  runNccScript(environment);

  await waitFor(() => environment.tesseractState.terminateCalls >= 1);

  assert.equal(environment.input.value, '');
  assert.deepEqual(environment.input.dispatchedEvents, []);
});

test('high-confidence character evidence that disagrees with the line refuses to fill', async () => {
  const environment = createEnvironment([{
    lines: [
      { text: '12345', confidence: 96 },
      { text: '12345', confidence: 95 },
    ],
    digits: '12346',
    digitConfidence: 99,
  }]);
  runNccScript(environment);

  await waitFor(() => environment.tesseractState.terminateCalls >= 1);

  assert.equal(environment.input.value, '');
  assert.deepEqual(environment.input.dispatchedEvents, []);
});

test('conflicting equal best character scores refuse to fill', async () => {
  const environment = createEnvironment([{
    text: '12345',
    confidence: 96,
    digitConfidence: 99,
    digitResults: [
      [
        { text: '1', confidence: 99 },
        { text: '2', confidence: 99 },
        { text: '1', confidence: 98 },
        { text: '1', confidence: 98 },
        { text: '1', confidence: 98 },
        { text: '1', confidence: 98 },
        { text: '1', confidence: 98 },
      ],
    ],
  }]);
  runNccScript(environment);

  await waitFor(() => environment.tesseractState.terminateCalls >= 1);

  assert.equal(environment.input.value, '');
  assert.deepEqual(environment.input.dispatchedEvents, []);
});

test('retrying the same source after a failed job recovers and can replace the prior automatic result', async () => {
  const environment = createEnvironment([
    { text: '12345', confidence: 96 },
    { text: '67890', confidence: 99 },
    { text: '54321', confidence: 99 },
  ], { fail: [0] });
  runNccScript(environment);
  await waitFor(() => environment.tesseractState.terminateCalls >= 1);

  findRetryButton(environment).click();
  await waitFor(() => environment.input.value === '67890');
  findRetryButton(environment).click();
  await waitFor(() => environment.input.value === '54321');

  assert.deepEqual(
    environment.input.dispatchedEvents,
    ['input', 'change', 'input', 'change', 'input', 'change'],
  );
});

test('invalid OCR text and confidence below 80 never fill the input', async () => {
  const invalid = createEnvironment([{ text: '12A45', confidence: 99 }]);
  runNccScript(invalid);
  await waitFor(() => invalid.tesseractState.terminateCalls >= 1);
  assert.equal(invalid.input.value, '');
  assert.deepEqual(invalid.input.dispatchedEvents, []);

  const lowConfidence = createEnvironment([{ text: '12345', confidence: 79 }]);
  runNccScript(lowConfidence);
  await waitFor(() => lowConfidence.tesseractState.terminateCalls >= 1);
  assert.equal(lowConfidence.input.value, '');
  assert.deepEqual(lowConfidence.input.dispatchedEvents, []);
});

test('a newer image drops stale output and fills the latest result', async () => {
  const environment = createEnvironment([
    { text: '11111', confidence: 99 },
    { text: '22222', confidence: 99 },
  ], { hold: [0] });
  runNccScript(environment);
  await waitFor(() => environment.tesseractState.recognizeCalls === 1);

  environment.image.src = 'data:image/gif;base64,second';
  environment.observers[0].emit([{ type: 'attributes', attributeName: 'src' }]);
  environment.image.src = 'data:image/gif;base64,latest';
  environment.observers[0].emit([{ type: 'attributes', attributeName: 'src' }]);
  environment.releaseWorker(0);

  await waitFor(() => environment.input.value === '22222');

  assert.equal(environment.input.value, '22222');
  assert.deepEqual(environment.input.dispatchedEvents, ['input', 'change']);
});

test('manual input, including clearing while recognition is in flight, is never overwritten', async () => {
  const environment = createEnvironment([{ text: '12345', confidence: 99 }], { hold: [0] });
  runNccScript(environment);
  await waitFor(() => environment.tesseractState.recognizeCalls === 1);

  environment.input.value = '99999';
  environment.input.dispatchEvent(new environment.sandbox.Event('input', { bubbles: true }));
  environment.input.value = '';
  environment.input.dispatchEvent(new environment.sandbox.Event('input', { bubbles: true }));
  environment.releaseWorker(0);
  await waitFor(() => environment.tesseractState.terminateCalls >= 1);

  assert.equal(environment.input.value, '');
  assert.deepEqual(environment.input.dispatchedEvents, ['input', 'input']);
});

test('bfcache pagehide keeps the worker alive, while real unload terminates it and blocks output', async () => {
  const environment = createEnvironment([{ text: '12345', confidence: 99 }], { hold: [0] });
  runNccScript(environment);
  await waitFor(() => environment.tesseractState.recognizeCalls === 1);

  environment.window.dispatch('pagehide', { persisted: true });
  assert.equal(environment.tesseractState.terminateCalls, 0);
  environment.window.dispatch('pagehide', { persisted: false });
  await waitFor(() => environment.tesseractState.terminateCalls >= 1);
  environment.releaseWorker(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(environment.input.value, '');
  assert.equal(environment.observers[0].disconnected, true);
});

test('iframe execution leaves captcha controls untouched', async () => {
  const environment = createEnvironment();
  environment.window.top = {};
  runNccScript(environment);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(findRetryButton(environment), null);
  assert.equal(environment.input.value, '');
});
