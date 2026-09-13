// QQ 音乐源客户端：与本地网关（server.js 的 /api/qq/* 路由）通信。
// 与网易云不同：QQ 只有网关单通道（无网页直连），且音质降级 ladder 在网关侧完成，
// 客户端只做一次请求 → 拿到最终可播地址或中文限制文案。
import { Track } from './track';
import type { SongUrlResult } from './server-client';

export class QqService {
  constructor(private base: () => string) {}

  private url(pathname: string, params?: Record<string, string>): string {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return `${this.base()}${pathname}${qs}`;
  }

  private async getJson(pathname: string, params?: Record<string, string>): Promise<any> {
    const res = await fetch(this.url(pathname, params), { signal: AbortSignal.timeout(20000) });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `网关 HTTP ${res.status}（${pathname}）`);
    return body;
  }

  // —— 登录 ——
  async qrKey(): Promise<{ key: string; qrimg: string }> {
    const body = await this.getJson('/api/qq/login/qr/key');
    const d = body?.data;
    if (!d?.unikey || !d?.qrimg) throw new Error('获取 QQ 登录二维码失败');
    return { key: String(d.unikey), qrimg: String(d.qrimg) };
  }

  async qrCheck(key: string): Promise<any> {
    const body = await this.getJson('/api/qq/login/qr/check', { key });
    return body;
  }

  async loginStatus(): Promise<any> {
    return this.getJson('/api/qq/login/status');
  }

  async validateCookie(cookie: string, signal?: AbortSignal): Promise<any> {
    const res = await fetch(this.url('/api/qq/cookie/validate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie }),
      signal: signal || AbortSignal.timeout(20000),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `QQ 登录验证失败 HTTP ${res.status}`);
    return body;
  }

  async setCookie(cookie: string): Promise<void> {
    const res = await fetch(this.url('/api/qq/cookie'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `Cookie 写入失败 HTTP ${res.status}`);
  }

  async clearCookie(): Promise<void> {
    await fetch(this.url('/api/qq/cookie'), { method: 'DELETE' });
  }

  // —— 曲库 ——
  async album(mid: string): Promise<any> {
    return this.getJson('/api/qq/album', { id: mid });
  }

  async songUrl(mid: string, level: string, mediaMid?: string): Promise<SongUrlResult> {
    const params: Record<string, string> = { id: mid, level };
    if (mediaMid) params.mediaMid = mediaMid;
    const body = await this.getJson('/api/qq/song/url', params);
    const d = body?.data?.[0];
    if (d?.url) {
      return { url: String(d.url), br: d.br, type: d.type, level: d.level };
    }
    return { restriction: d?.msg || '音源不可用' };
  }

  async lyric(songmid: string): Promise<any> {
    return this.getJson('/api/qq/lyric', { songmid });
  }
}

// QQ 曲目（网关归一化形态）→ 统一 Track
export function qqSongsToTracks(songs: any[], albumNotePath?: string): Track[] {
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
