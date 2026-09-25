// 本地音频导入面板：① 选文件 / 文件夹（或把文件拖进来）→ ② 目标 → ③ 落库方式 → 开始导入。
// 与在线搜索（views/album-search）同一个思路：机制在这里，外壳由宿主给 ——
//   专辑墙的「添加」浮层把它当第二层（选文件 / 拖进来的入口），
//   本地导入弹窗（卡片右键「导入本地音频…」、命令面板）把它当弹窗内容。
// 文件夹 = 一张专辑；子目录结构保留（audio/<专辑>/CD1/01.flac）；音乐库根目录改成逐张勾选。
import { AlbumInfo } from '../core/album-index';
import {
  ImportContext,
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

/** 宿主接管的收尾：导入跑完（成功与否都算一次「跑完」）时由宿主决定关窗 / 留在原地 */
export interface LocalImportHost {
  /** 有一批音频真的写进去了（或库模式下逐张跑完）：弹窗据此开笔记 / 关窗，浮层据此描边 */
  onDone(result: { imported: number; album: AlbumInfo | null; created: boolean }): void;
}

export class LocalImportPane {
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
  /** 离场时要摘掉的监听（宿主容器上的拖放） */
  private cleanups: Array<() => void> = [];
  /** 收下文件的实现（mount 时建好：分析文件夹、刷新摘要与目标区） */
  private applyFiles: ((files: File[], rootName: string) => void) | null = null;

  constructor(
    private ctx: ImportContext,
    private albums: AlbumInfo[],
    private presetAlbum: AlbumInfo | undefined,
    private host: LocalImportHost
  ) {}

  mount(container: HTMLElement): void {
    const c = container.createDiv({ cls: 'vinyl-local-import' });

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
    const fileSummary = fileSec.createDiv({ cls: 'vinyl-muted vinyl-import-files' });

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
        fileSummary.setText('');
        this.scan = null;
        return;
      }
      this.scan = this.rootName
        ? analyzeFolder(
            this.rootName,
            this.picked.map((f) => ({
              file: f,
              relPath: String(f.webkitRelativePath || f.relPath || ''),
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

    /** 收下一组文件（选择器 / 拖放都走这里）：分析文件夹、刷新摘要与目标区 */
    this.applyFiles = (files, rootName) => {
      if (!files.length) return;
      this.picked = files;
      this.rootName = rootName;
      status.setText('');
      refreshFiles();
      (newRadio.checked ? nameInput : btn).focus();
    };

    pickBtn.addEventListener('click', () => fileInput.click());
    pickDirBtn.addEventListener('click', () => dirInput.click());
    fileInput.addEventListener('change', () => this.takeFiles(Array.from(fileInput.files || [])));
    dirInput.addEventListener('change', () => {
      const files = Array.from(dirInput.files || []);
      const root = String(files[0]?.webkitRelativePath || '').split('/')[0] || '';
      this.takeFiles(files, root);
    });

    // 拖文件 / 文件夹进这一层任意位置
    const onDragOver = (ev: DragEvent) => {
      ev.preventDefault();
      c.addClass('is-drop-active');
    };
    const onDragLeave = () => c.removeClass('is-drop-active');
    const onDrop = (ev: DragEvent) => {
      void (async () => {
        ev.preventDefault();
        c.removeClass('is-drop-active');
        const dt = ev.dataTransfer;
        if (!dt) return;
        const picked = await collectDroppedFiles(dt);
        if (picked.length) this.takeFiles(picked.map((p) => p.file), droppedRootName(picked));
      })();
    };
    c.addEventListener('dragover', onDragOver);
    c.addEventListener('dragleave', onDragLeave);
    c.addEventListener('drop', onDrop);
    this.cleanups.push(() => {
      c.removeEventListener('dragover', onDragOver);
      c.removeEventListener('dragleave', onDragLeave);
      c.removeEventListener('drop', onDrop);
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
          this.host.onDone({ imported: added, album: null, created: false });
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
        if (res.added.length) this.host.onDone({ imported: res.added.length, album, created });
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

    // 默认目标：带入了专辑（卡片右键 / 播放中）→ 已有专辑；从工具栏 / 命令进入 → 新建专辑
    setMode(!this.presetAlbum);
    window.setTimeout(() => pickBtn.focus(), 50);
  }

  /** 选择文件：直接弹系统选择器（添加浮层的「选择文件」入口用它，一步到位） */
  pickFiles(): void {
    this.fileInput?.click();
  }

  /** 把一组文件喂进来（拖到添加浮层上时用）：走和选择器完全一样的分析流程 */
  takeFiles(files: File[], rootName = ''): void {
    this.applyFiles?.(files, rootName);
  }

  /** 导完一批：清空已选文件与目标区（浮层留在原地，接着导下一批） */
  reset(): void {
    this.applyFiles?.([], '');
  }

  destroy(): void {
    for (const fn of this.cleanups) fn();
    this.cleanups = [];
    for (const el of [this.fileInput, this.dirInput]) {
      if (el) el.remove();
    }
    this.fileInput = null;
    this.dirInput = null;
  }
}
