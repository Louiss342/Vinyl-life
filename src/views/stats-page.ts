// 设置页的独立「统计」标签：日历热力图、当日唱片墙、最近/最多、自定义属性统计。
// 版式跟着通用 / 外观 / 源 走：每张卡片就是一个设置分区（标题栏 + 图标徽章 + 内容区），
// 壳由 views/settings-section 提供，这里只负责内容。
import { Modal, Setting, TFile, setIcon } from 'obsidian';
import type VinylLifePlugin from '../main';
import { findAlbumNotes, getAlbumInfo } from '../core/album-index';
import {
  AlbumPlayStat,
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

function albumTitle(path: string, stat: AlbumPlayStat): string {
  const title = stat.snapshot?.title || path.split('/').pop()?.replace(/\.md$/, '') || path;
  return stat.snapshot?.edition ? `${title} · ${stat.snapshot.edition}` : title;
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
    const status = this.contentEl.createEl('p', { cls: 'vinyl-muted' });
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
    const actions = c.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: t('common.cancel') }).onclick = () => this.close();
    const go = actions.createEl('button', { text: t('settings.clearStats'), cls: 'mod-warning' });
    go.onclick = async () => {
      go.disabled = true;
      try {
        await this.plugin.clearPlaybackStats();
      } catch (e) {
        notice(tf('stats.clearFailed', { msg: (e as Error).message }));
        go.disabled = false;
        return;
      }
      this.close();
      this.onDone();
    };
  }
}

export class StatsPage {
  private selectedDay = '';
  private selectedProp = '';

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
    // 只读状态行：名称在左、值在右（与设置页的登录状态行同一套做法）
    const valueRow = (name: string, value: string) => {
      const row = new Setting(body).setName(name);
      row.settingEl.addClass('vinyl-data-row');
      row.controlEl.createDiv({ cls: 'vinyl-data-value', text: value });
    };
    valueRow(t('data.backupPlace'), p.backupFolderPath() + '/');
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
          this.rerender();
        };
      }
    }
    const legend = parent.createDiv({ cls: 'vinyl-stats-legend' });
    legend.createSpan({ text: t('stats.less') });
    for (let i = 0; i <= 4; i++) legend.createSpan({ cls: `vinyl-stats-legend-cell is-level-${i}` });
    legend.createSpan({ text: t('stats.more') });
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
    const name = album?.title || albumTitle(albumPath, stat);
    const coverSrc = album?.cover || this.plugin.statsCoverSrc(stat.snapshot);
    // 悬停提示走 aria-label（宿主会画成样式化气泡）：用 title 会和它叠成两个
    const label = exists ? name : tf('stats.removedBadgeTitle', { title: name });
    const button = parent.createEl('button', {
      cls: `vinyl-stats-album${compact ? ' is-compact' : ''}${exists ? '' : ' is-removed'}`,
      attr: { type: 'button', 'aria-label': label },
    });
    const art = button.createDiv({ cls: 'vinyl-stats-album-art' });
    if (coverSrc && !/^#[0-9a-f]{3,8}$/i.test(coverSrc)) {
      art.createEl('img', { attr: { src: coverSrc, alt: name } });
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
      text.createDiv({ cls: 'vinyl-stats-ranking-name', text: albumTitle(path, stat) });
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
    const keys = new Set<string>();
    for (const file of findAlbumNotes(this.plugin.app)) {
      const album = getAlbumInfo(this.plugin.app, file, { coverFolder: this.plugin.settings.coverFolder });
      Object.keys(album?.displayProps ?? {}).forEach((key) => keys.add(key));
    }
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
