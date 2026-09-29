// 音频供流的中断路径（真网关、注入式 I/O）：<audio> 拖进度条 / 切曲 / 关播放器会**中断**上一次 Range
// 请求，走的是响应的 close 事件（不是读流的 error）—— 只 pipe 的话 Node 把读流 unpipe 掉就完了，
// fs.ReadStream 不 destroy 就一直攥着 fd：每中断一次漏一个，几百次后 fd 预算见底，所有供流 / 写凭据 /
// 建连一起失败（自愈只看进程退出）。这里不数 OS 句柄（跨平台不稳），改用探针看「中断之后读流有没有被销毁」。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const TOKEN = 'stream-fd-token';
const AUDIO = path.resolve(__dirname, 'fixture-track.mp3');

function fakeReadStream() {
  const calls = { destroy: 0, piped: 0 };
  return {
    calls,
    on: () => undefined,
    pipe() {
      calls.piped++;
    },
    destroy() {
      calls.destroy++;
    },
  };
}

function fakeReq(url, method = 'GET', headers = {}) {
  const handlers = {};
  return {
    url,
    method,
    headers,
    on(event, cb) {
      (handlers[event] || (handlers[event] = [])).push(cb);
      if (event === 'end') cb(); // 测试里没有请求体：注册即触发
      return this;
    },
  };
}

function fakeRes() {
  const handlers = {};
  return {
    status: 0,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || null;
    },
    end(text) {
      this.body = text;
    },
    destroy() {},
    on(event, cb) {
      (handlers[event] || (handlers[event] = [])).push(cb);
      return this;
    },
    emit(event) {
      for (const cb of handlers[event] || []) cb();
    },
  };
}

/** 真网关跑在 vm 里，只把 fs / http 换成桩：fs.createReadStream 换成探针 */
function gatewayWith() {
  const filename = path.resolve(__dirname, '../server/gateway.js');
  const requireFromGateway = createRequire(filename);
  const streams = [];
  let serverHandler = null;
  const context = {
    require(name) {
      if (name === 'fs') {
        return {
          readFileSync: () => '',
          writeFileSync: () => undefined,
          appendFileSync: () => undefined,
          statSync: () => ({ size: 4096, isFile: () => true }),
          createReadStream: () => {
            const s = fakeReadStream();
            streams.push(s);
            return s;
          },
          unlinkSync: () => undefined,
          renameSync: () => undefined,
        };
      }
      if (name === 'dns') {
        return { lookup: (hostname, options, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]) };
      }
      if (name === 'http') {
        return {
          createServer: (handler) => {
            serverHandler = handler;
            return { listen() {}, on() {} };
          },
        };
      }
      return requireFromGateway(name);
    },
    process: {
      env: {
        VINYL_COOKIE_FILE: '/test/.cookie',
        VINYL_TOKEN: TOKEN,
        VINYL_LOG_FILE: '/test/gateway.log',
      },
      pid: 1,
      uptime: () => 0,
    },
    __dirname: path.dirname(filename),
    console: { log() {}, error() {} },
    Buffer,
    URL,
    URLSearchParams,
    AbortSignal,
    setTimeout,
    clearTimeout,
    fetch: async () => {
      throw new Error('socket hang up');
    },
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(filename, 'utf8') + '\nglobalThis.testRoutes = routes;',
    context
  );
  return {
    streams,
    /** 走真实的分发路径（不是直接调 route handler）：鉴权 → 路由 → sendStreamFile */
    async request(range) {
      const url = `/api/local/stream?path=${encodeURIComponent(AUDIO)}&t=${TOKEN}`;
      const res = fakeRes();
      await serverHandler(
        fakeReq(url, 'GET', range ? { 'x-vinyl-token': TOKEN, range } : { 'x-vinyl-token': TOKEN }),
        res
      );
      return res;
    },
    allow(paths) {
      const route = context.testRoutes.find((r) => r.method === 'POST' && r.pattern.test('/api/local/allow'));
      assert.ok(route, '登记路由在');
      return route.handler({ query: {}, body: { paths }, cookie: '' });
    },
  };
}

test('供流：正常请求照旧发流，中断之前不销毁读流', async () => {
  const g = gatewayWith();
  await g.allow([AUDIO]);
  const res = await g.request('bytes=0-1023');
  assert.equal(res.status, 206, '单区间回 206');
  assert.equal(res.headers['Accept-Ranges'], 'bytes');
  assert.equal(g.streams.length, 1, '开了一条读流');
  assert.equal(g.streams[0].calls.piped, 1, '接上了响应');
  assert.equal(g.streams[0].calls.destroy, 0, '还没中断：不该销毁');
});

test('供流：客户端中断（res close）必须销毁读流，否则每中断一次漏一个 fd', async () => {
  const g = gatewayWith();
  await g.allow([AUDIO]);
  const res = await g.request('bytes=0-1023');
  res.emit('close'); // 拖进度条 / 切曲 / 关播放器：浏览器就是这么断的
  assert.equal(g.streams[0].calls.destroy, 1, '读流要销毁：fs.ReadStream 不 destroy 就攥着 fd');
});

test('供流：多次中断各销毁各的流（不是只认第一条）', async () => {
  const g = gatewayWith();
  await g.allow([AUDIO]);
  for (let i = 0; i < 3; i++) {
    const res = await g.request('bytes=0-1023');
    res.emit('close');
  }
  assert.equal(g.streams.length, 3);
  assert.equal(
    g.streams.filter((s) => s.calls.destroy === 1).length,
    3,
    '三次中断三条流都收干净'
  );
});

test('供流：没登记过的路径在碰文件系统之前就被挡下（不建读流）', async () => {
  const g = gatewayWith();
  const res = await g.request('bytes=0-1023');
  assert.equal(res.status, 403);
  assert.equal(g.streams.length, 0, '被拒的请求不该打开文件');
});
