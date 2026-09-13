// 网易云登录（浏览器官方页，独立交互窗口）：
//   由 BrowserLogin 打开官方登录页的独立会话窗口（临时分区，不共享 Obsidian 登录态）。
//   窗口内完成登录（扫码 / 账号密码均可）后自动读取完整 Cookie（含 HttpOnly），
//   经 Auth 验证后接回账号：验证通过前不会覆盖现有账号，失败或关闭窗口保留原账号可重试。
//   零复制粘贴；手动兜底入口见对应音源的「扫码登录」弹窗（网易云 / QQ 音乐）。
import { App, Modal } from 'obsidian';
import type { LoginState } from '../core/auth';
import type { BrowserLogin } from '../core/browser-login';
import { notice } from '../util';
import { t, tf } from '../core/i18n';

export interface WebAuthLike {
  getStatus(): Promise<LoginState>;
}

export interface WebLoginProvider {
  title: string;
  displayName: string;
  /** 窗口不可用时的扫码兜底入口名（对应插件命令名，文案随源切换） */
  qrFallback: string;
}

// 用函数而不是常量：语言在设置里切换后，文案要跟着变（常量在模块加载时就定型了）
function neteaseWebProvider(): WebLoginProvider {
  return {
    title: t('login.web.netease.title'),
    displayName: t('login.web.netease.displayName'),
    qrFallback: t('cmd.neteaseLogin'),
  };
}

export function qqWebProvider(): WebLoginProvider {
  return {
    title: t('login.web.qq.title'),
    displayName: t('login.web.qq.displayName'),
    qrFallback: t('cmd.qqLogin'),
  };
}

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
    this.provider = deps.provider ?? neteaseWebProvider();
    this.titleEl.setText(this.provider.title);
  }

  onOpen() {
    const c = this.contentEl;
    c.empty();
    this.closed = false;
    c.addClass('vinyl-web-login');

    this.accountEl = c.createDiv({ cls: 'vinyl-muted' });
    this.accountEl.setText(t('login.web.readingAccount'));
    void this.deps.auth
      .getStatus()
      .then((st) => {
        if (this.closed) return;
        this.accountEl.setText(
          st.loggedIn
            ? tf('login.web.account', { nick: st.nick || '', id: st.userId ?? '' })
            : t('login.web.notLoggedIn')
        );
      })
      .catch(() => {
        if (!this.closed) this.accountEl.setText(t('login.web.accountFailed'));
      });

    const steps = c.createDiv({ cls: 'vinyl-muted vinyl-web-steps' });
    steps.createDiv({
      text: t('login.web.step1'),
    });
    steps.createDiv({
      text: t('login.web.step2'),
    });

    const actions = c.createDiv({ cls: 'vinyl-import-actions' });
    actions
      .createEl('button', { text: t('login.web.openWindow'), cls: 'mod-cta' })
      .addEventListener('click', () => this.start());
    actions.createEl('button', { text: t('login.web.check') }).addEventListener('click', () => {
      if (this.deps.browserLogin.active) void this.deps.browserLogin.check();
      else this.start();
    });

    this.statusEl = c.createDiv({ cls: 'vinyl-muted' });
    this.statusEl.setText(t('login.web.opening'));
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
        tf('login.web.openFailed', {
          msg: (e as Error).message,
          fallback: this.provider.qrFallback,
        })
      );
      return;
    }
    if (login === this.watched) return;
    this.watched = login;
    void login
      .then((ok) => {
        if (ok) {
          notice(tf('login.web.success', { name: this.provider.displayName }));
          void this.deps.onLogin?.();
          if (this.closed) return;
          this.setStatus(t('login.web.saved'));
          window.setTimeout(() => {
            if (!this.closed) this.close();
          }, 1200);
        } else {
          this.setStatus(t('login.web.closed'));
        }
      })
      .catch((e) => {
        this.setStatus(
          tf('login.web.openFailed', {
            msg: (e as Error).message,
            fallback: this.provider.qrFallback,
          })
        );
      });
  }

  private setStatus(message: string): void {
    if (this.closed) return;
    this.statusEl.setText(message);
  }
}
