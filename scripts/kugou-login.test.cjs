// 酷狗登录 UX 回归：esbuild 编译真实扫码弹窗源码后在 vm 执行；无需网络与 Obsidian。
// 与 qq-login.test.cjs 同构：provider 化之后，每个源各自锁自己的文案与临时图名。
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

/** provider 从编译产物获取（保证测的是真实导出；用函数取是为了切语言后文案跟着变） */
function kugouProvider() {
  const module = { exports: {} };
  vm.runInNewContext(qrSource, {
    module,
    exports: module.exports,
    require: (name) => (name === 'obsidian' ? { Modal: class {}, TFile: class {} } : require(name)),
    window: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
    Buffer,
  });
  return module.exports.kugouQrProvider();
}

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
      this.modalEl = new Element('div');
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
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('酷狗扫码弹窗文案：酷狗音乐登录 / 用酷狗 App 扫 / 独立临时图名', async () => {
  const h = setupQr({}, { provider: kugouProvider() });
  await h.modal.onOpen();
  assert.match(h.modal.titleEl.textContent, /酷狗音乐登录/);
  const text = h.text();
  assert.match(text, /酷狗音乐 App 扫码/);
  assert.doesNotMatch(text, /MUSIC_U|qm_keyst/, '不得混入其他平台的凭据字样');
  assert.equal(kugouProvider().tempPng, 'qr-login-tmp-kugou.png', '临时图名独立（并发时不撞名）');
});

test('酷狗扫码状态机复用 800/801/802/803 协议，成功后不丢弃会话', async () => {
  const codes = [801, 802, 803];
  const h = setupQr({ checkQr: async () => codes.shift() }, { provider: kugouProvider() });
  await h.modal.onOpen();
  await h.tick();
  assert.match(h.status(), /等待扫码/);
  await h.tick();
  assert.match(h.status(), /确认/);
  assert.equal(h.stats.status, 0);
  await h.tick();
  assert.match(h.status(), /已登录/);
  assert.equal(h.stats.status, 1);
  assert.equal(h.stats.begin, 1, '授权成功不得重建二维码会话');
  assert.equal(h.jobs.size, 0);
});

test('未登录是酷狗的常态：状态行文案不把「未登录」渲染成错误', async () => {
  const h = setupQr(
    {
      getStatus: async () => ({ loggedIn: false, cookieBytes: 0, serverOk: true }),
    },
    { provider: kugouProvider() }
  );
  await h.modal.onOpen();
  await h.tick();
  assert.doesNotMatch(h.modal.contentEl.all().map((el) => el.cls).join(' '), /is-error/);
});

test('netease 默认文案不受酷狗 provider 影响（无 provider 参数时）', async () => {
  const h = setupQr({});
  await h.modal.onOpen();
  assert.match(h.modal.titleEl.textContent, /网易云登录/);
  assert.match(h.text(), /网易云音乐 App 扫码/);
  assert.doesNotMatch(h.text(), /酷狗/);
});
