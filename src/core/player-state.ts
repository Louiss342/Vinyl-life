// 播放引擎（M1 底座）：统一面向 Track 解析可播放地址、推进队列、状态快照事件。
// M3 的交接动效与黑胶转盘视觉接在此状态之上（IDLE → HANDOFF → PLAYING）。
import { App } from 'obsidian';
import { Track, trackKey } from './track';
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
}

export class PlaybackEngine {
  private audio = new Audio();
  private queue: Track[] = [];
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
    this.queue = tracks;
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
    try {
      const url = await this.resolveUrl(track);
      if (this.index !== i) return; // 期间用户已切走
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
      if (this.index !== i) return;
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
    // 出错的是「事件触发时的那一首」：await 之后若已切歌，兜底结果一律丢弃
    const stillCurrent = () => this.index === idx && this.queue[idx] === track;
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
