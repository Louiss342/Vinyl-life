// 酷狗音乐网关模块（登录 + 曲库 + 取流）—— 纯函数 + 依赖注入。
//
// ⚠ 测试纪律（与 qq.js 同款，务必遵守）：本模块被 gateway.js require，而测试 harness 以 vm 方式
//   执行 gateway.js 并替换其作用域内的 fs / fetch —— 被 require 的模块拿到的是【真实】全局。
//   因此本文件绝不能 require 任何模块、不能裸调 fetch / 读写文件；可用 deps 注入的：
//     deps = { route, log, fetch, makeStore, msg, timeout, crypto, cookieFile, deviceFile }
//   允许直接用的只有纯全局：Buffer / URL / URLSearchParams / Math / Date / JSON。
//
// 三条链路（2026-09-24 实机验证，见 tmp/kugou-probe*.js 的探测记录）：
//   ① 设备身份：设备指纹 dfid 必须先注册（POST userservice.kugou.com/risk/v2/r_register_dev）——
//      body 是 AES-128-CBC 密文、`p` 参数是 RSA-PKCS1v1.5 加密的会话信息；响应可能是明文 JSON，
//      也可能是同一会话 key 加密的密文，两种都要认。dfid 缺了取流会被判「本次请求需要验证」。
//   ② 匿名曲库：mobilecdn.kugou.com/api/v3 的搜索 / 专辑 / 曲目接口——无签名、无登录、字段稳定，
//      第三方客户端（Meting 血统）多年都在用这条。搜索的 /v2/search/song 路对匿名返回 error_code 152，
//      不要走。
//   ③ 取流：优先 /v5/url（android 签名 + signKey + dfid；url 为空时看 fail_process），
//      退 trackercdn i/v2（key = md5(hash + 'kgcloudv2')，纯匿名老链）。两条都不需要 DRM。
//   登录：扫码三步（/v2/qrcode → 前端渲染 qrcode_img → 轮询 /v2/get_userinfo_qrcode），web 签名；
//      状态码 0 过期 / 1 待扫 / 2 待确认 / 4 成功（带 token + userid）→ 归一化 800 / 801 / 802 / 803。
//      登录后 token/userid 会带进取流请求（决定能否拿到 VIP 音质与完整曲目）。
'use strict';

module.exports = { registerKugouRoutes };

function registerKugouRoutes(deps) {
  const { route, log, fetch, makeStore, msg, timeout, crypto, cookieFile, deviceFile } = deps;
  const cookieStore = makeStore(cookieFile);
  const deviceStore = makeStore(deviceFile);

  const UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';
  const APPID = 1005;
  const CLIENTVER = 20489;
  const SRCAPPID = 2919;
  const SALT_ANDROID = 'OIlwieks28dk2k092lksi2UIkp';
  const SALT_WEB = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
  const SALT_SIGN_KEY = '57ae12eb6890223e355ccfcb74edf70d';
  const RSA_PUBLIC = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB
-----END PUBLIC KEY-----`;
  const H5_BASE = 'http://mobilecdn.kugou.com';
  const GW_BASE = 'https://gateway.kugou.com';
  const LOGIN_BASE = 'https://login-user.kugou.com';
  // 搜索结果一页多少条（专辑与歌曲共用）。插件侧按同样的页大小换算页码 ——
  // 两边必须一致，否则第 2 页会从半截开始漏掉或重复（album-discovery 的 SEARCH_PAGE_SIZE）。
  const SEARCH_PAGE = 30;
  // 封面占位尺寸：上游 imgurl 里的 {size} 需要替换（参照第三方客户端取 480）
  const COVER_SIZE = 480;
  // 音质档位：插件四档 → 酷狗 quality 参数（flac 为无损；'high' 在酷狗语义里不是 320）。
  // br 只给兜底的 trackercdn 旧链用（实测它一律回 128k，不认 br；v5 链走 quality）。
  // 2026-09-24 实机核对：quality 128/320/flac → bitRate 128000/320000/595000、ext mp3/mp3/flac。
  const LEVELS = {
    standard: { quality: '128', br: '128' },
    higher: { quality: '320', br: '320' },
    exhigh: { quality: 'flac', br: 'flac' },
    lossless: { quality: 'flac', br: 'flac' },
  };

  /** 把「实际到手的音质」报回给插件（与 qq.js 的 ladder 口径一致）：
   *  请求 lossless 但上游只回了 128k mp3 时，播放器读数不该显示「无损」。
   *  flac 无法再分 exhigh / lossless（两档请求的都是 flac），按请求档位回报。 */
  function actualLevel(requested, br, ext) {
    const isFlac = String(ext).toLowerCase() === 'flac' || Number(br) >= 500000;
    if (isFlac) return requested;
    return Number(br) >= 256000 ? 'higher' : 'standard';
  }

  /** 媒体地址统一 https（上游给的多半是 http://fsandroid…；CDN 实测两者都支持，渲染进程走 https 更干净） */
  function httpsify(url) {
    return String(url || '').replace(/^http:\/\//i, 'https://');
  }

  // ==================== 工具 ====================

  function md5(text) {
    return crypto.createHash('md5').update(String(text), 'utf8').digest('hex');
  }

  const POOL = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function randomString(n) {
    let out = '';
    for (let i = 0; i < n; i++) out += POOL[Math.floor(Math.random() * POOL.length)];
    return out;
  }

  function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.floor(Math.random() * 16);
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /** mid = 十进制(MD5(guid))；guid 由 md5(uuidv4) 派生（与参考实现一致） */
  function calculateMid(guid) {
    return BigInt('0x' + md5(guid)).toString();
  }

  function cookieToObj(raw) {
    const out = {};
    String(raw || '')
      .split(/;\s*/)
      .forEach((part) => {
        if (!part) return;
        const idx = part.indexOf('=');
        if (idx <= 0) return;
        out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
      });
    return out;
  }

  const jar = () => cookieToObj(cookieStore.read());

  // —— 签名（全部是纯 MD5 拼接） ——

  /** 通用 android 签名：盐 + 按 key 排序的 k=v 串 + body + 盐（对象值走紧凑 JSON） */
  function signAndroid(params, data = '') {
    const joined = Object.keys(params)
      .sort()
      .map((k) => `${k}=${typeof params[k] === 'object' ? JSON.stringify(params[k]) : params[k]}`)
      .join('');
    return md5(`${SALT_ANDROID}${joined}${data || ''}${SALT_ANDROID}`);
  }

  /** 登录系接口的 web 签名：先拼 k=v 再整体排序，盐不同，对象值不序列化 */
  function signWeb(params, data = '') {
    const joined = Object.keys(params)
      .map((k) => `${k}=${params[k]}`)
      .sort()
      .join('');
    return md5(`${SALT_WEB}${joined}${data || ''}${SALT_WEB}`);
  }

  /** 取流专用的 key 签名（参与 /v5/url 的 query） */
  function signKey(hash, mid, userid, appid) {
    return md5(`${hash}${SALT_SIGN_KEY}${appid || APPID}${mid}${userid || 0}`);
  }

  // —— 设备身份 ——

  function readDevice() {
    const jarObj = cookieToObj(deviceStore.read());
    return {
      guid: jarObj.guid || '',
      mid: jarObj.mid || '',
      dfid: jarObj.dfid || '',
      dev: jarObj.dev || '',
    };
  }

  function writeDevice(device) {
    deviceStore.write(
      `guid=${device.guid}; mid=${device.mid}; dfid=${device.dfid}; dev=${device.dev}`
    );
  }

  /** 每个上游请求都要带的基础参数（秒级 clienttime；时间与签名必须同一份） */
  function baseQuery(device, extra) {
    const user = jar();
    const q = {
      dfid: device.dfid || '-',
      mid: device.mid,
      uuid: '-',
      appid: APPID,
      clientver: CLIENTVER,
      clienttime: Math.floor(Date.now() / 1000),
    };
    if (user.token) q.token = user.token;
    if (user.userid && user.userid !== '0') q.userid = user.userid;
    return Object.assign(q, extra || {});
  }

  function deviceHeaders(device, q) {
    return {
      'User-Agent': UA,
      dfid: device.dfid || '-',
      clienttime: String(q.clienttime),
      mid: device.mid,
      'kg-rc': '1',
      'kg-thash': '5d816a0',
      'kg-rec': '1',
      'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    };
  }

  function aesEncryptSession(plain, sessionKey) {
    const key = md5(sessionKey).substring(0, 16);
    const iv = md5(sessionKey).substring(16, 32);
    const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
    return Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]).toString('base64');
  }

  function aesDecryptSession(b64, sessionKey) {
    const key = md5(sessionKey).substring(0, 16);
    const iv = md5(sessionKey).substring(16, 32);
    const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
    return Buffer.concat([decipher.update(Buffer.from(b64, 'base64')), decipher.final()]).toString('utf8');
  }

  /** 注册设备并拿 dfid。响应两种形态（明文 / 同会话 key 加密）都要认。 */
  async function registerDevice() {
    const guid = md5(uuidv4());
    const mid = calculateMid(guid);
    const device = { guid, mid, dfid: '-', dev: randomString(10).toUpperCase() };
    const sessionKey = randomString(6).toLowerCase();
    // 设备字段必须给「像真机」的全量（实测：只给 brand/device/imei/uuid 的精简载荷会被回空 data，
    // 拿不到 dfid；补全电池/传感器等字段后稳定返回）。值本身不敏感，照抄参考实现即可。
    const payload = {
      availableRamSize: 4983533568,
      availableRomSize: 48114719,
      availableSDSize: 48114717,
      basebandVer: '',
      batteryLevel: 100,
      batteryStatus: 3,
      brand: 'Redmi',
      buildSerial: 'unknown',
      device: 'marble',
      imsi: '',
      manufacturer: 'Xiaomi',
      accelerometer: false,
      accelerometerValue: '',
      gravity: false,
      gravityValue: '',
      gyroscope: false,
      gyroscopeValue: '',
      light: false,
      lightValue: '',
      magnetic: false,
      magneticValue: '',
      orientation: false,
      orientationValue: '',
      pressure: false,
      pressureValue: '',
      step_counter: false,
      step_counterValue: '',
      temperature: false,
      temperatureValue: '',
      imei: guid,
      uuid: guid,
    };
    const body = aesEncryptSession(JSON.stringify(payload), sessionKey);
    const p = crypto
      .publicEncrypt(
        { key: RSA_PUBLIC, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(JSON.stringify({ aes: sessionKey, uid: 0, token: '' }), 'utf8')
      )
      .toString('hex');
    const q = baseQuery(device, { part: 1, platid: 1, p });
    q.signature = signAndroid(q, body);
    const url = `https://userservice.kugou.com/risk/v2/r_register_dev?${new URLSearchParams(
      Object.entries(q).map(([k, v]) => [k, String(v)])
    ).toString()}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: Object.assign(deviceHeaders(device, q), { 'Content-Type': 'application/json' }),
      body,
      signal: timeout(20000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let text = buf.toString('utf8');
    if (!text.trim().startsWith('{')) {
      text = aesDecryptSession(buf.toString('base64'), sessionKey);
    }
    const body2 = JSON.parse(text);
    device.dfid = String(body2?.data?.dfid || '');
    if (!device.dfid) throw new Error(msg('gw.kugouDeviceFailed'));
    writeDevice(device);
    log('[vinyl-server] 酷狗设备已注册（dfid 长度', device.dfid.length, '）');
    return device;
  }

  let devicePromise = null;
  async function ensureDevice() {
    const cur = readDevice();
    if (cur.dfid && cur.guid && cur.mid && cur.dev) return cur;
    if (!devicePromise) {
      devicePromise = registerDevice().finally(() => {
        devicePromise = null;
      });
    }
    return devicePromise;
  }

  // ==================== 曲库（mobilecdn，匿名） ====================

  async function h5(pathname, params) {
    const url = `${H5_BASE}${pathname}?${new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ).toString()}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: timeout(15000) });
    const text = await res.text();
    let body = {};
    try {
      body = JSON.parse(text);
    } catch (_) {
      throw new Error(msg('gw.kugouBadResponse'));
    }
    return body;
  }

  /** 上游封面模板里的 {size} 换成实际尺寸；http → https（渲染进程直接挂 <img>） */
  function coverUrl(template) {
    const raw = String(template || '').replace('{size}', String(COVER_SIZE));
    return raw.replace(/^http:\/\//, 'https://');
  }

  function mapAlbum(row) {
    return {
      id: String(row.albumid ?? row.album_id ?? ''),
      name: String(row.albumname ?? row.album_name ?? ''),
      artist: String(row.singername ?? row.author_name ?? ''),
      songCount: Number(row.songcount ?? 0) || 0,
      publishDate: String(row.publishtime ?? ''),
      cover: coverUrl(row.imgurl),
    };
  }

  function mapSong(row) {
    const hash = String(row.hash ?? '').toLowerCase();
    return {
      id: hash,
      hash,
      name: String(row.songname ?? row.filename ?? ''),
      artist: String(row.singername ?? ''),
      albumName: String(row.album_name ?? ''),
      albumId: String(row.album_id ?? ''),
      albumAudioId: String(row.album_audio_id ?? ''),
      duration: Math.max(0, Math.round(Number(row.duration || 0))),
      cover: coverUrl(row.trans_param?.union_cover ?? row.imgurl ?? ''),
      // fail_process / pay_type：非 0 表示这张专辑有付费或权限限制（与 QQ 的 pay/trial 同义）
      pay: Number(row.pay_type ?? row.feetype ?? 0) ? 1 : 0,
      trial: Number(row.fail_process ?? 0) > 0,
    };
  }

  // ==================== 专辑曲目补齐 ====================

  /** mobilecdn 的 album/song 行**没有** songname / singername / album_name（只有 filename，
   *  酷狗约定「歌手 - 歌名」；单曲搜索那条链才有完整字段）。不补的话队列里一整列都是
   *  「周杰伦 - 龙战骑士」这种拼接名、歌手栏还是空的。补齐顺序：专辑信息 → filename 拆分。 */
  function enrichAlbumSong(row, album) {
    const song = mapSong(row);
    if (!row.songname && row.filename) {
      const file = String(row.filename).trim();
      // 只认「A - B」这一种：拆不出就整串当歌名，宁可不拆也别把歌名切坏
      const m = /^(.{1,60}?)\s+-\s+(.+)$/.exec(file);
      if (m) {
        song.name = m[2].trim();
        if (!song.artist) song.artist = m[1].trim();
      } else {
        song.name = file;
      }
    }
    if (!song.artist) song.artist = album.artist || '';
    if (!song.albumName) song.albumName = album.name || '';
    if (!song.albumId) song.albumId = album.id || '';
    if (!song.cover) song.cover = album.cover || '';
    return song;
  }

  // ==================== 取流 ====================

  /** 主链：/v5/url（android 签名 + signKey + dfid + 登录态）。返回 {url, br, type, level} 或 {msg} */
  async function streamUrlV5(device, song, level) {
    const spec = LEVELS[level] || LEVELS.standard;
    const hash = String(song.hash || '').toLowerCase();
    const user = jar();
    const q = baseQuery(device, {
      album_id: Number(song.albumId || 0),
      area_code: 1,
      hash,
      ssa_flag: 'is_fromtrack',
      version: 11430,
      page_id: 151369488,
      quality: spec.quality,
      album_audio_id: Number(song.albumAudioId || 0),
      behavior: 'play',
      pid: 2,
      cmd: 26,
      pidversion: 3001,
      IsFreePart: 0,
      ppage_id: '',
      cdnBackup: 1,
      module: '',
      clientver: 11430,
    });
    q.key = signKey(hash, device.mid, user.userid || 0, APPID);
    q.signature = signAndroid(q);
    const url = `${GW_BASE}/v5/url?${new URLSearchParams(
      Object.entries(q).map(([k, v]) => [k, String(v)])
    ).toString()}`;
    const res = await fetch(url, {
      headers: Object.assign(deviceHeaders(device, q), { 'x-router': 'trackercdn.kugou.com' }),
      signal: timeout(15000),
    });
    let body = {};
    try {
      body = JSON.parse(await res.text());
    } catch (_) {}
    const first = Array.isArray(body.url) && body.url[0] ? String(body.url[0]) : '';
    const backup = Array.isArray(body.backupUrl) && body.backupUrl[0] ? String(body.backupUrl[0]) : '';
    return {
      url: first || backup,
      br: Number(body.bitRate) || 0,
      type: String(body.extName || '').toLowerCase(),
      level,
      // status 1 = 有 url；url 为空时多半是权限/试听限制
      raw: body,
    };
  }

  /** 兜底链：trackercdn i/v2（key = md5(hash + 'kgcloudv2')，纯匿名、无签名）。
   *  实测 https 同样可用，且这条链一律回 128k mp3（br 参数被忽略）—— 只当取流兜底。 */
  async function streamUrlLegacy(song, level) {
    const spec = LEVELS[level] || LEVELS.standard;
    const hash = String(song.hash || '').toLowerCase();
    const url =
      `https://trackercdn.kugou.com/i/v2/?key=${md5(`${hash}kgcloudv2`)}` +
      `&hash=${hash}&br=${spec.br}&appid=${APPID}&pid=2&cmd=25&behavior=play`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: timeout(15000) });
    let body = {};
    try {
      body = JSON.parse(await res.text());
    } catch (_) {}
    const first = Array.isArray(body.url) && body.url[0] ? String(body.url[0]) : '';
    return {
      url: first,
      br: Number(body.bitRate) || 0,
      type: String(body.extName || '').toLowerCase(),
      level,
      raw: body,
    };
  }

  const HASH_RE = /^[0-9a-f]{32}$/;

  // ==================== 路由 ====================

  route('GET', '/api/kugou/login/qr/key', async () => {
    const device = await ensureDevice();
    let lastErr = null;
    // 上游偶发失败（风控/网络）：再试一次，别让用户卡在第一步
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const q = baseQuery(device, {
          appid: 1001,
          type: 1,
          plat: 4,
          qrcode_txt: `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${APPID}&`,
          srcappid: SRCAPPID,
        });
        q.signature = signWeb(q);
        const url = `${LOGIN_BASE}/v2/qrcode?${new URLSearchParams(
          Object.entries(q).map(([k, v]) => [k, String(v)])
        ).toString()}`;
        const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: timeout(15000) });
        const body = JSON.parse(await res.text());
        const key = String(body?.data?.qrcode || '');
        const qrimg = String(body?.data?.qrcode_img || '');
        if (!key) throw new Error(msg('gw.kugouQrFailed'));
        return { code: 200, data: { unikey: key, qrimg } };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error(msg('gw.kugouQrFailed'));
  });

  route('GET', '/api/kugou/login/qr/check', async ({ query }) => {
    const key = String((query && query.key) || '').trim();
    if (!/^[A-Za-z0-9]{16,64}$/.test(key)) throw new Error(msg('gw.kugouMissingLoginKey'));
    const device = await ensureDevice();
    const q = baseQuery(device, {
      plat: 4,
      appid: APPID,
      srcappid: SRCAPPID,
      qrcode: key,
      dev: device.dev,
    });
    // login_qr_check 用的是 web 签名，且默认参数照常注入（与 qrcode 接口同一套）
    q.signature = signWeb(q);
    const url = `${LOGIN_BASE}/v2/get_userinfo_qrcode?${new URLSearchParams(
      Object.entries(q).map(([k, v]) => [k, String(v)])
    ).toString()}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: timeout(15000) });
    let body = {};
    try {
      body = JSON.parse(await res.text());
    } catch (_) {}
    const status = Number(body?.data?.status ?? -1);
    if (status === 0) return { code: 800 }; // 过期
    if (status === 1) return { code: 801 }; // 待扫
    if (status === 2) return { code: 802 }; // 已扫待确认
    if (status === 4) {
      const token = String(body?.data?.token || '');
      const userid = String(body?.data?.userid || '');
      if (!token || !userid) throw new Error(msg('gw.kugouLoginIncomplete'));
      // 与网易云/QQ 同语义：保存即视为校验通过（token 由上游本次下发）
      const extra = [];
      if (body?.data?.nickname) extra.push(`nickname=${body.data.nickname}`);
      if (body?.data?.vip_type != null) extra.push(`vip_type=${body.data.vip_type}`);
      if (body?.data?.vip_token) extra.push(`vip_token=${body.data.vip_token}`);
      cookieStore.write(`token=${token}; userid=${userid}${extra.length ? '; ' + extra.join('; ') : ''}`);
      log('[vinyl-server] 酷狗扫码登录成功（userid', userid + '）');
      return {
        code: 803,
        data: {
          code: 200,
          account: { id: Number(userid) || userid },
          profile: { nickname: String(body?.data?.nickname || msg('gw.kugouUser', { id: userid })), userId: userid },
        },
      };
    }
    throw new Error(msg('gw.kugouQrServiceUnavailable'));
  });

  route('GET', '/api/kugou/login/status', async () => {
    const user = jar();
    if (!user.token || !user.userid) return { code: 200, data: {} };
    return {
      code: 200,
      data: {
        code: 200,
        account: { id: Number(user.userid) || user.userid },
        profile: {
          nickname: String(user.nickname || `酷狗用户 ${user.userid}`),
          userId: user.userid,
        },
      },
    };
  });

  route('DELETE', '/api/kugou/cookie', async () => {
    cookieStore.write('');
    return { ok: true };
  });

  route('GET', '/api/kugou/search', async ({ query }) => {
    const keywords = String((query && query.keywords) || '').trim().slice(0, 100);
    if (!keywords) return { ok: false, albums: [], songs: [] };
    const page = Math.max(1, Math.floor(Number((query && query.page) || 1)) || 1);
    const [albumBody, songBody] = await Promise.all([
      h5('/api/v3/search/album', { format: 'json', keyword: keywords, page, pagesize: SEARCH_PAGE }),
      h5('/api/v3/search/song', { format: 'json', keyword: keywords, page, pagesize: SEARCH_PAGE, showtype: 1 }),
    ]);
    const albums = ((albumBody?.data && albumBody.data.info) || []).map(mapAlbum);
    const songs = ((songBody?.data && songBody.data.info) || []).map(mapSong);
    return { ok: albums.length > 0 || songs.length > 0, albums, songs };
  });

  route('GET', '/api/kugou/album', async ({ query }) => {
    const id = String((query && query.id) || '').trim();
    if (!/^\d{1,20}$/.test(id)) throw new Error(msg('gw.kugouBadAlbumId'));
    const [infoBody, songsBody] = await Promise.all([
      h5('/api/v3/album/info', { format: 'json', albumid: id }),
      h5('/api/v3/album/song', { format: 'json', albumid: id, page: 1, pagesize: -1 }),
    ]);
    const info = infoBody?.data || {};
    if (!info.albumid && !info.albumname) throw new Error(msg('gw.kugouAlbumFailed'));
    const album = mapAlbum(info);
    const songs = ((songsBody?.data && songsBody.data.info) || []).map((row) =>
      enrichAlbumSong(row, album)
    );
    // 曲目里逐条的封面是 union_cover（每首一张图）；专辑封面以专辑信息为准
    return { code: 0, data: { album, songs } };
  });

  route('GET', '/api/kugou/song/url', async ({ query }) => {
    const hash = String((query && query.id) || '').trim().toLowerCase();
    const level = LEVELS[(query && query.level) || ''] ? String(query.level) : 'standard';
    if (!HASH_RE.test(hash)) throw new Error(msg('gw.kugouBadSongId'));
    const song = {
      hash,
      albumId: String((query && query.albumId) || '0'),
      albumAudioId: String((query && query.albumAudioId) || '0'),
    };
    const device = await ensureDevice();
    let result = { url: '', br: 0, type: '', raw: {} };
    try {
      result = await streamUrlV5(device, song, level);
    } catch (e) {
      log('[vinyl-server] 酷狗 /v5/url 失败：', (e && e.message) || String(e));
    }
    if (!result.url) {
      try {
        const legacy = await streamUrlLegacy(song, level);
        if (legacy.url) result = legacy;
      } catch (e) {
        log('[vinyl-server] 酷狗 trackercdn 兜底失败：', (e && e.message) || String(e));
      }
    }
    if (result.url) {
      // 报「实际到手」的档位（兜底链只给 128k）：播放器读数不能拿请求档位冒充结果
      const actual = actualLevel(level, result.br, result.type);
      return {
        code: 200,
        data: [{ url: httpsify(result.url), br: result.br, type: result.type, level: actual, code: 200 }],
      };
    }
    return { code: 200, data: [{ url: '', code: 0, level, msg: msg('gw.kugouNoUrl') }] };
  });
}
