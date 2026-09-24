// 酷狗登录态与凭据管理（与 Auth / QqAuth 同语义）：
//   扫码 803 → 网关校验后落盘 .kugou-cookie（token + userid；登录只有这一条路径）。
//   未登录也能搜索与取流（免费曲目），登录只影响会员音质与付费曲目 —— 所以状态行
//   要把「未登录」表达成可选项，而不是错误。
// 凭据仅存本机插件目录，不进笔记/日志/git。
import { Plugin } from 'obsidian';
import * as fs from 'fs';
import { ServerManager } from './server-manager';
import { KugouService } from './kugou';
import type { LoginState, QrCheckResult } from './auth';
import { readCredentialFile } from './credential-file';
import { pluginAbsPath } from '../util';
import { t } from './i18n';

const KUGOU_KEY_RE = /(?:^|;\s*)token=[^;\s]+/;

export class KugouAuth {
  constructor(
    private plugin: Plugin,
    private server: ServerManager,
    private client: KugouService
  ) {}

  cookieFile(): string {
    return pluginAbsPath(this.plugin, '.kugou-cookie');
  }

  hasLocalCookie(): boolean {
    return KUGOU_KEY_RE.test(readCredentialFile(this.cookieFile()));
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
        userId: uid != null ? Number(uid) || undefined : undefined,
        cookieBytes: bytes,
        serverOk: true,
      };
    } catch {
      // 网关在但状态接口失败：按未登录返回
      return { loggedIn: false, cookieBytes: bytes, serverOk: true };
    }
  }

  async clear(): Promise<void> {
    try {
      if (await this.server.ensure()) await this.client.clearCookie();
    } catch {
      // 网关不可用：忽略，下面直接删本地文件（网关按请求从磁盘读凭据，两路等价）
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
    if (!ok) throw new Error(this.server.lastError || t('auth.gatewayNotReadyCannotLogin'));
    return this.client.qrKey();
  }

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
        userId: uid != null ? Number(uid) || undefined : undefined,
        cookieBytes: this.cookieBytes(),
        serverOk: true,
      },
    };
  }
}
