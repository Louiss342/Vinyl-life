// 播放器视图（M3 黑胶转盘版，v0.3.1 唱机质感打磨）：
//   转盘 + 旋转唱片 + 直线唱臂（不播放归位支架 / 播放落针并随进度内移）+ 唱臂支架；
//   胡桃木设备面板（.vinyl-deck）：金属圆钮控制、红色填充进度轨、丝印品牌行；
//   换碟 = 头部圆钮弹 Menu（替代臃肿的 select 选择区）。
// 增量渲染：壳只建一次，状态更新只改目标节点——旋转动画不被打断。
import { ItemView, WorkspaceLeaf, Menu, setIcon, TFile, CachedMetadata } from 'obsidian';
import type VinylLifePlugin from '../main';
import type { PlayerSnapshot } from '../core/player-state';
import { AlbumInfo, findAlbumNotes, getAlbumInfo, hasAlbumTag } from '../core/album-index';
import type { Track } from '../core/track';
import { trackSourceLabel, trackSourceClass, qualityText } from '../core/track';
import { fmtTime } from '../util';
import { SPIN_SPEEDS } from '../core/disc-motion';
import { DECK_STYLES, RECORD_COLORS, deckClass, recordClass } from '../core/appearance';
import { t } from '../core/i18n';

export const PLAYER_VIEW_TYPE = 'vinyl-player';

interface PlayerEls {
  headerTitle: HTMLElement;
  swapBtn: HTMLButtonElement;
  discOuter: HTMLElement;
  vinyl: HTMLElement;
  labelImg: HTMLImageElement;
  labelEmpty: HTMLElement;
  arm: HTMLElement;
  progressSlider: HTMLInputElement;
  timeEl: HTMLElement;
  prevBtn: HTMLButtonElement;
  playBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  volSlider: HTMLInputElement;
  queueTitle: HTMLElement;
  queueBox: HTMLElement;
  qualityEl: HTMLElement;
}

// 实际音质读数文案：队列就绪才显示；在线源带档位，本地源只显示来源
export function qualityReadout(s: PlayerSnapshot): string {
  if (!s.queue.length || !s.sourceLabel) return '';
  const q = qualityText(s.quality);
  return q ? `${s.sourceLabel} · ${q}` : s.sourceLabel;
}

function setVal(el: HTMLInputElement, v: string) {
  if (el.dataset.dragging !== '1') el.value = v;
}

// 进度轨填充（唱片品牌红 / 音量中性银）：经 CSS 变量喂给 ::-webkit-slider-runnable-track
function fillRange(el: HTMLInputElement, ratio: number, color: string) {
  const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  el.style.setProperty(
    '--track-fill',
    `linear-gradient(90deg, ${color} ${pct}%, #1c1c21 ${pct}%)`
  );
}

const FILL_RED = '#ff4757';
const FILL_SILVER = '#c8c8d0';

// 唱臂角度（deg，与 styles.css 的 .vinyl-turntable-arm 几何配套）：
//   停放 = 归位到唱臂支架卡口（唱针离开唱片）；
//   播放 = 唱针落在导入槽（外圈 ≈0.96R），随播放向内圈导出槽（≈0.40R，停在标签外）缓移。
const ARM_PARKED = -100;
const ARM_OUTER = -76;
const ARM_INNER = -46;

export class VinylPlayerView extends ItemView {
  private plugin: VinylLifePlugin;
  private unsub: (() => void) | null = null;
  private albums: AlbumInfo[] = [];
  private els: PlayerEls | null = null;
  private renderedQueue: Track[] | null = null;
  private queueRows: HTMLElement[] = [];
  private currentCoverSrc: string | null = null;
  private lastAlbumPath: string | null = null;
  private lastSpinning = false;
  private lastArmAngle = NaN;
  private playIcon: 'play' | 'pause' | '' = '';
  private lastReadout = '';
  // 条件更新缓存（值不变不写 DOM，减少样式失效与 :has() 重算）
  private lastRatio = -1;
  private lastTimeText = '';
  private lastHeaderText = '';
  private lastVol = -1;
  private onVisibility = () => this.syncVisibility();

  constructor(leaf: WorkspaceLeaf, plugin: VinylLifePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return PLAYER_VIEW_TYPE;
  }

  getDisplayText() {
    return t('player.title');
  }

  getIcon() {
    return 'disc-3';
  }

  // 外观（设置 → 外观）：转盘转速 + 面板配色 + 唱片配色（改设置即时生效，无需重开视图）
  applyAppearance() {
    const c = this.contentEl;
    const speed = SPIN_SPEEDS[this.plugin.settings.turntableSpeed] || SPIN_SPEEDS.normal;
    c.style.setProperty('--vinyl-spin-duration', speed);
    // 两套配色都是纯类切换（互斥 toggle，避免脏值残留）
    for (const [v] of DECK_STYLES) c.toggleClass(deckClass(v), v === this.plugin.settings.playerDeck);
    for (const [v] of RECORD_COLORS) c.toggleClass(recordClass(v), v === this.plugin.settings.recordColor);
  }

  async onOpen() {
    this.applyAppearance();
    this.refreshAlbums();
    // 性能：只响应专辑相关文件的元数据变化（任意笔记编辑不再触发全库扫描）
    this.registerEvent(
      this.plugin.app.metadataCache.on('changed', (file: TFile, _data: string, cache: CachedMetadata) => {
        if (file.extension !== 'md') return;
        const isAlbumNow = !!cache?.frontmatter && hasAlbumTag(cache.frontmatter);
        const inAlbumFolder = file.path.startsWith(this.plugin.settings.albumFolder);
        if (isAlbumNow || inAlbumFolder) this.refreshAlbumsDebounced();
      })
    );
    // 性能：仅在「真的看不见」时暂停转盘旋转（窗口不可见 / 视图未渲染），判据见 syncVisibility
    this.registerEvent(this.app.workspace.on('active-leaf-change', this.onVisibility));
    document.addEventListener('visibilitychange', this.onVisibility);
    this.unsub = this.plugin.engine.subscribe((s) => this.update(s));
  }

  async onClose() {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  // 转盘停转的判据只有两种「真的看不见」：窗口不可见（最小化 / 切到别的应用）、本视图没被渲染
  // （后台标签页、折叠的侧栏、独立窗口已关）。不能按「当前活动叶」判断——播放器常驻侧栏时，
  // 播放期间活动叶仍在专辑墙上，那样唱片会被冻住，转动就与歌曲播放对不上了。
  private syncVisibility() {
    if (!this.els) return;
    const doc = this.containerEl.ownerDocument;
    const el = this.containerEl as HTMLElement;
    // isShown 缺失时按「可见」处理：宁可持续转，也不要静默停转
    const shown = typeof el.isShown === 'function' ? el.isShown() : true;
    this.els.vinyl.classList.toggle('is-hidden', !!doc.hidden || !shown);
  }

  refreshAlbums() {
    this.albums = findAlbumNotes(this.plugin.app)
      .map((f) =>
        getAlbumInfo(this.plugin.app, f, { coverFolder: this.plugin.settings.coverFolder })
      )
      .filter((a): a is AlbumInfo => !!a)
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  }

  private albumsTimer: number | null = null;
  private refreshAlbumsDebounced() {
    if (this.albumsTimer) window.clearTimeout(this.albumsTimer);
    this.albumsTimer = window.setTimeout(() => {
      this.albumsTimer = null;
      this.refreshAlbums();
    }, 500);
  }

  // ============ 壳（只建一次） ============

  private ensureShell(): PlayerEls {
    if (this.els) return this.els;
    const c = this.contentEl;
    c.empty();
    c.addClass('vinyl-player');

    // 头部：标题 + 换碟圆钮
    const header = c.createDiv({ cls: 'vinyl-player-header' });
    const headerTitle = header.createDiv({ cls: 'vinyl-player-header-title', text: t('player.title') });
    const swapBtn = header.createEl('button', { cls: 'vinyl-btn vinyl-btn-small' });
    setIcon(swapBtn, 'disc-3');
    swapBtn.setAttribute('aria-label', t('player.pickAlbum'));
    swapBtn.addEventListener('click', (ev) => this.showAlbumMenu(ev));

    // 设备面板（胡桃木底座，样式见 .vinyl-deck）
    const deck = c.createDiv({ cls: 'vinyl-deck' });

    // 转盘：外层 discOuter 承接入场动画，内层 vinyl 承载 CSS 旋转（分离互不冲突）
    const turntable = deck.createDiv({ cls: 'vinyl-turntable' });
    turntable.createDiv({ cls: 'vinyl-turntable-platter' });
    const discOuter = turntable.createDiv({ cls: 'vinyl-turntable-disc' });
    const vinyl = discOuter.createDiv({ cls: 'vinyl-turntable-vinyl is-empty' });
    const label = vinyl.createDiv({ cls: 'vinyl-turntable-label' });
    const labelImg = label.createEl('img', { attr: { alt: '' } });
    labelImg.style.display = 'none';
    const labelEmpty = label.createDiv({ cls: 'vinyl-turntable-label-empty', text: '♪' });
    // 唱臂：配重 + 枢轴 + 唱头（直线臂）+ 唱臂支架（不播放时唱头落在这个卡口上）
    const arm = turntable.createDiv({ cls: 'vinyl-turntable-arm' });
    arm.createDiv({ cls: 'vinyl-arm-counterweight' });
    arm.createDiv({ cls: 'vinyl-arm-pivot' });
    arm.createDiv({ cls: 'vinyl-arm-head' });
    turntable.createDiv({ cls: 'vinyl-arm-rest' });
    turntable.createDiv({ cls: 'vinyl-turntable-spindle' });

    // 进度轨（红色填充）
    const progress = deck.createDiv({ cls: 'vinyl-progress' });
    const progressSlider = progress.createEl('input', {
      attr: { type: 'range', min: '0', max: '1000' },
      cls: 'vinyl-slider',
    });
    progressSlider.addEventListener('pointerdown', () => (progressSlider.dataset.dragging = '1'));
    progressSlider.addEventListener('pointerup', () => delete progressSlider.dataset.dragging);
    progressSlider.addEventListener('input', () =>
      this.plugin.engine.seek(Number(progressSlider.value) / 1000)
    );
    const timeEl = progress.createSpan({ text: '–:– / –:–', cls: 'vinyl-readout' });

    // 控制圆钮组
    const controls = deck.createDiv({ cls: 'vinyl-controls' });
    const prevBtn = controls.createEl('button', { cls: 'vinyl-btn' });
    const playBtn = controls.createEl('button', { cls: 'vinyl-btn vinyl-btn-primary' });
    const nextBtn = controls.createEl('button', { cls: 'vinyl-btn' });
    setIcon(prevBtn, 'skip-back');
    setIcon(playBtn, 'play');
    setIcon(nextBtn, 'skip-forward');
    prevBtn.setAttribute('aria-label', t('player.prev'));
    playBtn.setAttribute('aria-label', t('player.playPause'));
    nextBtn.setAttribute('aria-label', t('player.next'));
    prevBtn.addEventListener('click', () => this.plugin.engine.prev());
    playBtn.addEventListener('click', () => this.plugin.engine.toggle());
    nextBtn.addEventListener('click', () => this.plugin.engine.next());

    // 音量行：旋钮图标 + 银色填充轨
    const volRow = deck.createDiv({ cls: 'vinyl-vol-row' });
    const volIcon = volRow.createSpan({ cls: 'vinyl-vol-icon' });
    setIcon(volIcon, 'volume-2');
    const volSlider = volRow.createEl('input', {
      attr: { type: 'range', min: '0', max: '100' },
      cls: 'vinyl-slider vinyl-vol',
    });
    volSlider.addEventListener('pointerdown', () => (volSlider.dataset.dragging = '1'));
    volSlider.addEventListener('pointerup', () => delete volSlider.dataset.dragging);
    volSlider.addEventListener('input', () =>
      this.plugin.engine.setVolume(Number(volSlider.value) / 100)
    );

    // 丝印品牌行 + 实际音质读数（源 · 档位，如「网易云 · 较高」；本地音轨只显示来源）
    const brandRow = deck.createDiv({ cls: 'vinyl-deck-brand-row' });
    brandRow.createDiv({ cls: 'vinyl-deck-brand', text: 'Vinyl Life' });
    const qualityEl = brandRow.createDiv({ cls: 'vinyl-quality' });

    // Vinyl order 行：标题 + ✎ 追加感想（P1 感想联动）
    const orderRow = c.createDiv({ cls: 'vinyl-order-row' });
    const queueTitle = orderRow.createDiv({ cls: 'vinyl-queue-title' });
    const noteBtn = orderRow.createEl('button', { cls: 'vinyl-btn vinyl-btn-small' });
    setIcon(noteBtn, 'pencil');
    noteBtn.setAttribute('aria-label', t('player.appendNote'));
    noteBtn.setAttribute('title', t('player.appendNote'));
    noteBtn.addEventListener('click', () => this.plugin.appendListeningNote());

    const queueBox = c.createDiv({ cls: 'vinyl-queue' });
    // 队列点击委托（重建不丢监听）
    queueBox.addEventListener('click', (ev) => {
      const row = (ev.target as HTMLElement).closest('.vinyl-queue-item') as HTMLElement | null;
      if (row && row.dataset.idx != null) {
        this.plugin.engine.playIndex(Number(row.dataset.idx));
      }
    });

    this.els = {
      headerTitle,
      swapBtn,
      discOuter,
      vinyl,
      labelImg,
      labelEmpty,
      arm,
      progressSlider,
      timeEl,
      prevBtn,
      playBtn,
      nextBtn,
      volSlider,
      queueTitle,
      queueBox,
      qualityEl,
    };
    return this.els;
  }

  // 换碟：弹专辑菜单（当前专辑打勾）
  private showAlbumMenu(ev: MouseEvent) {
    const snap = this.plugin.engine.snapshot();
    const menu = new Menu();
    for (const a of this.albums) {
      menu.addItem((it) =>
        it
          .setTitle(`${a.title}${a.artist ? ' — ' + a.artist : ''}`)
          .setChecked(snap.albumNotePath === a.path)
          .onClick(() => {
            this.plugin.engine.loadAlbum(a);
          })
      );
    }
    if (!this.albums.length) {
      menu.addItem((it) => it.setTitle(t('player.noAlbumNotes')).setDisabled(true));
    }
    menu.showAtMouseEvent(ev);
  }

  // ============ 增量更新 ============

  private update(s: PlayerSnapshot) {
    const els = this.ensureShell();

    // 专辑切换 → 落盘入场（C 阶段）/ 清空回位
    const albumPath = s.albumNotePath || null;
    if (albumPath && albumPath !== this.lastAlbumPath) {
      this.lastAlbumPath = albumPath;
      this.playEntrance(els);
    } else if (!albumPath && this.lastAlbumPath) {
      this.lastAlbumPath = null;
      this.resetTurntable(els);
    }

    // 队列（引用变化才重建；当前高亮走 class 切换）
    if (s.queue !== this.renderedQueue) this.rebuildQueue(els, s);
    this.queueRows.forEach((row, i) => row.classList.toggle('is-current', i === s.index));

    // 头部（错误并入标题行；值不变不写 DOM）
    const headerText =
      s.status === 'error' && s.error
        ? `⚠ ${s.error}`
        : s.status === 'loading'
          ? t('player.loading')
          : s.albumTitle
            ? `♪ ${s.albumTitle}`
            : t('player.title');
    if (headerText !== this.lastHeaderText) {
      this.lastHeaderText = headerText;
      els.headerTitle.textContent = headerText;
      els.headerTitle.setAttribute('title', s.albumTitle || t('player.title'));
      els.headerTitle.toggleClass('is-error', s.status === 'error' && !!s.error);
    }

    // 实际音质读数（值不变不写 DOM；极高 / 无损给品牌红点缀）
    const readout = qualityReadout(s);
    if (readout !== this.lastReadout) {
      this.lastReadout = readout;
      els.qualityEl.textContent = readout;
      els.qualityEl.toggleClass('is-hq', s.quality === 'lossless' || s.quality === 'exhigh');
    }

    // 转盘状态（旋转动画只切 class，不重建节点）
    const spinning = s.status === 'playing';
    els.vinyl.classList.toggle('is-spinning', spinning);
    // 刚转入播放：重算一次可见性，清掉可能残留的 is-hidden（否则动画停在 paused，转不动）
    if (spinning && !this.lastSpinning) this.syncVisibility();
    this.lastSpinning = spinning;
    els.vinyl.classList.toggle('is-paused', s.status === 'paused');
    els.vinyl.classList.toggle('is-empty', !s.queue.length);

    // 唱片中心封面（变化才换 src）
    const coverSrc = s.current?.cover || '';
    if (coverSrc !== this.currentCoverSrc) {
      this.currentCoverSrc = coverSrc;
      if (coverSrc) {
        els.labelImg.src = coverSrc;
        els.labelImg.style.display = 'block';
        els.labelEmpty.style.display = 'none';
      } else {
        els.labelImg.style.display = 'none';
        els.labelEmpty.style.display = 'flex';
      }
    }

    // 进度 / 计数器（值不变不写 DOM）
    const dur = Math.max(s.duration, s.currentTime);
    const ratioRaw = dur > 0 ? Math.min(1, s.currentTime / dur) : 0;
    const ratio = Math.round(ratioRaw * 1000);
    if (ratio !== this.lastRatio) {
      this.lastRatio = ratio;
      setVal(els.progressSlider, String(ratio));
      fillRange(els.progressSlider, ratioRaw, FILL_RED);
    }
    const timeText = `${fmtTime(s.currentTime)} / ${fmtTime(s.duration)}`;
    if (timeText !== this.lastTimeText) {
      this.lastTimeText = timeText;
      els.timeEl.textContent = timeText;
    }

    // 唱臂姿态（真实唱机关系，见 ARM_* 常量）：不播放归位支架；播放落针并沿侧 A 单调内移。
    // 取「曲序 + 本曲进度」而非单曲进度：整面唱片上唱针只进不退，换曲不跳回外圈。
    // loading 也保持落针，避免换曲瞬间唱臂来回摆。
    const onRecord = (s.status === 'playing' || s.status === 'loading') && s.queue.length > 0;
    let armAngle = ARM_PARKED;
    if (onRecord) {
      const trackRatio = dur > 0 ? Math.min(1, Math.max(0, s.currentTime / dur)) : 0;
      const sideRatio = Math.min(1, (s.index + trackRatio) / Math.max(1, s.queue.length));
      armAngle = ARM_OUTER + sideRatio * (ARM_INNER - ARM_OUTER);
    }
    if (Math.abs(armAngle - this.lastArmAngle) > 0.05) {
      this.lastArmAngle = armAngle;
      els.arm.style.setProperty('--vinyl-arm-angle', `${armAngle.toFixed(2)}deg`);
    }

    // 播放圆钮图标（状态变化才换）
    const wantIcon: 'play' | 'pause' = s.status === 'playing' ? 'pause' : 'play';
    if (wantIcon !== this.playIcon) {
      this.playIcon = wantIcon;
      setIcon(els.playBtn, wantIcon);
    }

    // 音量（银色填充；值不变不写）
    const vol = Math.round(s.volume * 100);
    if (vol !== this.lastVol) {
      this.lastVol = vol;
      setVal(els.volSlider, String(vol));
      fillRange(els.volSlider, s.volume, FILL_SILVER);
    }
  }

  private rebuildQueue(els: PlayerEls, s: PlayerSnapshot) {
    els.queueTitle.textContent = 'Vinyl order';
    els.queueBox.empty();
    this.queueRows = [];
    if (!s.queue.length) {
      els.queueBox.createDiv({ text: t('player.emptyQueue'), cls: 'vinyl-muted' });
    } else {
      s.queue.forEach((t, i) => {
        const row = els.queueBox.createDiv({ cls: 'vinyl-queue-item' });
        row.dataset.idx = String(i);
        row.createSpan({ text: String(i + 1).padStart(2, '0'), cls: 'vinyl-idx' });
        row.createSpan({ text: t.title, cls: 'vinyl-q-title' });
        row.createSpan({
          text: trackSourceLabel(t),
          cls: 'vinyl-badge ' + trackSourceClass(t),
        });
        row.createSpan({
          text: t.duration ? fmtTime(t.duration) : '–:–',
          cls: 'vinyl-muted',
        });
        this.queueRows.push(row);
      });
    }
    this.renderedQueue = s.queue;
  }

  // 落盘入场（交接 C 阶段）：唱片滑入转盘
  private playEntrance(els: PlayerEls) {
    els.discOuter.getAnimations().forEach((a) => a.cancel());
    els.discOuter.animate(
      [
        { transform: 'scale(0.3) rotate(-30deg)', opacity: '0' },
        { transform: 'scale(1.02) rotate(0deg)', opacity: '1', offset: 0.72 },
        { transform: 'scale(1) rotate(0deg)', opacity: '1' },
      ],
      { duration: 360, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    );
  }

  private resetTurntable(els: PlayerEls) {
    els.vinyl.classList.remove('is-spinning', 'is-paused');
    els.vinyl.classList.add('is-empty');
    // 唱臂归位到支架（显式写死：CSS 变量可能停在播放中的角度上）
    els.arm.style.setProperty('--vinyl-arm-angle', `${ARM_PARKED}deg`);
    this.lastArmAngle = ARM_PARKED;
  }
}
