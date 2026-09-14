// 专辑笔记索引：metadataCache 过滤 tags:[album]，解析 frontmatter 为 AlbumInfo。
// 向后兼容：netease 旧字段 URL 正则解析；本地引用支持 wikilink / 外链绝对路径。
import { App, TFile, TFolder, normalizePath } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import {
  isAudioFile,
  scalarText,
  stripWikilink,
  collectFolderAudios,
  collectExternalAudios,
} from '../util';
import { buildDisplayProps } from './shelf-props';

// 兼容既有调用点（delete.ts / local-source.ts 从本模块 import stripWikilink）：真值已移至 util.ts
export { stripWikilink };

export type AlbumSourcePref = 'auto' | 'local' | 'netease' | 'qq';

export interface AlbumInfo {
  file: TFile;
  path: string;
  title: string;
  artist?: string;
  year?: string | number;
  genre?: string;
  rating?: string | number;
  /** frontmatter 原文（wikilink / URL / 色值） */
  coverRaw?: string;
  /** 解析后的可显示值 */
  cover?: string;
  /** 网易云专辑 ID（neteaseId 字段或 netease URL 正则解析） */
  neteaseId?: number;
  /** QQ 音乐专辑 mid（qqId 字段或 qq 链接正则解析） */
  qqId?: string;
  /** audioFolder 引用（wikilink / vault 路径 / 外链绝对路径） */
  audioFolderRef?: string;
  /** audio 显式列表原文 */
  audioRefs: string[];
  /** 笔记 source 字段 */
  sourcePref: AlbumSourcePref;
  /** 卡片显示用属性（frontmatter 键 → 已格式化字符串，已剔黑名单）。
   *  空值保留为 ''，由渲染侧跳过——采集侧不剔除，保证「候选计数」与「卡片渲染」同一份数据 */
  displayProps: Record<string, string>;
}

const NETEASE_ALBUM_RE = /album\?id=(\d+)/;
const QQ_ALBUM_RE = /albumDetail\/([A-Za-z0-9]+)/;
const QQ_ALBUM_LEGACY_RE = /album\/([A-Za-z0-9]+)\.html/;
const QQ_MID_RE = /^[A-Za-z0-9]{8,24}$/;
type Frontmatter = Record<string, unknown>;

function asFrontmatter(value: unknown): Frontmatter {
  return value && typeof value === 'object' ? (value as Frontmatter) : {};
}

function toTagList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(/,\s*/);
  return [];
}

export function hasAlbumTag(fm: unknown): boolean {
  return toTagList(asFrontmatter(fm).tags).some((t) => t.replace(/^\[|\]$/g, '').trim() === 'album');
}

export function parseNeteaseId(fm: unknown): number | undefined {
  const data = asFrontmatter(fm);
  const raw = data.neteaseId;
  if (raw) {
    const n = Number(raw);
    if (isFinite(n)) return n;
  }
  const url = scalarText(data.netease);
  const m = url.match(NETEASE_ALBUM_RE);
  return m ? Number(m[1]) : undefined;
}

// QQ 专辑 mid 解析：qqId 裸 mid / qq 链接（新版 albumDetail、旧版 /album/<mid>.html）
export function parseQqAlbumMid(fm: unknown): string | undefined {
  const data = asFrontmatter(fm);
  const bare = data.qqId;
  if (bare != null) {
    const t = scalarText(bare).trim();
    if (QQ_MID_RE.test(t)) return t;
  }
  const url = scalarText(data.qq);
  const m = url.match(QQ_ALBUM_RE) || url.match(QQ_ALBUM_LEGACY_RE);
  if (m) return m[1];
  const t = url.trim();
  return QQ_MID_RE.test(t) ? t : undefined;
}

// 封面解析：wikilink → app:// 资源路径；http(s) 原样；色值原样（README 三形态）
export function resolveCover(
  app: App,
  raw: string | undefined,
  fromPath: string
): string | undefined {
  if (!raw) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  const target = app.metadataCache.getFirstLinkpathDest(stripWikilink(s), fromPath);
  if (target instanceof TFile) return app.vault.getResourcePath(target);
  return undefined;
}

// 主解析（同步，走 metadataCache）
export function getAlbumInfo(app: App, file: TFile, opts?: AlbumInfoOpts): AlbumInfo | null {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  if (!fm || !hasAlbumTag(fm)) return null;
  return buildAlbumInfo(app, file, fm, opts);
}

export interface AlbumInfoOpts {
  /** 封面目录（设置项）：用于自动识别「covers/<专辑名>.jpg」这类约定图片 */
  coverFolder?: string;
}

// 约定封面文件名：放进专辑音频文件夹即被自动采用
export const CONVENTION_COVER_NAMES = ['cover', 'folder', 'front'];
const COVER_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp'];

/**
 * 自动识别封面（读时解析，不写笔记——放上文件就生效）：
 *   ① 专辑音频文件夹内的 cover / folder / front / <专辑名>.<图片>
 *   ② 封面目录下与专辑同名的图片（与「导入专辑」下载封面的命名一致）
 */
export function findConventionCover(
  app: App,
  file: TFile,
  audioFolderRef: string | undefined,
  coverFolder: string | undefined
): TFile | null {
  const tryFile = (p: string): TFile | null => {
    const hit = app.vault.getAbstractFileByPath(p);
    return hit instanceof TFile ? hit : null;
  };
  const title = file.basename;
  // ① 音频文件夹（外链绝对路径不查：那是库外目录，交给 fs 的场景不在本模块）
  const ref = String(audioFolderRef || '').trim();
  const folder =
    ref && !/^[a-zA-Z]:[\\/]/.test(ref) ? stripWikilink(ref).replace(/\/+$/, '') : '';
  if (folder) {
    for (const base of [...CONVENTION_COVER_NAMES, title]) {
      for (const ext of COVER_IMAGE_EXTS) {
        const hit = tryFile(normalizePath(`${folder}/${base}.${ext}`));
        if (hit) return hit;
      }
    }
  }
  // ② 封面目录（同名优先）
  if (coverFolder) {
    for (const base of [title, ...CONVENTION_COVER_NAMES]) {
      for (const ext of COVER_IMAGE_EXTS) {
        const hit = tryFile(normalizePath(`${coverFolder}/${base}.${ext}`));
        if (hit) return hit;
      }
    }
  }
  return null;
}

export function buildAlbumInfo(
  app: App,
  file: TFile,
  fm: unknown,
  opts?: AlbumInfoOpts
): AlbumInfo {
  const data = asFrontmatter(fm);
  const source: AlbumSourcePref =
    data.source === 'local' || data.source === 'netease' || data.source === 'qq'
      ? data.source
      : 'auto';
  const coverRaw = data.cover != null ? scalarText(data.cover) : undefined;
  const audioFolderRef = data.audioFolder != null ? scalarText(data.audioFolder) : undefined;
  // 显式 cover 优先；没写封面时按约定自动认一个（不写回笔记）
  let cover = resolveCover(app, coverRaw, file.path);
  if (!cover) {
    const auto = findConventionCover(app, file, audioFolderRef, opts?.coverFolder);
    if (auto) cover = app.vault.getResourcePath(auto);
  }
  return {
    file,
    path: file.path,
    title: file.basename,
    artist: data.artist != null ? scalarText(data.artist) : undefined,
    year: typeof data.year === 'string' || typeof data.year === 'number' ? data.year : undefined,
    genre: data.genre != null ? scalarText(data.genre) : undefined,
    rating:
      typeof data.rating === 'string' || typeof data.rating === 'number'
        ? data.rating
        : undefined,
    coverRaw,
    cover,
    neteaseId: parseNeteaseId(fm),
    qqId: parseQqAlbumMid(fm),
    audioFolderRef,
    audioRefs: Array.isArray(data.audio)
      ? data.audio.map((v) => scalarText(v))
      : data.audio != null
        ? [scalarText(data.audio)]
        : [],
    sourcePref: source,
    displayProps: buildDisplayProps(data),
  };
}

// 模板文件本身不能被当成专辑展示（模板里通常也写着 tags: [album]）；
// 由插件在加载/保存设置时注入（避免 findAlbumNotes 的每个调用点都传参数）。
let albumTemplatePath = '';

export function setAlbumTemplatePath(p: string): void {
  albumTemplatePath = String(p || '').trim();
}

export function findAlbumNotes(app: App): TFile[] {
  return app.vault.getMarkdownFiles().filter((f) => {
    if (albumTemplatePath && f.path === albumTemplatePath) return false;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    return !!fm && hasAlbumTag(fm);
  });
}

// ============ 音源可用性检测（筛选 / 点击与播放行为判定 / 卡片「无音源」提示） ============

export interface AlbumSources {
  local: boolean;
  netease: boolean;
  qq: boolean;
}

// 同步检测（不读取音频内容）：本地 = 引用的音频文件夹/文件实际存在且含受支持音频
export function detectAlbumSources(app: App, album: AlbumInfo): AlbumSources {
  let local = false;
  if (album.audioFolderRef) {
    local = folderRefHasAudio(app, album.audioFolderRef);
  }
  if (!local) {
    for (const ref of album.audioRefs) {
      if (audioRefExists(app, ref)) {
        local = true;
        break;
      }
    }
  }
  return { local, netease: !!album.neteaseId, qq: !!album.qqId };
}

function folderRefHasAudio(app: App, ref: string): boolean {
  const raw = ref.trim();
  if (/^[a-zA-Z]:[\\/]/.test(raw) || path.isAbsolute(raw)) {
    try {
      if (!fs.existsSync(raw) || !fs.statSync(raw).isDirectory()) return false;
      return collectExternalAudios(raw).length > 0;
    } catch {
      return false;
    }
  }
  const folder = app.vault.getAbstractFileByPath(normalizePath(stripWikilink(raw)));
  if (!(folder instanceof TFolder)) return false;
  // 含子目录（文件夹导入保留 CD1/CD2 结构）
  return collectFolderAudios(folder).length > 0;
}

function audioRefExists(app: App, ref: string): boolean {
  const raw = ref.trim();
  if (!raw) return false;
  if (/^[a-zA-Z]:[\\/]/.test(raw) || path.isAbsolute(raw)) {
    try {
      return fs.existsSync(raw) && fs.statSync(raw).isFile() && isAudioFile(raw);
    } catch {
      return false;
    }
  }
  const file = app.vault.getAbstractFileByPath(normalizePath(stripWikilink(raw)));
  return file instanceof TFile && isAudioFile(file.name);
}

// 简易 YAML frontmatter 解析（metadataCache 未命中时的兜底）
export function parseFrontmatterSimple(text: string): Frontmatter {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Frontmatter = {};
  let listKey = '';
  for (const line of m[1].split(/\r?\n/)) {
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && listKey) {
      const list = out[listKey];
      if (Array.isArray(list)) list.push(unquote(listMatch[1].trim()));
      continue;
    }
    listKey = '';
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const rawVal = kv[2].trim();
    if (rawVal === '') {
      // 数组起始
      out[key] = [];
      listKey = key;
      continue;
    }
    out[key] = unquote(rawVal);
  }
  return out;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
