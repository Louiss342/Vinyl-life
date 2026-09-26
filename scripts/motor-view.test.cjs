// 转盘盘面的马达回归（假 DOM + 假时钟）：暂停时盘面滑停、停在原地不摆正，复播时从原角度起转。
// 盯住的坑（都是「只看代码看不出来」的那种）：
//   ① 暂停不再把 is-spinning 摘掉就完事 —— 摘掉 = transform 归零 = 用户报的「迅速跳帧摆正」；
//   ② 滑停 / 起转期间角度归 JS（--vinyl-spin-angle），逐帧走的必须是 core/motor 的同一条曲线
//      （角度 = ∫rate 换算成转角，与引擎写元素的那条是同一个积分）；
//   ③ 滑停结束停在原地：角度、类、延迟三者都不许再动；起转到位才交还 CSS 动画（负延迟续相位）；
//   ④ 停住时手按上去（搓碟起手）要接着那个角度走，不能跳回 0；
//   ⑤ 换曲的间隙（loading）什么都不动 —— 盘上还是同一张碟。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');

const source = esbuild.buildSync({
  stdin: {
    // 连 core/motor 一起导出：用例拿同一条曲线算期望值（「两个执行者共用一个积分」正是要钉的那件事）
    contents: `export * from '../src/views/player-view';\nexport * from '../src/core/motor';\n`,
    resolveDir: __dirname,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian'],
}).outputFiles[0].text;

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
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 200, height: 200 }),
    // 假 DOM 里没有真动画：currentSpinAngle 读不到相位 → 0（接手角度的基准就是 0）
    getAnimations: () => [],
    scrollIntoView() {},
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

const TRACK = { source: 'netease', id: 1, title: 'T', duration: 100 };
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

let cached = null;
function playerModule() {
  if (cached) return cached;
  const raf = new Map();
  const timeouts = new Map();
  const clock = { now: 0 };
  let seq = 0;
  const windowStub = {
    setTimeout: (fn) => {
      const id = ++seq;
      timeouts.set(id, fn);
      return id;
    },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => {
      const id = ++seq;
      raf.set(id, fn);
      return id;
    },
    cancelAnimationFrame: (id) => raf.delete(id),
  };
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
  cached = { mod: sandboxObj.module.exports, raf, clock, timeouts };
  return cached;
}

function fresh() {
  const { mod, raf, clock, timeouts } = playerModule();
  raf.clear();
  timeouts.clear();
  return { mod, raf, clock, timeouts };
}

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
      scratchPreload: false,
      turntableSpeed: 'normal',
      volume: 0.8,
      ...settings,
    },
    engine,
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

/** 推一帧（取最早排队的那个回调） */
function runFrame(raf, clock) {
  const [id, fn] = [...raf.entries()][0] || [];
  if (!fn) return false;
  raf.delete(id);
  fn(clock.now);
  return true;
}

/** 把时钟推到某个时刻并推一帧（斜坡按闭式重算，所以什么时候推、推几帧都不影响结果） */
function frameAt(raf, clock, now) {
  clock.now = now;
  runFrame(raf, clock);
}

const angleOf = (view) => Number(String(view.els.vinyl.vars.get('--vinyl-spin-angle')).replace('deg', ''));
const delayOf = (view) => String(view.els.vinyl.vars.get('animation-delay'));
/** 正常转速下一圈 1.8s：角度 = 走过的时间 ÷ 1.8 × 360 */
const degOf = (seconds, spin = 1.8) => (seconds * 360) / spin;

test('暂停：盘面滑停 —— 逐帧减速，最后停在原地（角度不摆正、也不归零）', () => {
  const { mod, raf, clock } = fresh();
  const { view } = makeView(mod);

  clock.now = 1000;
  view.update(snap({ status: 'paused', motor: { phase: 'stopping', rate: 1 } }));
  assert.equal(view.els.vinyl.classes.has('is-spin-held'), true, '旋转交给 JS（CSS 动画让位）');
  assert.equal(angleOf(view), 0, '起点就是当时的盘面角度');
  assert.equal(raf.size, 1, '起了逐帧循环');

  // 与引擎同一条曲线：0–100ms 走 ∫rate = 130ms×(1−e^(−100/130)) ≈ 0.0698s → 13.96°
  frameAt(raf, clock, 1100);
  const a100 = angleOf(view);
  assert.ok(Math.abs(a100 - degOf(0.0698)) < 0.05, `100ms 转过约 13.96°（实得 ${a100}）`);

  frameAt(raf, clock, 1250);
  const a250 = angleOf(view);
  assert.ok(a250 > a100, '还在转');
  assert.ok(a250 - a100 < a100, '但越转越慢（减速，不是匀速也不是加速）');

  frameAt(raf, clock, 1350); // 滑到地板（0.35s 级）→ 收尾
  assert.equal(raf.size, 0, '滑停有终点：到了就把表停了');
  assert.equal(view.els.vinyl.classes.has('is-spin-held'), true, '停住：还归 JS 扶着');
  const stopped = angleOf(view);
  assert.ok(stopped > a250, '最后一段还在往前走');
  // 滑停总共走 ∫rate = 130ms×(1−e^(−350/130)) ≈ 0.121s 的角 → 24.2°（不到一圈的十四分之一）
  assert.ok(Math.abs(stopped - degOf(0.1212)) < 0.05, `滑停总共约 24.2°（实得 ${stopped}）`);

  // 引擎随后发来「斜坡收完」的快照（状态早已是暂停）→ 什么都不该动
  view.update(snap({ status: 'paused' }));
  assert.equal(angleOf(view), stopped, '角度留在停下的那一刻（不摆正、也不归零）');
  assert.equal(view.els.vinyl.classes.has('is-spin-held'), true);
  assert.equal(view.els.vinyl.classes.has('is-spinning'), false);
  assert.equal(view.els.vinyl.vars.get('animation-delay'), undefined, '停住不是「按住动画」，延迟不参与');
  assert.equal(raf.size, 0, '没有多余的帧在排');
});

test('复播：从停下的角度起转，到位才交还 CSS 动画（负延迟续上相位）', () => {
  const { mod, raf, clock } = fresh();
  const { view } = makeView(mod);
  clock.now = 1000;
  view.update(snap({ status: 'paused', motor: { phase: 'stopping', rate: 1 } }));
  frameAt(raf, clock, 1500);
  const frozen = angleOf(view);
  assert.ok(frozen > 0);

  clock.now = 2000;
  view.update(snap({ status: 'playing', motor: { phase: 'starting', rate: 0.07 } }));
  assert.equal(angleOf(view), frozen, '起转的起点就是停下的角度（不跳回 0）');
  assert.equal(raf.size, 1, '接着逐帧走');

  frameAt(raf, clock, 2200);
  assert.ok(angleOf(view) > frozen, '盘面开始转');

  // 常见路径：引擎先收（快照里没有 motor 了），视图就地交还。
  // 角度按「起点 + ∫rate(2000→2400)」算 —— 交还的那一刻重算，不是拿上一帧的（frozen 之后 400ms）
  const expect = frozen + (mod.motorAdvance(0.07, 400, 'starting') * 360) / 1.8;
  clock.now = 2400;
  view.update(snap({ status: 'playing' }));
  assert.equal(view.els.vinyl.classes.has('is-spin-held'), false, '交还 CSS 动画');
  assert.equal(view.els.vinyl.classes.has('is-spinning'), true);
  assert.equal(raf.size, 0, '逐帧到此为止（合成器接手）');
  const frac = (((expect % 360) + 360) % 360) / 360;
  const ms = Number(delayOf(view).replace(/^-|ms$/g, ''));
  assert.ok(Math.abs(ms - Math.round(frac * 1800)) <= 1, `负延迟接上相位（${delayOf(view)} ↦ ${expect}°）`);
  assert.equal(view.els.vinyl.vars.get('--vinyl-spin-angle'), undefined, '交还后角度变量清掉');
});

test('起转自己走到终点（引擎还没发话）：一次迟到的帧也落在满速上，交还相位一致', () => {
  const { mod, raf, clock } = fresh();
  const { view } = makeView(mod);
  view.update(snap({ status: 'paused' }));
  clock.now = 1000;
  view.update(snap({ status: 'playing', motor: { phase: 'starting', rate: 0.07 } }));
  // 掉帧 / 后台节流：这一帧来得很晚，闭式曲线照样落在终点（起步走满 0.5s 的角 ≈ 99.6°）
  frameAt(raf, clock, 1600);
  assert.equal(raf.size, 0, '一次帧就收尾（不靠逐帧积分）');
  assert.equal(view.els.vinyl.classes.has('is-spin-held'), false, '交还 CSS 动画');
  assert.equal(view.els.vinyl.classes.has('is-spinning'), true);
  const ms = Number(delayOf(view).replace(/^-|ms$/g, ''));
  const frac = (((degOf(0.4981) % 360) + 360) % 360) / 360;
  assert.ok(Math.abs(ms - Math.round(frac * 1800)) <= 1, `负延迟 = 终点角度（${ms}ms ↦ ${degOf(0.4981)}°）`);
});

test('停住时手按上去（搓碟起手）：接着那个角度走，不跳回 0', () => {
  const { mod, raf, clock } = fresh();
  const { view } = makeView(mod);
  clock.now = 1000;
  view.update(snap({ status: 'paused', motor: { phase: 'stopping', rate: 1 } }));
  frameAt(raf, clock, 1500);
  const frozen = angleOf(view);
  assert.ok(frozen > 5, `先停在一个非零角度上（${frozen}°）`);

  // 在唱片上按下并从 0° 划到 10°（半径 60px，避开圆心收手区）
  const pt = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return { clientX: 200 + Math.cos(rad) * 60, clientY: 200 + Math.sin(rad) * 60 };
  };
  const base = { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, preventDefault() {} };
  const hit = view.els.turntable;
  hit.fire('pointerdown', { ...base, ...pt(0) });
  hit.fire('pointermove', { ...base, ...pt(10) });
  assert.equal(view.els.vinyl.classes.has('is-scratching'), true, '起手接管');
  frameAt(raf, clock, 1600);
  const dragged = angleOf(view);
  assert.ok(
    Math.abs(dragged - (frozen + 10)) < 1e-6,
    `盘面从停下的角度跟着手走（${frozen}° + 10° = ${frozen + 10}°，实得 ${dragged}°）`
  );
});

test('滑停到一半手按上去：从斜坡算到此刻的角度接着走（不是从 0 或停住角重来）', () => {
  const { mod, raf, clock } = fresh();
  const { view } = makeView(mod);
  clock.now = 1000;
  view.update(snap({ status: 'paused', motor: { phase: 'stopping', rate: 1 } }));
  frameAt(raf, clock, 1100);
  const mid = angleOf(view);
  assert.ok(mid > 10, `滑到一半已经转过一些角度（${mid}°）`);

  const pt = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return { clientX: 200 + Math.cos(rad) * 60, clientY: 200 + Math.sin(rad) * 60 };
  };
  const base = { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, preventDefault() {} };
  const hit = view.els.turntable;
  hit.fire('pointerdown', { ...base, ...pt(0) });
  hit.fire('pointermove', { ...base, ...pt(10) });
  frameAt(raf, clock, 1200);
  const dragged = angleOf(view);
  assert.ok(
    Math.abs(dragged - (mid + 10)) < 1e-6,
    `接着斜坡的角度走（${mid}° + 10°，实得 ${dragged}°）—— 收掉斜坡之前就得把角度读下来`
  );
});

test('换曲的间隙（loading）不动转盘：接着转 / 接着停，都不许复位', () => {
  const { mod, raf, clock } = fresh();
  const { view } = makeView(mod);
  assert.equal(view.els.vinyl.classes.has('is-spinning'), true, '播放中：CSS 动画在转');

  view.update(snap({ status: 'loading' }));
  assert.equal(view.els.vinyl.classes.has('is-spinning'), true, '换曲间隙接着转（旧写法在这里摘掉类 → 跳回 0°）');
  assert.equal(view.els.vinyl.classes.has('is-spin-held'), false);

  // 停住时换曲：一动不动
  clock.now = 1000;
  view.update(snap({ status: 'paused', motor: { phase: 'stopping', rate: 1 } }));
  frameAt(raf, clock, 1500);
  const frozen = angleOf(view);
  view.update(snap({ status: 'loading' }));
  assert.equal(angleOf(view), frozen, '停住的角度原样留着');
  assert.equal(raf.size, 0);
});

test('出错也停在原地（不摆正），恢复播放时从那个角度接着转', () => {
  const { mod, raf } = fresh();
  const { view } = makeView(mod);
  view.update(snap({ status: 'error' }));
  assert.equal(view.els.vinyl.classes.has('is-spin-held'), true, '出错：定住');
  assert.equal(view.els.vinyl.classes.has('is-spinning'), false);
  const held = angleOf(view);

  view.update(snap({ status: 'playing' }));
  assert.equal(view.els.vinyl.classes.has('is-spin-held'), false, '恢复播放：交还动画');
  assert.equal(view.els.vinyl.classes.has('is-spinning'), true);
  const ms = Number(delayOf(view).replace(/^-|ms$/g, ''));
  assert.ok(Math.abs(ms - Math.round((held / 360) * 1800)) <= 1, '从定住的角度续上');
});

test('转速档：同样的斜坡，慢档扫过的角度更小（角度 = 走过的时间 ÷ 一圈秒数）', () => {
  const { mod, raf, clock } = fresh();
  const { view } = makeView(mod, { turntableSpeed: 'slow' });
  clock.now = 1000;
  view.update(snap({ status: 'paused', motor: { phase: 'stopping', rate: 1 } }));
  frameAt(raf, clock, 1100);
  const slow = angleOf(view);
  // 0.0698s 的角：标准档（1.8s/圈）13.96°，慢档（2.6s/圈）9.66°
  assert.ok(Math.abs(slow - degOf(0.0698, 2.6)) < 0.05, `慢档 100ms 约 9.66°（实得 ${slow}）`);
});

test('样式闸门：接管规则与搓碟共用一份，停住的角度写在同一变量上', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const view = fs.readFileSync(path.join(ROOT, 'src/views/player-view.ts'), 'utf8');
  assert.match(
    css,
    /\.vinyl-turntable-vinyl\.is-scratching,\s*\.vinyl-turntable-vinyl\.is-spin-held \{[^}]*animation: none;\s*transform: rotate\(var\(--vinyl-spin-angle/,
    '搓碟 / 马达共用同一条接管规则（动画让位，角度走 --vinyl-spin-angle）'
  );
  assert.match(css, /\.vinyl-turntable-vinyl\.is-spinning\.is-hidden \{\s*animation-play-state: paused;/, '看不见时按住');
  assert.doesNotMatch(css, /is-paused/, 'is-paused 已撤（暂停不再是「按住动画」，而是把角度交给 JS）');
  assert.doesNotMatch(view, /is-paused/, '源码里也不该再有旧类');
  assert.doesNotMatch(view, /vinyl-scratch-angle/, '角度变量统一成 --vinyl-spin-angle');
});
