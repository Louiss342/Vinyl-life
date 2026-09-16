// 多选手势的共享原语（专辑墙「批量删除」与播放器唱片区共用，别再各写一份）：
// 选中表一律保序 —— 点选的先后就是用户心里的先后（排队 / 删除都按它走）。

/** 切换选中（保序：新选的追加在末尾） */
export function toggleInList(list: string[], path: string): string[] {
  return list.includes(path) ? list.filter((p) => p !== path) : [...list, path];
}

/** 连续选（Shift）：把 order 里 from → to 之间的一段并入已选（不取消已选中的）。
 *  order 用「当前显示顺序」传：用户按眼前看到的连选，与筛选 / 排序结果一致。 */
export function rangeInList(list: string[], order: string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return list;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const out = [...list];
  for (const path of order.slice(lo, hi + 1)) {
    if (!out.includes(path)) out.push(path);
  }
  return out;
}
