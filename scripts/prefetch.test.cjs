// 起播预热回归：起播本要等两段网络（曲目表、这一首的地址，各百毫秒级），都提前做掉 ——
//   ① 这一首一开声就取下一首的地址；② 悬停停够先搭一遍队列（曲目表进服务缓存 + 首曲地址进 urlCache）；
//   ③ 地址保鲜期 10 分钟（签名地址约一刻钟到期），过期当没缓存 —— 否则放久了的地址要靠 onAudioError 兜底，用户先听一次错误再重来。
// 另守三条边界：本地源不预热（整文件读进内存）、预热失败静默（提前量不是用户动作）、扫过一面墙只跑最新那一张（每张一轮平台请求）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const nodePath = require('node:path');

/** 可推进的时钟：地址保鲜期按 Date.now() 算，用例要能把它拨到 10 分钟后 */
let clock = 1_760_000_000_000;
class FakeDate extends Date {
  static now() {
    return clock;
  }
}

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
    Date: FakeDate,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    window: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
    console,
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
    this.preload = '';
    this.duration = NaN;
    this.listeners = {};
    audioInstances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeAttribute() {}
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const song = (id) => ({
  id,
  name: `S${id}`,
  ar: [{ name: 'Ar' }],
  al: { name: 'Al', picUrl: '' },
  dt: 1000,
});

function albumOf(id, title) {
  const notePath = `Vinyl Life/Vinyl Note/${title}.md`;
  return { path: notePath, title, neteaseId: id, sourcePref: 'auto', audioRefs: [], file: { path: notePath } };
}

const localTrack = (p) => ({
  id: p,
  title: p,
  source: 'local-vault',
  file: { path: p },
  albumNotePath: 'Vinyl Life/Vinyl Note/L.md',
});

/** 引擎 + 记账桩：songUrl / album / 本地取址各自记一笔，用例按顺序比对 */
function makeEngine({ songsByAlbum = {}, failSongUrl = false, failAlbum = false, songUrlDelayMs = 0 } = {}) {
  const calls = { songUrl: [], album: [], vaultUrl: [] };
  const local = {
    buildTracks: async () => [],
    clearBlobs() {},
    keysOf: () => [],
    resolveVaultUrl: (f) => {
      calls.vaultUrl.push(f.path);
      return `vault://${f.path}`;
    },
    resolveExternalUrl: (p) => `ext://${p}`,
    resolveVaultBlobUrl: async () => 'blob://retry',
  };
  const engine = new PlaybackEngine({
    app: {},
    local,
    netease: {
      album: async (id) => {
        calls.album.push(id);
        if (failAlbum) throw new Error('专辑取不到');
        return { songs: songsByAlbum[String(id)] || [] };
      },
      songUrl: async (id) => {
        calls.songUrl.push(id);
        if (songUrlDelayMs) await sleep(songUrlDelayMs);
        if (failSongUrl) throw new Error('取址失败');
        return { url: `https://cdn.example/${id}.mp3`, level: 'standard' };
      },
    },
    qq: null,
    kugou: null,
    settings: () => ({ defaultSource: 'auto', autoPlay: true, quality: 'higher' }),
  });
  return { engine, calls };
}

/** 起播一张两首的专辑，等预热那一趟（异步的，不 await 在 playIndex 里）跑完 */
async function startAlbum(ids = [11, 12], opts) {
  const { engine, calls } = makeEngine({ songsByAlbum: { 1: ids.map(song) }, ...opts });
  await engine.loadAlbum(albumOf(1, 'Album'));
  await sleep(10);
  return { engine, calls };
}

test('预热：这一首开声后，下一首的地址已经在手上（切歌不再等取址）', async () => {
  const { engine, calls } = await startAlbum([11, 12]);
  assert.deepEqual(calls.songUrl, [11, 12], '起播取第一首，顺手把下一首也取了');
  calls.songUrl.length = 0;
  await engine.playIndex(1);
  assert.deepEqual(calls.songUrl, [], '切过去时取址那一段省掉了（只剩元素缓冲）');
});

test('预热：到队尾没有下一首就不取（不多敲一次平台）', async () => {
  const { calls } = await startAlbum([11]);
  assert.deepEqual(calls.songUrl, [11], '只有这一首，预热无事可做');
});

test('预热：本地源不预热（它的「取址」是整文件读进内存，不该由预热触发）', async () => {
  const { engine, calls } = makeEngine();
  await engine.prefetchTrackUrl(localTrack('audio/a.flac'));
  assert.deepEqual(calls.vaultUrl, [], '本地曲目不预热');
  assert.deepEqual(calls.songUrl, [], '也没去问在线源');
});

test('预热：失败静默（不抛、不改状态、不弹提示）', async () => {
  const { engine, calls } = makeEngine({ failSongUrl: true });
  await engine.prefetchTrackUrl({ id: 9, title: 'S9', source: 'netease' });
  assert.equal(engine.snapshot().status, 'idle', '预热失败不改变任何状态');
  calls.songUrl.length = 0;
  await engine.prefetchTrackUrl({ id: 9, title: 'S9', source: 'netease' });
  assert.deepEqual(calls.songUrl, [9], '下一次预热照旧去取（没有把失败也缓存下来）');
});

test('地址保鲜期：超过 10 分钟的缓存当没缓存，重新取一次', async () => {
  const { engine, calls } = await startAlbum([11, 12]);
  calls.songUrl.length = 0;
  await engine.playIndex(1);
  assert.deepEqual(calls.songUrl, [], '探头：预热过的地址先是命中的');
  clock += 11 * 60 * 1000; // 签名地址约一刻钟到期
  await engine.playIndex(0);
  assert.deepEqual(
    calls.songUrl,
    [11, 12],
    '过期了就当没缓存：当前这首重新取（不走 onAudioError 那条兜底），顺手预热的下一首同样重取'
  );
});

test('去重：同一首同时被预热与起播取址时只发一趟请求（平台侧只看到一次）', async () => {
  const { engine, calls } = makeEngine({
    songsByAlbum: { 1: [song(11), song(12)] },
    songUrlDelayMs: 30,
  });
  await engine.loadAlbum(albumOf(1, 'Album')); // 起播 11，顺手预热 12（还在飞）
  await sleep(5);
  const track12 = engine.snapshot().queue[1];
  const [a] = await Promise.all([engine.resolveUrl(track12), engine.prefetchTrackUrl(track12)]);
  assert.equal(calls.songUrl.filter((id) => id === 12).length, 1, '同一首只发一趟');
  assert.equal(a, 'https://cdn.example/12.mp3', '两个调用方拿到的是同一趟的结果');
});

test('悬停预热：曲目表与第一首地址都热上，但引擎状态一动不动', async () => {
  const { engine, calls } = makeEngine({ songsByAlbum: { 7: [song(71), song(72)] } });
  const before = engine.snapshot();
  await engine.prefetchAlbum(albumOf(7, 'Hover'));
  assert.deepEqual(calls.album, [7], '曲目表进服务缓存（点下去时命中）');
  assert.deepEqual(calls.songUrl, [71], '第一首的地址也热上');
  const after = engine.snapshot();
  assert.equal(after.status, before.status, '不碰状态');
  assert.equal(after.queue.length, 0, '不建队列');
  assert.equal(after.albumNotePath, before.albumNotePath);
});

test('悬停预热：扫过一面墙只跑最新那一张（每追一张就是一次平台请求）', async () => {
  const { engine, calls } = makeEngine({
    songsByAlbum: { 1: [song(11)], 2: [song(21)], 3: [song(31)] },
  });
  const chain = [
    engine.prefetchAlbum(albumOf(1, 'A')),
    engine.prefetchAlbum(albumOf(2, 'B')),
    engine.prefetchAlbum(albumOf(3, 'C')),
  ];
  await Promise.all(chain);
  assert.deepEqual(calls.album, [3], '中途扫过的那两张不追，只热最后停住的那张');
});

test('悬停预热：失败静默（悬停只是提前量，后果最多是「点下去和以前一样」）', async () => {
  const { engine } = makeEngine({ failAlbum: true });
  await engine.prefetchAlbum(albumOf(1, 'Bad'));
  assert.equal(engine.snapshot().status, 'idle', '预热失败不改状态、不抛给调用方');
});
