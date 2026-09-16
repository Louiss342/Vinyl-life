// 专辑墙视图（自绘 ItemView）：
//   工具栏：悬浮圆角长条 + 抽屉 —— 常态只有「专辑墙（N 张）」把手，点开才露出
//   搜索（防抖）/ 刷新 / 排序 / 音源筛选 / 卡片属性 / 批量删除 / 导入专辑 / 导入本地音频
//   批量删除：进入选择模式后点卡片勾选（Shift 连选），底部动作条确认删除（Esc 退出）
//   点击卡片 = 黑胶交接；拖拽音频入库；播放中卡片高亮 + 唱片离墙。
import {
  ItemView,
  WorkspaceLeaf,
  Menu,
  setIcon,
  TFile,
  TFolder,
  TAbstractFile,
  CachedMetadata,
} from 'obsidian';
import type VinylLifePlugin from '../main';
import type { PlayerSnapshot } from '../core/player-state';
import {
  AlbumInfo,
  findAlbumNotes,
  getAlbumInfo,
  detectAlbumSources,
  hasAlbumTag,
} from '../core/album-index';
import { DISC_DIRECTIONS, discTransform } from '../core/disc-motion';
import { queuedAlbumPaths } from '../core/queue';
import { animateDiscLiftOff } from '../animation/handoff';
import { RECORD_COLORS, recordClass } from '../core/appearance';
import {
  collectShelfPropKeys,
  propLabel,
  propPrefix,
  reorderShelfProp,
  resolveDropIndex,
  toggleShelfProp,
} from '../core/shelf-props';
import { rangeInList, toggleInList } from '../core/multi-select';
import { collectDroppedFiles, droppedRootName, isAudioFile, isImageFile, notice, prefersReducedMotion } from '../util';
// 手绘笔触用 roughjs（Excalidraw 内部同款引擎）。只引 SVG 那一支：canvas 渲染器用不上，
// 直接引包入口会把它一起打进来（实测多 2 KB）。线宽 / 虚线等公共参数见 hand-drawn.ts。
import { RoughSVG } from 'roughjs/bin/svg';
import { roughDashed, roughSolid, roundRectPath, SVG_NS } from './hand-drawn';
import { t, tf } from '../core/i18n';
import { SetCoverModal } from './set-cover-modal';
import { onMarqueeOver, onMarqueeOut } from './marquee';

export const SHELF_VIEW_TYPE = 'vinyl-shelf';

interface ShelfEntry {
  album: AlbumInfo;
  local: boolean;
  netease: boolean;
  qq: boolean;
}

type SortKey =
  | 'title-asc'
  | 'title-desc'
  | 'year-desc'
  | 'year-asc'
  | 'rating-desc'
  | 'plays-desc'
  | 'recent';
type SourceFilter = 'all' | 'local' | 'netease' | 'qq' | 'collect';

interface ShelfViewState {
  query: string;
  sort: SortKey;
  sourceFilter: SourceFilter;
}

// 用函数而不是常量：语言在设置里切换后，菜单标题要跟着变（常量在模块加载时就定型了）
const sortOptions = (): [SortKey, string][] => [
  ['title-asc', t('sort.titleAsc')],
  ['title-desc', t('sort.titleDesc')],
  ['year-desc', t('sort.yearDesc')],
  ['year-asc', t('sort.yearAsc')],
  ['rating-desc', t('sort.ratingDesc')],
  ['plays-desc', t('sort.playsDesc')],
  ['recent', t('sort.recent')],
];

const filterOptions = (): [SourceFilter, string][] => [
  ['all', t('filter.all')],
  ['local', t('filter.local')],
  ['netease', t('filter.netease')],
  ['qq', t('filter.qq')],
  ['collect', t('filter.collect')],
];

// 空态教程的图纸参数（Excalidraw 设计稿 Drawing 2026-09-15 14.14.52，1 图纸单位 = 1px）。
// 笔触一律交给 roughjs（Excalidraw 用的同一套手绘引擎），线宽 / 虚线 / roughness 等公共参数
// 在 views/hand-drawn.ts（与「关于」页共用），这里只留这张图纸自己的比例与种子 ——
// 每个图形的 seed 都照搬图纸，抖动纹路才对得上。
// 版面比例：框顶 = 线圈底 + 82（视图不够高时的下限）；箭尾贴框右缘（+6）且落在框的垂直中点；
// 折点 = 尾 + (70.3%, 42.9%) 的「尾→尖」向量；箭尖压在圈底（+1px、圈心右偏 2px）。
// 只有「两个按钮在哪」是从 DOM 现量的，其余比例照搬，窗口怎么变都指着按钮。
const TUT = {
  bendRatioX: 0.703,
  bendRatioY: 0.429,
  tailPad: 6,
  boxTopFromRing: 82,
  bottomPad: 48, // 整块离视图底部的余量：视觉重心压在左下；视图不够高时退回去贴线圈（见 layoutTutorial）
  ringPadX: 16, // 虚线圈 = 两个按钮外扩（图纸 106×45 ≈ 按钮 74×23 + 2×16 / 2×11）
  ringPadY: 11,
  minRoomX: 120, // 拐弯箭头与文本框之间的净空：不足就整条藏掉（窄面板 / 手机）
  minSideX: 60, // 直箭头同理：太短就不画
  headLen: 23.5, // 箭头头部：图纸导出 SVG 实测（箭尖往后 23.5、两侧 ±8.55，两笔实线）
  headHalf: 8.55,
  seed: {
    box1: 1563201844,
    box2: 540552628,
    arrowStraight: 283137332,
    arrowBent: 582803468,
    ring: 1170450060,
  },
} as const;

/** 箭头头部两笔的端点：从箭尖沿 -dir 收 headLen，两侧各偏 headHalf（dir 为单位方向） */
const arrowHeadPoints = (tip: { x: number; y: number }, dir: { x: number; y: number }) => {
  const bx = tip.x - dir.x * TUT.headLen;
  const by = tip.y - dir.y * TUT.headLen;
  const px = -dir.y * TUT.headHalf;
  const py = dir.x * TUT.headHalf;
  return { tip, a: { x: bx + px, y: by + py }, b: { x: bx - px, y: by - py } };
};

/** 单位方向（箭头头部按箭尖处切线方向张开） */
const unitVector = (from: { x: number; y: number }, to: { x: number; y: number }) => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const m = Math.hypot(dx, dy) || 1;
  return { x: dx / m, y: dy / m };
};

export class VinylShelfView extends ItemView {
  private plugin: VinylLifePlugin;
  private unsub: (() => void) | null = null;
  private entries: ShelfEntry[] = [];
  private cardEls = new Map<string, HTMLElement>();
  private refreshTimer: number | null = null;
  private lastSnap: PlayerSnapshot | null = null;
  private state: ShelfViewState = { query: '', sort: 'title-asc', sourceFilter: 'all' };
  private toolbarTitle: HTMLElement | null = null;
  private toolbarEl: HTMLElement | null = null;
  private toolbarToggle: HTMLButtonElement | null = null; // 抽屉把手（空墙时没有：固定展开）
  private drawerOpen = false; // 抽屉：常态收起（只露计数），点一下弹出任务栏
  private drawerForced = false; // 空墙：抽屉固定展开（教程要指着导入按钮），把手退化成纯标题
  // 批量删除（选择模式）：点卡片 = 选 / 取消选，Shift = 连选，Esc 退出
  private batch: { active: boolean; selection: string[]; anchor: string } = {
    active: false,
    selection: [],
    anchor: '',
  };
  private batchBtn: HTMLElement | null = null; // 工具栏里的「批量删除」入口
  private batchBarEl: HTMLElement | null = null; // 底部动作条
  private batchCountEl: HTMLElement | null = null;
  private batchAllBtn: HTMLButtonElement | null = null; // 全选 / 清空（同一枚，文案与图标随状态换）
  private batchDeleteBtn: HTMLButtonElement | null = null;
  private gridHost: HTMLElement | null = null;
  private importGroupEl: HTMLElement | null = null; // 工具栏最后两个按钮（导入专辑 / 导入本地音频）
  private propsPopover: HTMLElement | null = null;
  private onDocClick: ((ev: MouseEvent) => void) | null = null;
  private dragKey: string | null = null; // 卡片属性弹层：正在拖拽的属性键
  private dropAt: { key: string; after: boolean } | null = null; // 当前落点（在 key 行之前/之后）
  // 空态教程（Excalidraw 设计稿移植）：root 是盖在视图上的纯装饰层，
  // ink 里是 roughjs 现画的框 / 圈 / 箭头，几何在 layoutTutorial() 里算
  private tutorial: {
    root: HTMLElement;
    main: HTMLElement;
    title: HTMLElement;
    box1: HTMLElement;
    box2: HTMLElement;
    svg: SVGSVGElement;
    ink: SVGGElement;
    here: HTMLElement;
  } | null = null;
  private tutorialRO: ResizeObserver | null = null;
  private settleRaf = 0; // 教程布局的「定型补枪」（见 settleTutorial）
  private settleTimers: number[] = [];

  constructor(leaf: WorkspaceLeaf, plugin: VinylLifePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return SHELF_VIEW_TYPE;
  }

  getDisplayText() {
    return t('shelf.title');
  }

  getIcon() {
    return 'library';
  }

  async onOpen() {
    // 性能：metadataCache 事件只响应「专辑相关」文件，避免任意笔记编辑触发全库扫描
    this.registerEvent(
      this.plugin.app.metadataCache.on('changed', (file: TFile, _data: string, cache: CachedMetadata) => {
        if (file.extension !== 'md') return;
        const isAlbumNow = !!cache?.frontmatter && hasAlbumTag(cache.frontmatter);
        const inAlbumFolder = file.path.startsWith(this.plugin.settings.albumFolder);
        const wasAlbum = this.entries.some((e) => e.album.path === file.path);
        if (isAlbumNow || inAlbumFolder || wasAlbum) this.scheduleRefresh();
      })
    );
    this.registerEvent(
      this.plugin.app.metadataCache.on('deleted', (file: TFile) => {
        if (file.extension !== 'md') return;
        const wasAlbum = this.entries.some((e) => e.album.path === file.path);
        if (wasAlbum || file.path.startsWith(this.plugin.settings.albumFolder)) {
          this.scheduleRefresh();
        }
      })
    );
    // 性能：vault 层事件比 metadataCache 更频繁（音频/封面是普通文件，不走 md 缓存），
    // 只认「音频 / 图片 / 文件夹」三类，其余（笔记、插件文件、配置…）直接早退，不触发任何工作。
    //   音频增删改 → 本地音源角标；图片增删改 → 封面自动识别；文件夹增删改名 → 专辑音频目录失效。
    // 导入一批音频会连着触发几十个 create，统一交给 scheduleRefresh 防抖合并（500ms 内只扫一次库）。
    const onVaultChanged = (f: TAbstractFile, oldPath?: string) => {
      if (f instanceof TFolder) {
        this.scheduleRefresh();
        return;
      }
      if (!(f instanceof TFile)) return;
      // rename 时旧名一并判：音频/封面被改名成其他后缀等于离开了专辑目录，角标同样要重算
      const related = (name: string) => isAudioFile(name) || isImageFile(name);
      if (related(f.name) || (!!oldPath && related(oldPath))) this.scheduleRefresh();
    };
    this.registerEvent(this.plugin.app.vault.on('create', (f: TAbstractFile) => onVaultChanged(f)));
    this.registerEvent(this.plugin.app.vault.on('delete', (f: TAbstractFile) => onVaultChanged(f)));
    this.registerEvent(
      this.plugin.app.vault.on('rename', (f: TAbstractFile, oldPath: string) =>
        onVaultChanged(f, oldPath)
      )
    );
    // 卡片文字的悬停滚动：委托挂在 contentEl 上（卡片每次刷新都重建，逐张挂监听会白挂随卡片丢弃的一堆）
    this.registerDomEvent(this.contentEl, 'pointerover', (ev) => onMarqueeOver(ev));
    this.registerDomEvent(this.contentEl, 'pointerout', (ev) => onMarqueeOut(ev));
    // 键盘等价操作：卡片上 Enter / 空格 = 点击
    this.registerDomEvent(this.contentEl, 'keydown', (ev) => this.onShelfKeydown(ev));
    this.unsub = this.plugin.engine.subscribe((s) => this.updatePlaying(s));
    // 空态教程：视图尺寸一变（窗口 / 侧边栏开合）就重算线圈与箭头的位置；没有教程时空转
    this.tutorialRO = new ResizeObserver(() => this.layoutTutorial());
    this.tutorialRO.observe(this.contentEl);
    this.registerDomEvent(this.contentEl, 'scroll', () => this.layoutTutorial());
    // 工作区布局变化（分屏 / 标签移动 / 恢复布局）时容器尺寸可能几帧内还在变，补一次布局
    this.registerEvent(this.app.workspace.on('layout-change', () => this.layoutTutorial()));
    this.render();
  }

  async onClose() {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.tutorialRO?.disconnect();
    this.tutorialRO = null;
    this.cancelTutorialSettle();
    this.closePropsPopover();
  }

  /** 键盘等价：卡片上 Enter / 空格 = 点击（role=button 的常规语义）。
   *  卡片内部没有输入控件，所以不用区分按在卡片里的哪个位置。 */
  private onShelfKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
      const el = ev.target as HTMLElement | null;
      if (!el || typeof el.closest !== 'function') return;
      const card = el.closest<HTMLElement>('.vinyl-shelf-card');
      if (!card) return;
      ev.preventDefault(); // 空格默认会滚动面板
      card.click();
      return;
    }
    // 选择模式：Esc 退出（与播放器唱片区同一处手势，别让用户找半天出口）
    if (ev.key === 'Escape' && this.batch.active) {
      ev.preventDefault();
      this.exitBatch();
    }
  }

  private scheduleRefresh() {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      const before = this.shelfSignature();
      this.loadEntries();
      if (before !== this.shelfSignature()) this.render();
      // 签名不变但弹层开着：候选计数可能已变（新增字段但尚未显示）→ 就地重绘，不关层
      else if (this.propsPopover) this.renderPropsPopover(this.propsPopover);
    }, 500);
  }

  // 内容签名（路径 + 已显示属性取值）：改 frontmatter 后卡片即时更新，而不只在增删专辑时
  private shelfSignature(): string {
    const keys = this.plugin.settings.shelfProps;
    return this.entries
      .map((e) => `${e.album.path}\u0001${keys.map((k) => e.album.displayProps[k] ?? '').join('\u0002')}`)
      .sort()
      .join('\u0003');
  }

  private loadEntries() {
    this.entries = findAlbumNotes(this.plugin.app)
      .map((f) =>
        getAlbumInfo(this.plugin.app, f, { coverFolder: this.plugin.settings.coverFolder })
      )
      .filter((a): a is AlbumInfo => !!a)
      .map((album) => {
        const src = detectAlbumSources(this.plugin.app, album);
        return { album, local: src.local, netease: src.netease, qq: src.qq };
      });
  }

  // ============ 渲染 ============

  render() {
    this.loadEntries();
    this.closePropsPopover();
    const c = this.contentEl;
    c.empty();
    c.addClass('vinyl-shelf');
    this.applyAppearance();
    this.cardEls.clear();
    // 工具栏 / 动作条的元素随旧 DOM 一起没了：先把引用清掉，免得重建间隙里的回调摸到 detached 节点
    this.toolbarEl = null;
    this.toolbarToggle = null;
    this.toolbarTitle = null;
    this.batchBtn = null;
    this.batchBarEl = null;
    this.batchCountEl = null;
    this.batchAllBtn = null;
    this.batchDeleteBtn = null;
    this.renderToolbar(c);
    this.gridHost = c.createDiv({ cls: 'vinyl-shelf-grid-host' });
    this.renderGrid();
    this.renderBatchBar(c);
    this.syncBatch(); // 重建后再把选择模式的整体状态铺回去（卡片是新 DOM）
  }

  /** 卡片属性变更后的就地刷新（main.refreshShelfProps 广播给所有专辑墙视图）：
   *  重建卡片行 + 刷新已打开的弹层（计数 / 已选区） */
  refreshProps() {
    this.renderGrid();
    if (this.propsPopover) this.renderPropsPopover(this.propsPopover);
  }

  // 外观（设置 → 外观）：唱片弹出方向 + 每行卡片数 + 唱片配色，仅换类与 CSS 变量，不重建卡片
  applyAppearance() {
    const c = this.contentEl;
    const dir = this.plugin.settings.discDirection || 'right';
    for (const d of DISC_DIRECTIONS) c.toggleClass(`is-disc-${d}`, d === dir);
    const color = this.plugin.settings.recordColor;
    for (const v of RECORD_COLORS) c.toggleClass(recordClass(v), v === color);
    const cols = this.plugin.settings.shelfColumns;
    c.style.setProperty(
      '--vinyl-shelf-columns',
      cols === 'auto' || !cols
        ? 'repeat(auto-fill, minmax(230px, 1fr))'
        : `repeat(${cols}, minmax(0, 1fr))`
    );
  }

  // 工具栏 = 悬浮圆角长条 + 抽屉（样式见 styles.css 的「专辑墙视图」段）：
  //   常态只有一枚「专辑墙（N 张）⌄」把手，点开才露出搜索 / 各功能按钮（任务栏）。
  //   空墙例外：教程那张图上虚线箭头指着导入按钮，抽屉固定展开，把手退化成纯标题。
  private renderToolbar(c: HTMLElement) {
    const bar = c.createDiv({ cls: 'vinyl-shelf-toolbar' });
    this.toolbarEl = bar; // 教程层要量它的高度（窄视图工具栏换行时别被压住）
    this.drawerForced = !this.entries.length;
    if (this.drawerForced || this.drawerOpen) bar.addClass('is-open');

    // 抽屉把手：标题计数（+ 展开态雪佛龙）。forceOpen 时是 div —— 没有可点的东西，别做成假按钮。
    // 箭头是横向的：抽屉朝右铺开，收起时朝右（点它向右展开），展开后转 180° 朝左（点它收回来）
    const head = this.drawerForced
      ? bar.createDiv({ cls: 'vinyl-shelf-toolbar-toggle is-static' })
      : bar.createEl('button', { cls: 'vinyl-shelf-toolbar-toggle' });
    this.toolbarToggle = this.drawerForced ? null : (head as HTMLButtonElement);
    this.toolbarTitle = head.createDiv({ cls: 'vinyl-shelf-toolbar-title' });
    if (this.toolbarToggle) {
      const chevron = head.createSpan({ cls: 'vinyl-shelf-toggle-chevron' });
      setIcon(chevron, 'chevron-right');
      this.toolbarToggle.setAttribute('aria-expanded', String(this.drawerOpen));
      this.toolbarToggle.addEventListener('click', () => {
        this.drawerOpen = !this.drawerOpen;
        this.syncDrawer();
      });
    }

    // 任务栏的控件直接平铺在条上（不再套一层内层 flex 容器）：嵌套的「换行 flex」会让 Chromium
    // 把整条的 max-content 算小 —— 展开后明明放得下，导入组还是被挤到第二行（实测 977px 宽的
    // 视图里整条只量到 589px，2 行）。平铺后按真实内容量宽，只在真的放不下时才换行。
    // 收起时的隐藏 / 展开时的入场动画都按「条的直接子元素」写（见 styles.css）。

    // 搜索（防抖 200ms，只重建网格保持输入焦点）
    const searchWrap = bar.createDiv({ cls: 'vinyl-shelf-search' });
    const input = searchWrap.createEl('input', {
      attr: { type: 'search', placeholder: t('shelf.search') },
    });
    input.value = this.state.query;
    let timer: number | null = null;
    input.addEventListener('input', () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        this.state.query = input.value.trim();
        this.renderGrid();
      }, 200);
    });

    // 按钮都建在 host 里：前四个 + 批量删除直接进任务栏，最后两个（导入）先进一个组 ——
    // 空态教程的虚线圈要圈住这一组（见 buildTutorial / layoutTutorial）
    let host: HTMLElement = bar;
    const mk = (icon: string, title: string, fn: (ev: MouseEvent) => void) => {
      // Obsidian 原生图标按钮（浅色底 + 黑色线形图标，随主题自适应，清晰易识别）
      const b = host.createEl('button', { cls: 'clickable-icon vinyl-toolbar-icon' });
      setIcon(b, icon);
      // 只设 aria-label：Obsidian 按它渲染样式化提示，再设 title 会多弹一个浏览器原生提示（两个气泡）
      b.setAttribute('aria-label', title);
      b.addEventListener('click', fn);
      return b;
    };
    mk('refresh-cw', t('shelf.refresh'), () => this.render());
    mk('arrow-up-down', t('shelf.sort'), (ev) => this.showSortMenu(ev));
    mk('filter', t('shelf.filter'), (ev) => this.showFilterMenu(ev));
    mk('sliders-horizontal', t('shelf.props'), (ev) => this.showPropsPopover(ev));
    // 批量删除：没有专辑可删时不出现（空墙只有一个出路 —— 导入）
    this.batchBtn = this.entries.length
      ? mk('trash-2', t('shelf.batchDelete'), () => this.toggleBatch())
      : null;
    if (this.batchBtn) this.batchBtn.setAttribute('aria-pressed', 'false');
    host = bar.createDiv({ cls: 'vinyl-shelf-import-group' });
    this.importGroupEl = host;
    mk('cloud-download', t('shelf.importAlbum'), () => this.plugin.openAlbumImport());
    mk('upload', t('shelf.importAudio'), () => this.plugin.openLocalImport());
  }

  /** 抽屉把手的状态回写（展开 / 收起 + 读屏状态 + 提示文案），不动 DOM 结构。
   *  计数文案由 renderGrid 写好后调这里刷新 aria-label（筛选态下数字会变）。 */
  private syncDrawer() {
    const open = this.drawerForced || this.drawerOpen;
    this.toolbarEl?.toggleClass('is-open', open);
    if (!this.toolbarToggle) return; // 空墙：固定展开，没有把手
    this.toolbarToggle.setAttribute('aria-expanded', String(open));
    this.toolbarToggle.setAttribute(
      'aria-label',
      `${this.toolbarTitle?.textContent ?? ''}｜${t(open ? 'shelf.collapse' : 'shelf.expand')}`
    );
  }

  // ============ 批量删除（选择模式）============
  // 入口在工具栏；进模式后卡片变成「勾选框」：点 = 选 / 取消选、Ctrl / ⌘ 同义、Shift = 连选，
  // 手势原语与播放器唱片区共用（core/multi-select）。底部浮出一条动作条（已选计数 / 全选 / 删除 / 退出）。

  private toggleBatch() {
    if (this.batch.active) this.exitBatch();
    else this.enterBatch();
  }

  private enterBatch() {
    if (!this.entries.length) return;
    this.batch = { active: true, selection: [], anchor: '' };
    this.syncBatch();
  }

  /** 退出选择模式（Esc / 动作条退出按钮 / 删完收工都走这里） */
  private exitBatch() {
    if (!this.batch.active) return;
    this.batch = { active: false, selection: [], anchor: '' };
    this.syncBatch();
  }

  /** 当前显示的专辑路径（按显示顺序）：Shift 连选 / 全选都以「眼前看到的」为准 */
  private visiblePaths(): string[] {
    return this.applyViewFilters().map((e) => e.album.path);
  }

  private pickForBatch(path: string, ev: MouseEvent) {
    this.batch.selection = ev.shiftKey
      ? rangeInList(this.batch.selection, this.visiblePaths(), this.batch.anchor || path, path)
      : toggleInList(this.batch.selection, path);
    this.batch.anchor = path;
    this.syncBatch();
  }

  /** 全选 / 清空（同一枚按钮：视窗里都选上了就切到「清空选择」） */
  private toggleSelectAll() {
    const all = this.visiblePaths();
    const picked = new Set(this.batch.selection);
    const allPicked = all.length > 0 && all.every((p) => picked.has(p));
    this.batch.selection = allPicked
      ? []
      : [...this.batch.selection, ...all.filter((p) => !picked.has(p))];
    this.batch.anchor = all.length && !allPicked ? all[all.length - 1] : '';
    this.syncBatch();
  }

  private openBatchDelete() {
    const picked = new Set(this.batch.selection);
    const albums = this.entries.filter((e) => picked.has(e.album.path)).map((e) => e.album);
    if (!albums.length) return;
    this.plugin.openDeleteAlbums(albums, () => this.exitBatch());
  }

  /** 底部动作条（选择模式）：居中悬浮的小圆条 —— 与顶部工具栏同一种「浮起来」的观感 */
  private renderBatchBar(c: HTMLElement) {
    const bar = c.createDiv({ cls: 'vinyl-shelf-batchbar' });
    this.batchBarEl = bar;
    this.batchCountEl = bar.createDiv({ cls: 'vinyl-shelf-batch-count' });
    const mk = (icon: string, label: string, fn: () => void) => {
      const b = bar.createEl('button', { cls: 'vinyl-btn vinyl-btn-small' });
      setIcon(b, icon);
      b.setAttribute('aria-label', label);
      b.addEventListener('click', fn);
      return b;
    };
    this.batchAllBtn = mk('list-checks', t('batch.selectAll'), () => this.toggleSelectAll());
    this.batchDeleteBtn = mk('trash-2', t('batch.delete'), () => this.openBatchDelete());
    this.batchDeleteBtn.addClass('is-danger');
    mk('x', t('batch.exit'), () => this.exitBatch());
  }

  /** 选择模式的整体状态回写：进入 / 退出、卡片勾选态、动作条、工具栏入口按钮 */
  private syncBatch() {
    const active = this.batch.active;
    const picked = new Set(this.batch.selection);
    this.contentEl.toggleClass('is-batching', active);
    for (const [path, el] of this.cardEls) {
      const on = active && picked.has(path);
      el.toggleClass('is-batch-selected', on);
      // 读屏：选择模式里卡片是「开关」，把选中态报出来（退出时撤掉，别把卡片变成开关语义）
      if (active) el.setAttribute('aria-pressed', on ? 'true' : 'false');
      else el.removeAttribute('aria-pressed');
    }
    if (this.batchBarEl) {
      this.batchBarEl.toggleClass('is-on', active);
      if (this.batchCountEl) {
        this.batchCountEl.textContent = tf('batch.selected', { n: this.batch.selection.length });
      }
      if (this.batchDeleteBtn) this.batchDeleteBtn.disabled = !this.batch.selection.length;
      if (this.batchAllBtn && active) {
        const all = this.visiblePaths();
        const allPicked = all.length > 0 && all.every((p) => picked.has(p));
        setIcon(this.batchAllBtn, allPicked ? 'x' : 'list-checks');
        this.batchAllBtn.setAttribute('aria-label', t(allPicked ? 'batch.clear' : 'batch.selectAll'));
      }
    }
    if (this.batchBtn) {
      this.batchBtn.toggleClass('is-active', active);
      this.batchBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
      this.batchBtn.setAttribute('aria-label', t(active ? 'batch.exit' : 'shelf.batchDelete'));
    }
  }

  private renderGrid() {
    if (!this.gridHost) return;
    this.gridHost.empty();
    this.cardEls.clear();
    this.clearTutorial(); // 教程层挂在视图上而不是网格里，要单独收

    // 选择模式：专辑可能已被删掉 / 改名（卡片是快照）→ 选择表里去掉不存在的；
    // 墙空了就自动退出模式（否则底下还浮着一条「已选 N 张」却没东西可选）
    if (this.batch.active) {
      const alive = new Set(this.entries.map((e) => e.album.path));
      this.batch.selection = this.batch.selection.filter((p) => alive.has(p));
      if (!this.entries.length) this.batch.active = false;
    }

    const shown = this.applyViewFilters();
    const filtered = !!this.state.query || this.state.sourceFilter !== 'all';
    if (this.toolbarTitle) {
      this.toolbarTitle.textContent = filtered
        ? tf('shelf.titleFiltered', { shown: shown.length, total: this.entries.length })
        : tf('shelf.titleWithCount', { n: this.entries.length });
    }
    this.syncDrawer(); // 计数变了：把手上的 aria-label 跟着换

    if (!this.entries.length) {
      // 一张专辑都没有（新装也是这样）：直接给图纸上那份「图文教程」
      this.buildTutorial();
      this.syncBatch();
      return;
    }
    if (!shown.length) {
      const empty = this.gridHost.createDiv({ cls: 'vinyl-shelf-empty' });
      empty.createDiv({ text: t('shelf.filtered.title'), cls: 'vinyl-shelf-empty-title' });
      empty.createDiv({ text: t('shelf.filtered.hint'), cls: 'vinyl-muted' });
      this.syncBatch();
      return;
    }

    const grid = this.gridHost.createDiv({ cls: 'vinyl-shelf-grid' });
    for (const e of shown) {
      grid.appendChild(this.buildCard(e));
    }
    this.wireGridDrop(grid);
    if (this.lastSnap) this.updatePlaying(this.lastSnap);
    this.syncBatch(); // 卡片是新 DOM：把勾选态铺回去
  }

  // ============ 空态教程 ============
  // 版面照搬 Excalidraw 设计稿 Drawing 2026-09-15 14.14.52：标题 + 两个虚线框 + 页脚是一列居中文本，
  // 右侧拐弯箭头指向工具栏最后两个按钮（虚线圈圈住它们），直箭头指着右边栏（播放器在那儿）。
  // 整块靠左下摆（框宽按英文文案放宽到 600px，垂直方向压到视图底部，见 layoutTutorial），
  // 整层 pointer-events: none，纯装饰：按钮、卡片、拖拽导入一概不受影响。

  private clearTutorial() {
    this.cancelTutorialSettle();
    this.tutorial?.root.remove();
    this.tutorial = null;
  }

  /** 教程层刚建好时容器未必定型：视图创建 / 工作区恢复的头几帧量到的是过渡尺寸
   *  （实测：重载插件后首帧量到的是恢复前的窄尺寸，而 ResizeObserver 不会因为「已经定型」再报一次，
   *  整块就停在过渡位置，直到用户手动缩放窗口）。所以头几帧连着补几次布局，另加两枪定时兜底；
   *  布局是幂等的，尺寸稳了以后多跑的几次只是重画一遍，没有副作用，全部在下一次渲染 / 关视图时取消。 */
  private settleTutorial() {
    this.cancelTutorialSettle();
    let frames = 0;
    const tick = () => {
      this.settleRaf = 0;
      if (!this.tutorial) return;
      this.layoutTutorial();
      if (++frames < 8) this.settleRaf = window.requestAnimationFrame(tick);
    };
    this.settleRaf = window.requestAnimationFrame(tick);
    for (const ms of [300, 1200]) {
      this.settleTimers.push(window.setTimeout(() => this.layoutTutorial(), ms));
    }
  }

  private cancelTutorialSettle() {
    if (this.settleRaf) {
      window.cancelAnimationFrame(this.settleRaf);
      this.settleRaf = 0;
    }
    for (const id of this.settleTimers) window.clearTimeout(id);
    this.settleTimers = [];
  }

  private buildTutorial() {
    this.clearTutorial();
    const root = this.contentEl.createDiv({ cls: 'vinyl-tutorial' });
    const main = root.createDiv({ cls: 'vinyl-tutorial-main' });
    const title = main.createDiv({ cls: 'vinyl-tutorial-title', text: t('shelf.tutorial.title') });
    // 第一个虚线框：五句话照图纸顺序（一处一行，交给 CSS 居中 + 行距 2）
    const box1 = main.createDiv({ cls: 'vinyl-tutorial-box' });
    box1.createDiv({ text: t('shelf.tutorial.emptyTitle') });
    box1.createDiv({ text: t('shelf.tutorial.importA') });
    box1.createDiv({ text: t('shelf.tutorial.importB') });
    box1.createDiv({ text: t('shelf.tutorial.onlineOnly') });
    box1.createDiv({ text: t('shelf.tutorial.moreSoon') });
    // 第二个虚线框：播放器在哪
    const box2 = main.createDiv({ cls: 'vinyl-tutorial-box is-small' });
    box2.createDiv({ text: t('shelf.tutorial.playerSidebar') });
    box2.createDiv({ text: t('shelf.tutorial.playAfterImport') });
    main.createDiv({ cls: 'vinyl-tutorial-foot', text: t('shelf.tutorial.loginNote') });

    // SVG 用 createElementNS 建：createEl('svg') 出来的是 HTML 元素，path / ellipse 属性不生效。
    // 走 ownerDocument：视图可能在弹出窗口里（跨文档 appendChild 会被收养，但要在对的文档里建）
    const doc = this.contentEl.ownerDocument;
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'vinyl-tutorial-svg');
    const ink = doc.createElementNS(SVG_NS, 'g'); // 所有手绘图形都画在这一层里（每次布局重画）
    ink.setAttribute('class', 'vinyl-tutorial-ink');
    svg.appendChild(ink);
    root.appendChild(svg);
    const here = root.createDiv({ cls: 'vinyl-tutorial-here', text: t('shelf.tutorial.playerHere') });

    this.tutorial = { root, main, title, box1, box2, svg, ink, here };
    this.layoutTutorial();
    this.settleTutorial();
  }

  /** 把图纸坐标落到当前视图上：虚线框套住文本、虚线圈圈住最后两个按钮、两条箭头连到各自目标。
   *  图形全部用 roughjs 现场重画（尺寸一变位置就变，静态路径没法复用），参数与设计稿逐项对齐。 */
  private layoutTutorial() {
    const T = this.tutorial;
    const group = this.importGroupEl;
    if (!T || !T.root.isConnected || !group || !group.isConnected) return;
    const base = T.root.getBoundingClientRect(); // 教程层铺满视图内容区，作为统一坐标原点
    const btn = group.getBoundingClientRect();
    if (!base.width || !btn.width) return;

    const cx = btn.left + btn.width / 2 - base.left;
    const cy = btn.top + btn.height / 2 - base.top;
    const rx = btn.width / 2 + TUT.ringPadX;
    const ry = btn.height / 2 + TUT.ringPadY;
    const ringBottom = cy + ry;

    // 文本块：图纸上第一个虚线框顶 = 线圈底 + 82；框顶往上 20 是标题，所以整块再上移标题高 + 20。
    // 窄视图里工具栏会换行变高，这一条会把标题顶进工具栏 —— 加一道下限，最多贴到工具栏下方。
    const bar = this.toolbarEl?.getBoundingClientRect();
    const belowBar = bar ? bar.bottom - base.top + 24 : 0;
    const minTop = Math.max(ringBottom + TUT.boxTopFromRing - T.title.offsetHeight - 20, belowBar);
    // 视觉重心落在左下：整块默认压到视图底部（离底 bottomPad），视图不够高就退回 minTop（贴着线圈下方）。
    // 两道下限合起来保证任何尺寸下既不压工具栏、也不冒到视图外 —— 箭头跟着整块一起变长，不用单独调。
    const top = Math.max(minTop, base.height - T.main.offsetHeight - TUT.bottomPad);
    T.main.style.top = `${Math.round(top)}px`;

    const b1 = T.box1.getBoundingClientRect();
    const b2 = T.box2.getBoundingClientRect();
    const box1Mid = b1.top - base.top + b1.height / 2;
    const box2Mid = b2.top - base.top + b2.height / 2;

    // 拐弯箭头：箭尖压在圈底（图纸比圈底低 1px、比圈心右偏 2px）；尾巴锚在第一个虚线框右缘中点
    // —— 图纸里箭头就是绑在这个位置的，所以不管视图多宽，箭头都长在文本框上，不会飘出去。
    const tip = { x: cx + 2, y: ringBottom + 1 };
    const box1Right = b1.right - base.left;
    const roomX = tip.x - (box1Right + TUT.tailPad); // 文本框右缘到箭尖的净空
    const tight = roomX < TUT.minRoomX;

    // 直箭头：与第二个虚线框中线齐平，从框右缘一路指到视图右缘（侧边栏 = 播放器的落脚处）。
    // 视图窄时这段净空本来就没有（CSS 用 is-narrow 藏掉），这里再兜一道：太短干脆不画。
    const y2 = box2Mid;
    const x1 = base.width - 2;
    const x0 = Math.min(b2.right - base.left + TUT.tailPad, x1 - 40);
    const drawSide = x1 - x0 >= TUT.minSideX;

    // —— 手绘图形：清掉上一轮，按当下尺寸重画（种子 / roughness / 虚线都照设计稿）——
    const rc = new RoughSVG(T.svg);
    T.ink.replaceChildren();
    const inkAdd = (nodes: ArrayLike<Element> | Element) => {
      const list = nodes instanceof Element ? [nodes] : Array.from(nodes);
      for (const n of list) T.ink.appendChild(n);
    };
    // roughjs 写的描边是 stroke="currentColor"，颜色由 .vinyl-tutorial-ink 的 CSS 变量给（主题切换自动跟随）

    // 两个虚线框（图纸：roughness 2 的圆角矩形）
    inkAdd(
      rc.path(
        roundRectPath({ x: b1.left - base.left, y: b1.top - base.top, w: b1.width, h: b1.height }),
        roughDashed(TUT.seed.box1, 2)
      )
    );
    inkAdd(
      rc.path(
        roundRectPath({ x: b2.left - base.left, y: b2.top - base.top, w: b2.width, h: b2.height }),
        roughDashed(TUT.seed.box2, 2)
      )
    );

    // 虚线圈（图纸：roughness 2 的椭圆，curveFitting 1）
    inkAdd(rc.ellipse(cx, cy, rx * 2, ry * 2, { ...roughDashed(TUT.seed.ring, 2), curveFitting: 1 }));

    // 拐弯箭头（图纸：roughness 2；杆是过三点的曲线，头是两笔实线）
    if (!tight) {
      const tail = { x: box1Right + TUT.tailPad, y: box1Mid };
      const bend = {
        x: tail.x + TUT.bendRatioX * (tip.x - tail.x),
        y: tail.y + TUT.bendRatioY * (tip.y - tail.y),
      };
      inkAdd(
        rc.curve(
          [
            [tail.x, tail.y],
            [bend.x, bend.y],
            [tip.x, tip.y],
          ],
          roughDashed(TUT.seed.arrowBent, 2)
        )
      );
      const h = arrowHeadPoints(tip, unitVector(bend, tip));
      inkAdd([rc.line(h.tip.x, h.tip.y, h.a.x, h.a.y, roughSolid(TUT.seed.arrowBent + 1)), rc.line(h.tip.x, h.tip.y, h.b.x, h.b.y, roughSolid(TUT.seed.arrowBent + 2))]);
    }

    // 直箭头（图纸：roughness 1，箭尖顶到视图右缘）
    if (drawSide) {
      const p0 = { x: x0, y: y2 };
      const p1 = { x: x1, y: y2 };
      inkAdd(
        rc.curve(
          [
            [p0.x, p0.y],
            [p1.x, p1.y],
          ],
          roughDashed(TUT.seed.arrowStraight, 1)
        )
      );
      const h = arrowHeadPoints(p1, unitVector(p0, p1));
      inkAdd([rc.line(h.tip.x, h.tip.y, h.a.x, h.a.y, roughSolid(TUT.seed.arrowStraight + 1)), rc.line(h.tip.x, h.tip.y, h.b.x, h.b.y, roughSolid(TUT.seed.arrowStraight + 2))]);
      T.here.style.left = `${Math.round((x0 + x1) / 2)}px`;
      T.here.style.top = `${Math.round(y2 - 4)}px`;
    }

    T.root.toggleClass('is-tight', tight);
    // 太窄：直箭头和「大概是在这里」没有落脚处，只留线圈 / 拐弯箭头 / 文本（CSS 里藏）
    T.root.toggleClass('is-narrow', base.width < 560);
  }

  // 搜索 / 筛选 / 排序
  private applyViewFilters(): ShelfEntry[] {
    const q = this.state.query.toLowerCase();
    const list = this.entries.filter((e) => {
      if (this.state.sourceFilter === 'local' && !e.local) return false;
      if (this.state.sourceFilter === 'netease' && !e.netease) return false;
      if (this.state.sourceFilter === 'qq' && !e.qq) return false;
      if (this.state.sourceFilter === 'collect' && (e.local || e.netease || e.qq)) return false;
      if (q) {
        const hay = [
          e.album.title,
          e.album.artist,
          e.album.genre,
          e.album.year != null ? String(e.album.year) : '',
          // 已显示的属性一并纳入搜索；原有 4 项保留（取消勾选流派后仍可搜流派）
          ...this.plugin.settings.shelfProps.map((k) => e.album.displayProps[k] ?? ''),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const stats = this.plugin.settings.stats;
    const plays = (e: ShelfEntry) => stats.albums[e.album.path]?.plays ?? 0;
    const recent = (e: ShelfEntry) => stats.albums[e.album.path]?.lastPlayedAt ?? 0;
    const num = (v: string | number | undefined) => (v == null || v === '' ? -1 : Number(v));
    switch (this.state.sort) {
      case 'title-asc':
        list.sort((a, b) => a.album.title.localeCompare(b.album.title, 'zh-CN'));
        break;
      case 'title-desc':
        list.sort((a, b) => b.album.title.localeCompare(a.album.title, 'zh-CN'));
        break;
      case 'year-desc':
        list.sort((a, b) => num(b.album.year) - num(a.album.year));
        break;
      case 'year-asc':
        list.sort((a, b) => num(a.album.year) - num(b.album.year));
        break;
      case 'rating-desc':
        list.sort((a, b) => num(b.album.rating) - num(a.album.rating));
        break;
      case 'plays-desc':
        list.sort((a, b) => plays(b) - plays(a));
        break;
      case 'recent':
        list.sort((a, b) => recent(b) - recent(a));
        break;
    }
    return list;
  }

  // ============ 工具栏菜单 / 弹层 ============

  private showSortMenu(ev: MouseEvent) {
    const menu = new Menu();
    for (const [key, label] of sortOptions()) {
      menu.addItem((it) =>
        it
          .setTitle(label)
          .setChecked(this.state.sort === key)
          .onClick(() => {
            this.state.sort = key;
            this.renderGrid();
          })
      );
    }
    menu.showAtMouseEvent(ev);
  }

  private showFilterMenu(ev: MouseEvent) {
    const menu = new Menu();
    for (const [key, label] of filterOptions()) {
      menu.addItem((it) =>
        it
          .setTitle(label)
          .setChecked(this.state.sourceFilter === key)
          .onClick(() => {
            this.state.sourceFilter = key;
            this.renderGrid();
          })
      );
    }
    menu.showAtMouseEvent(ev);
  }

  // ============ 卡片属性弹层 ============
  // 两区（已显示 / 可添加）+ 计数；已显示区可拖拽调序、✎ 改显示名、✕ 移除。
  // 内容重绘与事件注册分离：任何变更只重绘本区，弹层保持打开、逐项即时生效。

  private showPropsPopover(ev: MouseEvent) {
    this.closePropsPopover();
    const pop = document.body.createDiv({ cls: 'vinyl-props-popover' });
    this.propsPopover = pop;
    this.renderPropsPopover(pop);
    this.placePropsPopover(pop, ev.currentTarget as HTMLElement);
    this.onDocClick = (docEv: MouseEvent) => {
      if (pop.contains(docEv.target as Node)) return;
      this.closePropsPopover();
    };
    document.addEventListener('click', this.onDocClick, true);
  }

  // 内容重绘（不重建弹层、不重注册 document 监听）：勾选 / 排序 / 改名后调用
  private renderPropsPopover(pop: HTMLElement) {
    pop.empty();
    this.dragKey = null;
    this.dropAt = null;
    const selected = this.plugin.settings.shelfProps;
    const usage = collectShelfPropKeys(this.entries.map((e) => e.album));
    const counts = new Map(usage.map((u) => [u.key, u.count]));

    pop.createDiv({ text: t('props.shown'), cls: 'vinyl-props-section' });
    if (!selected.length) {
      pop.createDiv({
        text: t('props.nonePicked'),
        cls: 'vinyl-props-hint',
      });
    }
    for (const key of selected) this.propsSelectedRow(pop, key, counts.get(key));

    pop.createDiv({ cls: 'vinyl-props-divider' });
    const rest = usage.filter((u) => !selected.includes(u.key));
    if (!this.entries.length) {
      pop.createDiv({ text: t('props.noAlbums'), cls: 'vinyl-props-hint' });
    } else if (!rest.length) {
      pop.createDiv({ text: t('props.allAdded'), cls: 'vinyl-props-hint' });
    } else {
      for (const u of rest) this.propsAvailableRow(pop, u.key, u.count);
    }

    pop.createDiv({
      text: t('props.footer'),
      cls: 'vinyl-props-hint',
    });
  }

  // 已显示行：拖拽排序 + ✎ 改显示名 + ✕ 移除
  private propsSelectedRow(pop: HTMLElement, key: string, count?: number) {
    const row = pop.createDiv({ cls: 'vinyl-props-row is-selected' });
    row.dataset.propKey = key;
    row.setAttribute('draggable', 'true');
    row.setAttribute('title', tf('props.frontmatterKey', { key }));
    row.addEventListener('dragstart', (ev) => {
      this.dragKey = key;
      this.dropAt = null;
      row.addClass('is-dragging');
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', key); // 不设 data 时部分环境不启动拖拽
      }
    });
    row.addEventListener('dragend', () => {
      this.dragKey = null;
      row.removeClass('is-dragging');
      this.clearDropIndicators();
    });
    // 落点判定：指针在行的上/下半 ⇒ 插到该行前/后（拖到自己身上时结果等价于原位，无副作用）
    row.addEventListener('dragover', (ev) => {
      if (!this.dragKey) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      this.setDropIndicator(key, ev.clientY > rect.top + rect.height / 2);
    });
    row.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const dragKey = this.dragKey;
      const drop = this.dropAt;
      this.clearDropIndicators();
      if (!dragKey || !drop) return;
      const cur = this.plugin.settings.shelfProps;
      const to = resolveDropIndex(cur, dragKey, drop.key, drop.after);
      void this.applyShelfProps(reorderShelfProp(cur, dragKey, to));
    });

    const label = row.createSpan({
      text: propLabel(key, this.plugin.settings.shelfPropLabels),
      cls: 'vinyl-props-row-label',
    });
    if (count != null)
      row.createSpan({ text: tf('props.albumCount', { count }), cls: 'vinyl-props-count' });
    const iconBtn = (icon: string, title: string, fn: () => void) => {
      const b = row.createEl('button', { cls: 'clickable-icon vinyl-props-icon' });
      setIcon(b, icon);
      // 同上：只留 aria-label（title 与它同文案时会叠成两个提示气泡）
      b.setAttribute('aria-label', title);
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fn();
      });
    };
    iconBtn(
      'pencil',
      tf('props.rename', { name: propLabel(key, this.plugin.settings.shelfPropLabels) }),
      () =>
      this.startPropRename(label, key)
    );
    iconBtn(
      'x',
      tf('props.hide', { name: propLabel(key, this.plugin.settings.shelfPropLabels) }),
      () =>
      void this.applyShelfProps(toggleShelfProp(this.plugin.settings.shelfProps, key, false))
    );
  }

  // 可添加行：勾选即上墙（新键追加到末尾，之后可拖拽调序）
  private propsAvailableRow(pop: HTMLElement, key: string, count: number) {
    const row = pop.createDiv({ cls: 'vinyl-props-row' });
    const cb = row.createEl('input', { attr: { type: 'checkbox' } });
    const toggle = (on: boolean) =>
      void this.applyShelfProps(toggleShelfProp(this.plugin.settings.shelfProps, key, on));
    cb.addEventListener('change', () => {
      toggle(cb.checked);
    });
    row.addEventListener('click', (ev) => {
      if (ev.target === cb) return;
      cb.checked = !cb.checked;
      toggle(cb.checked);
    });
    row.createSpan({
      text: propLabel(key, this.plugin.settings.shelfPropLabels),
      cls: 'vinyl-props-row-label',
    });
    row.createSpan({ text: tf('props.albumCount', { count }), cls: 'vinyl-props-count' });
  }

  // ✎ 改显示名：行内 input；Enter/blur 提交、Esc 取消；留空 = 删除覆写（回落预设别名 / 键名）
  private startPropRename(labelEl: HTMLElement, key: string) {
    const input = createEl('input', {
      cls: 'vinyl-props-rename',
      attr: { type: 'text' },
    });
    input.value = propLabel(key, this.plugin.settings.shelfPropLabels);
    labelEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = async (save: boolean) => {
      if (done) return;
      done = true;
      if (!save) {
        if (this.propsPopover) this.renderPropsPopover(this.propsPopover); // Esc：原样重绘
        return;
      }
      const value = input.value.trim();
      const labels = { ...this.plugin.settings.shelfPropLabels };
      if (!value || value === propLabel(key)) delete labels[key];
      else labels[key] = value;
      await this.applyShelfPropLabels(labels);
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation(); // 别把按键漏给 Obsidian 全局快捷键
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void commit(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        void commit(false);
      }
    });
    input.addEventListener('blur', () => void commit(true));
  }

  // 卡片属性 / 显示名的唯一写入口：整表替换 → 落盘 → 广播所有专辑墙视图（含本视图）
  private async applyShelfProps(next: string[]) {
    this.plugin.settings.shelfProps = next;
    await this.plugin.saveSettings();
    this.plugin.refreshShelfProps();
  }

  private async applyShelfPropLabels(next: Record<string, string>) {
    this.plugin.settings.shelfPropLabels = next;
    await this.plugin.saveSettings();
    this.plugin.refreshShelfProps();
  }

  // 拖拽落点指示：清掉旧指示，标记当前行前/后插入位
  private setDropIndicator(key: string, after: boolean) {
    const pop = this.propsPopover;
    if (!pop) return;
    let target: HTMLElement | null = null;
    for (const el of Array.from(pop.querySelectorAll<HTMLElement>('.vinyl-props-row'))) {
      el.removeClass('is-drop-before', 'is-drop-after');
      if (el.dataset.propKey === key) target = el;
    }
    if (target) target.addClass(after ? 'is-drop-after' : 'is-drop-before');
    this.dropAt = { key, after };
  }

  private clearDropIndicators() {
    this.dropAt = null;
    const pop = this.propsPopover;
    if (!pop) return;
    for (const el of Array.from(pop.querySelectorAll<HTMLElement>('.vinyl-props-row'))) {
      el.removeClass('is-drop-before', 'is-drop-after');
    }
  }

  // 弹层定位：默认贴按钮下方；下方空间不足则上翻；限高滚动（候选属性多时必需）
  private placePropsPopover(pop: HTMLElement, anchor: HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    const win = pop.ownerDocument.defaultView ?? window;
    const below = win.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const flip = below < 220 && above > below;
    pop.style.maxHeight = `${Math.round(
      Math.max(160, Math.min(win.innerHeight * 0.6, flip ? above : below))
    )}px`;
    pop.style.top = flip ? 'auto' : `${rect.bottom + 4}px`;
    pop.style.bottom = flip ? `${win.innerHeight - rect.top + 4}px` : 'auto';
    pop.style.left = `${Math.max(8, Math.min(rect.left, win.innerWidth - 240))}px`;
  }

  private closePropsPopover() {
    if (this.propsPopover) {
      this.propsPopover.remove();
      this.propsPopover = null;
    }
    this.dragKey = null;
    this.dropAt = null;
    if (this.onDocClick) {
      document.removeEventListener('click', this.onDocClick, true);
      this.onDocClick = null;
    }
  }

  // ============ 卡片 ============

  private buildCard(e: ShelfEntry): HTMLElement {
    const { album } = e;
    const card = createDiv();
    card.className = 'vinyl-shelf-card';
    card.dataset.path = album.path;
    // 键盘可达：Tab 能落到卡片上，Enter / 空格等同点击（role=button 让读屏软件报「按钮」）
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', album.title);
    this.cardEls.set(album.path, card);

    // 笔记路径的悬停提示只挂在封面上：挂整张卡片的话，鼠标移到专辑名或属性行也会弹出来，
    // 正好挡住正在滚动的文字。属性行自己的提示（属性名：值）见下面的 buildCard 属性循环。
    const cover = card.createDiv({ cls: 'vinyl-shelf-cover', attr: { title: album.path } });
    // 唱片层（绝对定位）：位于封面之下（img/占位 z-index 1 在上，disc 藏于封面后方探出）
    cover.createDiv({ cls: 'vinyl-shelf-disc' });
    if (album.cover) {
      cover.createEl('img', { attr: { src: album.cover } });
    } else if (album.coverRaw) {
      const ph = cover.createDiv({ cls: 'vinyl-shelf-cover-color' });
      ph.style.background = String(album.coverRaw);
      ph.createSpan({ text: '♪' });
    } else {
      cover.createDiv({ cls: 'vinyl-shelf-cover-color vinyl-shelf-cover-empty', text: '♪' });
    }

    // 标题与属性行都套 .vinyl-marquee：放不下时悬停横向滚动（量距离在 onMarqueeOver，滚动是纯 CSS）
    const title = card.createDiv({ cls: 'vinyl-shelf-card-title vinyl-marquee' });
    title.createSpan({ text: album.title, cls: 'vinyl-marquee-text' });
    // 属性行：顺序取自设置数组（不遍历 displayProps 键序——整数样键名会被 Object.keys 提前）。
    // 不显示属性名（表头），整行只有值；值太长由 CSS 截断，悬停滚动看全，
    // 鼠标停住时 title 给出「属性名：值」——不然「1997」这种裸值分不清是什么属性。
    const labels = this.plugin.settings.shelfPropLabels;
    for (const key of this.plugin.settings.shelfProps) {
      // ?? '' 必须有：strict:false 下静态类型是 string，运行时可能键不存在
      const value = album.displayProps[key] ?? '';
      if (value === '') continue; // 无该字段 / 值无法展示 → 跳过整行（前缀也不显示）
      const text = propPrefix(key) + value;
      const row = card.createDiv({
        cls: 'vinyl-shelf-prop vinyl-marquee',
        // 冒号也随语言（全角 / 半角），别把中文标点漏进英文界面
        attr: { title: `${propLabel(key, labels)}${t('common.colon')}${text}` },
      });
      row.createSpan({ text, cls: 'vinyl-shelf-prop-value vinyl-marquee-text' });
    }

    // 只在「无任何音源」时给提示——这类卡片点击打开笔记而非播放，需要一眼可辨
    // （音源筛选在工具栏，播放时播放器丝印行也显示来源）。
    if (!e.local && !e.netease && !e.qq) {
      card
        .createDiv({ cls: 'vinyl-shelf-badges' })
        .createSpan({ text: t('card.collect'), cls: 'vinyl-badge is-collect' });
    }

    // 选择模式的勾选圈（批量删除）：常态不显示，进模式后每张卡右上角一枚空圈，选中打勾
    const mark = card.createDiv({ cls: 'vinyl-shelf-card-check' });
    setIcon(mark, 'check');

    card.addEventListener('click', (ev) => {
      if (this.batch.active) {
        this.pickForBatch(album.path, ev);
        return;
      }
      void this.playAlbum(e);
    });
    card.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (this.batch.active) return; // 选择模式里不弹菜单：右键留给「别的用途」，别把播放 / 删除搅进来
      this.showMenu(e, ev);
    });
    // 拖拽音频到卡片 = 导入到该专辑（落库模式取设置）
    card.addEventListener('dragover', (ev) => {
      if (this.hasAudioFiles(ev)) {
        ev.preventDefault();
        ev.stopPropagation();
        card.addClass('is-drag-over');
      }
    });
    card.addEventListener('dragleave', () => card.removeClass('is-drag-over'));
    const onCardDrop = async (ev: DragEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      card.removeClass('is-drag-over');
      if (!ev.dataTransfer) return;
      // 文件或文件夹都支持：文件夹按「一张专辑一个文件夹」导入到这张专辑
      const picked = await collectDroppedFiles(ev.dataTransfer);
      if (!picked.length) return;
      await this.plugin.importAudioFromFiles(
        picked.map((p) => p.file),
        e.album,
        droppedRootName(picked)
      );
    };
    card.addEventListener('drop', (ev) => {
      void onCardDrop(ev);
    });
    return card;
  }

  // 点击 = 黑胶交接：离墙动画 → 打开播放器 → 落盘 → 播放；纯收藏态 → 打开笔记
  private async playAlbum(e: ShelfEntry) {
    const { album } = e;
    if (!e.local && !e.netease && !e.qq) {
      const leaf = this.plugin.app.workspace.getLeaf(false);
      await leaf.openFile(album.file);
      notice(t('card.noSource'));
      return;
    }
    // 专辑队列模式：点专辑 = 排到队尾（不换碟、不走交接动画）；队列空时引擎按普通换碟处理
    if (this.plugin.settings.queueMode) {
      const res = await this.plugin.engine.enqueueAlbum(album);
      if (res.tracks.length) notice(tf('notice.queuedAlbum', { name: album.title }));
      return;
    }
    if (
      this.lastSnap &&
      this.lastSnap.albumNotePath === album.path &&
      this.lastSnap.queue.length > 0
    ) {
      await this.plugin.openPlayer();
      return;
    }
    const cardEl = this.cardEls.get(album.path) || null;
    await this.plugin.handoff.handoff(album, cardEl);
  }

  private showMenu(e: ShelfEntry, ev: MouseEvent) {
    const { album } = e;
    const menu = new Menu();
    if (e.local || e.netease || e.qq) {
      menu.addItem((it) =>
        it
          .setTitle(t('menu.play'))
          .setIcon('play')
          .onClick(() => this.playAlbum(e))
      );
    }
    menu.addItem((it) =>
      it
        .setTitle(t('menu.openNote'))
        .setIcon('file-text')
        .onClick(async () => {
          const leaf = this.plugin.app.workspace.getLeaf(false);
          await leaf.openFile(album.file);
        })
    );
    menu.addItem((it) =>
      it
        .setTitle(t('menu.importAudio'))
        .setIcon('upload')
        .onClick(() => this.plugin.openLocalImport(album))
    );
    menu.addItem((it) =>
      it
        .setTitle(t('menu.setCover'))
        .setIcon('image')
        .onClick(() => new SetCoverModal(this.plugin.app, this.plugin, album).open())
    );
    if (album.neteaseId) {
      menu.addItem((it) =>
        it
          .setTitle(t('menu.openNetease'))
          .setIcon('external-link')
          .onClick(() => {
            window.open(`https://music.163.com/#/album?id=${album.neteaseId}`);
          })
      );
    }
    if (album.qqId) {
      menu.addItem((it) =>
        it
          .setTitle(t('menu.openQq'))
          .setIcon('external-link')
          .onClick(() => {
            window.open(`https://y.qq.com/n/ryqq/albumDetail/${album.qqId}`);
          })
      );
    }
    menu.addSeparator();
    menu.addItem((it) =>
      it
        .setTitle(t('menu.deleteAlbum'))
        .setIcon('trash')
        .onClick(() => this.plugin.openDeleteAlbum(album))
    );
    menu.showAtMouseEvent(ev);
  }

  // ============ 播放状态 ============

  // 播放中高亮 + 唱片离墙：当前专辑描边着色；队列里排着的专辑（列表模式下常有多张）同样把
  // 唱片收走 —— 「已在列表里」就是「已经离开墙」。进出队列都带动画：排进来时自己飞离墙面，
  // 退出列表模式（队列收敛回当前专辑）时被移出的那几张滑回封套。
  private updatePlaying(s: PlayerSnapshot) {
    this.lastSnap = s;
    const current = s.status !== 'idle' && s.albumNotePath ? s.albumNotePath : null;
    const queued = queuedAlbumPaths(s.queue);
    for (const [path, el] of this.cardEls) {
      const playing = path === current;
      const away = playing || queued.has(path);
      const wasAway = el.classList.contains('is-playing') || el.classList.contains('is-queued');
      // 刚建出来的卡片只回写状态：首屏就排着的专辑不该一起「飞出去」（那是一次渲染，不是一次动作）
      const known = el.__vinylSnap === true;
      el.__vinylSnap = true;
      if (known && wasAway && !away) {
        this.playDiscReturn(el);
      } else if (known && !wasAway && away && !el.__vinylLift) {
        // 排进列表（点专辑 / 唱片架多选 / 其它排队入口都算）→ 唱片飞离墙面。
        // 交接动画正在跑时 __vinylLift 已挂上，这里不重复点火
        const disc = el.querySelector<HTMLElement>('.vinyl-shelf-disc');
        if (disc && !prefersReducedMotion()) animateDiscLiftOff(el, disc);
      }
      el.classList.toggle('is-playing', playing);
      el.classList.toggle('is-queued', away && !playing);
    }
  }

  // 唱片回归动画：与离墙动画同参数逆向（WAAPI，700ms），避免突然出现
  private playDiscReturn(cardEl: HTMLElement) {
    const lift = cardEl.__vinylLift;
    if (lift) {
      lift.cancel();
      cardEl.__vinylLift = null;
    }
    const prev = cardEl.__vinylReturn;
    if (prev) prev.cancel();
    const disc = cardEl.querySelector<HTMLElement>('.vinyl-shelf-disc');
    if (!disc || prefersReducedMotion()) return; // 减少动态效果：不回位位移（类名状态照旧）
    // 关键帧取 CSS 变量（--vinyl-disc-{off,lift,rest}），随「黑胶动画方向」设置变化
    const anim = disc.animate(
      [
        { transform: discTransform(disc, 'off'), opacity: '0', offset: 0 },
        { transform: discTransform(disc, 'lift'), opacity: '1', offset: 0.47 },
        { transform: discTransform(disc, 'rest'), opacity: '1', offset: 1 },
      ],
      { duration: 700, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' }
    );
    cardEl.addClass('is-returning');
    // cancel 也要摘：连着换专辑时上一条回位动画会被取消，只挂 finish 的话 is-returning 会永远留在卡上
    const done = () => cardEl.removeClass('is-returning');
    anim.addEventListener('finish', done);
    anim.addEventListener('cancel', done);
    cardEl.__vinylReturn = anim;
  }

  // ============ 拖拽（空白处新建专辑） ============

  private wireGridDrop(grid: HTMLElement) {
    grid.addEventListener('dragover', (ev) => {
      if (this.hasAudioFiles(ev)) {
        ev.preventDefault();
        grid.addClass('is-drag-over');
      }
    });
    grid.addEventListener('dragleave', () => grid.removeClass('is-drag-over'));
    const onGridDrop = async (ev: DragEvent) => {
      ev.preventDefault();
      grid.removeClass('is-drag-over');
      if (!ev.dataTransfer) return;
      // 拖到空白处：文件夹按其名字新建专辑
      const picked = await collectDroppedFiles(ev.dataTransfer);
      if (!picked.length) return;
      await this.plugin.importAudioFromFiles(
        picked.map((p) => p.file),
        null,
        droppedRootName(picked)
      );
    };
    grid.addEventListener('drop', (ev) => {
      void onGridDrop(ev);
    });
  }

  // 音频文件或文件夹都算可接收（目录的 dataTransfer item type 为空）
  private hasAudioFiles(ev: DragEvent): boolean {
    const items = Array.from(ev.dataTransfer?.items || []);
    if (items.some((it) => it.kind === 'file' && !it.type)) return true;
    return Array.from(ev.dataTransfer?.files || []).some((f) => isAudioFile(f.name));
  }

}
