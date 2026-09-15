// 应用内网关的启动器：用 Electron 自带的 Node（utilityProcess）跑网关，用户不需要安装 Node.js。
// 背景：Obsidian 的 Electron 二进制禁用了 ELECTRON_RUN_AS_NODE，
// 「用应用自带的 Node 跑子进程」只能走 Electron 官方通道 utilityProcess.fork ——
// 它等价于 child_process.fork，但用 Chromium Services API 拉起子进程（Electron 22+，
// 官方文档明确把它列为「runAsNode fuse 被禁用」时的替代方案）。
// 这里只负责经 @electron/remote 拿主进程的模块（utilityProcess / session）；
// fork / 就绪 / 自愈 / 关闭的编排都在 ServerManager。
export interface UtilityProcessLike {
  pid?: number;
  kill(): boolean;
  on?(event: 'exit', listener: (code?: number) => void): unknown;
}

export interface UtilityProcessModuleLike {
  fork(
    modulePath: string,
    args?: string[],
    options?: { env?: Record<string, string | undefined>; stdio?: 'pipe' | 'ignore' | 'inherit'; serviceName?: string }
  ): UtilityProcessLike;
}

/** Electron Session 里网关需要的那一小块：系统代理解析 */
export interface ProxyResolverLike {
  /** 返回 'PROXY host:port' / 'SOCKS5 host:port' / 'DIRECT'（PAC 场景可能是分号链） */
  resolveProxy(url: string): Promise<string>;
}

/** 经 @electron/remote（或 electron.remote 回退）拿主进程的 electron 模块；拿不到返回 null */
export function loadMainElectron(): Record<string, unknown> | null {
  try {
    const loadModule: (id: string) => unknown = require;
    let remote: { require?: (id: string) => unknown } | null = null;
    try {
      remote = loadModule('@electron/remote') as { require?: (id: string) => unknown };
    } catch {
      const electron = loadModule('electron') as { remote?: { require?: (id: string) => unknown } };
      remote = electron.remote ?? null;
    }
    if (typeof remote?.require !== 'function') return null;
    const mod = remote.require('electron') as Record<string, unknown> | null;
    return mod && typeof mod === 'object' ? mod : null;
  } catch {
    return null; // 任何加载异常都按「不可用」处理：在线功能退化，界面给明确提示
  }
}

/** 动态拿主进程的 utilityProcess；拿不到返回 null（调用方转成明确的失败文案，不静默）。 */
export function loadUtilityProcess(): UtilityProcessModuleLike | null {
  const mod = loadMainElectron() as { utilityProcess?: UtilityProcessModuleLike } | null;
  return mod?.utilityProcess && typeof mod.utilityProcess.fork === 'function' ? mod.utilityProcess : null;
}

/** 系统代理解析器（与 Chromium 同一套设置）；拿不到返回 null（调用方按直连处理，不抛）。 */
export function loadProxyResolver(): ProxyResolverLike | null {
  const mod = loadMainElectron() as { session?: { defaultSession?: ProxyResolverLike } } | null;
  const session = mod?.session?.defaultSession;
  return session && typeof session.resolveProxy === 'function' ? session : null;
}
