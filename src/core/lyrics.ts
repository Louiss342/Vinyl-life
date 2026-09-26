// 歌词：解析（LRC → 行）+ 定位（时间 → 第几行）+ 滚动计划（时间 → 从哪滚到哪、进度多少）
// + 景深档位（行号 → 离当前行多远）+ 视觉中心（滚动位置 → 画面正中是第几行）+ 回位缓动。
//
// 为什么这些都做成纯函数：它们都是「时间 / 位置 → 位置」的换算，错了就是「歌词和声音对不上」
// 或「高亮跑到了别处」，而这恰恰能脱离 DOM 验证（滚动顺不顺是观感，滚到哪一行是正确性）。
// 视图只负责把计划变成像素（offsetTop）与一帧一帧的 rAF —— 换任何渲染方式，这一层都不用动。
//
// 两套参考系，别混：
//   ① **时间**（activeLineIndex / lineProgress）：哪一句正在被唱 —— 卡拉OK填充走它；
//   ② **位置**（centerLineIndex / lineDepth）：画面正中是哪一句 —— 高亮与景深走它。
// 自动跟随时两者是同一句（滚动计划把正在唱的那句摆到正中）；用户自己滚动时参考系②接管，
// 「视觉中心」跟着手走，停手几秒后再平滑回到正在唱的那一句。
//
// 滚动是**连续**的（用户按参考效果定的）：两行之间的全部时间都在走，唱到哪画面就走到哪，
// 没有静止期。旧版是「预滚动」——把移动压在换行前的 620ms 里、其余时间静止（取向是
//「读词时画面要稳」），两者是同一段路程的两种走法，换成连续就是为了「跟着唱走」。

export interface LyricLine {
  /** 行首时间戳（毫秒） */
  at: number;
  /** 正文；空串 = 这一行只有时间戳（间奏 / 纯音乐段落），视图会画成音符 */
  text: string;
  /** 翻译（网易云 tlyric / QQ 的 trans）：时间戳对上的那一条 */
  trans?: string;
}

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
/** 元数据标签（[ti:] / [ar:] / [al:] / [by:] / [offset:] …）：不是歌词行 */
const META_TAG = /^\[[a-zA-Z]+:/;

/** 时间戳 → 毫秒：小数部分 1 位 = 百毫秒、2 位 = 厘秒、3 位 = 毫秒（三种写法都见过） */
function tagToMs(m: RegExpExecArray): number {
  const min = Number(m[1]);
  const sec = Number(m[2]);
  const frac = m[3] ?? '';
  const ms = frac.length === 1 ? Number(frac) * 100 : frac.length === 2 ? Number(frac) * 10 : Number(frac);
  return (min * 60 + sec) * 1000 + (frac ? ms : 0);
}

/** `[offset:+1234]`：整篇的全局时间补偿（毫秒）。
 *  符号方向各家实现不一致（Wikipedia 与多数播放器：正值 = 歌词提前；少数库反着来），
 *  本仓库采用**正值 = 歌词提前**，即每行时间戳减去 offset —— 想反过来改这一处即可。
 *  这条标签在本地 .lrc 里很常见（翻唱 / 不同版本对齐用），不处理就是整篇系统性偏一口。 */
const OFFSET_TAG = /^\[offset:\s*([+-]?\d+)\s*\]/i;

function parseOffsetMs(raw: string): number {
  for (const rawLine of String(raw ?? '').split(/\r?\n/)) {
    const m = OFFSET_TAG.exec(rawLine.trim());
    if (m) return Number(m[1]) || 0;
  }
  return 0;
}

/** LRC 文本 → 带时间的行（不做翻译配对，内部用）。
 *  offsetMs 由调用方从正文里读出来：翻译轨与主歌词共用同一份（两边配对靠时间戳全等，
 *  各减各的会让它们直接对不上）。 */
function parseTimedLines(raw: string, offsetMs: number): Array<{ at: number; text: string }> {
  const out: Array<{ at: number; text: string }> = [];
  for (const rawLine of String(raw ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || META_TAG.test(line)) continue;
    // 一行可以挂多个时间戳（副歌「[00:12.00][01:30.00]同一句」）：每个时间戳都出一行
    TIME_TAG.lastIndex = 0;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = TIME_TAG.exec(line))) stamps.push(tagToMs(m));
    if (!stamps.length) continue;
    const text = line.replace(TIME_TAG, '').trim();
    // 补偿后夹在 0 以上：负时间戳没有对应的播放时刻，留着只会让「当前行」多出一条永不结束的
    for (const at of stamps) out.push({ at: Math.max(0, at - offsetMs), text });
  }
  // 时间戳可能不是升序（少量平台如此）：排完序再交给二分，否则定位会错
  return out.sort((a, b) => a.at - b.at);
}

/** 解析歌词：主歌词 + 可选翻译（按时间戳配对）。没有可用的行时返回空数组。 */
export function parseLrc(lyric: string, trans?: string): LyricLine[] {
  const offset = parseOffsetMs(lyric);
  const main = parseTimedLines(lyric, offset);
  if (!main.length) return [];
  const byTime = new Map<number, string>();
  for (const l of parseTimedLines(trans ?? '', offset)) {
    if (l.text) byTime.set(l.at, l.text);
  }
  return main.map((l) => (byTime.has(l.at) ? { at: l.at, text: l.text, trans: byTime.get(l.at) } : l));
}

/**
 * 字节 → 歌词文本（本地 .lrc 用）。UTF-8 优先，整篇不是合法 UTF-8 时按 GBK 再解一次 ——
 * 中文歌词站导出的 .lrc 至今仍有 GBK / GB18030 的，按 UTF-8 硬解就是满屏乱码，
 * 而这是「本地歌词」这条路上最常见的坑。BOM 交给 TextDecoder 自己剥（默认行为）。
 * 两种都解不了（二进制垃圾）时退回宽容模式的 UTF-8：宁可带几个替换符，也不要空着。
 */
export function decodeLyricBytes(bytes: ArrayBuffer | Uint8Array): string {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return new TextDecoder('utf-8').decode(buf);
    }
  }
}

/** 这一时刻唱到第几行：最后一条 `at <= tMs`。返回 -1 = 还没到第一行。 */
export function activeLineIndex(lines: LyricLine[], tMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].at <= tMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** 景深档位上限：再远的行已经落进容器的上下渐隐里了，夹住让 CSS 的 calc 有界 */
export const MAX_LYRIC_DEPTH = 5;

/**
 * 视觉中心：此刻离滚动容器正中最近的是第几行（`offsets` = 各行中心的升序像素位置）。
 * 用户自己滚动时高亮跟着它走 —— 滚到哪，哪一句就是画面中心。
 * 返回 -1 = 还没有行。
 */
export function centerLineIndex(offsets: number[], scrollTop: number, viewport: number): number {
  if (!offsets.length) return -1;
  const center = scrollTop + viewport / 2;
  // 二分找第一个「中心 >= 视觉中心」的行，最接近的只可能是它或它前面那一行
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < center) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(offsets[lo - 1] - center) <= Math.abs(offsets[lo] - center)) return lo - 1;
  return lo;
}

/** 回位缓动：两端慢、中间快。停手后从用户停的地方平滑回到正在唱的那一句用。 */
export function easeInOutCubic(p: number): number {
  const x = Math.min(1, Math.max(0, p));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * 这一行离「正在唱的那一行」有多远（0 = 正在唱），视图拿它写 `--vinyl-lyric-d`：
 * 远端行渐淡、略小（见 styles.css 的 .vinyl-lyric-line）。
 * 还没唱到第一行（active < 0）时把第 0 行当作当前行 —— 开场前那一句也该是清晰的。
 */
export function lineDepth(index: number, active: number): number {
  if (active < 0) return Math.min(index, MAX_LYRIC_DEPTH);
  return Math.min(Math.abs(index - active), MAX_LYRIC_DEPTH);
}

export interface ScrollPlan {
  /** 从哪一行滚向哪一行（from === to = 不动：还没到第一行 / 已经是最后一行） */
  from: number;
  to: number;
  /** 这段的进度 0..1（视图拿它做像素插值） */
  progress: number;
}

/**
 * 滚动计划：`tMs` 时刻歌词列表应该「从第 from 行滚到第 to 行、走了 progress」。
 *
 * 连续滚动：用掉的是两行之间的**全部**时间，从「当前行居中」走到「下一行居中」——
 * 唱到哪就走到哪（短句走得快、长句走得慢，速度跟着歌唱走），任何时刻都在动。
 *
 * 为什么是线性而不是缓动：缓动两端速度为 0，那正好又变回静止期（就是要取消的东西）。
 * 位置还必须单调 —— 词只能朝一个方向走，回弹会让人看到画面「倒退」。
 */
export function scrollPlan(lines: LyricLine[], tMs: number): ScrollPlan {
  const active = activeLineIndex(lines, tMs);
  if (active < 0) return { from: 0, to: 0, progress: 0 }; // 还没到第一行
  const next = active + 1;
  if (next >= lines.length) return { from: active, to: active, progress: 0 }; // 最后一行之后没处去
  const gap = lines[next].at - lines[active].at;
  if (gap <= 0) return { from: active, to: next, progress: 1 }; // 同一时刻的两行：直接落位
  const progress = Math.min(1, Math.max(0, (tMs - lines[active].at) / gap));
  return { from: active, to: next, progress };
}

/** 当前行的推进比例（0..1）：行内卡拉OK式填充用。
 *  时间够上下文（下一行的 at），没有下一行就按 4 秒兜底；间奏行（没有文字）恒为 1（不做填充）。 */
export function lineProgress(lines: LyricLine[], index: number, tMs: number): number {
  const line = lines[index];
  if (!line || !line.text) return 1;
  const end = lines[index + 1]?.at ?? line.at + 4000;
  const span = Math.max(1, end - line.at);
  return Math.min(1, Math.max(0, (tMs - line.at) / span));
}
