// 陈列的来源筛选：从「筛选无结果」切回「全部」时，空态必须撤掉。
// renderGrid 有两条互斥的出口 —— 空态（.vinyl-shelf-empty）与网格（.vinyl-shelf-grid），
// 都直接挂在 gridHost 下。dropGrid 在「有结果 → 无结果」方向清得掉旧网格，
// 但从空态回来时 ensureGrid 只是补建一个网格、不清 host，两套 DOM 就叠在了一起：
// 界面上专辑卡片都出来了，上面还压着一句「没有符合条件的专辑」（用户实测）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const nodePath = require('node:path');

function fakeEl(tag = 'div') {
  const el = {
    tag,
    children: [],
    classes: new Set(),
    attrs: new Map(),
    style: { setProperty: () => {} },
    textContent: '',
    value: '',
    disabled: false,
    scrollTop: 0,
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
    setAttr(k, v) {
      el.attrs.set(k, String(v));
      return el;
    },
    createEl(t, o) {
      const child = fakeEl(typeof t === 'string' ? t : 'div');
      el.children.push(child);
      const opts = typeof o === 'string' ? { cls: o } : o || {};
      if (opts.cls) child.addClass(opts.cls);
      if (opts.text != null) child.textContent = String(opts.text);
      return child;
    },
    createDiv(o) {
      return el.createEl('div', o);
    },
    createSpan(o) {
      return el.createEl('span', o);
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    remove() {
      const i = el.parent?.children.indexOf(el) ?? -1;
      if (i >= 0) el.parent.children.splice(i, 1);
    },
    isConnected: true,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    contains: () => false,
    querySelectorAll: () => [],
    closest: () => null,
  };
  return el;
}

function loadModule(entry, globals = {}) {
  const source = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', entry)],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text;
  const mod = { exports: {} };
  vm.runInNewContext(source, {
    module: mod,
    exports: mod.exports,
    require: (name) => {
      if (name === 'obsidian') {
        return {
          App: class {},
          ItemView: class {},
          WorkspaceLeaf: class {},
          Menu: class {},
          Modal: class {},
          Notice: class {},
          FuzzySuggestModal: class {},
          Setting: class {},
          PluginSettingTab: class {},
          SettingPage: class {},
          TFile: class {},
          TFolder: class {},
          TAbstractFile: class {},
          setIcon: () => {},
          normalizePath: (p) => p,
        };
      }
      if (name === 'fs') {
        return { existsSync: () => false, statSync: () => ({}), readdirSync: () => [] };
      }
      if (name === 'path') return nodePath;
      throw new Error('Unexpected runtime import: ' + name);
    },
    fetch: async () => {
      throw new Error('no network in tests');
    },
    window: {
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => {},
      matchMedia: () => ({ matches: false }),
    },
    document: { hidden: false, body: fakeEl(), addEventListener() {}, removeEventListener() {} },
    AbortSignal,
    URL,
    URLSearchParams,
    Buffer,
    setTimeout,
    clearTimeout,
    console,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    ...globals,
  });
  return mod.exports;
}

// buildCard 用的是宿主注入的全局 createDiv()（Obsidian 1.13 的 DOM 便捷函数），
// 卡片本身不在本用例射程内（applyPlan 会被换掉），但入口得先有
const { VinylShelfView } = loadModule('src/views/shelf-view.ts', {
  createDiv: () => fakeEl(),
  createSpan: () => fakeEl('span'),
});

/** 两张专辑：一张只有网易云（没有 QQ），一张只有本地 —— 用来制造「QQ 筛出来是空的」 */
function makeView() {
  const plugin = {
    settings: {
      albumFolder: 'Vinyl Life/Vinyl Note',
      coverFolder: 'Covers',
      shelfProps: [],
      shelfPropLabels: {},
      discDirection: 'right',
      recordColor: 'black',
      toolbarPosition: 'top-center',
      shelfColumns: 'auto',
      stats: {},
    },
    app: {
      vault: { getMarkdownFiles: () => [] },
      metadataCache: { getFileCache: () => null },
    },
  };
  const view = new VinylShelfView({}, plugin);
  view.contentEl = fakeEl();
  view.gridHost = fakeEl();
  view.buildTutorial = () => {};
  view.renderToolbar = () => {};
  // 卡片本体（buildCard / 分批追加）不在本用例射程内：这条只问「两套容器换得干不干净」，
  // 真正要验的 ensureGrid / dropGrid 都是真的
  view.applyPlan = () => 0;
  view.syncRoving = () => {};
  view.syncBatch = () => {};
  view.entries = [
    {
      album: { path: 'Vinyl Life/Vinyl Note/A.md', title: 'A', artist: 'x', displayProps: {} },
      local: false,
      netease: true,
      qq: false,
      kugou: false,
    },
    {
      album: { path: 'Vinyl Life/Vinyl Note/B.md', title: 'B', artist: 'y', displayProps: {} },
      local: true,
      netease: false,
      qq: false,
      kugou: false,
    },
  ];
  return view;
}

/** 在假 DOM 里按类名找（gridHost 的直接子元素就是网格与空态两套） */
function childWithClass(host, cls) {
  return host.children.find((c) => c.classes?.has(cls)) ?? null;
}

test('筛选无结果时给空态：网格撤掉、只留空态', () => {
  const view = makeView();
  view.state.sourceFilter = 'qq'; // 两张都不是 QQ 来源
  view.renderGrid();
  assert.ok(childWithClass(view.gridHost, 'vinyl-shelf-empty'), '无结果：要有空态');
  assert.equal(childWithClass(view.gridHost, 'vinyl-shelf-grid'), null, '无结果：网格要撤掉');
});

test('从「筛选无结果」切回「全部」：空态必须撤掉（不能与网格叠着）', () => {
  const view = makeView();
  view.state.sourceFilter = 'qq';
  view.renderGrid();
  assert.ok(childWithClass(view.gridHost, 'vinyl-shelf-empty'), '前置：先落到空态');

  view.state.sourceFilter = 'all'; // 用户点「全部」
  view.renderGrid();
  assert.ok(childWithClass(view.gridHost, 'vinyl-shelf-grid'), '有结果了：网格要在');
  assert.equal(
    childWithClass(view.gridHost, 'vinyl-shelf-empty'),
    null,
    '有结果了：空态必须撤掉 —— 留着就是卡片上面压一句「没有符合条件的专辑」'
  );
});

test('空态与网格是互斥的两套 DOM：来回切几次也只留一个', () => {
  const view = makeView();
  for (const filter of ['qq', 'all', 'kugou', 'local', 'all']) {
    view.state.sourceFilter = filter;
    view.renderGrid();
    const kinds = ['vinyl-shelf-grid', 'vinyl-shelf-empty'].filter((c) => childWithClass(view.gridHost, c));
    assert.equal(kinds.length, 1, `筛选 ${filter} 后应恰好留一套 DOM，实际：${kinds.join(' + ') || '都没有'}`);
  }
});
