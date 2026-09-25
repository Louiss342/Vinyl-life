import { App, Modal } from 'obsidian';
import type { AlbumInfo } from '../core/album-index';
import { t } from '../core/i18n';
import { markVinylModal } from '../util';

export class AlbumEditionModal extends Modal {
  constructor(app: App, private album: AlbumInfo, private onSaved: () => void) {
    super(app);
    markVinylModal(this);
    this.titleEl.setText(t('edition.set'));
  }

  onOpen(): void {
    this.contentEl.createEl('p', { text: this.album.title });
    const input = this.contentEl.createEl('input', { attr: { type: 'text', placeholder: t('edition.placeholder') } });
    input.value = this.album.edition || '';
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: t('common.cancel') }).onclick = () => this.close();
    const save = actions.createEl('button', { text: t('common.save'), cls: 'mod-cta' });
    save.onclick = async () => {
      // 回调参数显式标注（理由同 import.ts）：不标注则 fm 是 any，读写属性都算不安全访问
      await this.app.fileManager.processFrontMatter(
        this.album.file,
        (fm: Record<string, unknown>) => {
          if (input.value.trim()) fm.edition = input.value.trim();
          else delete fm.edition;
        }
      );
      this.close();
      this.onSaved();
    };
    input.focus();
  }
}
