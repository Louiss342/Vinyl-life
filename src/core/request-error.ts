// 网关请求错误：带上 HTTP 状态码。
import { tf } from './i18n';

//
// 背景：网关以前把上游的所有拒绝（限流 405、接口 404、真·网络故障）一律压成同一条
// 「请检查网络后重试」，客户端也就无从区分。现在网关按上游 code 给出状态码
// （限流 → 429，见 server/gateway.js 的 failureStatus），客户端据此分流：
// 429 让该来源冷却一段时间，其它错误照常汇报。两者的处理方式恰好相反 ——
// 对着一个正在限流的上游重试，只会一直撞在限流上。
export class GatewayError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
  }
}

/** 上游限流（HTTP 429）：来源应进入冷却，而不是立刻重试 */
export function isRateLimited(e: unknown): boolean {
  return e instanceof GatewayError && e.status === 429;
}

/** 出站请求的超时档位（毫秒）。
 *
 *  为什么需要：`requestUrl` 没有超时参数。网关卡住时（进程僵住 / 端口被占却没人应答 /
 *  上游把连接吊着不吐字节）这个 Promise 永远不落地，界面就跟着一直转圈 ——
 *  用户看到的是「点了没反应」，而错误处理链一次都不会被触发。
 *
 *  30s 比网关自身的上游超时（15s / 20s）宽一档：正常但慢的请求不该被误杀。
 *  就绪探测（ping）走 2s：那只是在本地端口上问一句「你在吗」，吊住只会让启动流程白等。 */
export const REQUEST_TIMEOUT_MS = 30_000;
export const PING_TIMEOUT_MS = 2_000;

/** 给一个 Promise 套超时：到点用一句明确的话拒绝，晚到的响应丢掉（Promise.race 的语义）。
 *  定时器走 window.*（弹出窗口场景下才指得对，见 CONTRIBUTING 的定时器纪律）。 */
export function withRequestTimeout<T>(run: Promise<T>, ms: number = REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new GatewayError(tf('auth.gatewayTimeout', { s: Math.round(ms / 1000) }), 0));
    }, ms);
    run.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (e: unknown) => {
        window.clearTimeout(timer);
        // Error 实例原样透传（上游的状态码与 GatewayError 类型不能在这里被换掉）；
        // 非 Error 的抛出物（字符串 / 对象）包一层 —— promise 的拒绝理由必须是 Error。
        reject(e instanceof Error ? e : new Error(typeof e === 'string' ? e : 'request failed'));
      }
    );
  });
}
