// 网易云登录（浏览器官方页，v0.4.8 起为独立交互窗口）：
//   由 BrowserLogin 打开官方登录页的独立会话窗口（临时分区，不共享 Obsidian 登录态）。
//   窗口内完成登录（扫码 / 账号密码均可）后自动读取完整 Cookie（含 HttpOnly），
//   经 Auth 验证后接回账号：验证通过前不会覆盖现有账号，失败或关闭窗口保留原账号可重试。
//   零复制粘贴；手动兜底入口见对应音源的「扫码登录」弹窗（网易云 / QQ 音乐）。
import { App, Modal } from 'obsidian';
import type { LoginState } from '../core/auth';
import type { BrowserLogin } from '../core/browser-login';
import { notice } from '../util';

export interface WebAuthLike {
  getStatus(): Promise<LoginState>;
}

export interface WebLoginProvider {
  title: string;
  displayName: string;
  /** 窗口不可用时的扫码兜底入口名（对应插件命令名，文案随源切换） */
  qrFallback: string;
}

const NETEASE_WEB: WebLoginProvider = {
  title: '网易云登录（浏览器）',
  displayName: '网易云',
  qrFallback: '网易云扫码登录',
};

export const QQ_WEB: WebLoginProvider = {
  title: 'QQ 音乐登录（浏览器）',
  displayName: 'QQ 音乐',
  qrFallback: 'QQ 音乐扫码登录',
};

export class WebLoginModal extends Modal {
  private accountEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private closed = false;
  private provider: WebLoginProvider;
  /** 同一轮登录窗口只挂接一次回调，避免重复提示（重复点击 / 重开弹窗时 open 复用同一 Promise） */
  private watched: Promise<boolean> | null = null;

  constructor(
    app: App,
    private deps: {
      auth: WebAuthLike;
      browserLogin: BrowserLogin;
      provider?: WebLoginProvider;
      onLogin?: () => void | Promise<void>;
    }
  ) {
    super(app);
    this.provider = deps.provider ?? NETEASE_WEB;
    this.titleEl.setText(this.provider.title);
  }

  onOpen() {
    const c = this.contentEl;
    c.empty();
    this.closed = false;
    c.addClass('vinyl-web-login');

    this.accountEl = c.createDiv({ cls: 'vinyl-muted' });
    this.accountEl.setText('正在读取当前账号…');
    void this.deps.auth
      .getStatus()
      .then((st) => {
        if (this.closed) return;
        this.accountEl.setText(
          st.loggedIn
            ? `当前账号：${st.nick || ''}（${st.userId ?? ''}）；新登录验证通过后才会替换。`
            : '当前未登录；登录完成后自动验证并接回账号。'
        );
      })
      .catch(() => {
        if (!this.closed) this.accountEl.setText('当前账号读取失败，可在设置页查看登录态。');
      });

    const steps = c.createDiv({ cls: 'vinyl-muted vinyl-web-steps' });
    steps.createDiv({
      text: '第 1 步：点击下方按钮，在弹出的官方窗口内完成登录（扫码 / 账号密码均可）。',
    });
    steps.createDiv({
      text: '第 2 步：登录完成后无需操作——插件会自动检测、验证并接回账号；验证通过前不会覆盖现有登录。',
    });

    const actions = c.createDiv({ cls: 'vinyl-import-actions' });
    actions
      .createEl('button', { text: '打开官方登录窗口', cls: 'mod-cta' })
      .addEventListener('click', () => this.start());
    actions.createEl('button', { text: '检测登录' }).addEventListener('click', () => {
      if (this.deps.browserLogin.active) void this.deps.browserLogin.check();
      else this.start();
    });

    this.statusEl = c.createDiv({ cls: 'vinyl-muted' });
    this.statusEl.setText('正在打开官方登录窗口…');
    this.start();
  }

  onClose() {
    this.closed = true;
    // 关闭本弹窗不中断登录窗口：窗口内完成后仍会自动验证并保存，仅此处不再显示状态。
    this.contentEl.empty();
  }

  private start(): void {
    let login: Promise<boolean>;
    try {
      login = this.deps.browserLogin.open((message) => this.setStatus(message));
    } catch (e) {
      this.setStatus(
        `无法打开登录窗口：${(e as Error).message}（可改用「${this.provider.qrFallback}」或手动粘贴 Cookie）`
      );
      return;
    }
    if (login === this.watched) return;
    this.watched = login;
    void login
      .then((ok) => {
        if (ok) {
          notice(`${this.provider.displayName}登录成功，已接回账号`);
          void this.deps.onLogin?.();
          if (this.closed) return;
          this.setStatus('✅ 登录成功，账号已保存。');
          window.setTimeout(() => {
            if (!this.closed) this.close();
          }, 1200);
        } else {
          this.setStatus('登录窗口已关闭，尚未完成登录。可点击「打开官方登录窗口」重试。');
        }
      })
      .catch((e) => {
        this.setStatus(
          `无法打开登录窗口：${(e as Error).message}（可改用「${this.provider.qrFallback}」或手动粘贴 Cookie）`
        );
      });
  }

  private setStatus(message: string): void {
    if (this.closed) return;
    this.statusEl.setText(message);
  }
}
