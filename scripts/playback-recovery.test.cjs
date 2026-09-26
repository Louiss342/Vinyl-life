// 播放失败与等待状态的回归（两条真缺陷 + 两条防线）：
//   ① 一首放不出来时**自动跳下一首** —— 旧写法落 status='error' 就停在那一首，
//      一张专辑里坏一首（链接过期 / 单个文件损坏）就卡住整张，得手动一首首点过去；
//   ② 队尾按「下一首」：循环 / 随机有去处（回队首 / 重洗一遍），只有单次才真的没有下一首。
//      旧写法在队尾无声返回 —— 按了下一首什么都没发生；
//   ③ 防线一：整条队列都放不出来时不打转（同一首在一次播放回合里只自动跳一次，见 autoSkipped）；
//   ④ 防线二：取址失败（会员 / 未绑定音源）**不**跳 —— 那是语义问题，用户要看的是原因，
//      不是一首首刷提示。同一份队列里，两种情况的表现必须分得开。
// 另加缓冲态：只在真的在播时报（暂停时元素也在等数据，那不是用户眼里的卡顿）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const nodePath = require('node:path');
const notices = [];

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
          // 提示要能断言：自动换歌必须说一声，不然用户看到的是「播放器自己乱跳」
          Notice: class {
            constructor(msg) {
              notices.push(String(msg));
            }
          },
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
    // 马达斜坡（暂停的滑停）在 window 上排定时器：这里的用例不考斜坡本身，
    // 给一组「排了但不响」的替身即可 —— 状态在按下的那一刻就翻，其余断言不依赖斜坡走完
    window: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
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
    /** 哪些地址放不出来（按 src 判）：用例据此模拟「解码失败 / 格式不支持 / 链接过期」 */
    this.failPlayFor = () => false;
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
    if (this.failPlayFor(this.src)) return Promise.reject(new Error('decode failed'));
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

const { PlaybackEngine } = loadModule('src/core/player-state.ts', { Audio: AudioStub });

const song = (id) => ({
  id,
  name: `S${id}`,
  ar: [{ name: 'Ar' }],
  al: { name: 'Al', picUrl: '' },
  dt: 1000,
});

function albumOf(id, title) {
  const notePath = `06-专辑墙/专辑/${title}.md`;
  return {
    path: notePath,
    title,
    neteaseId: id,
    sourcePref: 'auto',
    audioRefs: [],
    file: { path: notePath },
  };
}

/** 每张专辑的曲目表（album 桩按 id 取） */
const songList = {};

function makeEngine({ songUrl, failAll = false } = {}) {
  const local = {
    buildTracks: async () => [],
    clearBlobs() {},
    keysOf: () => [],
    resolveVaultUrl: (f) => `vault://${f.path}`,
    resolveExternalUrl: (p) => `ext://${p}`,
    resolveVaultBlobUrl: async () => 'blob://retry',
  };
  const engine = new PlaybackEngine({
    app: {},
    local,
    netease: {
      album: async (id) => ({ songs: songList[String(id)] || [] }),
      songUrl: songUrl || (async (id) => ({ url: `https://cdn.example/${id}.mp3`, level: 'standard' })),
    },
    qq: null,
    kugou: null,
    settings: () => ({ defaultSource: 'auto', autoPlay: true, quality: 'higher' }),
  });
  const audio = audioInstances[audioInstances.length - 1];
  // failAll 要在 loadAlbum 之前就位：自动播放紧接着就会撞上它
  if (failAll) audio.failPlayFor = () => true;
  return { engine, audio };
}

async function setup(ids, opts) {
  songList[1] = ids.map(song);
  notices.length = 0;
  const { engine, audio } = makeEngine(opts);
  await engine.loadAlbum(albumOf(1, 'Album'));
  return { engine, audio, snap: () => engine.snapshot() };
}

test('播放失败：兜底救不回来就自动跳下一首（旧写法停在那一首）', async () => {
  const { audio, snap } = await setup([11, 12]);
  assert.equal(snap().index, 0, '先放着第一首');
  // 第一首「放着放着坏了」：重取回来的地址同样放不出来（元素报 error → 引擎重取 → 还是放不出来）
  audio.failPlayFor = (src) => src.includes('/11.');
  notices.length = 0;
  audio.emit('error');
  await sleep(30);
  assert.equal(snap().index, 1, '跳到下一首');
  assert.equal(snap().status, 'playing', '下一首照常播起来');
  assert.equal(notices.length, 1, '跳之前说一声');
  assert.match(notices[0], /无法播放/, '提示要说清是「放不出来所以跳了」');
});

test('取址失败（会员 / 未绑定音源）不跳：停在那一首并报出原因', async () => {
  songList[1] = [song(11), song(12)];
  notices.length = 0;
  const { engine } = makeEngine({
    songUrl: async (id) =>
      id === 11 ? { url: '', restriction: '会员曲目' } : { url: `https://cdn.example/${id}.mp3` },
  });
  await engine.loadAlbum(albumOf(1, 'Album'));
  await sleep(10);
  const s = engine.snapshot();
  assert.equal(s.index, 0, '语义失败停在原地 —— 不一首首刷提示');
  assert.equal(s.status, 'error');
  assert.equal(notices.length, 1, '只报这一首的原因');
  assert.match(notices[0], /会员曲目|无法播放/);
});

test('整条队列都放不出来：跳满一圈就停在最后一首，不打转', async () => {
  const { snap } = await setup([11, 12, 13], { failAll: true });
  await sleep(80);
  const s = snap();
  assert.equal(s.index, 2, '停在最后一首（每首只自动跳一次）');
  assert.equal(s.status, 'error');
  assert.equal(notices.length, 3, `提示 = 跳过的两首 + 最后失败的一首，实际 ${notices.length}`);
});

test('缓冲态：waiting 亮起、canplay 收掉；暂停时不报', async () => {
  const { engine, audio, snap } = await setup([11]);
  assert.equal(snap().buffering, false, '正常播放时不报缓冲');
  audio.emit('waiting');
  assert.equal(snap().buffering, true, '元素在等数据 → 报缓冲');
  audio.emit('canplay');
  assert.equal(snap().buffering, false, '能接着放了 → 收掉');
  // 暂停：元素也会继续取数据，但那不是用户眼里的卡顿
  audio.emit('waiting');
  engine.pause();
  audio.emit('pause');
  assert.equal(snap().status, 'paused');
  assert.equal(snap().buffering, false, '暂停时不报缓冲');
});

test('队尾按下一首：循环回队首，单次不动（旧写法两边都无声）', async () => {
  const { engine, snap } = await setup([11, 12]);
  await engine.playIndex(1);
  assert.equal(snap().index, 1, '先停在最后一首');
  await engine.next();
  assert.equal(snap().index, 1, '单次模式：队列放完了，没有下一首，保持不动');

  engine.cyclePlayMode(); // once → loop
  assert.equal(snap().playMode, 'loop');
  await engine.next();
  assert.equal(snap().index, 0, '循环模式：队尾的下一首就是队首');
});

test('换队列清空自动跳过的记账：同一首在新队列里重新有机会', async () => {
  const { engine, audio, snap } = await setup([11, 12], { failAll: true });
  await sleep(80);
  assert.equal(snap().status, 'error', '第一首跳过、第二首失败（已跳满一圈）');
  audio.failPlayFor = () => false; // 换专辑之前把「坏」撤掉
  songList[2] = [song(11), song(21)];
  await engine.loadAlbum(albumOf(2, 'Another'));
  await sleep(20);
  const s = snap();
  assert.equal(s.index, 0, '新队列里第一首重新开播');
  assert.equal(s.status, 'playing');
});
