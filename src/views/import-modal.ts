// 导入弹窗（M4）：专辑导入（粘贴网易云 / QQ 音乐链接或 ID）+ 本地音频导入。
// 本地导入为「文件优先」流程：① 选文件 / 文件夹（或拖进弹窗）→ ② 选目标 → ③ 落库方式。
// 文件夹 = 一张专辑；子目录结构保留（audio/<专辑>/CD1/01.flac）。
import { App, Modal, TFile } from 'obsidian';
import { AlbumInfo } from '../core/album-index';
import {
  ImportContext,
  importAlbum,
  importLocalAudio,
  createAlbumFromFiles,
} from '../import';
import {
  notice,
  skippedFormatsText,
  splitAudioFiles,
  suggestAlbumTitle,
  analyzeFolder,
  FolderScan,
  PickedAudio,
} from '../util';

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

/** 拖入的目录条目递归展开（readEntries 每次最多返回 100 个，必须循环到空） */
async function readEntry(entry: any, parent: string, out: PickedAudio[]): Promise<void> {
  const path = parent + entry.name;
  if (entry.isFile) {
    const file: File = await new Promise((res, rej) => entry.file(res, rej));
    try {
      (file as any).relPath = path; // 供 relDirOf / 子目录保留使用
    } catch (_) {}
    out.push({ file, relPath: path });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  for (;;) {
    const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const child of batch) await readEntry(child, path + '/', out);
  }
}

function libraryHint(scan: FolderScan): string {
  return (
    `ℹ️「${scan.rootName}」根层没有音频，但有 ${scan.audioSubfolders} 个子文件夹各含音频——` +
    '看起来是音乐库根目录。文件夹导入一次只建一张专辑，请改选**具体的专辑文件夹**。'
  );
}

export class LocalImportModal extends Modal {
  private albums: AlbumInfo[];
  private presetAlbum?: AlbumInfo;
  private ctx: ImportContext;
  private fileInput: HTMLInputElement | null = null;
  private dirInput: HTMLInputElement | null = null;
  /** 已选文件（选择器或拖入）；不再「选完专辑才能选文件」 */
  private picked: File[] = [];
  /** 选中的文件夹名（空 = 散选文件） */
  private rootName = '';
  /** 文件夹分析结果（散选文件时为 null） */
  private scan: FolderScan | null = null;
  /** 专辑名被手动改过 → 不再自动覆盖 */
  private nameTouched = false;

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

    // —— ① 文件 / 文件夹 ——
    const fileSec = c.createDiv({ cls: 'vinyl-import-section' });
    fileSec.createDiv({ text: '① 选择音频文件或文件夹', cls: 'vinyl-import-step' });
    const pickRow = fileSec.createDiv({ cls: 'vinyl-import-actions' });
    const pickBtn = pickRow.createEl('button', { text: '选择文件…', cls: 'mod-cta' });
    const pickDirBtn = pickRow.createEl('button', { text: '选择文件夹…' });
    const fileInput = pickRow.createEl('input', {
      attr: { type: 'file', accept: 'audio/*', multiple: '' },
    });
    const dirInput = pickRow.createEl('input', {
      attr: { type: 'file', webkitdirectory: '', multiple: '' },
    });
    fileInput.style.display = 'none';
    dirInput.style.display = 'none';
    this.fileInput = fileInput;
    this.dirInput = dirInput;
    const fileSummary = fileSec.createDiv({
      cls: 'vinyl-muted vinyl-import-files',
      text: '尚未选择——点上面的按钮，或把文件 / 文件夹直接拖进本窗口（文件夹按一张专辑导入，子目录结构保留）',
    });

    // —— ② 目标：新建 / 已有 ——
    const targetSec = c.createDiv({ cls: 'vinyl-import-section' });
    targetSec.createDiv({ text: '② 导入到', cls: 'vinyl-import-step' });

    const newRow = targetSec.createEl('label', { cls: 'vinyl-import-choice' });
    const newRadio = newRow.createEl('input', { attr: { type: 'radio', name: 'vinyl-target' } });
    newRow.createSpan({ text: '新建专辑' });
    const nameInput = targetSec.createEl('input', {
      attr: { type: 'text', placeholder: '专辑名（自动从文件夹 / 文件名推断）' },
      cls: 'vinyl-import-input',
    });

    const existRow = targetSec.createEl('label', { cls: 'vinyl-import-choice' });
    const existRadio = existRow.createEl('input', { attr: { type: 'radio', name: 'vinyl-target' } });
    existRow.createSpan({ text: '已有专辑' });
    const sel = targetSec.createEl('select', { cls: 'vinyl-import-album' });
    sel.createEl('option', { text: '选择专辑…', value: '' });
    for (const a of this.albums) {
      const o = sel.createEl('option', {
        text: `${a.title}${a.artist ? ' — ' + a.artist : ''}`,
        value: a.path,
      });
      if (a.path === this.presetAlbum?.path) o.selected = true;
    }
    if (!this.albums.length) {
      existRow.addClass('is-disabled');
      existRow.createSpan({ text: '（还没有专辑笔记）', cls: 'vinyl-muted' });
    }

    // —— ③ 落库方式 ——
    const modeSec = c.createDiv({ cls: 'vinyl-import-section' });
    modeSec.createDiv({ text: '③ 落库方式', cls: 'vinyl-import-step' });
    const modeRow = modeSec.createDiv({ cls: 'vinyl-import-row' });
    const modeSel = modeRow.createEl('select');
    modeSel.createEl('option', { text: '复制进 vault（可随库同步）', value: 'copy' });
    modeSel.createEl('option', { text: '外链绝对路径（不复制，仅记路径）', value: 'link' });
    modeSel.value = this.ctx.settings().importMode;

    // —— 操作区 ——
    const status = c.createDiv({ cls: 'vinyl-muted vinyl-import-status' });
    const btnRow = c.createDiv({ cls: 'vinyl-import-actions' });
    const btn = btnRow.createEl('button', { text: '开始导入', cls: 'mod-cta' });

    const setMode = (isNew: boolean) => {
      newRadio.checked = isNew;
      existRadio.checked = !isNew;
      nameInput.disabled = !isNew;
      sel.disabled = isNew;
    };
    newRadio.addEventListener('change', () => setMode(true));
    existRadio.addEventListener('change', () => setMode(false));
    nameInput.addEventListener('input', () => {
      this.nameTouched = true;
    });

    const refreshFiles = () => {
      const names = this.picked.map((f) => f.name);
      if (!names.length) {
        fileSummary.setText(
          '尚未选择——点上面的按钮，或把文件 / 文件夹直接拖进本窗口（文件夹按一张专辑导入，子目录结构保留）'
        );
        this.scan = null;
        return;
      }
      this.scan = this.rootName
        ? analyzeFolder(
            this.rootName,
            this.picked.map((f) => ({
              file: f,
              relPath: String((f as any).webkitRelativePath || (f as any).relPath || ''),
            }))
          )
        : null;
      if (this.scan) {
        const sub = this.scan.audioSubfolders
          ? `，含 ${this.scan.audioSubfolders} 个子文件夹`
          : '';
        const other = this.scan.others ? `（另有 ${this.scan.others} 个非音频文件已忽略）` : '';
        fileSummary.setText(`文件夹「${this.scan.rootName}」→ ${this.scan.files.length} 个音频${sub}${other}`);
      } else {
        fileSummary.setText(
          `已选 ${names.length} 个文件：${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}`
        );
      }
      fileSummary.setAttr('title', names.join('\n'));
      if (!this.nameTouched && newRadio.checked) {
        nameInput.value = this.rootName || suggestAlbumTitle(this.picked);
      }
      status.setText(this.scan?.verdict === 'library' ? libraryHint(this.scan) : '');
    };
    const takeFiles = (files: File[], rootName = '') => {
      if (!files.length) return;
      this.picked = files;
      this.rootName = rootName;
      status.setText('');
      refreshFiles();
      (newRadio.checked ? nameInput : btn).focus();
    };

    pickBtn.addEventListener('click', () => fileInput.click());
    pickDirBtn.addEventListener('click', () => dirInput.click());
    fileInput.addEventListener('change', () => takeFiles(Array.from(fileInput.files || [])));
    dirInput.addEventListener('change', () => {
      const files = Array.from(dirInput.files || []);
      const root = String((files[0] as any)?.webkitRelativePath || '').split('/')[0] || '';
      takeFiles(files, root);
    });

    // 拖文件 / 文件夹进弹窗任意位置
    c.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      c.addClass('is-drop-active');
    });
    c.addEventListener('dragleave', () => c.removeClass('is-drop-active'));
    c.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      c.removeClass('is-drop-active');
      const dt = ev.dataTransfer;
      if (!dt) return;
      const entries = Array.from(dt.items || [])
        .map((it) =>
          typeof (it as any).webkitGetAsEntry === 'function' ? (it as any).webkitGetAsEntry() : null
        )
        .filter((e): e is any => !!e);
      if (entries.length) {
        const scanned: PickedAudio[] = [];
        for (const entry of entries) await readEntry(entry, '', scanned);
        const onlyDir =
          entries.length === 1 && entries[0].isDirectory ? String(entries[0].name || '') : '';
        takeFiles(scanned.map((s) => s.file), onlyDir);
        return;
      }
      if (dt.files?.length) takeFiles(Array.from(dt.files));
    });

    const run = async () => {
      status.setText('');
      if (this.scan?.verdict === 'library') {
        status.setText(libraryHint(this.scan));
        return;
      }
      const picked = splitAudioFiles(this.picked);
      const audio = this.scan ? this.scan.files : picked.audio;
      if (!this.scan && picked.skipped.length) {
        notice(skippedFormatsText(picked.skipped.map((f) => f.name)));
      }
      if (!audio.length) {
        status.setText(
          this.scan && !this.scan.files.length
            ? '这个文件夹里没有受支持的音频文件'
            : '请先选择音频文件或文件夹'
        );
        return;
      }
      btn.disabled = true;
      try {
        let album: AlbumInfo | null;
        let created = false;
        if (newRadio.checked) {
          const name = nameInput.value.trim() || this.rootName;
          if (!name) {
            status.setText('请填写专辑名');
            return;
          }
          album = await createAlbumFromFiles(this.ctx, audio, name);
          created = !!album;
        } else {
          album = this.albums.find((a) => a.path === sel.value) || null;
          if (!album) {
            status.setText('请选择目标专辑');
            return;
          }
        }
        if (!album) {
          status.setText('❌ 创建专辑失败');
          return;
        }
        const mode = modeSel.value === 'link' ? 'link' : 'copy';
        status.setText(
          `正在导入 ${audio.length} 个文件（${mode === 'copy' ? '复制进 vault' : '外链引用'}）…`
        );
        const res = await importLocalAudio(this.ctx, album, audio, mode);
        const detail: string[] = [];
        if (res.skippedExisting.length) detail.push(`跳过已存在 ${res.skippedExisting.length} 个`);
        status.setText(
          (res.added.length
            ? `✅ 已导入 ${res.added.length} 个音频到「${album.title}」`
            : '⚠️ 没有可导入的音频') +
            (detail.length ? `，${detail.join('，')}` : '') +
            (res.fallback ? '（部分文件无路径信息，已回退复制进 vault）' : '')
        );
        notice(status.textContent || '');
        if (res.skippedUnsupported.length) notice(skippedFormatsText(res.skippedUnsupported));
        // 新建的专辑：打开笔记，方便接着补封面 / 年份 / 评分
        if (created && album.file instanceof TFile) {
          await this.app.workspace.getLeaf(false).openFile(album.file);
        }
        this.close();
      } catch (e) {
        console.error('[vinyl] 本地导入失败', e);
        status.setText(`❌ 导入失败：${(e as Error).message || e}`);
      } finally {
        btn.disabled = false;
      }
    };

    btn.addEventListener('click', () => void run());
    nameInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') void run();
    });

    // 默认目标：带入了专辑（卡片右键 / 播放中）→ 已有专辑；从命令或工具栏进入 → 新建专辑
    setMode(!this.presetAlbum);
    window.setTimeout(() => pickBtn.focus(), 50);
  }

  onClose() {
    for (const el of [this.fileInput, this.dirInput]) {
      if (el) el.remove();
    }
    this.fileInput = null;
    this.dirInput = null;
    this.contentEl.empty();
  }
}
