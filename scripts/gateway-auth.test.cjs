const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Execute the real gateway and upstream endpoint modules. Only I/O is replaced;
// account cookies here are synthetic and never touch the installed plugin.
function gateway(qrCode, qrCookies = [], valid = true, opts = {}) {
  const filename = path.resolve(__dirname, '../server/gateway.js');
  const requireFromGateway = createRequire(filename);
  const files = new Map([
    ['/test/.cookie', 'MUSIC_U=existing-account'],
    ['/test/.anon-token', JSON.stringify({ token: 'fixture-anon', deviceId: 'fixture-device' })],
  ]);
  const requests = [];
  let serverHandler = null;
  const context = {
    require(name) {
      if (name === 'fs') return {
        readFileSync(file) { if (!files.has(file)) throw new Error('ENOENT'); return files.get(file); },
        writeFileSync(file, value) { files.set(file, value); },
        renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
        unlinkSync(file) { files.delete(file); },
        appendFileSync() {},
      };
      if (name === 'dns') {
        const realDns = requireFromGateway('dns');
        return {
          // 默认走真实解析（本机 / localhost 这类既有用例依赖它）；封面用例用 opts.dns 接管
          lookup: (hostname, options, cb) =>
            opts.dns ? opts.dns(hostname, options, cb) : realDns.lookup(hostname, options, cb),
        };
      }
      if (name === 'http') {
        return {
          createServer: (handler) => {
            serverHandler = handler;
            return { listen() {} };
          },
        };
      }
      return requireFromGateway(name);
    },
    process: {
      env: {
        VINYL_COOKIE_FILE: '/test/.cookie',
        VINYL_ANON_FILE: '/test/.anon-token',
        VINYL_TOKEN: 'fixture-token',
      },
      pid: 1,
      uptime: () => 0,
    },
    __dirname: path.dirname(filename),
    console: { log() {}, error() {} },
    Buffer, URL, URLSearchParams, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url) => {
      requests.push(url);
      // 用例可用 opts.fetch 接管（返回 falsy 则落回默认桩）
      if (opts.fetch) {
        const custom = await opts.fetch(String(url));
        if (custom) return custom;
      }
      const isQr = url.includes('qrcode/client/login');
      const body = isQr ? { code: qrCode } : {
        code: 200,
        account: valid ? { id: 123 } : null,
        profile: valid ? { userId: 123, nickname: 'Fixture user' } : null,
      };
      return { status: 200, text: async () => JSON.stringify(body), headers: {
        getSetCookie: () => isQr ? qrCookies : [],
      } };
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(filename, 'utf8') + '\nglobalThis.testRoutes = routes;', context);
  return {
    files, requests,
    call(method, url, data = {}, query = { key: 'fixture-qr' }) {
      const route = context.testRoutes.find(r => r.method === method && r.pattern.test(url));
      assert.ok(route, `${method} ${url} exists`);
      return route.handler({ query, body: data, cookie: '' });
    },
    /** 走真实请求入口（http.createServer 的回调）：用于测鉴权 / 响应头这类请求级行为 */
    async request(method, target, headers = {}) {
      assert.ok(serverHandler, '网关应注册了请求处理器');
      const res = {
        status: 0,
        headers: {},
        body: '',
        setHeader(k, v) { this.headers[k] = v; },
        writeHead(code, extra) { this.status = code; Object.assign(this.headers, extra || {}); return this; },
        end(chunk) { if (chunk) this.body += String(chunk); this.done = true; return this; },
      };
      const listeners = {};
      const req = {
        method,
        url: target,
        headers,
        on(ev, fn) {
          (listeners[ev] = listeners[ev] || []).push(fn);
          if (ev === 'end') setImmediate(() => fn());
          return this;
        },
      };
      serverHandler(req, res);
      for (let i = 0; i < 200 && !res.done; i++) await new Promise((r) => setImmediate(r));
      return res;
    },
  };
}

test('QR 803 saves a verified login session and does not expose the cookie', async () => {
  const g = gateway(803, ['MUSIC_U=new-account; HttpOnly; Path=/', '__csrf=fixture; Path=/']);
  const result = await g.call('GET', '/api/login/qr/check');
  assert.equal(result.code, 803);
  assert.match(g.files.get('/test/.cookie'), /MUSIC_U=new-account/);
  assert.equal(Object.hasOwn(result, 'cookie'), false);
});

test('QR 802 waits for confirmation and preserves the existing account', async () => {
  const g = gateway(802, ['NMTID=visitor; Path=/']);
  const result = await g.call('GET', '/api/login/qr/check');
  assert.equal(result.code, 802);
  assert.equal(g.requests.length, 1, 'no second authorization request while waiting');
  assert.equal(g.files.get('/test/.cookie'), 'MUSIC_U=existing-account');
});

test('QR 803 without MUSIC_U fails clearly and preserves the existing account', async () => {
  const g = gateway(803, ['NMTID=visitor; Path=/']);
  await assert.rejects(g.call('GET', '/api/login/qr/check'), /MUSIC_U|会话/);
  assert.equal(g.files.get('/test/.cookie'), 'MUSIC_U=existing-account');
});

// ============ 请求级：鉴权与响应头 ============

test('网关鉴权：没有 token 一律 401，带对 token（header 或 ?t=）才放行', async () => {
  const g = gateway(803);
  const anonymous = await g.request('GET', '/api/ping');
  assert.equal(anonymous.status, 401, '没有 token 的请求必须被拒');
  assert.equal(anonymous.headers['Access-Control-Allow-Origin'], undefined, '不得发 CORS 头');
  const wrong = await g.request('GET', '/api/ping', { 'x-vinyl-token': 'not-the-token' });
  assert.equal(wrong.status, 401, 'token 不对同样拒绝');
  const byHeader = await g.request('GET', '/api/ping', { 'x-vinyl-token': 'fixture-token' });
  assert.equal(byHeader.status, 200, 'header 带 token 放行');
  const byQuery = await g.request('GET', '/api/ping?t=fixture-token');
  assert.equal(byQuery.status, 200, '?t= 带 token 也放行（少数要进 DOM 的 URL 用这条路）');
});

test('封面代理：本机 / 内网 / 链路本地地址一律拒绝（防 SSRF）', async () => {
  const g = gateway(803);
  const blocked = [
    'http://127.0.0.1:9/cover.jpg',
    'http://localhost/cover.jpg',
    'http://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
  ];
  for (const url of blocked) {
    await assert.rejects(g.call('GET', '/api/cover', {}, { url }), /不可访问|无效/, `应拒绝 ${url}`);
  }
});

// ============ 请求级：封面代理的失败分流（这些文案会一路冒到导入提示） ============

const COVER_URL = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000001mvhPh0qevad.jpg';
const publicDns = (hostname, options, cb) => cb(null, [{ address: '203.0.113.10', family: 4 }]);

/** 假流式响应：fetchBinary 按 res.body.getReader() 逐块读 */
function imageResponse(chunks, contentType = 'image/jpeg', status = 200) {
  let i = 0;
  return {
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
        cancel: async () => {},
      }),
    },
  };
}

test('封面代理：正常图片按二进制返回并带上 Content-Type', async () => {
  const g = gateway(803, [], true, {
    dns: publicDns,
    fetch: async () => imageResponse([new Uint8Array([1, 2, 3])]),
  });
  const result = await g.call('GET', '/api/cover', {}, { url: COVER_URL });
  assert.equal(result.contentType, 'image/jpeg');
  assert.deepEqual(Array.from(result.binary), [1, 2, 3]);
});

test('封面代理：源站 404 报「不存在」，不再误报「不是图片」', async () => {
  const g = gateway(803, [], true, {
    dns: publicDns,
    fetch: async () => ({ status: 404, headers: { get: () => 'text/plain' } }),
  });
  await assert.rejects(g.call('GET', '/api/cover', {}, { url: COVER_URL }), /不存在/);
});

test('封面代理：源站 5xx 报出状态码', async () => {
  const g = gateway(803, [], true, {
    dns: publicDns,
    fetch: async () => ({ status: 502, headers: { get: () => 'text/html' } }),
  });
  await assert.rejects(g.call('GET', '/api/cover', {}, { url: COVER_URL }), /HTTP 502/);
});

test('封面代理：200 但内容不是图片 → 仍是「不是图片」', async () => {
  const g = gateway(803, [], true, {
    dns: publicDns,
    fetch: async () => imageResponse([], 'text/html'),
  });
  await assert.rejects(g.call('GET', '/api/cover', {}, { url: COVER_URL }), /不是图片/);
});

test('封面代理：DNS 解析失败与「解析到内网」分开报（排查方向不同）', async () => {
  const g = gateway(803, [], true, {
    dns: (hostname, options, cb) => cb(new Error('ENOTFOUND')),
    fetch: async () => imageResponse([]),
  });
  await assert.rejects(g.call('GET', '/api/cover', {}, { url: COVER_URL }), /无法解析/);

  const g2 = gateway(803, [], true, {
    dns: (hostname, options, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
  });
  await assert.rejects(g2.call('GET', '/api/cover', {}, { url: COVER_URL }), /不可访问/);
});

test('封面代理：连接失败 / 超时 → 中文可达性文案（不透出 undici 英文报错）', async () => {
  const g = gateway(803, [], true, {
    dns: publicDns,
    fetch: async () => {
      throw new Error('The operation was aborted due to timeout');
    },
  });
  await assert.rejects(g.call('GET', '/api/cover', {}, { url: COVER_URL }), /连接失败或超时/);
});
