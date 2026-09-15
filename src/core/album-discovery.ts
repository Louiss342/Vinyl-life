import { App } from 'obsidian';
import { findAlbumNotes, getAlbumInfo } from './album-index';
import { isRateLimited } from './request-error';
import { tf } from './i18n';
import type { NeteaseService } from './netease';
import type { QqService } from './qq';
import type {
  NeteaseSearchAlbum,
  NeteaseSearchResponse,
  NeteaseSearchSong,
  QqSearchAlbum,
  QqSearchResponse,
  QqSearchSong,
} from './api-types';

export type MusicSource = 'netease' | 'qq';
export type AlbumMatchKind = 'album' | 'track';

export interface AlbumSearchCandidate {
  key: string;
  source: MusicSource;
  sourceAlbumId: string;
  title: string;
  artists: string[];
  coverUrl?: string;
  releaseDate?: string;
  trackCount?: number;
  matchedBy: AlbumMatchKind;
  matchedTrack?: string;
  importedFilePath?: string;
}

export interface AlbumSearchResult {
  items: AlbumSearchCandidate[];
  warnings: Array<{ source: MusicSource; message: string }>;
}

export interface AlbumDiscoveryContext {
  app: App;
  client: Pick<NeteaseService, 'searchAlbums' | 'searchSongs'>;
  qq: Pick<QqService, 'search'>;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function yearOf(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  if (/^\d{4}/.test(raw) && Number(raw.slice(0, 4)) >= 1900) return raw.slice(0, 10);
  const time = Number(raw);
  if (!Number.isFinite(time) || time <= 0) return undefined;
  const year = new Date(time).getFullYear();
  return Number.isFinite(year) ? String(year) : undefined;
}

function neteaseArtists(item: NeteaseSearchAlbum | NeteaseSearchSong): string[] {
  const many = 'artists' in item ? item.artists : undefined;
  const ar = 'ar' in item ? item.ar : undefined;
  const one = 'artist' in item ? item.artist : undefined;
  return (many || ar || (one ? [one] : []))
    .map((artist) => text(artist?.name))
    .filter(Boolean);
}

export function normalizeNeteaseSearch(
  albumsBody: NeteaseSearchResponse,
  songsBody: NeteaseSearchResponse
): AlbumSearchCandidate[] {
  const albums = (albumsBody.result?.albums || []).flatMap((album) => {
    if (
      album.available === false ||
      (album.status != null && Number(album.status) < 0) ||
      (album.size != null && Number(album.size) <= 0)
    ) return [];
    const id = text(album.id);
    const title = text(album.name);
    if (!id || !title) return [];
    return [{
      key: `netease:${id}`,
      source: 'netease' as const,
      sourceAlbumId: id,
      title,
      artists: neteaseArtists(album),
      coverUrl: text(album.picUrl) || undefined,
      releaseDate: yearOf(album.publishTime),
      trackCount: Number(album.size) || undefined,
      matchedBy: 'album' as const,
    }];
  });
  const songs = (songsBody.result?.songs || []).flatMap((song) => {
    if (
      song.available === false ||
      (song.status != null && Number(song.status) < 0) ||
      Number(song.copyrightId) === 0
    ) return [];
    const album = song.al || song.album;
    const id = text(album && 'id' in album ? album.id : undefined);
    const title = text(album?.name);
    if (!id || !title) return [];
    return [{
      key: `netease:${id}`,
      source: 'netease' as const,
      sourceAlbumId: id,
      title,
      artists: neteaseArtists(song),
      coverUrl: text(album?.picUrl) || undefined,
      releaseDate: yearOf('publishTime' in album ? album.publishTime : undefined),
      matchedBy: 'track' as const,
      matchedTrack: text(song.name) || undefined,
    }];
  });
  return dedupe([...albums, ...songs]);
}

export function normalizeQqSearch(body: QqSearchResponse): AlbumSearchCandidate[] {
  const albums = (body.data?.albums || []).flatMap((album: QqSearchAlbum) => {
    if (album.available === false) return [];
    const id = text(album.mid);
    const title = text(album.name);
    if (!id || !title) return [];
    return [{
      key: `qq:${id}`,
      source: 'qq' as const,
      sourceAlbumId: id,
      title,
      artists: text(album.artist) ? [text(album.artist)] : [],
      coverUrl: text(album.coverUrl) || undefined,
      releaseDate: yearOf(album.publishTime),
      trackCount: Number(album.trackCount) || undefined,
      matchedBy: 'album' as const,
    }];
  });
  const songs = (body.data?.songs || []).flatMap((song: QqSearchSong) => {
    if (song.available === false) return [];
    const id = text(song.albumMid);
    const title = text(song.albumName);
    if (!id || !title) return [];
    return [{
      key: `qq:${id}`,
      source: 'qq' as const,
      sourceAlbumId: id,
      title,
      artists: text(song.artist) ? [text(song.artist)] : [],
      coverUrl: text(song.albumCover) || undefined,
      matchedBy: 'track' as const,
      matchedTrack: text(song.name) || undefined,
    }];
  });
  return dedupe([...albums, ...songs]);
}

function dedupe(items: AlbumSearchCandidate[]): AlbumSearchCandidate[] {
  const byKey = new Map<string, AlbumSearchCandidate>();
  for (const item of items) {
    const previous = byKey.get(item.key);
    if (!previous || (previous.matchedBy === 'track' && item.matchedBy === 'album')) {
      byKey.set(item.key, item);
    }
  }
  return [...byKey.values()];
}

function score(item: AlbumSearchCandidate, query: string): number {
  const q = query.toLocaleLowerCase();
  const title = item.title.toLocaleLowerCase();
  const artists = item.artists.join(' / ').toLocaleLowerCase();
  const track = (item.matchedTrack || '').toLocaleLowerCase();
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  if (artists === q) return 70;
  if (track === q) return 60;
  if (title.includes(q)) return 50;
  if (artists.includes(q)) return 40;
  return item.matchedBy === 'album' ? 20 : 10;
}

function markImported(app: App, items: AlbumSearchCandidate[]): void {
  const imported = new Map<string, string>();
  for (const file of findAlbumNotes(app)) {
    const album = getAlbumInfo(app, file);
    if (album?.neteaseId != null) imported.set(`netease:${album.neteaseId}`, file.path);
    if (album?.qqId) imported.set(`qq:${album.qqId}`, file.path);
  }
  for (const item of items) item.importedFilePath = imported.get(item.key);
}

// ============ 搜索节流 ============
// 搜索框每敲一次字就是一轮「双源 × 网易云两次」的请求，而网易云对短时间内的重复搜索相当敏感
//（旧端点甚至会直接回 405「操作频繁」）。三层防护，从便宜到昂贵：
//   ① 缓存：同一个 query 60 秒内只发一次网（回删重打、按回车重复触发都落在这里）
//   ② 最小间隔：连续搜索之间至少隔 MIN_INTERVAL，避免「敲-停-敲」把请求打散成连发
//   ③ 冷却：上游明确说限流（HTTP 429）时，该来源暂停 COOLDOWN —— 对着限流重试只会一直撞
const CACHE_TTL = 60_000;
const MIN_INTERVAL = 600;
const COOLDOWN = 20_000;

const cache = new Map<string, { at: number; items: AlbumSearchCandidate[] }>();
const cooldownUntil: Record<MusicSource, number> = { netease: 0, qq: 0 };
let lastDispatchAt = 0;

/** 让两次实际发网至少隔 MIN_INTERVAL（首次不受限） */
async function waitForSlot(): Promise<void> {
  const wait = lastDispatchAt + MIN_INTERVAL - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => window.setTimeout(resolve, wait));
  }
  lastDispatchAt = Date.now();
}

/** 冷却中的来源这一轮不会发请求 —— 得有个说法，否则用户会把「没发请求」当成「没有结果」 */
function cooldownWarning(source: MusicSource): AlbumSearchResult['warnings'][number] {
  const left = Math.max(1, Math.ceil((cooldownUntil[source] - Date.now()) / 1000));
  return { source, message: tf('import.sourceCoolingDown', { n: left }) };
}

const SOURCES: MusicSource[] = ['netease', 'qq'];

/** 聚合搜索：双源并行，任一来源失败时仍返回另一来源的结果。 */
export async function discoverAlbums(
  ctx: AlbumDiscoveryContext,
  rawQuery: string
): Promise<AlbumSearchResult> {
  const query = rawQuery.trim();
  if (!query) return { items: [], warnings: [] };

  const key = query.toLocaleLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    // 命中缓存也要重算「已导入」：刚导完一张再搜同一个词，按钮得跟着变成「打开」
    markImported(ctx.app, hit.items);
    return { items: hit.items, warnings: [] };
  }

  await waitForSlot();

  const attempts: Array<{ source: MusicSource; run: () => Promise<AlbumSearchCandidate[]> }> = [];
  if (Date.now() >= cooldownUntil.netease) {
    attempts.push({
      source: 'netease',
      run: async () => {
        const [albums, songs] = await Promise.all([
          ctx.client.searchAlbums(query),
          ctx.client.searchSongs(query),
        ]);
        return normalizeNeteaseSearch(albums, songs);
      },
    });
  }
  if (Date.now() >= cooldownUntil.qq) {
    attempts.push({
      source: 'qq',
      run: async () => normalizeQqSearch(await ctx.qq.search(query)),
    });
  }

  const warnings: AlbumSearchResult['warnings'] = [];
  const items: AlbumSearchCandidate[] = [];
  const settled = await Promise.allSettled(attempts.map((attempt) => attempt.run()));
  settled.forEach((result, i) => {
    const { source } = attempts[i];
    if (result.status === 'fulfilled') {
      items.push(...result.value);
      return;
    }
    if (isRateLimited(result.reason)) cooldownUntil[source] = Date.now() + COOLDOWN;
    warnings.push({
      source,
      message: text((result.reason as Error | undefined)?.message || result.reason),
    });
  });
  const attempted = new Set(attempts.map((attempt) => attempt.source));
  for (const source of SOURCES) {
    if (!attempted.has(source) && Date.now() < cooldownUntil[source]) {
      warnings.push(cooldownWarning(source));
    }
  }

  const unique = dedupe(items)
    .sort((a, b) => score(b, query) - score(a, query))
    .slice(0, 20);
  markImported(ctx.app, unique);
  // 只缓存「两个来源都正常回来」的结果：带警告的结果缓存下来的话，
  // 用户在网络恢复后重搜同一个词，会被 60 秒的旧结果按住，看起来像是还没修好
  if (!warnings.length) cache.set(key, { at: Date.now(), items: unique });
  return { items: unique, warnings };
}
