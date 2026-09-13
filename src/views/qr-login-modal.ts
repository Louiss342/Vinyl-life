// 网易云登录弹窗（M0 V4 已验证链路的产品化封装）：
//   扫码：qrimg 自带 data: 前缀（M0 坑，勿重复拼接）→ 2s 轮询 800/801/802/803
//   手动：粘贴浏览器 Cookie 兜底
import { App, Modal } from 'obsidian';
import { ServerManager } from '../core/server-manager';
import type { LoginState } from '../core/auth';

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
}

export const NETEASE_QR_PROVIDER: QrProvider = {
  id: 'netease',
  title: '网易云登录',
  appHint: '请用网易云音乐 App 扫码',
  manualHint:
    '浏览器打开 music.163.com 登录 → F12 → Application（应用）→ Cookies → music.163.com，复制 MUSIC_U 的 Value，按 MUSIC_U=复制的值 粘贴到下面。此方法也可读取 HttpOnly Cookie。',
  placeholder: 'MUSIC_U=xxx; __csrf=yyy; ...',
  tempPng: 'qr-login-tmp.png',
  fallbackHint:
    '若扫码长时间无反应（网易云对新设备的匿名注册有限流），请改用命令「网易云浏览器登录（官方登录页）」——官方页面登录，最稳。',
};

export const QQ_QR_PROVIDER: QrProvider = {
  id: 'qq',
  title: 'QQ 音乐登录',
  appHint: '请用手机 QQ 扫码（此为 QQ 互联二维码，QQ 音乐 App 的「扫一扫」识别不了）',
  fallbackHint:
    '若扫码后长时间停在「已扫码」，请改用设置里的「QQ 浏览器登录」——在官方页面里微信 / QQ 扫码都能完成登录（已实测可用）。',
  manualHint:
    '浏览器打开 y.qq.com 登录 → F12 → Application（应用）→ Cookies → y.qq.com，复制 qm_keyst 的 Value，按 qm_keyst=复制的值 粘贴到下面。此方法也可读取 HttpOnly Cookie。',
  placeholder: 'qm_keyst=xxx; uin=123456789; ...',
  tempPng: 'qr-login-tmp-qq.png',
};

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
    this.provider = opts?.provider ?? NETEASE_QR_PROVIDER;
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
      qrSec.createEl('h4', { text: '扫码登录' });
      const img = qrSec.createEl('img', { attr: { width: '220', height: '220' } });
      const qrStatus = qrSec.createEl('div', { text: '正在生成二维码…', cls: 'vinyl-muted' });
      const refreshBtn = qrSec.createEl('button', { text: '刷新二维码' });
      if (this.provider.fallbackHint) {
        qrSec.createEl('div', { text: this.provider.fallbackHint, cls: 'vinyl-muted' });
      }

      const start = async () => {
        const generation = ++this.qrGeneration;
        this.stopPolling();
        refreshBtn.disabled = true;
        img.onerror = null;
        img.removeAttribute('src');
        qrStatus.textContent = '正在生成二维码…';
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
              if (generation === this.qrGeneration) qrStatus.textContent = '二维码渲染失败：' + (e as Error).message;
            }
          };
          img.src = qrimg.startsWith('data:image/') ? qrimg : 'data:image/png;base64,' + qrimg;
          qrStatus.textContent = this.provider.appHint;
          this.poll(key, qrStatus, start, generation);
        } catch (e) {
          if (generation === this.qrGeneration) qrStatus.textContent = '生成二维码失败：' + (e as Error).message;
        } finally {
          if (generation === this.qrGeneration) refreshBtn.disabled = false;
        }
      };
      refreshBtn.addEventListener('click', start);
      startQr = start;
    }

    if (this.showManual) {
      if (this.showQr) c.createEl('hr');
      c.createEl('h4', { text: '手动粘贴 Cookie（兜底）' });
      c.createEl('div', {
        text: this.provider.manualHint,
        cls: 'vinyl-muted',
      });
      const ta = c.createEl('textarea', {
        attr: { placeholder: this.provider.placeholder },
      });
      const saveBtn = c.createEl('button', { text: '保存 Cookie', cls: 'mod-cta' });
      const manualStatus = c.createEl('div', { cls: 'vinyl-muted' });
      saveBtn.addEventListener('click', async () => {
        const val = ta.value.trim();
        if (!val) {
          manualStatus.textContent = '请输入 Cookie 内容';
          return;
        }
        saveBtn.disabled = true;
        manualStatus.textContent = '正在保存并验证…';
        this.manualAbort?.abort();
        const abort = new AbortController();
        this.manualAbort = abort;
        try {
          await this.deps.auth.saveCookie(val, abort.signal);
          if (abort.signal.aborted) return;
          const st = await this.deps.auth.getStatus();
          if (abort.signal.aborted) return;
          if (st.loggedIn) {
            manualStatus.textContent = `✅ Cookie 有效，已登录：${st.nick}（${st.userId}）${
              st.vipType === 11 ? ' · VIP' : ''
            }`;
            void this.onLogin?.(st);
          } else {
            manualStatus.textContent = '❌ 登录态无效（Cookie 可能过期或格式不对）';
          }
        } catch (e) {
          if (!abort.signal.aborted) manualStatus.textContent = '保存失败：' + (e as Error).message;
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
          statusEl.textContent = '二维码已过期，正在刷新…';
          await restart();
          return;
        } else if (code === 801) {
          statusEl.textContent = '等待扫码，' + this.provider.appHint + '…';
        } else if (code === 802) {
          statusEl.textContent = '已扫码，请在手机上确认登录…';
        } else if (code === 803) {
          statusEl.textContent = '授权成功，正在读取登录态…';
          // 新网关直接复用 803 前已经验证过的账号，避免紧接着重复请求远端导致假失败。
          // 数字返回值仍兼容旧网关与测试替身。
          const st = typeof result === 'number' || !result.state
            ? await this.deps.auth.getStatus()
            : result.state;
          if (generation !== this.qrGeneration) return;
          if (st.loggedIn) {
            statusEl.textContent = `✅ 已登录：${st.nick || ''}（${st.userId ?? ''}）${
              st.vipType === 11 ? ' · VIP' : ''
            }。登录会话已保存。`;
            void this.onLogin?.(st);
          } else {
            statusEl.textContent =
              '❌ 已授权但未取得有效登录会话，请刷新二维码重试，或使用「手动粘贴 Cookie」。';
          }
          return;
        } else {
          statusEl.textContent = `扫码状态异常（${code}），正在重试；也可刷新二维码。`;
        }
      } catch (e) {
        if (generation !== this.qrGeneration) return;
        statusEl.textContent = '扫码检查失败：' + (e as Error).message + '。正在重试，也可刷新二维码。';
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
