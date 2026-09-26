// 专辑墙刷新的滚动位置回归（驱动真实 render / refreshProps + 会夹滚动位置的假 DOM）：
//   重建 DOM 时 contentEl 先被清空 —— 那一刻内容高度归零，浏览器**立即**把 scrollTop 夹成 0
//   （假 DOM 照这个行为实现，所以「先记后还」写反了顺序会红）。后台刷新（导入 / 换封面 /
//   元数据变化）与改一个卡片属性都会走到这里，500 张的墙里弹回顶部等于把用户扔回起点。
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
    // 滚动位置是真的会变的字段：清空内容 = 高度归零 = 浏览器把位置夹回 0
    scrollTop: 0,
    empty() {
      el.children = [];
      el.scrollTop = 0;
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
    remove() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    contains: () => false,
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

const { VinylShelfView } = loadModule('src/views/shelf-view.ts');

/** 一个「库里还没有专辑」的墙：render 会走空态分支，正好只剩滚动这条路径要验 */
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
    },
    app: {
      vault: { getMarkdownFiles: () => [] },
      metadataCache: { getFileCache: () => null },
    },
  };
  const view = new VinylShelfView({}, plugin);
  view.contentEl = fakeEl();
  // 空态教程是 rougjs 手绘、工具栏与网格各自一大摊 DOM：这条用例只管滚动位置，
  // 把它们换掉，剩下的（清空 → 重建 → 还位置）都是真的
  view.buildTutorial = () => {};
  view.renderToolbar = () => {};
  view.renderGrid = () => {};
  return view;
}

test('后台刷新（render）之后，墙面的滚动位置还在', () => {
  const view = makeView();
  view.contentEl.scrollTop = 640;
  view.render();
  assert.equal(view.contentEl.scrollTop, 640, '重建之后要回到原来的位置');
});

test('从墙顶刷新：位置本来就是 0，也不该被写成别的值', () => {
  const view = makeView();
  view.render();
  assert.equal(view.contentEl.scrollTop, 0);
});

test('刷新签名：换封面 / 改版本 / 加音源都算变化（只签属性会让卡片停在旧样子）', () => {
  const view = makeView();
  const entry = (over = {}) => ({
    album: {
      path: 'Vinyl Life/Vinyl Note/A.md',
      displayProps: {},
      cover: 'app://old.png',
      edition: undefined,
      ...over,
    },
    local: false,
    netease: true,
    qq: false,
    kugou: false,
  });
  view.entries = [entry()];
  const before = view.shelfSignature();
  view.entries = [entry({ cover: 'app://new.png' })];
  assert.notEqual(view.shelfSignature(), before, '换封面要算变化（此前提示成功但墙上还是旧图）');
  view.entries = [entry({ edition: 'Remastered' })];
  assert.notEqual(view.shelfSignature(), before, '改版本要算变化');
  view.entries = [{ ...entry(), local: true }];
  assert.notEqual(view.shelfSignature(), before, '加了本地音源要算变化（否则点卡片还是打开笔记）');
  view.entries = [entry()];
  assert.equal(view.shelfSignature(), before, '什么都没变就不该重画');
});

test('改一个卡片属性（refreshProps 重建卡片行）也不把用户弹回顶部', () => {
  const view = makeView();
  const host = view.contentEl;
  host.scrollTop = 320;
  // 真的 renderGrid 会先把网格清空：内容高度归零，浏览器随即把滚动位置夹回 0
  view.renderGrid = () => {
    host.scrollTop = 0;
  };
  view.refreshProps();
  assert.equal(host.scrollTop, 320, '重建卡片行之后要回到原来的位置');
});
