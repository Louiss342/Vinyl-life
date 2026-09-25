// 唱臂姿态与专辑进度（设计稿 Drawing 2026-09-16 10.26.32）：
//   未播放专辑 / 暂停 → 姿态 1（唱针归位支架）；播放专辑 → 姿态 2（落针）；
//   姿态 2 时「唱针到唱片圆心的距离」= 专辑进度（不是角度与进度成正比 —— 距离与进度成正比）。
// 盯住两处容易写错的换算：
//   ① 线性内插角度（老写法）在圆弧上不等距 —— 这里必须余弦定理反解，逐点核验距离；
//   ② 专辑进度按「本专辑在队列里的曲目」算，不是下标 ÷ 队列长度（队列里可能有好几张专辑，
//      打乱之后同一张专辑的曲目还会散开）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const nodePath = require('node:path');

function loadModule(entry, globals = {}) {
  const abs = path.join(__dirname, '..', entry);
  const source = esbuild.buildSync({
    entryPoints: [abs],
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
      if (name === 'obsidian') return { App: class {}, ItemView: class {}, setIcon: () => {} };
      if (name === 'fs') return { existsSync: () => false, statSync: () => ({}), readdirSync: () => [] };
      if (name === 'path') return nodePath;
      throw new Error('Unexpected runtime import: ' + name);
    },
    fetch: async () => {
      throw new Error('no network in tests');
    },
    window: { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} },
    document: { hidden: false },
    AbortSignal,
    URL,
    URLSearchParams,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    ...globals,
  });
  return mod.exports;
}

const geo = loadModule('src/core/arm-geometry.ts');
const { ARM_GEOMETRY, ARM_ASPECT, ARM_PARK_ANGLE, albumProgress, armAngleForProgress, armPosture, stylusDistance } = geo;
const { round } = Math;

/** 唱针位置：转轴 + 臂长 × (cos θ, sin θ)（θ = CSS 旋转角，屏幕坐标 y 向下） */
function stylusAt(deg) {
  const rad = (deg * Math.PI) / 180;
  return {
    x: ARM_GEOMETRY.pivot.x + ARM_GEOMETRY.length * Math.cos(rad),
    y: ARM_GEOMETRY.pivot.y + ARM_GEOMETRY.length * Math.sin(rad),
  };
}

const distanceToCenter = (p) => Math.hypot(p.x - ARM_GEOMETRY.center.x, p.y - ARM_GEOMETRY.center.y);
const discRadius = ARM_GEOMETRY.discRadius;

test('几何：唱针位置 = 转轴 + 臂长（与 styles.css 的 left/top/width 是同一套常量）', () => {
  // 单位 = 转盘「高」（横向唱机 1.3 : 1）；CSS 的 x 百分比 = 常量 x ÷ 1.3
  assert.equal(ARM_ASPECT, 1.3);
  assert.equal(ARM_GEOMETRY.pivot.x, 1.222);
  assert.equal(ARM_GEOMETRY.pivot.y, 0.17);
  assert.equal(ARM_GEOMETRY.length, 0.64);
  assert.equal(ARM_GEOMETRY.center.x, 0.61, '唱片偏左：46.92% × 1.3 = 0.61');
  assert.equal(ARM_GEOMETRY.center.y, 0.49);
  assert.equal(ARM_GEOMETRY.discRadius, 0.5, '唱片直径 1.00 个转盘高 ⇒ 半径 0.50');
  const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
  assert.match(css, /\.vinyl-turntable\s*\{[^}]*aspect-ratio:\s*1\.3/, '转盘宽高比与常量一致');
  assert.match(css, /\.vinyl-turntable-arm\s*\{[^}]*left:\s*94%/, '转轴 x 与常量一致（1.222 ÷ 1.3 = 94%）');
  assert.match(css, /\.vinyl-turntable-arm\s*\{[^}]*top:\s*calc\(17% - 2\.5px\)/, '转轴 y 与常量一致');
  assert.match(css, /\.vinyl-turntable-arm\s*\{[^}]*width:\s*49\.23%/, '臂长与常量一致（0.64 ÷ 1.3 = 49.23%）');
  assert.match(css, /\.vinyl-turntable-disc\s*\{[^}]*left:\s*46\.92%/, '唱片圆心 x 与常量一致（0.61 ÷ 1.3 = 46.92%）');
  assert.match(css, /\.vinyl-turntable-disc\s*\{[^}]*top:\s*49%/, '唱片圆心 y 与常量一致');
  assert.match(css, /\.vinyl-turntable-disc\s*\{[^}]*width:\s*76\.92%/, '唱片直径与常量一致（1.00 ÷ 1.3 = 76.92%）');
  assert.match(css, /\.vinyl-turntable-platter\s*\{[^}]*width:\s*80\.77%/, '毛毡垫比唱片大一圈（1.05 ÷ 1.3 = 80.77%）');
});

test('姿态：未播放 / 暂停 / 出错 / 空队列 = 姿态 1；播放与取址中 = 姿态 2', () => {
  const { park, record } = { park: 'park', record: 'record' };
  assert.equal(armPosture('idle', 3), park, '没在播 = 姿态 1');
  assert.equal(armPosture('paused', 3), park, '暂停 = 姿态 1（设计稿明确）');
  assert.equal(armPosture('error', 3), park, '出错 = 姿态 1');
  assert.equal(armPosture('playing', 0), park, '队列空 = 姿态 1（没有唱片可落针）');
  assert.equal(armPosture('playing', 3), record, '播放专辑 = 姿态 2');
  assert.equal(armPosture('loading', 3), record, '换曲取址的间隙保持落针（唱臂不该来回摆）');
});

test('姿态 1（停放位）：唱臂竖直朝下，唱针落在唱片外的支架上', () => {
  // 用户要求：停放时立正、不带偏角（早先按「1.25R」反解出来的 108.3° 是斜的）
  assert.equal(ARM_PARK_ANGLE, 90, '停放角 = 90°（转轴正下方一个臂长处）');
  const s = stylusAt(ARM_PARK_ANGLE);
  const d = distanceToCenter(s);
  assert.ok(d > discRadius, `停车位唱针必须在唱片外（d=${d.toFixed(3)}，唱片半径 ${discRadius}）`);
  // 还要避开毛毡垫（1.05 个转盘高 ⇒ 半径 0.525）：支架整体在垫子外
  assert.ok(d > 0.525, `停车位唱针必须在毛毡垫外（d=${d.toFixed(3)} > 0.525）`);
  // 支架 CSS 的位置要对着这个落点（CSS 的 x 百分比 = 常量 x ÷ 1.3；竖直朝下 ⇒ x = 转轴 x）
  const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
  assert.match(css, /\.vinyl-arm-rest\s*\{[^}]*left:\s*calc\(94% - 4px\)/, '支架在落点处（x = 转轴 x）');
  assert.match(css, /\.vinyl-arm-rest\s*\{[^}]*top:\s*calc\(81% - 8px\)/, '支架在落点处（y = 转轴 y + 臂长）');
  const sxPct = (s.x / ARM_ASPECT) * 100;
  assert.ok(Math.abs(sxPct - 94) < 0.1, `落点 x = 转轴 x（${sxPct.toFixed(2)}%）`);
  assert.ok(Math.abs(s.y * 100 - 81) < 0.1, `落点 y = 17% + 64%（${(s.y * 100).toFixed(2)}%）`);
});

test('姿态 2：唱针到圆心的「距离」与专辑进度成正比（逐点核验，不是角度成正比）', () => {
  const outer = ARM_GEOMETRY.grooveOuter * discRadius;
  const inner = ARM_GEOMETRY.grooveInner * discRadius;
  for (let i = 0; i <= 20; i++) {
    const p = i / 20;
    const want = outer + p * (inner - outer);
    const got = distanceToCenter(stylusAt(armAngleForProgress(p)));
    assert.ok(
      Math.abs(got - want) < 1e-9,
      `进度 ${p.toFixed(2)}：唱针距离应为 ${want.toFixed(4)}，实得 ${got.toFixed(4)}`
    );
  }
  // 与「角度线性内插」的老写法必须不同：中点若按角度插值会落在别处
  const angleLinear = (ARM_PARK_ANGLE + armAngleForProgress(1)) / 2;
  const dAngleLinear = distanceToCenter(stylusAt(angleLinear));
  const dTrue = distanceToCenter(stylusAt(armAngleForProgress(0.5)));
  assert.ok(Math.abs(dAngleLinear - dTrue) > 0.01, '角度中点的距离与进度中点的距离必须明显不同（否则等于没改）');
});

test('姿态 2：落针范围在导入槽与内圈之间（不压到标签、不出唱片）', () => {
  const start = distanceToCenter(stylusAt(armAngleForProgress(0)));
  const end = distanceToCenter(stylusAt(armAngleForProgress(1)));
  assert.ok(start < discRadius, '开头落在唱片上（导入槽）');
  assert.ok(start / discRadius > end / discRadius, '随进度向内圈走（只进不退）');
  assert.ok(Math.abs(start / discRadius - 0.96) < 1e-9, '导入槽 = 0.96R');
  assert.ok(Math.abs(end / discRadius - 0.4) < 1e-9, '导出槽 = 0.40R');
  // 唱片标签（.vinyl-turntable-label）= 唱片直径的 34% ⇒ 标签半径 = 0.34R，落针必须停在标签外
  const labelCss = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
  const labelRatio = Number((labelCss.match(/\.vinyl-turntable-label\s*\{[^}]*width:\s*(\d+)%/) || [])[1]) / 100;
  assert.ok(labelRatio > 0, '标签尺寸从 CSS 里读得到');
  assert.ok(end > labelRatio * discRadius, `结尾必须停在标签外（${end.toFixed(3)} > ${(labelRatio * discRadius).toFixed(3)}）`);
});

test('stylusDistance：进度越界 clamp，且首尾就是两条槽', () => {
  assert.equal(round(stylusDistance(0), 6), round(ARM_GEOMETRY.grooveOuter * discRadius, 6));
  assert.equal(round(stylusDistance(1), 6), round(ARM_GEOMETRY.grooveInner * discRadius, 6));
  assert.equal(stylusDistance(-1), stylusDistance(0), '越界 clamp');
  assert.equal(stylusDistance(2), stylusDistance(1));
  assert.equal(stylusDistance(NaN), stylusDistance(0));
});

// ============ 专辑进度：按本专辑的曲目算，不按队列下标 ============

const track = (id, albumPath) => ({ source: 'netease', id, albumNotePath: albumPath, title: 'T' + id, duration: 100 });
const A = '专辑/A.md';
const B = '专辑/B.md';

test('专辑进度：单专辑队列 = （第几首 + 本曲进度）/ 总曲数', () => {
  const queue = [track(1, A), track(2, A), track(3, A), track(4, A)];
  const at = (index, currentTime) => albumProgress({ queue, index, albumNotePath: A, currentTime, duration: 100 });
  assert.equal(at(0, 0), 0, '第一首开头 = 0');
  assert.equal(at(0, 50), 0.125, '第一首播一半 = 0.5 / 4');
  assert.equal(at(2, 0), 0.5, '第三首开头 = 一半');
  assert.equal(at(3, 100), 1, '最后一首播完 = 1');
  assert.equal(at(0, 999), 0.25, '本曲进度越界 clamp（不超过本曲那一格）');
  assert.equal(at(-1, 0), 0, '没在播 = 0');
});

test('专辑进度：多专辑队列只数「这张专辑」的曲目（不是下标 ÷ 队列长度）', () => {
  const queue = [track(1, A), track(2, A), track(3, B), track(4, B)];
  // B 段第一首：按队列下标算是 2/4 = 0.5，按本专辑算是 0/2 = 0
  assert.equal(albumProgress({ queue, index: 2, albumNotePath: B, currentTime: 0, duration: 100 }), 0);
  assert.equal(albumProgress({ queue, index: 3, albumNotePath: B, currentTime: 50, duration: 100 }), 0.75);
  assert.equal(albumProgress({ queue, index: 1, albumNotePath: A, currentTime: 100, duration: 100 }), 1);
});

test('专辑进度：打乱之后同一张专辑的曲目散开，仍按「这张专辑播到哪了」算', () => {
  // 打乱后的顺序：A1 B1 A2 B2 —— A 的进度只看 A 的两首
  const queue = [track(1, A), track(3, B), track(2, A), track(4, B)];
  assert.equal(albumProgress({ queue, index: 0, albumNotePath: A, currentTime: 0, duration: 100 }), 0);
  assert.equal(albumProgress({ queue, index: 2, albumNotePath: A, currentTime: 100, duration: 100 }), 1, 'A 的第二首播完 = A 播完了');
  assert.equal(albumProgress({ queue, index: 1, albumNotePath: B, currentTime: 0, duration: 100 }), 0, 'B 是另一张专辑，从 0 起');
});

test('专辑进度：曲目没带专辑路径时退到快照里的那张（老数据兜底）', () => {
  const queue = [{ source: 'netease', id: 1, title: 'X', duration: 100 }];
  assert.equal(albumProgress({ queue, index: 0, albumNotePath: A, currentTime: 50, duration: 100 }), 0.5);
  assert.equal(albumProgress({ queue, index: 0, currentTime: 50, duration: 100 }), 0.5, '两边都没有路径也按同一张算');
});

test('专辑进度：时长未知（直播 / 元数据未就绪）时按本曲开头算', () => {
  const queue = [track(1, A), track(2, A)];
  assert.equal(albumProgress({ queue, index: 1, albumNotePath: A, currentTime: 7, duration: 0 }), 0.5);
});

// ============ 视图接线：姿态落到 DOM（角度 + is-parked 类） ============

function fakeEl(tag = 'div') {
  const vars = new Map();
  const el = {
    tag,
    children: [],
    attrs: new Map(),
    classes: new Set(),
    dataset: {},
    textContent: '',
    // removeProperty 也要：视图交还旋转时会清掉内联 animation-delay（搓碟）
    // Obsidian 的 setCssProps：把对象里的自定义属性一次写进内联样式（就绪圈用它写进度）
    setCssProps(props) {
      for (const [k, v] of Object.entries(props)) vars.set(k, String(v));
    },
    style: {
      setProperty: (k, v) => vars.set(k, v),
      removeProperty: (k) => vars.delete(k),
    },
    vars,
    empty() {
      el.children = [];
    },
    addClass(...names) {
      for (const n of String(names.join(' ')).split(/\s+/).filter(Boolean)) el.classes.add(n);
    },
    removeClass(...names) {
      for (const n of String(names.join(' ')).split(/\s+/).filter(Boolean)) el.classes.delete(n);
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
    addEventListener() {},
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

function collect(el, out = []) {
  out.push(el);
  for (const c of el.children) collect(c, out);
  return out;
}

let playerBundle = null;
function playerModule() {
  if (playerBundle) return playerBundle;
  const src = esbuild.buildSync({
    stdin: {
      contents: `export * from '../src/views/player-view';`,
      resolveDir: __dirname,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text;
  class ItemView {
    constructor() {
      this.contentEl = fakeEl();
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(src, {
    module,
    exports: module.exports,
    require: (name) => {
      if (name === 'obsidian') {
        return {
          App: class {},
          ItemView,
          Menu: class {},
          Modal: class {},
          FuzzySuggestModal: class {},
          Notice: class {},
          Plugin: class {},
          TFile: class {},
          TFolder: class {},
          normalizePath: (p) => p,
          setIcon: () => {},
        };
      }
      return require(name);
    },
    window: { setTimeout: () => 0, clearTimeout: () => {} },
    console,
    Buffer,
    // 臂管是内联 SVG：真机经 document.createElementNS 建（见 player-view 的 svgEl）
    document: { createElementNS: (_ns, tag) => fakeEl(tag) },
  });
  playerBundle = module.exports;
  return playerBundle;
}

const snap = (over = {}) => {
  const queue = over.queue || [];
  const segments =
    over.segments ||
    (queue.length
      ? [{ albumPath: 'a.md', albumTitle: 'A', start: 0, count: queue.length, current: true }]
      : []);
  return {
    status: 'playing',
    queue,
    segments,
    index: 0,
    currentTime: 0,
    duration: 100,
    volume: 0.8,
    albumNotePath: 'a.md',
    albumTitle: 'A',
    sourceLabel: '',
    playMode: 'once',
    ...over,
  };
};

function makeView(mod) {
  const view = new mod.VinylPlayerView({}, { settings: {}, engine: {} });
  const root = fakeEl();
  view.contentEl = root;
  // 转盘可见性判定要用到容器（窗口不可见 / 视图没渲染时停转）：给个最小的容器
  view.containerEl = { ownerDocument: { hidden: false }, isShown: () => true };
  view.update(snap());
  return { view, root };
}

const armOf = (view) => view.els.arm;

test('视图：播放中 = 姿态 2（角度 = 专辑进度换算出来的角，且不挂 is-parked）', () => {
  const mod = playerModule();
  const queue = [track(1, 'a.md'), track(2, 'a.md')];
  const { view } = makeView(mod);
  view.update(snap({ queue, index: 0, currentTime: 50, duration: 100 }));
  const arm = armOf(view);
  assert.equal(arm.classes.has('is-parked'), false, '播放中不归位');
  assert.equal(
    arm.vars.get('--vinyl-arm-angle'),
    `${armAngleForProgress(0.25).toFixed(2)}deg`,
    '两首里的第一首播一半 = 专辑进度 0.25'
  );
});

test('视图：暂停 / 停止 = 姿态 1（唱针归位支架）', () => {
  const mod = playerModule();
  const queue = [track(1, 'a.md'), track(2, 'a.md')];
  const { view } = makeView(mod);
  view.update(snap({ queue, index: 0, currentTime: 50, duration: 100 }));
  view.update(snap({ queue, index: 0, currentTime: 50, duration: 100, status: 'paused' }));
  const arm = armOf(view);
  assert.equal(arm.classes.has('is-parked'), true, '暂停 = 姿态 1');
  assert.equal(arm.vars.get('--vinyl-arm-angle'), `${ARM_PARK_ANGLE.toFixed(2)}deg`);
});

test('视图：清空（专辑被删 / 换碟失败）也回到姿态 1', () => {
  const mod = playerModule();
  const { view } = makeView(mod);
  const queue = [track(1, 'a.md')];
  view.update(snap({ queue, index: 0, currentTime: 1, duration: 100 })); // 先播放（姿态 2）
  assert.equal(armOf(view).classes.has('is-parked'), false);
  view.update(snap({ queue: [], segments: [], index: -1, albumNotePath: undefined, albumTitle: '', status: 'idle' }));
  const arm = armOf(view);
  assert.equal(arm.classes.has('is-parked'), true, '清空 = 姿态 1');
  assert.equal(arm.vars.get('--vinyl-arm-angle'), `${ARM_PARK_ANGLE.toFixed(2)}deg`);
});

test('视图：默认角度与停放角一致（壳刚建好、还没收到快照时也不指向别处）', () => {
  const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
  const m = css.match(/--vinyl-arm-angle,\s*([\d.]+)deg/);
  assert.ok(m, 'CSS 里写了默认角度');
  assert.equal(Number(m[1]), ARM_PARK_ANGLE, `CSS 默认角度 = 停放角（${m && m[1]}deg vs ${ARM_PARK_ANGLE}deg）`);
});

test('视图：唱臂写的是角度，CSS 用旋转 + 举起（姿态 1 抬 1.5px）', () => {
  const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
  assert.match(
    css,
    /\.vinyl-turntable-arm\s*\{[^}]*transform:\s*translateY\(var\(--vinyl-arm-lift, 0px\)\)\s*rotate\(var\(--vinyl-arm-angle/,
    '一个 transform 里同时表达「抬起」与「摆角」'
  );
  assert.match(css, /\.vinyl-turntable-arm\.is-parked\s*\{[^}]*--vinyl-arm-lift:\s*-1\.5px/, '姿态 1 抬起唱臂');
  assert.match(css, /\.vinyl-turntable-arm\s*\{[^}]*transform-origin:\s*0 50%/, '转轴在臂的左端（与几何常量一致）');
  assert.match(css, /\.vinyl-arm-head\s*\{[^}]*right:\s*0/, '唱头挂在臂的远端（几何上的唱针位置）');
  assert.match(css, /\.vinyl-arm-counterweight\s*\{[^}]*right:\s*100%/, '配重在转轴后方');
  assert.match(css, /\.vinyl-turntable-clip\s*\{[^}]*overflow:\s*hidden/, '臂盒子的溢出要裁掉（否则顶出横向滚动条）');
});
