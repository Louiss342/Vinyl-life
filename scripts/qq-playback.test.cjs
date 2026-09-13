// QQ 播放链路回归：esbuild 编译真实源码后在 vm 执行；无需网络与 Obsidian。
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

const trackMod = loadModule('src/core/track.ts');
const qqMod = loadModule('src/core/qq.ts');
const queueMod = loadModule('src/core/queue.ts');
const albumMod = loadModule('src/core/album-index.ts');

class AudioStub {
  constructor(src) {
    this.src = src || '';
    this.volume = 1;
    this.currentTime = 0;
    this.paused = true;
    this.preload = '';
    this.duration = NaN;
  }
  addEventListener() {}
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
const engineMod = loadModule('src/core/player-state.ts', { Audio: AudioStub });

test('trackKey is total and QQ ids are string-keyed', () => {
  const { trackKey, trackSourceLabel, trackSourceClass } = trackMod;
  assert.equal(trackKey({ source: 'local-vault', file: { path: 'a/b.md' }, title: 'x' }), 'vault:a/b.md');
  assert.equal(trackKey({ source: 'local-external', path: 'D:/x.wav', title: 'x' }), 'ext:D:/x.wav');
  assert.equal(trackKey({ source: 'netease', id: 123, duration: 1, title: 'x' }), 'ne:123');
  assert.equal(trackKey({ source: 'qq', id: '001n4C3p1yv0FU', duration: 1, title: 'x' }), 'qq:001n4C3p1yv0FU');
  assert.equal(
    typeof trackKey({ source: 'mystery', title: 'x' }),
    'string',
    'unknown sources must still key uniquely'
  );
  assert.equal(trackSourceLabel({ source: 'qq', id: 'x', duration: 1, title: 'x' }), 'QQ音乐');
  assert.equal(trackSourceClass({ source: 'qq', id: 'x', duration: 1, title: 'x' }), 'is-qq');
  assert.equal(trackSourceClass({ source: 'netease', id: 1, duration: 1, title: 'x' }), 'is-net');
});

test('qqSongsToTracks maps the normalized payload', () => {
  const tracks = qqMod.qqSongsToTracks(
    [
      {
        mid: '001n4C3p1yv0FU',
        mediaMid: '002ExFMX2Jt6gv',
        name: '以父之名',
        artist: '周杰伦',
        albumName: '叶惠美',
        interval: 326,
        cover: 'https://example/1.jpg',
        pay: 1,
        trial: true,
      },
    ],
    '06-专辑墙/专辑/叶惠美.md'
  );
  const t = tracks[0];
  assert.equal(t.source, 'qq');
  assert.equal(t.id, '001n4C3p1yv0FU');
  assert.equal(t.mediaMid, '002ExFMX2Jt6gv');
  assert.equal(t.duration, 326);
  assert.equal(t.artist, '周杰伦');
  assert.equal(t.album, '叶惠美');
  assert.equal(t.cover, 'https://example/1.jpg');
  assert.equal(t.pay, 1);
  assert.equal(t.trial, true);
  assert.equal(t.albumNotePath, '06-专辑墙/专辑/叶惠美.md');
});

test('QQ album mid parsing accepts links and bare ids', () => {
  const { parseQqAlbumMid, buildAlbumInfo, detectAlbumSources } = albumMod;
  assert.equal(parseQqAlbumMid({ qq: 'https://y.qq.com/n/ryqq/albumDetail/000MkMni19ClKG' }), '000MkMni19ClKG');
  assert.equal(parseQqAlbumMid({ qq: 'https://y.qq.com/n/yqq/album/000MkMni19ClKG.html' }), '000MkMni19ClKG');
  assert.equal(parseQqAlbumMid({ qqId: '000MkMni19ClKG' }), '000MkMni19ClKG');
  assert.equal(parseQqAlbumMid({ qq: '000MkMni19ClKG' }), '000MkMni19ClKG');
  assert.equal(parseQqAlbumMid({ qqId: 'bad!' }), undefined);
  assert.equal(parseQqAlbumMid({}), undefined);

  const app = { vault: {}, metadataCache: {} };
  const file = { path: '06-专辑墙/专辑/叶惠美.md', basename: '叶惠美' };
  const album = buildAlbumInfo(app, file, {
    tags: ['album'],
    source: 'qq',
    qq: 'https://y.qq.com/n/ryqq/albumDetail/000MkMni19ClKG',
  });
  assert.equal(album.sourcePref, 'qq');
  assert.equal(album.qqId, '000MkMni19ClKG');
  const src = detectAlbumSources(app, album);
  assert.equal(src.local, false);
  assert.equal(src.netease, false);
  assert.equal(src.qq, true);
});

test('queue: qq policy resolves via qq service; auto order is local→netease→qq', async () => {
  const { buildAlbumQueue } = queueMod;
  const album = (over = {}) => ({
    file: {},
    path: 'p.md',
    title: 'T',
    audioRefs: [],
    sourcePref: 'auto',
    ...over,
  });
  const local = { buildTracks: async () => [] };
  const qqSongs = {
    code: 0,
    data: { songs: [{ mid: '001n4C3p1yv0FU', mediaMid: 'm', name: 'S', interval: 100 }] },
  };

  // 显式 qq
  let res = await buildAlbumQueue(album({ sourcePref: 'qq', qqId: '000MkMni19ClKG' }), {
    local,
    netease: null,
    qq: {
      album: async (id) => {
        assert.equal(id, '000MkMni19ClKG');
        return qqSongs;
      },
    },
    defaultSource: 'auto',
  });
  assert.equal(res.resolvedSource, 'qq');
  assert.equal(res.qqSongs, 1);
  assert.equal(res.tracks[0].source, 'qq');

  // auto + 仅 qqId
  res = await buildAlbumQueue(album({ qqId: '000MkMni19ClKG' }), {
    local,
    netease: null,
    qq: { album: async () => qqSongs },
    defaultSource: 'auto',
  });
  assert.equal(res.resolvedSource, 'qq');

  // auto + 双 id → 网易云优先（顺序被测试固定）
  let neteaseCalled = false;
  res = await buildAlbumQueue(album({ neteaseId: 15185, qqId: '000MkMni19ClKG' }), {
    local,
    netease: {
      album: async () => {
        neteaseCalled = true;
        return { songs: [{ id: 1, name: 'N', ar: [], al: {}, dt: 1000 }] };
      },
    },
    qq: { album: async () => qqSongs },
    defaultSource: 'auto',
  });
  assert.equal(neteaseCalled, true);
  assert.equal(res.resolvedSource, 'netease');

  // auto + 本地有音轨 → 本地
  res = await buildAlbumQueue(album({ qqId: '000MkMni19ClKG' }), {
    local: { buildTracks: async () => [{ source: 'local-external', path: 'p', title: 'L' }] },
    netease: null,
    qq: { album: async () => qqSongs },
    defaultSource: 'auto',
  });
  assert.equal(res.resolvedSource, 'local');

  // 显式 qq 但未绑定 / 源不可用
  res = await buildAlbumQueue(album({ sourcePref: 'qq' }), {
    local,
    netease: null,
    qq: null,
    defaultSource: 'auto',
  });
  assert.match(res.reason, /未绑定 QQ/);
  res = await buildAlbumQueue(album({ qqId: '000MkMni19ClKG' }), {
    local,
    netease: null,
    qq: null,
    defaultSource: 'auto',
  });
  assert.equal(res.reason, 'QQ 音乐源不可用');
});

test('source labels cover all three active sources', () => {
  const { sourceLabel } = queueMod;
  assert.equal(sourceLabel('local'), '本地');
  assert.equal(sourceLabel('netease'), '网易云');
  assert.equal(sourceLabel('qq'), 'QQ音乐');
});

test('player resolves per source and never collides numeric vs string ids', async () => {
  const calls = { netease: 0, qq: 0 };
  const engine = new engineMod.PlaybackEngine({
    app: {},
    local: { clearBlobs() {}, keysOf: () => [] },
    netease: {
      songUrl: async (id, level) => {
        calls.netease++;
        return { url: `https://ne/${id}?level=${level}` };
      },
    },
    qq: {
      songUrl: async (id, level, mediaMid) => {
        calls.qq++;
        return { url: `https://qq/${id}?media=${mediaMid || '-'}` };
      },
    },
    settings: () => ({ quality: 'higher' }),
  });
  const ne = { source: 'netease', id: 123, duration: 1, title: 'a' };
  const qq = { source: 'qq', id: '123', duration: 1, title: 'b', mediaMid: 'm1' };
  assert.equal(await engine.resolveUrl(ne), 'https://ne/123?level=higher');
  assert.equal(await engine.resolveUrl(qq), 'https://qq/123?media=m1', 'must not hit the netease cache entry');
  assert.equal(calls.netease, 1);
  assert.equal(calls.qq, 1);
  await engine.resolveUrl(ne);
  await engine.resolveUrl(qq);
  assert.equal(calls.netease, 1, 'cache hit for netease');
  assert.equal(calls.qq, 1, 'cache hit for qq');
});
