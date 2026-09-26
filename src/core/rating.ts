// 评分与「人写的数值」：解析口径的唯一实现。
//
// 为什么要单独一层：同一个值有三个地方读它 —— 排序（shelf-sort 的数值化）、卡片显示
// （shelf-props 的值前缀）、评分弹窗（预填当前值，见 views/rating-modal）。各写一套解析，
// 就会出现「弹窗里预填成空、排序却排得好好的」这种自相矛盾。
//
// 口径：**读得宽容**。手写的 4 / '4' / '4/5' / '★★★★' 都认（笔记里什么写法都有），
// 插件只在两处写它：评分弹窗（用户自己填的数，见 views/rating-modal）与导入 —— 都不改用户的写法。
// 年份同理：'1997年'、'2003-05' 里都能读出 1997 / 2003；读不出数（'待定'）才算缺失。

/** 从任意写法里读一个数：数字直接用；文本取**第一个数**（'4/5' → 4、'1997年' → 1997）；
 *  没有数字就数星星（'★★★★' → 4）。认不出来回 null（= 缺失，不是 0）。 */
export function parseLeadingNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  const num = /-?\d+(?:\.\d+)?/.exec(s);
  if (num) {
    const n = Number(num[0]);
    return Number.isFinite(n) ? n : null;
  }
  // ★ (U+2605) 与 ⭐ (U+2B50) 都算：前者是评价惯例，后者是本插件卡片上的前缀
  const stars = (s.match(/[★⭐]/g) || []).length;
  return stars || null;
}

