// 播放统计：聚合数 + 逐次播放事件 + 专辑快照，存插件 data.json，不污染笔记。
export interface AlbumStatSnapshot {
  title: string;
  artist?: string;
  year?: string | number;
  genre?: string;
  rating?: string | number;
  cover?: string;
  coverRaw?: string;
  /** 封面在 vault 中的原路径（恢复专辑时可放回原处） */
  coverVaultPath?: string;
  /** 插件目录下的历史封面副本，删除专辑后仍可展示 */
  cachedCover?: string;
  neteaseId?: number;
  qqId?: string;
  kugouId?: string;
  audioFolderRef?: string;
  audioRefs?: string[];
  sourcePref?: 'auto' | 'local' | 'netease' | 'qq' | 'kugou';
  displayProps?: Record<string, string>;
  /** 删除前保留的原 YAML frontmatter（不保存正文） */
  frontmatter?: string;
}

export interface AlbumPlayStat {
  plays: number;
  lastPlayedAt: number;
  lastTrack?: string;
  snapshot?: AlbumStatSnapshot;
}

export interface PlayEvent {
  at: number;
  albumPath?: string;
  trackKey: string;
}

export interface VinylStats {
  totalPlays: number;
  albums: Record<string, AlbumPlayStat>;
  tracks: Record<string, { plays: number; lastPlayedAt: number }>;
  /** 新版日历所需的逐次记录；旧版数据无法反推，故从升级后开始累积 */
  events: PlayEvent[];
}

export const EMPTY_STATS: VinylStats = { totalPlays: 0, albums: {}, tracks: {}, events: [] };

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && isFinite(value) && value >= 0 ? value : 0;
}

// 深拷贝归一（loadData 合并用，避免共享 DEFAULT_SETTINGS 的引用）
export function ensureStats(s?: Partial<VinylStats> | null): VinylStats {
  const albums: VinylStats['albums'] = {};
  for (const [path, raw] of Object.entries(s?.albums ?? {})) {
    if (!raw || typeof raw !== 'object') continue;
    albums[path] = {
      ...raw,
      plays: finiteNonNegative(raw.plays),
      lastPlayedAt: finiteNonNegative(raw.lastPlayedAt),
      snapshot: raw.snapshot
        ? {
            ...raw.snapshot,
            audioRefs: [...(raw.snapshot.audioRefs ?? [])],
            displayProps: { ...(raw.snapshot.displayProps ?? {}) },
          }
        : undefined,
    };
  }
  const tracks: VinylStats['tracks'] = {};
  for (const [key, raw] of Object.entries(s?.tracks ?? {})) {
    if (!raw || typeof raw !== 'object') continue;
    tracks[key] = {
      plays: finiteNonNegative(raw.plays),
      lastPlayedAt: finiteNonNegative(raw.lastPlayedAt),
    };
  }
  const events = Array.isArray(s?.events)
    ? s.events
        .filter(
          (e): e is PlayEvent =>
            !!e &&
            typeof e === 'object' &&
            typeof e.at === 'number' &&
            isFinite(e.at) &&
            e.at > 0 &&
            typeof e.trackKey === 'string'
        )
        .map((e) => ({ at: e.at, trackKey: e.trackKey, albumPath: e.albumPath }))
    : [];
  return { totalPlays: finiteNonNegative(s?.totalPlays), albums, tracks, events };
}

export function recordTrackPlay(
  stats: VinylStats,
  key: string,
  albumPath?: string,
  albumTitle?: string,
  trackTitle?: string,
  snapshot?: AlbumStatSnapshot,
  now = Date.now()
): VinylStats {
  stats.totalPlays++;
  const t = stats.tracks[key] ?? { plays: 0, lastPlayedAt: 0 };
  t.plays++;
  t.lastPlayedAt = now;
  stats.tracks[key] = t;
  stats.events.push({ at: now, albumPath, trackKey: key });
  if (albumPath) {
    const a = stats.albums[albumPath] ?? { plays: 0, lastPlayedAt: 0 };
    a.plays++;
    a.lastPlayedAt = now;
    if (trackTitle) a.lastTrack = trackTitle;
    if (snapshot) a.snapshot = { ...a.snapshot, ...snapshot };
    else if (albumTitle && !a.snapshot) a.snapshot = { title: albumTitle };
    stats.albums[albumPath] = a;
  }
  return stats;
}

export function localDayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地零点：日历按「日」对齐时用（不能用 UTC 截断，跨时区会错一天） */
export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** 热力日历的一列 = 一周（日→六，与左侧星期标签对齐） */
export interface CalendarColumn {
  /** 该列第一格（周日）的本地零点 */
  start: Date;
  days: Date[];
}

/**
 * 热力日历的列：**时间倒序**——第 0 列是「含今天的那一周」，往右每列回退一周。
 * 今天落在第 0 列，打开面板不用横向滚动就能看到最近的播放；
 * 本列今天之后的几天仍是未来格（渲染时置灰）。
 */
export function calendarColumns(today: Date, weeks = 53): CalendarColumn[] {
  const day0 = startOfLocalDay(today);
  const weekEnd = new Date(day0);
  weekEnd.setDate(weekEnd.getDate() + (6 - weekEnd.getDay())); // 本周六 = 第 0 列最后一格
  const columns: CalendarColumn[] = [];
  for (let c = 0; c < weeks; c++) {
    const start = new Date(weekEnd);
    start.setDate(start.getDate() - (6 + 7 * c));
    columns.push({
      start,
      days: Array.from({ length: 7 }, (_, r) => {
        const day = new Date(start);
        day.setDate(start.getDate() + r);
        return day;
      }),
    });
  }
  return columns;
}

/** 月份标题：每段连续同月的列一个标题，标在这段最左（即离今天最近）的那一列上方 */
export interface CalendarMonthLabel {
  /** 标题落在第几列 */
  column: number;
  /** 这段月份占几列：只有 1 列时标题比格子宽，渲染要改右对齐（见 stats-page） */
  span: number;
  /** 取月份用的那天（该列里最新的一天；未来格不算） */
  month: Date;
}

/** 列归属哪个「月」：看这列里最新的一天。跨月的边界周因此归给占多数的那一侧。 */
function columnMonth(col: CalendarColumn, today: Date): Date {
  let newest = col.days[0];
  for (const day of col.days) {
    if (day.getTime() > today.getTime()) continue; // 未来格不参与
    if (day.getTime() >= newest.getTime()) newest = day;
  }
  return newest;
}

export function calendarMonthLabels(columns: CalendarColumn[], today: Date): CalendarMonthLabel[] {
  const labels: CalendarMonthLabel[] = [];
  let currentKey = Number.NaN;
  for (let c = 0; c < columns.length; c++) {
    const month = columnMonth(columns[c], today);
    const key = month.getFullYear() * 12 + month.getMonth();
    if (key === currentKey) labels[labels.length - 1].span++;
    else {
      currentKey = key;
      labels.push({ column: c, span: 1, month });
    }
  }
  return labels;
}

export function playsByDay(stats: VinylStats): Map<string, PlayEvent[]> {
  const days = new Map<string, PlayEvent[]>();
  for (const event of stats.events) {
    const key = localDayKey(event.at);
    const list = days.get(key) ?? [];
    list.push(event);
    days.set(key, list);
  }
  return days;
}

// 最近播放的专辑（按 lastPlayedAt 降序）
export function recentAlbums(stats: VinylStats, n: number): { path: string; title: string }[] {
  return Object.entries(stats.albums)
    .sort((a, b) => b[1].lastPlayedAt - a[1].lastPlayedAt)
    .slice(0, n)
    .map(([path, stat]) => ({
      path,
      title: stat.snapshot?.title || path.split('/').pop()?.replace(/\.md$/, '') || path,
    }));
}
