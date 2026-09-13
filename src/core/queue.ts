// 队列构建（方案 5.2）：专辑 → Track[]。
// 源判定：笔记 source 显式优先；auto = 本地有音轨先播本地，否则 neteaseId → 网易云，
// 再次 qqId → QQ 音乐（两条在线源都没有时按收藏展示）。
import { AlbumInfo } from './album-index';
import { Track, sourceName } from './track';
import { LocalSource } from './local-source';
import { songsToTracks } from './server-client';
import { qqSongsToTracks, QqService } from './qq';
import { NeteaseService } from './netease';

export type QueueSource = 'local' | 'netease' | 'qq' | 'none';
export type SourcePolicy = 'auto' | 'local' | 'netease' | 'qq';
/** 已解析出的实际播放源（非 'none'） */
export type ActiveSource = 'local' | 'netease' | 'qq';

/** 播放源显示名：与曲目角标同源（track.ts 的 sourceName），调用时按当前语言求值 */
export function sourceLabel(s: ActiveSource): string {
  return sourceName(s);
}

export interface BuildQueueResult {
  tracks: Track[];
  resolvedSource: QueueSource;
  policy: SourcePolicy;
  reason?: string;
  neteaseSongs?: number;
  qqSongs?: number;
}

export interface QueueDeps {
  local: LocalSource;
  /** 统一网易云入口（网页会话优先，网关兜底，内部处理就绪） */
  netease: NeteaseService | null;
  /** QQ 音乐入口（网关单通道） */
  qq: QqService | null;
  defaultSource: SourcePolicy;
}

export async function buildAlbumQueue(
  album: AlbumInfo,
  deps: QueueDeps
): Promise<BuildQueueResult> {
  const policy: SourcePolicy =
    album.sourcePref !== 'auto' ? album.sourcePref : deps.defaultSource;

  const localTracks = await deps.local.buildTracks(album);

  if (policy === 'local') {
    if (localTracks.length) return { tracks: localTracks, resolvedSource: 'local', policy };
    return {
      tracks: [],
      resolvedSource: 'none',
      policy,
      reason: `专辑「${album.title}」没有本地音轨（audioFolder/audio 为空）`,
    };
  }

  if (policy === 'netease') {
    return buildNetease(album, deps);
  }

  if (policy === 'qq') {
    return buildQq(album, deps);
  }

  // auto：本地优先，其次网易云，再次 QQ 音乐
  if (localTracks.length) return { tracks: localTracks, resolvedSource: 'local', policy };
  if (album.neteaseId) return buildNetease(album, deps);
  if (album.qqId) return buildQq(album, deps);
  return {
    tracks: [],
    resolvedSource: 'none',
    policy,
    reason: `专辑「${album.title}」既无本地音轨，也未绑定网易云 / QQ 音乐，仅作收藏展示`,
  };
}

async function buildNetease(album: AlbumInfo, deps: QueueDeps): Promise<BuildQueueResult> {
  const policy: SourcePolicy = 'netease';
  if (!album.neteaseId) {
    return {
      tracks: [],
      resolvedSource: 'none',
      policy,
      reason: '该专辑未绑定网易云（无 neteaseId / netease 链接）',
    };
  }
  if (!deps.netease) {
    return { tracks: [], resolvedSource: 'none', policy, reason: '网易云源不可用' };
  }
  try {
    const body = await deps.netease.album(album.neteaseId);
    const songs = body?.songs || [];
    if (!songs.length) {
      return {
        tracks: [],
        resolvedSource: 'none',
        policy,
        reason: `专辑接口无曲目（code=${body?.code}）`,
      };
    }
    const tracks = songsToTracks(songs, album.path);
    return { tracks, resolvedSource: 'netease', policy, neteaseSongs: tracks.length };
  } catch (e) {
    return {
      tracks: [],
      resolvedSource: 'none',
      policy,
      reason: `获取网易云专辑失败：${(e as Error).message}`,
    };
  }
}

async function buildQq(album: AlbumInfo, deps: QueueDeps): Promise<BuildQueueResult> {
  const policy: SourcePolicy = 'qq';
  if (!album.qqId) {
    return {
      tracks: [],
      resolvedSource: 'none',
      policy,
      reason: '该专辑未绑定 QQ 音乐（无 qqId / qq 链接）',
    };
  }
  if (!deps.qq) {
    return { tracks: [], resolvedSource: 'none', policy, reason: 'QQ 音乐源不可用' };
  }
  try {
    const body = await deps.qq.album(album.qqId);
    const songs = body?.data?.songs || [];
    if (!songs.length) {
      return {
        tracks: [],
        resolvedSource: 'none',
        policy,
        reason: `QQ 音乐专辑接口无曲目（${body?.msg || 'code=' + body?.code}）`,
      };
    }
    const tracks = qqSongsToTracks(songs, album.path);
    return { tracks, resolvedSource: 'qq', policy, qqSongs: tracks.length };
  } catch (e) {
    return {
      tracks: [],
      resolvedSource: 'none',
      policy,
      reason: `获取 QQ 音乐专辑失败：${(e as Error).message}`,
    };
  }
}
