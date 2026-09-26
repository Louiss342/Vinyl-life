// 播放队列拖拽排序：
//   A 部分纯函数：reorderTracks（含越界）；
//   B 部分引擎：moveTrack 后「正在播的那首仍是当前曲目」；
//   C 部分设置归一化：音量 / 上次播放位置（队列顺序已不再持久化 —— 设计稿要求不记忆拖拽顺序）；
//   D 部分视图：落点换算（行前/后 → 结果下标）+ 落点视觉复用专辑墙的同一套 CSS；
//   E 部分「不记忆拖拽顺序」的源码防护：data.json 不写 queueOrder、引擎不接顺序钩子、
//          恢复发行顺序 / 清空后面的专辑两个按键已删除。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const nodePath = require('node:path');

const OBSIDIAN_STUB = {
  App: class {},
  ItemView: class {},
  Plugin: class {},
  PluginSettingTab: class {},
  SettingPage: class {},
  Setting: class {},
  Menu: class {},
  Modal: class {},
  FuzzySuggestModal: class {},
  Notice: class {},
  TFile: class {},
  TFolder: class {},
  normalizePath: (p) => p,
  setIcon: () => {},
};

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
      if (name === 'obsidian') return OBSIDIAN_STUB;
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

// vm 里造出的数组 / 对象与测试进程不是同一个 realm，直接 deepStrictEqual 会因原型不同而失败：
// 比较前一律搬回本 realm（数组 Array.from，对象 JSON 往返）。
const keys = (list) => Array.from(list, (t) => trackKey(t));
const plain = (v) => JSON.parse(JSON.stringify(v));

// —— 曲目小工厂：只用 trackKey 有意义的字段 ——
const ne = (id, title = 'T' + id) => ({ source: 'netease', id, duration: 1000, title });

// ============ A. 纯函数（track.ts） ============

const trackMod = loadModule('src/core/track.ts');
const { reorderTracks, trackKey } = trackMod;

test('reorderTracks：向后移 / 向前移，返回新数组且不改原数组', () => {
  const a = [ne(1), ne(2), ne(3), ne(4)];
  assert.deepEqual(keys(reorderTracks(a, 0, 2)), ['ne:2', 'ne:3', 'ne:1', 'ne:4'], '0 → 2');
  assert.deepEqual(keys(reorderTracks(a, 3, 1)), ['ne:1', 'ne:4', 'ne:2', 'ne:3'], '3 → 1');
  assert.deepEqual(keys(reorderTracks(a, 1, 1)), ['ne:1', 'ne:2', 'ne:3', 'ne:4'], '原地');
  assert.deepEqual(keys(a), ['ne:1', 'ne:2', 'ne:3', 'ne:4'], '原数组不得被改动');
  assert.notEqual(reorderTracks(a, 0, 2), a, '必须返回新数组');
});

test('reorderTracks：越界 / 非法下标 → 返回原数组副本（不崩、不动）', () => {
  const a = [ne(1), ne(2), ne(3)];
  for (const [from, to] of [
    [-1, 1],
    [0, -1],
    [3, 0],
    [0, 3],
    [1.5, 2],
    [1, 1.5],
  ]) {
    const out = reorderTracks(a, from, to);
    assert.deepEqual(keys(out), ['ne:1', 'ne:2', 'ne:3'], `from=${from} to=${to}`);
    assert.notEqual(out, a, `from=${from} to=${to} 也要返回副本`);
  }
  assert.deepEqual(keys(reorderTracks([], 0, 0)), [], '空队列不崩');
});

test('track.ts：不再提供「按存过的顺序重排」（顺序不落盘，就没有可套用的顺序）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/core/track.ts'), 'utf8');
  assert.equal(/applyTrackOrder/.test(src), false, 'applyTrackOrder 已随「恢复发行顺序」一起删除');
});

// ============ B. 引擎（player-state.ts） ============

const audioInstances = [];

class AudioStub {
  constructor(src) {
    this.src = src || '';
    this.volume = 1;
    this.currentTime = 0;
    this.paused = true;
    this.preload = '';
    this.duration = NaN;
    this.listeners = {};
    audioInstances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeAttribute(name) {
    if (name === 'src') this.src = '';
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

const ALBUM = '专辑/Abbey Road.md';

function makeEngine({ gate } = {}) {
  const local = {
    buildTracks: async () => [],
    clearBlobs() {},
    keysOf: () => [],
    resolveVaultUrl: (f) => `vault://${f.path}`,
    resolveExternalUrl: (p) => `ext://${p}`,
  };
  const deps = {
    app: {},
    local,
    netease: {
      album: async () => ({ songs: [] }),
      songUrl: async (id) => {
        if (gate) await gate; // 取链被挂住：模拟「加载中」这段时间窗
        return { url: `https://x/${id}.mp3`, level: 'higher' };
      },
    },
    qq: null,
    settings: () => ({ defaultSource: 'auto', autoPlay: false, quality: 'higher' }),
  };
  const engine = new PlaybackEngine(deps);
  return { engine, audio: audioInstances[audioInstances.length - 1] };
}

function setTracks(engine, tracks, albumPath = ALBUM) {
  engine.setQueue(tracks, albumPath, 'Abbey Road', 'netease');
}

test('setQueue：一律按构建出来的顺序（发行顺序），不套用任何存过的排列', () => {
  const a = makeEngine();
  setTracks(a.engine, [ne(1), ne(2), ne(3)]);
  assert.deepEqual(keys(a.engine.snapshot().queue), ['ne:1', 'ne:2', 'ne:3'], '原顺序');
  assert.equal(a.engine.snapshot().index, -1, '换队列后不自动指向某首');
});

test('moveTrack：重排后正在播的那首仍是当前曲目（index 跟着它走，音频不重载）', async () => {
  const { engine, audio } = makeEngine();
  setTracks(engine, [ne(1), ne(2), ne(3), ne(4)]);
  await engine.playIndex(2); // 正在播 ne:3
  const srcBefore = audio.src;
  assert.equal(trackKey(engine.snapshot().current), 'ne:3');

  engine.moveTrack(2, 0); // 把正在播的那首拖到最前
  let snap = engine.snapshot();
  assert.deepEqual(keys(snap.queue), ['ne:3', 'ne:1', 'ne:2', 'ne:4'], '队列顺序已变');
  assert.equal(trackKey(snap.current), 'ne:3', '当前曲目必须还是 ne:3（不能跳到别的曲子上）');
  assert.equal(snap.index, 0, 'index 应指向新位置');
  assert.equal(audio.src, srcBefore, '同一首歌不重新解析地址（播放不被打断）');
  assert.equal(audio.paused, false, '重排不该停播');

  engine.moveTrack(0, 3); // 再拖到最后
  snap = engine.snapshot();
  assert.deepEqual(keys(snap.queue), ['ne:1', 'ne:2', 'ne:4', 'ne:3']);
  assert.equal(trackKey(snap.current), 'ne:3', '双向拖动都不丢当前曲');
  assert.equal(snap.index, 3);

  engine.moveTrack(1, 2); // 拖别的曲子：当前曲目只是 index 平移
  snap = engine.snapshot();
  assert.deepEqual(keys(snap.queue), ['ne:1', 'ne:4', 'ne:2', 'ne:3']);
  assert.equal(trackKey(snap.current), 'ne:3');
  assert.equal(snap.index, 3);
});

test('moveTrack：next() 按新顺序推进（顺序是真生效的，不只 UI）', async () => {
  const { engine } = makeEngine();
  setTracks(engine, [ne(1), ne(2), ne(3)]);
  await engine.playIndex(0);
  engine.moveTrack(2, 1); // [1,2,3] → [1,3,2]
  await engine.next();
  assert.deepEqual(keys(engine.snapshot().queue), ['ne:1', 'ne:3', 'ne:2']);
  assert.equal(trackKey(engine.snapshot().current), 'ne:3', '下一首应取新顺序里的后一首');
  assert.equal(engine.snapshot().index, 1);
});

test('moveTrack：越界 / 原地拖拽是空操作（不改队列）', async () => {
  const { engine } = makeEngine();
  setTracks(engine, [ne(1), ne(2)]);
  await engine.playIndex(0);
  engine.moveTrack(0, 0);
  engine.moveTrack(-1, 1);
  engine.moveTrack(0, 2);
  engine.moveTrack(2, 0);
  assert.deepEqual(keys(engine.snapshot().queue), ['ne:1', 'ne:2']);
  assert.equal(trackKey(engine.snapshot().current), 'ne:1');
});

test('moveTrack：拖拽撞上「正在加载」不打断加载（当前曲判定按曲目而非下标）', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { engine, audio } = makeEngine({ gate });
  setTracks(engine, [ne(1), ne(2), ne(3)]);
  const loading = engine.playIndex(2); // ne:3 的地址还在解析（被 gate 挂住）
  engine.moveTrack(2, 0); // 用户此时把它拖到最前 → index 变了但曲子没变
  release();
  await loading;
  const snap = engine.snapshot();
  assert.equal(snap.status, 'playing', '重排不该丢弃加载结果（否则永远停在 loading）');
  assert.equal(audio.src, 'https://x/3.mp3', '加载的是被拖走的那首');
  assert.equal(trackKey(snap.current), 'ne:3');
  assert.equal(snap.index, 0, 'index 已是新位置');
});

test('加载中切走：旧曲的加载结果不得覆盖新曲（原有竞态语义不变）', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { engine, audio } = makeEngine({ gate });
  setTracks(engine, [ne(1), ne(2), ne(3)]);
  const first = engine.playIndex(2); // 先点第 3 首（慢）
  const second = engine.playIndex(0); // 又点第 1 首
  release();
  await Promise.all([first, second]);
  assert.equal(audio.src, 'https://x/1.mp3', '先发起的那首不得覆盖后点的');
  assert.equal(engine.snapshot().status, 'playing');
  assert.equal(trackKey(engine.snapshot().current), 'ne:1');
});

test('moveTrack：没在播（index = -1）时重排不崩、不做当前曲目换算', () => {
  const { engine } = makeEngine();
  setTracks(engine, [ne(1), ne(2), ne(3)]);
  engine.moveTrack(0, 2);
  const snap = engine.snapshot();
  assert.deepEqual(keys(snap.queue), ['ne:2', 'ne:3', 'ne:1']);
  assert.equal(snap.index, -1, '没在播就还是没在播');
  assert.equal(snap.current, undefined);
});

// ============ C. 设置归一化（settings.ts） ============

const settingsMod = loadModule('src/settings.ts');
const { normalizeLastPlayback, normalizeVolume, DEFAULT_SETTINGS } = settingsMod;

test('resolveSegmentDropIndex：整段拖拽落点（块先摘掉，下标按摘后算）', () => {
  // 落点数学已从 player-view 抽到 core/queue-move：拖拽、键盘、命令层共用一份
  const { resolveSegmentDropIndex } = loadModule('src/core/queue-move.ts');
  // A(0,2) B(2,1) C(3,1)：把 A 拖到 C 之后 → 摘掉 A 后是 [B,C]，插到 C 后 = 2
  assert.equal(resolveSegmentDropIndex(0, 2, 3, 1, true), 2);
  // 把 A 拖到 B 之前 → 摘掉 A 后是 [B,C]，插到 B 前 = 0
  assert.equal(resolveSegmentDropIndex(0, 2, 2, 1, false), 0);
  // 把 C 拖到 A 之前 → 摘掉 C 后是 [A,B]，插到 A 前 = 0
  assert.equal(resolveSegmentDropIndex(3, 1, 0, 2, false), 0);
  // 把 B 拖到 A 之后 → 摘掉 B 后是 [A,C]，插到 A 后 = 2
  assert.equal(resolveSegmentDropIndex(2, 1, 0, 2, true), 2);
});

test('segmentMoveBy：整段上下移一格（键盘路径，与拖拽同一份落点数学）', () => {
  const { segmentMoveBy } = loadModule('src/core/queue-move.ts');
  // A(0,2) B(2,3) C(5,1)：当前曲目在 B 段里（下标 3）
  const segs = [
    { start: 0, count: 2 },
    { start: 2, count: 3 },
    { start: 5, count: 1 },
  ];
  // B 下移（与 C 换位）：摘掉 B 后是 [A1,A2,C1]，插到 C 之后 = 3
  assert.deepEqual({ ...segmentMoveBy(segs, 3, 1) }, { start: 2, count: 3, to: 3 });
  // B 上移（与 A 换位）：摘掉 B 后是 [A1,A2,C1]，插到 A 之前 = 0
  assert.deepEqual({ ...segmentMoveBy(segs, 3, -1) }, { start: 2, count: 3, to: 0 });
  // 首段上移 / 末段下移：没有可去的地方 → null（别夹到边界再发一次等价移动，界面会白闪一下）
  assert.equal(segmentMoveBy(segs, 0, -1), null);
  assert.equal(segmentMoveBy(segs, 5, 1), null);
  // 移的是「当前曲目所在的那一段」：同一段里换一首，结果相同
  assert.deepEqual({ ...segmentMoveBy(segs, 2, 1) }, { ...segmentMoveBy(segs, 4, 1) });
  // 边界：空队列 / 下标不在任何段内 / delta 非法
  assert.equal(segmentMoveBy([], 0, 1), null);
  assert.equal(segmentMoveBy(segs, 99, 1), null);
  assert.equal(segmentMoveBy(segs, 3, 0), null);
});

test('专辑队列模式接线：顶部开关 / 分段渲染 / 整段操作都在（清空与恢复已删）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/views/player-view.ts'), 'utf8');
  const headerBlock = src.slice(src.indexOf('const header = '), src.indexOf('const playModeBtn'));
  assert.match(headerBlock, /pickBtn/, '「选取专辑」是顶部第一个按钮（翻到页面 2）');
  assert.match(headerBlock, /queueModeBtn/, '队列模式开关在播放模式之前（顶部那一行的顺序就是创建顺序）');
  // 追加发生在专辑墙与唱片区的点击路径上（播放器只负责显示与整段操作）
  const shelf = fs.readFileSync(path.join(__dirname, '../src/views/shelf-view.ts'), 'utf8');
  assert.match(shelf, /settings\.queueMode[\s\S]{0,200}?enqueueAlbum\(/, '队列模式下点专辑走引擎的 enqueueAlbum');
  assert.match(src, /engine\.removeRange\(seg\.start, seg\.count\)/, '整段移除按段的下标与长度');
  assert.match(src, /engine\.moveRange\(/, '跨专辑排序走 moveRange');
  assert.match(src, /resolveSegmentDropIndex\(/, '整段落点用纯函数换算');
});

test('settings：音量与「上次播放位置」默认值 + 脏数据回落', () => {
  assert.equal(DEFAULT_SETTINGS.volume, 0.8);
  assert.equal(DEFAULT_SETTINGS.lastPlayback, undefined, '没播过就没有记录');

  assert.equal(normalizeVolume(0.3), 0.3);
  assert.equal(normalizeVolume(0), 0, '静音是合法值');
  assert.equal(normalizeVolume(1), 1);
  for (const bad of [undefined, null, '0.5', NaN, -0.1, 1.5, {}]) {
    assert.equal(normalizeVolume(bad), 0.8, `脏值应回落默认：${String(bad)}`);
  }
});

test('normalizeLastPlayback：缺字段 / 类型不对 / 负数一律丢弃或归零', () => {
  const ok = normalizeLastPlayback({ albumPath: 'Vinyl Life/Vinyl Note/A.md', trackKey: 'ne:1', positionSec: 42.7 });
  assert.deepEqual(plain(ok), { albumPath: 'Vinyl Life/Vinyl Note/A.md', trackKey: 'ne:1', positionSec: 42 }, '位置取整');

  for (const bad of [undefined, null, 'x', [], {}, { albumPath: 'a.md' }, { albumPath: 'a.md', trackKey: '' }]) {
    assert.equal(normalizeLastPlayback(bad), undefined, `脏数据应丢弃：${JSON.stringify(bad)}`);
  }
  const neg = normalizeLastPlayback({ albumPath: 'a.md', trackKey: 'k', positionSec: -5 });
  assert.equal(neg.positionSec, 0, '负数位置归零（不回放，只是从头开始）');
  const nan = normalizeLastPlayback({ albumPath: 'a.md', trackKey: 'k', positionSec: 'x' });
  assert.equal(nan.positionSec, 0, '非数字位置归零');
});

// ============ D. 视图：落点换算 + 落点视觉 ============

const viewMod = loadModule('src/views/player-view.ts');
const { resolveQueueDropIndex } = viewMod;

test('resolveQueueDropIndex：行前/后落点 → 结果下标（等效于「先移除再插入」）', () => {
  // 往后拖：落在第 2 行前 → 结果下标 1（被拖行先移除，后面左移一位）
  assert.equal(resolveQueueDropIndex(0, 2, false), 1);
  assert.equal(resolveQueueDropIndex(0, 2, true), 2);
  // 往前拖：落在第 0 行前/后 → 0 / 1
  assert.equal(resolveQueueDropIndex(2, 0, false), 0);
  assert.equal(resolveQueueDropIndex(2, 0, true), 1);
  // 落到自己身上 = 原位（拖动无副作用）
  assert.equal(resolveQueueDropIndex(1, 1, false), 1);
  assert.equal(resolveQueueDropIndex(1, 1, true), 1);
  // 拖到最后一行之后
  assert.equal(resolveQueueDropIndex(0, 3, true), 3);
});

test('落点换算 + reorderTracks：拖到某行之前 / 之后得到预期队列', () => {
  const q = [ne(1), ne(2), ne(3), ne(4)];
  const moved = (from, target, after) =>
    keys(reorderTracks(q, from, resolveQueueDropIndex(from, target, after)));
  assert.deepEqual(moved(0, 2, false), ['ne:2', 'ne:1', 'ne:3', 'ne:4'], 'a 拖到 c 之前');
  assert.deepEqual(moved(0, 2, true), ['ne:2', 'ne:3', 'ne:1', 'ne:4'], 'a 拖到 c 之后');
  assert.deepEqual(moved(3, 0, false), ['ne:4', 'ne:1', 'ne:2', 'ne:3'], 'd 拖到最前');
  assert.deepEqual(moved(1, 1, true), ['ne:1', 'ne:2', 'ne:3', 'ne:4'], '原地拖 = 不变');
  assert.deepEqual(moved(0, 3, true), ['ne:2', 'ne:3', 'ne:4', 'ne:1'], '拖到队尾');
});

test('styles.css：队列行落点复用专辑墙属性行的同一套定义（未另发明一套视觉）', () => {
  const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) rules.push({ selector: m[1].trim(), body: m[2] });

  for (const [cls, shadow] of [
    ['is-drop-before', /box-shadow:\s*inset 0 2px 0 0 var\(--interactive-accent\)/],
    ['is-drop-after', /box-shadow:\s*inset 0 -2px 0 0 var\(--interactive-accent\)/],
    ['is-dragging', /opacity:\s*0?\.5/],
  ]) {
    const sel = `.vinyl-queue-item.${cls}`;
    const rule = rules.find((r) => r.selector.includes(sel));
    assert.ok(rule, `styles.css 缺少 ${sel} 规则`);
    assert.ok(
      rule.selector.includes(`.vinyl-props-row.${cls}`),
      `${sel} 应与专辑墙属性行共用同一条规则（而不是另起一套）`
    );
    assert.ok(shadow.test(rule.body), `${sel} 的落点视觉与专辑墙不一致`);
  }
});

// 极简假行：只实现 bindQueueDrag 用到的 DOM 面（够验证「事件 → 落点 → 引擎调用」这条链）
function makeRow() {
  const attrs = new Map();
  const classes = new Set();
  const listeners = {};
  return {
    attrs,
    classes,
    listeners,
    dataset: {},
    addClass: (c) => classes.add(c),
    removeClass: (...cs) => cs.forEach((c) => classes.delete(c)),
    setAttribute: (k, v) => attrs.set(k, v),
    addEventListener: (type, fn) => ((listeners[type] = listeners[type] || []).push(fn)),
    getBoundingClientRect: () => ({ top: 100, height: 20 }),
    contains: () => false,
    fire(type, ev) {
      for (const fn of listeners[type] || []) fn(ev);
    },
  };
}

const dragEvent = (clientY) => ({
  clientY,
  preventDefault() {},
  dataTransfer: { setData() {}, effectAllowed: '', dropEffect: '' },
});

test('player-view：拖到某行下半 → 引擎按「之后」落点重排（事件 → 落点换算 → moveTrack）', () => {
  const calls = [];
  const view = new viewMod.VinylPlayerView({}, {
    engine: { moveTrack: (from, to) => calls.push([from, to]) },
  });
  const rows = [0, 1, 2, 3].map(() => makeRow());
  view.queueRows = rows;
  rows.forEach((r, i) => view.bindQueueDrag(r, i));

  // 拖起第 0 行 → 落到第 2 行下半 ⇒ 结果下标 2
  rows[0].fire('dragstart', dragEvent(0));
  assert.equal(view.dragging, true, '拖拽中必须置位（click 抑制的前提）');
  assert.ok(rows[0].classes.has('is-dragging'));
  rows[2].fire('dragover', dragEvent(112)); // 行内 (100 + 20/2) 之下 = 后半
  assert.ok(rows[2].classes.has('is-drop-after'), '落点提示类应标在目标行下缘');
  assert.ok(!rows[2].classes.has('is-drop-before'));
  rows[2].fire('drop', dragEvent(112));
  assert.deepEqual(calls, [[0, 2]], '落点换算成引擎的下标');

  // 往前拖：第 3 行落到第 1 行上半 ⇒ 结果下标 1（移除被拖行后，后面的行左移一位）
  rows[3].fire('dragstart', dragEvent(0));
  rows[1].fire('dragover', dragEvent(101));
  assert.ok(rows[1].classes.has('is-drop-before'), '上半应标上缘');
  rows[1].fire('drop', dragEvent(101));
  assert.deepEqual(calls[1], [3, 1]);
});

test('player-view：拖拽收尾后 dragend 清干净落点指示，并压制随后的 click', () => {
  const calls = [];
  const view = new viewMod.VinylPlayerView({}, {
    engine: { moveTrack: (from, to) => calls.push([from, to]) },
  });
  const rows = [0, 1].map(() => makeRow());
  view.queueRows = rows;
  rows.forEach((r, i) => view.bindQueueDrag(r, i));

  assert.equal(view.isQueueClickBlocked(), false, '平时不拦点击（点行切歌照常）');
  rows[0].fire('dragstart', dragEvent(0));
  assert.equal(view.isQueueClickBlocked(), true, '拖拽中拦点击');
  rows[1].fire('dragover', dragEvent(112));
  rows[0].fire('dragend', {});
  assert.equal(view.dragging, false);
  assert.equal(view.isQueueClickBlocked(), true, '拖完那一瞬仍要拦（拖拽尾巴的 click）');
  assert.ok(!rows[1].classes.has('is-drop-after'), 'dragend 后落点指示必须清掉');

  view.clickBlockUntil = Date.now() - 1; // 窗口过去（等价于用户随后正常点击）
  assert.equal(view.isQueueClickBlocked(), false);
  assert.deepEqual(calls, [], '拖动没落到行上 → 不重排');
});

test('player-view：队列行可拖拽，且点击委托走拖拽抑制判定', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/views/player-view.ts'), 'utf8');
  assert.ok(/setAttribute\('draggable', 'true'\)/.test(src), '队列行必须可拖拽');
  for (const ev of ['dragstart', 'dragover', 'dragleave', 'drop', 'dragend']) {
    assert.ok(src.includes(`addEventListener('${ev}'`), `缺少 ${ev} 处理`);
  }
  assert.ok(
    /queueBox\.addEventListener\('click', \(ev\) => \{\s*if \(this\.isQueueClickBlocked\(\)\) return;/.test(src),
    'click 委托必须先过拖拽抑制判定，否则拖完会误切歌'
  );
  assert.ok(
    /engine\.moveTrack\(from, resolveQueueDropIndex\(from, index, after\)\)/.test(src),
    '落点必须交给引擎的 moveTrack 重排（视图不自己动队列）'
  );
});

// ============ E. 删干净：不再记住拖拽顺序 / 不再有恢复与清空队列 ============

test('main.ts：队列顺序不再落盘（拖拽只影响本次会话）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  assert.equal(/queueOrder/.test(src), false, 'data.json 里不再有 queueOrder 字段');
  assert.equal(/rememberQueueOrder|forgetQueueOrder/.test(src), false, '读写顺序的两个入口一并删除');
  assert.equal(/savedOrder|onQueueOrderChange|onQueueOrderClear/.test(src), false, '引擎的顺序钩子不再接线');
});

test('settings.ts：queueOrder 字段与归一化函数一并删除', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/settings.ts'), 'utf8');
  assert.equal(/queueOrder|normalizeQueueOrder/.test(src), false, '设置里不再留顺序字段');
});

test('player-state.ts：不再有「清空后面的专辑」与「恢复发行顺序」', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/core/player-state.ts'), 'utf8');
  assert.equal(/keepCurrentAlbum|restoreOriginalOrder|originalOrder/.test(src), false, '两个功能与它们的字段一并删除');
});

test('player-view.ts：Vinyl order 行 = 标题 + 两枚图标钮（专辑名与三个旧按键都不在这行）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/views/player-view.ts'), 'utf8');
  const block = src.slice(src.indexOf('const orderRow = '), src.indexOf('const queueBox = '));
  assert.match(block, /vinyl-queue-save/, '保存队列');
  assert.match(block, /vinyl-queue-locate/, '定位到正在播的那首');
  assert.equal(
    /vinyl-order-album/.test(block),
    false,
    '专辑名不在这行（用户 2026-09-25 定稿）：那一行宽度留给按钮，标题也不再被挤到换行'
  );
  assert.equal(/clearQueueBtn|restoreBtn|noteBtn/.test(block), false, '清空 / 恢复 / 写点什么 三个按键都不在这一行');
  assert.equal(/queueClearOthers|restoreOriginal/.test(src), false, '对应文案也不再引用');
});

test('player-view.ts：写感想按键落在每个专辑名行里（每个专辑一个）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/views/player-view.ts'), 'utf8');
  assert.match(src, /pushSegmentNote\(head, seg\)/, '每个专辑名行都要挂上这个小按键');
  assert.match(src, /pushSegmentNote\(head, currentSeg\)/, '打乱模式下给正在播的那张也挂一个');
  assert.match(
    src,
    /private pushSegmentNote\([\s\S]{0,900}?appendListeningNote\(seg\.albumPath\)/,
    '段头里的按钮把「这一段那张专辑」的路径交给感想入口（不是正在播的那张）'
  );
  assert.match(src, /player\.noteAlbum/, '按钮文案带专辑名（每个专辑一个提示）');
});
