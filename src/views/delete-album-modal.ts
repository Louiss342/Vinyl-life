// 删除专辑弹窗：二次确认 + 可选连带清理（本地音频 / 封面）。
// 资产盘点在 onOpen 时做一次（模态打开期间专辑墙不会改动）；执行统一走 plugin.deleteAlbum。
import { App, Modal } from 'obsidian';
import type VinylLifePlugin from '../main';
import { AlbumInfo } from '../core/album-index';
import { AlbumDeleteTargets, collectAlbumDeleteTargets, scanFolderContents } from '../delete';
import { t, tf } from '../core/i18n';

export class DeleteAlbumModal extends Modal {
  private targets: AlbumDeleteTargets;
  private busy = false;

  constructor(
    app: App,
    private plugin: VinylLifePlugin,
    private album: AlbumInfo
  ) {
    super(app);
    this.titleEl.setText(t('delete.title'));
    this.targets = collectAlbumDeleteTargets(app, album);
  }

  async onOpen() {
    // 特意不叫 t：t 已被 i18n 的查表函数占用
    const targets = this.targets;
    const c = this.contentEl;
    c.empty();
    c.addClass('vinyl-delete-modal');

    const head = c.createDiv({ cls: 'vinyl-delete-head' });
    head.createSpan({ text: tf('delete.quoted', { title: this.album.title }), cls: 'vinyl-delete-title' });
    if (this.album.artist) head.createSpan({ text: this.album.artist, cls: 'vinyl-muted' });
    c.createDiv({ text: this.album.path, cls: 'vinyl-muted vinyl-delete-path' });

    const snap = this.plugin.engine.snapshot();
    if (snap.albumNotePath === this.album.path) {
      c.createDiv({ text: t('delete.playingHint'), cls: 'vinyl-error' });
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
        parts.push(
          tf('delete.folderPart', { path: f.path, n: scanFolderContents(f).audios.length })
        );
      }
      if (targets.audioFiles.length) {
        parts.push(
          tf('delete.looseFiles', {
            n: targets.audioFiles.length,
            names: targets.audioFiles.map((f) => f.name).join(t('common.listSep')),
          })
        );
      }
      audioCb = this.optionRow(
        c,
        tf('delete.alsoAudio', { n: audioFolderCount + targets.audioFiles.length }),
        parts.join(t('common.semicolon'))
      );
    }

    let coverCb: HTMLInputElement | null = null;
    if (targets.coverFile && !targets.coverShared) {
      coverCb = this.optionRow(c, t('delete.alsoCover'), targets.coverFile.path);
    }

    // —— 未纳入删除的资源提示 ——
    for (const k of targets.keptFolders) {
      c.createDiv({
        text: tf('delete.keptFolder', {
          path: k.path,
          n: k.others.length,
          names:
            k.others
              .slice(0, 3)
              .map((p) => p.split('/').pop())
              .join(t('common.listSep')) + (k.others.length > 3 ? t('delete.othersMore') : ''),
          audios: k.audios,
        }),
        cls: 'vinyl-muted vinyl-delete-hint',
      });
    }
    if (targets.sharedAudioPaths.length) {
      c.createDiv({
        text: tf('delete.sharedAudio', {
          n: targets.sharedAudioPaths.length,
          paths: targets.sharedAudioPaths.join(t('common.listSep')),
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
    if (targets.coverShared) {
      c.createDiv({
        text: t('delete.coverShared'),
        cls: 'vinyl-muted vinyl-delete-hint',
      });
    }
    c.createDiv({
      text: t('delete.trashHint'),
      cls: 'vinyl-muted vinyl-delete-hint',
    });

    // —— 操作区 ——
    const status = c.createDiv({ cls: 'vinyl-muted vinyl-delete-status' });
    const row = c.createDiv({ cls: 'vinyl-import-actions vinyl-delete-actions' });
    const cancelBtn = row.createEl('button', { text: t('common.cancel') });
    const delBtn = row.createEl('button', { text: t('common.delete'), cls: 'mod-warning' });
    cancelBtn.addEventListener('click', () => this.close());
    delBtn.addEventListener('click', async () => {
      if (this.busy) return;
      this.busy = true;
      cancelBtn.disabled = true;
      delBtn.disabled = true;
      status.textContent = t('delete.deleting');
      try {
        await this.plugin.deleteAlbum(this.album, {
          audio: !!audioCb?.checked,
          cover: !!coverCb?.checked,
        });
        this.close();
      } catch (e) {
        this.busy = false;
        cancelBtn.disabled = false;
        delBtn.disabled = false;
        status.setText(tf('delete.failed', { msg: (e as Error).message }));
        console.error('[vinyl] 删除专辑失败', e);
      }
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
