// 搜索结果批量导入：导入完必须**留在搜索页**（不跳转、不关窗），卡片就地变成「打开」。
// 判别点：批量导入没有新按钮，全靠「导入后不离开」这一个行为 —— 旧实现每导一张就 openFile + close()，
// 入口一次只能导一张（已废）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

// ============ 假 DOM（够面板用：类名 / 文本 / 属性 / 事件记录）============
function fakeEl(tag = 'div') {
  const el = {
    tag,
    children: [],
    attrs: new Map(),
    classes: new Set(),
    textContent: '',
    value: '',
    disabled: false,
    listeners: new Map(),
    style: {},
    empty() {
      el.children = [];
      return el;
    },
    addClass(...names) {
      for (const n of String(names.join(' ')).split(/\s+/).filter(Boolean)) el.classes.add(n);
      return el;
    },
    removeClass(...names) {
      for (const n of String(names.join(' ')).split(/\s+/).filter(Boolean)) el.classes.delete(n);
      return el;
    },
    toggleClass(name, on) {
      const want = on === undefined ? !el.classes.has(name) : !!on;
      if (want) el.classes.add(name);
      else el.classes.delete(name);
      return el;
    },
    setAttribute(k, v) {
      el.attrs.set(k, String(v));
      return el;
    },
    getAttribute(k) {
      return el.attrs.has(k) ? el.attrs.get(k) : null;
    },
    setText(t) {
      el.textContent = String(t);
      return el;
    },
    createEl(t, o) {
      const child = fakeEl(typeof t === 'string' ? t : 'div');
      el.children.push(child);
      const opts = typeof o === 'string' ? { cls: o } : o || {};
      if (opts.cls) child.addClass(opts.cls);
      if (opts.text != null) child.textContent = String(opts.text);
      if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) child.setAttribute(k, v);
      return child;
    },
    createDiv(o) {
      return el.createEl('div', o);
    },
    createSpan(o) {
      return el.createEl('span', o);
    },
    addEventListener(type, fn) {
      if (!el.listeners.has(type)) el.listeners.set(type, []);
      el.listeners.get(type).push(fn);
    },
    removeEventListener() {},
    focus() {},
    blur() {},
    remove() {},
  };
  return el;
}

const collect = (el, out = []) => {
  out.push(el);
  for (const c of el.children) collect(c, out);
  return out;
};

/** 触发记录下来的监听器（事件对象给足面板会读到的字段）。
 *  disabled 控件不派发点击（浏览器如此，桩也得如此），否则「按钮忘了重新启用」这类 bug 会被放过去。 */
function fire(el, type, ev = {}) {
  if (type === 'click' && el.disabled) return;
  const full = { preventDefault() {}, stopPropagation() {}, key: '', ...ev };
  for (const fn of el.listeners.get(type) || []) fn(full);
}

/** 放行若干轮微任务 / 宏任务：面板里全是 async 链（真导入要走一遍 vault 接口） */
async function flush(times = 5) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

// ============ 被测模块 + obsidian 桩 ============
function loadModal() {
  const source = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '../src/views/import-modal.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text;

  class TFile {
    constructor(p) {
      this.path = p;
      this.basename = String(p).split('/').pop().replace(/\.md$/, '');
    }
  }
  class Modal {
    constructor(app) {
      this.app = app;
      this.contentEl = fakeEl();
      this.titleEl = fakeEl();
      this.modalEl = fakeEl(); // 真机上的弹窗壳：markVinylModal（全直角）往它上面挂类名
      this.closed = false;
    }
    close() {
      this.closed = true;
    }
    open() {}
  }
  const obsidian = {
    TFile,
    TFolder: class TFolder {},
    Modal,
    App: class App {},
    Notice: class Notice {},
    normalizePath: (p) => p,
    requestUrl: async () => ({ status: 200, json: {}, text: '', arrayBuffer: new ArrayBuffer(0) }),
  };

  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: (name) => {
      if (name === 'obsidian') return obsidian;
      return require(name);
    },
    console,
    Buffer,
    window: {
      setTimeout: (fn) => {
        fn();
        return 0;
      },
      clearTimeout: () => {},
    },
    document: { createElement: (tag) => fakeEl(tag) },
    setTimeout,
    clearTimeout,
    Promise,
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(source, sandbox);
  return { mod: sandbox.module.exports, TFile };
}

/** 造一个够真导入跑通的 ctx：vault 有 create / 文件夹、客户端给两张专辑 */
function makeHarness() {
  const created = [];
  const opened = [];
  const leaves = [];
  const files = [];
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (p) => files.find((f) => f.path === p) || null,
      create: async (p, content) => {
        const f = new (harness.TFile)(p);
        f.content = content;
        files.push(f);
        created.push({ path: p, content });
        return f;
      },
      createFolder: async () => {},
    },
    metadataCache: { getFileCache: () => null },
    workspace: {
      getLeaf: (...args) => {
        leaves.push(args);
        return { openFile: async (f) => opened.push(f.path) };
      },
    },
  };
  const albums = [
    { id: 1, name: '叶惠美', artist: { name: '周杰伦' }, size: 11 },
    { id: 2, name: '七里香', artist: { name: '周杰伦' }, size: 10 },
  ];
  const ctx = {
    app,
    settings: () => ({
      albumFolder: 'Albums',
      coverFolder: 'Covers',
      audioFolder: 'Audio',
      importMode: 'copy',
    }),
    client: {
      searchAlbums: async () => ({ result: { albums } }),
      searchSongs: async () => ({ result: { songs: [] } }),
      album: async (id) => ({
        album: {
          name: id === 1 ? '叶惠美' : '七里香',
          artist: { name: '周杰伦' },
          publishTime: 1056988800000,
        },
        songs: [],
      }),
      fetchCover: async () => {
        throw new Error('测试里不下载封面');
      },
    },
    qq: { search: async () => ({ data: { albums: [], songs: [] } }) },
  };
  const harness = { TFile: null, created, opened, leaves, app, ctx, files };
  return harness;
}

const cardsOf = (el) => collect(el).filter((e) => e.classes.has('vinyl-import-result'));
const sideButton = (card) => {
  const side = collect(card).find((e) => e.classes.has('vinyl-import-result-side'));
  return side.children.find((c) => c.tag === 'button');
};
const rowStatus = (card) =>
  collect(card).find((e) => e.classes.has('vinyl-import-result-state'));
const statusLine = (el) => collect(el).find((e) => e.classes.has('vinyl-import-status'));

async function search(modal, query) {
  const input = collect(modal.contentEl).find((e) => e.tag === 'input');
  input.value = query;
  fire(input, 'keydown', { key: 'Enter' });
  await flush();
}

const previewAction = (modal) => {
  const actions = collect(modal.contentEl).find((el) => el.classes.has('vinyl-import-preview-actions'));
  return actions.children[1];
};
async function choose(modal, index) {
  fire(cardsOf(modal.contentEl)[index], 'click');
  await flush(5);
}

test('分栏导入：选择只预览，确认后写笔记，连续添加保留窗口，打开时才离开', async () => {
  const { mod, TFile } = loadModal();
  const h = makeHarness();
  h.TFile = TFile;
  const modal = new mod.AlbumImportModal(h.app, h.ctx);
  await modal.onOpen();
  await search(modal, '周杰伦');
  assert.equal(cardsOf(modal.contentEl).length, 2);
  assert.equal(h.created.length, 0, '预览不能写入笔记');
  fire(previewAction(modal), 'click');
  await flush(10);
  assert.equal(h.created[0].path, 'Albums/叶惠美.md');
  assert.deepEqual(h.leaves, []);
  assert.equal(modal.closed, false);
  assert.equal(previewAction(modal).textContent, '打开');
  assert.match(statusLine(modal.contentEl).textContent, /已导入 1 张/);
  await choose(modal, 1);
  fire(previewAction(modal), 'click');
  await flush(10);
  assert.equal(h.created.length, 2);
  assert.equal(h.created[1].path, 'Albums/七里香.md');
  assert.match(statusLine(modal.contentEl).textContent, /已导入 2 张/);
  await choose(modal, 0);
  fire(previewAction(modal), 'click');
  await flush(5);
  assert.deepEqual(h.opened, ['Albums/叶惠美.md']);
  assert.equal(modal.closed, true);
});

test('分栏导入：失败原位重试，不关闭窗口；重试成功后才能打开笔记', async () => {
  const { mod, TFile } = loadModal();
  const h = makeHarness();
  h.TFile = TFile;
  const album = h.ctx.client.album;
  h.ctx.client.album = async () => { throw new Error('上游挂了'); };
  const modal = new mod.AlbumImportModal(h.app, h.ctx);
  await modal.onOpen();
  await search(modal, '周杰伦');
  fire(previewAction(modal), 'click');
  await flush(10);
  assert.equal(modal.closed, false);
  assert.equal(previewAction(modal).textContent, '重试');
  assert.equal(previewAction(modal).disabled, false);
  assert.match(rowStatus(cardsOf(modal.contentEl)[0]).textContent, /失败/);
  h.ctx.client.album = album;
  fire(previewAction(modal), 'click');
  await flush(10);
  assert.equal(h.created.length, 1);
  assert.equal(previewAction(modal).textContent, '打开');
});

test('链接导入：解析后只展示资料，确认添加才写笔记', async () => {
  const { mod, TFile } = loadModal();
  const h = makeHarness();
  h.TFile = TFile;
  const modal = new mod.AlbumImportModal(h.app, h.ctx);
  await modal.onOpen();
  await search(modal, 'https://music.163.com/#/album?id=1');
  assert.equal(h.created.length, 0);
  assert.equal(cardsOf(modal.contentEl).length, 1);
  fire(previewAction(modal), 'click');
  await flush(10);
  assert.equal(h.created.length, 1);
  assert.equal(modal.closed, false);
});
