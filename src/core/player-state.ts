// 播放引擎（M1 底座）：统一面向 Track 解析可播放地址、推进队列、状态快照事件。
// M3 的交接动效与黑胶转盘视觉接在此状态之上（IDLE → HANDOFF → PLAYING）。
import { App } from 'obsidian';
import { Track, trackKey, applyTrackOrder, reorderTracks } from './track';
import { AlbumInfo } from './album-index';
import { LocalSource } from './local-source';
import { NeteaseService } from './netease';
import { QqService } from './qq';
import { buildAlbumQueue, BuildQueueResult, ActiveSource, sourceLabel } from './queue';
import type { VinylSettings } from '../settings';
import { fmtTime, notice, sleep } from '../util';

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

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
  /** 当前队列来源（本地 / 网易云） */
  sourceLabel?: string;
  /** 当前曲目实际拿到的音质档（standard/higher/exhigh/lossless；本地音轨为空） */
  quality?: string;
  error?: string;
}

export interface EngineDeps {
  app: App;
  local: LocalSource;
  /** 统一网易云入口（网页会话优先，网关兜底，内部处理就绪） */
  netease: NeteaseService;
  /** QQ 音乐入口（网关单通道；取链 ladder 在网关侧） */
  qq: QqService;
  settings: () => VinylSettings;
  /** 曲目成功开播钩子（播放统计用；重试路径不触发） */
  onTrackPlay?: (track: Track, albumNotePath?: string, albumTitle?: string) => void;
  /** 读取该专辑存过的自定义队列顺序（返回 undefined = 没存过，按原顺序播）。
   *  可选：既有测试 / 无设置场景不传也不影响。 */
  savedOrder?: (albumNotePath: string) => string[] | undefined;
  /** 队列被拖拽重排后的钩子（持久化用；orderKeys = 新顺序的 trackKey 列表）。
   *  可选：不传则重排只影响本次会话。 */
  onQueueOrderChange?: (albumNotePath: string, orderKeys: string[]) => void;
  /** 队列被「恢复原有顺序」后的钩子（持久化用：删掉该专辑存过的自定义顺序）。
   *  可选：不传则恢复只影响本次会话。 */
  onQueueOrderClear?: (albumNotePath: string) => void;
}

export class PlaybackEngine {
  private audio = new Audio();
  private queue: Track[] = [];
  /** 本专辑的「原始顺序」（构建出来的自然顺序：在线源 = 专辑曲目顺序，本地 = 扫描文件名顺序）。
   *  只在 setQueue 里按构建结果写一次，拖拽不碰它——「恢复原有顺序」靠它把队列排回去。 */
  private originalOrder: string[] = [];
  private index = -1;
  private status: PlayerStatus = 'idle';
  private errorMsg = '';
  private albumNotePath?: string;
  private albumTitle = '';
  private sourceLabel = '';
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

  constructor(private deps: EngineDeps) {
    this.audio.preload = 'auto';
    this.audio.volume = 0.8;
    this.audio.addEventListener('loadedmetadata', () => this.emit());
    this.audio.addEventListener('timeupdate', () => this.emitThrottled());
    this.audio.addEventListener('ended', () => this.onEnded());
    this.audio.addEventListener('play', () => {
      if (this.status !== 'playing') {
        this.status = 'playing';
        this.emit();
      }
    });
    this.audio.addEventListener('pause', () => {
      if (this.status === 'playing') {
        this.status = 'paused';
        this.emit();
      }
    });
    this.audio.addEventListener('error', () => this.onAudioError());
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
      status: this.status,
      queue: this.queue,
      index: this.index,
      current: this.index >= 0 ? this.queue[this.index] : undefined,
      currentTime: this.audio.currentTime || 0,
      duration: isFinite(this.audio.duration)
        ? this.audio.duration
        : this.queue[this.index]?.duration || 0,
      volume: this.audio.volume,
      albumNotePath: this.albumNotePath,
      albumTitle: this.albumTitle,
      sourceLabel: this.sourceLabel,
      quality: this.quality || undefined,
      error: this.errorMsg || undefined,
    };
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
  async loadAlbum(album: AlbumInfo): Promise<BuildQueueResult> {
    const seq = ++this.loadSeq;
    const res = await buildAlbumQueue(album, {
      local: this.deps.local,
      netease: this.deps.netease,
      qq: this.deps.qq,
      defaultSource: this.deps.settings().defaultSource,
    });
    // 期间用户又点了别的专辑（交接动效 / 播放器换碟菜单两个入口）→ 丢弃本次结果
    if (seq !== this.loadSeq) return res;
    if (!res.tracks.length) {
      this.errorMsg = res.reason || '';
      this.status = 'idle';
      this.emit();
      notice(res.reason || '无可播放音轨');
      return res;
    }
    const source: ActiveSource = res.resolvedSource === 'none' ? 'local' : res.resolvedSource;
    this.setQueue(res.tracks, album.path, album.title, source);
    if (this.deps.settings().autoPlay) await this.playIndex(0);
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
    // 先记下「原始顺序」（= 构建出来的自然顺序），再套用自定义顺序：
    // 它是「恢复原有顺序」的基准，拖拽不得改动，故只认这里的构建结果
    this.originalOrder = tracks.map((t) => trackKey(t));
    // 该专辑存过自定义顺序 → 套用（新增曲目按原相对顺序补在后面）；
    // 没存过（或钩子未接线）走原始顺序，行为与旧版一致
    const saved = this.deps.savedOrder?.(albumNotePath);
    this.queue = saved && saved.length ? applyTrackOrder(tracks, saved) : tracks;
    this.index = -1;
    this.albumNotePath = albumNotePath;
    this.albumTitle = albumTitle;
    this.sourceLabel = sourceLabel(source);
    this.quality = '';
    this.urlCache.clear();
    this.levelCache.clear();
    this.vaultBlobRetried.clear();
    this.urlRefetched.clear();
    this.emit();
  }

  /** 拖拽重排队列：把 from 处的曲目移到 to 位（to = 结果下标）。
   *  正在播放的那首歌必须继续是「当前」——先记住它（对象引用 + trackKey 双保险），
   *  重排后按新位置重置 index，否则 UI 高亮 / next() 的推进基准会跟着下标漂到别的曲子上。 */
  moveTrack(from: number, to: number) {
    if (from === to) return;
    if (from < 0 || to < 0 || from >= this.queue.length || to >= this.queue.length) return;
    // 双保险：对象引用（同队列内唯一）+ trackKey（同一首歌换了实例也能追上）
    const current = this.index >= 0 ? this.queue[this.index] : undefined;
    const currentKey = current ? trackKey(current) : '';
    this.queue = reorderTracks(this.queue, from, to);
    if (current) {
      let i = this.queue.indexOf(current);
      if (i < 0 && currentKey) i = this.queue.findIndex((t) => trackKey(t) === currentKey);
      if (i >= 0) this.index = i;
    }
    // 音频不动（同一首歌继续播），只广播新队列 → 视图重建行并重贴 is-current
    this.emit();
    if (this.albumNotePath) {
      this.deps.onQueueOrderChange?.(this.albumNotePath, this.queue.map((t) => trackKey(t)));
    }
  }

  /** 恢复专辑原有顺序：按 setQueue 记下的原始顺序就地重排（纯排序，不重新联网 / 不重新扫描）。
   *  正在播放的那首必须仍是「当前」——与 moveTrack 同一套「对象引用 → trackKey」双保险重定位 index；
   *  音频 src 一律不碰（同一首歌继续播）。返回是否真的动过队列：
   *  已是原始顺序 = 空操作，不 emit 也不惊动持久化层（与 moveTrack 的越界空操作同款语义）。 */
  restoreOriginalOrder(): boolean {
    if (!this.queue.length || !this.originalOrder.length) return false;
    // applyTrackOrder 搬的是同一批对象引用 → 逐位比较对象即可判定「顺序有没有变」
    const next = applyTrackOrder(this.queue, this.originalOrder);
    if (next.every((t, i) => t === this.queue[i])) return false;
    const current = this.index >= 0 ? this.queue[this.index] : undefined;
    const currentKey = current ? trackKey(current) : '';
    this.queue = next;
    if (current) {
      let i = this.queue.indexOf(current);
      if (i < 0 && currentKey) i = this.queue.findIndex((t) => trackKey(t) === currentKey);
      if (i >= 0) this.index = i;
    }
    // 音频不动（同一首歌继续播），只广播新队列 → 视图重建行并重贴 is-current
    this.emit();
    if (this.albumNotePath) {
      this.deps.onQueueOrderClear?.(this.albumNotePath);
    }
    return true;
  }

  // 卸载当前音源（换专辑 / 复位共用；removeAttribute + load 是 Chromium 释放媒体的标准姿势）
  private unloadAudio() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    try {
      this.audio.load();
    } catch (_) {}
  }

  // 清空队列并复位（专辑被删除时调用）：状态回到首次打开播放器的样子
  clear() {
    this.deps.local.clearBlobs(this.deps.local.keysOf(this.queue));
    this.unloadAudio();
    this.queue = [];
    this.originalOrder = [];
    this.index = -1;
    this.status = 'idle';
    this.errorMsg = '';
    this.albumNotePath = undefined;
    this.albumTitle = '';
    this.sourceLabel = '';
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
    this.index = i;
    this.status = 'loading';
    this.errorMsg = '';
    this.emit();
    const track = this.queue[i];
    // 「还在等这一首吗」按下标判定会在拖拽重排后误判（下标变了、曲子没变）→ 卡在 loading。
    // 统一改成判「当前曲目还是不是这一首」：切走 / 换专辑照样丢弃，重排不再打断加载。
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
        this.deps.onTrackPlay?.(track, this.albumNotePath, this.albumTitle);
      }
    } catch (e) {
      if (!stillCurrent()) return;
      this.status = 'error';
      this.errorMsg = String((e as Error).message || e);
      this.emit();
      notice(`无法播放《${track.title}》：${this.errorMsg}`);
    }
  }

  async toggle() {
    if (this.status === 'playing') {
      this.audio.pause();
      return;
    }
    if (this.queue.length === 0) {
      notice('队列为空，先在播放器选择专辑');
      return;
    }
    if (this.index < 0) {
      await this.playIndex(0);
      return;
    }
    try {
      await this.audio.play();
    } catch (_) {
      this.onAudioError();
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

  seek(ratio: number) {
    const d = isFinite(this.audio.duration)
      ? this.audio.duration
      : this.queue[this.index]?.duration || 0;
    if (d > 0) this.audio.currentTime = ratio * d;
  }

  setVolume(v: number) {
    this.audio.volume = Math.min(1, Math.max(0, v));
    this.emit();
  }

  // —— 地址解析（三路 M0 已验证）——
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
        if (!r.url) throw new Error(r.restriction || '音源不可用');
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
            r.restriction || (track.pay ? '会员/付费曲目，QQ 音乐未提供播放地址' : '音源不可用')
          );
        }
        this.urlCache.set(key, r.url);
        if (r.level) this.levelCache.set(key, r.level);
        return r.url;
      }
    }
  }

  // 试播探针（自检用，不动当前队列）
  async probePlay(track: Track, ms = 1200): Promise<{ ok: boolean; detail: string }> {
    try {
      const url = await this.resolveUrl(track);
      const a = new Audio(url);
      a.volume = 0.3;
      await a.play();
      await sleep(ms);
      const ok = !a.paused && a.currentTime > 0.15;
      const detail = `currentTime=${a.currentTime.toFixed(2)}s, duration=${
        isFinite(a.duration) ? fmtTime(a.duration) : 'N/A'
      }`;
      a.pause();
      return { ok, detail };
    } catch (e) {
      return { ok: false, detail: String((e as Error).message || e) };
    }
  }

  // —— 内部事件 ——
  private onEnded() {
    if (this.index + 1 < this.queue.length) {
      this.playIndex(this.index + 1);
    } else {
      this.status = 'paused';
      this.emit();
    }
  }

  private async onAudioError() {
    const idx = this.index;
    const track = idx >= 0 ? this.queue[idx] : undefined;
    if (!track) return;
    // 出错的是「事件触发时的那一首」：await 之后若已切歌，兜底结果一律丢弃。
    // 判「当前曲目还是不是这一首」而非下标——拖拽重排只换位置不换曲子，不该丢弃兜底结果。
    const stillCurrent = () => this.queue[this.index] === track;
    // vault 流式失败 → readBinary→Blob 兜底（M0 V1-B 预案）
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
      } catch (_) {}
    }
    // 在线源 URL 过期/失效 → 重取一次（缓存按 trackKey 键控，跨源互不影响）
    if (track.source === 'netease' || track.source === 'qq') {
      const key = trackKey(track);
      if (!this.urlRefetched.has(key)) {
        this.urlRefetched.add(key);
        this.urlCache.delete(key);
        try {
          if (!stillCurrent()) return;
          await this.playIndex(idx, { retry: true });
          return;
        } catch (_) {}
      }
    }
    if (!stillCurrent()) return;
    this.status = 'error';
    this.errorMsg = `《${track.title}》播放失败（格式不支持、文件损坏或网络问题）`;
    this.emit();
    notice(this.errorMsg);
  }

  dispose() {
    this.listeners.clear();
    this.audio.pause();
    this.audio.removeAttribute('src');
    try {
      this.audio.load();
    } catch (_) {}
  }
}
