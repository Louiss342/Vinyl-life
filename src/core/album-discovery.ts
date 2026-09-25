import { App } from 'obsidian';
import { AlbumInfo, findAlbumNotes, getAlbumInfo } from './album-index';
import { isRateLimited } from './request-error';
import { tf } from './i18n';
import type { NeteaseService } from './netease';
import type { QqService } from './qq';
import type { KugouService } from './kugou';
import type {
  KugouSearchResponse,
  NeteaseSearchAlbum,
  NeteaseSearchResponse,
  NeteaseSearchSong,
  QqSearchAlbum,
  QqSearchResponse,
  QqSearchSong,
} from './api-types';

export type MusicSource = 'netease' | 'qq' | 'kugou';
export type AlbumMatchKind = 'album' | 'track';

export interface AlbumSearchCandidate {
  key: string;
  source: MusicSource;
  sourceAlbumId: string;
  title: string;
  artists: string[];
  coverUrl?: string;
  releaseDate?: string;
  trackCount?: number;
  matchedBy: AlbumMatchKind;
  matchedTrack?: string;
  /** 本轮本地重排的相关度（0..100）。只给剪尾和测试看，界面不展示这个数 */
  score?: number;
  /** 同平台同 id 已经明确入库：界面显示「已在收藏」，不再给「添加」 */
  inLibrary?: boolean;
  /** 库里有一张同名的（另一个平台 / 未记 id）：只提示一声，仍可添加 */
  nameInLibrary?: boolean;
}

export interface AlbumSearchResult {
  items: AlbumSearchCandidate[];
  warnings: Array<{ source: MusicSource; message: string }>;
  /** 结果里已在收藏的条数（状态行用来说「其中 N 张已在收藏」） */
  owned: number;
  /** 上游还有没有下一页：界面靠它决定「加载更多」还要不要发请求 */
  hasMore: boolean;
}

export interface AlbumDiscoveryContext {
  app: App;
  client: Pick<NeteaseService, 'searchAlbums' | 'searchSongs'>;
  qq: Pick<QqService, 'search'>;
  /** 酷狗搜索（网关单通道；未登录也能搜到免费曲库） */
  kugou: Pick<KugouService, 'search'>;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function yearOf(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  if (/^\d{4}/.test(raw) && Number(raw.slice(0, 4)) >= 1900) return raw.slice(0, 10);
  const time = Number(raw);
  if (!Number.isFinite(time) || time <= 0) return undefined;
  const year = new Date(time).getFullYear();
  return Number.isFinite(year) ? String(year) : undefined;
}

function neteaseArtists(item: NeteaseSearchAlbum | NeteaseSearchSong): string[] {
  const many = 'artists' in item ? item.artists : undefined;
  const ar = 'ar' in item ? item.ar : undefined;
  const one = 'artist' in item ? item.artist : undefined;
  return (many || ar || (one ? [one] : []))
    .map((artist) => text(artist?.name))
    .filter(Boolean);
}

export function normalizeNeteaseSearch(
  albumsBody: NeteaseSearchResponse,
  songsBody: NeteaseSearchResponse
): AlbumSearchCandidate[] {
  const albums = (albumsBody.result?.albums || []).flatMap((album) => {
    if (
      album.available === false ||
      (album.status != null && Number(album.status) < 0) ||
      (album.size != null && Number(album.size) <= 0)
    ) return [];
    const id = text(album.id);
    const title = text(album.name);
    if (!id || !title) return [];
    return [{
      key: `netease:${id}`,
      source: 'netease' as const,
      sourceAlbumId: id,
      title,
      artists: neteaseArtists(album),
      coverUrl: text(album.picUrl) || undefined,
      releaseDate: yearOf(album.publishTime),
      trackCount: Number(album.size) || undefined,
      matchedBy: 'album' as const,
    }];
  });
  const songs = (songsBody.result?.songs || []).flatMap((song) => {
    if (
      song.available === false ||
      (song.status != null && Number(song.status) < 0) ||
      Number(song.copyrightId) === 0
    ) return [];
    const album = song.al || song.album;
    const id = text(album && 'id' in album ? album.id : undefined);
    const title = text(album?.name);
    if (!id || !title) return [];
    return [{
      key: `netease:${id}`,
      source: 'netease' as const,
      sourceAlbumId: id,
      title,
      artists: neteaseArtists(song),
      coverUrl: text(album?.picUrl) || undefined,
      releaseDate: yearOf('publishTime' in album ? album.publishTime : undefined),
      matchedBy: 'track' as const,
      matchedTrack: text(song.name) || undefined,
    }];
  });
  return dedupe([...albums, ...songs]);
}

export function normalizeQqSearch(body: QqSearchResponse): AlbumSearchCandidate[] {
  const albums = (body.data?.albums || []).flatMap((album: QqSearchAlbum) => {
    if (album.available === false) return [];
    const id = text(album.mid);
    const title = text(album.name);
    if (!id || !title) return [];
    return [{
      key: `qq:${id}`,
      source: 'qq' as const,
      sourceAlbumId: id,
      title,
      artists: text(album.artist) ? [text(album.artist)] : [],
      coverUrl: text(album.coverUrl) || undefined,
      releaseDate: yearOf(album.publishTime),
      trackCount: Number(album.trackCount) || undefined,
      matchedBy: 'album' as const,
    }];
  });
  const songs = (body.data?.songs || []).flatMap((song: QqSearchSong) => {
    if (song.available === false) return [];
    const id = text(song.albumMid);
    const title = text(song.albumName);
    if (!id || !title) return [];
    return [{
      key: `qq:${id}`,
      source: 'qq' as const,
      sourceAlbumId: id,
      title,
      artists: text(song.artist) ? [text(song.artist)] : [],
      coverUrl: text(song.albumCover) || undefined,
      matchedBy: 'track' as const,
      matchedTrack: text(song.name) || undefined,
    }];
  });
  return dedupe([...albums, ...songs]);
}

export function normalizeKugouSearch(body: KugouSearchResponse): AlbumSearchCandidate[] {
  const albums = (body?.albums || []).flatMap((album) => {
    const id = text(album.id);
    const title = text(album.name);
    if (!id || !title) return [];
    return [{
      key: `kugou:${id}`,
      source: 'kugou' as const,
      sourceAlbumId: id,
      title,
      artists: text(album.artist) ? [text(album.artist)] : [],
      coverUrl: text(album.cover) || undefined,
      releaseDate: yearOf(album.publishDate),
      trackCount: Number(album.songCount) || undefined,
      matchedBy: 'album' as const,
    }];
  });
  const songs = (body?.songs || []).flatMap((song) => {
    // 单曲命中：专辑 id 与名字都在曲目上（与 QQ 同形），捞的是「搜歌名找专辑」这条路
    const id = text(song.albumId);
    const title = text(song.albumName);
    if (!id || !title) return [];
    return [{
      key: `kugou:${id}`,
      source: 'kugou' as const,
      sourceAlbumId: id,
      title,
      artists: text(song.artist) ? [text(song.artist)] : [],
      coverUrl: text(song.cover) || undefined,
      matchedBy: 'track' as const,
      matchedTrack: text(song.name) || undefined,
    }];
  });
  return dedupe([...albums, ...songs]);
}

function dedupe(items: AlbumSearchCandidate[]): AlbumSearchCandidate[] {
  const byKey = new Map<string, AlbumSearchCandidate>();
  for (const item of items) {
    const previous = byKey.get(item.key);
    if (!previous || (previous.matchedBy === 'track' && item.matchedBy === 'album')) {
      byKey.set(item.key, item);
    }
  }
  return [...byKey.values()];
}

// ============ 本地相关度（模糊重排） ============
// 上游只按自己的索引给结果：拼写差一两个字、词序颠倒、只记得标题后半截的查询，
// 它要么把对的那张排到很后面（前 10 条里根本没有），要么干脆塞一堆沾边的充数。
// 拿到更大的候选池后，本地按「文本上有多像」重排一遍，才能真正把对的捞上来。
// 分档（也是剪尾阈值的依据）：
//   ≥60 确有文本关联：标题 / 艺人 / 歌名整体命中，或分词全中
//   30..59 勉强关联：分词中了一部分，或拼写差一两个字（编辑距离近似）
//   <30 看不出关联：只是上游觉得沾边

const SPLIT_RE = /[\s\p{P}\p{S}]+/u;
const FOLD_RE = /[\s\p{P}\p{S}]+/gu;

/** 折叠：NFKC（全角→半角、兼容字符归位）+ 小写 + 去空白标点，用于「是否相等 / 是否包含」的比对。
 *  中文没有大小写，但中英混排、全角括号、书名号在曲名里很常见，折一下能省掉一堆假阴性。 */
function fold(value: string): string {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(FOLD_RE, '');
}

function tokenize(value: string): string[] {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().split(SPLIT_RE).filter(Boolean);
}

/** 有界编辑距离：超过预算立刻收工（模糊只看「够不够近」，不关心具体差多少）。 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev: number[] = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let cheapest = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < cheapest) cheapest = cur[j];
    }
    if (cheapest > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** 容错预算：一个词能错几个字。中文单字信息量大，不能按长度比例放大 —— 两个字的词错一个就是另一个词。 */
function typoBudget(length: number): number {
  if (length <= 2) return 0;
  if (length <= 5) return 1;
  if (length <= 10) return 2;
  return 3;
}

/** 相似度（0..1）：编辑距离折算；超出容错预算即 0（宁可不算，也别把不相干的算成相近）。 */
function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  const budget = typoBudget(longest);
  if (!longest || !budget) return 0;
  const distance = editDistance(a, b, budget);
  return distance > budget ? 0 : 1 - distance / longest;
}

/** 词级模糊命中：整串近似，或字段里存在一段长度相近的近似片段
 *（「叶慧美」要能命中《叶惠美 2003 演唱会》这种带尾巴的标题）。 */
function fuzzyHit(token: string, field: string): boolean {
  const budget = typoBudget(token.length);
  if (!field || !budget) return false;
  if (field.includes(token)) return true;
  if (similarity(token, field) > 0) return true;
  if (field.length > 48) return false; // 长文案不做滑窗：不值得为它把每次搜索拖慢
  for (let i = 0; i + token.length <= field.length; i++) {
    if (editDistance(token, field.slice(i, i + token.length), budget) <= budget) return true;
  }
  return false;
}

function scoreCandidate(item: AlbumSearchCandidate, query: string): number {
  const q = fold(query);
  if (!q) return 0;
  const title = fold(item.title);
  const artist = fold(item.artists.join(' '));
  const track = fold(item.matchedTrack || '');
  const fields = [title, artist, track].filter(Boolean);
  const parts = tokenize(query);
  const multi = parts.length > 1;
  // ① 整体命中：相等 > 前缀 > 包含。歌名要单独给高分：搜歌名找专辑是主要用法之一，
  //    而专辑标题里压根不会有歌名（「晴天」→《叶惠美》），只能靠歌曲命中把它捞上来。
  //    多词查询里「整串嵌进标题」要打折：它会奖励《周杰伦《叶惠美》吉他翻唱版》这种
  //    把查询词整个嵌住的名字，而用户多半在找专辑本身 —— 多词查询的分词命中（②）才是真信号。
  if (title && title === q) return 100;
  if (track && track === q) return 96;
  if (artist && artist === q) return 90;
  if (title.startsWith(q)) return multi ? 70 : 88;
  if (track.startsWith(q)) return multi ? 68 : 84;
  if (title.includes(q)) return multi ? 66 : 80;
  if (track.includes(q)) return multi ? 64 : 76;
  if (artist.includes(q)) return 70;
  // ② 分词：多词查询（「周杰伦 叶惠美」「jay chou」）不分先后，全中才算强命中。
  //    其中「有一个词正好就是歌手名」再加一档：这是「专辑名 + 歌手」的典型写法，
  //    靠它才能把翻唱版、同名合辑挡在后面
  if (multi) {
    const hits = parts.filter((part) => fields.some((field) => fuzzyHit(part, field))).length;
    if (hits === parts.length) return parts.some((part) => part === artist) ? 74 : 66;
    if (hits > 1) return 46;
    if (hits === 1) return 34;
  }
  // ③ 整串近似：拼写差一两个字。上限压在 60 以下 —— 剪尾的「确有关联」线是 60，
  //    光靠近似不该够到那条线（否则一条近似命中就能把整池的兜底项全剪掉）。
  //    标题 / 歌名上的近似比歌手名上的可信：「叶慧美」要找的是专辑，不是名字像的那个歌手
  const bestName = Math.max(similarity(q, title), similarity(q, track));
  if (bestName > 0) return Math.round(30 + bestName * 28);
  const bestArtist = similarity(q, artist);
  if (bestArtist > 0) return Math.round(24 + bestArtist * 20);
  // ④ 本地看不出关联，只剩上游的排序信息
  return 12;
}

// ============ 关联已有：拿搜索结果去库里找最像的那几张 ============

/** 把库里的专辑按「与这张搜索结果有多像」排序（关联弹窗用）。
 *  标题是主信号 —— 同名版本（原版 / 重制版 / 现场版）必须排在一起，这正是容易选错的地方；
 *  歌手与年份各给一档加分（同名不同歌手、差了十年的不该混进第一梯队）。
 *  只用于排序，界面不展示分数。 */
export function rankLibraryMatches(
  candidate: Pick<AlbumSearchCandidate, 'title' | 'artists' | 'releaseDate'>,
  albums: AlbumInfo[]
): AlbumInfo[] {
  const q = fold(candidate.title);
  const artists = candidate.artists.map((a) => fold(a)).filter(Boolean);
  const year = (candidate.releaseDate || '').slice(0, 4);
  return albums
    .map((album) => {
      const title = fold(album.title);
      let score = 0;
      if (title && q) {
        if (title === q) score = 100;
        else if (title.startsWith(q) || q.startsWith(title)) score = 82;
        else if (title.includes(q) || q.includes(title)) score = 70;
        else {
          const sim = similarity(q, title);
          score = sim > 0 ? Math.round(40 + sim * 30) : 0;
        }
      }
      const artist = fold(album.artist || '');
      if (artist && artists.some((a) => a === artist || artist.includes(a) || a.includes(artist))) {
        score += 12;
      } else if (artist && artists.some((a) => similarity(a, artist) > 0)) {
        score += 6;
      }
      const albumYear = String(album.year ?? '').slice(0, 4);
      if (year && albumYear === year) score += 8;
      else if (year && /^\d{4}$/.test(albumYear) && Math.abs(Number(albumYear) - Number(year)) === 1) {
        score += 3;
      }
      return { album, score };
    })
    .sort((a, b) => b.score - a.score || a.album.title.localeCompare(b.album.title, 'zh-CN'))
    .map((entry) => entry.album);
}

/** 模糊筛选（关联弹窗的搜索框）：与在线搜索同一套容错 —— 错字、词序颠倒、只记得半截都能命中。
 *  查询为空 = 全通过（列表按相关度排好即可）。 */
export function fuzzyMatches(query: string, ...fields: Array<string | undefined>): boolean {
  const q = fold(query);
  if (!q) return true;
  const pool = fields.map((field) => fold(field || '')).filter(Boolean);
  if (!pool.length) return false;
  if (pool.some((field) => field.includes(q))) return true;
  const parts = tokenize(query);
  if (parts.length > 1) return parts.every((part) => pool.some((field) => fuzzyHit(part, field)));
  return pool.some((field) => fuzzyHit(q, field));
}

/** 剪尾：池子里只要有一条名副其实的命中（≥60），就把「看不出关联」的（<30）整段去掉。
 *  上游对模糊查询会塞一堆勉强沾边的结果，留着它们不光难看，还会把真想要的那张挤下去。 */
const CUT_FLOOR = 30;
const CUT_KEEP = 60;

function cutTail(ranked: AlbumSearchCandidate[]): AlbumSearchCandidate[] {
  if (!ranked.some((item) => (item.score || 0) >= CUT_KEEP)) return ranked;
  return ranked.filter((item) => (item.score || 0) >= CUT_FLOOR);
}

function rank(pool: AlbumSearchCandidate[], query: string): AlbumSearchCandidate[] {
  for (const item of pool) item.score = scoreCandidate(item, query);
  // 稳定排序：同分保持「上游给的先后」（跨页也是先来先得）——上游的相关度里带着它自己的热度信息，
  // 拿它当平手的次序，比随便排一个要强
  return [...pool].sort((a, b) => (b.score || 0) - (a.score || 0));
}

// ============ 已在库中：直接从结果里隐去 ============
// 需求：已经导入过的专辑不再出现在搜索结果里。索引是现算的（不是搜索时打快照），
// 所以刚导入一张、或者删掉一张笔记，下一次搜索立刻就能反映出来。
//
// 判定分两层：
//   ① 来源 id（neteaseId / qqId）—— 权威，但只管自己那个平台
//   ② 「标题 + 艺人」指纹 —— 两个平台的目录高度重合，同一张专辑两边都搜得到；
//      只认 id 的话，刚从网易云导完，QQ 那版还挂在结果里，点下去就是第二张重复笔记
//  ② 的两边都必须非空，且是折叠后的完全相等（不做模糊）：宁可漏认一张，也不能把别的专辑认成同一张。
//  笔记的标题就是笔记文件名，用户改过名（「叶惠美 (2003)」）时指纹对不上 —— 那就只剩 ① 兜着。
//  拼接用换行当分隔符：折叠已经把空白全去掉了，标题 / 艺人里再出现换行的可能性为零，
//  于是「叶惠美 + 周杰伦」与「叶惠 + 美周杰伦」不会拼成同一个指纹（用空格或斜杠就会有这种歧义）
function nameKey(title: unknown, artist: unknown): string {
  const t = fold(text(title));
  const a = fold(text(artist));
  return t && a ? `${t}\n${a}` : '';
}

function libraryIndex(app: App): { ids: Set<string>; names: Set<string> } {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const file of findAlbumNotes(app)) {
    const album = getAlbumInfo(app, file);
    if (!album) continue;
    if (album.neteaseId != null) ids.add(`netease:${album.neteaseId}`);
    if (album.qqId) ids.add(`qq:${album.qqId}`);
    if (album.kugouId) ids.add(`kugou:${album.kugouId}`);
    const name = nameKey(album.title, album.artist);
    if (name) names.add(name);
  }
  return { ids, names };
}

// ============ 搜索节流 ============
// 搜索框每敲一次字就是一轮「双源 × 网易云两次」的请求，而网易云对短时间内的重复搜索相当敏感
//（旧端点甚至会直接回 405「操作频繁」）。三层防护，从便宜到昂贵：
//   ① 缓存：同一个 query 60 秒内只发一次网（回删重打、按回车重复触发都落在这里）
//   ② 最小间隔：连续搜索之间至少隔 MIN_INTERVAL，避免「敲-停-敲」把请求打散成连发
//   ③ 冷却：上游明确说限流（HTTP 429）时，该来源暂停 COOLDOWN —— 对着限流重试只会一直撞
const CACHE_TTL = 60_000;
const MIN_INTERVAL = 600;
const COOLDOWN = 20_000;

const cooldownUntil: Record<MusicSource, number> = { netease: 0, qq: 0, kugou: 0 };
let lastDispatchAt = 0;

/** 让两次实际发网至少隔 MIN_INTERVAL（首次不受限） */
async function waitForSlot(): Promise<void> {
  const wait = lastDispatchAt + MIN_INTERVAL - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => window.setTimeout(resolve, wait));
  }
  lastDispatchAt = Date.now();
}

/** 冷却中的来源这一轮不会发请求 —— 得有个说法，否则用户会把「没发请求」当成「没有结果」 */
function cooldownWarning(source: MusicSource): AlbumSearchResult['warnings'][number] {
  const left = Math.max(1, Math.ceil((cooldownUntil[source] - Date.now()) / 1000));
  return { source, message: tf('import.sourceCoolingDown', { n: left }) };
}

const SOURCES: MusicSource[] = ['netease', 'qq', 'kugou'];

/** 在线搜索的来源范围（「添加」面板的搜索选择）：聚合（默认，与旧行为一致）/ 仅网易云 / 仅 QQ / 仅酷狗。
 *  单源不只是少打请求 —— 另一个来源的限流冷却、未登录提示也一并绕开。 */
export type SearchScope = 'all' | 'netease' | 'qq' | 'kugou';

/** 分段控件的档位顺序（界面按这个顺序排） */
export const SEARCH_SCOPES: SearchScope[] = ['all', 'netease', 'qq', 'kugou'];

/** data.json 里的脏值一律回落「聚合」（与其它记忆型设置同款兜底） */
export function normalizeSearchScope(v: unknown): SearchScope {
  return v === 'netease' || v === 'qq' || v === 'kugou' ? v : 'all';
}

/** 范围 → 实际要打请求的来源；聚合 = 全部来源都打 */
export function scopeSources(scope: SearchScope | undefined): MusicSource[] {
  return scope === 'netease' || scope === 'qq' || scope === 'kugou' ? [scope] : SOURCES;
}

// ============ 结果池 & 翻页 ============
// 「只有二十条」的解法不是把上限调大一点，而是让池子能一直长：一页 30 条/类型/来源，
// 首屏只画一部分，剩下的本地展开；展开完了再按 offset 问上游要下一页，并进同一个池子重排。
// 池子按 query 存（就是原来那份搜索缓存，只是多长了几页），TTL 内同一个词不再打网。

/** 每类每源一页要多少条：上游给得太少会把对的排到页外，给得太多是在招限流 */
export const SEARCH_PAGE_SIZE = 30;
const SESSION_TTL = CACHE_TTL;
const MAX_SESSIONS = 6;

interface SearchSession {
  at: number;
  /** 这一池子属于哪个范围：换个范围就是另一个池子（聚合的结果不能端给「仅 QQ」） */
  sources: MusicSource[];
  /** 去重后的原始池（含已在库中的 —— 隐去发生在返回前，删掉笔记重搜同一个词能立刻回来） */
  pool: AlbumSearchCandidate[];
  /** 下一页从哪开始（网易云是 offset；QQ 换算成页码，见 pageOf） */
  offset: number;
  /** 已经确认翻到底的来源 */
  exhausted: Set<MusicSource>;
  warnings: AlbumSearchResult['warnings'];
  /** 本轮有来源报错：同一个词再搜要重打网络（网络刚恢复时，压在头上的旧结果会骗人） */
  dirty: boolean;
}

const sessions = new Map<string, SearchSession>();

/** 池子的键 = 范围 + 词：同一个词换个范围必须另起一池 —— 否则「仅 QQ」会端出上一轮聚合的
 *  网易云结果（或反过来，聚合里少一半），而池子里的翻页页码还各自属于不同的来源。 */
function sessionKey(scope: SearchScope, query: string): string {
  return `${scope}|${query.toLocaleLowerCase()}`;
}

function trimSessions(): void {
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value as string | undefined;
    if (oldest == null) return;
    sessions.delete(oldest);
  }
}

function emptyResult(): AlbumSearchResult {
  return { items: [], warnings: [], owned: 0, hasMore: false };
}

/** 池子 → 展示列表：本地重排 → 剪尾 → 标注已在库中的。
 *  工具栏方案 2026-09-18：不再隐去 —— 明确入库的同平台专辑照常出现、就地标「已在收藏」；
 *  只凭同名命中的另记一笔（nameInLibrary），界面上给一句弱提示而不是当成同一张。 */
function present(app: App, query: string, session: SearchSession): AlbumSearchResult {
  const ranked = cutTail(rank(session.pool, query));
  const library = libraryIndex(app);
  const items = ranked.map((item) => {
    const inLibrary = library.ids.has(item.key);
    const name = nameKey(item.title, item.artists.join(' '));
    return {
      ...item,
      inLibrary,
      nameInLibrary: !inLibrary && !!name && library.names.has(name),
    };
  });
  return {
    items,
    warnings: session.warnings,
    owned: items.filter((item) => item.inLibrary).length,
    hasMore: session.sources.some((source) => !session.exhausted.has(source)),
  };
}

interface SourcePage {
  items: AlbumSearchCandidate[];
  /** 归一化之前上游给了多少条：0 就说明这个来源没有下一页了 */
  raw: number;
}

/** QQ / 酷狗的翻页是页码不是 offset：两端点的页大小都是 SEARCH_PAGE_SIZE（见 server/qq.js、server/kugou.js），除一下即可 */
function pageOf(offset: number): number {
  return Math.floor(offset / SEARCH_PAGE_SIZE) + 1;
}

async function fetchSource(
  ctx: AlbumDiscoveryContext,
  source: MusicSource,
  query: string,
  offset: number
): Promise<SourcePage> {
  if (source === 'qq') {
    const body = await ctx.qq.search(query, pageOf(offset));
    const raw = (body.data?.albums?.length || 0) + (body.data?.songs?.length || 0);
    return { items: normalizeQqSearch(body), raw };
  }
  if (source === 'kugou') {
    const body = await ctx.kugou.search(query, pageOf(offset));
    const raw = (body?.albums?.length || 0) + (body?.songs?.length || 0);
    return { items: normalizeKugouSearch(body), raw };
  }
  const page = { limit: SEARCH_PAGE_SIZE, offset };
  const [albums, songs] = await Promise.all([
    ctx.client.searchAlbums(query, page),
    ctx.client.searchSongs(query, page),
  ]);
  return {
    items: normalizeNeteaseSearch(albums, songs),
    raw: (albums.result?.albums?.length || 0) + (songs.result?.songs?.length || 0),
  };
}

/** 并进池子：同 key 去重（专辑命中比单曲命中信息全），返回新增条数 */
function mergeInto(pool: AlbumSearchCandidate[], incoming: AlbumSearchCandidate[]): number {
  const byKey = new Map(pool.map((item) => [item.key, item]));
  let added = 0;
  for (const item of incoming) {
    const previous = byKey.get(item.key);
    if (!previous) {
      pool.push(item);
      byKey.set(item.key, item);
      added++;
      continue;
    }
    if (previous.matchedBy === 'track' && item.matchedBy === 'album') {
      Object.assign(previous, item);
    }
  }
  return added;
}

/** 拉一页（每源各一次）并并进池子。失败的来源照旧记警告 + 冷却，不影响另一个来源。 */
async function loadPage(
  ctx: AlbumDiscoveryContext,
  query: string,
  session: SearchSession
): Promise<void> {
  const targets = session.sources.filter(
    (source) => !session.exhausted.has(source) && Date.now() >= cooldownUntil[source]
  );
  // 已经没有可要的东西（都翻到底了 / 都在冷却）：一个请求都不发，也不动池子与页码。
  // 冷却中的来源还是要留个说法，否则用户会把「没发请求」当成「没有结果」。
  if (!targets.length) {
    session.warnings = session.sources
      .filter((source) => !session.exhausted.has(source))
      .map(cooldownWarning);
    return;
  }
  await waitForSlot();
  const attempts = targets.map((source) => ({
    source,
    run: () => fetchSource(ctx, source, query, session.offset),
  }));

  const warnings: AlbumSearchResult['warnings'] = [];
  const settled = await Promise.allSettled(attempts.map((attempt) => attempt.run()));
  settled.forEach((result, i) => {
    const { source } = attempts[i];
    if (result.status === 'rejected') {
      if (isRateLimited(result.reason)) cooldownUntil[source] = Date.now() + COOLDOWN;
      warnings.push({
        source,
        message: text((result.reason as Error | undefined)?.message || result.reason),
      });
      session.dirty = true;
      return;
    }
    const { items, raw } = result.value;
    const added = mergeInto(session.pool, items);
    // 「这个来源还有没有下一页」：网易云的 offset 翻页是准的（给少于要的即到底）；
    // QQ / 酷狗的页码端点对页大小有夹取，只有「这一页没带来新东西」才可靠 —— 两条一起用，谁先到算谁
    if (raw === 0 || added === 0 || (source === 'netease' && raw < SEARCH_PAGE_SIZE)) {
      session.exhausted.add(source);
    }
  });
  const attempted = new Set(attempts.map((attempt) => attempt.source));
  for (const source of session.sources) {
    // 到底了的来源不解释：那是「没有更多」，不是「被限流」
    if (attempted.has(source) || session.exhausted.has(source)) continue;
    if (Date.now() < cooldownUntil[source]) warnings.push(cooldownWarning(source));
  }
  session.warnings = warnings;
  session.offset += SEARCH_PAGE_SIZE;
  session.at = Date.now();
}

/** 首屏搜索：池子里没有这个词（或上一轮带错、已过期）时重打网络，否则直接复用池子。
 *  scope 是「搜索来源」选择，默认聚合（老调用方不传就是旧行为）。 */
export async function discoverAlbums(
  ctx: AlbumDiscoveryContext,
  rawQuery: string,
  scope: SearchScope = 'all'
): Promise<AlbumSearchResult> {
  const query = String(rawQuery || '').trim();
  if (!query) return emptyResult();

  const key = sessionKey(scope, query);
  const cached = sessions.get(key);
  if (cached && Date.now() - cached.at < SESSION_TTL && !cached.dirty) {
    return present(ctx.app, query, cached);
  }
  // 过期 / 上一轮带错的：池子和页码一起重建，别把脏页码带到这一轮
  const session: SearchSession = {
    at: Date.now(),
    sources: scopeSources(scope),
    pool: [],
    offset: 0,
    exhausted: new Set(),
    warnings: [],
    dirty: false,
  };
  // 池子建起来之后才登记：先登记的话，连按两次回车时第二次会命中一个还没有内容的池子，
  // 于是「搜到了」和「没搜到」同时出现在屏幕上（后者还盖着前者）
  await loadPage(ctx, query, session);
  sessions.set(key, session);
  trimSessions();
  return present(ctx.app, query, session);
}

/** 「加载更多」：把上游更深处的一页拉进池子，再按同一套逻辑重排后返回整个池子。
 *  池子已经翻到底（或有来源在冷却）时不发请求，如实返回现有的池子。 */
export async function loadMoreAlbums(
  ctx: AlbumDiscoveryContext,
  rawQuery: string,
  scope: SearchScope = 'all'
): Promise<AlbumSearchResult> {
  const query = String(rawQuery || '').trim();
  if (!query) return emptyResult();
  const session = sessions.get(sessionKey(scope, query));
  // 会话已被挤掉 / 过期：当作重新搜一次（此时池子是空的，能给出完整的一页）
  if (!session) return discoverAlbums(ctx, query, scope);
  await loadPage(ctx, query, session);
  return present(ctx.app, query, session);
}
