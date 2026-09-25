// 搓碟闭环回归：用假 DOM / 假引擎 / 假声卡把一次完整手势从头跑到尾 ——
//   按下 → 转过阈值起手 → 逐帧把转角喂成角度与倍速 → 松手 → 马达回正 → 交还位置与盘面。
// 盯住的坑（只看代码看不出来的那种）：
//   ① 起手必须把元素停掉、把位置交给手势（时间不进则退，音乐不能继续从旧位置往前走）；
//   ② 逐帧要把转角写进 --vinyl-scratch-angle（盘面跟手）、把位置喂给引擎与搓碟台；
//   ③ 抬手必须把最终位置交回引擎（否则音乐跳到别处），并摘掉接管类、留下负 animation-delay；
//   ④ 减速回正是有终点的：到了正常转速要停表（否则 rAF 永远转下去）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  stdin: {
    contents: `export * from '../src/views/player-view';\nexport * from '../src/core/scratch-deck';\n`,
    resolveDir: __dirname,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian'],
}).outputFiles[0].text;

// —— 假 DOM（够视图把壳建起来 + 收发指针事件 + 报盒宽）——

function fakeEl(tag = 'div') {
  const vars = new Map();
  const listeners = new Map();
  const el = {
    tag,
    children: [],
    classes: new Set(),
    dataset: {},
    attrs: new Map(),
    textContent: '',
    style: { setProperty: (k, v) => vars.set(k, v), removeProperty: (k) => vars.delete(k) },
    // Obsidian 的 setCssProps：把对象里的自定义属性一次写进内联样式（就绪圈用它写进度）
    setCssProps(props) {
      for (const [k, v] of Object.entries(props)) vars.set(k, String(v));
    },
    vars,
    listeners,
    empty() {
      el.children = [];
    },
    addClass(...n) {
      for (const x of String(n.join(' ')).split(/\s+/).filter(Boolean)) el.classes.add(x);
    },
    removeClass(...n) {
      for (const x of String(n.join(' ')).split(/\s+/).filter(Boolean)) el.classes.delete(x);
    },
    toggleClass(name, on) {
      const want = on === undefined ? !el.classes.has(name) : !!on;
      if (want) el.classes.add(name);
      else el.classes.delete(name);
    },
    setAttribute(k, v) {
      el.attrs.set(k, String(v));
    },
    getAttribute(k) {
      return el.attrs.has(k) ? el.attrs.get(k) : null;
    },
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    fire(type, ev) {
      for (const fn of listeners.get(type) || []) fn(ev);
    },
    setText(t) {
      el.textContent = String(t);
      return el;
    },
    createDiv(o) {
      return el.createEl('div', o);
    },
    createSpan(o) {
      return el.createEl('span', o);
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
    // 唱片盒：视口里一个 200×200 的圆（圆心 200,200，半径 100）
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 200, height: 200 }),
    getAnimations: () => [],
    animate: () => ({}),
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild(child) {
      el.children.push(child);
      return child;
    },
  };
  el.classList = {
    toggle: (n, on) => el.toggleClass(n, on),
    add: (...n) => el.addClass(...n),
    remove: (...n) => el.removeClass(...n),
  };
  return el;
}

/** 假声卡：与 scratch-deck.test.cjs 同一套替身 */
function fakeCtx() {
  const param = () => ({
    value: 1,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    cancelScheduledValues() {},
  });
  const ctx = {
    currentTime: 0,
    state: 'running',
    destination: {},
    sources: [],
    createGain: () => ({ gain: param(), connect() {} }),
    createBufferSource() {
      const s = {
        buffer: null,
        playbackRate: param(),
        started: null,
        stopped: null,
        connect() {},
        start(when, offset) {
          s.started = { when, offset };
        },
        stop(when) {
          s.stopped = when;
        },
      };
      ctx.sources.push(s);
      return s;
    },
    createBuffer: (c, l, r) => {
      const data = Array.from({ length: c }, () => new Float32Array(l));
      return {
        duration: l / r,
        sampleRate: r,
        numberOfChannels: c,
        length: l,
        getChannelData: (i) => data[i],
      };
    },
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return ctx;
}

const TRACK = { source: 'netease', id: 1, title: 'T', duration: 100 };
/** 与 core/track 的 trackKey 同一口径（视图模块不导出它，测试自己拼） */
const trackKeyOf = (t) => `ne:${t.id}`;

function snap(over = {}) {
  return {
    status: 'playing',
    queue: [TRACK],
    segments: [{ albumPath: 'a.md', albumTitle: 'A', start: 0, count: 1, current: true }],
    index: 0,
    current: TRACK,
    currentTime: 30,
    duration: 100,
    volume: 0.8,
    albumNotePath: 'a.md',
    albumTitle: 'A',
    playMode: 'once',
    ...over,
  };
}

/** 每个用例从干净的帧队列开始（上一个用例若中途断言失败，可能留下半截手势的帧） */
function fresh() {
  const { mod, raf, clock, timers, timeouts } = playerModule();
  raf.clear();
  timers.clear();
  timeouts.clear();
  return { mod, raf, clock, timers, timeouts };
}

let cached = null;
/** 把视图与搓碟台编译进一个沙箱：帧队列与时钟由测试自己推（不依赖真实 rAF / 时间） */
function playerModule() {
  if (cached) return cached;
  const raf = new Map(); // id → 回调
  const timers = new Map(); // id → 回调（就绪圈的推进表）
  const timeouts = new Map(); // id → 回调（一次性定时器：搓碟缓冲的预载表等）
  const clock = { now: 0 };
  let seq = 0;
  const windowStub = {
    setTimeout: (fn) => {
      const id = ++seq;
      timeouts.set(id, fn);
      return id;
    },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (fn) => {
      const id = ++seq;
      timers.set(id, fn);
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    requestAnimationFrame: (fn) => {
      const id = ++seq;
      raf.set(id, fn);
      return id;
    },
    cancelAnimationFrame: (id) => raf.delete(id),
  };
  // 时钟可推：视图里的 Date.now() / performance.now() 都跟着 clock 走（测试不真等）
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super(clock.now);
    }
    static now() {
      return clock.now;
    }
  }
  const sandboxObj = {
    module: { exports: {} },
    exports: {},
    require: (name) => {
      if (name === 'obsidian') {
        return {
          App: class {},
          ItemView: class {},
          Menu: class {},
          Modal: class {},
          Notice: class {},
          Plugin: class {},
          TFile: class {},
          TFolder: class {},
          normalizePath: (p) => p,
          setIcon: () => {},
          requestUrl: async () => ({ arrayBuffer: new ArrayBuffer(8) }),
        };
      }
      return require(name);
    },
    window: windowStub,
    performance: { now: () => clock.now },
    Date: FakeDate,
    document: { createElementNS: (_ns, tag) => fakeEl(tag) },
    console,
    Buffer,
  };
  vm.runInNewContext(source, sandboxObj);
  cached = { mod: sandboxObj.module.exports, raf, clock, timers, timeouts };
  return cached;
}

/** 建一个装好壳的视图 + 引擎调用记录 */
function makeView(mod, settings = {}) {
  const calls = [];
  const engine = {
    beginScratch: (opts) => {
      calls.push(['begin', opts.live]);
      return { time: 30, playing: true };
    },
    updateScratch: (t) => calls.push(['update', t]),
    endScratch: (t, resume) => calls.push(['end', t, resume]),
    scratchRate: (r) => calls.push(['rate', r]),
    setScratchLive: (live) => calls.push(['live', live]),
    toggle: () => {},
    seek: () => {},
    resolveUrl: async (t) => {
      calls.push(['resolve', trackKeyOf(t)]);
      return 'https://cdn/x.mp3';
    },
    snapshot: () => snap(),
  };
  const plugin = {
    settings: {
      scratchEnabled: true,
      scratchSound: 'light',
      scratchPreload: true,
      turntableSpeed: 'normal',
      volume: 0.8,
      ...settings,
    },
    engine,
    // 本地曲目的取料路径（就绪圈用例走这条：本地不等待预取窗口）
    local: {
      resolveVaultUrl: () => 'app://vault/x.mp3',
      resolveExternalUrl: () => 'app://ext/x.mp3',
      readTrackBytes: async () => new ArrayBuffer(8),
    },
  };
  const view = new mod.VinylPlayerView({}, plugin);
  view.contentEl = fakeEl();
  view.containerEl = { ownerDocument: { hidden: false }, isShown: () => true };
  view.update(snap());
  return { view, calls };
}

/** 在唱片上按下并从 fromDeg 划到 toDeg（半径 60px，避开圆心收手区） */
function scratch(view, fromDeg, toDeg) {
  const pt = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return { clientX: 200 + Math.cos(rad) * 60, clientY: 200 + Math.sin(rad) * 60 };
  };
  const base = { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, preventDefault() {} };
  const hit = view.els.turntable;
  hit.fire('pointerdown', { ...base, ...pt(fromDeg) });
  hit.fire('pointermove', { ...base, ...pt(toDeg) });
}

function release(view) {
  const base = { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0, preventDefault() {} };
  view.els.turntable.fire('pointerup', { ...base, clientX: 260, clientY: 210 });
}

/** 手还按着，继续划到某个角度（与 scratch() 同一套坐标） */
function moveTo(view, deg) {
  const rad = (deg * Math.PI) / 180;
  const base = { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, preventDefault() {} };
  view.els.turntable.fire('pointermove', {
    ...base,
    clientX: 200 + Math.cos(rad) * 60,
    clientY: 200 + Math.sin(rad) * 60,
  });
}

/** 推一帧（取最早排队的那个回调），返回是否真的跑了一帧 */
function runFrame(raf, clock) {
  const [id, fn] = [...raf.entries()][0] || [];
  if (!fn) return false;
  raf.delete(id);
  fn(clock.now);
  return true;
}

function lastOf(calls, kind) {
  const hit = [...calls].reverse().find((c) => c[0] === kind);
  return hit ? hit.slice(1) : undefined;
}

/** 让沙箱里那几个 promise 链条跑完（预载 → 解析地址 → 取字节 → 解码） */
async function flush() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

/** 让沙箱里挂着的定时器到点（真表到点就从队列里消失了，替身不替这一步，测试自己删） */
function fireTimers(timeouts) {
  for (const [id, fn] of [...timeouts.entries()]) {
    timeouts.delete(id);
    fn();
  }
}

test('闭环（轻量音效）：起手 → 逐帧 → 松手 → 回正 → 交还', () => {
  const { mod, raf, clock } = fresh();
  const { view, calls } = makeView(mod);

  clock.now = 1000;
  scratch(view, 0, 10); // 转过 10°：越过 3° 阈值
  assert.deepEqual(calls[0], ['begin', true], '轻量档：声音归元素（live = true）');
  assert.equal(view.els.vinyl.classes.has('is-scratching'), true);
  assert.equal(view.els.turntable.classes.has('is-scratching'), true);
  assert.equal(view.els.arm.classes.has('is-parked'), false, '起手即落针');
  assert.equal(raf.size, 1, '起了逐帧循环');

  clock.now = 1100; // 第一帧：10° / 100ms → 原始倍速 = 10×1.8/(360×0.1) = 0.5（平滑后略小）
  assert.equal(runFrame(raf, clock), true);
  const angle = Number(String(view.els.vinyl.vars.get('--vinyl-scratch-angle')).replace('deg', ''));
  assert.ok(Math.abs(angle - 10) < 1e-6, `盘面角度 = 手指划过的角，实得 ${angle}`);
  const rate = lastOf(calls, 'rate');
  assert.ok(rate > 0 && rate < 0.5, `轻量路按倍速驱动元素，实得 ${rate}`);
  const pos = lastOf(calls, 'update');
  assert.ok(pos > 30 && pos < 30.06, `位置由倍速积分（100ms × ~0.49），实得 ${pos}`);

  release(view); // 松手：马达回正
  for (let i = 0; i < 120 && raf.size; i++) {
    clock.now += 16;
    runFrame(raf, clock);
  }
  assert.equal(raf.size, 0, '回到正常转速就停表（rAF 不许永远转下去）');
  const end = lastOf(calls, 'end');
  assert.equal(end[1], true, '起手前在播：抬手回到播放');
  assert.ok(Math.abs(end[0] - lastOf(calls, 'update')[0]) < 0.5, '交还的位置就是最后喂进去的那个');
  assert.equal(view.els.vinyl.classes.has('is-scratching'), false);
  assert.equal(view.els.turntable.classes.has('is-scratching'), false);
  assert.match(String(view.els.vinyl.vars.get('animation-delay')), /^-\d+ms$/, '交还角度：负延迟续上旋转');
  assert.equal(view.scratch, null, '手势状态收干净');
});

test('闭环（完整音效）：声音走搓碟台，引擎不碰元素倍速', async () => {
  const { mod, raf, clock } = fresh();
  const ctx = fakeCtx();
  const { view, calls } = makeView(mod, { scratchSound: 'full' });
  view.scratchDeck = new mod.ScratchDeck({
    createContext: () => ctx,
    decode: async (bytes, rate) => ({
      duration: 100,
      sampleRate: rate,
      numberOfChannels: 2,
      length: rate * 100,
      getChannelData: () => new Float32Array(1),
    }),
    negativeRate: async () => true,
    volume: () => 0.8,
    schedule: (fn) => fn(),
  });
  view.scratchDeck.prepare('ne:1', 100, async () => ({ bytes: new ArrayBuffer(8), durationSec: 100 }));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(view.scratchDeck.prepared('ne:1'), true, '缓冲就绪');

  clock.now = 500;
  scratch(view, 0, 20);
  assert.deepEqual(calls[0], ['begin', false], '完整档：声音归搓碟台（live = false）');
  clock.now = 600;
  runFrame(raf, clock);
  assert.equal(lastOf(calls, 'rate'), undefined, '完整档不该动元素的倍速');
  assert.equal(ctx.sources.length, 1, '搓碟台起了声源');
  assert.ok(view.scratchDeck.position() > 30, '搓碟台自己积分位置');

  release(view);
  for (let i = 0; i < 120 && raf.size; i++) {
    clock.now += 16;
    runFrame(raf, clock);
  }
  assert.equal(ctx.sources[0].stopped !== null, true, '抬手要停声');
  assert.equal(lastOf(calls, 'end')[1], true, '抬手回到播放');
  assert.equal(view.scratch, null);
});

test('闭环（完整音效）：来回拖一直有声 —— 手在动就不许有哑帧', async () => {
  const { mod, raf, clock } = fresh();
  const ctx = fakeCtx();
  const { view } = makeView(mod, { scratchSound: 'full' });
  view.scratchDeck = new mod.ScratchDeck({
    createContext: () => ctx,
    decode: async (bytes, rate) => ({
      duration: 100,
      sampleRate: rate,
      numberOfChannels: 2,
      length: rate * 100,
      getChannelData: () => new Float32Array(1),
    }),
    negativeRate: async () => true,
    volume: () => 0.8,
    schedule: (fn) => fn(),
  });
  view.scratchDeck.prepare('ne:1', 100, async () => ({ bytes: new ArrayBuffer(8), durationSec: 100 }));
  await flush();

  clock.now = 1000;
  scratch(view, 0, 12); // 起手
  const silent = [];
  let deg = 12;
  for (let i = 0; i < 40; i++) {
    deg += i % 2 === 0 ? -6 : 6; // 来回划：每帧 6° / 20ms ≈ 1.5 倍速
    moveTo(view, deg);
    clock.now += 20;
    runFrame(raf, clock);
    const src = ctx.sources[ctx.sources.length - 1];
    const rate = Math.abs(src ? src.playbackRate.value : 0);
    if (!(rate > 0.05)) silent.push({ frame: i, rate, deg }); // 手在动，声音却是哑的
  }
  assert.deepEqual(silent, [], '来回拖动期间每一帧都该有声音（手在动就有声）');
  assert.equal(ctx.sources.length, 1, '负速率可用：一个源带符号倍速就够（不必换源）');
  assert.equal(ctx.sources[0].stopped, null, '这一程的源不该被停掉');
});

test('闭环：暂停起手不回正，位置留在松手处', () => {
  const { mod, raf, clock } = fresh();
  const { view, calls } = makeView(mod);
  view.update(snap({ status: 'paused' }));
  view.plugin.engine.beginScratch = (opts) => {
    calls.push(['begin', opts.live]);
    return { time: 40, playing: false };
  };
  clock.now = 0;
  scratch(view, 0, 12);
  clock.now = 100;
  runFrame(raf, clock);
  release(view);
  assert.equal(raf.size, 0, '暂停起手：抬手即收尾，没有回正动画');
  const end = lastOf(calls, 'end');
  assert.equal(end[1], false, '起手前是暂停：抬手后仍是暂停');
});

test('闭环：点一下唱片（没过阈值）什么都不发生', () => {
  const { mod, raf } = fresh();
  const { view, calls } = makeView(mod);
  const base = { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, preventDefault() {} };
  view.els.turntable.fire('pointerdown', { ...base, clientX: 260, clientY: 200 });
  view.els.turntable.fire('pointerup', { ...base, buttons: 0, clientX: 260, clientY: 200 });
  assert.deepEqual(calls, [], '没起手：不动引擎、不动盘面');
  assert.equal(raf.size, 0);
  assert.equal(view.els.vinyl.classes.has('is-scratching'), false);
});

test('闭环：曲目在手里被换掉 → 手势作废（不写位置、收干净）', () => {
  const { mod, raf } = fresh();
  const { view, calls } = makeView(mod);
  scratch(view, 0, 10);
  assert.equal(view.scratch !== null, true);
  view.update(snap({ current: { source: 'netease', id: 2, title: 'U', duration: 100 } }));
  assert.equal(view.scratch, null, '换曲作废');
  assert.equal(raf.size, 0, '逐帧循环停掉');
  assert.equal(view.els.vinyl.classes.has('is-scratching'), false);
  assert.equal(lastOf(calls, 'end'), undefined, '作废不写位置（引擎那边已经自行收掉会话）');
});

// —— 预载（开播几秒后自动备好搓碟缓冲）——
// 盯住的坑：①「只在手按上来才抓」= 每张唱片的第一下搓碟只有轻量音效（倒着拖没声、位置也对不上）；
//          ②「开播就抓」= 跟播放抢带宽，切歌变得不跟手。所以这条表既要挂、又要挂得有分寸。

test('闭环：预载的表 —— 开播不抓，到点才抓；每条快照都不许把它往后推', async () => {
  const { mod, timeouts } = fresh();
  const { view, calls } = makeView(mod, { scratchSound: 'full' });
  assert.equal(timeouts.size, 1, '开播就挂上一张表');
  assert.equal(calls.some((c) => c[0] === 'resolve'), false, '还没到点：一个字节都不抓');

  // 每 400ms 一条快照：表不能被这些快照推着重挂（否则等待时间永远走不完）
  const settled = [...timeouts.keys()][0];
  for (let i = 0; i < 5; i++) view.update(snap({ currentTime: 31 + i }));
  assert.deepEqual([...timeouts.keys()], [settled], '同一首、同一播放状态：表不动');

  fireTimers(timeouts); // 到点
  await flush();
  assert.deepEqual(lastOf(calls, 'resolve'), ['ne:1'], '到点了才去解析地址 / 抓整轨');
  assert.equal(timeouts.size, 0, '到点后表清掉');

  // 曲目变了：旧表作废、按新曲目重挂（到点抓的是新那一首）
  view.update(snap({ current: { source: 'netease', id: 2, title: 'U', duration: 100 } }));
  assert.equal(timeouts.size, 1, '换曲重挂');
  fireTimers(timeouts);
  await flush();
  assert.deepEqual(lastOf(calls, 'resolve'), ['ne:2'], '抓的是换过之后的那一首');
});

test('闭环：预载只在这几种情况下挂表（暂停 / 轻量档 / 关掉预载都不挂）', () => {
  const a = fresh();
  const va = makeView(a.mod, { scratchSound: 'full' }).view;
  va.update(snap({ status: 'paused' }));
  assert.equal(a.timeouts.size, 0, '暂停：不挂表（也别在暂停里偷偷下载）');
  va.update(snap({ status: 'playing' }));
  assert.equal(a.timeouts.size, 1, '转回播放：挂上');

  const b = fresh();
  makeView(b.mod, { scratchSound: 'light' });
  assert.equal(b.timeouts.size, 0, '轻量档：没有搓碟台，不下载整轨');

  const c = fresh();
  makeView(c.mod, { scratchSound: 'full', scratchPreload: false });
  assert.equal(c.timeouts.size, 0, '关掉预载：不挂表');
});

test('闭环：关掉预载时，手按上来才抓（兜底那条路还在）', async () => {
  const { mod, raf, clock } = fresh();
  const { view, calls } = makeView(mod, { scratchSound: 'full', scratchPreload: false });
  clock.now = 1000;
  scratch(view, 0, 10);
  await flush();
  assert.deepEqual(lastOf(calls, 'resolve'), ['ne:1'], '起手就把这一首的整轨抓起来');
  assert.deepEqual(calls[0], ['begin', true], '这一下先用轻量音效（缓冲还没就绪）');
  assert.equal(raf.size, 1);
});

test('闭环：预载排不下时回头再挂一次（连着切歌，后一首不该永远排不上队）', async () => {
  const { mod, timeouts } = fresh();
  const { view } = makeView(mod, { scratchSound: 'full' });
  view.scratchDeck = new mod.ScratchDeck({
    createContext: () => fakeCtx(),
    decode: () => new Promise(() => {}),
    negativeRate: async () => true,
    volume: () => 0.8,
    schedule: (fn) => fn(),
  });
  const stuck = () => new Promise(() => {}); // 两份永远在途的活，把名额占满
  view.scratchDeck.prepare('x', 1, stuck);
  view.scratchDeck.prepare('y', 1, stuck);

  fireTimers(timeouts);
  await flush();
  assert.equal(view.scratchDeck.has('ne:1'), false, '这一份当时排不下');
  assert.equal(timeouts.size, 1, '回头再挂一次（不是就此算了）');
});

test('闭环：轻量路搓到一半缓冲备好了 → 余下的交给搓碟台', async () => {
  const { mod, raf, clock } = fresh();
  const ctx = fakeCtx();
  const { view, calls } = makeView(mod, { scratchSound: 'full' });
  view.scratchDeck = new mod.ScratchDeck({
    createContext: () => ctx,
    decode: async (bytes, rate) => ({
      duration: 100,
      sampleRate: rate,
      numberOfChannels: 2,
      length: rate * 100,
      getChannelData: () => new Float32Array(1),
    }),
    negativeRate: async () => true,
    volume: () => 0.8,
    schedule: (fn) => fn(),
  });

  clock.now = 3000;
  scratch(view, 0, 10);
  assert.deepEqual(calls[0], ['begin', true], '缓冲还没就绪：先用轻量路出声');
  clock.now = 3100;
  runFrame(raf, clock);
  assert.ok(lastOf(calls, 'rate') > 0, '轻量路正在按倍速出声');

  // 后台那份刚好备好（预载的表提前跑完）
  view.scratchDeck.prepare('ne:1', 100, async () => ({ bytes: new ArrayBuffer(8), durationSec: 100 }));
  await flush();
  assert.equal(view.scratchDeck.has('ne:1'), true, '缓冲就绪');

  const rates = calls.filter((c) => c[0] === 'rate').length;
  clock.now = 3200;
  runFrame(raf, clock);
  assert.deepEqual(lastOf(calls, 'live'), [false], '换出声路线：元素让位');
  assert.equal(ctx.sources.length, 1, '搓碟台接手起了声源');
  assert.ok(view.scratchDeck.position() > 30, `位置接着走（不是从头开始），实得 ${view.scratchDeck.position()}`);
  clock.now = 3300;
  runFrame(raf, clock);
  assert.equal(calls.filter((c) => c[0] === 'rate').length, rates, '换过之后不再动元素的倍速');

  release(view);
  for (let i = 0; i < 120 && raf.size; i++) {
    clock.now += 16;
    runFrame(raf, clock);
  }
  assert.equal(ctx.sources[0].stopped !== null, true, '抬手要停声');
  assert.equal(view.scratch, null);
});
