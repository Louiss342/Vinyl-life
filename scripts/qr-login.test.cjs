// Exercise the actual TypeScript modal without requiring a running Obsidian app.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

// vm 与测试的 Promise 跨 Realm 结算需要宏任务级 flush，单个微任务不足以驱动断言
const flush = () => new Promise((resolve) => setImmediate(resolve));

const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/views/qr-login-modal.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian'],
}).outputFiles[0].text;

class Element {
  constructor(tag, options = {}) {
    this.tag = tag;
    this.textContent = options.text || '';
    this.cls = options.cls || '';
    this.children = [];
    this.events = {};
    this.value = '';
    this.disabled = false;
  }
  createEl(tag, options) {
    const child = new Element(tag, options);
    this.children.push(child);
    return child;
  }
  createDiv(options) { return this.createEl('div', options); }
  setText(text) { this.textContent = text; }
  addClass() {}
  empty() { this.children = []; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(name, handler) { this.events[name] = handler; }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function setup(overrides = {}) {
  const jobs = new Map();
  let nextId = 0;
  const window = {
    setInterval: callback => { jobs.set(++nextId, { callback, interval: true }); return nextId; },
    clearInterval: id => jobs.delete(id),
    setTimeout: callback => { jobs.set(++nextId, { callback }); return nextId; },
    clearTimeout: id => jobs.delete(id),
  };
  const stats = { begin: 0, check: 0, status: 0 };
  const auth = {
    async beginQr() { stats.begin++; return { key: `qr-${stats.begin}`, qrimg: 'data:image/png;base64,AAAA' }; },
    async checkQr() { stats.check++; return 801; },
    async getStatus() { stats.status++; return { loggedIn: true, nick: '测试账号', userId: 42 }; },
    async saveCookie() {},
    ...overrides,
  };
  class Modal {
    constructor(app) { this.app = app; this.contentEl = new Element('div'); this.titleEl = new Element('div'); }
  }
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: name => name === 'obsidian' ? { Modal, TFile: class {} } : require(name),
    window,
    Buffer,
    AbortController,
  });
  const modal = new module.exports.QrLoginModal({}, { auth, server: {} });
  return {
    modal, auth, stats, jobs,
    status: () => modal.contentEl.all().find(el => el.cls === 'vinyl-qr-section').children.find(el => el.cls === 'vinyl-muted').textContent,
    refresh: () => modal.contentEl.all().find(el => el.tag === 'button' && el.textContent.includes('刷新二维码')),
    textarea: () => modal.contentEl.all().find(el => el.tag === 'textarea'),
    save: () => modal.contentEl.all().find(el => el.tag === 'button' && el.textContent === '保存 Cookie'),
    async tick() {
      const first = jobs.entries().next().value;
      if (!first) return;
      const [id, job] = first;
      if (!job.interval) jobs.delete(id);
      await job.callback();
    },
  };
}

test('801 waits, 802 requests phone confirmation, only 803 verifies the saved session', async () => {
  const codes = [801, 802, 803];
  const h = setup({ checkQr: async () => codes.shift() });
  await h.modal.onOpen();
  await h.tick();
  assert.match(h.status(), /等待扫码/);
  await h.tick();
  assert.match(h.status(), /确认/);
  assert.equal(h.stats.status, 0);
  await h.tick();
  assert.match(h.status(), /已登录/);
  assert.equal(h.stats.status, 1);
  assert.equal(h.stats.begin, 1, 'successful authorization must not discard the QR session');
  assert.equal(h.jobs.size, 0);
});

test('803 can carry the gateway-verified account without a second fragile status request', async () => {
  const h = setup({
    checkQr: async () => ({
      code: 803,
      state: { loggedIn: true, nick: '一次验证成功', userId: 88, cookieBytes: 128, serverOk: true },
    }),
    getStatus: async () => { throw new Error('不应重复请求'); },
  });
  await h.modal.onOpen();
  await h.tick();
  assert.match(h.status(), /一次验证成功/);
  assert.equal(h.stats.status, 0);
  assert.equal(h.jobs.size, 0);
});

test('800 replaces an expired QR code and resumes polling the new one', async () => {
  const h = setup({ checkQr: async () => 800 });
  await h.modal.onOpen();
  await h.tick();
  assert.equal(h.stats.begin, 2);
  assert.equal(h.jobs.size, 1);
});

test('authorization without a usable saved session stays visibly unsuccessful', async () => {
  const h = setup({ checkQr: async () => 803, getStatus: async () => ({ loggedIn: false }) });
  await h.modal.onOpen();
  await h.tick();
  assert.match(h.status(), /未.*登录会话|登录态无效/);
  assert.doesNotMatch(h.status(), /✅/);
  assert.equal(h.jobs.size, 0);
  assert.ok(h.refresh());
});

test('poll failures are visible and a subsequent check can recover', async () => {
  let attempt = 0;
  const h = setup({ checkQr: async () => { if (++attempt === 1) throw new Error('网络中断'); return 801; } });
  await h.modal.onOpen();
  await h.tick();
  assert.match(h.status(), /失败.*网络中断/);
  await h.tick();
  assert.match(h.status(), /等待扫码/);
});

test('slow checks cannot overlap', async () => {
  const pending = deferred();
  let checks = 0;
  const h = setup({ checkQr: () => { checks++; return pending.promise; } });
  await h.modal.onOpen();
  const first = h.tick();
  const second = h.tick();
  pending.resolve(801);
  await Promise.all([first, second]);
  assert.equal(checks, 1);
  assert.equal(h.jobs.size, 1);
});

test('closing while generating a QR cannot restart polling', async () => {
  const pending = deferred();
  const h = setup({ beginQr: () => pending.promise });
  const opening = h.modal.onOpen();
  h.modal.onClose();
  pending.resolve({ key: 'closed', qrimg: 'data:image/png;base64,AAAA' });
  await opening;
  assert.equal(h.jobs.size, 0);
  assert.equal(h.modal.contentEl.children.length, 0);
});

test('closing during a poll ignores a late authorization result', async () => {
  const pending = deferred();
  const h = setup({ checkQr: () => pending.promise });
  await h.modal.onOpen();
  const checking = h.tick();
  h.modal.onClose();
  pending.resolve(803);
  await checking;
  assert.equal(h.stats.status, 0);
  assert.equal(h.jobs.size, 0);
});

test('manual refresh ignores an old poll result and keeps one timer', async () => {
  const pending = deferred();
  const h = setup({ checkQr: () => pending.promise });
  await h.modal.onOpen();
  const checking = h.tick();
  const refresh = h.refresh();
  assert.ok(refresh, 'a visible refresh button is required');
  await refresh.events.click();
  pending.resolve(803);
  await checking;
  assert.equal(h.stats.begin, 2);
  assert.equal(h.stats.status, 0);
  assert.equal(h.jobs.size, 1);
  assert.doesNotMatch(h.status(), /已登录/);
});

test('refresh while login verification is pending ignores the obsolete result', async () => {
  const pending = deferred();
  let verifying = false;
  const h = setup({ checkQr: async () => 803, getStatus: () => { verifying = true; return pending.promise; } });
  await h.modal.onOpen();
  const checking = h.tick();
  await flush();
  assert.equal(verifying, true);
  assert.ok(h.refresh());
  await h.refresh().events.click();
  pending.resolve({ loggedIn: true, nick: 'obsolete' });
  await checking;
  assert.doesNotMatch(h.status(), /obsolete|已登录/);
  assert.equal(h.jobs.size, 1);
});

test('manual fallback explains HttpOnly cookie retrieval without document.cookie', async () => {
  const h = setup();
  await h.modal.onOpen();
  const text = h.modal.contentEl.all().map(el => el.textContent).join('\n');
  assert.match(text, /Application|应用/);
  assert.match(text, /MUSIC_U/);
  assert.doesNotMatch(text, /document\.cookie/);
});

test('closing during manual Cookie validation aborts the pending account replacement', async () => {
  const pending = deferred();
  let signal;
  const h = setup({ saveCookie: async (_raw, s) => { signal = s; await pending.promise; } });
  await h.modal.onOpen();
  h.textarea().value = 'MUSIC_U=fixture';
  const saving = h.save().events.click();
  await flush();
  h.modal.onClose();
  assert.equal(signal.aborted, true);
  pending.resolve();
  await saving;
  assert.equal(h.modal.contentEl.children.length, 0);
  assert.equal(h.jobs.size, 0);
});
