// 本地音频的**内嵌**标签（ID3v2 / Vorbis comment / MP4 ilst）：曲名、艺人、专辑、音轨号。
//
// 为什么要自己解：本地音轨此前只能拿文件名当曲名（`01 - 曲名.mp3` 还算能看，`track01.mp3` 就完蛋）。
// 与「不读内嵌歌词」那条取舍（见 README 6.2.5）不同 —— 标签是**每首歌的身份**，曲名错了
// 队列、统计、歌词匹配跟着一起错；而读它只需要文件头几百 KB，不必解码音频容器。
//
// 为什么不用 music-metadata 之类的库：它会进产物体积（预算 540 KB，现在离顶还有 25 KB），
// 而这里只要四个文本字段。自己解的成本就是下面这些字节搬运 —— 全是纯函数，能拿合成数据断言。
//
// 支持：ID3v2.2/2.3/2.4（mp3）、Vorbis comment（flac / ogg / opus）、MP4 ilst（m4a / mp4 / aac）。
// 不支持：ID3v1（只在文件尾部，老掉牙）、APE、WMA、内嵌封面（封面另有出口：笔记的 cover 与
// 约定的封面文件名；把图从音频里抠出来要连图片格式一起处理，等真有人要再说）。
// 读不到的字段一律缺省：调用方回退文件名 / 笔记里的艺人（见 local-source 的 trackOf）。

/** 标签前缀读多少字节：ID3v2 与 Vorbis comment 都在文件头，MP4 的 moov 通常也在。
 *  128 KB 覆盖绝大多数（文本帧一共才几百字节）；前面挂了大图的 ID3v2 会自己声明更长的长度，
 *  那时按声明补读一次（见 audioTagReadHint）—— 整张专辑二十首也就读几 MB 的头。 */
export const TAG_PREFIX_BYTES = 128 * 1024;

/** 补读的上限：别被一个畸形 / 恶意的头部长度骗着把整个文件读进内存 */
export const TAG_MAX_BYTES = 4 * 1024 * 1024;

export interface AudioTags {
  title?: string;
  artist?: string;
  album?: string;
  /** 音轨号（TRCK / TRACKNUMBER / trkn 的第一个数）：用来排曲目顺序 */
  track?: number;
}

/** 解析文件头里的内嵌标签。认不出格式 / 没有标签时返回空对象（不是 null：调用方统一按「有没有字段」处理）。 */
export function parseAudioTags(buf: Uint8Array): AudioTags {
  if (!buf || buf.length < 12) return {};
  if (startsWith(buf, 'ID3')) return parseId3v2(buf);
  if (startsWith(buf, 'fLaC')) return parseFlac(buf);
  if (startsWith(buf, 'OggS')) return parseOgg(buf);
  // MP4：盒子的头 4 字节是**长度**（常以 0 开头），类型在第 4 字节起 —— 别拿 startsWith 去比 0 号位
  const mp4Type = ascii(buf, 4, 4);
  if (mp4Type === 'ftyp' || mp4Type === 'moov') return parseMp4(buf);
  return {};
}

/** 光凭这段前缀还不够吗？返回还想读到的总字节数（0 = 够了）。
 *  ID3v2 在头部第三个字节之后是 4 字节的 syncsafe 长度，声明得比前缀长时按它补读（封顶 TAG_MAX_BYTES）。 */
export function audioTagReadHint(buf: Uint8Array): number {
  if (buf.length < 10 || !startsWith(buf, 'ID3')) return 0;
  const size = syncSafe(buf, 6, 4);
  const total = 10 + size;
  if (total <= buf.length) return 0;
  return Math.min(total, TAG_MAX_BYTES);
}

// ==================== ID3v2 ====================

/** ID3v2.2 用 3 字节帧 ID，2.3/2.4 用 4 字节；文本帧的 ID 表按版本各一套 */
const ID3_TEXT_FRAMES: Record<string, keyof AudioTags> = {
  // 2.3 / 2.4
  TIT2: 'title',
  TPE1: 'artist',
  TALB: 'album',
  TRCK: 'track',
  // 2.2
  TT2: 'title',
  TP1: 'artist',
  TAL: 'album',
  TRK: 'track',
};

function parseId3v2(buf: Uint8Array): AudioTags {
  const major = buf[3];
  if (major < 2 || major > 4) return {};
  const flags = buf[5];
  let at = 10;
  // 2.3 / 2.4 的扩展头（2.2 没有）：跳过它，否则第一个帧就解歪
  if (flags & 0x40) {
    if (major === 3) {
      const ext = readU32(buf, at);
      at += 4 + ext;
    } else if (major === 4) {
      const ext = syncSafe(buf, at, 4);
      at += ext;
    }
  }
  const idLen = major === 2 ? 3 : 4;
  const headerLen = major === 2 ? 6 : 10;
  const out: AudioTags = {};
  while (at + headerLen <= buf.length) {
    const id = ascii(buf, at, idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break; // 填充区（0x00）或越界：停
    // 2.2 是 3 字节长度；2.3 是普通 32 位；2.4 是 syncsafe —— 三种写法都要认
    const size = major === 2 ? (buf[at + 3] << 16) | (buf[at + 4] << 8) | buf[at + 5] : major === 3 ? readU32(buf, at + 4) : syncSafe(buf, at + 4, 4);
    const body = at + headerLen;
    if (size <= 0 || body + size > buf.length) break;
    const field = ID3_TEXT_FRAMES[id];
    if (field) {
      const text = decodeText(buf.subarray(body, body + size)).trim();
      if (text) assign(out, field, text);
    }
    at = body + size;
  }
  return out;
}

/** 文本帧：第一个字节是编码（0=ISO-8859-1 / 1=UTF-16 带 BOM / 2=UTF-16BE / 3=UTF-8），
 *  其后是正文，可能带结尾的 \0（帧内多值时用 \0 分隔，这里只取第一段）。 */
function decodeText(bytes: Uint8Array): string {
  if (!bytes.length) return '';
  const enc = bytes[0];
  let body = bytes.subarray(1);
  let text = '';
  if (enc === 1 || enc === 2) {
    const little = enc === 1 && body.length >= 2 && body[0] === 0xff && body[1] === 0xfe;
    if (enc === 1) body = body.subarray(2); // 去掉 BOM
    text = decodeUtf16(body, little);
  } else if (enc === 3) {
    text = utf8(body);
  } else {
    text = latin1(body);
  }
  return text.split('\0')[0] ?? '';
}

// ==================== FLAC / Ogg（Vorbis comment） ====================

function parseFlac(buf: Uint8Array): AudioTags {
  let at = 4; // fLaC
  while (at + 4 <= buf.length) {
    const header = buf[at];
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const size = (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3];
    at += 4;
    if (type === 4) return parseVorbisComment(buf.subarray(at, at + size));
    at += size;
    if (last) break;
  }
  return {};
}

/** Ogg：注释块在第一个或第二个包里（Vorbis 是 \x03vorbis 之后，Opus 是 OpusTags 之后）。
 *  不去解 Ogg 页分片：标签都很小，一定落在最前面几个包里，直接扫标记更省事也够稳。 */
function parseOgg(buf: Uint8Array): AudioTags {
  const vorbis = indexOf(buf, [0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]); // "\x03vorbis"
  if (vorbis >= 0) return parseVorbisComment(buf.subarray(vorbis + 7));
  const opus = indexOf(buf, asciiBytes('OpusTags'));
  if (opus >= 0) return parseVorbisComment(buf.subarray(opus + 8));
  return {};
}

/** Vorbis comment：vendor 长度 + vendor + 条数 + （长度 + "KEY=值"）× N。键不分大小写。 */
function parseVorbisComment(buf: Uint8Array): AudioTags {
  let at = 0;
  const vendorLen = readU32le(buf, at);
  if (vendorLen < 0 || at + 4 + vendorLen + 4 > buf.length) return {};
  at += 4 + vendorLen;
  const count = readU32le(buf, at);
  at += 4;
  const out: AudioTags = {};
  for (let i = 0; i < count && at + 4 <= buf.length; i++) {
    const len = readU32le(buf, at);
    at += 4;
    if (len < 0 || at + len > buf.length) break;
    const line = utf8(buf.subarray(at, at + len));
    at += len;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toUpperCase();
    const value = line.slice(eq + 1).trim();
    if (!value) continue;
    if (key === 'TITLE') assign(out, 'title', value);
    else if (key === 'ARTIST') assign(out, 'artist', value);
    else if (key === 'ALBUM') assign(out, 'album', value);
    else if (key === 'TRACKNUMBER') assign(out, 'track', value);
  }
  return out;
}

// ==================== MP4 / M4A ====================

/** moov.udta.meta.ilst：每个条目下挂一个 data 盒，前 8 字节是类型与区域设置，其后才是内容。
 *  条目名是 ©nam / ©ART / ©alb（© 是 0xA9）与 trkn（二进制）。
 *  路径要一层层下：moov 的孩子是 mvhd/trak/udta…，ilst 藏在 udta.meta 里面，
 *  直接拿 moov 的范围找 ilst 是找不到的（盒子解析最容易在这里想当然）。 */
function parseMp4(buf: Uint8Array): AudioTags {
  const moov = findBox(buf, 0, buf.length, 'moov');
  if (!moov) return {};
  const udta = findBox(buf, moov.start, moov.end, 'udta');
  if (!udta) return {};
  const meta = findBox(buf, udta.start, udta.end, 'meta');
  if (!meta) return {};
  // meta 是 full box（版本 4 字节之后才是子盒）；个别写入器不写那 4 字节，两条路都试
  const ilst = findBox(buf, meta.start + 4, meta.end, 'ilst') ?? findBox(buf, meta.start, meta.end, 'ilst');
  if (!ilst) return {};
  const out: AudioTags = {};
  let at = ilst.start;
  while (at + 8 <= ilst.end) {
    const size = readU32(buf, at);
    const name = latin1(buf.subarray(at + 4, at + 8));
    const end = size >= 8 ? at + size : ilst.end;
    if (end > ilst.end) break;
    const data = findBox(buf, at + 8, end, 'data');
    if (data && data.end - data.start > 8) {
      const body = buf.subarray(data.start + 8, data.end);
      if (name === '©nam') assign(out, 'title', utf8(body).trim());
      else if (name === '©ART' || name === 'aART') assign(out, 'artist', utf8(body).trim());
      else if (name === '©alb') assign(out, 'album', utf8(body).trim());
      else if (name === 'trkn' && body.length >= 4) {
        const n = (body[2] << 8) | body[3];
        if (n > 0) out.track = n;
      }
    }
    at = end;
  }
  return out;
}

/** 在 [from, to) 里找一个盒子；只找同一层（不做递归，够用且不会误撞子盒里的同名） */
function findBox(buf: Uint8Array, from: number, to: number, name: string): { start: number; end: number } | null {
  let at = from;
  while (at + 8 <= to) {
    let size = readU32(buf, at);
    const type = latin1(buf.subarray(at + 4, at + 8));
    let header = 8;
    if (size === 1) {
      // 64 位长度：高 32 位在 type 之后
      if (at + 16 > to) return null;
      size = readU32(buf, at + 12); // 低 32 位足够（>4GB 的音频不在考虑范围）
      header = 16;
    } else if (size === 0) {
      size = to - at; // 一直到末尾
    }
    if (size < header || at + size > to) return null;
    if (type === name) return { start: at + header, end: at + size };
    at += size;
  }
  return null;
}

// ==================== 小工具（都是纯字节搬运，别引 Buffer：vm 沙箱里可能没有） ====================

function startsWith(buf: Uint8Array, text: string): boolean {
  return ascii(buf, 0, text.length) === text;
}

function ascii(buf: Uint8Array, at: number, len: number): string {
  let out = '';
  for (let i = 0; i < len && at + i < buf.length; i++) {
    const c = buf[at + i];
    if (c === 0) break; // 0 是填充，不要带进字符串
    out += String.fromCharCode(c);
  }
  return out;
}

function asciiBytes(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

function latin1(buf: Uint8Array): string {
  return BufferLike.fromCharCodes(buf);
}

function utf8(buf: Uint8Array): string {
  // TextDecoder 在插件环境与测试沙箱里都有（宿主与 Node 都实现了）
  try {
    return new TextDecoder('utf-8').decode(buf);
  } catch {
    return BufferLike.fromCharCodes(buf);
  }
}

function decodeUtf16(buf: Uint8Array, little: boolean): string {
  let out = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const code = little ? buf[i] | (buf[i + 1] << 8) : (buf[i] << 8) | buf[i + 1];
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

/** 兜底解码：没有 TextDecoder 时按单字节拼（至少不抛） */
const BufferLike = {
  fromCharCodes(buf: Uint8Array): string {
    let out = '';
    for (let i = 0; i < buf.length; i++) out += String.fromCharCode(buf[i]);
    return out;
  },
};

function indexOf(buf: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= buf.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function readU32(buf: Uint8Array, at: number): number {
  return ((buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]) >>> 0;
}

function readU32le(buf: Uint8Array, at: number): number {
  if (at + 4 > buf.length) return -1;
  return (buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)) >>> 0;
}

/** ID3v2 的 syncsafe 整数：每字节只用低 7 位（最高位恒为 0，免得被误认成帧同步） */
function syncSafe(buf: Uint8Array, at: number, len: number): number {
  let out = 0;
  for (let i = 0; i < len; i++) out = (out << 7) | (buf[at + i] & 0x7f);
  return out;
}

/** 赋值：数值字段走同一个 key 名，字符串字段只在非空时写入 */
function assign(out: AudioTags, field: keyof AudioTags, value: string): void {
  if (field === 'track') {
    const n = Number((/-?\d+/.exec(value) || [''])[0]);
    if (Number.isFinite(n) && n > 0) out.track = n;
    return;
  }
  if (value) out[field] = value;
}
