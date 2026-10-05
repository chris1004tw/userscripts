'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runUserScript } = require('./helpers/userscript-harness');

function createHarness({ options = ['Auto', '720p', '840p', '240p'], iframe = false, initiallyOpen = false } = {}) {
  const events = {};
  const timers = new Map();
  let nextTimer = 0;
  let stage = initiallyOpen ? 'settings' : 'closed';
  const observers = [];
  const snapshots = [];
  const menus = [];
  const newMenu = () => {
    const values = new Map([['opacity', ['0.9', 'important']]]);
    const menu = {
      parentElement: { contains: () => true },
      contains: () => false,
      querySelector: () => null,
      style: {
        getPropertyValue: key => values.get(key)?.[0] || '',
        getPropertyPriority: key => values.get(key)?.[1] || '',
        setProperty: (key, value, priority) => values.set(key, [value, priority]),
        removeProperty: key => values.delete(key),
      },
    };
    menus.push(menu);
    return menu;
  };
  let menu = newMenu();
  const clicks = [];
  const button = (text, action, label = '') => ({
    textContent: text, isConnected: true, disabled: false,
    getAttribute: name => name === 'aria-label' ? label : null,
    getClientRects: () => [{}],
    click: () => {
      snapshots.push({ text: label || text, opacity: menu.style.getPropertyValue('opacity') });
      clicks.push(label || text);
      action();
      observers.forEach(observer => observer.callback?.());
    },
  });
  const settings = button('', () => { stage = stage === 'closed' ? 'settings' : 'closed'; }, 'Settings');
  const quality = button('QualityAuto', () => { stage = 'quality'; menu = newMenu(); });
  const choices = options.map(text => button(text, () => { stage = 'settings'; }));
  const group = {
    querySelectorAll: () => {
      const result = stage === 'closed' ? [settings] : stage === 'settings' ? [settings, quality] : [settings, button('Quality', () => {}), ...choices];
      for (const item of result) if (item !== settings) item.parentElement = menu;
      return result;
    },
  };
  const root = {
    parentElement: null, isConnected: true,
    querySelectorAll: selector => selector === 'video' ? [video] : [group],
  };
  const video = {
    tagName: 'VIDEO', paused: false, ended: false, isConnected: true,
    currentSrc: 'blob:first', srcObject: null, parentElement: root,
    getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 300, right: 500, width: 500, height: 300 }),
  };
  const document = {
    body: {}, documentElement: {},
    querySelectorAll: () => [video],
    addEventListener: (type, fn) => { events[type] = fn; },
    removeEventListener: type => { delete events[type]; },
  };
  const window = {
    innerHeight: 800, innerWidth: 1200,
    addEventListener: (type, fn) => { events[type] = fn; },
  };
  window.self = window;
  window.top = iframe ? {} : window;
  runUserScript('facebook-highest-quality.user.js', {
    window, document, location: { href: 'https://www.facebook.com/watch/?v=123' },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.push(this); }
      disconnect() { this.callback = null; }
    },
    requestAnimationFrame: fn => { const id = ++nextTimer; timers.set(id, fn); return id; },
    cancelAnimationFrame: id => timers.delete(id),
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const flush = () => {
    let count = 0;
    while (timers.size) {
      assert.ok(++count < 100, 'quality attempts must converge');
      const [id, fn] = timers.entries().next().value;
      timers.delete(id);
      fn();
    }
  };
  const step = () => {
    const [id, fn] = timers.entries().next().value;
    timers.delete(id);
    fn();
  };
  return { clicks, video, events, timers, flush, root, snapshots, menus, step };
}

test('selects numeric maximum rather than Auto or first item, and leaves controls closed', () => {
  const h = createHarness();
  h.flush();
  assert.deepEqual(h.clicks, ['Settings', 'QualityAuto', '840p', 'Settings']);
  h.events.playing({ target: h.video });
  h.flush();
  assert.equal(h.clicks.length, 4, 'reentrant playing must not reopen the menu');
});

test('a reused video with a new media source gets its own quality selection', () => {
  const h = createHarness();
  h.flush();
  h.video.currentSrc = 'blob:second';
  h.events.playing({ target: h.video });
  h.flush();
  assert.equal(h.clicks.filter(label => label === '840p').length, 2);
});

test('an unrecognized quality menu stops instead of clicking Auto or unrelated controls', () => {
  const h = createHarness({ options: ['Auto', 'Playback speed', '2x'] });
  h.flush();
  assert.deepEqual(h.clicks, ['Settings', 'QualityAuto', 'Settings']);
});

test('a player containing multiple videos is not guessed', () => {
  const h = createHarness();
  h.root.querySelectorAll = selector => selector === 'video' ? [h.video, {}] : [];
  h.flush();
  assert.deepEqual(h.clicks, []);
});

test('user interaction during selection cancels further automatic clicks', () => {
  const h = createHarness();
  h.events.pointerdown({ isTrusted: true });
  h.flush();
  assert.deepEqual(h.clicks, []);
});

test('pagehide cancels work except when entering bfcache', () => {
  const h = createHarness();
  h.events.pagehide({ persisted: true });
  h.flush();
  assert.ok(h.clicks.includes('840p'));
  h.video.currentSrc = 'blob:next';
  h.events.playing({ target: h.video });
  h.events.pagehide({ persisted: false });
  h.flush();
  assert.equal(h.clicks.filter(label => label === '840p').length, 1);
});

test('iframes do not register handlers or start selection', () => {
  const h = createHarness({ iframe: true });
  assert.deepEqual(Object.keys(h.events), []);
  assert.equal(h.timers.size, 0);
});

test('automatic menus remain transparent across submenu replacement and restore original styles', () => {
  const h = createHarness();
  h.flush();
  assert.equal(h.snapshots.find(item => item.text === 'QualityAuto').opacity, '0');
  assert.equal(h.snapshots.find(item => item.text === '840p').opacity, '0');
  for (const menu of h.menus) {
    assert.equal(menu.style.getPropertyValue('opacity'), '0.9');
    assert.equal(menu.style.getPropertyPriority('opacity'), 'important');
    assert.equal(menu.style.getPropertyValue('transition'), '');
    assert.equal(menu.style.getPropertyValue('pointer-events'), '');
  }
});

test('timeout restores all hidden menu branches', () => {
  const h = createHarness({ options: ['Auto'] });
  h.flush();
  assert.equal(h.snapshots.find(item => item.text === 'QualityAuto').opacity, '0');
  assert.ok(h.menus.every(menu => menu.style.getPropertyValue('opacity') === '0.9'));
});

test('manual input and pagehide restore menus immediately without waiting for another frame', () => {
  for (const type of ['pointerdown', 'keydown', 'pagehide']) {
    const h = createHarness();
    h.step();
    assert.equal(h.menus[0].style.getPropertyValue('opacity'), '0');
    h.events[type]({ isTrusted: true, persisted: false });
    assert.equal(h.menus[0].style.getPropertyValue('opacity'), '0.9');
    h.flush();
    assert.equal(h.clicks.includes('840p'), false);
  }
});

test('a manually opened menu is neither hidden nor operated', () => {
  const h = createHarness({ initiallyOpen: true });
  h.flush();
  assert.deepEqual(h.clicks, []);
  assert.equal(h.menus[0].style.getPropertyValue('opacity'), '0.9');
});
