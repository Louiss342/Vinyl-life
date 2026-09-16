// Vinyl Life — 通用小工具

import { App, Plugin, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import * as path from 'path';
import { readdirSync as fsReaddirSync } from 'fs';
import type { Dirent } from 'fs';
import { t, tf } from './core/i18n';

// 受支持的音频容器（插件本身不解码，最终取决于 Chromium/Electron 内置解码器）：
//   mp3 · m4a / m4b / mp4（AAC · ALAC）· wav · ogg / oga（vorbis）· opus · aac（ADTS）· webm / weba
// 不在此列的（ape / wma / dsf / dff / tak / aiff 等）导入时跳过并提示，需自行转码。
export const AUDIO_EXTENSIONS = [
  'mp3', 'm4a', 'm4b', 'mp4', 'wav', 'ogg', 'oga', 'flac', 'aac', 'opus', 'webm', 'weba',
];

const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  webm: 'audio/webm',
  weba: 'audio/webm',
};

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function isAudioFile(name: string): boolean {
  return AUDIO_EXTENSIONS.includes(extOf(name));
}

/** 图片扩展名（封面自动识别 / 选择器过滤用） */
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'];

export function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.includes(extOf(name));
}

/** unknown → 字符串：只认标量（string / number / boolean / bigint），其余（对象 / 数组 / 函数）
 *  一律返回 ''。用于 frontmatter 等外部数据——直接 String() 会把对象印成 [object Object]。 */
export function scalarText(v: unknown): string {
  switch (typeof v) {
    case 'string':
      return v;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(v);
    default:
      return '';
  }
}

// ============ 文件夹导入（一张专辑一个文件夹） ============

export interface PickedAudio {
  file: File;
  /** 相对路径（文件夹选择器用 webkitRelativePath；拖拽由扫描器注入） */
  relPath: string;
}

export interface FolderScan {
  /** 选中的文件夹名（专辑名建议值） */
  rootName: string;
  /** 全部受支持音频（含子目录） */
  files: File[];
  /** 根层音频数 */
  rootAudio: number;
  /** 含音频的一级子目录数 */
  audioSubfolders: number;
  /** 非音频文件数（封面 / cue / log 等，导入时忽略） */
  others: number;
  /** album = 直接建一张专辑；library = 像音乐库根目录（多张专辑）；empty = 没有音频 */
  verdict: 'album' | 'library' | 'empty';
}

/** 相对路径 → 子目录（去掉根文件夹与文件名）：`A/CD1/01.flac` → `CD1` */
export function relDirOfPath(relPath: string): string {
  const segs = String(relPath || '').split('/').filter(Boolean);
  return segs.length <= 1 ? '' : segs.slice(1, -1).join('/');
}

/** File → 相对路径（选择器读 webkitRelativePath；拖拽由扫描器注入 relPath） */
export function relPathOf(file: File): string {
  return String(file.webkitRelativePath || file.relPath || '');
}

/** File → 子目录（`A/CD1/01.flac` → `CD1`） */
export function relDirOf(file: File): string {
  return relDirOfPath(relPathOf(file));
}

/** 拖拽结果的根文件夹名（≥2 段相对路径的第一段；散选文件为空） */
export function droppedRootName(picked: PickedAudio[]): string {
  const roots = new Set<string>();
  for (const p of picked) {
    const segs = p.relPath.split('/').filter(Boolean);
    if (segs.length >= 2) roots.add(segs[0]);
  }
  return roots.size === 1 ? [...roots][0] : '';
}

/** 拖入的目录条目递归展开（readEntries 每次最多 100 条，必须循环到空） */
async function readEntry(entry: FileSystemEntry, parent: string, out: PickedAudio[]): Promise<void> {
  const path = parent + entry.name;
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
    try {
      file.relPath = path; // 供 relDirOf / 子目录保留使用
    } catch {
      // Some browser File implementations are non-extensible; PickedAudio still keeps relPath.
    }
    out.push({ file, relPath: path });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject)
    );
    if (!batch.length) break;
    for (const child of batch) await readEntry(child, path + '/', out);
  }
}

/** DataTransfer → 展开后的文件（文件夹递归；拿不到 entry 时退回普通文件列表） */
export async function collectDroppedFiles(dt: DataTransfer): Promise<PickedAudio[]> {
  const entries = Array.from(dt.items || [])
    .map((it) =>
      typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null
    )
    .filter((e): e is FileSystemEntry => e !== null);
  if (entries.length) {
    const out: PickedAudio[] = [];
    for (const entry of entries) await readEntry(entry, '', out);
    return out;
  }
  return Array.from(dt.files || []).map((file) => ({ file, relPath: '' }));
}

export interface LibraryCandidate {
  name: string;
  files: File[];
}

/** 音乐库根目录 → 按一级子文件夹分组成「每张专辑一批」 */
export function libraryCandidates(items: PickedAudio[]): LibraryCandidate[] {
  const map = new Map<string, File[]>();
  for (const it of items) {
    if (!isAudioFile(it.file.name)) continue;
    const top = relDirOfPath(it.relPath).split('/')[0];
    if (!top) continue;
    const list = map.get(top) || [];
    list.push(it.file);
    map.set(top, list);
  }
  return [...map.entries()]
    .map(([name, files]) => ({ name, files }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

/**
 * 递归收集文件夹内的音频文件（含子目录）：文件夹导入会保留 CD1/CD2 结构，
 * 只扫顶层的话这类专辑会被判成「没有本地音源」而无法播放。
 */
export function collectFolderAudios(folder: TFolder): TFile[] {
  const out: TFile[] = [];
  const walk = (f: TFolder) => {
    for (const child of f.children) {
      if (child instanceof TFolder) walk(child);
      else if (child instanceof TFile && isAudioFile(child.name)) out.push(child);
    }
  };
  walk(folder);
  return out;
}

/** 递归收集库外目录内的音频绝对路径（同一目的，走 fs） */
export function collectExternalAudios(dir: string, depth = 3): string[] {
  const out: string[] = [];
  const walk = (d: string, left: number) => {
    let entries: Dirent[];
    try {
      entries = fsReaddirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isFile() && isAudioFile(e.name)) out.push(full);
      else if (e.isDirectory() && left > 0) walk(full, left - 1);
    }
  };
  walk(dir, depth);
  return out;
}

/** 音乐库根目录提示（弹窗与专辑墙共用同一句判定说明） */
export function libraryRootHint(scan: FolderScan): string {
  return tf('util.libraryRootHint', { name: scan.rootName, n: scan.audioSubfolders });
}

/** 碟号子目录（CD1 / Disc 2 / Vol.3 …）：属于同一张专辑 */
const DISC_DIR_RE = /^(cd|disc|disk|vol|volume|part|pt)[\s._-]*\d+$/i;

/**
 * 判断选中的文件夹该怎么导入：
 *   根层有音频 → 一张专辑（子目录一起收进来）
 *   根层没有、只有 1 个子目录有音频 → 仍按根文件夹名建一张专辑
 *   根层没有、子目录都是碟号（CD1 / CD2）→ 仍是同一张专辑
 *   否则（A / B 各含音频）→ 看起来是音乐库根目录，别糊成一张专辑
 */
export function analyzeFolder(rootName: string, items: PickedAudio[]): FolderScan {
  const audioItems = items.filter((it) => isAudioFile(it.file.name));
  const others = items.length - audioItems.length;
  const rootAudio = audioItems.filter((it) => !relDirOfPath(it.relPath)).length;
  const subs = new Set<string>();
  for (const it of audioItems) {
    const dir = relDirOfPath(it.relPath);
    if (dir) subs.add(dir.split('/')[0]);
  }
  const subNames = [...subs];
  const allDiscs = subNames.length > 0 && subNames.every((s) => DISC_DIR_RE.test(s));
  const verdict: FolderScan['verdict'] = !audioItems.length
    ? 'empty'
    : rootAudio > 0 || subs.size <= 1 || allDiscs
      ? 'album'
      : 'library';
  return {
    rootName,
    files: audioItems.map((it) => it.file),
    rootAudio,
    audioSubfolders: subs.size,
    others,
    verdict,
  };
}

/** 拆分拖入 / 选中的文件：受支持的音频 / 因格式不支持而跳过的 */
export function splitAudioFiles(files: File[]): { audio: File[]; skipped: File[] } {
  const audio: File[] = [];
  const skipped: File[] = [];
  for (const f of files) (isAudioFile(f.name) ? audio : skipped).push(f);
  return { audio, skipped };
}

/**
 * 从所选文件推断专辑名：
 *   多个文件来自同一目录 → 目录名（常见于「一张专辑一个文件夹」）；否则首个文件名。
 *   单文件不用目录名，避免把 `D:/Music/xx.mp3` 猜成「Music」。
 */
export function suggestAlbumTitle(files: File[]): string {
  const list = files.filter((f) => isAudioFile(f.name));
  if (!list.length) return '';
  const dirOf = (f: File): string => {
    const p = f.path;
    if (typeof p !== 'string') return '';
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i > 0 ? p.slice(0, i) : '';
  };
  const dirs = list.map(dirOf);
  const first = dirs[0];
  if (list.length >= 2 && first && dirs.every((d) => d === first)) {
    const seg = first.split(/[\\/]/).filter(Boolean).pop();
    if (seg) return seg;
  }
  return baseName(list[0].name);
}

/** 跳过提示文案（最多列 3 个文件名，避免提示过长） */
export function skippedFormatsText(names: string[]): string {
  const head = names.slice(0, 3).join(t('common.listSep'));
  return tf('util.skippedFormats', {
    n: names.length,
    names: head,
    more: names.length > 3 ? t('util.skippedFormatsMore') : '',
  });
}

export function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

// wikilink 剥壳（卡片属性格式化与路径解析共用；此处是依赖链叶子，避免 album-index ↔ shelf-props 成环）
const WIKILINK_RE = /^\[\[([^\]|#]+)(?:[^\]|]*)\]\]$/;

export function stripWikilink(v: string): string {
  const m = v.trim().match(WIKILINK_RE);
  return m ? m[1].trim() : v.trim();
}

export function mimeFromName(name: string): string {
  return MIME_BY_EXT[extOf(name)] || 'application/octet-stream';
}

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '–:–';
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// 网易云播放限制码 → 提示文案
export function restrictionText(code: number | string | undefined | null): string {
  const c = String(code ?? '');
  if (['401', '10407'].includes(c)) return t('util.restrictionLoginRequired');
  if (['403'].includes(c)) return t('util.restrictionVip');
  if (['404', '10404'].includes(c)) return t('util.restrictionCopyright');
  if (['405', '10411'].includes(c)) return t('util.restrictionTrial');
  return c ? tf('util.restrictionUnknown', { code: c }) : t('util.restrictionUnavailable');
}

// 插件目录绝对路径（Obsidian 进程 cwd ≠ vault 根，相对路径会静默失效）
export function pluginAbsPath(plugin: Plugin, ...parts: string[]): string {
  let base = '';
  try {
    const adapter = plugin.app.vault.adapter as { getBasePath?: () => string };
    if (typeof adapter.getBasePath === 'function') base = adapter.getBasePath() || '';
  } catch {
    // Non-filesystem adapters cannot expose an absolute vault path.
  }
  const dir = plugin.manifest.dir || '';
  const absDir = path.isAbsolute(dir) ? dir : path.join(base, dir);
  return path.join(absDir, ...parts);
}

export function notice(msg: string, ms?: number) {
  new Notice(`Vinyl Life · ${msg}`, ms);
}

// 目录不存在则创建（vault.create / createBinary 不会自动建父目录）：
// 新装用户首次运行时用来搭出 Vinyl Life/{audio, covers, Vinyl Note}
export async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const p = normalizePath(String(folderPath || ''));
  if (!p) return;
  if (app.vault.getAbstractFileByPath(p)) return;
  try {
    await app.vault.createFolder(p); // 会自动创建缺失的上级目录
  } catch (e) {
    if (!app.vault.getAbstractFileByPath(p)) throw e; // 并发创建已存在之外的失败照常抛出
  }
}

// 文件名净化（Obsidian vault 与 Windows 双重要求：禁 # ^ [ ] 与 \ / : * ? " < > |）
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#^[\]]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\s+$/, '')
    .trim();
  return cleaned || 'untitled';
}

/** 系统「减少动态效果」是否开启（前庭敏感的用户靠它关掉转盘与交接动画）。
 *  拿不到 matchMedia（脚本沙箱 / 老环境）按 false 处理：宁可有动画，也别在渲染路径上抛。 */
export function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}
