// 播放统计弹窗（M4，P1）：总次数 / 最近播放 / 播放最多的专辑
import { App, Modal } from 'obsidian';
import { VinylStats, recentAlbums } from '../core/stats';
import { fmtTime } from '../util';

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
    this.titleEl.setText('播放统计');
  }

  onOpen() {
    const c = this.contentEl;
    c.empty();
    c.addClass('vinyl-stats');

    const head = c.createDiv({ cls: 'vinyl-stats-head' });
    head.createSpan({
      text: `共播放 ${this.stats.totalPlays} 次`,
      cls: 'vinyl-stats-total',
    });

    const recent = recentAlbums(this.stats, 5);
    c.createEl('h5', { text: '最近播放' });
    if (!recent.length) {
      c.createDiv({ text: '暂无记录', cls: 'vinyl-muted' });
    } else {
      const list = c.createDiv({ cls: 'vinyl-stats-list' });
      for (const r of recent) {
        const stat = this.stats.albums[r.path];
        const row = list.createDiv({ cls: 'vinyl-stats-row' });
        row.createSpan({ text: r.title, cls: 'vinyl-stats-name' });
        row.createSpan({
          text: `${stat.lastTrack ? '《' + stat.lastTrack + '》 · ' : ''}${fmtStamp(stat.lastPlayedAt)}`,
          cls: 'vinyl-muted',
        });
      }
    }

    c.createEl('h5', { text: '播放最多' });
    const top = Object.entries(this.stats.albums)
      .sort((a, b) => b[1].plays - a[1].plays)
      .slice(0, 5);
    if (!top.length) {
      c.createDiv({ text: '暂无记录', cls: 'vinyl-muted' });
    } else {
      const list = c.createDiv({ cls: 'vinyl-stats-list' });
      for (const [path, stat] of top) {
        const row = list.createDiv({ cls: 'vinyl-stats-row' });
        row.createSpan({
          text: path.split('/').pop()?.replace(/\.md$/, '') || path,
          cls: 'vinyl-stats-name',
        });
        row.createSpan({ text: `${stat.plays} 次`, cls: 'vinyl-muted' });
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
