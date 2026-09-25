// 搓碟台（完整音效）：把整轨音频解码成 AudioBuffer，用 AudioBufferSourceNode 按指针倍速出声 ——
// 正反两个方向都出声，位置由本模块自己积分（与视图的视觉同源，不依赖元素的 currentTime）。
//
// 为什么不能直接用 <audio> 元素：
//   ① 元素的 playbackRate 只能正向 —— Chromium 的负速率（反向播放）至今没普及，而「搓」的灵魂
//      恰恰是来回都能出声；
//   ② 元素的 currentTime 读数是量化过的（官方播放位置 250ms 一档），做不出跟手的手感。
// 所以搓碟期间元素暂停，声音由这里出；抬手再把最终位置写回元素（见 player-state 的 endScratch）。
//
// 内存：解码整轨是这套方案的代价，采样率按内存预算挑档（chooseScratchRate）。
//   float32 × 2 声道 = 每采样 8 字节 → 22.05 kHz ≈ 10.6 MB/分钟（4 分钟的歌 ≈ 42 MB）。
//   反向播放在不支持负速率的内核上还要一份倒放副本（再翻一倍），故预算按「前向 + 可能的副本」
//   一起算：探测不到负速率时预算对半 —— 长音轨在旧内核上退到低采样率，装不下就整首走轻量音效
//   （正反都不出声的那一侧只是安静，位置照走，不是坏掉）。
//
// 缓存：下载 + 解码一份要几秒，而这张碟随时可能被回头再搓 —— 解码好的份按 LRU 留着，
//   回头再搓是现成的，不用再等一遍。退出只看内存总量：超过预算就丢最久没用过的那份，
//   正在搓的那份不丢。（不在后台预先下载整轨：那会跟播放抢带宽、还要多解析一次播放地址，
//   切歌会变得不跟手 —— 准备一律由「手按上来」触发，见 player-view 的 maybePrepareScratch。）
//
// 两条出声路线：
//   负速率可用 → 一个源、带符号 playbackRate（内存 ×1）
//   负速率不可用 → 正向走原缓冲、反向走倒放副本（把「倒着读」变成「正着读倒放副本」，
//                  方向翻转时换源；翻转发生在速度过零处，再加 4ms 增益包络，听不出接缝）
//
// 三条纪律（都是「手指还在盘上，声音却没了」的来源）：
//   ① 声源播到头就摘掉重起 —— 已结束的节点上写 playbackRate 是哑的，往回拖也不会再出声；
//   ② 增益自动化先撤销再排 —— 快速换向时上一次的淡出 / 淡入还排在时间轴上，叠起来会把增益
//      压在 0 上起不来；
//   ③ 起手按当帧倍速起播 —— 不是正常转速：手指慢慢拖，耳朵先听到一截原速就是露馅。

import { clampRate } from './scratch';

/** 解码采样率档位（由高到低挑一档装进内存预算）；都装不下 → 这首曲子只走轻量音效 */
export const SCRATCH_SAMPLE_RATES: readonly number[] = [22050, 16000, 11025, 8000];

/** 立体声 + float32：每采样字节数 */
const BYTES_PER_SAMPLE = 4;
const SCRATCH_CHANNELS = 2;

/** 单首曲子的解码内存预算（前向缓冲 + 可能的倒放副本一起算，见文件头注释） */
export const SCRATCH_BUDGET_BYTES = 64 * 1024 * 1024;
/** 整台搓碟台的缓存上限：超了丢最久没用过的那份（4 分钟的歌 ≈ 42 MB，够放两份） */
export const SCRATCH_CACHE_BYTES = 96 * 1024 * 1024;
/** 缓存份数上限（最近搓过的几张；内存先到上限就以内存为准） */
export const SCRATCH_CACHE_TRACKS = 3;
/** 同时在途的准备份数：连抓两张蝶时的上限，再多就等下一次，别把带宽和 CPU 一次铺满 */
export const SCRATCH_MAX_INFLIGHT = 2;

/** 方向翻转的增益包络时长（秒）：几毫秒就够，听不出接缝又不会爆音 */
const FADE_SEC = 0.004;

/** 抬手收尾的包络时长（秒）：留够元素接回来的时间（视图那侧先把它 seek + play 上，见 scratchFinish） */
const RELEASE_FADE_SEC = 0.04;

/** 单帧位置推进的上限（ms）：窗口切回来时别让位置一帧飞出几秒 */
const MAX_FRAME_MS = 100;

/** 挑解码采样率：给出这首曲子的时长（秒）与预算，返回能装下的最高档；装不下返回 null。
 *  时长未知（0 / 非有限）也返回 null —— 不猜：宁可这首曲子只有轻量音效，也不要解出一坨内存。
 *  时长由调用方保证（本地未播过的曲子用一次元数据探测补上，见 probeMediaDuration）。 */
export function chooseScratchRate(durationSec: number, budget = SCRATCH_BUDGET_BYTES): number | null {
  if (!(durationSec > 0) || !isFinite(durationSec) || !(budget > 0)) return null;
  for (const rate of SCRATCH_SAMPLE_RATES) {
    if (durationSec * rate * SCRATCH_CHANNELS * BYTES_PER_SAMPLE <= budget) return rate;
  }
  return null;
}

/** 缓冲占的字节数（前向 + 倒放副本） */
function bufferBytes(buf: AudioBufferLike): number {
  return buf.length * buf.numberOfChannels * BYTES_PER_SAMPLE;
}

// —— 最小结构类型（不依赖 lib.dom 的类型名，便于脚本测试注入替身；与 media-session 同一取舍）——

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): void;
  linearRampToValueAtTime(value: number, time: number): void;
  cancelScheduledValues(time: number): void;
}

export interface GainLike {
  gain: AudioParamLike;
  connect(dst: unknown): void;
}

export interface BufferSourceLike {
  buffer: AudioBufferLike | null;
  playbackRate: AudioParamLike;
  connect(dst: unknown): void;
  start(when?: number, offset?: number): void;
  stop(when?: number): void;
}

export interface AudioBufferLike {
  duration: number;
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

export interface AudioContextLike {
  currentTime: number;
  state: string;
  destination: unknown;
  createGain(): GainLike;
  createBufferSource(): BufferSourceLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  resume?(): Promise<void>;
  close?(): Promise<void>;
}

/** 一份解码好的曲目（缓存条目） */
interface DeckEntry {
  key: string;
  /** 前向缓冲 */
  buffer: AudioBufferLike;
  /** 倒放副本（负速率不可用时按需分片复制；没就绪 / 放弃时是 null） */
  reversed: AudioBufferLike | null;
  /** 已占内存（前向 + 倒放副本） */
  bytes: number;
  /** 最近一次使用的次序（LRU：越小越久没用过） */
  used: number;
  /** 倒放副本放弃了（超预算）：别每帧再试 */
  reverseSkipped: boolean;
}

/** prepare 的取料结果：整轨字节 + 时长（时长用来挑解码采样率） */
export interface ScratchSource {
  bytes: ArrayBuffer | null;
  durationSec: number;
}

export interface ScratchDeckDeps {
  /** 声卡上下文（缺省 new AudioContext；测试注入替身） */
  createContext?: () => AudioContextLike | null;
  /** 解码（缺省 OfflineAudioContext.decodeAudioData；测试注入替身） */
  decode?: (bytes: ArrayBuffer, sampleRate: number) => Promise<AudioBufferLike>;
  /** 负速率探测（缺省 supportsNegativeRate；测试注入固定结果） */
  negativeRate?: () => Promise<boolean>;
  /** 当前音量（0–1；每次 begin / 换向取一次） */
  volume: () => number;
  /** 延后执行（倒放副本分片复制用；测试可注入同步实现） */
  schedule?: (fn: () => void) => void;
}

// —— 负速率探测（一次、结果缓存）——

let negativeRateSupport: Promise<boolean> | null = null;

/** 浏览器是否支持 AudioBufferSourceNode 的负 playbackRate（反向播放）。
 *  一次探测、结果缓存；任何异常按「不支持」处理（退回倒放副本那条路，功能不受影响）。 */
export function supportsNegativeRate(): Promise<boolean> {
  if (!negativeRateSupport) {
    negativeRateSupport = probeNegativeRate().catch(() => false);
  }
  return negativeRateSupport;
}

/** 渲染一小段斜坡、从中间倒着播：输出该是递减的（正着播是递增，静音则两者都不是）。
 *  为什么从中间起播：从 0 起播时「倒着」与「正着」都立刻到头，分不出方向。 */
async function probeNegativeRate(): Promise<boolean> {
  const Ctor = (
    globalThis as unknown as {
      OfflineAudioContext?: new (c: number, l: number, r: number) => AudioContextLike & {
        startRendering(): Promise<AudioBufferLike>;
      };
    }
  ).OfflineAudioContext;
  if (!Ctor) return false;
  const ctx = new Ctor(1, 32, 8000);
  const buf = ctx.createBuffer(1, 32, 8000);
  const data = buf.getChannelData(0);
  for (let i = 0; i < 32; i++) data[i] = i / 32;
  const node = ctx.createBufferSource();
  node.buffer = buf;
  node.playbackRate.value = -1;
  node.connect(ctx.destination);
  node.start(0, 16 / 8000);
  const out = await ctx.startRendering();
  const got = out.getChannelData(0);
  return got[0] > 0 && got[1] < got[0];
}

/** 仅测试用：清掉负速率探测的缓存 */
export function __resetNegativeRateForTest(): void {
  negativeRateSupport = null;
}

/** 读一次媒体时长（本地未播过的曲子没有时长元数据，队列里也不带标签）：
 *  临时元素只读元数据、读完立刻卸掉音源；失败 / 超时按 0 处理（该曲目退回轻量音效，不报错）。 */
export function probeMediaDuration(
  url: string,
  opts?: { create?: () => HTMLAudioElement | null; timeoutMs?: number }
): Promise<number> {
  const timeoutMs = opts?.timeoutMs ?? 8000;
  return new Promise((resolve) => {
    let el: HTMLAudioElement | null = null;
    let timer: number | null = null;
    let done = false;
    const finish = (sec: number) => {
      if (done) return;
      done = true;
      if (timer !== null) window.clearTimeout(timer);
      try {
        el?.removeAttribute('src');
        el?.load();
      } catch {
        /* 卸不掉就算了：元素没有别的引用，交给 GC */
      }
      resolve(isFinite(sec) && sec > 0 ? sec : 0);
    };
    try {
      const create =
        opts?.create ??
        (() => (globalThis as unknown as { Audio?: new () => HTMLAudioElement }).Audio
          ? new (globalThis as unknown as { Audio: new () => HTMLAudioElement }).Audio()
          : null);
      el = create();
      if (!el) return finish(0);
      el.preload = 'metadata';
      el.addEventListener('loadedmetadata', () => finish(el?.duration || 0));
      el.addEventListener('error', () => finish(0));
      timer = window.setTimeout(() => finish(0), timeoutMs);
      el.src = url;
    } catch {
      finish(0);
    }
  });
}

// —— 搓碟台 ——

export class ScratchDeck {
  private ctx: AudioContextLike | null = null;
  private gain: GainLike | null = null;
  /** 解码好的曲目（LRU 缓存） */
  private entries = new Map<string, DeckEntry>();
  /** 缓存占用的总字节数（前向 + 倒放副本） */
  private bytes = 0;
  /** 正在准备中的曲目键（同键不重复取字节 / 解码） */
  private inflight = new Set<string>();
  /** 释放代次：dispose 时 ++，在途的取料与解码回来发现已释放就丢弃
   *  （否则关视图之后回来的结果会往已清空的缓存里塞，甚至把声卡上下文重新建起来） */
  private epoch = 0;
  /** 负速率是否可用（全局属性，探测一次） */
  private negative = false;
  /** 当前手势用的那一份（begin 选中；淘汰时跳过它） */
  private active: DeckEntry | null = null;
  private src: BufferSourceLike | null = null;
  /** 播放方向（决定用哪个缓冲、从哪个偏移起播） */
  private dir: 1 | -1 = 1;
  /** 当前位置（秒）：本模块自己积分，抬手时交给引擎写回元素 */
  private pos = 0;
  /** LRU 次序计数 */
  private useSeq = 0;

  constructor(private deps: ScratchDeckDeps) {}

  /** 当前曲目的缓冲是否就绪（视图据此决定这次起手走完整音效还是轻量音效）。
   *  顺带把这一份记成「刚用过」：还挂在盘上的那张碟不该被后面的准备挤掉。 */
  prepared(key: string): boolean {
    const hit = this.entries.get(key);
    if (hit) hit.used = ++this.useSeq;
    return !!hit;
  }

  /** 只问有没有，不动 LRU 次序（视图每帧拿它看「缓冲刚备好了没」，见 player-view 的升级路径） */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** 这一首值不值得准备（时长已知时先问一句）：装不进预算就不必开始 —— 省下整轨流量与一次
   *  注定失败的下载。预算按保守的一档算（负速率还没探测出来时，宁可给它一个名额）。 */
  canPrepare(durationSec: number): boolean {
    if (!(durationSec > 0)) return true; // 时长未知（本地未播过的曲子）：放它去探测，探完再定夺
    return chooseScratchRate(durationSec, SCRATCH_BUDGET_BYTES / 2) !== null;
  }

  /** 后台准备：取料（字节 + 时长）→ 解码 →（必要时）建倒放副本。幂等：同键在途 / 已就绪都不重复，
   *  不同键并行（当前 + 下一首）—— 所以没有「后发起的把先发起的作废」这回事：谁回来谁进缓存。
   *  durationHint = 已知时长（0 = 还不知道，本地未播过的曲子要等探测）：够它先按预算筛一遍，
   *  装不下的曲子连整轨都不下（省流量，也别让就绪圈为它亮一下又灭）。
   *  load 由调用方给（本地 / 在线三路的取法与时长探测都在视图侧，本模块不认识音源）。
   *  返回 true = 这一首的账记下了（排上了 / 已经有了 / 装不下不必备），false = 在途满了没排上
   *  —— 调用方（预载表）据此回头再挂一次，否则连着切歌时后一首永远排不上队。 */
  prepare(key: string, durationHint: number, load: () => Promise<ScratchSource>): boolean {
    if (!key || this.entries.has(key) || this.inflight.has(key)) return true;
    if (this.inflight.size >= SCRATCH_MAX_INFLIGHT) return false; // 排不下：等一份回来再说（当前那首优先）
    this.inflight.add(key);
    const epoch = this.epoch;
    void (async () => {
      try {
        const negative = await this.negativeRate();
        // 预算：负速率不可用时倒放副本要占一半（见文件头注释）
        const budget = negative ? SCRATCH_BUDGET_BYTES : SCRATCH_BUDGET_BYTES / 2;
        if (durationHint > 0 && !chooseScratchRate(durationHint, budget)) return;
        const src = await load();
        if (epoch !== this.epoch || !src.bytes) return;
        const rate = chooseScratchRate(src.durationSec, budget);
        if (!rate) return; // 装不进预算：整首走轻量音效
        const buf = await this.decodeBytes(src.bytes, rate);
        if (epoch !== this.epoch) return;
        const entry: DeckEntry = {
          key,
          buffer: buf,
          reversed: null,
          bytes: bufferBytes(buf),
          used: ++this.useSeq,
          reverseSkipped: false,
        };
        this.entries.set(key, entry);
        this.bytes += entry.bytes;
        this.evict();
        if (!negative) this.buildReversed(entry); // 分片复制，别在播放中卡一下
      } catch (e) {
        console.warn('[vinyl] 搓碟缓冲准备失败（这首曲子只走轻量音效）', e);
      } finally {
        this.inflight.delete(key);
      }
    })();
    return true;
  }

  /** 起手：就绪才返回 true（返回后由 frame 驱动）。
   *  rate = 起手这一帧的倍速：按它起播，而不是按正常转速 —— 手指慢慢拖的时候，
   *  先响 16ms 的原速再切到 0.3 倍是听得出来的（耳朵先拿到错的音高）。
   *  返回 false 的两种情形（视图必须退回轻量音效，不能当成「在搓但没声」）：
   *  这一首没备好，或者声卡上下文建不出来。 */
  begin(key: string, time: number, rate = 0): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    const ctx = this.context();
    if (!ctx || !this.gain) return false;
    try {
      void ctx.resume?.();
    } catch {
      /* 已经在跑 / 拿不到 resume：不影响下面的调度 */
    }
    entry.used = ++this.useSeq;
    this.active = entry;
    this.setGain(this.volume(), ctx.currentTime);
    this.pos = clamp(time, 0, entry.buffer.duration);
    this.dir = 1;
    this.startSource(clampRate(rate));
    return true;
  }

  /** 每帧：按倍速推进位置并驱动声源（rate 为 0 = 按住不放，无声但位置不动） */
  frame(dtMs: number, rate: number): void {
    const entry = this.active;
    if (!entry) return;
    const dur = entry.buffer.duration;
    const dt = Math.max(0, Math.min(dtMs, MAX_FRAME_MS)) / 1000;
    this.pos = clamp(this.pos + rate * dt, 0, dur);
    // 顶到头（正着播到末尾 / 倒着播回开头）：这一程的声源到此为止，摘掉它。
    // 不摘的话，手指往回拖时 playbackRate 写在一个已经结束的节点上 —— 位置照走，一声不吭。
    if ((rate > 0 && this.pos >= dur) || (rate < 0 && this.pos <= 0)) {
      this.stopSource(0);
      this.src = null;
      return;
    }
    // 上一程没起成（倒放副本还在复制 / 刚从头顶回来）：这一帧补起，并把增益拉回正常
    if (!this.src) {
      this.openSource(rate);
      return;
    }
    const nextDir: 1 | -1 = rate > 0 ? 1 : rate < 0 ? -1 : this.dir;
    if (!this.negative && nextDir !== this.dir) {
      this.swap(nextDir, rate);
      return;
    }
    this.src.playbackRate.value = this.negative ? rate : Math.abs(rate);
  }

  /** 当前位置（秒） */
  position(): number {
    return this.pos;
  }

  /** 抬手：渐弱收尾，返回最终位置（交给引擎写回元素）。
   *  收尾比换向的包络长得多：这几十分之一是留给元素接回来的（seek + play 有延迟），
   *  两边叠着淡出淡入，听不出接缝；直接掐掉就是一个窟窿。 */
  end(): number {
    const ctx = this.ctx;
    if (ctx && this.gain) {
      const t = ctx.currentTime;
      this.setGain(0, t, RELEASE_FADE_SEC);
      this.stopSource(t + RELEASE_FADE_SEC);
    } else {
      this.stopSource(0);
    }
    return this.pos;
  }

  /** 释放（关视图 / 切到轻量档）：停声、丢掉全部缓存、关上下文 */
  dispose(): void {
    this.epoch++; // 在途的准备从此作废（不许再往缓存里塞，也不许把声卡重新建起来）
    this.inflight.clear();
    this.stopSource(0);
    this.entries.clear();
    this.bytes = 0;
    this.active = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.gain = null;
    try {
      void ctx?.close?.();
    } catch {
      /* 关不掉（已经关了 / 实现不全）：引用已断，交给 GC */
    }
  }

  // —— 内部 ——

  private volume(): number {
    const v = this.deps.volume();
    return isFinite(v) ? clamp(v, 0, 1) : 1;
  }

  private context(): AudioContextLike | null {
    if (this.ctx) return this.ctx;
    try {
      const Ctor = (globalThis as unknown as { AudioContext?: new () => AudioContextLike })
        .AudioContext;
      const ctx = this.deps.createContext ? this.deps.createContext() : Ctor ? new Ctor() : null;
      if (!ctx) return null;
      this.ctx = ctx;
      this.gain = ctx.createGain();
      this.gain.connect(ctx.destination);
    } catch (e) {
      console.warn('[vinyl] 搓碟台建不起来（只走轻量音效）', e);
      this.ctx = null;
      this.gain = null;
    }
    return this.ctx;
  }

  private negativeRate(): Promise<boolean> {
    const probe = this.deps.negativeRate ?? supportsNegativeRate;
    return Promise.resolve(probe()).then((v) => {
      this.negative = !!v;
      return this.negative;
    });
  }

  private decodeBytes(bytes: ArrayBuffer, sampleRate: number): Promise<AudioBufferLike> {
    if (this.deps.decode) return this.deps.decode(bytes, sampleRate);
    const Ctor = (
      globalThis as unknown as {
        OfflineAudioContext?: new (c: number, l: number, r: number) => {
          decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
        };
      }
    ).OfflineAudioContext;
    if (!Ctor) return Promise.reject(new Error('no OfflineAudioContext'));
    // 低采样率解码：decodeAudioData 按上下文的采样率重采样 —— 这是省内存的关键一步
    return new Ctor(SCRATCH_CHANNELS, 1, sampleRate).decodeAudioData(bytes);
  }

  /** 增益：撤销还没走完的自动化，再从当前值走到目标（不给时长就立刻到）。
   *  撤销这一步是必须的：换向时上一次的「淡出 → 淡入」还排在时间轴上，不撤就叠在一起，
   *  增益可能被压在 0 上再也起不来 —— 听感就是「手还在盘上，声音却没了」。 */
  private setGain(to: number, at: number, durationSec = 0): void {
    const p = this.gain?.gain;
    if (!p) return;
    try {
      p.cancelScheduledValues(at);
    } catch {
      /* 实现不全（老内核 / 替身）：退回只写目标值 */
    }
    if (durationSec > 0) {
      p.setValueAtTime(p.value, at);
      p.linearRampToValueAtTime(to, at + durationSec);
      return;
    }
    p.setValueAtTime(to, at);
  }

  /** 起一程声源，并把增益拉回本次会话的音量。begin 与「顶到头之后往回拖」都走这里 ——
   *  后者接在一次收尾之后，增益还压在 0 上，不拉回来就是哑的。 */
  private openSource(rate: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.setGain(this.volume(), ctx.currentTime);
    this.startSource(rate);
  }

  /** 起一个源：负速率可用时用原缓冲 + 带符号倍速；否则正向用原缓冲、反向用倒放副本。
   *  fade > 0 时延后一点起播（让增益包络先把上一程收掉）。 */
  private startSource(rate: number, fade = 0): void {
    const ctx = this.ctx;
    const entry = this.active;
    const gain = this.gain;
    if (!ctx || !entry || !gain) return;
    const buf = this.negative || this.dir > 0 ? entry.buffer : this.ensureReversed(entry);
    if (!buf) {
      this.src = null; // 倒放副本还没就绪：这一程无声（位置照走）
      return;
    }
    const offset =
      this.negative || this.dir > 0 ? this.pos : Math.max(0, entry.buffer.duration - this.pos);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.playbackRate.value = this.negative ? rate : Math.abs(rate);
    node.connect(gain);
    const when = ctx.currentTime + fade;
    const maxOffset = Math.max(0, buf.duration - 1e-3);
    try {
      node.start(when, clamp(offset, 0, maxOffset));
    } catch {
      // 某些实现对「起点 + 偏移」挑剔：退到立即起播（偏移已 clamp，正常不会再抛）
      try {
        node.start(0, clamp(offset, 0, maxOffset));
      } catch {
        return;
      }
    }
    this.src = node;
  }

  /** 方向翻转：把当前源按增益包络收掉，另一条路起新的（翻转发生在速度过零处，听不出接缝）。
   *  三拍都走 setGain（先撤后排）：连着几下快速换向也不会把增益叠成一团。 */
  private swap(dir: 1 | -1, rate: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.gain) return;
    const t = ctx.currentTime;
    this.setGain(0, t, FADE_SEC);
    this.stopSource(t + FADE_SEC);
    this.dir = dir;
    this.startSource(rate, FADE_SEC);
    this.setGain(this.volume(), t + FADE_SEC, FADE_SEC);
  }

  private stopSource(when: number): void {
    const src = this.src;
    this.src = null;
    if (!src) return;
    try {
      src.stop(when);
    } catch {
      /* 还没 start / 已经停过：忽略 */
    }
  }

  /** 分片复制倒放副本（正序数据倒着写）：一次复制完会卡住界面，所以按块让出主线程。
   *  速度：22.05 kHz 的 4 分钟曲子 ≈ 2×21M 个采样，分十几块、总计 ~100ms。 */
  private buildReversed(entry: DeckEntry): void {
    const ctx = this.ctx ?? this.context();
    const b = entry.buffer;
    if (!ctx) return;
    const size = bufferBytes(b);
    if (size > SCRATCH_BUDGET_BYTES / 2 || this.bytes + size > SCRATCH_CACHE_BYTES) {
      entry.reverseSkipped = true; // 预算之外：反向安静，位置照走
      return;
    }
    let out: AudioBufferLike;
    try {
      out = ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
    } catch {
      entry.reverseSkipped = true;
      return;
    }
    const schedule = this.deps.schedule ?? ((fn) => window.setTimeout(fn, 0));
    const chunk = 1 << 19;
    let ch = 0;
    let i = 0;
    const step = () => {
      if (!this.entries.has(entry.key)) return; // 已被淘汰 / 释放：这一份作废
      const src = b.getChannelData(ch);
      const dst = out.getChannelData(ch);
      const n = Math.min(b.length, src.length, dst.length);
      const end = Math.min(n, i + chunk);
      for (; i < end; i++) dst[i] = src[n - 1 - i];
      if (i < n) {
        schedule(step);
        return;
      }
      ch++;
      i = 0;
      if (ch < b.numberOfChannels) {
        schedule(step);
        return;
      }
      entry.reversed = out;
      entry.bytes += size;
      this.bytes += size;
      this.evict();
    };
    schedule(step);
  }

  private ensureReversed(entry: DeckEntry): AudioBufferLike | null {
    return entry.reverseSkipped ? null : entry.reversed;
  }

  /** 淘汰：先按份数、再按总内存，丢最久没用过的那份（正在搓的那份不丢） */
  private evict(): void {
    while (this.entries.size > SCRATCH_CACHE_TRACKS || this.bytes > SCRATCH_CACHE_BYTES) {
      let victim: DeckEntry | null = null;
      for (const e of this.entries.values()) {
        if (e === this.active) continue;
        if (!victim || e.used < victim.used) victim = e;
      }
      if (!victim) return; // 只剩正在搓的那份：宁可超一点，也不能把它抽走
      this.entries.delete(victim.key);
      this.bytes -= victim.bytes;
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
