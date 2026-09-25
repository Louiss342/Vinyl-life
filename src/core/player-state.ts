// 播放引擎：统一面向 Track 解析可播放地址、推进队列、状态快照事件。
// 交接动效与黑胶转盘视觉接在此状态之上（IDLE → HANDOFF → PLAYING）。
import { App } from 'obsidian';
import { Track, trackKey, trackSourceLabel, reorderTracks } from './track';
import { AlbumInfo } from './album-index';
import { LocalSource } from './local-source';
import { NeteaseService } from './netease';
import { QqService } from './qq';
import { KugouService } from './kugou';
import { buildAlbumQueue, BuildQueueResult, ActiveSource, SourcePolicy, sourceLabel } from './queue';
import {
  SCRATCH_LIVE_ALIGN_TOL,
  SCRATCH_LIVE_PAUSE_RATE,
  SCRATCH_LIVE_RESUME_RATE,
  SCRATCH_MAX_RATE,
} from './scratch';
import type { VinylSettings } from '../settings';
import { notice } from '../util';
import { t, tf } from './i18n';

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

/** 播放模式：单次（播完停）/ 循环（播完回到开头）/ 随机（打乱后一直放）。
 *  作用对象是当前队列：单专辑时就是这张专辑的曲目，队列模式下是整条列表的曲目。 */
export type PlayMode = 'once' | 'loop' | 'shuffle';

/** 队列里的一段 = 同一张专辑连续的一段曲目。专辑队列模式下可以有多个段（同一张专辑也可以出现多次）。 */
export interface QueueSegment {
  /** 专辑笔记路径（分组键；曲目没带路径时回落到当前专辑） */
  albumPath: string;
  albumTitle: string;
  /** 在整条队列里的起始下标与长度 */
  start: number;
  count: number;
  /** 当前播放的曲目是否落在这一段里 */
  current: boolean;
}

export interface PlayerSnapshot {
  status: PlayerStatus;
  queue: Track[];
  index: number;
  current?: Track;
  currentTime: number;
  duration: number;
  volume: number;
  albumNotePath?: string;
  albumTitle?: string;
  /** 队列按专辑分段（视图按段渲染分组与整段操作） */
  segments: QueueSegment[];
  /** 当前播放模式（顶部模式按钮按它显示图标与提示） */
  playMode: PlayMode;
  /** 当前队列来源（本地 / 网易云） */
  sourceLabel?: string;
  /** 当前曲目实际拿到的音质档（standard/higher/exhigh/lossless；本地音轨为空） */
  quality?: string;
  error?: string;
}

export interface EngineDeps {
  /** 洗牌源（缺省 Math.random）：测试注入固定序列用 */
  random?: () => number;
  /** 初始播放模式（缺省 once）：由设置的持久值决定 */
  playMode?: () => PlayMode;
  app: App;
  local: LocalSource;
  /** 统一网易云入口（网页会话优先，网关兜底，内部处理就绪） */
  netease: NeteaseService;
  /** QQ 音乐入口（网关单通道；取链 ladder 在网关侧） */
  qq: QqService;
  /** 酷狗音乐入口（网关单通道；设备指纹与取链 ladder 都在网关侧） */
  kugou: KugouService;
  settings: () => VinylSettings;
  /** 曲目成功开播钩子（播放统计用；重试路径不触发） */
  onTrackPlay?: (track: Track, albumNotePath?: string, albumTitle?: string) => void;
  onAlbumLoadFailed?: (album: AlbumInfo, policy: SourcePolicy, reason: string) => void;
}

export class PlaybackEngine {
  private audio = new Audio();
  private queue: Track[] = [];
  private index = -1;
  private status: PlayerStatus = 'idle';
  private errorMsg = '';
  private albumNotePath?: string;
  private albumTitle = '';
  // 存来源枚举而非显示文案：文案语言可随时切换，必须等 snapshot() 时再求值（否则会停在建队列那一刻的语言）
  private sourceKind: ActiveSource | null = null;
  private playMode: PlayMode = 'once';
  /** 专辑路径 → 标题：追加多张专辑后，界面要按段显示各自的名字（曲目上只有路径） */
  private albumTitles = new Map<string, string>();
  private quality = '';
  private listeners = new Set<(s: PlayerSnapshot) => void>();
  // 在线源 URL 缓存：按 trackKey 区分来源（netease id 为数字、qq id 为 mid 字符串，
  // 无法共用裸 id 键，否则跨源会命中错误缓存）。
  private urlCache = new Map<string, string>();
  // 实际拿到的音质档（与 urlCache 同生命周期；降档后即为低档位）
  private levelCache = new Map<string, string>();
  private vaultBlobRetried = new Set<string>();
  private urlRefetched = new Set<string>();
  private lastTimeEmit = 0;
  // 加载代次：快速连点两张专辑时，先发起的在线队列构建可能后返回，须丢弃以免覆盖新选择
  private loadSeq = 0;
  /** 搓碟会话（null = 没在搓）：搓碟期间元素暂停、位置由视图逐帧喂进来（见 beginScratch）。
   *  状态字段在搓碟期间不跟着元素的 play / pause 事件抖（见构造函数里的两个监听）。
   *  pitchFollow = 本会话把元素的「保音高」关掉了（松手要还回去，见 setPitchFollow）。 */
  private scratch: {
    live: boolean;
    resumePlaying: boolean;
    time: number;
    pitchFollow: boolean;
  } | null = null;

  constructor(private deps: EngineDeps) {
    this.playMode = deps.playMode?.() || 'once';
    this.audio.preload = 'auto';
    this.audio.volume = 0.8;
    this.audio.addEventListener('loadedmetadata', () => this.emit());
    this.audio.addEventListener('timeupdate', () => this.emitThrottled());
    this.audio.addEventListener('ended', () => this.onEnded());
    // 搓碟期间元素的 play / pause 是「手在盘上」的中间态（轻量音效会随倍速反复起停），
    // 一律不写状态：对外报的是起手前的姿态（见 snapshot）。
    this.audio.addEventListener('play', () => {
      if (this.scratch) return;
      if (this.status !== 'playing') {
        this.status = 'playing';
        this.emit();
      }
    });
    this.audio.addEventListener('pause', () => {
      if (this.scratch) return;
      if (this.status === 'playing') {
        this.status = 'paused';
        this.emit();
      }
    });
    this.audio.addEventListener('error', () => {
      void this.onAudioError();
    });
  }

  // —— 订阅 ——
  subscribe(fn: (s: PlayerSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  snapshot(): PlayerSnapshot {
    return {
      // 搓碟期间对外报「起手前的姿态」：手在盘上不该让播放键熄灭、系统面板翻成暂停
      status: this.scratch ? (this.scratch.resumePlaying ? 'playing' : 'paused') : this.status,
      queue: this.queue,
      index: this.index,
      current: this.index >= 0 ? this.queue[this.index] : undefined,
      currentTime: this.scratch ? this.scratch.time : this.audio.currentTime || 0,
      duration: this.audioDuration(),
      volume: this.audio.volume,
      // 专辑信息按「当前曲目」推：多专辑队列里播放会跨段，用最后一次 loadAlbum 的那张会串
      albumNotePath: this.albumOfCurrent().path,
      albumTitle: this.albumOfCurrent().title,
      // 来源标签也按当前曲目算（跨段后自动跟着变）
      sourceLabel: this.queue[this.index]
        ? trackSourceLabel(this.queue[this.index])
        : this.sourceKind
          ? sourceLabel(this.sourceKind)
          : '',
      segments: this.segments(),
      playMode: this.playMode,
      quality: this.quality || undefined,
      error: this.errorMsg || undefined,
    };
  }

  /** 当前曲目所属的专辑（路径 + 标题）。曲目没带路径时回落到「最后加载的那张」。 */
  private albumOfCurrent(): { path?: string; title?: string } {
    const track = this.index >= 0 ? this.queue[this.index] : undefined;
    const path = track?.albumNotePath || this.albumNotePath;
    const title = (path ? this.albumTitles.get(path) : undefined) || this.albumTitle;
    return { path, title };
  }

  /** 队列按专辑分段：连续且 albumNotePath 相同的曲目算一段（同一张专辑可以出现多次）。
   *  段是界面分组与「移除整张专辑 / 跨段排序」的操作单位。 */
  segments(): QueueSegment[] {
    const out: QueueSegment[] = [];
    for (let i = 0; i < this.queue.length; i++) {
      const path = this.queue[i].albumNotePath || this.albumNotePath || '';
      const last = out[out.length - 1];
      if (last && last.albumPath === path) {
        last.count++;
      } else {
        out.push({
          albumPath: path,
          albumTitle: this.albumTitles.get(path) || this.albumTitle || '',
          start: i,
          count: 1,
          current: false,
        });
      }
    }
    for (const seg of out) seg.current = this.index >= seg.start && this.index < seg.start + seg.count;
    return out;
  }

  private emit() {
    const s = this.snapshot();
    for (const l of [...this.listeners]) l(s);
  }

  // 进度事件节流（非播放态不产生任何渲染开销）
  private emitThrottled() {
    const now = Date.now();
    if (now - this.lastTimeEmit < 400) return;
    this.lastTimeEmit = now;
    this.emit();
  }

  // —— 队列 ——
  /** opts.autoplay 缺省时看设置（「加载队列后立即播放」）；恢复上次会话传 false
   *  —— 重启 Obsidian 时突然出声是惊吓，不是功能。 */
  async loadAlbum(album: AlbumInfo, opts?: { autoplay?: boolean; source?: SourcePolicy }): Promise<BuildQueueResult> {
    const seq = ++this.loadSeq;
    const res = await buildAlbumQueue(opts?.source ? { ...album, sourcePref: opts.source } : album, {
      local: this.deps.local,
      netease: this.deps.netease,
      qq: this.deps.qq,
      kugou: this.deps.kugou,
      defaultSource: this.deps.settings().defaultSource,
    });
    // 期间用户又点了别的专辑（交接动效 / 播放器换碟菜单两个入口）→ 丢弃本次结果
    if (seq !== this.loadSeq) return res;
    if (!res.tracks.length) {
      this.errorMsg = res.reason || '';
      this.status = 'idle';
      this.emit();
      this.deps.onAlbumLoadFailed?.(album, res.policy, res.reason || t('player.noPlayableTrack'));
      notice(res.reason || t('player.noPlayableTrack'));
      return res;
    }
    const source: ActiveSource = res.resolvedSource === 'none' ? 'local' : res.resolvedSource;
    this.setQueue(res.tracks, album.path, album.title, source);
    const autoplay = opts?.autoplay ?? this.deps.settings().autoPlay;
    if (autoplay) await this.playIndex(0);
    return res;
  }

  setQueue(
    tracks: Track[],
    albumNotePath: string,
    albumTitle: string,
    source: ActiveSource
  ) {
    // 换专辑：先停旧曲（否则关闭「自动播放」时旧曲会一直响，而界面已是新专辑）
    this.unloadAudio();
    this.errorMsg = '';
    // 切换专辑：回收上一张的 Blob，保留本队列需要的
    this.deps.local.clearBlobs(this.deps.local.keysOf(tracks));
    // 队列一律按构建出来的自然顺序（发行顺序）：用户拖拽只改本次会话的排列，
    // 不落盘、也不在下次播这张专辑时复现（设计稿要求「不记忆拖拽导致的顺序变化」）
    this.queue = tracks;
    this.index = -1;
    this.albumNotePath = albumNotePath;
    this.albumTitle = albumTitle;
    for (const track of tracks) {
      if (track.albumNotePath && track.album) this.albumTitles.set(track.albumNotePath, track.album);
    }
    if (albumNotePath) this.albumTitles.set(albumNotePath, albumTitle);
    this.sourceKind = source;
    this.quality = '';
    this.urlCache.clear();
    this.levelCache.clear();
    this.vaultBlobRetried.clear();
    this.urlRefetched.clear();
    this.emit();
  }

  /** 专辑队列模式：构建这张专辑的队列并追加到队尾（界面只调这一句）。
   *  与 loadAlbum 共用代次：快速连点两张专辑时，先发起的构建后返回会被丢弃。 */
  async enqueueAlbum(album: AlbumInfo): Promise<BuildQueueResult> {
    const seq = ++this.loadSeq;
    const res = await buildAlbumQueue(album, {
      local: this.deps.local,
      netease: this.deps.netease,
      qq: this.deps.qq,
      kugou: this.deps.kugou,
      defaultSource: this.deps.settings().defaultSource,
    });
    if (seq !== this.loadSeq) return res;
    if (!res.tracks.length) {
      notice(res.reason || t('player.noPlayableTrack'));
      return res;
    }
    const source: ActiveSource = res.resolvedSource === 'none' ? 'local' : res.resolvedSource;
    await this.appendAlbum(res.tracks, album.path, album.title, source);
    return res;
  }

  /** 专辑队列模式：把一张专辑的队列追加到队尾（不动当前播放，允许同一张专辑重复排入）。
   *  队列原本是空的 → 按普通换碟处理（否则用户点了专辑却什么都不发生，比排队更奇怪）。 */
  async appendAlbum(
    tracks: Track[],
    albumPath: string,
    albumTitle: string,
    source: ActiveSource
  ): Promise<void> {
    if (!tracks.length) return;
    // 只看队列是否为空：队列在但不处于播放态（index=-1，例如暂停着）时，仍然应当追加
    if (!this.queue.length) {
      this.setQueue(tracks, albumPath, albumTitle, source);
      if (this.deps.settings().autoPlay) await this.playIndex(0);
      return;
    }
    if (albumPath) this.albumTitles.set(albumPath, albumTitle);
    this.queue = [...this.queue, ...tracks];
    this.emit();
  }

  /** 离开专辑队列模式：丢弃其他专辑，保留当前曲所属专辑的全部曲目。 */
  retainCurrentAlbum() {
    if (!this.queue.length) return;
    const current = this.index >= 0 ? this.queue[this.index] : undefined;
    const albumPath = current?.albumNotePath || this.albumNotePath;
    if (!albumPath) return;
    const kept = this.queue.filter((track) => (track.albumNotePath || this.albumNotePath) === albumPath);
    if (!kept.length || kept.length === this.queue.length) return;
    const removed = this.queue.filter((track) => (track.albumNotePath || this.albumNotePath) !== albumPath);
    this.deps.local.clearBlobs(this.deps.local.keysOf(removed));
    this.queue = kept;
    this.index = current ? kept.indexOf(current) : -1;
    this.albumNotePath = albumPath;
    this.albumTitle = this.albumTitles.get(albumPath) || this.albumTitle;
    this.emit();
  }

  /** 移除队列里的一段（整张专辑）。正在播的曲目落在这一段里时，顺延到同位置剩下的那一首
   *  （删的是队尾段就往前退一首）；队列空了就复位成「没在播」。 */
  removeRange(start: number, count: number) {
    if (start < 0 || count <= 0 || start >= this.queue.length) return;
    const end = Math.min(this.queue.length, start + count);
    const removed = this.queue.slice(start, end);
    const wasCurrent = this.index >= start && this.index < end;
    const currentKey = this.index >= 0 ? trackKey(this.queue[this.index]) : '';
    this.deps.local.clearBlobs(this.deps.local.keysOf(removed));
    const nextQueue = [...this.queue.slice(0, start), ...this.queue.slice(end)];
    this.queue = nextQueue;
    if (!nextQueue.length) {
      this.unloadAudio();
      this.index = -1;
      this.status = 'idle';
      this.albumNotePath = undefined;
      this.albumTitle = '';
      this.errorMsg = '';
    } else if (wasCurrent) {
      // 顺延：原来的位置现在接着后面的段；删的是尾段就退到最后一首
      this.unloadAudio();
      this.index = Math.min(start, nextQueue.length - 1);
      this.status = 'paused';
      void this.playIndex(this.index, { retry: true });
    } else {
      const i = nextQueue.findIndex((tr) => trackKey(tr) === currentKey);
      if (i >= 0) this.index = i;
    }
    this.emit();
  }

  /** 整体移动一段（跨专辑拖拽排序）：把 [start, start+count) 移到下标 to 处。 */
  moveRange(start: number, count: number, to: number) {
    if (start < 0 || count <= 0 || start + count > this.queue.length) return;
    const clamped = Math.max(0, Math.min(this.queue.length - count, to));
    if (clamped === start) return;
    const currentKey = this.index >= 0 ? trackKey(this.queue[this.index]) : '';
    const block = this.queue.slice(start, start + count);
    const rest = [...this.queue.slice(0, start), ...this.queue.slice(start + count)];
    this.queue = [...rest.slice(0, clamped), ...block, ...rest.slice(clamped)];
    if (currentKey) {
      const i = this.queue.findIndex((tr) => trackKey(tr) === currentKey);
      if (i >= 0) this.index = i;
    }
    this.emit();
  }

  /** 拖拽重排队列：把 from 处的曲目移到 to 位（to = 结果下标）。
   *  正在播放的那首歌必须继续是「当前」——先记住它（对象引用 + trackKey 双保险），
   *  重排后按新位置重置 index，否则 UI 高亮 / next() 的推进基准会跟着下标漂到别的曲子上。 */
  /** 曲目在队列里的所属段（供拖拽约束与界面分组用） */
  private segmentOf(index: number): QueueSegment | undefined {
    return this.segments().find((x) => index >= x.start && index < x.start + x.count);
  }

  moveTrack(from: number, to: number) {
    if (from === to) return;
    if (from < 0 || to < 0 || from >= this.queue.length || to >= this.queue.length) return;
    // 双保险：对象引用（同队列内唯一）+ trackKey（同一首歌换了实例也能追上）
    const current = this.index >= 0 ? this.queue[this.index] : undefined;
    const currentKey = current ? trackKey(current) : '';
    this.queue = reorderTracks(this.queue, from, to);
    if (current) {
      let i = this.queue.indexOf(current);
      if (i < 0 && currentKey) i = this.queue.findIndex((tr) => trackKey(tr) === currentKey);
      if (i >= 0) this.index = i;
    }
    // 音频不动（同一首歌继续播），只广播新队列 → 视图重建行并重贴 is-current。
    // 拖动只改「这一次会话」的排列：不落盘、也不在下次播这张专辑时复现（设计稿要求）
    this.emit();
  }

  // 卸载当前音源（换专辑 / 复位共用；removeAttribute + load 是 Chromium 释放媒体的标准姿势）
  private unloadAudio() {
    this.abortScratch(); // 换碟 / 移除整段时手还按在盘上的话：这次搓碟作废（视图下次快照会收尾）
    this.audio.pause();
    this.audio.removeAttribute('src');
    try {
      this.audio.load();
    } catch {
      // 某些实现下无 src 时 load() 会抛：卸载目的已达成
    }
  }

  // 清空队列并复位（专辑被删除时调用）：状态回到首次打开播放器的样子
  clear() {
    this.deps.local.clearBlobs(this.deps.local.keysOf(this.queue));
    this.unloadAudio();
    this.queue = [];
    this.index = -1;
    this.status = 'idle';
    this.errorMsg = '';
    this.albumNotePath = undefined;
    this.albumTitle = '';
    this.albumTitles.clear();
    this.sourceKind = null;
    this.quality = '';
    this.urlCache.clear();
    this.levelCache.clear();
    this.vaultBlobRetried.clear();
    this.urlRefetched.clear();
    this.emit();
  }

  // —— 控制 ——
  async playIndex(i: number, opts?: { retry?: boolean }) {
    if (i < 0 || i >= this.queue.length) return;
    if (this.index === i && this.status === 'playing') return;
    this.abortScratch(); // 点队列切歌 / 媒体键下一首：手里的那张碟换掉了
    this.index = i;
    this.status = 'loading';
    this.errorMsg = '';
    this.emit();
    const track = this.queue[i];
    // 「还在等这一首吗」按下标判定会在拖拽重排后误判（下标变了、曲子没变）→ 卡在 loading。
    // 判据用「当前曲目还是不是这一首」：切走 / 换专辑照样丢弃，重排不打断加载。
    const stillCurrent = () => this.queue[this.index] === track;
    try {
      const url = await this.resolveUrl(track);
      if (!stillCurrent()) return; // 期间用户已切走
      // 实际音质档（网易云可能已逐级降档；本地音轨无此项）
      this.quality = this.levelCache.get(trackKey(track)) || '';
      this.audio.src = url;
      await this.audio.play();
      this.status = 'playing';
      this.emit();
      if (!opts?.retry) {
        // 归属按曲目自己的专辑算：多专辑队列里，这一段可能不是最后 loadAlbum 的那张
        const album = this.albumOfCurrent();
        this.deps.onTrackPlay?.(track, album.path, album.title || '');
      }
    } catch (e) {
      if (!stillCurrent()) return;
      this.status = 'error';
      this.errorMsg = String((e as Error).message || e);
      this.emit();
      notice(tf('player.cannotPlay', { title: track.title, msg: this.errorMsg }));
    }
  }

  /** 恢复队列位置（不播放）：加载曲目地址并停在 positionSec 处，等用户自己按播放。
   *  位置要等元数据到位才设得上（duration 未就绪时赋值会被忽略），所以挂在 loadedmetadata 上。 */
  async preloadIndex(i: number, positionSec = 0) {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    this.status = 'paused';
    this.errorMsg = '';
    this.emit();
    const track = this.queue[i];
    const stillCurrent = () => this.queue[this.index] === track;
    try {
      const url = await this.resolveUrl(track);
      if (!stillCurrent()) return;
      this.quality = this.levelCache.get(trackKey(track)) || '';
      const applyPosition = () => {
        this.audio.removeEventListener('loadedmetadata', applyPosition);
        if (!stillCurrent()) return;
        const d = isFinite(this.audio.duration) ? this.audio.duration : track.duration || 0;
        if (d > 0 && positionSec > 0) this.audio.currentTime = Math.min(positionSec, Math.max(0, d - 1));
        this.emit();
      };
      this.audio.addEventListener('loadedmetadata', applyPosition);
      this.audio.src = url; // 只设 src，不 play()
      this.emit();
    } catch (e) {
      if (!stillCurrent()) return;
      this.status = 'error';
      this.errorMsg = String((e as Error).message || e);
      this.emit();
    }
  }

  /** 系统媒体键「播放」：已经在播就不动（别拿 toggle 当 play，否则系统面板会越点越乱） */
  async play() {
    if (this.status === 'playing') return;
    await this.toggle();
  }

  /** 系统媒体键「暂停」 */
  pause() {
    if (this.status === 'playing') this.audio.pause();
  }

  async toggle() {
    if (this.status === 'playing') {
      this.audio.pause();
      return;
    }
    if (this.queue.length === 0) {
      notice(t('player.queueEmpty'));
      return;
    }
    if (this.index < 0) {
      await this.playIndex(0);
      return;
    }
    try {
      await this.audio.play();
    } catch {
      // play() 拒绝（多为格式/解码问题）→ 交给统一的错误兜底链路
      void this.onAudioError();
    }
  }

  async next() {
    if (this.queue.length && this.index + 1 < this.queue.length) {
      await this.playIndex(this.index + 1);
    }
  }

  async prev() {
    if (this.queue.length && this.index > 0) {
      await this.playIndex(this.index - 1);
    }
  }

  /** 当前曲目的可用时长（秒）：元素报的优先（元数据到位后最准），退回队列里的元数据 */
  private audioDuration(): number {
    return isFinite(this.audio.duration) ? this.audio.duration : this.queue[this.index]?.duration || 0;
  }

  seek(ratio: number) {
    if (this.scratch) return; // 搓碟期间位置归手势，别让别处的 seek 把盘面拽走
    const d = this.audioDuration();
    if (d > 0) this.audio.currentTime = ratio * d;
  }

  // —— 搓碟（视图的手势通道）——
  // 分工：视图负责手势、视觉与（完整音效的）解码搓碟台；引擎只负责元素的起停与状态口径。
  // 位置的主人始终是视图 —— 快照里的 currentTime 在搓碟期间读的就是视图喂进来的值。

  /** 起手：暂停元素并交出位置。返回 null = 这次不接（没曲目 / 还没就绪 / 已经在搓）。
   *  live = 声音由轻量路出（元素自己按倍速）—— 视图的搓碟台没就绪时走这条。 */
  beginScratch(opts: { live: boolean }): { time: number; playing: boolean } | null {
    if (this.scratch) return null;
    if (this.index < 0 || !this.queue[this.index]) return null;
    // loading / error / idle 不接（换曲取址的间隙里盘上放的是上一首的声音）
    if (this.status !== 'playing' && this.status !== 'paused') return null;
    const time = this.audio.currentTime || 0;
    const playing = this.status === 'playing';
    // 先立会话再暂停：pause 事件（异步）回来时看到 scratch 已经存在，就不会把状态写成暂停
    this.scratch = { live: opts.live, resumePlaying: playing, time, pitchFollow: false };
    if (playing) this.audio.pause();
    if (opts.live) this.applyPitchFollow(true); // 声音要走元素：音高跟着转速（见 setPitchFollow）
    return { time, playing };
  }

  /** 换出声路线：视图的搓碟台中途备好了 → 声音交给它（元素让位，别两边一起响）。
   *  反向不需要（搓碟台出不了声才退回元素，那种情形不会中途发生）。 */
  setScratchLive(live: boolean) {
    const s = this.scratch;
    if (!s || s.live === live) return;
    s.live = live;
    if (live) {
      this.applyPitchFollow(true);
      return;
    }
    if (!this.audio.paused) this.audio.pause();
    try {
      this.audio.playbackRate = 1;
    } catch {
      /* 元素对倍速挑剔：忽略 */
    }
    this.applyPitchFollow(false);
  }

  /** 元素的「保音高」开关：preservesPitch 默认是 true —— 那是给变速不变调用途的时间拉伸，
   *  0.5 倍速听上去是「慢放」而不是黑胶。搓碟要的是唱片那一套：转速变多少、音高就变多少
   *  （搓碟的灵魂之一正是这个「跟着手变调」）。只在轻量路（元素真的出声）用得上，
   *  松手 / 换路 / 收会话都要还回去 —— 正常播放不受影响。 */
  private applyPitchFollow(on: boolean) {
    const s = this.scratch;
    if (!s || s.pitchFollow === on) return;
    s.pitchFollow = on;
    const a = this.audio as HTMLAudioElement & { webkitPreservesPitch?: boolean };
    try {
      a.preservesPitch = !on;
      if ('webkitPreservesPitch' in a) a.webkitPreservesPitch = !on; // 老内核的别名，顺手写上
    } catch {
      /* 元素不支持 / 替身对象：倍速照旧，只是音高不变 */
    }
  }

  /** 搓碟期间的位置（秒）：视图逐帧喂进来；快照 / 系统媒体面板 / 上次播放位置都跟着走 */
  updateScratch(time: number) {
    const s = this.scratch;
    if (!s) return;
    const d = this.audioDuration();
    s.time = Math.max(0, d > 0 ? Math.min(time, d) : time);
    this.emitThrottled(); // 与 timeupdate 同一条节流：别让 60fps 的位置刷新把界面拖垮
  }

  /** 轻量音效：元素按倍速出声 —— 只有正向（元素没有反向，倒着拖是它出不了声的那一半，
   *  不是坏掉；要正反都出声得走视图的搓碟台）。
   *  两件必须做的事：
   *    ① 出声前把元素对到针位上：停声期间元素原地不动，而针位一直在跟着手走 ——
   *       不对齐就出声的话，听到的是手指早就划过的那一段（「声音跟歌没关系」正是这么来的）；
   *    ② 出声 / 停声之间留迟滞（停声线与出声线两档）：每次切换都是真的 play() / pause()，
   *       在阈值上抖一下就是一片碎音。 */
  scratchRate(rate: number) {
    const s = this.scratch;
    if (!s || !s.live) return;
    const a = this.audio;
    if (rate >= SCRATCH_LIVE_RESUME_RATE) {
      try {
        a.playbackRate = Math.min(SCRATCH_MAX_RATE, rate);
      } catch {
        /* 元素对倍速挑剔：忽略，位置与视觉照常 */
      }
      if (a.paused) this.startLive(s.time);
      return;
    }
    if (rate < SCRATCH_LIVE_PAUSE_RATE && !a.paused) a.pause();
  }

  /** 轻量音效从停声转出声：先对针位、再让音高跟着转速、最后 play（出声失败不打断搓碟） */
  private startLive(time: number) {
    const a = this.audio;
    // 对齐要断一下声音，差一点点不值得断；差得多就必须对（见 scratchRate ①）
    if (Math.abs((a.currentTime || 0) - time) > SCRATCH_LIVE_ALIGN_TOL) {
      try {
        a.currentTime = time;
      } catch {
        /* 没有 src / 实现挑剔：位置保持原样，至少倍速是对的 */
      }
    }
    this.applyPitchFollow(true);
    void a.play().catch(() => undefined);
  }

  /** 抬手：把最终位置写回元素，并按起手前的姿态回到播放 / 暂停 */
  endScratch(time: number, resume: boolean) {
    if (!this.scratch) return;
    this.applyPitchFollow(false); // 交还元素：保音高还回去（要在清掉会话之前）
    this.scratch = null;
    const d = this.audioDuration();
    // 别顶到末尾（顶上去会直接触发 ended 切歌）
    const t = Math.max(0, d > 0 ? Math.min(time, Math.max(0, d - 0.05)) : time);
    // 轻量路抬手时元素本来就在放、位置一路对着针位（见 scratchRate ①）：这点零头不值得
    // 用一次 seek（那是几十毫秒的断音）去纠。元素停着就得写 —— 完整音效的指针位置全靠这一下。
    const drift = Math.abs((this.audio.currentTime || 0) - t);
    if (this.audio.paused || drift > SCRATCH_LIVE_ALIGN_TOL) {
      try {
        this.audio.currentTime = t;
      } catch {
        /* 没有 src / 实现挑剔：位置保持原样 */
      }
    }
    this.audio.playbackRate = 1;
    if (resume) {
      if (this.audio.paused) void this.audio.play().catch(() => void this.onAudioError());
    } else if (!this.audio.paused) {
      this.audio.pause();
    }
    this.emit();
  }

  /** 收掉搓碟会话（换曲 / 清队列 / 卸载音源 / 关插件）：不写位置、不碰元素 —— 调用方自己收尾 */
  private abortScratch() {
    if (!this.scratch) return;
    this.applyPitchFollow(false);
    this.scratch = null;
    this.audio.playbackRate = 1;
  }

  setVolume(v: number) {
    this.audio.volume = Math.min(1, Math.max(0, v));
    this.emit();
  }

  // —— 地址解析（本地 / 网易云 / QQ 三路）——
  async resolveUrl(track: Track): Promise<string> {
    switch (track.source) {
      case 'local-vault':
        return this.deps.local.resolveVaultUrl(track.file);
      case 'local-external':
        return this.deps.local.resolveExternalUrl(track.path);
      case 'netease': {
        const key = trackKey(track);
        const hit = this.urlCache.get(key);
        if (hit) return hit;
        const r = await this.deps.netease.songUrl(track.id, this.deps.settings().quality);
        if (!r.url) throw new Error(r.restriction || t('auth.sourceUnavailable'));
        this.urlCache.set(key, r.url);
        if (r.level) this.levelCache.set(key, r.level);
        return r.url;
      }
      case 'qq': {
        const key = trackKey(track);
        const hit = this.urlCache.get(key);
        if (hit) return hit;
        const r = await this.deps.qq.songUrl(track.id, this.deps.settings().quality, track.mediaMid);
        if (!r.url) {
          throw new Error(
            r.restriction ||
            (track.pay ? t('player.vipNoUrl') : t('auth.sourceUnavailable'))
          );
        }
        this.urlCache.set(key, r.url);
        if (r.level) this.levelCache.set(key, r.level);
        return r.url;
      }
      case 'kugou': {
        const key = trackKey(track);
        const hit = this.urlCache.get(key);
        if (hit) return hit;
        // 取流要带 hash + 专辑 id + mixsongid 三件套（见 core/kugou.ts）；付费曲目的限制文案与 QQ 同义
        const r = await this.deps.kugou.songUrl(
          track.id,
          this.deps.settings().quality,
          track.albumId,
          track.albumAudioId
        );
        if (!r.url) {
          throw new Error(
            r.restriction ||
            (track.pay ? t('player.vipNoUrl') : t('auth.sourceUnavailable'))
          );
        }
        this.urlCache.set(key, r.url);
        if (r.level) this.levelCache.set(key, r.level);
        return r.url;
      }
    }
  }

  // —— 内部事件 ——
  private onEnded() {
    if (this.index + 1 < this.queue.length) {
      void this.playIndex(this.index + 1);
      return;
    }
    // 队尾：单次 → 停；循环 → 回队首；随机 → 重洗一次再从头放（随机的语义是一直放下去）
    if (this.playMode === 'loop') {
      void this.playIndex(0);
      return;
    }
    if (this.playMode === 'shuffle') {
      this.shuffleQueue();
      void this.playIndex(0);
      return;
    }
    this.status = 'paused';
    this.emit();
  }

  /** 单次 → 循环 → 随机 循环切换（播放器顶部那个模式按钮）。切到随机时立刻打乱一次；
   *  打乱的对象是「队列里的曲目」—— 队列模式下即整条列表的曲目。 */
  cyclePlayMode(): PlayMode {
    const order: PlayMode[] = ['once', 'loop', 'shuffle'];
    const next = order[(order.indexOf(this.playMode) + 1) % order.length];
    this.playMode = next;
    if (next === 'shuffle') this.shuffleQueue();
    this.emit();
    return next;
  }

  /** 打乱队列：整条队列的曲目一起打乱（队列模式下就是「随机播放列表中的曲目」，
   *  各专辑的曲子会混在一起）。当前播放的那首仍是当前曲目 —— 下标跟着它走，不打断播放。 */
  shuffleQueue() {
    if (this.queue.length < 2) return;
    const currentKey = this.index >= 0 ? trackKey(this.queue[this.index]) : '';
    this.queue = this.shuffle(this.queue);
    if (currentKey) {
      const i = this.queue.findIndex((tr) => trackKey(tr) === currentKey);
      if (i >= 0) this.index = i;
    }
    this.emit();
  }

  /** Fisher–Yates（洗牌源可注入，测试里给固定序列） */
  private shuffle<T>(list: T[]): T[] {
    const rnd = this.deps.random || Math.random;
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  private async onAudioError() {
    const idx = this.index;
    const track = idx >= 0 ? this.queue[idx] : undefined;
    if (!track) return;
    // 出错的是「事件触发时的那一首」：await 之后若已切歌，兜底结果一律丢弃。
    // 判「当前曲目还是不是这一首」而非下标——拖拽重排只换位置不换曲子，不该丢弃兜底结果。
    const stillCurrent = () => this.queue[this.index] === track;
    // vault 流式失败 → readBinary→Blob 兜底
    if (track.source === 'local-vault' && !this.vaultBlobRetried.has(track.file.path)) {
      this.vaultBlobRetried.add(track.file.path);
      try {
        const blob = await this.deps.local.resolveVaultBlobUrl(track.file);
        if (!stillCurrent()) return;
        this.audio.src = blob;
        await this.audio.play();
        if (!stillCurrent()) return;
        this.status = 'playing';
        this.emit();
        return;
      } catch {
        // Blob 兜底也失败 → 继续走下面的在线源重取 / 报错链路
      }
    }
    // 在线源 URL 过期/失效 → 重取一次（缓存按 trackKey 键控，跨源互不影响）
    if (track.source === 'netease' || track.source === 'qq' || track.source === 'kugou') {
      const key = trackKey(track);
      if (!this.urlRefetched.has(key)) {
        this.urlRefetched.add(key);
        this.urlCache.delete(key);
        try {
          if (!stillCurrent()) return;
          await this.playIndex(idx, { retry: true });
          return;
        } catch {
          // 重取后仍失败：落到底部的错误文案
        }
      }
    }
    if (!stillCurrent()) return;
    this.status = 'error';
    this.errorMsg = tf('player.playFailed', { title: track.title });
    this.emit();
    notice(this.errorMsg);
  }

  dispose() {
    this.listeners.clear();
    this.abortScratch();
    this.audio.pause();
    this.audio.removeAttribute('src');
    try {
      this.audio.load();
    } catch {
      // 同 unloadAudio：无 src 时 load() 可能抛，忽略
    }
  }
}
