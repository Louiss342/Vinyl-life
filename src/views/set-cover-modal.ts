// 设置封面弹窗（专辑卡片右键）：从库中选图 / 选本地图片（复制进封面目录）/ 移除封面。
// 另有零操作路径：把 cover / folder / front.<图片> 放进专辑音频文件夹，或把与专辑同名的图片
// 放进封面目录，读取时自动识别（见 core/album-index.findConventionCover）。
import { App, FuzzySuggestModal, Modal, TFile } from 'obsidian';
import type VinylLifePlugin from '../main';
import type { AlbumInfo } from '../core/album-index';
import { ensureFolder, isImageFile, markVinylModal, notice, sanitizeFileName } from '../util';
import { t, tf } from '../core/i18n';

class VaultImageSuggest extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private onPick: (f: TFile) => void
  ) {
    super(app);
    markVinylModal(this); // 全直角：弹窗壳收掉圆角（见 styles.css「全直角」段）
    this.setPlaceholder(t('cover.pickInVault'));
  }

  /** 候选图 = 库内所有图片：选封面时用户要能挑到任意一张（审核披露的 vault 枚举之一，见 CONTRIBUTING） */
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
    markVinylModal(this); // 全直角：弹窗壳收掉圆角（见 styles.css「全直角」段）
    this.titleEl.setText(tf('cover.title', { title: album.title }));
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
    const vaultBtn = row.createEl('button', { text: t('cover.fromVault'), cls: 'mod-cta' });
    const fileBtn = row.createEl('button', { text: t('cover.fromLocal') });
    const removeBtn = row.createEl('button', { text: t('cover.remove') });
    const fileInput = row.createEl('input', {
      attr: { type: 'file', accept: 'image/*' },
      cls: 'vinyl-hidden',
    });
    this.fileInput = fileInput;

    const status = c.createDiv({ cls: 'vinyl-muted' });
    c.createDiv({
      cls: 'vinyl-muted',
      text: t('cover.conventionHint'),
    });

    vaultBtn.addEventListener('click', () => {
      new VaultImageSuggest(this.app, (f) => void this.applyCover(`[[${f.path}]]`, f.name)).open();
    });
    fileBtn.addEventListener('click', () => fileInput.click());
    const pickLocal = async () => {
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
        await this.applyCover(`[[${path}]]`, f.name);
      } catch (e) {
        console.error('[vinyl] 设置封面失败', e);
        status.setText(`${t('cover.setFailed')}${(e as Error).message || e}`);
      }
    };
    fileInput.addEventListener('change', () => {
      void pickLocal();
    });
    removeBtn.addEventListener('click', () => void this.applyCover(null, ''));
  }

  /** 写回 frontmatter（cover 传 null = 移除）；metadataCache 变更会驱动专辑墙自动刷新 */
  private async applyCover(cover: string | null, label: string) {
    try {
      await this.app.fileManager.processFrontMatter(
        this.album.file,
        (fm: Record<string, unknown>) => {
          if (cover) fm.cover = cover;
          else delete fm.cover;
        }
      );
      notice(cover ? tf('cover.updated', { label }) : t('cover.removed'));
      this.close();
    } catch (e) {
      console.error('[vinyl] 写入封面失败', e);
      notice(tf('cover.writeFailed', { msg: (e as Error).message }));
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
