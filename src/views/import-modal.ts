// 导入弹窗：专辑导入（粘贴网易云 / QQ 音乐链接或 ID）+ 本地音频导入。
// 本地导入为「文件优先」流程：① 选文件 / 文件夹（或拖进弹窗）→ ② 选目标 → ③ 落库方式。
// 文件夹 = 一张专辑；子目录结构保留（audio/<专辑>/CD1/01.flac）。
import { App, Modal, TFile } from 'obsidian';
import { AlbumInfo } from '../core/album-index';
import {
  ImportContext,
  importAlbum,
  importAlbumRef,
  importLocalAudio,
  createAlbumFromFiles,
  parseAlbumInput,
} from '../import';
import {
  AlbumSearchCandidate,
  AlbumSearchResult,
  discoverAlbums,
  loadMoreAlbums,
} from '../core/album-discovery';
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

/** 首屏画多少条 / 每次「显示更多」多画多少条。
 *  本地展开不花网络，所以先白嫖池子：等池子真的见底了，才轮到向上游要下一页。 */
const REVEAL_FIRST = 20;
const REVEAL_STEP = 20;

export class AlbumImportModal extends Modal {
  private searchTimer: number | null = null;
  private latestRequestId = 0;
  /** 当前词的结果池（已隐去在库中的那些）：展开与翻页都在这上面长 */
  private pool: AlbumSearchCandidate[] = [];
  /** 池子里已经画出来的条数 */
  private shown = 0;
  /** 上游还有没有下一页 */
  private hasMore = false;
  /** 当前词：翻页时要拿它去要下一页，也是「这批结果属于谁」的凭据 */
  private query = '';
  /** 本轮就地导入过的 key → 笔记路径。搜索结果本身不再回填已导入的（见 album-discovery），
   *  所以「导入完就地变打开」这个状态只能弹窗自己记 —— 它属于交互，不属于搜索结果 */
  private importedPaths = new Map<string, string>();
  /** 本轮已经导入了多少张：搜索页导入后不跳转，要有个进度给用户看（批量导入就靠它） */
  private importedCount = 0;
  private inputEl!: HTMLInputElement;
  private searchBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private resultsEl!: HTMLElement;
  private moreBar!: HTMLElement;
  private moreBtn!: HTMLButtonElement;

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
    c.addClass('vinyl-album-import');
    const searchRow = c.createDiv({ cls: 'vinyl-import-search-row' });
    this.inputEl = searchRow.createEl('input', {
      attr: { type: 'search', placeholder: t('import.searchPlaceholder') },
      cls: 'vinyl-import-input',
    });
    this.searchBtn = searchRow.createEl('button', { text: t('import.searchAction'), cls: 'mod-cta' });
    this.statusEl = c.createDiv({ cls: 'vinyl-muted vinyl-import-status' });
    this.resultsEl = c.createDiv({ cls: 'vinyl-import-results' });
    // 展开 / 翻页的入口放在滚动区**外面**：列表再长也不用先滚到底才能点，展开之后也不会被滚走
    this.moreBar = c.createDiv({ cls: 'vinyl-import-more' });
    this.moreBtn = this.moreBar.createEl('button');
    this.moreBtn.addEventListener('click', () => void this.revealOrFetchMore());
    this.setStatus('');
    this.renderMore();

    this.inputEl.addEventListener('input', () => {
      if (this.searchTimer != null) window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => void this.runSearch(), 350);
    });
    this.inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (this.searchTimer != null) window.clearTimeout(this.searchTimer);
        void this.runSearch();
      }
    });
    this.searchBtn.addEventListener('click', () => void this.runSearch());
    window.setTimeout(() => this.inputEl.focus(), 50);
  }

  onClose() {
    this.latestRequestId++;
    if (this.searchTimer != null) window.clearTimeout(this.searchTimer);
    this.searchTimer = null;
    this.contentEl.empty();
  }

  // 状态行写入口：只在这里切 is-error（失败文案走红），调用点不必各自记着加类
  private setStatus(text: string, isError = false): void {
    this.statusEl.setText(text);
    this.statusEl.toggleClass('is-error', isError);
  }

  private async openFile(file: TFile): Promise<void> {
    await this.app.workspace.getLeaf(false).openFile(file);
    this.close();
  }

  /** 清空这一轮的结果（换词 / 输入太短都要清干净，否则旧池子会被当成新词的结果） */
  private resetResults(): void {
    this.pool = [];
    this.shown = 0;
    this.hasMore = false;
    this.importedPaths.clear();
    this.resultsEl.empty();
    this.resultsEl.removeClass('is-loading');
    this.renderMore();
  }

  /** 底部入口的三态：本地还有没画出来的就本地展开（先白嫖），展开完了才问上游要下一页，
   *  两头都没有了就收成一行说明（没有再可要的了，别留个点了没反应的按钮） */
  private renderMore(): void {
    if (!this.pool.length) {
      this.moreBar.addClass('vinyl-hidden');
      return;
    }
    this.moreBar.removeClass('vinyl-hidden');
    const rest = this.pool.length - this.shown;
    if (rest > 0) {
      this.moreBtn.disabled = false;
      this.moreBtn.removeClass('is-end');
      this.moreBtn.setText(tf('import.showMore', { n: rest }));
      return;
    }
    if (this.hasMore) {
      this.moreBtn.disabled = false;
      this.moreBtn.removeClass('is-end');
      this.moreBtn.setText(t('import.loadMore'));
      return;
    }
    this.moreBtn.disabled = true;
    this.moreBtn.addClass('is-end');
    this.moreBtn.setText(tf('import.allShown', { n: this.pool.length }));
  }

  /** 重画列表。展开是在原有条目后面接，所以画完要把滚动位置放回去 —— 不然用户被弹回顶部，
   *  还得自己再滚一遍才能接着看（长列表里这一步很烦） */
  private renderList(): void {
    const keepScroll = this.resultsEl.scrollTop;
    this.resultsEl.empty();
    this.renderCards(this.pool.slice(0, this.shown));
    this.renderMore();
    this.resultsEl.scrollTop = keepScroll;
  }

  private renderCards(items: AlbumSearchCandidate[]): void {
    for (const candidate of items) {
      const card = this.resultsEl.createDiv({ cls: 'vinyl-import-result' });
      if (candidate.coverUrl) {
        const img = card.createEl('img', {
          attr: { src: candidate.coverUrl, alt: '', loading: 'lazy' },
          cls: 'vinyl-import-result-cover',
        });
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => img.addClass('vinyl-hidden'));
      } else {
        card.createDiv({ cls: 'vinyl-import-result-cover is-placeholder', text: '♫' });
      }
      const body = card.createDiv({ cls: 'vinyl-import-result-body' });
      body.createDiv({ cls: 'vinyl-import-result-title', text: candidate.title });
      const meta = [candidate.artists.join(' / '), candidate.releaseDate, candidate.trackCount
        ? tf('import.trackCount', { n: candidate.trackCount })
        : ''].filter(Boolean).join(' · ');
      const metaRow = body.createDiv({ cls: 'vinyl-import-result-meta' });
      metaRow.createSpan({
        cls: `vinyl-badge ${candidate.source === 'qq' ? 'is-qq' : 'is-net'}`,
        text: candidate.source === 'qq' ? t('import.sourceQq') : t('import.sourceNetease'),
      });
      if (meta) metaRow.createSpan({ cls: 'vinyl-muted', text: meta });
      if (candidate.matchedBy === 'track' && candidate.matchedTrack) {
        body.createDiv({
          cls: 'vinyl-muted vinyl-import-result-match',
          text: tf('import.matchedTrack', { name: candidate.matchedTrack }),
        });
      }
      const rowStatus = body.createDiv({ cls: 'vinyl-muted vinyl-import-result-state' });
      const side = card.createDiv({ cls: 'vinyl-import-result-side' });
      const isImported = this.importedPaths.has(candidate.key);
      const button = side.createEl('button', {
        text: isImported ? t('import.openExisting') : t('import.action'),
        cls: isImported ? '' : 'mod-cta',
      });
      button.addEventListener('click', () => void this.importCandidate(candidate, button, rowStatus));
    }
  }

  private async importCandidate(
    candidate: AlbumSearchCandidate,
    button: HTMLButtonElement,
    rowStatus: HTMLElement
  ): Promise<void> {
    const existing = this.importedPaths.get(candidate.key);
    if (existing) {
      // 这一张是刚在本轮导入的：点「打开」才离开搜索页 —— 是用户明确要去看它
      const file = this.app.vault.getAbstractFileByPath(existing);
      if (file instanceof TFile) await this.openFile(file);
      return;
    }
    button.disabled = true;
    rowStatus.setText(t('import.fetchingShort'));
    const ref = candidate.source === 'qq'
      ? { source: 'qq' as const, mid: candidate.sourceAlbumId }
      : { source: 'netease' as const, id: Number(candidate.sourceAlbumId) };
    try {
      const res = await importAlbumRef(this.ctx, ref);
      rowStatus.setText((res.status === 'failed' ? '❌ ' : '✅ ') + res.detail);
      rowStatus.toggleClass('is-error', res.status === 'failed');
      if (res.status === 'failed' || !(res.file instanceof TFile)) {
        button.disabled = false; // 失败拿不到笔记：按钮留在「导入」，让用户能再点
        return;
      }
      // 批量导入：导入完**不跳转、不关窗**，就地把这张卡片改成「打开」，接着点下一张就行。
      // 想立刻看笔记的话，按钮就在原地（那是「打开」，语义不变）。
      this.importedPaths.set(candidate.key, res.file.path);
      button.disabled = false; // 「打开」要能点（浏览器不会给 disabled 按钮派发点击）
      button.setText(t('import.openExisting'));
      button.removeClass('mod-cta');
      if (res.status === 'created') {
        this.importedCount++;
        this.setStatus(tf('import.batchProgress', { n: this.importedCount }));
      }
    } catch (e) {
      console.error('[vinyl] 导入搜索结果失败', e);
      rowStatus.setText(`${t('import.failed')}${(e as Error).message || e}`);
      rowStatus.toggleClass('is-error', true);
      button.disabled = false;
    }
  }

  /** 状态行：上游的告警（限流 / 拒绝）优先说原因，其次报数量；
   *  搜到的全都在库里则单独说一句 —— 否则用户会以为搜索坏了（「怎么一条都没有」） */
  private reportOutcome(result: AlbumSearchResult): void {
    const warned = result.warnings.length > 0;
    const sources = result.warnings
      .map((warning) => (warning.source === 'qq' ? t('import.sourceQq') : t('import.sourceNetease')))
      .join(t('common.listSep'));
    const reasons = result.warnings
      .map((warning) => warning.message)
      .filter(Boolean)
      .join(t('common.listSep'));
    if (!result.items.length) {
      if (result.hiddenImported) {
        this.setStatus(tf('import.searchAllImported', { n: result.hiddenImported }));
      } else if (warned) {
        // 有警告就把原因说出来：上游限流、接口拒绝这些真相不该被笼统的「检查网络」盖掉
        this.setStatus(
          tf('import.searchNoResultsWithReason', { sources, reason: reasons }),
          result.warnings.length === 2
        );
      } else {
        this.setStatus(t('import.searchNoResults'));
      }
      return;
    }
    if (warned) {
      this.setStatus(tf('import.searchPartial', { sources, reason: reasons }));
      return;
    }
    if (result.hiddenImported) {
      this.setStatus(tf('import.searchFoundHidden', { n: result.items.length, m: result.hiddenImported }));
      return;
    }
    this.setStatus(tf('import.searchFound', { n: result.items.length }));
  }

  private async runDirect(value: string): Promise<void> {
    if (!value) {
      this.setStatus(t('import.searchEmpty'));
      return;
    }
    this.latestRequestId++;
    this.resetResults();
    this.searchBtn.disabled = true;
    this.setStatus(t('import.fetching'));
    try {
      const res = await importAlbum(this.ctx, value);
      this.setStatus((res.status === 'failed' ? '❌ ' : '✅ ') + res.detail, res.status === 'failed');
      if (res.file instanceof TFile) await this.openFile(res.file);
    } catch (e) {
      console.error('[vinyl] 导入失败', e);
      this.setStatus(`${t('import.failed')}${(e as Error).message || e}`, true);
    } finally {
      this.searchBtn.disabled = false;
    }
  }

  private async runSearch(): Promise<void> {
    const query = this.inputEl.value.trim();
    if (parseAlbumInput(query)) {
      await this.runDirect(query);
      return;
    }
    if (query.length < 2) {
      // 太短不搜：清掉上一轮的结果与状态即可，不再给「还差一个字符」之类的提示
      this.latestRequestId++;
      this.resetResults();
      this.searchBtn.disabled = false;
      this.setStatus('');
      return;
    }
    const requestId = ++this.latestRequestId;
    this.searchBtn.disabled = true;
    this.resetResults();
    this.resultsEl.addClass('is-loading');
    this.setStatus(t('import.searching'));
    try {
      const result = await discoverAlbums(this.ctx, query);
      if (requestId !== this.latestRequestId) return;
      this.pool = result.items;
      this.shown = Math.min(REVEAL_FIRST, this.pool.length);
      this.hasMore = result.hasMore;
      this.query = query;
      this.renderList();
      this.reportOutcome(result);
    } catch (e) {
      if (requestId !== this.latestRequestId) return;
      console.error('[vinyl] 聚合搜索失败', e);
      this.setStatus(t('import.searchFailed'), true);
    } finally {
      if (requestId === this.latestRequestId) {
        this.resultsEl.removeClass('is-loading');
        this.searchBtn.disabled = false;
      }
    }
  }

  /** 底部按钮：池子里还有没画的就先画出来（本地展开，不花网络，卡片状态原地不动）；
   *  画完了再向上游要下一页 —— 那一页要整池重排，新来的更贴的会浮上来。 */
  private async revealOrFetchMore(): Promise<void> {
    const rest = this.pool.length - this.shown;
    if (rest > 0) {
      this.shown = Math.min(this.pool.length, this.shown + REVEAL_STEP);
      this.renderList();
      return;
    }
    if (!this.hasMore || !this.query) return;
    const requestId = this.latestRequestId;
    this.moreBtn.disabled = true;
    this.moreBtn.setText(t('import.loadingMore'));
    try {
      const result = await loadMoreAlbums(this.ctx, this.query);
      if (requestId !== this.latestRequestId) return; // 这期间用户换了词：这一页已经不归它了
      // 整池换掉（重排过）：翻页带出来的、以及本轮已经导进去的，都不再出现在结果里。
      // 新到的一页全画出来 —— 用户点的就是「更多」，没有理由再把它折起来
      this.pool = result.items;
      this.shown = this.pool.length;
      this.hasMore = result.hasMore;
      this.renderList();
    } catch (e) {
      if (requestId !== this.latestRequestId) return;
      console.error('[vinyl] 加载更多失败', e);
      this.setStatus(t('import.searchFailed'), true);
    } finally {
      if (requestId === this.latestRequestId) this.renderMore();
    }
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
      const root = String(files[0]?.webkitRelativePath || '').split('/')[0] || '';
      takeFiles(files, root);
    });

    // 拖文件 / 文件夹进弹窗任意位置
    c.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      c.addClass('is-drop-active');
    });
    c.addEventListener('dragleave', () => c.removeClass('is-drop-active'));
    const onDrop = async (ev: DragEvent) => {
      ev.preventDefault();
      c.removeClass('is-drop-active');
      const dt = ev.dataTransfer;
      if (!dt) return;
      const picked = await collectDroppedFiles(dt);
      if (picked.length) takeFiles(picked.map((p) => p.file), droppedRootName(picked));
    };
    c.addEventListener('drop', (ev) => {
      void onDrop(ev);
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
