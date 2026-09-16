// 多专辑队列（专辑队列模式）回归：分段 / 追加 / 移除整段 / 整段重排 / 播报归属。
// 引擎测试的套路同 queue-order.test.cjs：真 TS → esbuild → node:vm（假 Audio），不需要 Obsidian。
const test = require('node:test');
const assert = require('node:assert/strict');
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

const audioInstances = [];
class AudioStub {
  constructor() {
    this.src = '';
    this.volume = 1;
    this.currentTime = 0;
    this.paused = true;
    this.duration = NaN;
    this.listeners = {};
    audioInstances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener() {}
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
// trackKey 从 track 模块单独取：player-state 不转出它（取错会得到 undefined，回调里一调用就抛）
const { trackKey } = loadModule('src/core/track.ts');

const A = '专辑/A.md';
const B = '专辑/B.md';
const C = '专辑/C.md';

/** 造一条曲目：带所属专辑（真实队列里由各源构建时写入） */
const tr = (id, albumPath, title) => ({
  source: 'netease',
  id,
  albumNotePath: albumPath,
  title: title || `T${id}`,
  duration: 100,
});

function makeEngine({ autoPlay = false, random } = {}) {
  const played = [];
  const engine = new PlaybackEngine({
    app: {},
    local: {
      buildTracks: async () => [],
      clearBlobs() {},
      keysOf: () => [],
      resolveVaultUrl: () => '',
      resolveExternalUrl: () => '',
    },
    netease: {
      songUrl: async (id) => ({ url: `https://x/${id}.mp3`, level: 'higher' }),
      // enqueueAlbum 会真的构建队列：给两个最小可用的网易云歌曲对象
      album: async (id) => ({
        songs: [
          { id: id * 10 + 1, name: 'S1', ar: [{ name: 'X' }], al: { name: 'B 专辑' }, dt: 100000 },
          { id: id * 10 + 2, name: 'S2', ar: [{ name: 'X' }], al: { name: 'B 专辑' }, dt: 120000 },
        ],
      }),
    },
    qq: null,
    settings: () => ({ defaultSource: 'auto', autoPlay, quality: 'higher' }),
    // 洗牌源可注入：给固定序列时打乱结果可预测（下面的用例就靠它断言具体顺序）
    random,
    onTrackPlay: (track, albumPath, albumTitle) =>
      played.push([trackKey(track), albumPath, albumTitle]),
  });
  // 队列行/队尾行为要手动触发 audio 的 ended 事件
  return { engine, played, audio: audioInstances[audioInstances.length - 1] };
}

// 展开一层：vm 沙箱里的数组原型与测试侧不同，deepStrictEqual 会因原型不等而失败
const segShape = (engine) => [...engine.segments().map((s) => [s.albumPath, s.start, s.count, s.current])];

test('分段：同一张专辑连成一段；重复排入的同一张专辑各成一段', async () => {
  const { engine } = makeEngine();
  engine.setQueue([tr(1, A), tr(2, A)], A, 'A 专辑', 'netease');
  await engine.appendAlbum([tr(3, B), tr(4, B)], B, 'B 专辑', 'netease');
  await engine.appendAlbum([tr(5, A)], A, 'A 专辑', 'netease');

  assert.deepEqual(segShape(engine), [
    [A, 0, 2, false],
    [B, 2, 2, false],
    [A, 4, 1, false],
  ]);
  assert.equal(engine.segments()[1].albumTitle, 'B 专辑', '段标题来自追加时记下的名字');
});

test('分段：曲目没带专辑路径时归到最后加载的那张（老数据兜底）', () => {
  const { engine } = makeEngine();
  engine.setQueue([{ source: 'netease', id: 9, title: '裸曲目', duration: 1 }], A, 'A 专辑', 'netease');
  assert.deepEqual(segShape(engine), [[A, 0, 1, false]]);
});

test('追加：不动当前播放，只把新专辑接在队尾', async () => {
  const { engine } = makeEngine();
  engine.setQueue([tr(1, A), tr(2, A)], A, 'A 专辑', 'netease');
  await engine.playIndex(1);
  const before = engine.snapshot();
  await engine.appendAlbum([tr(3, B)], B, 'B 专辑', 'netease');

  const after = engine.snapshot();
  assert.equal(after.queue.length, 3, '队列变长');
  assert.equal(after.index, before.index, '当前曲目下标不变');
  assert.equal(after.current, before.current, '当前曲目还是同一首');
  assert.equal(after.status, 'playing', '播放状态不受影响');
  assert.equal(engine.segments().length, 2);
});

test('关闭队列模式：只保留当前正在播放的专辑，播放身份与状态不变', async () => {
  const { engine } = makeEngine();
  engine.setQueue([tr(1, A), tr(2, A)], A, 'A 专辑', 'netease');
  await engine.appendAlbum([tr(3, B), tr(4, B)], B, 'B 专辑', 'netease');
  await engine.appendAlbum([tr(5, C)], C, 'C 专辑', 'netease');
  await engine.playIndex(3);

  engine.retainCurrentAlbum();

  const snap = engine.snapshot();
  assert.deepEqual([...snap.queue].map((x) => x.title), ['T3', 'T4']);
  assert.equal(snap.index, 1, '当前曲在保留段内的相对位置不变');
  assert.equal(snap.current.title, 'T4');
  assert.equal(snap.status, 'playing');
  assert.deepEqual(segShape(engine), [[B, 0, 2, true]]);
});

test('追加：队列本来是空的 → 按普通换碟处理（设置允许时才自动播）', async () => {
  const idle = makeEngine();
  await idle.engine.appendAlbum([tr(1, A)], A, 'A 专辑', 'netease');
  assert.equal(idle.engine.snapshot().queue.length, 1, '空队列追加 = 成为当前专辑');
  assert.equal(idle.engine.snapshot().status, 'idle', 'autoPlay=false 时不出声');

  const auto = makeEngine({ autoPlay: true });
  await auto.engine.appendAlbum([tr(1, A)], A, 'A 专辑', 'netease');
  assert.equal(auto.engine.snapshot().status, 'playing', 'autoPlay=true 时按设置自动播');
});

test('移除整段：删别人不动播放；删到自己这段就顺延', async () => {
  const { engine } = makeEngine();
  engine.setQueue([tr(1, A), tr(2, A)], A, 'A 专辑', 'netease');
  await engine.appendAlbum([tr(3, B)], B, 'B 专辑', 'netease');
  await engine.appendAlbum([tr(4, C)], C, 'C 专辑', 'netease');
  await engine.playIndex(0); // 正在播 A 段第一首

  // 删 B 段：下标从 segments() 里取（界面也是这么用的，不手算）
  const bSeg = engine.segments().find((x) => x.albumPath === B);
  assert.ok(bSeg, 'B 段存在');
  engine.removeRange(bSeg.start, bSeg.count);
  assert.deepEqual(segShape(engine), [
    [A, 0, 2, true],
    [C, 2, 1, false],
  ]);
  assert.equal(engine.snapshot().status, 'playing', '删别人这段不影响播放');
  assert.equal(engine.snapshot().current.title, 'T1', '当前曲目没变');

  engine.removeRange(0, 2); // 删掉正在播的 A 段
  assert.deepEqual(segShape(engine), [[C, 0, 1, true]], '顺延到剩下的那段');
  assert.equal(engine.snapshot().current.title, 'T4');

  engine.removeRange(0, 1); // 删光
  const empty = engine.snapshot();
  assert.equal(empty.queue.length, 0);
  assert.equal(empty.index, -1);
  assert.equal(empty.status, 'idle');
});

test('整段重排：跨专辑拖动整段，当前曲目仍然是同一首', async () => {
  const { engine } = makeEngine();
  engine.setQueue([tr(1, A), tr(2, A)], A, 'A 专辑', 'netease');
  await engine.appendAlbum([tr(3, B)], B, 'B 专辑', 'netease');
  await engine.appendAlbum([tr(4, C)], C, 'C 专辑', 'netease');
  await engine.playIndex(2); // B 段（下标 2）

  engine.moveRange(0, 2, 3); // A 段移到 C 段之后
  assert.deepEqual(segShape(engine), [
    [B, 0, 1, true],
    [C, 1, 1, false],
    [A, 2, 2, false],
  ]);
  assert.equal(engine.snapshot().current.title, 'T3', '当前曲目身份不变（下标跟着走）');
  assert.equal(engine.snapshot().index, 0);
});

test('enqueueAlbum：构建并追加（队列空时按普通换碟；有内容时接在队尾）', async () => {
  const { engine } = makeEngine();
  const albumA = { path: A, title: 'A 专辑', neteaseId: 1 };
  const albumB = { path: B, title: 'B 专辑', neteaseId: 2 };
  // 用假的 album 构建结果：deps.netease.album 返回两首歌
  engine.setQueue([tr(1, A), tr(2, A)], A, 'A 专辑', 'netease');
  await engine.enqueueAlbum(albumB);

  const segs = engine.segments();
  assert.equal(segs.length, 2, '追加出一段新专辑');
  assert.equal(segs[1].albumTitle, 'B 专辑', '段标题来自专辑信息');
  assert.equal(engine.snapshot().queue.length > 2, true, '队尾接上了 B 的曲目');
});

test('播放模式：单次 → 循环 → 随机 循环切换（并写进快照）', () => {
  const { engine } = makeEngine();
  engine.setQueue([tr(1, A)], A, 'A 专辑', 'netease');
  assert.equal(engine.snapshot().playMode, 'once', '默认单次');
  assert.equal(engine.cyclePlayMode(), 'loop');
  assert.equal(engine.cyclePlayMode(), 'shuffle');
  assert.equal(engine.snapshot().playMode, 'shuffle');
  assert.equal(engine.cyclePlayMode(), 'once', '转一圈回到单次');
});

test('随机（单专辑）：打乱曲目顺序，当前曲目仍是同一首', async () => {
  const { engine } = makeEngine({ random: () => 0 }); // Fisher–Yates 取 j=0：结果是确定的轮转
  const tracks = [tr(1, A), tr(2, A), tr(3, A), tr(4, A)];
  engine.setQueue(tracks, A, 'A 专辑', 'netease');
  await engine.playIndex(1); // 当前是 T2
  const before = [...engine.snapshot().queue].map((x) => trackKey(x));

  engine.cyclePlayMode(); // → loop
  engine.cyclePlayMode(); // → shuffle（立刻打乱）
  const after = [...engine.snapshot().queue].map((x) => trackKey(x));
  assert.notDeepEqual(after, before, '顺序确实变了');
  assert.deepEqual([...after].sort(), [...before].sort(), '曲目一首不多一首不少');
  assert.equal(engine.snapshot().current.title, 'T2', '当前曲目没被换掉');
});

test('随机（列表模式）：整条列表的曲目一起打乱（各专辑的曲子会混在一起）', async () => {
  const { engine } = makeEngine({ random: () => 0 });
  engine.setQueue([tr(1, A), tr(2, A)], A, 'A 专辑', 'netease');
  await engine.appendAlbum([tr(3, B), tr(4, B)], B, 'B 专辑', 'netease');
  await engine.playIndex(1); // A 段第二首
  const before = [...engine.snapshot().queue].map((x) => trackKey(x));

  engine.cyclePlayMode();
  engine.cyclePlayMode(); // → shuffle
  const after = [...engine.snapshot().queue].map((x) => trackKey(x));
  assert.notDeepEqual(after, before, '顺序确实变了');
  assert.deepEqual([...after].sort(), [...before].sort(), '曲目一首不多一首不少');
  // 打乱是「曲目级」的：两张专辑的曲子会交错，不再各自成块（tr(1)/tr(2) 属 A，tr(3)/tr(4) 属 B）
  const albumOf = (key) => Math.floor((Number(key.slice(3)) - 1) / 2);
  const runs = after.map(albumOf);
  let blocks = 1;
  for (let i = 1; i < runs.length; i++) if (runs[i] !== runs[i - 1]) blocks++;
  assert.ok(blocks > 2, '不再按专辑分段排列（交错成块数应多于 2）');
  assert.equal(engine.snapshot().current.title, 'T2', '当前曲目仍是同一首');
});

test('队尾行为：单次停住 / 循环回队首 / 随机重洗后继续', async () => {
  const tick = () => new Promise((r) => setImmediate(r));

  // 单次：队尾暂停
  const once = makeEngine();
  once.engine.setQueue([tr(1, A), tr(2, A)], A, 'A 专辑', 'netease');
  await once.engine.playIndex(1); // 最后一首
  once.audio.listeners.ended[0]();
  await tick();
  assert.equal(once.engine.snapshot().status, 'paused', '单次：播完就停');

  // 循环：回队首继续
  const loop = makeEngine();
  loop.engine.setQueue([tr(1, A), tr(2, A)], A, 'A 专辑', 'netease');
  loop.engine.cyclePlayMode(); // → loop
  await loop.engine.playIndex(1);
  loop.audio.listeners.ended[0]();
  await tick();
  assert.equal(loop.engine.snapshot().status, 'playing', '循环：接着放');
  assert.equal(loop.engine.snapshot().index, 0, '回到队首');

  // 随机：重洗后继续（顺序变了、仍在播）
  const sh = makeEngine({ random: () => 0 });
  sh.engine.setQueue([tr(1, A), tr(2, A), tr(3, A)], A, 'A 专辑', 'netease');
  sh.engine.cyclePlayMode();
  sh.engine.cyclePlayMode(); // → shuffle
  const before = [...sh.engine.snapshot().queue].map((x) => trackKey(x));
  await sh.engine.playIndex(2);
  sh.audio.listeners.ended[0]();
  await tick();
  assert.equal(sh.engine.snapshot().status, 'playing', '随机：继续放');
  const after = [...sh.engine.snapshot().queue].map((x) => trackKey(x));
  assert.notDeepEqual(after, before, '队尾重洗了一次');
});

test('播报归属：跨段播放时，上报的是曲目自己那张专辑', async () => {
  const { engine, played } = makeEngine();
  engine.setQueue([tr(1, A)], A, 'A 专辑', 'netease');
  await engine.appendAlbum([tr(2, B)], B, 'B 专辑', 'netease');

  await engine.playIndex(0);
  await engine.playIndex(1);
  // 播报参数由 vm 侧的引擎回调构造 → 比 JSON 形状，别比原型
  assert.equal(
    JSON.stringify(played),
    JSON.stringify([
      ['ne:1', A, 'A 专辑'],
      ['ne:2', B, 'B 专辑'],
    ])
  );
  assert.equal(engine.snapshot().albumTitle, 'B 专辑', '快照里的专辑名也跟着当前曲目走');
  assert.equal(engine.snapshot().sourceLabel.length > 0, true, '来源标签仍可用');
});
