// 歌词页视图回归（驱动真实 player-view + 假 DOM）：
//   ① 三面翻转：歌词面向左、唱片区向右，几何互为镜像、尺寸一致（都是绝对定位填满）
//   ② 一帧的完整链路：时间 → scrollPlan → 像素（scrollTop）→ 当前行的类、景深与卡拉OK填充
//      （滚动是**连续**的：两行之间一直在走，换行那一刻正好落在新行中心）
//   ③ 手动滚动接管：自己写 scrollTop 不算用户意图；用户滚过之后不再被拽回
//   ④ 视觉中心（位置说了算）：滚到哪哪句亮，正在唱的那句留着填充；停手 4 秒平滑回位
//   ⑤ 点某一行 = 跳到那句（走引擎的 seekTo）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const nodePath = require('node:path');
const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const view = fs.readFileSync(path.join(root, 'src/views/player-view.ts'), 'utf8');

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

const source = esbuild.buildSync({
  entryPoints: [path.join(root, 'src/views/player-view.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian'],
}).outputFiles[0].text;

function fakeEl(tag = 'div') {
  const el = {
    tag,
    children: [],
    classes: new Set(),
    attrs: new Map(),
    props: new Map(),
    textContent: '',
    dataset: {},
    clientHeight: 200,
    offsetTop: 0,
    offsetHeight: 20,
    scrollTop: 0,
    scrollWrites: 0,
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
    scrollIntoView() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
  // 自定义属性走 Map：用例要断言「每帧写了什么」（--vinyl-lyric-fill / --vinyl-lyric-pad）
  el.style = {
    setProperty: (k, v) => el.props.set(k, String(v)),
    removeProperty: (k) => el.props.delete(k),
  };
  let top = 0;
  Object.defineProperty(el, 'scrollTop', {
    get: () => top,
    set: (v) => {
      top = v;
      el.scrollWrites++;
    },
  });
  return el;
}

const collect = (el, out = []) => {
  out.push(el);
  for (const c of el.children) collect(c, out);
  return out;
};

function fire(el, type, ev = {}) {
  const full = {
    defaultPrevented: false,
    preventDefault() {
      full.defaultPrevented = true;
    },
    stopPropagation() {},
    key: '',
    ...ev,
  };
  for (const fn of el.listeners.get(type) || []) fn(full);
  return full;
}

/** 时钟与「减少动效」都归用例管：回位动画的中间帧要能验 */
let nowMs = 1000;
let reduceMotion = false;
class FakeDate extends Date {
  static now() {
    return nowMs;
  }
}

function loadView(timers) {
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
      // 定时器只登记、不自动跑：恢复跟随这类「4 秒后」的行为要由用例决定何时发生
      setTimeout: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimeout: (id) => {
        if (id > 0) timers[id - 1] = null;
      },
      setInterval: () => 0,
      clearInterval: () => {},
      // rAF 不真的跑循环：用例手动调 syncLyricsScroll 一帧一帧验
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
      matchMedia: (q) => ({ matches: reduceMotion && String(q).includes('reduced-motion') }),
    },
    // 回位动画按时间插值：时钟归用例管（不然「中途某一帧在哪」没法断言）
    Date: FakeDate,
    document: { hidden: false },
    AbortSignal,
    URL,
    URLSearchParams,
    Buffer,
    setTimeout,
    clearTimeout,
    console,
  });
  return mod.exports.VinylPlayerView;
}

const timers = [];
const VinylPlayerView = loadView(timers);

/** 放行所有登记着的定时器（恢复跟随之类） */
function flushTimers() {
  for (let i = 0; i < timers.length; i++) {
    const t = timers[i];
    if (!t) continue;
    timers[i] = null;
    t.fn();
  }
}

const LINES = [
  { at: 0, text: '第一句', trans: 'first' },
  { at: 5000, text: '第二句' },
  { at: 10000, text: '', },
];

/** 造一个只装歌词页需要的部分：行容器 + 滚动容器 + 引擎桩。
 *  liveSeconds 传函数时每帧现取 —— 连续滚动要在一帧里推进时间，得能改。 */
function makeView({ liveSeconds } = {}) {
  const seeked = [];
  const plugin = {
    settings: {},
    engine: liveSeconds
      ? {
          liveSeconds: typeof liveSeconds === 'function' ? liveSeconds : () => liveSeconds,
          seekTo: (s) => seeked.push(s),
          // 切语言那条用例要调 applyLanguage：它会取一次快照做整体刷新，这里只关心歌词页
          snapshot: () => null,
        }
      : {},
  };
  const v = new VinylPlayerView({}, plugin);
  // 骨架走真实的 buildLyricsFace（滚动接管那几条监听就挂在这里，手搓元素会漏掉它们）
  v.buildLyricsFace(fakeEl());
  v.lyricsScrollEl.clientHeight = 200;
  v.lyrics = LINES;
  v.lyricsForKey = 'ne:1';
  v.lyricsState = 'ready';
  v.renderLyricsLines();
  // 行位置：每行 40px，中心依次 60 / 100 / 140（真机由 measureLyrics 量出来）
  v.lyricsOffsets = [60, 100, 140];
  return { v, seeked, plugin };
}

// ============ A. 三面几何 ============

test('翻转：歌词面向左转、唱片区向右转，两面几何互为镜像', () => {
  assert.match(
    css,
    /\.vinyl-flip\.is-lyrics \.vinyl-flip-inner \{\s*transform:\s*rotateY\(90deg\)/,
    '歌词页：内层向 +90° 转（向左）'
  );
  assert.match(
    css,
    /\.vinyl-flip\.is-crate \.vinyl-flip-inner \{\s*transform:\s*rotateY\(-90deg\)/,
    '唱片区：内层向 -90° 转（向右）'
  );
  assert.match(
    css,
    /\.vinyl-flip-face\.is-lyrics \{[\s\S]{0,240}?rotateY\(-90deg\) translateZ/,
    '歌词面自己先转 -90°（与唱片区 +90° 互为镜像）'
  );
  assert.match(css, /\.vinyl-flip-face\.is-crate \{[\s\S]{0,240}?rotateY\(90deg\) translateZ/);
  // 尺寸一致：两面都是绝对定位填满翻转区（正面撑多高就多高），反向缩放系数同一份
  assert.match(css, /\.vinyl-flip-face\.is-lyrics \{[\s\S]{0,120}?position:\s*absolute/);
  assert.match(css, /\.vinyl-flip-face\.is-lyrics \{[\s\S]{0,240}?scale\(var\(--vinyl-flip-counter/);
});

test('翻转：翻到歌词页会挂 is-lyrics、把歌词键点亮，翻回来撤掉', () => {
  const { v } = makeView();
  v.els = {
    flip: fakeEl(),
    pickBtn: fakeEl('button'),
    lyricsBtn: fakeEl('button'),
    turntable: fakeEl(),
  };
  v.face = 'player';
  v.flipTo('lyrics');
  assert.equal(v.els.flip.classes.has('is-lyrics'), true);
  assert.equal(v.els.lyricsBtn.classes.has('is-active'), true);
  assert.equal(v.els.pickBtn.classes.has('is-active'), false);
  v.flipTo('player');
  assert.equal(v.els.flip.classes.has('is-lyrics'), false, '翻回来要撤掉');
  assert.equal(v.els.lyricsBtn.classes.has('is-active'), false);
});

// ============ B. 一帧的完整链路 ============

test('一帧：两行之间一直在走（连续滚动，换行前才动的静止期没有了）', () => {
  let t = 6;
  const { v } = makeView({ liveSeconds: () => t });
  v.syncLyricsScroll();
  // 第二句中心 100、第三句中心 140，容器半高 100；已唱 (6000-5000)/5000 = 1/5
  assert.equal(v.lyricsScrollEl.scrollTop, 8, '100 + 40×0.2 − 100 = 8 —— 旧版这一刻纹丝不动');
  assert.equal(v.lyricsLineEls[1].classes.has('is-active'), true, '第二句亮起');
  assert.equal(
    v.lyricsLineEls[1].props.get('--vinyl-lyric-fill'),
    '0.2',
    '第二句 5000..10000ms，走到 6000ms = 0.2 的填充进度'
  );

  t = 7.5;
  v.syncLyricsScroll();
  assert.equal(v.lyricsScrollEl.scrollTop, 20, '半程位置：100 + 40×0.5 − 100 = 20');
  assert.equal(v.lyricsLineEls[2].classes.has('is-active'), false, '时间还没到：第三句不算当前行');

  t = 2; // 第一句（行首 0）：目标 60 − 100 是负的 → 夹到 0
  v.syncLyricsScroll();
  assert.equal(v.lyricsScrollEl.scrollTop, 0, '第一句贴顶（负值夹 0）');
  assert.equal(v.lyricsLineEls[0].props.get('--vinyl-lyric-fill'), '0.4', '第一句走到 2000ms = 0.4');
});

test('一帧：换行那一刻正好落在新行中心，唱过的行压暗', () => {
  const { v } = makeView({ liveSeconds: 10 }); // 第三句行首
  v.syncLyricsScroll();
  assert.equal(v.lyricsLineEls[0].classes.has('is-past'), true, '第一句唱过了');
  assert.equal(v.lyricsLineEls[1].classes.has('is-past'), true, '第二句唱过了');
  assert.equal(v.lyricsLineEls[2].classes.has('is-active'), true);
  assert.equal(
    v.lyricsOffsets[2] - v.lyricsScrollEl.clientHeight / 2,
    v.lyricsScrollEl.scrollTop,
    '位置与高亮同一刻交棒：新行正好居中'
  );
});

test('一帧：景深按行号之差写（0 = 视觉中心），没换中心就不重刷', () => {
  let t = 6;
  const { v } = makeView({ liveSeconds: () => t });
  v.syncLyricsScroll();
  assert.deepEqual(
    Array.from(v.lyricsLineEls, (el) => el.props.get('--vinyl-lyric-d')),
    ['1', '0', '1'],
    '跟随时视觉中心 = 正在唱的第二句：它 0 档，前后各 1 档'
  );

  // 同一行内再来一帧：档位是行号之差、帧间不变，不该重写 DOM
  v.lyricsLineEls[0].props.set('--vinyl-lyric-d', 'sentinel');
  v.syncLyricsScroll();
  assert.equal(v.lyricsLineEls[0].props.get('--vinyl-lyric-d'), 'sentinel', '没换中心不重刷景深');

  t = 10; // 换行：第三句成为视觉中心，档位整体交棒
  v.syncLyricsScroll();
  assert.deepEqual(
    Array.from(v.lyricsLineEls, (el) => el.props.get('--vinyl-lyric-d')),
    ['2', '1', '0'],
    '换中心后重刷一遍（越远的行越淡越小）'
  );
});

test('开场前（还没唱到第一行）：第一句就是 0 档，画面也停在它身上', () => {
  const { v } = makeView({ liveSeconds: -1 }); // 快照 / 引擎都还没开始
  v.syncLyricsScroll();
  assert.deepEqual(
    Array.from(v.lyricsLineEls, (el) => el.props.get('--vinyl-lyric-d')),
    ['0', '1', '2'],
    '第一句清晰：它就是要开口的那一句'
  );
  assert.equal(v.lyricsScrollEl.scrollTop, 0);
});

test('一帧：间奏行不做填充，行内进度停在 1', () => {
  const { v } = makeView({ liveSeconds: 11 });
  v.syncLyricsScroll();
  const el = v.lyricsLineEls[2];
  assert.equal(el.classes.has('is-interlude'), true, '没有词的行标成间奏');
  assert.equal(el.classes.has('is-active'), true);
  assert.equal(el.props.get('--vinyl-lyric-fill'), '1', '间奏不填充');
});

test('引擎缺失（极简依赖）：退回快照里的播放位置，不报错', () => {
  const { v } = makeView(); // 没有 liveSeconds
  v.lastSnapshot = { currentTime: 5.2 };
  v.syncLyricsScroll();
  assert.equal(v.lyricsLineEls[1].classes.has('is-active'), true);
});

// ============ C. 手动滚动接管 ============

test('手动滚动：用户滚过之后不再被拽回；自己写的 scrollTop 不算用户意图', () => {
  const { v } = makeView({ liveSeconds: 2 });
  v.lyricsScrollEl.scrollTop = 500; // 用户滚远了
  fire(v.lyricsScrollEl, 'scroll');
  assert.equal(v.lyricsFollow, false, '用户滚过：先不跟着走');
  const writes = v.lyricsScrollEl.scrollWrites;
  v.syncLyricsScroll();
  assert.equal(v.lyricsScrollEl.scrollWrites, writes, '暂停跟随时不再写 scrollTop');

  // 点某一行 = 跳到那句并立刻恢复跟随
  fire(v.lyricsLineEls[1], 'click');
  assert.equal(v.lyricsFollow, true, '点行之后恢复跟随');
});

test('程序化滚动：我们自己写的那一次不算用户意图，用户真滚了要接管', () => {
  let t = 7.5; // 两行之间：连续滚动下这一帧会写 scrollTop
  const { v } = makeView({ liveSeconds: () => t });
  v.syncLyricsScroll();
  assert.ok(v.lyricsScrollEl.scrollWrites > 0, '这一帧确实写了 scrollTop');
  assert.equal(v.lyricsScrollEl.scrollTop, v.lyricsWrittenTop, '写完记下的位置就是元素上的位置');
  fire(v.lyricsScrollEl, 'scroll');
  assert.equal(
    v.lyricsFollow,
    true,
    '自己写的：不算用户意图（连续滚动下每帧都在写 —— 按时间设护栏会把用户滚动一起吞掉）'
  );

  v.lyricsScrollEl.scrollTop = 500; // 用户滚到别处：位置对不上了
  fire(v.lyricsScrollEl, 'scroll');
  assert.equal(v.lyricsFollow, false, '位置与上次写入不符 = 用户在滚');
});

test('手动滚动期间：暂停跟随就不再写 scrollTop（别和用户抢）', () => {
  const { v } = makeView({ liveSeconds: 7.5 });
  v.syncLyricsScroll();
  v.lyricsScrollEl.scrollTop = 500;
  fire(v.lyricsScrollEl, 'scroll');
  assert.equal(v.lyricsFollow, false);
  const writes = v.lyricsScrollEl.scrollWrites;
  v.syncLyricsScroll();
  assert.equal(v.lyricsScrollEl.scrollWrites, writes, '暂停跟随期间一帧都不写');
});

// ============ G. 视觉中心（位置说了算）与回位 ============

test('滚到哪哪一句就是视觉中心；正在唱的那一句留着填充', () => {
  const { v } = makeView({ liveSeconds: 6 }); // 正在唱第二句（index 1）
  v.syncLyricsScroll();
  assert.equal(v.lyricsLineEls[1].classes.has('is-active'), true, '跟随时：视觉中心就是正在唱的那句');
  assert.equal(v.lyricsLineEls[1].classes.has('is-playing'), true, '它同时是「正在唱」');

  // 用户往下滚：容器高 200、scrollTop 80 → 视觉中心 180 → 最近的是第三句（中心 140）
  v.lyricsFollow = false;
  v.lyricsScrollEl.scrollTop = 80;
  v.syncLyricsScroll();
  assert.equal(v.lyricsLineEls[2].classes.has('is-active'), true, '视觉中心跟着滚动移到第三句');
  assert.equal(v.lyricsLineEls[1].classes.has('is-active'), false, '第二句不再是中心');
  assert.equal(v.lyricsLineEls[1].classes.has('is-playing'), true, '但它还在被唱：填充留在它身上');
  assert.equal(v.lyricsLineEls[2].classes.has('is-playing'), false, '第三句只是被看，不是被唱');
  assert.equal(v.lyricsLineEls[1].props.get('--vinyl-lyric-fill'), '0.2', '填充仍按时间推进');
  assert.deepEqual(
    Array.from(v.lyricsLineEls, (el) => el.props.get('--vinyl-lyric-d')),
    ['2', '1', '0'],
    '景深以视觉中心为 0 档（不再是「离正在唱那句多远」）'
  );
});

test('is-past 按时间算：视觉中心可以停在「已经唱过」的行上', () => {
  const { v } = makeView({ liveSeconds: 11 }); // 正在唱第三句（最后一句）
  v.lyricsFollow = false;
  v.lyricsScrollEl.scrollTop = 0; // 视觉中心 100 → 最近的是第二句（行中心 100）
  v.syncLyricsScroll();
  assert.equal(v.lyricsLineEls[1].classes.has('is-active'), true, '视觉中心在第二句');
  assert.equal(v.lyricsLineEls[1].classes.has('is-playing'), false, '但正在唱的是第三句');
  assert.equal(v.lyricsLineEls[1].classes.has('is-past'), true, '第二句唱过了（按时间，与它在不在中心无关）');
  assert.equal(v.lyricsLineEls[2].classes.has('is-playing'), true);
  assert.equal(v.lyricsLineEls[2].classes.has('is-past'), false, '正在唱的那句不算「唱过」');
});

test('暂停中滚动：scroll 事件补的那一帧让视觉中心跟着手走', () => {
  const { v } = makeView(); // 没有 rAF 循环（暂停 / 极简依赖）
  v.lastSnapshot = { currentTime: 6 };
  v.syncLyricsScroll();
  assert.equal(v.lyricsLineEls[1].classes.has('is-active'), true);
  v.lyricsScrollEl.scrollTop = 80;
  fire(v.lyricsScrollEl, 'scroll'); // 真路径：暂停跟随 + 就地补一帧
  assert.equal(v.lyricsFollow, false);
  assert.equal(v.lyricsLineEls[2].classes.has('is-active'), true, '没有逐帧循环时也要跟上');
});

test('停手 4 秒：从停下的地方平滑滑回正在唱的那一句（不是瞬移）', () => {
  nowMs = 1000;
  reduceMotion = false;
  const { v } = makeView({ liveSeconds: 6 });
  v.syncLyricsScroll();
  assert.equal(v.lyricsScrollEl.scrollTop, 8, '跟随时停在两行之间的对应位置');
  const followTop = 8;

  v.lyricsScrollEl.scrollTop = 120; // 用户滚走
  fire(v.lyricsScrollEl, 'scroll');
  assert.equal(v.lyricsFollow, false);

  nowMs = 5000;
  flushTimers(); // 4 秒到：恢复跟随 + 起一段回位动画
  assert.equal(v.lyricsFollow, true);
  assert.equal(v.lyricsScrollEl.scrollTop, 120, '第一帧还没动（缓动从 0 开始）');

  nowMs = 5000 + 210; // 半程
  v.syncLyricsScroll();
  const mid = v.lyricsScrollEl.scrollTop;
  assert.ok(mid < 120 && mid > followTop, `半程落在起终点之间（实际 ${mid}）—— 不是瞬移`);
  assert.equal(v.lyricsLineEls[2].classes.has('is-active'), true, '回位途中视觉中心仍跟着画面走');

  nowMs = 5000 + 420; // 走完
  v.syncLyricsScroll();
  assert.equal(v.lyricsScrollEl.scrollTop, followTop, '落回跟随时该在的位置');
  assert.equal(v.lyricsReturn, null, '动画收尾');
  assert.equal(v.lyricsLineEls[1].classes.has('is-active'), true, '视觉中心回到正在唱的那一句');
});

test('用户翻着谱、歌继续走：is-past 仍按时间刷（不能停在旧位置）', () => {
  let t = 6; // 正在唱第二句（index 1）
  const { v } = makeView({ liveSeconds: () => t });
  v.syncLyricsScroll();
  v.lyricsFollow = false;
  v.lyricsScrollEl.scrollTop = 80; // 视觉中心停在第三句（index 2）
  v.syncLyricsScroll();
  assert.equal(v.lyricsLineEls[0].classes.has('is-past'), true, '第一句唱过了');
  assert.equal(v.lyricsLineEls[1].classes.has('is-past'), false, '第二句正在唱，不算「唱过」');
  assert.equal(v.lyricsLineEls[2].classes.has('is-active'), true, '视觉中心在第三句（用户滚到那儿）');

  t = 11; // 歌走到第三句：用户没动，视觉中心不该变，但「唱过」的边界要跟着走
  v.syncLyricsScroll();
  assert.equal(v.lyricsLineEls[2].classes.has('is-active'), true, '视觉中心还在第三句');
  assert.equal(v.lyricsLineEls[2].classes.has('is-playing'), true, '这一句现在也被唱到了');
  assert.equal(
    v.lyricsLineEls[1].classes.has('is-past'),
    true,
    '第二句现在唱过了 —— 换行只更新了 is-playing 就会漏掉它（视觉中心没动，容易漏刷）'
  );
});

test('暂停时滚走再停手：回位动画也有帧可跑（循环要为它拉起来）', () => {
  nowMs = 1000;
  reduceMotion = false;
  const { v } = makeView({ liveSeconds: 6 });
  v.face = 'lyrics';
  v.lyricsScrollEl.scrollTop = 120;
  fire(v.lyricsScrollEl, 'scroll'); // 暂停中用户滚走
  nowMs = 5000;
  flushTimers(); // 4 秒到：回位被起
  assert.ok(v.lyricsReturn, '回位动画已起');
  v.lyricsRaf = 0;
  v.syncLyricsState({ status: 'paused', current: { source: 'netease', id: 1 } });
  assert.notEqual(v.lyricsRaf, 0, '暂停中也要有帧 —— 否则动画停在半路、视觉中心一直跟着手走');
});

test('减少动效：回位直接到位（不滑）', () => {
  nowMs = 1000;
  reduceMotion = true;
  const { v } = makeView({ liveSeconds: 6 });
  v.syncLyricsScroll();
  v.lyricsScrollEl.scrollTop = 120;
  fire(v.lyricsScrollEl, 'scroll');

  nowMs = 5000;
  flushTimers();
  assert.equal(v.lyricsScrollEl.scrollTop, 8, '一帧回到位，没有中间态');
  assert.equal(v.lyricsReturn, null);
  reduceMotion = false; // 复位：别影响别的用例
});

// ============ D. 点行跳转 ============

test('点某一行 = 跳到那句（秒），走的必须是引擎的 seekTo', () => {
  const { v, seeked } = makeView({ liveSeconds: 2 });
  fire(v.lyricsLineEls[1], 'click');
  assert.deepEqual(Array.from(seeked), [5], '第二句在 5000ms → 跳 5 秒');
});

test('键盘：Enter / 空格等价于点击（空格要 preventDefault，别把面板滚走）', () => {
  const { v, seeked } = makeView({ liveSeconds: 2 });
  const ev = fire(v.lyricsLineEls[1], 'keydown', { key: ' ' });
  assert.deepEqual(Array.from(seeked), [5]);
  assert.equal(ev.defaultPrevented, true);
});

test('换歌重建歌词行：登记表不跟着涨（曾经每换一首涨一批，且攥着已摘除的节点）', () => {
  const { v } = makeView({ liveSeconds: 2 });
  const shellLabels = v.labelEls.length; // 建壳时的登记：一辈子只该有这一批（有界）
  assert.equal(v.lyricsLabelEls.length, LINES.length, '每行登记一条（切语言要重放）');
  // 连着换几首歌：每次都会整批重建歌词行
  v.renderLyricsLines();
  v.renderLyricsLines();
  assert.equal(
    v.labelEls.length,
    shellLabels,
    '歌词行的登记不许再进建壳那张表 —— 混进去就是随换歌无界增长，还闭包持着已摘除的节点'
  );
  assert.equal(v.lyricsLabelEls.length, LINES.length, '重建后仍是一行一条，不累积');
  // 登记表的用途是切语言时重放（行不随语言重建 DOM）
  const first = v.lyricsLineEls[0];
  first.setAttribute('aria-label', 'stale');
  v.applyLanguage();
  assert.notEqual(first.getAttribute('aria-label'), 'stale', '切语言要重放歌词行的标签动作');
});

// ============ E2. 空态分流 ============

test('空态：本地音轨的「没有歌词」多给一句旁挂 .lrc 的出路，在线源与取词途中都不提', () => {
  const { v } = makeView();
  v.lyrics = null;
  v.lyricsState = 'ready';

  v.lyricsLocal = false;
  v.syncLyricsEmpty();
  const online = v.lyricsEmptyEl.textContent;
  assert.ok(online.length > 0, '在线源：要如实说「没有歌词」');
  assert.ok(!online.includes('.lrc'), '在线源不提文件 —— 那边没有这条路');

  v.lyricsLocal = true;
  v.syncLyricsEmpty();
  const local = v.lyricsEmptyEl.textContent;
  assert.ok(
    local.includes('.lrc'),
    '本地音轨：旁挂 .lrc 是唯一的入口，空态必须说出来（否则这个功能没人找得到）'
  );

  v.lyricsState = 'loading';
  v.syncLyricsEmpty();
  assert.ok(!v.lyricsEmptyEl.textContent.includes('.lrc'), '取词途中不下结论（还在取）');
  assert.notEqual(v.lyricsEmptyEl.textContent, local, '取词途中显示的是「正在取歌词…」');
});

// ============ F. 抬头两行 ============

test('抬头第二行：歌手与专辑合成一行，缺哪段就连分隔符一起省', () => {
  const { v } = makeView();
  const head = (track) => {
    v.writeLyricsHead(track ? { current: track } : null);
    return v.lyricsSubEl.textContent;
  };

  assert.equal(head({ title: '歌名', artist: '歌手', album: '专辑' }), '歌手 · 专辑', '两段都在：合成一行');
  assert.equal(head({ title: '歌名', artist: '歌手' }), '歌手', '没有专辑名：不留孤零零的「·」');
  assert.equal(head({ title: '歌名', album: '专辑' }), '专辑', '没有艺人（本地曲目常见）：只显示专辑');
  assert.equal(head({ title: '歌名' }), '', '两段都没有：这一行留空（CSS 的 :empty 不占位）');

  v.writeLyricsHead(null);
  assert.equal(v.lyricsSubEl.textContent, '', '没在放歌：第二行空着');
  assert.equal(v.lyricsTitleEl.textContent, '还没有开始播放', '第一行给空态文案');
});

test('抬头：歌手 / 专辑各自都能过长省略，两个类名不许留死样式', () => {
  assert.match(
    css,
    /\.vinyl-lyrics-title,\s*\.vinyl-lyrics-sub \{[\s\S]{0,120}?text-overflow:\s*ellipsis/,
    '两行都要 nowrap + 省略号（长专辑名不能撑破抬头）'
  );
  assert.match(css, /\.vinyl-lyrics-sub:empty \{[\s\S]{0,60}?display:\s*none/, '空行不占位');
  // 合并成一行之后，拆开的那两个类名不该还留在样式里（否则改回来看不出是死代码）
  assert.doesNotMatch(css, /\.vinyl-lyrics-(album|artist)\b/, '抬头已合并成一行，旧的 album / artist 类应当删干净');
});

// ============ E. 接线 ============

test('接线：滚动循环在「歌词页可见 + 有歌词 +（播放中 或 正在回位）」时跑', () => {
  assert.match(
    view,
    /face === 'lyrics' && this\.lyrics\?\.length && \(s\?\.status === 'playing' \|\| returning\)[\s\S]{0,160}?this\.startLyricsLoop\(\)/,
    '暂停 / 翻走就别烧帧 —— 但回位动画在跑时必须有帧推它'
  );
  assert.match(view, /private startLyricsLoop\(\) \{\s*if \(this\.lyricsRaf\) return;/, '循环防重入');
  assert.match(view, /this\.lyricsRaf = window\.requestAnimationFrame\(tick\)/, 'rAF 走 window（弹出窗口才正常）');
  assert.match(view, /stopLyricsLoop\(\); \/\/ 视图没了就别再逐帧跑/, 'onClose 里收掉');
});

test('接线：滚动只碰位置视觉，位置本身归 rAF（CSS 不能给行加位置过渡）', () => {
  assert.match(
    css,
    /\.vinyl-lyric-line \{[\s\S]{0,600}?transition:\s*color[^;]*;/,
    '行只过渡视觉（叠位置过渡会跟逐帧写入打架）'
  );
  assert.doesNotMatch(
    css.match(/\.vinyl-lyric-line \{[^}]*\}/)[0],
    /transition:\s*[^;]*top/,
    '位置不能有过渡'
  );
  assert.match(
    css,
    /\.vinyl-lyric-line\.is-playing \.vinyl-lyric-text \{[\s\S]{0,300}?background-clip:\s*text/,
    '卡拉OK填充靠 background-clip: text'
  );
  assert.match(css, /--vinyl-lyric-fill/, '填充进度是个 CSS 变量（视图每帧写一个数）');
  // 填充挂「正在唱」（时间）而不是「视觉中心」（位置）：用户翻去别的段落时，
  // 高亮跟着手走、填充灯留在正在唱的那一句上 —— 一眼找回播放位置
  assert.doesNotMatch(
    css,
    /\.vinyl-lyric-line\.is-active \.vinyl-lyric-text/,
    '填充不该挂在 is-active 上（那是视觉中心，会跟着滚动跑）'
  );
});

test('景深：CSS 按 --vinyl-lyric-d 算渐淡与略小，当前行与焦点行不受影响', () => {
  assert.match(
    css,
    /\.vinyl-lyric-line \{[\s\S]{0,700}?opacity:\s*calc\(1 - var\(--vinyl-lyric-d/,
    '渐淡按档位连续算（不是「唱过 / 没唱」两级）'
  );
  assert.match(
    css,
    /\.vinyl-lyric-line \{[\s\S]{0,700}?transform:\s*scale\(calc\(1 - var\(--vinyl-lyric-d/,
    '越远越小'
  );
  assert.match(
    css,
    /\.vinyl-lyric-line:focus-visible \{[\s\S]{0,200}?opacity:\s*1/,
    '键盘走到的那一行不能被景深压暗'
  );
});

test('歌词行不上模糊（用户明确去掉的）：整段歌词相关的规则里不许再出现 filter', () => {
  // 模糊试过 0.3px/档：滤镜会关掉次像素抗锯齿，整片词都发虚 —— 观感上只有「糊」没有「深」。
  // 这条是防回归的闸门：景深只由 opacity / transform 表达。
  const block = css.slice(css.indexOf('.vinyl-lyric-line {'), css.indexOf('.vinyl-lyric-text {'));
  assert.ok(block.length > 0, '找不到歌词行的样式段（选择器改名了？）');
  assert.doesNotMatch(block, /filter\s*:/, '歌词行不许再加 filter（模糊已被去掉）');
  assert.doesNotMatch(css, /--vinyl-lyric-d[\s\S]{0,80}?blur\(/, '档位不该再驱动任何模糊');
});
