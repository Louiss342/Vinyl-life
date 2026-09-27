// 播放引擎回归：
//   1) 换专辑竞态：快速连点两张专辑时，后发起的加载必须胜出（先发起的慢请求结果丢弃）；
//   2) 换专辑即停旧曲：setQueue 必须卸载上一张音源（关闭「自动播放」时不残留旧曲）；
//   3) 错误兜底竞态：切歌后旧曲的兜底结果不得覆盖当前曲。
const test = require('node:test');
const assert = require('node:assert/strict');
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
      if (name === 'obsidian') {
        return {
          App: class {},
          TFile: class {},
          TFolder: class {},
          Notice: class {},
          Plugin: class {},
          normalizePath: (p) => p,
        };
      }
      if (name === 'fs') return { existsSync: () => false, statSync: () => ({}), readdirSync: () => [] };
      if (name === 'path') return nodePath;
      throw new Error('Unexpected runtime import: ' + name);
    },
    fetch: async () => {
      throw new Error('no network in tests');
    },
    AbortSignal,
    URL,
    URLSearchParams,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    ...globals,
  });
  return mod.exports;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  emit(type) {
    for (const fn of this.listeners[type] || []) fn();
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

const { PlaybackEngine } = loadModule('src/core/player-state.ts', {
  Audio: AudioStub,
  // 暂停走马达斜坡，斜坡用 window.setInterval 推进曲线。下面那几条只关心「状态与元素」，
  // 给一对不排帧的桩就够（马达曲线本身另有 motor-engine / motor-view 两组用例盯着）。
  window: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
});

function albumOf(id, title, extra = {}) {
  const notePath = `06-专辑墙/专辑/${title}.md`;
  return {
    path: notePath,
    title,
    neteaseId: id,
    sourcePref: 'auto',
    audioRefs: [],
    file: { path: notePath },
    ...extra,
  };
}

function makeEngine({ neteaseAlbum, localOverrides = {}, autoPlay = false } = {}) {
  const local = {
    buildTracks: async () => [],
    clearBlobs() {},
    keysOf: () => [],
    resolveVaultUrl: (f) => `vault://${f.path}`,
    resolveExternalUrl: (p) => `ext://${p}`,
    resolveVaultBlobUrl: async () => 'blob://retry',
    ...localOverrides,
  };
  const engine = new PlaybackEngine({
    app: {},
    local,
    netease: { album: neteaseAlbum },
    qq: null,
    settings: () => ({ defaultSource: 'auto', autoPlay, quality: 'higher' }),
  });
  return { engine, local, audio: audioInstances[audioInstances.length - 1] };
}

test('换专辑竞态：先发起的慢请求不得覆盖后发起的快请求', async () => {
  const { engine } = makeEngine({
    neteaseAlbum: async (id) => {
      await sleep(id === 1 ? 80 : 5);
      return {
        songs: [{ id: id * 10, name: `S${id}`, ar: [{ name: 'Ar' }], al: { name: 'Al', picUrl: '' }, dt: 1000 }],
      };
    },
  });
  const pA = engine.loadAlbum(albumOf(1, 'Slow'));
  const pB = engine.loadAlbum(albumOf(2, 'Fast'));
  await Promise.all([pA, pB]);
  const snap = engine.snapshot();
  assert.equal(snap.albumTitle, 'Fast', '后发起的加载必须胜出');
  assert.deepEqual(
    Array.from(snap.queue, (t) => t.id),
    [20],
    '队列应为后发起那张专辑'
  );
});

test('换专辑即停旧曲：setQueue 卸载上一张音源（关闭自动播放时不残留）', async () => {
  const { engine, audio } = makeEngine({
    neteaseAlbum: async (id) => ({
      songs: [{ id: id * 10, name: `S${id}`, ar: [], al: {}, dt: 1000 }],
    }),
  });
  await engine.loadAlbum(albumOf(1, 'A'));
  audio.src = 'https://old/track.mp3';
  audio.paused = false;
  await engine.loadAlbum(albumOf(2, 'B'));
  assert.equal(audio.src, '', '换专辑应卸载旧音源');
  assert.equal(audio.paused, true, '换专辑应停掉旧曲');
});

test('错误兜底竞态：切歌后旧曲的兜底结果不覆盖当前曲', async () => {
  let releaseBlob;
  const gate = new Promise((r) => (releaseBlob = r));
  const { engine, audio } = makeEngine({
    neteaseAlbum: async () => {
      throw new Error('unused');
    },
    localOverrides: {
      buildTracks: async (album) =>
        album.title === 'A'
          ? [
              { source: 'local-vault', file: { path: 'x/a1.mp3' }, title: 'a1', duration: 1 },
              { source: 'local-vault', file: { path: 'x/a2.mp3' }, title: 'a2', duration: 1 },
            ]
          : [{ source: 'local-vault', file: { path: 'x/b1.mp3' }, title: 'b1', duration: 1 }],
      resolveVaultBlobUrl: async () => {
        await gate;
        return 'blob://late';
      },
    },
  });
  await engine.loadAlbum(albumOf(1, 'A'));
  await engine.playIndex(0);
  audio.src = 'vault://x/a1.mp3';
  audio.emit('error'); // a1 出错 → 进入 Blob 兜底（被 gate 挂住）
  await sleep(0);
  await engine.playIndex(1); // 用户切到 a2
  audio.src = 'vault://x/a2.mp3';
  releaseBlob();
  await sleep(10);
  assert.equal(audio.src, 'vault://x/a2.mp3', '旧曲兜底不得覆盖当前曲');
});

// ============ 点队列行：加载窗口里的重入与「回到同一首」 ============

/** 三首歌的专辑桩 + 可控取址：netease 的地址来自 deps.netease.songUrl */
function songsFixture(ids = [10, 11, 12]) {
  return async () => ({
    songs: ids.map((id) => ({ id, name: `S${id}`, ar: [], al: {}, dt: 1000 })),
  });
}
const urlOk = (id) => ({ url: `https://cdn/${id}.mp3`, level: '' });

test('点队列行：取址还没回来时再点同一行，不再重入（不然会误报「无法播放」并跳歌）', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const played = [];
  let urlCalls = 0;
  const { engine } = makeEngine({ neteaseAlbum: songsFixture([10, 11]) });
  engine.deps.netease.songUrl = async (id) => {
    urlCalls++;
    if (id === 10) await gate; // 第一首卡在取址：状态停在 loading
    return urlOk(id);
  };
  engine.deps.onTrackPlay = (t) => played.push(t.id);
  await engine.loadAlbum(albumOf(1, 'A'));

  const first = engine.playIndex(0);
  assert.equal(engine.snapshot().status, 'loading', '取址期间就是 loading');
  await engine.playIndex(0); // 用户觉得没反应，又点了一下同一行（或双击）
  assert.equal(urlCalls, 1, '第二次点击不该再发一次取址请求（重写 src 会把上一次的 play 打断）');
  release();
  await first;
  assert.equal(engine.snapshot().status, 'playing');
  assert.equal(engine.snapshot().index, 0, '还在这一首：不许跳走');
  assert.deepEqual(played, [10], '播放事件只记一次');
});

test('A→B→A 快速来回点：只认最后那一次，不重复记播放事件', async () => {
  const played = [];
  const gates = new Map();
  const { engine } = makeEngine({ neteaseAlbum: songsFixture([10, 11]) });
  engine.deps.netease.songUrl = async (id) => {
    const gate = gates.get(id);
    if (gate) await gate;
    return urlOk(id);
  };
  engine.deps.onTrackPlay = (t) => played.push(t.id);
  await engine.loadAlbum(albumOf(1, 'A'));

  let releaseFirst;
  gates.set(10, new Promise((r) => (releaseFirst = r)));
  const firstA = engine.playIndex(0); // A：取址卡住
  gates.delete(10);
  await engine.playIndex(1); // → B
  const secondA = engine.playIndex(0); // → 又回 A（这一次取址是快的）
  releaseFirst(); // 第一次的 A 这时才回来
  await Promise.all([firstA, secondA]);

  assert.deepEqual(played, [11, 10], '只有 B 与最后那次 A 记了播放事件');
  assert.equal(engine.snapshot().index, 0, '停在 A');
  assert.equal(engine.snapshot().status, 'playing');
});

// ============ 移除一段：暂停中不许自己开播 ============

test('暂停中删掉当前这首：只把新的一首挂上元素，不自己播', async () => {
  const played = [];
  const { engine, audio } = makeEngine({ neteaseAlbum: songsFixture([10, 11]) });
  engine.deps.netease.songUrl = async (id) => urlOk(id);
  engine.deps.onTrackPlay = (t) => played.push(t.id);
  await engine.loadAlbum(albumOf(1, 'A'));
  await engine.playIndex(0);
  engine.pause();
  assert.equal(engine.snapshot().status, 'paused');

  engine.removeRange(0, 1); // 把正在播的这首从队列里拿掉
  await sleep(5); // 顺延那一趟是 void 出去的：等它落地
  assert.equal(engine.snapshot().status, 'paused', '用户没按播放：引擎不该替他按');
  assert.equal(audio.paused, true, '不许出声');
  assert.equal(engine.snapshot().index, 0, '顺延到新的第一首');
  assert.deepEqual(played, [10], '没有新的播放事件');
});

test('播放中删掉当前这首：照旧顺延着放下去（这条行为不能丢）', async () => {
  const { engine, audio } = makeEngine({ neteaseAlbum: songsFixture([10, 11]) });
  engine.deps.netease.songUrl = async (id) => urlOk(id);
  await engine.loadAlbum(albumOf(1, 'A'));
  await engine.playIndex(0);

  engine.removeRange(0, 1);
  await sleep(5); // 同上一例：顺延的加载是异步的
  assert.equal(engine.snapshot().index, 0);
  assert.equal(engine.snapshot().status, 'playing', '在播的时候删掉：接着放下一首');
  assert.equal(audio.paused, false);
  assert.match(audio.src, /11\.mp3$/, '元素挂的是新那一首');
});

test('Blob 回收：留的是**剩下**的那批（移除的那张不该被留下、正在播的那张不该被回收）', async () => {
  const cleared = [];
  const { engine } = makeEngine({
    neteaseAlbum: songsFixture([10, 11, 12]),
    localOverrides: {
      keysOf: (tracks) => new Set(tracks.map((t) => `${t.source}:${t.id}`)),
      clearBlobs: (keep) => cleared.push(Array.from(keep).sort()),
    },
  });
  engine.deps.netease.songUrl = async (id) => urlOk(id);
  await engine.loadAlbum(albumOf(1, 'A'));
  await engine.playIndex(0);

  engine.removeRange(1, 1); // 移除中间那首（不是当前曲）
  assert.deepEqual(cleared[cleared.length - 1], ['netease:10', 'netease:12'], 'keeper 是剩下的两首');

  cleared.length = 0;
  engine.retainCurrentAlbum(); // 已经是单专辑队列：无事发生
  assert.deepEqual(cleared, [], '不需要回收时别乱清');
});

test('随机模式下整段移动：退出随机时不许把用户的调整还原回去', async () => {
  const { engine } = makeEngine({ neteaseAlbum: songsFixture([10, 11, 12]) });
  engine.deps.netease.songUrl = async (id) => urlOk(id);
  await engine.loadAlbum(albumOf(1, 'A'));
  const ids = () => Array.from(engine.snapshot().queue, (t) => t.id);

  engine.setPlayMode('shuffle'); // 进随机：存下进随机前的顺序
  engine.moveRange(0, 1, engine.snapshot().queue.length); // 命令面板的「整段下移」
  const afterMove = ids();
  engine.setPlayMode('once'); // 退出随机
  assert.deepEqual(ids(), afterMove, '手动搬过 = 用户认下了这个顺序，别还原');
});
