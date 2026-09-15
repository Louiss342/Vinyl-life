// Vinyl Life 本地网关（由插件 main.js 内联源码生成，勿手改）
// 设计：自研极简 request（node:crypto 实现 weapi/eapi 加密 + 内置 fetch 发请求），
// 仅复用 NeteaseCloudMusicApi 的 7 个轻量端点模块负责响应整形。
// 无 axios / crypto-js / node-forge / pac-proxy-agent / tunnel 等重依赖：
// 出口代理是自写的 HTTP CONNECT 隧道（server/proxy.js），不需要三方包。
const http = require('http');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { registerQqRoutes } = require('./qq');
const { resolveProxyConfig, createProxyFetch } = require('./proxy');

const login_qr_key = require('NeteaseCloudMusicApi/module/login_qr_key');
const login_status = require('NeteaseCloudMusicApi/module/login_status');
const album = require('NeteaseCloudMusicApi/module/album');
const song_url_v1 = require('NeteaseCloudMusicApi/module/song_url_v1');
const lyric = require('NeteaseCloudMusicApi/module/lyric');
const search = require('NeteaseCloudMusicApi/module/search');

// ==================== 文案 ====================
// 网关是独立进程，拿不到渲染进程的词典，所以自带一份小表：错误文案会一路冒到导入弹窗 /
// 登录窗口里给用户看，不能只有中文。语言由插件经 VINYL_LANG 注入（默认中文）。
const LANG = process.env.VINYL_LANG === 'en' ? 'en' : 'zh';
// 每次请求可带 x-vinyl-lang 覆盖（插件切语言后立刻生效，不用重启网关）。
// 并发下最坏情况是某条文案的语言串台 —— 纯展示问题，不值得为此把语言穿进每个 handler。
let requestLang = LANG;
const MSG = {
  'gw.credentialWriteFailed': {
    zh: '登录凭据写入失败，请检查插件目录权限',
    en: 'Could not write the credential file — check permissions on the plugin folder',
  },
  'gw.cookieMissingMusicU': { zh: 'Cookie 缺少有效的 MUSIC_U', en: 'The cookie has no valid MUSIC_U' },
  'gw.cookieInvalidNetease': {
    zh: 'Cookie 登录验证失败，请重新登录网易云',
    en: 'Cookie sign-in check failed — sign in to NetEase again',
  },
  'gw.coverBadUrl': { zh: '封面地址无效', en: 'Invalid cover URL' },
  'gw.coverBlocked': {
    zh: '封面地址不可访问（指向本机或内网）',
    en: 'Cover URL not reachable (points to this machine or a private network)',
  },
  'gw.coverNotImage': { zh: '封面地址不是图片', en: 'Cover URL is not an image' },
  'gw.coverNotFound': {
    zh: '封面不存在（源站 404）',
    en: 'Cover image not found (upstream 404)',
  },
  'gw.coverBadStatus': {
    zh: '封面源站返回 HTTP {status}',
    en: 'The cover host returned HTTP {status}',
  },
  'gw.coverDnsFailed': {
    zh: '封面地址无法解析（{host}），可能被 DNS 或网络拦截',
    en: 'Could not resolve the cover host ({host}) — possibly blocked by DNS or the network',
  },
  'gw.coverUnreachable': {
    zh: '封面地址连接失败或超时（{host}）',
    en: 'Could not reach the cover host ({host}) — connection failed or timed out',
  },
  'gw.coverTooLarge': { zh: '封面图过大', en: 'Cover image is too large' },
  'gw.qrServiceUnavailable': {
    zh: '网易云扫码服务暂时不可用，请重试',
    en: 'The NetEase QR service is temporarily unavailable — try again',
  },
  'gw.neteaseRequestFailed': {
    zh: '网易云请求失败，请检查网络后重试',
    en: 'NetEase request failed — check your network and try again',
  },
  // —— QQ 音乐（server/qq.js 用注入进来的 msg）——
  'gw.qqQrNoQrsig': {
    zh: '获取 QQ 登录二维码失败（未返回 qrsig），请重试',
    en: 'Could not fetch the QQ sign-in QR code (no qrsig returned) — try again',
  },
  'gw.qqPollFailed': {
    zh: 'QQ 扫码轮询请求失败（{code}），正在重试',
    en: 'QQ QR polling failed ({code}) — retrying',
  },
  'gw.qqPollAbnormal': {
    zh: 'QQ 扫码服务返回异常（HTTP {status}，回调状态 {code}），请重试',
    en: 'The QQ QR service returned an unexpected response (HTTP {status}, callback state {code}) — try again',
  },
  'gw.qqLoginNoPskey': {
    zh: 'QQ 登录链路异常（未取得 p_skey/p_uin），请重试',
    en: 'The QQ sign-in chain broke (no p_skey/p_uin) — try again',
  },
  'gw.qqLoginBadUin': {
    zh: 'QQ 登录链路异常（uin 无效），请重试',
    en: 'The QQ sign-in chain broke (invalid uin) — try again',
  },
  'gw.qqAuthFailed': {
    zh: 'QQ 登录授权失败，请重新扫码',
    en: 'QQ sign-in was not authorized — scan the code again',
  },
  'gw.qqNoKeyst': {
    zh: 'QQ 音乐登录未返回 qm_keyst，请重试',
    en: 'QQ Music sign-in returned no qm_keyst — try again',
  },
  'gw.qqCookieFormat': { zh: 'Cookie 格式无效', en: 'Invalid cookie format' },
  'gw.qqCookieMissingKeyst': { zh: 'Cookie 缺少有效的 qm_keyst', en: 'The cookie has no valid qm_keyst' },
  'gw.qqCookieInvalid': {
    zh: 'Cookie 登录验证失败，请重新登录 QQ 音乐',
    en: 'Cookie sign-in check failed — sign in to QQ Music again',
  },
  'gw.qqMissingLoginKey': {
    zh: '缺少有效的登录 key，请刷新二维码',
    en: 'Missing a valid sign-in key — refresh the QR code',
  },
  'gw.qqNoCheckUrl': {
    zh: 'QQ 登录成功但未返回校验地址，请重试',
    en: 'QQ sign-in succeeded but returned no verification URL — try again',
  },
  'gw.qqQrServiceUnavailable': {
    zh: 'QQ 扫码服务暂时不可用，请重试',
    en: 'The QQ QR service is temporarily unavailable — try again',
  },
  // —— 出站代理（server/proxy.js 用注入进来的 msg）——
  'gw.proxyFailed': {
    zh: '代理连接失败（{msg}）',
    en: 'Could not connect to the proxy ({msg})',
  },
  'gw.proxyRejected': {
    zh: '代理拒绝建立隧道（HTTP {status}）',
    en: 'The proxy refused the tunnel (HTTP {status})',
  },
  'gw.proxyTimeout': { zh: '代理连接超时', en: 'Proxy connection timed out' },
  'gw.qqBadAlbumId': { zh: '专辑 ID 无效', en: 'Invalid album ID' },
  'gw.qqBadSongId': { zh: '歌曲 ID 无效', en: 'Invalid song ID' },
  'gw.qqLyricFailed': { zh: 'QQ 音乐歌词获取失败', en: 'Could not fetch the QQ Music lyrics' },
};

/** 取当前语言的文案；{name} 占位符按 params 替换（缺键 / 缺参数都原样保留，便于发现漏配） */
function msg(key, params) {
  const entry = MSG[key];
  let text = (entry && (entry[requestLang] || entry.zh)) || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) text = text.split('{' + k + '}').join(String(v));
  }
  return text;
}

// ==================== 鉴权 ====================
// 插件 spawn 网关时用 VINYL_TOKEN 下发本次会话的随机 token，每个请求必须带上
// （header x-vinyl-token；极少数要进 DOM 的 URL 用 ?t=）。没有它的话，浏览器里任意页面
// 扫到本机端口就能拿用户的网易云/QQ 账号发请求 —— 所以这里不是「防君子」的摆设。
// 手工 `node server.js` 调试时没有 token，放行并打一条警告（那种情况下网关照常只监听本机）。
const AUTH_TOKEN = String(process.env.VINYL_TOKEN || '');
let warnedNoToken = false;

// ==================== Cookie 持久化 ====================

const COOKIE_FILE = process.env.VINYL_COOKIE_FILE || path.join(__dirname, '.cookie');
// QQ 音乐独立凭据与设备标识（默认与 .cookie 同目录；env 由 server-manager 注入）
const QQ_COOKIE_FILE =
  process.env.VINYL_QQ_COOKIE_FILE || path.join(path.dirname(COOKIE_FILE), '.qq-cookie');
const QQ_GUID_FILE =
  process.env.VINYL_QQ_GUID_FILE || path.join(path.dirname(COOKIE_FILE), '.qq-guid');

// 凭据文件读写工厂（网易云 / QQ 共用；原子写 + 0600；仅用注入的 fs 方法，便于测试替换）
function makeCookieStore(file) {
  function read() {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (!raw) return '';
      if (raw.startsWith('{')) {
        const j = JSON.parse(raw);
        return j.cookie || j.Cookie || '';
      }
      return raw;
    } catch (_) {
      return '';
    }
  }
  function write(value) {
    const tmp = file + '.tmp';
    try {
      const v = String(value || '').trim();
      fs.writeFileSync(tmp, v, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      serverLog('[vinyl-server] cookie 已写入', file, v.length, 'bytes');
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw new Error(msg('gw.credentialWriteFailed'));
    }
  }
  return { file, read, write };
}

const neteaseStore = makeCookieStore(COOKIE_FILE);
const readCookie = () => neteaseStore.read();
const writeCookie = (value) => neteaseStore.write(value);

async function validateCookie(cookie) {
  if (typeof cookie !== 'string' || /[\r\n]/.test(cookie) || !cookieToObject(cookie).MUSIC_U) {
    throw new Error(msg('gw.cookieMissingMusicU'));
  }
  const result = await login_status({ cookie }, request);
  const inner = result.body?.data || result.body;
  if (Number(inner?.code) !== 200 || !(inner.account?.id || inner.profile?.userId)) {
    throw new Error(msg('gw.cookieInvalidNetease'));
  }
  return result.body;
}

// ==================== 加密实现（等价 NeteaseCloudMusicApi util/crypto.js 的 weapi/eapi） ====================

const IV = '0102030405060708';
const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const EAPI_KEY = 'e82ckenh8dichen8';
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

function aesEncryptCbcBase64(text, key, iv) {
  const cipher = crypto.createCipheriv(
    'aes-128-cbc',
    Buffer.from(key, 'utf8'),
    Buffer.from(iv, 'utf8')
  );
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}

function aesEncryptEcbHex(text, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('hex').toUpperCase();
}

function rsaNoPaddingEncryptHex(text, pem) {
  const reversed = text.split('').reverse().join('');
  const hex = Buffer.from(reversed, 'utf8').toString('hex').padStart(256, '0');
  const enc = crypto.publicEncrypt(
    { key: pem, padding: crypto.constants.RSA_NO_PADDING },
    Buffer.from(hex, 'hex')
  );
  return enc.toString('hex');
}

function weapi(object) {
  const text = JSON.stringify(object);
  let secretKey = '';
  for (let i = 0; i < 16; i++) secretKey += BASE62.charAt(Math.floor(Math.random() * 62));
  return {
    params: aesEncryptCbcBase64(aesEncryptCbcBase64(text, PRESET_KEY, IV), secretKey, IV),
    encSecKey: rsaNoPaddingEncryptHex(secretKey, PUBLIC_KEY),
  };
}

function eapi(url, object) {
  const text = JSON.stringify(object);
  const digest = crypto
    .createHash('md5')
    .update(`nobody${url}use${text}md5forencrypt`, 'utf8')
    .digest('hex');
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  return { params: aesEncryptEcbHex(data, EAPI_KEY) };
}

// ==================== 极简 request（等价 util/request.js 核心路径，无代理/无重依赖） ====================

const OS_INFO = {
  os: 'pc',
  appver: '3.1.17.204416',
  osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
  channel: 'netease',
};
const UA_API = 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)';
const UA_WEAPI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';
const SPECIAL_CODES = new Set([201, 302, 400, 502, 800, 801, 802, 803]);

let anonymousToken = '';
// 匿名 token 注册时绑定的 deviceId（v2 落盘后与 token 一起恢复）
let savedDeviceId = '';
// 与 NeteaseCloudMusicApi generateDeviceId 同格式（52 位大写 hex）：
// register/anonimous 的 username 由 deviceId 派生，格式需与官方客户端一致。
const deviceId = Array.from({ length: 52 }, () =>
  '0123456789ABCDEF'.charAt(Math.floor(Math.random() * 16))
).join('');
const WNMCID_VALUE = `${Math.random().toString(36).slice(2, 8)}.${Date.now()}.01.0`;
const randomHex = (n) => crypto.randomBytes(n / 2).toString('hex');

// 网关日志：控制台 + 落盘（VINYL_LOG_FILE 由主进程传入绝对路径）
const LOG_FILE = process.env.VINYL_LOG_FILE || '';
function serverLog(...args) {
  console.log(...args);
  if (!LOG_FILE) return;
  try {
    fs.appendFileSync(
      LOG_FILE,
      args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n'
    );
  } catch (_) {}
}

// ==================== 出站代理 ====================
// 内置 fetch（undici）不读系统代理：会出现「浏览器能打开封面、插件下载不了」。
// 插件启动网关时把「系统代理」（Electron session.resolveProxy）经 VINYL_PROXY 注入，
// 也认 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 等常规变量；都没有则直连（与从前一致）。
const proxyConfig = resolveProxyConfig(process.env);
const proxyFetch = createProxyFetch((...args) => fetch(...args), proxyConfig, {
  msg,
  log: serverLog,
});
serverLog(
  '[vinyl-server] 出站网络:',
  proxyConfig.mode === 'http'
    ? `经代理 ${proxyConfig.host}:${proxyConfig.port}（来源 ${proxyConfig.source}）`
    : proxyConfig.mode === 'unsupported'
      ? `代理配置无法使用（${proxyConfig.raw}），按直连处理`
      : '直连'
);

// 构建指纹 Cookie 头（对齐库的 processCookieObject）
// deviceId 优先复用已有匿名 token 的设备标识。
function buildFingerprintCookie(cookieObj, uri, includeMusicAuth) {
  const header = {
    osver: cookieObj.osver || OS_INFO.osver,
    deviceId: cookieObj.deviceId || savedDeviceId || deviceId,
    os: cookieObj.os || OS_INFO.os,
    appver: cookieObj.appver || OS_INFO.appver,
    versioncode: cookieObj.versioncode || '140',
    mobilename: cookieObj.mobilename || '',
    buildver: cookieObj.buildver || String(Date.now()).slice(0, 10),
    resolution: cookieObj.resolution || '1920x1080',
    __csrf: cookieObj.__csrf || '',
    channel: cookieObj.channel || OS_INFO.channel,
    requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1000)).padStart(4, '0')}`,
    WNMCID: cookieObj.WNMCID || WNMCID_VALUE,
    _ntes_nuid: cookieObj._ntes_nuid || randomHex(32),
    WEVNSM: cookieObj.WEVNSM || '1.0.0',
    __remember_me: 'true',
    ntes_kaola_ad: '1',
  };
  // 对齐库的行为：登录类接口不主动携带 NMTID
  if (uri.indexOf('login') === -1) header.NMTID = cookieObj.NMTID || randomHex(16);
  if (includeMusicAuth) {
    if (cookieObj.MUSIC_U) header.MUSIC_U = cookieObj.MUSIC_U;
    else if (anonymousToken) header.MUSIC_A = anonymousToken;
  }
  return header;
}

function cookieToObject(cookie) {
  const obj = {};
  if (!cookie) return obj;
  for (const part of String(cookie).split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) obj[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return obj;
}

const ANON_FILE =
  process.env.VINYL_ANON_FILE || path.join(path.dirname(COOKIE_FILE), '.anon-token');

function loadAnonymousTokenFromDisk() {
  try {
    const raw = fs.readFileSync(ANON_FILE, 'utf8').trim();
    if (!raw) return false;
    try {
      const j = JSON.parse(raw);
      if (j.token) {
        anonymousToken = String(j.token);
        savedDeviceId = String(j.deviceId || '');
        serverLog(
          '[vinyl-server] anonymous token 已从磁盘加载 (v2, deviceId=',
          savedDeviceId ? '已绑定' : '缺失',
          '), 长度',
          anonymousToken.length
        );
        return true;
      }
    } catch (_) {}
    // 旧格式（仅 token，无 deviceId）
    anonymousToken = raw;
    savedDeviceId = '';
    serverLog('[vinyl-server] anonymous token 已从磁盘加载 (旧格式，无 deviceId 绑定), 长度', raw.length);
    return true;
  } catch (_) {}
  return false;
}

function createRequest(uri, data, options) {
  return new Promise((resolve, reject) => {
    try {
      const cookieRaw = (options && options.cookie) || '';
      const cookieObj = typeof cookieRaw === 'string' ? cookieToObject(cookieRaw) : cookieRaw;
      const csrf = cookieObj.__csrf || '';
      const cryptoMode = (options && options.crypto) || 'eapi';
      let url = '';
      let body = '';
      let headers = {};

      if (cryptoMode === 'weapi') {
        data.csrf_token = csrf;
        // 对齐库的行为：weapi 请求转发用户的全部 Cookie + 补默认指纹
        const header = {
          ...cookieObj,
          osver: cookieObj.osver || OS_INFO.osver,
          deviceId: cookieObj.deviceId || savedDeviceId || deviceId,
          os: cookieObj.os || OS_INFO.os,
          appver: cookieObj.appver || OS_INFO.appver,
          channel: cookieObj.channel || OS_INFO.channel,
          WNMCID: cookieObj.WNMCID || WNMCID_VALUE,
          _ntes_nuid: cookieObj._ntes_nuid || randomHex(32),
          WEVNSM: cookieObj.WEVNSM || '1.0.0',
          __remember_me: 'true',
          ntes_kaola_ad: '1',
        };
        if (uri.indexOf('login') === -1) header.NMTID = cookieObj.NMTID || randomHex(16);
        if (!header.MUSIC_U && anonymousToken) header.MUSIC_A = header.MUSIC_A || anonymousToken;
        headers = {
          'User-Agent': UA_WEAPI,
          Referer: 'https://music.163.com',
          Cookie: Object.entries(header)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('; '),
        };
        body = new URLSearchParams(weapi(data)).toString();
        url = 'https://music.163.com/weapi/' + uri.substr(5);
      } else {
        const header = buildFingerprintCookie(cookieObj, uri, true);
        headers = {
          Cookie: Object.entries(header)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('; '),
          'User-Agent': UA_API,
        };
        data.header = header;
        body = new URLSearchParams(eapi(uri, data)).toString();
        url = 'https://interface.music.163.com/eapi/' + uri.substr(5);
      }

      proxyFetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15000),
      })
        .then(async (res) => {
          const text = await res.text();
          const setCookies = [];
          try {
            const sc =
              typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
            for (const c of sc) {
              // 只保留第一个键值对，剥离 Max-Age/Expires/Path 等属性
              const first = c.split(';')[0].trim();
              if (first.includes('=')) setCookies.push(first);
            }
            serverLog(
              '[vinyl-server] netease set-cookie 数量:',
              sc.length,
              '| 键:',
              setCookies.map((c) => c.split('=')[0]).join(',') || '(无)',
              '| url:',
              url
            );
          } catch (_) {}
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch (_) {
            parsed = { raw: String(text).slice(0, 200) };
          }
          if (parsed.code) parsed.code = Number(parsed.code);
          const code = parsed.code || res.status;
          const answer = { status: 200, body: parsed, cookie: setCookies };
          if (code === 200 || SPECIAL_CODES.has(code)) resolve(answer);
          else reject(answer);
        })
        .catch((err) => {
          reject({
            status: 502,
            body: { code: 502, msg: String((err && err.message) || err) },
            cookie: [],
          });
        });
    } catch (e) {
      reject({
        status: 500,
        body: { code: 500, msg: String((e && e.message) || e) },
        cookie: [],
      });
    }
  });
}

const request = createRequest;

// 复用已有匿名身份；注册只发生在「用户主动发起扫码登录」时（见 ensureAnonymousToken）。
loadAnonymousTokenFromDisk();

// —— 匿名身份惰性注册（新用户首次扫码登录）——
// 802 授权只有在请求携带 MUSIC_A 时才会下发 MUSIC_U。新用户本机没有 .anon-token，
// 因此首次扫码前注册一次匿名身份并落盘复用；每个进程生命周期最多尝试一次，避免触发
// 上游限流（注册接口有频率限制，失败不阻塞流程，仍有浏览器登录兜底）。
const ID_XOR_KEY_1 = '3go8&$8*3*3h0k(2)2';
let anonRegisterTried = false;

function cloudmusicDllEncodeId(someId) {
  let xored = '';
  for (let i = 0; i < someId.length; i++) {
    xored += String.fromCharCode(
      someId.charCodeAt(i) ^ ID_XOR_KEY_1.charCodeAt(i % ID_XOR_KEY_1.length)
    );
  }
  return crypto.createHash('md5').update(Buffer.from(xored, 'utf8')).digest('base64');
}

function saveAnonymousToken(token, dev) {
  savedDeviceId = dev;
  const tmp = ANON_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ token, deviceId: dev }), {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(tmp, ANON_FILE);
    serverLog('[vinyl-server] anonymous token 已注册并落盘 (v2), 长度', token.length);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
    serverLog('[vinyl-server] anonymous token 落盘失败:', String((e && e.message) || e));
  }
}

async function ensureAnonymousToken() {
  if (anonymousToken) return true;
  if (anonRegisterTried) return false;
  anonRegisterTried = true;
  try {
    const username = Buffer.from(
      `${deviceId} ${cloudmusicDllEncodeId(deviceId)}`,
      'utf8'
    ).toString('base64');
    const r = await createRequest('/api/register/anonimous', { username }, { crypto: 'weapi' });
    const parts = (r.cookie || []).map((c) => String(c).split(';')[0]);
    // 上游把匿名 token 放在 MUSIC_A（部分版本为 anonymous_token），两者都认
    const hit =
      parts.find((c) => c.startsWith('MUSIC_A=')) ||
      parts.find((c) => c.startsWith('anonymous_token='));
    const token = hit ? hit.slice(hit.indexOf('=') + 1) : '';
    if (!token) {
      serverLog(
        '[vinyl-server] anonymous token 注册未返回 token（上游可能限流），扫码流程继续 code=',
        r.body && r.body.code,
        'msg=',
        r.body && (r.body.msg || r.body.message)
      );
      return false;
    }
    anonymousToken = token;
    saveAnonymousToken(token, deviceId);
    return true;
  } catch (e) {
    serverLog(
      '[vinyl-server] anonymous token 注册失败（上游可能限流）:',
      String((e && e.message) || e)
    );
    return false;
  }
}

// ==================== 路由 ====================

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (_) {
        resolve({});
      }
    });
  });
}

// 封面代理的护栏（这个路由是拿内部 token 也不该被当成任意代理用的）：
//   只允许 http(s) → 解析出的地址不能是本机 / 内网 / 链路本地（防 SSRF 打内网服务）
//   → 只收图片 → 限时 10s、限 12MB。跳转按同一套规则重新校验，不信任 Location 的协议。
// 失败原因要能分流：DNS 解析失败 / 内网地址 / 源站 404 / 其它状态码 / 连不上，各有各的文案 ——
// 这些文案会一路冒到导入提示里，一律说「不是图片」只会把排查带偏。
const BINARY_TIMEOUT_MS = 10000;
const BINARY_MAX_BYTES = 12 * 1024 * 1024;

function isPrivateAddress(ip) {
  if (!ip) return true; // 拿不到地址就按危险处理
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip; // IPv4-mapped IPv6
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true; // 本机 / 私有
    if (a === 172 && b >= 16 && b <= 31) return true; // 私有
    if (a === 192 && b === 168) return true; // 私有
    if (a === 169 && b === 254) return true; // 链路本地（含云元数据地址）
    return a >= 224; // 组播 / 保留
  }
  const low = v4.toLowerCase();
  return low === '::1' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80');
}

/** 校验目标可抓取，返回解析后的 URL；不可抓取时 reject */
function assertFetchable(rawUrl) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch (_) {
    return Promise.reject(new Error(msg('gw.coverBadUrl')));
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return Promise.reject(new Error(msg('gw.coverBadUrl')));
  }
  return new Promise((resolve, reject) => {
    dns.lookup(target.hostname, { all: true }, (err, addrs) => {
      const list = Array.isArray(addrs) ? addrs : [];
      // 解析失败与被解析到内网地址是两回事：前者（DNS 被拦 / 域名不存在）说成「指向本机或内网」
      // 只会误导排查方向
      if (err || list.length === 0) {
        reject(new Error(msg('gw.coverDnsFailed', { host: target.hostname })));
        return;
      }
      if (list.some((a) => isPrivateAddress(a.address))) {
        reject(new Error(msg('gw.coverBlocked')));
        return;
      }
      resolve(target);
    });
  });
}

async function fetchBinary(url, redirects = 0) {
  if (redirects > 3) throw new Error('too many redirects');
  const target = await assertFetchable(url);
  let res;
  try {
    res = await proxyFetch(target, {
      redirect: 'manual',
      signal: AbortSignal.timeout(BINARY_TIMEOUT_MS),
    });
  } catch (e) {
    // 代理自身的失败原因已经完整（含「代理」字样）：原样上抛，别当成「目标不可达」吞掉
    if (e && e.vinylProxy) {
      serverLog('[vinyl-server] 封面代理失败:', String((e && e.message) || e));
      throw e;
    }
    // 连接失败 / 超时：undici 的英文报错不适合直接展示给用户（它会一路冒到导入提示里）
    serverLog('[vinyl-server] 封面请求异常:', String((e && e.message) || e));
    throw new Error(msg('gw.coverUnreachable', { host: target.hostname }));
  }
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    return fetchBinary(new URL(res.headers.get('location'), target).toString(), redirects + 1);
  }
  // 源站明确的失败状态：404（这张图确实不存在）与其它状态分开报
  if (res.status === 404) throw new Error(msg('gw.coverNotFound'));
  if (res.status >= 400) throw new Error(msg('gw.coverBadStatus', { status: res.status }));
  const contentType = String(res.headers.get('content-type') || '');
  if (!contentType.startsWith('image/')) throw new Error(msg('gw.coverNotImage'));
  const chunks = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > BINARY_MAX_BYTES) {
      await reader.cancel();
      throw new Error(msg('gw.coverTooLarge'));
    }
    chunks.push(Buffer.from(value));
  }
  return { binary: Buffer.concat(chunks), contentType };
}

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern: new RegExp('^' + pattern + '$'), handler });
}

route('GET', '/api/ping', () => ({ ok: true, pid: process.pid, uptime: process.uptime() }));

route('GET', '/api/login/qr/key', async () => {
  // 新用户没有匿名身份 → 首次扫码前注册一次（失败不阻塞，浏览器登录通道兜底）
  await ensureAnonymousToken();
  const r = await login_qr_key({}, request);
  return r.body;
});

// 本地 QRCode 编码登录链接（与库的 login_qr_create 等价，但只依赖 qrcode）
route('GET', '/api/login/qr/create', async ({ query }) => {
  const url = `https://music.163.com/login?codekey=${query.key}`;
  const qrimg = await QRCode.toDataURL(url);
  return { code: 200, data: { qrurl: url, qrimg } };
});

route('GET', '/api/login/qr/check', async ({ query }) => {
  // 上游码：800 过期 / 801 等待扫码 / 802 待确认 / 803 授权成功。
  // 直接调用端点而不是依赖模块的封装：其 catch 分支引用了未定义的 result，会吞掉网络错误。
  const result = await request('/api/login/qrcode/client/login',
    { key: query.key, type: 3 }, { crypto: 'weapi' });
  const code = Number(result.body?.code);
  if (![800, 801, 802, 803].includes(code)) throw new Error(msg('gw.qrServiceUnavailable'));
  if (code === 803) {
    const cookie = result.cookie.join('; ');
    const verified = await validateCookie(cookie);
    writeCookie(cookie);
    serverLog('[vinyl-server] qr/check code:', code);
    return { code, data: verified?.data || verified || {} };
  }
  serverLog('[vinyl-server] qr/check code:', code);
  return { code };
});

route('GET', '/api/login/status', async ({ cookie }) => {
  const r = await login_status({ cookie: cookie || readCookie() }, request);
  return r.body;
});

route('GET', '/api/album', async ({ query, cookie }) => {
  const r = await album({ id: query.id, cookie: cookie || readCookie() }, request);
  return r.body;
});

route('GET', '/api/song/url', async ({ query, cookie }) => {
  const r = await song_url_v1(
    {
      id: query.id,
      level: query.level || 'higher',
      cookie: cookie || readCookie(),
    },
    request
  );
  return r.body;
});

route('GET', '/api/lyric', async ({ query, cookie }) => {
  const r = await lyric({ id: query.id, cookie: cookie || readCookie() }, request);
  return r.body;
});

route('GET', '/api/search', async ({ query, cookie }) => {
  const type = query.type === 'song' ? 1 : 10;
  const r = await search(
    {
      keywords: query.keywords,
      type,
      limit: 10,
      cookie: cookie || readCookie(),
    },
    request
  );
  return r.body;
});

route('GET', '/api/cover', async ({ query }) => {
  const url = String(query.url || '');
  if (!/^https?:\/\//.test(url)) throw new Error(msg('gw.coverBadUrl'));
  try {
    return await fetchBinary(url);
  } catch (e) {
    // 封面失败通常只在渲染进程控制台可见 → 同时落 gateway.log（用户报障时附的就是这份日志）
    serverLog('[vinyl-server] 封面获取失败:', url, '→', String((e && e.message) || e));
    throw e;
  }
});

route('DELETE', '/api/cookie', async () => {
  writeCookie('');
  return { ok: true };
});

// ==================== QQ 音乐路由（/api/qq/*） ====================
// server/qq.js 为纯注入式模块：fs/fetch/日志/超时/crypto/路径全部由这里注入，
// 模块自身零 require、零裸 fetch（测试以 vm 替换本文件作用域内的 I/O）。
registerQqRoutes({
  route,
  log: serverLog,
  fetch: proxyFetch,
  makeStore: makeCookieStore,
  msg,
  timeout: (ms) => AbortSignal.timeout(ms),
  crypto,
  cookieFile: QQ_COOKIE_FILE,
  guidFile: QQ_GUID_FILE,
});

const server = http.createServer(async (req, res) => {
  // 不发任何 CORS 头：插件用 requestUrl（不受同源策略约束），浏览器里的第三方页面
  // 既不该也不需要通过 CORS 访问这里。
  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch (_) {
    res.writeHead(400);
    return res.end('{"error":"bad url"}');
  }
  const langHeader = String(req.headers['x-vinyl-lang'] || '');
  if (langHeader === 'en' || langHeader === 'zh') requestLang = langHeader;
  if (AUTH_TOKEN) {
    const got = String(req.headers['x-vinyl-token'] || '') || String(url.searchParams.get('t') || '');
    if (got !== AUTH_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error":"unauthorized"}');
    }
  } else if (!warnedNoToken) {
    warnedNoToken = true;
    serverLog('[vinyl-server] 未设置 VINYL_TOKEN：本次不做鉴权（仅建议本地调试时如此运行）');
  }
  const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end('{"error":"not found","path":"' + url.pathname + '"}');
  }
  const body = await readBody(req);
  try {
    const result = await match.handler({
      query: Object.fromEntries(url.searchParams),
      body,
      cookie: '',
    });
    if (result && result.binary) {
      res.writeHead(200, { 'Content-Type': result.contentType });
      return res.end(result.binary);
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
  } catch (e) {
    const message = e instanceof Error ? e.message : msg('gw.neteaseRequestFailed');
    // 走 serverLog 落盘：只进 stderr 的话，gateway.log 里查不到这类失败（排查时抓瞎）
    serverLog('[vinyl-server] route error:', req.method, url.pathname, message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
});

const port = Number(process.env.VINYL_PORT || 0);
server.listen(port, '127.0.0.1', () => {
  serverLog('[vinyl-server] listening on 127.0.0.1:' + server.address().port);
});
