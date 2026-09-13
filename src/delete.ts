// 专辑删除：专辑墙右键「删除专辑…」的资产盘点 + 清理。
// 原则（与 import.ts 对称）：
//   1. 只动 vault 内文件——外链绝对路径音频（link 模式）永不删除，仅提示；
//   2. 仍被其他专辑引用的音频/封面不删（含「其他专辑文件夹在本文件夹内」的嵌套情形）；
//   3. 文件夹内混有非音频文件时，只删音频、文件夹保留（整目录进回收站会连带删掉笔记/PDF 等）；
//   4. 删除走 app.fileManager.trashFile，尊重 Obsidian「已删除文件」设置（回收站 / 永久删除）。
import { App, TAbstractFile, TFile, TFolder, normalizePath } from 'obsidian';
import * as path from 'path';
import {
  AlbumInfo,
  findAlbumNotes,
  getAlbumInfo,
  stripWikilink,
} from './core/album-index';
import { isAudioFile } from './util';

export interface AlbumDeleteTargets {
  /** vault 内音频文件夹（仅本专辑引用，可删） */
  audioFolders: TFolder[];
  /** vault 内音频文件（仅本专辑引用，可删；不含已在可删文件夹内的） */
  audioFiles: TFile[];
  /** 被其他专辑同时引用的 vault 内路径（列出提示，不删） */
  sharedAudioPaths: string[];
  /** 外链绝对路径音频（库外文件，不删，仅提示） */
  externalAudioRefs: string[];
  /** vault 内封面文件（仅本专辑引用，可删） */
  coverFile: TFile | null;
  /** 封面仍被其他专辑引用（不删） */
  coverShared: boolean;
  /** 混有非音频文件而保留的文件夹：只删其中音频，文件夹与非音频内容保留 */
  keptFolders: { path: string; audios: number; others: string[] }[];
}

export interface AlbumDeleteOptions {
  audio: boolean;
  cover: boolean;
}

function isExternalRef(ref: string): boolean {
  const s = String(ref || '').trim();
  return /^[a-zA-Z]:[\\/]/.test(s) || path.isAbsolute(s);
}

// 引用 → vault 内文件/文件夹（wikilink / vault 路径；外链与不存在返回 null）
function resolveVaultRef(app: App, ref: string | undefined | null): TAbstractFile | null {
  if (ref == null) return null;
  const raw = String(ref).trim();
  if (!raw || isExternalRef(raw)) return null;
  return app.vault.getAbstractFileByPath(normalizePath(stripWikilink(raw)));
}

// 封面 → vault 内文件（http 链接 / 纯色值不算资产；wikilink 走 linkpath 解析）
function resolveCoverFile(app: App, album: AlbumInfo): TFile | null {
  const raw = album.coverRaw?.trim();
  if (!raw || /^https?:\/\//i.test(raw) || /^#[0-9a-fA-F]{3,8}$/.test(raw)) return null;
  const dest = app.metadataCache.getFirstLinkpathDest(stripWikilink(raw), album.path);
  if (dest instanceof TFile) return dest;
  const fallback = resolveVaultRef(app, raw);
  return fallback instanceof TFile ? fallback : null;
}

// 其他专辑占用的 vault 内资源路径集合
function otherAlbumResourcePaths(app: App, album: AlbumInfo): Set<string> {
  const used = new Set<string>();
  for (const f of findAlbumNotes(app)) {
    if (f.path === album.path) continue;
    const info = getAlbumInfo(app, f);
    if (!info) continue;
    for (const ref of [info.audioFolderRef, ...info.audioRefs]) {
      const t = resolveVaultRef(app, ref);
      if (t) used.add(t.path);
    }
    const cov = resolveCoverFile(app, info);
    if (cov) used.add(cov.path);
  }
  return used;
}

// 文件夹是否被他人占用（自身命中，或他人资源位于其子目录内）
function folderClaimedByOthers(folderPath: string, used: Set<string>): boolean {
  if (used.has(folderPath)) return true;
  const prefix = folderPath + '/';
  for (const p of used) if (p.startsWith(prefix)) return true;
  return false;
}

export function collectAlbumDeleteTargets(app: App, album: AlbumInfo): AlbumDeleteTargets {
  const used = otherAlbumResourcePaths(app, album);
  const audioFolders: TFolder[] = [];
  const audioFiles: TFile[] = [];
  const sharedAudioPaths: string[] = [];
  const externalAudioRefs: string[] = [];
  const keptFolders: { path: string; audios: number; others: string[] }[] = [];
  const seen = new Set<string>();

  const folderRef = album.audioFolderRef?.trim();
  if (folderRef) {
    if (isExternalRef(folderRef)) {
      externalAudioRefs.push(folderRef);
    } else {
      const folder = resolveVaultRef(app, folderRef);
      if (folder instanceof TFolder) {
        if (folderClaimedByOthers(folder.path, used)) sharedAudioPaths.push(folder.path);
        else {
          const { audios, others } = scanFolderContents(folder);
          if (others.length) {
            // 混有非音频文件：整目录进回收站会连带删掉它们 → 只删音频，文件夹保留
            keptFolders.push({
              path: folder.path,
              audios: audios.length,
              others: others.map((f) => f.path),
            });
            for (const a of audios) {
              if (!seen.has(a.path)) {
                audioFiles.push(a);
                seen.add(a.path);
              }
            }
          } else {
            audioFolders.push(folder);
            seen.add(folder.path);
          }
        }
      }
    }
  }

  for (const ref of album.audioRefs) {
    if (isExternalRef(ref)) {
      externalAudioRefs.push(ref.trim());
      continue;
    }
    const f = resolveVaultRef(app, ref);
    if (!(f instanceof TFile) || !isAudioFile(f.name) || seen.has(f.path)) continue;
    if (used.has(f.path)) sharedAudioPaths.push(f.path);
    else {
      audioFiles.push(f);
      seen.add(f.path);
    }
  }

  // 可删文件夹内的音频文件已随文件夹一并删除，避免先删子项再删父目录
  const folderPrefixes = audioFolders.map((f) => f.path + '/');
  const standaloneFiles = audioFiles.filter(
    (f) => !folderPrefixes.some((p) => f.path.startsWith(p))
  );

  const coverFile = resolveCoverFile(app, album);
  return {
    audioFolders,
    audioFiles: standaloneFiles,
    sharedAudioPaths,
    externalAudioRefs,
    coverFile,
    coverShared: !!coverFile && used.has(coverFile.path),
    keptFolders,
  };
}

// 递归扫描文件夹内容（音频 / 非音频分开）：判断「整目录删除」是否安全
export function scanFolderContents(folder: TFolder): { audios: TFile[]; others: TFile[] } {
  const audios: TFile[] = [];
  const others: TFile[] = [];
  const walk = (f: TFolder) => {
    for (const child of f.children) {
      if (child instanceof TFolder) walk(child);
      else if (child instanceof TFile) (isAudioFile(child.name) ? audios : others).push(child);
    }
  };
  walk(folder);
  return { audios, others };
}

// 递归统计文件夹内音频数（弹窗展示用）
export function countFolderAudios(folder: TFolder): number {
  let n = 0;
  for (const child of folder.children) {
    if (child instanceof TFolder) n += countFolderAudios(child);
    else if (child instanceof TFile && isAudioFile(child.name)) n++;
  }
  return n;
}

// 执行清理：删除顺序为「文件 → 文件夹 → 封面」，任一步失败即抛出，由调用方提示
export async function deleteAlbumAssets(
  app: App,
  targets: AlbumDeleteTargets,
  opts: AlbumDeleteOptions
): Promise<number> {
  let removed = 0;
  if (opts.audio) {
    for (const f of targets.audioFiles) {
      await app.fileManager.trashFile(f);
      removed++;
    }
    for (const d of targets.audioFolders) {
      await app.fileManager.trashFile(d);
      removed++;
    }
  }
  if (opts.cover && targets.coverFile) {
    await app.fileManager.trashFile(targets.coverFile);
    removed++;
  }
  return removed;
}
