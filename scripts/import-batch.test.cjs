// 搜索结果批量导入：导入完必须**留在搜索页**（不跳转、不关窗），卡片就地变成「打开」。
// 背景：早先每导一张就 openFile + close()，于是「导入专辑」入口一次只能导一张 ——
// 这个用例盯的就是那条回归线：批量导入没有新按钮，全靠「导入后不离开」这一个行为。
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
 *  disabled 的控件不派发点击 —— 浏览器就是这样的，桩也得这样，
 *  否则「按钮忘了重新启用」这类 bug 会被测试放过去。 */
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

test('搜索结果导入：留在搜索页、就地变「打开」，可以接着导下一张', async () => {
  const { mod, TFile } = loadModal();
  const h = makeHarness();
  h.TFile = TFile; // vault.create 要交出真实的 TFile 实例（面板用 instanceof 判断）

  const modal = new mod.AlbumImportModal(h.app, h.ctx);
  await modal.onOpen();
  await search(modal, '周杰伦');

  const cards = cardsOf(modal.contentEl);
  assert.equal(cards.length, 2, '两个搜索结果');

  // 导第一张
  fire(sideButton(cards[0]), 'click');
  await flush(10);
  assert.equal(h.created.length, 1, '笔记建了');
  assert.equal(h.created[0].path, 'Albums/叶惠美.md');
  assert.match(String(h.created[0].content), /neteaseId: 1/);
  assert.deepEqual(h.leaves, [], '导入后不得跳转（跳转就没法批量了）');
  assert.equal(modal.closed, false, '导入后不得关窗');
  assert.equal(sideButton(cards[0]).textContent, '打开', '这张卡片就地变成「打开」');
  assert.equal(sideButton(cards[0]).classes.has('mod-cta'), false, '不再强调「导入」');
  assert.ok(
    String(statusLine(modal.contentEl).textContent).includes('已导入 1 张'),
    '状态行要报批量进度：' + statusLine(modal.contentEl).textContent
  );

  // 接着导第二张 —— 批量导入的核心
  fire(sideButton(cards[1]), 'click');
  await flush(10);
  assert.equal(h.created.length, 2, '第二张也导进去了');
  assert.equal(h.created[1].path, 'Albums/七里香.md');
  assert.deepEqual(h.leaves, [], '导第二张同样不跳转');
  assert.ok(String(statusLine(modal.contentEl).textContent).includes('已导入 2 张'));
  assert.equal(sideButton(cards[1]).textContent, '打开');

  // 想立刻看笔记：点「打开」才离开（语义不变）
  fire(sideButton(cards[0]), 'click');
  await flush(5);
  assert.deepEqual(h.leaves.length, 1, '点「打开」才打开笔记');
  assert.deepEqual(h.opened, ['Albums/叶惠美.md']);
  assert.equal(modal.closed, true, '「打开」= 明确要去看，这时才关窗');
});

test('搜索结果导入：失败不改变卡片状态，也不会把窗口关掉', async () => {
  const { mod, TFile: FileClass } = loadModal();
  const h = makeHarness();
  h.TFile = FileClass;
  h.ctx.client.album = async () => {
    throw new Error('上游挂了');
  };
  const modal = new mod.AlbumImportModal(h.app, h.ctx);
  await modal.onOpen();
  await search(modal, '周杰伦');

  const cards = cardsOf(modal.contentEl);
  fire(sideButton(cards[0]), 'click');
  await flush(10);
  assert.equal(modal.closed, false, '失败也不能关窗（用户还要接着试）');
  assert.equal(sideButton(cards[0]).textContent, '导入', '按钮回到可点状态，文案不变');
  assert.equal(sideButton(cards[0]).disabled, false, '失败后按钮要能再点');
  assert.match(String(rowStatus(cards[0]).textContent), /失败|❌/);
});
