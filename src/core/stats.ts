// 播放统计（P1）：次数/最近播放，存插件 data.json，不污染笔记（方案 5.1 规则）。
export interface AlbumPlayStat {
  plays: number;
  lastPlayedAt: number;
  lastTrack?: string;
}

export interface VinylStats {
  totalPlays: number;
  albums: Record<string, AlbumPlayStat>;
  tracks: Record<string, { plays: number; lastPlayedAt: number }>;
}

export const EMPTY_STATS: VinylStats = { totalPlays: 0, albums: {}, tracks: {} };

// 深拷贝归一（loadData 合并用，避免共享 DEFAULT_SETTINGS 的引用）
export function ensureStats(s?: Partial<VinylStats> | null): VinylStats {
  return {
    totalPlays: s?.totalPlays ?? 0,
    albums: { ...(s?.albums ?? {}) },
    tracks: { ...(s?.tracks ?? {}) },
  };
}

export function recordTrackPlay(
  stats: VinylStats,
  key: string,
  albumPath?: string,
  albumTitle?: string,
  trackTitle?: string
): VinylStats {
  stats.totalPlays++;
  const t = stats.tracks[key] ?? { plays: 0, lastPlayedAt: 0 };
  t.plays++;
  t.lastPlayedAt = Date.now();
  stats.tracks[key] = t;
  if (albumPath) {
    const a = stats.albums[albumPath] ?? { plays: 0, lastPlayedAt: 0 };
    a.plays++;
    a.lastPlayedAt = Date.now();
    if (trackTitle) a.lastTrack = trackTitle;
    stats.albums[albumPath] = a;
  }
  return stats;
}

// 最近播放的专辑（按 lastPlayedAt 降序）
export function recentAlbums(stats: VinylStats, n: number): { path: string; title: string }[] {
  return Object.entries(stats.albums)
    .sort((a, b) => b[1].lastPlayedAt - a[1].lastPlayedAt)
    .slice(0, n)
    .map(([path]) => ({ path, title: path.split('/').pop()?.replace(/\.md$/, '') || path }));
}
