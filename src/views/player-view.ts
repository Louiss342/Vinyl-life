// 播放器视图：页面 1 = 转盘播放器（自上而下：按键卡 / 翻转区 / Vinyl order 行 / 队列）。
//   卡① .vinyl-player-header 按键卡：「选取专辑」宽键（只留图标）占一半，队列模式 / 播放模式各占四分之一（2:1:1）；
//     没有标题行 —— 专辑名归 Vinyl order 行末尾（播放错误由引擎的 Notice 弹窗报出）；
//   翻转区 ②+③ .vinyl-flip：唱机卡 + 唱放条合并为「一张卡」（用户要求），整张左转 90°，
//     背面是唱片区（三行唱片架，见 album-picker）。
//     只有这一区翻面——按键卡、Vinyl order、队列都留在板上不动（用户要求「其他不要变」）。
//     唱机卡 .vinyl-deck（四套配色：胡桃木 / 雪域白 / 哑光黑 / 珊瑚红）：横向 1.3 : 1 转盘，唱片偏左、
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
import { ItemView, WorkspaceLeaf, requestUrl, setIcon } from 'obsidian';
import type VinylLifePlugin from '../main';
import type { PlayerSnapshot } from '../core/player-state';
import type { Track } from '../core/track';
import type { PlayMode } from '../core/player-state';
import { trackSourceLabel, trackSourceClass, trackKey, isLocalTrack, isTrialTrack } from '../core/track';
import {
  LyricLine,
  activeLineIndex,
  centerLineIndex,
  easeInOutCubic,
  lineDepth,
  lineProgress,
  scrollPlan,
} from '../core/lyrics';
import { fmtTime, notice, prefersReducedMotion } from '../util';
import { SPIN_SECONDS, SPIN_SPEEDS } from '../core/disc-motion';
import {
  MotorPhase,
  motorAdvance,
  motorDone,
  motorRate,
} from '../core/motor';
import {
  bindScratchGesture,
  approachRate,
  ScratchTracker,
  SCRATCH_PRELOAD_DELAY_MS,
  SCRATCH_SETTLE_EPS,
} from '../core/scratch';
import type { ScratchHit } from '../core/scratch';
import { ScratchDeck, probeMediaDuration } from '../core/scratch-deck';
import type { ScratchSource } from '../core/scratch-deck';
import { DECK_STYLES, RECORD_COLORS, deckClass, recordClass } from '../core/appearance';
import { coverChain } from '../core/cover-url';
import { resolveAlbumCover, findAlbumNotes, getAlbumInfo, detectAlbumSources } from '../core/album-index';
import type { AlbumInfo } from '../core/album-index';
import { ARM_PARK_ANGLE, albumProgress, armAngleForProgress, armPosture } from '../core/arm-geometry';
import { t, tf } from '../core/i18n';
import { AlbumPicker } from './album-picker';
import type { PickerEntry } from './album-picker';
// 整段移动的落点数学：拖拽（resolveSegmentDropIndex）与键盘（segmentMoveBy）共用一份，
// 免得两条路各写一套、落到不同位置（命令层也走这里）
import { resolveSegmentDropIndex, segmentMoveBy } from '../core/queue-move';

export const PLAYER_VIEW_TYPE = 'vinyl-player';

interface PlayerEls {
  /** 转盘盒（搓碟手势的宿主：唱臂裁剪层盖在盘面上，绑容器 + 几何判更稳） */
  turntable: HTMLElement;
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
  /** 载入 / 缓冲的状态位（唱放卡进度行上的一小行字）：只在等数据时露面 */
  bufferingEl: HTMLElement;
  /** 唱盘左下角的播放 / 暂停键（设计稿：长方形；页面 1 里唯一的播放键） */
  deckPlayBtn: HTMLButtonElement;
  volSlider: HTMLInputElement;
  volSegments: HTMLElement[];
  queueTitle: HTMLElement;
  queueBox: HTMLElement;
  /** 歌词键（顶部最左）：翻转区向左转过去的那一面 */
  lyricsBtn: HTMLButtonElement;
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

/** 停手后滑回正在唱的那一句的时长：太短像瞬移、太长像拖沓（参考实现多用 300~500ms） */
const LYRIC_RETURN_MS = 420;
/** 一次搓碟手势的进行态（抬手回正结束后置空） */
interface ScratchState {
  /** drag = 手指还按着；settle = 松手后的马达回正 */
  phase: 'drag' | 'settle';
  /** 起手前是否在播（抬手回到它；暂停起手的不回正） */
  playing: boolean;
  /** 起手时的曲目下标（抬手压回声用） */
  index: number;
  /** 起手时的曲目键：快照换了曲目就作废这次手势（别把位置写到新曲子上） */
  key: string;
  /** 声音是否由搓碟台出（false = 轻量音效：元素自己按倍速出声） */
  deck: boolean;
  /** 当前播放位置（秒）：完整音效以搓碟台的积分为准，轻量路由本视图积分 */
  pos: number;
  /** 唱片累计转角（deg，可正可负） */
  angle: number;
  /** 平滑后的倍速（松手回正从它出发） */
  rate: number;
  /** 上一帧时间（performance.now） */
  at: number;
  /** rAF 句柄 */
  raf: number;
}

/** 一段马达斜坡的进行态（暂停滑停 / 复播起转；收尾后置空，见 endSpin） */
interface SpinState {
  phase: MotorPhase;
  /** 这一段起点的转速（引擎给的） */
  from: number;
  /** 起点角度（接管那一刻的盘面角度） */
  base: number;
  /** 接管时刻（performance.now）：角度按「起点 + ∫rate(已走时长)」闭式算，不逐帧累加 */
  startedAt: number;
  /** 当前角度（deg）：每次写盘面时重算，收尾时交给 holdSpin / releaseSpin */
  angle: number;
  raf: number;
}

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
  /** 每行的「移除这首」钮（连曲名一起记着：切语言要按新语言重写 aria-label） */
  private queueRemoves: Array<{ btn: HTMLElement; title: string }> = [];
  /** 当前曲目在队列里的下标（定位 / 跟随播放用；-1 = 没在播） */
  private lastIndex = -1;
  /** 打开播放器时定位一次「正在播的那首」——之后由跟随逻辑接管（见 update 里的 locate 段） */
  private pendingLocate = false;
  /** Vinyl order 行的定位钮：把正在播的那首滚回视野（自己翻看队列翻远了之后的回程） */
  private locateBtn: HTMLButtonElement | null = null;
  // —— 歌词页（向左转的那一面）——
  private lyricsTitleEl: HTMLElement | null = null;
  /** 抬头第二行：`歌手 · 专辑` 合成一行（用户要求；缺哪个就只显示另一个） */
  private lyricsSubEl: HTMLElement | null = null;
  private lyricsScrollEl: HTMLElement | null = null;
  private lyricsLinesEl: HTMLElement | null = null;
  private lyricsEmptyEl: HTMLElement | null = null;
  /** 当前曲目的歌词（null = 还没有 / 这首歌没有）；与 lyricsLineEls 一一对应 */
  private lyrics: LyricLine[] | null = null;
  /** 上面那份歌词属于哪首（trackKey）：换歌就整块作废重画 */
  private lyricsForKey = '';
  /** 抬头三行的值签名：update 每 400ms 来一次，值不变就别写 DOM（切语言时清空强制重写） */
  private lyricsHeadSig = '';
  /** idle → 第一次翻到歌词页才去取；loading 在途中；ready 拿过结论了（含「确实没有」） */
  private lyricsState: 'idle' | 'loading' | 'ready' = 'idle';
  /** 当前曲目是不是本地音轨：空态文案要分流（本地多一句「放个同名 .lrc」的出路） */
  private lyricsLocal = false;
  /** 取歌词的代次：切歌后回来的旧结果一律丢弃（否则会把上一首的歌词画到这一首上） */
  private lyricsReq = 0;
  private lyricsLineEls: HTMLElement[] = [];
  /** 歌词行「切语言要重放」的标签动作。**与 labelEls 分开**：那张表是建壳时登记一次的
   *  （有界），歌词行却是每换一首歌整批重建的 —— 混在一起会随换歌无界增长，
   *  而且每个闭包都攥着一个已被摘除的节点。这里跟着行一起重建。 */
  private lyricsLabelEls: Array<() => void> = [];
  /** 每行中心相对滚动容器的像素位置：只在重建 / 改尺寸时量（每帧量会触发布局抖动） */
  private lyricsOffsets: number[] = [];
  /** 上一帧的视觉中心行（见 paintLyrics）。-2 = 还没画过：第一帧要把景深写一遍 */
  private lyricsFocus = -2;
  /** 上一帧「正在唱」的那一行（卡拉OK填充挂在它身上，与视觉中心是两回事） */
  private lyricsPlaying = -2;
  private lyricsFill = -1; // 上一帧写进 --vinyl-lyric-fill 的值（同值不写 DOM）
  private lyricsRaf = 0;
  /** 用户手动滚动 = 暂时不跟随；停手 4 秒后自己回来（见 pauseLyricsFollow） */
  private lyricsFollow = true;
  private lyricsResumeTimer: number | null = null;
  /** 翻面后搬焦点的定时器（同一时刻只留一个，见 moveFocusAcrossFlip） */
  private flipFocusTimer: number | null = null;
  /** 「刚加入队列」闪烁的定时器集合：行可能在闪完之前被重建，关闭时要能一并撤销 */
  private segmentFlashTimers = new Set<number>();
  /** 回位动画：从用户停下的位置平滑滑回正在唱的那一句（瞬移会把人晃一下）。
   *  from 是起点像素、start 是起始时刻；目标每帧现算（见 writeFollowTop）。 */
  private lyricsReturn: { from: number; start: number } | null = null;
  /** 我们上一次写进 scrollTop 的位置：事件发生时位置与它相同 = 那次是我们自己写的，不是用户在滚 */
  private lyricsWrittenTop = 0;
  /** 段头里的小按钮（写感想 / 移除整段）：切语言时按段就地重写 aria-label */
  private segmentBtns: Array<{ note: HTMLElement; remove: HTMLElement | null; seg: { albumTitle: string; albumPath: string } }> = [];
  /** 封面候选链的签名（链内容变化才换图；链见 core/cover-url.coverChain） */
  private currentCoverSig: string | null = null;
  private coverChain: string[] = [];
  private lastAlbumPath: string | null = null;
  private lastSpinning = false;
  /** 转盘旋转此刻归谁管（三种归属见 syncTurntable）：
   *  spin = 马达斜坡进行中（JS 逐帧按 core/motor 的曲线写角度）；
   *  heldAngle = 停在原地不转（暂停 / 出错：角度留在停下的那一刻，不摆正也不归零）；
   *  两者都是 null = 交给 CSS 动画（稳速播放 / 视图不可见时按住）。 */
  private spin: SpinState | null = null;
  private heldAngle: number | null = null;
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
  // 条件更新缓存（值不变不写 DOM：每写一次都要重新算样式，进度条每秒都来，攒起来不便宜）
  private lastRatio = -1;
  private lastTimeText = '';
  private lastVol = -1;
  /** 载入 / 缓冲状态位的当前取值（'' = 不显示）：只在这个值翻转时写 DOM */
  private lastWaitKind: 'loading' | 'buffering' | '' = '';
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
  private face: 'player' | 'picker' | 'lyrics' = 'player';
  /** 翻转区半深（px）：= 区宽 / 2，随尺寸变化重算（见 syncFlipDepth） */
  private flipRO: ResizeObserver | null = null;
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
  /** 搓碟台（完整音效）：第一次真的要准备缓冲时才建（省一个 AudioContext / 一份解码内存） */
  private scratchDeck: ScratchDeck | null = null;
  /** 想为哪一首备好搓碟缓冲（见 maybePrepareScratch / armScratchPreload） */
  private scratchWant: { key: string; track: Track } | null = null;
  /** 预载的挂表（见 armScratchPreload） */
  private scratchPreloadTimer: number | null = null;
  /** 上一次挂表时的曲目键与播放状态：只有它们变了才重挂 —— 每条快照都重挂的话，等待时间永远走不完 */
  private preloadKey = '';
  private preloadPlaying = false;
  /** 搓碟手势的进行态（null = 没在搓） */
  private scratch: ScratchState | null = null;
  /** 指针转角的累计器：事件写入、rAF 帧消费（两者的节奏不同，见 core/scratch） */
  private scratchTracker = new ScratchTracker();

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
    // 搓碟音效切到轻量 / 关掉搓碟：把解码缓冲与声卡上下文还回去（几十 MB 不该攥着）；
    // 再切回完整时由下一次快照重新挂预取（scratchWant 清空即触发重算）
    if (!this.plugin.settings.scratchEnabled || this.plugin.settings.scratchSound !== 'full') {
      this.disposeScratchDeck();
      this.scratchWant = null;
      this.disarmScratchPreload();
    } else if (this.els) {
      // 转速换了：动画一圈的时长跟着变，相位（负延迟）在新周期下已经对不上，清掉。
      // 相位只在「停住 / 滑停」时才有观感意义，而那两个状态的角度在 JS 手里（见 syncTurntable），
      // 下次交还时按新周期重写延迟 —— 转着的时候相位跳一下看不出来
      this.els.vinyl.style.removeProperty('animation-delay');
      // 从轻量切回完整 / 打开预载开关：按当前状态重新挂表（update 那边不会替我挂，键与状态都没变）
      if (this.lastSnapshot) this.armScratchPreload(this.lastSnapshot);
    }
  }

  async onOpen() {
    this.pendingLocate = true; // 打开就定位到正在播的那首（一次；之后由跟随逻辑接管）
    this.applyAppearance();
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
    this.stopLyricsLoop(); // 视图没了就别再逐帧跑（rAF 会一直排下去）
    if (this.lyricsResumeTimer) window.clearTimeout(this.lyricsResumeTimer);
    this.lyricsResumeTimer = null;
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    this.scratchAbort();
    this.spinCancel(); // 视图没了：马达斜坡的逐帧到此为止（引擎那边的声音自己走完）
    this.disarmScratchPreload();
    this.disposeScratchDeck();
    this.flipRO?.disconnect();
    this.flipRO = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    // 定时器收尾放在最后：搓碟那三件（作废手势 / 撤预载表 / 释放解码台）是关门时最要紧的，
    // 排在最前便于一眼核对（用例也按这个顺序盯着，见 scripts/scratch-view.test.cjs）
    if (this.flipFocusTimer) window.clearTimeout(this.flipFocusTimer);
    this.flipFocusTimer = null;
    for (const timer of this.segmentFlashTimers) window.clearTimeout(timer);
    this.segmentFlashTimers.clear();
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
    if (this.face === 'lyrics') {
      // 翻转区尺寸变了：行位置与上下留白都要重量（滚动计划靠这些像素）
      this.measureLyrics();
      this.syncLyricsScroll();
    }
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
    // 歌词行不随语言重建 DOM（重建会把滚动位置和逐帧状态一起丢掉），所以它们的标签动作
    // 各自登记、这里补一次重放
    for (const apply of this.lyricsLabelEls) apply();
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
    // 每行的移除钮：带曲名（「从队列移除《X》」），切语言时按新语言重写
    for (const { btn, title } of this.queueRemoves) {
      btn.setAttribute('aria-label', tf('player.queueRemoveTrack', { name: title }));
    }
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

    // 卡①：顶部四枚键（设计稿 1 : 1 : 1 : 1 —— 用户把原来的宽键一分为二：歌词 / 选取专辑）。
    // 两张「翻面键」分居两侧：歌词向左转、选取专辑向右转，转过去的是同一块翻转区（见 flipTo）。
    const header = board.createDiv({ cls: 'vinyl-player-header' });
    // 歌词（左转）：与右边的选取专辑成对，都是「把翻转区转过去」的开关
    const lyricsBtn = header.createEl('button', { cls: 'vinyl-btn-mode vinyl-open-lyrics' });
    setIcon(lyricsBtn, 'mic-vocal');
    this.bindLabel(() => {
      lyricsBtn.setAttribute('aria-label', t('player.lyrics'));
    });
    lyricsBtn.addEventListener('click', () => this.flipTo(this.face === 'lyrics' ? 'player' : 'lyrics'));
    // 选取专辑（右转）：翻转区的开关（只留图标 —— 用户不要文字；再点一下转回唱机卡）
    const pickBtn = header.createEl('button', { cls: 'vinyl-btn-mode vinyl-pick-album' });
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
    // 歌词面（向左转的那一面）：与唱片区同一套「绝对定位填满 + 反向缩放」，见 styles.css
    const lyricsFace = flipInner.createDiv({ cls: 'vinyl-flip-face is-lyrics' });
    this.buildLyricsFace(lyricsFace);

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
    // 载入 / 缓冲：换曲取址与「元素在等字节」是两段不同的等待，都在这枚状态位上报出来。
    // role=status：读屏也要能知道「在等」而不是「死了」——它是这一行里唯一的异步状态。
    const bufferingEl = progress.createSpan({ cls: 'vinyl-buffering', attr: { role: 'status' } });
    // 切语言：状态位上的文案也得跟着换。写文本归 update（它按 lastWaitKind 判重），
    // 这里只把那份缓存作废，下一次 update 就会用新语言重写一遍 —— 与抬头三行同一套做法。
    this.bindLabel(() => {
      this.lastWaitKind = '';
    });
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

    // Vinyl order 行：左边标题，右边两个图标钮（保存队列 / 定位到正在播的那首）。
    // 专辑名不在这儿（用户 2026-09-25 定稿）：一行的宽度留给按钮，标题也不再被挤到换行 ——
    // 当前是哪张专辑，队列里每个专辑的段头写着（见 renderQueue）。
    // 清空队列 / 恢复发行顺序两个按键及其功能已按设计稿删除；「写点什么吧」移到每个专辑名行里。
    const orderRow = board.createDiv({ cls: 'vinyl-order-row' });
    const queueTitle = orderRow.createDiv({ cls: 'vinyl-queue-title' });
    const saveQueue = orderRow.createEl('button', { cls: 'clickable-icon vinyl-queue-save' });
    setIcon(saveQueue, 'save');
    this.bindLabel(() => saveQueue.setAttribute('aria-label', t('queueNote.save')));
    saveQueue.addEventListener('click', () => void this.plugin.saveQueueNote());
    // 载入：此前只有命令面板入口（保存有按钮、载入没有 —— 审计点名的半成品）。
    // 两者是同一条闭环的两端，摆在一起才不会让人以为「存了就回不来」
    const loadQueue = orderRow.createEl('button', { cls: 'clickable-icon vinyl-queue-load' });
    setIcon(loadQueue, 'folder-open');
    this.bindLabel(() => loadQueue.setAttribute('aria-label', t('queueNote.load')));
    loadQueue.addEventListener('click', () => void this.plugin.loadQueueFromActiveNote());
    // 定位到正在播的那首：队列长了之后把它滚回视野。跟随播放只在「原本还看得见」时进行，
    // 所以自己翻远之后要有这条回程（见 update 里的 locate 段）。
    const locateBtn = orderRow.createEl('button', { cls: 'clickable-icon vinyl-queue-locate' });
    setIcon(locateBtn, 'locate-fixed');
    this.locateBtn = locateBtn;
    this.bindLabel(() => locateBtn.setAttribute('aria-label', t('player.locateCurrent')));
    locateBtn.addEventListener('click', () => this.locateCurrentRow());

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
        // 别漏给全局快捷键：用户若把 Enter / 空格绑到了别的命令上，会在这里双触发
        ev.stopPropagation();
        void this.plugin.engine.playIndex(idx);
        return;
      }
      if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
        ev.preventDefault();
        ev.stopPropagation();
        const to = ev.key === 'ArrowUp' ? idx - 1 : idx + 1;
        if (to < 0 || to >= this.queueRows.length) return;
        this.plugin.engine.moveTrack(idx, to);
        window.setTimeout(() => this.queueRows[to]?.focus(), 0);
        return;
      }
      // Delete / Backspace = 移除这一行（移除钮的键盘等价）。行没了，焦点挪到同位置那一行上 ——
      // 否则焦点掉回 body，连删几首就得每次重新 Tab 进来。
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        ev.preventDefault();
        this.plugin.engine.removeRange(idx, 1);
        window.setTimeout(() => {
          const i = Math.min(idx, this.queueRows.length - 1);
          this.queueRows[i]?.focus();
        }, 0);
      }
    });

    // 搓碟：在转盘上按下并拖动 = 手搓唱片。挂在容器上按几何判（唱臂裁剪层 inset:0 盖着盘面，
    // 直接绑盘面层会被它挡住），按下点落在唱片圆外或左下播放键上都不接手。
    bindScratchGesture(turntable, {
      geometry: () => this.scratchGeometry(),
      accept: (ev) => this.canScratch() && !this.isDeckButton(ev),
      onEngage: () => this.scratchEngage(),
      onTurn: (turn) => this.scratchTracker.add(turn),
      onEnd: () => this.scratchRelease(),
    });

    this.els = {
      turntable,
      flip,
      flipInner,
      lyricsBtn,
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
      bufferingEl,
      deckPlayBtn,
      volSlider,
      volSegments,
      queueTitle,
      queueBox,
    };
    // 唱片区先只留个空面：懒建（第一次翻过去才扫专辑，打开播放器不必为它扫全库）
    this.pickerFace = crateFace;
    this.syncFlipDepth();
    return this.els;
  }

  // ============ 立方体两面（页面 1 / 页面 2）============

  /** 翻转区翻面：左转 = rotateY(-90deg)（只有②③卡片这一区转，两面跟着转；减小动效时直接到位） */
  private flipTo(face: 'player' | 'picker' | 'lyrics') {
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
    els.flip.toggleClass('is-lyrics', face === 'lyrics');
    els.flip.toggleClass('is-reduced', prefersReducedMotion());
    els.pickBtn.toggleClass('is-active', face === 'picker');
    els.lyricsBtn.toggleClass('is-active', face === 'lyrics');
    // 焦点跟着翻面走：翻过去之后，原来那些元素在背面（还在 DOM 里，但看不见）——
    // 焦点留在那里时 Enter 会对一个看不见的东西生效，读屏也还在读旧的一面。
    // 只在「焦点确实落在翻转区里」时搬，免得把用户点按钮后留在按钮上的焦点抢走。
    this.moveFocusAcrossFlip(face);
    // 歌词面：翻过去才量行位置（那一面翻上来之前 clientHeight 是 0，量出来全是 0）；
    // 没在播时循环不跑，翻过去也要摆一次位置（停在当前那句上）
    if (face === 'lyrics') {
      this.measureLyrics();
      this.syncLyricsState(this.lastSnapshot);
      this.syncLyricsScroll();
    }
    // 预载只服务唱机面：翻走了就撤表（翻回来重挂，等待时间从这一刻算起）
    if (face === 'player' && this.lastSnapshot) this.armScratchPreload(this.lastSnapshot);
    else this.disarmScratchPreload();
    // 盘面转到背面去了：抓取光标跟着收掉（唱片区没有唱片可搓）
    els.turntable.toggleClass('is-scratchable', this.canScratch());
  }

  /** 翻面时把焦点搬到新那一面的第一个可操作元素上（见 flipTo 的调用点）。
   *  搬完要等一轮：唱片区是翻过去那一刻才建的，背面的行位置也要等布局落定。 */
  private moveFocusAcrossFlip(face: 'player' | 'picker' | 'lyrics'): void {
    const els = this.els;
    if (!els) return;
    // 独立窗口 / 弹窗里的 ownerDocument 才是对的那一份（同 syncVisibility 的口径）；
    // 极简依赖的测试里没有 containerEl，回落到全局 document
    const doc = this.containerEl?.ownerDocument ?? document;
    const active = doc.activeElement;
    if (!active || !els.flip.contains(active)) return; // 焦点本来就在别处（顶部按键 / 队列）：不动
    // 上一次搬家还没落地就再翻一次：撤掉旧的（否则两个定时器抢焦点，落到哪一面看运气）
    if (this.flipFocusTimer) window.clearTimeout(this.flipFocusTimer);
    this.flipFocusTimer = window.setTimeout(() => {
      this.flipFocusTimer = null;
      const target =
        face === 'picker'
          ? this.pickerFace?.querySelector<HTMLElement>('.vinyl-pick') ?? null
          : face === 'lyrics'
            ? this.lyricsLineEls[0] ?? null
            : els.deckPlayBtn;
      // 还在同一面才搬（这一轮里用户可能又翻回去了）
      if (target && this.face === face) target.focus();
    }, 0);
  }

  /** 键盘：在唱片区 / 歌词页按 Esc 回播放器（焦点不在唱片箱里时也管用 —— 箱内由唱片区自己处理并阻止冒泡）。 */
  private onEscape(ev: KeyboardEvent) {
    if (ev.key !== 'Escape' || this.face === 'player') return;
    ev.preventDefault();
    if (this.face === 'picker' && this.picker?.hasSelection()) {
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
        return { album, local: src.local, netease: src.netease, qq: src.qq, kugou: src.kugou };
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
    if (!src.local && !src.netease && !src.qq && !src.kugou) {
      const leaf = this.plugin.app.workspace.getLeaf(false);
      await leaf.openFile(album.file);
      notice(t('card.noSource'));
      return;
    }
    // 已经是这张（且队列还在）→ 只翻回去，不重新取碟；暂停中则接着放（与专辑墙点卡片同一口径）
    if (this.lastSnapshot?.albumNotePath === album.path && this.lastSnapshot.queue.length) {
      if (this.lastSnapshot.status === 'paused') void this.plugin.engine.play();
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
    // 歌词页（可能没翻到那一面）：抬头三行、换歌作废、循环开关都从这里收口
    this.syncLyricsState(s);

    // 手势期间的意外换曲（媒体键 / 清空队列 / 移除整段）：这次手势作废，
    // 别把位置写到新曲目上（引擎那边已经自行收掉了搓碟会话）。
    // 判据是曲目键而不是下标：拖动重排只换位置不换曲子，那种情况不该把手里这张碟打断。
    if (this.scratch && (!s.current || trackKey(s.current) !== this.scratch.key)) this.scratchAbort();

    // 搓碟缓冲的挂点：曲目变了就换一份惦记（真正取字节的时机见 maybePrepareScratch / armScratchPreload）
    const scratchKey = s.current ? trackKey(s.current) : '';
    if (scratchKey !== (this.scratchWant?.key ?? '')) {
      // 旧的惦记直接换掉：在途的准备不用打断 —— 搓碟台按曲目键缓存，回来的那份照样有用
      // （下一首提前备的那份尤其如此：切歌之后它往往正是要放的那首）
      this.scratchWant = s.current ? { key: scratchKey, track: s.current } : null;
    }
    // 预载的表：曲目变了 / 播放状态翻了才重挂（其余快照不动它 —— 见 preloadKey）
    const playing = s.status === 'playing';
    if (scratchKey !== this.preloadKey || playing !== this.preloadPlaying) {
      this.preloadKey = scratchKey;
      this.preloadPlaying = playing;
      this.armScratchPreload(s);
    }
    this.maybePrepareScratch(s);
    // 盘面可搓时才给抓取光标（唱臂裁剪层已让开指针事件，见 styles.css）
    els.turntable.toggleClass('is-scratchable', this.canScratch());

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
    const queueRebuilt = s.queue !== this.renderedQueue;
    if (queueRebuilt) this.rebuildQueue(els, s);
    // 队列模式开关的当前状态（设置改了、切了开关都要跟着走）
    this.syncQueueControls();
    // 播放模式按钮：图标随模式变，非默认（单次）时给个高亮色
    if (s.playMode !== this.lastPlayMode) {
      this.lastPlayMode = s.playMode;
      setIcon(els.playModeBtn, PLAY_MODE_ICON[s.playMode]);
      els.playModeBtn.toggleClass('is-active', s.playMode !== 'once');
    }
    // 正在播的那一行：既给视觉（is-current），也给读屏（aria-current）——
    // 只有类名的话，读屏用户翻队列时不知道现在放到哪儿了。
    // 只写变化的那两行：快照每 400ms 一次，几百行的队列全量 toggle 纯属白干；
    // 队列刚重建过则必须补写（新行上没有这个类）。
    const indexChanged = s.index !== this.lastIndex;
    if (indexChanged || queueRebuilt) {
      if (indexChanged && !queueRebuilt) {
        const prevRow = this.queueRows[this.lastIndex];
        prevRow?.classList.remove('is-current');
        prevRow?.setAttribute('aria-current', 'false');
      }
      const row = this.queueRows[s.index];
      row?.classList.add('is-current');
      row?.setAttribute('aria-current', 'true');
      this.lastIndex = s.index;
    }

    // 定位正在播的那首：打开时定位一次；之后跟随播放走，但只在「上一条还看得见」时才跟 ——
    // 自己往上翻看队列了就别把人拽回来（翻远了点 Vinyl order 上的定位钮回来）。
    // 「看得见吗」要量两个元素的矩形（强制回流）：只在真的换了曲目时才问
    const wasVisible = indexChanged ? this.currentRowVisible() : false;
    if (this.locateBtn) this.locateBtn.disabled = s.index < 0;
    if (s.index >= 0 && (this.pendingLocate || (indexChanged && wasVisible))) {
      this.pendingLocate = false;
      this.locateCurrentRow();
    }

    // 转盘状态（旋转动画只切 class，不重建节点）：三种归属都在 syncTurntable 里切换
    this.syncTurntable(s);
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
    // 手搓期间位置归手势：快照（400ms 一条、且比手指慢一截）不许回写轨道与读数
    const seekOwned = this.seeking || this.seekHold !== null || this.scratch !== null;
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

    // 载入 / 缓冲状态位。两段等待是两件事：loading = 换曲后正在取址（还没有可播的 src），
    // buffering = 已经有 src 但元素在等字节。文本只在状态翻转时写 —— update 每 400ms 一条，
    // 反复写同一个字符串会让读屏把这句话一遍遍重播。
    const waitKind: 'loading' | 'buffering' | '' =
      s.status === 'loading' ? 'loading' : s.buffering ? 'buffering' : '';
    if (waitKind !== this.lastWaitKind) {
      this.lastWaitKind = waitKind;
      els.bufferingEl.textContent =
        waitKind === 'loading' ? t('player.loading') : waitKind === 'buffering' ? t('player.buffering') : '';
      els.bufferingEl.toggleClass('is-on', waitKind !== '');
    }

    // 唱臂姿态（设计稿）：未播放专辑 / 暂停 = 姿态 1（归位支架）；
    // 播放专辑 = 姿态 2（落针），且唱针到唱片圆心的「距离」= 专辑进度（换算见 core/arm-geometry）。
    // loading（换曲取址的间隙）保持落针，避免唱臂在换曲时来回摆。
    // 搓碟期间整块让给手势：手在盘上时唱针就还在槽里（起手即落针，角度由 scratchPreview 逐帧写）
    if (this.scratch === null) {
      const posture = armPosture(s.status, s.queue.length);
      if (posture !== this.lastPosture) {
        this.lastPosture = posture;
        els.arm.toggleClass('is-parked', posture === 'park');
      }
      this.writeArm(posture === 'park' ? ARM_PARK_ANGLE : this.armAngleFor(s, s.currentTime));
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

  /** 正在播的那一行此刻在不在队列的视野里（跟随播放的判据：切歌前还看得见才跟） */
  private currentRowVisible(): boolean {
    const row = this.queueRows[this.lastIndex];
    const box = this.els?.queueBox;
    if (!row || !box) return true; // 判不了就当可见：保持旧行为（跟随）
    const r = row.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return r.bottom > b.top && r.top < b.bottom;
  }

  /** 把正在播的那首滚进视野：block:'nearest' —— 已经在视野里就一点都不动
   *  （不打断正在看队列的人）；减少动效时不做平滑滚动。 */
  private locateCurrentRow(): void {
    const row = this.queueRows[this.lastIndex];
    if (!row) return;
    row.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  // ============ 歌词页（向左转的那一面）============
  // 版式：抬头两行（曲名 / 歌手 · 专辑）+ 剩下全部给歌词滚动区。
  // 滚动是**连续**的（用户按参考效果定的）：位置由 core/lyrics 的 scrollPlan 按时间轴给出 ——
  // 两行之间的全部时间都在从「当前行居中」走向「下一行居中」，没有静止期。这里只负责把计划
  // 变成像素：量一次每行的 offsetTop（改尺寸才重量），每帧插值写 scrollTop。
  // 景深：每行按离当前行的距离渐淡 + 略小（--vinyl-lyric-d，换行时写一次）。
  // 参考的几家做法：聚焦行放大提亮 + 容器上下渐隐（Apple Music）、行内卡拉OK式填充
  // （逐字做不到：网易云 / QQ 给的是行级 LRC，没有字级时间戳）、手动滚动接管 + 停手后跟回。

  private buildLyricsFace(host: HTMLElement) {
    const head = host.createDiv({ cls: 'vinyl-lyrics-head' });
    this.lyricsTitleEl = head.createDiv({ cls: 'vinyl-lyrics-title' });
    this.lyricsSubEl = head.createDiv({ cls: 'vinyl-lyrics-sub' });
    const scroll = host.createDiv({ cls: 'vinyl-lyrics-scroll' });
    this.lyricsScrollEl = scroll;
    this.lyricsLinesEl = scroll.createDiv({ cls: 'vinyl-lyrics-lines' });
    this.lyricsEmptyEl = scroll.createDiv({ cls: 'vinyl-lyrics-empty' });
    this.bindLabel(() => {
      this.lyricsHeadSig = ''; // 切语言：抬头三行要按新语言重写（签名拦着的话会留着旧语言）
      this.writeLyricsHead(this.lastSnapshot);
      this.syncLyricsEmpty();
    });
    // 手动滚动 = 先别跟着走（否则刚翻上去就被拽回来）；点某一行 = 跳到那句并恢复跟随
    scroll.addEventListener('wheel', () => this.pauseLyricsFollow(), { passive: true });
    scroll.addEventListener('pointerdown', () => this.pauseLyricsFollow());
    scroll.addEventListener(
      'scroll',
      () => {
        // 我们自己写 scrollTop 引发的事件不算用户意图（不然一直在「暂停跟随」）。
        // 连续滚动下我们每帧都在写，所以不能按时间设护栏（护栏永远是新刷的，会把用户滚动一起吞掉）——
        // 改比值：事件发生时的位置就是我们上次写下的那个，才说明这次是我们自己写的。
        if (Math.abs(scroll.scrollTop - this.lyricsWrittenTop) < 1) return;
        this.pauseLyricsFollow();
        // 暂停时不再逐帧跑：这里补一帧，视觉中心才能跟着手走（暂停中滚动也会亮到对应的那一句）
        this.syncLyricsScroll();
      },
      { passive: true }
    );
  }

  /** 抬头两行永远跟着当前曲目走（有没有歌词都要显示「现在在放什么」）。
   *  第二行 = `歌手 · 专辑`：两段都是可缺的（本地曲目常常没有艺人，线上曲目偶尔没有专辑名），
   *  空的那段连分隔符一起省掉 —— 只剩一段时不出现孤零零的「·」。 */
  private writeLyricsHead(s: PlayerSnapshot | null) {
    const track = s?.current;
    const album = track?.album || s?.albumTitle || '';
    const artist = track?.artist || '';
    // 值不变不写 DOM：update 每 400ms 来一次，抬头两行大部分时候是同一个值
    // （与旧版「Vinyl order 行末尾的专辑名」同一个口径）
    // 用 JSON 而不是拼接：标题里有分隔符也不会串味
    const sig = JSON.stringify([track?.title ?? '', artist, album]);
    if (sig === this.lyricsHeadSig) return;
    this.lyricsHeadSig = sig;
    const headTitle = track?.title || t('lyrics.idle');
    const headSub = [artist, album].filter(Boolean).join(' · ');
    this.lyricsTitleEl?.setText(headTitle);
    this.lyricsSubEl?.setText(headSub);
  }

  /** 换歌就整块作废重来；人在歌词页且还没取过 → 去取。暂停 / 翻走停循环，暂停时也摆一次位置。 */
  private syncLyricsState(s: PlayerSnapshot | null) {
    const track = s?.current ?? null;
    const key = track ? trackKey(track) : '';
    // 本地音轨的空态多一句出路（旁挂 .lrc）：文案按它分流，见 syncLyricsEmpty
    this.lyricsLocal = !!track && isLocalTrack(track);
    if (key !== this.lyricsForKey) {
      this.lyricsForKey = key;
      this.lyrics = null;
      this.lyricsState = 'idle';
      this.lyricsFocus = -2; // 还没画过：换歌后第一帧要把景深重写一遍
      this.lyricsPlaying = -2;
      this.lyricsFill = -1;
      this.lyricsFollow = true; // 换歌：跟上
      this.renderLyricsLines();
    }
    this.writeLyricsHead(s);
    if (this.face === 'lyrics' && track && this.lyricsState === 'idle') {
      void this.loadLyricsFor(track, key);
    }
    this.syncLyricsEmpty();
    // 回位动画也要帧：暂停时用户滚走再停手，那一段平滑回位同样得有人逐帧推
    //（不然它停在半路，而且 lyricsReturn 不清空 → 视觉中心会一直跟着手走）
    const returning = this.lyricsReturn !== null;
    if (this.face === 'lyrics' && this.lyrics?.length && (s?.status === 'playing' || returning)) {
      this.startLyricsLoop();
    } else {
      this.stopLyricsLoop();
      if (this.face === 'lyrics') this.syncLyricsScroll(); // 暂停 / 拖进度条后也要摆到正确那句
    }
  }

  private async loadLyricsFor(track: Track, key: string) {
    this.lyricsState = 'loading';
    this.syncLyricsEmpty();
    const gen = ++this.lyricsReq;
    // 极简依赖的测试里没有 loadLyrics：拿不到就当「没有歌词」
    const lines = (await this.plugin.loadLyrics?.(track)) ?? null;
    if (gen !== this.lyricsReq || this.lyricsForKey !== key) return; // 期间切歌了：这份作废
    this.lyrics = lines;
    this.lyricsState = 'ready';
    this.renderLyricsLines();
    this.measureLyrics();
    this.syncLyricsEmpty();
    this.syncLyricsScroll();
  }

  private renderLyricsLines() {
    const host = this.lyricsLinesEl;
    if (!host) return;
    host.empty();
    this.lyricsLineEls = [];
    this.lyricsLabelEls = []; // 行没了，逐行的标签动作也一起作废（否则每次重建都往表里堆一批）
    this.lyricsOffsets = [];
    this.lyricsFocus = -2; // 还没画过：重建行之后第一帧要把景深重写一遍
    this.lyricsPlaying = -2;
    this.lyricsFill = -1;
    const lines = this.lyrics ?? [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const el = host.createDiv({ cls: 'vinyl-lyric-line' });
      if (!line.text) el.addClass('is-interlude'); // 间奏：一行音符，不做填充
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      this.bindLyricLineLabel(el, line);
      el.createDiv({ cls: 'vinyl-lyric-text', text: line.text || '♪' });
      if (line.trans) el.createDiv({ cls: 'vinyl-lyric-trans', text: line.trans });
      el.addEventListener('click', () => this.seekToLyric(i));
      el.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault(); // 空格别把面板滚走
        this.seekToLyric(i);
      });
      this.lyricsLineEls.push(el);
    }
  }

  /** 行的可读名称：切语言时也要跟着换（与队列行同一套做法）。
   *  登记进 lyricsLabelEls 而不是 labelEls —— 后者是建壳那张一次性的表，见该字段的注释。 */
  private bindLyricLineLabel(el: HTMLElement, line: LyricLine) {
    const apply = () =>
      el.setAttribute('aria-label', tf('lyrics.seekLine', { text: line.text || t('lyrics.interlude') }));
    this.lyricsLabelEls.push(apply);
    apply();
  }

  /** 量一次行位置 + 上下留白。上下各留半个容器高：第一行与最后一行也能滚到正中。
   *  只在重建 / 改尺寸时量 —— 每帧量 offsetTop 会强制布局，滚动就不丝滑了。 */
  private measureLyrics() {
    const scroll = this.lyricsScrollEl;
    if (!scroll || !this.lyricsLineEls.length) return;
    const pad = Math.max(16, Math.round(scroll.clientHeight / 2 - 20));
    scroll.style.setProperty('--vinyl-lyric-pad', `${pad}px`);
    // 读 offsetTop 会强制布局：上面刚改完留白，这里量到的就是改完之后的位置
    this.lyricsOffsets = this.lyricsLineEls.map((el) => el.offsetTop + el.offsetHeight / 2);
  }

  /** 一帧：两套参考系各画各的（换行了才改类与档位，填充每帧只写一个变量）——
   *   · is-playing（**时间**说了算）：正在被唱的那一句，卡拉OK填充挂在它身上 ——
   *     用户翻到别的段落时，也能一眼找回播放到哪了；
   *   · is-active / 景深（**位置**说了算）：视觉中心那一句。自动跟随时就是正在唱的那句，
   *     用户自己滚了之后是画面正中那一句 —— 滚到哪，哪一句亮。 */
  private paintLyrics(playing: number, focus: number, ms: number) {
    const playingMoved = playing !== this.lyricsPlaying;
    const focusMoved = focus !== this.lyricsFocus;
    if (playingMoved) {
      this.lyricsLineEls[this.lyricsPlaying]?.removeClass('is-playing');
      this.lyricsLineEls[playing]?.addClass('is-playing');
      this.lyricsPlaying = playing;
      this.lyricsFill = -1; // 换行：填充重新算
    }
    if (focusMoved) {
      this.lyricsLineEls[this.lyricsFocus]?.removeClass('is-active');
      this.lyricsLineEls[focus]?.addClass('is-active');
      this.lyricsFocus = focus;
    }
    // 逐行刷（都是行号之差、帧间不变，所以只在换了行 / 换了中心时才写一次）：
    //   is-past：唱过的压暗一档 —— 按**时间**算，用户翻去别的段落时歌还在走，也要跟着刷
    //   --vinyl-lyric-d：离视觉中心多远 —— 按**位置**算，CSS 拿它算渐淡 / 略小（见 core/lyrics 的 lineDepth）
    if (playingMoved || focusMoved) {
      for (let i = 0; i < this.lyricsLineEls.length; i++) {
        this.lyricsLineEls[i].toggleClass('is-past', i < playing);
        if (focusMoved) this.lyricsLineEls[i].style.setProperty('--vinyl-lyric-d', String(lineDepth(i, focus)));
      }
    }
    const el = this.lyricsLineEls[playing];
    if (!el) return;
    const p = Math.round(lineProgress(this.lyrics ?? [], playing, ms) * 1000) / 1000;
    if (p !== this.lyricsFill) {
      this.lyricsFill = p;
      el.style.setProperty('--vinyl-lyric-fill', String(p));
    }
  }

  /** 一帧：把滚动计划（从哪一行 → 哪一行、进度）变成滚动像素；高亮与景深按视觉中心画 */
  private syncLyricsScroll() {
    const lines = this.lyrics;
    const scroll = this.lyricsScrollEl;
    if (!lines?.length || !scroll || !this.lyricsLineEls.length) return;
    const ms = this.lyricsTimeMs();
    const playing = activeLineIndex(lines, ms);
    if (this.lyricsFollow) {
      const plan = scrollPlan(lines, ms);
      const from = this.lyricsOffsets[plan.from] ?? 0;
      const to = this.lyricsOffsets[plan.to] ?? from;
      // 先夹到合法范围再比：列表头尾那几行算出来的目标是负的 / 超出的，不夹的话
      // 每一帧都在「写 0 → 读回 0 → 再写 0」（白写一次 scrollTop，还多发一个 scroll 事件）
      const target = Math.max(0, from + (to - from) * plan.progress - scroll.clientHeight / 2);
      this.writeFollowTop(target);
    }
    // 视觉中心在**写完位置之后**才定：这一帧真正停在哪，就以哪为中心。
    // （顺序反了的话，回位收尾那一帧会按上一帧的旧位置算中心，高亮闪一下。）
    const center = centerLineIndex(this.lyricsOffsets, scroll.scrollTop, scroll.clientHeight);
    const browsing = !this.lyricsFollow || this.lyricsReturn !== null;
    const focus = browsing && center >= 0 ? center : playing;
    this.paintLyrics(playing, focus, ms);
  }

  /** 跟随位置：平时直接写；回位期间按缓动从「用户停下的地方」滑回正在唱的那一句。
   *  目标每帧现算是为了接得上连续滚动 —— 缓动只是把起点拉回来，直到走完这一段。 */
  private writeFollowTop(target: number) {
    const scroll = this.lyricsScrollEl;
    if (!scroll) return;
    const ret = this.lyricsReturn;
    if (!ret) {
      if (Math.abs(target - scroll.scrollTop) > 0.5) this.setLyricsScrollTop(target);
      return;
    }
    const p = (Date.now() - ret.start) / LYRIC_RETURN_MS;
    this.setLyricsScrollTop(ret.from + (target - ret.from) * easeInOutCubic(p));
    if (p >= 1) this.lyricsReturn = null; // 到位：之后交回普通的跟随写入
  }

  private startLyricsLoop() {
    if (this.lyricsRaf) return;
    const tick = () => {
      this.lyricsRaf = window.requestAnimationFrame(tick);
      this.syncLyricsScroll();
    };
    this.lyricsRaf = window.requestAnimationFrame(tick);
  }

  private stopLyricsLoop() {
    if (this.lyricsRaf) window.cancelAnimationFrame(this.lyricsRaf);
    this.lyricsRaf = 0;
  }

  /** 播放位置（毫秒）：优先问引擎要实时读数 —— 快照是 400ms 节流过的，撑不起逐帧滚动。
   *  引擎缺失（极简依赖的测试）退回最近一次快照。 */
  private lyricsTimeMs(): number {
    const live = this.plugin.engine?.liveSeconds?.();
    const sec =
      typeof live === 'number' && Number.isFinite(live) ? live : this.lastSnapshot?.currentTime ?? 0;
    return sec * 1000;
  }

  private setLyricsScrollTop(y: number) {
    const el = this.lyricsScrollEl;
    if (!el) return;
    const next = Math.max(0, y);
    // 记下写进去的位置：这次引发的 scroll 事件不算用户手动滚动（见 buildLyricsFace 的 scroll 监听）
    this.lyricsWrittenTop = next;
    el.scrollTop = next;
  }

  /** 用户手动滚了：视觉中心交给滚动位置（滚到哪哪句亮），自动跟随先停；
   *  停手 4 秒后平滑滑回正在唱的那一句（跟丢最烦人，但正在看的时候也不能被拽走）。 */
  private pauseLyricsFollow() {
    this.lyricsFollow = false;
    this.lyricsReturn = null; // 用户的手胜过回位动画
    if (this.lyricsResumeTimer) window.clearTimeout(this.lyricsResumeTimer);
    this.lyricsResumeTimer = window.setTimeout(() => {
      this.lyricsResumeTimer = null;
      this.lyricsFollow = true;
      // 减少动效：直接回位（不滑）——与别的动效口径一致
      this.lyricsReturn = prefersReducedMotion() ? null : { from: this.lyricsScrollEl?.scrollTop ?? 0, start: Date.now() };
      this.syncLyricsScroll();
    }, 4000);
  }

  /** 点某一行 = 跳到那一句，并立刻恢复跟随 */
  private seekToLyric(i: number) {
    const line = this.lyrics?.[i];
    if (!line) return;
    this.plugin.engine?.seekTo?.(line.at / 1000);
    this.lyricsFollow = true;
    if (this.lyricsResumeTimer) window.clearTimeout(this.lyricsResumeTimer);
    this.lyricsResumeTimer = null;
    // 从当前位置滑到点到的那一句（与回位同一条动画），减少动效时直接到位
    this.lyricsReturn = prefersReducedMotion() ? null : { from: this.lyricsScrollEl?.scrollTop ?? 0, start: Date.now() };
    this.syncLyricsScroll();
  }

  private syncLyricsEmpty() {
    const el = this.lyricsEmptyEl;
    if (!el) return;
    const hasLines = !!this.lyrics?.length;
    el.toggleClass('vinyl-hidden', hasLines);
    if (hasLines) return;
    el.setText(
      this.lyricsState === 'loading'
        ? t('lyrics.loading')
        : this.lyricsForKey
          ? t(this.lyricsLocal ? 'lyrics.emptyLocal' : 'lyrics.empty')
          : t('lyrics.idle')
    );
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
    this.queueRemoves = [];
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
        // 长曲名会省略号截断：读屏走行的 aria-label（含完整曲名）。
        // 不给 title —— 提示一律走 aria-label（1.0.19 的双气泡教训，见 i18n.test.cjs 的源码防护）
        row.createSpan({ text: track.title, cls: 'vinyl-q-title' });
        const badge = row.createSpan({
          text: trackSourceLabel(track),
          cls: 'vinyl-badge ' + trackSourceClass(track),
        });
        // 试听片段（会员曲目匿名取流只给一段）：角标说明白，别让用户以为「怎么放到一半没了」。
        // 引擎侧开播时还会提示一次（见 player-state 的 trialNoticed）—— 角标是常驻的那份
        if (isTrialTrack(track)) {
          row.createSpan({ text: t('player.trialBadge'), cls: 'vinyl-badge is-trial' });
        }
        row.createSpan({
          text: track.duration ? fmtTime(track.duration) : '–:–',
          cls: 'vinyl-muted',
        });
        // 单曲移除：设计稿把「清空队列」拿掉了（退出队列模式自然收敛），
        // 但一行一行地去掉排错的那首是日常动作 —— 挂在这一行自己的尾巴上。
        // Delete / Backspace 是它的键盘等价（见 queueBox 的 keydown）。
        const remove = row.createEl('button', { cls: 'clickable-icon vinyl-queue-remove' });
        setIcon(remove, 'x');
        remove.addEventListener('click', (ev) => {
          ev.stopPropagation(); // 别让队列的点击委托把它当成「切到这首」
          this.plugin.engine.removeRange(i, 1);
        });
        remove.addEventListener('pointerdown', (ev) => ev.stopPropagation()); // 行可拖拽：别从按钮上起拖
        this.queueRemoves.push({ btn: remove, title: track.title });
        this.queueRows.push(row);
        this.queueBadges.push(badge);
      }
      if (flashLast && seg === s.segments[s.segments.length - 1]) {
        segEl.addClass('is-just-added');
        // 记下来并登记：这一行可能在 1.2 秒内被整块重建（换专辑 / 移除整段），
        // 那时旧节点已经摘除 —— 不清理的话这个定时器会攥着它（也攥着它的订阅）
        const flash = window.setTimeout(() => {
          segEl.removeClass('is-just-added');
          this.segmentFlashTimers.delete(flash);
        }, 1200);
        this.segmentFlashTimers.add(flash);
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

  /** 整段拖拽（跨专辑排序）：只认段头作落点，段内单曲拖拽仍走 bindQueueDrag。
   *  段头同时是这条动作的键盘入口（Alt+↑/↓）：拖拽能做的事，键盘要有等价的一条。 */
  private bindSegmentDrag(head: HTMLElement, seg: { start: number; count: number }) {
    head.setAttribute('draggable', 'true');
    // 可聚焦才有人能「站」在这一段上按键；aria-label（拖拽调整专辑顺序）本来挂在段头上，
    // 但此前段头不可聚焦，读屏永远读不到它
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.addEventListener('keydown', (ev) => {
      if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
      ev.preventDefault();
      // 别漏给全局快捷键：命令层那两个整段命令的默认键也是 Alt+Shift+↑/↓
      ev.stopPropagation();
      const delta = ev.key === 'ArrowUp' ? -1 : 1;
      const from = this.segmentEls.findIndex((x) => x.head === head);
      if (from < 0) return;
      const to = from + delta;
      if (to < 0 || to >= this.segmentEls.length) return;
      // 落点换算与命令层共用 segmentMoveBy（它内部就是拖拽那份 resolveSegmentDropIndex）
      const move = segmentMoveBy(this.lastSnapshot?.segments ?? [], seg.start, delta);
      if (!move) return;
      this.plugin.engine.moveRange(move.start, move.count, move.to);
      // 焦点跟着这一段走：重排后它落在第 to 段（段头重建过，等一轮再聚焦）
      window.setTimeout(() => this.segmentEls[to]?.head.focus(), 0);
    });
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

  // ============ 搓碟（手指在唱片上划 = 手动转盘）============
  // 分工：手势、视觉与位置换算都在这几段里；声音分两条路 —— 搓碟台（完整音效，正反都出声）
  // 与引擎的 scratchRate（轻量音效，只有正向出声）。搓碟期间位置由这里说了算：
  // 快照不回写轨道 / 读数 / 唱臂（update 的 seekOwned），抬手再一次性交还给引擎。

  /** 命中几何：唱片本体的圆。取内层唱片的盒子 —— 它是正圆、绕心自转，旋转不改 bounding box；
   *  外层 .vinyl-turntable-disc 上还挂着入场位移，飞行途中别拿它当圆心。 */
  private scratchGeometry(): ScratchHit | null {
    const els = this.els;
    if (!els) return null;
    const r = els.vinyl.getBoundingClientRect();
    if (!(r.width > 0)) return null;
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, radius: r.width / 2 };
  }

  /** 按在左下角的播放键上不算搓碟（那枚键有自己的事要做） */
  private isDeckButton(ev: PointerEvent): boolean {
    const node = ev.targetNode;
    return !!node && node.instanceOf(HTMLElement) && !!node.closest('.vinyl-deck-play');
  }

  /** 能不能搓：唱机面 + 开关开着 + 有当前曲目 + 不在换曲取址的间隙里 */
  private canScratch(): boolean {
    if (this.face !== 'player') return false;
    if (!this.plugin.settings.scratchEnabled) return false;
    const s = this.lastSnapshot;
    if (!s?.current) return false;
    return s.status === 'playing' || s.status === 'paused';
  }

  /** 转盘一圈的秒数（换算基准 = 设置里的转速档；默认 1.8s 正是 33⅓ RPM） */
  private spinSeconds(): number {
    return SPIN_SECONDS[this.plugin.settings.turntableSpeed] || SPIN_SECONDS.normal;
  }

  /** CSS 动画此刻转到了哪个角度（0–360）：接手时对齐用（不然盘面会跳一下）。
   *  从 CSSAnimation 的 currentTime 反推 —— 比解析 computed transform 的矩阵稳。
   *  负延迟要一起算：交还旋转时相位就存在 animation-delay 里（搓碟抬手、起转到位都是这么交的），
   *  只读 currentTime 会把它漏掉 —— 接手的一瞬间盘面会跳回相位 0（正是「跳帧摆正」那种观感）。 */
  private currentSpinAngle(): number {
    const el = this.els?.vinyl;
    if (!el || typeof el.getAnimations !== 'function') return 0;
    for (const a of el.getAnimations()) {
      const timing = a.effect?.getComputedTiming?.();
      const duration = typeof timing?.duration === 'number' ? timing.duration : 0;
      const delay = typeof timing?.delay === 'number' ? timing.delay : 0;
      const t = a.currentTime;
      if (duration > 0 && typeof t === 'number') {
        const phase = (((t - delay) % duration) + duration) % duration;
        return (phase / duration) * 360;
      }
    }
    return 0;
  }

  /** 盘面此刻的角度（deg，0–360）：旋转归谁管就问谁 —— 马达斜坡 / 停住时在 JS 手里，
   *  否则在 CSS 动画手里。接手（搓碟起手、起转）一律从这里取起点，角度就不会跳。 */
  private discAngle(): number {
    if (this.spin) return this.spin.angle;
    if (this.heldAngle !== null) return this.heldAngle;
    return this.currentSpinAngle();
  }

  /** 专辑进度 → 唱臂角（进度按「当前曲目在本专辑里的位置」算，见 core/arm-geometry） */
  private armAngleFor(s: PlayerSnapshot, currentTime: number): number {
    return armAngleForProgress(
      albumProgress({
        queue: s.queue,
        index: s.index,
        albumNotePath: s.albumNotePath,
        currentTime,
        duration: Math.max(s.duration, currentTime),
      })
    );
  }

  /** 写唱臂角。判据写成「不小于等于」而不是「大于」：首帧 lastArmAngle 是 NaN，
   *  用 > 比较永远为假，打开视图时正在播放的话唱臂会停在 CSS 默认角上（要等下一次快照才动）。 */
  private writeArm(angle: number) {
    const els = this.els;
    if (!els) return;
    if (!(Math.abs(angle - this.lastArmAngle) <= 0.05)) {
      this.lastArmAngle = angle;
      els.arm.style.setProperty('--vinyl-arm-angle', `${angle.toFixed(2)}deg`);
    }
  }

  // ============ 转盘马达（暂停的滑停 / 复播的起转）============
  // 旋转有三种归属，全部在这一处切换（每条快照过一遍）：
  //   ① CSS 动画（.is-spinning）：稳速播放的常态 —— 交给合成器转，主线程不参与；
  //   ② 马达斜坡（.is-spin-held + 逐帧写 --vinyl-spin-angle）：暂停滑停 / 复播起转。
  //      引擎起头（快照的 motor），视图按 core/motor 的同一条曲线写角度 —— 曲线是闭式的，
  //      只与「起点转速 + 已走时长」有关，所以掉帧不影响角度，两个执行者也必然同时到终点；
  //   ③ 停住（.is-spin-held + 写死的角度）：暂停 / 出错。唱片停在停下的那个角度上 ——
  //      不摆正、也不归零；再按播放从同一个角度接着起转，全程不跳。
  // 换曲的间隙（loading）什么都不动：盘上还是同一张碟，它该接着转（或接着停在原地）。

  /** 按快照切换转盘的旋转归属（见上面三种）。 */
  private syncTurntable(s: PlayerSnapshot) {
    const els = this.els;
    if (!els) return;
    // 手在盘上：盘面归手势（起手时已经把斜坡收掉了，见 scratchEngage）
    if (this.scratch) return;
    const motor = s.motor ?? null;
    const spinning = !motor && s.status === 'playing';
    // 刚转入播放：重算一次可见性，清掉可能残留的 is-hidden（动画停在它上面就转不动了）
    if (spinning && !this.lastSpinning) this.syncVisibility();
    this.lastSpinning = spinning;

    if (motor) {
      // 同一段斜坡不重来（rAF 已经排上了）；引擎期间重发快照（音量变化等）也当作同一段
      if (this.spin?.phase === motor.phase && this.spin.from === motor.rate) return;
      const base = this.discAngle();
      this.spinCancel();
      this.spin = {
        phase: motor.phase,
        from: motor.rate,
        base,
        startedAt: performance.now(),
        angle: base,
        raf: 0,
      };
      els.vinyl.addClass('is-spin-held');
      this.writeSpinAngle(base);
      this.heldAngle = null; // 接管之后「此刻的角度」由 spin.angle 代表
      this.spin.raf = window.requestAnimationFrame(this.spinLoop);
      return;
    }
    if (this.spin) {
      this.endSpin(); // 引擎那边收完了：滑停的定住、起转的交还
      return;
    }
    if (s.status === 'loading') return; // 换曲的间隙：不动转盘

    const onPlatter = !!s.current && s.status !== 'idle';
    els.vinyl.classList.toggle('is-spinning', onPlatter && s.status === 'playing');
    // 暂停 / 出错：定住（角度 = 动画现在的相位）。减少动效时动画根本不转，这里定的是 0°，看着就是没动过
    const frozen = onPlatter && (s.status === 'paused' || s.status === 'error');
    if (frozen && this.heldAngle === null) this.holdSpin(this.currentSpinAngle());
    else if (!frozen && this.heldAngle !== null) this.releaseSpin(this.heldAngle);
  }

  /** 斜坡走到 now 时的角度 = 起点角 + 「走过的时间」换算成转角（与元素的位置前进量是同一个积分）。
   *  闭式重算而不是逐帧累加：掉帧、后台节流、迟到很久的那一帧都不会让落点走偏。 */
  private spinAngleAt(st: SpinState, now: number): number {
    const elapsed = Math.max(0, now - st.startedAt);
    return st.base + (motorAdvance(st.from, elapsed, st.phase) * 360) / this.spinSeconds();
  }

  /** 盘面角度的唯一出口（旋转归 JS 的那三种情形都写这一个变量） */
  private writeSpinAngle(angle: number) {
    this.els?.vinyl.style.setProperty('--vinyl-spin-angle', `${angle.toFixed(2)}deg`);
  }

  /** 斜坡的逐帧 */
  private spinLoop = (now: number) => {
    const st = this.spin;
    if (!st) return;
    st.angle = this.spinAngleAt(st, now);
    this.writeSpinAngle(st.angle);
    const elapsed = Math.max(0, now - st.startedAt);
    if (motorDone(st.phase, motorRate(st.from, elapsed, st.phase), elapsed)) {
      this.endSpin();
      return;
    }
    st.raf = window.requestAnimationFrame(this.spinLoop);
  };

  /** 斜坡收尾：滑停 → 就地定住（角度不跳、也不归零）；起转到位 → 交还 CSS 动画（负延迟续上相位）。
   *  角度在这里按当前时刻重算一次：收尾可能是「快照说引擎收完了」（离最后一帧可能已经很久），
   *  拿上一帧的角度会停在半路上。 */
  private endSpin() {
    const st = this.spin;
    if (!st) return;
    this.spin = null;
    window.cancelAnimationFrame(st.raf);
    const angle = this.spinAngleAt(st, performance.now());
    if (st.phase === 'stopping') this.holdSpin(angle);
    else this.releaseSpin(angle);
  }

  /** 丢掉进行中的斜坡（手势接管 / 视图关闭）：角度留给调用方处置 */
  private spinCancel() {
    const st = this.spin;
    if (!st) return;
    this.spin = null;
    window.cancelAnimationFrame(st.raf);
  }

  /** 把旋转定在某个角度上（暂停 / 出错）：JS 扶着不动 —— 停在原地，不摆正也不归零 */
  private holdSpin(angle: number) {
    const els = this.els;
    if (!els) return;
    this.heldAngle = angle;
    els.vinyl.addClass('is-spin-held');
    this.writeSpinAngle(angle);
  }

  /** 交还旋转给 CSS 动画：角度折成负 animation-delay（转盘从原角度接着转，不跳）。
   *  顺带补上 is-spinning —— 起转刚到位时状态可能还没翻（元素还在缓冲），而盘面这时候
   *  已经该转起来了（转盘先到速，唱针再落下）。 */
  private releaseSpin(angle: number) {
    const els = this.els;
    if (!els) return;
    this.heldAngle = null;
    this.writeSpinDelay(angle);
    els.vinyl.addClass('is-spinning');
    els.vinyl.removeClass('is-spin-held');
    els.vinyl.style.removeProperty('--vinyl-spin-angle');
  }

  /** 把角度折成负延迟写进 animation-delay：CSS 动画按负延迟创建时，相位就等于这个角度
   *  （交接必须在同一帧里完成 —— 先写延迟、再摘掉接管类，动画才会带着这个相位建出来）。 */
  private writeSpinDelay(angle: number) {
    const els = this.els;
    if (!els) return;
    const spinMs = this.spinSeconds() * 1000;
    const frac = (((angle % 360) + 360) % 360) / 360;
    els.vinyl.style.setProperty('animation-delay', `-${Math.round(frac * spinMs)}ms`);
  }

  /** 起手（转过 3° 才走到这里）：接管盘面与声音。轻量 / 完整两条路由搓碟台的就绪状态决定。 */
  private scratchEngage() {
    const els = this.els;
    const s = this.lastSnapshot;
    if (!els || this.scratch || !s?.current || s.index < 0) return;
    // 手已经按在唱片上了：这一首的缓冲现在就去抓（预载没赶上时的兜底 —— 见 maybePrepareScratch）
    this.maybePrepareScratch(s, true);
    const key = trackKey(s.current);
    const deckReady =
      !!this.scratchDeck && this.plugin.settings.scratchSound === 'full' && this.scratchDeck.prepared(key);
    const info = this.plugin.engine.beginScratch({ live: !deckReady });
    if (!info) return;
    // 搓碟台接不下（声卡上下文就是建不出来这类）：如实退回轻量路 —— 引擎那边的会话也要跟着换，
    // 否则元素不出声、搓碟台也没声，手在盘上划半天是哑的
    const useDeck = deckReady && !!this.scratchDeck?.begin(key, info.time, this.scratchTracker.rate);
    if (!useDeck) this.plugin.engine.setScratchLive(true);
    this.scratchTracker.reset();
    // 马达斜坡（滑停 / 起转）到此为止：盘面从此刻的角度归手势 —— 引擎那边已经把斜坡收了。
    // 角度要在收掉斜坡之前读：滑停到一半被按住时，正主是斜坡那一手算到现在的角度
    const angle = this.discAngle();
    this.spinCancel();
    this.scratch = {
      phase: 'drag',
      playing: info.playing,
      index: s.index,
      key,
      deck: useDeck,
      pos: info.time,
      angle,
      rate: 0,
      at: performance.now(),
      raf: 0,
    };
    els.vinyl.addClass('is-scratching');
    els.turntable.addClass('is-scratching');
    // 手一按下去唱针就落在盘上（暂停起手也一样 —— 搓碟期间唱针在槽里）
    els.arm.removeClass('is-parked');
    this.lastPosture = 'record';
    this.scratch.raf = window.requestAnimationFrame(this.scratchLoop);
  }

  /** 每帧一步：drag 里把指针转角变成角度与倍速，settle 里让马达把转盘拉回正常转速 */
  private scratchLoop = (now: number) => {
    const st = this.scratch;
    if (!st) return;
    const dt = Math.min(100, Math.max(0, now - st.at)); // 窗口切回来别让一帧吃掉几秒
    st.at = now;
    const spin = this.spinSeconds();
    const target = st.playing ? 1 : 0;
    if (st.phase === 'drag') {
      const { turn, rate } = this.scratchTracker.frame(dt, spin);
      st.angle += turn; // 视觉用原始转角：直接跟手，不过平滑
      st.rate = rate;
    } else {
      st.rate = approachRate(st.rate, target, dt);
      st.angle += (st.rate * 360 * dt) / (spin * 1000);
      if (Math.abs(st.rate - target) < SCRATCH_SETTLE_EPS) {
        this.scratchFinish();
        return;
      }
    }
    this.scratchApply(st, dt);
    st.raf = window.requestAnimationFrame(this.scratchLoop);
  };

  /** 把这一帧的角度与位置写给盘面 / 声音 / 进度 / 唱臂 */
  private scratchApply(st: ScratchState, dt: number) {
    const els = this.els;
    if (!els) return;
    els.vinyl.style.setProperty('--vinyl-spin-angle', `${st.angle.toFixed(2)}deg`);
    // 轻量路搓到一半、缓冲备好了：这一程余下的交给搓碟台（正反都出声那套）。
    // 起点接着走（当前位置直接交给它），元素让位 —— 第一下搓碟不必等完整的几秒下载。
    if (!st.deck && this.canUpgrade(st) && this.scratchDeck?.begin(st.key, st.pos, st.rate)) {
      st.deck = true;
      this.plugin.engine.setScratchLive(false);
    }
    if (st.deck) {
      // 完整音效：声音与位置都由搓碟台自己积分（倍速平滑后的积分就是它听到的位置）
      this.scratchDeck?.frame(dt, st.rate);
      st.pos = this.scratchDeck?.position() ?? st.pos;
    } else {
      // 轻量音效：位置由这里积分；元素只负责「正向按倍速出声、其余停声」
      const dur = this.lastSnapshot?.duration || 0;
      const step = (st.rate * dt) / 1000;
      st.pos = dur > 0 ? Math.min(dur, Math.max(0, st.pos + step)) : Math.max(0, st.pos + step);
    }
    // 位置先喂给引擎（读数 / 媒体面板 / 唱臂），再让轻量路按倍速起停 —— 顺序不能反：
    // 轻量路出声前要拿最新针位把元素对齐（见 player-state 的 scratchRate）
    this.plugin.engine.updateScratch(st.pos);
    if (!st.deck) this.plugin.engine.scratchRate(st.rate);
    this.scratchPreview(st.pos);
  }

  /** 这一程能不能改走搓碟台：完整音效 + 这一首的缓冲刚备好（每帧问一次，就一个 Map 查询） */
  private canUpgrade(st: ScratchState): boolean {
    return (
      this.plugin.settings.scratchSound === 'full' && !!this.scratchDeck && this.scratchDeck.has(st.key)
    );
  }

  /** 搓碟期间的界面跟手：进度轨 / 读数 / 唱臂（与拖动进度条同一套本地预览的写法） */
  private scratchPreview(pos: number) {
    const els = this.els;
    const s = this.lastSnapshot;
    if (!els || !s) return;
    const dur = s.duration || 0;
    if (!(dur > 0)) return;
    const ratio = clampRatio(pos / dur);
    els.progressSlider.value = String(Math.round(ratio * 1000));
    setSeekPosition(els.progressRail, ratio);
    const text = `${fmtTime(pos)} / ${fmtTime(dur)}`;
    if (text !== this.lastTimeText) {
      this.lastTimeText = text;
      els.timeEl.textContent = text;
    }
    this.writeArm(this.armAngleFor(s, pos)); // 唱针还在槽里：进到哪，臂就移到哪
  }

  /** 松手：播放中 → 马达回正（转盘自己转回正常转速，声音跟着收）；暂停起手 → 就地收尾 */
  private scratchRelease() {
    const st = this.scratch;
    if (!st || st.phase === 'settle') return;
    if (!st.playing) {
      this.scratchFinish(); // 盘本来就是停的：不回转，位置留在松手处（＝手动定位）
      return;
    }
    st.phase = 'settle';
  }

  /** 收尾：位置交回引擎，盘面交回 CSS 动画 */
  private scratchFinish() {
    const st = this.scratch;
    if (!st) return;
    this.scratch = null;
    window.cancelAnimationFrame(st.raf);
    // 先压住回声（引擎那边一写回就会 emit）：抬手后不许把轨道拽回旧位置
    const dur = this.lastSnapshot?.duration || 0;
    this.seekHold = {
      ratio: dur > 0 ? clampRatio(st.pos / dur) : 0,
      index: this.lastSnapshot?.index ?? st.index,
      until: Date.now() + SEEK_HOLD_MS,
    };
    const els = this.els;
    if (els) {
      // 交还旋转：起手前在播 → 盘面从当前角度接着转（负延迟续相位）；
      // 起手前是暂停 → 就地定住（暂停中搓碟 = 手动定位，松手就停在那儿）。两处都不跳
      if (st.playing) this.releaseSpin(st.angle);
      else this.holdSpin(st.angle);
      els.vinyl.removeClass('is-scratching');
      els.turntable.removeClass('is-scratching');
    }
    // 顺序有意为之：先把元素接回去（seek + play 都要几十毫秒才出声），再让搓碟台按它的收尾包络
    // 淡出 —— 两个声音叠一点点，比中间空一拍好。反过来写就是一个听得见的窟窿。
    this.plugin.engine.endScratch(st.pos, st.playing);
    this.scratchDeck?.end();
    this.scratchTracker.reset();
  }

  /** 手势作废（换曲 / 关视图）：不写位置 —— 引擎那边的会话已经收掉了，这里只把声音与盘面收干净 */
  private scratchAbort() {
    const st = this.scratch;
    if (!st) return;
    this.scratch = null;
    window.cancelAnimationFrame(st.raf);
    this.els?.vinyl.removeClass('is-scratching');
    this.els?.turntable.removeClass('is-scratching');
    this.scratchDeck?.end();
    this.scratchTracker.reset();
  }

  // —— 搓碟缓冲（完整音效的准备；轻量档从不走到这里）——

  /** 挂表：开播一会儿之后去抓整轨。见 SCRATCH_PRELOAD_DELAY_MS 与 maybePrepareScratch 的说明。
   *  到点时会再核一遍曲目 / 播放状态 / 当前面 —— 这几秒里用户可能已经翻到唱片区或者按了暂停。 */
  private armScratchPreload(s: PlayerSnapshot) {
    this.disarmScratchPreload();
    if (!this.plugin.settings.scratchEnabled) return;
    if (this.plugin.settings.scratchSound !== 'full') return;
    if (!this.plugin.settings.scratchPreload) return;
    if (!s.current || s.status !== 'playing' || this.face !== 'player') return;
    const key = trackKey(s.current);
    this.scratchPreloadTimer = window.setTimeout(() => {
      this.scratchPreloadTimer = null;
      const cur = this.lastSnapshot;
      if (!cur?.current || trackKey(cur.current) !== key) return;
      if (cur.status !== 'playing' || this.face !== 'player') return;
      // 排不下（在途满了，见 ScratchDeck.prepare）就再挂一次 —— 连着切歌时后一首不该永远排不上队
      if (!this.maybePrepareScratch(cur, true)) this.armScratchPreload(cur);
    }, SCRATCH_PRELOAD_DELAY_MS);
  }

  private disarmScratchPreload() {
    if (this.scratchPreloadTimer !== null) window.clearTimeout(this.scratchPreloadTimer);
    this.scratchPreloadTimer = null;
  }

  /** 备搓碟缓冲。两个触发点：
   *    ① 预载（force，开播满 SCRATCH_PRELOAD_DELAY_MS 后，见 armScratchPreload）—— 常态；
   *    ② 手按上来的那一刻 —— 预载没赶上（刚切歌 / 关着预载）时的兜底。
   *  两个代价都是真的，权衡下来这么切：
   *    立刻抓 = 跟开播抢带宽、还多解析一次播放地址，切歌会变得不跟手（用户实测）；
   *    只在手按上来才抓 = 每张唱片的第一下搓碟只有轻量音效：倒着拖没声、位置也对不上，
   *    听感是「声音跟歌没关系」（也是用户实测）。开播几秒再抓，两头都躲开。 */
  private maybePrepareScratch(s: PlayerSnapshot, force = false): boolean {
    const want = this.scratchWant;
    if (!want || !s.current || trackKey(s.current) !== want.key) return true;
    if (!this.plugin.settings.scratchEnabled || this.plugin.settings.scratchSound !== 'full') return true;
    const deck = this.ensureScratchDeck();
    if (deck.prepared(want.key)) return true; // 已经备好（缓存命中）：什么都不用做
    if (!force) return true; // 没动手就不下载
    const track = want.track;
    const dur = s.duration || track.duration || 0;
    // 时长已知时先在下载前筛一遍（装不下的曲子不必白下一整轨）
    if (!deck.canPrepare(dur)) return true;
    return deck.prepare(want.key, dur, () => this.loadScratchSource(track, dur));
  }

  private ensureScratchDeck(): ScratchDeck {
    if (!this.scratchDeck) {
      this.scratchDeck = new ScratchDeck({
        volume: () => this.lastSnapshot?.volume ?? this.plugin.settings.volume,
      });
    }
    return this.scratchDeck;
  }

  private disposeScratchDeck() {
    this.scratchDeck?.dispose();
    this.scratchDeck = null;
  }

  /** 搓碟缓冲的取料：整轨字节 + 时长（时长用来挑解码采样率）。
   *  字节：本地走 LocalSource（vault / fs）、在线走 requestUrl（主进程发起、不受 CORS 限制 ——
   *  CDN 不给跨源头，渲染进程 fetch 会直接失败）。
   *  时长：优先用已知值（元素元数据 / 队列元数据）；本地没播过的曲子没有时长元数据，
   *  用一次元数据探测补上 —— 探测与取字节并行跑，不额外等。 */
  private async loadScratchSource(track: Track, knownSec: number): Promise<ScratchSource> {
    try {
      let url = '';
      if (track.source === 'local-vault') url = this.plugin.local.resolveVaultUrl(track.file);
      // 库外音频与播放引擎同一口径：能起网关就按 Range 供流，起不来才落回 Blob
      else if (track.source === 'local-external') url = await this.plugin.local.resolveExternalPlayableUrl(track.path);
      else url = await this.plugin.engine.resolveUrl(track);
      if (!url) return { bytes: null, durationSec: 0 };
      const bytes = isLocalTrack(track)
        ? this.plugin.local.readTrackBytes(track)
        : requestUrl({ url }).then((r) => r.arrayBuffer);
      const duration = knownSec > 0 ? Promise.resolve(knownSec) : probeMediaDuration(url);
      const [buf, dur] = await Promise.all([bytes, duration]);
      return { bytes: buf, durationSec: dur };
    } catch (e) {
      console.warn('[vinyl] 搓碟缓冲取料失败（这首曲子只走轻量音效）', e);
      return { bytes: null, durationSec: 0 };
    }
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
    this.scratchAbort(); // 清空队列 / 换碟：手还按在盘上的话，这次手势到此为止
    this.spinCancel(); // 马达斜坡（滑停 / 起转）同理：盘子要换了，斜坡没有下文
    this.heldAngle = null;
    els.vinyl.classList.remove('is-spinning', 'is-spin-held');
    els.vinyl.classList.add('is-empty');
    els.vinyl.style.removeProperty('animation-delay');
    els.vinyl.style.removeProperty('--vinyl-spin-angle');
    // 唱臂归位到支架（显式写死：CSS 变量可能停在播放中的角度上）
    els.arm.style.setProperty('--vinyl-arm-angle', `${ARM_PARK_ANGLE.toFixed(2)}deg`);
    this.lastArmAngle = ARM_PARK_ANGLE;
    els.arm.addClass('is-parked');
    this.lastPosture = 'park';
  }
}
