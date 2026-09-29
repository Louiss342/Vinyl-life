// 扫码登录弹窗（网易云 / QQ 音乐 / 酷狗音乐共用，provider 给文案与临时图名）：登录只有扫码一条路径。
// qrimg 可能自带 data: 前缀（勿重复拼接），2s 轮询 800/801/802/803。
import { App, Modal } from 'obsidian';
import { ServerManager } from '../core/server-manager';
import type { LoginState } from '../core/auth';
import { markVinylModal } from '../util';
import { t, tf } from '../core/i18n';

export interface QrAuthLike {
  beginQr(): Promise<{ key: string; qrimg: string }>;
  checkQr(key: string): Promise<number | { code: number; state?: LoginState }>;
  getStatus(): Promise<LoginState>;
}

export interface QrLoginDeps {
  server: ServerManager;
  auth: QrAuthLike;
}

// 音源登录文案配置（netease 作默认值，既有文案与测试因此不变）
export interface QrProvider {
  id: 'netease' | 'qq' | 'kugou';
  title: string;
  /** 扫码区提示（含 App 名） */
  appHint: string;
  /** CSP 兜底临时图片文件名（每位源独立，避免并发冲突） */
  tempPng: string;
  /** 「已授权但没拿到会话」失败态的指引（默认给重试建议） */
  noSessionHint?: string;
}

// 用函数而非常量：语言切换后文案要跟着变（常量在模块加载时就定型了）
export function neteaseQrProvider(): QrProvider {
  return {
    id: 'netease',
    title: t('login.netease.title'),
    appHint: t('login.netease.appHint'),
    tempPng: 'qr-login-tmp.png',
    // 首次扫码时网关现场注册匿名设备身份，该接口可能限流 → 失败态给重试指引
    noSessionHint: t('login.netease.noSessionHint'),
  };
}

export function qqQrProvider(): QrProvider {
  return {
    id: 'qq',
    title: t('login.qq.title'),
    appHint: t('login.qq.appHint'),
    tempPng: 'qr-login-tmp-qq.png',
  };
}

export function kugouQrProvider(): QrProvider {
  return {
    id: 'kugou',
    title: t('login.kugou.title'),
    appHint: t('login.kugou.appHint'),
    tempPng: 'qr-login-tmp-kugou.png',
  };
}

export class QrLoginModal extends Modal {
  private deps: QrLoginDeps;
  private provider: QrProvider;
  private pollTimer: number | null = null;
  private qrGeneration = 0;
  private onLogin?: (state: LoginState) => void | Promise<void>;
  /** 插件目录（vault 相对，形如 plugins/vinyl-life）：二维码兜底往这里写临时 PNG；由调用方从
   *  manifest.dir 传进来 —— 写死的话用户重命名插件目录后就指向不存在的目录（见 tmpPath 处）。 */
  private pluginDir: string;

  constructor(
    app: App,
    deps: QrLoginDeps,
    opts?: {
      provider?: QrProvider;
      onLogin?: (state: LoginState) => void | Promise<void>;
      pluginDir?: string;
    }
  ) {
    super(app);
    markVinylModal(this);
    this.modalEl.addClass('vinyl-dialog-compact', 'vinyl-dialog-actions');
    this.deps = deps;
    this.provider = opts?.provider ?? neteaseQrProvider();
    this.onLogin = opts?.onLogin;
    this.pluginDir = opts?.pluginDir || 'plugins/vinyl-life';
    this.titleEl.setText(this.provider.title);
  }

  async onOpen() {
    const c = this.contentEl;
    c.empty();
    c.addClass('vinyl-qr-modal');

    const qrSec = c.createDiv({ cls: 'vinyl-qr-section' });
    qrSec.createEl('h4', { text: t('login.qrSection') });
    // 二维码图对读屏没意义，但不能留成无名的图：alt 用扫码提示（「请用 XX App 扫码」）；状态行标
    // status —— 生成中 / 已扫码 / 已过期全靠它播报（登录只有扫码一条路径，读屏要知道轮到哪一步）。
    const img = qrSec.createEl('img', {
      attr: { width: '220', height: '220', alt: this.provider.appHint },
    });
    const qrStatus = qrSec.createDiv({
      text: t('login.generating'),
      cls: 'vinyl-muted',
      attr: { role: 'status' },
    });
    const refreshBtn = qrSec.createEl('button', { text: t('login.refreshQr') });

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
            const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            // 配置目录与插件目录都可能被改名：前者走 Vault#configDir，后者由调用方传（都不写死）
            const tmpPath = `${this.app.vault.configDir}/${this.pluginDir}/${this.provider.tempPng}`;
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
    refreshBtn.addEventListener('click', () => {
      void start();
    });
    await start();
  }

  private poll(key: string, statusEl: HTMLElement, restart: () => Promise<void>, generation: number) {
    if (generation !== this.qrGeneration) return;
    // 回调只「点火」不等待：定时器回调不接收 Promise 返回，void 表示有意不 await；下一轮由 tick 结束时自己安排
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null;
      void this.tick(key, statusEl, restart, generation);
    }, 2000);
  }

  /** 单次轮询：查码 → 更新状态 → 安排下一次（下次等本次请求完成后再排，避免慢请求重入）。 */
  private async tick(
    key: string,
    statusEl: HTMLElement,
    restart: () => Promise<void>,
    generation: number
  ): Promise<void> {
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
        // 803 已带回验证过的账号：直接复用以免重复请求远端造成假失败（只在拿到数字返回值、或响应里没有 state 时才回落到 getStatus）
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
    this.poll(key, statusEl, restart, generation);
  }

  private stopPolling() {
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  onClose() {
    this.qrGeneration++;
    this.stopPolling();
    this.contentEl.empty();
  }
}
