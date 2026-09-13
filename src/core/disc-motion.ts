// 黑胶唱片动效关键帧（专辑墙）：真值在 styles.css —— .vinyl-shelf / .is-disc-* 上的
// --vinyl-disc-{rest,lift,off} 变量，TS 侧（handoff 离墙动画、唱片回位动画）按方向取用，
// 避免同一组位移在 CSS 与 JS 里各写一份。此处 fallback 仅在变量未就绪时兜底（右向）。

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

// 转盘转速（播放器，一圈耗时）：fallback 1.8s 与 styles.css 的 --vinyl-spin-duration 默认值一致
export type SpinSpeed = 'slow' | 'normal' | 'fast';

export const SPIN_SPEEDS: Record<SpinSpeed, string> = {
  slow: '2.6s',
  normal: '1.8s',
  fast: '1.2s',
};
