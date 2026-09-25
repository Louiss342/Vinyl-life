import * as fs from 'fs';
import * as path from 'path';
import type { App } from 'obsidian';
import { AlbumInfo, AlbumSources, detectAlbumSources } from './album-index';
import type { ActiveSource } from './queue';

export type HealthIssueKind = 'external' | 'cover' | 'source' | 'playback';

export interface LibraryHealthIssue {
  album: AlbumInfo;
  kind: HealthIssueKind;
  /** error = 真的坏了，要修；note = 只是「可以更好」（无音源 / 无封面这类）。
   *  无音源、无封面的专辑很可能是有意保存的乐评，不该和失效引用混在一张待办单里。 */
  severity: 'error' | 'note';
  detail: string;
  /** 播放失败发生的时间（只有 playback 类有）：界面上标「什么时候坏的」 */
  at?: number;
  /** 出问题的音源策略（只有 playback 类有）：界面上「重试并清除」要按它重试 */
  source?: ActiveSource | 'auto';
}

/** 错误（要修）与提示（可以不管）分开：**失效引用 / 播放失败 / 指定音源不可用** 是错误；
 *  「完全没有音源」「没有封面」只是提示 —— 而且标了「仅收藏」的专辑连提示都不出。 */
function issueFor(album: AlbumInfo, kind: HealthIssueKind, detail: string): LibraryHealthIssue | null {
  switch (kind) {
    case 'external':
    case 'playback':
      return { album, kind, severity: 'error', detail };
    case 'source':
      // detail 为空 = 这张一个音源都没有（很可能是有意只收藏的乐评）；
      // 有 detail = 用户在笔记里指定了某个音源，而它现在不可用 —— 这是错误
      if (!detail) return album.collectOnly ? null : { album, kind, severity: 'note', detail };
      return { album, kind, severity: 'error', detail };
    case 'cover':
      return album.collectOnly ? null : { album, kind, severity: 'note', detail };
  }
}

function externalRef(ref: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(ref) || path.isAbsolute(ref);
}

/** 静态检查 + 已知播放失败；在线音源不会在扫描时批量请求平台。 */
export function scanLibraryHealth(
  app: App,
  albums: AlbumInfo[],
  failures: Record<string, { message: string; at: number }>
): LibraryHealthIssue[] {
  const issues: LibraryHealthIssue[] = [];
  for (const album of albums) {
    for (const ref of [album.audioFolderRef, ...album.audioRefs]) {
      if (ref && externalRef(ref) && !fs.existsSync(ref)) {
        const issue = issueFor(album, 'external', ref);
        if (issue) issues.push(issue);
      }
    }
    if (!album.cover) {
      const issue = issueFor(album, 'cover', album.coverRaw || '');
      if (issue) issues.push(issue);
    }
    const sources = detectAlbumSources(app, album);
    if (!Object.values(sources).some(Boolean)) {
      const issue = issueFor(album, 'source', '');
      if (issue) issues.push(issue);
    } else if (album.sourcePref !== 'auto' && !sources[album.sourcePref]) {
      const issue = issueFor(album, 'source', album.sourcePref);
      if (issue) issues.push(issue);
    }
    for (const source of ['auto', 'local', 'netease', 'qq', 'kugou'] as Array<ActiveSource | 'auto'>) {
      const failure = failures[`${album.path}:${source}`];
      if (failure) {
        const issue = issueFor(album, 'playback', `${source}: ${failure.message}`);
        if (issue) issues.push({ ...issue, at: failure.at, source });
      }
    }
  }
  return issues;
}

export interface SourceFailure {
  message: string;
  at: number;
}

// ============ 在线试播：范围 ============

/** 试播范围：全部已关联音源 / 只试每张「实际会用」的那一个 / 只试上次失败的。 */
export type ProbeScope = 'all' | 'current' | 'failing';

export const PROBE_SCOPES: readonly ProbeScope[] = ['all', 'current', 'failing'];

export function normalizeProbeScope(v: unknown): ProbeScope {
  return v === 'current' || v === 'failing' ? v : 'all';
}

/** 子集：本地音轨由静态检查负责，不用试播 */
export type OnlineSource = Exclude<ActiveSource, 'local'>;

export const ONLINE_SOURCES: readonly OnlineSource[] = ['netease', 'qq', 'kugou'];

export interface ProbeJob {
  album: AlbumInfo;
  source: OnlineSource;
}

/** 每张专辑「实际会用」的音源：笔记里指定了就按它，否则按自动选源的优先级
 *  （本地 > 网易云 > QQ > 酷狗，与 buildAlbumQueue 同一套口径）。纯本地或没音源的返回 null。 */
function effectiveSource(album: AlbumInfo, sources: AlbumSources): ActiveSource | null {
  if (album.sourcePref !== 'auto') return sources[album.sourcePref] ? album.sourcePref : null;
  for (const source of ['local', 'netease', 'qq', 'kugou'] as ActiveSource[]) {
    if (sources[source]) return source;
  }
  return null;
}

/** 试播清单：只列在线音源（本地音轨由静态检查负责，不用试播）。 */
export function probeJobs(
  app: App,
  albums: AlbumInfo[],
  failures: Record<string, SourceFailure>,
  scope: ProbeScope = 'all'
): ProbeJob[] {
  const jobs: ProbeJob[] = [];
  for (const album of albums) {
    const sources = detectAlbumSources(app, album);
    if (scope === 'failing') {
      for (const source of ONLINE_SOURCES) {
        if (sources[source] && failures[`${album.path}:${source}`]) jobs.push({ album, source });
      }
      continue;
    }
    if (scope === 'current') {
      const source = effectiveSource(album, sources);
      if (source && source !== 'local') jobs.push({ album, source });
      continue;
    }
    for (const source of ONLINE_SOURCES) {
      if (sources[source]) jobs.push({ album, source });
    }
  }
  return jobs;
}
