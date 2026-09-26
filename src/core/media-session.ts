// 系统媒体控制：把引擎状态映射到 MediaSession（媒体键 / 耳机按键 / 系统媒体面板）。
// 放在插件层而不是播放器视图：播放器关着的时候媒体键也得管用。
// 浏览器 / Electron 里 navigator.mediaSession 可能不存在（或部分实现），所有调用都要容错。
import type { PlayerSnapshot } from './player-state';

/** 媒体元数据（形状对齐 MediaMetadataInit，但不依赖 lib.dom 的类型名 —— 便于脚本测试） */
export interface MediaMetadata {
  title: string;
  artist: string;
  album: string;
  artwork: Array<{ src: string }>;
}

/** 快照 → 媒体元数据；没有当前曲目时返回 null（表示该清空系统面板） */
export function metadataOf(s: PlayerSnapshot): MediaMetadata | null {
  const track = s.current;
  if (!track) return null;
  const artwork = track.cover ? [{ src: track.cover }] : [];
  return {
    title: track.title || '',
    // 歌手用 Track 上的 artist（三平台与本地标签都填了）；只有拿不到时才退回专辑名 ——
    // 「歌手 = 专辑名」在系统面板上等于少显示一半信息（旧注释说 Track 上没有 artist，已过时）
    artist: track.artist || s.albumTitle || '',
    album: s.albumTitle || '',
    artwork,
  };
}

/** 系统面板能显示播放进度时才设置（时长未知时 setPositionState 会抛） */
export function positionStateOf(s: PlayerSnapshot): { duration: number; position: number; playbackRate: number } | null {
  if (!s.current || !isFinite(s.duration) || s.duration <= 0) return null;
  return {
    duration: s.duration,
    position: Math.min(Math.max(0, s.currentTime), s.duration),
    playbackRate: 1,
  };
}

export interface MediaSessionHooks {
  play: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
  /** 系统面板拖动进度条：ratio ∈ [0,1] */
  seek: (ratio: number) => void;
}

type MediaSessionLike = {
  metadata: unknown;
  playbackState: 'none' | 'paused' | 'playing';
  setActionHandler: (action: string, handler: ((details?: unknown) => void) | null) => void;
  setPositionState?: (state?: { duration: number; position: number; playbackRate: number }) => void;
};

function mediaSession(): MediaSessionLike | null {
  try {
    const ms = (navigator as unknown as { mediaSession?: MediaSessionLike }).mediaSession;
    return ms && typeof ms.setActionHandler === 'function' ? ms : null;
  } catch {
    return null; // 没有 navigator（脚本测试）或实现不全：静默降级
  }
}

let handlersBound = false;

/** 把当前快照同步到系统媒体面板；第一次调用时登记动作处理器（媒体键 → 引擎） */
export function syncMediaSession(s: PlayerSnapshot, hooks: MediaSessionHooks) {
  const ms = mediaSession();
  if (!ms) return;

  if (!handlersBound) {
    handlersBound = true;
    // 不支持的动作（Electron 里常见）会抛，逐个兜住，不影响其它动作
    const bind = (action: string, handler: (details?: unknown) => void) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // 该动作不被支持：忽略
      }
    };
    bind('play', () => hooks.play());
    bind('pause', () => hooks.pause());
    bind('nexttrack', () => hooks.next());
    bind('previoustrack', () => hooks.prev());
    bind('seekto', (details) => {
      const d = details as { seekTime?: number } | undefined;
      const duration = lastDuration;
      if (d && typeof d.seekTime === 'number' && duration > 0) {
        hooks.seek(Math.min(1, Math.max(0, d.seekTime / duration)));
      }
    });
  }

  const meta = metadataOf(s);
  const Ctor = (window as unknown as { MediaMetadata?: new (init: MediaMetadata) => unknown })
    .MediaMetadata;
  try {
    ms.metadata = meta && Ctor ? new Ctor(meta) : null;
  } catch {
    // 构造失败（形状不被接受）：保留上一次的元数据，不影响播放
  }

  // 顺序要紧：没有曲目就是 none（哪怕 status 还停在 playing），否则系统面板会显示一个不存在的播放
  ms.playbackState = !s.current ? 'none' : s.status === 'playing' ? 'playing' : 'paused';

  lastDuration = isFinite(s.duration) && s.duration > 0 ? s.duration : 0;
  const pos = positionStateOf(s);
  try {
    if (ms.setPositionState) ms.setPositionState(pos ?? undefined);
  } catch {
    // 时长/位置不合法：跳过这一次进度上报
  }
}

// seekto 处理器要按时长换算，而处理器只登记一次 → 用模块级变量记住最近一次的时长
let lastDuration = 0;

/** 仅测试用：重置「已登记处理器」与时长缓存 */
export function __resetMediaSessionForTest() {
  handlersBound = false;
  lastDuration = 0;
}
