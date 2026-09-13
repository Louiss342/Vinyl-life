// 专辑墙视图（M2 自绘 ItemView，v0.4.1 工具栏版）：
//   工具栏：标题计数 / 搜索（防抖）/ 刷新 / 排序 / 音源筛选 / 卡片属性 / 导入专辑 / 导入本地音频
//   点击卡片 = 黑胶交接（M3）；拖拽音频入库（M4）；播放中卡片高亮 + 唱片离墙。
import { ItemView, WorkspaceLeaf, Menu, setIcon, TFile, CachedMetadata } from 'obsidian';
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
import { RECORD_COLORS, recordClass } from '../core/appearance';
import {
  collectShelfPropKeys,
  propLabel,
  propPrefix,
  reorderShelfProp,
  resolveDropIndex,
  toggleShelfProp,
} from '../core/shelf-props';
import { notice, isAudioFile, collectDroppedFiles, droppedRootName } from '../util';
import { t } from '../core/i18n';
import { SetCoverModal } from './set-cover-modal';

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

export class VinylShelfView extends ItemView {
  private plugin: VinylLifePlugin;
  private unsub: (() => void) | null = null;
  private entries: ShelfEntry[] = [];
  private cardEls = new Map<string, HTMLElement>();
  private refreshTimer: number | null = null;
  private lastSnap: PlayerSnapshot | null = null;
  private state: ShelfViewState = { query: '', sort: 'title-asc', sourceFilter: 'all' };
  private toolbarTitle: HTMLElement | null = null;
  private gridHost: HTMLElement | null = null;
  private propsPopover: HTMLElement | null = null;
  private onDocClick: ((ev: MouseEvent) => void) | null = null;
  private dragKey: string | null = null; // 卡片属性弹层：正在拖拽的属性键
  private dropAt: { key: string; after: boolean } | null = null; // 当前落点（在 key 行之前/之后）

  constructor(leaf: WorkspaceLeaf, plugin: VinylLifePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return SHELF_VIEW_TYPE;
  }

  getDisplayText() {
    return '专辑墙';
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
    this.unsub = this.plugin.engine.subscribe((s) => this.updatePlaying(s));
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
    this.closePropsPopover();
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
    this.renderToolbar(c);
    this.gridHost = c.createDiv({ cls: 'vinyl-shelf-grid-host' });
    this.renderGrid();
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
    for (const [v] of RECORD_COLORS) c.toggleClass(recordClass(v), v === color);
    const cols = this.plugin.settings.shelfColumns;
    c.style.setProperty(
      '--vinyl-shelf-columns',
      cols === 'auto' || !cols
        ? 'repeat(auto-fill, minmax(230px, 1fr))'
        : `repeat(${cols}, minmax(0, 1fr))`
    );
  }

  private renderToolbar(c: HTMLElement) {
    const bar = c.createDiv({ cls: 'vinyl-shelf-toolbar' });
    this.toolbarTitle = bar.createDiv({ cls: 'vinyl-shelf-toolbar-title' });

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

    const mk = (icon: string, title: string, fn: (ev: MouseEvent) => void) => {
      // Obsidian 原生图标按钮（浅色底 + 黑色线形图标，随主题自适应，清晰易识别）
      const b = bar.createEl('button', { cls: 'clickable-icon vinyl-toolbar-icon' });
      setIcon(b, icon);
      b.setAttribute('aria-label', title);
      b.setAttribute('title', title);
      b.addEventListener('click', fn);
      return b;
    };
    mk('refresh-cw', t('shelf.refresh'), () => this.render());
    mk('arrow-up-down', t('shelf.sort'), (ev) => this.showSortMenu(ev));
    mk('filter', t('shelf.filter'), (ev) => this.showFilterMenu(ev));
    mk('sliders-horizontal', t('shelf.props'), (ev) => this.showPropsPopover(ev));
    mk('cloud-download', t('shelf.importAlbum'), () => this.plugin.openAlbumImport());
    mk('upload', t('shelf.importAudio'), () => this.plugin.openLocalImport());
  }

  private renderGrid() {
    if (!this.gridHost) return;
    this.gridHost.empty();
    this.cardEls.clear();

    const shown = this.applyViewFilters();
    const filtered = !!this.state.query || this.state.sourceFilter !== 'all';
    if (this.toolbarTitle) {
      this.toolbarTitle.textContent = filtered
        ? `专辑墙（${shown.length}/${this.entries.length}）`
        : `专辑墙（${this.entries.length} 张）`;
    }

    if (!this.entries.length) {
      const empty = this.gridHost.createDiv({ cls: 'vinyl-shelf-empty' });
      empty.createDiv({ text: t('shelf.empty.title'), cls: 'vinyl-shelf-empty-title' });
      empty.createDiv({
        text: t('shelf.empty.hint'),
        cls: 'vinyl-muted',
      });
      return;
    }
    if (!shown.length) {
      const empty = this.gridHost.createDiv({ cls: 'vinyl-shelf-empty' });
      empty.createDiv({ text: t('shelf.filtered.title'), cls: 'vinyl-shelf-empty-title' });
      empty.createDiv({ text: t('shelf.filtered.hint'), cls: 'vinyl-muted' });
      return;
    }

    const grid = this.gridHost.createDiv({ cls: 'vinyl-shelf-grid' });
    for (const e of shown) {
      grid.appendChild(this.buildCard(e));
    }
    this.wireGridDrop(grid);
    if (this.lastSnap) this.updatePlaying(this.lastSnap);
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

  // ============ 卡片属性弹层（M7）============
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

    pop.createDiv({ text: '已显示（拖拽调整顺序）', cls: 'vinyl-props-section' });
    if (!selected.length) {
      pop.createDiv({
        text: '未选择任何属性：卡片只显示标题。',
        cls: 'vinyl-props-hint',
      });
    }
    for (const key of selected) this.propsSelectedRow(pop, key, counts.get(key));

    pop.createDiv({ cls: 'vinyl-props-divider' });
    pop.createDiv({ text: '可添加（来自笔记 frontmatter）', cls: 'vinyl-props-section' });
    const rest = usage.filter((u) => !selected.includes(u.key));
    if (!this.entries.length) {
      pop.createDiv({ text: '还没有专辑笔记。先用工具栏「导入」建一张。', cls: 'vinyl-props-hint' });
    } else if (!rest.length) {
      pop.createDiv({ text: '已全部添加。', cls: 'vinyl-props-hint' });
    } else {
      for (const u of rest) this.propsAvailableRow(pop, u.key, u.count);
    }

    pop.createDiv({
      text: '属性来自专辑笔记，部分省略；在笔记中添加属性后回到这里即可添加勾选。',
      cls: 'vinyl-props-hint',
    });
  }

  // 已显示行：拖拽排序 + ✎ 改显示名 + ✕ 移除
  private propsSelectedRow(pop: HTMLElement, key: string, count?: number) {
    const row = pop.createDiv({ cls: 'vinyl-props-row is-selected' });
    row.dataset.propKey = key;
    row.setAttribute('draggable', 'true');
    row.setAttribute('title', `frontmatter 键：${key}`);
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
    if (count != null) row.createSpan({ text: `${count} 张`, cls: 'vinyl-props-count' });
    const iconBtn = (icon: string, title: string, fn: () => void) => {
      const b = row.createEl('button', { cls: 'clickable-icon vinyl-props-icon' });
      setIcon(b, icon);
      b.setAttribute('aria-label', title);
      b.setAttribute('title', title);
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fn();
      });
    };
    iconBtn('pencil', `重命名「${propLabel(key, this.plugin.settings.shelfPropLabels)}」`, () =>
      this.startPropRename(label, key)
    );
    iconBtn('x', `不再显示「${propLabel(key, this.plugin.settings.shelfPropLabels)}」`, () =>
      void this.applyShelfProps(toggleShelfProp(this.plugin.settings.shelfProps, key, false))
    );
  }

  // 可添加行：勾选即上墙（新键追加到末尾，之后可拖拽调序）
  private propsAvailableRow(pop: HTMLElement, key: string, count: number) {
    const row = pop.createDiv({ cls: 'vinyl-props-row' });
    const cb = row.createEl('input', { attr: { type: 'checkbox' } });
    const toggle = (on: boolean) =>
      void this.applyShelfProps(toggleShelfProp(this.plugin.settings.shelfProps, key, on));
    cb.addEventListener('change', () => toggle(cb.checked));
    row.addEventListener('click', (ev) => {
      if (ev.target === cb) return;
      cb.checked = !cb.checked;
      toggle(cb.checked);
    });
    row.createSpan({
      text: propLabel(key, this.plugin.settings.shelfPropLabels),
      cls: 'vinyl-props-row-label',
    });
    row.createSpan({ text: `${count} 张`, cls: 'vinyl-props-count' });
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
    const card = document.createElement('div');
    card.className = 'vinyl-shelf-card';
    card.dataset.path = album.path;
    card.setAttribute('title', album.path);
    this.cardEls.set(album.path, card);

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

    card.createDiv({ text: album.title, cls: 'vinyl-shelf-card-title' });
    // 属性行（M7）：顺序取自设置数组（不遍历 displayProps 键序——整数样键名会被 Object.keys 提前）
    const labels = this.plugin.settings.shelfPropLabels;
    const prop = (label: string, value: string) => {
      const row = card.createDiv({ cls: 'vinyl-shelf-prop' });
      row.createSpan({ text: label, cls: 'vinyl-shelf-prop-label' });
      // 长值已由 CSS 省略号截断，title 供悬停看全文
      row.createSpan({ text: value, cls: 'vinyl-shelf-prop-value', attr: { title: value } });
    };
    for (const key of this.plugin.settings.shelfProps) {
      // ?? '' 必须有：strict:false 下静态类型是 string，运行时可能键不存在
      const value = album.displayProps[key] ?? '';
      if (value === '') continue; // 无该字段 / 值无法展示 → 跳过整行（前缀也不显示）
      prop(propLabel(key, labels), propPrefix(key) + value);
    }

    // 音源标记已下线（音源可由工具栏「音源筛选」找到，播放时播放器丝印行也显示来源）；
    // 只留「无音源」提示——这类卡片点击打开笔记而非播放，需要一眼可辨。
    if (!e.local && !e.netease && !e.qq) {
      card
        .createDiv({ cls: 'vinyl-shelf-badges' })
        .createSpan({ text: '收藏 ·', cls: 'vinyl-badge is-collect' });
    }

    card.addEventListener('click', () => this.playAlbum(e));
    card.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      this.showMenu(e, ev);
    });
    // 拖拽音频到卡片 = 导入到该专辑（M4，落库模式取设置）
    card.addEventListener('dragover', (ev) => {
      if (this.hasAudioFiles(ev)) {
        ev.preventDefault();
        ev.stopPropagation();
        card.addClass('is-drag-over');
      }
    });
    card.addEventListener('dragleave', () => card.removeClass('is-drag-over'));
    card.addEventListener('drop', async (ev) => {
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
    });
    return card;
  }

  // 点击 = 黑胶交接（M3）：离墙动画 → 打开播放器 → 落盘 → 播放；纯收藏态 → 打开笔记
  private async playAlbum(e: ShelfEntry) {
    const { album } = e;
    if (!e.local && !e.netease && !e.qq) {
      const leaf = this.plugin.app.workspace.getLeaf(false);
      await leaf.openFile(album.file);
      notice('该专辑暂无音源（本地音频、neteaseId 或 QQ 音乐），已打开笔记');
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

  // 播放中高亮：当前队列所属专辑卡片描边 + 标题着色 + 唱片离墙（卡位空出）
  private updatePlaying(s: PlayerSnapshot) {
    this.lastSnap = s;
    const current = s.status !== 'idle' && s.albumNotePath ? s.albumNotePath : null;
    for (const [path, el] of this.cardEls) {
      const active = path === current;
      const wasActive = el.classList.contains('is-playing');
      if (wasActive && !active) {
        this.playDiscReturn(el);
      }
      el.classList.toggle('is-playing', active);
    }
  }

  // 唱片回归动画：与离墙动画同参数逆向（WAAPI，700ms），避免突然出现
  private playDiscReturn(cardEl: HTMLElement) {
    const lift = (cardEl as any).__vinylLift as Animation | undefined;
    if (lift) {
      lift.cancel();
      (cardEl as any).__vinylLift = null;
    }
    const prev = (cardEl as any).__vinylReturn as Animation | undefined;
    if (prev) prev.cancel();
    const disc = cardEl.querySelector('.vinyl-shelf-disc') as HTMLElement | null;
    if (!disc) return;
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
    anim.addEventListener('finish', () => cardEl.removeClass('is-returning'));
    (cardEl as any).__vinylReturn = anim;
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
    grid.addEventListener('drop', async (ev) => {
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
    });
  }

  // 音频文件或文件夹都算可接收（目录的 dataTransfer item type 为空）
  private hasAudioFiles(ev: DragEvent): boolean {
    const items = Array.from(ev.dataTransfer?.items || []);
    if (items.some((it) => it.kind === 'file' && !it.type)) return true;
    return Array.from(ev.dataTransfer?.files || []).some((f) => isAudioFile(f.name));
  }

}
