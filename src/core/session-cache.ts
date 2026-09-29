// 会话级的小 LRU：缓存「一次会话里不会变」的远端响应（专辑曲目表是唯一的用例）。
//
// 值得缓存：专辑曲目表是起播链上的第一段网络（实测网易云 eapi 100~150ms），一次会话里又是死的 ——
// 不缓存的话同一张专辑点几次就是几次同样的请求；悬停预热（shelf-view 的 schedulePrefetch）拨的也是这一份。
// 用 LRU 而不是 FIFO：浏览一面墙会挨张扫过很多专辑，FIFO 会挤掉「刚看过、很可能要回头点」的那些；
// Map 的迭代序就是插入序，get 命中后重新 set 一次即把它挪到队尾，淘汰永远从队首拿走最久没用过的。
// 刻意不设过期时间：曲目表没有「过期」一说（要变只可能是换了 id，而键就是 id，换了自然是另一个键）；
// 容量上限只用来兜住「一面墙上几百张专辑」这种极端情况。
export class SessionCache<T> {
  private map = new Map<string, T>();

  constructor(private cap: number) {}

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.cap) {
      // 队首 = 最久没用过的（命中会把它挪到队尾，见 get）
      const keys: string[] = Array.from(this.map.keys());
      const oldest: string | undefined = keys[0];
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
