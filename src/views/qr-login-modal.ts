// 网易云登录弹窗（M0 V4 已验证链路的产品化封装）：
//   扫码：qrimg 自带 data: 前缀（M0 坑，勿重复拼接）→ 2s 轮询 800/801/802/803
//   手动：粘贴浏览器 Cookie 兜底
import { App, Modal } from 'obsidian';
import { ServerManager } from '../core/server-manager';
import type { LoginState } from '../core/auth';
import { t, tf } from '../core/i18n';

export interface QrAuthLike {
  beginQr(): Promise<{ key: string; qrimg: string }>;
  checkQr(key: string): Promise<number | { code: number; state?: LoginState }>;
  getStatus(): Promise<LoginState>;
  saveCookie(raw: string, signal?: AbortSignal): Promise<void>;
}

export interface QrLoginDeps {
  server: ServerManager;
  auth: QrAuthLike;
}

// 音源登录文案配置（netease 默认值保证既有文案与测试不变）
export interface QrProvider {
  id: 'netease' | 'qq';
  title: string;
  /** 扫码区提示（含 App 名） */
  appHint: string;
  /** 手动粘贴说明（含获取途径与 Cookie 名） */
  manualHint: string;
  /** 手动粘贴 placeholder */
  placeholder: string;
  /** CSP 兜底临时图片文件名（每位源独立，避免并发冲突） */
  tempPng: string;
  /** 扫码不顺时的替代入口提示（网易云默认无） */
  fallbackHint?: string;
  /** 「802 已授权但没拿到会话」这个失败态的指引（默认给手动粘贴兜底） */
  noSessionHint?: string;
}

// 用函数而不是常量：语言在设置里切换后，文案要跟着变（常量在模块加载时就定型了）
export function neteaseQrProvider(): QrProvider {
  return {
    id: 'netease',
    title: t('login.netease.title'),
    appHint: t('login.netease.appHint'),
    manualHint: t('login.netease.manualHint'),
    placeholder: 'MUSIC_U=xxx; __csrf=yyy; ...',
    tempPng: 'qr-login-tmp.png',
    // 新用户首次扫码时网关会现场注册匿名设备身份，该接口可能限流 → 失败态给出浏览器登录指引
    noSessionHint: t('login.netease.noSessionHint'),
  };
}

export function qqQrProvider(): QrProvider {
  return {
    id: 'qq',
    title: t('login.qq.title'),
    appHint: t('login.qq.appHint'),
    fallbackHint: t('login.qq.fallbackHint'),
    manualHint: t('login.qq.manualHint'),
    placeholder: 'qm_keyst=xxx; uin=123456789; ...',
    tempPng: 'qr-login-tmp-qq.png',
  };
}

export class QrLoginModal extends Modal {
  private deps: QrLoginDeps;
  private provider: QrProvider;
  private pollTimer: number | null = null;
  private showQr: boolean;
  private showManual: boolean;
  private qrGeneration = 0;
  private manualAbort: AbortController | null = null;
  private onLogin?: (state: LoginState) => void | Promise<void>;

  constructor(
    app: App,
    deps: QrLoginDeps,
    opts?: {
      qr?: boolean;
      manual?: boolean;
      provider?: QrProvider;
      onLogin?: (state: LoginState) => void | Promise<void>;
    }
  ) {
    super(app);
    this.deps = deps;
    this.provider = opts?.provider ?? neteaseQrProvider();
    this.showQr = opts?.qr ?? true;
    this.showManual = opts?.manual ?? true;
    this.onLogin = opts?.onLogin;
    this.titleEl.setText(this.provider.title);
  }

  async onOpen() {
    const c = this.contentEl;
    c.empty();
    c.addClass('vinyl-qr-modal');
    let startQr: (() => Promise<void>) | undefined;

    if (this.showQr) {
      const qrSec = c.createDiv({ cls: 'vinyl-qr-section' });
      qrSec.createEl('h4', { text: t('login.qrSection') });
      const img = qrSec.createEl('img', { attr: { width: '220', height: '220' } });
      const qrStatus = qrSec.createEl('div', { text: t('login.generating'), cls: 'vinyl-muted' });
      const refreshBtn = qrSec.createEl('button', { text: t('login.refreshQr') });
      if (this.provider.fallbackHint) {
        qrSec.createEl('div', { text: this.provider.fallbackHint, cls: 'vinyl-muted' });
      }

      const start = async () => {
        const generation = ++this.qrGeneration;
        this.stopPolling();
        refreshBtn.disabled = true;
        img.onerror = null;
        img.removeAttribute('src');
        qrStatus.textContent = t('login.generating');
        try {
          const { key, qrimg } = await this.deps.auth.beginQr();
          if (generation !== this.qrGeneration) return;
          // CSP 兜底：data URL 被拦时写临时文件走 app:// 资源路径
          img.onerror = async () => {
            if (generation !== this.qrGeneration) return;
            img.onerror = null;
            try {
              const b64 = qrimg.replace(/^data:image\/\w+;base64,/, '');
              const buf = Buffer.from(b64, 'base64');
              const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
              const tmpPath = '.obsidian/plugins/vinyl-note/' + this.provider.tempPng;
              await this.app.vault.adapter.writeBinary(tmpPath, ab);
              if (generation !== this.qrGeneration) return;
              img.src = this.app.vault.adapter.getResourcePath(tmpPath);
            } catch (e) {
              if (generation === this.qrGeneration) qrStatus.textContent = t('login.qrRenderFailed') + (e as Error).message;
            }
          };
          img.src = qrimg.startsWith('data:image/') ? qrimg : 'data:image/png;base64,' + qrimg;
          qrStatus.textContent = this.provider.appHint;
          this.poll(key, qrStatus, start, generation);
        } catch (e) {
          if (generation === this.qrGeneration) qrStatus.textContent = t('login.qrGenFailed') + (e as Error).message;
        } finally {
          if (generation === this.qrGeneration) refreshBtn.disabled = false;
        }
      };
      refreshBtn.addEventListener('click', start);
      startQr = start;
    }

    if (this.showManual) {
      if (this.showQr) c.createEl('hr');
      c.createEl('h4', { text: t('login.manualSection') });
      c.createEl('div', {
        text: this.provider.manualHint,
        cls: 'vinyl-muted',
      });
      const ta = c.createEl('textarea', {
        attr: { placeholder: this.provider.placeholder },
      });
      const saveBtn = c.createEl('button', { text: t('login.saveCookie'), cls: 'mod-cta' });
      const manualStatus = c.createEl('div', { cls: 'vinyl-muted' });
      saveBtn.addEventListener('click', async () => {
        const val = ta.value.trim();
        if (!val) {
          manualStatus.textContent = t('login.cookieEmpty');
          return;
        }
        saveBtn.disabled = true;
        manualStatus.textContent = t('login.verifying');
        this.manualAbort?.abort();
        const abort = new AbortController();
        this.manualAbort = abort;
        try {
          await this.deps.auth.saveCookie(val, abort.signal);
          if (abort.signal.aborted) return;
          const st = await this.deps.auth.getStatus();
          if (abort.signal.aborted) return;
          if (st.loggedIn) {
            manualStatus.textContent =
              tf('login.cookieOk', { nick: String(st.nick), id: String(st.userId) }) +
              (st.vipType === 11 ? ' · VIP' : '');
            void this.onLogin?.(st);
          } else {
            manualStatus.textContent = t('login.cookieInvalid');
          }
        } catch (e) {
          if (!abort.signal.aborted) manualStatus.textContent = t('login.saveFailed') + (e as Error).message;
        } finally {
          if (this.manualAbort === abort) this.manualAbort = null;
          if (!abort.signal.aborted) saveBtn.disabled = false;
        }
      });
    }
    if (startQr) await startQr();
  }

  private poll(key: string, statusEl: HTMLElement, restart: () => Promise<void>, generation: number) {
    if (generation !== this.qrGeneration) return;
    this.pollTimer = window.setTimeout(async () => {
      this.pollTimer = null;
      if (generation !== this.qrGeneration) return;
      try {
        const result = await this.deps.auth.checkQr(key);
        const code = typeof result === 'number' ? result : result.code;
        if (generation !== this.qrGeneration) return;
        if (code === 800) {
          statusEl.textContent = t('login.qrExpired');
          await restart();
          return;
        } else if (code === 801) {
          statusEl.textContent = t('login.waitScan') + this.provider.appHint + '…';
        } else if (code === 802) {
          statusEl.textContent = t('login.scannedConfirm');
        } else if (code === 803) {
          statusEl.textContent = t('login.authorizing');
          // 新网关直接复用 803 前已经验证过的账号，避免紧接着重复请求远端导致假失败。
          // 数字返回值仍兼容旧网关与测试替身。
          const st = typeof result === 'number' || !result.state
            ? await this.deps.auth.getStatus()
            : result.state;
          if (generation !== this.qrGeneration) return;
          if (st.loggedIn) {
            statusEl.textContent = tf('login.loggedIn', {
              nick: st.nick || '',
              id: st.userId ?? '',
              vip: st.vipType === 11 ? ' · VIP' : '',
            });
            void this.onLogin?.(st);
          } else {
            statusEl.textContent = this.provider.noSessionHint ?? t('login.noSession');
          }
          return;
        } else {
          statusEl.textContent = tf('login.qrAbnormal', { code });
        }
      } catch (e) {
        if (generation !== this.qrGeneration) return;
        statusEl.textContent = tf('login.qrCheckFailed', { msg: (e as Error).message });
      }
      // 下一次检查等本次请求完成后再安排，避免慢请求重入。
      this.poll(key, statusEl, restart, generation);
    }, 2000);
  }

  private stopPolling() {
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  onClose() {
    this.qrGeneration++;
    this.manualAbort?.abort();
    this.manualAbort = null;
    this.stopPolling();
    this.contentEl.empty();
  }
}
