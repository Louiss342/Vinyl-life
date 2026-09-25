// 导入功能：
//   A. 专辑导入：网易云 / QQ 音乐 / 酷狗音乐链接（或 ID）→ 元信息 → 建笔记（neteaseId / qqId / kugouId）→ 代理下封面 → 打开笔记
//   B. 本地音频导入：复制进 vault（audioFolder）/ 外链绝对路径（audio 列表）两模式，processFrontMatter 更新
//   C. 拖到空白处：从文件新建本地专辑笔记
import { App, TFile, normalizePath } from 'obsidian';
import {
  AlbumInfo,
  buildAlbumInfo,
  findAlbumNotes,
  getAlbumInfo,
  parseKugouAlbumId,
  parseQqAlbumMid,
} from './core/album-index';
import { coverCandidates } from './core/cover-url';
import {
  isAudioFile,
  baseName,
  scalarText,
  sanitizeFileName,
  ensureFolder,
  relDirOf,
  notice,
} from './util';
import { t, tf } from './core/i18n';
// 以下仅作类型使用（import type 让测试打包不牵连整条服务链）
import type { VinylSettings } from './settings';
import type { NeteaseService } from './core/netease';
import type { QqService } from './core/qq';
import type { KugouService } from './core/kugou';
import type { KugouAlbumResponse, NeteaseAlbumResponse, QqAlbumResponse } from './core/api-types';

export interface ImportContext {
  app: App;
  settings: () => VinylSettings;
  /** 把设置落盘（搜索来源这类「记住上次选择」的界面偏好写入后调用）。
   *  可缺省：没有宿主的场合（测试 / 精简调用方）选择只在本次会话内有效。 */
  saveSettings?: () => void | Promise<void>;
  /** 统一网易云入口（网页会话优先，网关兜底，内部处理就绪） */
  client: NeteaseService;
  /** QQ 音乐入口（网关单通道） */
  qq: QqService;
  /** 酷狗音乐入口（网关单通道；未登录也能取免费曲库） */
  kugou: KugouService;
}

export interface ImportResult {
  status: 'created' | 'existing' | 'failed';
  /** 保留给旧调用方；新界面应使用 status 区分「已存在」与失败。 */
  ok: boolean;
  detail: string;
  file?: TFile;
}

// ensureFolder 见 util.ts（导入与插件启动共用）

// ============ A. 专辑导入（网易云 / QQ 音乐） ============

export type AlbumRef =
  | { source: 'netease'; id: number }
  | { source: 'qq'; mid: string }
  | { source: 'kugou'; id: string };

export type AlbumLink = AlbumRef;

/** frontmatter 里的字符串值：走 JSON 转义（它是 YAML 双引号的子集）。
 *  不这么做的话，艺人名里一个 `"` 就能让整段 frontmatter 解析失败 —— 那张专辑会直接从
 *  专辑墙上消失，而且用户看不到任何报错。 */
function yamlString(v: string): string {
  return JSON.stringify(v);
}

/** 在不覆盖现有笔记的前提下为在线专辑选路径；只有发生冲突时才增加歌手/年份。 */
function availableOnlineNoteName(
  ctx: ImportContext,
  album: string,
  artist: string,
  year: string | number | undefined,
  source: 'netease' | 'qq' | 'kugou'
): string {
  const folder = ctx.settings().albumFolder;
  const base = sanitizeFileName(album);
  const available = (name: string) =>
    !ctx.app.vault.getAbstractFileByPath(normalizePath(`${folder}/${name}.md`));
  if (available(base)) return base;
  const withArtist = sanitizeFileName(`${album}${artist ? ` - ${artist}` : ''}`);
  if (withArtist !== base && available(withArtist)) return withArtist;
  const brand = source === 'qq' ? 'QQ' : source === 'kugou' ? 'Kugou' : 'NetEase';
  const suffix = [year, brand].filter(Boolean).join(', ');
  const detailed = sanitizeFileName(`${withArtist} (${suffix})`);
  if (available(detailed)) return detailed;
  for (let n = 2; ; n++) {
    const numbered = sanitizeFileName(`${detailed} ${n}`);
    if (available(numbered)) return numbered;
  }
}

export function parseNeteaseInput(input: string): number | undefined {
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/album\?id=(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/** 专辑链接/ID 识别：网易云（album?id= / 纯数字 ID）优先，其次酷狗（kugou.com/yy/album/single/<id>.html），
 *  最后 QQ 音乐（albumDetail/、旧版 /album/<mid>.html、纯 mid）。
 *  酷狗必须排在 QQ 前面：酷狗网页链接里也有 "album/…" 段，而 QQ 的旧版正则会把 /album/<数字>.html 认成自己的 mid。
 *  裸数字仍然是网易云 ID（酷狗 id 也是数字，无法从裸数字上区分 —— 请粘贴完整链接）。 */
export function parseAlbumInput(input: string): AlbumLink | undefined {
  const s = String(input || '').trim();
  if (!s) return undefined;
  const id = parseNeteaseInput(s);
  if (id) return { source: 'netease', id };
  if (/kugou\.com/i.test(s)) {
    const kugouId = parseKugouAlbumId({ kugou: s });
    if (kugouId) return { source: 'kugou', id: kugouId };
  }
  const mid = parseQqAlbumMid({ qq: s });
  return mid ? { source: 'qq', mid } : undefined;
}

export async function importAlbum(ctx: ImportContext, input: string): Promise<ImportResult> {
  const link = parseAlbumInput(input);
  if (!link) {
    return {
      status: 'failed',
      ok: false,
      detail: t('import.badLink'),
    };
  }
  return importAlbumRef(ctx, link);
}

/** 搜索结果的直接导入入口：不拼 URL，不再猜测来源。 */
export function importAlbumRef(ctx: ImportContext, ref: AlbumRef): Promise<ImportResult> {
  if (ref.source === 'qq') return importQqAlbum(ctx, ref.mid);
  if (ref.source === 'kugou') return importKugouAlbum(ctx, ref.id);
  return importNeteaseAlbum(ctx, String(ref.id));
}

// 封面：经本地网关代理下载（避开 CORS）→ covers/，返回 frontmatter 用的 wikilink 字面量。
// QQ 封面地址是拼出来的，主图床（y.gtimg.cn）在部分网络下不可达 —— 按候选图床依次重试
//（见 core/cover-url.ts）。全部失败时给出可见提示（Notice + 控制台），不再静默留白。
async function downloadCoverToVault(
  ctx: ImportContext,
  url: string | undefined,
  name: string
): Promise<string> {
  if (!url) return '';
  let ab: ArrayBuffer | null = null;
  let firstError = '';
  for (const candidate of coverCandidates(String(url))) {
    try {
      ab = await ctx.client.fetchCover(candidate);
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!firstError) firstError = msg;
      // 主图床失败、备用图床顶上属常态 → 只进控制台；全部失败才弹提示
      console.warn(`[vinyl] 封面下载失败（${candidate}）：${msg}`);
    }
  }
  if (!ab) {
    console.error('[vinyl] 封面下载失败', firstError);
    notice(tf('import.coverFailed', { msg: firstError }));
    return '';
  }
  try {
    const ext = String(url).match(/\.(jpe?g|png|webp)(\?|$)/i)?.[1] || 'jpg';
    const coverPath = normalizePath(`${ctx.settings().coverFolder}/${name}.${ext}`);
    if (!ctx.app.vault.getAbstractFileByPath(coverPath)) {
      await ensureFolder(ctx.app, ctx.settings().coverFolder);
      await ctx.app.vault.createBinary(coverPath, ab);
    }
    return `"[[${coverPath}]]"`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[vinyl] 封面写入失败', e);
    notice(tf('import.coverFailed', { msg }));
    return '';
  }
}

export async function importNeteaseAlbum(
  ctx: ImportContext,
  input: string
): Promise<ImportResult> {
  const id = parseNeteaseInput(input);
  if (!id) {
    return { status: 'failed', ok: false, detail: t('import.badId') };
  }

  // 查重先于接口请求：已有同 neteaseId 的笔记 → 直接指路（也避免离线/接口故障时误报失败）
  for (const f of findAlbumNotes(ctx.app)) {
    const info = getAlbumInfo(ctx.app, f);
    if (info?.neteaseId === id) {
      return { status: 'existing', ok: false, detail: tf('import.duplicate', { title: info.title }), file: f };
    }
  }

  let body: NeteaseAlbumResponse;
  try {
    body = await ctx.client.album(id);
  } catch (e) {
    return { status: 'failed', ok: false, detail: tf('import.fetchFailed', { msg: (e as Error).message }) };
  }
  const album = body?.album;
  if (!album?.name) {
    return { status: 'failed', ok: false, detail: tf('import.albumNoData', { code: String(body?.code) }) };
  }

  // 建笔记
  const artist = album.artist?.name || '';
  const year = album.publishTime
    ? new Date(Number(album.publishTime)).getFullYear()
    : undefined;
  const name = availableOnlineNoteName(ctx, album.name, artist, year, 'netease');
  const notePath = normalizePath(`${ctx.settings().albumFolder}/${name}.md`);

  const coverRef = await downloadCoverToVault(ctx, album.picUrl, name);

  await ensureFolder(ctx.app, ctx.settings().albumFolder);

  // 笔记走与本地导入同一条模板路（在线资料填进占位符；模板没写到的功能键由它补齐）
  const content = await buildAlbumNote(ctx, {
    title: album.name,
    artist,
    year,
    cover: coverRef || undefined,
    neteaseId: id,
    netease: `https://music.163.com/#/album?id=${id}`,
  });
  const file = await ctx.app.vault.create(notePath, content);
  return {
    status: 'created',
    ok: true,
    detail: tf('import.neteaseDone', {
      name: album.name,
      artist,
      year: year ? `, ${year}` : '',
      n: body.songs?.length ?? 0,
    }),
    file,
  };
}

// ============ A2. QQ 音乐专辑导入 ============

export async function importQqAlbum(ctx: ImportContext, input: string): Promise<ImportResult> {
  const mid = parseQqAlbumMid({ qq: String(input || '').trim() });
  if (!mid) {
    return {
      status: 'failed',
      ok: false,
      detail: t('import.badQqId'),
    };
  }

  // 查重先于接口请求：已有同 qqId 的笔记 → 直接指路
  for (const f of findAlbumNotes(ctx.app)) {
    const info = getAlbumInfo(ctx.app, f);
    if (info?.qqId === mid) {
      return { status: 'existing', ok: false, detail: tf('import.duplicate', { title: info.title }), file: f };
    }
  }

  let body: QqAlbumResponse;
  try {
    body = await ctx.qq.album(mid);
  } catch (e) {
    return { status: 'failed', ok: false, detail: tf('import.albumFetchFailed', { msg: (e as Error).message }) };
  }
  const album = body?.data?.album;
  if (!album?.name) {
    return {
      status: 'failed',
      ok: false,
      detail: body?.msg || tf('import.qqNoData', { code: String(body?.code) }),
    };
  }

  const artist = album.artist || '';
  // QQ 的 aDate 形如 2020-01-01
  const year = /^(\d{4})/.exec(String(album.publishTime || ''))?.[1];
  const name = availableOnlineNoteName(ctx, album.name, artist, year, 'qq');
  const notePath = normalizePath(`${ctx.settings().albumFolder}/${name}.md`);
  const coverRef = await downloadCoverToVault(ctx, album.coverUrl, name);

  await ensureFolder(ctx.app, ctx.settings().albumFolder);

  const content = await buildAlbumNote(ctx, {
    title: album.name,
    artist,
    year,
    cover: coverRef || undefined,
    qqId: mid,
    qq: `https://y.qq.com/n/ryqq/albumDetail/${mid}`,
  });
  const file = await ctx.app.vault.create(notePath, content);
  return {
    status: 'created',
    ok: true,
    detail: tf('import.qqDone', {
      name: album.name,
      artist,
      year: year ? `, ${year}` : '',
      tracks: album.trackCount ? tf('import.qqTracks', { n: album.trackCount }) : '',
    }),
    file,
  };
}

// ============ A3. 酷狗音乐专辑导入 ============

/** 发行年份：酷狗的 publishtime 可能是「2020-01-01」这类日期串，也可能是秒级时间戳字符串 */
function yearFromKugouDate(raw: unknown): string | undefined {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  const m = /^(\d{4})/.exec(s);
  if (m) return m[1];
  const t = Number(s);
  if (Number.isFinite(t) && t > 0) {
    const year = new Date(t).getFullYear();
    return Number.isFinite(year) ? String(year) : undefined;
  }
  return undefined;
}

export async function importKugouAlbum(ctx: ImportContext, input: string): Promise<ImportResult> {
  const id = parseKugouAlbumId({ kugou: String(input || '').trim() });
  if (!id) {
    return {
      status: 'failed',
      ok: false,
      detail: t('import.badKugouId'),
    };
  }

  // 查重先于接口请求：已有同 kugouId 的笔记 → 直接指路
  for (const f of findAlbumNotes(ctx.app)) {
    const info = getAlbumInfo(ctx.app, f);
    if (info?.kugouId === id) {
      return { status: 'existing', ok: false, detail: tf('import.duplicate', { title: info.title }), file: f };
    }
  }

  let body: KugouAlbumResponse;
  try {
    body = await ctx.kugou.album(id);
  } catch (e) {
    return { status: 'failed', ok: false, detail: tf('import.albumFetchFailed', { msg: (e as Error).message }) };
  }
  const album = body?.data?.album;
  if (!album?.name) {
    return {
      status: 'failed',
      ok: false,
      detail: tf('import.kugouNoData', { code: String(body?.code) }),
    };
  }

  const artist = album.artist || '';
  const year = yearFromKugouDate(album.publishDate);
  const name = availableOnlineNoteName(ctx, album.name, artist, year, 'kugou');
  const notePath = normalizePath(`${ctx.settings().albumFolder}/${name}.md`);
  const coverRef = await downloadCoverToVault(ctx, album.cover, name);

  await ensureFolder(ctx.app, ctx.settings().albumFolder);

  const content = await buildAlbumNote(ctx, {
    title: album.name,
    artist,
    year,
    cover: coverRef || undefined,
    kugouId: id,
    kugou: `https://www.kugou.com/yy/album/single/${id}.html`,
  });
  const file = await ctx.app.vault.create(notePath, content);
  return {
    status: 'created',
    ok: true,
    detail: tf('import.kugouDone', {
      name: album.name,
      artist,
      year: year ? `, ${year}` : '',
      tracks: album.songCount ? tf('import.kugouTracks', { n: album.songCount }) : '',
    }),
    file,
  };
}

// ============ B. 本地音频导入（两模式） ============

export async function importLocalAudio(
  ctx: ImportContext,
  album: AlbumInfo,
  files: File[],
  mode: 'copy' | 'link'
): Promise<{
  added: string[];
  fallback: boolean;
  /** 格式不受支持而跳过的文件名（与「已存在」区分开，便于给出准确提示） */
  skippedUnsupported: string[];
  /** 已存在（或本次选择内重复）而跳过的文件名 */
  skippedExisting: string[];
}> {
  const added: string[] = [];
  const skippedUnsupported: string[] = [];
  const skippedExisting: string[] = [];
  let fallback = false;
  let copyDir = '';

  for (const f of files) {
    if (!isAudioFile(f.name)) {
      skippedUnsupported.push(f.name);
      continue;
    }
    const safeName = sanitizeFileName(f.name);

    if (mode === 'copy') {
      copyDir = normalizePath(
        `${ctx.settings().audioFolder}/${sanitizeFileName(album.title)}`
      );
      // 文件夹导入：保留子目录结构（audio/<专辑>/CD1/01.flac），散选文件则平铺
      const relDir = relDirOf(f);
      const destDir = relDir
        ? normalizePath(
            `${copyDir}/${relDir
              .split('/')
              .filter(Boolean)
              .map((seg) => sanitizeFileName(seg))
              .join('/')}`
          )
        : copyDir;
      const p = normalizePath(`${destDir}/${safeName}`);
      if (ctx.app.vault.getAbstractFileByPath(p)) {
        skippedExisting.push(f.name); // 已存在跳过
        continue;
      }
      const ab = await f.arrayBuffer();
      await ensureFolder(ctx.app, destDir);
      await ctx.app.vault.createBinary(p, ab);
      added.push(p);
    } else {
      const abs = f.path;
      if (abs && typeof abs === 'string') {
        if (added.includes(abs)) skippedExisting.push(f.name);
        else added.push(abs);
      } else {
        // 非 Electron 拖拽（无文件路径）→ 回退复制进 vault
        fallback = true;
        copyDir = normalizePath(
          `${ctx.settings().audioFolder}/${sanitizeFileName(album.title)}`
        );
        const p = normalizePath(`${copyDir}/${safeName}`);
        if (!ctx.app.vault.getAbstractFileByPath(p)) {
          const ab = await f.arrayBuffer();
          await ensureFolder(ctx.app, copyDir);
          await ctx.app.vault.createBinary(p, ab);
        }
        added.push(p);
      }
    }
  }

  if (!added.length) return { added, fallback, skippedUnsupported, skippedExisting };

  // 更新笔记 frontmatter（复制 → audioFolder；外链 → audio 列表追加）
  // 回调参数显式标注：Obsidian 的 processFrontMatter 把 frontmatter 声明为 any，
  // 不标注会让下面每一次取值都落在 unsafe-member-access 上。
  await ctx.app.fileManager.processFrontMatter(
    album.file,
    (fm: Record<string, unknown>) => {
      if (mode === 'copy') {
        if (!fm.audioFolder) fm.audioFolder = `[[${copyDir}]]`;
      } else {
        const raw = fm.audio;
        // 旧数据可能是单值也可能是数组；非标量项（对象 / 数组）按无法使用丢弃
        const list: string[] = Array.isArray(raw)
          ? raw.map((v) => scalarText(v))
          : raw != null
            ? [scalarText(raw)]
            : [];
        for (const a of added) if (!list.includes(a)) list.push(a);
        fm.audio = list;
      }
    }
  );
  return { added, fallback, skippedUnsupported, skippedExisting };
}

// ============ C. 从文件新建本地专辑（拖到空白处） ============

/**
 * 内置模板：与「导入专辑」生成的字段一致，能自动的填好、其余留空待填。
 * 空属性在 Obsidian 属性面板里就是一行空字段，点进去填即可
 *（用空字符串而非 null：processFrontMatter 会把 null 回写成 `key: null`，面板会显示 "null"）。
 */
export const DEFAULT_ALBUM_TEMPLATE = [
  '---',
  'tags: [album]',
  'artist: ""',
  'year: ""',
  'genre: ""',
  'rating: ""',
  'cover: ""',
  '{{audioFolder}}',
  '---',
  '',
  t('import.reflectionHeading'),
  '',
].join('\n');

/** 一篇专辑笔记能用到的全部资料：模板占位符与 frontmatter 补全共用这一份。
 *  在线导入能填满，本地导入只有标题 / 音频目录 / 时间（本地不读 ID3，见 README）。 */
export interface AlbumNoteFields {
  title: string;
  artist?: string;
  year?: string | number;
  genre?: string;
  rating?: string | number;
  /** 已落库的封面引用，带引号的 wikilink（downloadCoverToVault 的返回值） */
  cover?: string;
  /** 音频目录的 vault 路径（本地导入才有） */
  audioFolder?: string;
  neteaseId?: string | number;
  qqId?: string;
  kugouId?: string;
  /** 平台链接（frontmatter 的 netease / qq / kugou 三个键） */
  netease?: string;
  qq?: string;
  kugou?: string;
  now?: Date;
}

/** 值型占位符：拿不到值替换成空串（拼错的仍然原样保留，好让用户在笔记里看见自己写错了）。 */
function valuePlaceholders(vars: AlbumNoteFields): Record<string, string> {
  const d = vars.now || new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const text = (v: string | number | undefined) => (v == null ? '' : String(v));
  return {
    title: vars.title,
    artist: text(vars.artist),
    year: text(vars.year),
    genre: text(vars.genre),
    rating: text(vars.rating),
    neteaseId: text(vars.neteaseId),
    qqId: text(vars.qqId),
    kugouId: text(vars.kugouId),
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/**
 * 占位符替换。两类：
 *   - **值型**（`{{title}}` `{{artist}}` `{{year}}` `{{genre}}` `{{rating}}` `{{date}}` `{{time}}` 与三个平台 id）：
 *     替换成值本身，放正文、放引号里都行；
 *   - **行型**（`{{audioFolder}}` `{{cover}}`）：替换成整整一行 frontmatter，拿不到值的整行消失
 *     （空行留着会在属性面板里多出一个空字段）。
 * 未识别的占位符原样保留。frontmatter 里剩下的空行也一并清掉。
 */
export function renderAlbumTemplate(tpl: string, vars: AlbumNoteFields): string {
  const map = valuePlaceholders(vars);
  const lines = { audioFolder: vars.audioFolder ? `audioFolder: "[[${vars.audioFolder}]]"` : '', cover: vars.cover ? `cover: ${vars.cover}` : '' };
  const out = String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) =>
    k in map ? map[k] : k in lines ? lines[k as keyof typeof lines] : m
  );
  return out.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_m, body: string) => {
    const kept = body.split(/\r?\n/).filter((l) => l.trim() !== '');
    return `---\n${kept.join('\n')}\n---`;
  });
}

/** 空值判断：`key:`、`key: ""`、`key: ''` 都算没填 */
function isEmptyYamlValue(raw: string): boolean {
  const v = raw.trim();
  return v === '' || v === '""' || v === "''";
}

/** tags 行合并出 album：`[music]` → `[music, album]`；块状列表则由调用方补一行；已是则原样 */
function mergeAlbumTag(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null; // 块状列表：调用方紧跟一行 `- album`
  const list = value.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
  if (list.some((s) => s === 'album')) return raw;
  return `[${[...list.filter(Boolean), 'album'].join(', ')}]`;
}

/**
 * 模板决定笔记长什么样，插件保证**功能键不丢**：缺的补上、空着的填上。
 * 具体：tags 里一定有 album；已知的平台 id / 链接 / 封面 / 音频目录 / 艺人 / 年份等
 * 只在「键缺失或值为空」时写入 —— 模板里写死的非空值一律尊重（用户改过就不覆盖）。
 * 纯文本操作，不重新序列化 YAML：用户模板里的注释、引号风格、字段顺序都留着。
 */
export function fillAlbumFrontmatter(note: string, vars: AlbumNoteFields): string {
  const known: Array<[string, string]> = [];
  const push = (k: string, v: string | number | undefined, wrap = false) => {
    if (v === undefined || v === '') return;
    known.push([k, wrap ? yamlString(String(v)) : String(v)]);
  };
  push('cover', vars.cover);
  push('artist', vars.artist, true);
  push('year', vars.year);
  push('genre', vars.genre, true);
  push('rating', vars.rating);
  push('audioFolder', vars.audioFolder ? `"[[${vars.audioFolder}]]"` : '');
  push('neteaseId', vars.neteaseId);
  push('qqId', vars.qqId);
  push('kugouId', vars.kugouId);
  push('netease', vars.netease, true);
  push('qq', vars.qq, true);
  push('kugou', vars.kugou, true);

  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(note);
  if (!m) {
    // 模板没写 frontmatter：补一块（tags 与 id 是插件认出这张专辑的依据）
    const block = ['---', 'tags: [album]', ...known.map(([k, v]) => `${k}: ${v}`), '---'].join('\n');
    return `${block}\n${note.replace(/^\r?\n/, '')}`;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!kv) { out.push(line); continue; }
    const key = kv[1];
    if (key === 'tags') {
      seen.add('tags');
      const merged = mergeAlbumTag(kv[2]);
      out.push(merged == null ? line : `tags: ${merged}`);
      if (merged == null) out.push('  - album');
      continue;
    }
    const entry = known.find(([k]) => k === key);
    if (!entry) { out.push(line); continue; }
    seen.add(key);
    // 值为空的键用已知资料填上；非空的尊重模板
    out.push(isEmptyYamlValue(kv[2]) ? `${key}: ${entry[1]}` : line);
  }
  for (const [k, v] of known) if (!seen.has(k)) out.push(`${k}: ${v}`);
  if (!seen.has('tags')) out.push('tags: [album]');
  return note.slice(0, m.index) + `---\n${out.join('\n')}\n---` + note.slice(m.index + m[0].length);
}

/** 读设置里指定的模板文件；没配 / 读不到就用内置模板。
 *  配了路径却找不到文件是最常见的坑（删过、改过名），这里不再只是 console.warn：
 *  整个会话提一次，用户才知道自己导入出来的为什么是「默认样子」。 */
let warnedMissingTemplate = false;
async function readAlbumTemplate(ctx: ImportContext, onMissing: (path: string) => void): Promise<string> {
  const cfg = String(ctx.settings().albumNoteTemplate || '').trim();
  if (!cfg) return DEFAULT_ALBUM_TEMPLATE;
  const f = ctx.app.vault.getAbstractFileByPath(normalizePath(cfg));
  if (f instanceof TFile) {
    try {
      return await ctx.app.vault.read(f);
    } catch (e) {
      console.warn('[vinyl] 读取专辑模板失败，改用内置模板', e);
      return DEFAULT_ALBUM_TEMPLATE;
    }
  }
  console.warn('[vinyl] 专辑模板文件不存在：' + cfg);
  if (!warnedMissingTemplate) {
    warnedMissingTemplate = true;
    onMissing(cfg);
  }
  return DEFAULT_ALBUM_TEMPLATE;
}

/** 按模板生成一篇专辑笔记：渲染占位符 + 补齐功能键（本地与在线导入共用这一条路） */
export async function buildAlbumNote(ctx: ImportContext, vars: AlbumNoteFields): Promise<string> {
  const tpl = await readAlbumTemplate(ctx, (path) => notice(tf('notice.templateMissing', { path })));
  return fillAlbumFrontmatter(renderAlbumTemplate(tpl, vars), vars);
}

/** 本地导入的专辑笔记（保留旧入口名：调用方只关心「给我一篇笔记」） */
export async function buildLocalAlbumNote(
  ctx: ImportContext,
  title: string,
  audioFolderRef?: string
): Promise<string> {
  return buildAlbumNote(ctx, { title, audioFolder: audioFolderRef });
}

export async function createAlbumFromFiles(
  ctx: ImportContext,
  files: File[],
  titleOverride?: string,
  mode: 'copy' | 'link' = 'copy'
): Promise<AlbumInfo | null> {
  const audioFiles = files.filter((f) => isAudioFile(f.name));
  if (!audioFiles.length) return null;
  const title = (titleOverride || '').trim() || baseName(audioFiles[0].name);
  const safeTitle = sanitizeFileName(title);
  const notePath = normalizePath(`${ctx.settings().albumFolder}/${safeTitle}.md`);
  const existing = ctx.app.vault.getAbstractFileByPath(notePath);
  if (existing instanceof TFile) {
    const info = getAlbumInfo(ctx.app, existing);
    if (info) return info;
    // 同名文件存在但不是专辑笔记 → 不覆盖，给出可读提示
    throw new Error(tf('import.nameConflict', { path: notePath }));
  }
  await ensureFolder(ctx.app, ctx.settings().albumFolder);
  // 复制模式：音频目录现在就已知（与 importLocalAudio 的落位规则一致），直接写进骨架
  const audioRef =
    mode === 'copy'
      ? normalizePath(`${ctx.settings().audioFolder}/${safeTitle}`)
      : undefined;
  const file = await ctx.app.vault.create(notePath, await buildLocalAlbumNote(ctx, safeTitle, audioRef));
  // metadataCache 尚未索引新文件 → 用已知 frontmatter 直接构造
  const fm: Record<string, unknown> = { tags: ['album'] };
  if (audioRef) fm.audioFolder = `[[${audioRef}]]`;
  return buildAlbumInfo(ctx.app, file, fm);
}
