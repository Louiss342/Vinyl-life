// 导入功能（M4，方案 5.9）：
//   A. 专辑导入：网易云 / QQ 音乐链接（或 ID）→ 元信息 → 建笔记（neteaseId / qqId）→ 代理下封面 → 打开笔记
//   B. 本地音频导入：复制进 vault（audioFolder）/ 外链绝对路径（audio 列表）两模式，processFrontMatter 更新
//   C. 拖到空白处：从文件新建本地专辑笔记
import { App, TFile, normalizePath } from 'obsidian';
import {
  AlbumInfo,
  buildAlbumInfo,
  findAlbumNotes,
  getAlbumInfo,
  parseQqAlbumMid,
} from './core/album-index';
import { isAudioFile, baseName, sanitizeFileName, ensureFolder } from './util';
// 以下仅作类型使用（import type 让测试打包不牵连整条服务链）
import type { VinylSettings } from './settings';
import type { NeteaseService } from './core/netease';
import type { QqService } from './core/qq';

export interface ImportContext {
  app: App;
  settings: () => VinylSettings;
  /** 统一网易云入口（网页会话优先，网关兜底，内部处理就绪） */
  client: NeteaseService;
  /** QQ 音乐入口（网关单通道） */
  qq: QqService;
}

export interface ImportResult {
  ok: boolean;
  detail: string;
  file?: TFile;
}

// ensureFolder 见 util.ts（导入与插件启动共用）

// ============ A. 专辑导入（网易云 / QQ 音乐） ============

export type AlbumLink =
  | { source: 'netease'; id: number }
  | { source: 'qq'; mid: string };

export function parseNeteaseInput(input: string): number | undefined {
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/album\?id=(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/** 专辑链接/ID 识别：网易云（album?id= / 纯数字 ID）优先，其次 QQ 音乐（albumDetail/、旧版 /album/<mid>.html、纯 mid） */
export function parseAlbumInput(input: string): AlbumLink | undefined {
  const s = String(input || '').trim();
  if (!s) return undefined;
  const id = parseNeteaseInput(s);
  if (id) return { source: 'netease', id };
  const mid = parseQqAlbumMid({ qq: s });
  return mid ? { source: 'qq', mid } : undefined;
}

export async function importAlbum(ctx: ImportContext, input: string): Promise<ImportResult> {
  const link = parseAlbumInput(input);
  if (!link) {
    return {
      ok: false,
      detail:
        '无法识别链接：请粘贴网易云专辑链接（music.163.com/#/album?id=… 或纯数字 ID）或 QQ 音乐专辑链接（y.qq.com/n/ryqq/albumDetail/…）',
    };
  }
  return link.source === 'qq' ? importQqAlbum(ctx, input) : importNeteaseAlbum(ctx, input);
}

// 封面：经本地网关代理下载（避开 CORS）→ covers/，返回 frontmatter 用的 wikilink 字面量
async function downloadCoverToVault(
  ctx: ImportContext,
  url: string | undefined,
  name: string
): Promise<string> {
  if (!url) return '';
  try {
    const ab = await ctx.client.fetchCover(String(url));
    const ext = String(url).match(/\.(jpe?g|png|webp)(\?|$)/i)?.[1] || 'jpg';
    const coverPath = normalizePath(`${ctx.settings().coverFolder}/${name}.${ext}`);
    if (!ctx.app.vault.getAbstractFileByPath(coverPath)) {
      await ensureFolder(ctx.app, ctx.settings().coverFolder);
      await ctx.app.vault.createBinary(coverPath, ab);
    }
    return `"[[${coverPath}]]"`;
  } catch (e) {
    console.error('[vinyl] 封面下载失败', e);
    return '';
  }
}

export async function importNeteaseAlbum(
  ctx: ImportContext,
  input: string
): Promise<ImportResult> {
  const id = parseNeteaseInput(input);
  if (!id) {
    return { ok: false, detail: '无法解析专辑 ID（请粘贴专辑链接或纯数字 ID）' };
  }

  // 查重先于接口请求：已有同 neteaseId 的笔记 → 直接指路（也避免离线/接口故障时误报失败）
  for (const f of findAlbumNotes(ctx.app)) {
    const info = getAlbumInfo(ctx.app, f);
    if (info?.neteaseId === id) {
      return { ok: false, detail: `已存在「${info.title}」，无需重复导入`, file: f };
    }
  }

  let body: any;
  try {
    body = await ctx.client.album(id);
  } catch (e) {
    return { ok: false, detail: `获取专辑失败：${(e as Error).message}` };
  }
  const album = body?.album;
  if (!album?.name) {
    return { ok: false, detail: `专辑接口无数据（code=${body?.code}）` };
  }

  // 建笔记
  const name = sanitizeFileName(album.name);
  const notePath = normalizePath(`${ctx.settings().albumFolder}/${name}.md`);
  if (ctx.app.vault.getAbstractFileByPath(notePath)) {
    return { ok: false, detail: `笔记已存在：${notePath}` };
  }
  const artist = album.artist?.name || '';
  const year = album.publishTime
    ? new Date(Number(album.publishTime)).getFullYear()
    : undefined;

  const coverRef = await downloadCoverToVault(ctx, album.picUrl, name);

  await ensureFolder(ctx.app, ctx.settings().albumFolder);

  const lines = ['---', 'tags: [album]', `neteaseId: ${id}`];
  if (coverRef) lines.push(`cover: ${coverRef}`);
  if (artist) lines.push(`artist: "${artist}"`);
  if (year) lines.push(`year: ${year}`);
  lines.push(`netease: "https://music.163.com/#/album?id=${id}"`);
  lines.push('---', '');
  const file = await ctx.app.vault.create(notePath, lines.join('\n'));
  return {
    ok: true,
    detail: `已导入「${album.name}」（${artist}${year ? `, ${year}` : ''}，${body.songs?.length ?? 0} 曲）`,
    file,
  };
}

// ============ A2. QQ 音乐专辑导入 ============

export async function importQqAlbum(ctx: ImportContext, input: string): Promise<ImportResult> {
  const mid = parseQqAlbumMid({ qq: String(input || '').trim() });
  if (!mid) {
    return {
      ok: false,
      detail: '无法解析 QQ 音乐专辑 ID（请粘贴专辑链接，如 https://y.qq.com/n/ryqq/albumDetail/004VSvF52mQoQp）',
    };
  }

  // 查重先于接口请求：已有同 qqId 的笔记 → 直接指路
  for (const f of findAlbumNotes(ctx.app)) {
    const info = getAlbumInfo(ctx.app, f);
    if (info?.qqId === mid) {
      return { ok: false, detail: `已存在「${info.title}」，无需重复导入`, file: f };
    }
  }

  let body: any;
  try {
    body = await ctx.qq.album(mid);
  } catch (e) {
    return { ok: false, detail: `获取专辑失败：${(e as Error).message}` };
  }
  const album = body?.data?.album;
  if (!album?.name) {
    return {
      ok: false,
      detail: body?.msg || `QQ 音乐专辑接口无数据（code=${body?.code}）`,
    };
  }

  const name = sanitizeFileName(album.name);
  const notePath = normalizePath(`${ctx.settings().albumFolder}/${name}.md`);
  if (ctx.app.vault.getAbstractFileByPath(notePath)) {
    return { ok: false, detail: `笔记已存在：${notePath}` };
  }
  const artist = album.artist || '';
  // QQ 的 aDate 形如 2020-01-01
  const year = /^(\d{4})/.exec(String(album.publishTime || ''))?.[1];
  const coverRef = await downloadCoverToVault(ctx, album.coverUrl, name);

  await ensureFolder(ctx.app, ctx.settings().albumFolder);

  const lines = ['---', 'tags: [album]', `qqId: ${mid}`];
  if (coverRef) lines.push(`cover: ${coverRef}`);
  if (artist) lines.push(`artist: "${artist}"`);
  if (year) lines.push(`year: ${Number(year)}`);
  lines.push(`qq: "https://y.qq.com/n/ryqq/albumDetail/${mid}"`);
  lines.push('---', '');
  const file = await ctx.app.vault.create(notePath, lines.join('\n'));
  return {
    ok: true,
    detail: `已导入「${album.name}」（${artist}${year ? `, ${year}` : ''}${
      album.trackCount ? `，${album.trackCount} 曲` : ''
    }）`,
    file,
  };
}

// ============ B. 本地音频导入（两模式） ============

export async function importLocalAudio(
  ctx: ImportContext,
  album: AlbumInfo,
  files: File[],
  mode: 'copy' | 'link'
): Promise<{ added: string[]; fallback: boolean }> {
  const added: string[] = [];
  let fallback = false;
  let copyDir = '';

  for (const f of files) {
    if (!isAudioFile(f.name)) continue;
    const safeName = sanitizeFileName(f.name);

    if (mode === 'copy') {
      copyDir = normalizePath(
        `${ctx.settings().audioFolder}/${sanitizeFileName(album.title)}`
      );
      const p = normalizePath(`${copyDir}/${safeName}`);
      if (ctx.app.vault.getAbstractFileByPath(p)) continue; // 已存在跳过
      const ab = await f.arrayBuffer();
      await ensureFolder(ctx.app, copyDir);
      await ctx.app.vault.createBinary(p, ab);
      added.push(p);
    } else {
      const abs = (f as any).path as string | undefined;
      if (abs && typeof abs === 'string') {
        if (!added.includes(abs)) added.push(abs);
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

  if (!added.length) return { added, fallback };

  // 更新笔记 frontmatter（复制 → audioFolder；外链 → audio 列表追加）
  await ctx.app.fileManager.processFrontMatter(album.file, (fm) => {
    if (mode === 'copy') {
      if (!fm.audioFolder) fm.audioFolder = `[[${copyDir}]]`;
    } else {
      const list: string[] = Array.isArray(fm.audio)
        ? [...fm.audio]
        : fm.audio != null
          ? [fm.audio]
          : [];
      for (const a of added) if (!list.includes(a)) list.push(a);
      fm.audio = list;
    }
  });
  return { added, fallback };
}

// ============ C. 从文件新建本地专辑（拖到空白处） ============

export async function createAlbumFromFiles(
  ctx: ImportContext,
  files: File[]
): Promise<AlbumInfo | null> {
  const audioFiles = files.filter((f) => isAudioFile(f.name));
  if (!audioFiles.length) return null;
  const title = baseName(audioFiles[0].name);
  const notePath = normalizePath(
    `${ctx.settings().albumFolder}/${sanitizeFileName(title)}.md`
  );
  const existing = ctx.app.vault.getAbstractFileByPath(notePath);
  if (existing instanceof TFile) {
    const info = getAlbumInfo(ctx.app, existing);
    if (info) return info;
    // 同名文件存在但不是专辑笔记 → 不覆盖，给出可读提示
    throw new Error(`已存在同名文件「${notePath}」，请先改名或移走后再拖入`);
  }
  await ensureFolder(ctx.app, ctx.settings().albumFolder);
  const file = await ctx.app.vault.create(notePath, '---\ntags: [album]\n---\n');
  // metadataCache 尚未索引新文件 → 用已知 frontmatter 直接构造
  return buildAlbumInfo(ctx.app, file, { tags: ['album'] });
}
