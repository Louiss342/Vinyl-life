// 独立官方登录窗口：由 Electron 会话读取完整 Cookie（含 HttpOnly），
// 验证后经 Auth 导入网关。窗口使用临时内存会话，不共享 Obsidian 的登录态。
import type { Auth } from './auth';

export interface BrowserLoginOptions {
  /** 官方登录页（Cookie 按此 URL 过滤） */
  loginUrl: string;
  /** 判定登录成功的 Cookie 名（HttpOnly 主票据） */
  requiredCookie: string;
  /** 窗口标题 */
  title: string;
  /** 临时会话分区前缀（每次尝试追加随机串，避免共享 Obsidian 登录态） */
  partitionPrefix: string;
  /** 状态文案中的服务名 */
  displayName: string;
  /** 同一凭据的其它命名（不同版本 Cookie 名，需非空才算命中） */
  altCookies?: string[];
  /**
   * requiredCookie 在 loginUrl 域下不可见时，按名字在整个临时会话分区兜底查找
   * （QQ 的 qm_keyst 可能只落在子域/其它主机上；网易云默认关闭，行为不变）
   */
  searchSessionByCookieName?: boolean;
  /** 长时间未捕获到凭据时，把 Cookie 名单（仅名称）打到控制台便于排查 */
  debugCookieInventory?: boolean;
  /** 允许 https 弹窗：官方登录页常以弹窗 + window.opener 回传结果 */
  allowHttpsPopups?: boolean;
}

export const NETEASE_BROWSER_LOGIN: BrowserLoginOptions = {
  loginUrl: 'https://music.163.com/',
  requiredCookie: 'MUSIC_U',
  title: '网易云音乐登录 · Vinyl Life',
  partitionPrefix: 'vinyl-life-login',
  displayName: '网易云',
};

export const QQ_BROWSER_LOGIN: BrowserLoginOptions = {
  loginUrl: 'https://y.qq.com/',
  requiredCookie: 'qm_keyst',
  title: 'QQ 音乐登录 · Vinyl Life',
  partitionPrefix: 'vinyl-life-qq-login',
  displayName: 'QQ 音乐',
  // 旧版命名 / 跨主机兜底 / 弹窗登录（QQ 登录页靠 window.opener 回传结果）
  altCookies: ['qqmusic_key'],
  searchSessionByCookieName: true,
  debugCookieInventory: true,
  allowHttpsPopups: true,
};

interface LoginAttempt {
  win: BrowserWindowLike;
  session: SessionLike;
  partition: string;
  /** 登录页弹出的子窗口（关窗时一并销毁） */
  children: Set<BrowserWindowLike>;
  timer?: number;
  promise: Promise<boolean>;
  resolve: (loggedIn: boolean) => void;
  abort: AbortController;
  busy: boolean;
  rejectedCookie: string;
  rejectedAt: number;
  lastInventoryAt: number;
  onStatus?: (message: string) => void;
}

interface BrowserCookie {
  name: string;
  value: string;
}

interface PreventableEvent {
  preventDefault(): void;
}

interface SessionLike {
  cookies: { get(filter: { url?: string }): Promise<BrowserCookie[]> };
  setPermissionRequestHandler(
    handler: (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void
  ): void;
  setPermissionCheckHandler(handler: () => boolean): void;
  clearStorageData(): Promise<void>;
}

interface WebContentsLike {
  session: SessionLike;
  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: 'allow' | 'deny'; overrideBrowserWindowOptions?: object }
  ): void;
  on(event: string, handler: (...args: never[]) => void): void;
}

interface BrowserWindowLike {
  webContents: WebContentsLike;
  show(): void;
  focus(): void;
  loadURL(url: string): Promise<void>;
  once(event: string, handler: () => void): void;
  isDestroyed(): boolean;
  destroy(): void;
}

interface BrowserWindowConstructor {
  new (options: object): BrowserWindowLike;
}

interface RemoteLike {
  BrowserWindow?: BrowserWindowConstructor;
}

export class BrowserLogin {
  private attempt: LoginAttempt | null = null;
  private disposed = false;

  constructor(
    private auth: Pick<Auth, 'saveCookie'>,
    private opts: BrowserLoginOptions = NETEASE_BROWSER_LOGIN
  ) {}

  /** 登录窗口是否处于打开状态（供「检测登录」等入口判断） */
  get active(): boolean {
    return this.attempt !== null;
  }

  open(onStatus?: (message: string) => void): Promise<boolean> {
    if (this.disposed) return Promise.reject(new Error('插件已卸载，请重新启用后登录'));
    if (this.attempt) {
      this.attempt.onStatus = onStatus;
      this.attempt.win.show();
      this.attempt.win.focus();
      return this.attempt.promise;
    }

    const loadModule: (id: string) => unknown = require;
    let remote: RemoteLike;
    try {
      remote = loadModule('@electron/remote') as RemoteLike;
    } catch {
      const electron = loadModule('electron') as { remote?: RemoteLike };
      remote = electron.remote ?? {};
    }
    if (!remote?.BrowserWindow) {
      return Promise.reject(new Error('当前环境无法创建登录窗口，请使用桌面版 Obsidian'));
    }

    const partition = `${this.opts.partitionPrefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const win = new remote.BrowserWindow({
      width: 1100,
      height: 780,
      title: this.opts.title,
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
    });
    let resolve!: (loggedIn: boolean) => void;
    const promise = new Promise<boolean>((done) => { resolve = done; });
    const attempt: LoginAttempt = {
      win,
      session: win.webContents.session,
      partition,
      children: new Set(),
      promise,
      resolve,
      abort: new AbortController(),
      busy: false,
      rejectedCookie: '',
      rejectedAt: 0,
      lastInventoryAt: 0,
      onStatus,
    };
    this.attempt = attempt;
    attempt.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    attempt.session.setPermissionCheckHandler(() => false);
    // 登录页没有本机权限。新链接默认复用此窗口（避免遗留无管理的弹窗）；
    // 但部分官方登录页（如 QQ 音乐）依赖弹窗 + window.opener 回传登录结果，
    // 这类源允许 https 弹窗，并挂上同样的导航守卫、关窗时一并回收。
    win.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
      if (!this.isHttps(url)) return { action: 'deny' };
      if (this.opts.allowHttpsPopups) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            webPreferences: {
              partition,
              nodeIntegration: false,
              nodeIntegrationInSubFrames: false,
              contextIsolation: true,
              sandbox: true,
              webSecurity: true,
              webviewTag: false,
            },
          },
        };
      }
      void win.loadURL(url).catch(() => this.loadError(attempt));
      return { action: 'deny' };
    });
    win.webContents.on('did-create-window', (child: BrowserWindowLike) => {
      if (this.attempt !== attempt || !child.webContents) return;
      attempt.children.add(child);
      child.once('closed', () => attempt.children.delete(child));
      child.webContents.on('will-navigate', (event: PreventableEvent, url: string) => {
        if (!this.isHttps(url)) event.preventDefault();
      });
    });
    win.webContents.on('will-navigate', (event: PreventableEvent, url: string) => {
      if (!this.isHttps(url)) event.preventDefault();
    });
    win.webContents.on('will-redirect', (event: PreventableEvent, url: string) => {
      if (!this.isHttps(url)) event.preventDefault();
    });
    win.webContents.on('did-fail-load', (_event: PreventableEvent, code: number, _description: string, _url: string, mainFrame: boolean) => {
      if (mainFrame && code !== -3) this.loadError(attempt);
    });
    win.webContents.on('render-process-gone', () => {
      if (this.attempt !== attempt) return;
      attempt.onStatus?.('登录窗口已停止运行，请重新打开登录窗口。');
      this.finish(attempt, false);
    });
    win.once('closed', () => this.finish(attempt, false));
    attempt.timer = window.setInterval(() => { void this.poll(attempt, false); }, 2000);
    onStatus?.('请在官方窗口点击右上角「登录」。登录完成后会自动验证并返回。');
    void win.loadURL(this.opts.loginUrl).catch(() => this.loadError(attempt));
    void this.poll(attempt, false);
    return promise;
  }

  async check(): Promise<void> {
    if (this.attempt) await this.poll(this.attempt, true);
  }

  cancel(): void {
    if (this.attempt) this.finish(this.attempt, false);
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private async poll(attempt: LoginAttempt, force: boolean): Promise<void> {
    if (this.attempt !== attempt || attempt.busy) return;
    attempt.busy = true;
    try {
      let cookies: { name: string; value: string }[] = await attempt.session.cookies.get({
        url: this.opts.loginUrl,
      });
      if (this.attempt !== attempt) return;
      if (!this.accepts(cookies)) {
        const fallback = await this.findByCookieName(attempt, cookies);
        if (this.attempt !== attempt) return;
        if (!fallback) {
          if (force) attempt.onStatus?.('尚未检测到账号登录，请在官方窗口完成登录。');
          return;
        }
        cookies = fallback;
      }
      const raw = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
      // 同一 Cookie 校验失败后短暂退避，避免 2 秒一轮轰炸网关；网络恢复后自动重试。
      if (!force && raw === attempt.rejectedCookie && Date.now() - attempt.rejectedAt < 8000) return;
      attempt.onStatus?.('已检测到账号，正在验证登录…');
      try {
        await this.auth.saveCookie(raw, attempt.abort.signal);
      } catch (error) {
        attempt.rejectedCookie = raw;
        attempt.rejectedAt = Date.now();
        throw error;
      }
      if (this.attempt !== attempt) return;
      attempt.onStatus?.(`${this.opts.displayName}登录成功，已保存登录状态。`);
      this.finish(attempt, true);
    } catch (error) {
      if (this.attempt === attempt && !attempt.abort.signal.aborted) {
        attempt.onStatus?.(`登录验证失败：${(error as Error).message}。可继续登录或点击「检测登录」重试。`);
      }
    } finally {
      attempt.busy = false;
    }
  }

  private acceptedNames(): string[] {
    return [this.opts.requiredCookie, ...(this.opts.altCookies || [])];
  }

  private accepts(cookies: BrowserCookie[]): boolean {
    const names = this.acceptedNames();
    return cookies.some((cookie) => names.includes(cookie.name) && cookie.value);
  }

  /**
   * loginUrl 域下看不到凭据时的兜底：按名字在整个临时会话分区里找
   * （QQ 的 qm_keyst 可能只落在子域；网易云默认不开此路径，行为不变）。
   */
  private async findByCookieName(
    attempt: LoginAttempt,
    scoped: BrowserCookie[]
  ): Promise<BrowserCookie[] | null> {
    if (!this.opts.searchSessionByCookieName) return null;
    let all: BrowserCookie[] = [];
    try {
      all = await attempt.session.cookies.get({});
    } catch (_) {
      return null;
    }
    if (this.attempt !== attempt) return null;
    const names = this.acceptedNames();
    const merged = new Map<string, string>(scoped.map((cookie) => [cookie.name, cookie.value]));
    for (const cookie of all) {
      if (names.includes(cookie.name) && cookie.value) merged.set(cookie.name, cookie.value);
    }
    if (!names.some((name) => merged.has(name) && merged.get(name))) {
      return null;
    }
    // 账号标识也一并带上（校验接口需要）
    for (const name of ['uin', 'p_uin', 'wxuin']) {
      if (merged.has(name)) continue;
      const hit = all.find((cookie) => cookie.name === name && cookie.value);
      if (hit) merged.set(hit.name, hit.value);
    }
    return [...merged].map(([name, value]) => ({ name, value }));
  }

  private finish(attempt: LoginAttempt, loggedIn: boolean): void {
    if (this.attempt !== attempt) return;
    this.attempt = null;
    attempt.abort.abort();
    if (attempt.timer) window.clearInterval(attempt.timer);
    for (const child of attempt.children) {
      try {
        if (!child.isDestroyed()) child.destroy();
      } catch {}
    }
    attempt.children.clear();
    if (!attempt.win.isDestroyed()) attempt.win.destroy();
    // 临时会话退出即清理；凭据只由 Auth 在验证通过后保存。
    void attempt.session.clearStorageData().catch(() => {});
    attempt.rejectedCookie = '';
    attempt.rejectedAt = 0;
    attempt.resolve(loggedIn);
  }

  private loadError(attempt: LoginAttempt): void {
    if (this.attempt === attempt) {
      attempt.onStatus?.('官方登录页加载失败，请检查网络后关闭并重新打开登录窗口。');
    }
  }

  private isHttps(url: string): boolean {
    try { return new URL(url).protocol === 'https:'; } catch { return false; }
  }
}
