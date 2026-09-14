// 本地网关管理：
//   Obsidian 二进制禁用 ELECTRON_RUN_AS_NODE → 依赖系统 Node，先探测 PATH 再试常见绝对路径
//   空闲端口探测 → 懒加载 spawn → 就绪等待 → 优雅关闭 → 崩溃自愈（限次重启）
//   所有路径经 gatewayEnv 统一绝对化注入
import { Plugin, requestUrl } from 'obsidian';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { spawn, execFile, ChildProcess } from 'child_process';
import { pluginAbsPath, sleep } from '../util';
import { gunzipSync } from 'zlib';
import { GATEWAY_HASH, GATEWAY_GZIP } from './gateway-bundle';

export type ServerState = 'stopped' | 'starting' | 'running' | 'error';

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
  } catch (_) {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

export class ServerManager {
  state: ServerState = 'stopped';
  lastError = '';
  nodeBinary: string | null = null;
  /** 网关鉴权 token：随 env 下发给网关（VINYL_TOKEN），所有客户端请求带 x-vinyl-token。
   *  为什么要它：网关只监听 127.0.0.1，但浏览器里的任意页面都能扫本机端口 —— 没有 token 时，
   *  扫到就能拿你的网易云/QQ 账号发请求、读搜索结果、改凭据（见 README 的「权限说明」）。 */
  readonly token: string = randomToken();

  private child: ChildProcess | null = null;
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

  // —— Node 探测（需系统 Node，做友好引导）——
  probeNode(bin: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const p = spawn(bin, ['-v']);
        let out = '';
        p.stdout?.on('data', (d) => (out += String(d)));
        p.on('error', () => resolve(false));
        p.on('close', (code) => resolve(code === 0 && out.trim().startsWith('v')));
        window.setTimeout(() => resolve(false), 4000);
      } catch {
        resolve(false); // spawn 同步抛错（二进制不可执行等）：探测失败
      }
    });
  }

  async resolveNodeBinary(): Promise<string | null> {
    if (await this.probeNode('node')) return 'node';
    const candidates = [
      'C:/Program Files/nodejs/node.exe',
      path.join(process.env.ProgramFiles || '', 'nodejs/node.exe'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'nodejs/node.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs/nodejs/node.exe'),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c) && (await this.probeNode(c))) return c;
      } catch {
        // 单个候选路径不可用：继续试下一个
      }
    }
    return null;
  }

  // —— 生命周期 ——
  async ensure(): Promise<boolean> {
    if (this.state === 'running') {
      try {
        const r = await requestUrl({
          url: `${this.base}/api/ping`,
          headers: { 'x-vinyl-token': this.token },
          throw: false,
        });
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
    if (!this.nodeBinary) this.nodeBinary = await this.resolveNodeBinary();
    if (!this.nodeBinary) {
      this.state = 'error';
      this.lastError =
        '未找到 Node.js：在线音源（网易云 / QQ 音乐）需要系统 Node（PATH 与常见安装路径均未探测到）。' +
        '纯本地源不受影响；可前往 nodejs.org 安装，或重启 Obsidian 后在设置里「重新探测」。';
      console.error('[vinyl] ' + this.lastError);
      return false;
    }
    // 插件每次重载都会 spawn 新网关；旧进程不清会常驻堆积，先按 PID 记录清掉上一个。
    await this.killStaleGateway();
    this.port = await this.findFreePort();
    let gateway = '';
    try {
      gateway = this.materializeGateway();
    } catch (e) {
      // 明确报错，绝不静默失败（社区市场只分发 main.js，网关源码内联其中）
      this.state = 'error';
      this.lastError = (e as Error).message;
      console.error('[vinyl] ' + this.lastError);
      return false;
    }
    // stdout 直接丢弃：网关自己写 gateway.log（VINYL_LOG_FILE 见 gatewayEnv），
    // 再往 DevTools 控制台镜像一份属多余日志。stderr 仍需读取——既是排空管道（不读会让子进程写阻塞），
    // 也用来给启动失败提供原因。
    this.child = spawn(this.nodeBinary, [gateway], {
      env: this.gatewayEnv(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.rememberPid(this.child.pid);
    let earlyError = '';
    this.child.on('error', (err) => {
      earlyError = earlyError || err.message;
    });
    this.child.stderr?.on('data', (d) => {
      earlyError = earlyError || String(d).trim();
    });
    this.child.on('exit', (code) => {
      const wasIntentional = this.stopping;
      this.child = null;
      this.port = 0;
      this.state = 'stopped';
      this.forgetPid();
      if (wasIntentional) return;
      if (this.restarts < this.maxRestarts) {
        this.restarts++;
        window.setTimeout(() => {
          void this.ensure();
        }, 500);
      } else {
        this.state = 'error';
        this.lastError = `网关多次崩溃（最近一次退出码 ${code ?? '未知'}），已停止自动重启（可在设置里重试，或查看 gateway.log）`;
      }
    });

    // 就绪等待（最多 15s）
    for (let i = 0; i < 100; i++) {
      if (earlyError) break;
      try {
        const r = await requestUrl({
          url: `${this.base}/api/ping`,
          headers: { 'x-vinyl-token': this.token },
          throw: false,
        });
        if (r.status >= 200 && r.status < 300) {
          this.state = 'running';
          this.restarts = 0;
          return true;
        }
      } catch {
        // 尚未监听（进程刚起来）：继续等下一轮
      }
      await sleep(150);
    }
    const msg = earlyError ? `网关启动失败：${earlyError.slice(0, 200)}` : '网关 15s 未就绪';
    this.stop();
    this.state = 'error';
    this.lastError = msg;
    console.error('[vinyl] ' + msg);
    return false;
  }

  // 网关源码内联在 main.js 里（社区市场只安装 main.js / manifest.json / styles.css），
  // 首次使用时把源码落盘到系统临时目录再 spawn；文件名带源码 hash，升级自动换新文件。
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
        `无法写入网关临时文件（${file}）：${(e as Error).message}。` +
          '在线音源（网易云 / QQ 音乐）不可用，本地源不受影响；请检查系统临时目录权限。'
      );
    }
  }

  // 网关路径注入统一封装：COOKIE / ANON / QQ 凭据 / LOG 全部绝对化
  private gatewayEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      VINYL_PORT: String(this.port),
      VINYL_TOKEN: this.token,
      VINYL_COOKIE_FILE: pluginAbsPath(this.plugin, '.cookie'),
      VINYL_ANON_FILE: pluginAbsPath(this.plugin, '.anon-token'),
      VINYL_QQ_COOKIE_FILE: pluginAbsPath(this.plugin, '.qq-cookie'),
      VINYL_QQ_GUID_FILE: pluginAbsPath(this.plugin, '.qq-guid'),
      VINYL_LOG_FILE: pluginAbsPath(this.plugin, 'gateway.log'),
    };
  }

  stop() {
    this.stopping = true;
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // 进程可能已自行退出：忽略，下面照常复位状态
      }
      this.child = null;
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

  // —— 旧网关 PID 记录与清理（跨插件重载/崩溃的孤儿进程）——

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

  private rememberPid(pid: number | undefined): void {
    try {
      if (pid) fs.writeFileSync(this.stalePidFile(), String(pid));
    } catch {
      // 写不进去只影响「下次启动清理旧进程」，不阻塞本次启动
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
