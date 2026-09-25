// 引擎的搓碟通道回归：起手交位置、搓碟期间状态不抖（对外仍是起手前的姿态）、
// 轻量倍速只有正向出声、抬手写回位置，以及换曲 / 清队列一律收掉会话。
// 盯住的坑：
//   ① 元素在搓碟期间会被反复起停（轻量音效按倍速走），若照旧上报状态，
//      播放键会闪、系统媒体面板会翻成暂停 —— 对外必须报「起手前的姿态」；
//   ② 反向与「按住不放」在元素上出不了声（负速率没普及），位置由视图积分，
//      抬手必须一次性写回元素，否则音乐从旧位置继续。
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

// 假元素：引擎用到的那几个成员 + 事件可手动触发（真机的 play / pause 事件是异步的，
// 这里同步触发更严苛：起手时先立会话再暂停，正是为了扛住这个时序）
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
    // 真元素默认「保音高」（变速不变调的时间拉伸）；搓碟期间要关掉它，见下面的用例
    this.preservesPitch = true;
    this.playCalls = 0;
    this._src = '';
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  emit(type) {
    for (const fn of this.listeners[type] || []) fn();
  }
  async play() {
    this.playCalls++;
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

function setup(overrides = {}) {
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
  });
  const mod = module.exports;
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
  return { mod, engine: new mod.PlaybackEngine(deps) };
}

const track = (id) => ({ source: 'netease', id, title: 'T' + id, duration: 100 });

/** 建一台「正在播第一首」的引擎 */
async function playing(overrides) {
  const { mod, engine } = setup(overrides);
  engine.setQueue([track(1), track(2)], 'a.md', 'A', 'netease');
  await engine.playIndex(0);
  return { mod, engine, audio: FakeAudio.last };
}

test('起手：元素暂停、对外仍报「播放中」，位置由视图喂', async () => {
  const { engine, audio } = await playing();
  audio.currentTime = 42;
  const info = engine.beginScratch({ live: true });
  // 跨 vm 领域的对象不能 deepStrictEqual（原型不同），逐字段比
  assert.equal(info.time, 42);
  assert.equal(info.playing, true);
  assert.equal(audio.paused, true, '声音交给搓碟那条路：元素先停');
  assert.equal(engine.snapshot().status, 'playing', '手在盘上：对外不该翻成暂停');
  assert.equal(engine.snapshot().currentTime, 42);
  engine.updateScratch(43.5);
  assert.equal(engine.snapshot().currentTime, 43.5, '搓碟期间的位置读视图喂的值');
  assert.equal(audio.currentTime, 42, '元素本身不动（位置在手势那边）');
});

test('起手：没曲目 / 换曲取址的间隙都不接', async () => {
  const { engine } = setup();
  assert.equal(engine.beginScratch({ live: true }), null, '空队列不接');

  // 换曲取址中（songUrl 永不落地）：status = loading
  const pending = setup({ netease: { songUrl: () => new Promise(() => {}) } });
  pending.engine.setQueue([track(1)], 'a.md', 'A', 'netease');
  void pending.engine.playIndex(0);
  assert.equal(pending.engine.beginScratch({ live: true }), null, 'loading 不接');
});

test('起手：暂停中按盘也算（搓碟期间对外报暂停）', async () => {
  const { engine, audio } = await playing();
  engine.pause();
  assert.equal(engine.snapshot().status, 'paused');
  const info = engine.beginScratch({ live: true });
  assert.equal(info.playing, false);
  assert.equal(engine.snapshot().status, 'paused', '起手前是暂停，对外还是暂停');
});

test('轻量音效：正向按倍速出声，反向与按住不放都停声', async () => {
  const { engine, audio } = await playing();
  engine.beginScratch({ live: true });
  engine.scratchRate(0.5);
  assert.equal(audio.playbackRate, 0.5);
  assert.equal(audio.paused, false, '正向要出声');
  engine.scratchRate(-0.5);
  assert.equal(audio.paused, true, '反向：元素出不了声，位置由视图积分');
  engine.scratchRate(0.4);
  assert.equal(audio.paused, false);
  engine.scratchRate(0.01);
  assert.equal(audio.paused, true, '低于出声下限 = 按住不放（停声）');
  engine.scratchRate(9);
  assert.equal(audio.playbackRate, 4, '倍速钳到上限');
});

test('搓碟期间：元素的 play / pause 事件不许改对外状态', async () => {
  const { engine, audio } = await playing();
  engine.beginScratch({ live: true });
  audio.emit('pause');
  assert.equal(engine.snapshot().status, 'playing', '轻量音效反复起停：对外仍是播放中');
  audio.emit('play');
  engine.scratchRate(-1);
  audio.emit('pause');
  assert.equal(engine.snapshot().status, 'playing');
});

test('轻量音效：音高跟着转速（关掉元素的保音高，松手还回去）', async () => {
  const { engine, audio } = await playing();
  assert.equal(audio.preservesPitch, true, '默认是保音高的时间拉伸');
  engine.beginScratch({ live: true });
  assert.equal(audio.preservesPitch, false, '搓碟：转速变多少、音高就变多少（唱片那一套）');
  engine.endScratch(30, true);
  assert.equal(audio.preservesPitch, true, '松手还回去，正常播放不受影响');

  const b = await playing();
  b.engine.beginScratch({ live: true });
  assert.equal(b.audio.preservesPitch, false);
  await b.engine.playIndex(1); // 换曲：会话被引擎自己收掉
  assert.equal(b.audio.preservesPitch, true, '换曲也要还回去（会话不许把开关漏在关着的那一侧）');
});

test('轻量音效：从停声转出声先把元素对到针位（否则听到的是旧位置）', async () => {
  const { engine, audio } = await playing();
  audio.currentTime = 30;
  engine.beginScratch({ live: true });
  engine.updateScratch(31.5); // 倒着拖了一段：针位退到 31.5，元素原地不动（还是 30）
  engine.scratchRate(-1);
  assert.equal(audio.paused, true, '反向：元素停声');
  engine.scratchRate(0.5); // 又往前拖
  assert.equal(audio.currentTime, 31.5, '出声前对齐到针位 —— 不对齐就是「声音跟歌没关系」');
  assert.equal(audio.paused, false);
});

test('轻量音效：出声 / 停声两档迟滞（换向的那一瞬不抖元素）', async () => {
  const { engine, audio } = await playing();
  engine.beginScratch({ live: true });
  engine.scratchRate(0.5);
  assert.equal(audio.paused, false);
  const calls = audio.playCalls;
  engine.scratchRate(0.08); // 落在两档之间：保持现状（还在出声）
  assert.equal(audio.paused, false, '中间地带不动元素');
  assert.equal(audio.playCalls, calls, '不重复 play');
  engine.scratchRate(0.3);
  assert.equal(audio.paused, false);
  engine.scratchRate(0.02); // 低于停声线：停
  assert.equal(audio.paused, true);
  engine.scratchRate(0.1); // 又回到中间地带：保持停着，别一有动静就起
  assert.equal(audio.paused, true);
  engine.scratchRate(0.15); // 越过出声线：出声
  assert.equal(audio.paused, false);
});

test('完整音效：声音归搓碟台，引擎不碰元素倍速', async () => {
  const { engine, audio } = await playing();
  engine.beginScratch({ live: false });
  engine.scratchRate(0.5);
  assert.equal(audio.playbackRate, 1, '不属于轻量路：不调倍速');
  assert.equal(audio.paused, true, '元素保持安静（声音由搓碟台出）');
  assert.equal(audio.preservesPitch, true, '元素这边一点都不动');
});

test('换出声路线：搓碟台中途接手 → 元素让位（倍速复位、保音高还回去）', async () => {
  const { engine, audio } = await playing();
  engine.beginScratch({ live: true });
  engine.scratchRate(0.5);
  assert.equal(audio.paused, false);
  engine.setScratchLive(false); // 视图的搓碟台备好了
  assert.equal(audio.paused, true, '元素让位：两边一起响会叠成回声');
  assert.equal(audio.playbackRate, 1);
  assert.equal(audio.preservesPitch, true);
  engine.scratchRate(0.5); // 换过去之后，轻量路的话一句都不该再听
  assert.equal(audio.paused, true, '已经切到搓碟台：不再动元素');
});

test('抬手：位置写回元素，按起手前的姿态回到播放 / 暂停', async () => {
  const a = await playing();
  a.engine.beginScratch({ live: true });
  a.engine.updateScratch(30);
  a.engine.endScratch(30, true);
  assert.equal(a.audio.currentTime, 30, '位置写回元素');
  assert.equal(a.audio.playbackRate, 1, '倍速复位');
  assert.equal(a.audio.paused, false, '回到播放');
  assert.equal(a.engine.snapshot().status, 'playing');

  const b = await playing();
  b.engine.beginScratch({ live: true });
  b.engine.scratchRate(2);
  assert.equal(b.audio.paused, false);
  b.engine.endScratch(10, false);
  assert.equal(b.audio.paused, true, '起手前是暂停：抬手后仍暂停');
  assert.equal(b.engine.snapshot().status, 'paused');
  assert.equal(b.engine.snapshot().currentTime, 10, '位置留在松手处（＝手动定位）');
});

test('抬手：位置不许顶到末尾（贴上会直接触发切歌）', async () => {
  const { engine, audio } = await playing();
  audio.duration = 100;
  engine.beginScratch({ live: true });
  engine.endScratch(100, true);
  assert.ok(audio.currentTime <= 99.96 && audio.currentTime >= 99.9, `留出余量，实得 ${audio.currentTime}`);
});

test('搓碟期间：别处的 seek 不生效（位置归手势）', async () => {
  const { engine, audio } = await playing();
  engine.beginScratch({ live: true });
  engine.seek(0.5);
  assert.equal(audio.currentTime, 0, 'seek 被忽略');
  engine.endScratch(20, true);
  engine.seek(0.5);
  assert.equal(audio.currentTime, 50, '抬手后 seek 照常');
});

test('换曲 / 清队列 / 卸载：搓碟会话一律收掉', async () => {
  const a = await playing();
  a.engine.beginScratch({ live: true });
  a.engine.updateScratch(50);
  await a.engine.playIndex(1);
  assert.equal(a.engine.snapshot().currentTime, 0, '切歌后不再读搓碟位置');

  const b = await playing();
  b.engine.beginScratch({ live: true });
  b.engine.updateScratch(50);
  b.engine.setQueue([track(3)], 'b.md', 'B', 'netease');
  assert.equal(b.engine.snapshot().currentTime, 0, '换队列后不再读搓碟位置');

  const c = await playing();
  c.engine.beginScratch({ live: true });
  c.engine.clear();
  assert.equal(c.engine.snapshot().status, 'idle');
  assert.equal(c.engine.snapshot().currentTime, 0);
});

test('搓碟位置会被时长夹住（喂超界的值也不越界）', async () => {
  const { engine } = await playing();
  engine.beginScratch({ live: true });
  engine.updateScratch(999);
  assert.equal(engine.snapshot().currentTime, 100);
  engine.updateScratch(-5);
  assert.equal(engine.snapshot().currentTime, 0);
});
