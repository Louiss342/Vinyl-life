// 黑胶唱片动效关键帧（专辑墙）：真值在 styles.css 的 --vinyl-disc-{rest,lift,off}（避免同一组位移
// 在 CSS 与 JS 里各写一份），TS 侧（handoff 离墙 / 唱片回位）按方向取用；此处 fallback 仅在变量未就绪时兜底（右向）。

export type DiscDirection = 'right' | 'left' | 'up' | 'down';

export const DISC_DIRECTIONS: DiscDirection[] = ['right', 'left', 'up', 'down'];

export type DiscPhase = 'rest' | 'lift' | 'off';

export const DISC_FALLBACK: Record<DiscPhase, string> = {
  rest: 'translate(-20%, -50%) translateZ(-10px) rotate(20deg)',
  lift: 'translate(62%, -55%) translateZ(0) rotate(0deg) scale(1.06)',
  off: 'translate(130%, -62%) translateZ(0) rotate(0deg) scale(0.45)',
};

export function discTransform(el: HTMLElement, phase: DiscPhase): string {
  const v = getComputedStyle(el).getPropertyValue(`--vinyl-disc-${phase}`).trim();
  return v || DISC_FALLBACK[phase];
}

/** 转盘转速（一圈耗时）：秒/圈的真值在下面 —— normal = 1.8s 正是 33⅓ RPM，搓碟的换算基准（唱片转一圈 = 音频前进这么多秒，见 core/scratch）。
 *  字符串那份供 styles.css 的 --vinyl-spin-duration（fallback 1.8s 与之一致）。 */
export type SpinSpeed = 'slow' | 'normal' | 'fast';

export const SPIN_SECONDS: Record<SpinSpeed, number> = {
  slow: 2.6,
  normal: 1.8,
  fast: 1.2,
};

export const SPIN_SPEEDS: Record<SpinSpeed, string> = {
  slow: `${SPIN_SECONDS.slow}s`,
  normal: `${SPIN_SECONDS.normal}s`,
  fast: `${SPIN_SECONDS.fast}s`,
};
