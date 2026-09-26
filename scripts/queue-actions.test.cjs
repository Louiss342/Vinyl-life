// 队列动作回归：
//   A 引擎：随机可逆（进随机前的顺序在退出随机时还回来；期间增删过 / 手动拖过就放弃还原）
//   B 视图：队列行末尾的「移除这首」（点击走 removeRange(i,1) 且不落到「切歌」那条路上）
//   C 接线：Delete / Backspace 的键盘等价、Vinyl order 的定位钮、跟随播放的判据
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const nodePath = require('node:path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const OBSIDIAN_STUB = {
  App: class {},
  ItemView: class {},
  WorkspaceLeaf: class {},
  Menu: class {},
  Modal: class {},
  Notice: class {},
  Plugin: class {},
  PluginSettingTab: class {},
  SettingPage: class {},
  Setting: class {},
  FuzzySuggestModal: class {},
  TFile: class {},
  TFolder: class {},
  TAbstractFile: class {},
  normalizePath: (p) => p,
  setIcon: () => {},
  requestUrl: async () => ({ status: 200, json: {} }),
};

function loadModule(entry, globals = {}) {
  const source = esbuild.buildSync({
    entryPoints: [path.join(root, entry)],
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
      if (name === 'obsidian') return OBSIDIAN_STUB;
      if (name === 'fs') return { existsSync: () => false, statSync: () => ({}), readdirSync: () => [] };
      if (name === 'path') return nodePath;
      throw new Error('Unexpected runtime import: ' + name);
    },
    fetch: async () => {
      throw new Error('no network in tests');
    },
    window: {
      setTimeout: (fn) => { fn(); return 0; },
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      matchMedia: () => ({ matches: false }),
    },
    document: { hidden: false },
    AbortSignal,
    URL,
    URLSearchParams,
    Buffer,
    setTimeout,
    clearTimeout,
    console,
    ...globals,
  });
  return mod.exports;
}

// ============ A. 引擎：随机可逆 ============

const audioInstances = [];
class AudioStub {
  constructor() {
    this.src = '';
    this.volume = 1;
    this.currentTime = 0;
    this.paused = true;
    this.listeners = {};
    audioInstances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  removeAttribute() {
    this.src = '';
  }
  load() {}
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

const { PlaybackEngine } = loadModule('src/core/player-state.ts', { Audio: AudioStub });

const SONGS = [1, 2, 3, 4].map((i) => ({
  id: i,
  name: `S${i}`,
  ar: [{ name: 'Ar' }],
  al: { name: 'Al', picUrl: '' },
  dt: 180000,
}));

function makeEngine({ random = () => 0 } = {}) {
  const engine = new PlaybackEngine({
    app: {},
    local: {
      buildTracks: async () => [],
      clearBlobs() {},
      keysOf: () => [],
      resolveVaultUrl: (f) => `vault://${f.path}`,
      resolveExternalUrl: (p) => `ext://${p}`,
    },
    netease: {
      album: async () => ({ songs: SONGS }),
      songUrl: async () => ({ url: 'https://cdn/x.mp3' }),
    },
    qq: null,
    kugou: null,
    settings: () => ({ defaultSource: 'auto', autoPlay: false, quality: 'higher' }),
    random,
  });
  return engine;
}

const albumOf = (title) => ({
  path: `Vinyl Note/${title}.md`,
  title,
  neteaseId: 1,
  sourcePref: 'auto',
  audioRefs: [],
  file: { path: `Vinyl Note/${title}.md` },
});

// 用 Array.from（测试 realm 的数组）：vm 里 map 出来的数组原型不同，deepStrictEqual 会假红
const ids = (engine) => Array.from(engine.snapshot().queue, (t) => t.id);

async function engineWithQueue() {
  const engine = makeEngine();
  await engine.loadAlbum(albumOf('A'));
  await engine.playIndex(0); // 有「当前曲目」才谈得上跟着它走
  return engine;
}

test('随机可逆：退出随机时把进随机之前的顺序还回来，当前曲目还是那一首', async () => {
  const engine = await engineWithQueue();
  const before = ids(engine);
  assert.deepEqual(before, [1, 2, 3, 4]);

  engine.cyclePlayMode(); // once → loop
  engine.cyclePlayMode(); // loop → shuffle（打乱）
  assert.notDeepEqual(ids(engine), before, '进随机要真的打乱');
  const currentId = engine.snapshot().current?.id;
  assert.ok(currentId, '打乱不该把它停掉');

  engine.cyclePlayMode(); // shuffle → once（还原）
  assert.deepEqual(ids(engine), before, '退出随机：顺序回到进随机之前');
  assert.equal(engine.snapshot().current?.id, currentId, '当前曲目不变（下标跟着它走）');
});

test('随机期间排入了新专辑：不硬还原（那份顺序已经对不上现在的曲目集合）', async () => {
  const engine = await engineWithQueue();
  const before = ids(engine);
  engine.cyclePlayMode();
  engine.cyclePlayMode(); // 进随机
  engine.appendAlbum(
    [{ source: 'netease', id: 99, title: 'New', duration: 100 }],
    'Vinyl Note/B.md',
    'B',
    'netease'
  );
  assert.equal(ids(engine).length, 5, '新专辑排进去了');
  engine.cyclePlayMode(); // 退出随机
  assert.notDeepEqual(ids(engine).slice(0, 4), before, '不做还原（长度对不上）');
  assert.ok(ids(engine).includes(99), '排进去的那首还在，没被丢弃');
});

test('随机期间手动拖过：以用户的顺序为准，退出随机不吃掉他的调整', async () => {
  const engine = await engineWithQueue();
  engine.cyclePlayMode();
  engine.cyclePlayMode(); // 进随机
  const shuffled = ids(engine);
  engine.moveTrack(0, 3); // 手动把第一首挪到队尾
  const moved = ids(engine);
  assert.notDeepEqual(moved, shuffled);
  engine.cyclePlayMode(); // 退出随机
  assert.deepEqual(ids(engine), moved, '手动调整之后那份「原序」作废');
});

// ============ B. 视图：移除这首 ============

function fakeEl(tag = 'div') {
  const el = {
    tag,
    children: [],
    classes: new Set(),
    attrs: new Map(),
    textContent: '',
    value: '',
    disabled: false,
    scrollCalls: [],
    dataset: {},
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
    remove() {},
    scrollIntoView(opts) {
      el.scrollCalls.push(opts);
    },
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 10, width: 10, height: 10 }),
  };
  return el;
}

const collect = (el, out = []) => {
  out.push(el);
  for (const c of el.children) collect(c, out);
  return out;
};

/** 触发监听器；事件对象记录 stopPropagation 有没有被调（判「别当成切歌」） */
function fire(el, type, ev = {}) {
  const full = {
    preventDefault() {},
    stopped: false,
    stopPropagation() {
      full.stopped = true;
    },
    ...ev,
  };
  for (const fn of el.listeners.get(type) || []) fn(full);
  return full;
}

const { VinylPlayerView } = loadModule('src/views/player-view.ts');

function makeView() {
  const removed = [];
  const view = new VinylPlayerView({}, {
    settings: { queueMode: false },
    engine: { removeRange: (start, count) => removed.push([start, count]) },
    appendListeningNote: () => {},
  });
  const queueBox = fakeEl();
  view.els = { queueBox, queueModeBtn: fakeEl('button'), playModeBtn: fakeEl('button') };
  const snapshot = {
    queue: [
      { source: 'netease', id: 1, title: 'S1', duration: 100, albumNotePath: 'Vinyl Note/A.md' },
      { source: 'netease', id: 2, title: 'S2', duration: 100, albumNotePath: 'Vinyl Note/A.md' },
    ],
    segments: [{ start: 0, count: 2, albumTitle: 'A', albumPath: 'Vinyl Note/A.md', current: true }],
    index: 0,
    playMode: 'once',
  };
  view.renderQueue(snapshot);
  return { view, queueBox, removed };
}

test('每行都有「移除这首」：点击走 removeRange(i,1)，并挡住「切歌」那条路', () => {
  const { queueBox, removed } = makeView();
  const rows = collect(queueBox).filter((el) => el.classes.has('vinyl-queue-item'));
  const removes = collect(queueBox).filter((el) => el.classes.has('vinyl-queue-remove'));
  assert.equal(rows.length, 2);
  assert.equal(removes.length, 2, '两行各一枚（单专辑队列也要能一首一首去掉）');

  const ev = fire(removes[1], 'click');
  assert.deepEqual(removed, [[1, 1]], '第二行 → removeRange(1, 1)');
  assert.equal(ev.stopped, true, '别让队列的点击委托把它当成「切到这首」');
  fire(removes[1], 'pointerdown');
  assert.equal(removes[1].listeners.get('pointerdown').length, 1, '行可拖拽：按钮上要挡住起拖');
});

// ============ C. 接线（行为难直接驱动，锁住关键写法） ============

test('接线：Delete / Backspace 是「移除这首」的键盘等价，焦点跟着挪到同位置的行', () => {
  const src = read('src/views/player-view.ts');
  assert.match(
    src,
    /ev\.key === 'Delete' \|\| ev\.key === 'Backspace'[\s\S]{0,400}?this\.plugin\.engine\.removeRange\(idx, 1\)[\s\S]{0,200}?this\.queueRows\[i\]\?\.focus\(\)/,
    '删完把焦点挪到同位置那一行（否则焦点掉回 body，连删几首要反复 Tab）'
  );
});

test('接线：定位与跟随 —— 打开定位一次，切歌只在「上一条还看得见」时跟', () => {
  const src = read('src/views/player-view.ts');
  assert.match(src, /this\.pendingLocate = true;/, 'onOpen 里定位一次');
  assert.match(
    src,
    /const wasVisible = this\.currentRowVisible\(\);[\s\S]{0,600}?this\.pendingLocate \|\| \(indexChanged && wasVisible\)/,
    '跟随的判据：自己翻远了就别把人拽回来'
  );
  assert.match(
    src,
    /scrollIntoView\(\{ block: 'nearest', behavior: prefersReducedMotion\(\) \? 'auto' : 'smooth' \}\)/,
    "block:'nearest'：已经在视野里就一点都不动"
  );
  assert.match(
    src,
    /setIcon\(locateBtn, 'locate-fixed'\)[\s\S]{0,200}?t\('player\.locateCurrent'\)/,
    'Vinyl order 行的定位钮要挂可读名称'
  );
});

test('接线：Vinyl order 行两个钮 —— 保存与载入是一对（载入此前只有命令面板入口）', () => {
  const src = read('src/views/player-view.ts');
  assert.match(
    src,
    /setIcon\(saveQueue, 'save'\)[\s\S]{0,120}?t\('queueNote\.save'\)/,
    '保存钮在这儿'
  );
  assert.match(
    src,
    /setIcon\(loadQueue, 'folder-open'\)[\s\S]{0,120}?t\('queueNote\.load'\)/,
    '载入钮要摆在旁边（存了却回不来，是审计点名的半成品）'
  );
  assert.match(
    src,
    /loadQueue\.addEventListener\('click', \(\) => void this\.plugin\.loadQueueFromActiveNote\(\)\)/,
    '载入走命令层同一个方法（别另写一条读笔记的路）'
  );
});

test('接线：试听片段有角标 + 开播提示一次（trial 此前只写不读）', () => {
  const view = read('src/views/player-view.ts');
  assert.match(view, /isTrialTrack\(track\)/, '队列行按统一的判定读 trial');
  assert.match(view, /vinyl-badge is-trial/, '试听角标');
  const engine = read('src/core/player-state.ts');
  assert.match(
    engine,
    /isTrialTrack\(track\) && !this\.trialNoticed\.has\(trackKey\(track\)\)/,
    '开播提示同一首只报一次（单曲循环 / 来回切不刷屏）'
  );
  const css = read('styles.css');
  assert.match(css, /\.vinyl-badge\.is-trial\s*\{/, '角标样式');
});
