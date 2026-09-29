// 专辑墙卡片增量的**决策**部分：这一轮该撤谁、谁可以留着、谁得重画、谁是新来的。
// 单独放纯函数是因为容易出错的不是 DOM 操作而是这份判断：判得太粗（什么都重画）会把滚动位置与焦点
// 一起丢，判得太细（该重画的留着了）界面就停在旧样子（换了封面还是旧图，最难发现）。
import type { AlbumInfo } from './album-index';

/** 卡片内容签名：卡片上真正画出来的字段，**加上点击时要用到的那些**（顺序与 views/shelf-view 的
 *  buildCard 一致；改那边时这里要跟着看）。用 JSON.stringify 而不是拼字符串：值里出现分隔符也不会
 *  串味，源码里也不必写不可见的控制字符（album-index 的缓存签名是同一口径）。id / 音频引用 / 源偏好
 *  也算「内容」，是因为卡片的点击闭包握着这一份 AlbumInfo，进 playAlbum → buildAlbumQueue 用的就是
 *  这些字段 —— 只签「有没有音源」那四个布尔的话，改掉 neteaseId（或走「切换音源」把 source 写回
 *  笔记）签名不变，卡片被复用后点下去建的还是旧队列；属性显示名（aria-label 用）同理。 */
export function cardSignature(
  album: Pick<
    AlbumInfo,
    | 'path'
    | 'cover'
    | 'edition'
    | 'displayProps'
    | 'neteaseId'
    | 'qqId'
    | 'kugouId'
    | 'audioFolderRef'
    | 'audioRefs'
    | 'sourcePref'
  >,
  sourceFlags: { local: boolean; netease: boolean; qq: boolean; kugou: boolean },
  propKeys: readonly string[],
  propLabels?: Record<string, string>
): string {
  return JSON.stringify([
    album.path,
    propKeys.map((k) => album.displayProps[k] ?? ''),
    album.cover ?? '',
    album.edition ?? '',
    [sourceFlags.local, sourceFlags.netease, sourceFlags.qq, sourceFlags.kugou].map((v) => !!v),
    album.neteaseId ?? '',
    album.qqId ?? '',
    album.kugouId ?? '',
    album.audioFolderRef ?? '',
    album.audioRefs ?? [],
    album.sourcePref ?? '',
    propLabels ? propKeys.map((k) => propLabels[k] ?? '') : [],
  ]);
}

export interface CardAction {
  path: string;
  sig: string;
  /** reuse = 原节点留着（内容没变）；rebuild = 原地换一张新卡；create = 新出现 */
  action: 'reuse' | 'rebuild' | 'create';
}

export interface CardPlan {
  /** 从 DOM 与映射里摘掉（不再显示：被筛掉、被删掉、改了名） */
  remove: string[];
  /** 显示顺序：照这个顺序把卡片摆好（复用 / 重画 / 新建都在这里定） */
  order: CardAction[];
}

/** 上一轮的「path → 签名」与本轮的显示列表 → 这一轮要做什么。
 *  remove 只看 path 在不在新列表里 —— 改了名的专辑就是「旧的撤掉 + 新的建出来」，不该去猜它是同一张。 */
export function planCards(
  prev: ReadonlyMap<string, string>,
  next: ReadonlyArray<{ path: string; sig: string }>
): CardPlan {
  const wanted = new Set(next.map((n) => n.path));
  const remove: string[] = [];
  for (const path of prev.keys()) {
    if (!wanted.has(path)) remove.push(path);
  }
  const order: CardAction[] = next.map((n) => {
    const before = prev.get(n.path);
    const action: CardAction['action'] =
      before === undefined ? 'create' : before === n.sig ? 'reuse' : 'rebuild';
    return { path: n.path, sig: n.sig, action };
  });
  return { remove, order };
}
