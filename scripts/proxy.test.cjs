// 网关出站代理回归：配置解析（VINYL_PROXY / 常规环境变量 / NO_PROXY）+ HTTP CONNECT 隧道端到端。
// 端到端用本地假代理 + 本地真源站，不碰外网 —— 覆盖的正是「浏览器能取到封面、网关取不到」的修复面。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const {
  parseProxySpec,
  resolveProxyConfig,
  hostBypassed,
  createProxyFetch,
} = require('../server/proxy.js');

// 与网关同一个注入约定：msg(key, params) → 文案；测试里返回「键:参数」，断言认键。
const msg = (key, params) => key + (params ? ':' + JSON.stringify(params) : '');
const fetchLike = (...args) => globalThis.fetch(...args);

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** 测试结束必须收掉监听（否则事件循环不空，测试进程退不出去） */
const closeServer = (server) =>
  new Promise((resolve) => {
    try {
      server.closeAllConnections?.(); // 隧道连接还挂着时，close 会一直等
    } catch (_) {}
    server.close(() => resolve());
  });

async function startOrigin(t, handler) {
  const server = http.createServer(handler);
  const port = await listen(server);
  t.after(() => closeServer(server));
  return { server, port, url: `http://127.0.0.1:${port}` };
}

/**
 * 记录 CONNECT 目标的 HTTP 代理（真隧道，双向 pipe）。
 * - opts.origin：把 CONNECT 的 tunnel.test 映射到本地真源站 —— 这样「请求真的过了隧道」
 *   才是唯一可能的成功路径（直连 tunnel.test 解析不了），弱断言骗不过去；
 * - opts.captureFirst：只收下隧道里的第一批字节就断开，用于验证 https 目标确实在隧道上做 TLS。
 */
async function startProxy(t, { origin = null, captureFirst = false } = {}) {
  const seen = [];
  const firstBytes = [];
  const server = http.createServer((req, res) => {
    seen.push(`http:${req.url}`);
    res.writeHead(400);
    res.end();
  });
  server.on('connect', (req, clientSocket, head) => {
    const raw = String(req.url);
    seen.push(`connect:${raw}`);
    if (captureFirst) {
      // 先回 CONNECT 成功（客户端要等它才继续），再收第一批字节就断开
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      clientSocket.once('data', (chunk) => {
        firstBytes.push(Buffer.from(chunk));
        clientSocket.destroy();
      });
      return;
    }
    const i = raw.lastIndexOf(':');
    let host = raw.slice(0, i);
    let port = Number(raw.slice(i + 1));
    if (origin && host === 'tunnel.test') {
      host = '127.0.0.1';
      port = origin.port;
    }
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  const port = await listen(server);
  t.after(() => closeServer(server));
  return { server, port, seen, firstBytes };
}

/** 占一个端口再立刻关掉：得到一个确定「没人监听」的端口 */
async function closedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const proxyConfig = (overrides = {}) => ({
  mode: 'http',
  host: '127.0.0.1',
  port: 0,
  noProxy: '',
  source: 'test',
  raw: 'test',
  ...overrides,
});

// ============ 配置解析 ============

test('parseProxySpec：DIRECT / PROXY 链 / URL（含认证）/ host:port / SOCKS 不支持', () => {
  assert.equal(parseProxySpec('DIRECT', 'x').mode, 'direct');
  assert.deepEqual({ ...parseProxySpec('PROXY 127.0.0.1:7890; DIRECT', 'VINYL_PROXY') }, {
    mode: 'http',
    host: '127.0.0.1',
    port: 7890,
    auth: '',
    source: 'VINYL_PROXY',
    raw: 'PROXY 127.0.0.1:7890; DIRECT',
  });
  const url = parseProxySpec('http://user:pass@10.0.0.2:8080', 'HTTPS_PROXY');
  assert.equal(url.mode, 'http');
  assert.equal(url.host, '10.0.0.2');
  assert.equal(url.auth, 'Basic ' + Buffer.from('user:pass').toString('base64'), '认证转成 Proxy-Authorization');
  assert.equal(parseProxySpec('10.0.0.2:8080', 'HTTP_PROXY').port, 8080, '裸 host:port 也认');
  assert.equal(parseProxySpec('SOCKS5 127.0.0.1:1080', 'ALL_PROXY').mode, 'unsupported');
  assert.equal(parseProxySpec('这不是地址', 'VINYL_PROXY').mode, 'unsupported', '认不出的形态显式标记');
  assert.equal(parseProxySpec('', 'X'), null);
});

test('resolveProxyConfig：VINYL_PROXY 优先于环境变量；DIRECT 是明确结论；NO_PROXY 原样带出', () => {
  assert.equal(resolveProxyConfig({}).mode, 'direct');
  const prefer = resolveProxyConfig({
    VINYL_PROXY: 'PROXY 127.0.0.1:7890',
    HTTPS_PROXY: 'http://10.0.0.1:1',
    NO_PROXY: 'localhost',
  });
  assert.equal(prefer.host, '127.0.0.1', '插件注入的系统代理优先');
  assert.equal(prefer.source, 'VINYL_PROXY');
  assert.equal(prefer.noProxy, 'localhost');
  const env = resolveProxyConfig({ https_proxy: 'http://10.0.0.1:3128' });
  assert.equal(env.mode, 'http');
  assert.equal(env.port, 3128, '小写环境变量同样生效');
  assert.equal(resolveProxyConfig({ VINYL_PROXY: 'DIRECT', HTTPS_PROXY: 'http://10.0.0.1:1' }).mode, 'direct');
});

test('hostBypassed：* / 精确 / 后缀 / 带端口；后缀不误伤近似域名', () => {
  assert.equal(hostBypassed('y.qq.com', '*'), true);
  assert.equal(hostBypassed('y.qq.com', 'qq.com'), true);
  assert.equal(hostBypassed('y.qq.com', '.qq.com'), true);
  assert.equal(hostBypassed('y.qq.com', 'music.163.com'), false);
  assert.equal(hostBypassed('music.163.com', 'music.163.com:443'), true);
  assert.equal(hostBypassed('qq.com.evil.com', 'qq.com'), false);
});

// ============ 隧道端到端 ============

test('CONNECT 隧道：状态 / 头 / 正文 / 二进制 / 重定向都按 fetch 语义回传', async (t) => {
  const origin = await startOrigin(t, (req, res) => {
    if (req.url === '/bytes') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.end(Buffer.from([1, 2, 3, 255]));
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/hello' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/'],
    });
    res.end(JSON.stringify({ host: req.headers.host, path: req.url }));
  });
  const proxy = await startProxy(t, { origin });
  const proxyFetch = createProxyFetch(fetchLike, proxyConfig({ port: proxy.port }), { msg });
  // tunnel.test 本地解析不了：请求成功 ⇒ 一定走了代理隧道（直连假绿骗不过去）
  const base = 'http://tunnel.test:8080';

  const res = await proxyFetch(`${base}/hello?x=1`);
  assert.equal(res.status, 200);
  assert.ok(proxy.seen.includes('connect:tunnel.test:8080'), '必须经代理隧道取数');
  assert.deepEqual(res.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/'], '多值 Set-Cookie 完整保留（QQ Cookie 链依赖）');
  const body = JSON.parse(await res.text());
  assert.equal(body.path, '/hello?x=1');
  assert.equal(body.host, 'tunnel.test:8080', 'Host 头按目标原样');

  const bin = await (await proxyFetch(`${base}/bytes`)).arrayBuffer();
  assert.deepEqual(Array.from(new Uint8Array(bin)), [1, 2, 3, 255], '二进制按精确长度回传');

  const followed = await proxyFetch(`${base}/redirect`);
  assert.equal(followed.status, 200);
  assert.equal((await followed.json()).path, '/hello', '默认跟随重定向（qq.js 的 CDN 探测依赖）');

  const manual = await proxyFetch(`${base}/redirect`, { redirect: 'manual' });
  assert.equal(manual.status, 302);
  assert.equal(manual.headers.get('location'), '/hello', 'manual 模式 3xx 与 Location 必须可读');

  const streamed = await proxyFetch(`${base}/hello`);
  const reader = streamed.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false, 'body.getReader 可流式读取（封面下载用）');
  await reader.cancel();
  assert.equal(typeof streamed.body.cancel, 'function', 'body.cancel 同形（QQ CDN 探测用）');
});

test('https 目标：隧道里做的是 TLS（不是把明文打到 443 端口）', async (t) => {
  const proxy = await startProxy(t, { captureFirst: true });
  const proxyFetch = createProxyFetch(fetchLike, proxyConfig({ port: proxy.port }), { msg });
  await assert.rejects(proxyFetch('https://tunnel.test/', { signal: AbortSignal.timeout(5000) }));
  assert.equal(proxy.seen.length, 1, '先完成 CONNECT');
  const hello = proxy.firstBytes[0];
  assert.ok(hello && hello.length > 0, '隧道里应收到字节');
  assert.equal(
    hello[0],
    0x16,
    '首个字节应是 TLS 握手记录 0x16；若是 0x47（"G"）说明把明文 HTTP 发到了 TLS 端口'
  );
});

test('直连配置 / NO_PROXY 命中：完全不碰代理，仍是内置 fetch', async (t) => {
  const origin = await startOrigin(t, (req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  const proxy = await startProxy(t);
  assert.equal(createProxyFetch(fetchLike, { mode: 'direct' }), fetchLike, '直连时原样返回 baseFetch');

  const bypass = createProxyFetch(fetchLike, proxyConfig({ port: proxy.port, noProxy: '127.0.0.1' }), { msg });
  const res = await bypass(`${origin.url}/x`);
  assert.equal(await res.text(), 'ok');
  assert.equal(proxy.seen.length, 0, 'NO_PROXY 命中不该碰代理');
});

// ============ 失败分流 ============

test('代理连不上：报「代理连接失败」并带 vinylProxy 标记', async () => {
  const port = await closedPort();
  const proxyFetch = createProxyFetch(fetchLike, proxyConfig({ port }), { msg });
  await assert.rejects(
    proxyFetch('http://127.0.0.1:9/x'),
    (e) => e.vinylProxy === true && /gw\.proxyFailed/.test(e.message),
    '代理自身的失败要能被网关识别、原样上抛'
  );
});

test('代理拒绝建立隧道：报 HTTP 状态码', async (t) => {
  const server = http.createServer();
  server.on('connect', (_req, socket) => {
    socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    socket.destroy();
  });
  t.after(() => closeServer(server));
  const port = await listen(server);
  const proxyFetch = createProxyFetch(fetchLike, proxyConfig({ port }), { msg });
  await assert.rejects(proxyFetch('http://127.0.0.1:9/x'), /gw\.proxyRejected.*407/);
});

test('已取消的请求：立刻拒绝，不挂在隧道上', async (t) => {
  const proxy = await startProxy(t);
  const proxyFetch = createProxyFetch(fetchLike, proxyConfig({ port: proxy.port }), { msg });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    proxyFetch('http://127.0.0.1:9/x', { signal: ac.signal }),
    (e) => e.vinylProxy === true && /gw\.proxyTimeout/.test(e.message)
  );
});
