// 唱臂几何（播放器转盘）—— 把「专辑进度」换算成唱臂的旋转角。
//
// 需求（设计稿 Drawing 2026-09-16 10.26.32）：
//   未播放专辑或暂停 → 姿态 1（唱针归位支架，离开唱片）；
//   播放专辑         → 姿态 2（唱针落在唱片上）；
//   姿态 2 时，唱针到唱片圆心的「距离」表示专辑进度（不是角度成正比 —— 距离成正比）。
//
// 为什么需要这个模块：唱臂是绕转轴摆动的刚体，唱针走的是圆弧；角度与「唱针到圆心距离」
// 之间隔着一个三角形（转轴 P、圆心 C、唱针 S），换算必须走余弦定理：
//   |CS|² = |PC|² + L² − 2·|PC|·L·cosφ      （φ = 臂方向与「转轴→圆心」方向的夹角）
// 给定目标距离 d 反解 φ，再叠加「转轴→圆心」的方位角就得到臂的方向角。
// 角度与长度的真值在 styles.css 的 .vinyl-turntable-arm（定位 / 宽度 = 臂长），
// 两处必须一起改 —— 常量在这里只写一份，CSS 用 var() 取不到，故注释互相指认。
import type { PlayerStatus } from './player-state';

/** 转盘宽高比（CSS .vinyl-turntable 的 aspect-ratio）：横向长方形唱机，宽度 = 1.3 个高。
 *  所有以「宽」为基准的 CSS 百分比 = 这里的 x ÷ ARM_ASPECT（见每条的注释）。 */
export const ARM_ASPECT = 1.3;

/** 转盘几何（单位 = 转盘「高」，横向唱机的所有距离都以高为标尺 —— 唱片是圆的，
 *  半径按高算才不会被拉成椭圆；宽度只影响左右留白，见 ARM_ASPECT）。
 *  与 styles.css 的百分比一一对应（x ÷ 1.3 = left%，y = top%）。 */
export const ARM_GEOMETRY = {
  /** 转轴位置（右上角）：.vinyl-turntable-arm 的 left / top（left = 1.222 ÷ 1.3 = 94%） */
  pivot: { x: 1.222, y: 0.17 },
  /** 转轴 → 唱针的距离：.vinyl-turntable-arm 的 width（唱头挂在臂的远端；0.64 ÷ 1.3 = 49.23%） */
  length: 0.64,
  /** 唱片圆心（偏左：给右侧的唱针与左下的播放键让位）与半径：.vinyl-turntable-disc
   *  （left = 0.61 ÷ 1.3 = 46.92%、top 49%，直径 1.00 ÷ 1.3 = 76.92% 宽）。
   *  毛毡垫还要再大一圈（1.05 个转盘高，见 styles.css），竖向会长出转盘盒。 */
  center: { x: 0.61, y: 0.49 },
  discRadius: 0.5,
  /** 落针半径带（×唱片半径）：开头落在导入槽，结尾停在内圈（标签外，标签半径 0.34R） */
  grooveOuter: 0.96,
  grooveInner: 0.4,
} as const;

/** 转轴 → 圆心 的距离与方位角（deg，屏幕坐标：x 向右、y 向下，与 CSS rotate 同向） */
const PIVOT_TO_CENTER = Math.hypot(
  ARM_GEOMETRY.center.x - ARM_GEOMETRY.pivot.x,
  ARM_GEOMETRY.center.y - ARM_GEOMETRY.pivot.y
);
const BASE_ANGLE =
  (Math.atan2(
    ARM_GEOMETRY.center.y - ARM_GEOMETRY.pivot.y,
    ARM_GEOMETRY.center.x - ARM_GEOMETRY.pivot.x
  ) *
    180) /
  Math.PI;
const L = ARM_GEOMETRY.length;

export function clampRatio(ratio: number): number {
  if (!isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}

/** 专辑进度 → 唱针到圆心的距离（×转盘边长）：线性（进度 0 = 导入槽，1 = 内圈） */
export function stylusDistance(progress: number): number {
  const p = clampRatio(progress);
  const r = ARM_GEOMETRY.discRadius;
  const outer = ARM_GEOMETRY.grooveOuter * r;
  const inner = ARM_GEOMETRY.grooveInner * r;
  return outer + p * (inner - outer);
}

/** 唱针到圆心的距离 → 唱臂旋转角（deg）：余弦定理反解，取「唱头在转轴左下方」的那一支
 *  （设计稿里唱臂从右上角转轴垂下来，落针落在唱片右下方 —— 另一支会把唱头甩到盘外）。 */
export function armAngleForDistance(distance: number): number {
  const d = Math.min(PIVOT_TO_CENTER + L, Math.max(Math.abs(PIVOT_TO_CENTER - L), distance));
  const cosPhi = (PIVOT_TO_CENTER * PIVOT_TO_CENTER + L * L - d * d) / (2 * PIVOT_TO_CENTER * L);
  const phi = Math.acos(Math.min(1, Math.max(-1, cosPhi)));
  return BASE_ANGLE - (phi * 180) / Math.PI;
}

/** 专辑进度 → 唱臂旋转角（deg） */
export function armAngleForProgress(progress: number): number {
  return armAngleForDistance(stylusDistance(progress));
}

/** 停放位（姿态 1）的旋转角：唱臂竖直朝下、不带一点偏角（用户要求）——
 *  转轴在 (94%, 17%)，臂长 0.64，所以唱针落在 (94%, 81%) 的支架上。
 *  不再按「唱针到圆心的距离 = 1.25R」反解：那个角度天生是斜的（108.3°）。 */
export const ARM_PARK_ANGLE = 90;

/** 唱针姿态：未播放专辑 / 暂停 / 出错 / 队列为空 → 姿态 1（归位支架），否则姿态 2（在唱片上）。
 *  loading（换曲取址的间隙）保持落针，避免唱臂在换曲时来回摆。 */
export function armPosture(status: PlayerStatus, queueLength: number): 'park' | 'record' {
  return (status === 'playing' || status === 'loading') && queueLength > 0 ? 'record' : 'park';
}

/** 专辑进度的输入面（只读这几个字段，便于单测） */
export interface AlbumProgressInput {
  queue: Array<{ albumNotePath?: string }>;
  index: number;
  albumNotePath?: string;
  currentTime: number;
  duration: number;
}

/** 专辑进度（0–1）：当前曲目在本专辑里的位置（第几首 + 本曲播到几成）。
 *  按「本专辑在队列里的曲目」计数，而不是按下标除以队列长度 —— 队列模式下队列里可能有
 *  好几张专辑，打乱后同一张专辑的曲目还会散开；两种情况下都要算的是「这张专辑播到哪了」。
 *  没有专辑信息 / 队列为空时返回 0。 */
export function albumProgress(s: AlbumProgressInput): number {
  const track = s.queue[s.index];
  if (!track) return 0;
  const path = track.albumNotePath || s.albumNotePath || '';
  let total = 0;
  let at = -1;
  for (let i = 0; i < s.queue.length; i++) {
    if ((s.queue[i].albumNotePath || s.albumNotePath || '') !== path) continue;
    if (i === s.index) at = total;
    total++;
  }
  if (total === 0) return 0;
  const trackRatio = s.duration > 0 ? clampRatio(s.currentTime / s.duration) : 0;
  return clampRatio(((at < 0 ? 0 : at) + trackRatio) / total);
}
