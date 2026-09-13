// 本地源（零后端）：
//   vault 内  → adapter 扫描 + getResourcePath 流式直出（首选），readBinary→Blob 兜底
//   外链绝对路径 → Node fs 扫描/读取 → Blob URL（按文件缓存，内存拷贝）
// Blob URL 生命周期：按专辑小缓存，切专辑回收，unload 全清。
import { App, TFile, TFolder, normalizePath } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { AlbumInfo, stripWikilink } from './album-index';
import { Track, trackKey } from './track';
import {
  isAudioFile,
  baseName,
  mimeFromName,
  collectFolderAudios,
  collectExternalAudios,
} from '../util';

export class LocalSource {
  private blobUrls = new Map<string, string>();

  constructor(private app: App) {}

  // ============ 专辑 → 本地 Track 列表 ============

  async buildTracks(album: AlbumInfo): Promise<Track[]> {
    const out: Track[] = [];
    if (album.audioFolderRef) {
      out.push(...(await this.scanFolderRef(album, album.audioFolderRef)));
    }
    for (const ref of album.audioRefs) {
      const t = await this.resolveAudioRef(album, ref);
      if (t) out.push(t);
    }
    // 去重（audioFolder 与 audio 列表可能重叠）
    const seen = new Set<string>();
    return out.filter((t) => {
      const k = trackKey(t);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // 队列用到的 Blob key 集合（切专辑时保留这些，回收其余）
  keysOf(tracks: Track[]): Set<string> {
    const s = new Set<string>();
    for (const t of tracks) {
      if (t.source === 'local-external') s.add(t.path);
      else if (t.source === 'local-vault') s.add('vault:' + t.file.path);
    }
    return s;
  }

  clearBlobs(keep?: Set<string>) {
    for (const [k, url] of [...this.blobUrls]) {
      if (keep && keep.has(k)) continue;
      try {
        URL.revokeObjectURL(url);
      } catch (_) {}
      this.blobUrls.delete(k);
    }
  }

  clearAllBlobs() {
    this.clearBlobs();
  }

  private isAbsolutePathRef(ref: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(ref) || path.isAbsolute(ref);
  }

  private async scanFolderRef(album: AlbumInfo, ref: string): Promise<Track[]> {
    const raw = ref.trim();
    if (this.isAbsolutePathRef(raw)) return this.scanExternalFolder(album, raw);
    // vault 内文件夹：wikilink 或相对路径
    const clean = stripWikilink(raw);
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(clean));
    if (!(folder instanceof TFolder)) return [];
    // 含子目录：文件夹导入会保留 CD1/CD2 结构，只扫顶层会变成「无本地音源」
    return collectFolderAudios(folder)
      .map((f) => this.vaultTrack(album, f))
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  }

  private scanExternalFolder(album: AlbumInfo, absDir: string): Track[] {
    return collectExternalAudios(absDir)
      .map((p) => this.externalTrack(album, p))
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  }

  private async resolveAudioRef(album: AlbumInfo, ref: string): Promise<Track | null> {
    const raw = ref.trim();
    if (!raw) return null;
    if (this.isAbsolutePathRef(raw)) {
      try {
        if (!fs.existsSync(raw) || !fs.statSync(raw).isFile()) return null;
      } catch {
        return null;
      }
      return this.externalTrack(album, raw);
    }
    const clean = stripWikilink(raw);
    const file = this.app.vault.getAbstractFileByPath(normalizePath(clean));
    if (file instanceof TFile && isAudioFile(file.name)) return this.vaultTrack(album, file);
    return null;
  }

  private metaOf(album: AlbumInfo) {
    return {
      artist: album.artist,
      album: album.title,
      cover: album.cover,
      albumNotePath: album.path,
    };
  }

  private vaultTrack(album: AlbumInfo, file: TFile): Track {
    return {
      source: 'local-vault',
      file,
      title: baseName(file.name),
      ...this.metaOf(album),
    };
  }

  private externalTrack(album: AlbumInfo, absPath: string): Track {
    return {
      source: 'local-external',
      path: absPath,
      title: baseName(path.basename(absPath)),
      ...this.metaOf(album),
    };
  }

  // ============ 可播放地址解析 ============

  // vault：getResourcePath 流式直出，失败由引擎回退 readBinary→Blob
  resolveVaultUrl(file: TFile): string {
    return this.app.vault.getResourcePath(file);
  }

  async resolveVaultBlobUrl(file: TFile): Promise<string> {
    const key = 'vault:' + file.path;
    const hit = this.blobUrls.get(key);
    if (hit) return hit;
    const buf = await this.app.vault.readBinary(file);
    const blob = new Blob([buf], { type: mimeFromName(file.name) });
    const url = URL.createObjectURL(blob);
    this.blobUrls.set(key, url);
    return url;
  }

  // 外链：fs → Blob URL（按文件缓存）
  resolveExternalUrl(absPath: string): string {
    const hit = this.blobUrls.get(absPath);
    if (hit) return hit;
    const buf = fs.readFileSync(absPath);
    const blob = new Blob([buf], { type: mimeFromName(absPath) });
    const url = URL.createObjectURL(blob);
    this.blobUrls.set(absPath, url);
    return url;
  }
}
