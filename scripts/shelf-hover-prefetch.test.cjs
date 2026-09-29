// 悬停预热（专辑墙那一侧）回归：指针在卡上停够 PREFETCH_DWELL_MS → 叫一次 PlaybackEngine.prefetchAlbum；
// 没停够就走掉 → 不叫（扫过一面墙不该把每张卡都变成一次平台请求）。
// 假 DOM + 假定时器（window.setTimeout 收进表里，用例手动点火）：本批只考「什么时候叫」，预热做了什么是 core 那边的事（scripts/prefetch.test.cjs）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodePath = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

// ============ 假定时器：排进去但不自己响，用例显式点火 ============
const timers = [];
let timerSeq = 0;
const fakeWindow = {
  setTimeout(fn) {
    timers.push({ id: ++timerSeq, fn });
    return timerSeq;
  },
  clearTimeout(id) {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  },
  setInterval: () => 0,
  clearInterval: () => {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  matchMedia: () => ({ matches: false }),
};
function fireTimers() {
  const due = timers.splice(0, timers.length);
  for (const t of due) t.fn();
}
function pendingTimers() {
  return timers.length;
}

function fakeCard(path) {
  const el = {
    dataset: { path },
    classes: new Set(['vinyl-shelf-card']),
    children: [],
    closest: (sel) => (sel === '.vinyl-shelf-card' ? el : null),
    contains: (node) => node === el || el.children.includes(node),
    addClass(...n) {
      for (const x of String(n.join(' ')).split(/\s+/).filter(Boolean)) el.classes.add(x);
      return el;
    },
    style: { setProperty: () => {} },
    textContent: '',
  };
  return el;
}

function loadModule(entry) {
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
      if (name === 'fs') return { existsSync: () => false, statSync: () => ({}), readdirSync: () => [] };
      if (name === 'path') return nodePath;
      throw new Error('Unexpected runtime import: ' + name);
    },
    fetch: async () => {
      throw new Error('no network in tests');
    },
    window: fakeWindow,
    document: { hidden: false, body: { addEventListener() {}, removeEventListener() {} }, addEventListener() {}, removeEventListener() {} },
    AbortSignal,
    URL,
    URLSearchParams,
    Buffer,
    setTimeout,
    clearTimeout,
    console,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  });
  return mod.exports;
}

const { VinylShelfView } = loadModule('src/views/shelf-view.ts');

function makeView() {
  const prefetched = [];
  const plugin = {
    settings: { albumFolder: 'Vinyl Life/Vinyl Note', coverFolder: 'Covers', shelfProps: [] },
    app: { vault: { getMarkdownFiles: () => [] }, metadataCache: { getFileCache: () => null } },
    engine: { prefetchAlbum: (album) => { prefetched.push(album.title); return Promise.resolve(); } },
  };
  const view = new VinylShelfView({}, plugin);
  const cardA = fakeCard('A.md');
  const cardB = fakeCard('B.md');
  view.cardEls = new Map([['A.md', cardA], ['B.md', cardB]]);
  view.entries = [
    { album: { path: 'A.md', title: 'A' }, local: false, netease: true, qq: false, kugou: false },
    { album: { path: 'B.md', title: 'B' }, local: false, netease: true, qq: false, kugou: false },
  ];
  return { view, cardA, cardB, prefetched };
}

const over = (card, related = null) => ({ target: card, relatedTarget: related });
const out = (card, related = null) => ({ target: card, relatedTarget: related });

test('悬停预热：在卡上停够时间 → 预热这张专辑', () => {
  timers.length = 0;
  const { view, cardA, prefetched } = makeView();
  view.schedulePrefetch(over(cardA));
  assert.equal(pendingTimers(), 1, '先只是排了个计时器（碰一下就预 = 把墙当批量抓取）');
  assert.deepEqual(prefetched, [], '还没到点，什么都不做');
  fireTimers();
  assert.deepEqual(prefetched, ['A'], '停够了才预热，热的是停住的这张');
});

test('悬停预热：没停够就走掉 → 不预热（扫过一面墙不该挨张敲平台）', () => {
  timers.length = 0;
  const { view, cardA, prefetched } = makeView();
  view.schedulePrefetch(over(cardA));
  view.cancelPrefetch(out(cardA, null));
  assert.equal(pendingTimers(), 0, '计时器撤了');
  fireTimers();
  assert.deepEqual(prefetched, [], '没停够不预热');
});

test('悬停预热：卡片内部移动（封面→专辑名）不算换卡，计时不重来', () => {
  timers.length = 0;
  const { view, cardA, prefetched } = makeView();
  const title = { parent: cardA };
  cardA.children.push(title);
  view.schedulePrefetch(over(cardA));
  const firstId = timers[0].id;
  view.schedulePrefetch(over(title)); // 委托：事件目标是内部元素，closest 仍找到同一张卡
  assert.deepEqual(timers.map((t) => t.id), [firstId], '同一张卡只排一次（计时不重来）');
  view.cancelPrefetch(out(title, cardA));
  assert.equal(pendingTimers(), 1, '卡片内部换元素不算离开');
  fireTimers();
  assert.deepEqual(prefetched, ['A']);
});

test('悬停预热：滑到另一张卡 → 前一张作废，只按后一张预热', () => {
  timers.length = 0;
  const { view, cardA, cardB, prefetched } = makeView();
  view.schedulePrefetch(over(cardA));
  view.cancelPrefetch(out(cardA, cardB));
  view.schedulePrefetch(over(cardB));
  assert.equal(pendingTimers(), 1, '同时只等一张');
  fireTimers();
  assert.deepEqual(prefetched, ['B'], '预热的是最后停住的那张');
});

test('悬停预热：选择模式里不预热（点卡片是勾选，不是播放）', () => {
  timers.length = 0;
  const { view, cardA, prefetched } = makeView();
  view.batch.active = true;
  view.schedulePrefetch(over(cardA));
  assert.equal(pendingTimers(), 0, '选择模式下连计时器都不排');
  fireTimers();
  assert.deepEqual(prefetched, []);
});

test('接线：pointerover / pointerout 上挂了预热（与 marquee 同一处委托）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/views/shelf-view.ts'), 'utf8');
  assert.match(
    src,
    /'pointerover'[\s\S]{0,140}?this\.schedulePrefetch\(ev\)/,
    '指针进卡片要排预热计时器'
  );
  assert.match(
    src,
    /'pointerout'[\s\S]{0,140}?this\.cancelPrefetch\(ev\)/,
    '指针离开要撤掉它（没停够就不预热）'
  );
});

test('悬停预热：关视图时把没到点的计时器收掉（别让预热打到已经没了的视图上）', async () => {
  timers.length = 0;
  const { view, cardA, prefetched } = makeView();
  view.schedulePrefetch(over(cardA));
  await view.onClose();
  assert.equal(pendingTimers(), 0, 'onClose 清计时器');
  fireTimers();
  assert.deepEqual(prefetched, []);
});
