// QQ 音乐源客户端：与本地网关（server.js 的 /api/qq/* 路由）通信。
// 与网易云不同：QQ 只有网关单通道（无网页直连），且音质降级 ladder 在网关侧完成，
// 客户端只做一次请求 → 拿到最终可播地址或中文限制文案。
import { requestUrl } from 'obsidian';
import { Track } from './track';
import type { SongUrlResult } from './server-client';
import { getLanguage, t, tf } from './i18n';
import type {
  ApiErrorResponse,
  LoginResponse,
  QqAlbumResponse,
  QqSong,
  QrKeyResponse,
  SongUrlResponse,
} from './api-types';

export class QqService {
  constructor(
    private base: () => string,
    private token: () => string
  ) {}

  /** 网关鉴权头：会话 token 由 ServerManager 生成（见 VINYL_TOKEN） */
  private authHeaders(): Record<string, string> {
    return { 'x-vinyl-token': this.token(), 'x-vinyl-lang': getLanguage() };
  }

  private url(pathname: string, params?: Record<string, string>): string {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return `${this.base()}${pathname}${qs}`;
  }

  private async request<T>(pathname: string, options?: { method?: string; body?: string }): Promise<T> {
    const res = await requestUrl({
      url: this.url(pathname),
      headers: this.authHeaders(),
      method: options?.method,
      contentType: options?.body ? 'application/json' : undefined,
      body: options?.body,
      throw: false,
    });
    const body: unknown = res.json;
    if (res.status < 200 || res.status >= 300) {
      const error = (body as ApiErrorResponse | null)?.error;
      throw new Error(error || tf('auth.gatewayHttp', { status: res.status, path: pathname }));
    }
    return body as T;
  }

  private getJson<T>(pathname: string, params?: Record<string, string>): Promise<T> {
    return this.request<T>(params ? `${pathname}?${new URLSearchParams(params).toString()}` : pathname);
  }

  // —— 登录 ——
  async qrKey(): Promise<{ key: string; qrimg: string }> {
    const body = await this.getJson<QrKeyResponse>('/api/qq/login/qr/key');
    const d = body?.data;
    if (!d?.unikey || !d?.qrimg) throw new Error(t('auth.qqQrFailed'));
    return { key: String(d.unikey), qrimg: String(d.qrimg) };
  }

  async qrCheck(key: string): Promise<LoginResponse> {
    return this.getJson<LoginResponse>('/api/qq/login/qr/check', { key });
  }

  async loginStatus(): Promise<LoginResponse> {
    return this.getJson<LoginResponse>('/api/qq/login/status');
  }

  async validateCookie(cookie: string, signal?: AbortSignal): Promise<LoginResponse> {
    signal?.throwIfAborted();
    const body = await this.request<LoginResponse>('/api/qq/cookie/validate', {
      method: 'POST',
      body: JSON.stringify({ cookie }),
    });
    signal?.throwIfAborted();
    return body;
  }

  async setCookie(cookie: string): Promise<void> {
    await this.request<unknown>('/api/qq/cookie', {
      method: 'POST',
      body: JSON.stringify({ cookie }),
    });
  }

  async clearCookie(): Promise<void> {
    await this.request<unknown>('/api/qq/cookie', { method: 'DELETE' });
  }

  // —— 曲库 ——
  async album(mid: string): Promise<QqAlbumResponse> {
    return this.getJson<QqAlbumResponse>('/api/qq/album', { id: mid });
  }

  async songUrl(mid: string, level: string, mediaMid?: string): Promise<SongUrlResult> {
    const params: Record<string, string> = { id: mid, level };
    if (mediaMid) params.mediaMid = mediaMid;
    const body = await this.getJson<SongUrlResponse>('/api/qq/song/url', params);
    const d = body?.data?.[0];
    if (d?.url) {
      return { url: String(d.url), br: d.br, type: d.type, level: d.level };
    }
    return { restriction: d?.msg || t('auth.sourceUnavailable') };
  }

  async lyric(songmid: string): Promise<{ code?: number; lyric?: string; trans?: string }> {
    return this.getJson('/api/qq/lyric', { songmid });
  }
}

// QQ 曲目（网关归一化形态）→ 统一 Track
export function qqSongsToTracks(songs: QqSong[], albumNotePath?: string): Track[] {
  return (songs || []).map((s) => ({
    source: 'qq' as const,
    id: String(s.mid ?? ''),
    mediaMid: s.mediaMid ? String(s.mediaMid) : undefined,
    title: String(s.name ?? ''),
    artist: s.artist || undefined,
    album: s.albumName,
    cover: s.cover,
    duration: Math.max(0, Math.round(Number(s.interval || 0))),
    albumNotePath,
    pay: Number(s.pay) || 0,
    trial: !!s.trial,
  }));
}
