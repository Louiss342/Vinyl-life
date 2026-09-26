// 系统媒体控制回归：引擎快照 → MediaMetadata / 播放状态 / 动作处理器接线。
// 用假 navigator（真机上是 Electron 的 mediaSession），不需要 Obsidian 与音频设备。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/core/media-session.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian'],
}).outputFiles[0].text;

/** 造一个沙箱：可带假 mediaSession（不带 = 环境不支持，模块必须静默降级） */
function harness({ withSession = true } = {}) {
  const handlers = new Map();
  const session = {
    metadata: null,
    playbackState: 'none',
    position: 'unset',
    setActionHandler(action, fn) {
      handlers.set(action, fn);
    },
    setPositionState(state) {
      this.position = state;
    },
  };
  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: () => ({}),
    console,
    window: { MediaMetadata: class { constructor(init) { Object.assign(this, init); } } },
  };
  if (withSession) sandbox.navigator = { mediaSession: session };
  vm.runInNewContext(source, sandbox);
  return { mod: mod.exports, session, handlers };
}

const snap = (over = {}) => ({
  status: 'playing',
  queue: [],
  index: 0,
  current: { key: 'k1', title: '无地自容', cover: 'app://cover.png' },
  currentTime: 12,
  duration: 240,
  volume: 0.6,
  albumTitle: '黑豹乐队',
  albumNotePath: 'Vinyl Life/Vinyl Note/黑豹乐队.md',
  ...over,
});

test('media-session：快照 → 元数据（曲名 / 专辑 / 封面）', () => {
  const h = harness();
  const meta = h.mod.metadataOf(snap());
  assert.equal(meta.title, '无地自容');
  assert.equal(meta.album, '黑豹乐队');
  // vm 沙箱里的对象与测试侧原型不同，deepStrictEqual 会判不等 → 比 JSON 形状
  assert.equal(JSON.stringify(meta.artwork), JSON.stringify([{ src: 'app://cover.png' }]));
  // 歌手：Track 上有 artist 就用它 —— 系统面板上「歌手 = 专辑名」等于少显示一半信息
  assert.equal(
    h.mod.metadataOf(
      snap({
        current: { key: 'k1', title: '无地自容', artist: '黑豹乐队' },
        albumTitle: '黑豹乐队 (1991)',
      })
    ).artist,
    '黑豹乐队',
    '有 artist 时歌手必须是它，不是专辑名'
  );
  assert.equal(meta.artist, '黑豹乐队', '没有 artist 才退回专辑名');
  assert.equal(h.mod.metadataOf(snap({ current: undefined })), null, '没有当前曲目 → 清空');
  assert.equal(
    h.mod.metadataOf(snap({ current: { key: 'k', title: 'A' } })).artwork.length,
    0,
    '没有封面时不编造 artwork'
  );
});

test('media-session：进度只在时长可用时上报（否则 setPositionState 会抛）', () => {
  const h = harness();
  const pos = h.mod.positionStateOf(snap());
  assert.equal(pos.duration, 240);
  assert.equal(pos.position, 12);
  assert.equal(pos.playbackRate, 1);
  assert.equal(h.mod.positionStateOf(snap({ duration: 0 })), null, '时长未知 → 不上报');
  assert.equal(h.mod.positionStateOf(snap({ current: undefined })), null, '没有曲目 → 不上报');
  assert.equal(
    h.mod.positionStateOf(snap({ currentTime: 999 })).position,
    240,
    '位置越界要夹回时长内（系统面板不接受超出）'
  );
});

test('media-session：同步元数据、播放状态与进度，并登记媒体键处理器', () => {
  const h = harness();
  const calls = [];
  const hooks = {
    play: () => calls.push('play'),
    pause: () => calls.push('pause'),
    next: () => calls.push('next'),
    prev: () => calls.push('prev'),
    seek: (ratio) => calls.push('seek:' + ratio),
  };

  h.mod.syncMediaSession(snap(), hooks);
  assert.equal(h.session.metadata.title, '无地自容');
  assert.equal(h.session.playbackState, 'playing');
  assert.equal(h.session.position.duration, 240);
  assert.equal(h.session.position.position, 12);

  // 暂停 / 清空
  h.mod.syncMediaSession(snap({ status: 'paused' }), hooks);
  assert.equal(h.session.playbackState, 'paused');
  h.mod.syncMediaSession(snap({ current: undefined }), hooks);
  assert.equal(h.session.playbackState, 'none');
  assert.equal(h.session.metadata, null);

  // 媒体键 → 引擎（处理器只登记一次，重复同步不会重复登记）
  assert.deepEqual([...h.handlers.keys()].sort(), ['nexttrack', 'pause', 'play', 'previoustrack', 'seekto']);
  h.handlers.get('play')();
  h.handlers.get('pause')();
  h.handlers.get('nexttrack')();
  h.handlers.get('previoustrack')();
  h.handlers.get('seekto')({ seekTime: 120 });
  assert.deepEqual(calls, ['play', 'pause', 'next', 'prev', 'seek:0.5'], 'seekto 按时长换算成比例');
});

test('media-session：环境不支持时静默降级（不抛）', () => {
  const h = harness({ withSession: false });
  const hooks = { play() {}, pause() {}, next() {}, prev() {}, seek() {} };
  h.mod.syncMediaSession(snap(), hooks);
  assert.equal(h.mod.metadataOf(snap()).title, '无地自容', '纯函数部分照常可用');
});

test('media-session：动作不被支持时不炸（Electron 常见部分实现）', () => {
  const h = harness();
  h.session.setActionHandler = () => {
    throw new Error('not supported');
  };
  const hooks = { play() {}, pause() {}, next() {}, prev() {}, seek() {} };
  h.mod.syncMediaSession(snap(), hooks);
  h.mod.syncMediaSession(snap({ status: 'paused' }), hooks);
  assert.equal(h.session.playbackState, 'paused', '处理器登记失败不影响状态同步');
});
