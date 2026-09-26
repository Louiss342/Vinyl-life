// 转盘马达（turntable motor）：播放 / 暂停时唱片的转速斜坡 —— 暂停 = 断电滑停、复播 = 马达起转。
//
// 为什么单独成模块：这条斜坡有**两个执行者** —— 引擎写元素的 playbackRate 与音量（声音），
// 视图逐帧写唱片角度（画面）。两边必须走同一条曲线，否则就是「盘面还在减速、声音已经没了」。
// 共用这里的纯函数，同步是结构性的，不是把两个时长调得差不多调出来的。
//
// 模型（沿用 core/scratch 的「转速 = 倍速」语言：rate 1 = 设置里的正常转速，标准档 1.8s/圈）：
//   停机：角速度按指数衰减（轴承摩擦）  rate(t) = from · e^(−t/τ)
//   起步：角速度按指数逼近 1（马达扭矩） rate(t) = 1 − (1 − from) · e^(−t/τ)
// 两条都是「差多少、按同一个时间常数补多少」，所以中途反向（滑停到一半又按播放）可以就地接着
// 走，不用记账 —— 曲线只与「此刻的转速」有关，与「已经走了多久」无关。
//
// 音量与转速同步：增益只由**当前转速**换算（motorGain），不另走一条时间轴 ——
// 转速滑到地板（MOTOR_MIN_RATE）的那一刻增益正好是 0，元素也在同一刻停声：
// 淡出与减速共享同一个终点，两个执行者各按自己的时钟问同一个函数，终点必然重合。

export type MotorPhase = 'stopping' | 'starting';

/** 停机的时间常数（ms）：滑到地板约 0.35s —— 「快速的减速停止」。 */
export const MOTOR_STOP_TAU_MS = 130;
/** 起步的时间常数（ms）：到满速约 0.5s；听得出来的那一段（地板 → 0.9）约 0.25s。 */
export const MOTOR_START_TAU_MS = 110;
/** 转速地板：低于它就算停了（元素停声、盘面冻结）。取 0.07 是因为内核的倍速下限是 0.0625
 *  （Chromium / Safari / 火狐都把 playbackRate 钳在这条线以上），写更小的值只会换来一条
 *  控制台警告；而这一档的音量已经是 0（见 motorGain），听不出差别。 */
export const MOTOR_MIN_RATE = 0.07;
/** 满速线：起步到此即交还 CSS 动画（剩下的 1% 速度差看不出来、也听不出来）。 */
export const MOTOR_FULL_RATE = 0.99;
/** 满音量的转速线：这条线以上音量就是满的，以下随转速淡出 / 淡入（两个方向共用一条）。 */
export const MOTOR_FADE_RATE = 0.9;
/** 斜坡的最长时限（ms）：定时器被后台节流时的兜底 —— 到点必须收，
 *  否则声音会卡在半速上一直响（正常收尾是 0.35s / 0.5s，这里给足余量）。 */
export const MOTOR_MAX_MS = 900;
/** 引擎推进斜坡的步长（ms）。 */
export const MOTOR_TICK_MS = 16;

function tauMs(phase: MotorPhase): number {
  return phase === 'stopping' ? MOTOR_STOP_TAU_MS : MOTOR_START_TAU_MS;
}

/** 斜坡走到 elapsedMs 时的转速（1 = 正常转速）。from = 这一段起点的转速。 */
export function motorRate(from: number, elapsedMs: number, phase: MotorPhase): number {
  const decay = Math.exp(-Math.max(0, elapsedMs) / tauMs(phase));
  return phase === 'stopping' ? from * decay : 1 - (1 - from) * decay;
}

/** 斜坡走到 elapsedMs 时「走过」了多少时间（秒）＝ ∫rate dt。
 *  唱片转过的角 = 这个数 ÷ 一圈秒数 × 360°，同时它也正是元素播放位置前进的量 ——
 *  「盘面转角」与「针位前进」在这里是同一个积分，这是两条时间轴各自积不出来的那件事。 */
export function motorAdvance(from: number, elapsedMs: number, phase: MotorPhase): number {
  const tau = tauMs(phase);
  const t = Math.max(0, elapsedMs);
  const decayIntegral = tau * (1 - Math.exp(-t / tau)); // ∫e^(−t/τ)dt
  const ms = phase === 'stopping' ? from * decayIntegral : t - (1 - from) * decayIntegral;
  return ms / 1000;
}

/** 斜坡期间的音量系数（0–1）：只由转速换算 —— 地板处正好 0（与元素停声同一刻），
 *  到 MOTOR_FADE_RATE 以上是满音量。两个方向共用这一份，淡入与淡出才是同一条曲线。 */
export function motorGain(rate: number): number {
  const v = (rate - MOTOR_MIN_RATE) / (MOTOR_FADE_RATE - MOTOR_MIN_RATE);
  return Math.min(1, Math.max(0, v));
}

/** 这一段到头了吗（引擎与视图各自按自己的时钟问同一句）：滑停滑到了地板 / 起步到了满速，
 *  或者已经超过最长时限（后台节流时的那条兜底）。 */
export function motorDone(phase: MotorPhase, rate: number, elapsedMs: number): boolean {
  if (elapsedMs >= MOTOR_MAX_MS) return true;
  return phase === 'stopping' ? rate <= MOTOR_MIN_RATE : rate >= MOTOR_FULL_RATE;
}
