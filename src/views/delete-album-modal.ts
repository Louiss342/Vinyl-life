// 删除专辑弹窗（M6）：二次确认 + 可选连带清理（本地音频 / 封面）。
// 资产盘点在 onOpen 时做一次（模态打开期间专辑墙不会改动）；执行统一走 plugin.deleteAlbum。
import { App, Modal } from 'obsidian';
import type VinylLifePlugin from '../main';
import { AlbumInfo } from '../core/album-index';
import { AlbumDeleteTargets, collectAlbumDeleteTargets, scanFolderContents } from '../delete';

export class DeleteAlbumModal extends Modal {
  private targets: AlbumDeleteTargets;
  private busy = false;

  constructor(
    app: App,
    private plugin: VinylLifePlugin,
    private album: AlbumInfo
  ) {
    super(app);
    this.titleEl.setText('删除专辑');
    this.targets = collectAlbumDeleteTargets(app, album);
  }

  async onOpen() {
    const t = this.targets;
    const c = this.contentEl;
    c.empty();
    c.addClass('vinyl-delete-modal');

    const head = c.createDiv({ cls: 'vinyl-delete-head' });
    head.createSpan({ text: `「${this.album.title}」`, cls: 'vinyl-delete-title' });
    if (this.album.artist) head.createSpan({ text: this.album.artist, cls: 'vinyl-muted' });
    c.createDiv({ text: this.album.path, cls: 'vinyl-muted vinyl-delete-path' });

    const snap = this.plugin.engine.snapshot();
    if (snap.albumNotePath === this.album.path) {
      c.createDiv({ text: '该专辑正在播放，删除后将停止播放。', cls: 'vinyl-error' });
    }

    // —— 连带清理选项（有可删资产才出现）——
    const audioFolderCount = t.audioFolders.reduce(
      (n, f) => n + scanFolderContents(f).audios.length,
      0
    );
    let audioCb: HTMLInputElement | null = null;
    if (t.audioFolders.length || t.audioFiles.length) {
      const parts: string[] = [];
      for (const f of t.audioFolders) {
        parts.push(`${f.path}（${scanFolderContents(f).audios.length} 个音频）`);
      }
      if (t.audioFiles.length) {
        parts.push(`零散文件 ${t.audioFiles.length} 个：${t.audioFiles.map((f) => f.name).join('、')}`);
      }
      audioCb = this.optionRow(
        c,
        `同时删除本地音频（${audioFolderCount + t.audioFiles.length} 个文件）`,
        parts.join('；')
      );
    }

    let coverCb: HTMLInputElement | null = null;
    if (t.coverFile && !t.coverShared) {
      coverCb = this.optionRow(c, '同时删除封面图', t.coverFile.path);
    }

    // —— 未纳入删除的资源提示 ——
    for (const k of t.keptFolders) {
      c.createDiv({
        text: `文件夹 ${k.path} 内另有 ${k.others.length} 个非音频文件（${k.others
          .slice(0, 3)
          .map((p) => p.split('/').pop())
          .join('、')}${k.others.length > 3 ? ' 等' : ''}）：只删除其中 ${k.audios} 个音频，文件夹保留`,
        cls: 'vinyl-muted vinyl-delete-hint',
      });
    }
    if (t.sharedAudioPaths.length) {
      c.createDiv({
        text: `另有 ${t.sharedAudioPaths.length} 项音频被其他专辑引用，不会删除：${t.sharedAudioPaths.join('、')}`,
        cls: 'vinyl-muted vinyl-delete-hint',
      });
    }
    if (t.externalAudioRefs.length) {
      c.createDiv({
        text: `外链音频 ${t.externalAudioRefs.length} 项位于库外，不会被删除（笔记删除后需自行清理）`,
        cls: 'vinyl-muted vinyl-delete-hint',
      });
    }
    if (t.coverShared) {
      c.createDiv({
        text: '封面图被其他专辑引用，不会删除',
        cls: 'vinyl-muted vinyl-delete-hint',
      });
    }
    c.createDiv({
      text: '文件按 Obsidian「已删除文件」设置移入回收站或永久删除。',
      cls: 'vinyl-muted vinyl-delete-hint',
    });

    // —— 操作区 ——
    const status = c.createDiv({ cls: 'vinyl-muted vinyl-delete-status' });
    const row = c.createDiv({ cls: 'vinyl-import-actions vinyl-delete-actions' });
    const cancelBtn = row.createEl('button', { text: '取消' });
    const delBtn = row.createEl('button', { text: '删除', cls: 'mod-warning' });
    cancelBtn.addEventListener('click', () => this.close());
    delBtn.addEventListener('click', async () => {
      if (this.busy) return;
      this.busy = true;
      cancelBtn.disabled = true;
      delBtn.disabled = true;
      status.textContent = '正在删除…';
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
        status.setText(`删除失败：${(e as Error).message}`);
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
