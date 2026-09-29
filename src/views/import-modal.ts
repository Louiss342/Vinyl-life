// 导入弹窗：两个薄壳 —— 在线搜索（views/album-search）与本地导入（views/local-import-pane），
// 机制都在那两个面板里（专辑墙的「添加」浮层共用）。壳只管挂载、弹窗语义（开完即关）与作废在途请求。
import { App, Modal, TFile } from 'obsidian';
import { AlbumInfo, findAlbumNotes, getAlbumInfo } from '../core/album-index';
import { ImportContext } from '../import';
import { markVinylModal } from '../util';
import { t } from '../core/i18n';
import { AlbumSearchPane } from './album-search';
import { LocalImportPane } from './local-import-pane';

// ============ 专辑导入（网易云 / QQ 音乐）：搜索 / 直链 / 翻页 / 逐条状态全在 AlbumSearchPane ============

export class AlbumImportModal extends Modal {
  private pane: AlbumSearchPane;
  private linkPane: AlbumSearchPane | null = null;
  private localPane: LocalImportPane | null = null;
  private layers = new Map<string, HTMLElement>();
  private tabs = new Map<string, HTMLButtonElement>();

  constructor(app: App, private ctx: ImportContext, private initialQuery = '') {
    super(app);
    markVinylModal(this);
    this.modalEl.addClass('vinyl-import-dialog');
    this.titleEl.setText(t('import.title'));
    this.pane = new AlbumSearchPane(ctx, { openFile: (file) => this.openFile(file) });
  }

  async onOpen() {
    const c = this.contentEl;
    c.empty();
    c.addClass('vinyl-album-import', 'vinyl-import-dialog-content');
    const tabs = c.createDiv({ cls: 'vinyl-import-dialog-tabs', attr: { role: 'tablist', 'aria-label': t('import.method') } });
    const bodies = c.createDiv({ cls: 'vinyl-import-dialog-bodies' });
    for (const [key, label] of [['search', 'import.searchTab'], ['link', 'import.linkTab'], ['local', 'import.localTab']]) {
      const button = tabs.createEl('button', { text: t(label), attr: { role: 'tab', 'aria-selected': String(key === 'search'), tabindex: key === 'search' ? '0' : '-1' } });
      const body = bodies.createDiv({ cls: `vinyl-import-dialog-layer${key === 'search' ? '' : ' vinyl-hidden'}`, attr: { role: 'tabpanel', 'aria-label': t(label) } });
      this.layers.set(key, body);
      this.tabs.set(key, button);
      button.addEventListener('click', () => this.selectTab(key));
      button.addEventListener('keydown', (ev) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
        ev.preventDefault();
        ev.stopPropagation();
        const keys = ['search', 'link', 'local'];
        const index = ev.key === 'Home' ? 0 : ev.key === 'End' ? 2 : (keys.indexOf(key) + (ev.key === 'ArrowRight' ? 1 : 2)) % 3;
        this.selectTab(keys[index]);
        this.tabs.get(keys[index])?.focus();
      });
    }
    this.pane.mount(this.layers.get('search'), { withButton: true, detailed: true });
    if (this.initialQuery) this.pane.prefill(this.initialQuery);
    window.setTimeout(() => this.pane.focus(), 50);
  }

  private selectTab(key: string): void {
    for (const [name, layer] of this.layers) layer.toggleClass('vinyl-hidden', key !== name);
    for (const [name, tab] of this.tabs) {
      tab.setAttribute('aria-selected', String(name === key));
      tab.setAttribute('tabindex', name === key ? '0' : '-1');
    }
    if (key === 'link' && !this.linkPane) {
      this.linkPane = new AlbumSearchPane(this.ctx, { openFile: (file) => this.openFile(file) });
      this.layers.get('link').addClass('is-link');
      this.linkPane.mount(this.layers.get('link'), { withButton: true, detailed: true, linkOnly: true, placeholder: t('import.linkPlaceholder') });
    }
    if (key === 'local' && !this.localPane) {
      const albums = findAlbumNotes(this.app).map((file) => getAlbumInfo(this.app, file)).filter((album): album is AlbumInfo => !!album);
      this.localPane = new LocalImportPane(this.ctx, albums, undefined, { onDone: () => {} });
      this.localPane.mount(this.layers.get('local'), { detailed: true });
    }
  }

  onClose() {
    this.pane.destroy();
    this.linkPane?.destroy();
    this.localPane?.destroy();
    this.contentEl.empty();
  }

  private async openFile(file: TFile): Promise<void> {
    await this.app.workspace.getLeaf(false).openFile(file);
    this.close();
  }
}

// ============ 本地音频导入：文件优先流程（选文件 → 目标 → 落库方式）在 LocalImportPane ============

export class LocalImportModal extends Modal {
  private pane: LocalImportPane;

  constructor(app: App, ctx: ImportContext, albums: AlbumInfo[], presetAlbum?: AlbumInfo) {
    super(app);
    markVinylModal(this);
    this.modalEl.addClass('vinyl-dialog-wide');
    this.titleEl.setText(t('import.localTitle'));
    this.pane = new LocalImportPane(ctx, albums, presetAlbum, {
      onDone: ({ created, album }) => {
        // 弹窗路径：新建的专辑就打开笔记（方便接着补封面 / 年份 / 评分），然后关窗
        if (created && album?.file instanceof TFile) {
          void this.app.workspace.getLeaf(false).openFile(album.file);
        }
        this.close();
      },
    });
  }

  async onOpen() {
    const c = this.contentEl;
    c.empty();
    c.addClass('vinyl-local-workspace-host');
    this.pane.mount(c, { detailed: true });
  }

  onClose() {
    this.pane.destroy();
    this.contentEl.empty();
  }
}
