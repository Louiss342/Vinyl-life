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
const { registerKugouRoutes } = require('./kugou');
const { resolveProxyConfig, createProxyFetch } = require('./proxy');
const { redactLogText, MAX_LOG_BYTES } = require('./redact');

const login_qr_key = require('NeteaseCloudMusicApi/module/login_qr_key');
const login_status = require('NeteaseCloudMusicApi/module/login_status');
const album = require('NeteaseCloudMusicApi/module/album');
const song_url_v1 = require('NeteaseCloudMusicApi/module/song_url_v1');
const lyric = require('NeteaseCloudMusicApi/module/lyric');
// 搜索刻意用 cloudsearch（/api/cloudsearch/pc）而不是 module/search（/api/search/get）：
// 后者在「本机已登录、请求带 MUSIC_U」时会稳定返回 405「操作频繁，请稍候再试」——
// 也就是登录之后搜索栏必挂（eapi / weapi 两条通道都一样，实测可复现）。
// cloudsearch 是网页版在用的搜索端点，登录、匿名身份两种状态下都正常。
const search = require('NeteaseCloudMusicApi/module/cloudsearch');

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
  // 上游明确说的「操作频繁」不是网络故障：以前被并进上面那条，用户只会去查网络
  'gw.neteaseRateLimited': {
    zh: '网易云接口限流（操作频繁），请等几秒再搜',
    en: 'NetEase is rate-limiting requests (too frequent) — wait a few seconds and search again',
  },
  // 其它上游拒绝：把 code 和上游原话透出来，别让排查卡在「网络问题」上
  'gw.upstreamRejected': {
    zh: '网易云返回 {code}：{message}',
    en: 'NetEase returned {code}: {message}',
  },
  'gw.upstreamNoDetail': { zh: '上游未给出原因', en: 'upstream gave no reason' },
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
  // —— 酷狗（server/kugou.js）——
  'gw.kugouDeviceFailed': {
    zh: '酷狗设备注册失败（拿不到设备指纹），请稍后重试',
    en: 'Could not register the Kugou device (no device fingerprint) — try again later',
  },
  'gw.kugouBadResponse': { zh: '酷狗接口返回异常', en: 'The Kugou API returned an unexpected response' },
  'gw.kugouQrFailed': {
    zh: '酷狗二维码获取失败，请重试',
    en: 'Could not fetch the Kugou QR code — try again',
  },
  'gw.kugouMissingLoginKey': {
    zh: '缺少有效的登录 key，请刷新二维码',
    en: 'Missing a valid sign-in key — refresh the QR code',
  },
  'gw.kugouLoginIncomplete': {
    zh: '酷狗登录成功但凭据不完整，请重试',
    en: 'Kugou sign-in succeeded but the credentials are incomplete — try again',
  },
  'gw.kugouQrServiceUnavailable': {
    zh: '酷狗扫码服务暂时不可用，请重试',
    en: 'The Kugou QR service is temporarily unavailable — try again',
  },
  // 未登录时的昵称占位（切 en 界面时不能冒出中文）
  'gw.kugouUser': { zh: '酷狗用户 {id}', en: 'Kugou user {id}' },
  'gw.kugouBadAlbumId': { zh: '专辑 ID 无效', en: 'Invalid album ID' },
  'gw.kugouBadSongId': { zh: '歌曲 ID 无效', en: 'Invalid song ID' },
  'gw.kugouAlbumFailed': { zh: '酷狗专辑信息获取失败', en: 'Could not fetch the Kugou album info' },
  'gw.kugouLyricFailed': { zh: '酷狗歌词获取失败', en: 'Could not fetch the Kugou lyrics' },
  'gw.kugouNoUrl': {
    zh: '这首歌暂时拿不到播放地址（可能需要会员，或只有试听片段）',
    en: 'No playable URL for this track right now (it may require membership, or only a preview is available)',
  },
  // —— 本机音频按 Range 供流（库外音频播放用，见 README 6.3.1）——
  'gw.streamBadPath': {
    zh: '本地音频路径无效（需要绝对路径）',
    en: 'Invalid local audio path (an absolute path is required)',
  },
  'gw.streamNotAudio': {
    zh: '不是可播放的音频文件：{name}',
    en: 'Not a playable audio file: {name}',
  },
  'gw.streamNotFound': { zh: '音频文件不存在：{name}', en: 'Audio file not found: {name}' },
  'gw.streamNotAllowed': {
    zh: '这个路径没有登记给本次会话，拒绝供流：{name}',
    en: 'This path was not registered for streaming in this session: {name}',
  },
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

/** 把 handler 抛出的东西转成能给人看的文案。
 *  createRequest 是以「普通对象」{status, body, cookie} reject 的，不是 Error ——
 *  以前只判断 instanceof Error，于是上游所有拒绝（限流 405、接口 404…）都被压成
 *  「请检查网络后重试」，界面和 gateway.log 一起指向错误方向。 */
function failureText(e) {
  if (e instanceof Error) return e.message;
  const body = e && typeof e === 'object' ? e.body : null;
  const code = body && body.code != null ? Number(body.code) : 0;
  if (code === 405 || code === 429) return msg('gw.neteaseRateLimited');
  const upstream = body ? String(body.message || body.msg || '').trim() : '';
  // 有的端点（如不存在的专辑）只回 {"code":404}，没有 message —— 只透 code 也比谎报网络故障强
  if (code || upstream) {
    return msg('gw.upstreamRejected', {
      code: code || '?',
      message: upstream || msg('gw.upstreamNoDetail'),
    });
  }
  return msg('gw.neteaseRequestFailed');
}

/** 拒绝对应哪个 HTTP 状态：限流给 429，客户端据此让该来源冷却（见 src/core/request-error.ts）。
 *  其它一律 500 —— 客户端只区分「限流」与「出错了」，不靠文案匹配（文案有中英两套）。 */
/** 路由错误：可以指定 HTTP 状态（默认 500）。供流的三种拒绝各有各的状态：
 *  路径无效 / 不是音频 400、没登记 403、不存在 404 —— 客户端与排查都靠它分流。 */
class RouteError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function failureStatus(e) {
  if (e instanceof RouteError) return e.status;
  if (e instanceof Error) return 500;
  const body = e && typeof e === 'object' ? e.body : null;
  const code = body && body.code != null ? Number(body.code) : 0;
  return code === 405 || code === 429 ? 429 : 500;
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
// 酷狗：登录凭据 + 设备身份（dfid/mid/guid/dev）各一个文件
const KUGOU_COOKIE_FILE =
  process.env.VINYL_KUGOU_COOKIE_FILE || path.join(path.dirname(COOKIE_FILE), '.kugou-cookie');
const KUGOU_DEVICE_FILE =
  process.env.VINYL_KUGOU_DEVICE_FILE || path.join(path.dirname(COOKIE_FILE), '.kugou-device');

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
    // 体积上限：超了就把上一份滚成 .1（只留一代）。日志就长在插件目录（库内）里，
    // 无上限的 append 会把它撑成几十 MB 跟着同步走。statSync 失败当「没有旧文件」处理。
    let size = 0;
    try {
      size = fs.statSync(LOG_FILE).size;
    } catch (_) {}
    if (size > MAX_LOG_BYTES) {
      try {
        fs.unlinkSync(LOG_FILE + '.1');
      } catch (_) {}
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
      args = [`[vinyl-server] 日志超过 ${Math.round(MAX_LOG_BYTES / 1024)} KB，上一份已滚到 gateway.log.1`];
    }
    fs.appendFileSync(LOG_FILE, redactLogText(renderLogArgs(args)) + '\n');
  } catch (_) {}
}

/** 参数拼成一行：字符串原样、其余 JSON（与从前同一口径，只是多过一道脱敏） */
function renderLogArgs(args) {
  return args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
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
  // 一页给多少条由客户端定（搜索页要一直往深处翻）。上限 50：上游一次给太多没意义，
  // 放大 limit 就是在放大被限流的概率 —— 网易云对搜索本来就敏感。
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 30));
  const offset = Math.max(0, Number(query.offset) || 0);
  const r = await search(
    {
      keywords: query.keywords,
      type,
      limit,
      offset,
      // 显式 weapi：模块自身不带默认值时会落到 eapi（设备指纹通道），而网页版走的是 weapi
      crypto: 'weapi',
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

// ==================== 本机音频按 Range 供流（库外音频专用） ====================
// 背景：库外音频（vault 之外的绝对路径）此前由插件整文件读进渲染进程做成 Blob ——
// 一首 30–50 MB 的无损就是一整块内存，一张 20 首的专辑能上 GB（见 src/core/local-source.ts）。
// 现在改由网关按 HTTP Range 供流：Chromium 的 <audio> 只取需要的区间，整轨不驻留内存。
// 代价：库外音频从此也会用到网关（README 里「只放本地音频不启动网关」已按此改写）。
// 安全：与其它路由同一套 token 鉴权（<audio> 不能自定义请求头，所以走 ?t= 那条路，见上面的鉴权段）；
// 另外只认「绝对路径 + 音频扩展名 + 常规文件」—— 这条路由不是通用文件读取口。
// 扩展名表与 src/util.ts 的 AUDIO_EXTENSIONS / MIME_BY_EXT 必须一致（有测试锁着）。
const STREAM_MIME = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  webm: 'audio/webm',
  weba: 'audio/webm',
};

/** 本会话允许供流的路径（见 /api/local/allow）。为什么需要这一层：
 *  <audio> 发的是浏览器级请求、带不了自定义头，所以这条路由的凭据只能是 URL 里的 ?t= 会话 token。
 *  光有 token 还不够 —— 拿到它的任何进程都能用它读盘上**任意**音频文件；登记过之后，
 *  能读的就只剩「插件真的声明过要放的那几个路径」，与 README 6.3.1 的口径一致。 */
const streamAllow = new Set();

/** 登记键：与供流同样的两条硬条件（绝对路径 + 认识的音频扩展名），再 path.resolve 归一
 *  —— 插件与网关同机，但分隔符写法可能不同。不合格的路径直接不收（返回 null）。 */
function streamAllowKey(raw) {
  const p = String(raw || '');
  if (!path.isAbsolute(p)) return null;
  if (!STREAM_MIME[path.extname(p).slice(1).toLowerCase()]) return null;
  return path.resolve(p);
}

// 供流白名单登记：插件在取流地址之前调一次（见 core/server-manager 的 allowStreamPaths）。
// 与其它路由同一条鉴权链；没有 token 一样 401。
route('POST', '/api/local/allow', async ({ body }) => {
  const list = body && Array.isArray(body.paths) ? body.paths : [];
  let added = 0;
  for (const raw of list) {
    const key = streamAllowKey(raw);
    if (!key || streamAllow.has(key)) continue;
    streamAllow.add(key);
    added++;
  }
  return { added, total: streamAllow.size };
});

/** 校验并描述一个待供流的文件；不是「绝对路径 + 认识的音频扩展名 + 已登记 + 常规文件」就抛。
 *  未登记的路径在碰文件系统之前就被挡下（不给「存不存在」的探测面）。 */
function resolveStreamFile(raw) {
  const p = String(raw || '');
  if (!path.isAbsolute(p)) throw new RouteError(msg('gw.streamBadPath'), 400);
  const name = path.basename(p);
  const contentType = STREAM_MIME[path.extname(p).slice(1).toLowerCase()];
  if (!contentType) throw new RouteError(msg('gw.streamNotAudio', { name }), 400);
  if (!streamAllow.has(path.resolve(p))) throw new RouteError(msg('gw.streamNotAllowed', { name }), 403);
  let stat;
  try {
    stat = fs.statSync(p);
  } catch (_) {
    throw new RouteError(msg('gw.streamNotFound', { name }), 404);
  }
  if (!stat.isFile()) throw new RouteError(msg('gw.streamNotFound', { name }), 404);
  return { path: p, size: stat.size, contentType };
}

route('GET', '/api/local/stream', async ({ query }) => ({ file: resolveStreamFile(query.path) }));

/** 解析单区间 Range。返回 {start,end} / null（没带 Range，回全量）/ 'invalid'（不合法或越界 → 416）。
 *  只认单区间（bytes=a-b / a- / -n）：多区间按规范允许回 200 全量，这里就这么办 —— 音频播放器
 *  实际只发单区间，为多区间做 multipart 响应没有收益。 */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  let start, end;
  if (rawStart === '') {
    // bytes=-n：最后 n 字节（n 为 0 按越界处理）
    const n = Number(rawEnd);
    if (!n) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid';
  return { start, end };
}

/** 按 Range 把一个文件写回去。Accept-Ranges 必须给 —— <audio> 靠它决定能不能拖进度条。 */
function sendStreamFile(req, res, file) {
  const total = file.size;
  const headers = {
    'Content-Type': file.contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const range = parseRange(req.headers && req.headers.range, total);
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${total}` });
    return res.end();
  }
  if (!total) {
    // 空文件：音频不会是 0 字节，但别让 createReadStream(start:0, end:-1) 抛
    res.writeHead(200, { ...headers, 'Content-Length': '0' });
    return res.end();
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;
  headers['Content-Length'] = String(end - start + 1);
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
  // 先建流再写头：createReadStream 抛（路径含 NUL 之类）时还没发响应，能落回 500 的 JSON 分支
  const stream = fs.createReadStream(file.path, { start, end });
  stream.on('error', (e) => {
    serverLog('[vinyl-server] 音频供流中断:', file.path, String((e && e.message) || e));
    try {
      res.destroy();
    } catch (_) {
      // 响应已经结束：无处可收，忽略
    }
  });
  res.writeHead(range ? 206 : 200, headers);
  stream.pipe(res);
}

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

// ==================== 酷狗音乐路由（/api/kugou/*） ====================
// server/kugou.js 与 qq.js 同一套纪律：零 require、零裸 fetch（测试以 vm 替换本文件的 I/O）。
// 比 QQ 多一个 deviceFile —— 酷狗取流强依赖设备指纹 dfid（首次使用时注册并落盘）。
registerKugouRoutes({
  route,
  log: serverLog,
  fetch: proxyFetch,
  makeStore: makeCookieStore,
  msg,
  timeout: (ms) => AbortSignal.timeout(ms),
  crypto,
  cookieFile: KUGOU_COOKIE_FILE,
  deviceFile: KUGOU_DEVICE_FILE,
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
    // 文件供流（/api/local/stream）：头与流由 sendStreamFile 自己写，不走 JSON 那条路
    if (result && result.file) return sendStreamFile(req, res, result.file);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
  } catch (e) {
    const message = failureText(e);
    // 走 serverLog 落盘：只进 stderr 的话，gateway.log 里查不到这类失败（排查时抓瞎）
    serverLog('[vinyl-server] route error:', req.method, url.pathname, message);
    res.writeHead(failureStatus(e), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
});

// 端口：VINYL_PORT=0（或未给）时由系统分配，选中的端口回报给父进程。
// 为什么不让父进程先探测再传进来：探测完必须先关掉那个监听才能交给网关，中间有一段
// 端口被别人抢走的窗口（TOCTOU）—— 抢到了网关会 EADDRINUSE，用户看到的是「在线音源
// 莫名其妙不可用」。改成网关自己 bind(0) 再回报真实端口，这条缝就不存在了。
// 回报格式固定在下面这一行上，插件侧按它解析（改格式要同步改 server-manager 的 PORT_RE）。
const port = Number(process.env.VINYL_PORT || 0);
server.listen(port, '127.0.0.1', () => {
  serverLog('[vinyl-server] listening on 127.0.0.1:' + server.address().port);
});

// 监听失败（端口被占 / 权限 / 网卡异常）：必须有处理，否则 Node 会把 'error' 事件
// 直接抛成未捕获异常，进程带着一段吓人的堆栈死掉 —— 插件侧只看到「退出」，只能猜。
// 这里写清原因再退出：父进程按「启动失败」处理（它会换端口重试，见 server-manager 的自愈）。
server.on('error', (e) => {
  serverLog('[vinyl-server] 监听失败：' + ((e && e.message) || String(e)));
  process.exit(1);
});
