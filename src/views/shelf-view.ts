// 专辑墙视图（自绘 ItemView）：
//   工具栏（工具栏方案 2026-09-18）：单行 —— 左边标题 + 手绘体计数，右边四枚图标钮：
//     搜索（点击原位向左展开输入框，输入即筛墙；无词失焦收回）/ 陈列 / 添加 / 更多。
//     没有抽屉、没有厚重胶囊；窗格再窄也是单行（窄到放不下就先省计数、再缩标题）。
//   陈列：来源（单选芯片）+ 排列（依据 / 方向两个下拉）+ 显示（每行数量 / 封面下的信息第二层）。
//   添加：一个浮层两种入库方式 —— 在线搜索 + 本地拖放（见 views/add-panel）。
//   选择模式：更多 → 选择专辑；工具栏整条切换用途（已选数量 / 全选当前 / 清空 / 删除… / 完成），
//     卡片点选（Shift 连选），Esc 或「完成」退出。
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
import {
  RECORD_COLORS,
  SHELF_COLUMN_CHOICES,
  TOOLBAR_POSITIONS,
  isToolbarAtBottom,
  normalizeToolbarPosition,
  recordClass,
  toolbarPositionClass,
} from '../core/appearance';
import {
  collectShelfPropKeys,
  propLabel,
  propPrefix,
  reorderShelfProp,
  resolveDropIndex,
  toggleShelfProp,
} from '../core/shelf-props';
import {
  DEFAULT_SHELF_SORT,
  SORT_BASES,
  ShelfSort,
  SortBasis,
  SortDir,
  basisName,
  setCustomSortKey,
  setSortBasis,
  setSortDir,
  sortDirOptions,
  sortShelfEntries,
} from '../core/shelf-sort';
import { rangeInList, toggleInList } from '../core/multi-select';
import { collectDroppedFiles, droppedRootName, isAudioFile, isImageFile, markVinylMenu, notice, prefersReducedMotion } from '../util';
// 手绘笔触用 roughjs（Excalidraw 内部同款引擎）。只引 SVG 那一支：canvas 渲染器用不上，
// 直接引包入口会把它一起打进来（实测多 2 KB）。线宽 / 虚线等公共参数见 hand-drawn.ts。
import { RoughSVG } from 'roughjs/bin/svg';
import { roughDashed, roughSolid, roundRectPath, SVG_NS } from './hand-drawn';
import { t, tf } from '../core/i18n';
import { SetCoverModal } from './set-cover-modal';
import { AddPanel } from './add-panel';
import { onMarqueeOver, onMarqueeOut } from './marquee';

export const SHELF_VIEW_TYPE = 'vinyl-shelf';

interface ShelfEntry {
  album: AlbumInfo;
  local: boolean;
  netease: boolean;
  qq: boolean;
}

type SourceFilter = 'all' | 'local' | 'netease' | 'qq' | 'collect';

interface ShelfViewState {
  query: string;
  sort: ShelfSort;
  sourceFilter: SourceFilter;
}

// 用函数而不是常量：语言在设置里切换后，菜单标题要跟着变（常量在模块加载时就定型了）
const filterOptions = (): [SourceFilter, string][] => [
  ['all', t('filter.all')],
  ['local', t('filter.local')],
  ['netease', t('filter.netease')],
  ['qq', t('filter.qq')],
  ['collect', t('filter.collect')],
];

/** 分段控件里的短标签（窄浮层里放得下）：完整名字挂在 aria-label 上，不丢语义 */
const sourceShortLabel = (key: SourceFilter): string => {
  switch (key) {
    case 'all':
      return t('filter.all');
    case 'local':
      return t('src.local');
    case 'netease':
      return t('src.netease');
    case 'qq':
      return t('src.qq');
    case 'collect':
      return t('filter.collectShort');
  }
};

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
  private state: ShelfViewState = { query: '', sort: DEFAULT_SHELF_SORT, sourceFilter: 'all' };
  private toolbarEl: HTMLElement | null = null;
  private headingEl: HTMLElement | null = null; // 标题 + 计数（计数是手绘体）
  private displayBtnEl: HTMLButtonElement | null = null; // 陈列入口（筛了来源时按钮上挂来源名）
  private addBtnEl: HTMLButtonElement | null = null; // 添加入口（空态教程的虚线圈指着它）
  private searchEl: HTMLElement | null = null; // 搜索控件（图标 ↔ 输入框）
  private searchInput: HTMLInputElement | null = null;
  private searchOpen = false; // 输入框展开中（无关键词失焦 / 清空后收回图标）
  private composing = false; // 中文输入法组词中：组词期间不筛墙
  private preSearchScroll = 0; // 进入搜索前的滚动位置（清空关键词后回到这里）
  // 选择模式（批量删除）：点卡片 = 选 / 取消选，Shift = 连选，Esc / 完成退出。
  // scope = 进入模式那一刻眼前的结果（全选只作用于它；期间不提供搜索 / 陈列 / 添加）
  private batch: { active: boolean; selection: string[]; anchor: string; scope: string[] } = {
    active: false,
    selection: [],
    anchor: '',
    scope: [],
  };
  private batchInfoEl: HTMLElement | null = null;
  private batchAllBtn: HTMLButtonElement | null = null; // 全选当前 N 张
  private batchClearBtn: HTMLButtonElement | null = null; // 清空选择
  private batchDeleteBtn: HTMLButtonElement | null = null;
  private batchDoneBtn: HTMLButtonElement | null = null;
  private gridHost: HTMLElement | null = null;
  private shownCount = 0; // 当前筛选结果条数（标题计数与网格共用这一个数）
  // 浮层（陈列 / 添加）：同一时刻最多一个；点外 / Esc 关闭；焦点还给入口按钮
  private panel: { el: HTMLElement; kind: 'display' | 'add'; anchor: HTMLElement } | null = null;
  private displayLayer: 'main' | 'props' = 'main'; // 陈列浮层当前在哪一层
  private propsHost: HTMLElement | null = null; // 属性行（第二层）挂在哪个容器里
  private addPanel: AddPanel | null = null;
  private onPanelDocPointer: ((ev: PointerEvent) => void) | null = null;
  private onPanelKey: ((ev: KeyboardEvent) => void) | null = null;
  private dragKey: string | null = null; // 卡片属性行：正在拖拽的属性键
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
    this.closePanel();
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
    // 选择模式：Esc 退出（与播放器唱片区同一处手势，别让用户找半天出口）。
    // 搜索框里的 Esc 只退焦点、不清条件，由输入框自己拦住（stopPropagation）。
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
      // 签名不变但浮层开着：候选计数可能已变（新增字段但尚未显示）→ 就地重绘，不关层
      else this.refreshPanelContent();
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
    // 浮层挂在 body 上：这次重建不该把它关掉（在「添加」面板里导入一张专辑就会触发后台刷新，
    // 面板要保持打开才能连续添加）。只把锚点换到重建后的新按钮上，见下面的 reattachPanel。
    const keepPanel = this.panel?.kind ?? null;
    this.loadEntries();
    const c = this.contentEl;
    c.empty();
    c.addClass('vinyl-shelf');
    this.applyAppearance();
    this.cardEls.clear();
    // 工具栏的元素随旧 DOM 一起没了：先把引用清掉，免得重建间隙里的回调摸到 detached 节点
    this.toolbarEl = null;
    this.headingEl = null;
    this.displayBtnEl = null;
    this.addBtnEl = null;
    this.searchEl = null;
    this.searchInput = null;
    this.batchInfoEl = null;
    this.batchAllBtn = null;
    this.batchClearBtn = null;
    this.batchDeleteBtn = null;
    this.batchDoneBtn = null;
    this.renderToolbar(c);
    this.gridHost = c.createDiv({ cls: 'vinyl-shelf-grid-host' });
    this.renderGrid();
    this.syncBatch(); // 重建后再把选择模式的整体状态铺回去（卡片是新 DOM）
    if (keepPanel) this.reattachPanel(keepPanel);
  }

  /** 卡片属性变更后的就地刷新（main.refreshShelfProps 广播给所有专辑墙视图）：
   *  重建卡片行 + 刷新打开的浮层（计数 / 已选区） */
  refreshProps() {
    this.renderGrid();
    this.refreshPanelContent();
  }

  // 外观（设置 → 外观）：唱片弹出方向 + 每行卡片数 + 唱片配色，仅换类与 CSS 变量，不重建卡片
  applyAppearance() {
    const c = this.contentEl;
    const dir = this.plugin.settings.discDirection || 'right';
    for (const d of DISC_DIRECTIONS) c.toggleClass(`is-disc-${d}`, d === dir);
    const color = this.plugin.settings.recordColor;
    for (const v of RECORD_COLORS) c.toggleClass(recordClass(v), v === color);
    // 工具栏位置（设置 → 外观）：六个类只换 align-self / order / top / bottom，不动结构
    const pos = normalizeToolbarPosition(this.plugin.settings.toolbarPosition);
    for (const v of TOOLBAR_POSITIONS) c.toggleClass(toolbarPositionClass(v), v === pos);
    const cols = this.plugin.settings.shelfColumns;
    c.style.setProperty(
      '--vinyl-shelf-columns',
      cols === 'auto' || !cols
        ? 'repeat(auto-fill, minmax(230px, 1fr))'
        : `repeat(${cols}, minmax(0, 1fr))`
    );
  }

  // 工具栏（工具栏方案 2026-09-18）：单行 —— 标题（+ 手绘体计数）｜搜索｜陈列 / 添加 / 更多。
  // 选择模式整条切换用途；其余时候右侧三键只留图标（文字都在浮层里）。
  private renderToolbar(c: HTMLElement) {
    const bar = c.createDiv({ cls: 'vinyl-shelf-toolbar' });
    this.toolbarEl = bar; // 教程层要量它的高度（教程整块要躲开它）
    this.renderToolbarContent(bar);
  }

  private renderToolbarContent(bar: HTMLElement) {
    bar.empty();
    bar.toggleClass('is-batch', this.batch.active);
    if (this.batch.active) {
      this.renderBatchToolbar(bar);
      return;
    }

    // —— 标题 + 计数（计数是手绘体；有搜索 / 来源筛选时改报「匹配数/总数」）——
    const heading = bar.createDiv({ cls: 'vinyl-shelf-heading' });
    this.headingEl = heading;
    this.syncHeading(); // 工具栏可能是在选择模式之后重建的：计数要立刻回填（不能等下一次 renderGrid）

    // —— 搜索：图标 ↔ 原位展开的输入框（输入框向左长，右侧三个按钮原地不动）——
    const search = bar.createDiv({ cls: 'vinyl-shelf-search' });
    this.searchEl = search;
    search.toggleClass('is-open', this.searchOpen);
    const toggle = search.createEl('button', { cls: 'clickable-icon vinyl-shelf-search-toggle' });
    setIcon(toggle, 'search');
    toggle.setAttribute('aria-label', t('toolbar.search'));
    toggle.setAttribute('aria-expanded', String(this.searchOpen));
    toggle.addEventListener('click', () => this.openSearch());

    const box = search.createDiv({ cls: 'vinyl-shelf-search-box' });
    const glyph = box.createSpan({ cls: 'vinyl-shelf-search-glyph' });
    setIcon(glyph, 'search');
    const input = box.createEl('input', {
      attr: { type: 'search', placeholder: t('shelf.search'), 'aria-label': t('toolbar.search') },
    });
    this.searchInput = input;
    input.value = this.state.query;
    const clear = box.createEl('button', { cls: 'clickable-icon vinyl-shelf-search-clear' });
    setIcon(clear, 'x');
    clear.setAttribute('aria-label', t('shelf.searchClear'));
    clear.addEventListener('click', () => {
      input.value = '';
      this.applySearch('');
      input.focus(); // 清空后留在输入框里，接着敲下一个词
    });

    let timer: number | null = null;
    const schedule = (delay: number) => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        this.applySearch(input.value.trim());
      }, delay);
    };
    input.addEventListener('input', () => {
      // 中文输入法组词中不筛墙：拼音字母会一个个进来，这时候筛等于白筛几轮（还闪）
      if (this.composing) return;
      schedule(200);
    });
    input.addEventListener('compositionstart', () => {
      this.composing = true;
    });
    input.addEventListener('compositionend', () => {
      this.composing = false;
      schedule(0);
    });
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation(); // 别把按键漏给 Obsidian 全局快捷键；Esc 只退焦点，不清条件
      if (ev.key === 'Escape') {
        ev.preventDefault();
        input.blur();
      }
    });
    input.addEventListener('focus', () => this.setSearchOpen(true));
    input.addEventListener('blur', () => {
      if (!input.value.trim()) this.setSearchOpen(false); // 无关键词失焦：收回图标
    });

    // —— 右侧：陈列 / 添加 / 更多 ——（文字都在浮层里，这里只留图标）
    const actions = bar.createDiv({ cls: 'vinyl-shelf-actions' });
    const mk = (icon: string, label: string, cls = '') => {
      const b = actions.createEl('button', { cls: `clickable-icon vinyl-toolbar-icon ${cls}`.trim() });
      setIcon(b, icon);
      // 只设 aria-label：Obsidian 按它渲染样式化提示，再设 title 会多弹一个浏览器原生提示（两个气泡）
      b.setAttribute('aria-label', label);
      return b;
    };
    const display = mk('sliders-horizontal', t('toolbar.display'), 'vinyl-toolbar-display');
    this.displayBtnEl = display;
    display.addEventListener('click', () => this.toggleDisplayPanel(display));
    const add = mk('plus', t('toolbar.add'), 'vinyl-toolbar-add');
    this.addBtnEl = add;
    add.addEventListener('click', () => this.toggleAddPanel(add));
    const more = mk('more-horizontal', t('toolbar.more'));
    more.addEventListener('click', (ev) => this.showMoreMenu(ev));
    this.syncDisplayButton();
  }

  /** 标题计数：无筛选报总数，有搜索 / 来源筛选报「匹配/总数」（数量由 renderGrid 算好存进来，两处口径一致） */
  private syncHeading(): void {
    const el = this.headingEl;
    if (!el) return;
    const filtered = !!this.state.query || this.state.sourceFilter !== 'all';
    el.empty();
    el.createSpan({ text: t('shelf.heading'), cls: 'vinyl-shelf-heading-title' });
    el.createSpan({
      text: filtered ? `[${this.shownCount}/${this.entries.length}]` : `[${this.entries.length}]`,
      cls: 'vinyl-shelf-heading-count',
    });
  }

  /** 陈列按钮：筛了来源就把来源名挂在图标后面 —— 单行工具栏里条件要保持可见（方案 §4） */
  private syncDisplayButton(): void {
    const btn = this.displayBtnEl;
    if (!btn) return;
    const src = this.state.sourceFilter;
    btn.empty();
    setIcon(btn, 'sliders-horizontal');
    if (src === 'all') {
      btn.removeClass('has-filter');
      btn.setAttribute('aria-label', t('toolbar.display'));
      return;
    }
    const label = filterOptions().find(([key]) => key === src)?.[1] ?? '';
    btn.addClass('has-filter');
    btn.createSpan({ text: label, cls: 'vinyl-toolbar-icon-label' });
    btn.setAttribute('aria-label', tf('toolbar.displayFiltered', { source: label }));
  }

  /** 展开搜索框并聚焦（点图标进入） */
  private openSearch(): void {
    this.setSearchOpen(true);
    this.searchInput?.focus();
  }

  private setSearchOpen(open: boolean): void {
    this.searchOpen = open;
    this.searchEl?.toggleClass('is-open', open);
    const toggle = this.searchEl?.querySelector<HTMLElement>('.vinyl-shelf-search-toggle');
    toggle?.setAttribute('aria-expanded', String(open));
  }

  /** 应用关键词（防抖 / 组词结束后调用）：更新墙、管滚动位置。
   *  进入搜索时先记住浏览位置，清空后回到那里；新关键词从结果顶部看起。 */
  private applySearch(next: string): void {
    if (next === this.state.query) return;
    const wasEmpty = !this.state.query;
    if (wasEmpty && next) this.preSearchScroll = this.contentEl.scrollTop;
    this.state.query = next;
    this.renderGrid();
    if (next) this.contentEl.scrollTop = 0;
    else this.contentEl.scrollTop = this.preSearchScroll;
  }

  // ============ 批量删除（选择模式）============
  // 入口在「更多」菜单；进模式后工具栏整条切换用途（已选数量 / 全选当前 / 清空 / 删除… / 完成），
  // 不再是底部浮条。卡片变成「勾选框」：点 = 选 / 取消选、Ctrl / ⌘ 同义、Shift = 连选，
  // 手势原语与播放器唱片区共用（core/multi-select）。全选只作用于进入模式那一刻的结果（batch.scope）。

  private enterBatch() {
    if (!this.entries.length) return;
    this.closePanel();
    // 全选只作用于「进入模式时的当前结果」：期间墙的增删（后台导入等）不改这个范围
    const scope = this.visiblePaths();
    this.batch = { active: true, selection: [], anchor: '', scope };
    this.syncBatch();
  }

  /** 退出选择模式（Esc / 工具栏「完成」/ 删完收工都走这里） */
  private exitBatch() {
    if (!this.batch.active) return;
    this.batch = { active: false, selection: [], anchor: '', scope: [] };
    this.syncBatch();
  }

  /** 当前显示的专辑路径（按显示顺序）：Shift 连选以「眼前看到的」为准（全选看 batch.scope） */
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

  /** 全选当前 N 张（都选上了就是清空） */
  private toggleSelectAll() {
    const scope = this.batch.scope;
    const picked = new Set(this.batch.selection);
    const allPicked = scope.length > 0 && scope.every((p) => picked.has(p));
    if (allPicked) {
      this.clearSelection();
      return;
    }
    this.batch.selection = [...this.batch.selection, ...scope.filter((p) => !picked.has(p))];
    this.batch.anchor = scope.length ? scope[scope.length - 1] : '';
    this.syncBatch();
  }

  private clearSelection() {
    this.batch.selection = [];
    this.batch.anchor = '';
    this.syncBatch();
  }

  private openBatchDelete() {
    const picked = new Set(this.batch.selection);
    const albums = this.entries.filter((e) => picked.has(e.album.path)).map((e) => e.album);
    if (!albums.length) return;
    this.plugin.openDeleteAlbums(albums, () => this.exitBatch());
  }

  /** 选择模式的工具栏（整条切换用途）：左边已选数量，右边四个动作 */
  private renderBatchToolbar(bar: HTMLElement) {
    this.batchInfoEl = bar.createDiv({ cls: 'vinyl-shelf-batch-info' });
    const actions = bar.createDiv({ cls: 'vinyl-shelf-batch-actions' });
    const mk = (label: string, cls: string, fn: () => void) => {
      const b = actions.createEl('button', { text: label, cls: `vinyl-toolbar-textbtn ${cls}`.trim() });
      b.addEventListener('click', fn);
      return b;
    };
    this.batchAllBtn = mk('', 'vinyl-batch-all', () => this.toggleSelectAll());
    this.batchClearBtn = mk(t('batch.clear'), 'vinyl-batch-clear', () => this.clearSelection());
    this.batchDeleteBtn = mk(t('batch.delete'), 'is-danger vinyl-batch-delete', () =>
      this.openBatchDelete()
    );
    this.batchDoneBtn = mk(t('batch.exit'), 'vinyl-batch-done', () => this.exitBatch());
  }

  /** 选择模式的整体状态回写：进入 / 退出（整条工具栏换用途）、卡片勾选态、各按钮的可用性 */
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
    const bar = this.toolbarEl;
    if (bar && bar.classList.contains('is-batch') !== active) this.renderToolbarContent(bar);
    if (!active) return;
    if (this.batchInfoEl) {
      this.batchInfoEl.setText(tf('batch.selected', { n: this.batch.selection.length }));
    }
    const scope = this.batch.scope;
    if (this.batchAllBtn) {
      const allPicked = scope.length > 0 && scope.every((p) => picked.has(p));
      this.batchAllBtn.setText(tf('batch.selectAll', { n: scope.length }));
      this.batchAllBtn.disabled = allPicked || !scope.length; // 都选上了就没有「全选」可点
    }
    if (this.batchClearBtn) this.batchClearBtn.disabled = !this.batch.selection.length;
    if (this.batchDeleteBtn) this.batchDeleteBtn.disabled = !this.batch.selection.length;
  }

  private renderGrid() {
    if (!this.gridHost) return;
    this.gridHost.empty();
    this.cardEls.clear();
    this.clearTutorial(); // 教程层挂在视图上而不是网格里，要单独收

    // 选择模式：专辑可能已被删掉 / 改名（卡片是快照）→ 选择表与全选范围里去掉不存在的；
    // 墙空了就自动退出模式（否则工具栏还停着「已选 N 张」却没东西可选）
    if (this.batch.active) {
      const alive = new Set(this.entries.map((e) => e.album.path));
      this.batch.selection = this.batch.selection.filter((p) => alive.has(p));
      this.batch.scope = this.batch.scope.filter((p) => alive.has(p));
      if (!this.entries.length) this.batch.active = false;
    }

    const shown = this.applyViewFilters();
    this.shownCount = shown.length;
    this.syncHeading(); // 计数（手绘体）：筛选态报「匹配/总数」

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
      // 搜不到东西时给一条出路：拿这个词去在线找（点开添加面板并带入关键词）
      const q = this.state.query;
      if (q) {
        const btn = empty.createEl('button', {
          text: tf('shelf.searchOnline', { q }),
          cls: 'mod-cta vinyl-shelf-empty-cta',
        });
        btn.addEventListener('click', () => this.openAddPanelWith(q));
      }
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
    const group = this.addBtnEl; // 虚线圈圈住「添加」入口（工具栏方案：两个导入按钮合成一个面板入口）
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
    const barTop = bar ? bar.top - base.top : 0;
    // 工具栏在底部（外观页那六档里的 bottom-*）：整块要收在它上面，别被压住
    const barAtBottom = isToolbarAtBottom(
      normalizeToolbarPosition(this.plugin.settings.toolbarPosition)
    );
    const belowBar = bar && !barAtBottom ? bar.bottom - base.top + 24 : 0;
    const minTop = Math.max(ringBottom + TUT.boxTopFromRing - T.title.offsetHeight - 20, belowBar);
    // 视觉重心落在左下：整块默认压到视图底部（离底 bottomPad），视图不够高就退回 minTop（贴着线圈下方）。
    // 两道下限合起来保证任何尺寸下既不压工具栏、也不冒到视图外 —— 箭头跟着整块一起变长，不用单独调。
    let top = Math.max(minTop, base.height - T.main.offsetHeight - TUT.bottomPad);
    if (barAtBottom) {
      top = Math.max(8, Math.min(top, barTop - T.main.offsetHeight - 12));
    }
    T.main.style.top = `${Math.round(top)}px`;

    const b1 = T.box1.getBoundingClientRect();
    const b2 = T.box2.getBoundingClientRect();
    const box1Mid = b1.top - base.top + b1.height / 2;
    const box2Mid = b2.top - base.top + b2.height / 2;

    // 指向「添加」那枚按钮的箭头（虚线圆圈住的地方）。图纸里按钮在右上角，所以箭头是
    // 「框右缘中点 → 往右拐 → 戳到圈底」；现在工具栏是紧凑浮卡、还能摆到六档位置，
    // 按钮未必在框的右边 —— 横向净空为负时老画法会被整条判掉（箭头就消失了，用户反馈）。
    // 按圈相对文本框的位置分三种：旁边有横向净空走老画法；圈在框上方 / 下方改成竖箭头。
    const tip = { x: cx + 2, y: ringBottom + 1 };
    const box1Right = b1.right - base.left;
    const box1Left = b1.left - base.left;
    const box1Top = b1.top - base.top;
    const box1Bottom = b1.bottom - base.top;
    const ringTop = cy - ry;
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

    // 箭头（图纸：roughness 2；杆是过三点的曲线，头是两笔实线）。三种走法共用同一对种子，
    // 换布局时手绘抖动一致；竖箭头的尾锚在框的上 / 下缘（x 跟着圈心走，但夹在框内 30px）。
    const arrowTipX = Math.round(Math.max(box1Left + 30, Math.min(tip.x, box1Right - 30)));
    let arrow: { tail: { x: number; y: number }; bend: { x: number; y: number }; tip: { x: number; y: number } } | null = null;
    if (!tight) {
      const tail = { x: box1Right + TUT.tailPad, y: box1Mid };
      // 箭尖：圈整体在框下方时戳圈顶（工具栏摆到右下角那一档），否则照图纸戳圈底
      const classicTip = { x: tip.x, y: ringTop > box1Bottom ? ringTop - 1 : ringBottom + 1 };
      arrow = {
        tail,
        bend: {
          x: tail.x + TUT.bendRatioX * (classicTip.x - tail.x),
          y: tail.y + TUT.bendRatioY * (classicTip.y - tail.y),
        },
        tip: classicTip,
      };
    } else if (ringBottom < box1Top) {
      // 工具栏在顶部那一排：框在下面，箭头从框顶竖着往上指
      const tail = { x: arrowTipX, y: box1Top - TUT.tailPad };
      const up = { x: arrowTipX + 2, y: ringBottom + 1 };
      arrow = { tail, bend: { x: tail.x + 6, y: (tail.y + up.y) / 2 }, tip: up };
    } else if (ringTop > box1Bottom) {
      // 工具栏摆到了底部：圈在框的下方，箭头从框底往下指
      const tail = { x: arrowTipX, y: box1Bottom + TUT.tailPad };
      const down = { x: arrowTipX + 2, y: ringTop - 1 };
      arrow = { tail, bend: { x: tail.x + 6, y: (tail.y + down.y) / 2 }, tip: down };
    }
    if (arrow) {
      inkAdd(
        rc.curve(
          [
            [arrow.tail.x, arrow.tail.y],
            [arrow.bend.x, arrow.bend.y],
            [arrow.tip.x, arrow.tip.y],
          ],
          roughDashed(TUT.seed.arrowBent, 2)
        )
      );
      const h = arrowHeadPoints(arrow.tip, unitVector(arrow.bend, arrow.tip));
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
    return sortShelfEntries(list, this.state.sort, this.plugin.settings.stats);
  }

  // ============ 浮层：陈列 / 添加 ============
  // 同一时刻最多一个浮层；点外 / Esc 关闭；关闭后焦点还给入口按钮。
  // 浮层挂在 body（position: fixed），但位置夹在专辑墙窗格内 —— 不遮住别的窗格里的播放器。

  private openPanel(kind: 'display' | 'add', anchor: HTMLElement): void {
    this.closePanel();
    const el = document.body.createDiv({ cls: `vinyl-panel vinyl-${kind}-panel` });
    this.panel = { el, kind, anchor };
    this.displayLayer = 'main';
    if (kind === 'display') this.renderDisplayPanel(el);
    else this.renderAddPanel(el);
    this.placePanel(el, anchor);
    // 点外关闭：pointerdown 的捕获阶段（click 太晚 —— 浮层里的按钮会先响应）
    this.onPanelDocPointer = (ev: PointerEvent) => {
      const target = ev.target as Node | null;
      const p = this.panel;
      if (!target || !p) return;
      if (p.el.contains(target) || p.anchor.contains(target)) return; // 点入口本身交给切换逻辑
      this.closePanel();
    };
    document.addEventListener('pointerdown', this.onPanelDocPointer, true);
    this.onPanelKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      const anchorEl = this.panel?.anchor ?? null;
      this.closePanel();
      anchorEl?.focus(); // 键盘用户：关掉之后焦点回到入口，不用重新找
    };
    document.addEventListener('keydown', this.onPanelKey, true);
  }

  /** 视图重建后把浮层接回来：锚点换成新的入口按钮、重新摆位（内容与搜索状态原地保留） */
  private reattachPanel(kind: 'display' | 'add'): void {
    const panel = this.panel;
    if (!panel || panel.kind !== kind) return;
    const anchor = kind === 'add' ? this.addBtnEl : this.displayBtnEl;
    if (!anchor) return;
    panel.anchor = anchor;
    this.placePanel(panel.el, anchor);
  }

  /** 原位切换：点同一个入口 = 收起 */
  private toggleDisplayPanel(anchor: HTMLElement): void {
    if (this.panel?.kind === 'display') {
      this.closePanel();
      return;
    }
    this.openPanel('display', anchor);
  }

  private toggleAddPanel(anchor: HTMLElement): void {
    if (this.panel?.kind === 'add') {
      this.closePanel();
      return;
    }
    this.openPanel('add', anchor);
  }

  private closePanel(): void {
    const panel = this.panel;
    const addPanel = this.addPanel;
    this.panel = null;
    this.propsHost = null;
    this.addPanel = null;
    if (this.onPanelDocPointer) {
      document.removeEventListener('pointerdown', this.onPanelDocPointer, true);
      this.onPanelDocPointer = null;
    }
    if (this.onPanelKey) {
      document.removeEventListener('keydown', this.onPanelKey, true);
      this.onPanelKey = null;
    }
    addPanel?.destroy(); // 在途搜索作废：结果回来也不许再往 DOM 上画
    panel?.el.remove();
  }

  /** 浮层内容就地重绘（属性 / 计数变了；浮层保持打开） */
  private refreshPanelContent(): void {
    const p = this.panel;
    if (!p || p.kind !== 'display') return;
    this.renderDisplayPanel(p.el);
  }

  /** 位置与宽度：贴入口按钮下方、右缘对齐 —— 宽度优先收在专辑墙窗格里，窗格太窄时保底一个可读下限
   *  （搜索结果是「封面 + 标题 + 操作」三栏，320px 以下就挤成一团）；下方放不下上翻；内容超高限高滚动。 */
  private placePanel(el: HTMLElement, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const pane = this.contentEl.getBoundingClientRect();
    const win = el.ownerDocument.defaultView ?? window;
    const kind = this.panel?.kind ?? 'display';
    // 添加浮层里有搜索结果，比陈列那种表单行宽一档；下限保证窄窗格里信息仍看得清
    const preferred = kind === 'add' ? 440 : 340;
    const floor = kind === 'add' ? 340 : 260;
    const available = Math.max(pane.width - 24, floor);
    const width = Math.round(Math.min(preferred, available, win.innerWidth - 24));
    el.style.width = `${width}px`;
    const paneClamped = Math.min(rect.right - width, Math.max(pane.left + 8, pane.right - width - 8));
    const left = Math.max(8, Math.min(paneClamped, win.innerWidth - width - 8));
    const below = win.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const flip = below < 240 && above > below;
    el.style.maxHeight = `${Math.round(
      Math.max(200, Math.min(win.innerHeight * 0.7, flip ? above : below))
    )}px`;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = flip ? 'auto' : `${Math.round(rect.bottom + 6)}px`;
    el.style.bottom = flip ? `${Math.round(win.innerHeight - rect.top + 6)}px` : 'auto';
  }

  // ============ 陈列浮层（来源 / 排列 / 显示 + 第二层：封面下的信息）============

  private renderDisplayPanel(el: HTMLElement): void {
    el.empty();
    // 标题栏（学设置页的分区块）：主层是图标芯片 + 「陈列」，第二层是「‹ 返回陈列」+ 「封面下的信息」
    const props = this.displayLayer === 'props';
    const head = el.createDiv({ cls: 'vinyl-panel-head' });
    if (props) {
      const back = head.createEl('button', { cls: 'vinyl-panel-back' });
      const backIcon = back.createSpan({ cls: 'vinyl-panel-back-icon' });
      setIcon(backIcon, 'chevron-left');
      back.createSpan({ text: t('display.back') });
      back.addEventListener('click', () => {
        this.displayLayer = 'main';
        this.renderDisplayPanel(el);
      });
      head.createDiv({ text: t('display.props'), cls: 'vinyl-panel-title' });
    } else {
      const icon = head.createSpan({ cls: 'vinyl-panel-icon' });
      setIcon(icon, 'sliders-horizontal');
      head.createDiv({ text: t('toolbar.display'), cls: 'vinyl-panel-title' });
    }
    if (props) {
      this.renderPropsLayer(el);
      return;
    }
    const body = el.createDiv({ cls: 'vinyl-panel-body' });

    // —— 来源：分段控件（单选），与关键词叠加筛选 ——
    body.createDiv({ text: t('display.source'), cls: 'vinyl-panel-section' });
    const segments = body.createDiv({ cls: 'vinyl-segments' });
    for (const [key, label] of filterOptions()) {
      const on = this.state.sourceFilter === key;
      const seg = segments.createEl('button', { text: sourceShortLabel(key), cls: 'vinyl-segment' });
      seg.setAttribute('aria-label', label); // 完整名字（如「仅收藏（无音源）」）在提示里
      seg.setAttribute('aria-pressed', String(on));
      seg.toggleClass('is-on', on);
      seg.addEventListener('click', () => {
        if (this.state.sourceFilter === key) return;
        this.state.sourceFilter = key;
        this.renderGrid();
        this.contentEl.scrollTop = 0; // 换来源：从结果顶部看起
        this.syncDisplayButton(); // 单行工具栏里的条件保持可见
        this.refreshPanelContent();
      });
    }

    // —— 排列：依据 + 方向，两个独立下拉（不再靠重复点击翻转）——
    body.createDiv({ text: t('display.arrange'), cls: 'vinyl-panel-section' });
    const basisSel = this.panelValueRow(body, t('display.sortBy'));
    for (const basis of SORT_BASES) {
      if (basis === 'custom') continue; // 自定义属性走下面的分组
      const opt = basisSel.createEl('option', { text: basisName(basis), value: basis });
      if (this.state.sort.basis === basis) opt.selected = true;
    }
    const usage = collectShelfPropKeys(this.entries.map((e) => e.album));
    if (usage.length) {
      const group = basisSel.createEl('optgroup', { attr: { label: t('display.customGroup') } });
      for (const u of usage) {
        const label = propLabel(u.key, this.plugin.settings.shelfPropLabels);
        const opt = group.createEl('option', {
          text: `${label} · ${tf('props.albumCount', { count: u.count })}`,
          value: `custom:${u.key}`,
        });
        if (this.state.sort.basis === 'custom' && this.state.sort.custom === u.key) opt.selected = true;
      }
    }
    basisSel.addEventListener('change', () => {
      const v = basisSel.value;
      this.state.sort = v.startsWith('custom:')
        ? setCustomSortKey(this.state.sort, v.slice('custom:'.length))
        : setSortBasis(this.state.sort, v as SortBasis);
      this.renderGrid();
      this.contentEl.scrollTop = 0; // 换依据：从结果顶部看起
      this.refreshPanelContent(); // 方向下拉的文案跟着依据换
    });

    const dirSel = this.panelValueRow(body, t('display.dir'));
    for (const o of sortDirOptions(this.state.sort.basis)) {
      const opt = dirSel.createEl('option', { text: o.label, value: o.dir });
      if (this.state.sort.dir === o.dir) opt.selected = true;
    }
    dirSel.addEventListener('change', () => {
      this.state.sort = setSortDir(this.state.sort, dirSel.value as SortDir);
      this.renderGrid();
      this.contentEl.scrollTop = 0;
    });

    // —— 显示：每行数量（即时预览）+ 封面下的信息（第二层）——
    body.createDiv({ text: t('display.view'), cls: 'vinyl-panel-section' });
    const colSel = this.panelValueRow(body, t('display.columns'));
    colSel.createEl('option', { text: t('settings.columnsAuto'), value: 'auto' });
    for (const n of SHELF_COLUMN_CHOICES) {
      colSel.createEl('option', { text: tf('settings.columnsN', { n }), value: String(n) });
    }
    colSel.value = String(this.plugin.settings.shelfColumns ?? 'auto');
    colSel.addEventListener('change', () => void this.applyShelfColumns(colSel.value));

    // 「封面下的信息」：与上面同一套行（标签在左），但整行不是按钮 ——
    // 只有右边一小枚按键（当前显示的信息 + ›）可点，进第二层
    const propsRow = body.createDiv({ cls: 'vinyl-panel-row is-static' });
    propsRow.createSpan({ text: t('display.props'), cls: 'vinyl-panel-row-label' });
    const propsBtn = propsRow.createEl('button', { cls: 'vinyl-panel-value-btn' });
    propsBtn.setAttribute('aria-label', t('display.props'));
    propsBtn.createSpan({ text: this.propsSummary(), cls: 'vinyl-panel-value-btn-text' });
    const chev = propsBtn.createSpan({ cls: 'vinyl-panel-value-btn-chevron' });
    setIcon(chev, 'chevron-right');
    propsBtn.addEventListener('click', () => {
      this.displayLayer = 'props';
      this.renderDisplayPanel(el);
    });
  }

  /** 一行「标签 + 值 ▾」：值由原生 select 承载，视觉做成苹果那种「右侧弱化值 + 上下箭头」。
   *  整行都可点（点标签也开下拉，与系统设置行的手感一致）；点 select 自己时不再转一次（会开两次）。 */
  private panelValueRow(parent: HTMLElement, label: string): HTMLSelectElement {
    const row = parent.createDiv({ cls: 'vinyl-panel-row is-value' });
    row.createSpan({ text: label, cls: 'vinyl-panel-row-label' });
    const sel = row.createEl('select', { cls: 'vinyl-panel-value' });
    const chev = row.createSpan({ cls: 'vinyl-panel-row-chevron' });
    setIcon(chev, 'chevrons-up-down'); // macOS 弹出按钮上的那个上下箭头
    row.addEventListener('click', (ev) => {
      if (ev.target === sel) return; // 点值本身：浏览器自己会开
      const picker = sel as HTMLSelectElement & { showPicker?: () => void };
      if (typeof picker.showPicker === 'function') picker.showPicker();
      else sel.focus();
    });
    return sel;
  }

  /** 封面下的信息那一行右侧的摘要（当前显示属性的名字，逗号分隔） */
  private propsSummary(): string {
    const props = this.plugin.settings.shelfProps;
    if (!props.length) return t('display.propsNone');
    return props.map((k) => propLabel(k, this.plugin.settings.shelfPropLabels)).join(t('common.listSep'));
  }

  /** 每行数量（设置项）：即时预览 —— 只换 CSS 变量，不重建卡片、不动滚动位置 */
  private async applyShelfColumns(value: string) {
    this.plugin.settings.shelfColumns =
      value === 'auto' ? 'auto' : Number(value) || this.plugin.settings.shelfColumns;
    await this.plugin.saveSettings();
    this.applyAppearance();
  }

  /** 陈列第二层：封面下的信息（返回键在标题栏里）。改完即时生效、落盘，浮层保持打开。 */
  private renderPropsLayer(el: HTMLElement): void {
    const host = el.createDiv({ cls: 'vinyl-panel-body vinyl-props-host' });
    this.propsHost = host;
    this.renderProps(host);
  }

  // ============ 更多菜单 ============

  private showMoreMenu(ev: MouseEvent) {
    const menu = new Menu();
    markVinylMenu(menu); // 全直角：菜单壳与悬停底一起收（见 styles.css「全直角」段）
    menu.addItem((it) =>
      it
        .setTitle(t('more.select'))
        .setIcon('list-checks')
        .setDisabled(!this.entries.length)
        .onClick(() => this.enterBatch())
    );
    menu.addItem((it) =>
      it
        .setTitle(t('more.refresh'))
        .setIcon('refresh-cw')
        .onClick(() => this.render()) // 保留搜索 / 筛选 / 陈列状态（state 不动，只是重扫库）
    );
    menu.showAtMouseEvent(ev);
  }

  // ============ 添加浮层 ============

  private renderAddPanel(el: HTMLElement): void {
    // 本地导入的目标列表：库里的专辑按标题排（与「导入本地音频…」弹窗同一套口径）
    const albums = this.entries
      .map((e) => e.album)
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    this.addPanel = new AddPanel(this.plugin.importCtx(), albums, {
      openFile: (file) => void this.openNote(file),
      onImported: (file) => this.flashAlbum(file.path),
      onLocalDone: (path) => this.flashAlbum(path),
      close: () => this.closePanel(),
    });
    this.addPanel.mount(el); // 标题栏由面板自己画（两层各有标题与返回键）
    window.setTimeout(() => this.addPanel?.focus(), 30);
  }

  /** 空态出路：打开「添加」面板并把关键词带进去（用户点的是「在线查找『词』」） */
  private openAddPanelWith(query: string): void {
    const anchor = this.addBtnEl;
    if (!anchor) return;
    this.openPanel('add', anchor);
    this.addPanel?.prefill(query);
  }

  /** 刚入库的专辑：在当前视野里就描边闪一下；不可见时导入本身已有回执，不再打扰 */
  private flashAlbum(path: string): void {
    window.setTimeout(() => {
      const el = this.cardEls.get(path);
      if (!el) return;
      el.addClass('is-just-added');
      window.setTimeout(() => el.removeClass('is-just-added'), 1200);
    }, 600); // 等专辑墙刷新（scheduleRefresh 500ms 防抖）之后再来找卡片
  }

  private async openNote(file: TFile): Promise<void> {
    this.closePanel();
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  // ============ 卡片属性（陈列第二层的内容）============
  // 两区（已显示 / 可添加）+ 计数；已显示区可拖拽调序、✎ 改显示名、✕ 移除。
  // 内容重绘与事件注册分离：任何变更只重绘本区，浮层保持打开、逐项即时生效。

  // 内容重绘（不重建浮层、不重注册 document 监听）：勾选 / 排序 / 改名后调用
  private renderProps(host: HTMLElement) {
    host.empty();
    this.dragKey = null;
    this.dropAt = null;
    const selected = this.plugin.settings.shelfProps;
    const usage = collectShelfPropKeys(this.entries.map((e) => e.album));
    const counts = new Map(usage.map((u) => [u.key, u.count]));

    host.createDiv({ text: t('props.shown'), cls: 'vinyl-props-section' });
    if (!selected.length) {
      host.createDiv({
        text: t('props.nonePicked'),
        cls: 'vinyl-props-hint',
      });
    }
    for (const key of selected) this.propsSelectedRow(host, key, counts.get(key));

    host.createDiv({ cls: 'vinyl-props-divider' });
    const rest = usage.filter((u) => !selected.includes(u.key));
    if (!this.entries.length) {
      host.createDiv({ text: t('props.noAlbums'), cls: 'vinyl-props-hint' });
    } else if (!rest.length) {
      host.createDiv({ text: t('props.allAdded'), cls: 'vinyl-props-hint' });
    } else {
      for (const u of rest) this.propsAvailableRow(host, u.key, u.count);
    }

    host.createDiv({
      text: t('props.footer'),
      cls: 'vinyl-props-hint',
    });
  }

  // 已显示行：拖拽排序 + ✎ 改显示名 + ✕ 移除
  private propsSelectedRow(pop: HTMLElement, key: string, count?: number) {
    const row = pop.createDiv({ cls: 'vinyl-props-row is-selected' });
    row.dataset.propKey = key;
    row.setAttribute('draggable', 'true');
    // 提示走 aria-label：行里还有「改显示名 / 移除」两个按钮，用 title 会把气泡叠到它们身上
    row.setAttribute('aria-label', tf('props.frontmatterKey', { key }));
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
        if (this.propsHost) this.renderProps(this.propsHost); // Esc：原样重绘
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
    const host = this.propsHost;
    if (!host) return;
    let target: HTMLElement | null = null;
    for (const el of Array.from(host.querySelectorAll<HTMLElement>('.vinyl-props-row'))) {
      el.removeClass('is-drop-before', 'is-drop-after');
      if (el.dataset.propKey === key) target = el;
    }
    if (target) target.addClass(after ? 'is-drop-after' : 'is-drop-before');
    this.dropAt = { key, after };
  }

  private clearDropIndicators() {
    this.dropAt = null;
    const host = this.propsHost;
    if (!host) return;
    for (const el of Array.from(host.querySelectorAll<HTMLElement>('.vinyl-props-row'))) {
      el.removeClass('is-drop-before', 'is-drop-after');
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
    // 封面不再单独挂 title（原先报的是 vault 路径）：悬停交给卡片的 aria-label，只报专辑名
    const cover = card.createDiv({ cls: 'vinyl-shelf-cover' });
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
        attr: { 'aria-label': `${propLabel(key, labels)}${t('common.colon')}${text}` },
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
    markVinylMenu(menu); // 全直角：菜单壳与悬停底一起收（见 styles.css「全直角」段）
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
    if (this.entries.length) {
      // 从这张卡进选择模式：自动选中它（工具栏方案 §6）
      menu.addItem((it) =>
        it
          .setTitle(t('menu.selectMany'))
          .setIcon('list-checks')
          .onClick(() => {
            this.enterBatch();
            this.batch.selection = [album.path];
            this.batch.anchor = album.path;
            this.syncBatch();
          })
      );
    }
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
