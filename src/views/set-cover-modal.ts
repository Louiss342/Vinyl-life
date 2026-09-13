// 设置封面弹窗（专辑卡片右键）：从库中选图 / 选本地图片（复制进封面目录）/ 移除封面。
// 另有零操作路径：把 cover / folder / front.<图片> 放进专辑音频文件夹，或把与专辑同名的图片
// 放进封面目录，读取时自动识别（见 core/album-index.findConventionCover）。
import { App, FuzzySuggestModal, Modal, TFile } from 'obsidian';
import type VinylLifePlugin from '../main';
import type { AlbumInfo } from '../core/album-index';
import { ensureFolder, isImageFile, notice, sanitizeFileName } from '../util';

class VaultImageSuggest extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private onPick: (f: TFile) => void
  ) {
    super(app);
    this.setPlaceholder('在库中选择一张图片…');
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((f) => isImageFile(f.name));
  }

  getItemText(f: TFile): string {
    return f.path;
  }

  onChooseItem(f: TFile): void {
    this.onPick(f);
  }
}

export class SetCoverModal extends Modal {
  private fileInput: HTMLInputElement | null = null;

  constructor(
    app: App,
    private plugin: VinylLifePlugin,
    private album: AlbumInfo
  ) {
    super(app);
    this.titleEl.setText(`设置封面 — ${album.title}`);
  }

  async onOpen() {
    const c = this.contentEl;
    c.empty();
    c.addClass('vinyl-set-cover');

    const preview = c.createDiv({ cls: 'vinyl-cover-preview' });
    if (this.album.cover) {
      preview.createEl('img', { attr: { src: this.album.cover } });
    } else {
      preview.createDiv({ cls: 'vinyl-shelf-cover-color vinyl-shelf-cover-empty', text: '♪' });
    }

    const row = c.createDiv({ cls: 'vinyl-import-actions' });
    const vaultBtn = row.createEl('button', { text: '从库中选择图片…', cls: 'mod-cta' });
    const fileBtn = row.createEl('button', { text: '选择本地图片…' });
    const removeBtn = row.createEl('button', { text: '移除封面' });
    const fileInput = row.createEl('input', { attr: { type: 'file', accept: 'image/*' } });
    fileInput.style.display = 'none';
    this.fileInput = fileInput;

    const status = c.createDiv({ cls: 'vinyl-muted' });
    c.createDiv({
      cls: 'vinyl-muted',
      text:
        '也可以不设置：把 cover.jpg / folder.jpg / front.jpg 放进专辑的音频文件夹，' +
        '或把与专辑同名的图片放进封面目录，插件会自动识别。',
    });

    vaultBtn.addEventListener('click', () => {
      new VaultImageSuggest(this.app, (f) => void this.apply(`[[${f.path}]]`, f.name)).open();
    });
    fileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      try {
        const ext = (f.name.split('.').pop() || 'jpg').toLowerCase();
        const dir = this.plugin.settings.coverFolder;
        await ensureFolder(this.app, dir);
        const path = `${dir}/${sanitizeFileName(this.album.title)}.${ext}`;
        const ab = await f.arrayBuffer();
        const exist = this.app.vault.getAbstractFileByPath(path);
        if (exist instanceof TFile) await this.app.vault.modifyBinary(exist, ab);
        else await this.app.vault.createBinary(path, ab);
        await this.apply(`[[${path}]]`, f.name);
      } catch (e) {
        console.error('[vinyl] 设置封面失败', e);
        status.setText(`❌ 设置失败：${(e as Error).message || e}`);
      }
    });
    removeBtn.addEventListener('click', () => void this.apply(null, ''));
  }

  /** 写回 frontmatter（cover 传 null = 移除）；metadataCache 变更会驱动专辑墙自动刷新 */
  private async apply(cover: string | null, label: string) {
    try {
      await this.app.fileManager.processFrontMatter(this.album.file, (fm) => {
        if (cover) fm.cover = cover;
        else delete fm.cover;
      });
      notice(cover ? `封面已更新（${label}）` : '已移除封面');
      this.close();
    } catch (e) {
      console.error('[vinyl] 写入封面失败', e);
      notice(`设置封面失败：${(e as Error).message}`);
    }
  }

  onClose() {
    if (this.fileInput) {
      this.fileInput.remove();
      this.fileInput = null;
    }
    this.contentEl.empty();
  }
}
