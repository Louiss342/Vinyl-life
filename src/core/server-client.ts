// 网易云源客户端：与本地网关（server.js）通信。
import { Track } from './track';
import { restrictionText } from '../util';

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

  private async getJson(pathname: string, params?: Record<string, string>): Promise<any> {
    const res = await fetch(this.url(pathname, params), { signal: AbortSignal.timeout(20000) });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `网关 HTTP ${res.status}（${pathname}）`);
    return body;
  }

  async ping(): Promise<boolean> {
    try {
      const r = await fetch(this.url('/api/ping'));
      return r.ok;
    } catch (_) {
      return false;
    }
  }

  // —— 登录 ——
  async qrKey(): Promise<string> {
    const body = await this.getJson('/api/login/qr/key');
    const key = body?.data?.unikey;
    if (!key) throw new Error('获取登录 unikey 失败');
    return String(key);
  }

  async qrCreate(key: string): Promise<{ qrurl: string; qrimg: string }> {
    const body = await this.getJson('/api/login/qr/create', { key });
    const d = body?.data;
    if (!d?.qrimg) throw new Error('生成二维码失败');
    return { qrurl: String(d.qrurl || ''), qrimg: String(d.qrimg) };
  }

  async qrCheck(key: string): Promise<any> {
    const body = await this.getJson('/api/login/qr/check', { key });
    return body;
  }

  async loginStatus(): Promise<any> {
    return this.getJson('/api/login/status');
  }

  async setCookie(cookie: string): Promise<void> {
    const res = await fetch(this.url('/api/cookie'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `Cookie 写入失败 HTTP ${res.status}`);
  }

  async validateCookie(cookie: string, signal?: AbortSignal): Promise<any> {
    const res = await fetch(this.url('/api/cookie/validate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie }),
      signal: signal || AbortSignal.timeout(20000),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `登录验证失败 HTTP ${res.status}`);
    return body;
  }

  async clearCookie(): Promise<void> {
    await fetch(this.url('/api/cookie'), { method: 'DELETE' });
  }

  // —— 曲库 ——
  async album(id: number): Promise<any> {
    return this.getJson('/api/album', { id: String(id) });
  }

  // 音源地址：请求指定音质；url 为空且无限制码时逐级降档（lossless 需 VIP）
  async songUrl(id: number, level: string): Promise<SongUrlResult> {
    const idx = QUALITY_LADDER.indexOf(level);
    const start = idx === -1 ? 1 : idx;
    for (let i = start; i >= 0; i--) {
      const body = await this.getJson('/api/song/url', {
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

  async searchAlbum(keywords: string): Promise<any> {
    return this.getJson('/api/search', { keywords });
  }

  // 封面代理下载（避开浏览器 CORS）
  async fetchCover(url: string): Promise<ArrayBuffer> {
    const res = await fetch(this.url('/api/cover', { url }));
    if (!res.ok) throw new Error(`封面下载失败 HTTP ${res.status}`);
    return res.arrayBuffer();
  }
}

// 网易云曲目 → 统一 Track
export function songsToTracks(songs: any[], albumNotePath?: string): Track[] {
  return (songs || []).map((s) => ({
    source: 'netease' as const,
    id: Number(s.id),
    title: String(s.name ?? ''),
    artist: (s.ar || []).map((a: any) => a.name).join(' / ') || undefined,
    album: s.al?.name,
    cover: s.al?.picUrl,
    duration: Math.max(0, Math.round(Number(s.dt || 0) / 1000)),
    albumNotePath,
  }));
}
