// 导入弹窗：两个薄壳 —— 在线搜索（views/album-search）与本地导入（views/local-import-pane）。
// 机制都在那两个面板里（专辑墙的「添加」浮层共用同一套）；壳只做三件事：
// 挂进 contentEl、把「打开笔记 / 收尾」接成弹窗语义（开完就关窗）、关窗时让在途请求作废。
import { App, Modal, TFile } from 'obsidian';
import { AlbumInfo } from '../core/album-index';
import { ImportContext } from '../import';
import { markVinylModal } from '../util';
import { t } from '../core/i18n';
import { AlbumSearchPane } from './album-search';
import { LocalImportPane } from './local-import-pane';

// ============ 专辑导入（网易云 / QQ 音乐） ============
// 搜索 / 直连链接 / 结果池与翻页 / 逐条导入状态全在 AlbumSearchPane 里。

export class AlbumImportModal extends Modal {
  private pane: AlbumSearchPane;

  constructor(app: App, ctx: ImportContext) {
    super(app);
    markVinylModal(this); // 全直角：弹窗壳收掉圆角（见 styles.css「全直角」段）
    this.titleEl.setText(t('import.title'));
    this.pane = new AlbumSearchPane(ctx, { openFile: (file) => this.openFile(file) });
  }

  async onOpen() {
    const c = this.contentEl;
    c.empty();
    c.addClass('vinyl-album-import');
    this.pane.mount(c);
    window.setTimeout(() => this.pane.focus(), 50);
  }

  onClose() {
    this.pane.destroy();
    this.contentEl.empty();
  }

  private async openFile(file: TFile): Promise<void> {
    await this.app.workspace.getLeaf(false).openFile(file);
    this.close();
  }
}

// ============ 本地音频导入 ============
// 文件优先流程（① 选文件 / 文件夹 → ② 目标 → ③ 落库方式）在 LocalImportPane 里。

export class LocalImportModal extends Modal {
  private pane: LocalImportPane;

  constructor(app: App, ctx: ImportContext, albums: AlbumInfo[], presetAlbum?: AlbumInfo) {
    super(app);
    markVinylModal(this); // 全直角：弹窗壳收掉圆角（见 styles.css「全直角」段）
    this.titleEl.setText(t('import.localTitle'));
    this.pane = new LocalImportPane(ctx, albums, presetAlbum, {
      onDone: ({ created, album }) => {
        // 弹窗路径沿用旧行为：新建的专辑打开笔记（方便接着补封面 / 年份 / 评分），然后关窗
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
    this.pane.mount(c);
  }

  onClose() {
    this.pane.destroy();
    this.contentEl.empty();
  }
}
