// 卡片属性：专辑笔记 frontmatter 键 → 卡片显示值。
// 依赖方向：util ← 本模块 ← album-index（单向；禁止反向 import album-index 的运行时导出，否则成环）。
// 所有「显示什么属性」的规则都集中在这里：黑名单 / 预设别名 / 值格式化 / 旧设置迁移 / 有序变更。
// 本模块不依赖 album-index（连类型也不依赖）：属性发现的入参只要求结构上有 displayProps。

import { scalarText } from '../util';
import { t } from './i18n';

/** 默认卡片属性（顺序即显示顺序）；同时是旧 boolean 结构迁移时的键序真值。
 *  freeze 是护栏：设置里的数组与默认值可能共享引用（DEFAULT_SETTINGS 浅拷贝），
 *  所有变更函数一律返回新数组，设置只整表替换，防止「默认值」被就地改写后永久错乱。 */
export const DEFAULT_SHELF_PROPS: readonly string[] = Object.freeze([
  'artist',
  'year',
  'genre',
  'rating',
]);

/** 不参与卡片显示的键：Obsidian 系统键 + 插件功能键。
 *  功能键在卡片上已由封面图 / 右键菜单 / 播放器承载，显示出来会是长 URL 或本机绝对路径。
 *  新增功能字段时在此登记（漏登记只是候选区多一个未勾选项，无害）。 */
export const SHELF_PROP_BLACKLIST: readonly string[] = Object.freeze([
  'tags',
  'aliases',
  'cssclasses',
  'position',
  'publish',
  'permalink',
  'cover',
  'netease',
  'neteaseId',
  'qq',
  'qqId',
  'kugou',
  'kugouId',
  'audio',
  'audioFolder',
  'source',
  // 健康检查的「仅收藏」标记：是给扫描看的状态位，不是给卡片看的资料
  'collectOnly',
]);

/** 预设别名与值前缀；用户自定义别名（settings.shelfPropLabels）优先。
 *  别名存的是**词典键**而不是文案：卡片属性名是用户可见文案，必须随语言走（词典里的 props.* 一组）。
 *  表刻意精简——猜错比不猜更糟；未覆盖的键回退键名（中文键名如「厂牌:」天然可读）。 */
export const PROP_META: Record<string, { labelKey: string; prefix?: string }> = {
  artist: { labelKey: 'props.artist' },
  year: { labelKey: 'props.year' },
  genre: { labelKey: 'props.genre' },
  // 星号是值前缀而非别名：自定义改名时不应丢失
  rating: { labelKey: 'props.rating', prefix: '⭐ ' },
  label: { labelKey: 'props.label' },
  country: { labelKey: 'props.country' },
  version: { labelKey: 'props.version' },
  catalog: { labelKey: 'props.catalog' },
};

export function isDisplayablePropKey(key: string): boolean {
  return !!key && !SHELF_PROP_BLACKLIST.includes(key);
}

/** 显示名：自定义覆写 > 预设别名 > 键名 */
export function propLabel(key: string, overrides?: Record<string, string>): string {
  const o = overrides?.[key];
  if (typeof o === 'string' && o.trim()) return o.trim();
  const meta = PROP_META[key];
  return meta ? t(meta.labelKey) : key;
}

/** 值前缀（评分星号等；不改名也不丢失） */
export function propPrefix(key: string): string {
  return PROP_META[key]?.prefix ?? '';
}

/** frontmatter 值 → 单行可读文本；空值 / 无法展示的值返回 ''（由渲染侧跳过）。 */
export function formatPropValue(v: unknown, joiner: string = t('props.joiner')): string {
  if (v == null) return '';
  if (Array.isArray(v)) {
    return v.map(formatScalar).filter((s) => s !== '').join(joiner);
  }
  return formatScalar(v);
}

// ⚠️ 判空只能用 v == null / s === ''，禁止 if (!v)：year: 0、rating: 0、released: false 都是有值
function formatScalar(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? '✓' : '✗';
  if (isDate(v)) {
    // 用本地字段而非 toISOString：后者按 UTC 输出，+08:00 的 00:00 会印成前一天
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  if (typeof v === 'object') return ''; // 嵌套对象一行放不下，序列化也不可读
  // 剩标量：symbol / function 不可读，scalarText 会返回 ''（直接用 String 对 symbol 会抛）
  const s = unwrapWikilinkForDisplay(scalarText(v));
  return s.replace(/\s*\n\s*/g, ' ').trim(); // YAML block scalar 折成单行，避免撑破卡片
}

// 跨 realm 安全（vm / iframe 里造出的 Date 用 instanceof 判定会失败）
function isDate(v: unknown): v is Date {
  return Object.prototype.toString.call(v) === '[object Date]';
}

// wikilink 显示语义：[[目标|别名]] → 别名（Obsidian 的显示约定），[[目标]] → 目标。
// 注意与 util.stripWikilink 的路径语义不同——路径解析需要「目标」，卡片显示需要「用户看到的文字」。
const WIKILINK_DISPLAY_RE = /^\[\[([^\]|#]+)(?:\|([^\]|]*))?\]\]$/;

function unwrapWikilinkForDisplay(raw: string): string {
  const s = raw.trim();
  const m = s.match(WIKILINK_DISPLAY_RE);
  if (!m) return s;
  return (m[2] ?? m[1] ?? '').trim();
}

/** frontmatter → 显示值映射（剔除黑名单键；空值保留为 ''，由渲染侧跳过）。 */
export function buildDisplayProps(fm: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fm || typeof fm !== 'object') return out;
  const props = fm as Record<string, unknown>;
  for (const key of Object.keys(props)) {
    if (!isDisplayablePropKey(key)) continue;
    out[key] = formatPropValue(props[key]);
  }
  return out;
}

export interface PropUsage {
  key: string;
  count: number;
}

/** 属性发现：聚合已在内存中的专辑（不吃盘，与屏幕所见一致）。
 *  count 只统计「格式化后非空」的专辑——保证勾了至少能看到东西；
 *  显式排序（count desc → 键名），不依赖对象键序（整数样键名会被提前）。 */
export function collectShelfPropKeys(
  albums: Array<{ displayProps?: Record<string, string> }>
): PropUsage[] {
  const counts = new Map<string, number>();
  for (const a of albums) {
    const props = a.displayProps ?? {};
    for (const key of Object.keys(props)) {
      if (!props[key]) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((x, y) => y.count - x.count || x.key.localeCompare(y.key, 'zh-CN'));
}

/** data.json → shelfProps。兼容旧的 boolean 结构 {artist:true,…}；脏数据回落默认。 */
export function normalizeShelfProps(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    // 稳定去重（保留首次出现位置：顺序有语义，不能 Set 之后重排）
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const k = item.trim();
      if (!isDisplayablePropKey(k) || seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    return out; // [] 合法（用户显式全关），不得回落默认
  }
  if (raw && typeof raw === 'object') {
    // 旧结构按默认键序保留 true 的项：未勾选的键静默保持关闭
    const o = raw as Record<string, unknown>;
    return DEFAULT_SHELF_PROPS.filter((k) => o[k] === true);
  }
  return [...DEFAULT_SHELF_PROPS];
}

/** data.json → shelfPropLabels：仅保留非空 string 覆写；与预设别名相同的覆写丢弃（保持 data.json 干净）。 */
export function normalizeShelfPropLabels(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const v = value.trim();
    if (!v || v === propLabel(key)) continue; // 与预设别名相同 = 没改过（别名随语言，所以要用 propLabel 现算）
    out[key] = v;
  }
  return out;
}

/** 勾选 / 取消（返回新数组；新键追加到末尾） */
export function toggleShelfProp(cur: readonly string[], key: string, on: boolean): string[] {
  if (on) return cur.includes(key) ? [...cur] : [...cur, key];
  return cur.filter((k) => k !== key);
}

/** 拖拽落点 → 结果下标：drop 落在 dropKey 行之前/之后。
 *  被拖项先移除、其后的行左移一位，故落点在其后时要减一；落到自己身上返回原位（无副作用）。 */
export function resolveDropIndex(
  cur: readonly string[],
  dragKey: string,
  dropKey: string,
  after: boolean
): number {
  const from = cur.indexOf(dragKey);
  const dropIdx = cur.indexOf(dropKey);
  if (from < 0 || dropIdx < 0) return from;
  const to = dropIdx + (after ? 1 : 0);
  return from < to ? to - 1 : to;
}

/** 拖拽排序内核：把 key 移到结果数组的 toIndex 位（越界 clamp；返回新数组）。
 *  调用方（视图）负责把「落点行」换算成结果下标——移除被拖项后，其后的行会左移一位。 */
export function reorderShelfProp(cur: readonly string[], key: string, toIndex: number): string[] {
  const from = cur.indexOf(key);
  if (from < 0) return [...cur];
  const next = [...cur];
  next.splice(from, 1);
  const to = Math.max(0, Math.min(Math.round(toIndex), next.length));
  next.splice(to, 0, key);
  return next;
}
