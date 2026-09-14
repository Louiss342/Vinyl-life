// 网易云源客户端：与本地网关（server.js）通信。
import { requestUrl } from 'obsidian';
import { Track } from './track';
import { restrictionText } from '../util';
import type {
  ApiErrorResponse,
  LoginResponse,
  NeteaseAlbumResponse,
  NeteaseSong,
  QrKeyResponse,
  SearchAlbumResponse,
  SongUrlResponse,
} from './api-types';

export interface SongUrlResult {
  url?: string;
  br?: number;
  type?: string;
  level?: string;
  /** 已映射的限制文案（url 为空且有明确限制码时） */
  restriction?: string;
}

// 音质阶梯（失败自动降级）
const QUALITY_LADDER = ['standard', 'higher', 'exhigh', 'lossless'];

export class ServerClient {
  constructor(private base: () => string) {}

  private url(pathname: string, params?: Record<string, string>): string {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return `${this.base()}${pathname}${qs}`;
  }

  private async request<T>(pathname: string, options?: { method?: string; body?: string }): Promise<T> {
    const res = await requestUrl({
      url: this.url(pathname),
      method: options?.method,
      contentType: options?.body ? 'application/json' : undefined,
      body: options?.body,
      throw: false,
    });
    const body: unknown = res.json;
    if (res.status < 200 || res.status >= 300) {
      const error = (body as ApiErrorResponse | null)?.error;
      throw new Error(error || `网关 HTTP ${res.status}（${pathname}）`);
    }
    return body as T;
  }

  private getJson<T>(pathname: string, params?: Record<string, string>): Promise<T> {
    return this.request<T>(params ? `${pathname}?${new URLSearchParams(params).toString()}` : pathname);
  }

  async ping(): Promise<boolean> {
    try {
      const r = await requestUrl({ url: this.url('/api/ping'), throw: false });
      return r.status >= 200 && r.status < 300;
    } catch {
      return false;
    }
  }

  // —— 登录 ——
  async qrKey(): Promise<string> {
    const body = await this.getJson<QrKeyResponse>('/api/login/qr/key');
    const key = body?.data?.unikey;
    if (!key) throw new Error('获取登录 unikey 失败');
    return String(key);
  }

  async qrCreate(key: string): Promise<{ qrurl: string; qrimg: string }> {
    const body = await this.getJson<QrKeyResponse>('/api/login/qr/create', { key });
    const d = body?.data;
    if (!d?.qrimg) throw new Error('生成二维码失败');
    return { qrurl: String(d.qrurl || ''), qrimg: String(d.qrimg) };
  }

  async qrCheck(key: string): Promise<LoginResponse> {
    return this.getJson<LoginResponse>('/api/login/qr/check', { key });
  }

  async loginStatus(): Promise<LoginResponse> {
    return this.getJson<LoginResponse>('/api/login/status');
  }

  async setCookie(cookie: string): Promise<void> {
    await this.request<unknown>('/api/cookie', {
      method: 'POST',
      body: JSON.stringify({ cookie }),
    });
  }

  async validateCookie(cookie: string, signal?: AbortSignal): Promise<LoginResponse> {
    signal?.throwIfAborted();
    const body = await this.request<LoginResponse>('/api/cookie/validate', {
      method: 'POST',
      body: JSON.stringify({ cookie }),
    });
    signal?.throwIfAborted();
    return body;
  }

  async clearCookie(): Promise<void> {
    await this.request<unknown>('/api/cookie', { method: 'DELETE' });
  }

  // —— 曲库 ——
  async album(id: number): Promise<NeteaseAlbumResponse> {
    return this.getJson<NeteaseAlbumResponse>('/api/album', { id: String(id) });
  }

  // 音源地址：请求指定音质；url 为空且无限制码时逐级降档（lossless 需 VIP）
  async songUrl(id: number, level: string): Promise<SongUrlResult> {
    const idx = QUALITY_LADDER.indexOf(level);
    const start = idx === -1 ? 1 : idx;
    for (let i = start; i >= 0; i--) {
      const body = await this.getJson<SongUrlResponse>('/api/song/url', {
        id: String(id),
        level: QUALITY_LADDER[i],
      });
      const d = body?.data?.[0];
      if (d?.url) {
        return { url: String(d.url), br: d.br, type: d.type, level: QUALITY_LADDER[i] };
      }
      if (d?.code != null && String(d.code) !== '200') {
        return { restriction: restrictionText(d.code) };
      }
    }
    return { restriction: '音源不可用' };
  }

  async searchAlbum(keywords: string): Promise<SearchAlbumResponse> {
    return this.getJson<SearchAlbumResponse>('/api/search', { keywords });
  }

  // 封面代理下载（避开浏览器 CORS）
  async fetchCover(url: string): Promise<ArrayBuffer> {
    const res = await requestUrl({ url: this.url('/api/cover', { url }), throw: false });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`封面下载失败 HTTP ${res.status}`);
    }
    return res.arrayBuffer;
  }
}

// 网易云曲目 → 统一 Track
export function songsToTracks(songs: NeteaseSong[], albumNotePath?: string): Track[] {
  return (songs || []).map((s) => ({
    source: 'netease' as const,
    id: Number(s.id),
    title: String(s.name ?? ''),
    artist: (s.ar || []).map((a) => a.name || '').filter(Boolean).join(' / ') || undefined,
    album: s.al?.name,
    cover: s.al?.picUrl,
    duration: Math.max(0, Math.round(Number(s.dt || 0) / 1000)),
    albumNotePath,
  }));
}
