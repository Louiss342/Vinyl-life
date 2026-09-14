// Browser login regressions: no account or network required.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { transformSync, buildSync } = require('esbuild');

// transform 不打包相对导入，所以沙箱里得手动接上真实词典（browser-login 的文案已走 i18n）
const i18nMod = { exports: {} };
vm.runInNewContext(
  buildSync({
    entryPoints: [path.join(__dirname, '../src/core/i18n.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text,
  { module: i18nMod, exports: i18nMod.exports, require: () => ({}), console }
);

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function harness(save = async () => {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src/core/browser-login.ts'), 'utf8');
  const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  const windows = [];
  const timers = new Set();
  const saved = [];
  let values = [];
  let get = async () => values;
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.session = {
        cookies: { get: (filter) => { assert.equal(filter.url, 'https://music.163.com/'); return get(); } },
        setPermissionRequestHandler: () => {},
        setPermissionCheckHandler: () => {},
        clearStorageData: async () => { this.cleared = true; },
      };
      this.webContents.setWindowOpenHandler = (handler) => { this.windowOpenHandler = handler; };
      windows.push(this);
    }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    setMenuBarVisibility() {}
    isDestroyed() { return this.destroyed; }
    show() { this.shown = true; }
    focus() {}
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const mod = { exports: {} };
  // 生产代码按 Obsidian 要求走 window.setInterval / window.clearInterval（弹出窗口兼容），
  // 沙箱里补一个 window 代理到同一套被追踪的计时器，断言才有意义。
  const windowShim = {
    setInterval: (fn) => { timers.add(fn); return fn; },
    clearInterval: (fn) => timers.delete(fn),
    setTimeout: (fn) => { timers.add(fn); return fn; },
    clearTimeout: (fn) => timers.delete(fn),
  };
  vm.runInNewContext(compiled, {
    module: mod,
    exports: mod.exports,
    require: (name) => {
      if (name === './i18n') return i18nMod.exports;
      if (name === '@electron/remote') return { BrowserWindow };
      if (name === 'electron') return { remote: { BrowserWindow } };
      throw new Error(`Unexpected runtime import: ${name}`);
    },
    URL, AbortController,
    window: windowShim,
    setInterval: (fn) => { timers.add(fn); return fn; },
    clearInterval: (fn) => timers.delete(fn),
  });
  const auth = { saveCookie: async (raw, signal) => { saved.push(raw); await save(raw, signal); } };
  const login = new mod.exports.BrowserLogin(auth);
  return { login, windows, timers, saved, setCookies: (v) => { values = v; }, setGet: (v) => { get = v; } };
}

test('browser login no longer asks users to extract document.cookie or send it in a URI', () => {
  const modal = fs.readFileSync(path.join(__dirname, '../src/views/web-login-modal.ts'), 'utf8');
  assert.ok(!modal.includes('document.cookie'), 'browser login still relies on document.cookie, which cannot read HttpOnly sessions');
  assert.ok(!modal.includes('obsidian://vinyl-login?cookie='));
});

test('official window imports HttpOnly MUSIC_U once, then closes and clears its session', async () => {
  const h = harness();
  const done = h.login.open();
  await tick();
  const win = h.windows[0];
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.ok(!win.options.webPreferences.partition.startsWith('persist:'));
  h.setCookies([{ name: 'MUSIC_U', value: 'fixture-session', httpOnly: true }, { name: '__csrf', value: 'fixture-csrf' }]);
  await h.login.check();
  assert.equal(await done, true);
  assert.deepEqual(h.saved, ['MUSIC_U=fixture-session; __csrf=fixture-csrf']);
  assert.equal(win.destroyed, true);
  assert.equal(win.cleared, true);
  assert.equal(h.timers.size, 0);
});

test('guest cookies never become a login and another open reuses the current window', async () => {
  const h = harness();
  h.setCookies([{ name: 'MUSIC_A', value: 'fixture-anonymous' }]);
  const first = h.login.open();
  const second = h.login.open();
  await tick();
  await h.login.check();
  assert.equal(h.saved.length, 0);
  assert.equal(h.windows.length, 1);
  h.login.cancel();
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(h.timers.size, 0);
});

test('failed validation keeps the login window open for retry', async () => {
  let failing = true;
  const h = harness(async () => { if (failing) throw new Error('会话无效'); });
  const statuses = [];
  const done = h.login.open((value) => statuses.push(value));
  await tick();
  h.setCookies([{ name: 'MUSIC_U', value: 'fixture-session' }]);
  await h.login.check();
  assert.equal(h.windows[0].destroyed, false);
  assert.ok(statuses.some((value) => value.includes('会话无效')));
  failing = false;
  await h.login.check();
  assert.equal(await done, true);
});

test('cookie polling never overlaps and closing ignores a pending cookie read', async () => {
  const read = deferred();
  const h = harness();
  let reads = 0;
  h.setGet(() => { reads++; return read.promise; });
  const done = h.login.open();
  await tick();
  await h.login.check();
  await h.login.check();
  assert.equal(reads, 1);
  h.login.cancel();
  read.resolve([{ name: 'MUSIC_U', value: 'fixture-session' }]);
  await tick();
  assert.equal(await done, false);
  assert.equal(h.saved.length, 0);
});

test('unload aborts an in-flight import before it can commit', async () => {
  const pending = deferred();
  let signal;
  const h = harness(async (_, s) => { signal = s; await pending.promise; });
  const done = h.login.open();
  await tick();
  h.setCookies([{ name: 'MUSIC_U', value: 'fixture-session' }]);
  const check = h.login.check();
  await tick();
  h.login.dispose();
  assert.equal(signal.aborted, true);
  pending.resolve();
  await check;
  assert.equal(await done, false);
  assert.equal(h.windows[0].destroyed, true);
});

test('closing the native window cleans the polling loop', async () => {
  const h = harness();
  const done = h.login.open();
  await tick();
  h.windows[0].destroy();
  assert.equal(await done, false);
  assert.equal(h.timers.size, 0);
});

test('active reflects whether the interactive login window is open', async () => {
  const h = harness();
  assert.equal(h.login.active, false);
  const done = h.login.open();
  assert.equal(h.login.active, true);
  await tick();
  h.login.cancel();
  assert.equal(await done, false);
  assert.equal(h.login.active, false);
});

test('page load error is reported without leaking the page URL', async () => {
  const h = harness();
  const statuses = [];
  const done = h.login.open((value) => statuses.push(value));
  await tick();
  h.windows[0].webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://music.163.com/?secret=fixture', true);
  assert.ok(statuses.some((value) => value.includes('加载失败')));
  assert.ok(statuses.every((value) => !value.includes('secret=')));
  h.login.cancel();
  await done;
});
