// 播放引擎回归（第二轮修复）：
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

const { PlaybackEngine } = loadModule('src/core/player-state.ts', { Audio: AudioStub });

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
