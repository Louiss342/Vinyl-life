// 网关请求错误：带上 HTTP 状态码。
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
