// 搓碟（scratch）：手势 → 唱片转角 / 声音倍速 的纯换算 + 指针接管。
//
// 为什么单独成模块（与 core/arm-geometry 同一理由）：换算是这套交互里唯一值得单测的部分 ——
// 视图只负责把结果写给 CSS 变量与引擎，测试用真源码 esbuild + vm 跑这一份就够。
//
// 模型（以「手指粘在唱片表面」为准，不做人为增益）：
//   指针方位角 θ = atan2(y − cy, x − cx)（屏幕坐标，与 CSS rotate 同向：x 向右、y 向下）
//   单帧转角 dθ = wrap(θ − θprev)                    —— 手指划过的角，就是唱片转过的角
//   倍速 rate = (dθ/dt) ÷ (360°/spinSeconds)         —— 正常转速 = 设置里的转盘转速
//   音频前进量 = dθ/360 × spinSeconds                 —— 1.8s/圈（33⅓ RPM）时，转一圈 = 音频走 1.8 秒
// 半径只用来「收手」：贴着圆心时 dθ 对位移极其敏感（1px 能转好几度），
// 按 RATIO 把灵敏度收回来，免得指针抖一下就甩飞。视觉用原始转角跟着手指走（直接操作，不平滑），
// 只有声音的倍速过一层低通（鼠标事件 60–125Hz 的采样抖动不该进音频）。

/** 指针到圆心的距离下限（× 唱片半径）：低于它按这个半径算转角（收手） */
export const SCRATCH_MIN_RADIUS_RATIO = 0.25;
/** 单帧转角上限（deg）：超过按「指针跨过圆心」的跳变丢弃（那一帧不算转动） */
export const SCRATCH_MAX_TURN = 120;
/** 倍速上限（正常转速的几倍）：真实搓碟可以更快，但再快只是噪音，且容易把位置甩飞 */
export const SCRATCH_MAX_RATE = 4;
/** 轻量音效（元素自己出声）的停声线：低于它算「按住不放」（停声）。给个下限而不是 0，
 *  是避免 0.01 倍的嗡嗡声。与下面的出声线一起构成迟滞，中间地带保持现状。 */
export const SCRATCH_LIVE_PAUSE_RATE = 0.05;
/** 轻量音效的出声线：高过它才让元素出声。停在停声线与出声线之间的手势（换向的那一瞬）
 *  不切换元素的起停 —— 每一次切换都是真的 play() / pause()，在阈值上来回抖会碎成一片。 */
export const SCRATCH_LIVE_RESUME_RATE = 0.12;
/** 轻量音效起播前允许的对齐误差（秒）：低于它就不动元素的 currentTime
 *  （每次写 currentTime 都要断一下声音，差一点点不值得断）。 */
export const SCRATCH_LIVE_ALIGN_TOL = 0.02;
/** 起手阈值（deg）：转不够这么多当「点了一下」，不打断播放 */
export const SCRATCH_ENGAGE_TURN = 3;
/** 倍速平滑时间常数（ms）：越小越跟手、越大越稳 */
export const SCRATCH_RATE_TAU_MS = 25;
/** 松手回正（马达把转盘拉回正常转速）的时间常数（ms） */
export const SCRATCH_MOTOR_TAU_MS = 150;
/** 回正的收尾容差（倍速）：|rate − 目标| 小于它就交还给 CSS 动画与播放元素 */
export const SCRATCH_SETTLE_EPS = 0.02;

/** 预先备好搓碟缓冲的等待时长（ms）：开播后先让播放自己把流拉稳，再去抓整轨。
 *  立刻抓会跟开播抢带宽（实测「切歌变得不跟手」），一直不抓则每张唱片的第一下搓碟只能用
 *  轻量音效（实测「声音跟歌没关系」）—— 等这么久，两头都躲开。 */
export const SCRATCH_PRELOAD_DELAY_MS = 6000;

/** 搓碟音效档（设置 → 外观 → 播放器）：full = 完整（解码整轨，正反都出声）；
 *  light = 轻量（元素按倍速出声，只有正向，零内存、零预载）。
 *  轻量档的音高跟着倍速走、位置对着针位（见 player-state 的 scratchRate）——
 *  它只是「倒着不出声」，不是「听到别的段落」。 */
export type ScratchSound = 'full' | 'light';
export const SCRATCH_SOUNDS: readonly ScratchSound[] = ['full', 'light'];
export const DEFAULT_SCRATCH_SOUND: ScratchSound = 'full';

/** data.json → 搓碟音效档（脏值回落默认：完整） */
export function normalizeScratchSound(raw: unknown): ScratchSound {
  return SCRATCH_SOUNDS.includes(raw as ScratchSound) ? (raw as ScratchSound) : DEFAULT_SCRATCH_SOUND;
}

/** 角度环绕：把任意角度差折回 (−180, 180]（指针从 359° 走到 1° 是 +2°，不是 −358°） */
export function wrapDeg(delta: number): number {
  let d = delta % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** 指针相对圆心的方位角（deg，屏幕坐标：0 = 正右，顺时针为正） */
export function angleOf(x: number, y: number, cx: number, cy: number): number {
  return (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
}

/** 单帧转角（deg）：手指的角位移，圆心附近按 SCRATCH_MIN_RADIUS_RATIO 收手；
 *  跨过圆心的跳变（|dθ| > SCRATCH_MAX_TURN）返回 0 —— 那一帧不是转动，是指针换了半边。 */
export function turnOf(angle: number, prevAngle: number, radius: number, discRadius: number): number {
  const raw = wrapDeg(angle - prevAngle);
  if (!(Math.abs(raw) <= SCRATCH_MAX_TURN)) return 0;
  const floor = Math.max(1e-6, SCRATCH_MIN_RADIUS_RATIO * discRadius);
  if (!(radius < floor)) return raw;
  return raw * (radius / floor);
}

/** 转角 → 倍速（1 = 正常转速）。dtMs ≤ 0 视为「没动」（不猜） */
export function rateOfTurn(turn: number, dtMs: number, spinSeconds: number): number {
  if (!(dtMs > 0) || !(spinSeconds > 0)) return 0;
  return (turn * spinSeconds) / (360 * (dtMs / 1000));
}

export function clampRate(rate: number): number {
  if (Number.isNaN(rate)) return 0; // NaN 不是「很快」，是「算不出来」：按按住不放处理
  return Math.min(SCRATCH_MAX_RATE, Math.max(-SCRATCH_MAX_RATE, rate));
}

/** 松手回正：角速度按指数逼近目标（播放中 → 1，暂停起手 → 0），返回本帧的新倍速。
 *  指数逼近而不是线性：马达拉转盘就是这个手感 —— 一开始快、越接近越缓。 */
export function approachRate(
  rate: number,
  target: number,
  dtMs: number,
  tauMs: number = SCRATCH_MOTOR_TAU_MS
): number {
  if (!(dtMs > 0) || !(tauMs > 0)) return rate;
  return rate + (target - rate) * (1 - Math.exp(-dtMs / tauMs));
}

/** 搓碟累计器：指针事件把转角喂进 add()，每帧由 frame() 取走 ——
 *  分开两步是为了让「事件按自己的节奏来、声音与视觉按帧走」：鼠标 125Hz 的碎采样
 *  若逐事件算倍速，抖动会直接进音频。 */
export class ScratchTracker {
  /** 尚未被帧消费的转角（deg，正 = 唱片顺时针） */
  private pending = 0;
  /** 平滑后的倍速 */
  private current = 0;

  add(turn: number): void {
    if (!turn) return;
    this.pending += turn;
  }

  /** 取走本帧的转角（原样，供视觉跟手）与平滑后的倍速（供音频） */
  frame(dtMs: number, spinSeconds: number): { turn: number; rate: number } {
    const turn = this.pending;
    this.pending = 0;
    const raw = clampRate(rateOfTurn(turn, dtMs, spinSeconds));
    const k = dtMs > 0 ? 1 - Math.exp(-dtMs / SCRATCH_RATE_TAU_MS) : 0;
    this.current += (raw - this.current) * k;
    return { turn, rate: this.current };
  }

  get rate(): number {
    return this.current;
  }

  reset(): void {
    this.pending = 0;
    this.current = 0;
  }
}

/** 命中几何：唱片圆心与半径（px，视口坐标） */
export interface ScratchHit {
  cx: number;
  cy: number;
  radius: number;
}

export interface ScratchGestureOptions {
  /** 命中几何（起手时取一次；宽度为 0 / 拿不到时返回 null = 不接管） */
  geometry: () => ScratchHit | null;
  /** 这一下要不要接管（不在唱片范围内 / 当前不可搓 → false，事件原样放行） */
  accept: (ev: PointerEvent) => boolean;
  /** 真的转起来了（越过起手阈值）—— 音效从这里才开始，别在按下时就打断播放 */
  onEngage: () => void;
  /** 每一段的转角增量（deg，已含半径收手与环绕修正） */
  onTurn: (turn: number) => void;
  /** 松手 / 指针被系统收走（真的转起来过才回调） */
  onEnd: () => void;
  /** 起手阈值（deg），缺省 SCRATCH_ENGAGE_TURN */
  engageTurn?: number;
}

/** 指针接管：按下即捕获、拖动按「绕圆心的转角」上报、抬手 / 取消统一收尾。
 *  纪律与 bindPointerScrub 一致：捕获失败靠 buttons 兜底、lostpointercapture 必收尾、右键不当拖动。 */
export function bindScratchGesture(hit: HTMLElement, opts: ScratchGestureOptions): void {
  const engageTurn = opts.engageTurn ?? SCRATCH_ENGAGE_TURN;
  let id: number | null = null;
  let geom: ScratchHit | null = null;
  let prev = 0;
  let turnSum = 0;
  let engaged = false;

  const finish = () => {
    const was = engaged;
    id = null;
    geom = null;
    turnSum = 0;
    engaged = false;
    if (was) opts.onEnd();
  };

  hit.addEventListener('pointerdown', (ev) => {
    if (id !== null) return; // 已经在搓（第二根手指不理）
    if (ev.pointerType === 'mouse' && ev.button !== 0) return; // 右键 / 中键不当拖动
    if (!opts.accept(ev)) return;
    const g = opts.geometry();
    if (!g) return;
    ev.preventDefault(); // 别开始选字与原生拖拽
    // 捕获是「锦上添花」（拖出控件 / 拖出窗口也收得到抬手），失败也不许拖垮这条交互
    try {
      hit.setPointerCapture(ev.pointerId);
    } catch {
      /* 捕获不到就靠 pointermove 的 buttons 判定兜底 */
    }
    id = ev.pointerId;
    geom = g;
    prev = angleOf(ev.clientX, ev.clientY, g.cx, g.cy);
    turnSum = 0;
    engaged = false;
  });

  hit.addEventListener('pointermove', (ev) => {
    if (id === null || ev.pointerId !== id || !geom) return;
    // 已经松手了（抬手落在控件之外又没捕获住）：当收尾，别把悬停当成拖动
    if (ev.buttons === 0) {
      finish();
      return;
    }
    const angle = angleOf(ev.clientX, ev.clientY, geom.cx, geom.cy);
    const radius = Math.hypot(ev.clientX - geom.cx, ev.clientY - geom.cy);
    const turn = turnOf(angle, prev, radius, geom.radius);
    prev = angle;
    if (!turn) return;
    if (!engaged) {
      turnSum += turn;
      if (Math.abs(turnSum) < engageTurn) return;
      engaged = true;
      opts.onEngage();
      opts.onTurn(turnSum); // 起手前攒下的那一小段也算上：唱片角度与手指严格对应
      return;
    }
    opts.onTurn(turn);
  });

  const up = (ev: PointerEvent) => {
    if (id === null || ev.pointerId !== id) return;
    finish();
  };
  hit.addEventListener('pointerup', up);
  // 拖动被系统收走（多指手势等）：按松手处理（盘面已经真的转过了，回滚反而假）
  hit.addEventListener('pointercancel', up);
  hit.addEventListener('lostpointercapture', () => {
    if (id !== null) finish();
  });
}
