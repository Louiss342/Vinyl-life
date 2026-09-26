// 专辑墙排序：状态 + 比较器 + 陈列面板的方向文案（视图只负责接线与画下拉）。
// 交互约定（工具栏方案 2026-09-18）：依据与方向是两个独立下拉，不再靠重复点击翻转方向；
// 方向给具体文案（A → Z / 最新在前 / 最多在前…）；缺失排序属性的专辑一律排最后（与方向无关）。
// 方向词分两族：A → Z / Z → A 两种语言写法一致，直接写在代码里、不进词典（词典测试也要求中英不同）；
// 其余走 sort.dir.* 键族。t() 一律在调用时求值，不写进模块级常量（语言切换后才不会僵住）。
// 依赖方向：util ← shelf-props ← 本模块；视图（shelf-view）单向引用本模块。

import { t } from './i18n';
import { propLabel } from './shelf-props';
import { parseLeadingNumber } from './rating';

export type SortBasis = 'title' | 'artist' | 'year' | 'plays' | 'rating' | 'recent' | 'custom';
export type SortDir = 'asc' | 'desc';

/** 下拉顺序 = 设计稿顺序（测试盯着这个） */
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

/** 换依据（独立下拉）：带这个依据的默认方向 —— 方向下拉跟着换文案，用户再单独调 */
export function setSortBasis(cur: ShelfSort, basis: SortBasis): ShelfSort {
  if (cur.basis === basis) return cur;
  // 固定依据之间互切：方向回到新依据的默认档；切走时自定义键一并丢掉
  return { basis, dir: defaultDirOf(basis) };
}

/** 选一个自定义属性：换属性时按升序（文本 A→Z / 数值小→大），仍留在自定义依据上 */
export function setCustomSortKey(cur: ShelfSort, key: string): ShelfSort {
  if (cur.basis === 'custom' && cur.custom === key) return cur;
  return { basis: 'custom', dir: 'asc', custom: key };
}

/** 换方向（独立下拉）：只动 dir，依据与属性键都不碰 */
export function setSortDir(cur: ShelfSort, dir: SortDir): ShelfSort {
  return cur.dir === dir ? cur : { ...cur, dir };
}

/** 方向的显示文案：具体动作，与依据绑定（A → Z / 最新在前 / 最多在前…） */
export function dirWord(basis: SortBasis, dir: SortDir): string {
  const asc = dir === 'asc';
  switch (basis) {
    case 'title':
    case 'artist':
      return asc ? 'A → Z' : 'Z → A'; // 两种语言写法一致：不进词典
    case 'year':
      return asc ? t('sort.dir.earliestFirst') : t('sort.dir.newestFirst');
    case 'plays':
      return asc ? t('sort.dir.leastFirst') : t('sort.dir.mostFirst');
    case 'rating':
      return asc ? t('sort.dir.lowFirst') : t('sort.dir.highFirst');
    case 'recent':
      return asc ? t('sort.dir.earliestFirst') : t('sort.dir.recentFirst');
    case 'custom':
      return asc ? t('sort.dir.asc') : t('sort.dir.desc');
  }
}

/** 方向下拉的两个选项（先升后降，与 defaultDirOf 无关 —— 用户看到的就是两个方向） */
export function sortDirOptions(basis: SortBasis): Array<{ dir: SortDir; label: string }> {
  return [
    { dir: 'asc', label: dirWord(basis, 'asc') },
    { dir: 'desc', label: dirWord(basis, 'desc') },
  ];
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

const text = (v: string | undefined): string => (v ?? '').trim();

/** 数值化：先从「人写的」值里读第一个数（见 core/rating 的口径）——
 *  '1997年' / '2003-05' 读得出年份，'4/5' 读得出评分；读不出来（'待定' 这类）才算缺失，
 *  由调用方排到最后。空串与 null 同样是缺失。 */
function numOf(v: string | number | undefined): number | undefined {
  if (v == null) return undefined;
  const n = parseLeadingNumber(v);
  return n === null ? undefined : n;
}

/** 这一张按当前依据有没有可排的属性：没有的一律排最后（空歌手 / 空年份 / 没播过 / 空属性…） */
function missingOf(x: ShelfSortable, sort: ShelfSort, stats: ShelfSortStats): boolean {
  switch (sort.basis) {
    case 'title':
      return false; // 标题必填
    case 'artist':
      return !text(x.artist);
    case 'year':
      return numOf(x.year) === undefined;
    case 'rating':
      return numOf(x.rating) === undefined;
    case 'plays':
      return !(stats.albums?.[x.path]?.plays ?? 0); // 0 次 = 还没播过 = 没有这个属性
    case 'recent':
      return !(stats.albums?.[x.path]?.lastPlayedAt ?? 0);
    case 'custom':
      return !sort.custom || !text(x.displayProps?.[sort.custom]);
  }
}

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

/** 自然序（升序方向）比较：返回负数 = a 在前。缺失值不进这里（见 missingOf） */
function naturalCompare(a: ShelfSortable, b: ShelfSortable, sort: ShelfSort, stats: ShelfSortStats): number {
  switch (sort.basis) {
    case 'title':
      return a.title.localeCompare(b.title, 'zh-CN');
    case 'artist':
      return text(a.artist).localeCompare(text(b.artist), 'zh-CN');
    case 'year':
      return (numOf(a.year) ?? 0) - (numOf(b.year) ?? 0);
    case 'rating':
      return (numOf(a.rating) ?? 0) - (numOf(b.rating) ?? 0);
    case 'plays':
      return (stats.albums?.[a.path]?.plays ?? 0) - (stats.albums?.[b.path]?.plays ?? 0);
    case 'recent':
      return (stats.albums?.[a.path]?.lastPlayedAt ?? 0) - (stats.albums?.[b.path]?.lastPlayedAt ?? 0);
    case 'custom':
      return sort.custom ? compareProp(a, b, sort.custom) : 0;
  }
}

/** 排序（返回新数组，不改入参）：缺失属性恒排最后，其余按方向；desc 只翻转有值的那一段 */
export function sortShelfEntries<T extends { album: ShelfSortable }>(
  list: readonly T[],
  sort: ShelfSort,
  stats: ShelfSortStats = {}
): T[] {
  const out = [...list];
  out.sort((x, y) => {
    const mx = missingOf(x.album, sort, stats);
    const my = missingOf(y.album, sort, stats);
    if (mx !== my) return mx ? 1 : -1;
    const c = naturalCompare(x.album, y.album, sort, stats);
    return sort.dir === 'desc' ? -c : c;
  });
  return out;
}

/** 依据 / 自定义属性的下拉文案（面板要用）：固定依据用 sort.*，自定义属性带属性名 */
export function basisName(basis: SortBasis, custom?: string, propLabels?: Record<string, string>): string {
  if (basis === 'custom') return custom ? propLabel(custom, propLabels) : t('sort.custom');
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
    default:
      return t('sort.custom');
  }
}
