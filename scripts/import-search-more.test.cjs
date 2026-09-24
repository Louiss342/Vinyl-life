// 导入搜索的「结果池 / 展开 / 翻页 / 隐去已导入」回归（驱动真实弹窗 + 结果池模块）：
//   ① 首屏只画一屏，剩下的先本地展开（不花网络）—— 「只有二十条」不该再靠调大上限来解
//   ② 本地见底了才向上游要下一页，那一页要和前面的结果一起重排（更贴的浮上来）
//   ③ 翻到底就收成一行说明，别再留个点了没反应的按钮
//   ④ 已在收藏的专辑照常出现、就地标「已在收藏」（同平台同 id），状态行报个数
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

// ============ 假 DOM（与 import-batch.test.cjs 同一套：够面板用）============
function fakeEl(tag = 'div') {
  const el = {
    tag,
    children: [],
    attrs: new Map(),
    classes: new Set(),
    textContent: '',
    value: '',
    disabled: false,
    scrollTop: 0,
    listeners: new Map(),
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

function fire(el, type, ev = {}) {
  if (type === 'click' && el.disabled) return;
  const full = { preventDefault() {}, stopPropagation() {}, key: '', ...ev };
  for (const fn of el.listeners.get(type) || []) fn(full);
}

/** 放行若干轮微任务 / 宏任务（面板里全是 async 链，搜索要走一遍 discoverAlbums） */
async function flush(times = 6) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

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
    require: (name) => (name === 'obsidian' ? obsidian : require(name)),
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

/** 造一个能翻页的 ctx：albumsOf(offset) 给出那一页的专辑，调用会被记进 calls */
function makeHarness(albumsOf, opts = {}) {
  const calls = [];
  const files = opts.files || [];
  const frontmatters = opts.frontmatters || {};
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (p) => files.find((f) => f.path === p) || null,
      create: async () => {
        throw new Error('本用例不导入');
      },
      createFolder: async () => {},
    },
    metadataCache: {
      getFileCache: (f) => (frontmatters[f.path] ? { frontmatter: frontmatters[f.path] } : null),
    },
    workspace: { getLeaf: () => ({ openFile: async () => {} }) },
  };
  const ctx = {
    app,
    settings: () => ({ albumFolder: 'Albums', coverFolder: 'Covers', audioFolder: 'Audio', importMode: 'copy' }),
    client: {
      searchAlbums: async (_q, page) => {
        calls.push({ kind: 'album', offset: page.offset });
        return { result: { albums: albumsOf(page.offset) } };
      },
      searchSongs: async (_q, page) => {
        calls.push({ kind: 'song', offset: page.offset });
        return { result: { songs: [] } };
      },
      album: async () => ({ album: {}, songs: [] }),
      fetchCover: async () => {
        throw new Error('本用例不下载封面');
      },
    },
    qq: { search: async () => ({ data: { albums: [], songs: [] } }) },
    kugou: { search: async () => ({ ok: false, albums: [], songs: [] }) },
  };
  return { app, ctx, calls };
}

const cardsOf = (el) => collect(el).filter((e) => e.classes.has('vinyl-import-result'));
const statusLine = (el) => collect(el).find((e) => e.classes.has('vinyl-import-status'));
const moreBar = (el) => collect(el).find((e) => e.classes.has('vinyl-import-more'));
const moreButton = (el) => collect(moreBar(el)).find((e) => e.tag === 'button');

async function search(modal, query) {
  const input = collect(modal.contentEl).find((e) => e.tag === 'input');
  input.value = query;
  fire(input, 'keydown', { key: 'Enter' });
  await flush();
}

/** 一页「沾边」的合辑（名字都含查询词，够分不被剪尾） */
const filler = (base) => Array.from({ length: 30 }, (_, i) => ({
  id: 100 + base + i,
  name: `晨光 精选 ${base + i}`,
  artist: { name: '群星' },
  size: 5,
}));

test('导入搜索：首屏一屏，其余本地展开，展开完了才向上游要下一页', async () => {
  const { mod } = loadModal();
  // 第二页才出现正主（标题与查询词完全相等）：翻页 + 重排要把它顶到最前
  const h = makeHarness((offset) => {
    if (offset === 0) return filler(0);
    if (offset === 30) {
      return [{ id: 1000, name: '晨光', artist: { name: '某某' }, size: 11 }, ...filler(30).slice(0, 29)];
    }
    return [];
  });

  const modal = new mod.AlbumImportModal(h.app, h.ctx);
  await modal.onOpen();
  await search(modal, '晨光');

  assert.equal(cardsOf(modal.contentEl).length, 20, '首屏只画一屏');
  assert.equal(String(statusLine(modal.contentEl).textContent), '找到 30 张专辑');
  assert.match(String(moreButton(modal.contentEl).textContent), /显示更多（还有 10 张）/);
  const afterSearch = h.calls.filter((c) => c.kind === 'album').length;

  // 本地展开：白嫖池子，一个请求都不该发
  fire(moreButton(modal.contentEl), 'click');
  await flush();
  assert.equal(cardsOf(modal.contentEl).length, 30, '剩下的本地展开出来');
  assert.equal(h.calls.filter((c) => c.kind === 'album').length, afterSearch, '本地展开不花网络');
  assert.match(String(moreButton(modal.contentEl).textContent), /加载更多/, '本地见底 → 该问上游了');

  // 翻页：新一页要与前面的结果一起重排
  fire(moreButton(modal.contentEl), 'click');
  await flush();
  const cards = cardsOf(modal.contentEl);
  const titles = collect(modal.contentEl)
    .filter((e) => e.classes.has('vinyl-import-result-title'))
    .map((e) => e.textContent);
  assert.equal(cards.length, 60, '新到的一页接在后面全画出来');
  assert.equal(titles[0], '晨光', '翻页拿到的正主重排后顶到最前');
  assert.deepEqual(
    h.calls.filter((c) => c.kind === 'album').map((c) => c.offset),
    [0, 30],
    '第二页要按 offset 要'
  );

  // 翻到底：收成一行说明，按钮不再可点
  fire(moreButton(modal.contentEl), 'click');
  await flush();
  assert.equal(moreButton(modal.contentEl).disabled, true, '到底了就别留个点了没反应的按钮');
  assert.equal(String(moreButton(modal.contentEl).textContent), '已显示全部 60 张');
  assert.equal(moreButton(modal.contentEl).classes.has('is-end'), true);
});

test('导入搜索：已在库中的专辑不出现，隐去的条数写在状态行', async () => {
  const { mod } = loadModal();
  const h = makeHarness(
    () => [
      { id: 1, name: '晨光', artist: { name: '某某' }, size: 11 },
      { id: 2, name: '晨光 精选 2020', artist: { name: '某某' }, size: 5 },
    ],
    {
      files: [{ path: 'Albums/晨光.md', basename: '晨光' }],
      frontmatters: { 'Albums/晨光.md': { tags: ['album'], neteaseId: 1 } },
    }
  );
  const modal = new mod.AlbumImportModal(h.app, h.ctx);
  await modal.onOpen();
  await search(modal, '晨光');

  const titles = collect(modal.contentEl)
    .filter((e) => e.classes.has('vinyl-import-result-title'))
    .map((e) => e.textContent);
  assert.deepEqual(titles, ['晨光', '晨光 精选 2020'], '两张都照常出现（不再隐去）');
  // 已在收藏的那张：按钮变成不可点的「已在收藏」，另一张照常可添加
  const ownedButtons = collect(modal.contentEl)
    .filter((e) => e.tag === 'button' && e.textContent === '已在收藏')
    .map((e) => ({ disabled: e.disabled }));
  assert.deepEqual(ownedButtons, [{ disabled: true }], '同平台同 id：一张已在收藏且不可点');
  assert.equal(String(statusLine(modal.contentEl).textContent), '找到 2 张专辑（其中 1 张已在收藏）');
});

test('导入搜索：搜到的全都在库里 → 逐条标「已在收藏」，不再留一片空白', async () => {
  const { mod } = loadModal();
  const h = makeHarness(() => [{ id: 1, name: '晨光', artist: { name: '某某' }, size: 11 }], {
    files: [{ path: 'Albums/晨光.md', basename: '晨光' }],
    frontmatters: { 'Albums/晨光.md': { tags: ['album'], neteaseId: 1 } },
  });
  const modal = new mod.AlbumImportModal(h.app, h.ctx);
  await modal.onOpen();
  await search(modal, '晨光');

  assert.equal(cardsOf(modal.contentEl).length, 1, '照常画出来');
  assert.match(String(statusLine(modal.contentEl).textContent), /1 张已在收藏/);
  const owned = collect(modal.contentEl).find((e) => e.tag === 'button' && e.textContent === '已在收藏');
  assert.ok(owned && owned.disabled, '这条不给「添加」按钮（点了只会多一张重复笔记）');
});
