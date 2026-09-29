// 评分与「人写的数值」：解析口径的唯一实现。
//
// 为什么要单独一层：同一个值有三个地方读它 —— 排序（shelf-sort）、卡片显示（shelf-props）、评分弹窗
// （views/rating-modal）；各写一套就会出现「弹窗里预填成空、排序却排得好好的」这种自相矛盾。
//
// 口径：**读得宽容** —— 手写的 4 / '4' / '4/5' / '★★★★' 都认（笔记里什么写法都有），插件只在评分弹窗与
// 导入两处写它，不改用户的写法；年份同理，'1997年' / '2003-05' 都读得出数，读不出（'待定'）才算缺失。

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

