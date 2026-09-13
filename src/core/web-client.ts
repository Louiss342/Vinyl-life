// 渲染进程直连网易云（M0 遗留探索项落地）：
//   内嵌官方登录页（iframe）与 Obsidian 共享同一 Electron 会话——用户登录成功后，
//   会话 Cookie（MUSIC_U）随 requestUrl 自动携带，无需向网关落盘任何 Cookie。
//   未登录时由 NeteaseService 路由回退网关（网关 Cookie 通道）。
// 加密：node:crypto 原生 weapi（双 AES-CBC + RSA_NO_PADDING）与 eapi（AES-ECB + MD5 签名），
//   与网关 server.js 完全一致，无额外依赖。
import { requestUrl } from 'obsidian';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { restrictionText } from '../util';

const IV = '0102030405060708';
const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const EAPI_KEY = 'e82ckenh8dichen8';
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;
const UA_WEAPI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';
const UA_API = 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)';

const QUALITY_LADDER = ['standard', 'higher', 'exhigh', 'lossless'];

function aesCbcBase64(text: string, key: string, iv: string): string {
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('base64');
}

function aesEcbHex(text: string, key: string): string {
  const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
  return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('hex').toUpperCase();
}

function rsaNoPaddingHex(text: string, pem: string): string {
  const reversed = text.split('').reverse().join('');
  const hex = Buffer.from(reversed, 'utf8').toString('hex').padStart(256, '0');
  return crypto
    .publicEncrypt({ key: pem, padding: crypto.constants.RSA_NO_PADDING }, Buffer.from(hex, 'hex'))
    .toString('hex');
}

function weapi(object: any): { params: string; encSecKey: string } {
  const text = JSON.stringify(object);
  let secretKey = '';
  for (let i = 0; i < 16; i++) secretKey += BASE62.charAt(Math.floor(Math.random() * 62));
  return {
    params: aesCbcBase64(aesCbcBase64(text, PRESET_KEY, IV), secretKey, IV),
    encSecKey: rsaNoPaddingHex(secretKey, PUBLIC_KEY),
  };
}

function eapi(uri: string, object: any): { params: string } {
  const text = JSON.stringify(object);
  const digest = crypto
    .createHash('md5')
    .update(`nobody${uri}use${text}md5forencrypt`, 'utf8')
    .digest('hex');
  const data = `${uri}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  return { params: aesEcbHex(data, EAPI_KEY) };
}

export interface WebLoginState {
  loggedIn: boolean;
  nick?: string;
  userId?: number;
  vipType?: number;
}

export interface SongUrlResult {
  url?: string;
  br?: number;
  type?: string;
  level?: string;
  restriction?: string;
}

// 设备指纹（与 NeteaseCloudMusicApi generateDeviceId 同格式：52 位大写 hex）
function newDeviceId(): string {
  let s = '';
  const hex = '0123456789ABCDEF';
  for (let i = 0; i < 52; i++) s += hex.charAt(Math.floor(Math.random() * 16));
  return s;
}

// 读取或创建持久化 deviceId：设备身份跨重启保持稳定（降低风控概率），失败则退化为内存内随机值
function readOrCreateDeviceId(file: string): string | null {
  try {
    const cur = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9A-F]{52}$/.test(cur)) return cur;
  } catch (_) {}
  try {
    const v = newDeviceId();
    fs.writeFileSync(file, v, { encoding: 'utf8', mode: 0o600 });
    return v;
  } catch (_) {
    return null;
  }
}

export class WebClient {
  // 指纹 deviceId：优先用 .anon-token v2 绑定的 deviceId（与网关共用同一设备身份），
  // 否则用 .device-id 持久化的值；新用户首次运行即生成并落盘。
  private deviceId = newDeviceId();
  private anonToken = '';
  private probeCache: { at: number; state: WebLoginState } | null = null;
  private readonly PROBE_TTL = 60_000;

  constructor(anonTokenFile: string, deviceIdFile?: string) {
    let bound = '';
    try {
      const raw = fs.readFileSync(anonTokenFile, 'utf8').trim();
      const j = JSON.parse(raw);
      if (j.token) {
        this.anonToken = String(j.token);
        bound = String(j.deviceId || '');
      } else {
        this.anonToken = raw; // 旧格式
      }
    } catch (_) {}
    if (bound) {
      this.deviceId = bound;
    } else if (deviceIdFile) {
      this.deviceId = readOrCreateDeviceId(deviceIdFile) || this.deviceId;
    }
  }

  private async post(uri: string, data: any, mode: 'weapi' | 'eapi'): Promise<any> {
    const base = mode === 'weapi' ? 'https://music.163.com/weapi' : 'https://interface.music.163.com/eapi';
    if (mode === 'eapi') data.header = this.fingerprint();
    const body =
      mode === 'weapi'
        ? new URLSearchParams(weapi(data)).toString()
        : new URLSearchParams(eapi(uri, data)).toString();
    const r = await requestUrl({
      url: `${base}${uri.substr(5)}`,
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      headers: {
        'User-Agent': mode === 'weapi' ? UA_WEAPI : UA_API,
        Referer: 'https://music.163.com',
      },
      body,
    });
    return r.json;
  }

  // eapi 指纹头（对齐网关 buildFingerprintCookie；MUSIC_A 在未登录会话时提供匿名身份）
  private fingerprint(): any {
    const header: any = {
      osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
      deviceId: this.deviceId,
      os: 'pc',
      appver: '3.1.17.204416',
      versioncode: '140',
      mobilename: '',
      buildver: String(Date.now()).slice(0, 10),
      resolution: '1920x1080',
      __csrf: '',
      channel: 'netease',
      requestId: `${Date.now()}_${String(Math.floor(Math.random() * 1000)).padStart(4, '0')}`,
      WNMCID: `${Math.random().toString(36).slice(2, 8)}.${Date.now()}.01.0`,
      _ntes_nuid: crypto.randomBytes(16).toString('hex'),
      WEVNSM: '1.0.0',
      __remember_me: 'true',
      ntes_kaola_ad: '1',
      NMTID: crypto.randomBytes(8).toString('hex'),
    };
    if (this.anonToken) header.MUSIC_A = this.anonToken;
    return header;
  }

  // 登录态探测（weapi nuser/account/get，M0 spike 同款；结果缓存 60s）
  async probeLogin(force = false): Promise<WebLoginState> {
    if (!force && this.probeCache && Date.now() - this.probeCache.at < this.PROBE_TTL) {
      return this.probeCache.state;
    }
    try {
      const j = await this.post('/api/w/nuser/account/get', {}, 'weapi');
      const inner = j?.data || j || {};
      const nick = inner.profile?.nickname;
      const uid = inner.account?.id ?? inner.profile?.userId;
      const state: WebLoginState = {
        loggedIn: !!(nick || uid),
        nick: nick ? String(nick) : undefined,
        userId: uid != null ? Number(uid) : undefined,
        vipType: inner.profile?.vipType != null ? Number(inner.profile.vipType) : undefined,
      };
      this.probeCache = { at: Date.now(), state };
      return state;
    } catch (_) {
      return { loggedIn: false };
    }
  }

  async isLoggedIn(): Promise<boolean> {
    return (await this.probeLogin()).loggedIn;
  }

  // 专辑详情（weapi v1/album/{id}，与网关同源响应结构）
  async album(id: number): Promise<any> {
    return this.post(`/api/v1/album/${id}`, {}, 'weapi');
  }

  // 音源地址（eapi song/enhance/player/url/v1，与网关同款降级阶梯）
  async songUrl(id: number, level: string): Promise<SongUrlResult> {
    const idx = QUALITY_LADDER.indexOf(level);
    const start = idx === -1 ? 1 : idx;
    for (let i = start; i >= 0; i--) {
      const j = await this.post(
        '/api/song/enhance/player/url/v1',
        { ids: `[${id}]`, level: QUALITY_LADDER[i], encodeType: 'flac' },
        'eapi'
      );
      const d = j?.data?.[0];
      if (d?.url) {
        return { url: String(d.url), br: d.br, type: d.type, level: QUALITY_LADDER[i] };
      }
      if (d?.code != null && String(d.code) !== '200') {
        return { restriction: restrictionText(d.code) };
      }
    }
    return { restriction: '音源不可用' };
  }
}
