// 播放统计弹窗：总次数 / 最近播放 / 播放最多的专辑
import { App, Modal } from 'obsidian';
import { VinylStats, recentAlbums } from '../core/stats';
import { t, tf } from '../core/i18n';

function fmtStamp(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export class StatsModal extends Modal {
  constructor(
    app: App,
    private stats: VinylStats
  ) {
    super(app);
    this.titleEl.setText(t('stats.title'));
  }

  onOpen() {
    const c = this.contentEl;
    c.empty();
    c.addClass('vinyl-stats');

    const head = c.createDiv({ cls: 'vinyl-stats-head' });
    head.createSpan({
      text: tf('stats.total', { n: this.stats.totalPlays }),
      cls: 'vinyl-stats-total',
    });

    const recent = recentAlbums(this.stats, 5);
    c.createEl('h5', { text: t('stats.recent') });
    if (!recent.length) {
      c.createDiv({ text: t('stats.noRecords'), cls: 'vinyl-muted' });
    } else {
      const list = c.createDiv({ cls: 'vinyl-stats-list' });
      for (const r of recent) {
        const stat = this.stats.albums[r.path];
        const row = list.createDiv({ cls: 'vinyl-stats-row' });
        row.createSpan({ text: r.title, cls: 'vinyl-stats-name' });
        row.createSpan({
          text: stat.lastTrack
            ? tf('stats.lastTrackAt', {
                track: stat.lastTrack || '',
                time: fmtStamp(stat.lastPlayedAt),
              })
            : fmtStamp(stat.lastPlayedAt),
          cls: 'vinyl-muted',
        });
      }
    }

    c.createEl('h5', { text: t('stats.top') });
    const top = Object.entries(this.stats.albums)
      .sort((a, b) => b[1].plays - a[1].plays)
      .slice(0, 5);
    if (!top.length) {
      c.createDiv({ text: t('stats.noRecords'), cls: 'vinyl-muted' });
    } else {
      const list = c.createDiv({ cls: 'vinyl-stats-list' });
      for (const [path, stat] of top) {
        const row = list.createDiv({ cls: 'vinyl-stats-row' });
        row.createSpan({
          text: path.split('/').pop()?.replace(/\.md$/, '') || path,
          cls: 'vinyl-stats-name',
        });
        row.createSpan({ text: tf('stats.plays', { n: stat.plays }), cls: 'vinyl-muted' });
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
