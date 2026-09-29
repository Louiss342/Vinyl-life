// 出口代理（HTTP CONNECT）：网关跑在用户的 Node / Electron 里，内置 fetch（undici）不读系统代理，
// 于是出现「浏览器能打开封面、插件下载不了」这类同机双链路不一致的怪象，这里补上同一条出口。
// 配置优先级：VINYL_PROXY（启动网关时写入 Electron session.resolveProxy 的结果）→
// HTTPS_PROXY / HTTP_PROXY / ALL_PROXY → 直连；NO_PROXY 命中的一律直连。
// 只支持 HTTP 代理（CONNECT 隧道）：SOCKS / 认不出的配置记日志后按直连（显式留痕，不「静默半生效」）。
const net = require('net');
const tls = require('tls');
const http = require('http');

/** 代理阶段的失败：带 vinylProxy 标记，调用方（网关）据此原样上抛，不当作「目标不可达」 */
function proxyError(msgFn, key, params) {
  const err = new Error(msgFn(key, params));
  err.vinylProxy = true;
  return err;
}

/** 单个地址（URL / `host:port` / `user:pass@host:port`）→ http 代理配置 */
function httpProxyFrom(value, source, raw) {
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  // 裸形态先过形状检查：认不出的显式标记（别当主机名去连）；`user:pass@host:port` 也要认 —— curl 系工具的常规写法，不认就一路 direct 还被记成「配置写错」。
  const bareHost = /^[A-Za-z0-9.\-_]+(:\d+)?$/;
  const bareWithAuth = /^[^@\s/]+@[A-Za-z0-9.\-_]+(:\d+)?$/;
  if (!isUrl && !bareHost.test(value) && !bareWithAuth.test(value)) {
    return { mode: 'unsupported', source, raw };
  }
  let url;
  try {
    url = isUrl ? new URL(value) : new URL('http://' + value);
  } catch (_) {
    return { mode: 'unsupported', source, raw };
  }
  // 只认 http/https：CONNECT 隧道只对这两种协议成立。SOCKS 按不支持处理 = 直连，用户立刻看得出
  //「代理没生效」；照 HTTP 代理解析会把请求全发往一个 SOCKS 端口，日志却写着「经代理」，带偏排查。
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { mode: 'unsupported', source, raw };
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!url.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return { mode: 'unsupported', source, raw };
  }
  // 代理要认证时：user:pass → CONNECT 的 Proxy-Authorization 头
  const auth = url.username
    ? 'Basic ' +
      Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')
    : '';
  return { mode: 'http', host: url.hostname, port, auth, source, raw };
}

/** 代理配置字符串 → 配置对象。形态：DIRECT / `PROXY host:port` / `PROXY a:1; PROXY b:2; DIRECT` / `http://h:p` / `h:p` */
function parseProxySpec(raw, source) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^direct$/i.test(text)) return { mode: 'direct', source, raw: text };
  // Electron resolveProxy 的「代理链」形态：取第一个可用条目（DIRECT 即直连）
  if (/(^|;)\s*(PROXY|SOCKS5?|HTTPS?|DIRECT)\s/i.test(text)) {
    for (const part of text.split(';')) {
      const m = /^\s*(PROXY|SOCKS5?|HTTPS?|DIRECT)\s*(.*)$/i.exec(part);
      if (!m) continue;
      const kind = m[1].toUpperCase();
      const value = m[2].trim();
      if (kind === 'DIRECT') return { mode: 'direct', source, raw: text };
      if (kind === 'SOCKS5' || kind === 'SOCKS') return { mode: 'unsupported', source, raw: text };
      if (!value) continue;
      return httpProxyFrom(value, source, text);
    }
    return { mode: 'direct', source, raw: text };
  }
  return httpProxyFrom(text, source, text);
}

/** 环境变量 → 代理配置（VINYL_PROXY 优先于常规 env；NO_PROXY 原样带出，逐请求判断） */
function resolveProxyConfig(env = {}) {
  const pick = (upper, lower) => {
    const v = env[upper] || env[lower];
    return v == null ? '' : String(v);
  };
  const noProxy = pick('NO_PROXY', 'no_proxy');
  const candidates = [
    ['VINYL_PROXY', pick('VINYL_PROXY', 'vinyl_proxy')],
    ['HTTPS_PROXY', pick('HTTPS_PROXY', 'https_proxy')],
    ['HTTP_PROXY', pick('HTTP_PROXY', 'http_proxy')],
    ['ALL_PROXY', pick('ALL_PROXY', 'all_proxy')],
  ];
  for (const [source, value] of candidates) {
    if (!value.trim()) continue;
    const spec = parseProxySpec(value, source);
    if (spec) return { ...spec, noProxy };
  }
  return { mode: 'direct', source: '', raw: '', noProxy };
}

/** NO_PROXY 命中判断（'*' / 精确主机 / 后缀；条目允许带端口，匹配时忽略） */
function hostBypassed(hostname, noProxy) {
  const host = String(hostname || '').toLowerCase();
  const list = String(noProxy || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const entry of list) {
    if (entry === '*') return true;
    const rule = entry.replace(/^\./, '').split(':')[0];
    if (!rule) continue;
    if (host === rule || host.endsWith('.' + rule)) return true;
  }
  return false;
}

/** 经代理建立到 host:port 的隧道（CONNECT 握手完成后 resolve 出裸 socket） */
function connectViaProxy(proxy, host, port, signal, msg) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      fn(arg);
    };
    const onAbort = () => {
      sock.destroy();
      done(reject, proxyError(msg, 'gw.proxyTimeout'));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener?.('abort', onAbort, { once: true });
    }
    let buf = '';
    sock.on('connect', () => {
      const auth = proxy.auth ? `Proxy-Authorization: ${proxy.auth}\r\n` : '';
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    });
    const onHandshakeData = (chunk) => {
      if (settled) return;
      buf += chunk.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const status = Number((/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(buf) || [])[1]);
      if (status !== 200) {
        sock.destroy();
        done(reject, proxyError(msg, 'gw.proxyRejected', { status: status || '?' }));
        return;
      }
      // 头之后的字节属于隧道数据：塞回流里别丢；摘掉握手监听器，后续数据归消费者
      const rest = Buffer.from(buf.slice(end + 4), 'latin1');
      if (rest.length) sock.unshift(rest);
      sock.removeListener('data', onHandshakeData);
      done(resolve, sock);
    };
    sock.on('data', onHandshakeData);
    sock.on('error', (e) => {
      sock.destroy();
      done(reject, proxyError(msg, 'gw.proxyFailed', { msg: String((e && e.message) || e) }));
    });
  });
}

/** 把隧道 socket 交给 http 客户端：必须挂在 Agent 的 createConnection 上 —— http.request 的「agent: false + 每请求 createConnection」会被忽略（Node 给它造了默认 Agent），socket 直连出去，表现是「明文打到 443 端口」。 */
function tunnelAgent(stream) {
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = () => stream;
  return agent;
}

/** IncomingMessage → fetch 风格的响应对象（网关各处只用到这些成员） */
function adaptResponse(res) {
  const headerValue = (name) => {
    const v = res.headers[String(name).toLowerCase()];
    return Array.isArray(v) ? v.join(', ') : v == null ? null : String(v);
  };
  const collect = () =>
    new Promise((resolve, reject) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
  return {
    status: res.statusCode,
    ok: res.statusCode >= 200 && res.statusCode < 300,
    headers: {
      get: headerValue,
      getSetCookie: () => {
        const v = res.headers['set-cookie'];
        return Array.isArray(v) ? v : v ? [v] : [];
      },
    },
    text: () => collect().then((b) => b.toString('utf8')),
    json: () => collect().then((b) => JSON.parse(b.toString('utf8'))),
    arrayBuffer: () =>
      collect().then((b) => {
        // 复制成精确长度：Buffer.concat 的底层池子可能更大
        const out = new Uint8Array(b.length);
        out.set(b);
        return out.buffer;
      }),
    body: {
      // qq.js 的 CDN 探测会先判 typeof cancel==='function' 再调：给个同形实现
      cancel: () => {
        res.destroy();
        return Promise.resolve();
      },
      getReader: () => {
        let ended = res.readableEnded === true;
        let failure = null;
        const queue = [];
        const waiters = [];
        res.on('data', (c) => {
          if (waiters.length) waiters.shift().resolve({ value: c, done: false });
          else queue.push(c);
        });
        res.on('end', () => {
          ended = true;
          while (waiters.length) waiters.shift().resolve({ value: undefined, done: true });
        });
        res.on('error', (e) => {
          ended = true;
          failure = e;
          while (waiters.length) waiters.shift().reject(e);
        });
        return {
          read: () => {
            if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
            if (failure) return Promise.reject(failure);
            if (ended) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
          },
          cancel: () => {
            res.destroy();
            return Promise.resolve();
          },
        };
      },
    },
  };
}

/** 一步（不跟重定向）的隧道请求 */
async function proxiedOnce(target, options, config, msg) {
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const signal = options.signal;
  const socket = await connectViaProxy(config, target.hostname, port, signal, msg);
  let stream = socket;
  if (target.protocol === 'https:') {
    stream = tls.connect({ socket, servername: target.hostname, ALPNProtocols: ['http/1.1'] });
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        stream.destroy();
        reject(proxyError(msg, 'gw.proxyTimeout'));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener?.('abort', onAbort, { once: true });
      }
      stream.once('secureConnect', () => {
        signal?.removeEventListener?.('abort', onAbort);
        resolve();
      });
      stream.once('error', reject);
    });
  }
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        method: (options.method || 'GET').toUpperCase(),
        // 显式写 Host：隧道里 http 客户端不知道目标其实是 https，默认会带上 :443
        headers: { ...(options.headers || {}), Host: target.host },
        agent: tunnelAgent(stream),
        signal,
      },
      (res) => {
        // 请求结束后一并回收隧道（非 keep-alive：每请求一条隧道，语义最直白）
        res.once('close', () => {
          try {
            stream.destroy();
          } catch (_) {}
        });
        resolve(adaptResponse(res));
      }
    );
    req.on('error', reject);
    if (options.body != null) req.write(options.body);
    req.end();
  });
}

/** 走代理的取数：逐跳处理重定向（fetch 默认跟随；manual 交由调用方） */
async function proxiedFetch(target, options, config, msg) {
  let current = target;
  for (let hop = 0; hop <= 5; hop++) {
    const res = await proxiedOnce(current, options, config, msg);
    const location = res.headers.get('location');
    const redirect = options.redirect !== 'manual';
    if (redirect && res.status >= 300 && res.status < 400 && location) {
      // 丢弃这一跳的响应体（销毁隧道），按 Location 继续
      try {
        await res.body.getReader().cancel();
      } catch (_) {}
      current = new URL(location, current);
      continue;
    }
    return res;
  }
  throw new Error('too many redirects');
}

/**
 * 可代理的 fetch 封装（签名同 fetch）：直连 / NO_PROXY 命中时原样转发 baseFetch（测试里的 fetch 桩照旧生效），有代理时
 * 走 CONNECT 隧道（https 再套 TLS）而不经 baseFetch。代理自身的失败带 vinylProxy 标记 —— 调用方原样上抛，别当「目标不可达」。
 */
function createProxyFetch(baseFetch, config, deps = {}) {
  const msg = deps.msg || ((key) => key);
  const proxied = config && config.mode === 'http' ? config : null;
  if (!proxied) return baseFetch;
  return async (url, options = {}) => {
    const target = new URL(String(url));
    if (hostBypassed(target.hostname, proxied.noProxy)) {
      return baseFetch(url, options);
    }
    return proxiedFetch(target, options, proxied, msg);
  };
}

module.exports = { parseProxySpec, resolveProxyConfig, hostBypassed, createProxyFetch };
