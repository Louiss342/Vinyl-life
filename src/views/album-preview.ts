// 预览只读取平台资料；确认添加之前不会下载封面或写入笔记。
import type { ImportContext, AlbumRef } from '../import';
import type { AlbumSearchCandidate } from '../core/album-discovery';
import { findAlbumNotes, getAlbumInfo } from '../core/album-index';
import { t } from '../core/i18n';

export interface AlbumPreview {
  candidate: AlbumSearchCandidate;
  tracks: Array<{ title: string; seconds: number }>;
}

export async function fetchAlbumPreview(ctx: ImportContext, ref: AlbumRef): Promise<AlbumPreview> {
  let title = '', artist = '', coverUrl: string | undefined, releaseDate: string | undefined;
  let tracks: AlbumPreview['tracks'] = [];
  const id = ref.source === 'qq' ? ref.mid : String(ref.id);
  if (ref.source === 'netease') {
    const body = await ctx.client.album(ref.id);
    title = body.album?.name || '';
    artist = body.album?.artist?.name || '';
    coverUrl = body.album?.picUrl;
    if (body.album?.publishTime) releaseDate = new Date(Number(body.album.publishTime)).getFullYear().toString();
    tracks = (body.songs || []).map((song) => ({ title: song.name || '', seconds: Number(song.dt || 0) / 1000 }));
  } else if (ref.source === 'qq') {
    const body = await ctx.qq.album(ref.mid);
    title = body.data?.album?.name || '';
    artist = body.data?.album?.artist || '';
    coverUrl = body.data?.album?.coverUrl;
    releaseDate = body.data?.album?.publishTime;
    tracks = (body.data?.songs || []).map((song) => ({ title: song.name || '', seconds: Number(song.interval || 0) }));
  } else {
    const body = await ctx.kugou.album(ref.id);
    title = body.data?.album?.name || '';
    artist = body.data?.album?.artist || '';
    coverUrl = body.data?.album?.cover;
    releaseDate = body.data?.album?.publishDate;
    tracks = (body.data?.songs || []).map((song) => ({ title: song.name || '', seconds: Number(song.duration || 0) }));
  }
  if (!title) throw new Error(t('import.previewUnavailable'));
  const field = ref.source === 'netease' ? 'neteaseId' : ref.source === 'qq' ? 'qqId' : 'kugouId';
  const inLibrary = findAlbumNotes(ctx.app).some((file) => String(getAlbumInfo(ctx.app, file)?.[field] || '') === id);
  return { candidate: { key: `${ref.source}:${id}`, source: ref.source, sourceAlbumId: id,
    title, artists: artist ? [artist] : [], coverUrl, releaseDate, trackCount: tracks.length,
    matchedBy: 'album', inLibrary }, tracks };
}
