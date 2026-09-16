// 统一 Track 抽象：队列统一为 Track[]，播放时按 source 各自解析为可播放地址。
// 前端只面向 Track 编程，增删音源不碰播放器逻辑。
import { TFile } from 'obsidian';
import { t } from './i18n';

export type TrackSource = 'local-vault' | 'local-external' | 'netease' | 'qq';

export interface TrackMeta {
  title: string;
  artist?: string;
  album?: string;
  /** 已解析的可显示封面（app:// / http(s) / 色值）；本地音轨继承专辑笔记 */
  cover?: string;
  /** 来源专辑笔记路径（统计/感想联动用） */
  albumNotePath?: string;
}

export type Track =
  | (TrackMeta & { source: 'local-vault'; file: TFile; duration?: number })
  | (TrackMeta & { source: 'local-external'; path: string; duration?: number })
  | (TrackMeta & { source: 'netease'; id: number; duration: number })
  | (TrackMeta & {
      source: 'qq';
      /** songmid（字母数字串，非数字） */
      id: string;
      /** 付费曲目的媒体 mid（vkey 取链用；缺省回退 id） */
      mediaMid?: string;
      duration: number;
      /** QQ 侧付费标记（1=付费）与试听标记（限制文案用） */
      pay?: number;
      trial?: boolean;
    });

export function trackKey(t: Track): string {
  switch (t.source) {
    case 'local-vault':
      return 'vault:' + t.file.path;
    case 'local-external':
      return 'ext:' + t.path;
    case 'netease':
      return 'ne:' + t.id;
    case 'qq':
      return 'qq:' + t.id;
    default:
      // 兜底：未知来源也不得静默归并（stats / 播放缓存的键必须唯一）
      return 'unknown:' + String((t as { source?: string }).source || '?');
  }
}

// —— 队列顺序（纯函数：不碰引擎状态，便于单测）——

/** 队列重排内核：把 from 处的元素移到结果数组的 to 位（to = 结果下标，先移除再插入）。
 *  越界（from / to 不在 0..length-1）返回原数组副本；任何情况下都不改原数组。
 *  只作用于本次会话：拖拽结果不落盘、下次播这张专辑仍是发行顺序。 */
export function reorderTracks(tracks: Track[], from: number, to: number): Track[] {
  const next = [...tracks];
  if (!Number.isInteger(from) || !Number.isInteger(to)) return next;
  if (from < 0 || from >= tracks.length) return next;
  if (to < 0 || to >= tracks.length) return next;
  if (from === to) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** 播放源显示名（三个来源的唯一出处：队列角标与播放器读数共用）。
 *  必须保持「函数」形态：写进模块级常量会在加载期定型，切语言后不跟着变。 */
export function sourceName(s: 'local' | 'netease' | 'qq'): string {
  if (s === 'netease') return t('src.netease');
  if (s === 'qq') return t('src.qq');
  return t('src.local');
}

export function trackSourceLabel(t: Track): string {
  if (t.source === 'netease') return sourceName('netease');
  if (t.source === 'qq') return sourceName('qq');
  return sourceName('local');
}

export function trackSourceClass(t: Track): 'is-local' | 'is-net' | 'is-qq' {
  if (t.source === 'netease') return 'is-net';
  if (t.source === 'qq') return 'is-qq';
  return 'is-local';
}

export function isLocalTrack(t: Track): boolean {
  return t.source === 'local-vault' || t.source === 'local-external';
}
