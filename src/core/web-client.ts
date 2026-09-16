// 渲染进程直连网易云：
//   走 requestUrl 发官方 weapi / eapi 请求，凭据是本机登录时落盘的 .cookie（MUSIC_U）。
//   （0.6.0 起这里一度靠「内嵌登录页共享 Electron 会话」拿凭据，但登录早已只保留扫码 ——
//   那条会话永远不会登录，网页通道一直是死的；现在改为直接读凭据文件，见 musicU()。）
//   任何一步失败都由 NeteaseService 静默回退网关（网关 Cookie 通道）。
// 加密：node:crypto 原生 weapi（双 AES-CBC + RSA_NO_PADDING）与 eapi（AES-ECB + MD5 签名），
//   与网关 server.js 完全一致，无额外依赖。
import { requestUrl } from 'obsidian';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { restrictionText, scalarText } from '../util';
import { t } from './i18n';
import type {
  LoginResponse,
  NeteaseAlbumResponse,
  NeteaseSearchResponse,
  SearchPage,
  SongUrlResponse,
} from './api-types';

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

// 两条 API 前缀（都带结尾斜杠，见 post() 里的拼接说明）
const API_BASE = {
  weapi: 'https://music.163.com/weapi/',
  eapi: 'https://interface.music.163.com/eapi/',
};

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

function weapi(object: unknown): { params: string; encSecKey: string } {
  const text = JSON.stringify(object);
  let secretKey = '';
  for (let i = 0; i < 16; i++) secretKey += BASE62.charAt(Math.floor(Math.random() * 62));
  return {
    params: aesCbcBase64(aesCbcBase64(text, PRESET_KEY, IV), secretKey, IV),
    encSecKey: rsaNoPaddingHex(secretKey, PUBLIC_KEY),
  };
}

function eapi(uri: string, object: unknown): { params: string } {
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
  } catch {
    // 还没有落盘过 deviceId（或不可读）→ 下面生成一个新的
  }
  try {
    const v = newDeviceId();
    fs.writeFileSync(file, v, { encoding: 'utf8', mode: 0o600 });
    return v;
  } catch {
    return null;
  }
}

export class WebClient {
  // 指纹 deviceId：优先用 .anon-token v2 绑定的 deviceId（与网关共用同一设备身份），
  // 否则用 .device-id 持久化的值；新用户首次运行即生成并落盘。
  private deviceId = newDeviceId();
  private anonToken = '';
  private cookieFile?: string;
  private probeCache: { at: number; state: WebLoginState } | null = null;
  private readonly PROBE_TTL = 60_000;

  constructor(anonTokenFile: string, deviceIdFile?: string, cookieFile?: string) {
    this.cookieFile = cookieFile;
    let bound = '';
    try {
      const raw = fs.readFileSync(anonTokenFile, 'utf8').trim();
      const parsed: unknown = JSON.parse(raw);
      const j = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      const token = scalarText(j.token);
      if (token) {
        this.anonToken = token;
        bound = scalarText(j.deviceId);
      } else {
        this.anonToken = raw; // 旧格式
      }
    } catch {
      // 文件不存在 / 非 JSON：按「没有匿名身份」处理（deviceId 另走 .device-id）
    }
    if (bound) {
      this.deviceId = bound;
    } else if (deviceIdFile) {
      this.deviceId = readOrCreateDeviceId(deviceIdFile) || this.deviceId;
    }
  }

  /** 本机登录凭据（网关扫码登录写下的 .cookie）。
   *  每次读盘而不是缓存：登录 / 退出账号都会重写这个文件，缓存住会出现「刚扫码登录却说未登录」。 */
  private musicU(): string {
    if (!this.cookieFile) return '';
    try {
      for (const part of fs.readFileSync(this.cookieFile, 'utf8').split(/;\s*/)) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === 'MUSIC_U') return part.slice(i + 1).trim();
      }
    } catch {
      // 没有凭据文件 = 未登录（首次使用、或已退出账号）
    }
    return '';
  }

  private async post<T>(uri: string, data: Record<string, unknown>, mode: 'weapi' | 'eapi'): Promise<T> {
    // 前缀必须以斜杠结尾：uri 形如 '/api/v1/album/1'，slice(5) 去掉 '/api/' 后直接拼在后面。
    // 少这个斜杠时上游回「HTTP 200 + {"code":404,"接口未找到！"}」—— 既不抛错也不报错，
    // 于是整条「网页会话优先」悄悄失效、全部落回网关（0.6.0 起一直如此，见 netease-search 测试）。
    const base = mode === 'weapi' ? API_BASE.weapi : API_BASE.eapi;
    const musicU = this.musicU();
    if (mode === 'eapi') data.header = this.fingerprint(musicU);
    const body =
      mode === 'weapi'
        ? new URLSearchParams(weapi(data)).toString()
        : new URLSearchParams(eapi(uri, data)).toString();
    const r = await requestUrl({
      url: `${base}${uri.slice(5)}`,
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      headers: {
        'User-Agent': mode === 'weapi' ? UA_WEAPI : UA_API,
        Referer: 'https://music.163.com',
        ...(musicU ? { Cookie: `MUSIC_U=${musicU}` } : {}),
      },
      body,
    });
    const json = r.json as { code?: number | string } | null;
    // 上游用「200 + body.code」表达失败（接口未找到 / 参数错 / 未登录…）。不在这里抛，
    // 调用方的 catch 就永远不触发 —— 兜底通道形同虚设，坏响应还会被当成正常数据往下传。
    if (json && json.code != null && Number(json.code) !== 200) {
      throw new Error(`NetEase API ${uri} returned code ${json.code}`);
    }
    return json as T;
  }

  // eapi 指纹头（对齐网关 buildFingerprintCookie：有登录凭据用 MUSIC_U，否则用 MUSIC_A 匿名身份）
  private fingerprint(musicU: string): Record<string, string> {
    const header: Record<string, string> = {
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
    if (musicU) header.MUSIC_U = musicU;
    else if (this.anonToken) header.MUSIC_A = this.anonToken;
    return header;
  }

  // 登录态探测（weapi nuser/account/get；结果缓存 60s）
  async probeLogin(force = false): Promise<WebLoginState> {
    if (!force && this.probeCache && Date.now() - this.probeCache.at < this.PROBE_TTL) {
      return this.probeCache.state;
    }
    try {
      const j = await this.post<LoginResponse>('/api/w/nuser/account/get', {}, 'weapi');
      const inner = j.data || j;
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
    } catch {
      return { loggedIn: false };
    }
  }

  async isLoggedIn(): Promise<boolean> {
    return (await this.probeLogin()).loggedIn;
  }

  // 专辑详情（weapi v1/album/{id}，与网关同源响应结构）
  async album(id: number): Promise<NeteaseAlbumResponse> {
    return this.post<NeteaseAlbumResponse>(`/api/v1/album/${id}`, {}, 'weapi');
  }

  // 搜索（网页版同款 weapi cloudsearch/get/web；会话 Cookie 由 requestUrl 自动携带）。
  // 不用旧的 /api/search/get：那条端点在带 MUSIC_U 时会稳定返回 405「操作频繁」（实测）。
  async searchAlbums(keywords: string, page?: SearchPage): Promise<NeteaseSearchResponse> {
    return this.search(keywords, 10, page);
  }

  async searchSongs(keywords: string, page?: SearchPage): Promise<NeteaseSearchResponse> {
    return this.search(keywords, 1, page);
  }

  private search(
    keywords: string,
    type: number,
    page?: SearchPage
  ): Promise<NeteaseSearchResponse> {
    return this.post<NeteaseSearchResponse>(
      '/api/cloudsearch/get/web',
      {
        s: keywords,
        type,
        limit: page?.limit ?? 30,
        offset: page?.offset ?? 0,
        total: true,
        csrf_token: '',
      },
      'weapi'
    );
  }

  // 音源地址（eapi song/enhance/player/url/v1，与网关同款降级阶梯）
  async songUrl(id: number, level: string): Promise<SongUrlResult> {
    const idx = QUALITY_LADDER.indexOf(level);
    const start = idx === -1 ? 1 : idx;
    for (let i = start; i >= 0; i--) {
      const j = await this.post<SongUrlResponse>(
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
    return { restriction: t('auth.sourceUnavailable') };
  }
}
