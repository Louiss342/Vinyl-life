// 设置封面弹窗（专辑卡片右键）：从库中选图 / 选本地图片（复制进封面目录）/ 移除封面。
// 另有零操作路径：把 cover / folder / front.<图片> 放进专辑音频文件夹，或把与专辑同名的图片
// 放进封面目录，读取时自动识别（见 core/album-index.findConventionCover）。
import { App, FuzzySuggestModal, Modal, TFile } from 'obsidian';
import type VinylLifePlugin from '../main';
import type { AlbumInfo } from '../core/album-index';
import {
  ensureFolder,
  isImageFile,
  markVinylModal,
  notice,
  sanitizeFileName,
  stripWikilink,
} from '../util';
import { t, tf } from '../core/i18n';

class VaultImageSuggest extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private onPick: (f: TFile) => void
  ) {
    super(app);
    markVinylModal(this);
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
    private album: AlbumInfo,
    /** 写回之后通知调用方刷新（与 RatingModal / AlbumEditionModal 同一口径）——
     *  只靠 metadataCache 驱动是不够的：专辑墙的刷新签名以前不含 cover，页面会停在旧封面 */
    private onSaved?: () => void
  ) {
    super(app);
    markVinylModal(this);
    this.modalEl.addClass('vinyl-dialog-compact', 'vinyl-dialog-actions');
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

    // 状态行：下载封面 / 复制入库的过程中会变，标成 status 让读屏软件播报
    const status = c.createDiv({ cls: 'vinyl-muted vinyl-cover-status', attr: { role: 'status' } });
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
        const path = this.coverDestPath(dir, ext);
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

  /** 本地图片的落点：默认「封面目录 / 专辑标题.扩展名」。**只有那个文件确实是本专辑当前的封面时**
   *  才就地覆盖（换封面的正常路径）；否则往「标题 (2).jpg」这样取一个不冲突的名字 —— 专辑笔记是全库
   *  扫描，两张同名笔记（Albums/A.md 与 Archive/A.md）各有封面，就地覆盖会让第二张把第一张的图
   *  盖掉，而第一条笔记的 wikilink 还指着该文件：两张显示同一张图，原图再也找不回来。 */
  private coverDestPath(dir: string, ext: string): string {
    const base = sanitizeFileName(this.album.title);
    let path = `${dir}/${base}.${ext}`;
    // 命中本专辑自己的那一张就停（沿用「标题 2.jpg」而不是一路堆到 3、4）
    for (let n = 2; this.app.vault.getAbstractFileByPath(path) && !this.isCurrentCover(path); n++) {
      path = `${dir}/${base} (${n}).${ext}`;
    }
    return path;
  }

  /** 这个路径是不是本专辑当前 cover 指着的文件（判定口径与删除盘点的共享封面一致） */
  private isCurrentCover(path: string): boolean {
    const raw = this.album.coverRaw?.trim();
    if (!raw || /^https?:\/\//i.test(raw) || /^#[0-9a-fA-F]{3,8}$/.test(raw)) return false;
    const dest = this.app.metadataCache.getFirstLinkpathDest(stripWikilink(raw), this.album.path);
    return dest instanceof TFile && dest.path === path;
  }

  /** 写回 frontmatter（cover 传 null = 移除）；写成功后就地通知调用方刷新 */
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
      this.onSaved?.();
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
