// 队列笔记（人可读的 Markdown）：**可见的曲目列表就是数据源**。
//
// 早先的版本在笔记末尾藏一段 JSON 标记，列表只是它的投影 —— 用户改了看得见的曲目，
// 载入结果纹丝不动（评审意见：可编辑内容与载入数据要统一）。现在只认列表：
//
//     - [[专辑笔记|专辑名]] · 曲名
//
// 载入时按「专辑笔记路径 + 曲名」把每一行还原成曲目，对不上的整行跳过并如实报数
// （重名曲目按先出现的算；标题在存盘时已把换行压成空格）。
import type { Track } from './track';

export interface QueueNoteEntry {
  /** 列表里那半个 wikilink 指向的专辑笔记路径 */
  albumPath: string;
  trackTitle: string;
}

/** 列表行：`- [[路径|名字]] · 曲名`（`*` 也认）。没有 wikilink / 没有曲名的行直接跳过 ——
 *  用户写的说明、标题、别的清单都不是曲目。 */
const LINK_HEAD = /^\[\[([^\]]+)\]\]/;

export function parseQueueEntries(markdown: string): QueueNoteEntry[] {
  const out: QueueNoteEntry[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('- ') && !line.startsWith('* ')) continue;
    const body = line.slice(2).trim();
    const link = LINK_HEAD.exec(body);
    if (!link) continue;
    const albumPath = link[1].split('|')[0].split('#')[0].trim();
    // 分隔符可省（用户手写时容易漏），剩下的都当曲名；曲名里再出现「 · 」也不截断
    const trackTitle = body.slice(link[0].length).replace(/^\s*·\s*/, '').trim();
    if (!albumPath || !trackTitle) continue;
    out.push({ albumPath, trackTitle });
  }
  return out;
}

/** 写进笔记的曲目行。`link` 由调用方给（wikilink 的安全拼装规则在主模块里）。 */
export function queueNoteLines(
  tracks: Track[],
  link: (albumPath: string, albumName: string) => string
): string[] {
  return tracks
    .filter((track) => !!track.albumNotePath)
    .map(
      (track) =>
        `- ${link(track.albumNotePath!, track.album || track.albumNotePath!)} · ${track.title.replace(/\r?\n/g, ' ')}`
    );
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 曲名 → 曲目：先精确（只忽略空白与大小写差异），再退一步认「专辑那侧多一截后缀」
 *  且只有一个候选的情况（列表里的《歌》对上《歌 (Remastered)》）。
 *  反向不认、歧义不认 —— 猜错一首比少载一首更糟：跳过的会在提示里点名，
 *  用户改一下列表就能载回。 */
export function pickTrackByTitle(tracks: Track[], title: string): Track | undefined {
  const want = normalizeTitle(title);
  if (!want) return undefined;
  const exact = tracks.filter((track) => normalizeTitle(track.title) === want);
  if (exact.length) return exact[0];
  const suffixed = tracks.filter((track) => normalizeTitle(track.title).startsWith(want));
  return suffixed.length === 1 ? suffixed[0] : undefined;
}
