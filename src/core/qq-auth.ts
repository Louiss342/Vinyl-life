// QQ 音乐登录态与 Cookie 管理（与 Auth 同语义）：
//   扫码 803 → 网关校验后落盘 .qq-cookie；官方登录窗口 / 手动粘贴走 saveCookie（校验通过才覆盖）；
//   失败或窗口关闭保留原账号。凭据仅存本机插件目录，不进笔记/日志/git。
import { Plugin } from 'obsidian';
import * as fs from 'fs';
import { ServerManager } from './server-manager';
import { QqService } from './qq';
import type { LoginState, QrCheckResult } from './auth';
import { readCredentialFile, writeCredentialFile } from './credential-file';
import { pluginAbsPath } from '../util';

const QQ_KEY_RE = /(?:^|;\s*)(?:qm_keyst|qqmusic_key)=[^;\s]+/;

export class QqAuth {
  constructor(
    private plugin: Plugin,
    private server: ServerManager,
    private client: QqService
  ) {}

  cookieFile(): string {
    return pluginAbsPath(this.plugin, '.qq-cookie');
  }

  hasLocalCookie(): boolean {
    return QQ_KEY_RE.test(readCredentialFile(this.cookieFile()));
  }

  cookieBytes(): number {
    try {
      return fs.readFileSync(this.cookieFile()).length;
    } catch {
      return 0;
    }
  }

  async getStatus(): Promise<LoginState> {
    const bytes = this.cookieBytes();
    if (!this.hasLocalCookie()) return { loggedIn: false, cookieBytes: bytes, serverOk: false };
    const ok = await this.server.ensure();
    if (!ok) return { loggedIn: false, cookieBytes: bytes, serverOk: false };
    try {
      const body = await this.client.loginStatus();
      const inner = body?.data || body || {};
      const nick = inner.profile?.nickname;
      const uid = inner.account?.id ?? inner.profile?.userId;
      return {
        loggedIn: !!(nick || uid),
        nick: nick ? String(nick) : undefined,
        userId: uid != null ? Number(uid) : undefined,
        cookieBytes: bytes,
        serverOk: true,
      };
    } catch {
      // 网关在但状态接口失败：按未登录返回
      return { loggedIn: false, cookieBytes: bytes, serverOk: true };
    }
  }

  async saveCookie(raw: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const cookie = raw.trim();
    if (!QQ_KEY_RE.test(cookie) || /[\r\n]/.test(cookie)) {
      throw new Error('Cookie 缺少有效的 qm_keyst');
    }
    const ok = await this.server.ensure();
    if (!ok) throw new Error(this.server.lastError || '网关未就绪');
    signal?.throwIfAborted();
    await this.client.validateCookie(cookie, signal);
    // 验证期间关闭登录窗口时，不让迟到的请求覆盖原账号。
    signal?.throwIfAborted();
    writeCredentialFile(this.cookieFile(), cookie);
  }

  async clear(): Promise<void> {
    try {
      if (await this.server.ensure()) await this.client.clearCookie();
    } catch {
      // 网关不可用：忽略，下面直接删本地文件（网关按请求从磁盘读 Cookie，两路等价）
    }
    try {
      fs.unlinkSync(this.cookieFile());
    } catch {
      // 文件本就不存在：目标状态已达成
    }
  }

  // —— 扫码（UI 复用 QrLoginModal，provider 配置见 views）——
  async beginQr(): Promise<{ key: string; qrimg: string }> {
    const ok = await this.server.ensure();
    if (!ok) throw new Error(this.server.lastError || '网关未就绪，无法登录');
    return this.client.qrKey();
  }

  // 803 时网关已验证并保存 Cookie；802 仅表示等待手机确认。
  async checkQr(key: string): Promise<QrCheckResult> {
    const body = await this.client.qrCheck(key);
    const code = Number(body?.code ?? -1);
    if (code !== 803) return { code };
    const inner = body?.data || {};
    const nick = inner.profile?.nickname;
    const uid = inner.account?.id ?? inner.profile?.userId;
    return {
      code,
      state: {
        loggedIn: !!(nick || uid),
        nick: nick ? String(nick) : undefined,
        userId: uid != null ? Number(uid) : undefined,
        cookieBytes: this.cookieBytes(),
        serverOk: true,
      },
    };
  }
}
