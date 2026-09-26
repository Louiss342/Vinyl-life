// 引擎的马达斜坡回归：暂停 = 断电滑停、复播 = 马达起转（曲线在 core/motor，用例见 motor.test.cjs）。
// 盯住的坑：
//   ① 指令与声音是两件事：按下暂停状态就翻（播放键该灭、媒体面板该翻），但元素还要响着滑零点几秒 ——
//      提前停元素就是「啪」的一声，不是黑胶；
//   ② 音量分两层：淡出写在元素上，快照 / 落盘报的仍是用户那一档（电平表不该跟着抖）；
//   ③ 中途反向要接着走：滑到一半按播放，从当时的转速升起来，音量也不许跳（增益是转速的函数）；
//   ④ 斜坡必须收干净：搓碟起手 / 换曲 / 卸载 / 关视图都不许把曲线留在元素上；
//   ⑤ 后台节流：定时器迟到或干脆不来，也要能收（否则声音卡在半速上一直响）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  stdin: {
    contents: `export * from '../src/core/player-state';\nexport * from '../src/core/track';\n`,
    resolveDir: __dirname,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian'],
}).outputFiles[0].text;

class FakeAudio {
  constructor() {
    FakeAudio.last = this;
    this.listeners = {};
    this.volume = 1;
    this.preload = '';
    this.currentTime = 0;
    this.duration = 100;
    this.paused = true;
    this.playbackRate = 1;
    this.preservesPitch = true;
    this._src = '';
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  emit(type) {
    for (const fn of this.listeners[type] || []) fn();
  }
  async play() {
    this.paused = false;
    this.emit('play');
  }
  pause() {
    this.paused = true;
    this.emit('pause');
  }
  removeAttribute() {}
  load() {}
  set src(v) {
    this._src = v;
  }
  get src() {
    return this._src;
  }
}

const clock = { now: 0 };
const intervals = new Map(); // id → 回调（马达斜坡的推进表）
const timeouts = new Map(); // id → 回调（后台节流时的兜底）
let seq = 0;

/** 推进一次斜坡（真机上由 setInterval 按 16ms 打，这里由测试自己决定走多久） */
function tick() {
  for (const fn of [...intervals.values()]) fn();
}

/** 只让兜底表到点（模拟「隐藏窗口里 interval 被节流到没响」） */
function fireWatchdogs() {
  for (const [id, fn] of [...timeouts.entries()]) {
    timeouts.delete(id);
    fn();
  }
}

/** 假时钟：Date.now / performance.now 都跟着 clock 走，斜坡不真等 */
class FakeDate extends Date {
  constructor(...args) {
    if (args.length) super(...args);
    else super(clock.now);
  }
  static now() {
    return clock.now;
  }
}

function setup({ reducedMotion = false, ...overrides } = {}) {
  clock.now = 0;
  intervals.clear();
  timeouts.clear();
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: (name) => {
      if (name === 'obsidian') {
        return {
          App: class {},
          ItemView: class {},
          Menu: class {},
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
    console,
    Buffer,
    Audio: FakeAudio,
    Date: FakeDate,
    performance: { now: () => clock.now },
    window: {
      setInterval: (fn) => {
        const id = ++seq;
        intervals.set(id, fn);
        return id;
      },
      clearInterval: (id) => intervals.delete(id),
      setTimeout: (fn) => {
        const id = ++seq;
        timeouts.set(id, fn);
        return id;
      },
      clearTimeout: (id) => timeouts.delete(id),
      // 减少动效：prefersReducedMotion() 读的就是这条查询
      matchMedia: () => ({ matches: reducedMotion }),
    },
  });
  const deps = {
    app: {},
    local: {
      clearBlobs() {},
      keysOf: () => new Set(),
      resolveVaultUrl: (f) => 'app://local/' + f.path,
      resolveExternalUrl: (p) => 'app://ext/' + p,
    },
    netease: { songUrl: async () => ({ url: 'https://cdn/ne.mp3' }) },
    qq: { songUrl: async () => ({ url: 'https://cdn/qq.m4a' }) },
    kugou: { songUrl: async () => ({ url: 'https://cdn/kg.mp3' }) },
    settings: () => ({ quality: 'higher', autoPlay: false }),
    onTrackPlay: () => {},
    ...overrides,
  };
  return { mod: module.exports, engine: new module.exports.PlaybackEngine(deps) };
}

const track = (id) => ({ source: 'netease', id, title: 'T' + id, duration: 100 });

/** 一台「正在播第一首、音量 0.8」的引擎 */
async function playing(opts) {
  const { mod, engine } = setup(opts);
  engine.setQueue([track(1), track(2)], 'a.md', 'A', 'netease');
  await engine.playIndex(0);
  const audio = FakeAudio.last;
  engine.setVolume(0.8);
  return { mod, engine, audio };
}

/** 快照里的 motor 是跨 vm 领域的对象：逐字段比，不 deepEqual */
function motorOf(engine) {
  const m = engine.snapshot().motor;
  return m ? { phase: m.phase, rate: m.rate } : null;
}

test('暂停：指令立刻生效（状态翻成暂停、按钮该灭），声音还在滑', async () => {
  const { engine, audio } = await playing();
  assert.equal(engine.snapshot().status, 'playing');

  engine.pause();
  assert.equal(engine.snapshot().status, 'paused', '按下的这一刻状态就翻 —— 这是指令');
  assert.equal(audio.paused, false, '但元素还在响：滑停要零点几秒');
  assert.deepEqual(motorOf(engine), { phase: 'stopping', rate: 1 }, '斜坡从正常转速起');

  clock.now += 200;
  tick();
  assert.ok(audio.playbackRate < 0.3 && audio.playbackRate > 0.15, `滑到约 0.2 倍速（实得 ${audio.playbackRate}）`);
  assert.ok(audio.volume > 0 && audio.volume < 0.3, `音量同步淡出（实得 ${audio.volume}）`);
  assert.equal(audio.preservesPitch, false, '音高跟着转速掉 —— 真唱机断电就是这个声音');
  assert.equal(audio.paused, false, '还没滑到底，元素不许提前停（提前停就是「啪」的一声）');
});

test('暂停：滑到底元素才停，倍速 / 音量 / 音高都还回去，两张表都撤掉', async () => {
  const { engine, audio } = await playing();
  engine.pause();
  clock.now += 500; // 滑停总共 0.35s 级
  tick();

  assert.equal(audio.paused, true, '滑到底才真正暂停元素');
  assert.equal(audio.playbackRate, 1);
  assert.equal(audio.volume, 0.8, '音量还回用户那一档');
  assert.equal(audio.preservesPitch, true, '保音高还回去，正常播放不受影响');
  assert.equal(motorOf(engine), null, '收完了：快照里不再有斜坡');
  assert.equal(engine.snapshot().status, 'paused');
  assert.equal(intervals.size, 0, '推进表要撤（留着会一直空转）');
  assert.equal(timeouts.size, 0, '兜底表也要撤');
});

test('音量分两层：快照报用户那一档，元素才是淡出中的实际值', async () => {
  const { engine, audio } = await playing();
  engine.pause();
  clock.now += 100;
  tick();
  assert.equal(engine.snapshot().volume, 0.8, '电平表 / 落盘拿的是用户设的那一档');
  assert.ok(audio.volume < 0.8, '元素在淡出');

  engine.setVolume(0.4); // 斜坡期间用户还拖了音量条
  assert.equal(engine.snapshot().volume, 0.4, '快照跟着用户走');
  assert.ok(audio.volume < 0.4 && audio.volume > 0, '元素 = 新音量 × 淡出系数（不是二选一）');
});

test('复播：先压到地板转速、音量归零，再出声，然后一起升起来', async () => {
  const { engine, audio } = await playing();
  engine.pause();
  clock.now += 500;
  tick();
  assert.equal(audio.paused, true);

  await engine.toggle(); // 从暂停转回播放
  assert.equal(engine.snapshot().status, 'playing', '指令立刻生效');
  assert.equal(audio.paused, false, '元素已经出声');
  assert.ok(Math.abs(audio.playbackRate - 0.07) < 1e-9, `起步从地板转速开始（${audio.playbackRate}）`);
  assert.equal(audio.volume, 0, '起步那一刻是静音（低转速的呻吟不该听见）');
  assert.deepEqual(motorOf(engine), { phase: 'starting', rate: 0.07 });

  clock.now += 250;
  tick();
  assert.ok(audio.playbackRate >= 0.9, `0.25 秒到满音量线（实得 ${audio.playbackRate}）`);
  assert.ok(audio.volume > 0.8 * 0.9, `音量跟着起来（实得 ${audio.volume}，用户那一档是 0.8）`);

  clock.now += 400;
  tick();
  assert.equal(audio.playbackRate, 1);
  assert.equal(audio.volume, 0.8);
  assert.equal(audio.preservesPitch, true);
  assert.equal(motorOf(engine), null);
  assert.equal(intervals.size + timeouts.size, 0);
});

test('中途反向：滑到一半按播放，从当时的转速升起来，音量不跳', async () => {
  const { engine, audio } = await playing();
  engine.pause();
  clock.now += 150;
  tick();
  const mid = motorOf(engine);
  const fadedVolume = audio.volume;
  assert.ok(mid.phase === 'stopping' && mid.rate > 0.2 && mid.rate < 0.5, `滑到半路（${mid.rate}）`);
  assert.ok(fadedVolume > 0 && fadedVolume < 0.8);

  await engine.toggle();
  assert.deepEqual(motorOf(engine), { phase: 'starting', rate: mid.rate }, '接着当时的转速升，不从地板重来');
  assert.equal(audio.paused, false, '元素本来就没停，接着响');
  assert.ok(
    Math.abs(audio.volume - fadedVolume) < 1e-9,
    `音量接得住（增益是转速的函数，反向那一刻不该跳）：${audio.volume} vs ${fadedVolume}`
  );

  clock.now += 600;
  tick();
  assert.equal(audio.playbackRate, 1);
  assert.equal(audio.volume, 0.8);
  assert.equal(engine.snapshot().status, 'playing');
});

test('收斜坡：搓碟起手 / 换曲 / 卸载，都不许把曲线留在元素上', async () => {
  // ① 手按上盘
  const a = await playing();
  a.engine.pause();
  clock.now += 100;
  tick();
  a.engine.beginScratch({ live: true });
  assert.equal(a.audio.paused, true, '手在盘上：元素停声，声音归手势');
  assert.equal(a.audio.playbackRate, 1, '斜坡作废，倍速归位');
  assert.equal(a.audio.volume, 0.8, '音量归位（淡出到此为止）');
  assert.equal(a.audio.preservesPitch, false, '轻量档：音高跟着手（会话自己开的）');
  assert.equal(motorOf(a.engine), null);
  assert.equal(intervals.size, 0, '定时器要撤（否则旧曲线接着写元素）');

  // ② 换曲（斜坡中直接点下一首）
  const b = await playing();
  b.engine.pause();
  clock.now += 100;
  tick();
  await b.engine.playIndex(1);
  assert.equal(b.audio.playbackRate, 1, '换曲不做斜坡，但旧斜坡要收干净');
  assert.equal(b.audio.volume, 0.8);
  assert.equal(b.audio.preservesPitch, true);
  assert.equal(motorOf(b.engine), null);
  assert.equal(intervals.size, 0);

  // ③ 卸载音源（换专辑）
  const c = await playing();
  c.engine.pause();
  clock.now += 100;
  tick();
  c.engine.setQueue([track(3)], 'b.md', 'B', 'netease');
  assert.equal(c.audio.playbackRate, 1);
  assert.equal(c.audio.volume, 0.8);
  assert.equal(motorOf(c.engine), null);
  assert.equal(intervals.size + timeouts.size, 0);
});

test('后台节流：定时器不来（兜底）或迟到（一次 tick 落在终点）都要能收', async () => {
  // ① 只让兜底到点：隐藏窗口里 interval 被节流到没响
  const a = await playing();
  a.engine.pause();
  clock.now += 1200;
  fireWatchdogs();
  assert.equal(a.audio.paused, true, '兜底到点必须收');
  assert.equal(a.audio.playbackRate, 1);
  assert.equal(a.audio.volume, 0.8);
  assert.equal(motorOf(a.engine), null);
  assert.equal(intervals.size, 0, '兜底收尾也要把推进表撤掉');

  // ② 一次迟到的 tick：闭式曲线自己落在终点上（不靠逐帧积分）
  const b = await playing();
  b.engine.pause();
  clock.now += 5000;
  tick();
  assert.equal(b.audio.paused, true);
  assert.equal(b.audio.playbackRate, 1);
  assert.equal(motorOf(b.engine), null);
});

test('减少动效：不做斜坡（与旧行为一致，盘面本来就不转）', async () => {
  const { engine, audio } = await playing({ reducedMotion: true });
  engine.pause();
  assert.equal(audio.paused, true, '直停');
  assert.equal(engine.snapshot().status, 'paused');
  assert.equal(motorOf(engine), null);
  assert.equal(intervals.size, 0, '没排任何定时器');

  await engine.toggle();
  assert.equal(audio.paused, false);
  assert.equal(audio.playbackRate, 1, '倍速不参与（起步就是原速）');
  assert.equal(audio.volume, 0.8);
  assert.equal(motorOf(engine), null);
});

test('接线：两个执行者共用同一条曲线（引擎写元素、视图写盘面，各自 import 同一份 core/motor）', () => {
  const fs = require('node:fs');
  const engineSrc = fs.readFileSync(path.join(__dirname, '../src/core/player-state.ts'), 'utf8');
  const viewSrc = fs.readFileSync(path.join(__dirname, '../src/views/player-view.ts'), 'utf8');
  assert.match(engineSrc, /from '\.\/motor'/, '引擎：倍速与音量按 core/motor 走');
  assert.match(viewSrc, /from '\.\.\/core\/motor'/, '视图：盘面角度按同一份走');
  assert.match(engineSrc, /window\.setInterval\(\(\) => this\.motorTick\(\), MOTOR_TICK_MS\)/);
  assert.match(engineSrc, /window\.setTimeout\(\(\) => this\.motorEnd\(\), MOTOR_MAX_MS \+ 100\)/, '节流兜底');
});
