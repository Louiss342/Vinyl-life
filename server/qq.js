// QQ 音乐网关模块（登录 + 播放）——纯函数 + 依赖注入。
//
// ⚠ 测试纪律（务必遵守）：本模块被 gateway.js require，而测试 harness 以 vm 方式执行
//   gateway.js 并替换其作用域内的 fs / http / fetch —— 但被 require 的模块拿到的是
//   【真实】全局与模块系统。因此本文件绝不能：
//     · require('fs' / 'http' / 'https' / 'crypto' / 任何模块) → 一切依赖由 gateway.js 注入
//     · 裸调 fetch / 直接文件读写 → 只用 deps 里的注入版本
//   允许直接使用的只有纯全局：Buffer / URL / URLSearchParams / Math / Date / JSON。
//
// deps = { route, log, fetch, makeStore, timeout, crypto, cookieFile, guidFile }
//   route(method, pattern, handler) 注册路由；log(...) 写日志；fetch(url, opts) 发请求；
//   makeStore(file) → { read(), write(v) } 凭据文件；timeout(ms) → AbortSignal；
//   crypto → node:crypto（仅 zza 签名后备用）；cookieFile / guidFile → 本模块凭据路径。
//
// 上游约束：vkey 取链可不带 sign；sip 的 http CDN 支持 https + Range(206)、无需 Referer
//   ⇒ 只做 http→https 改写，不做音频代理。strMediaMid ≠ songmid（vkey filename 优先 mediaMid，
//   空 purl 时回退 songmid 再试）；空 purl = 无权限（无错误码可映射），试听曲目同样给 purl。
//
// 扫码码（ptuiCB 首参）：66 待扫 / 67 已扫待确认 / 65 过期 / 0 成功
//   → 网关内归一化为 801 / 802 / 800 / 803（客户端弹窗协议与网易云一致）。
// 成功链：check_sig（收 p_skey / p_uin / pt4_token）→ g_tk(p_skey) → graph.qq.com/oauth2.0/authorize
//   （302 Location 取 code）→ musicu.fcg QQConnectLogin.LoginServer/QQLogin → 最终 Cookie（含 qm_keyst）。
'use strict';

const UA_QQ =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PTLOGIN_APPID = '716027609';
const PTLOGIN_DAID = '383';
const PT_3RD_AID = '100497308';
const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const ALBUM_URL = 'https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg';
const LYRIC_URL = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg';
const OAUTH_URL = 'https://graph.qq.com/oauth2.0/authorize';
const LOGIN_JUMP_URL = 'https://graph.qq.com/oauth2.0/login_jump';
// 官方扫码流程会先加载 xlogin 页，拿到 pt_login_sig 并在 ptqrlogin 里回传 login_sig；
// 缺这个值时会话无法与"手机确认"绑定，二维码会一直停在 67「二维码认证中」。
const XLOGIN_URL = 'https://xui.ptlogin2.qq.com/cgi-bin/xlogin';

// 音质档位 → vkey filename 前缀（higher 与 exhigh 同为 320k，QQ 无 192k 档）
const LEVELS = {
  standard: { prefix: 'M500', ext: '.mp3', br: 128000, type: 'mp3' },
  higher: { prefix: 'M800', ext: '.mp3', br: 320000, type: 'mp3' },
  exhigh: { prefix: 'M800', ext: '.mp3', br: 320000, type: 'mp3' },
  lossless: { prefix: 'F000', ext: '.flac', br: 999000, type: 'flac' },
};
const LEVEL_ORDER = ['standard', 'higher', 'exhigh', 'lossless'];
const MID_RE = /^[A-Za-z0-9]{8,24}$/;

// ==================== 纯工具 ====================

// qrsig → ptqrtoken（腾讯登录 hash33）
function hash33(str) {
  let e = 0;
  for (let i = 0; i < str.length; i++) e += (e << 5) + str.charCodeAt(i);
  return 2147483647 & e;
}

// p_skey → g_tk（CSRF token）
function getGtk(skey) {
  let h = 5381;
  for (let i = 0; i < skey.length; i++) h += (h << 5) + skey.charCodeAt(i);
  return h & 0x7fffffff;
}

function cookieToObj(cookie) {
  const obj = {};
  if (!cookie) return obj;
  for (const part of String(cookie).split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) obj[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return obj;
}

function cookieHeader(obj) {
  return Object.entries(obj)
    .filter(([k, v]) => k && v !== '' && v != null)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function getSetCookies(res) {
  try {
    if (res && res.headers && typeof res.headers.getSetCookie === 'function') {
      return res.headers.getSetCookie() || [];
    }
  } catch (_) {}
  try {
    const raw = res && res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('set-cookie')
      : null;
    return raw ? [raw] : [];
  } catch (_) {
    return [];
  }
}

// Set-Cookie 合并（跨跳持久化）：同一 Cookie 名可能多次下发（不同 Domain/Path，含“删除型”空值，
// 如 check_sig 对 p_uin / p_skey 各下发两次）。规则：空值不覆盖已有值；非空值按最后一条为准
// —— 按最后一条无脑覆盖时，空值会把有效票据冲掉。
function mergeSetCookies(jar, setCookies) {
  for (const c of setCookies || []) {
    const first = String(c).split(';')[0];
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    if (value === '') {
      if (!(name in jar)) jar[name] = '';
      continue;
    }
    jar[name] = value;
  }
  return jar;
}

// 诊断用：Set-Cookie 形状摘要（名字|Domain|Path|值长度|空/删除标记），绝不含值本身。
function setCookieShape(setCookies) {
  return (setCookies || [])
    .map((c) => {
      const s = String(c);
      const first = s.split(';')[0];
      const i = first.indexOf('=');
      const name = (i > 0 ? first.slice(0, i) : first).trim();
      const value = i > 0 ? first.slice(i + 1).trim() : '';
      const attr = (re) => {
        const x = re.exec(s);
        return x ? x[1].trim() : '';
      };
      const dom = attr(/;\s*domain=([^;]+)/i) || 'host';
      const p = attr(/;\s*path=([^;]+)/i) || '/';
      const del = /;\s*expires=[^;]*1970/i.test(s) || /;\s*max-age=0/i.test(s);
      return `${name}[${dom}${p} v${value.length}${value === '' ? ' EMPTY' : ''}${del ? ' DEL' : ''}]`;
    })
    .join(' ');
}

// ptuiCB('66','0','','0','...','') → { code, subCode, url, msg, nick }；无法解析返回 null
// 官方字段数不固定（成功响应 7 字段，尾部可能还有空字段）：第 5 字段之后统一当作附加字段
// 序列，取第一个附加字段为昵称。别按固定字段数匹配——多一个空字段就会整体解析失败。
function parsePtuiCB(text) {
  const m = /^ptuiCB\('(\d+)',\s*'(\d+)',\s*'([^']*)',\s*'(\d+)',\s*'([^']*)'((?:,\s*'[^']*')*)\)/.exec(
    String(text == null ? '' : text).trim()
  );
  if (!m) return null;
  const extra = (m[6] || '').match(/'[^']*'/g) || [];
  return {
    code: Number(m[1]),
    subCode: Number(m[2]),
    url: m[3],
    msg: m[5],
    nick: extra.length ? extra[0].slice(1, -1) : '',
  };
}

function coverUrl(albumMid) {
  return albumMid
    ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`
    : '';
}

// 双通道防御：部分响应把 Cookie 放在 JSON body 里，而非 Set-Cookie 头
function extractCookiesFromJson(node, depth) {
  if ((depth || 0) > 4 || node == null) return {};
  if (typeof node === 'string') {
    return /(?:^|[;\s])(?:qm_keyst|qqmusic_key)=/.test(node) ? cookieToObj(node) : {};
  }
  if (typeof node !== 'object') return {};
  let acc = {};
  for (const v of Object.values(node)) Object.assign(acc, extractCookiesFromJson(v, (depth || 0) + 1));
  return acc;
}

function httpsify(u) {
  return String(u).replace(/^http:\/\//, 'https://');
}

// ==================== 路由注册 ====================

function registerQqRoutes(deps) {
  const { route, log, fetch, makeStore, msg, timeout, crypto, cookieFile, guidFile } = deps;
  const cookieStore = makeStore(cookieFile);
  const guidStore = makeStore(guidFile);

  function readJar() {
    return cookieToObj(cookieStore.read());
  }

  function uinOf(jar) {
    const raw = String(jar.uin || jar.p_uin || jar.wxuin || '').replace(/^o/, '');
    return /^\d+$/.test(raw) ? raw : '0';
  }

  // 设备标识：持久化、登录/登出均不重置（vkey 与 OAuth 均需）
  function ensureGuid() {
    const cur = guidStore.read().trim();
    if (/^\d{8,12}$/.test(cur)) return cur;
    const g = String(Math.floor(1e9 + Math.random() * 8e9));
    guidStore.write(g);
    return g;
  }

  // zza 签名（当前接口不校验；若 musicu 返回风控错误，可拼到 URL query：?sign=<z>&data=…）
  function zzaSign(jsonText) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const count = Math.floor(Math.random() * 7 + 10);
    let rnd = '';
    for (let i = 0; i < count; i++) rnd += chars[Math.floor(Math.random() * chars.length)];
    const hash = crypto.createHash('md5').update('CJBPACrRuNy7' + jsonText, 'utf8').digest('hex');
    return 'zza' + rnd + hash;
  }
  void zzaSign;

  async function musicuPost(payload, jar) {
    const headers = {
      'User-Agent': UA_QQ,
      'Content-Type': 'application/json',
      Referer: 'https://y.qq.com/',
    };
    const cookie = cookieHeader(jar || {});
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(MUSICU_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: timeout(15000),
    });
    const text = await res.text();
    let body = {};
    try {
      body = JSON.parse(text);
    } catch (_) {}
    return { res, body };
  }

  // —— 扫码 ——

  // 官方流程必须在 xlogin → ptqrshow → ptqrlogin → check_sig 全程复用同一 Cookie 会话。
  // 只记 pt_login_sig 查询参数不够：pt_guid_sig / ptvfsession 等票据缺失时，手机扫码后会
  // 长期停在 67「二维码认证中」。会话只在内存存活，客户端协议仍只传 key=qrsig。
  const qrSessions = new Map();
  const QR_SIG_TTL = 10 * 60 * 1000;
  const PTUI_VERSION_FALLBACK = '26090116';

  function rememberQrSession(qrsig, session) {
    qrSessions.set(qrsig, { ...session, at: Date.now() });
    for (const [k, v] of qrSessions) {
      if (qrSessions.size <= 32) break;
      if (Date.now() - v.at > QR_SIG_TTL) qrSessions.delete(k);
    }
    // 插入序即时间序：仍超限则丢最早的
    while (qrSessions.size > 32) qrSessions.delete(qrSessions.keys().next().value);
  }

  function readQrSession(qrsig) {
    const hit = qrSessions.get(qrsig);
    if (!hit) return null;
    if (Date.now() - hit.at > QR_SIG_TTL) {
      qrSessions.delete(qrsig);
      return null;
    }
    return hit;
  }

  async function fetchLoginSession() {
    const url =
      `${XLOGIN_URL}?appid=${PTLOGIN_APPID}&daid=${PTLOGIN_DAID}&style=33&hide_title_bar=1` +
      `&low_login=0&qlogin_auto_open=1&no_verifyimg=1&link_target=blank&target=self` +
      `&s_url=${encodeURIComponent(LOGIN_JUMP_URL)}&pt_3rd_aid=${PT_3RD_AID}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA_QQ, Referer: 'https://xui.ptlogin2.qq.com/' },
        signal: timeout(15000),
      });
      const jar = {};
      mergeSetCookies(jar, getSetCookies(res));
      const html = await res.text();
      const versionMatch = /ptui_version\s*:\s*encodeURIComponent\(["'](\d+)["']\)/.exec(html);
      const version = versionMatch ? versionMatch[1] : PTUI_VERSION_FALLBACK;
      log(
        '[vinyl-server] qq qr xlogin',
        res.status,
        'login_sig:',
        jar.pt_login_sig ? '已取得' : '缺失',
        'set-cookie:',
        getSetCookies(res).map((c) => String(c).split('=')[0]).join(',') || '(无)'
      );
      return { jar, version };
    } catch (e) {
      log('[vinyl-server] qq qr xlogin 失败:', (e && e.message) || String(e));
      return { jar: {}, version: PTUI_VERSION_FALLBACK };
    }
  }

  async function fetchQrShow() {
    // 顺序与参数对齐官方页面：先建立会话，再在同一会话内取二维码图片。
    const session = await fetchLoginSession();
    const url =
      `https://ssl.ptlogin2.qq.com/ptqrshow?appid=${PTLOGIN_APPID}&e=2&l=M&s=3&d=72&v=4` +
      `&t=${Math.random()}&daid=${PTLOGIN_DAID}&pt_3rd_aid=${PT_3RD_AID}` +
      `&u1=${encodeURIComponent(LOGIN_JUMP_URL)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA_QQ,
        Referer: 'https://xui.ptlogin2.qq.com/',
        Cookie: cookieHeader(session.jar),
      },
      signal: timeout(15000),
    });
    const jar = { ...session.jar };
    mergeSetCookies(jar, getSetCookies(res));
    if (!jar.qrsig) throw new Error(msg('gw.qqQrNoQrsig'));
    rememberQrSession(jar.qrsig, { jar, version: session.version });
    const buf = Buffer.from(await res.arrayBuffer());
    return { qrsig: jar.qrsig, qrimg: 'data:image/png;base64,' + buf.toString('base64') };
  }

  async function pollQr(qrsig) {
    const session = readQrSession(qrsig) || {
      jar: { qrsig },
      version: PTUI_VERSION_FALLBACK,
    };
    const loginSig = session.jar.pt_login_sig || '';
    const url =
      `https://ssl.ptlogin2.qq.com/ptqrlogin?u1=${encodeURIComponent(LOGIN_JUMP_URL)}` +
      `&ptqrtoken=${hash33(qrsig)}&ptredirect=0&h=1&t=1&g=1&from_ui=1&ptlang=2052&action=0-0-${Date.now()}` +
      `&js_ver=${encodeURIComponent(session.version)}&js_type=1&login_sig=${encodeURIComponent(loginSig)}&pt_uistyle=40&aid=${PTLOGIN_APPID}` +
      `&daid=${PTLOGIN_DAID}&pt_3rd_aid=${PT_3RD_AID}&has_onekey=1`;
    let res;
    let responseText;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': UA_QQ,
          Referer: 'https://xui.ptlogin2.qq.com/',
          Cookie: cookieHeader(session.jar),
        },
        signal: timeout(15000),
      });
      responseText = await res.text();
    } catch (e) {
      // 只记录固定错误类别，禁止写出含 qrsig / ticket 的 URL 或原始异常消息。
      const rawCode = e && e.cause && e.cause.code;
      const code = ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'].includes(rawCode)
        ? rawCode : e && e.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR';
      log('[vinyl-server] qq qr/check transport failed:', code);
      throw new Error(msg('gw.qqPollFailed', { code }));
    }
    mergeSetCookies(session.jar, getSetCookies(res));
    const cb = parsePtuiCB(responseText);
    if (!cb) {
      const rawCode = /^\s*ptuiCB\(['"](\d+)['"]/.exec(responseText);
      log('[vinyl-server] qq qr/check parse failed; http:', res.status,
        'length:', responseText.length, 'callback code:', rawCode ? rawCode[1] : 'unknown');
      throw new Error(
        msg('gw.qqPollAbnormal', { status: res.status, code: rawCode ? rawCode[1] : '?' })
      );
    }
    // 原始状态诊断（腾讯返回的中文 msg 是排查扫码链路的关键，且不含任何凭据）
    log(
      '[vinyl-server] qq qr/check raw code:',
      cb.code,
      'sub:',
      cb.subCode,
      'msg:',
      cb.msg || '(无)',
      'check_sig:',
      cb.url ? '已下发' : '未下发'
    );
    return cb;
  }

  // —— 登录成功链（check_sig → g_tk → oauth → QQLogin）——

  async function completeLogin(checkUrl, initialJar) {
    const jar = { ...(initialJar || {}) };
    // 1) check_sig 跳转链：逐跳捕获 Set-Cookie（p_skey / p_uin / pt4_token 等）。
    //    有的链路在这一步的 302 Location 里就直接带 OAuth code（可作兜底）。
    let url = checkUrl;
    let chainCode = '';
    const codeFrom = (loc) => {
      const m = /[?&]code=([^&\s]+)/.exec(String(loc || ''));
      return m ? decodeURIComponent(m[1]) : '';
    };
    for (let hop = 0; hop < 5; hop++) {
      let host = '';
      try {
        host = new URL(url).host;
      } catch (_) {}
      const headers = { 'User-Agent': UA_QQ };
      const cookie = cookieHeader(jar);
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(url, { headers, redirect: 'manual', signal: timeout(15000) });
      const setCookies = getSetCookies(res);
      mergeSetCookies(jar, setCookies);
      const loc = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
      if (!chainCode && loc) chainCode = codeFrom(loc);
      log(
        '[vinyl-server] qq-login hop',
        hop,
        host,
        res.status,
        'set-cookie:',
        setCookieShape(setCookies) || '(无)',
        'code:',
        loc ? (codeFrom(loc) ? '有' : '无') : '(无跳转)',
        '| req-ck:',
        ['p_skey', 'p_uin', 'qrsig', 'pt_login_sig', 'pt4_token', 'pt_oauth_token']
          .filter((k) => jar[k])
          .map((k) => `${k}:len${String(jar[k]).length}`)
          .join(' ') || '(无)'
      );
      if (res.status >= 300 && res.status < 400 && loc) {
        url = new URL(loc, url).toString();
        continue;
      }
      // 非跳转终态：留一小段正文头（掩码化），用于区分「登录页 200」与「JS 回跳页 200」。
      try {
        const head = (await res.text()).replace(/\s+/g, ' ').replace(/[A-Za-z0-9_\-]{32,}/g, '<masked>').slice(0, 200);
        log('[vinyl-server] qq-login hop', hop, '终态正文头:', head || '(空)');
      } catch (_) {}
      break;
    }
    log(
      '[vinyl-server] qq-login 会话票据:',
      ['p_skey', 'p_uin', 'uin', 'pt2gguin', 'pt4_token', 'pt_oauth_token']
        .filter((k) => k in jar)
        .map((k) => `${k}:len${String(jar[k]).length}${String(jar[k]) === '' ? '(EMPTY)' : ''}`)
        .join(' ') || '(无)'
    );
    if (!jar.p_skey || !jar.p_uin) {
      throw new Error(msg('gw.qqLoginNoPskey'));
    }
    const uin = String(jar.p_uin).replace(/^o/, '');
    if (!/^\d+$/.test(uin)) throw new Error(msg('gw.qqLoginBadUin'));
    const gtk = getGtk(jar.p_skey);
    const guid = ensureGuid();

    // 2) OAuth authorize：从 302 Location 里取 code
    const authBody = new URLSearchParams({
      response_type: 'code',
      client_id: PT_3RD_AID,
      redirect_uri: 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https%3A%2F%2Fy.qq.com%2F',
      scope: 'get_user_info,get_app_friends',
      state: 'vinyl',
      switch: '',
      from_ptlogin: '1',
      src: '1',
      update_auth: '1',
      openapi: '1010_1030',
      g_tk: String(gtk),
      auth_time: String(Date.now()),
      ui: guid,
    });
    const authHeaders = {
      'User-Agent': UA_QQ,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    const authCookie = cookieHeader(jar);
    if (authCookie) authHeaders.Cookie = authCookie;
    const authRes = await fetch(OAUTH_URL, {
      method: 'POST',
      headers: authHeaders,
      body: authBody.toString(),
      redirect: 'manual',
      signal: timeout(15000),
    });
    mergeSetCookies(jar, getSetCookies(authRes));
    let code = '';
    const loc =
      authRes.headers && typeof authRes.headers.get === 'function'
        ? authRes.headers.get('location') || ''
        : '';
    const m = /[?&]code=([^&\s]+)/.exec(loc);
    if (m) code = decodeURIComponent(m[1]);
    if (!code) {
      // 个别版本 200 + 页面内跳转
      try {
        const text = await authRes.text();
        const m2 = /[?&]code=([A-Za-z0-9]+)/.exec(text);
        if (m2) code = m2[1];
      } catch (_) {}
    }
    log(
      '[vinyl-server] qq-login oauth status',
      authRes.status,
      'code:',
      code ? '已获取' : chainCode ? '缺失（改用 check_sig 链路 code）' : '缺失'
    );
    // 2b) 兜底一：check_sig 链路自身带回来的 code
    if (!code && chainCode) code = chainCode;
    // 2c) 兜底二：显式请求 login_jump（参考实现的 u1 落点），从其 302 取 code
    if (!code) {
      try {
        const jumpHeaders = { 'User-Agent': UA_QQ };
        const jumpCookie = cookieHeader(jar);
        if (jumpCookie) jumpHeaders.Cookie = jumpCookie;
        const jumpRes = await fetch(LOGIN_JUMP_URL, {
          headers: jumpHeaders,
          redirect: 'manual',
          signal: timeout(15000),
        });
        mergeSetCookies(jar, getSetCookies(jumpRes));
        const jloc =
          jumpRes.headers && typeof jumpRes.headers.get === 'function'
            ? jumpRes.headers.get('location') || ''
            : '';
        const jm = codeFrom(jloc);
        log('[vinyl-server] qq-login login_jump', jumpRes.status, 'code:', jm ? '已获取' : '缺失');
        if (jm) code = jm;
      } catch (e) {
        log('[vinyl-server] qq-login login_jump 失败:', (e && e.message) || String(e));
      }
    }
    if (!code) throw new Error(msg('gw.qqAuthFailed'));

    // 3) musicu QQLogin 换最终 Cookie（双通道：Set-Cookie + JSON body）
    const { res: qqRes, body: qqBody } = await musicuPost(
      {
        comm: { uin, format: 'json', ct: 24, cv: 0 },
        req: { module: 'QQConnectLogin.LoginServer', method: 'QQLogin', param: { code } },
      },
      jar
    );
    const qqSetCookies = getSetCookies(qqRes);
    mergeSetCookies(jar, qqSetCookies);
    const bodyCookies = extractCookiesFromJson(qqBody);
    Object.assign(jar, bodyCookies);
    log(
      '[vinyl-server] qq-login qqlogin code',
      qqBody && qqBody.req ? qqBody.req.code : (qqBody && qqBody.code),
      'set-cookie:',
      qqSetCookies.map((c) => String(c).split('=')[0]).join(',') || '(无)',
      'body-cookies:',
      Object.keys(bodyCookies).join(',') || '(无)'
    );

    const final = Object.assign({}, jar);
    delete final.qrsig;
    const cookie = cookieHeader(final);
    // 仅记键名，绝不记值
    log('[vinyl-server] qq-login 取到 Cookie 键名:', Object.keys(final).join(',') || '(无)');
    if (!final.qm_keyst && !final.qqmusic_key) {
      throw new Error(msg('gw.qqNoKeyst'));
    }
    return { cookie, uin: Number(uin) };
  }

  // —— 登录态 ——

  async function userInfo(jar) {
    const uin = uinOf(jar);
    const { body } = await musicuPost(
      {
        comm: { uin, format: 'json', ct: 24, cv: 0 },
        req_0: { module: 'music.UserInfo.userInfoServer', method: 'GetLoginUserInfo', param: {} },
      },
      jar
    );
    const req0 = (body && (body.req_0 || body.req)) || {};
    const d = req0.data || {};
    const valid = Number(req0.code) === 0;
    if (!valid) {
      log('[vinyl-server] qq userinfo code:', req0.code, 'data keys:', Object.keys(d).join(',') || '(无)');
    }
    // 真实登录态里昵称在 data.info.nick（顶层的 nick 字段并不返回）
    const info = d.info || {};
    const nick = String(d.nick || d.nickname || d.name || info.nick || info.nickname || '');
    const uid = d.uin != null ? d.uin : d.musicid != null ? d.musicid : d.qq != null ? d.qq : uin !== '0' ? Number(uin) : undefined;
    return { valid, nick, uin: uid != null && uid !== '' ? Number(uid) : undefined };
  }

  function normalizeAccount(info) {
    return {
      code: 200,
      data: {
        code: 200,
        account: { id: info.uin },
        profile: { nickname: info.nick, userId: info.uin },
      },
    };
  }

  async function validateCookieValue(raw) {
    if (typeof raw !== 'string' || /[\r\n]/.test(raw)) throw new Error(msg('gw.qqCookieFormat'));
    const jar = cookieToObj(raw);
    if (!jar.qm_keyst && !jar.qqmusic_key) throw new Error(msg('gw.qqCookieMissingKeyst'));
    const info = await userInfo(jar);
    if (!info.valid) throw new Error(msg('gw.qqCookieInvalid'));
    return info;
  }

  // —— 播放取链（服务端 ladder + CDN 并行探测 + https 改写）——

  async function probeCdn(url) {
    try {
      const res = await fetch(url, { headers: { Range: 'bytes=0-1' }, signal: timeout(3000) });
      try {
        if (res.body && typeof res.body.cancel === 'function') void res.body.cancel();
      } catch (_) {}
      return res.status === 200 || res.status === 206;
    } catch (_) {
      return false;
    }
  }

  function joinCdn(sips, purl) {
    const p = /^https?:\/\//.test(purl) ? httpsify(purl) : purl;
    return sips.map((s) => {
      const b = httpsify(String(s || ''));
      if (/^https?:\/\//.test(p)) return p;
      if (!b) return '';
      return b.endsWith('/') ? b + p : b + '/' + p;
    }).filter(Boolean);
  }

  async function vkeyUrl(mid, mediaMid, level, jar, guid) {
    const start = Math.max(0, LEVEL_ORDER.indexOf(level));
    const uin = uinOf(jar);
    const tried = new Set();
    let msg = '';
    for (let i = start; i >= 0; i--) {
      const lv = LEVEL_ORDER[i];
      const spec = LEVELS[lv];
      const dedupeKey = spec.prefix + spec.ext;
      if (tried.has(dedupeKey)) continue;
      tried.add(dedupeKey);
      // filename 优先 mediaMid（strMediaMid ≠ songmid），空 purl 时回退 songmid 再试
      const candidates = [];
      if (mediaMid && mediaMid !== mid) candidates.push(mediaMid);
      candidates.push(mid);
      for (const m of candidates) {
        const filename = `${spec.prefix}${m}${spec.ext}`;
        const { body } = await musicuPost(
          {
            comm: { uin, format: 'json', ct: 24, cv: 0 },
            req_0: {
              module: 'vkey.GetVkeyServer',
              method: 'CgiGetVkey',
              param: {
                guid,
                songmid: [mid],
                songtype: [0],
                uin,
                loginflag: 1,
                platform: '20',
                filename: [filename],
              },
            },
          },
          jar
        );
        const d = body && body.req_0 && body.req_0.data;
        const purl = d && d.midurlinfo && d.midurlinfo[0] ? d.midurlinfo[0].purl : '';
        if (!purl) {
          msg = 'QQ 音乐未返回可播放地址（可能为会员专享、数字专辑、需登录或无版权）';
          continue;
        }
        const urls = joinCdn((d && d.sip) || ['https://aqqmusic.tc.qq.com/'], purl);
        if (!urls.length) {
          msg = 'QQ 音乐 CDN 地址缺失';
          continue;
        }
        const probes = await Promise.all(urls.map(probeCdn));
        const idx = probes.indexOf(true);
        if (idx >= 0) return { url: urls[idx], br: spec.br, type: spec.type, level: lv, mid };
        msg = 'QQ 音乐 CDN 探测失败（可能网络受限）';
      }
    }
    return { url: '', br: 0, type: '', level, mid, msg };
  }

  // ==================== 路由 ====================

  route('GET', '/api/qq/login/qr/key', async () => {
    const { qrsig, qrimg } = await fetchQrShow();
    log('[vinyl-server] qq qr/key 已获取（qrsig 长度', qrsig.length, '）');
    return { code: 200, data: { unikey: qrsig, qrimg } };
  });

  route('GET', '/api/qq/login/qr/check', async ({ query }) => {
    const key = String((query && query.key) || '').trim();
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(key)) throw new Error(msg('gw.qqMissingLoginKey'));
    const cb = await pollQr(key);
    if (cb.code === 66) {
      log('[vinyl-server] qq qr/check code: 801');
      return { code: 801 };
    }
    if (cb.code === 67) {
      log('[vinyl-server] qq qr/check code: 802');
      return { code: 802 };
    }
    if (cb.code === 65) {
      qrSessions.delete(key);
      log('[vinyl-server] qq qr/check code: 800');
      return { code: 800 };
    }
    if (cb.code === 0) {
      if (!cb.url) throw new Error(msg('gw.qqNoCheckUrl'));
      try {
        const session = readQrSession(key);
        const { cookie } = await completeLogin(cb.url, session && session.jar);
        const info = await validateCookieValue(cookie); // 校验通过才落盘（与网易云同语义）
        cookieStore.write(cookie);
        log('[vinyl-server] qq qr/check code: 803（已校验并保存，uin', info.uin + '）');
        return { code: 803, data: normalizeAccount(info).data };
      } catch (e) {
        // 失败原因必须落在网关日志里（只进 Obsidian 控制台时，排查看不到）。
        log('[vinyl-server] qq-login 失败:', (e && e.message) || String(e));
        throw e;
      } finally {
        qrSessions.delete(key);
      }
    }
    throw new Error(msg('gw.qqQrServiceUnavailable'));
  });

  route('GET', '/api/qq/login/status', async () => {
    const jar = readJar();
    if (!jar.qm_keyst && !jar.qqmusic_key) return { code: 200, data: {} };
    const info = await userInfo(jar);
    if (!info.valid || info.uin == null) return { code: 200, data: {} };
    return normalizeAccount(info);
  });

  route('GET', '/api/qq/album', async ({ query }) => {
    const mid = String((query && query.id) || '').trim();
    if (!MID_RE.test(mid)) throw new Error(msg('gw.qqBadAlbumId'));
    const res = await fetch(`${ALBUM_URL}?albummid=${encodeURIComponent(mid)}&format=json`, {
      headers: { 'User-Agent': UA_QQ, Referer: 'https://y.qq.com/' },
      signal: timeout(15000),
    });
    let body = {};
    try {
      body = JSON.parse(await res.text());
    } catch (_) {}
    const code = Number(body && body.code);
    if (code === 1101) {
      return { code: 1101, msg: '专辑不存在或 albummid 无效', data: { album: null, songs: [] } };
    }
    if (code !== 0) {
      return { code: code || -1, msg: 'QQ 音乐专辑查询失败', data: { album: null, songs: [] } };
    }
    const d = body.data || {};
    const albumMid = d.mid || mid;
    const album = {
      mid: albumMid,
      name: d.name || '',
      artist: d.singername || '',
      artistMid: d.singermid || '',
      coverUrl: coverUrl(albumMid),
      publishTime: d.aDate || '',
      genre: d.genre || '',
      desc: d.desc || '',
      company: d.company || '',
      trackCount: Number(d.total) || (Array.isArray(d.list) ? d.list.length : 0),
    };
    const songs = (Array.isArray(d.list) ? d.list : []).map((s) => ({
      mid: String(s.songmid || ''),
      mediaMid: String(s.strMediaMid || s.songmid || ''),
      name: String(s.songname || ''),
      artist: (Array.isArray(s.singer) ? s.singer : [])
        .map((x) => x && x.name)
        .filter(Boolean)
        .join(' / '),
      albumName: String(s.albumname || d.name || ''),
      albumMid: String(s.albummid || albumMid),
      interval: Number(s.interval) || 0,
      cover: coverUrl(String(s.albummid || albumMid)),
      pay: s.pay && Number(s.pay.payplay) === 1 ? 1 : 0,
      trial: !!(s.preview && Number(s.preview.trybegin) > 0),
    }));
    return { code: 0, data: { album, songs } };
  });

  route('GET', '/api/qq/song/url', async ({ query }) => {
    const mid = String((query && query.id) || '').trim();
    const mediaMid = String((query && query.mediaMid) || '').trim();
    const level = LEVELS[(query && query.level) || ''] ? String(query.level) : 'standard';
    if (!MID_RE.test(mid)) throw new Error(msg('gw.qqBadSongId'));
    const jar = readJar();
    const guid = ensureGuid();
    const r = await vkeyUrl(mid, MID_RE.test(mediaMid) ? mediaMid : '', level, jar, guid);
    if (r.url) {
      return { code: 200, data: [{ url: r.url, br: r.br, type: r.type, level: r.level, mid, code: 200 }] };
    }
    return { code: 200, data: [{ url: '', code: 0, mid, msg: r.msg }] };
  });

  route('GET', '/api/qq/lyric', async ({ query }) => {
    const mid = String((query && query.songmid) || '').trim();
    if (!MID_RE.test(mid)) throw new Error(msg('gw.qqBadSongId'));
    const res = await fetch(
      `${LYRIC_URL}?songmid=${encodeURIComponent(mid)}&format=json&nobase64=1`,
      {
        headers: { 'User-Agent': UA_QQ, Referer: 'https://y.qq.com/' },
        signal: timeout(15000),
      }
    );
    let body = {};
    try {
      body = JSON.parse(await res.text());
    } catch (_) {}
    const ok = Number(body.retcode) === 0 || Number(body.code) === 0;
    if (!ok) throw new Error(msg('gw.qqLyricFailed'));
    return { code: 0, lyric: String(body.lyric || ''), trans: String(body.trans || '') };
  });

  route('POST', '/api/qq/cookie', async ({ body }) => {
    const info = await validateCookieValue(body && body.cookie);
    cookieStore.write(String(body.cookie).trim());
    return { ok: true, data: { account: { id: info.uin } } };
  });

  route('POST', '/api/qq/cookie/validate', async ({ body }) => {
    const info = await validateCookieValue(body && body.cookie);
    return normalizeAccount(info);
  });

  route('DELETE', '/api/qq/cookie', async () => {
    cookieStore.write('');
    return { ok: true };
  });
}

module.exports = { registerQqRoutes };
