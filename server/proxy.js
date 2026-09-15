// 出口代理（HTTP CONNECT）—— 网关自己跑在用户机器的 Node / Electron 里，
// 内置 fetch（undici）**不读系统代理**：于是出现「浏览器能打开封面、插件下载不了」这类
// 「同一台机器两个链路一个好一个坏」的怪象（见 README 的问题排查）。这里给网关补上同一条出口。
//
// 配置来源（按优先级）：
//   ① VINYL_PROXY —— 插件每次启动网关时写入「系统代理」（Electron session.resolveProxy 的结果）；
//      手动调试也可以直接指定：'http://127.0.0.1:7890'、'PROXY host:port'、'DIRECT'。
//   ② HTTPS_PROXY / HTTP_PROXY / ALL_PROXY —— 常规环境变量（值可以是 URL 或 host:port）。
//   ③ 都没有 → 直连。NO_PROXY（逗号分隔，支持 * 与后缀匹配）命中的主机一律直连。
//
// 只支持 HTTP 代理（CONNECT 隧道）；SOCKS / 无法识别的配置会记一条日志后按直连处理 ——
// 不支持的形态显式留痕，不做「静默半生效」。
// 手写隧道而不是引三方依赖：需要的就是「CONNECT + 把 socket 交给 http.request」这点代码。
const net = require('net');
const tls = require('tls');
const http = require('http');

/** 代理阶段的失败：带 vinylProxy 标记 —— 调用方（网关）据此原样上抛，不当作「目标不可达」 */
function proxyError(msgFn, key, params) {
  const err = new Error(msgFn(key, params));
  err.vinylProxy = true;
  return err;
}

/** 单个地址（'http://user:pass@host:port' / 'host:port'）→ http 代理配置 */
function httpProxyFrom(value, source, raw) {
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  // 裸形态先过一道形状检查：认不出的值（配置写错）显式标记，别当成国际化主机名去连
  if (!isUrl && !/^[A-Za-z0-9.\-_]+(:\d+)?$/.test(value)) {
    return { mode: 'unsupported', source, raw };
  }
  let url;
  try {
    url = isUrl ? new URL(value) : new URL('http://' + value);
  } catch (_) {
    return { mode: 'unsupported', source, raw };
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!url.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return { mode: 'unsupported', source, raw };
  }
  // 代理需要认证时：把 user:pass 变成 CONNECT 的 Proxy-Authorization 头
  const auth = url.username
    ? 'Basic ' +
      Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')
    : '';
  return { mode: 'http', host: url.hostname, port, auth, source, raw };
}

/** 代理配置字符串 → 配置对象。形态：'DIRECT' / 'PROXY host:port' / 'PROXY a:1; PROXY b:2; DIRECT' / 'http://h:p' / 'h:p' */
function parseProxySpec(raw, source) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/^direct$/i.test(text)) return { mode: 'direct', source, raw: text };
  // Electron resolveProxy 的「代理链」形态：取第一个可用条目（DIRECT 即直连，SOCKS 暂不支持）
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
      // 头之后的字节属于隧道数据：塞回流里，别丢；握手监听器摘掉，后续数据归消费者
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

/**
 * 把已建好的隧道 socket 交给 http 客户端。
 * 必须挂在 Agent 的 createConnection 上：http.request 的「agent: false + 每请求 createConnection」
 * 组合会被忽略（Node 只为 agent: false 造了个默认 Agent），结果 socket 直连出去 ——
 * 表现就是「明文打到 443 端口」（源站回 `The plain http request was sent to https port`）。
 */
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
        // 复制成精确长度的 ArrayBuffer：Buffer.concat 的底层池子可能更大
        const out = new Uint8Array(b.length);
        out.set(b);
        return out.buffer;
      }),
    body: {
      // qq.js 的 CDN 探测会先判 typeof cancel==='function' 再调；给它一个同形的实现
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
        // 显式写 Host：隧道里 http 客户端不知道自己在跟 https 目标说话，默认会带上 :443
        headers: { ...(options.headers || {}), Host: target.host },
        agent: tunnelAgent(stream),
        signal,
      },
      (res) => {
        // 请求结束后一并回收隧道（非 keep-alive；每次请求一条隧道，语义最直白）
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
      // 丢弃这一跳的响应体（destroy 隧道），按 Location 继续
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
 * 可代理的 fetch 封装：签名与 fetch 同形 —— (url, options) => Promise<Response 同形对象>。
 * - 直连配置（或 NO_PROXY 命中）→ 原样转发给 baseFetch（网关传内置 fetch），行为与从前完全一致，
 *   测试里对 fetch 的桩也照样生效；
 * - 有代理 → CONNECT 隧道（https 目标在隧道上再套 TLS），此模式下不经 baseFetch。
 * 代理**自身**的失败带 vinylProxy 标记，调用方原样上抛（别当成「目标不可达」吞掉原因）。
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
