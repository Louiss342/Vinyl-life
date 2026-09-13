// 登录态与 Cookie 管理（方案 5.5，M0 V4 已验证链路）：
//   扫码 803 → 网关验证后落盘 .cookie；官方登录窗口 + Mineradio 迁移 + 手动粘贴。
//   凭据仅存本机插件目录，不进笔记/日志/git。
import { Plugin } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { ServerManager } from './server-manager';
import { ServerClient } from './server-client';
import { writeCredentialFile } from './credential-file';
import { pluginAbsPath } from '../util';

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
    } catch (_) {
      return false;
    }
  }

  cookieBytes(): number {
    try {
      return fs.readFileSync(this.cookieFile()).length;
    } catch (_) {
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
    } catch (_) {
      return { loggedIn: false, cookieBytes: bytes, serverOk: true };
    }
  }

  async saveCookie(raw: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const cookie = raw.trim();
    if (!/(?:^|;\s*)MUSIC_U=[^;\s]+/.test(cookie) || /[\r\n]/.test(cookie)) {
      throw new Error('Cookie 缺少有效的 MUSIC_U');
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
    } catch (_) {}
    // 网关不可用时直接删本地文件（网关按请求从磁盘读 Cookie，两路等价）
    try {
      fs.unlinkSync(this.cookieFile());
    } catch (_) {}
  }

  // —— Mineradio Cookie 迁移（本机已登录时最稳，M0 实测识别 VIP 账号）——
  findMineradioCookie(): string | null {
    const candidates = [
      path.join(process.env.APPDATA || '', 'mineradio/.cookie'),
      path.join(process.env.USERPROFILE || '', 'AppData/Roaming/mineradio/.cookie'),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch (_) {}
    }
    return null;
  }

  async migrateMineradio(): Promise<{ ok: boolean; detail: string }> {
    const src = this.findMineradioCookie();
    if (!src) return { ok: false, detail: '未找到 %APPDATA%/mineradio/.cookie' };
    const raw = fs.readFileSync(src, 'utf8').trim();
    if (!raw) return { ok: false, detail: 'Mineradio Cookie 文件为空' };
    const parsed = raw.startsWith('{') ? JSON.parse(raw) : { cookie: raw };
    const cookie = parsed.cookie || raw;
    try {
      await this.saveCookie(String(cookie));
    } catch (e) {
      return { ok: false, detail: `Cookie 写入失败：${(e as Error).message}` };
    }
    const st = await this.getStatus();
    return st.loggedIn
      ? { ok: true, detail: `已迁移并验证登录：${st.nick}（${st.userId}）` }
      : { ok: false, detail: 'Cookie 已写入但登录态无效（可能已过期）' };
  }

  // —— 扫码（UI 在 QrLoginModal）——
  async beginQr(): Promise<{ key: string; qrimg: string }> {
    const ok = await this.server.ensure();
    if (!ok) throw new Error(this.server.lastError || '网关未就绪，无法登录');
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
