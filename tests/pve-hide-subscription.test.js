'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readUserScript, runUserScript } = require('./helpers/userscript-harness');

test('Metadata targets port 8006 on arbitrary hosts, not other ports or URL paths mentioning 8006', () => {
  const include = readUserScript('pve-hide-subscription.user.js').match(/^\/\/ @include\s+\/(.+)\/$/m);
  assert.ok(include);
  const pattern = new RegExp(include[1]);
  for (const url of ['https://pve.example.org:8006/', 'http://192.168.1.2:8006/#v1', 'https://[fd00::1]:8006/']) {
    assert.equal(pattern.test(url), true, url);
  }
  for (const url of ['https://pve.example.org/', 'https://pve.example.org:80060/', 'https://example.org/path:8006/', 'https://example.org/?next=https://pve:8006/']) {
    assert.equal(pattern.test(url), false, url);
  }
});

function createDialog(options = {}) {
  const dialog = {
    nodeType: 1,
    isConnected: true,
    hidden: false,
    title: options.title ?? 'No valid subscription',
    message: options.message ?? 'You do not have a valid subscription for this server. Please visit www.proxmox.com to get a list of available options.',
    clicks: 0,
    getAttribute: () => dialog.hidden ? 'true' : 'false',
    getClientRects: () => dialog.hidden ? [] : [{}],
    matches: selector => selector === '.x-message-box[role="alertdialog"]',
    closest: () => dialog,
    querySelector: selector => ({ textContent: selector === '.x-title-text' ? dialog.title : dialog.message }),
    querySelectorAll: () => dialog.buttons,
  };
  dialog.buttons = (options.buttons ?? ['OK']).map(textContent => ({
    textContent,
    disabled: false,
    getAttribute: () => 'false',
    getClientRects: () => [{}],
    click() { dialog.clicks++; dialog.hidden = true; },
  }));
  return dialog;
}

function createEnvironment(dialogs = []) {
  const frames = new Map();
  const events = {};
  let nextFrame = 0;
  let observer;
  const window = { addEventListener: (name, fn) => { events[name] = fn; } };
  window.self = window.top = window;
  runUserScript('pve-hide-subscription.user.js', {
    window,
    document: { body: {}, querySelectorAll: () => dialogs },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observer = this; }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
    requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  return {
    mutate: target => observer.callback([{ target, addedNodes: [] }]),
    add: target => observer.callback([{ target: { nodeType: 1, closest: () => null }, addedNodes: [target] }]),
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); },
    pagehide: persisted => events.pagehide({ persisted }),
    frames,
    get disconnected() { return !!observer.disconnected; },
  };
}

test('Only the subscription notice is acknowledged; other warnings and confirmation buttons remain untouched', () => {
  const notice = createDialog();
  const warning = createDialog({ title: 'Error' });
  const differentBody = createDialog({ message: 'Delete this server?' });
  const confirmation = createDialog({ buttons: ['OK', 'Cancel'] });
  const env = createEnvironment([notice, warning, differentBody, confirmation]);
  env.flush();
  assert.equal(notice.clicks, 1);
  for (const dialog of [warning, differentBody, confirmation]) assert.equal(dialog.clicks, 0);
});

test('A newly inserted or reused Ext JS message box is acknowledged on each subscription presentation', () => {
  const env = createEnvironment();
  const dialog = createDialog();
  env.add(dialog);
  env.flush();
  assert.equal(dialog.clicks, 1);
  dialog.hidden = false;
  dialog.title = 'Error';
  env.mutate(dialog);
  env.flush();
  assert.equal(dialog.clicks, 1);
  dialog.title = 'No valid subscription';
  env.mutate(dialog);
  env.flush();
  assert.equal(dialog.clicks, 2);
});

test('Detached and hidden dialogs are not clicked; pagehide cancels work except for bfcache', () => {
  const dialog = createDialog();
  dialog.hidden = true;
  const env = createEnvironment([dialog]);
  env.flush();
  assert.equal(dialog.clicks, 0);
  dialog.hidden = false;
  dialog.isConnected = false;
  env.mutate(dialog);
  env.flush();
  assert.equal(dialog.clicks, 0);
  dialog.isConnected = true;
  env.mutate(dialog);
  env.pagehide(true);
  env.flush();
  assert.equal(dialog.clicks, 1);
  assert.equal(env.disconnected, false);
  dialog.hidden = false;
  env.mutate(dialog);
  env.pagehide(false);
  env.flush();
  assert.equal(dialog.clicks, 1);
  assert.equal(env.disconnected, true);
  assert.equal(env.frames.size, 0);
});
