import { App, Modal } from 'obsidian';
import type { AlbumInfo } from '../core/album-index';
import { parseLeadingNumber } from '../core/rating';
import { t } from '../core/i18n';
import { markVinylModal } from '../util';

/** 评分编辑（卡片菜单 → 评分）：一个输入框，自己填数字。
 *
 *  为什么是自由输入而不是几档星级（用户 2026-09-26 定稿）：评分是**用户自己的**刻度 ——
 *  有人用 5 分制、有人用 10 分制、有人打 4.5，星级选择器会把「7 分」这种写法挤掉；
 *  而且那一排星在弹窗里又长又占地方。插件只负责读写这个数，不规定它的范围。
 *
 *  留空 = 清除（删掉这个键，不留 `rating: ''` 这种残渣）；填了非数字就地提示、不关窗，
 *  免得把用户刚打的字连同弹窗一起吞掉。写回去的是数字（不是字符串）：排序那头
 *  按数值比大小，字符串会被挡在「人写的值」那套解析里（见 core/rating）。 */
export class RatingModal extends Modal {
  constructor(
    app: App,
    private album: AlbumInfo,
    private onSaved: () => void
  ) {
    super(app);
    markVinylModal(this);
    this.titleEl.setText(t('menu.rating'));
  }

  onOpen(): void {
    this.contentEl.createEl('p', { text: this.album.title });
    const input = this.contentEl.createEl('input', {
      attr: { type: 'text', inputmode: 'decimal', placeholder: t('rating.placeholder') },
    });
    // 预填：读得出数就填那个数（'4/5' 也会预填成 4 —— 用户在这里看到的是「当前值」，
    // 保存与否由他决定；不保存就不会改写原来的写法）
    const current = parseLeadingNumber(this.album.rating);
    input.value = current === null ? '' : String(current);

    const status = this.contentEl.createEl('p', {
      cls: 'vinyl-muted vinyl-rating-status',
      attr: { role: 'status' },
    });
    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: t('common.cancel') }).onclick = () => this.close();
    const save = actions.createEl('button', { text: t('common.save'), cls: 'mod-cta' });
    save.onclick = () => void this.commit(input, status);
    // 回车 = 保存（这个弹窗只有一个字段，别逼用户去够按钮）
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      void this.commit(input, status);
    });
    input.focus();
    input.select();
  }

  private async commit(input: HTMLInputElement, status: HTMLElement): Promise<void> {
    const raw = input.value.trim();
    if (raw === '') {
      await this.write(null); // 留空 = 清除
      return;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      status.setText(t('rating.invalid'));
      input.focus();
      input.select();
      return;
    }
    await this.write(value);
  }

  /** 落盘：给的数字写进去，null 删键（与「设置专辑版本」同一套口径：空值不留空串） */
  private async write(value: number | null): Promise<void> {
    // 回调参数显式标注（理由同 import.ts）：不标注则 fm 是 any，读写属性都算不安全访问
    await this.app.fileManager.processFrontMatter(
      this.album.file,
      (fm: Record<string, unknown>) => {
        if (value === null) delete fm.rating;
        else fm.rating = value;
      }
    );
    this.close();
    this.onSaved();
  }
}
