// 「放不下就悬停 / 聚焦滚动」：专辑墙卡片文字与播放器顶部专辑名共用这一份实现。
// 用法：宿主元素加 .vinyl-marquee，里面放一个 .vinyl-marquee-text 包住文字；
// 视图侧把处理器注册到容器上（事件委托 —— 卡片与标题都会重建，逐元素挂会白挂）。
// 悬停与键盘焦点是**两条不同方向的查找**：指针事件的目标在 marquee 之内（向上 closest），
// 焦点落在卡片上而 marquee 是它的后代（向下 querySelectorAll）—— 所以入口成对：
//   onMarqueeOver / onMarqueeOut        指针（目标 = 文字本身）
//   measureMarqueesIn / resetMarqueesIn 焦点（目标 = 承载焦点的那一块，如卡片）
// 样式（默认省略号 / 松开截断 / 来回滚 / 减少动效下换行）全在 styles.css 的 .vinyl-marquee 一组里。

/** 悬停时量出溢出距离与滚动时长，写进两个 CSS 变量；滚动动画本身是纯 CSS。
 *  每次悬停现算：面板宽度变了、语言换了都不用额外失效逻辑。放得下就什么都不做。 */
export function onMarqueeOver(ev: PointerEvent) {
  const row = marqueeRow(ev.target);
  if (row) measureRow(row);
}

export function onMarqueeOut(ev: PointerEvent) {
  const row = marqueeRow(ev.target);
  if (!row) return;
  // relatedTarget 还在这一行里 = 只是行内移动，别复位（否则中途停下、动画从头再来）
  const to = ev.relatedTarget as Node | null;
  if (to && typeof row.contains === 'function' && row.contains(to)) return;
  row.classList.remove('is-overflowing');
}

/** 键盘焦点进入某一块（卡片）时，把它里面的 marquee 都量一遍 —— 与悬停同一份测量，
 *  于是 CSS 那条 :focus-visible 分支拿得到同样的两个变量，键盘用户看到的滚动与鼠标一致。
 *  用事件委托挂在容器上：卡片是重建的，逐元素挂会白挂（与指针那两个入口同一考虑）。 */
export function measureMarqueesIn(root: EventTarget | null) {
  for (const row of marqueesIn(root)) measureRow(row);
}

/** 焦点离开那一块时复位（回到截断 + 省略号）。传 null 是安全的：找不到宿主就什么都不做。 */
export function resetMarqueesIn(root: EventTarget | null) {
  for (const row of marqueesIn(root)) row.classList.remove('is-overflowing');
}

/** 一块宿主里的所有 marquee 行。宿主不是元素（或来自弹窗窗口、原型不同）时回空数组 ——
 *  鸭子判定用 closest，与 marqueeRow 同一套（querySelectorAll 在宿主类型上已被标废弃）。 */
function marqueesIn(root: EventTarget | null): HTMLElement[] {
  const el = root as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return [];
  return Array.from(el.querySelectorAll<HTMLElement>('.vinyl-marquee'));
}

/** 量一行：溢出多少、滚多久，写成 CSS 变量；放得下就不加类（保持省略号）。 */
function measureRow(row: HTMLElement) {
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

/** 弹窗窗口（popout）里 instanceof HTMLElement 会失败，所以只鸭子类型判 closest */
function marqueeRow(target: EventTarget | null): HTMLElement | null {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return null;
  return el.closest<HTMLElement>('.vinyl-marquee');
}
