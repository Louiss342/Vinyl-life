// 播放器视图：转盘 + 旋转唱片 + 直线唱臂（不播放归位支架 / 播放落针并随进度内移）；
//   胡桃木设备面板（.vinyl-deck）：金属圆钮控制、红色填充进度轨、丝印品牌行；
//   换碟 = 头部圆钮弹 Menu。
// 增量渲染：壳只建一次，状态更新只改目标节点——旋转动画不被打断。
import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import type VinylLifePlugin from '../main';
import type { PlayerSnapshot } from '../core/player-state';
import type { Track } from '../core/track';
import type { PlayMode } from '../core/player-state';
import { trackSourceLabel, trackSourceClass, qualityText } from '../core/track';
import { fmtTime, notice, prefersReducedMotion } from '../util';
import { SPIN_SPEEDS } from '../core/disc-motion';
import { DECK_STYLES, RECORD_COLORS, deckClass, recordClass } from '../core/appearance';
import { coverChain } from '../core/cover-url';
import { resolveAlbumCover } from '../core/album-index';
import { t, tf } from '../core/i18n';
import { onMarqueeOver, onMarqueeOut } from './marquee';

export const PLAYER_VIEW_TYPE = 'vinyl-player';

interface PlayerEls {
  headerTitle: HTMLElement;
  /** 标题里真正装文字的那一层（marquee 动的是它，不是外层容器） */
  headerTitleText: HTMLElement;
  /** 播放模式按钮（单次 / 循环 / 随机）：队列模式下作用于整条列表 */
  playModeBtn: HTMLButtonElement;
  discOuter: HTMLElement;
  vinyl: HTMLElement;
  labelImg: HTMLImageElement;
  labelEmpty: HTMLElement;
  arm: HTMLElement;
  progressSlider: HTMLInputElement;
  timeEl: HTMLElement;
  prevBtn: HTMLButtonElement;
  playBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  volSlider: HTMLInputElement;
  queueTitle: HTMLElement;
  queueBox: HTMLElement;
  /** 专辑队列模式开关（顶部，「选择专辑」左边） */
  queueModeBtn: HTMLButtonElement;
  /** 「清空后面的专辑」（Vinyl order 行） */
  clearQueueBtn: HTMLButtonElement;
  qualityEl: HTMLElement;
}

// 实际音质读数文案：队列就绪才显示；在线源带档位，本地源只显示来源
export function qualityReadout(s: PlayerSnapshot): string {
  if (!s.queue.length || !s.sourceLabel) return '';
  const q = qualityText(s.quality);
  return q ? `${s.sourceLabel} · ${q}` : s.sourceLabel;
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

function setVal(el: HTMLInputElement, v: string) {
  if (el.dataset.dragging !== '1') el.value = v;
}

// 进度轨填充（唱片品牌红 / 音量中性银）：经 CSS 变量喂给 ::-webkit-slider-runnable-track
function fillRange(el: HTMLInputElement, ratio: number, color: string) {
  const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  el.style.setProperty(
    '--track-fill',
    `linear-gradient(90deg, ${color} ${pct}%, #1c1c21 ${pct}%)`
  );
}

const FILL_RED = '#ff4757';
const FILL_SILVER = '#c8c8d0';

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

// 唱臂角度（deg，与 styles.css 的 .vinyl-turntable-arm 几何配套）：
//   停放 = 归位到唱臂支架卡口（唱针离开唱片）；
//   播放 = 唱针落在导入槽（外圈 ≈0.96R），随播放向内圈导出槽（≈0.40R，停在标签外）缓移。
const ARM_PARKED = -100;
const ARM_OUTER = -76;
const ARM_INNER = -46;

export class VinylPlayerView extends ItemView {
  private plugin: VinylLifePlugin;
  private unsub: (() => void) | null = null;
  private els: PlayerEls | null = null;
  private renderedQueue: Track[] | null = null;
  private queueRows: HTMLElement[] = [];
  /** 段容器（多专辑时画出来的分组）：切语言要按它重写段头提示 */
  private segmentEls: Array<{ el: HTMLElement; seg: { start: number; count: number; albumTitle: string; albumPath: string } }> = [];
  // 队列行右侧的来源角标（文案随语言变；行不重建，切语言时按 renderedQueue 就地重写）
  private queueBadges: HTMLElement[] = [];
  /** 封面候选链的签名（链内容变化才换图；链见 core/cover-url.coverChain） */
  private currentCoverSig: string | null = null;
  private coverChain: string[] = [];
  private lastAlbumPath: string | null = null;
  private lastSpinning = false;
  private lastArmAngle = NaN;
  private playIcon: 'play' | 'pause' | '' = '';
  private lastReadout = '';
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
  private lastHeaderText = '';
  private lastVol = -1;
  private onVisibility = () => this.syncVisibility();
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
    document.removeEventListener('visibilitychange', this.onVisibility);
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
    // 头部标题（专辑名 / 取碟中 / 错误提示）与音质读数（来源 · 档位）都由快照决定、由 update 统一维护：
    // 把这两处按语言缓存的值清掉，再按新语言重放一次，文案即重算。
    // 快照必须现取而不是用 lastSnapshot：来源文案是引擎按当前语言求值的，而切语言不产生引擎广播，
    // 手里的旧快照会把旧语言的来源钉在读数上（暂停中尤其明显——没有播放进度事件来纠正它）。
    // 引擎缺失时（极简依赖的测试）退回最近一次收到的快照。
    const snap = this.plugin.engine ? this.plugin.engine.snapshot() : this.lastSnapshot;
    if (snap) {
      this.lastHeaderText = '';
      this.lastReadout = '';
      this.update(snap);
    }
  }

  // 队列文案（行拖拽提示 / 空态 / 来源角标）不挂在壳上、随队列重建，故单独就地刷新（只改属性与文本，不重建节点）
  private applyQueueLabels() {
    const els = this.els;
    if (els) {
      els.queueModeBtn.setAttribute('aria-label', t('player.queueMode'));
      els.playModeBtn.setAttribute(
        'aria-label',
        tf('player.modeHint', {
          mode: t(modeLabelKey(this.lastPlayMode || 'once', this.plugin.settings.queueMode)),
        })
      );
      els.clearQueueBtn.setAttribute('aria-label', t('player.queueClearOthers'));
    }
    for (const { el, seg } of this.segmentEls) {
      const head = el.querySelector<HTMLElement>('.vinyl-queue-segment-head');
      if (head) head.setAttribute('title', t('player.queueDragAlbum'));
      const removeBtn = el.querySelector<HTMLElement>('.vinyl-queue-segment-remove');
      if (removeBtn) {
        removeBtn.setAttribute(
          'aria-label',
          tf('player.queueRemoveAlbum', { name: seg.albumTitle || seg.albumPath })
        );
      }
    }
    for (const row of this.queueRows) row.setAttribute('title', t('player.dragToReorder'));
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

    // 头部：标题 + 换碟圆钮
    const header = c.createDiv({ cls: 'vinyl-player-header' });
    // 顶部专辑名：放不下时悬停滚动（与专辑墙卡片同一套 .vinyl-marquee 机制）
    const headerTitle = header.createDiv({ cls: 'vinyl-player-header-title vinyl-marquee' });
    const headerTitleText = headerTitle.createSpan({
      cls: 'vinyl-marquee-text',
      text: t('player.title'),
    });
    // 专辑队列模式开关（默认关）：开着时点专辑墙上的专辑是排队，不是换碟。
    // 必须建在「选择专辑」之前 —— 顶部这一行的顺序就是创建顺序。
    const queueModeBtn = header.createEl('button', { cls: 'vinyl-btn vinyl-btn-small' });
    setIcon(queueModeBtn, 'list-plus');
    queueModeBtn.addEventListener('click', () => this.toggleQueueMode());
    // 播放模式：单次 → 循环 → 随机 循环切换（队列模式下作用于整条列表，见 modeLabelKey）
    const playModeBtn = header.createEl('button', { cls: 'vinyl-btn vinyl-btn-small' });
    setIcon(playModeBtn, PLAY_MODE_ICON.once);
    playModeBtn.addEventListener('click', () => this.cyclePlayMode());

    // 设备面板（胡桃木底座，样式见 .vinyl-deck）
    const deck = c.createDiv({ cls: 'vinyl-deck' });

    // 转盘：外层 discOuter 承接入场动画，内层 vinyl 承载 CSS 旋转（分离互不冲突）
    const turntable = deck.createDiv({ cls: 'vinyl-turntable' });
    turntable.createDiv({ cls: 'vinyl-turntable-platter' });
    const discOuter = turntable.createDiv({ cls: 'vinyl-turntable-disc' });
    const vinyl = discOuter.createDiv({ cls: 'vinyl-turntable-vinyl is-empty' });
    const label = vinyl.createDiv({ cls: 'vinyl-turntable-label' });
    const labelImg = label.createEl('img', { attr: { alt: '' }, cls: 'vinyl-hidden' });
    const labelEmpty = label.createDiv({ cls: 'vinyl-turntable-label-empty', text: '♪' });
    // 唱臂：配重 + 枢轴 + 唱头（直线臂）+ 唱臂支架（不播放时唱头落在这个卡口上）
    const arm = turntable.createDiv({ cls: 'vinyl-turntable-arm' });
    arm.createDiv({ cls: 'vinyl-arm-counterweight' });
    arm.createDiv({ cls: 'vinyl-arm-pivot' });
    arm.createDiv({ cls: 'vinyl-arm-head' });
    turntable.createDiv({ cls: 'vinyl-arm-rest' });
    turntable.createDiv({ cls: 'vinyl-turntable-spindle' });

    // 进度轨（红色填充）
    const progress = deck.createDiv({ cls: 'vinyl-progress' });
    const progressSlider = progress.createEl('input', {
      attr: { type: 'range', min: '0', max: '1000' },
      cls: 'vinyl-slider',
    });
    progressSlider.addEventListener('pointerdown', () => (progressSlider.dataset.dragging = '1'));
    progressSlider.addEventListener('pointerup', () => delete progressSlider.dataset.dragging);
    progressSlider.addEventListener('input', () =>
      this.plugin.engine.seek(Number(progressSlider.value) / 1000)
    );
    const timeEl = progress.createSpan({ text: '–:– / –:–', cls: 'vinyl-readout' });

    // 控制圆钮组
    const controls = deck.createDiv({ cls: 'vinyl-controls' });
    const prevBtn = controls.createEl('button', { cls: 'vinyl-btn' });
    const playBtn = controls.createEl('button', { cls: 'vinyl-btn vinyl-btn-primary' });
    const nextBtn = controls.createEl('button', { cls: 'vinyl-btn' });
    setIcon(prevBtn, 'skip-back');
    setIcon(playBtn, 'play');
    setIcon(nextBtn, 'skip-forward');
    this.bindLabel(() => prevBtn.setAttribute('aria-label', t('player.prev')));
    this.bindLabel(() => playBtn.setAttribute('aria-label', t('player.playPause')));
    this.bindLabel(() => nextBtn.setAttribute('aria-label', t('player.next')));
    prevBtn.addEventListener('click', () => {
      void this.plugin.engine.prev();
    });
    playBtn.addEventListener('click', () => {
      void this.plugin.engine.toggle();
    });
    nextBtn.addEventListener('click', () => {
      void this.plugin.engine.next();
    });

    // 音量行：旋钮图标 + 银色填充轨
    const volRow = deck.createDiv({ cls: 'vinyl-vol-row' });
    const volIcon = volRow.createSpan({ cls: 'vinyl-vol-icon' });
    setIcon(volIcon, 'volume-2');
    const volSlider = volRow.createEl('input', {
      attr: { type: 'range', min: '0', max: '100' },
      cls: 'vinyl-slider vinyl-vol',
    });
    volSlider.addEventListener('pointerdown', () => (volSlider.dataset.dragging = '1'));
    volSlider.addEventListener('pointerup', () => delete volSlider.dataset.dragging);
    volSlider.addEventListener('input', () =>
      this.plugin.engine.setVolume(Number(volSlider.value) / 100)
    );

    // 丝印品牌行 + 实际音质读数（源 · 档位，如「网易云 · 较高」；本地音轨只显示来源）
    const brandRow = deck.createDiv({ cls: 'vinyl-deck-brand-row' });
    brandRow.createDiv({ cls: 'vinyl-deck-brand', text: 'Vinyl Life' });
    const qualityEl = brandRow.createDiv({ cls: 'vinyl-quality' });

    // Vinyl order 行：标题 + ✎ 追加感想 + ↺ 恢复原有顺序
    const orderRow = c.createDiv({ cls: 'vinyl-order-row' });
    const queueTitle = orderRow.createDiv({ cls: 'vinyl-queue-title' });
    // 清空后面的专辑（保留当前这张）：只在队列里不止一张专辑时有意义
    const clearQueueBtn = orderRow.createEl('button', { cls: 'vinyl-btn vinyl-btn-small' });
    setIcon(clearQueueBtn, 'list-x');
    clearQueueBtn.addEventListener('click', () => {
      this.plugin.engine.keepCurrentAlbum();
      notice(t('player.queueClearOthers'));
    });
    const noteBtn = orderRow.createEl('button', { cls: 'vinyl-btn vinyl-btn-small' });
    setIcon(noteBtn, 'pencil');
    // 只设 aria-label：Obsidian 自己会按它渲染样式化提示，再设 title 会同时弹出浏览器原生提示（两个气泡）
    this.bindLabel(() => noteBtn.setAttribute('aria-label', t('player.appendNote')));
    noteBtn.addEventListener('click', () => {
      void this.plugin.appendListeningNote();
    });
    // 恢复按钮始终显示（本地专辑也显示：点按只提示不支持，见 restoreOrder）
    const restoreBtn = orderRow.createEl('button', { cls: 'vinyl-btn vinyl-btn-small' });
    setIcon(restoreBtn, 'undo-2');
    // 同上：只留 aria-label，避免「Obsidian 提示 + 原生 title 提示」叠成两个气泡
    this.bindLabel(() => restoreBtn.setAttribute('aria-label', t('player.restoreOriginal')));
    restoreBtn.addEventListener('click', () => this.restoreOrder());

    const queueBox = c.createDiv({ cls: 'vinyl-queue' });
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
      headerTitle,
      headerTitleText,
      queueModeBtn,
      playModeBtn,
      discOuter,
      vinyl,
      labelImg,
      labelEmpty,
      arm,
      progressSlider,
      timeEl,
      prevBtn,
      playBtn,
      nextBtn,
      volSlider,
      queueTitle,
      queueBox,
      clearQueueBtn,
      qualityEl,
    };
    return this.els;
  }

  // 「恢复原有顺序」（Vinyl order 行的 ↺ 按钮）：
  //   本地专辑按扫出来的文件名顺序播放，那本身就是它的「原有顺序」→ 只提示，不做任何事；
  //   在线专辑交给引擎就地排回原始顺序（不重新联网取专辑），并清掉存过的自定义顺序。
  //   队列来源看当前曲目（snapshot().current?.source）；还没开始播（index = -1）时退到队首曲目，
  //   否则「打开本地专辑但没点播放」会误走在线分支，把本地队列也重排一遍。
  private restoreOrder() {
    const snap = this.plugin.engine.snapshot();
    const source = snap.current?.source || snap.queue[0]?.source;
    if (source === 'local-vault' || source === 'local-external') {
      notice(t('player.restoreLocalUnsupported'));
      return;
    }
    this.plugin.engine.restoreOriginalOrder();
    notice(t('player.restoreDone'));
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
    // 队列模式开关 / 清空按钮的可见性（设置改了、段数变了都要跟着走）
    this.syncQueueControls(s.segments.length);
    // 播放模式按钮：图标随模式变，非默认（单次）时给个高亮色
    if (s.playMode !== this.lastPlayMode) {
      this.lastPlayMode = s.playMode;
      setIcon(els.playModeBtn, PLAY_MODE_ICON[s.playMode]);
      els.playModeBtn.toggleClass('is-active', s.playMode !== 'once');
    }
    this.queueRows.forEach((row, i) => row.classList.toggle('is-current', i === s.index));

    // 头部（错误并入标题行；值不变不写 DOM）
    const headerText =
      s.status === 'error' && s.error
        ? `⚠ ${s.error}`
        : s.status === 'loading'
          ? t('player.loading')
          : s.albumTitle
            ? `♪ ${s.albumTitle}`
            : t('player.title');
    if (headerText !== this.lastHeaderText) {
      this.lastHeaderText = headerText;
      els.headerTitleText.textContent = headerText;
      els.headerTitle.setAttribute('title', s.albumTitle || t('player.title'));
      els.headerTitle.toggleClass('is-error', s.status === 'error' && !!s.error);
    }

    // 实际音质读数（值不变不写 DOM；极高 / 无损给品牌红点缀）
    const readout = qualityReadout(s);
    if (readout !== this.lastReadout) {
      this.lastReadout = readout;
      els.qualityEl.textContent = readout;
      els.qualityEl.toggleClass('is-hq', s.quality === 'lossless' || s.quality === 'exhigh');
    }

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

    // 进度 / 计数器（值不变不写 DOM）
    const dur = Math.max(s.duration, s.currentTime);
    const ratioRaw = dur > 0 ? Math.min(1, s.currentTime / dur) : 0;
    const ratio = Math.round(ratioRaw * 1000);
    if (ratio !== this.lastRatio) {
      this.lastRatio = ratio;
      setVal(els.progressSlider, String(ratio));
      fillRange(els.progressSlider, ratioRaw, FILL_RED);
    }
    const timeText = `${fmtTime(s.currentTime)} / ${fmtTime(s.duration)}`;
    if (timeText !== this.lastTimeText) {
      this.lastTimeText = timeText;
      els.timeEl.textContent = timeText;
    }

    // 唱臂姿态（真实唱机关系，见 ARM_* 常量）：不播放归位支架；播放落针并沿侧 A 单调内移。
    // 取「曲序 + 本曲进度」而非单曲进度：整面唱片上唱针只进不退，换曲不跳回外圈。
    // loading 也保持落针，避免换曲瞬间唱臂来回摆。
    const onRecord = (s.status === 'playing' || s.status === 'loading') && s.queue.length > 0;
    let armAngle = ARM_PARKED;
    if (onRecord) {
      const trackRatio = dur > 0 ? Math.min(1, Math.max(0, s.currentTime / dur)) : 0;
      const sideRatio = Math.min(1, (s.index + trackRatio) / Math.max(1, s.queue.length));
      armAngle = ARM_OUTER + sideRatio * (ARM_INNER - ARM_OUTER);
    }
    if (Math.abs(armAngle - this.lastArmAngle) > 0.05) {
      this.lastArmAngle = armAngle;
      els.arm.style.setProperty('--vinyl-arm-angle', `${armAngle.toFixed(2)}deg`);
    }

    // 播放圆钮图标（状态变化才换）
    const wantIcon: 'play' | 'pause' = s.status === 'playing' ? 'pause' : 'play';
    if (wantIcon !== this.playIcon) {
      this.playIcon = wantIcon;
      setIcon(els.playBtn, wantIcon);
    }

    // 音量（银色填充；值不变不写）
    const vol = Math.round(s.volume * 100);
    if (vol !== this.lastVol) {
      this.lastVol = vol;
      setVal(els.volSlider, String(vol));
      fillRange(els.volSlider, s.volume, FILL_SILVER);
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
    // 「Vinyl order」是丝印品牌式的固定英文标签（与 'Vinyl Life' 同款）：中英同形，
    // 建 i18n 键会撞上「中英不得逐字相同」的词典测试，故保持硬编码。
    els.queueTitle.textContent = 'Vinyl order';
    // 段数变多 = 刚排入新专辑 → 记下来，画完闪一下（只在已经渲染过之后才比较）
    const grew = this.lastSegmentCount >= 0 && s.segments.length > this.lastSegmentCount;
    this.lastSegmentCount = s.segments.length;
    this.renderQueue(s, grew);
  }

  /** 按「专辑分段」画队列：一段 = 一张专辑（头部 + 它的曲目行）。
   *  只有一段时不画头部，保持单专辑队列原来的样子。 */
  private renderQueue(s: PlayerSnapshot, flashLast = false) {
    const els = this.els;
    if (!els) return;
    const box = els.queueBox;
    box.empty();
    this.queueRows = [];
    this.queueBadges = [];
    this.emptyQueueEl = null;
    this.segmentEls = [];
    this.renderedQueue = s.queue;

    this.renderedSegmentCount = s.segments.length;
    if (!s.queue.length) {
      this.emptyQueueEl = box.createDiv({ text: t('player.emptyQueue'), cls: 'vinyl-muted' });
      this.applyQueueLabels();
      return;
    }
    // 打乱模式下列表已被混排：按「段」分组失去意义（同一张专辑会碎成十几小段，
    // 每段挂一个重复标题与一个 ✕ 只会误导），所以只画平铺的行
    const multi = s.segments.length > 1 && s.playMode !== 'shuffle';
    for (const seg of s.segments) {
      const segEl = box.createDiv({ cls: 'vinyl-queue-segment' });
      segEl.dataset.start = String(seg.start);
      if (seg.current) segEl.addClass('is-current');
      if (multi) {
        const head = segEl.createDiv({ cls: 'vinyl-queue-segment-head' });
        head.createDiv({ text: seg.albumTitle || seg.albumPath, cls: 'vinyl-queue-segment-title' });
        const removeBtn = head.createEl('button', { cls: 'clickable-icon vinyl-queue-segment-remove' });
        setIcon(removeBtn, 'x');
        removeBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.plugin.engine.removeRange(seg.start, seg.count);
        });
        this.bindSegmentDrag(head, seg);
        this.segmentEls.push({ el: segEl, seg });
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
        row.createSpan({ text: String(i + 1).padStart(2, '0'), cls: 'vinyl-idx' });
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

  /** 队列模式开关与「清空后面的专辑」的当前状态。
   *  update() 与主动改设置的路径都要调 —— 只在 update() 里写的话，刚点完开关会看到状态滞后。 */
  private syncQueueControls(segmentCount: number) {
    const els = this.els;
    if (!els) return;
    els.queueModeBtn.toggleClass('is-active', this.plugin.settings.queueMode);
    els.clearQueueBtn.toggleClass('vinyl-hidden', segmentCount <= 1);
  }

  /** 播放模式按钮：切到下一档并弹一条提示（模式名随「队列模式」讲专辑还是讲列表） */
  private cyclePlayMode() {
    const mode = this.plugin.engine.cyclePlayMode();
    this.plugin.settings.playMode = mode;
    void this.plugin.saveSettings();
    notice(t(modeLabelKey(mode, this.plugin.settings.queueMode)));
    this.applyQueueLabels();
  }

  /** 专辑队列模式开关：改设置 + 提示；关掉时把队列收缩回当前专辑（用户定的语义） */
  private toggleQueueMode() {
    const on = !this.plugin.settings.queueMode;
    this.plugin.settings.queueMode = on;
    void this.plugin.saveSettings();
    if (!on) this.plugin.engine.keepCurrentAlbum();
    notice(t(on ? 'player.queueModeOn' : 'player.queueModeOff'));
    this.syncQueueControls(this.renderedSegmentCount);
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

  // 落盘入场（交接 C 阶段）：唱片滑入转盘
  private playEntrance(els: PlayerEls) {
    els.discOuter.getAnimations().forEach((a) => a.cancel());
    if (prefersReducedMotion()) return; // 减少动态效果：不播入场位移
    els.discOuter.animate(
      [
        { transform: 'scale(0.3) rotate(-30deg)', opacity: '0' },
        { transform: 'scale(1.02) rotate(0deg)', opacity: '1', offset: 0.72 },
        { transform: 'scale(1) rotate(0deg)', opacity: '1' },
      ],
      { duration: 360, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    );
  }

  private resetTurntable(els: PlayerEls) {
    els.vinyl.classList.remove('is-spinning', 'is-paused');
    els.vinyl.classList.add('is-empty');
    // 唱臂归位到支架（显式写死：CSS 变量可能停在播放中的角度上）
    els.arm.style.setProperty('--vinyl-arm-angle', `${ARM_PARKED}deg`);
    this.lastArmAngle = ARM_PARKED;
  }
}
