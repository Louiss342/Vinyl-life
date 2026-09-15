// 手绘笔触的公共件：专辑墙空态教程与设置面板「关于」页共用一套。
// 参数照 Excalidraw 的 generateRoughOptions 与元素自身取值逐项对齐：虚线 [8,10]、
// 线宽 2 + 0.5、单笔不叠（disableMultiStroke）、roughness 2 的元素不做顶点保持。
// 两个页面出自同一份设计稿的手感，参数只留这一份，改一处两边一起变。

/** SVG 命名空间：图形元素必须走 createElementNS，createEl('svg') 出来的是 HTML 元素，属性不生效 */
export const SVG_NS = 'http://www.w3.org/2000/svg';

/** 线宽：图纸 strokeWidth 2 + 0.5（虚线不留双笔，补回视觉线宽） */
const STROKE_WIDTH = 2.5;

/** 虚线间隔：图纸的 getDashArrayDashed(2) */
const DASH = [8, 10];

/** 虚线图形的 roughjs 选项。种子由调用方给：同一个图形固定种子，抖动纹路才每次都一样 */
export const roughDashed = (seed: number, roughness: number) => ({
  seed,
  roughness,
  bowing: 1,
  stroke: 'currentColor', // 颜色由所在图层的 CSS 变量给，主题切换自动跟随
  strokeWidth: STROKE_WIDTH,
  strokeLineDash: [...DASH],
  disableMultiStroke: true, // Excalidraw：虚线只画一笔，否则虚线段互相叠
  preserveVertices: roughness < 2, // Excalidraw：roughness 2 的元素不做顶点保持
});

/** 实线图形的 roughjs 选项（教程的箭头头部是两笔实线，不虚线） */
export const roughSolid = (seed: number) => ({
  seed,
  roughness: 2,
  bowing: 1,
  stroke: 'currentColor',
  strokeWidth: STROKE_WIDTH,
  disableMultiStroke: true,
  preserveVertices: false,
});

/** 圆角矩形路径：半径照 Excalidraw 的 getCornerRadius（min(32, 短边 × 0.25)） */
export const roundRectPath = (r: { x: number; y: number; w: number; h: number }) => {
  const rad = Math.min(32, Math.min(r.w, r.h) * 0.25);
  const x2 = r.x + r.w;
  const y2 = r.y + r.h;
  return [
    `M ${r.x + rad} ${r.y}`,
    `L ${x2 - rad} ${r.y}`,
    `Q ${x2} ${r.y} ${x2} ${r.y + rad}`,
    `L ${x2} ${y2 - rad}`,
    `Q ${x2} ${y2} ${x2 - rad} ${y2}`,
    `L ${r.x + rad} ${y2}`,
    `Q ${r.x} ${y2} ${r.x} ${y2 - rad}`,
    `L ${r.x} ${r.y + rad}`,
    `Q ${r.x} ${r.y} ${r.x + rad} ${r.y}`,
    'Z',
  ].join(' ');
};
