// 登录态与 Cookie 管理：
//   扫码 803 → 网关验证后落盘 .cookie；官方登录窗口 + 手动粘贴。
//   凭据仅存本机插件目录，不进笔记/日志/git。
import { Plugin } from 'obsidian';
import * as fs from 'fs';
import { ServerManager } from './server-manager';
import { ServerClient } from './server-client';
import { writeCredentialFile } from './credential-file';
import { pluginAbsPath } from '../util';
import { t } from './i18n';

export interface LoginState {
  loggedIn: boolean;
  nick?: string;
  userId?: number;
  /** 0 非会员 / 11 VIP（网易云口径） */
  vipType?: number;
  cookieBytes: number;
  /** 网关是否可用（false 时结果为本地文件判断，非最终结论） */
  serverOk: boolean;
}

export interface QrCheckResult {
  code: number;
  state?: LoginState;
}

export class Auth {
  constructor(
    private plugin: Plugin,
    private server: ServerManager,
    private client: ServerClient
  ) {}

  cookieFile(): string {
    return pluginAbsPath(this.plugin, '.cookie');
  }

  anonTokenFile(): string {
    return pluginAbsPath(this.plugin, '.anon-token');
  }

  hasLocalCookie(): boolean {
    try {
      return /(?:^|;\s*)MUSIC_U=[^;\s]+/.test(fs.readFileSync(this.cookieFile(), 'utf8'));
    } catch {
      return false; // 文件不存在 / 无权限：视为未登录
    }
  }

  cookieBytes(): number {
    try {
      return fs.readFileSync(this.cookieFile()).length;
    } catch {
      return 0;
    }
  }

  // 校验登录态：网关可用 → login/status（服务端读磁盘 Cookie）；否则仅本地文件判断
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
        vipType: inner.profile?.vipType != null ? Number(inner.profile.vipType) : undefined,
        cookieBytes: bytes,
        serverOk: true,
      };
    } catch {
      // 网关在但状态接口失败：按未登录返回（cookieBytes 仍如实报告）
      return { loggedIn: false, cookieBytes: bytes, serverOk: true };
    }
  }

  async saveCookie(raw: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const cookie = raw.trim();
    if (!/(?:^|;\s*)MUSIC_U=[^;\s]+/.test(cookie) || /[\r\n]/.test(cookie)) {
      throw new Error(t('auth.cookieMissingMusicU'));
    }
    const ok = await this.server.ensure();
    if (!ok) throw new Error(this.server.lastError || t('auth.gatewayNotReady'));
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

  // —— 扫码（UI 在 QrLoginModal）——
  async beginQr(): Promise<{ key: string; qrimg: string }> {
    const ok = await this.server.ensure();
    if (!ok) throw new Error(this.server.lastError || t('auth.gatewayNotReadyCannotLogin'));
    const key = await this.client.qrKey();
    const { qrimg } = await this.client.qrCreate(key);
    return { key, qrimg };
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
        vipType: inner.profile?.vipType != null ? Number(inner.profile.vipType) : undefined,
        cookieBytes: this.cookieBytes(),
        serverOk: true,
      },
    };
  }
}
