// 统一 Track 抽象（方案 4.2 关键设计）：
// 队列统一为 Track[]，播放时按 source 各自解析为可播放地址；
// 前端只面向 Track 编程，增删音源不碰播放器逻辑。
import { TFile } from 'obsidian';

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

export function trackSourceLabel(t: Track): string {
  if (t.source === 'netease') return '网易云';
  if (t.source === 'qq') return 'QQ音乐';
  return '本地';
}

export function trackSourceClass(t: Track): 'is-local' | 'is-net' | 'is-qq' {
  if (t.source === 'netease') return 'is-net';
  if (t.source === 'qq') return 'is-qq';
  return 'is-local';
}

export function isLocalTrack(t: Track): boolean {
  return t.source === 'local-vault' || t.source === 'local-external';
}

// 在线音源「实际拿到」的音质档（接口返回 level，可能低于请求档）→ 显示文案；
// 本地音轨无此概念（按原文件播放），返回空串。
const QUALITY_TEXT: Record<string, string> = {
  standard: '标准',
  higher: '较高',
  exhigh: '极高',
  lossless: '无损',
};

export function qualityText(level?: string): string {
  return level ? QUALITY_TEXT[level] || level : '';
}
