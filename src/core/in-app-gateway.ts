// 应用内网关的启动器：用 Electron 自带的 Node（utilityProcess）跑网关，用户不需要安装 Node.js。
// 背景：Obsidian 的 Electron 二进制禁用了 ELECTRON_RUN_AS_NODE（见 server-manager 顶部注释），
// 「用应用自带的 Node 跑子进程」只能走 Electron 官方通道 utilityProcess.fork ——
// 它等价于 child_process.fork，但用 Chromium Services API 拉起子进程（Electron 22+，
// 官方文档明确把它列为「runAsNode fuse 被禁用」时的替代方案）。
// 这里只负责拿到主进程的 utilityProcess 模块（经 @electron/remote，与 browser-login 同一套
// 动态加载与回退）；fork / 就绪 / 自愈 / 关闭的编排都在 ServerManager。
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

/** 动态拿主进程的 utilityProcess；拿不到返回 null（调用方转成明确的失败文案，不静默）。 */
export function loadUtilityProcess(): UtilityProcessModuleLike | null {
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
    const mod = remote.require('electron') as { utilityProcess?: UtilityProcessModuleLike } | null;
    return mod?.utilityProcess && typeof mod.utilityProcess.fork === 'function' ? mod.utilityProcess : null;
  } catch {
    return null; // 任何加载异常都按「不可用」处理：在线功能退化，界面给明确提示
  }
}
