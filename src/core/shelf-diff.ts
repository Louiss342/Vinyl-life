// 专辑墙卡片增量的**决策**部分：这一轮该撤谁、谁可以留着、谁得重画、谁是新来的。
//
// 为什么单独放一个纯函数：真正容易出错的不是 DOM 操作，而是这份判断 ——
//   · 判得太粗（什么都重画）= 现在的问题：改一个属性重建上千张卡片，滚动位置与焦点一起丢；
//   · 判得太细（该重画的留着了）= 界面停在旧样子（换了封面还是旧图，这种最难发现）。
// 纯函数能把这些边界一条条钉住，视图那边只剩「照着做」。
import type { AlbumInfo } from './album-index';

/** 卡片内容签名：卡片上真正画出来的那些字段。
 *  （顺序与 views/shelf-view 的 buildCard 一致；改那边时这里要跟着看。）
 *  用 JSON.stringify 而不是拼字符串：值里出现分隔符也不会串味，
 *  且不必在源码里写不可见的控制字符 —— album-index 的缓存签名是同一口径。 */
export function cardSignature(
  album: Pick<AlbumInfo, 'path' | 'cover' | 'edition' | 'displayProps'>,
  sourceFlags: { local: boolean; netease: boolean; qq: boolean; kugou: boolean },
  propKeys: readonly string[]
): string {
  return JSON.stringify([
    album.path,
    propKeys.map((k) => album.displayProps[k] ?? ''),
    album.cover ?? '',
    album.edition ?? '',
    [sourceFlags.local, sourceFlags.netease, sourceFlags.qq, sourceFlags.kugou].map((v) => !!v),
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
 *  注意 remove 只看 path 不在新列表里 —— 改了名的专辑就是「旧的撤掉 + 新的建出来」，
 *  不需要（也不该）去猜它是同一张。 */
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
