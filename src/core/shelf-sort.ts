// 专辑墙排序：状态机 + 比较器 + 菜单文案（视图只负责接线与弹菜单）。
// 交互约定（设计稿 2026-09-16）：固定依据点一下切过来（用默认方向），已选中的再点一下翻转方向；
// 「自定义排序依据」先选属性（视图弹属性列表），选定后与固定依据同一套交互（再点即倒序）。
// 方向词分两族：A-Z / Z-A 两种语言写法一致，直接写在代码里、不进词典（词典测试也要求中英不同）；
// 其余走 sort.dir.* 键族。t() 一律在调用时求值，不写进模块级常量（语言切换后才不会僵住）。
// 依赖方向：util ← shelf-props ← 本模块；视图（shelf-view）单向引用本模块。

import { t, tf } from './i18n';
import { propLabel } from './shelf-props';

export type SortBasis = 'title' | 'artist' | 'year' | 'plays' | 'rating' | 'recent' | 'custom';
export type SortDir = 'asc' | 'desc';

/** 菜单顺序 = 设计稿顺序（测试盯着这个） */
export const SORT_BASES: readonly SortBasis[] = Object.freeze([
  'title',
  'artist',
  'year',
  'plays',
  'rating',
  'recent',
  'custom',
]);

export interface ShelfSort {
  basis: SortBasis;
  dir: SortDir;
  /** 自定义依据的 frontmatter 键：仅 basis === 'custom' 时有意义（切走即丢） */
  custom?: string;
}

export const DEFAULT_SHELF_SORT: ShelfSort = Object.freeze({ basis: 'title', dir: 'asc' });

/** 各依据的默认方向：早 / 少 / 低 / 远 在前算升序；热度类（播放次数 / 评分 / 最近播放）降序更顺手 */
export function defaultDirOf(basis: SortBasis): SortDir {
  return basis === 'plays' || basis === 'rating' || basis === 'recent' ? 'desc' : 'asc';
}

export function flipSort(cur: ShelfSort): ShelfSort {
  return { ...cur, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
}

/** 点一个依据：没选中 = 切过来（用默认方向）；已选中 = 翻转方向。切走时自定义键一并丢掉 */
export function switchSort(cur: ShelfSort, basis: SortBasis): ShelfSort {
  if (cur.basis === basis) return flipSort(cur);
  return { basis, dir: defaultDirOf(basis) };
}

/** 属性列表里选一个属性：没在自定义依据上 = 按它升序；已是同一个属性 = 翻转（与固定依据同规则） */
export function pickCustomSort(cur: ShelfSort, key: string): ShelfSort {
  if (cur.basis === 'custom' && cur.custom === key) return flipSort(cur);
  return { basis: 'custom', dir: 'asc', custom: key };
}

function basisName(basis: SortBasis): string {
  switch (basis) {
    case 'title':
      return t('sort.title');
    case 'artist':
      return t('sort.artist');
    case 'year':
      return t('sort.year');
    case 'plays':
      return t('sort.plays');
    case 'rating':
      return t('sort.rating');
    case 'recent':
      return t('sort.recent');
    case 'custom':
      return t('sort.custom');
  }
}

function dirWord(basis: SortBasis, dir: SortDir): string {
  const asc = dir === 'asc';
  switch (basis) {
    case 'title':
    case 'artist':
      return asc ? 'A-Z' : 'Z-A'; // 两种语言写法一致：不进词典
    case 'year':
      return asc ? t('sort.dir.oldNew') : t('sort.dir.newOld');
    case 'plays':
      return asc ? t('sort.dir.leastMost') : t('sort.dir.mostLeast');
    case 'rating':
      return asc ? t('sort.dir.lowHigh') : t('sort.dir.highLow');
    case 'recent':
      return asc ? t('sort.dir.oldRecent') : t('sort.dir.recentOld');
    case 'custom':
      return asc ? t('sort.dir.asc') : t('sort.dir.desc');
  }
}

/** 菜单里一项的标题：未选中显示该项的默认方向，选中显示当前方向；
 *  自定义选过属性后带上属性名（未选过 = 光秃秃一个「自定义排序依据」，由视图弹属性列表）。 */
export function sortItemLabel(
  basis: SortBasis,
  cur: ShelfSort,
  propLabels?: Record<string, string>
): string {
  const active = cur.basis === basis;
  if (basis === 'custom') {
    if (!cur.custom) return t('sort.custom');
    return tf('sort.customLabel', {
      name: propLabel(cur.custom, propLabels),
      dir: dirWord('custom', active ? cur.dir : 'asc'),
    });
  }
  return `${basisName(basis)}[${dirWord(basis, active ? cur.dir : defaultDirOf(basis))}]`;
}

// ============ 比较器 ============

/** 比较器只认这几个字段（结构类型）：不 import album-index，视图直接传 ShelfEntry / AlbumInfo */
export interface ShelfSortable {
  path: string;
  title: string;
  artist?: string;
  year?: string | number;
  rating?: string | number;
  displayProps?: Record<string, string>;
}

export interface ShelfSortStats {
  albums?: Record<string, { plays?: number; lastPlayedAt?: number } | undefined>;
}

// 缺失值按最小处理（-1，沿用例）：升序里排最前、降序里排最后。非数值串得到 NaN，比较结果按 0 处理。
const num = (v: string | number | undefined): number => (v == null || v === '' ? -1 : Number(v));

/** 自定义属性比较：两值都是数字串（年份 / 评分这类 frontmatter 数值）按数值比，否则按文本 */
function compareProp(a: ShelfSortable, b: ShelfSortable, key: string): number {
  const av = a.displayProps?.[key] ?? '';
  const bv = b.displayProps?.[key] ?? '';
  if (av !== '' && bv !== '') {
    const an = Number(av);
    const bn = Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  }
  return av.localeCompare(bv, 'zh-CN');
}

/** 排序（返回新数组，不改入参）：先按依据求自然序，desc 时整体取反 */
export function sortShelfEntries<T extends { album: ShelfSortable }>(
  list: readonly T[],
  sort: ShelfSort,
  stats: ShelfSortStats = {}
): T[] {
  const cmp = (x: T, y: T): number => {
    const a = x.album;
    const b = y.album;
    switch (sort.basis) {
      case 'title':
        return a.title.localeCompare(b.title, 'zh-CN');
      case 'artist':
        return (a.artist ?? '').localeCompare(b.artist ?? '', 'zh-CN');
      case 'year':
        return num(a.year) - num(b.year);
      case 'rating':
        return num(a.rating) - num(b.rating);
      case 'plays':
        return (stats.albums?.[a.path]?.plays ?? 0) - (stats.albums?.[b.path]?.plays ?? 0);
      case 'recent':
        return (
          (stats.albums?.[a.path]?.lastPlayedAt ?? 0) -
          (stats.albums?.[b.path]?.lastPlayedAt ?? 0)
        );
      case 'custom':
        return sort.custom ? compareProp(a, b, sort.custom) : 0;
    }
  };
  const out = [...list];
  out.sort((x, y) => (sort.dir === 'desc' ? -cmp(x, y) : cmp(x, y)));
  return out;
}
