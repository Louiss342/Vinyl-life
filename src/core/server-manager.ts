// 本地网关管理：
//   一律用 Electron 自带的 Node（utilityProcess）在应用内跑网关 —— 插件不依赖系统 Node.js
//   （Obsidian 的 Electron 二进制禁用了 ELECTRON_RUN_AS_NODE，utilityProcess 是官方替代通道，
//   见 in-app-gateway.ts）。
//   空闲端口探测 → 懒加载 fork → 就绪等待 → 优雅关闭 → 崩溃自愈（限次重启）
//   所有路径经 gatewayEnv 统一绝对化注入；系统代理随 VINYL_PROXY 一并注入
import { Plugin, requestUrl } from 'obsidian';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { execFile } from 'child_process';
import { pluginAbsPath, sleep } from '../util';
import { PING_TIMEOUT_MS, withRequestTimeout } from './request-error';
import { getLanguage } from './i18n';
import { gunzipSync } from 'zlib';
import { GATEWAY_HASH, GATEWAY_GZIP } from './gateway-bundle';
import { t, tf } from './i18n';
import { loadUtilityProcess, loadProxyResolver } from './in-app-gateway';
import type { UtilityProcessLike, UtilityProcessModuleLike } from './in-app-gateway';

export type ServerState = 'stopped' | 'starting' | 'running' | 'error';

/** 网关回报真实端口的那一行（gateway.js 末尾的 serverLog）。两处必须同步改：
 *  端口交接靠它把 bind(0) 选中的号传回来，格式一漂父进程就只能超时。 */
const PORT_RE = /listening on 127\.0\.0\.1:(\d{1,5})/;

// 读进程命令行为文本（失败返回空串，绝不抛）：用于确认待清理 PID 确为本插件网关。
function execFileText(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, { windowsHide: true, timeout: 4000 }, (err, stdout) => {
        resolve(err ? '' : String(stdout || ''));
      });
    } catch {
      resolve(''); // 命令不存在等同步异常：按「读不到命令行」处理
    }
  });
}

/** 会话 token：给网关鉴权用。不是加密用途，只需要「猜不到 + 每次启动都换」——
 *  getRandomValues 来自 Web Crypto（渲染进程自带），拿不到时退回时间戳 + 随机串。 */
function randomToken(): string {
  try {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

export class ServerManager {
  state: ServerState = 'stopped';
  lastError = '';
  /** 网关鉴权 token：随 env 下发给网关（VINYL_TOKEN），所有客户端请求带 x-vinyl-token。
   *  为什么要它：网关只监听 127.0.0.1，但浏览器里的任意页面都能扫本机端口 —— 没有 token 时，
   *  扫到就能拿你的网易云/QQ 账号发请求、读搜索结果、改凭据（见 README 的「权限说明」）。 */
  readonly token: string = randomToken();

  /** 应用内网关进程（Electron utilityProcess，见 startInApp） */
  private utility: UtilityProcessLike | null = null;
  /** 系统代理（启动网关时经 VINYL_PROXY 注入；空串 = 未取到 / 直连） */
  private systemProxy = '';
  private port = 0;
  private startPromise: Promise<boolean> | null = null;
  private stopping = false;
  private restarts = 0;
  private maxRestarts = 2;

  constructor(private plugin: Plugin) {}

  get base(): string {
    return this.port ? `http://127.0.0.1:${this.port}` : '';
  }

  get running(): boolean {
    return this.state === 'running';
  }

  // —— 系统代理（与 Chromium 同一套设置）——
  // 网关的出口是 Electron 自带的 Node，内置 fetch 不读系统代理；不把这份配置喂给它，
  // 就会出现「Chromium 能打开封面、网关下载不了」这类同机两链路一好一坏的现象。
  // 取不到一律按直连处理（网关那边还会退回读 HTTPS_PROXY 等环境变量）。
  async resolveSystemProxy(): Promise<string> {
    try {
      const resolver = loadProxyResolver();
      if (!resolver) return '';
      const result = await resolver.resolveProxy('https://music.163.com');
      return typeof result === 'string' ? result : '';
    } catch {
      return ''; // 解析失败不能让网关起不来
    }
  }

  /** 把库外音频路径登记进网关的供流白名单（见 server/gateway.js 的 /api/local/allow）。
   *  为什么要登记：那条路由的凭据只能是 URL 里的 ?t=（<audio> 带不了自定义头），
   *  光有 token 就等于「拿到它的进程能读盘上任意音频文件」；登记过之后，能读的只剩
   *  「本插件声明过要放的那些路径」。登记一次本会话有效。
   *  超时按就绪探测那一档（本地一次 POST，不该等 30s）。 */
  async allowStreamPaths(paths: string[]): Promise<boolean> {
    if (!this.base || !paths.length) return false;
    try {
      const r = await withRequestTimeout(
        requestUrl({
          url: `${this.base}/api/local/allow`,
          method: 'POST',
          contentType: 'application/json',
          headers: { 'x-vinyl-token': this.token, 'x-vinyl-lang': getLanguage() },
          body: JSON.stringify({ paths }),
          throw: false,
        }),
        PING_TIMEOUT_MS
      );
      return r.status >= 200 && r.status < 300;
    } catch {
      return false;
    }
  }

  // —— 生命周期 ——
  async ensure(): Promise<boolean> {
    if (this.state === 'running') {
      try {
        // 就绪探测也要有超时：端口被占却没人应答时，这一句会一直吊着（见 request-error）
        const r = await withRequestTimeout(
          requestUrl({ url: `${this.base}/api/ping`, headers: { 'x-vinyl-token': this.token }, throw: false }),
          PING_TIMEOUT_MS
        );
        if (r.status >= 200 && r.status < 300) return true;
      } catch {
        // 探测失败（进程没了 / 端口已关）→ 下面归零重来
      }
      // 进程已换/僵死 → 归零重来
      this.state = 'stopped';
    }
    if (this.startPromise !== null) return this.startPromise;
    this.startPromise = this.start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async start(): Promise<boolean> {
    this.state = 'starting';
    this.lastError = '';
    this.stopping = false;
    // 旧版本（≤1.0.8）用系统 Node spawn 的网关进程不会随插件重载消失 → 按 PID 记录清掉遗留。
    // 应用内网关不需要这条兜底：随插件卸载 / Obsidian 退出一起回收。
    await this.killStaleGateway();
    this.systemProxy = await this.resolveSystemProxy();
    // 端口不再由这里预先探测：那要先 bind 再 close 才能把号交给网关，中间有一段被别人抢走的
    // 窗口（抢到就 EADDRINUSE，用户看到「在线音源莫名其妙不可用」）。改由网关自己 bind(0)
    // 并回报真实端口（见 startInApp 的 waitPort）；拿不到 stdout 时退回老路（见 ensurePortFallback）。
    return this.startInApp();
  }

  // —— 应用内网关 ——
  // 用 Electron 自带的 Node（utilityProcess.fork）跑网关产物：扫码登录 / 导入 / 播放
  // 等在线能力不要求用户安装 Node.js（发布形态只带 main.js，网关源码内联其中）。
  private async startInApp(): Promise<boolean> {
    const up = loadUtilityProcess();
    if (!up) {
      this.state = 'error';
      this.lastError = t('gateway.inAppUnavailable');
      console.error('[vinyl] ' + this.lastError);
      return false;
    }
    let gateway = '';
    try {
      gateway = this.materializeGateway();
    } catch (e) {
      this.state = 'error';
      this.lastError = (e as Error).message;
      console.error('[vinyl] ' + this.lastError);
      return false;
    }
    // 第一选择：端口交接 —— 网关自己 bind(0)，把真实端口写回 stdout，父进程读它。
    // 这样就没有「先探测再交给网关」那段能被别人抢走的窗口（TOCTOU）。
    const first = await this.forkGateway(up, gateway, { handoff: true });
    if (first.ok) return true;
    if (!first.forked) {
      // fork 这个动作本身就没成（模块路径 / 权限 / 通道问题）：再来一次也一样，如实报错
      this.state = 'error';
      console.error('[vinyl] ' + this.lastError);
      return false;
    }

    // 退回：拿不到 stdout 的通道（旧 Electron / remote 不给流）只能预探测一个端口显式传进去。
    // 那条老路仍有 TOCTOU，但网关现在会把「监听失败」写进日志并退出（见 gateway.js 的
    // server.on('error')），父进程的自愈会换一个端口重来 —— 不再是无声无息地死掉。
    try {
      this.port = await this.findFreePort();
    } catch (e) {
      this.state = 'error';
      this.lastError = tf('gateway.inAppStartFailed', { msg: (e as Error).message });
      console.error('[vinyl] ' + this.lastError);
      return false;
    }
    const second = await this.forkGateway(up, gateway, { handoff: false });
    if (second.ok) return true;
    this.state = 'error';
    this.lastError = second.forked ? t('gateway.notReady') : this.lastError;
    console.error('[vinyl] ' + this.lastError);
    return false;
  }

  /** fork 一次网关并等它就绪（ping 通）。
   *  handoff = true 时用 stdio: 'pipe' 读网关回报的端口；false 时用预探测好的 this.port。
   *  失败会把这一轮 fork 出来的进程收干净（不然它会挂在那儿占着端口）。
   *  返回 forked = false 表示「fork 调用本身抛了」——那种情况重试没有意义，调用方直接报错。 */
  private async forkGateway(
    up: UtilityProcessModuleLike,
    gateway: string,
    opts: { handoff: boolean }
  ): Promise<{ ok: boolean; forked: boolean }> {
    let proc: UtilityProcessLike;
    try {
      proc = up.fork(gateway, [], {
        env: this.gatewayEnv(opts.handoff),
        stdio: opts.handoff ? 'pipe' : 'ignore', // 交接要读 stdout；否则网关自己写 gateway.log
        serviceName: 'Vinyl Life Gateway',
      });
      this.utility = proc;
      this.attachUtilityExit(proc);
    } catch (e) {
      this.utility = null;
      // 记进 lastError：fork 都抛了的场合，调用方要把它原样透给用户（不是笼统的「未就绪」）
      this.lastError = tf('gateway.inAppStartFailed', { msg: (e as Error).message || String(e) });
      return { ok: false, forked: false };
    }
    if (opts.handoff) {
      const port = await this.waitReportedPort(proc, 15_000);
      // 没回报端口：要么进程没起来（原因写在 gateway.log），要么这条通道不给流。
      // 两种都不猜端口 —— 交给调用方决定是退回预探测还是报失败。
      if (!port) {
        this.stop();
        return { ok: false, forked: true };
      }
      this.port = port;
    }
    // 就绪等待（最多 15s，与独立进程同一节奏；网关自身的报错写在 gateway.log）
    for (let i = 0; i < 100; i++) {
      try {
        const r = await withRequestTimeout(
          requestUrl({ url: `${this.base}/api/ping`, headers: { 'x-vinyl-token': this.token }, throw: false }),
          PING_TIMEOUT_MS
        );
        if (r.status >= 200 && r.status < 300) {
          this.state = 'running';
          this.restarts = 0;
          return { ok: true, forked: true };
        }
      } catch {
        // 尚未监听：继续等下一轮
      }
      await sleep(150);
    }
    this.stop();
    return { ok: false, forked: true };
  }

  /** 等网关把真实端口写进 stdout。格式由 gateway.js 末尾那一行固定（改格式要同步改这里）。
   *  超时返回 0：调用方按「这一轮没成」处理，不猜端口。 */
  private waitReportedPort(proc: UtilityProcessLike, timeoutMs: number): Promise<number> {
    const stream = proc.stdout ?? null;
    if (!stream || typeof stream.on !== 'function') return Promise.resolve(0);
    return new Promise((resolve) => {
      let done = false;
      const finish = (port: number) => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        resolve(port);
      };
      const timer = window.setTimeout(() => finish(0), timeoutMs);
      try {
        stream.on('data', (chunk: { toString(): string }) => {
          const m = PORT_RE.exec(String(chunk?.toString?.() ?? ''));
          if (m) finish(Number(m[1]));
        });
      } catch {
        finish(0);
      }
    });
  }

  private attachUtilityExit(proc: UtilityProcessLike): void {
    if (typeof proc.on !== 'function') return; // remote 拿不到事件时：存活判断靠 ensure() 的 ping
    try {
      proc.on('exit', (code) => {
        if (this.utility !== proc) return; // 已换代或主动停过
        this.utility = null;
        this.port = 0;
        this.state = 'stopped';
        if (this.stopping) return;
        this.scheduleRestart(code);
      });
    } catch {
      // 事件注册失败不影响启动：就绪与存活判断都走 ping
    }
  }

  /** 网关退出后的自愈：限次重启；超过上限进入 error（独立进程与应用内共用同一策略）。 */
  private scheduleRestart(code: number | undefined): void {
    if (this.restarts < this.maxRestarts) {
      this.restarts++;
      window.setTimeout(() => {
        void this.ensure();
      }, 500);
    } else {
      this.state = 'error';
      this.lastError = tf('gateway.crashLoop', { code: code ?? t('gateway.exitCodeUnknown') });
    }
  }

  // 网关源码内联在 main.js 里（社区市场只安装 main.js / manifest.json / styles.css），
  // 首次使用时把源码落盘到系统临时目录再 fork；文件名带源码 hash，升级自动换新文件。
  private materializeGateway(): string {
    const dir = path.join(os.tmpdir(), 'vinyl-life');
    const file = path.join(dir, `gateway-${GATEWAY_HASH}.js`);
    try {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        // 内联的是 gzip+base64，这里还原成源码再落盘（内容与构建时的 server.js 逐字节一致）
        fs.writeFileSync(
          tmp,
          gunzipSync(Buffer.from(GATEWAY_GZIP, 'base64')).toString('utf8'),
          'utf8'
        );
        fs.renameSync(tmp, file);
        // 清理同目录下旧版本网关文件（在用的删不掉会抛错，忽略即可）
        try {
          for (const name of fs.readdirSync(dir)) {
            if (/^gateway-[0-9a-f]+\.js$/.test(name) && name !== path.basename(file)) {
              try {
                fs.unlinkSync(path.join(dir, name));
              } catch {
                // 该版本可能正被其它 Obsidian 窗口的网关占用：留着无害
              }
            }
          }
        } catch {
          // 目录读不到（权限 / 竞态）：不影响本次落盘的文件
        }
      }
      return file;
    } catch (e) {
      throw new Error(
        tf('gateway.tempWriteFailed', { file, msg: (e as Error).message })
      );
    }
  }

  // 网关路径注入统一封装：COOKIE / ANON / QQ 凭据 / LOG / 代理 全部绝对化。
  // handoff = true 时 VINYL_PORT 给 0：让网关自己 bind(0)，端口从 stdout 回报（见 forkGateway）。
  private gatewayEnv(handoff = false): NodeJS.ProcessEnv {
    return {
      ...process.env,
      VINYL_PORT: handoff ? '0' : String(this.port),
      VINYL_TOKEN: this.token,
      // 网关自带一份小词表：错误文案会冒到界面上，语言得跟着插件走
      VINYL_LANG: getLanguage(),
      VINYL_COOKIE_FILE: pluginAbsPath(this.plugin, '.cookie'),
      VINYL_ANON_FILE: pluginAbsPath(this.plugin, '.anon-token'),
      VINYL_QQ_COOKIE_FILE: pluginAbsPath(this.plugin, '.qq-cookie'),
      VINYL_QQ_GUID_FILE: pluginAbsPath(this.plugin, '.qq-guid'),
      VINYL_KUGOU_COOKIE_FILE: pluginAbsPath(this.plugin, '.kugou-cookie'),
      // 酷狗设备指纹（dfid/mid/guid/dev）：首次取流前注册一次，之后一直沿用
      VINYL_KUGOU_DEVICE_FILE: pluginAbsPath(this.plugin, '.kugou-device'),
      VINYL_LOG_FILE: pluginAbsPath(this.plugin, 'gateway.log'),
      // 系统代理 → 网关；'DIRECT' 不注入，留空让它回落读 HTTPS_PROXY 等环境变量
      VINYL_PROXY:
        this.systemProxy && this.systemProxy.trim().toUpperCase() !== 'DIRECT'
          ? this.systemProxy
          : '',
    };
  }

  stop() {
    this.stopping = true;
    if (this.utility) {
      try {
        this.utility.kill();
      } catch {
        // 进程可能已自行退出：忽略
      }
      this.utility = null;
    }
    this.port = 0;
    this.state = 'stopped';
    this.forgetPid();
    window.setTimeout(() => {
      this.stopping = false;
    }, 300);
  }

  findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(port));
      });
    });
  }

  // —— 旧网关 PID 记录与清理（只服务升级路径）——
  // ≤1.0.8 的版本用系统 Node spawn 网关：它不随插件重载消失，会常驻堆积，所以按 PID 记录清理。
  // 现行（应用内）网关随插件卸载 / Obsidian 退出回收，不再写 PID 记录。
  //
  // 这里是全插件唯一用到 child_process 的地方，审核会把它列为「Shell Execution」能力披露。
  // 非用不可：要确认一个 PID 确实是本插件的网关，只能读它的命令行 —— 只认 PID 的话，
  // 号被系统复用之后就会杀掉无关进程（杀错别人的进程远比留一个僵尸网关严重）。
  // 只在 .gateway.pid 存在时跑一次（即从 ≤1.0.8 升上来的那次启动），不是常驻能力。
  // 为什么留着，见 CONTRIBUTING 的「审核的能力披露」一节。

  private stalePidFile(): string {
    return pluginAbsPath(this.plugin, '.gateway.pid');
  }

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false; // 信号 0 抛错即进程不存在（或无权限）
    }
  }

  // 只清理「确认是本插件网关」的 PID：核对命令行含临时目录 vinyl-life 与网关文件名，避免 PID 复用误伤。
  private async isVinylGateway(pid: number): Promise<boolean> {
    if (!this.pidAlive(pid)) return false;
    const cmd =
      process.platform === 'win32'
        ? await execFileText('powershell', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
          ])
        : await execFileText('ps', ['-p', String(pid), '-o', 'args=']);
    return /vinyl-life/i.test(cmd) && /gateway-[0-9a-f]+\.js/.test(cmd);
  }

  private async killStaleGateway(): Promise<void> {
    let pid = NaN;
    try {
      pid = parseInt(fs.readFileSync(this.stalePidFile(), 'utf8').trim(), 10);
    } catch {
      return; // 无记录：正常首次启动
    }
    try {
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && (await this.isVinylGateway(pid))) {
        try {
          process.kill(pid);
        } catch {
          // 期间已自行退出：无需再等
        }
        for (let i = 0; i < 20 && this.pidAlive(pid); i++) await sleep(100);
      }
    } finally {
      try {
        fs.unlinkSync(this.stalePidFile());
      } catch {
        // 记录文件本就不在：无需清理
      }
    }
  }

  private forgetPid(): void {
    try {
      fs.unlinkSync(this.stalePidFile());
    } catch {
      // 无记录可删
    }
  }
}
