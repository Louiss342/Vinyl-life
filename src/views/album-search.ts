// 在线专辑搜索面板：输入 → 防抖搜索 / 直连链接 → 结果池（本地展开 + 上游翻页）→ 逐条导入状态。
// 从导入弹窗里抽出来（工具栏方案 2026-09-18）：弹窗与专辑墙的「添加」面板共用这一套机制，
// 只换外壳 —— 本模块渲染进宿主给的容器，宿主负责外壳（弹窗壳 / 浮层）与关闭行为。
// 结果里的已入库专辑照常显示、就地标「已在收藏」（同平台同 id；只凭同名命中的另给一句弱提示）。
import { TFile } from 'obsidian';
import {
  ImportContext,
  importAlbum,
  importAlbumRef,
  parseAlbumInput,
} from '../import';
import {
  AlbumSearchCandidate,
  AlbumSearchResult,
  discoverAlbums,
  loadMoreAlbums,
} from '../core/album-discovery';
import { t, tf } from '../core/i18n';

/** 首屏画多少条 / 每次「显示更多」多画多少条。
 *  本地展开不花网络，所以先白嫖池子：等池子真的见底了，才轮到向上游要下一页。 */
const REVEAL_FIRST = 20;
const REVEAL_STEP = 20;

/** 宿主接管的动作：打开一张笔记（直连导入成功 / 点结果上的「打开」）—— 跳不跳、关不关由宿主说了算；
 *  「刚入库」的回执由宿主处理（专辑墙拿它给卡片描边） */
export interface AlbumSearchHost {
  openFile(file: TFile): void | Promise<void>;
  onImported?(file: TFile): void;
}

export class AlbumSearchPane {
  private searchTimer: number | null = null;
  private latestRequestId = 0;
  /** 当前词的结果池（含已在收藏的）：展开与翻页都在这上面长 */
  pool: AlbumSearchCandidate[] = [];
  /** 池子里已经画出来的条数 */
  shown = 0;
  /** 上游还有没有下一页 */
  hasMore = false;
  /** 当前词：翻页时要拿它去要下一页，也是「这批结果属于谁」的凭据 */
  query = '';
  /** 本轮就地导入过的 key → 笔记路径（结果本身不回填，这个状态只属于交互） */
  private importedPaths = new Map<string, string>();
  /** 本轮已经导入了多少张：导入后不跳转，要有个进度给用户看（连续添加就靠它） */
  private importedCount = 0;
  private inputEl!: HTMLInputElement;
  private searchBtn: HTMLButtonElement | null = null;
  private statusEl!: HTMLElement;
  private resultsEl!: HTMLElement;
  private moreBar!: HTMLElement;
  private moreBtn!: HTMLButtonElement;

  constructor(
    private ctx: ImportContext,
    private host: AlbumSearchHost
  ) {}

  /** 建界面：搜索行（输入框 [+ 搜索按钮]）→ 状态行 → 结果区 → 展开 / 翻页入口（在滚动区外，列表再长也点得到） */
  mount(
    container: HTMLElement,
    opts: { withButton: boolean; placeholder?: string } = { withButton: true }
  ): void {
    const searchRow = container.createDiv({ cls: 'vinyl-import-search-row' });
    this.inputEl = searchRow.createEl('input', {
      attr: {
        type: 'search',
        placeholder: opts.placeholder ?? t('import.searchPlaceholder'),
        'aria-label': t('toolbar.search'),
      },
      cls: 'vinyl-import-input',
    });
    if (opts.withButton) {
      this.searchBtn = searchRow.createEl('button', { text: t('import.searchAction'), cls: 'mod-cta' });
      this.searchBtn.addEventListener('click', () => void this.runSearch());
    }
    this.statusEl = container.createDiv({ cls: 'vinyl-muted vinyl-import-status' });
    this.resultsEl = container.createDiv({ cls: 'vinyl-import-results' });
    this.moreBar = container.createDiv({ cls: 'vinyl-import-more' });
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
        this.cancelPending();
        void this.runSearch();
      }
    });
  }

  focus(): void {
    this.inputEl.focus();
  }

  /** 带入关键词并立即搜一轮（专辑墙搜不到东西时那条「在线查找『词』」） */
  prefill(query: string): void {
    this.inputEl.value = query;
    this.cancelPending();
    void this.runSearch();
  }

  /** 面板关掉时收尾：让在途请求作废（结果回来也不许再往 DOM 上画） */
  destroy(): void {
    this.cancelPending();
    this.latestRequestId++;
  }

  private cancelPending(): void {
    if (this.searchTimer != null) window.clearTimeout(this.searchTimer);
    this.searchTimer = null;
  }

  // 状态行写入口：只在这里切 is-error（失败文案走红），调用点不必各自记着加类
  private setStatus(text: string, isError = false): void {
    this.statusEl.setText(text);
    this.statusEl.toggleClass('is-error', isError);
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
      // 库里有一张同名的（另一个平台 / 没记 id）：提示一声，仍可添加 —— 只有同平台同 id 才是「已在收藏」
      if (candidate.nameInLibrary) {
        body.createDiv({ cls: 'vinyl-muted vinyl-import-result-match', text: t('import.sameNameHint') });
      }
      const rowStatus = body.createDiv({ cls: 'vinyl-muted vinyl-import-result-state' });
      const side = card.createDiv({ cls: 'vinyl-import-result-side' });
      const isImported = this.importedPaths.has(candidate.key);
      if (candidate.inLibrary) {
        // 已在收藏：不给可点的「添加」（点了只会多出一张重复笔记），也不报成失败
        const owned = side.createEl('button', { text: t('import.owned') });
        owned.disabled = true;
        continue;
      }
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
      const file = this.ctx.app.vault.getAbstractFileByPath(existing);
      if (file instanceof TFile) await this.host.openFile(file);
      return;
    }
    button.disabled = true;
    button.setText(t('import.adding'));
    rowStatus.setText(t('import.fetchingShort'));
    rowStatus.removeClass('is-error');
    const ref = candidate.source === 'qq'
      ? { source: 'qq' as const, mid: candidate.sourceAlbumId }
      : { source: 'netease' as const, id: Number(candidate.sourceAlbumId) };
    try {
      const res = await importAlbumRef(this.ctx, ref);
      rowStatus.setText((res.status === 'failed' ? '❌ ' : '✅ ') + res.detail);
      rowStatus.toggleClass('is-error', res.status === 'failed');
      if (res.status === 'failed' || !(res.file instanceof TFile)) {
        // 失败原地重试：按钮回到「添加」，状态行说原因
        button.setText(t('import.retry'));
        button.disabled = false;
        return;
      }
      // 连续添加：导入完**不跳转、不关面板**，就地把这张卡片改成「打开」（状态行同时报「已添加」），
      // 接着点下一张就行。想立刻看笔记的话，按钮就在原地（那是「打开」，语义不变）。
      this.importedPaths.set(candidate.key, res.file.path);
      button.disabled = false; // 「打开」要能点（浏览器不会给 disabled 按钮派发点击）
      button.setText(t('import.openExisting'));
      button.removeClass('mod-cta');
      if (res.status === 'created') {
        this.importedCount++;
        this.setStatus(tf('import.batchProgress', { n: this.importedCount }));
        this.host.onImported?.(res.file); // 专辑墙拿它给新卡片描一下边（看不见就算了）
      }
    } catch (e) {
      console.error('[vinyl] 导入搜索结果失败', e);
      rowStatus.setText(`${t('import.failed')}${(e as Error).message || e}`);
      rowStatus.toggleClass('is-error', true);
      button.setText(t('import.retry'));
      button.disabled = false;
    }
  }

  /** 状态行：上游的告警（限流 / 拒绝）优先说原因，其次报数量；有已在收藏的如实带一句 */
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
      if (warned) {
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
    if (result.owned) {
      this.setStatus(tf('import.searchFoundOwned', { n: result.items.length, m: result.owned }));
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
    this.setSearchBusy(true);
    this.setStatus(t('import.fetching'));
    try {
      const res = await importAlbum(this.ctx, value);
      this.setStatus((res.status === 'failed' ? '❌ ' : '✅ ') + res.detail, res.status === 'failed');
      if (res.file instanceof TFile) await this.host.openFile(res.file);
    } catch (e) {
      console.error('[vinyl] 导入失败', e);
      this.setStatus(`${t('import.failed')}${(e as Error).message || e}`, true);
    } finally {
      this.setSearchBusy(false);
    }
  }

  private setSearchBusy(on: boolean): void {
    if (this.searchBtn) this.searchBtn.disabled = on;
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
      this.setSearchBusy(false);
      this.setStatus('');
      return;
    }
    const requestId = ++this.latestRequestId;
    this.setSearchBusy(true);
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
        this.setSearchBusy(false);
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
      // 整池换掉（重排过）：新到的一页全画出来 —— 用户点的就是「更多」，没有理由再把它折起来
      this.pool = result.items;
      this.shown = this.pool.length;
      this.hasMore = result.hasMore;
      this.renderList();
      this.reportOutcome(result);
    } catch (e) {
      if (requestId !== this.latestRequestId) return;
      console.error('[vinyl] 加载更多失败', e);
      this.setStatus(t('import.searchFailed'), true);
    } finally {
      if (requestId === this.latestRequestId) this.renderMore();
    }
  }
}
