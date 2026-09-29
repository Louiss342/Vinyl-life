// 队列里「整段（整张专辑）」的移动换算：拖拽与键盘两条路必须共用同一套落点数学，
// 否则同一个手势与同一组按键会落到不同位置。纯函数，不碰引擎 / DOM，能脱离界面断言。

export interface Segment {
  start: number;
  count: number;
}

export interface SegmentMove extends Segment {
  /** 引擎 moveRange 的第三参：**摘下这一段之后**的下标（不是原数组下标） */
  to: number;
}

/** 拖拽落点 → 结果下标（同构于 shelf-props 的 resolveDropIndex）：被拖段先移除、其后左移，
 *  故落点在它之后要减一；落到自己身上即原位（无副作用）。 */
export function resolveSegmentDropIndex(
  fromStart: number,
  count: number,
  targetStart: number,
  targetCount: number,
  after: boolean
): number {
  const shift = fromStart < targetStart ? count : 0;
  return after ? targetStart + targetCount - shift : targetStart - shift;
}

/** 把「当前曲目所在的那一段」上移 / 下移一格（delta = -1 上、+1 下）；已在首 / 末段返回 null ——
 *  那里没得去，也避免夹到边界再发一次等价移动（引擎白广播一轮，界面闪一下）。
 *  落点复用拖拽那套 resolveSegmentDropIndex：上移 = 落到邻段前、下移 = 落到邻段后。 */
export function segmentMoveBy(
  segments: Segment[],
  currentIndex: number,
  delta: number
): SegmentMove | null {
  if (!segments.length || !Number.isInteger(delta) || delta === 0) return null;
  const i = segments.findIndex((s) => currentIndex >= s.start && currentIndex < s.start + s.count);
  if (i < 0) return null;
  const j = i + delta;
  if (j < 0 || j >= segments.length) return null;
  const from = segments[i];
  const target = segments[j];
  const to = resolveSegmentDropIndex(from.start, from.count, target.start, target.count, delta > 0);
  return { start: from.start, count: from.count, to };
}
