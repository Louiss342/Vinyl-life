// 库外音频的 Range 供流回归（第 5 条的正面解）：
//   ① 网关侧：**真起进程**跑 server/gateway.js、真发 HTTP —— 200 / 206 / 416、
//      Content-Range 与字节正确性、Accept-Ranges、四类拒绝（相对路径 / 非音频 / **没登记** / 不存在）、
//      无 token 401、路径里的空格与中文能原样找回；
//   ①b 供流白名单：没登记的路径一律 403（碰文件系统之前就挡下，不给探测面），
//      登记只收「绝对路径 + 音频扩展名」，重复登记不加量；
//   ② 插件侧：LocalSource 的选路 —— 能给网关就发 Range 地址（一次字节都不读），
//      起不来 / 没注入宿主才退回整文件 Blob；失败一次后本次会话不再主动启动网关，
//      但网关后来因别的功能起来了就照用；
//   ③ 引擎接线：local-external 走的是新口径（resolveExternalPlayableUrl），不是旧的 Blob 那条；
//   ④ 两张手抄的扩展名表（src/util.ts 与 server/gateway.js）必须一致。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const esbuild = require('esbuild');

const nodePath = require('node:path');
const TOKEN = 'range-fixture-token';

// ============ 真网关：构建产物 → 落临时文件 → spawn → 读它回报的端口 ============

const GATEWAY_SOURCE = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../server/gateway.js')],
  bundle: true,
  minify: true,
  charset: 'utf8',
  format: 'cjs',
  platform: 'node',
  write: false,
}).outputFiles[0].text;

async function startGateway() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinyl-range-'));
  const gwFile = path.join(dir, 'gateway.js');
  fs.writeFileSync(gwFile, GATEWAY_SOURCE, 'utf8');
  const child = spawn(process.execPath, [gwFile], {
    env: {
      ...process.env,
      VINYL_PORT: '0',
      VINYL_TOKEN: TOKEN,
      VINYL_LOG_FILE: path.join(dir, 'gateway.log'),
      VINYL_COOKIE_FILE: path.join(dir, '.cookie'),
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('网关 15s 内没回报端口：' + buf)), 15000);
    child.stdout.on('data', (d) => {
      buf += String(d);
      const m = /listening on 127\.0\.0\.1:(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`网关提前退出（code ${code}）：` + buf));
    });
  });
  return { child, dir, port };
}

function rawGet(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** POST JSON（登记白名单用）。带 token 头：这条路由走的是普通请求，不是 <audio>。 */
function rawPost(port, pathname, payload, headers = { 'x-vinyl-token': TOKEN }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** 把要供流的路径登记进白名单（插件在取流地址之前做的事，见 server-manager 的 allowStreamPaths） */
async function allow(gw, ...paths) {
  const res = await rawPost(gw.port, '/api/local/allow', { paths });
  assert.equal(res.status, 200, '登记要成功：' + res.body);
}

const SIZE = 4096;
/** 逐字节可校验的假音频：byte[i] = i % 251 */
function audioBytes() {
  const b = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) b[i] = i % 251;
  return b;
}

let gwPromise = null;
function gateway() {
  if (!gwPromise) gwPromise = startGateway();
  return gwPromise;
}
test.after(async () => {
  const gw = await gwPromise;
  if (gw) gw.child.kill();
});

/** 查询串按插件的写法编码（URLSearchParams：空格成 +，中文百分号转义） */
function streamPath(file) {
  return '/api/local/stream?' + new URLSearchParams({ path: file, t: TOKEN }).toString();
}

test('网关：没有 Range 时整文件 200，且必须带 Accept-Ranges（<audio> 靠它决定能不能拖进度）', async () => {
  const gw = await gateway();
  const file = path.join(gw.dir, 'whole.mp3');
  fs.writeFileSync(file, audioBytes());
  await allow(gw, file);
  const res = await rawGet(gw.port, streamPath(file));
  assert.equal(res.status, 200);
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.equal(res.headers['content-type'], 'audio/mpeg');
  assert.equal(Number(res.headers['content-length']), SIZE);
  assert.equal(res.headers['content-range'], undefined, '全量响应不带 Content-Range');
  assert.ok(res.body.equals(audioBytes()), '整轨字节要原样');
});

test('网关：单区间 206，Content-Range 与切片字节都对', async () => {
  const gw = await gateway();
  const file = path.join(gw.dir, 'part.flac');
  fs.writeFileSync(file, audioBytes());
  await allow(gw, file);
  const res = await rawGet(gw.port, streamPath(file), { Range: 'bytes=100-199' });
  assert.equal(res.status, 206);
  assert.equal(res.headers['content-range'], `bytes 100-199/${SIZE}`);
  assert.equal(Number(res.headers['content-length']), 100);
  assert.equal(res.headers['content-type'], 'audio/flac');
  assert.ok(res.body.equals(audioBytes().subarray(100, 200)), '切出来的必须是那一段');
});

test('网关：bytes=a- 到末尾、bytes=-n 取尾巴（Chromium 两种都会发）', async () => {
  const gw = await gateway();
  const file = path.join(gw.dir, 'tail.m4a');
  fs.writeFileSync(file, audioBytes());
  await allow(gw, file);
  const open = await rawGet(gw.port, streamPath(file), { Range: 'bytes=4000-' });
  assert.equal(open.status, 206);
  assert.equal(open.headers['content-range'], `bytes 4000-${SIZE - 1}/${SIZE}`);
  assert.ok(open.body.equals(audioBytes().subarray(4000)));

  const suffix = await rawGet(gw.port, streamPath(file), { Range: 'bytes=-50' });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers['content-range'], `bytes ${SIZE - 50}-${SIZE - 1}/${SIZE}`);
  assert.ok(suffix.body.equals(audioBytes().subarray(SIZE - 50)));
});

test('网关：越界区间回 416 并带 Content-Range: bytes */size（播放器据此收手）', async () => {
  const gw = await gateway();
  const file = path.join(gw.dir, 'oob.wav');
  fs.writeFileSync(file, audioBytes());
  await allow(gw, file);
  const res = await rawGet(gw.port, streamPath(file), { Range: `bytes=${SIZE}-` });
  assert.equal(res.status, 416);
  assert.equal(res.headers['content-range'], `bytes */${SIZE}`);
});

test('网关：只认「绝对路径 + 音频扩展名 + 已登记 + 存在的常规文件」——不是通用文件读取口', async () => {
  const gw = await gateway();
  const relative = await rawGet(gw.port, streamPath('music/song.mp3'));
  assert.equal(relative.status, 400);
  assert.match(relative.body.toString(), /需要绝对路径/);

  const notAudio = await rawGet(gw.port, streamPath(path.join(gw.dir, 'gateway.log')));
  assert.equal(notAudio.status, 400);
  assert.match(notAudio.body.toString(), /不是可播放的音频文件/);

  const missing = path.join(gw.dir, 'nope.mp3');
  await allow(gw, missing); // 登记了但文件不在 → 404（与「没登记」分开报，排查方向不同）
  const missingRes = await rawGet(gw.port, streamPath(missing));
  assert.equal(missingRes.status, 404);
  assert.match(missingRes.body.toString(), /音频文件不存在/);
});

test('网关：没登记的路径一律 403 —— 拿着 token 也读不了盘上任意音频文件', async () => {
  const gw = await gateway();
  const file = path.join(gw.dir, 'never-allowed.mp3');
  fs.writeFileSync(file, audioBytes());
  const res = await rawGet(gw.port, streamPath(file));
  assert.equal(res.status, 403, '白名单之外：拒绝');
  assert.match(res.body.toString(), /没有登记/, '文案要说清是「没登记」，不是「文件不存在」');

  // 登记只收「绝对路径 + 认识的音频扩展名」：相对路径与非音频混进来也不加量
  const first = await rawPost(gw.port, '/api/local/allow', {
    paths: [file, 'music/rel.mp3', path.join(gw.dir, 'gateway.log')],
  });
  assert.equal(JSON.parse(first.body).added, 1, '三条里只该收下那一条合格的');
  const again = await rawPost(gw.port, '/api/local/allow', { paths: [file] });
  assert.equal(JSON.parse(again.body).added, 0, '重复登记不加量');
  const ok = await rawGet(gw.port, streamPath(file), { Range: 'bytes=0-9' });
  assert.equal(ok.status, 206, '登记之后照常供流');
});

test('网关：路径里的空格与中文按查询串编码后能原样找回', async () => {
  const gw = await gateway();
  const file = path.join(gw.dir, '周杰伦 - 晴天 (Live).mp3');
  fs.writeFileSync(file, audioBytes());
  await allow(gw, file);
  const res = await rawGet(gw.port, streamPath(file), { Range: 'bytes=0-9' });
  assert.equal(res.status, 206);
  assert.ok(res.body.equals(audioBytes().subarray(0, 10)), '编码往返不能把路径弄丢');
});

test('网关：同一套 token 鉴权（<audio> 加不了请求头，所以走 ?t= 那条路）', async () => {
  const gw = await gateway();
  const file = path.join(gw.dir, 'auth.mp3');
  fs.writeFileSync(file, audioBytes());
  await allow(gw, file);
  const noToken = await rawGet(gw.port, '/api/local/stream?' + new URLSearchParams({ path: file }).toString());
  assert.equal(noToken.status, 401, '没有 token 一律拒绝');
  const wrongToken = await rawGet(
    gw.port,
    '/api/local/stream?' + new URLSearchParams({ path: file, t: 'not-the-token' }).toString()
  );
  assert.equal(wrongToken.status, 401);
});

test('扩展名表：server/gateway.js 的 STREAM_MIME 与 src/util.ts 的音频表逐项一致', () => {
  const util = fs.readFileSync(path.join(__dirname, '../src/util.ts'), 'utf8');
  const extensions = /export const AUDIO_EXTENSIONS = \[([\s\S]*?)\];/
    .exec(util)[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
  const mimeSrc = /const MIME_BY_EXT: Record<string, string> = \{([\s\S]*?)\n\};/.exec(util)[1];
  const utilMime = {};
  for (const m of mimeSrc.matchAll(/(\w+):\s*'([^']+)'/g)) utilMime[m[1]] = m[2];

  const gw = /const STREAM_MIME = \{([\s\S]*?)\n\};/.exec(fs.readFileSync(path.join(__dirname, '../server/gateway.js'), 'utf8'))[1];
  const gwMime = {};
  for (const m of gw.matchAll(/(\w+):\s*'([^']+)'/g)) gwMime[m[1]] = m[2];

  assert.deepEqual(
    Object.keys(gwMime).sort(),
    [...extensions].sort(),
    '两张表是手抄的：gateway 少一个扩展名 = 那种音频突然播不了，多一个 = 放行了插件不认的文件'
  );
  for (const ext of extensions) {
    assert.equal(gwMime[ext], utilMime[ext], `${ext} 的 MIME 两处必须一致`);
  }
});

// ============ 插件侧：LocalSource 选路 ============

/** 造一个 LocalSource：files 是「绝对路径 → 字节数」；streamHost 由用例给 */
function makeSource(files, { blobBudget = 192 * 1024 * 1024, streamHost = null } = {}) {
  const revoked = [];
  const created = [];
  const readCalls = [];
  const ensureCalls = [];
  let seq = 0;
  const fsStub = {
    existsSync: (p) => files.has(p),
    statSync: () => ({ isFile: () => true }),
    readdirSync: () => [],
    readFileSync: (p) => {
      readCalls.push(p);
      const size = files.get(p);
      if (size === undefined) throw new Error('ENOENT: ' + p);
      return Buffer.alloc(size, 1);
    },
  };
  const allowCalls = [];
  const source = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '../src/core/local-source.ts')],
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
          Plugin: class {},
          Notice: class {},
          Menu: class {},
          Modal: class {},
          TFile: class {},
          TFolder: class {},
          normalizePath: (p) => p,
        };
      }
      if (name === 'fs') return fsStub;
      if (name === 'path') return nodePath;
      throw new Error('Unexpected runtime import: ' + name);
    },
    console,
    Buffer,
    TextDecoder,
    TextEncoder,
    URLSearchParams,
    URL: {
      createObjectURL: () => {
        const url = `blob:fake-${++seq}`;
        created.push(url);
        return url;
      },
      revokeObjectURL: (url) => revoked.push(url),
    },
    Blob: class {
      constructor(parts) {
        this.size = parts.reduce((n, p) => n + (p.byteLength || 0), 0);
      }
    },
  });
  // streamHost 允许给一个工厂：用例要拿着 ensureCalls 记账（也可能是同一个对象、随用例改状态）
  const host = typeof streamHost === 'function' ? streamHost(ensureCalls, allowCalls) : streamHost ?? null;
  const { LocalSource } = mod.exports;
  return {
    src: new LocalSource({ vault: {} }, blobBudget, host),
    revoked,
    created,
    readCalls,
    ensureCalls,
    allowCalls,
    host,
  };
}

/** 供流宿主的缺省桩：状态 running、ensure 成功、登记白名单成功（用例可以整块换掉） */
function hostDefaults(ensureCalls, allowCalls = []) {
  return {
    base: 'http://127.0.0.1:54321',
    token: 'fixture-token',
    state: 'running',
    ensure: async () => {
      ensureCalls.push(1);
      return true;
    },
    allowStreamPaths: async (paths) => {
      allowCalls.push([...paths]);
      return true;
    },
  };
}

const MB = 1024 * 1024;

test('能给网关：先登记白名单，再发 Range 地址，一次字节都不读（整轨不进内存）', async () => {
  const files = new Map([['D:/m/a.flac', 40 * MB]]);
  const { src, created, readCalls, ensureCalls, allowCalls } = makeSource(files, {
    streamHost: (calls, allows) => hostDefaults(calls, allows),
  });
  const url = await src.resolveExternalPlayableUrl('D:/m/a.flac');
  assert.deepEqual(allowCalls, [['D:/m/a.flac']], '取流地址之前先把路径登记给网关');
  assert.match(url, /^http:\/\/127\.0\.0\.1:54321\/api\/local\/stream\?/, '应走网关供流');
  assert.match(url, /t=fixture-token/, 'token 走查询串（<audio> 加不了请求头）');
  assert.equal(new URL(url).searchParams.get('path'), 'D:/m/a.flac', '路径要原样带过去');
  assert.deepEqual(created, [], '不该再建 Blob');
  assert.deepEqual(readCalls, [], '不该读整文件');
  assert.equal(ensureCalls.length, 1, '每次解析都确认一次网关在跑');
  // 同一个路径再取一次：登记是幂等的，但没必要重复发（本会话记着）
  await src.resolveExternalPlayableUrl('D:/m/a.flac');
  assert.equal(allowCalls.length, 1, '已登记过的路径不重复登记');
});

test('登记不上就不用网关那条通道：退回 Blob（直接发流只会 403）', async () => {
  const files = new Map([['D:/m/a.flac', 1 * MB]]);
  const { src, created, allowCalls } = makeSource(files, {
    streamHost: (calls, allows) => ({
      ...hostDefaults(calls, allows),
      allowStreamPaths: async (paths) => {
        allows.push([...paths]);
        return false; // 网关拒绝了登记（版本旧 / 通道异常）
      },
    }),
  });
  const url = await src.resolveExternalPlayableUrl('D:/m/a.flac');
  assert.match(url, /^blob:fake-/, '登记不上就退回整文件 Blob');
  assert.equal(created.length, 1);
  assert.equal(allowCalls.length, 1);
});

test('网关起不来：退回整文件 Blob（功能不变，内存回到旧口径）', async () => {
  const files = new Map([['D:/m/a.flac', 1 * MB]]);
  const { src, created, ensureCalls } = makeSource(files, {
    streamHost: (calls) => ({
      ...hostDefaults(calls),
      ensure: async () => {
        calls.push(1);
        return false;
      },
    }),
  });
  const url = await src.resolveExternalPlayableUrl('D:/m/a.flac');
  assert.match(url, /^blob:fake-/, '应退回 Blob');
  assert.equal(created.length, 1);
});

test('没注入宿主（老装配 / 单测）：直接 Blob，不碰网关', async () => {
  const files = new Map([['D:/m/a.flac', 1 * MB]]);
  const { src, created } = makeSource(files);
  const url = await src.resolveExternalPlayableUrl('D:/m/a.flac');
  assert.match(url, /^blob:fake-/);
  assert.equal(created.length, 1);
});

test('失败一次后本次会话不再主动启动网关；网关后来起来了就照用', async () => {
  const files = new Map([['D:/m/a.flac', 1 * MB]]);
  const ensureCalls = [];
  let ensureOk = false;
  const host = {
    base: 'http://127.0.0.1:54321',
    token: 'fixture-token',
    state: 'stopped',
    ensure: async () => {
      ensureCalls.push(1);
      return ensureOk;
    },
    allowStreamPaths: async () => true,
  };
  const { src } = makeSource(files, { streamHost: () => host });
  assert.match(await src.resolveExternalPlayableUrl('D:/m/a.flac'), /^blob:/);
  assert.equal(ensureCalls.length, 1);

  // 再切一首：网关还是 stopped，不该再在失败的启动上等一轮
  assert.match(await src.resolveExternalPlayableUrl('D:/m/a.flac'), /^blob:/);
  assert.equal(ensureCalls.length, 1, '失败后不再反复试启动');

  // 网关因别的功能（在线音源）起来了：照用 Range，不必等插件重载
  host.state = 'running';
  ensureOk = true;
  assert.match(await src.resolveExternalPlayableUrl('D:/m/a.flac'), /^http:/, 'state 回到 running 就恢复供流');
  assert.equal(ensureCalls.length, 2);
});

// ============ 引擎接线：local-external 必须走新口径 ============

test('引擎：local-external 取地址走 resolveExternalPlayableUrl（不是旧的 Blob 那条）', async () => {
  const source = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '../src/core/player-state.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text;
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
  const mod = { exports: {} };
  vm.runInNewContext(source, {
    module: mod,
    exports: mod.exports,
    require: (name) => {
      if (name === 'obsidian') {
        return { App: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (p) => p };
      }
      if (name === 'fs') return { existsSync: () => false, statSync: () => ({}), readdirSync: () => [] };
      if (name === 'path') return nodePath;
      throw new Error('Unexpected runtime import: ' + name);
    },
    Audio: AudioStub,
    URL,
    URLSearchParams,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  });

  const called = [];
  const local = {
    buildTracks: async () => [
      { source: 'local-external', path: 'D:/m/a.flac', title: 'a', duration: 1 },
    ],
    clearBlobs() {},
    keysOf: () => [],
    resolveVaultUrl: (f) => `vault://${f.path}`,
    resolveExternalUrl: (p) => {
      called.push('blob:' + p);
      return `blob://${p}`;
    },
    resolveExternalPlayableUrl: async (p) => {
      called.push('range:' + p);
      return `http://127.0.0.1:1/stream?path=${encodeURIComponent(p)}`;
    },
    resolveVaultBlobUrl: async () => 'blob://retry',
  };
  const engine = new mod.exports.PlaybackEngine({
    app: {},
    local,
    netease: { album: async () => ({ songs: [] }) },
    qq: null,
    settings: () => ({ defaultSource: 'auto', autoPlay: false, quality: 'higher' }),
  });
  await engine.loadAlbum({ path: 'X.md', title: 'X', audioRefs: [], file: { path: 'X.md' } });
  await engine.playIndex(0);
  assert.deepEqual(called, ['range:D:/m/a.flac'], '只走 Range 那条，不该再退回 Blob');
  assert.match(audioInstances[audioInstances.length - 1].src, /^http:\/\/127\.0\.0\.1:1\/stream/);
});
