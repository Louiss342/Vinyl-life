// 批量删除弹窗：一次确认 + 可选连带清理（本地音频 / 封面）。
// 资产盘点在 onOpen 前做一次（模态打开期间专辑墙不会改动），执行统一走 plugin.deleteAlbums。
// 与单张删除的差别：盘点把「同批要删的专辑」互相视为不存在（同批共用的音频不会因为「别人还在引用」被留下），
// 资产明细按批聚合展示，不逐张弹窗。
import { App, Modal } from 'obsidian';
import type VinylLifePlugin from '../main';
import { AlbumInfo } from '../core/album-index';
import {
  AlbumBatchDeleteTargets,
  collectAlbumBatchDeleteTargets,
  scanFolderContents,
} from '../delete';
import { markVinylModal } from '../util';
import { t, tf } from '../core/i18n';

/** 专辑清单 / 提示里的路径列表最多各铺几条，其余折成「等 N 张 / 等」 */
const LIST_CAP = 10;
const PATH_CAP = 3;

export class DeleteBatchModal extends Modal {
  private targets: AlbumBatchDeleteTargets;
  private busy = false;

  constructor(
    app: App,
    private plugin: VinylLifePlugin,
    private albums: AlbumInfo[],
    private onDeleted?: () => void
  ) {
    super(app);
    markVinylModal(this); // 全直角：弹窗壳收掉圆角（见 styles.css「全直角」段）
    this.titleEl.setText(t('batchDelete.title'));
    this.targets = collectAlbumBatchDeleteTargets(app, albums);
  }

  async onOpen() {
    const targets = this.targets;
    const c = this.contentEl;
    c.empty();
    c.addClass('vinyl-delete-modal');

    const head = c.createDiv({ cls: 'vinyl-delete-head' });
    head.createSpan({
      text: tf('batchDelete.summary', { n: this.albums.length }),
      cls: 'vinyl-delete-title',
    });
    // 专辑清单：最多铺 LIST_CAP 行，其余折成一行（几十张时不把弹窗撑成一面墙）
    const list = c.createDiv({ cls: 'vinyl-delete-batch-list' });
    for (const album of this.albums.slice(0, LIST_CAP)) {
      list.createDiv({
        text: album.artist ? `${album.title}${t('common.listSep')}${album.artist}` : album.title,
      });
    }
    if (this.albums.length > LIST_CAP) {
      list.createDiv({
        text: tf('batchDelete.more', { n: this.albums.length }),
        cls: 'vinyl-muted',
      });
    }

    const current = this.plugin.engine.snapshot().albumNotePath;
    if (current && this.albums.some((a) => a.path === current)) {
      c.createDiv({ text: t('batchDelete.playingHint'), cls: 'vinyl-error' });
    }

    // —— 连带清理选项（有可删资产才出现）——
    const audioFolderCount = targets.audioFolders.reduce(
      (n, f) => n + scanFolderContents(f).audios.length,
      0
    );
    let audioCb: HTMLInputElement | null = null;
    if (targets.audioFolders.length || targets.audioFiles.length) {
      const parts: string[] = [];
      for (const f of targets.audioFolders) {
        parts.push(tf('delete.folderPart', { path: f.path, n: scanFolderContents(f).audios.length }));
      }
      if (targets.audioFiles.length) {
        const names = targets.audioFiles.map((f) => f.name);
        parts.push(
          tf('delete.looseFiles', {
            n: names.length,
            names:
              names.slice(0, PATH_CAP).join(t('common.listSep')) +
              (names.length > PATH_CAP ? t('delete.othersMore') : ''),
          })
        );
      }
      audioCb = this.optionRow(
        c,
        tf('batchDelete.alsoAudio', { n: audioFolderCount + targets.audioFiles.length }),
        parts.join(t('common.semicolon'))
      );
    }

    let coverCb: HTMLInputElement | null = null;
    if (targets.coverFiles.length) {
      coverCb = this.optionRow(
        c,
        tf('batchDelete.alsoCover', { n: targets.coverFiles.length }),
        targets.coverFiles
          .slice(0, PATH_CAP)
          .map((f) => f.path)
          .join(t('common.listSep')) +
          (targets.coverFiles.length > PATH_CAP ? t('delete.othersMore') : '')
      );
    }

    // —— 未纳入删除的资源提示 ——
    for (const k of targets.keptFolders) {
      c.createDiv({
        text: tf('delete.keptFolder', {
          path: k.path,
          n: k.others.length,
          names:
            k.others
              .slice(0, PATH_CAP)
              .map((p) => p.split('/').pop())
              .join(t('common.listSep')) + (k.others.length > PATH_CAP ? t('delete.othersMore') : ''),
          audios: k.audios,
        }),
        cls: 'vinyl-muted vinyl-delete-hint',
      });
    }
    if (targets.sharedAudioPaths.length) {
      c.createDiv({
        text: tf('delete.sharedAudio', {
          n: targets.sharedAudioPaths.length,
          paths:
            targets.sharedAudioPaths.slice(0, PATH_CAP).join(t('common.listSep')) +
            (targets.sharedAudioPaths.length > PATH_CAP ? t('delete.othersMore') : ''),
        }),
        cls: 'vinyl-muted vinyl-delete-hint',
      });
    }
    if (targets.externalAudioRefs.length) {
      c.createDiv({
        text: tf('delete.externalAudio', { n: targets.externalAudioRefs.length }),
        cls: 'vinyl-muted vinyl-delete-hint',
      });
    }
    if (targets.coverSharedCount) {
      c.createDiv({ text: t('batchDelete.coverShared'), cls: 'vinyl-muted vinyl-delete-hint' });
    }
    c.createDiv({
      text: t('delete.trashHint'),
      cls: 'vinyl-muted vinyl-delete-hint',
    });

    // —— 操作区 ——
    // 状态行：删除中 / 失败原因都写在这里 —— 标成 status，读屏软件才会播报
    const status = c.createDiv({
      cls: 'vinyl-muted vinyl-delete-status',
      attr: { role: 'status' },
    });
    const row = c.createDiv({ cls: 'vinyl-import-actions vinyl-delete-actions' });
    const cancelBtn = row.createEl('button', { text: t('common.cancel') });
    const delBtn = row.createEl('button', { text: t('common.delete'), cls: 'mod-warning' });
    cancelBtn.addEventListener('click', () => this.close());
    const doDelete = async () => {
      if (this.busy) return;
      this.busy = true;
      cancelBtn.disabled = true;
      delBtn.disabled = true;
      status.textContent = t('delete.deleting');
      try {
        await this.plugin.deleteAlbums(this.albums, {
          audio: !!audioCb?.checked,
          cover: !!coverCb?.checked,
        });
        this.close();
        this.onDeleted?.();
      } catch (e) {
        this.busy = false;
        cancelBtn.disabled = false;
        delBtn.disabled = false;
        status.setText(tf('delete.failed', { msg: (e as Error).message }));
        console.error('[vinyl] 批量删除专辑失败', e);
      }
    };
    delBtn.addEventListener('click', () => {
      void doDelete();
    });
    window.setTimeout(() => cancelBtn.focus(), 50);
  }

  // 勾选项行：标题 + 明细路径
  private optionRow(parent: HTMLElement, label: string, detail: string): HTMLInputElement {
    const row = parent.createEl('label', { cls: 'vinyl-delete-opt' });
    const cb = row.createEl('input', { attr: { type: 'checkbox' } });
    cb.checked = true;
    const text = row.createDiv({ cls: 'vinyl-delete-opt-text' });
    text.createDiv({ text: label });
    text.createDiv({ text: detail, cls: 'vinyl-muted vinyl-delete-opt-detail' });
    return cb;
  }

  onClose() {
    this.contentEl.empty();
  }
}
