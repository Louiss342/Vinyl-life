// 设置页的独立「统计」标签：日历热力图、当日唱片墙、最近/最多、自定义属性统计。
// 版式跟着通用 / 外观 / 源 走：每张卡片就是一个设置分区（标题栏 + 图标徽章 + 内容区），
// 壳由 views/settings-section 提供，这里只负责内容。
import { Modal, Setting, TFile, setIcon } from 'obsidian';
import type VinylLifePlugin from '../main';
import { findAlbumNotes, getAlbumInfo } from '../core/album-index';
import {
  albumTitleOf,
  calendarColumns,
  calendarMonthLabels,
  localDayKey,
  playsByDay,
  startOfLocalDay,
} from '../core/stats';
import { propLabel } from '../core/shelf-props';
import { SettingsSection, settingsSection } from './settings-section';
import { markVinylModal, notice } from '../util';
import { t, tf } from '../core/i18n';

/** 备份体积：不到 1 MB 按 KB 报，再往上按 MB（一位小数）—— 只求一眼看出量级 */
function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDay(key: string): string {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

class RestoreAlbumModal extends Modal {
  constructor(
    private plugin: VinylLifePlugin,
    private albumPath: string,
    private albumName: string,
    private onRestored: () => void
  ) {
    super(plugin.app);
    markVinylModal(this); // 全直角：弹窗壳收掉圆角（见 styles.css「全直角」段）
    this.titleEl.setText(t('stats.removedTitle'));
  }

  onOpen(): void {
    this.contentEl.createEl('p', {
      text: tf('stats.removedDesc', { title: this.albumName }),
    });
    this.contentEl.createEl('p', {
      text: t('stats.restoreHint'),
      cls: 'vinyl-muted',
    });
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: t('common.cancel') }).onclick = () => this.close();
    const restore = actions.createEl('button', {
      text: t('stats.restoreAction'),
      cls: 'mod-cta',
    });
    restore.onclick = async () => {
      restore.disabled = true;
      if (await this.plugin.restoreAlbumFromStats(this.albumPath)) {
        this.close();
        this.onRestored();
      } else {
        restore.disabled = false;
      }
    };
  }
}

class RestoreDataModal extends Modal {
  private selected: File | null = null;

  constructor(private plugin: VinylLifePlugin, private onRestored: () => void) {
    super(plugin.app);
    markVinylModal(this);
    this.titleEl.setText(t('backup.restore'));
  }

  onOpen(): void {
    this.contentEl.createEl('p', { text: t('backup.restoreHint') });
    const input = this.contentEl.createEl('input', { attr: { type: 'file', accept: '.json,application/json' } });
    input.addEventListener('change', () => { this.selected = input.files?.[0] ?? null; });
    // 状态行：恢复备份的每一步（选文件 / 恢复中 / 失败原因）都写在这里，标成 status 让读屏软件播报
    const status = this.contentEl.createEl('p', {
      cls: 'vinyl-muted vinyl-restore-status',
      attr: { role: 'status' },
    });
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: t('common.cancel') }).onclick = () => this.close();
    const restore = actions.createEl('button', { text: t('backup.restore'), cls: 'mod-warning' });
    restore.onclick = async () => {
      if (!this.selected) { status.setText(t('backup.chooseFile')); return; }
      restore.disabled = true;
      try {
        await this.plugin.restoreDataBackup(await this.selected.text());
        this.close();
        this.onRestored();
      } catch (e) {
        status.setText((e as Error).message);
        restore.disabled = false;
      }
    };
  }
}

/** 清除统计的确认：这是不可撤销的动作，「删掉什么」摆在这按下去之前。 */
export class ClearStatsModal extends Modal {
  constructor(
    private plugin: VinylLifePlugin,
    private onDone: () => void
  ) {
    super(plugin.app);
    markVinylModal(this);
    this.titleEl.setText(t('settings.clearStats'));
  }

  onOpen(): void {
    const c = this.contentEl;
    c.createEl('p', { text: t('data.clearScope') });
    // 同一张卡上的其它破坏性动作都有安全网（裁剪前必归档、恢复前必自动备份），
    // 只有这个原本没有 —— 补一个默认勾选的「先备份一份」。
    const backupFirst = c.createEl('label', { cls: 'vinyl-delete-opt' });
    const cb = backupFirst.createEl('input', { attr: { type: 'checkbox' } });
    cb.checked = true;
    const text = backupFirst.createDiv({ cls: 'vinyl-delete-opt-text' });
    text.createDiv({ text: t('data.clearBackupFirst') });
    text.createDiv({ text: t('data.clearBackupHint'), cls: 'vinyl-muted vinyl-delete-opt-detail' });
    const actions = c.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: t('common.cancel') }).onclick = () => this.close();
    const go = actions.createEl('button', { text: t('settings.clearStats'), cls: 'mod-warning' });
    go.onclick = async () => {
      go.disabled = true;
      cb.disabled = true;
      try {
        if (cb.checked) {
          const file = await this.plugin.exportDataBackup();
          notice(tf('backup.created', { path: file.path }));
        }
        await this.plugin.clearPlaybackStats();
      } catch (e) {
        notice(tf('stats.clearFailed', { msg: (e as Error).message }));
        go.disabled = false;
        cb.disabled = false;
        return;
      }
      this.close();
      this.onDone();
    };
  }
}

export class StatsPage {
  private selectedDay = '';
  /** 热力图的 roving 停靠点（哪个日期键上的格子 tabIndex=0）——重绘后据此复位（见 wireHeatmap） */
  private heatmapCursor = '';
  /** 点/回车选中某一天之后，把焦点接回那一格（重绘会把 DOM 换掉） */
  private focusDay = '';
  private selectedProp = '';
  /** 专辑侧属性键的签名缓存（见 albumPropKeys） */
  private propKeyCache: { sig: string; keys: string[] } | null = null;

  constructor(
    private plugin: VinylLifePlugin,
    private rerender: () => void
  ) {}

  render(root: HTMLElement): void {
    root.addClass('vinyl-stats-page');
    this.renderSummary(root);

    const calendar = this.card(root, t('stats.calendar'), 'stats-calendar', 'calendar-days');
    this.renderCalendar(calendar.body);

    const day = this.card(
      root,
      this.selectedDay ? fmtDay(this.selectedDay) : t('stats.dayAlbums'),
      'stats-day',
      'disc-3'
    );
    this.renderSelectedDay(day.body);

    const pair = root.createDiv({ cls: 'vinyl-stats-pair' });
    this.renderRanking(pair, 'recent');
    this.renderRanking(pair, 'top');

    this.renderCustom(root);
    this.renderDataManagement(root);
  }

  /** 数据管理：备份去哪、最近一次成功备份、每周自动备份与保留份数，末尾是四个动作按钮。
   *  版式与其它卡片一致 —— 全靠「行 + 值」，不写浮着的小字说明（用户嫌乱）。
   *  「清空删掉什么」摆在该看见的地方：按下去之前的确认弹窗里（见 ClearStatsModal）。 */
  private renderDataManagement(parent: HTMLElement): void {
    const p = this.plugin;
    const body = this.card(parent, t('data.title'), 'stats-data', 'database').body;
    // 恢复备份之后到重启之前：写入被关掉，必须常驻说出来（见 main.ts 的 awaitingRestartAfterRestore）
    if (p.awaitingRestartAfterRestore) {
      body.createDiv({ text: t('backup.restartBanner'), cls: 'vinyl-error vinyl-restart-banner' });
    }
    // 只读状态行：名称在左、值在右（与设置页的登录状态行同一套做法）
    const valueRow = (name: string, value: string) => {
      const row = new Setting(body).setName(name);
      row.settingEl.addClass('vinyl-data-row');
      row.controlEl.createDiv({ cls: 'vinyl-data-value', text: value });
    };
    valueRow(t('data.backupPlace'), p.backupFolderPath() + '/');
    // 备份目录自己在长大：份数与体积摆出来（手动备份与裁剪归档刻意不自动清，用户至少要看得见）
    const inventory = p.backupInventory();
    if (inventory.count > 0) {
      valueRow(
        t('data.backupOnDisk'),
        tf('data.backupOnDiskValue', { n: inventory.count, size: formatBytes(inventory.bytes) })
      );
    }
    valueRow(
      t('data.lastBackup'),
      p.settings.lastBackupAt
        ? new Date(p.settings.lastBackupAt).toLocaleString()
        : t('data.neverBackedUp')
    );
    new Setting(body)
      .setName(t('data.autoBackup'))
      .addToggle((tg) =>
        tg.setValue(p.settings.autoBackup).onChange(async (v) => {
          p.settings.autoBackup = v;
          await p.saveSettings();
        })
      );
    new Setting(body)
      .setName(t('data.keepCount'))
      .addDropdown((d) => {
        for (const n of [1, 3, 5, 10]) d.addOption(String(n), tf('data.keepN', { n }));
        d.setValue(String(p.settings.backupKeep)).onChange(async (v) => {
          p.settings.backupKeep = Number(v) || 3;
          await p.saveSettings();
        });
      });
    this.renderActions(body);
  }

  /** 累计播放：手写体一行（Drawing 2026-09-17 16.15.55）——
   *  大号「233 次播放」+ 隔一段空白后的「听过 N 张专辑」「播放曲目 N 首」，
   *  数字放大、单位是小字。字形与「关于」页同一对子集字体，字号取图纸的绝对 px（见 styles.css）。 */
  private renderSummary(root: HTMLElement): void {
    const stats = this.plugin.settings.stats;
    const hero = this.card(root, t('stats.totalLabel'), 'stats-summary', 'chart-no-axes-column');
    const hand = hero.body.createDiv({ cls: 'vinyl-stats-hand' });
    const group = (label: string, num: string, unit: string) => {
      const box = hand.createSpan({ cls: 'vinyl-stats-hand-group' });
      if (label) box.createSpan({ cls: 'vinyl-stats-hand-small', text: label });
      box.createSpan({ cls: 'vinyl-stats-hand-num', text: num });
      box.createSpan({ cls: 'vinyl-stats-hand-small', text: unit });
    };
    group('', String(stats.totalPlays), t('stats.unitPlays'));
    group(t('stats.unitListened'), String(Object.keys(stats.albums).length), t('stats.unitAlbums'));
    group(t('stats.unitTracks'), String(Object.keys(stats.tracks).length), t('stats.unitSongs'));
  }

  /** 一张统计卡片：设置分区的壳（与通用 / 外观 / 源 同一个），内容区带统计页的内边距 */
  private card(parent: HTMLElement, title: string, kind: string, icon: string): SettingsSection {
    const section = settingsSection(parent, title, kind, icon);
    section.body.addClass('vinyl-stats-body');
    return section;
  }

  private renderCalendar(parent: HTMLElement): void {
    const byDay = playsByDay(this.plugin.settings.stats);
    const today = startOfLocalDay(new Date());
    // 时间倒序：第 0 列就是含今天的那一周 —— 打开面板先看到最近的播放，不用横向拖到底
    const columns = calendarColumns(today);
    const max = Math.max(1, ...Array.from(byDay.values(), (events) => events.length));
    const scroll = parent.createDiv({ cls: 'vinyl-stats-calendar-scroll' });

    // 月份标题与格子同列宽（13px）。只有 1 列的月份标题比格子宽，靠右对齐让文字落进左邻的空档
    const months = scroll.createDiv({ cls: 'vinyl-stats-months' });
    const labels = new Map(calendarMonthLabels(columns, today).map((l) => [l.column, l]));
    for (let c = 0; c < columns.length; c++) {
      const label = labels.get(c);
      months.createSpan({
        text: label ? label.month.toLocaleDateString(undefined, { month: 'short' }) : '',
        cls: label?.span === 1 ? 'is-narrow' : '',
      });
    }

    const chartRow = scroll.createDiv({ cls: 'vinyl-stats-calendar-row' });
    const weekdays = chartRow.createDiv({ cls: 'vinyl-stats-weekdays' });
    ['', t('stats.weekMon'), '', t('stats.weekWed'), '', t('stats.weekFri'), ''].forEach((label) =>
      weekdays.createSpan({ text: label })
    );
    const grid = chartRow.createDiv({ cls: 'vinyl-stats-heatmap' });
    const cells: HTMLElement[] = [];
    // 列优先铺（grid-auto-flow: column，每列 7 格 = 日→六），列序 = 时间倒序
    for (const column of columns) {
      for (const date of column.days) {
        const key = localDayKey(date.getTime());
        const count = byDay.get(key)?.length ?? 0;
        const level = count ? Math.max(1, Math.ceil((count / max) * 4)) : 0;
        const future = date.getTime() > today.getTime();
        const cell = grid.createEl('button', {
          cls: `vinyl-stats-day is-level-${level}${this.selectedDay === key ? ' is-selected' : ''}${future ? ' is-future' : ''}`,
          attr: {
            type: 'button',
            'aria-label': tf('stats.dayTooltip', { date: fmtDay(key), n: count }),
            ...(future ? { disabled: 'true' } : {}),
          },
        });
        cell.onclick = () => {
          this.selectedDay = key;
          this.heatmapCursor = key; // 重绘之后焦点要回到这一格（见 wireHeatmap 的 focusDay）
          this.focusDay = key;
          this.rerender();
        };
        cells.push(cell);
      }
    }
    this.wireHeatmap(grid, cells, columns.flatMap((c) => c.days.map((d) => localDayKey(d.getTime()))));
    const legend = parent.createDiv({ cls: 'vinyl-stats-legend' });
    legend.createSpan({ text: t('stats.less') });
    for (let i = 0; i <= 4; i++) legend.createSpan({ cls: `vinyl-stats-legend-cell is-level-${i}` });
    legend.createSpan({ text: t('stats.more') });
  }

  /** 专辑侧的属性键集合：全库扫一遍 frontmatter。
   *  带签名缓存（路径 + mtime）—— 这一步要为每张专辑解析一次 frontmatter 与封面，
   *  而它每次重绘都要跑（改一下属性下拉、点一下日历格都算重绘），大库上就是白扫几百遍。
   *  mtime 变了（改了笔记 / 增删了专辑）才重扫；统计快照那一半很便宜，不进缓存。 */
  private albumPropKeys(): string[] {
    const files = findAlbumNotes(this.plugin.app);
    const sig = files.map((f) => `${f.path}:${f.stat?.mtime ?? 0}`).join('|');
    if (this.propKeyCache?.sig === sig) return this.propKeyCache.keys;
    const keys = new Set<string>();
    for (const file of files) {
      const album = getAlbumInfo(this.plugin.app, file, { coverFolder: this.plugin.settings.coverFolder });
      Object.keys(album?.displayProps ?? {}).forEach((key) => keys.add(key));
    }
    const list = Array.from(keys);
    this.propKeyCache = { sig, keys: list };
    return list;
  }

  /** 热力图的键盘导航：整张图只留**一个** Tab 停靠点（roving tabindex），方向键在格间走。
   *
   *  为什么：53 周 × 7 天 = 371 个格子，每格都是 <button> 就是 371 个停靠点 ——
   *  键盘用户要按几百下才走得出这张图（审计点名）。改成 ARIA 网格的常规做法：
   *  只有「游标」那一格 tabIndex=0，其余 -1；焦点落在哪一格，游标就跟到哪一格。
   *  左右 = ±7 天（一周），上下 = ±1 天，Home / End 到首尾；未来格是 disabled，
   *  不能聚焦，往那个方向走时跳过它们（不改变「一周 = 7 格」的映射）。
   *
   *  keys 与 cells 一一对应（列优先：列 = 周、行 = 星期），用来把焦点换算回日期键 ——
   *  重绘之后按 heatmapCursor 把停靠点放回原处，点格子触发重绘时再由 focusDay 把焦点接回去。 */
  private wireHeatmap(grid: HTMLElement, cells: HTMLElement[], keys: string[]): void {
    const total = cells.length;
    if (!total) return;
    const disabled = (i: number) => (cells[i] as HTMLButtonElement).disabled;
    const cursorAt = () => {
      const at = this.heatmapCursor ? keys.indexOf(this.heatmapCursor) : -1;
      if (at >= 0) return at;
      const selected = this.selectedDay ? keys.indexOf(this.selectedDay) : -1;
      return selected >= 0 ? selected : 0;
    };
    const paint = (i: number, focus: boolean) => {
      const at = Math.max(0, Math.min(total - 1, i));
      cells.forEach((el, n) => (el.tabIndex = n === at ? 0 : -1));
      this.heatmapCursor = keys[at] ?? '';
      if (focus) cells[at]?.focus();
    };
    // 落在 disabled 格上就沿同一方向找最近的可用格（走到边界就原地不动）
    const step = (from: number, delta: number) => {
      let i = from;
      while (i >= 0 && i < total && disabled(i)) i += delta;
      return i >= 0 && i < total ? i : from;
    };
    paint(cursorAt(), false);
    if (this.focusDay) {
      const i = keys.indexOf(this.focusDay);
      this.focusDay = '';
      if (i >= 0) paint(i, true);
    }
    grid.addEventListener('keydown', (ev) => {
      const delta =
        ev.key === 'ArrowLeft' ? -7 : ev.key === 'ArrowRight' ? 7 : ev.key === 'ArrowUp' ? -1 : ev.key === 'ArrowDown' ? 1 : 0;
      if (delta) {
        ev.preventDefault();
        // 不让方向键漏给全局快捷键（与专辑墙 / 队列的键盘处理同一条纪律）
        ev.stopPropagation();
        paint(step(cursorAt() + delta, delta > 0 ? 1 : -1), true);
        return;
      }
      if (ev.key === 'Home' || ev.key === 'End') {
        ev.preventDefault();
        ev.stopPropagation();
        paint(step(ev.key === 'Home' ? 0 : total - 1, ev.key === 'Home' ? 1 : -1), true);
      }
    });
    grid.addEventListener('focusin', (ev) => {
      const i = cells.indexOf(ev.target as HTMLElement);
      if (i >= 0) paint(i, false);
    });
  }

  private renderSelectedDay(parent: HTMLElement): void {
    // 还没选日期时什么都不放：内容区空着会自己收起，这张卡只剩标题栏
    if (!this.selectedDay) return;
    const paths = Array.from(
      new Set(
        (playsByDay(this.plugin.settings.stats).get(this.selectedDay) ?? [])
          .map((event) => event.albumPath)
          .filter((path): path is string => !!path)
      )
    );
    if (!paths.length) {
      parent.createDiv({ cls: 'vinyl-stats-empty', text: t('stats.noDayRecords') });
      return;
    }
    const wall = parent.createDiv({ cls: 'vinyl-stats-album-wall' });
    for (const path of paths) this.renderAlbumCover(wall, path);
  }

  private renderAlbumCover(parent: HTMLElement, albumPath: string, compact = false): void {
    const stat = this.plugin.settings.stats.albums[albumPath];
    if (!stat) return;
    const current = this.plugin.app.vault.getAbstractFileByPath(albumPath);
    const exists = current instanceof TFile;
    const album = exists
      ? getAlbumInfo(this.plugin.app, current, { coverFolder: this.plugin.settings.coverFolder })
      : null;
    const name = album?.title || albumTitleOf(albumPath, stat);
    const coverSrc = album?.cover || this.plugin.statsCoverSrc(stat.snapshot);
    // 悬停提示走 aria-label（宿主会画成样式化气泡）：用 title 会和它叠成两个
    const label = exists ? name : tf('stats.removedBadgeTitle', { title: name });
    const button = parent.createEl('button', {
      cls: `vinyl-stats-album${compact ? ' is-compact' : ''}${exists ? '' : ' is-removed'}`,
      attr: { type: 'button', 'aria-label': label },
    });
    const art = button.createDiv({ cls: 'vinyl-stats-album-art' });
    if (coverSrc && !/^#[0-9a-f]{3,8}$/i.test(coverSrc)) {
      // 当日唱片墙 / 排行也是成排的封面：同样 lazy（alt 有名字，这里不是装饰图）
      art.createEl('img', {
        attr: { src: coverSrc, alt: name, loading: 'lazy', decoding: 'async' },
      });
    } else {
      const fallback = art.createDiv({ cls: 'vinyl-stats-album-fallback', text: name.slice(0, 1) || '♪' });
      if (coverSrc) fallback.style.background = coverSrc;
    }
    if (!exists) {
      const badge = art.createSpan({ cls: 'vinyl-stats-removed-badge' });
      setIcon(badge, 'archive-restore');
      badge.createSpan({ text: t('stats.removedBadge') });
    }
    // 墙上只留封面：专辑名走悬停提示（title）与 img 的 alt，不再占一行文字
    button.onclick = () => {
      if (!exists) {
        new RestoreAlbumModal(this.plugin, albumPath, name, this.rerender).open();
        return;
      }
      void this.plugin.playAlbumFromStats(albumPath, button);
    };
  }

  private renderRanking(parent: HTMLElement, kind: 'recent' | 'top'): void {
    const card = this.card(
      parent,
      t(kind === 'recent' ? 'stats.recent' : 'stats.top'),
      'stats-ranking',
      kind === 'recent' ? 'history' : 'trending-up'
    );
    const albums = Object.entries(this.plugin.settings.stats.albums)
      .sort((a, b) =>
        kind === 'recent' ? b[1].lastPlayedAt - a[1].lastPlayedAt : b[1].plays - a[1].plays
      )
      .slice(0, 8);
    if (!albums.length) {
      card.body.createDiv({ cls: 'vinyl-stats-empty', text: t('stats.noRecords') });
      return;
    }
    const list = card.body.createDiv({ cls: 'vinyl-stats-ranking-list' });
    for (const [path, stat] of albums) {
      const row = list.createDiv({ cls: 'vinyl-stats-ranking-row' });
      this.renderAlbumCover(row, path, true);
      const text = row.createDiv({ cls: 'vinyl-stats-ranking-copy' });
      text.createDiv({ cls: 'vinyl-stats-ranking-name', text: albumTitleOf(path, stat) });
      text.createDiv({
        cls: 'vinyl-muted',
        text:
          kind === 'top'
            ? tf('stats.plays', { n: stat.plays })
            : new Date(stat.lastPlayedAt).toLocaleString(),
      });
    }
  }

  private renderCustom(parent: HTMLElement): void {
    const card = this.card(parent, t('stats.custom'), 'stats-custom', 'chart-pie');
    const keys = new Set<string>(this.albumPropKeys());
    for (const stat of Object.values(this.plugin.settings.stats.albums)) {
      Object.keys(stat.snapshot?.displayProps ?? {}).forEach((key) => keys.add(key));
    }
    const sorted = Array.from(keys).sort((a, b) => propLabel(a).localeCompare(propLabel(b)));
    card.heading.addDropdown((d) => {
      d.addOption('', t('stats.chooseProperty'));
      for (const key of sorted) d.addOption(key, propLabel(key));
      d.setValue(this.selectedProp);
      d.onChange((value) => {
        this.selectedProp = value;
        this.rerender();
      });
    });
    if (!this.selectedProp) return; // 没选属性时只剩标题栏 + 下拉（内容区空着会自己收起）

    const groups = new Map<string, { plays: number; albums: number }>();
    for (const [albumPath, stat] of Object.entries(this.plugin.settings.stats.albums)) {
      const current = this.plugin.app.vault.getAbstractFileByPath(albumPath);
      const album = current instanceof TFile ? getAlbumInfo(this.plugin.app, current) : null;
      const value = album?.displayProps[this.selectedProp] || stat.snapshot?.displayProps?.[this.selectedProp];
      if (!value) continue;
      const group = groups.get(value) ?? { plays: 0, albums: 0 };
      group.plays += stat.plays;
      group.albums++;
      groups.set(value, group);
    }
    const grid = card.body.createDiv({ cls: 'vinyl-stats-custom-grid' });
    for (const [value, group] of Array.from(groups).sort((a, b) => b[1].plays - a[1].plays)) {
      const item = grid.createDiv({ cls: 'vinyl-stats-custom-item' });
      item.createDiv({ cls: 'vinyl-stats-custom-value', text: value });
      item.createDiv({
        cls: 'vinyl-muted',
        text: tf('stats.customResult', { plays: group.plays, albums: group.albums }),
      });
    }
    if (!groups.size) grid.createDiv({ cls: 'vinyl-stats-empty', text: t('stats.noPropertyRecords') });
  }

  private renderActions(parent: HTMLElement): void {
    // 按钮就落在「数据管理」卡片里（不再单独一张卡）：上面那几行说明是它们的上下文
    const actions = parent.createDiv({ cls: 'vinyl-stats-actions' });
    // 这一排按钮的约定：**结果一律走 Notice，绝不写回按钮文案**。
    // 按钮里塞路径 / 长文案会把这行挤爆 —— 一行 flex、卡片又 overflow: hidden，
    // 长起来的那颗会把右边的按钮推出可视区，连点都点不到（曾经的备份按钮就是这样）。
    const exportBtn = actions.createEl('button', { cls: 'mod-cta' });
    setIcon(exportBtn.createSpan(), 'file-down');
    exportBtn.createSpan({ text: t('stats.exportNote') });
    exportBtn.onclick = async () => {
      exportBtn.disabled = true;
      try {
        const file = await this.plugin.exportPlaybackStats();
        await this.plugin.app.workspace.getLeaf(false).openFile(file);
      } catch (e) {
        notice(tf('stats.exportFailed', { msg: (e as Error).message }));
      } finally {
        exportBtn.disabled = false;
      }
    };
    const backupBtn = actions.createEl('button');
    setIcon(backupBtn.createSpan(), 'archive');
    backupBtn.createSpan({ text: t('backup.create') });
    backupBtn.onclick = async () => {
      backupBtn.disabled = true;
      try {
        const file = await this.plugin.exportDataBackup();
        notice(tf('backup.created', { path: file.path }));
      } catch (e) {
        notice(tf('backup.failed', { msg: (e as Error).message }));
      } finally {
        backupBtn.disabled = false;
      }
    };
    const restoreBtn = actions.createEl('button');
    setIcon(restoreBtn.createSpan(), 'archive-restore');
    restoreBtn.createSpan({ text: t('backup.restore') });
    restoreBtn.onclick = () => new RestoreDataModal(this.plugin, () => this.rerender()).open();
    const clearBtn = actions.createEl('button', { cls: 'mod-warning' });
    setIcon(clearBtn.createSpan(), 'trash-2');
    clearBtn.createSpan({ text: t('settings.clearStats') });
    // 不可撤销的动作先确认：删掉什么写在弹窗里（页面上的小字说明已经撤掉）
    clearBtn.onclick = () =>
      new ClearStatsModal(this.plugin, () => {
        this.selectedDay = '';
        this.rerender();
      }).open();
  }
}
