// 关联已有：把一张在线搜索结果挂到库里的某篇专辑笔记上（只写平台 id，不动正文）。
//
// 评审意见两条都落在这里：
//   ① 候选要挑得动 —— 显示艺人 / 发行日期 / 本地曲目数，按相似度排序（同名版本排一起），
//      另给一个模糊搜索框（大库里靠下拉框翻是翻不到的）；
//   ② 选错版本代价大 —— 左右并排：左边是搜索结果（上游专辑），右边是选中的目标笔记，
//      确认前把两边的艺人 / 年份 / 版本 / 已有音源摆在一起看。
import { App, Modal, TFile } from 'obsidian';
import { AlbumInfo, detectAlbumSources, findAlbumNotes, getAlbumInfo } from '../core/album-index';
import { AlbumSearchCandidate, fuzzyMatches, rankLibraryMatches } from '../core/album-discovery';
import type { ActiveSource } from '../core/queue';
import { sourceName } from '../core/track';
import { t, tf } from '../core/i18n';
import { markVinylModal } from '../util';

/** 目标笔记那侧的资料来源（显示用） */
function sourceBadges(app: App, album: AlbumInfo): string[] {
  const sources = detectAlbumSources(app, album);
  return (['local', 'netease', 'qq', 'kugou'] as ActiveSource[])
    .filter((source) => sources[source])
    .map((source) => sourceName(source));
}

export class LinkSourceModal extends Modal {
  private selected: AlbumInfo | null = null;
  private targetPanel: HTMLElement | null = null;
  private confirm: HTMLButtonElement | null = null;
  private readonly idField: 'neteaseId' | 'qqId' | 'kugouId';

  constructor(app: App, private candidate: AlbumSearchCandidate, private onLinked: (file: TFile) => void) {
    super(app);
    markVinylModal(this);
    this.titleEl.setText(t('link.title'));
    this.idField = candidate.source === 'netease' ? 'neteaseId' : candidate.source === 'qq' ? 'qqId' : 'kugouId';
  }

  onOpen(): void {
    const albums = findAlbumNotes(this.app)
      .map((file) => getAlbumInfo(this.app, file))
      .filter((album): album is AlbumInfo => album !== null && !album[this.idField]);
    this.contentEl.createEl('p', {
      text: tf('link.summary', { title: this.candidate.title, source: this.candidateSourceName() }),
    });
    this.contentEl.createEl('p', { text: t('link.versionHint'), cls: 'vinyl-muted' });

    const panes = this.contentEl.createDiv({ cls: 'vinyl-link-panes' });
    this.renderSourcePane(panes.createDiv({ cls: 'vinyl-link-pane is-source' }));
    const targetPane = panes.createDiv({ cls: 'vinyl-link-pane is-target' });
    this.targetPanel = targetPane;

    // 搜索 + 候选列表（排序：先按相似度，再按标题）
    const search = this.contentEl.createEl('input', {
      cls: 'vinyl-link-search',
      attr: { type: 'search', placeholder: t('link.searchPlaceholder') },
    });
    const list = this.contentEl.createDiv({ cls: 'vinyl-link-list' });
    const error = this.contentEl.createEl('p', { cls: 'vinyl-muted' });
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: t('common.cancel') }).onclick = () => this.close();
    this.confirm = actions.createEl('button', { text: t('link.action'), cls: 'mod-cta' });
    this.confirm.onclick = () => void this.link(error);

    const ranked = rankLibraryMatches(this.candidate, albums);
    const paint = () => {
      list.empty();
      const matched = ranked.filter((album) =>
        fuzzyMatches(search.value, album.title, album.artist, album.edition)
      );
      if (!matched.length) {
        list.createDiv({ cls: 'vinyl-link-empty', text: t('link.noMatch') });
        return;
      }
      for (const album of matched) {
        const row = list.createEl('button', { cls: 'vinyl-link-row', attr: { type: 'button' } });
        row.toggleClass('is-selected', this.selected?.path === album.path);
        row.createDiv({ cls: 'vinyl-link-row-title', text: album.title });
        const bits = [album.edition, album.artist, album.year].filter(Boolean).join(' · ');
        if (bits) row.createDiv({ cls: 'vinyl-link-row-meta', text: bits });
        const badges = sourceBadges(this.app, album);
        row.createDiv({
          cls: 'vinyl-link-row-sources',
          text: badges.length ? tf('link.hasSources', { list: badges.join(' / ') }) : t('link.noSource'),
        });
        row.onclick = () => {
          this.selected = album;
          for (const other of Array.from(list.querySelectorAll('.vinyl-link-row'))) {
            other.toggleClass('is-selected', other === row);
          }
          this.renderTargetPane(album);
        };
      }
    };
    search.oninput = paint;
    paint();
    // 默认选中排在最前的那张：右栏当场把它的资料摆出来 —— 确认前就是要看见两边
    const first = ranked[0];
    if (first) {
      this.selected = first;
      const firstRow = list.querySelector('.vinyl-link-row');
      firstRow?.addClass('is-selected');
      this.renderTargetPane(first);
    } else {
      this.renderTargetPane(null);
    }
  }

  private candidateSourceName(): string {
    return sourceName(this.candidate.source);
  }

  /** 左栏：搜索结果本身（拿它和右栏的目标笔记对照版本） */
  private renderSourcePane(pane: HTMLElement): void {
    const c = this.candidate;
    pane.createDiv({ cls: 'vinyl-link-pane-title', text: t('link.sourceAlbum') });
    if (c.coverUrl) {
      pane.createEl('img', { cls: 'vinyl-link-cover', attr: { src: c.coverUrl, alt: '' } });
    }
    pane.createDiv({ cls: 'vinyl-link-name', text: c.title });
    if (c.artists.length) pane.createDiv({ cls: 'vinyl-link-meta', text: c.artists.join(' / ') });
    const facts = [this.candidateSourceName()];
    if (c.releaseDate) facts.push(c.releaseDate);
    if (typeof c.trackCount === 'number') facts.push(tf('link.trackCount', { n: c.trackCount }));
    pane.createDiv({ cls: 'vinyl-link-meta is-strong', text: facts.join(' · ') });
  }

  /** 右栏：选中的目标笔记（未选时给一句提示） */
  private renderTargetPane(album: AlbumInfo | null): void {
    const pane = this.targetPanel;
    if (!pane) return;
    pane.empty();
    pane.createDiv({ cls: 'vinyl-link-pane-title', text: t('link.targetAlbum') });
    if (!album) {
      pane.createDiv({ cls: 'vinyl-link-meta', text: t('link.choose') });
      if (this.confirm) this.confirm.disabled = true;
      return;
    }
    if (this.confirm) this.confirm.disabled = false;
    if (album.cover) {
      pane.createEl('img', { cls: 'vinyl-link-cover', attr: { src: album.cover, alt: '' } });
    }
    pane.createDiv({ cls: 'vinyl-link-name', text: album.title });
    const version = [album.edition, album.artist, album.year].filter(Boolean).join(' · ');
    if (version) pane.createDiv({ cls: 'vinyl-link-meta', text: version });
    const badges = sourceBadges(this.app, album);
    pane.createDiv({
      cls: 'vinyl-link-meta is-strong',
      text: badges.length ? tf('link.hasSources', { list: badges.join(' / ') }) : t('link.noSource'),
    });
    if (album.audioRefs.length) {
      pane.createDiv({ cls: 'vinyl-link-meta', text: tf('link.localTracks', { n: album.audioRefs.length }) });
    }
  }

  private async link(error: HTMLElement): Promise<void> {
    const album = this.selected;
    if (!album) { error.setText(t('link.choose')); return; }
    const { candidate, idField, confirm } = this;
    if (confirm) confirm.disabled = true;
    try {
      // 回调参数显式标注（理由同 import.ts）：不标注则 fm 是 any，动态键读写都算不安全访问
      await this.app.fileManager.processFrontMatter(album.file, (fm: Record<string, unknown>) => {
        if (fm[idField]) throw new Error(t('link.conflict'));
        fm[idField] = candidate.source === 'netease' ? Number(candidate.sourceAlbumId) : candidate.sourceAlbumId;
      });
      this.close();
      this.onLinked(album.file);
    } catch (e) {
      error.setText((e as Error).message);
      if (confirm) confirm.disabled = false;
    }
  }
}
