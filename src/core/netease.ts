// 统一网易云入口：网页会话（渲染进程 requestUrl 直连）优先，网关（Cookie 通道）兜底。
// 对外方法与 ServerClient 同构，queue / engine / import 无需感知路由细节。
import { ServerClient, SongUrlResult } from './server-client';
import { WebClient } from './web-client';
import type { NeteaseAlbumResponse, NeteaseSearchResponse } from './api-types';
import { t } from './i18n';

export class NeteaseService {
  constructor(
    private web: WebClient,
    private gateway: ServerClient,
    private ensureGateway: () => Promise<boolean>,
    private gatewayError: () => string
  ) {}

  private async ensureGatewayReady(): Promise<void> {
    const ok = await this.ensureGateway();
    if (!ok) throw new Error(this.gatewayError() || t('auth.gatewayNotReadyNetease'));
  }

  async album(id: number): Promise<NeteaseAlbumResponse> {
    if (await this.web.isLoggedIn()) {
      try {
        return await this.web.album(id);
      } catch {
        // 网页会话通道失败 → 落到下面的网关兜底
      }
    }
    await this.ensureGatewayReady();
    return this.gateway.album(id);
  }

  async songUrl(id: number, level: string): Promise<SongUrlResult> {
    if (await this.web.isLoggedIn()) {
      try {
        return await this.web.songUrl(id, level);
      } catch {
        // 网页会话通道失败 → 落到下面的网关兜底
      }
    }
    await this.ensureGatewayReady();
    return this.gateway.songUrl(id, level);
  }

  async searchAlbums(keywords: string): Promise<NeteaseSearchResponse> {
    if (await this.web.isLoggedIn()) {
      try {
        return await this.web.searchAlbums(keywords);
      } catch {
        // 网页会话通道失败 → 落到下面的网关兜底
      }
    }
    await this.ensureGatewayReady();
    return this.gateway.searchAlbums(keywords);
  }

  async searchSongs(keywords: string): Promise<NeteaseSearchResponse> {
    if (await this.web.isLoggedIn()) {
      try {
        return await this.web.searchSongs(keywords);
      } catch {
        // 网页会话通道失败 → 落到下面的网关兜底
      }
    }
    await this.ensureGatewayReady();
    return this.gateway.searchSongs(keywords);
  }

  async fetchCover(url: string): Promise<ArrayBuffer> {
    await this.ensureGatewayReady();
    return this.gateway.fetchCover(url);
  }
}
