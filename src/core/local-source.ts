// 本地源：
//   vault 内  → adapter 扫描 + getResourcePath 流式直出（首选），readBinary→Blob 兜底
//   外链绝对路径 → 网关按 HTTP Range 供流（首选，整轨不进内存），
//                  Node fs 读成 Blob 兜底（按文件缓存 + 字节预算回收）
// Blob URL 生命周期：按专辑小缓存，切专辑回收，unload 全清。
// 库外音频本来就不在 Obsidian API 的范围内，只能用 fs —— 审核披露的 fs 能力主要来自这里
// 与 credential-file（为什么需要，见 CONTRIBUTING）。
// 「库外音频会用到网关」是 Range 供流的代价：README 与 CONTRIBUTING 都写明了，
// 起不来网关时自动退回整文件 Blob（功能不变，只是内存回到旧口径）。
import { App, TFile, TFolder, normalizePath } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { AlbumInfo, stripWikilink } from './album-index';
import { Track, trackKey } from './track';
import { decodeLyricBytes } from './lyrics';
import { audioTagReadHint, parseAudioTags, TAG_PREFIX_BYTES, type AudioTags } from './audio-tags';
import {
  isAudioFile,
  baseName,
  mimeFromName,
  collectFolderAudios,
  collectExternalAudios,
} from '../util';

/** Blob 缓存的字节预算（见 evictBlobs）。192 MB ≈ 三四首无损，够「来回切两首」不重读，
 *  又不至于把整张专辑留到播放结束。 */
export const BLOB_BUDGET_BYTES = 192 * 1024 * 1024;

/** 供流宿主（本机网关）：库外音频按 HTTP Range 供流，整轨不进内存。
 *  ServerManager 结构化满足它（base / token / state / ensure）—— 这里只声明接口，
 *  不 import server-manager：依赖方向闸门（T0.1）之外，也少一层 core 内部耦合。 */
export interface RangeStreamHost {
  readonly base: string;
  readonly token: string;
  readonly state: 'stopped' | 'starting' | 'running' | 'error';
  ensure(): Promise<boolean>;
  /** 登记要供流的绝对路径：网关只供登记过的路径（见 server/gateway.js 的 /api/local/allow） */
  allowStreamPaths(paths: string[]): Promise<boolean>;
}

/** 本地曲目顺序：有音轨号的按音轨号（'01 - x.mp3' 这种文件名排序在 10 之后会乱），
 *  其余的按标题（中文按拼音序）—— 两者混排时无音轨号的沉到最后。 */
export function compareByTrack(a: Track, b: Track): number {
  const at = a.track ?? Number.MAX_SAFE_INTEGER;
  const bt = b.track ?? Number.MAX_SAFE_INTEGER;
  if (at !== bt) return at - bt;
  return a.title.localeCompare(b.title, 'zh-CN');
}

export class LocalSource {
  private blobUrls = new Map<string, string>();
  /** 每份 Blob 的字节数（预算回收用；Map 的插入顺序即「最近使用」顺序，命中时重新插入） */
  private blobBytes = new Map<string, number>();
  private blobTotal = 0;
  /** 本次会话里网关供流失败过：不再主动启动网关 —— 否则每次切曲都要在失败的启动上等一轮。
   *  但网关后来因别的功能起来了（state 回到 running）就照用，不必等插件重载。 */
  private streamFailed = false;
  /** 已经登记给网关白名单的绝对路径（本会话）。登记是幂等的，但没必要每取一次流都发一遍。 */
  private allowedPaths = new Set<string>();

  /** blobBudget / streamHost 只给测试与装配注入用（生产：默认预算 + main.ts 传网关） */
  constructor(
    private app: App,
    private blobBudget: number = BLOB_BUDGET_BYTES,
    private streamHost: RangeStreamHost | null = null
  ) {}

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
      this.revokeBlob(k, url);
    }
  }

  /** 回收一份 Blob（三个账本一起清：url / 字节数 / 总量） */
  private revokeBlob(key: string, url: string): void {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // 已被释放 / 非法 URL：继续清缓存条目即可
    }
    this.blobUrls.delete(key);
    this.blobTotal -= this.blobBytes.get(key) ?? 0;
    this.blobBytes.delete(key);
  }

  /** 按字节预算回收：超出预算时丢**最久没用过**的那份，直到回到预算内。
   *  keepKey（本次要用的那份）永不回收 —— 正在播的 Blob 被 revoke 会让播放断掉。
   *  为什么需要：缓存原本只按「切专辑」清，一张 20 首的库外 FLAC 专辑能留到 GB 级内存。
   *  这是把「常驻内存」压到可接受范围的最后一道；想连单曲那一份也不驻留，
   *  得让网关按 HTTP Range 供文件（方案 §6.3 的事）。 */
  private evictBlobs(keepKey: string): void {
    if (this.blobBudget <= 0) return;
    for (const [k, url] of [...this.blobUrls]) {
      if (this.blobTotal <= this.blobBudget) return;
      if (k === keepKey) continue;
      this.revokeBlob(k, url);
    }
  }

  /** 记一份新 Blob 并跑一次预算回收；命中已有条目时把它挪到「最近使用」的一端 */
  private rememberBlob(key: string, url: string, size: number): void {
    const stale = this.blobUrls.get(key);
    if (stale !== undefined) this.revokeBlob(key, stale);
    this.blobUrls.set(key, url);
    this.blobBytes.set(key, size);
    this.blobTotal += size;
    this.evictBlobs(key);
  }

  /** 命中缓存：把这条挪到 Map 末尾 = 最近使用（Map 的插入顺序就是回收顺序） */
  private touchBlob(key: string): void {
    const url = this.blobUrls.get(key);
    if (url === undefined) return;
    this.blobUrls.delete(key);
    this.blobUrls.set(key, url);
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
      .sort(compareByTrack);
  }

  private scanExternalFolder(album: AlbumInfo, absDir: string): Track[] {
    return collectExternalAudios(absDir)
      .map((p) => this.externalTrack(album, p))
      .sort(compareByTrack);
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

  /** 库内音频的绝对路径（读标签用）。Obsidian 的 vault API 只能整文件读，而标签要的是前缀，
   *  所以这里走 fs 读同一个文件的前 128 KB（CONTRIBUTING 的能力披露里写了这条）；
   *  adapter 不给绝对路径（非文件系统适配器）时回 null，调用方退回文件名。 */
  private vaultAbsPath(file: TFile): string | null {
    try {
      const adapter = this.app.vault.adapter as { getBasePath?: () => string };
      const base = typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : '';
      return base ? path.join(base, file.path) : null;
    } catch {
      return null;
    }
  }

  /** 内嵌标签：读文件头 → 解析（见 core/audio-tags）。读不到 / 不是认识的容器都回空对象 ——
   *  曲名回退文件名、艺人与专辑回退笔记里的值，功能不因为「这个文件没标签」而变。 */
  private tagsOf(absPath: string | null): AudioTags {
    if (!absPath) return {};
    const buf = this.tagPrefix(absPath);
    return buf ? parseAudioTags(buf) : {};
  }

  /** 读标签用的文件头。只读前缀而不是整个文件：30 MB 的无损不该为了一个曲名被读进内存
   *  （与库外音频走 Range 供流是同一个道理）。ID3v2 声明比前缀长时按声明补读一次，封顶 4 MB。 */
  private tagPrefix(absPath: string): Uint8Array | null {
    try {
      const fd = fs.openSync(absPath, 'r');
      try {
        const first = Buffer.alloc(TAG_PREFIX_BYTES);
        const got = fs.readSync(fd, first, 0, TAG_PREFIX_BYTES, 0);
        const head = first.subarray(0, got);
        const want = audioTagReadHint(head);
        if (want <= got) return head;
        const full = Buffer.alloc(want);
        const gotMore = fs.readSync(fd, full, 0, want, 0);
        return full.subarray(0, gotMore);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null; // 权限 / 文件没了 / 非普通文件：回退文件名
    }
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
    const tags = this.tagsOf(this.vaultAbsPath(file));
    return {
      source: 'local-vault',
      file,
      title: tags.title || baseName(file.name),
      ...this.metaOf(album),
      // 标签里的字段优先于笔记里的：合辑里每首歌的艺人本来就不同（专辑名仍以笔记为准 —— 笔记是真源）
      artist: tags.artist || album.artist,
      track: tags.track,
    };
  }

  private externalTrack(album: AlbumInfo, absPath: string): Track {
    const tags = this.tagsOf(absPath);
    return {
      source: 'local-external',
      path: absPath,
      title: tags.title || baseName(path.basename(absPath)),
      ...this.metaOf(album),
      artist: tags.artist || album.artist,
      track: tags.track,
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
    if (hit) {
      this.touchBlob(key);
      return hit;
    }
    const buf = await this.app.vault.readBinary(file);
    const blob = new Blob([buf], { type: mimeFromName(file.name) });
    const url = URL.createObjectURL(blob);
    this.rememberBlob(key, url, buf.byteLength);
    return url;
  }

  /** 读取音轨的完整字节（搓碟台解码整轨用）：vault 走 readBinary、外链走 fs，其余来源返回 null。
   *  外链要拷成独立 ArrayBuffer —— Node 的 Buffer 来自共享内存池，直接交出去会把池里
   *  别人的字节一起带上（byteOffset 那一段才是本文件的）。 */
  async readTrackBytes(track: Track): Promise<ArrayBuffer | null> {
    try {
      if (track.source === 'local-vault') {
        return await this.app.vault.readBinary(track.file);
      }
      if (track.source === 'local-external') {
        const buf = fs.readFileSync(track.path);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
    } catch (e) {
      console.warn('[vinyl] 读取音轨字节失败（这首曲子只走轻量音效）', e);
    }
    return null;
  }

  // ============ 旁挂歌词（.lrc） ============

  /** 候选歌词名（按优先级）：`song.lrc`（同名换扩展名）与 `song.flac.lrc`（带原扩展名）两种流派都认，
   *  各带小写与大写扩展名 —— Linux 上文件系统区分大小写，而 `.LRC` 是常见写法。 */
  private sidecarNames(audioName: string): string[] {
    const stem = baseName(audioName);
    const out: string[] = [];
    for (const s of [stem, audioName]) {
      out.push(`${s}.lrc`, `${s}.LRC`);
    }
    return out;
  }

  /** 本地音轨的旁挂歌词：与音频同目录、同名的 .lrc 文件。找不到返回 null（视图按「没有歌词」显示）。
   *  只认旁挂文件，不读音频内嵌歌词（ID3 USLT / Vorbis LYRICS）：那要解音频容器，
   *  为一句歌词多背一个解码依赖不划算 —— 旁挂 .lrc 是本地歌词的完整入口（界面里也这么写）。 */
  async readSidecarLyrics(track: Track): Promise<string | null> {
    if (track.source === 'local-vault') {
      const parent = track.file.parent;
      if (!parent) return null;
      const wanted = new Set(this.sidecarNames(track.file.name).map((n) => n.toLowerCase()));
      const hit = parent.children.find(
        (f): f is TFile => f instanceof TFile && wanted.has(f.name.toLowerCase())
      );
      if (!hit) return null;
      try {
        return decodeLyricBytes(await this.app.vault.readBinary(hit));
      } catch (e) {
        console.warn('[vinyl] 读取旁挂歌词失败：' + ((e as Error).message || String(e)));
        return null;
      }
    }
    if (track.source === 'local-external') {
      const dir = path.dirname(track.path);
      for (const name of this.sidecarNames(path.basename(track.path))) {
        const p = path.join(dir, name);
        try {
          if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            const buf = fs.readFileSync(p);
            // 拷成独立 ArrayBuffer：Node 的 Buffer 来自共享内存池，直接交出去会带上池里别人的字节
            return decodeLyricBytes(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
          }
        } catch {
          // 读不到就试下一个候选名（权限 / 竞态都可能）
        }
      }
      return null;
    }
    return null;
  }

  // ============ 库外音频的可播放地址 ============

  /** 库外音频的可播放地址：网关能供流就走 Range（整轨不进内存），否则退回整文件 Blob。
   *  「库外音频会用到网关」就是这一步带来的，README 6.3.1 与权限说明按此改写。 */
  async resolveExternalPlayableUrl(absPath: string): Promise<string> {
    const stream = await this.externalStreamUrl(absPath);
    return stream ?? this.resolveExternalUrl(absPath);
  }

  /** 网关 Range 地址；拿不到（没注入宿主 / 起不来 / 这次会话里失败过）返回 null，调用方兜底。
   *  token 走查询串而不是请求头：<audio> 发的是浏览器级请求，加不了自定义头 ——
   *  网关为此保留了 ?t= 那条通道（见 README 的网关鉴权）。 */
  private async externalStreamUrl(absPath: string): Promise<string | null> {
    const host = this.streamHost;
    if (!host) return null;
    if (this.streamFailed && host.state !== 'running') return null;
    try {
      if (!(await host.ensure()) || !host.base) {
        this.streamFailed = true;
        return null;
      }
    } catch {
      this.streamFailed = true; // 启动抛错同样按「这次会话里别试了」处理
      return null;
    }
    // 先登记白名单：网关只供登记过的路径。登记不上就这条通道不用 ——
    // 直接发流会 403，退回落盘 Blob 至少还能放（下一次再试登记，不锁死本会话）。
    if (!this.allowedPaths.has(absPath)) {
      let allowed = false;
      try {
        allowed = await host.allowStreamPaths([absPath]);
      } catch {
        allowed = false;
      }
      if (!allowed) return null;
      this.allowedPaths.add(absPath);
    }
    const params = new URLSearchParams({ path: absPath, t: host.token });
    return `${host.base}/api/local/stream?${params.toString()}`;
  }

  // 外链兜底：fs → Blob URL（按文件缓存，超出预算就回收最久没用过的那份）
  resolveExternalUrl(absPath: string): string {
    const hit = this.blobUrls.get(absPath);
    if (hit) {
      this.touchBlob(absPath);
      return hit;
    }
    const buf = fs.readFileSync(absPath);
    const blob = new Blob([buf], { type: mimeFromName(absPath) });
    const url = URL.createObjectURL(blob);
    this.rememberBlob(absPath, url, buf.byteLength);
    return url;
  }
}
