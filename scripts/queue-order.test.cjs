// 播放队列拖拽排序：
//   A 部分纯函数：reorderTracks（含越界）/ applyTrackOrder（缺失键、新增曲目排后面保序）；
//   B 部分引擎：moveTrack 后「正在播的那首仍是当前曲目」+ 顺序持久化钩子 + setQueue 套用存过的顺序；
//   C 部分设置归一化：normalizeQueueOrder 丢弃脏数据 + 默认值不被就地改写；
//   D 部分视图：落点换算（行前/后 → 结果下标）+ 落点视觉复用专辑墙的同一套 CSS；
//   E 部分恢复发行顺序：restoreOriginalOrder 就地排回原始顺序（不重扫）+ 当前曲目保位 + 清条目钩子。
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
const vaultTrack = (p, title = 'L') => ({ source: 'local-vault', file: { path: p }, title, duration: 1 });

// ============ A. 纯函数（track.ts） ============

const trackMod = loadModule('src/core/track.ts');
const { reorderTracks, applyTrackOrder, trackKey } = trackMod;

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

test('applyTrackOrder：按 trackKey 重排；顺序里已不存在的键直接跳过', () => {
  const tracks = [ne(1), ne(2), ne(3)];
  assert.deepEqual(keys(applyTrackOrder(tracks, ['ne:3', 'ne:1', 'ne:2'])), ['ne:3', 'ne:1', 'ne:2']);
  assert.deepEqual(
    keys(applyTrackOrder(tracks, ['ne:3', 'ne:99', 'ne:1'])),
    ['ne:3', 'ne:1', 'ne:2'],
    '已删除的 ne:99 跳过，剩下的按原相对顺序跟上'
  );
  assert.deepEqual(keys(tracks), ['ne:1', 'ne:2', 'ne:3'], '原数组不得被改动');
});

test('applyTrackOrder：不在顺序里的（新增 / 改名 / 换源）按原相对顺序排在后面，一个都不能丢', () => {
  const tracks = [ne(1), ne(2), ne(3), ne(4)];
  assert.deepEqual(
    keys(applyTrackOrder(tracks, ['ne:3', 'ne:1'])),
    ['ne:3', 'ne:1', 'ne:2', 'ne:4'],
    'ne:2 / ne:4 补在后面且保持原相对顺序'
  );
  // 改名 / 换源：旧键失效、新键补在后面
  const renamed = [ne(1), vaultTrack('x/a.mp3')];
  assert.deepEqual(
    keys(applyTrackOrder(renamed, ['vault:x/old.mp3', 'ne:1'])),
    ['ne:1', 'vault:x/a.mp3']
  );
  assert.equal(applyTrackOrder(renamed, ['vault:x/old.mp3', 'ne:1']).length, 2, '曲目数量不得变化');
});

test('applyTrackOrder：空顺序 / 非数组 → 原顺序副本', () => {
  const tracks = [ne(1), ne(2)];
  for (const order of [[], null, undefined, 'ne:1', 42]) {
    const out = applyTrackOrder(tracks, order);
    assert.deepEqual(keys(out), ['ne:1', 'ne:2']);
    assert.notEqual(out, tracks, '必须返回新数组');
  }
  assert.deepEqual(keys(applyTrackOrder([], ['ne:1'])), [], '空队列不崩');
});

test('applyTrackOrder：顺序里的键重复也只取一次（不复制曲目）', () => {
  const tracks = [ne(1), ne(2)];
  const out = applyTrackOrder(tracks, ['ne:2', 'ne:2', 'ne:1']);
  assert.deepEqual(keys(out), ['ne:2', 'ne:1']);
  assert.equal(out.length, tracks.length);
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

function makeEngine({ saved, withHooks = true, gate } = {}) {
  const orderEvents = [];
  const clearEvents = [];
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
  if (withHooks) {
    deps.savedOrder = (p) => saved?.[p];
    deps.onQueueOrderChange = (p, list) => orderEvents.push([p, Array.from(list)]);
    deps.onQueueOrderClear = (p) => clearEvents.push(p);
  }
  const engine = new PlaybackEngine(deps);
  return { engine, orderEvents, clearEvents, audio: audioInstances[audioInstances.length - 1] };
}

function setTracks(engine, tracks, albumPath = ALBUM) {
  engine.setQueue(tracks, albumPath, 'Abbey Road', 'netease');
}

test('setQueue：存过顺序就套用（含新增曲目补后面）；没存过按原顺序', () => {
  const a = makeEngine({ saved: { [ALBUM]: ['ne:3', 'ne:1'] } });
  setTracks(a.engine, [ne(1), ne(2), ne(3)]);
  assert.deepEqual(keys(a.engine.snapshot().queue), ['ne:3', 'ne:1', 'ne:2'], '存过的顺序生效');
  assert.equal(a.engine.snapshot().index, -1, '换队列后不自动指向某首');

  const b = makeEngine({ saved: {} });
  setTracks(b.engine, [ne(1), ne(2), ne(3)]);
  assert.deepEqual(keys(b.engine.snapshot().queue), ['ne:1', 'ne:2', 'ne:3'], '没存过 → 原顺序');

  const c = makeEngine({ saved: { [ALBUM]: [] } });
  setTracks(c.engine, [ne(1), ne(2)]);
  assert.deepEqual(keys(c.engine.snapshot().queue), ['ne:1', 'ne:2'], '空顺序视为没存过');

  const d = makeEngine({ saved: { [ALBUM]: ['ne:3', 'ne:1'] } });
  setTracks(d.engine, [ne(1), ne(2), ne(3)], '专辑/别的.md');
  assert.deepEqual(keys(d.engine.snapshot().queue), ['ne:1', 'ne:2', 'ne:3'], '每张专辑各记各的');
});

test('moveTrack：重排后正在播的那首仍是当前曲目（index 跟着它走，音频不重载）', async () => {
  const { engine, audio } = makeEngine({ saved: {} });
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
  const { engine } = makeEngine({ saved: {} });
  setTracks(engine, [ne(1), ne(2), ne(3)]);
  await engine.playIndex(0);
  engine.moveTrack(2, 1); // [1,2,3] → [1,3,2]
  await engine.next();
  assert.deepEqual(keys(engine.snapshot().queue), ['ne:1', 'ne:3', 'ne:2']);
  assert.equal(trackKey(engine.snapshot().current), 'ne:3', '下一首应取新顺序里的后一首');
  assert.equal(engine.snapshot().index, 1);
});

test('moveTrack：把新顺序（完整 trackKey 列表）交给持久化钩子', async () => {
  const { engine, orderEvents } = makeEngine({ saved: {} });
  setTracks(engine, [ne(1), ne(2), ne(3)]);
  await engine.playIndex(0);
  engine.moveTrack(0, 1);
  assert.equal(orderEvents.length, 1, '每次重排恰好通知一次');
  assert.equal(orderEvents[0][0], ALBUM, '带上专辑笔记路径');
  assert.deepEqual(orderEvents[0][1], ['ne:2', 'ne:1', 'ne:3'], '顺序 = 重排后的完整 key 列表');

  engine.moveTrack(1, 0); // 拖回去
  assert.deepEqual(orderEvents[1][1], ['ne:1', 'ne:2', 'ne:3']);
});

test('moveTrack：越界 / 原地拖拽是空操作（不改队列、不发持久化事件）', async () => {
  const { engine, orderEvents } = makeEngine({ saved: {} });
  setTracks(engine, [ne(1), ne(2)]);
  await engine.playIndex(0);
  engine.moveTrack(0, 0);
  engine.moveTrack(-1, 1);
  engine.moveTrack(0, 2);
  engine.moveTrack(2, 0);
  assert.deepEqual(keys(engine.snapshot().queue), ['ne:1', 'ne:2']);
  assert.equal(trackKey(engine.snapshot().current), 'ne:1');
  assert.deepEqual(orderEvents, [], '空操作不该写盘');
});

test('moveTrack：拖拽撞上「正在加载」不打断加载（当前曲判定按曲目而非下标）', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { engine, audio } = makeEngine({ saved: {}, gate });
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
  const { engine, audio } = makeEngine({ saved: {}, gate });
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
  const { engine } = makeEngine({ saved: {} });
  setTracks(engine, [ne(1), ne(2), ne(3)]);
  engine.moveTrack(0, 2);
  const snap = engine.snapshot();
  assert.deepEqual(keys(snap.queue), ['ne:2', 'ne:3', 'ne:1']);
  assert.equal(snap.index, -1, '没在播就还是没在播');
  assert.equal(snap.current, undefined);
});

test('引擎：不接线 savedOrder / onQueueOrderChange 也能正常重排（既有调用方零改动）', async () => {
  const { engine } = makeEngine({ withHooks: false });
  setTracks(engine, [ne(1), ne(2), ne(3)]);
  await engine.playIndex(1);
  engine.moveTrack(0, 2); // 不该抛
  const snap = engine.snapshot();
  assert.deepEqual(keys(snap.queue), ['ne:2', 'ne:3', 'ne:1']);
  assert.equal(trackKey(snap.current), 'ne:2', '没有钩子时同样保住当前曲目');
  assert.equal(snap.index, 0);
});

// ============ C. 设置归一化（settings.ts） ============

const settingsMod = loadModule('src/settings.ts');
const { normalizeQueueOrder, normalizeLastPlayback, normalizeVolume, DEFAULT_SETTINGS } = settingsMod;

test('resolveSegmentDropIndex：整段拖拽落点（块先摘掉，下标按摘后算）', () => {
  const { resolveSegmentDropIndex } = loadModule('src/views/player-view.ts', {
    document: { createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {} }) },
    Notice: class {},
  });
  // A(0,2) B(2,1) C(3,1)：把 A 拖到 C 之后 → 摘掉 A 后是 [B,C]，插到 C 后 = 2
  assert.equal(resolveSegmentDropIndex(0, 2, 3, 1, true), 2);
  // 把 A 拖到 B 之前 → 摘掉 A 后是 [B,C]，插到 B 前 = 0
  assert.equal(resolveSegmentDropIndex(0, 2, 2, 1, false), 0);
  // 把 C 拖到 A 之前 → 摘掉 C 后是 [A,B]，插到 A 前 = 0
  assert.equal(resolveSegmentDropIndex(3, 1, 0, 2, false), 0);
  // 把 B 拖到 A 之后 → 摘掉 B 后是 [A,C]，插到 A 后 = 2
  assert.equal(resolveSegmentDropIndex(2, 1, 0, 2, true), 2);
});

test('专辑队列模式接线：顶部开关在「选择专辑」左边 / 分段渲染 / 整段操作都在', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/views/player-view.ts'), 'utf8');
  const headerBlock = src.slice(src.indexOf('const header = '), src.indexOf('const playModeBtn'));
  assert.match(headerBlock, /queueModeBtn/, '队列模式开关要建在「选择专辑」之前（顶部那一行的顺序就是创建顺序）');
  // 追加发生在专辑墙的点击路径上（播放器只负责显示与整段操作）
  const shelf = require('fs').readFileSync(require('path').join(__dirname, '../src/views/shelf-view.ts'), 'utf8');
  assert.match(shelf, /settings\.queueMode[\s\S]{0,200}?enqueueAlbum\(/, '队列模式下点专辑走引擎的 enqueueAlbum');
  assert.match(src, /engine\.removeRange\(seg\.start, seg\.count\)/, '整段移除按段的下标与长度');
  assert.match(src, /engine\.moveRange\(/, '跨专辑排序走 moveRange');
  assert.match(src, /engine\.keepCurrentAlbum\(\)/, '关开关 / 清空走 keepCurrentAlbum');
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

test('settings：queueOrder 默认 {}，且归一化结果不与默认值共享引用', () => {
  assert.deepEqual(plain(DEFAULT_SETTINGS.queueOrder), {});
  const out = normalizeQueueOrder(undefined);
  out['专辑/x.md'] = ['ne:1'];
  assert.deepEqual(plain(DEFAULT_SETTINGS.queueOrder), {}, '就地改写归一化结果不得污染默认值');
});

test('normalizeQueueOrder：非对象 / 非字符串数组 / 空数组一律丢弃', () => {
  assert.deepEqual(plain(normalizeQueueOrder(null)), {});
  assert.deepEqual(plain(normalizeQueueOrder('vault:a')), {});
  assert.deepEqual(plain(normalizeQueueOrder(['vault:a'])), {}, '数组不是「路径 → 顺序」的容器');
  assert.deepEqual(plain(normalizeQueueOrder({ a: 'ne:1', b: 42 })), {}, '值不是数组 → 丢弃');
  assert.deepEqual(plain(normalizeQueueOrder({ 'a.md': [] })), {}, '空顺序 = 没存过，不留空壳');
  assert.deepEqual(
    plain(normalizeQueueOrder({ 'a.md': ['ne:1', 7, null, '', 'ne:2'] })),
    { 'a.md': ['ne:1', 'ne:2'] },
    '数组里的非字符串项剔除'
  );
  assert.deepEqual(plain(normalizeQueueOrder({ 'a.md': ['ne:1'], '': ['ne:2'] })), {
    'a.md': ['ne:1'],
  });
});

test('normalizeQueueOrder：合法数据原样保留（多专辑各记各的），且内外层都是新对象', () => {
  const raw = { '专辑/A.md': ['ne:2', 'ne:1'], '专辑/B.md': ['vault:Vinyl Life/audio/b.mp3'] };
  const out = normalizeQueueOrder(raw);
  assert.deepEqual(plain(out), raw);
  assert.notEqual(out, raw, '返回新对象');
  assert.notEqual(out['专辑/A.md'], raw['专辑/A.md'], '内层数组也要复制');
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

test('main.ts：接线（loadSettings 归一化 / 读存过的顺序 / 拖拽后走已有防抖落盘）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  assert.ok(
    /this\.settings\.queueOrder = normalizeQueueOrder\(data\?\.queueOrder\)/.test(src),
    'loadSettings 必须归一化 queueOrder（data.json 可能被手改）'
  );
  assert.ok(
    /savedOrder: \(albumPath\) => this\.settings\.queueOrder\[albumPath\]/.test(src),
    '读顺序的钩子必须接到设置里'
  );
  assert.ok(
    /onQueueOrderChange: \(albumPath, keys\) => this\.rememberQueueOrder\(albumPath, keys\)/.test(src),
    '拖拽后的写回钩子必须接线'
  );
  assert.ok(
    /rememberQueueOrder\(albumPath: string, orderKeys: string\[\]\)[\s\S]{0,400}?scheduleStatsSave\(\)/.test(src),
    '写回后必须复用已有的 5 秒防抖落盘（不另起定时器）'
  );
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

// ============ E. 恢复专辑原有顺序 ============

test('restoreOriginalOrder：套用自定义顺序后能排回原始顺序，当前曲目仍是当前曲目', async () => {
  const { engine, clearEvents, audio } = makeEngine({ saved: { [ALBUM]: ['ne:3', 'ne:1'] } });
  setTracks(engine, [ne(1), ne(2), ne(3)]);
  assert.deepEqual(keys(engine.snapshot().queue), ['ne:3', 'ne:1', 'ne:2'], '先套用存过的顺序');
  await engine.playIndex(0); // 正在播 ne:3
  const srcBefore = audio.src;

  assert.equal(engine.restoreOriginalOrder(), true, '确实动过队列');
  const snap = engine.snapshot();
  assert.deepEqual(keys(snap.queue), ['ne:1', 'ne:2', 'ne:3'], '就地排回原始顺序（不重新联网）');
  assert.equal(trackKey(snap.current), 'ne:3', '正在播的那首仍是当前曲目');
  assert.equal(snap.index, 2, 'index 指向它的新位置');
  assert.equal(audio.src, srcBefore, '音频地址不重解析（播放不中断）');
  assert.equal(audio.paused, false, '恢复顺序不该停播');
  assert.deepEqual(clearEvents, [ALBUM], '把「清掉该专辑自定义顺序」交给持久化钩子');
  assert.deepEqual(Array.from(engine.snapshot().queue, (t) => trackKey(t)), [
    'ne:1',
    'ne:2',
    'ne:3',
  ]);

  assert.equal(engine.restoreOriginalOrder(), false, '已是原始顺序 → 空操作');
  assert.deepEqual(clearEvents, [ALBUM], '空操作不重复通知，也不动队列');
  assert.equal(audio.src, srcBefore);
});

test('restoreOriginalOrder：原始顺序不受拖拽影响（拖完再恢复仍回到最初的顺序）', async () => {
  const { engine, clearEvents } = makeEngine({ saved: {} });
  setTracks(engine, [ne(1), ne(2), ne(3), ne(4)]);
  await engine.playIndex(3); // 正在播 ne:4
  engine.moveTrack(3, 0); // [4,1,2,3]
  engine.moveTrack(1, 3); // [4,2,3,1]
  assert.deepEqual(keys(engine.snapshot().queue), ['ne:4', 'ne:2', 'ne:3', 'ne:1'], '拖过两轮');

  assert.equal(engine.restoreOriginalOrder(), true);
  const snap = engine.snapshot();
  assert.deepEqual(keys(snap.queue), ['ne:1', 'ne:2', 'ne:3', 'ne:4'], '回到最初的顺序');
  assert.equal(trackKey(snap.current), 'ne:4', '当前曲目还是拖拽前那首');
  assert.equal(snap.index, 3, 'index 跟着它走');
  assert.deepEqual(clearEvents, [ALBUM]);
});

test('restoreOriginalOrder：没有自定义顺序时不报错（顺序本就是原始的，队列不变）', () => {
  const { engine, clearEvents } = makeEngine({ saved: {} });
  setTracks(engine, [ne(1), ne(2), ne(3)]);
  assert.doesNotThrow(() => engine.restoreOriginalOrder());
  assert.deepEqual(keys(engine.snapshot().queue), ['ne:1', 'ne:2', 'ne:3'], '队列保持不变');
  assert.equal(engine.snapshot().index, -1, '没在播就还是没在播');
  assert.deepEqual(clearEvents, [], '顺序没变 → 不惊动持久化层');

  // 钩子未接线（既有调用方）同样不崩
  const bare = makeEngine({ withHooks: false });
  setTracks(bare.engine, [ne(1), ne(2)]);
  assert.doesNotThrow(() => bare.engine.restoreOriginalOrder());
});

test('restoreOriginalOrder：换专辑后按新专辑的原始顺序恢复（原始顺序随 setQueue 换）', async () => {
  const other = '专辑/别的.md';
  const { engine, clearEvents } = makeEngine({
    saved: { [ALBUM]: ['ne:2', 'ne:1'], [other]: ['ne:9', 'ne:8'] },
  });
  setTracks(engine, [ne(1), ne(2)]);
  setTracks(engine, [ne(7), ne(8), ne(9)], other);
  assert.deepEqual(keys(engine.snapshot().queue), ['ne:9', 'ne:8', 'ne:7'], '第二张按它自己的顺序');
  assert.equal(engine.restoreOriginalOrder(), true);
  assert.deepEqual(keys(engine.snapshot().queue), ['ne:7', 'ne:8', 'ne:9'], '回到第二张的原始顺序');
  assert.deepEqual(clearEvents, [other], '清的是当前这张专辑的条目');
});

test('main.ts：恢复发行顺序的接线（删设置里的条目 + 复用已有防抖落盘）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  assert.ok(
    /onQueueOrderClear: \(albumPath\) => this\.forgetQueueOrder\(albumPath\)/.test(src),
    '「恢复发行顺序」后的清条目钩子必须接线'
  );
  assert.ok(
    /forgetQueueOrder\(albumPath: string\)[\s\S]{0,400}?scheduleStatsSave\(\)/.test(src),
    '删条目后必须复用已有的 5 秒防抖落盘（不另起定时器）'
  );
});

test('player-view：恢复按钮常显、走引擎恢复，本地专辑只提示', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/views/player-view.ts'), 'utf8');
  assert.ok(/setIcon\(restoreBtn, 'undo-2'\)/.test(src), '图标用 undo-2');
  assert.ok(
    /restoreBtn\.setAttribute\('aria-label', t\('player\.restoreOriginal'\)\)/.test(src),
    '按钮要有 aria-label 提示（只此一处，不再另设 title——两个都设会叠成两个气泡）'
  );
  assert.ok(
    /const restoreBtn = orderRow\.createEl\('button', \{ cls: 'vinyl-btn vinyl-btn-small' \}\)/.test(
      src
    ),
    '恢复按钮复用 Vinyl order 行已有的按钮样式'
  );
  assert.ok(
    /snap\.current\?\.source \|\| snap\.queue\[0\]\?\.source/.test(src),
    '按队列来源判断（当前曲目，未开播时退到队首）'
  );
  assert.ok(
    /if \(source === 'local-vault' \|\| source === 'local-external'\) \{\s*notice\(t\('player\.restoreLocalUnsupported'\)\);\s*return;/.test(
      src
    ),
    '本地专辑只提示、不做任何事'
  );
  assert.ok(
    /private restoreOrder\(\)[\s\S]{0,600}?engine\.restoreOriginalOrder\(\)[\s\S]{0,200}?notice\(t\('player\.restoreDone'\)\)/.test(
      src
    ),
    '非本地来源才调引擎恢复并提示已恢复'
  );
});
