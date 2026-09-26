// 上游请求节流：健康检查的试播是唯一会成串打平台的路径 —— 每张专辑 × 每个音源，
// 每个音源最多三首，每首取流还要走阶梯（见 server-client 的 QUALITY_LADDER）。
// 平台的限流看的是**突发量**，只在 job 之间 sleep 挡不住 job 内部的连发（实测单 job 最多 26 个请求）。
//
// 所以把间隔下沉到「每一次上游请求」之间：平时是 0（播放、搜索、导入都不受影响），
// 试播期间由 main.checkOnlineSource 打开、跑完关掉（try/finally，关窗 / 出错都不会漏关）。
//
// 与 album-discovery 里的搜索节流（MIN_INTERVAL 600ms）同一思路，两处刻意不合并：
// 那边的节流是**搜索路径常驻**的（每次敲字都算），这边只在试播期间生效；
// 共用一个计数器会让「试播把搜索的槽位占了」这种耦合冒出来。
import { sleep } from '../util';

let gapMs = 0;
/** 下一个可发车的时刻（预约式：并发调用各占一格，不会两个一起过 —— 搜索那边的
 *  waitForSlot 是先读后写，两个并发者会同时通过，这里不重复那个写法） */
let nextSlotAt = 0;

/** 设成 0 就是关掉（默认）。调用方成对使用：打开 → 跑完关掉。 */
export function setUpstreamPacing(ms: number): void {
  gapMs = Math.max(0, ms);
  nextSlotAt = 0;
}

/** 当前档位（毫秒）。用例与排查用：试播跑完必须是 0，否则就是漏关了。 */
export function upstreamPacing(): number {
  return gapMs;
}

/** 每次真正发上游请求之前 await 它 */
export async function paceUpstream(): Promise<void> {
  if (gapMs <= 0) return;
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + gapMs;
  if (at > now) await sleep(at - now);
}
