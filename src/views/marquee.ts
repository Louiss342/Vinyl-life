// 「放不下就悬停滚动」：专辑墙卡片文字与播放器顶部专辑名共用这一份实现。
// 用法：宿主元素加 .vinyl-marquee，里面放一个 .vinyl-marquee-text 包住文字；
// 视图侧把这两个处理器注册到容器上（事件委托 —— 卡片与标题都会重建，逐元素挂会白挂）。
// 样式（默认省略号 / 悬停松开截断 / 来回滚 / 尊重减少动效）全在 styles.css 的 .vinyl-marquee 一组里。

/** 悬停时量出溢出距离与滚动时长，写进两个 CSS 变量；滚动动画本身是纯 CSS。
 *  每次悬停现算：面板宽度变了、语言换了都不用额外失效逻辑。放得下就什么都不做。 */
export function onMarqueeOver(ev: PointerEvent) {
  const row = marqueeRow(ev.target);
  if (!row) return;
  const text = row.querySelector<HTMLElement>('.vinyl-marquee-text');
  if (!text) return;
  const shift = text.scrollWidth - row.clientWidth;
  if (shift <= 1) return; // 放得下：保持省略号（其实也没省略号可显示）
  row.classList.add('is-overflowing');
  row.style.setProperty('--vinyl-marquee-shift', `-${shift}px`);
  // 45px/秒：最短 2 秒（再短看不清），最长 12 秒（长值别滚到天荒地老）
  row.style.setProperty(
    '--vinyl-marquee-duration',
    `${Math.min(12, Math.max(2, shift / 45)).toFixed(1)}s`
  );
}

export function onMarqueeOut(ev: PointerEvent) {
  const row = marqueeRow(ev.target);
  if (!row) return;
  // relatedTarget 还在这一行里 = 只是行内移动，别复位（否则中途停下、动画从头再来）
  const to = ev.relatedTarget as Node | null;
  if (to && typeof row.contains === 'function' && row.contains(to)) return;
  row.classList.remove('is-overflowing');
}

/** 弹窗窗口（popout）里 instanceof HTMLElement 会失败，所以只鸭子类型判 closest */
function marqueeRow(target: EventTarget | null): HTMLElement | null {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return null;
  return el.closest<HTMLElement>('.vinyl-marquee');
}
