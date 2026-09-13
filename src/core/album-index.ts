// 专辑笔记索引：metadataCache 过滤 tags:[album]，解析 frontmatter 为 AlbumInfo。
// 向后兼容（方案 5.1）：netease 旧字段 URL 正则解析；本地引用支持 wikilink / 外链绝对路径。
import { App, TFile, TFolder, normalizePath } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { isAudioFile, stripWikilink } from '../util';
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

function toTagList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(/,\s*/);
  return [];
}

export function hasAlbumTag(fm: any): boolean {
  return toTagList(fm?.tags).some((t) => t.replace(/^\[|\]$/g, '').trim() === 'album');
}

export function parseNeteaseId(fm: any): number | undefined {
  const raw = fm?.neteaseId;
  if (raw) {
    const n = Number(raw);
    if (isFinite(n)) return n;
  }
  const url = String(fm?.netease ?? '');
  const m = url.match(NETEASE_ALBUM_RE);
  return m ? Number(m[1]) : undefined;
}

// QQ 专辑 mid 解析：qqId 裸 mid / qq 链接（新版 albumDetail、旧版 /album/<mid>.html）
export function parseQqAlbumMid(fm: any): string | undefined {
  const bare = fm?.qqId;
  if (bare != null) {
    const t = String(bare).trim();
    if (QQ_MID_RE.test(t)) return t;
  }
  const url = String(fm?.qq ?? '');
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
export function getAlbumInfo(app: App, file: TFile): AlbumInfo | null {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  if (!fm || !hasAlbumTag(fm)) return null;
  return buildAlbumInfo(app, file, fm);
}

export function buildAlbumInfo(app: App, file: TFile, fm: any): AlbumInfo {
  const source: AlbumSourcePref =
    fm.source === 'local' || fm.source === 'netease' || fm.source === 'qq'
      ? fm.source
      : 'auto';
  const coverRaw = fm.cover != null ? String(fm.cover) : undefined;
  return {
    file,
    path: file.path,
    title: file.basename,
    artist: fm.artist != null ? String(fm.artist) : undefined,
    year: fm.year,
    genre: fm.genre != null ? String(fm.genre) : undefined,
    rating: fm.rating,
    coverRaw,
    cover: resolveCover(app, coverRaw, file.path),
    neteaseId: parseNeteaseId(fm),
    qqId: parseQqAlbumMid(fm),
    audioFolderRef: fm.audioFolder != null ? String(fm.audioFolder) : undefined,
    audioRefs: Array.isArray(fm.audio)
      ? fm.audio.map(String)
      : fm.audio != null
        ? [String(fm.audio)]
        : [],
    sourcePref: source,
    displayProps: buildDisplayProps(fm),
  };
}

export function findAlbumNotes(app: App): TFile[] {
  return app.vault.getMarkdownFiles().filter((f) => {
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
      return fs.readdirSync(raw).some((n) => isAudioFile(n));
    } catch {
      return false;
    }
  }
  const folder = app.vault.getAbstractFileByPath(normalizePath(stripWikilink(raw)));
  if (!(folder instanceof TFolder)) return false;
  return folder.children.some((c) => c instanceof TFile && isAudioFile(c.name));
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

// 简易 YAML frontmatter 解析（metadataCache 未命中时的兜底，自检/导入用）
export function parseFrontmatterSimple(text: string): any {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: any = {};
  let listKey = '';
  for (const line of m[1].split(/\r?\n/)) {
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && listKey) {
      out[listKey].push(unquote(listMatch[1].trim()));
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
