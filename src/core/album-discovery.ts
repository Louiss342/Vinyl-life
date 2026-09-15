import { App } from 'obsidian';
import { findAlbumNotes, getAlbumInfo } from './album-index';
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

/** 聚合搜索：双源并行，任一来源失败时仍返回另一来源的结果。 */
export async function discoverAlbums(
  ctx: AlbumDiscoveryContext,
  rawQuery: string
): Promise<AlbumSearchResult> {
  const query = rawQuery.trim();
  if (!query) return { items: [], warnings: [] };
  const [netease, qq] = await Promise.allSettled([
    Promise.all([ctx.client.searchAlbums(query), ctx.client.searchSongs(query)]),
    ctx.qq.search(query),
  ]);
  const warnings: AlbumSearchResult['warnings'] = [];
  const items: AlbumSearchCandidate[] = [];
  if (netease.status === 'fulfilled') {
    items.push(...normalizeNeteaseSearch(netease.value[0], netease.value[1]));
  } else {
    warnings.push({ source: 'netease', message: text(netease.reason?.message || netease.reason) });
  }
  if (qq.status === 'fulfilled') {
    items.push(...normalizeQqSearch(qq.value));
  } else {
    warnings.push({ source: 'qq', message: text(qq.reason?.message || qq.reason) });
  }
  const unique = dedupe(items)
    .sort((a, b) => score(b, query) - score(a, query))
    .slice(0, 20);
  markImported(ctx.app, unique);
  return { items: unique, warnings };
}
