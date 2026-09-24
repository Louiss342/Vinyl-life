// 酷狗播放链路回归：esbuild 编译真实源码后在 vm 执行；无需网络与 Obsidian。
// 与 qq-playback.test.cjs 同构 —— 新源接入必须与既有源在同一张网里被验收。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const nodePath = require('node:path');

function runBundle(source, globals = {}) {
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
  return runBundle(source, globals);
}

/** 把多个模块打进同一个 bundle（并从这里取出 setLanguage）——切语言必须切到 bundle 内部那一份 */
function loadBundle(entries, globals = {}) {
  const source = esbuild.buildSync({
    stdin: {
      contents:
        entries.map((e) => `export * from '../${e}';`).join('\n') +
        `\nexport { setLanguage } from '../src/core/i18n';\n`,
      resolveDir: __dirname,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text;
  return runBundle(source, globals);
}

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

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const trackMod = loadModule('src/core/track.ts');
const kugouMod = loadModule('src/core/kugou.ts');
const queueMod = loadModule('src/core/queue.ts');
const albumMod = loadModule('src/core/album-index.ts');
const engineMod = loadModule('src/core/player-state.ts', { Audio: AudioStub });

test('trackKey 把酷狗归到 kg: 前缀，角标类名 is-kugou', () => {
  const { trackKey, trackSourceLabel, trackSourceClass } = trackMod;
  assert.equal(trackKey({ source: 'kugou', id: HASH, duration: 1, title: 'x' }), `kg:${HASH}`);
  assert.equal(trackSourceLabel({ source: 'kugou', id: HASH, duration: 1, title: 'x' }), '酷狗音乐');
  assert.equal(trackSourceClass({ source: 'kugou', id: HASH, duration: 1, title: 'x' }), 'is-kugou');
  assert.equal(
    new Set([
      trackKey({ source: 'netease', id: 1, duration: 1, title: 'x' }),
      trackKey({ source: 'qq', id: '1', duration: 1, title: 'x' }),
      trackKey({ source: 'kugou', id: '1', duration: 1, title: 'x' }),
    ]).size,
    3,
    '三个在线源的同名 id 不许互相归并'
  );
});

test('kugouSongsToTracks 映射归一化载荷（hash 小写、三件套齐、时长取整）', () => {
  const tracks = kugouMod.kugouSongsToTracks(
    [
      {
        hash: HASH.toUpperCase(),
        name: '以父之名',
        artist: '周杰伦',
        albumName: '叶惠美',
        albumId: '900123',
        albumAudioId: '456789',
        duration: 326,
        cover: 'https://example/1.jpg',
        pay: 1,
        trial: true,
      },
    ],
    'Vinyl Life/Vinyl Note/叶惠美.md'
  );
  const t = tracks[0];
  assert.equal(t.source, 'kugou');
  assert.equal(t.id, HASH, '取流主键一律小写');
  assert.equal(t.albumId, '900123');
  assert.equal(t.albumAudioId, '456789');
  assert.equal(t.duration, 326);
  assert.equal(t.artist, '周杰伦');
  assert.equal(t.album, '叶惠美');
  assert.equal(t.cover, 'https://example/1.jpg');
  assert.equal(t.pay, 1);
  assert.equal(t.trial, true);
  assert.equal(t.albumNotePath, 'Vinyl Life/Vinyl Note/叶惠美.md');
});

test('酷狗专辑 id 解析：链接与裸 id；frontmatter 进 AlbumInfo 并参与音源检测', () => {
  const { parseKugouAlbumId, buildAlbumInfo, detectAlbumSources } = albumMod;
  assert.equal(
    parseKugouAlbumId({ kugou: 'https://www.kugou.com/yy/album/single/12345678.html' }),
    '12345678'
  );
  assert.equal(parseKugouAlbumId({ kugou: 'https://www.kugou.com/album/12345678.html' }), '12345678');
  assert.equal(parseKugouAlbumId({ kugouId: '12345678' }), '12345678');
  assert.equal(parseKugouAlbumId({ kugouId: 12345678 }), '12345678', '数字写法也要认');
  assert.equal(parseKugouAlbumId({ kugouId: 'bad!' }), undefined);
  assert.equal(parseKugouAlbumId({}), undefined);

  const app = { vault: {}, metadataCache: {} };
  const file = { path: 'Vinyl Life/Vinyl Note/叶惠美.md', basename: '叶惠美' };
  const album = buildAlbumInfo(app, file, {
    tags: ['album'],
    source: 'kugou',
    kugou: 'https://www.kugou.com/yy/album/single/12345678.html',
  });
  assert.equal(album.sourcePref, 'kugou');
  assert.equal(album.kugouId, '12345678');
  const src = detectAlbumSources(app, album);
  assert.equal(src.local, false);
  assert.equal(src.kugou, true, '有 kugouId 的专辑不该被判成「无音源」');
});

test('queue：酷狗策略走 kugou 服务；auto 顺序 local→netease→qq→kugou', async () => {
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
  const kugouSongs = {
    code: 0,
    data: { songs: [{ hash: HASH, name: 'S', duration: 100, albumId: '1', albumAudioId: '2' }] },
  };
  const noNet = null;

  // 显式 kugou
  let res = await buildAlbumQueue(album({ sourcePref: 'kugou', kugouId: '12345678' }), {
    local,
    netease: noNet,
    qq: null,
    kugou: {
      album: async (id) => {
        assert.equal(id, '12345678');
        return kugouSongs;
      },
    },
    defaultSource: 'auto',
  });
  assert.equal(res.resolvedSource, 'kugou');
  assert.equal(res.kugouSongs, 1);
  assert.equal(res.tracks[0].source, 'kugou');

  // auto：只有 kugouId → 走酷狗
  res = await buildAlbumQueue(album({ kugouId: '12345678' }), {
    local,
    netease: noNet,
    qq: null,
    kugou: { album: async () => kugouSongs },
    defaultSource: 'auto',
  });
  assert.equal(res.resolvedSource, 'kugou');

  // auto：qqId + kugouId 同时在场 → QQ 优先（酷狗是第四顺位）
  let kugouCalled = false;
  res = await buildAlbumQueue(album({ qqId: '000MkMni19ClKG', kugouId: '12345678' }), {
    local,
    netease: noNet,
    qq: { album: async () => ({ code: 0, data: { songs: [{ mid: 'm', name: 'Q', interval: 100 }] } }) },
    kugou: {
      album: async () => {
        kugouCalled = true;
        return kugouSongs;
      },
    },
    defaultSource: 'auto',
  });
  assert.equal(res.resolvedSource, 'qq');
  assert.equal(kugouCalled, false, '前序来源能出结果时不该惊动酷狗');

  // 显式 kugou 但未绑定 / 源不可用
  res = await buildAlbumQueue(album({ sourcePref: 'kugou' }), {
    local,
    netease: noNet,
    qq: null,
    kugou: { album: async () => kugouSongs },
    defaultSource: 'auto',
  });
  assert.match(res.reason, /未绑定酷狗/);
  res = await buildAlbumQueue(album({ kugouId: '12345678' }), {
    local,
    netease: noNet,
    qq: null,
    kugou: null,
    defaultSource: 'auto',
  });
  assert.equal(res.reason, '酷狗音乐源不可用');
});

test('播放器按源解析地址：酷狗带 hash + 专辑 id + mixsongid 三件套，缓存互不串味', async () => {
  const calls = { kugou: 0 };
  const engine = new engineMod.PlaybackEngine({
    app: {},
    local: { clearBlobs() {}, keysOf: () => [] },
    netease: {},
    qq: {},
    kugou: {
      songUrl: async (hash, level, albumId, albumAudioId) => {
        calls.kugou++;
        return { url: `https://kg/${hash}?level=${level}&a=${albumId}&m=${albumAudioId}`, level };
      },
    },
    settings: () => ({ quality: 'higher' }),
  });
  const track = { source: 'kugou', id: HASH, duration: 1, title: 'a', albumId: '900123', albumAudioId: '456789' };
  assert.equal(
    await engine.resolveUrl(track),
    `https://kg/${HASH}?level=higher&a=900123&m=456789`
  );
  assert.equal(calls.kugou, 1);
  await engine.resolveUrl(track);
  assert.equal(calls.kugou, 1, '同一首走缓存，不重复取流');
});

test('酷狗来源角标随语言切换，队列文案与角标同源', () => {
  const mod = loadBundle(['src/core/track.ts', 'src/core/queue.ts']);
  const kg = { source: 'kugou', id: HASH, duration: 1, title: 'x' };

  mod.setLanguage('zh');
  assert.equal(mod.trackSourceLabel(kg), '酷狗音乐');
  assert.equal(mod.sourceLabel('kugou'), '酷狗音乐');

  mod.setLanguage('en');
  assert.equal(mod.trackSourceLabel(kg), 'Kugou Music');
  assert.equal(mod.sourceLabel('kugou'), mod.trackSourceLabel(kg));

  mod.setLanguage('zh');
  assert.equal(mod.trackSourceLabel(kg), '酷狗音乐', '切回中文复原');
});

test('链接识别：酷狗链接走酷狗；QQ 链接与裸数字的既有语义不被动摇', () => {
  const importMod = loadModule('src/import.ts');
  // 跨 realm 的对象不能 deepEqual，逐字段断
  const kg = importMod.parseAlbumInput('https://www.kugou.com/yy/album/single/12345678.html');
  assert.equal(kg.source, 'kugou');
  assert.equal(kg.id, '12345678');
  const qq = importMod.parseAlbumInput('https://y.qq.com/n/ryqq/albumDetail/000MkMni19ClKG');
  assert.equal(qq.source, 'qq');
  assert.equal(qq.mid, '000MkMni19ClKG');
  const ne = importMod.parseAlbumInput('12345678');
  assert.equal(ne.source, 'netease');
  assert.equal(ne.id, 12345678, '裸数字仍是网易云 ID（酷狗 id 也是数字，无法从裸数字区分）');
  assert.equal(importMod.parseAlbumInput('随便一段话'), undefined);
});
