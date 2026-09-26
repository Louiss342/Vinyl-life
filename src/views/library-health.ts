// 收藏健康检查：静态扫描（失效引用 / 封面 / 音源）+ 可选的在线试播 + 「仅收藏」标记。
//
// 分两档列：**错误**（真的坏了：库外路径失效、指定音源不可用、播放失败）
// 与**提示**（无音源、无封面 —— 很可能是有意只收着的乐评）。标了 collectOnly 的专辑
// 连提示都不出；「标记为仅收藏」按钮把 collectOnly 写进笔记 frontmatter（数据归笔记）。
import { EventRef, Modal, TFile } from 'obsidian';
import type VinylLifePlugin from '../main';
import {
  AlbumInfo,
  detectAlbumSources,
  findAlbumNotes,
  getAlbumInfo,
  invalidateSourceCache,
} from '../core/album-index';
import type { ActiveSource } from '../core/queue';
import {
  LibraryHealthIssue,
  PROBE_SCOPES,
  normalizeProbeScope,
  probeJobs,
  scanLibraryHealth,
} from '../core/library-health';
import { sourceName } from '../core/track';
import { t, tf } from '../core/i18n';
import { markVinylModal, notice, pickedFolderPath, scalarText } from '../util';
import { SetCoverModal } from './set-cover-modal';

/** 两次试播之间留一口气：收藏多时是几十次连续请求，平台限流看的就是这个间隔 */
const PROBE_INTERVAL_MS = 350;

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export class SourceSwitchModal extends Modal {
  constructor(private plugin: VinylLifePlugin, private albumPath: string, private exclude?: ActiveSource) {
    super(plugin.app);
    markVinylModal(this);
    this.titleEl.setText(t('health.switch'));
  }

  onOpen(): void {
    const file = this.plugin.app.vault.getAbstractFileByPath(this.albumPath);
    const album = file instanceof TFile ? getAlbumInfo(this.plugin.app, file) : null;
    if (!album) { this.contentEl.setText(t('health.noteMissing')); return; }
    this.contentEl.createEl('p', { text: album.title });
    const sources = detectAlbumSources(this.plugin.app, album);
    let count = 0;
    for (const source of ['local', 'netease', 'qq', 'kugou'] as ActiveSource[]) {
      if (!sources[source] || source === this.exclude) continue;
      count++;
      const button = this.contentEl.createEl('button', { text: sourceName(source) });
      button.onclick = async () => {
        button.disabled = true;
        if (await this.plugin.switchAlbumSource(album.path, source)) this.close();
        else button.disabled = false;
      };
    }
    if (!count) this.contentEl.createEl('p', { text: t('health.noAlternative') });
  }
}

/** 重新定位库外音频：给一条失效的库外引用挑个新文件夹（或手填绝对路径），
 *  把**笔记里写着的引用**改过去 —— 库外的文件归用户自己管，插件不搬文件。 */
export class RelocateAudioModal extends Modal {
  private value = '';
  private input: HTMLInputElement | null = null;

  constructor(
    private plugin: VinylLifePlugin,
    private issue: LibraryHealthIssue,
    private onDone: () => void
  ) {
    super(plugin.app);
    markVinylModal(this);
    this.titleEl.setText(t('health.relocate'));
  }

  onOpen(): void {
    const c = this.contentEl;
    c.createEl('p', { text: tf('health.relocateFor', { title: this.issue.album.title }) });
    c.createEl('p', { text: this.issue.detail, cls: 'vinyl-muted' });
    const picker = c.createEl('input', {
      cls: 'vinyl-hidden-input',
      attr: { type: 'file', webkitdirectory: '', multiple: '' },
    });
    picker.onchange = () => {
      const picked = picker.files?.[0];
      const dir = picked ? pickedFolderPath(picked) : '';
      if (!dir) return;
      this.value = dir;
      if (this.input) this.input.value = dir;
    };
    const actions = c.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: t('health.relocatePick') }).onclick = () => picker.click();
    actions.createEl('button', { text: t('common.cancel') }).onclick = () => this.close();
    const apply = actions.createEl('button', { text: t('health.relocateApply'), cls: 'mod-cta' });
    const error = c.createEl('p', { cls: 'vinyl-muted' });
    this.input = c.createEl('input', {
      attr: { type: 'text', placeholder: t('health.relocatePlaceholder') },
    });
    this.input.oninput = () => { this.value = this.input?.value ?? ''; };
    apply.onclick = () => void this.apply(error, apply);
  }

  private async apply(error: HTMLElement, button: HTMLButtonElement): Promise<void> {
    const next = this.value.trim();
    if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(next)) {
      error.setText(t('health.relocateNeedAbs'));
      return;
    }
    button.disabled = true;
    const oldRef = this.issue.detail.trim();
    // scalarText 而非 String(v)：旧数据里这一项可能是对象，String() 会得到 "[object Object]"
    // 这种看似有效实则匹配不上的取值（scalarText 对非标量一律给空串，同 import.ts 的口径）
    const norm = (v: unknown) => scalarText(v).trim().replace(/^\[\[|\]\]$/g, '');
    const sep = next.includes('\\') ? '\\' : '/';
    let changed = 0;
    try {
      // 回调参数显式标注（理由同 import.ts）：不标注则 fm 是 any，读写属性都算不安全访问
      await this.plugin.app.fileManager.processFrontMatter(
        this.issue.album.file,
        (fm: Record<string, unknown>) => {
          if (norm(fm.audioFolder) === oldRef) {
            fm.audioFolder = next;
            changed++;
          }
          const audio = fm.audio;
          if (Array.isArray(audio)) {
            fm.audio = audio.map((raw: unknown) => {
              if (norm(raw) !== oldRef) return raw;
              changed++;
              return `${next}${sep}${scalarText(raw).split(/[\\/]/).pop() || ''}`;
            });
          }
        }
      );
      notice(changed ? tf('health.relocated', { n: changed }) : t('health.relocateNoMatch'));
      this.close();
      this.onDone();
    } catch (e) {
      error.setText((e as Error).message);
      button.disabled = false;
    }
  }
}

export class LibraryHealthModal extends Modal {
  private cancelled = false;
  /** 试播进行中：中途重画会把进度行换掉（循环还捏着旧节点），所以只在跑完 / 中止后重画 */
  private probing = false;
  /** 「标记为仅收藏」后等元数据缓存更新的那份监听（Modal 不是 Component，得自己摘） */
  private markRef: EventRef | null = null;

  constructor(private plugin: VinylLifePlugin) {
    super(plugin.app);
    markVinylModal(this);
    this.titleEl.setText(t('health.title'));
  }

  onOpen(): void {
    // 「检查一遍」的语义：音源检测的缓存先作废，这次扫描看到的是此时此刻的结论
    // （库外目录的改动没有事件可听，只有这里与专辑墙的「刷新」能把它捞回来）
    invalidateSourceCache();
    this.render();
  }

  onClose(): void {
    // 关窗即中止试播：循环每轮开头看这个标记
    this.cancelled = true;
    if (this.markRef) {
      this.plugin.app.metadataCache.offref(this.markRef);
      this.markRef = null;
    }
  }

  private render(): void {
    this.contentEl.empty();
    const albums = findAlbumNotes(this.plugin.app)
      .map((file) => getAlbumInfo(this.plugin.app, file, { coverFolder: this.plugin.settings.coverFolder }))
      .filter((album) => album !== null);
    const issues = scanLibraryHealth(this.plugin.app, albums, this.plugin.settings.sourceFailures);
    const errors = issues.filter((issue) => issue.severity === 'error');
    const notes = issues.filter((issue) => issue.severity === 'note');
    const collectOnly = albums.filter((album) => album.collectOnly).length;
    this.contentEl.createEl('p', {
      text: tf('health.summary', {
        albums: albums.length,
        errors: errors.length,
        notes: notes.length,
        collectOnly,
      }),
    });
    this.renderProbeControls(albums);
    // 错误在前：真正坏了的东西不该被「没封面」这种提示淹掉
    this.renderIssues(errors, 'error');
    this.renderIssues(notes, 'note');
  }

  private renderIssues(issues: LibraryHealthIssue[], severity: 'error' | 'note'): void {
    if (!issues.length) return;
    this.contentEl.createEl('h4', {
      text: severity === 'error' ? t('health.errorsHeading') : t('health.notesHeading'),
      cls: 'vinyl-health-heading',
    });
    const list = this.contentEl.createDiv({ cls: 'vinyl-health-list' });
    for (const issue of issues) {
      const row = list.createDiv({ cls: `vinyl-health-row is-${severity}` });
      row.createEl('strong', { text: issue.album.title });
      // 「一个音源都没有」与「指定的音源没了」是两回事：前者的文案不能写成「当前音源不可用」
      const label = issue.kind === 'source' && !issue.detail ? t('health.noSource') : t(`health.${issue.kind}`);
      const detail = `${label}${issue.detail ? `: ${issue.detail}` : ''}`;
      const when = issue.at ? ` · ${tf('health.checkedAt', { time: new Date(issue.at).toLocaleString() })}` : '';
      row.createEl('p', { text: detail + when });
      row.createEl('button', { text: t('menu.openNote') }).onclick = async () => {
        await this.plugin.app.workspace.getLeaf(false).openFile(issue.album.file);
      };
      // 换源只在真有一个「出问题的音源」时才有意义：一个音源都没有的专辑没有别的可换
      if (issue.detail && (issue.kind === 'source' || issue.kind === 'playback')) {
        row.createEl('button', { text: t('health.switch') }).onclick = () =>
          new SourceSwitchModal(this.plugin, issue.album.path).open();
      }
      // 分档之外再往前一步：这份列表要能直接修，而不只是看得见
      if (issue.kind === 'external') {
        // 改完等元数据缓存更新再重画：立刻重画会读到旧引用，列表照旧（以为没生效）
        row.createEl('button', { text: t('health.relocate'), cls: 'mod-cta' }).onclick = () =>
          new RelocateAudioModal(this.plugin, issue, () =>
            this.refreshOnMetadataChange(issue.album.path)
          ).open();
      }
      if (issue.kind === 'cover') {
        row.createEl('button', { text: t('health.setCover'), cls: 'mod-cta' }).onclick = () => {
          new SetCoverModal(this.plugin.app, this.plugin, issue.album).open();
          this.refreshOnMetadataChange(issue.album.path);
        };
      }
      if (issue.kind === 'playback' && issue.source) {
        row.createEl('button', { text: t('health.retry'), cls: 'mod-cta' }).onclick = async (ev) => {
          const button = ev.currentTarget as HTMLButtonElement;
          button.disabled = true;
          await this.retryPlayback(issue.album, issue.source, button);
        };
      }
      // 仅收藏只对「无音源 / 无封面」这类提示有意义：写完这条，下次扫描就不再提它
      if (severity === 'note' && !issue.album.collectOnly) {
        row.createEl('button', { text: t('health.markCollectOnly') }).onclick = async (ev) => {
          const button = ev.currentTarget as HTMLButtonElement;
          button.disabled = true;
          await this.markCollectOnly(issue.album.path);
        };
      }
    }
  }

  /** 「重试并清除」：按那条失败记录的音源策略再试一次。
   *  成功 → 删掉失败记录（列表里也就没有这一条了）；失败 → 刷新时间戳并如实报原因。 */
  private async retryPlayback(
    album: AlbumInfo,
    source: ActiveSource | 'auto',
    button: HTMLButtonElement
  ): Promise<void> {
    button.setText(t('health.retrying'));
    const error = await this.plugin.retryAlbumSource(album, source);
    const key = `${album.path}:${source}`;
    if (error) {
      this.plugin.settings.sourceFailures[key] = { message: error, at: Date.now() };
      notice(tf('health.retryFailed', { msg: error }));
      button.disabled = false;
      button.setText(t('health.retry'));
    } else {
      delete this.plugin.settings.sourceFailures[key];
      notice(t('health.retryOk'));
    }
    await this.plugin.saveSettings();
    if (!this.cancelled) this.render();
  }

  /** 元数据缓存更新后再重画一次（改封面这类外部动作：写完立刻重画会读到旧缓存） */
  private refreshOnMetadataChange(path: string): void {
    if (this.markRef) return; // 已经挂着一条了，等它触发
    this.markRef = this.plugin.app.metadataCache.on('changed', (changed) => {
      if (changed.path !== path) return;
      if (this.markRef) {
        this.plugin.app.metadataCache.offref(this.markRef);
        this.markRef = null;
      }
      if (!this.cancelled) this.render();
    });
  }

  /** 写进笔记 frontmatter（而不是插件数据）：标记跟着笔记走，换设备 / 改名都不丢 */
  private async markCollectOnly(path: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    try {
      // 回调参数显式标注（理由同 import.ts）：不标注则 fm 是 any，写属性算不安全访问
      await this.plugin.app.fileManager.processFrontMatter(
        file,
        (fm: Record<string, unknown>) => {
          fm.collectOnly = true;
        }
      );
      notice(t('health.markedNotice'));
      // 元数据缓存是异步更新的：立刻重画会照旧读到旧属性（用户以为没生效）。
      // 等这条笔记的缓存更新事件再重画；弹窗关掉时 Component 的清理会自动摘掉监听。
      this.markRef = this.plugin.app.metadataCache.on('changed', (changed) => {
        if (changed.path !== path) return;
        if (this.markRef) {
          this.plugin.app.metadataCache.offref(this.markRef);
          this.markRef = null;
        }
        if (!this.cancelled) this.render();
      });
    } catch (e) {
      notice(tf('health.markFailed', { msg: (e as Error).message }));
      if (!this.cancelled) this.render();
    }
  }

  // ============ 在线试播：范围 / 进度 / 中止 / 上次检查时间 ============

  private renderProbeControls(albums: AlbumInfo[]): void {
    const p = this.plugin;
    const actions = this.contentEl.createDiv({ cls: 'vinyl-health-actions' });
    const scope = actions.createEl('select', { cls: 'dropdown' });
    for (const value of PROBE_SCOPES) {
      scope.createEl('option', { text: t(`health.scope.${value}`), attr: { value } });
    }
    scope.value = normalizeProbeScope(p.settings.probeScope);
    scope.disabled = this.probing;
    scope.onchange = async () => {
      p.settings.probeScope = normalizeProbeScope(scope.value);
      await p.saveSettings();
    };
    const probe = actions.createEl('button', { text: t('health.probeOnline') });
    probe.disabled = this.probing;
    const abort = actions.createEl('button', {
      text: t('health.probeAbort'),
      cls: this.probing ? '' : 'is-hidden',
    });
    const progress = this.contentEl.createEl('p', { cls: 'vinyl-muted' });
    const last = p.settings.lastProbeAt;
    progress.setText(last ? tf('health.lastProbe', { time: new Date(last).toLocaleString() }) : t('health.neverProbed'));
    probe.onclick = async () => {
      const jobs = probeJobs(this.plugin.app, albums, p.settings.sourceFailures, p.settings.probeScope);
      if (!jobs.length) { progress.setText(t('health.probeNothing')); return; }
      this.cancelled = false;
      this.probing = true;
      probe.disabled = true;
      scope.disabled = true;
      abort.removeClass('is-hidden');
      let done = 0;
      for (const job of jobs) {
        if (this.cancelled) break;
        done++;
        progress.setText(tf('health.probeProgress', { done, total: jobs.length }));
        try {
          const error = await p.checkOnlineSource(job.album, job.source);
          const key = `${job.album.path}:${job.source}`;
          if (error) p.settings.sourceFailures[key] = { message: error, at: Date.now() };
          else delete p.settings.sourceFailures[key];
        } catch (e) {
          // 试播本身炸了（网关没起来等）：记成失败，别让整轮停在半路
          p.settings.sourceFailures[`${job.album.path}:${job.source}`] = {
            message: (e as Error).message,
            at: Date.now(),
          };
        }
        if (done < jobs.length && !this.cancelled) await wait(PROBE_INTERVAL_MS);
      }
      p.settings.lastProbeAt = Date.now();
      await p.saveSettings();
      this.probing = false;
      if (this.cancelled) {
        // 中止：弹窗还开着的话就地复位（重画会丢掉按钮引用，也会把进度行换掉）
        if (this.contentEl.isConnected) {
          probe.disabled = false;
          scope.disabled = false;
          abort.addClass('is-hidden');
          progress.setText(t('health.probeAborted'));
        }
        return;
      }
      this.render();
    };
    abort.onclick = () => { this.cancelled = true; };
  }
}
