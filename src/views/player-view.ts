// 播放器视图：页面 1 = 转盘播放器（自上而下：按键卡 / 翻转区 / Vinyl order 行 / 队列）。
//   卡① .vinyl-player-header 按键卡：「选取专辑」宽键（只留图标）占一半，队列模式 / 播放模式各占四分之一（2:1:1）；
//     没有标题行 —— 专辑名归 Vinyl order 行末尾（播放错误由引擎的 Notice 弹窗报出）；
//   翻转区 ②+③ .vinyl-flip：唱机卡 + 唱放条合并为「一张卡」（用户要求），整张左转 90°，
//     背面是唱片区（三行唱片架，见 album-picker）。
//     只有这一区翻面——按键卡、Vinyl order、队列都留在板上不动（用户要求「其他不要变」）。
//     唱机卡 .vinyl-deck（四套配色：胡桃木 / 贝壳白 / 哑光黑 / 珊瑚红）：横向 1.3 : 1 转盘，唱片偏左、
//     唱针在右上（几何真值见 core/arm-geometry，单位 = 转盘高）；姿态 1 = 未播放/暂停归位支架，
//     姿态 2 = 播放中落针，唱针到圆心的「距离」表示专辑进度；左下角长方形播放 / 暂停键（键面 = 手写体字标）；
//     唱放条 .vinyl-amp：两行控制条（版式照设计不动）—— 上单曲进度轨（点即定位、拖动跟手，
//     见 bindPointerScrub）、下音量电平表；整体压高到与按键卡同档（用户要求）。
//     合并成一张卡的落法：面板材质 / 落影改挂翻转面，接缝两条描边去掉、内边距补回，
//     尺寸逐像素不变（见 styles.css 的「②③ 合并成一张卡」）。
//   点「选取专辑」→ 翻转区转到唱片区；在唱片区点一张专辑 → 转回唱机卡并换碟。
//   翻转区的两个面都必须保持 overflow: visible —— 可滚动 + 3D 变换会让 Blink 的命中测试整面失效
//   （「返回键点不到」就是这么来的），滚动因此交给各自的滚动层（队列挂板、唱片区自己带箱子）。
// 增量渲染：壳只建一次，状态更新只改目标节点——旋转动画不被打断。
import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import type VinylLifePlugin from '../main';
import type { PlayerSnapshot } from '../core/player-state';
import type { Track } from '../core/track';
import type { PlayMode } from '../core/player-state';
import { trackSourceLabel, trackSourceClass } from '../core/track';
import { fmtTime, notice, prefersReducedMotion } from '../util';
import { SPIN_SPEEDS } from '../core/disc-motion';
import { DECK_STYLES, RECORD_COLORS, deckClass, recordClass } from '../core/appearance';
import { coverChain } from '../core/cover-url';
import { resolveAlbumCover, findAlbumNotes, getAlbumInfo, detectAlbumSources } from '../core/album-index';
import type { AlbumInfo } from '../core/album-index';
import { ARM_PARK_ANGLE, albumProgress, armAngleForProgress, armPosture } from '../core/arm-geometry';
import { t, tf } from '../core/i18n';
import { onMarqueeOver, onMarqueeOut } from './marquee';
import { AlbumPicker } from './album-picker';
import type { PickerEntry } from './album-picker';

export const PLAYER_VIEW_TYPE = 'vinyl-player';

interface PlayerEls {
  /** 翻转区（②+③）：正面 = 唱机卡 + 唱放卡，背面 = 唱片区，共用这一个 3D 容器 */
  flip: HTMLElement;
  flipInner: HTMLElement;
  /** 「选取专辑」：翻转区的开关（图标键，点一下转到唱片区 / 再点转回来） */
  pickBtn: HTMLButtonElement;
  /** 播放模式按钮（单次 / 循环 / 随机）：队列模式下作用于整条列表 */
  playModeBtn: HTMLButtonElement;
  discOuter: HTMLElement;
  vinyl: HTMLElement;
  labelImg: HTMLImageElement;
  labelEmpty: HTMLElement;
  arm: HTMLElement;
  progressSlider: HTMLInputElement;
  progressRail: HTMLElement;
  timeEl: HTMLElement;
  /** 唱盘左下角的播放 / 暂停键（设计稿：长方形；页面 1 里唯一的播放键） */
  deckPlayBtn: HTMLButtonElement;
  volSlider: HTMLInputElement;
  volSegments: HTMLElement[];
  queueTitle: HTMLElement;
  /** Vinyl order 行末尾的当前专辑名（设计稿：「(专辑名)」在那一栏的最后） */
  orderAlbum: HTMLElement;
  queueBox: HTMLElement;
  /** 专辑队列模式开关（顶部，「选取专辑」右边） */
  queueModeBtn: HTMLButtonElement;
}

/** 三种播放模式的图标（Obsidian 的 lucide 图标名） */
export const PLAY_MODE_ICON: Record<PlayMode, string> = {
  once: 'repeat-off',
  loop: 'repeat',
  shuffle: 'shuffle',
};

/** 模式文案键：队列模式下讲「列表」，否则讲「这张专辑」（用户要的正是这个区分） */
export function modeLabelKey(mode: PlayMode, queueMode: boolean): string {
  const scope = queueMode ? 'List' : 'Album';
  const name = mode === 'once' ? 'Once' : mode === 'loop' ? 'Loop' : 'Shuffle';
  return `player.mode${name}${scope}`;
}

const VOLUME_SEGMENT_COUNT = 24;
// 唱放卡压到两行 38px（行高 14，见 styles.css 的 .vinyl-amp）：格子按设计比例收小（5~10px，2 : 1）
const VOLUME_SEGMENT_MIN_HEIGHT = 5;
const VOLUME_SEGMENT_HEIGHT_RANGE = 5;
/** 抬手 seek 之后压住进度轨的时长：引擎把目标位置报回来之前不许回写（timeupdate 节流 400ms） */
const SEEK_HOLD_MS = 900;
/** 保持期的「引擎已到位」容差（占全长比例）：够了就把轨道交还给引擎 */
const SEEK_HOLD_TOLERANCE = 0.01;

function clampRatio(ratio: number): number {
  return Math.min(1, Math.max(0, ratio));
}

/** 指针落点 → 比例（左端 0、右端 1，越界 clamp）。进度条与电平表共用这一处换算。 */
export function pointerRatio(clientX: number, rect: { left: number; width: number }): number {
  if (!(rect.width > 0)) return 0; // 宽度为 0（还没布局 / 视图藏着）不除零
  return clampRatio((clientX - rect.left) / rect.width);
}

/** 音量表的亮格数：指针落在第 k 格，就亮 k + 1 格（含被点的那一格）—— 用户要的正是这个语义。
 *  为什么不用 round：round 把「点在第 k 格左半边」算成 k 格，被点的那格反而不亮；
 *  ceil 下指针永远在亮区里，且拖到最左格外（clientX 越过左边界）即 0 = 静音。 */
export function activeVolumeSegments(ratio: number, total: number): number {
  return Math.min(total, Math.ceil(clampRatio(ratio) * total));
}

function setSeekPosition(rail: HTMLElement, ratio: number): void {
  rail.style.setProperty('--seek-position', `${(clampRatio(ratio) * 100).toFixed(2)}%`);
}

function setVolumeSegments(segments: HTMLElement[], ratio: number): void {
  const active = activeVolumeSegments(ratio, segments.length);
  segments.forEach((segment, i) => segment.classList.toggle('is-active', i < active));
}

/** 自绘滑块 / 电平表的指针接管：按下即定位、按住拖动跟手、抬手交结果。
 *  为什么不让原生 range 干这活：它的行程是「宽度 − 滑块宽」（两端各让出半个滑块），与自绘几何
 *  对不齐 —— 进度条上让出 7px（点哪都得偏一点），电平表上则是点第 k 格亮的格数总差半格、
 *  最左边一格永远够不到 0。range 只留键盘（Tab + 方向键），故 CSS 给它 pointer-events: none。
 *  用 pointer capture 而不是「容器上监听」：拖出控件（甚至拖出窗口）也不丢事件，抬手一定收得到。 */
export function bindPointerScrub(
  hit: HTMLElement,
  input: HTMLInputElement,
  handlers: {
    /** 按下与拖动中的每一帧：给比例（已 clamp） */
    onScrub: (ratio: number) => void;
    /** 抬手（指针离开）：进度条在这里才真正 seek；音量表用不着 */
    onCommit?: (ratio: number) => void;
    onStart?: () => void;
    /** 真的拖起来了（按下后第一次移动）——「按一下」与「按住拖」要分开对待 */
    onDragStart?: () => void;
    /** 抬手或被系统收走，都会走到这里（收尾只做一次） */
    onEnd?: () => void;
    /** 命中几何，缺省用 hit 自己：进度条要按内缩半个滑块（6px）的轨道算，点哪滑块中心就落在哪 */
    geometry?: () => { left: number; width: number };
  }
): void {
  let last = 0;
  let dragging = false; // 按下之后真的移动过（「点一下」与「按住拖」要分开对待）
  let activeId: number | null = null; // 本次手势的 pointerId（null = 没按着）
  const apply = (ev: PointerEvent) => {
    const rect = handlers.geometry ? handlers.geometry() : hit.getBoundingClientRect();
    last = pointerRatio(ev.clientX, rect);
    handlers.onScrub(last);
  };
  const finish = () => {
    activeId = null;
    dragging = false;
    handlers.onEnd?.();
  };
  hit.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return; // 右键 / 中键不当拖动
    ev.preventDefault(); // 别开始选字与原生拖拽
    // 捕获是「锦上添花」（拖出控件 / 拖出窗口也收得到抬手），失败也不许拖垮这条交互：
    // 指针不活跃时 setPointerCapture 会抛，下面的 buttons 判定照样收得住手势
    try {
      hit.setPointerCapture(ev.pointerId);
    } catch {
      /* 捕获不到就靠 pointermove 的 buttons 判定兜底 */
    }
    // 键盘可达：点完接着就能用方向键微调（range 只是不接指针，仍可编程聚焦）
    input.focus({ preventScroll: true });
    activeId = ev.pointerId;
    dragging = false;
    handlers.onStart?.();
    apply(ev);
  });
  hit.addEventListener('pointermove', (ev) => {
    if (activeId === null || ev.pointerId !== activeId) return; // 不是本次手势（或只是路过）
    // 已经松手了（抬手落在控件之外又没捕获住）：当收尾，别把悬停当成拖动
    if (ev.buttons === 0) {
      finish();
      return;
    }
    if (!dragging) {
      dragging = true;
      handlers.onDragStart?.();
    }
    apply(ev);
  });
  hit.addEventListener('pointerup', (ev) => {
    if (activeId === null || ev.pointerId !== activeId) return;
    finish();
    handlers.onCommit?.(last);
  });
  // 拖动被系统收走（多指手势等）：不提交，交还给引擎的位置（下一次 update 就位）
  hit.addEventListener('pointercancel', (ev) => {
    if (activeId === null || ev.pointerId !== activeId) return;
    finish();
  });
  hit.addEventListener('lostpointercapture', () => {
    if (activeId !== null) finish(); // 捕获意外丢失（元素被摘等）：别把拖动状态挂在半路
  });
}

/** 拖拽落点 → 结果下标：drop 落在第 target 行的前 / 后（与 shelf-props 的 resolveDropIndex 同构）。
 *  被拖行先移除、其后的行左移一位，故落点在它之后时要减一；落到自己身上返回原位（无副作用）。 */
/** 整段拖拽的落点换算：块会先被摘掉，所以落点是「摘掉之后」的下标（引擎 moveRange 的语义）。 */
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

export function resolveQueueDropIndex(from: number, target: number, after: boolean): number {
  const to = target + (after ? 1 : 0);
  return from < to ? to - 1 : to;
}

// 唱臂角度的换算全部在 core/arm-geometry（姿态 1 = 停放角；姿态 2 = 专辑进度 → 唱针到圆心距离 →
// 余弦定理反解旋转角）。视图只负责把算出来的角度写进 --vinyl-arm-angle。

// —— 唱臂图形：S 型臂管（内联 SVG）——

const SVG_NS = 'http://www.w3.org/2000/svg';

/** SVG 元素小工厂（内联图形用；Obsidian 的 DOM 扩展只覆盖 HTML 元素，SVG 走原生命名空间） */
function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** S 型唱臂的臂管（用户点名要的形态，参考 Technics 的 S 臂）。
 *  形状照用户给的实拍图（Technics SL-1200 黑臂）重画：**一条朝盘外拱起的、连续的弓**——
 *  从转轴出发先与臂轴平行，中段鼓到最大（约 11% 臂长），再收回中心线进唱头。
 *  怎么来的：把参考图里臂管的中心线逐行描出来（黑色管身 vs 红漆 / 金属底，逐行取暗像素带中点），
 *  归一化到「转轴 → 唱针」的弦上，再做最小二乘拟合两条三次贝塞尔（残差 ~2-7 单位）。
 *  归一化后的剖面（弦长 = 1）：0 → 0.09(@0.15) → 0.20(@0.3) → 0.29(@0.45) → 峰 0.33(@0.5)
 *  → 0.17(@0.7) → 0.09(@0.83) → 0（@1）；换算到本画布 = 峰高 110 单位。
 *  局部坐标：x 沿臂、原点在转轴、y 向下（+y = 朝唱片圆心那一侧，所以外拱是 −y）。
 *  为什么远端必须回到 (1000, 100)：几何真值（唱针位置）是臂盒子「远端中点」
 *  （见 core/arm-geometry 与测试台 measuredStylus），图形怎么弯都行，端点不能在别处。
 *  viewBox 1000×240：x 仍是一整条臂长（等比缩放，管壁粗细不随尺寸变），y 的窗口取 [−20, 220]、
 *  以 100 为中心 —— 元件垂直居中挂上去（见 styles.css 的 .vinyl-arm-tube），所以中心线必须落在窗口正中；
 *  曲线的 y 在 [−10, 100]，加描边与落影仍在窗口内，不会被画布裁掉。
 *  改这几个数要一起看：末端切线（≈ +3°）与唱头转角（−10°，见 styles.css 的 .vinyl-arm-head）。 */
function buildArmTube(): SVGElement {
  const svg = svgEl('svg', {
    class: 'vinyl-arm-tube',
    viewBox: '0 -20 1000 240',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  const defs = svgEl('defs', {});
  const sheen = svgEl('linearGradient', { id: 'vinyl-arm-sheen', x1: '0', y1: '0', x2: '0', y2: '1' });
  sheen.appendChild(svgEl('stop', { offset: '0', 'stop-color': '#f4f5f7' }));
  sheen.appendChild(svgEl('stop', { offset: '0.48', 'stop-color': '#c9cbd2' }));
  sheen.appendChild(svgEl('stop', { offset: '1', 'stop-color': '#87898f' }));
  defs.appendChild(sheen);
  svg.appendChild(defs);
  // 臂管轴线：起点贴住枢轴（x=0，被枢轴座盖住），中段外拱 110 单位，远端精确回到 (1000, 100) —— 唱头挂在那里
  const tube = 'M 0 100 C 240 100 330 -10 490 -10 C 670 -10 710 85.5 1000 100';
  const stroke = (extra: Record<string, string>) =>
    svgEl('path', { d: tube, fill: 'none', 'stroke-linecap': 'round', ...extra });
  // 落影 → 管身（银）→ 顶面高光：三层描边堆出圆管的体积感
  svg.appendChild(stroke({ stroke: 'rgba(0, 0, 0, 0.32)', 'stroke-width': '16', transform: 'translate(0 7)' }));
  svg.appendChild(stroke({ stroke: 'url(#vinyl-arm-sheen)', 'stroke-width': '15' }));
  svg.appendChild(stroke({ stroke: 'rgba(255, 255, 255, 0.72)', 'stroke-width': '3.5', transform: 'translate(0 -4)' }));
  return svg;
}

export class VinylPlayerView extends ItemView {
  private plugin: VinylLifePlugin;
  private unsub: (() => void) | null = null;
  private els: PlayerEls | null = null;
  private renderedQueue: Track[] | null = null;
  private queueRows: HTMLElement[] = [];
  /** 每行的序号格：拖拽提示挂在它上面（行的 aria-label 留给曲名，一个元素只留一个提示来源） */
  private queueIdxs: HTMLElement[] = [];
  /** 段容器（多专辑时画出来的分组）+ 段头：切语言要按它们重写段头提示 */
  private segmentEls: Array<{ el: HTMLElement; head: HTMLElement; seg: { start: number; count: number; albumTitle: string; albumPath: string } }> = [];
  // 队列行右侧的来源角标（文案随语言变；行不重建，切语言时按 renderedQueue 就地重写）
  private queueBadges: HTMLElement[] = [];
  /** 段头里的小按钮（写感想 / 移除整段）：切语言时按段就地重写 aria-label */
  private segmentBtns: Array<{ note: HTMLElement; remove: HTMLElement | null; seg: { albumTitle: string; albumPath: string } }> = [];
  /** 封面候选链的签名（链内容变化才换图；链见 core/cover-url.coverChain） */
  private currentCoverSig: string | null = null;
  private coverChain: string[] = [];
  private lastAlbumPath: string | null = null;
  private lastSpinning = false;
  private lastArmAngle = NaN;
  /** 唱臂姿态（park / record）：只在变化时写类，避免每帧动 DOM */
  private lastPosture: 'park' | 'record' | null = null;
  private playLit = false;
  // 最近一次收到的快照（切语言时优先向引擎现取一份；仅引擎缺失的极简依赖下用它兜底）
  private lastSnapshot: PlayerSnapshot | null = null;
  // 随语言变的标签登记（见 bindLabel）：壳只建一次，切语言时不能重建 DOM 兜底
  // （重建会打断转盘旋转与入场动画、丢掉进度），只能把赋值动作记下来逐条重放。
  private labelEls: Array<() => void> = [];
  // 空队列提示节点（随队列重建；切语言时就地改文本，不重建节点）
  private emptyQueueEl: HTMLElement | null = null;
  // 条件更新缓存（值不变不写 DOM，减少样式失效与 :has() 重算）
  private lastRatio = -1;
  private lastTimeText = '';
  private lastVol = -1;
  /** 进度条被按住拖动中：手指说了算，快照不许回写轨道与读数（见 update 的 seekOwned） */
  private seeking = false;
  /** 抬手 seek 之后的目标值 + 保持期限：等引擎到位再交还控制权（见 SEEK_HOLD_MS） */
  private seekHold: { ratio: number; index: number; until: number } | null = null;
  private onVisibility = () => this.syncVisibility();
  /** 唱片区（页面 2）：三行唱片架。第一次翻到这一面时才建（懒建），此后常驻 */
  private picker: AlbumPicker | null = null;
  /** 页面 2 那个面（唱片区挂在这里） */
  private pickerFace: HTMLElement | null = null;
  /** 当前显示的是哪一面（'player' = 唱机卡那面，'picker' = 唱片区那面） */
  private face: 'player' | 'picker' = 'player';
  /** 翻转区半深（px）：= 区宽 / 2，随尺寸变化重算（见 syncFlipDepth） */
  private flipRO: ResizeObserver | null = null;
  /** Vinyl order 行末尾的专辑名（随当前曲目变，值不变不写 DOM） */
  private orderAlbumText: HTMLElement | null = null;
  private lastOrderAlbum = '';
  // 队列拖拽态：dragging 抑制拖拽尾巴上的 click（见 endQueueDrag），dragFrom 是被拖行的下标
  private dragging = false;
  /** 整段拖拽中的来源段（与行拖拽互斥，避免两套拖拽同时生效） */
  private dragSegment: { start: number; count: number } | null = null;
  /** 上一次渲染的段数：变多说明刚排入新专辑 → 闪一下作为反馈 */
  private lastSegmentCount = -1;
  /** 上一次渲染的播放模式：图标只在模式变化时重设 */
  private lastPlayMode: PlayMode | null = null;
  /** 当前画出来的段数（折叠提示要用；不去问引擎，渲染之外也能调用） */
  private renderedSegmentCount = 0;
  private dragFrom = -1;
  private clickBlockUntil = 0;

  constructor(leaf: WorkspaceLeaf, plugin: VinylLifePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return PLAYER_VIEW_TYPE;
  }

  getDisplayText() {
    return t('player.title');
  }

  getIcon() {
    return 'disc-3';
  }

  // 外观（设置 → 外观）：转盘转速 + 面板配色 + 唱片配色（改设置即时生效，无需重开视图）
  applyAppearance() {
    const c = this.contentEl;
    const speed = SPIN_SPEEDS[this.plugin.settings.turntableSpeed] || SPIN_SPEEDS.normal;
    c.style.setProperty('--vinyl-spin-duration', speed);
    // 两套配色都是纯类切换（互斥 toggle，避免脏值残留）
    for (const v of DECK_STYLES) c.toggleClass(deckClass(v), v === this.plugin.settings.playerDeck);
    for (const v of RECORD_COLORS) c.toggleClass(recordClass(v), v === this.plugin.settings.recordColor);
  }

  async onOpen() {
    this.applyAppearance();
    // 顶部专辑名的悬停滚动：委托挂在 contentEl（标题文字随播放状态变，逐次挂监听会漏）
    this.registerDomEvent(this.contentEl, 'pointerover', (ev) => onMarqueeOver(ev));
    this.registerDomEvent(this.contentEl, 'pointerout', (ev) => onMarqueeOut(ev));
    // 翻转区的半深跟着宽度走（translateZ 不认百分比，只能在尺寸变化时写一次 CSS 变量）
    this.flipRO = new ResizeObserver(() => this.syncFlipDepth());
    this.flipRO.observe(this.contentEl);
    // Esc：在唱片区按一下回播放器（焦点在别处也管用，见 onEscape）
    this.registerDomEvent(this.contentEl, 'keydown', (ev) => this.onEscape(ev));
    // 性能：仅在「真的看不见」时暂停转盘旋转（窗口不可见 / 视图未渲染），判据见 syncVisibility
    this.registerEvent(this.app.workspace.on('active-leaf-change', this.onVisibility));
    document.addEventListener('visibilitychange', this.onVisibility);
    this.unsub = this.plugin.engine.subscribe((s) => this.update(s));
  }

  async onClose() {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    this.flipRO?.disconnect();
    this.flipRO = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  /** 翻转区半深 = 区宽 / 2（+ 反向缩放系数：抵消透视放大，静止的一面永远是 1:1）。
   *  顺带给唱片区算行高（--vinyl-pick-h）：除去分隔线与少量内边距后三等分。 */
  private syncFlipDepth() {
    const els = this.els;
    if (!els) return;
    const w = els.flip.clientWidth;
    if (!(w > 0)) return;
    const depth = w / 2;
    const perspective = this.flipPerspective();
    els.flip.style.setProperty('--vinyl-flip-depth', `${depth.toFixed(1)}px`);
    els.flip.style.setProperty('--vinyl-flip-perspective', `${perspective}px`);
    // 透视会把处在 z = depth 平面上的一面放大 P/(P−depth)，静止时用反向 scale 拉回 1:1
    els.flipInner.style.setProperty('--vinyl-flip-counter', ((perspective - depth) / perspective).toFixed(4));
    if (this.picker) {
      const h = els.flip.clientHeight;
      if (h > 0) {
        const pickH = Math.max(60, Math.min(108, Math.floor((h - 12) / 3)));
        this.picker.el.style.setProperty('--vinyl-pick-h', `${pickH}px`);
      }
    }
  }

  /** 透视距离：随容器宽度走（窄侧栏里 1200px 会显得很夸张，宽面板里 1200px 又太平） */
  private flipPerspective(): number {
    const w = this.els?.flip.clientWidth || 360;
    return Math.round(Math.max(900, Math.min(2400, w * 3.4)));
  }

  // 转盘停转的判据只有两种「真的看不见」：窗口不可见（最小化 / 切到别的应用）、本视图没被渲染
  // （后台标签页、折叠的侧栏、独立窗口已关）。不能按「当前活动叶」判断——播放器常驻侧栏时，
  // 播放期间活动叶仍在专辑墙上，那样唱片会被冻住，转动就与歌曲播放对不上了。
  private syncVisibility() {
    if (!this.els) return;
    const doc = this.containerEl.ownerDocument;
    const el = this.containerEl;
    // isShown 缺失时按「可见」处理：宁可持续转，也不要静默停转
    const shown = typeof el.isShown === 'function' ? el.isShown() : true;
    this.els.vinyl.classList.toggle('is-hidden', !!doc.hidden || !shown);
  }

  // ============ 壳（只建一次） ============

  // 登记一个「随语言变」的标签动作：建壳时立刻应用一次，之后 applyLanguage() 重放。
  // 动作里照常写 t() 字面量键，i18n 的键扫描测试才覆盖得到（别把 key 抽成字符串参数）。
  private bindLabel(apply: () => void) {
    this.labelEls.push(apply);
    apply();
  }

  // 语言切换后就地更新（不重建 DOM）：只重放登记过的标签赋值，转盘旋转 / 入场动画 / 播放进度都不受影响
  applyLanguage() {
    for (const apply of this.labelEls) apply();
    this.applyQueueLabels();
    this.picker?.applyLabels(); // 唱片区（页面 2）的计数与动作条文案（唱片提示只报专辑名，与语言无关）
    // 文案都由快照决定、由 update 统一维护：切语言时按新语言重放一次即可。
    // 快照必须现取而不是用 lastSnapshot：队列行的来源文案是引擎按当前语言求值的。
    // 引擎缺失时（极简依赖的测试）退回最近一次收到的快照。
    const snap = this.plugin.engine ? this.plugin.engine.snapshot() : this.lastSnapshot;
    if (snap) {
      this.update(snap);
    }
  }

  // 队列文案（行拖拽提示 / 空态 / 来源角标）不挂在壳上、随队列重建，故单独就地刷新（只改属性与文本，不重建节点）
  private applyQueueLabels() {
    const els = this.els;
    if (els) {
      els.queueModeBtn.setAttribute('aria-label', t('player.queueMode'));
      // 播放模式钮的提示就是当前模式名本身（不再缀「点击切换」）
      els.playModeBtn.setAttribute(
        'aria-label',
        t(modeLabelKey(this.lastPlayMode || 'once', this.plugin.settings.queueMode))
      );
    }
    // 段头：拖拽提示 / 写感想（每个专辑一个）/ 移除整段
    for (const { note, remove, seg } of this.segmentBtns) {
      const name = seg.albumTitle || seg.albumPath;
      note.setAttribute('aria-label', tf('player.noteAlbum', { name }));
      if (remove) remove.setAttribute('aria-label', tf('player.queueRemoveAlbum', { name }));
    }
    // 段头可拖拽（整段排序）的提示：只有多专辑时才真能拖，但文案写在头上不碍事。
    // 走 aria-label 而不是 title —— 段头里还有「写感想 / 移除整段」两个按钮，浏览器会把祖先的
    // title 也弹出来，与宿主按 aria-label 画的气泡叠成两个（这就是「写感想」那两个气泡的来源）。
    for (const { head } of this.segmentEls) head.setAttribute('aria-label', t('player.queueDragAlbum'));
    // 行的拖拽提示改挂序号：行自己已经用 aria-label 报曲名，同一元素只留一个提示来源
    for (const idx of this.queueIdxs) idx.setAttribute('aria-label', t('player.dragToReorder'));
    if (this.emptyQueueEl) this.emptyQueueEl.textContent = t('player.emptyQueue');
    // 来源角标走 trackSourceLabel（随语言变）：行不重建，按当前队列就地重写文本
    const queue = this.renderedQueue;
    if (!queue) return;
    this.queueBadges.forEach((badge, i) => {
      const track = queue[i];
      if (track) badge.textContent = trackSourceLabel(track);
    });
  }

  private ensureShell(): PlayerEls {
    if (this.els) return this.els;
    const c = this.contentEl;
    c.empty();
    c.addClass('vinyl-player');

    // 滚动层（板）：内边距与纵向滚动都挂在这层 —— 所有不参与翻面的内容（按键卡 / 队列）都建在板上
    const board = c.createDiv({ cls: 'vinyl-board' });

    // 卡①：顶部三枚键（设计稿 2 : 1 : 1 —— 选取专辑占一半，两个模式开关各占四分之一）。
    // 专辑名不占这张卡 —— 设计稿把它放在 Vinyl order 那一栏的最后（见下面的 orderAlbum）。
    const header = board.createDiv({ cls: 'vinyl-player-header' });
    // 选取专辑：翻转区的开关（只留图标 —— 用户不要文字；再点一下转回唱机卡）
    const pickBtn = header.createEl('button', { cls: 'vinyl-btn-wide vinyl-pick-album' });
    setIcon(pickBtn, 'disc-3');
    this.bindLabel(() => {
      pickBtn.setAttribute('aria-label', t('player.pickAlbum'));
    });
    pickBtn.addEventListener('click', () => this.flipTo(this.face === 'picker' ? 'player' : 'picker'));
    // 专辑队列模式开关（默认关）：开着时点专辑（唱片区 / 专辑墙）是排队，不是换碟
    const queueModeBtn = header.createEl('button', { cls: 'vinyl-btn-mode vinyl-queue-mode' });
    setIcon(queueModeBtn, 'list-plus');
    queueModeBtn.addEventListener('click', () => this.toggleQueueMode());
    // 播放模式：单次 → 循环 → 随机 循环切换（队列模式下作用于整条列表，见 modeLabelKey）
    const playModeBtn = header.createEl('button', { cls: 'vinyl-btn-mode vinyl-play-mode' });
    setIcon(playModeBtn, PLAY_MODE_ICON.once);
    playModeBtn.addEventListener('click', () => this.cyclePlayMode());

    // 翻转区（②+③）：只有这一区翻面（左转 90°）—— 正面 = 唱机卡 + 唱放卡，背面 = 唱片区。
    // 按键卡、Vinyl order、队列都留在板上不动（用户要求「其他不要变」）。
    const flip = board.createDiv({ cls: 'vinyl-flip' });
    const flipInner = flip.createDiv({ cls: 'vinyl-flip-inner' });
    const deckFace = flipInner.createDiv({ cls: 'vinyl-flip-face is-deck' });
    const crateFace = flipInner.createDiv({ cls: 'vinyl-flip-face is-crate' });

    // 卡②：唱机（设计稿：横向长方形唱机）。配色见 .vinyl-deck 与 .is-deck-*（四套面板配色）
    const deck = deckFace.createDiv({ cls: 'vinyl-deck' });
    // 转盘分成两层（用户要「毛毡垫再大」）：盘面层允许垫子 / 唱片长到转盘盒外面去
    // （竖向溢出到面板的内边距里），只按盒宽裁 —— 唱片的入场仍从盒左缘滑进来；唱臂层照旧整盒裁。
    // 两层都是绝对定位的覆盖层，不影响布局；几何真值仍以 .vinyl-turntable 的盒子为准（见 core/arm-geometry）。
    const turntable = deck.createDiv({ cls: 'vinyl-turntable' });
    const padLayer = turntable.createDiv({ cls: 'vinyl-turntable-pad' });
    padLayer.createDiv({ cls: 'vinyl-turntable-platter' });
    const discOuter = padLayer.createDiv({ cls: 'vinyl-turntable-disc' });
    const vinyl = discOuter.createDiv({ cls: 'vinyl-turntable-vinyl is-empty' });
    const label = vinyl.createDiv({ cls: 'vinyl-turntable-label' });
    const labelImg = label.createEl('img', { attr: { alt: '' }, cls: 'vinyl-hidden' });
    const labelEmpty = label.createDiv({ cls: 'vinyl-turntable-label-empty', text: '♪' });
    // 唱臂：配重 + S 型臂管（内联 SVG）+ 枢轴 + 唱头；另一枚是唱臂支架（不播放时唱头落在卡口上）。
    // 绘制顺序：臂管夹在枢轴与唱头之间 —— 管子从枢轴座底下钻出来（见 styles.css 的 .vinyl-arm-tube）。
    // 臂盒子会甩到转盘盒外（转轴在 94%、臂长 49%），所以单独套一层裁剪层。
    const armLayer = turntable.createDiv({ cls: 'vinyl-turntable-clip' });
    const arm = armLayer.createDiv({ cls: 'vinyl-turntable-arm' });
    arm.createDiv({ cls: 'vinyl-arm-counterweight' });
    arm.appendChild(buildArmTube());
    arm.createDiv({ cls: 'vinyl-arm-pivot' });
    arm.createDiv({ cls: 'vinyl-arm-head' });
    turntable.createDiv({ cls: 'vinyl-arm-rest' });
    turntable.createDiv({ cls: 'vinyl-turntable-spindle' });

    // 唱机左下角的播放 / 暂停键（设计稿：长方形，不是圆钮；位置 / 键面见 styles.css 的 .vinyl-deck-play）。
    // 页面 1 里就这一枚播放键（原先的 ⏮ ▶ ⏭ 圆钮已按设计稿删除）。
    const deckPlayBtn = turntable.createEl('button', { cls: 'vinyl-deck-play' });
    // 键面 = 手写体的字标（用户要求：不要那颗三角；第五轮缩成「V-L」这个品牌缩写，不折行）；
    // 播放状态靠点亮 / 未点亮（见 styles.css 的 .is-playing）—— 字标本身就是这枚键的样子。
    deckPlayBtn.createSpan({ cls: 'vinyl-deck-play-mark', text: 'V-L' });
    this.bindLabel(() => deckPlayBtn.setAttribute('aria-label', t('player.playPause')));
    deckPlayBtn.addEventListener('click', () => {
      void this.plugin.engine.toggle();
    });

    // 卡③：唱放（两行控制条：上进度轨、下音量，版式与设计一致；面板材质与唱机卡共用，见 styles.css）
    const amp = deckFace.createDiv({ cls: 'vinyl-amp' });

    // 歌曲进度：原生 range 只负责键盘，自绘轨道的填充与滑块共用同一坐标系（点即定位）。
    const progress = amp.createDiv({ cls: 'vinyl-progress' });
    const progressControl = progress.createDiv({ cls: 'vinyl-seek-control' });
    const progressRail = progressControl.createDiv({ cls: 'vinyl-seek-rail' });
    progressRail.createDiv({ cls: 'vinyl-seek-fill' });
    progressRail.createDiv({ cls: 'vinyl-seek-thumb' });
    const progressSlider = progressControl.createEl('input', {
      attr: { type: 'range', min: '0', max: '1000' },
      cls: 'vinyl-range-input vinyl-seek-input',
    });
    const timeEl = progress.createSpan({ text: '–:– / –:–', cls: 'vinyl-readout' });
    this.bindLabel(() => progressSlider.setAttribute('aria-label', t('player.seek')));
    const seekable = () => (this.lastSnapshot?.duration || 0) > 0;
    // 拖动只挪画面与读数（点 / 填充 / 时间立刻跟手），抬手才真正 seek：拖动中反复 seek 会让
    // 音频抽搐、在线源反复取流。拖动期间每个快照都被挡在门外（见 update 的 seekOwned），
    // 否则引擎回声会把点拽回播放位置 —— 那才是「拖了没反应」的根。
    const previewSeek = (ratio: number) => {
      const dur = this.lastSnapshot?.duration || 0;
      if (!(dur > 0)) return; // 没在放歌：别把点画到假位置上
      const r = clampRatio(ratio);
      progressSlider.value = String(Math.round(r * 1000)); // 接得住随后的方向键微调
      setSeekPosition(progressRail, r);
      // 读数跟着预览（抬手前也能看清要跳到哪），并写进缓存：保持期结束时不会被旧文案回写
      const text = `${fmtTime(r * dur)} / ${fmtTime(dur)}`;
      if (text !== this.lastTimeText) {
        this.lastTimeText = text;
        timeEl.textContent = text;
      }
    };
    const commitSeek = (ratio: number) => {
      if (!seekable()) return;
      const r = clampRatio(ratio);
      // 抬手后短暂压住轨道：在线源 seek 有往返，引擎报回目标位置前不许回写
      this.seekHold = {
        ratio: r,
        index: this.lastSnapshot?.index ?? -1,
        until: Date.now() + SEEK_HOLD_MS,
      };
      this.plugin.engine.seek(r);
    };
    bindPointerScrub(progressControl, progressSlider, {
      geometry: () => progressRail.getBoundingClientRect(), // 按轨道（内缩 7px）算：点哪都不偏
      onScrub: previewSeek,
      onStart: () => {
        this.seeking = true;
      },
      // 拖起来才关掉缓动：点一下跳转仍走那 220ms 的平滑推移，拖动则直接跟手
      onDragStart: () => progressControl.addClass('is-scrubbing'),
      onEnd: () => {
        this.seeking = false;
        progressControl.removeClass('is-scrubbing');
      },
      onCommit: commitSeek,
    });
    // 键盘：方向键步进（原生 range 的 input）也压一下轨道，否则 400ms 后才有回声时会跳回去
    progressSlider.addEventListener('input', () => {
      const ratio = Number(progressSlider.value) / 1000;
      previewSeek(ratio);
      commitSeek(ratio);
    });

    // 音量表：参考手绘稿的阶梯矩形，增加格数并收敛高度变化。
    // 它就当一根长得不一样的调节条用：点到哪一格，那一格（含）之前全亮。
    const volRow = amp.createDiv({ cls: 'vinyl-vol-row' });
    const volMeter = volRow.createDiv({ cls: 'vinyl-volume-meter' });
    const volBars = volMeter.createDiv({ cls: 'vinyl-volume-bars' });
    const volSegments = Array.from({ length: VOLUME_SEGMENT_COUNT }, (_, i) => {
      const segment = volBars.createSpan({ cls: 'vinyl-volume-segment' });
      const level = Math.round((i / (VOLUME_SEGMENT_COUNT - 1)) * VOLUME_SEGMENT_HEIGHT_RANGE);
      segment.style.setProperty('--segment-height', `${VOLUME_SEGMENT_MIN_HEIGHT + level}px`);
      segment.style.setProperty('--segment-i', String(i)); // 阶梯波浪的次序（见 styles.css）
      return segment;
    });
    const volSlider = volMeter.createEl('input', {
      attr: { type: 'range', min: '0', max: '100' },
      cls: 'vinyl-range-input vinyl-volume-input',
    });
    this.bindLabel(() => volSlider.setAttribute('aria-label', t('player.volume')));
    const applyVolume = (ratio: number) => {
      const r = clampRatio(ratio);
      setVolumeSegments(volSegments, r);
      volSlider.value = String(Math.round(r * 100));
      this.plugin.engine.setVolume(r);
    };
    bindPointerScrub(volMeter, volSlider, {
      onScrub: applyVolume,
      // 拖起来才摘掉阶梯波浪的延迟：点一下（跳格）要那串波浪，拖动则一格都不许滞后
      onDragStart: () => volMeter.addClass('is-scrubbing'),
      onEnd: () => volMeter.removeClass('is-scrubbing'),
    });
    // 键盘（Tab + 方向键）仍走原生 range 的 input —— 指针已经被 pointer-events: none 让开
    volSlider.addEventListener('input', () => applyVolume(Number(volSlider.value) / 100));

    // Vinyl order 行：标题 + 当前专辑名（设计稿：专辑名跟在那一栏的最后）。
    // 清空队列 / 恢复发行顺序两个按键及其功能已按设计稿删除；「写点什么吧」移到每个专辑名行里（见 renderQueue）。
    const orderRow = board.createDiv({ cls: 'vinyl-order-row' });
    const queueTitle = orderRow.createDiv({ cls: 'vinyl-queue-title' });
    const orderAlbum = orderRow.createDiv({ cls: 'vinyl-order-album vinyl-marquee' });
    const orderAlbumText = orderAlbum.createSpan({ cls: 'vinyl-marquee-text' });
    this.orderAlbumText = orderAlbumText;

    const queueBox = board.createDiv({ cls: 'vinyl-queue' });
    // 队列点击委托（重建不丢监听）。拖拽与点击共存：拖拽中 / 拖拽刚收尾的 click 一律不当切歌，
    // 否则手一松就会被拖拽尾巴上的 click 切到别的曲子
    queueBox.addEventListener('click', (ev) => {
      if (this.isQueueClickBlocked()) return;
      // targetNode + instanceOf 是 Obsidian 的跨窗口安全判定（弹窗 / 独立窗口里 instanceof 会误判）
      const node = ev.targetNode;
      const row = node && node.instanceOf(HTMLElement) ? node.closest<HTMLElement>('.vinyl-queue-item') : null;
      if (row && row.dataset.idx != null) {
        void this.plugin.engine.playIndex(Number(row.dataset.idx));
      }
    });
    // 兜底：dragend 万一没触发，下一次按下即解除拖拽态（否则点击切歌会被永久抑制）。
    // 这里只复位拖拽态、不设 click 抑制窗口，否则随后的正常点击会被误伤
    queueBox.addEventListener('pointerdown', () => this.resetQueueDrag());
    // 键盘：Enter / 空格切歌；Alt+↑/↓ 与拖拽等价地调整顺序（重排后焦点跟着挪到新位置）
    queueBox.addEventListener('keydown', (ev) => {
      const node = ev.target as HTMLElement | null;
      const row =
        node && typeof node.closest === 'function'
          ? node.closest<HTMLElement>('.vinyl-queue-item')
          : null;
      if (!row) return;
      const idx = Number(row.dataset.idx);
      if (!Number.isInteger(idx)) return;
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault();
        void this.plugin.engine.playIndex(idx);
        return;
      }
      if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
        ev.preventDefault();
        const to = ev.key === 'ArrowUp' ? idx - 1 : idx + 1;
        if (to < 0 || to >= this.queueRows.length) return;
        this.plugin.engine.moveTrack(idx, to);
        window.setTimeout(() => this.queueRows[to]?.focus(), 0);
      }
    });

    this.els = {
      flip,
      flipInner,
      pickBtn,
      queueModeBtn,
      playModeBtn,
      discOuter,
      vinyl,
      labelImg,
      labelEmpty,
      arm,
      progressSlider,
      progressRail,
      timeEl,
      deckPlayBtn,
      volSlider,
      volSegments,
      queueTitle,
      orderAlbum,
      queueBox,
    };
    // 唱片区先只留个空面：懒建（第一次翻过去才扫专辑，打开播放器不必为它扫全库）
    this.pickerFace = crateFace;
    this.syncFlipDepth();
    return this.els;
  }

  // ============ 立方体两面（页面 1 / 页面 2）============

  /** 翻转区翻面：左转 = rotateY(-90deg)（只有②③卡片这一区转，两面跟着转；减小动效时直接到位） */
  private flipTo(face: 'player' | 'picker') {
    const els = this.els;
    if (!els || this.face === face) return;
    this.face = face;
    if (face === 'picker' && !this.picker) {
      // 第一次翻到唱片区才建（并从此常驻：展开态 / 滚动位置在来回翻面时保留）
      this.picker = new AlbumPicker({
        app: this.plugin.app,
        load: () => this.loadPickerEntries(),
        currentPath: () => this.lastSnapshot?.albumNotePath || undefined,
        switchTo: (album) => void this.pickAlbum(album),
        enqueue: (albums) => void this.enqueueAlbums(albums),
        back: () => this.flipTo('player'),
      });
      this.pickerFace?.appendChild(this.picker.el);
      this.syncFlipDepth(); // 新出现的唱片区按翻转区高算行高（--vinyl-pick-h）
    }
    if (face === 'picker') this.picker?.render(); // 每次翻过去都重扫一遍专辑（刚导入的立刻能看到）
    els.flip.toggleClass('is-crate', face === 'picker');
    els.flip.toggleClass('is-reduced', prefersReducedMotion());
    els.pickBtn.toggleClass('is-active', face === 'picker');
  }

  /** 键盘：在唱片区按 Esc 回播放器（焦点不在唱片箱里时也管用 —— 箱内由唱片区自己处理并阻止冒泡）。 */
  private onEscape(ev: KeyboardEvent) {
    if (ev.key !== 'Escape' || this.face !== 'picker') return;
    ev.preventDefault();
    if (this.picker?.hasSelection()) {
      this.picker.clearSelection(); // 有选中先清空，再按一次才回去
      return;
    }
    this.flipTo('player');
  }

  /** 唱片区用：扫描专辑集合（与专辑墙同一套：笔记 → 专辑信息 → 音源角标） */
  private loadPickerEntries(): PickerEntry[] {
    const app = this.plugin.app;
    if (!app) return []; // 极简测试依赖下没有 app：唱片区画空态
    return findAlbumNotes(app)
      .map((f) => getAlbumInfo(app, f, { coverFolder: this.plugin.settings.coverFolder }))
      .filter((a): a is AlbumInfo => !!a)
      .map((album) => {
        const src = detectAlbumSources(app, album);
        return { album, local: src.local, netease: src.netease, qq: src.qq };
      })
      .sort((a, b) => a.album.title.localeCompare(b.album.title, 'zh-CN'));
  }

  /** 唱片区点一张专辑 = 快速换碟：翻回页面 1 → 取碟（播放与否交设置里的「自动播放」）。
   *  队列模式下不换碟，点一张 = 排一张（与专辑墙同一语义，也留在唱片区方便接着选）。 */
  private async pickAlbum(album: AlbumInfo) {
    if (this.plugin.settings.queueMode) {
      const res = await this.plugin.engine.enqueueAlbum(album);
      if (res.tracks.length) notice(tf('notice.queuedAlbum', { name: album.title }));
      return;
    }
    // 纯收藏（无任何音源）：与专辑墙一致 —— 打开笔记并提示，不换碟
    const src = detectAlbumSources(this.plugin.app, album);
    if (!src.local && !src.netease && !src.qq) {
      const leaf = this.plugin.app.workspace.getLeaf(false);
      await leaf.openFile(album.file);
      notice(t('card.noSource'));
      return;
    }
    // 已经是这张（且队列还在）→ 只翻回去，不重新取碟
    if (this.lastSnapshot?.albumNotePath === album.path && this.lastSnapshot.queue.length) {
      this.flipTo('player');
      return;
    }
    this.flipTo('player');
    try {
      await this.plugin.engine.loadAlbum(album);
    } catch (e) {
      console.warn('[vinyl] 唱片区换碟失败', e);
    }
  }

  /** 唱片区多选后「加入队列」：按点选顺序逐张排队（顺序不能乱，故串行 await）。
   *  队列为空时第一张按普通换碟处理（引擎语义）。 */
  private async enqueueAlbums(albums: AlbumInfo[]) {
    const before = this.plugin.engine.snapshot().queue.length;
    for (const album of albums) {
      await this.plugin.engine.enqueueAlbum(album);
    }
    const after = this.plugin.engine.snapshot().queue.length;
    // 一张都没排进去（都没音源）时引擎已经各自弹过提示，这里不再重复
    if (after > before) notice(tf('picker.queued', { n: albums.length }));
  }

  // ============ 增量更新 ============

  private update(s: PlayerSnapshot) {
    const els = this.ensureShell();
    this.lastSnapshot = s;

    // 专辑切换 → 落盘入场（C 阶段）/ 清空回位
    const albumPath = s.albumNotePath || null;
    if (albumPath && albumPath !== this.lastAlbumPath) {
      this.lastAlbumPath = albumPath;
      this.playEntrance(els);
    } else if (!albumPath && this.lastAlbumPath) {
      this.lastAlbumPath = null;
      this.resetTurntable(els);
    }

    // 队列（引用变化才重建；当前高亮走 class 切换）
    if (s.queue !== this.renderedQueue) this.rebuildQueue(els, s);
    // 队列模式开关的当前状态（设置改了、切了开关都要跟着走）
    this.syncQueueControls();
    // 播放模式按钮：图标随模式变，非默认（单次）时给个高亮色
    if (s.playMode !== this.lastPlayMode) {
      this.lastPlayMode = s.playMode;
      setIcon(els.playModeBtn, PLAY_MODE_ICON[s.playMode]);
      els.playModeBtn.toggleClass('is-active', s.playMode !== 'once');
    }
    this.queueRows.forEach((row, i) => row.classList.toggle('is-current', i === s.index));

    // 转盘状态（旋转动画只切 class，不重建节点）
    const spinning = s.status === 'playing';
    els.vinyl.classList.toggle('is-spinning', spinning);
    // 刚转入播放：重算一次可见性，清掉可能残留的 is-hidden（否则动画停在 paused，转不动）
    if (spinning && !this.lastSpinning) this.syncVisibility();
    this.lastSpinning = spinning;
    els.vinyl.classList.toggle('is-paused', s.status === 'paused');
    els.vinyl.classList.toggle('is-empty', !s.queue.length);

    // 唱片中心封面：库内封面 → 曲目远程封面 → 备用图床（见 coverChain）。
    // 链内容变化才重置显示；单个候选加载失败自动换下一个（onerror），全失败回占位符。
    const chain = coverChain(this.localCover(s), s.current?.cover);
    const sig = chain.join('\n');
    if (sig !== this.currentCoverSig) {
      this.currentCoverSig = sig;
      this.coverChain = chain;
      this.showCover(els, 0);
    }

    // 进度 / 计数器（值不变不写 DOM）。
    // 拖动中与抬手后的保持期内，轨道与读数由本地目标值说了算：引擎的每一次回声（播放推进、
    // seek 往返）都不许回写，否则手指和回声会互相拽，看着就是「drag 了没反应」。
    const dur = Math.max(s.duration, s.currentTime);
    const ratioRaw = dur > 0 ? Math.min(1, s.currentTime / dur) : 0;
    const ratio = Math.round(ratioRaw * 1000);
    if (this.seekHold) {
      // 保持期的三种收尾：引擎到位 → 交还；换曲了（seek 到结尾会连着切歌）→ 立刻交还；超时 → 如实显示
      const arrived = Math.abs(ratioRaw - this.seekHold.ratio) < SEEK_HOLD_TOLERANCE;
      const switched = s.index !== this.seekHold.index;
      if (arrived || switched || Date.now() > this.seekHold.until) this.seekHold = null;
    }
    const seekOwned = this.seeking || this.seekHold !== null;
    if (!seekOwned && ratio !== this.lastRatio) {
      this.lastRatio = ratio;
      els.progressSlider.value = String(ratio);
      setSeekPosition(els.progressRail, ratioRaw);
    }
    const timeText = `${fmtTime(s.currentTime)} / ${fmtTime(s.duration)}`;
    if (!seekOwned && timeText !== this.lastTimeText) {
      this.lastTimeText = timeText;
      els.timeEl.textContent = timeText;
    }

    // 唱臂姿态（设计稿）：未播放专辑 / 暂停 = 姿态 1（归位支架）；
    // 播放专辑 = 姿态 2（落针），且唱针到唱片圆心的「距离」= 专辑进度（换算见 core/arm-geometry）。
    // loading（换曲取址的间隙）保持落针，避免唱臂在换曲时来回摆。
    const posture = armPosture(s.status, s.queue.length);
    if (posture !== this.lastPosture) {
      this.lastPosture = posture;
      els.arm.toggleClass('is-parked', posture === 'park');
    }
    const armAngle =
      posture === 'park'
        ? ARM_PARK_ANGLE
        : armAngleForProgress(
            albumProgress({
              queue: s.queue,
              index: s.index,
              albumNotePath: s.albumNotePath,
              currentTime: s.currentTime,
              duration: dur,
            })
          );
    // 判据写成「不小于等于」而不是「大于」：首帧 lastArmAngle 是 NaN，用 > 比较永远为假，
    // 打开视图时正在播放的话唱臂会停在 CSS 默认角上（要等 400ms 后的下一次快照才动）。
    if (!(Math.abs(armAngle - this.lastArmAngle) <= 0.05)) {
      this.lastArmAngle = armAngle;
      els.arm.style.setProperty('--vinyl-arm-angle', `${armAngle.toFixed(2)}deg`);
    }

    // Vinyl order 行末尾的当前专辑名（设计稿：「专辑名」在那一栏最后；空队列不占位）
    const orderAlbum = s.albumTitle || '';
    if (orderAlbum !== this.lastOrderAlbum) {
      this.lastOrderAlbum = orderAlbum;
      if (this.orderAlbumText) this.orderAlbumText.textContent = orderAlbum;
      els.orderAlbum.toggleClass('vinyl-hidden', !orderAlbum);
    }

    // 播放键的点亮状态（状态变化才写）：唱机左下角那一枚长方形键，键面是「Vinyl」字标，
    // 播放中点亮、暂停 / 未播放是暗的（图标已按用户要求撤掉）
    const lit = s.status === 'playing';
    if (lit !== this.playLit) {
      this.playLit = lit;
      els.deckPlayBtn.toggleClass('is-playing', lit);
    }

    // 音量（分段电平表；值不变不写。拖动中的本地写入与这里算出的格子一致，回写是幂等的）
    const vol = Math.round(s.volume * 100);
    if (vol !== this.lastVol) {
      this.lastVol = vol;
      els.volSlider.value = String(vol);
      setVolumeSegments(els.volSegments, s.volume);
    }
  }

  /** 库内封面（专辑笔记 cover / 约定自动识别）：离线可用，不受图床可达性影响 */
  private localCover(s: PlayerSnapshot): string | undefined {
    const app = this.plugin?.app;
    if (!app) return undefined; // 极简测试依赖下没有 app：跳过库内封面
    return resolveAlbumCover(app, s.albumNotePath || undefined, {
      coverFolder: this.plugin.settings?.coverFolder,
    });
  }

  /** 显示候选链里第 i 个封面：加载失败（onerror）→ 下一个候选；耗尽 → 占位符 */
  private showCover(els: PlayerEls, i: number) {
    const src = this.coverChain[i];
    if (!src) {
      els.labelImg.onerror = null;
      els.labelImg.addClass('vinyl-hidden');
      els.labelEmpty.removeClass('vinyl-hidden');
      return;
    }
    els.labelImg.onerror = () => this.showCover(els, i + 1);
    els.labelImg.src = src;
    els.labelImg.removeClass('vinyl-hidden');
    els.labelEmpty.addClass('vinyl-hidden');
  }

  private rebuildQueue(els: PlayerEls, s: PlayerSnapshot) {
    // 「Vinyl order」是丝印品牌式的固定英文标签（与唱机键上的手写体字标同款）：中英同形，
    // 建 i18n 键会撞上「中英不得逐字相同」的词典测试，故保持硬编码。
    els.queueTitle.textContent = 'Vinyl order';
    // 段数变多 = 刚排入新专辑 → 记下来，画完闪一下（只在已经渲染过之后才比较）
    const grew = this.lastSegmentCount >= 0 && s.segments.length > this.lastSegmentCount;
    this.lastSegmentCount = s.segments.length;
    this.renderQueue(s, grew);
  }

  /** 按「专辑分段」画队列：一段 = 一张专辑（专辑名行 + 它的曲目行）。
   *  专辑名行 = 段头：写感想（每个专辑一个）/ 移除整段（只有一张时不给）/ 整段拖拽。
   *  设计稿：单专辑队列也画段头 —— 「写点什么吧」被搬到专辑名那一栏的最后，只有画出来才够得着。 */
  private renderQueue(s: PlayerSnapshot, flashLast = false) {
    const els = this.els;
    if (!els) return;
    const box = els.queueBox;
    box.empty();
    this.queueRows = [];
    this.queueBadges = [];
    this.queueIdxs = [];
    this.emptyQueueEl = null;
    this.segmentEls = [];
    this.segmentBtns = [];
    this.renderedQueue = s.queue;

    this.renderedSegmentCount = s.segments.length;
    if (!s.queue.length) {
      this.emptyQueueEl = box.createDiv({ text: t('player.emptyQueue'), cls: 'vinyl-muted' });
      this.applyQueueLabels();
      return;
    }
    // 打乱模式下列表已被混排：按「段」分组失去意义（同一张专辑碎成十几小段，每段挂一个重复标题
    // 只会误导），故只画平铺的行 + 一条「现在播的是哪张」的行（写感想按钮得有落脚处）
    if (s.playMode === 'shuffle') {
      const currentSeg = s.segments.find((x) => x.current);
      if (currentSeg) {
        const head = box.createDiv({ cls: 'vinyl-queue-segment-head is-solo' });
        head.createDiv({
          text: currentSeg.albumTitle || currentSeg.albumPath,
          cls: 'vinyl-queue-segment-title',
        });
        this.segmentBtns.push({ note: this.pushSegmentNote(head, currentSeg), remove: null, seg: currentSeg });
      }
    }
    const multi = s.segments.length > 1 && s.playMode !== 'shuffle';
    for (const seg of s.segments) {
      const segEl = box.createDiv({ cls: 'vinyl-queue-segment' });
      segEl.dataset.start = String(seg.start);
      if (seg.current) segEl.addClass('is-current');
      if (s.playMode !== 'shuffle') {
        const head = segEl.createDiv({ cls: 'vinyl-queue-segment-head' });
        head.createDiv({ text: seg.albumTitle || seg.albumPath, cls: 'vinyl-queue-segment-title' });
        // 写点什么吧：搬到专辑名那一栏的最后（每个专辑一个，只要列表里有它）
        const note = this.pushSegmentNote(head, seg);
        let removeBtn: HTMLButtonElement | null = null;
        if (multi) {
          removeBtn = head.createEl('button', { cls: 'clickable-icon vinyl-queue-segment-remove' });
          setIcon(removeBtn, 'x');
          removeBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.plugin.engine.removeRange(seg.start, seg.count);
          });
          this.bindSegmentDrag(head, seg);
        }
        this.segmentEls.push({ el: segEl, head, seg });
        this.segmentBtns.push({ note, remove: removeBtn, seg });
      }
      for (let i = seg.start; i < seg.start + seg.count; i++) {
        const track = s.queue[i];
        const row = segEl.createDiv({ cls: 'vinyl-queue-item' });
        row.dataset.idx = String(i);
        // 键盘可达：Tab 落到行上，Enter / 空格切歌，Alt+↑/↓ 调整顺序（拖拽的键盘等价）
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', track.title);
        this.bindQueueDrag(row, i);
        // 序号兼作拖拽把手：拖拽提示挂在它身上（行的 aria-label 留给曲名）
        this.queueIdxs.push(
          row.createSpan({
            text: String(i + 1).padStart(2, '0'),
            cls: 'vinyl-idx',
            attr: { 'aria-label': t('player.dragToReorder') },
          })
        );
        row.createSpan({ text: track.title, cls: 'vinyl-q-title' });
        const badge = row.createSpan({
          text: trackSourceLabel(track),
          cls: 'vinyl-badge ' + trackSourceClass(track),
        });
        row.createSpan({
          text: track.duration ? fmtTime(track.duration) : '–:–',
          cls: 'vinyl-muted',
        });
        this.queueRows.push(row);
        this.queueBadges.push(badge);
      }
      if (flashLast && seg === s.segments[s.segments.length - 1]) {
        segEl.addClass('is-just-added');
        window.setTimeout(() => segEl.removeClass('is-just-added'), 1200);
      }
    }
    this.applyQueueLabels(); // 行拖拽提示 / 来源角标统一在这里按当前语言写（切语言时由 applyLanguage 重放）
  }

  /** 段头末尾的「写点什么吧:)」小按键：给这一段那张专辑追加一条感想。
   *  只设 aria-label（Obsidian 按它渲染样式化提示，再设 title 会叠出两个气泡）；
   *  按钮在段头里 stopPropagation —— 段头可拖拽，点按钮不该被当成抓取。 */
  private pushSegmentNote(head: HTMLElement, seg: { albumPath: string; albumTitle: string }): HTMLElement {
    const btn = head.createEl('button', { cls: 'clickable-icon vinyl-queue-segment-note' });
    setIcon(btn, 'pencil');
    btn.setAttribute('aria-label', tf('player.noteAlbum', { name: seg.albumTitle || seg.albumPath }));
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this.plugin.appendListeningNote(seg.albumPath);
    });
    btn.addEventListener('pointerdown', (ev) => ev.stopPropagation()); // 别从按钮上起拖整段
    return btn;
  }

  /** 整段拖拽（跨专辑排序）：只认段头作落点，段内单曲拖拽仍走 bindQueueDrag */
  private bindSegmentDrag(head: HTMLElement, seg: { start: number; count: number }) {
    head.setAttribute('draggable', 'true');
    head.addEventListener('dragstart', (ev) => {
      this.dragging = true;
      this.dragSegment = { start: seg.start, count: seg.count };
      head.addClass('is-dragging');
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', String(seg.start));
      }
    });
    head.addEventListener('dragover', (ev) => {
      if (!this.dragSegment) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      const rect = head.getBoundingClientRect();
      this.setSegmentDropIndicator(head, ev.clientY > rect.top + rect.height / 2);
    });
    head.addEventListener('dragleave', (ev) => {
      if (!this.dragSegment) return;
      const to = ev.relatedTarget as Node | null;
      if (to && head.contains(to)) return;
      head.removeClass('is-drop-before', 'is-drop-after');
    });
    head.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const from = this.dragSegment;
      const rect = head.getBoundingClientRect();
      const after = ev.clientY > rect.top + rect.height / 2;
      this.endQueueDrag();
      if (!from) return;
      this.plugin.engine.moveRange(
        from.start,
        from.count,
        resolveSegmentDropIndex(from.start, from.count, seg.start, seg.count, after)
      );
    });
    head.addEventListener('dragend', () => this.endQueueDrag());
  }

  private setSegmentDropIndicator(target: HTMLElement, after: boolean) {
    for (const x of this.segmentEls) x.el.removeClass('is-drop-before', 'is-drop-after');
    target.addClass(after ? 'is-drop-after' : 'is-drop-before');
  }

  /** 队列模式开关的当前状态。
   *  update() 与主动改设置的路径都要调 —— 只在 update() 里写的话，刚点完开关会看到状态滞后。 */
  private syncQueueControls() {
    const els = this.els;
    if (!els) return;
    els.queueModeBtn.toggleClass('is-active', this.plugin.settings.queueMode);
  }

  /** 播放模式按钮：切到下一档并弹一条提示（模式名随「队列模式」讲专辑还是讲列表） */
  private cyclePlayMode() {
    const mode = this.plugin.engine.cyclePlayMode();
    this.plugin.settings.playMode = mode;
    void this.plugin.saveSettings();
    notice(t(modeLabelKey(mode, this.plugin.settings.queueMode)));
    this.applyQueueLabels();
  }

  /** 专辑队列模式开关：关掉时队列立即收敛到当前播放专辑。 */
  private toggleQueueMode() {
    const on = !this.plugin.settings.queueMode;
    this.plugin.settings.queueMode = on;
    if (!on) this.plugin.engine.retainCurrentAlbum();
    void this.plugin.saveSettings();
    notice(t(on ? 'player.queueModeOn' : 'player.queueModeOff'));
    this.syncQueueControls();
    this.applyQueueLabels();
  }

  // —— 队列行拖拽排序 ——
  // 行与行之间的落点用「行内上/下半 ⇒ 插到该行前/后」判定（与专辑墙卡片属性同款交互与落点类）。
  // 重排只调引擎的 moveTrack，队列重建由引擎的 emit 驱动（视图不自己动 DOM 顺序）。
  private bindQueueDrag(row: HTMLElement, index: number) {
    row.setAttribute('draggable', 'true');
    row.addEventListener('dragstart', (ev) => {
      this.dragging = true;
      this.dragFrom = index;
      row.addClass('is-dragging');
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', String(index)); // 不设 data 时部分环境不启动拖拽
      }
    });
    row.addEventListener('dragover', (ev) => {
      if (this.dragFrom < 0) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      this.setQueueDropIndicator(row, ev.clientY > rect.top + rect.height / 2);
    });
    row.addEventListener('dragleave', (ev) => {
      if (this.dragFrom < 0) return;
      // 只在真的离开这一行时清指示：行内子元素之间移动也会冒泡出 dragleave
      const to = ev.relatedTarget as Node | null;
      if (to && row.contains(to)) return;
      row.removeClass('is-drop-before', 'is-drop-after');
    });
    row.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const from = this.dragFrom;
      const rect = row.getBoundingClientRect();
      const after = ev.clientY > rect.top + rect.height / 2;
      this.endQueueDrag();
      if (from < 0) return;
      // 引擎按「结果下标」重排，并保证正在播的那首仍是当前曲
      this.plugin.engine.moveTrack(from, resolveQueueDropIndex(from, index, after));
    });
    row.addEventListener('dragend', () => this.endQueueDrag());
  }

  // 拖拽落点指示：清掉旧指示，标记当前行前/后插入位（复用专辑墙的属性行同款类）
  private setQueueDropIndicator(target: HTMLElement, after: boolean) {
    for (const row of this.queueRows) row.removeClass('is-drop-before', 'is-drop-after');
    target.addClass(after ? 'is-drop-after' : 'is-drop-before');
  }

  private endSegmentDrag() {
    for (const x of this.segmentEls) x.el.removeClass('is-drop-before', 'is-drop-after', 'is-dragging');
    this.dragSegment = null;
  }

  private clearQueueDropIndicators() {
    for (const row of this.queueRows) {
      row.removeClass('is-drop-before', 'is-drop-after', 'is-dragging');
    }
  }

  /** 拖拽尾巴上的 click 不是切歌意图 → 不响应（拖拽中 / 收尾 200ms 窗口双保险） */
  private isQueueClickBlocked(): boolean {
    return this.dragging || Date.now() < this.clickBlockUntil;
  }

  // 拖拽收尾：复位拖拽态并压制紧随其后的 click（拖完手一松的 click 不是切歌意图）
  private endQueueDrag() {
    if (this.dragging) this.clickBlockUntil = Date.now() + 200;
    this.resetQueueDrag();
  }

  private resetQueueDrag() {
    this.dragging = false;
    this.dragFrom = -1;
    this.clearQueueDropIndicators();
    this.endSegmentDrag();
  }

  // 落盘入场（交接 C 阶段）：唱片从左侧飞入转盘（用户要求）。
  // 三条硬约束：
  //   ① 动画只碰 transform —— 唱片的居中在 CSS 里用的是独立的 translate 属性（见 styles.css 的
  //      .vinyl-turntable-disc）。两者写在同一处的话，动画一开就把居中顶掉：唱片会从「左上角对齐
  //      圆心的位置」冒出来、结束时再跳回圆心（老版就是这么坏的）。
  //   ② 起手位置要整张在转盘盒外（> 100% 自身宽），否则会看见它凭空出现在盘面上；转盘盒
  //      overflow: hidden 负责裁掉外面那一段 —— 从盘边滑出来才是「飞入」。
  //   ③ 缓动分段：长距离段用接近匀速的强减速曲线（起手有速度、中段顺），末段自己收住，
  //      落地时只留一点点点回弹（scale 1.015 → 1 + 角度归零）。
  // 内层的唱片旋转（CSS 动画）与外层的这一段互不干扰：两个不同的元素。
  private playEntrance(els: PlayerEls) {
    els.discOuter.getAnimations().forEach((a) => a.cancel()); // 换碟比动画快：先掐掉上一段
    if (prefersReducedMotion()) return; // 减少动态效果：不播入场位移
    els.discOuter.animate(
      [
        {
          transform: 'translateX(-142%) rotate(-26deg) scale(0.9)',
          offset: 0,
          easing: 'cubic-bezier(0.25, 0.8, 0.3, 1)', // 起手有速度、一路减速
        },
        {
          transform: 'translateX(-12%) rotate(-2.2deg) scale(1.015)',
          offset: 0.68,
          easing: 'cubic-bezier(0.35, 0, 0.25, 1)', // 末段：减速落定
        },
        { transform: 'translateX(0) rotate(0deg) scale(1)', offset: 1 },
      ],
      { duration: 600, easing: 'linear' } // 分段缓动：每段由该段的 easing 说了算
    );
  }

  private resetTurntable(els: PlayerEls) {
    els.vinyl.classList.remove('is-spinning', 'is-paused');
    els.vinyl.classList.add('is-empty');
    // 唱臂归位到支架（显式写死：CSS 变量可能停在播放中的角度上）
    els.arm.style.setProperty('--vinyl-arm-angle', `${ARM_PARK_ANGLE.toFixed(2)}deg`);
    this.lastArmAngle = ARM_PARK_ANGLE;
    els.arm.addClass('is-parked');
    this.lastPosture = 'park';
  }
}
