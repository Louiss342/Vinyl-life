// 设置面板「关于」页：整页手绘 —— 文本走手写体（Vinyl Hand / Vinyl Hand CJK 两个子集），
// 便签外框交给 roughjs 现画（与专辑墙空态教程同一套笔触，见 hand-drawn.ts）。
//
// 内容全是固定常量：作者手记（core/about.ts 的中英正文，刻意不翻译）、manifest 里的版本号、
// 词典里的壳文案（版本行 / 许可行）。正因为固定，两个手写体子集能把这页的字一个不落地收进去
// （scripts/subset-hand-font.cjs）；改了文案要重跑那个脚本，否则新字会回落到主题字体 ——
// 不会空白，只是那几个字没有手写感。
//
// 笔触要按元素的实际尺寸画，所以文本与笔触是两个函数：调用方先渲染文本、再挂笔触
// （见 VinylSettingTab.renderAboutTab），别合成一个 —— 藏起来的元素量出来是 0。
import { RoughSVG } from 'roughjs/bin/svg';
import { ABOUT_TEXT, ABOUT_TEXT_EN, REPO_URL } from '../core/about';
import { t, tf } from '../core/i18n';
import { roughDashed, roundRectPath, SVG_NS } from './hand-drawn';

/** 虚线框的固定种子：纹路每次一样。换个数值就是另一种抖动，别随手改 */
const SEED = 20260915;

/** 「关于」页的文本部分。返回根块与便签块 —— 手绘虚线框要套住便签，坐标以根块为原点。 */
export function renderAboutPage(
  containerEl: HTMLElement,
  version: string
): { root: HTMLElement; note: HTMLElement } {
  const about = containerEl.createDiv({ cls: 'vinyl-about' });

  const title = about.createDiv({ cls: 'vinyl-about-title' });
  title.createSpan({ text: 'Vinyl Life' }); // 产品名不翻译
  title.createSpan({ text: tf('settings.aboutVersion', { v: version }), cls: 'vinyl-about-version' });

  // 作者手记：原文常量，中文在上、英文在下（两份都不走 i18n，不随语言开关切换）。
  // text 设的是 textContent，原样进 DOM；换行与首行行尾空格交给 CSS 的 pre-wrap 保住。
  const note = about.createDiv({ cls: 'vinyl-about-note' });
  note.createDiv({ text: ABOUT_TEXT, cls: 'vinyl-about-text' });
  note.createDiv({ text: ABOUT_TEXT_EN, cls: 'vinyl-about-text-en' });

  const meta = about.createDiv({ cls: 'vinyl-about-meta' });
  meta.createSpan({ text: t('settings.aboutLicense') });
  meta.createSpan({ text: ' · ' });
  meta.createEl('a', { text: 'GitHub', href: REPO_URL, attr: { target: '_blank', rel: 'noopener' } });

  return { root: about, note };
}

/** 便签外的手绘虚线框：随尺寸重画（面板宽度一变，框要跟着变）。
 *  返回停止函数 —— 面板重绘 / 关闭时必须调用，断开 ResizeObserver。 */
export function attachAboutInk(root: HTMLElement, note: HTMLElement): () => void {
  const doc = root.ownerDocument;
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'vinyl-about-svg');
  svg.setAttribute('aria-hidden', 'true'); // 纯装饰：读屏软件跳过，文字本体才是内容
  const ink = doc.createElementNS(SVG_NS, 'g'); // 图形都画在这一层里（每次重画先清空）
  ink.setAttribute('class', 'vinyl-about-ink');
  svg.appendChild(ink);
  root.appendChild(svg); // 铺在内容上方：pointer-events 由 CSS 关掉，GitHub 链接照常能点

  const paint = () => {
    const base = root.getBoundingClientRect();
    const box = note.getBoundingClientRect();
    if (!base.width || !box.width) return; // 还没布局：等下一轮尺寸变化再画
    const rc = new RoughSVG(svg);
    ink.replaceChildren();
    ink.appendChild(
      rc.path(
        roundRectPath({
          x: box.left - base.left,
          y: box.top - base.top,
          w: box.width,
          h: box.height,
        }),
        roughDashed(SEED, 2)
      )
    );
  };
  paint();

  // 观察根元素而不是便签：面板宽度变化时根元素先变，重画即跟上（ResizeObserver 挂上就会先报一次）
  const ro = new ResizeObserver(paint);
  ro.observe(root);
  return () => ro.disconnect();
}
