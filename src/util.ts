// Vinyl Life — 通用小工具

import { App, Plugin, Notice, normalizePath } from 'obsidian';
import * as path from 'path';

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
  return new Promise((r) => setTimeout(r, ms));
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

/** File → 子目录（选择器读 webkitRelativePath；拖拽读注入的 relPath） */
export function relDirOf(file: File): string {
  const anyFile = file as any;
  return relDirOfPath(String(anyFile.webkitRelativePath || anyFile.relPath || ''));
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
    const p = (f as any).path;
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
  const head = names.slice(0, 3).join('、');
  return `已跳过 ${names.length} 个不支持的文件：${head}${names.length > 3 ? ' 等' : ''}`;
}

export function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

// wikilink 剥壳（M7 从 album-index 移入：卡片属性格式化与路径解析共用，且此处是依赖链叶子，避免 album-index ↔ shelf-props 成环）
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

// 网易云播放限制码 → 提示文案（M0 已定映射，方案 5.4）
export function restrictionText(code: number | string | undefined | null): string {
  const c = String(code ?? '');
  if (['401', '10407'].includes(c)) return '需登录（login_required）';
  if (['403'].includes(c)) return '会员专享（vip_required）';
  if (['404', '10404'].includes(c)) return '无版权/下架（copyright_unavailable）';
  if (['405', '10411'].includes(c)) return '仅试听（trial_only）';
  return c ? `未知限制码 ${c}` : '音源不可用';
}

// 插件目录绝对路径（M0 三连坑：Obsidian 进程 cwd ≠ vault 根，相对路径静默失效）
export function pluginAbsPath(plugin: Plugin, ...parts: string[]): string {
  let base = '';
  try {
    const adapter = plugin.app.vault.adapter as any;
    if (typeof adapter.getBasePath === 'function') base = adapter.getBasePath() || '';
  } catch (_) {}
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
    .replace(/[\\/:*?"<>|#^\[\]]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\s+$/, '')
    .trim();
  return cleaned || 'untitled';
}
