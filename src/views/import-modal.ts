// 导入弹窗：专辑导入（粘贴网易云 / QQ 音乐链接或 ID）+ 本地音频导入。
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
  collectDroppedFiles,
  droppedRootName,
  libraryCandidates,
  libraryRootHint,
  relPathOf,
  FolderScan,
  LibraryCandidate,
} from '../util';
import { t, tf } from '../core/i18n';

// ============ 专辑导入（网易云 / QQ 音乐） ============

export class AlbumImportModal extends Modal {
  constructor(
    app: App,
    private ctx: ImportContext
  ) {
    super(app);
    this.titleEl.setText(t('import.title'));
  }

  async onOpen() {
    const c = this.contentEl;
    c.empty();
    c.createEl('div', {
      text: t('import.pasteHint'),
      cls: 'vinyl-muted',
    });
    c.createEl('div', {
      text: t('import.exampleHint'),
      cls: 'vinyl-muted',
    });
    const input = c.createEl('input', {
      attr: { type: 'text', placeholder: t('import.linkPlaceholder') },
      cls: 'vinyl-import-input',
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') run();
    });
    const status = c.createDiv({ cls: 'vinyl-muted' });
    const btnRow = c.createDiv({ cls: 'vinyl-import-actions' });
    const btn = btnRow.createEl('button', { text: t('import.action'), cls: 'mod-cta' });

    const run = async () => {
      const val = input.value.trim();
      if (!val) {
        status.textContent = t('import.linkEmpty');
        return;
      }
      btn.disabled = true;
      status.textContent = t('import.fetching');
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
        status.textContent = `${t('import.failed')}${(e as Error).message || e}`;
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
  private dirInput: HTMLInputElement | null = null;
  /** 已选文件（选择器或拖入）；文件优先，不要求先选专辑 */
  private picked: File[] = [];
  /** 选中的文件夹名（空 = 散选文件） */
  private rootName = '';
  /** 文件夹分析结果（散选文件时为 null） */
  private scan: FolderScan | null = null;
  /** 专辑名被手动改过 → 不再自动覆盖 */
  private nameTouched = false;
  /** 音乐库模式下的候选专辑（勾选框） */
  private batchRows: Array<{ cand: LibraryCandidate; cb: HTMLInputElement }> = [];

  constructor(app: App, ctx: ImportContext, albums: AlbumInfo[], presetAlbum?: AlbumInfo) {
    super(app);
    this.ctx = ctx;
    this.albums = albums;
    this.presetAlbum = presetAlbum;
    this.titleEl.setText(t('import.localTitle'));
  }

  async onOpen() {
    const c = this.contentEl;
    c.empty();
    c.addClass('vinyl-local-import');

    // —— ① 文件 / 文件夹 ——
    const fileSec = c.createDiv({ cls: 'vinyl-import-section' });
    fileSec.createDiv({ text: t('import.step1'), cls: 'vinyl-import-step' });
    const pickRow = fileSec.createDiv({ cls: 'vinyl-import-actions' });
    const pickBtn = pickRow.createEl('button', { text: t('import.pickFiles'), cls: 'mod-cta' });
    const pickDirBtn = pickRow.createEl('button', { text: t('import.pickFolder') });
    const fileInput = pickRow.createEl('input', {
      attr: { type: 'file', accept: 'audio/*', multiple: '' },
      cls: 'vinyl-hidden',
    });
    const dirInput = pickRow.createEl('input', {
      attr: { type: 'file', webkitdirectory: '', multiple: '' },
      cls: 'vinyl-hidden',
    });
    this.fileInput = fileInput;
    this.dirInput = dirInput;
    const fileSummary = fileSec.createDiv({
      cls: 'vinyl-muted vinyl-import-files',
      text: t('import.noFilesPicked'),
    });

    // —— ② 目标：新建 / 已有 ——
    const targetSec = c.createDiv({ cls: 'vinyl-import-section' });
    targetSec.createDiv({ text: t('import.step2'), cls: 'vinyl-import-step' });

    const newRow = targetSec.createEl('label', { cls: 'vinyl-import-choice' });
    const newRadio = newRow.createEl('input', { attr: { type: 'radio', name: 'vinyl-target' } });
    newRow.createSpan({ text: t('import.targetNew') });
    const nameInput = targetSec.createEl('input', {
      attr: { type: 'text', placeholder: t('import.namePlaceholder') },
      cls: 'vinyl-import-input',
    });

    const existRow = targetSec.createEl('label', { cls: 'vinyl-import-choice' });
    const existRadio = existRow.createEl('input', { attr: { type: 'radio', name: 'vinyl-target' } });
    existRow.createSpan({ text: t('import.targetExisting') });
    const sel = targetSec.createEl('select', { cls: 'vinyl-import-album' });
    sel.createEl('option', { text: t('import.pickAlbum'), value: '' });
    for (const a of this.albums) {
      const o = sel.createEl('option', {
        text: `${a.title}${a.artist ? ' — ' + a.artist : ''}`,
        value: a.path,
      });
      if (a.path === this.presetAlbum?.path) o.selected = true;
    }
    if (!this.albums.length) {
      existRow.addClass('is-disabled');
      existRow.createSpan({ text: t('import.noAlbumNotes'), cls: 'vinyl-muted' });
    }
    // 音乐库模式（识别到多个专辑子目录）时隐藏上面这套单选，改为逐张勾选
    const targetFormEls = [newRow, nameInput, existRow, sel];
    const batchHost = targetSec.createDiv({ cls: 'vinyl-import-batch' });

    // —— ③ 落库方式 ——
    const modeSec = c.createDiv({ cls: 'vinyl-import-section' });
    modeSec.createDiv({ text: t('import.step3'), cls: 'vinyl-import-step' });
    const modeRow = modeSec.createDiv({ cls: 'vinyl-import-row' });
    const modeSel = modeRow.createEl('select');
    modeSel.createEl('option', { text: t('import.modeCopyLong'), value: 'copy' });
    modeSel.createEl('option', { text: t('import.modeLinkLong'), value: 'link' });
    modeSel.value = this.ctx.settings().importMode;

    // —— 操作区 ——
    const status = c.createDiv({ cls: 'vinyl-muted vinyl-import-status' });
    const btnRow = c.createDiv({ cls: 'vinyl-import-actions' });
    const btn = btnRow.createEl('button', { text: t('import.start'), cls: 'mod-cta' });

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
        fileSummary.setText(t('import.noFilesPicked'));
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
          ? tf('import.folderSubfolders', { n: this.scan.audioSubfolders })
          : '';
        const other = this.scan.others ? tf('import.folderOthers', { n: this.scan.others }) : '';
        fileSummary.setText(
          tf('import.folderSummary', { name: this.scan.rootName, n: this.scan.files.length }) +
            sub +
            other
        );
      } else {
        fileSummary.setText(
          tf('import.filesSelected', {
            n: names.length,
            names:
              names.slice(0, 3).join(t('common.listSep')) +
              (names.length > 3 ? t('import.filesMore') : ''),
          })
        );
      }
      fileSummary.setAttr('title', names.join('\n'));
      if (!this.nameTouched && newRadio.checked) {
        nameInput.value = this.rootName || suggestAlbumTitle(this.picked);
      }
      // 音乐库根目录 → 逐张专辑勾选（而不是禁止导入）
      const isLib = this.scan?.verdict === 'library';
      for (const el of targetFormEls) el.toggleClass('vinyl-hidden', isLib);
      batchHost.empty();
      this.batchRows = [];
      if (isLib && this.scan) {
        const cands = libraryCandidates(
          this.picked.map((f) => ({ file: f, relPath: relPathOf(f) }))
        );
        batchHost.createDiv({
          cls: 'vinyl-import-step',
          text: tf('import.libraryFound', { n: cands.length }),
        });
        for (const cand of cands) {
          const row = batchHost.createEl('label', { cls: 'vinyl-import-choice' });
          const cb = row.createEl('input', { attr: { type: 'checkbox' } });
          cb.checked = true;
          row.createSpan({ text: tf('import.candidateRow', { name: cand.name, n: cand.files.length }) });
          this.batchRows.push({ cand, cb });
        }
        btn.setText(tf('import.importNAlbums', { n: cands.length }));
      } else {
        btn.setText(t('import.start'));
      }
      status.setText(isLib && this.scan ? libraryRootHint(this.scan) : '');
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
      const picked = await collectDroppedFiles(dt);
      if (picked.length) takeFiles(picked.map((p) => p.file), droppedRootName(picked));
    });

    const run = async () => {
      status.setText('');
      const mode = modeSel.value === 'link' ? 'link' : 'copy';
      // 音乐库根目录：逐张建专辑导入
      if (this.scan?.verdict === 'library') {
        const chosen = this.batchRows.filter((r) => r.cb.checked);
        if (!chosen.length) {
          status.setText(t('import.pickAtLeastOne'));
          return;
        }
        btn.disabled = true;
        let albums = 0;
        let added = 0;
        let failed = 0;
        try {
          for (let i = 0; i < chosen.length; i++) {
            const { cand } = chosen[i];
            status.setText(
              tf('import.importingProgress', { i: i + 1, n: chosen.length, name: cand.name })
            );
            try {
              const album = await createAlbumFromFiles(this.ctx, cand.files, cand.name, mode);
              if (!album) {
                failed++;
                continue;
              }
              const res = await importLocalAudio(this.ctx, album, cand.files, mode);
              albums++;
              added += res.added.length;
            } catch (e) {
              failed++;
              console.error('[vinyl] 批量导入失败：' + cand.name, e);
            }
          }
          status.setText(
            tf('import.batchDone', { albums, n: added }) +
              (failed ? tf('import.batchFailed', { n: failed }) : '')
          );
          notice(status.textContent || '');
          this.close();
        } finally {
          btn.disabled = false;
        }
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
            ? t('import.noSupportedAudio')
            : t('import.pickFirst')
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
            status.setText(t('import.needAlbumName'));
            return;
          }
          album = await createAlbumFromFiles(this.ctx, audio, name, mode);
          created = !!album;
        } else {
          album = this.albums.find((a) => a.path === sel.value) || null;
          if (!album) {
            status.setText(t('import.needTargetAlbum'));
            return;
          }
        }
        if (!album) {
          status.setText(t('import.createFailed'));
          return;
        }
        status.setText(
          tf('import.importingFiles', {
            n: audio.length,
            mode: mode === 'copy' ? t('import.modeCopyShort') : t('import.modeLinkShort'),
          })
        );
        const res = await importLocalAudio(this.ctx, album, audio, mode);
        const detail: string[] = [];
        if (res.skippedExisting.length) {
          detail.push(tf('import.skippedExisting', { n: res.skippedExisting.length }));
        }
        status.setText(
          (res.added.length
            ? tf('import.doneInto', { n: res.added.length, title: album.title })
            : t('import.nothingToImport')) +
            (detail.length
              ? tf('import.detailSuffix', { details: detail.join(t('common.comma')) })
              : '') +
            (res.fallback ? t('import.fallbackCopy') : '')
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
        status.setText(`${t('import.failed')}${(e as Error).message || e}`);
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
