// 酷狗音乐源客户端：与本地网关（server.js 的 /api/kugou/* 路由）通信。
// 与 QQ 同构：网关单通道（无网页直连），音质降级 ladder 在网关侧完成，
// 客户端只做一次请求 → 拿到最终可播地址或中文限制文案。
// 与 QQ 的唯一结构差异：取流要带 hash + 专辑 id + mixsongid（album_audio_id）三件套。
import { requestUrl } from 'obsidian';
import { Track } from './track';
import { GatewayError, withRequestTimeout } from './request-error';
import type { SongUrlResult } from './server-client';
import { getLanguage, t, tf } from './i18n';
import type {
  ApiErrorResponse,
  KugouAlbumResponse,
  KugouLyricResponse,
  KugouSearchResponse,
  KugouSong,
  LoginResponse,
  QrKeyResponse,
  SongUrlResponse,
} from './api-types';

export class KugouService {
  constructor(
    private base: () => string,
    private token: () => string
  ) {}

  /** 网关鉴权头：会话 token 由 ServerManager 生成（见 VINYL_TOKEN） */
  private authHeaders(): Record<string, string> {
    return { 'x-vinyl-token': this.token(), 'x-vinyl-lang': getLanguage() };
  }

  private async request<T>(pathname: string, options?: { method?: string; body?: string }): Promise<T> {
    const res = await withRequestTimeout(
      requestUrl({
        url: `${this.base()}${pathname}`,
        headers: this.authHeaders(),
        method: options?.method,
        contentType: options?.body ? 'application/json' : undefined,
        body: options?.body,
        throw: false,
      })
    );
    const body: unknown = res.json;
    if (res.status < 200 || res.status >= 300) {
      const error = (body as ApiErrorResponse | null)?.error;
      throw new GatewayError(
        error || tf('auth.gatewayHttp', { status: res.status, path: pathname }),
        res.status
      );
    }
    return body as T;
  }

  private getJson<T>(pathname: string, params?: Record<string, string>): Promise<T> {
    return this.request<T>(params ? `${pathname}?${new URLSearchParams(params).toString()}` : pathname);
  }

  // —— 登录 ——
  async qrKey(): Promise<{ key: string; qrimg: string }> {
    const body = await this.getJson<QrKeyResponse>('/api/kugou/login/qr/key');
    const d = body?.data;
    if (!d?.unikey || !d?.qrimg) throw new Error(t('auth.kugouQrFailed'));
    return { key: String(d.unikey), qrimg: String(d.qrimg) };
  }

  async qrCheck(key: string): Promise<LoginResponse> {
    return this.getJson<LoginResponse>('/api/kugou/login/qr/check', { key });
  }

  async loginStatus(): Promise<LoginResponse> {
    return this.getJson<LoginResponse>('/api/kugou/login/status');
  }

  async clearCookie(): Promise<void> {
    await this.request<unknown>('/api/kugou/cookie', { method: 'DELETE' });
  }

  // —— 曲库 ——
  async album(id: string): Promise<KugouAlbumResponse> {
    return this.getJson<KugouAlbumResponse>('/api/kugou/album', { id });
  }

  /** 与 QQ 一样按页码翻页（不是 offset）：页大小固定在网关侧，客户端只报第几页 */
  async search(keywords: string, page = 1): Promise<KugouSearchResponse> {
    return this.getJson<KugouSearchResponse>('/api/kugou/search', {
      keywords,
      page: String(page),
    });
  }

  /** 歌词：网关按「关键词 + hash + 时长」去上游挑候选再下载，客户端只给三样线索。
   *  酷狗没有翻译轨（trans 恒为空）；取不到就是没有 —— 视图按「空」显示，不算错误。 */
  async lyric(
    hash: string,
    opts: { title?: string; artist?: string; duration?: number; albumAudioId?: string } = {}
  ): Promise<KugouLyricResponse> {
    const params: Record<string, string> = { id: hash };
    if (opts.title) params.title = opts.title;
    if (opts.artist) params.artist = opts.artist;
    if (opts.duration) params.duration = String(opts.duration);
    if (opts.albumAudioId) params.albumAudioId = opts.albumAudioId;
    return this.getJson<KugouLyricResponse>('/api/kugou/lyric', params);
  }

  async songUrl(
    hash: string,
    level: string,
    albumId?: string,
    albumAudioId?: string
  ): Promise<SongUrlResult> {
    const params: Record<string, string> = { id: hash, level };
    if (albumId) params.albumId = albumId;
    if (albumAudioId) params.albumAudioId = albumAudioId;
    const body = await this.getJson<SongUrlResponse>('/api/kugou/song/url', params);
    const d = body?.data?.[0];
    if (d?.url) {
      return { url: String(d.url), br: d.br, type: d.type, level: d.level };
    }
    return { restriction: d?.msg || t('auth.sourceUnavailable') };
  }
}

// 酷狗曲目（网关归一化形态）→ 统一 Track
export function kugouSongsToTracks(songs: KugouSong[], albumNotePath?: string): Track[] {
  return (songs || []).map((s) => ({
    source: 'kugou' as const,
    id: String(s.hash ?? s.id ?? '').toLowerCase(),
    albumId: s.albumId ? String(s.albumId) : undefined,
    albumAudioId: s.albumAudioId ? String(s.albumAudioId) : undefined,
    title: String(s.name ?? ''),
    artist: s.artist || undefined,
    album: s.albumName,
    cover: s.cover,
    duration: Math.max(0, Math.round(Number(s.duration || 0))),
    albumNotePath,
    pay: Number(s.pay) || 0,
    trial: !!s.trial,
  }));
}
