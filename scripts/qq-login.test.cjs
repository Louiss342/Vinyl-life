// QQ 登录 UX 回归：esbuild 编译真实扫码弹窗源码后在 vm 执行；无需网络与 Obsidian。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

function bundle(entry) {
  const abs = path.join(__dirname, '..', entry);
  return esbuild.buildSync({
    entryPoints: [abs],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian', '@electron/remote', 'electron'],
  }).outputFiles[0].text;
}

const qrSource = bundle('src/views/qr-login-modal.ts');

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
  createDiv(options) {
    return this.createEl('div', options);
  }
  setText(text) {
    this.textContent = text;
  }
  addClass() {}
  empty() {
    this.children = [];
  }
  removeAttribute(name) {
    delete this[name];
  }
  addEventListener(name, handler) {
    this.events[name] = handler;
  }
  all() {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}

// —— 扫码弹窗 harness（同 qr-login.test.cjs，增加 provider 参数）——
function setupQr(overrides = {}, opts) {
  const jobs = new Map();
  let nextId = 0;
  const window = {
    setInterval: (callback) => {
      jobs.set(++nextId, { callback, interval: true });
      return nextId;
    },
    clearInterval: (id) => jobs.delete(id),
    setTimeout: (callback) => {
      jobs.set(++nextId, { callback });
      return nextId;
    },
    clearTimeout: (id) => jobs.delete(id),
  };
  const stats = { begin: 0, check: 0, status: 0 };
  const auth = {
    async beginQr() {
      stats.begin++;
      return { key: `qr-${stats.begin}`, qrimg: 'data:image/png;base64,AAAA' };
    },
    async checkQr() {
      stats.check++;
      return 801;
    },
    async getStatus() {
      stats.status++;
      return { loggedIn: true, nick: '测试账号', userId: 42, cookieBytes: 100, serverOk: true };
    },
    ...overrides,
  };
  class Modal {
    constructor(app) {
      this.app = app;
      this.contentEl = new Element('div');
      this.titleEl = new Element('div');
      this.modalEl = new Element('div'); // 真机上的弹窗壳：markVinylModal（全直角）往它上面挂类名
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(qrSource, {
    module,
    exports: module.exports,
    require: (name) => (name === 'obsidian' ? { Modal, TFile: class {} } : require(name)),
    window,
    Buffer,
  });
  const modal = new module.exports.QrLoginModal({}, { auth, server: {} }, opts);
  return {
    modal,
    exports: module.exports,
    auth,
    stats,
    jobs,
    status: () =>
      modal.contentEl
        .all()
        .find((el) => el.cls === 'vinyl-qr-section')
        .children.find((el) => el.cls === 'vinyl-muted').textContent,
    text: () => modal.contentEl.all().map((el) => el.textContent).join('\n'),
    async tick() {
      const first = jobs.entries().next().value;
      if (!first) return;
      const [id, job] = first;
      if (!job.interval) jobs.delete(id);
      await job.callback();
      // 定时器回调不再把轮询 Promise 返回出来（代码里改为抽成 tick 方法 + void 点火），
      // 故这里补一个宏任务等这一轮真正跑完；断言本身不变。
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('QQ 扫码弹窗文案：QQ 音乐 / 手机 QQ 扫码 / 无 MUSIC_U', async () => {
  const h = setupQr({}, { provider: setupQrProvider() });
  await h.modal.onOpen();
  assert.match(h.modal.titleEl.textContent, /QQ 音乐登录/);
  const text = h.text();
  assert.match(text, /手机 QQ 扫码/);
  assert.doesNotMatch(text, /MUSIC_U/);
  assert.equal(h.exports.qqQrProvider().tempPng, 'qr-login-tmp-qq.png');
});

function setupQrProvider() {
  // provider 从编译产物获取（保证测的是真实导出；用函数取是为了切语言后文案跟着变）
  const module = { exports: {} };
  vm.runInNewContext(qrSource, {
    module,
    exports: module.exports,
    require: (name) => (name === 'obsidian' ? { Modal: class {}, TFile: class {} } : require(name)),
    window: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
    Buffer,
  });
  return module.exports.qqQrProvider();
}

test('QQ 扫码状态机复用 800/801/802/803 协议', async () => {
  const codes = [801, 802, 803];
  const h = setupQr({ checkQr: async () => codes.shift() }, { provider: setupQrProvider() });
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

test('QQ 扫码弹窗写明「用手机 QQ 扫」；netease 默认文案不受影响', async () => {
  const qq = setupQr({}, { provider: setupQrProvider() });
  await qq.modal.onOpen();
  assert.match(qq.text(), /手机 QQ 扫码/, 'QQ 互联二维码只能用手机 QQ 扫，必须写明');
  const ne = setupQr({});
  await ne.modal.onOpen();
  assert.doesNotMatch(ne.text(), /手机 QQ/, 'netease 默认文案不得改变');
});

test('netease 默认文案保持不变（无 provider 参数时）', async () => {
  const h = setupQr({});
  await h.modal.onOpen();
  assert.match(h.modal.titleEl.textContent, /网易云登录/);
  const text = h.text();
  assert.match(text, /网易云音乐 App 扫码/);
  assert.doesNotMatch(text, /qm_keyst/);
});
