// QQ 登录 UX 回归：esbuild 编译真实弹窗 / 登录窗口源码后在 vm 执行；无需网络与 Obsidian。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
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
const webSource = bundle('src/views/web-login-modal.ts');
const browserSource = esbuild.transformSync(
  fs.readFileSync(path.join(__dirname, '../src/core/browser-login.ts'), 'utf8'),
  { loader: 'ts', format: 'cjs', target: 'es2022' }
).code;

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
    async saveCookie() {},
    ...overrides,
  };
  class Modal {
    constructor(app) {
      this.app = app;
      this.contentEl = new Element('div');
      this.titleEl = new Element('div');
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
    },
  };
}

// —— BrowserLogin harness（同 browser-login.test.cjs，支持 options 与 URL 期望）——
const tick = () => new Promise((resolve) => setImmediate(resolve));
function setupBrowser() {
  const windows = [];
  const timers = new Set();
  const saved = [];
  let values = [];
  let allValues = [];
  let expectedUrl = null;
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.session = {
        cookies: {
          get: (filter) => {
            // 会话级查询（无 url 过滤）= 该临时分区全部 Cookie
            if (!filter || !filter.url) return Promise.resolve(allValues.length ? allValues : values);
            if (expectedUrl) assert.equal(filter.url, expectedUrl);
            return Promise.resolve(values);
          },
        },
        setPermissionRequestHandler: () => {},
        setPermissionCheckHandler: () => {},
        clearStorageData: async () => {
          this.cleared = true;
        },
      };
      this.webContents.setWindowOpenHandler = (handler) => {
        this.windowOpenHandler = handler;
      };
      windows.push(this);
    }
    loadURL(url) {
      this.url = url;
      return Promise.resolve();
    }
    setMenuBarVisibility() {}
    isDestroyed() {
      return this.destroyed;
    }
    show() {
      this.shown = true;
    }
    focus() {}
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  const mod = { exports: {} };
  vm.runInNewContext(browserSource, {
    module: mod,
    exports: mod.exports,
    require: (name) => {
      if (name === '@electron/remote') return { BrowserWindow };
      if (name === 'electron') return { remote: { BrowserWindow } };
      throw new Error(`Unexpected runtime import: ${name}`);
    },
    URL,
    AbortController,
    // 生产代码按 Obsidian 要求走 window.setInterval / window.clearInterval（弹出窗口兼容），
    // 沙箱里补一个 window 代理到同一套被追踪的计时器，断言才有意义。
    window: {
      setInterval: (fn) => {
        timers.add(fn);
        return fn;
      },
      clearInterval: (fn) => timers.delete(fn),
      setTimeout: (fn) => {
        timers.add(fn);
        return fn;
      },
      clearTimeout: (fn) => timers.delete(fn),
    },
    setInterval: (fn) => {
      timers.add(fn);
      return fn;
    },
    clearInterval: (fn) => timers.delete(fn),
  });
  const auth = {
    saveCookie: async (raw) => {
      saved.push(raw);
    },
  };
  return {
    mod,
    auth,
    windows,
    timers,
    saved,
    expectUrl: (url) => {
      expectedUrl = url;
    },
    setCookies: (v) => {
      values = v;
    },
    setAllCookies: (v) => {
      allValues = v;
    },
    loginWith(opts) {
      return new mod.exports.BrowserLogin(auth, opts);
    },
  };
}

test('QQ 扫码弹窗文案：QQ 音乐 / qm_keyst / y.qq.com，且不含 MUSIC_U', async () => {
  const h = setupQr({}, { provider: setupQrProvider() });
  await h.modal.onOpen();
  assert.match(h.modal.titleEl.textContent, /QQ 音乐登录/);
  const text = h.text();
  assert.match(text, /QQ 音乐/);
  assert.match(text, /qm_keyst/);
  assert.match(text, /y\.qq\.com/);
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

test('QQ 扫码弹窗给出浏览器登录兜底提示；netease 默认不出现该提示', async () => {
  const qq = setupQr({}, { provider: setupQrProvider() });
  await qq.modal.onOpen();
  assert.match(qq.text(), /浏览器登录/, 'QQ 需提示可改用浏览器窗口（已实测可用）');
  const ne = setupQr({});
  await ne.modal.onOpen();
  assert.doesNotMatch(ne.text(), /浏览器登录/, 'netease 默认文案不得改变');
});

test('netease 默认文案保持不变（无 provider 参数时）', async () => {
  const h = setupQr({});
  await h.modal.onOpen();
  assert.match(h.modal.titleEl.textContent, /网易云登录/);
  const text = h.text();
  assert.match(text, /MUSIC_U/);
  assert.doesNotMatch(text, /qm_keyst/);
});

test('QQ BrowserLogin：过滤 y.qq.com，qm_keyst 才入账，成功后销毁并清理会话', async () => {
  const h = setupBrowser();
  h.expectUrl('https://y.qq.com/');
  const login = h.loginWith(h.mod.exports.QQ_BROWSER_LOGIN);
  const done = login.open();
  await tick();
  h.setCookies([
    { name: 'uin', value: '123456789' },
    { name: 'qqmusic_key', value: '' },
  ]); // 游客态：无有效 qm_keyst
  await login.check();
  assert.equal(h.saved.length, 0);
  h.setCookies([
    { name: 'qm_keyst', value: 'fixture-keyst' },
    { name: 'uin', value: '123456789' },
  ]);
  await login.check();
  assert.deepEqual(h.saved, ['qm_keyst=fixture-keyst; uin=123456789']);
  assert.equal(await done, true);
  assert.equal(h.windows[0].destroyed, true);
  assert.equal(h.windows[0].cleared, true);
  assert.equal(h.timers.size, 0);
});

test('BrowserLogin 两个源的选项常量不被改坏', () => {
  const h = setupBrowser();
  assert.equal(h.mod.exports.QQ_BROWSER_LOGIN.loginUrl, 'https://y.qq.com/');
  assert.equal(h.mod.exports.QQ_BROWSER_LOGIN.requiredCookie, 'qm_keyst');
  assert.equal(h.mod.exports.NETEASE_BROWSER_LOGIN.loginUrl, 'https://music.163.com/');
  assert.equal(h.mod.exports.NETEASE_BROWSER_LOGIN.requiredCookie, 'MUSIC_U');
});

test('QQ 浏览器登录：qm_keyst 只落在子域时，按名兜底捕获（y.qq.com 域下不可见）', async () => {
  const h = setupBrowser();
  h.expectUrl('https://y.qq.com/');
  const login = h.loginWith(h.mod.exports.QQ_BROWSER_LOGIN);
  const done = login.open();
  await tick();
  // y.qq.com 域下只有 uin；凭据只在会话级可见（子域/跨主机落地）
  h.setCookies([{ name: 'uin', value: '123456789' }]);
  h.setAllCookies([
    { name: 'qm_keyst', value: 'subdomain-keyst' },
    { name: 'uin', value: '123456789' },
  ]);
  await login.check();
  assert.equal(h.saved.length, 1, '子域凭据必须能兜底入账');
  assert.ok(h.saved[0].includes('qm_keyst=subdomain-keyst'));
  assert.ok(h.saved[0].includes('uin=123456789'));
  assert.equal(await done, true);
});

test('QQ 浏览器登录：允许 https 弹窗（官方登录页靠 window.opener 回传结果），非 https 仍拒绝', async () => {
  const h = setupBrowser();
  const login = h.loginWith(h.mod.exports.QQ_BROWSER_LOGIN);
  const done = login.open();
  await tick();
  const win = h.windows[0];
  const allow = win.windowOpenHandler({ url: 'https://xui.ptlogin2.qq.com/cgi-bin/xlogin' });
  assert.equal(allow.action, 'allow', 'QQ 登录页依赖弹窗，必须放行 https 弹窗');
  assert.equal(allow.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false);
  assert.equal(allow.overrideBrowserWindowOptions.webPreferences.contextIsolation, true);
  assert.equal(win.windowOpenHandler({ url: 'http://insecure.example/' }).action, 'deny');
  login.cancel();
  await done;
});

test('netease 浏览器登录保持原行为：新链接复用同一窗口（不新开弹窗）', async () => {
  const h = setupBrowser();
  const login = h.loginWith(h.mod.exports.NETEASE_BROWSER_LOGIN);
  const done = login.open();
  await tick();
  const win = h.windows[0];
  assert.equal(win.windowOpenHandler({ url: 'https://music.163.com/other' }).action, 'deny');
  assert.equal(win.url, 'https://music.163.com/other', '原行为是复用当前窗口加载');
  login.cancel();
  await done;
});

test('QQ 浏览器登录：登录页弹出的子窗口在结束时一并销毁', async () => {
  const h = setupBrowser();
  const login = h.loginWith(h.mod.exports.QQ_BROWSER_LOGIN);
  const done = login.open();
  await tick();
  const win = h.windows[0];
  const child = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    destroy() {
      this.destroyed = true;
    },
    once() {},
    webContents: new EventEmitter(),
  };
  win.webContents.emit('did-create-window', child);
  assert.equal(child.destroyed, false);
  login.cancel();
  assert.equal(await done, false);
  assert.equal(child.destroyed, true, '子窗口必须随登录窗口回收，不能遗留');
});

test('QQ 浏览器弹窗：标题走 provider，且源码不含已废弃的跳转协议字符串', async () => {
  const raw = fs.readFileSync(path.join(__dirname, '../src/views/web-login-modal.ts'), 'utf8');
  assert.ok(!raw.includes('document.cookie'));
  assert.ok(!raw.includes('obsidian://vinyl-login?cookie='));

  const module = { exports: {} };
  const Modal = class {
    constructor(app) {
      this.app = app;
      this.titleEl = new Element('div');
      this.contentEl = new Element('div');
    }
    close() {}
  };
  vm.runInNewContext(webSource, {
    module,
    exports: module.exports,
    require: (name) => (name === 'obsidian' ? { Modal, TFile: class {} } : require(name)),
    window: { setTimeout: () => 0 },
    Buffer,
  });
  const modal = new module.exports.WebLoginModal(
    {},
    {
      auth: { getStatus: async () => ({ loggedIn: false, cookieBytes: 0, serverOk: true }) },
      browserLogin: { open: async () => false, active: false, check() {} },
      provider: module.exports.qqWebProvider(),
    }
  );
  await modal.onOpen();
  assert.match(modal.titleEl.textContent, /QQ 音乐登录/);
  const text = modal.contentEl.all().map((el) => el.textContent).join('\n');
  assert.match(text, /官方窗口/);
});
