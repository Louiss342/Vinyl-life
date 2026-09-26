// 唱片区（播放器的第二面）：固定三行高的纵向唱片架。
//   每行 8 张，按书写顺序逐行填满；超过 24 张后向下增行，视窗高度不变。
//   点击换碟，队列模式下点击 = 排到队尾；Ctrl / ⌘ 点与 Shift 点支持多选，多选后可一次性加入队列。
// 视图只负责画与手势：专辑集合、换碟、排队都由播放器视图注入（与专辑墙同一套语义）。
import type { App } from 'obsidian';
import { setIcon } from 'obsidian';
import type { AlbumInfo } from '../core/album-index';
import { rangeInList, toggleInList } from '../core/multi-select';
import { t, tf } from '../core/i18n';

export interface PickerEntry {
  album: AlbumInfo;
  local: boolean;
  netease: boolean;
  qq: boolean;
  kugou: boolean;
}

/** 唱片架初始可见行数与每行容量。 */
export const PICKER_ROWS = 3;
export const PICKER_COLUMNS = 8;
/** 鼠标横向划过当前行时的最大视差幅度（px）。 */
const PARALLAX_PX = 22;
/** 从第几列（0 基）起算右半区：这些唱片展开时会顶到右边界，整行要等量左移补偿。
 *  口径同 styles.css 的 .vinyl-picker-row.is-hover-shift（本文件是唯一给它挂类的地方）。 */
const SHIFT_FROM_COLUMN = 4;

/** 每行「当前算数（悬停 / 键盘焦点）的右半区唱片」：任一张在集合里，整行就左移。
 *  按行存，所以同一行里滑来滑去不会互相打架（见 bindRowShift）。 */
const rowShiftOwners = new WeakMap<HTMLElement, Set<HTMLElement>>();

/** 顺序分行：先填满上一行，且始终保留至少三行的架子。 */
export function pickerRows<T>(items: T[], columns = PICKER_COLUMNS): T[][] {
  const safeColumns = Math.max(1, columns);
  const rowCount = Math.max(PICKER_ROWS, Math.ceil(items.length / safeColumns));
  const out: T[][] = Array.from({ length: rowCount }, (): T[] => []);
  items.forEach((item, i) => out[Math.floor(i / safeColumns)].push(item));
  return out;
}

export type PickIntent = 'switch' | 'toggle' | 'range';

/** 修饰键 + 当前有没有选中 → 这次点击是什么意思：
 *  什么都没选 = 点谁换谁（队列模式下是排队）；已经在多选 = 点谁选谁；Ctrl/⌘ = 切换；Shift = 连选。 */
export function pickIntent(
  mod: { ctrl: boolean; meta: boolean; shift: boolean },
  hasSelection: boolean
): PickIntent {
  if (mod.shift) return 'range';
  if (mod.ctrl || mod.meta) return 'toggle';
  return hasSelection ? 'toggle' : 'switch';
}

export interface AlbumPickerDeps {
  app: App;
  /** 读当前专辑集合（专辑墙同一套扫描：笔记 + 音源角标） */
  load: () => PickerEntry[];
  /** 正在播放的专辑路径（高亮当前那张） */
  currentPath: () => string | undefined;
  /** 点一张专辑 = 换碟（播放器封装的完整路径：翻回页面 1 + 取碟播放） */
  switchTo: (album: AlbumInfo) => void;
  /** 多选后「加入队列」：按选中顺序逐张排队 */
  enqueue: (albums: AlbumInfo[]) => void;
  /** 返回播放器（页面 1） */
  back: () => void;
}

export class AlbumPicker {
  readonly el: HTMLElement;
  private entries: PickerEntry[] = [];
  /** 已选专辑路径（保序：加入队列按点选顺序） */
  private selection: string[] = [];
  /** Shift 连选的锚点（最近一次点过的专辑） */
  private anchor = '';
  private crate: HTMLElement;
  private track: HTMLElement;
  private actions: HTMLElement;
  private countEl: HTMLElement;
  private enqueueBtn: HTMLButtonElement;
  private clearBtn: HTMLButtonElement;
  /** 只记录当前指针所在行：视差不应该同时推动下方各行。 */
  private parallaxRow: HTMLElement | null = null;

  constructor(private deps: AlbumPickerDeps) {
    const el = createDiv({ cls: 'vinyl-picker' });
    this.el = el;

    this.crate = el.createDiv({ cls: 'vinyl-picker-crate' });
    this.track = this.crate.createDiv({ cls: 'vinyl-picker-track' });

    // 底部动作条：只在有选中时出现（多选 → 一次加入队列）
    this.actions = el.createDiv({ cls: 'vinyl-picker-actions' });
    this.countEl = this.actions.createDiv({ cls: 'vinyl-picker-count' });
    this.enqueueBtn = this.actions.createEl('button', { cls: 'vinyl-btn vinyl-btn-small' });
    setIcon(this.enqueueBtn, 'list-plus');
    this.enqueueBtn.addEventListener('click', () => this.enqueueSelection());
    this.clearBtn = this.actions.createEl('button', { cls: 'vinyl-btn vinyl-btn-small' });
    setIcon(this.clearBtn, 'x');
    this.clearBtn.addEventListener('click', () => this.clearSelection());

    // 点击委托挂在箱子上（行随数据重建，逐张挂监听会随 DOM 一起丢掉）
    this.crate.addEventListener('click', (ev) => this.onClick(ev));
    // 键盘：Shift+Enter / Shift+空格 = 多选切换（原生按钮的 Enter / 空格走 click，不带修饰键）
    this.crate.addEventListener('keydown', (ev) => this.onKeydown(ev));
    this.crate.addEventListener('pointermove', (ev) => this.onPointerMove(ev));
    this.crate.addEventListener('pointerleave', () => this.clearParallax());
    this.applyLabels();
    this.render();
  }

  // ============ 渲染 ============

  /** 重扫专辑集合并重建唱片架（每次翻到这一面时调用） */
  render() {
    this.entries = this.deps.load();
    this.selection = this.selection.filter((p) => this.entries.some((e) => e.album.path === p));
    this.clearParallax();
    this.track.empty();
    this.crate.scrollTop = 0;

    if (!this.entries.length) {
      // 一张专辑都没有：给一句去哪儿导入的提示，别留个空箱子
      this.track.createDiv({ cls: 'vinyl-picker-empty vinyl-muted', text: t('picker.empty') });
      this.applyLabels();
      return;
    }
    // 新排入的专辑排在当前之后：把正在播放的那张排在最前，找起来顺手
    const current = this.deps.currentPath();
    const albums = this.entries.map((e) => e.album);
    const order = current && albums.some((a) => a.path === current)
      ? [albums.find((a) => a.path === current), ...albums.filter((a) => a.path !== current)]
      : albums;
    const byPath = new Map(this.entries.map((e) => [e.album.path, e]));
    const rows = pickerRows(order);
    rows.forEach((rowAlbums, rowIdx) => {
      const row = this.track.createDiv({ cls: 'vinyl-picker-row' });
      // 保留原有的层次感：越靠下视差系数越大，但只在该行被指向时生效。
      row.style.setProperty('--vinyl-row-k', (0.45 + rowIdx * 0.35).toFixed(2));
      rowAlbums.forEach((album, col) => this.buildTile(row, byPath.get(album.path), col));
    });
    this.applyLabels();
  }

  private buildTile(row: HTMLElement, entry: PickerEntry, col: number) {
    const { album } = entry;
    const tile = row.createEl('button', { cls: 'vinyl-pick' });
    tile.dataset.path = album.path;
    // 悬停提示只报专辑名（Obsidian 按 aria-label 出提示气泡；点选语义由界面自己说明）
    tile.setAttribute('aria-label', album.title);
    // 正在播的那张唱片：类名给视觉，aria-current 给读屏（只靠颜色的话，读屏用户不知道现在放的是哪张）
    const isCurrent = album.path === this.deps.currentPath();
    if (isCurrent) tile.addClass('is-current');
    tile.setAttribute('aria-current', isCurrent ? 'true' : 'false');
    if (this.selection.includes(album.path)) tile.addClass('is-selected');

    const cover = tile.createSpan({ cls: 'vinyl-pick-cover' });
    if (album.cover) {
      cover.createEl('img', { attr: { src: album.cover, alt: '' } });
    } else if (album.coverRaw) {
      const color = cover.createSpan({ cls: 'vinyl-pick-color' });
      color.style.background = String(album.coverRaw);
      color.createSpan({ text: '♪' });
    } else {
      cover.createSpan({ cls: 'vinyl-pick-color is-empty', text: '♪' });
    }
    // 专辑名在悬停 / 键盘焦点时浮在封面底部，不参与排版。
    tile.createSpan({ cls: 'vinyl-pick-name', text: album.title });
    tile.createSpan({ cls: 'vinyl-pick-mark' });
    if (!entry.local && !entry.netease && !entry.qq && !entry.kugou) tile.addClass('is-collect');
    // 只有右半区（第 5 列起）展开时才需要整行左移，左半区挂监听也没用
    if (col >= SHIFT_FROM_COLUMN) this.bindRowShift(row, tile);
  }

  /** 右半区的唱片被悬停 / 键盘聚焦时给整行挂上左移类（.vinyl-picker-row.is-hover-shift）。
   *  为什么不用选择器 :has：它要由子元素反查父元素，会触发大范围选择器失效（审核的性能警告）。
   *  判定与原来那两条选择器一一对应：
   *    · hover 用 mouseenter / mouseleave，而不是 matches(':hover') —— 后者在离开事件里读到的
   *      状态取决于浏览器的更新时序，读到旧值就会留下一行错位的唱片；
   *    · 焦点要求 :focus-visible（键盘过来的才算）：鼠标点选后唱片并不展开，行却左移会很怪。
   *  状态记成「本行当前有几张算数」的集合，而不是每张各挂一个布尔量：从一张滑到另一张时
   *  两个事件谁先谁后由浏览器定，布尔量会拼出「还悬着却已复位」的中途态，集合则只增删自己那个。 */
  private bindRowShift(row: HTMLElement, tile: HTMLElement): void {
    let owners = rowShiftOwners.get(row);
    if (!owners) {
      owners = new Set();
      rowShiftOwners.set(row, owners);
    }
    const active = owners;
    const sync = () => row.toggleClass('is-hover-shift', active.size > 0);
    const mark = (on: boolean) => {
      if (on) active.add(tile);
      else active.delete(tile);
      sync();
    };
    tile.addEventListener('mouseenter', () => mark(true));
    tile.addEventListener('mouseleave', () => mark(false));
    tile.addEventListener('focusin', () => mark(tile.matches(':focus-visible')));
    tile.addEventListener('focusout', () => mark(false));
  }

  /** 语言切换后就地更新文案（不重建唱片架：展开态 / 滚动位置都保留） */
  applyLabels() {
    this.countEl.textContent = tf('picker.selected', { n: this.selection.length });
    this.enqueueBtn.setAttribute('aria-label', t('picker.enqueue'));
    this.clearBtn.setAttribute('aria-label', t('picker.clear'));
    this.actions.toggleClass('is-on', this.selection.length > 0);
  }

  /** 选中变化后只改类与计数（不重建，展开态与滚动位置都不动） */
  private syncSelection() {
    const set = new Set(this.selection);
    for (const tile of Array.from(this.track.querySelectorAll<HTMLElement>('.vinyl-pick'))) {
      tile.toggleClass('is-selected', set.has(tile.dataset.path || ''));
    }
    this.countEl.textContent = tf('picker.selected', { n: this.selection.length });
    this.actions.toggleClass('is-on', this.selection.length > 0);
  }

  // ============ 手势 ============

  private onClick(ev: MouseEvent) {
    const node = ev.targetNode;
    const tile = node && node.instanceOf(HTMLElement) ? node.closest<HTMLElement>('.vinyl-pick') : null;
    if (!tile) {
      this.clearSelection(); // 点箱子空白 = 取消选择
      return;
    }
    const path = tile.dataset.path || '';
    const intent = pickIntent(
      { ctrl: ev.ctrlKey, meta: ev.metaKey, shift: ev.shiftKey },
      this.selection.length > 0
    );
    if (intent === 'switch') {
      const entry = this.entries.find((e) => e.album.path === path);
      if (entry) this.deps.switchTo(entry.album);
      return;
    }
    if (intent === 'toggle') {
      this.selection = toggleInList(this.selection, path);
      this.anchor = path;
      this.syncSelection();
      return;
    }
    this.selection = rangeInList(
      this.selection,
      this.entries.map((e) => e.album.path),
      this.anchor || path,
      path
    );
    this.anchor = path;
    this.syncSelection();
  }

  private onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      // 阻止冒泡：视图层（播放器）也盯着 Esc，别让它再翻一次面（一处手势一件事）
      ev.stopPropagation();
      if (this.selection.length) this.clearSelection();
      else this.deps.back();
      return;
    }
    // 原生按钮的 Enter / 空格会自己发 click（走「换碟」）；带 Shift 时改成多选切换
    if (!ev.shiftKey || (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar')) return;
    const node = ev.target as HTMLElement | null;
    const tile =
      node && typeof node.closest === 'function' ? node.closest<HTMLElement>('.vinyl-pick') : null;
    if (!tile) return;
    ev.preventDefault();
    const path = tile.dataset.path || '';
    this.selection = toggleInList(this.selection, path);
    this.anchor = path;
    this.syncSelection();
  }

  private onPointerMove(ev: PointerEvent) {
    const node = ev.targetNode;
    const row = node && node.instanceOf(HTMLElement) ? node.closest<HTMLElement>('.vinyl-picker-row') : null;
    if (!row) {
      this.clearParallax();
      return;
    }
    if (this.parallaxRow && this.parallaxRow !== row) {
      this.parallaxRow.setCssProps({ '--vinyl-parallax': '0px' });
    }
    const rect = this.crate.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)) - 0.5;
    this.parallaxRow = row;
    row.setCssProps({ '--vinyl-parallax': `${(-ratio * PARALLAX_PX).toFixed(1)}px` });
  }

  private clearParallax() {
    this.parallaxRow?.setCssProps({ '--vinyl-parallax': '0px' });
    this.parallaxRow = null;
  }

  /** 清空选择（点箱子空白 / Esc / 播放器视图代为清理都走这里） */
  clearSelection() {
    if (!this.selection.length) return;
    this.selection = [];
    this.anchor = '';
    this.syncSelection();
  }

  private enqueueSelection() {
    // 按「点选顺序」排队（selection 是保序的），与用户心里的先后一致
    const picked = this.selection
      .map((p) => this.entries.find((e) => e.album.path === p)?.album)
      .filter((a): a is AlbumInfo => !!a);
    if (!picked.length) return;
    this.deps.enqueue(picked);
    this.clearSelection();
  }

  /** 当前是否处于多选（播放器视图在切面 / 关闭时用它决定要不要拦 Escape） */
  hasSelection(): boolean {
    return this.selection.length > 0;
  }
}
