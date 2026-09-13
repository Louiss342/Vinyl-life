// 导入弹窗（M4）：专辑导入（粘贴网易云 / QQ 音乐链接或 ID）+ 本地音频导入（目标专辑/落库模式/文件选择）
import { App, Modal, TFile, setIcon } from 'obsidian';
import { AlbumInfo } from '../core/album-index';
import {
  ImportContext,
  importAlbum,
  importLocalAudio,
} from '../import';
import { notice, isAudioFile, skippedFormatsText } from '../util';

// ============ 专辑导入（网易云 / QQ 音乐） ============

export class AlbumImportModal extends Modal {
  constructor(
    app: App,
    private ctx: ImportContext
  ) {
    super(app);
    this.titleEl.setText('导入专辑');
  }

  async onOpen() {
    const c = this.contentEl;
    c.empty();
    c.createEl('div', {
      text: '粘贴专辑链接（或 ID），网易云与 QQ 音乐都支持：',
      cls: 'vinyl-muted',
    });
    c.createEl('div', {
      text: '网易云：https://music.163.com/#/album?id=437968 ／ QQ 音乐：https://y.qq.com/n/ryqq/albumDetail/004VSvF52mQoQp',
      cls: 'vinyl-muted',
    });
    const input = c.createEl('input', {
      attr: { type: 'text', placeholder: '网易云或 QQ 音乐专辑链接 / ID' },
      cls: 'vinyl-import-input',
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') run();
    });
    const status = c.createDiv({ cls: 'vinyl-muted' });
    const btnRow = c.createDiv({ cls: 'vinyl-import-actions' });
    const btn = btnRow.createEl('button', { text: '导入', cls: 'mod-cta' });

    const run = async () => {
      const val = input.value.trim();
      if (!val) {
        status.textContent = '请输入专辑链接或 ID';
        return;
      }
      btn.disabled = true;
      status.textContent = '正在获取专辑信息（在线音源首次使用需启动本地网关）…';
      try {
        const res = await importAlbum(this.ctx, val);
        if (res.ok && res.file instanceof TFile) {
          status.textContent = '✅ ' + res.detail;
          await this.app.workspace.getLeaf(false).openFile(res.file);
          this.close();
        } else {
          status.textContent = '❌ ' + res.detail;
          if (res.file instanceof TFile) {
            // 已存在的专辑 → 直接打开
            await this.app.workspace.getLeaf(false).openFile(res.file);
            this.close();
          }
        }
      } catch (e) {
        // 建目录 / 建笔记失败等异常：给可读提示并恢复按钮，不把弹窗卡在「正在获取…」
        console.error('[vinyl] 导入失败', e);
        status.textContent = `❌ 导入失败：${(e as Error).message || e}`;
      } finally {
        btn.disabled = false;
      }
    };
    btn.addEventListener('click', run);
    window.setTimeout(() => input.focus(), 50);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ============ 本地音频导入 ============

export class LocalImportModal extends Modal {
  private albums: AlbumInfo[];
  private presetAlbum?: AlbumInfo;
  private ctx: ImportContext;
  private fileInput: HTMLInputElement | null = null;

  constructor(app: App, ctx: ImportContext, albums: AlbumInfo[], presetAlbum?: AlbumInfo) {
    super(app);
    this.ctx = ctx;
    this.albums = albums;
    this.presetAlbum = presetAlbum;
    this.titleEl.setText('导入本地音频');
  }

  async onOpen() {
    const c = this.contentEl;
    c.empty();
    c.addClass('vinyl-local-import');

    // 目标专辑
    const albumRow = c.createDiv({ cls: 'vinyl-import-row' });
    albumRow.createSpan({ text: '目标专辑', cls: 'vinyl-import-label' });
    const sel = albumRow.createEl('select');
    sel.createEl('option', { text: '选择专辑…', value: '' });
    for (const a of this.albums) {
      const o = sel.createEl('option', {
        text: `${a.title}${a.artist ? ' — ' + a.artist : ''}`,
        value: a.path,
      });
      if (a.path === this.presetAlbum?.path) o.selected = true;
    }

    // 落库模式
    const modeRow = c.createDiv({ cls: 'vinyl-import-row' });
    modeRow.createSpan({ text: '落库模式', cls: 'vinyl-import-label' });
    const modeSel = modeRow.createEl('select');
    modeSel.createEl('option', { text: '复制进 vault（可随库同步）', value: 'copy' });
    modeSel.createEl('option', { text: '外链绝对路径（不复制，仅记路径）', value: 'link' });
    modeSel.value = this.ctx.settings().importMode;

    // 文件选择
    const status = c.createDiv({ cls: 'vinyl-muted' });
    const pickRow = c.createDiv({ cls: 'vinyl-import-actions' });
    const pickBtn = pickRow.createEl('button', { text: '选择音频文件…', cls: 'mod-cta' });
    const fileInput = pickRow.createEl('input', {
      attr: { type: 'file', accept: 'audio/*', multiple: '' },
    });
    fileInput.style.display = 'none';
    this.fileInput = fileInput;

    pickBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const album = this.albums.find((a) => a.path === sel.value);
      const files = Array.from(fileInput.files || []);
      if (!album) {
        status.textContent = '请先选择目标专辑';
        return;
      }
      if (!files.length) return;
      const mode = modeSel.value === 'link' ? 'link' : 'copy';
      status.textContent = `正在导入 ${files.length} 个文件（${mode === 'copy' ? '复制进 vault' : '外链引用'}）…`;
      const res = await importLocalAudio(this.ctx, album, files, mode);
      const detail: string[] = [];
      if (res.skippedExisting.length) detail.push(`跳过已存在 ${res.skippedExisting.length} 个`);
      if (res.skippedUnsupported.length) detail.push(`跳过不支持 ${res.skippedUnsupported.length} 个`);
      status.textContent =
        (res.added.length ? `✅ 已导入 ${res.added.length} 个音频` : '⚠️ 没有可导入的音频') +
        (detail.length ? `，${detail.join('，')}` : '') +
        (res.fallback ? '（部分文件无路径信息，已回退复制进 vault）' : '');
      notice(status.textContent);
      if (res.skippedUnsupported.length) notice(skippedFormatsText(res.skippedUnsupported));
      this.close();
    });

    if (!this.albums.length) {
      status.textContent = '还没有专辑笔记——先在专辑墙从文件新建专辑，或导入专辑';
      pickBtn.disabled = true;
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
