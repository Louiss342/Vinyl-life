// 统一网易云入口：网页会话（渲染进程 requestUrl 直连）优先，网关（Cookie 通道）兜底。
// 对外方法与 ServerClient 同构，queue / engine / import 无需感知路由细节。
import { ServerClient, SongUrlResult } from './server-client';
import { WebClient } from './web-client';

export class NeteaseService {
  constructor(
    private web: WebClient,
    private gateway: ServerClient,
    private ensureGateway: () => Promise<boolean>,
    private gatewayError: () => string
  ) {}

  private async ensureGatewayReady(): Promise<void> {
    const ok = await this.ensureGateway();
    if (!ok) throw new Error(this.gatewayError() || '网易云网关未就绪');
  }

  async album(id: number): Promise<any> {
    if (await this.web.isLoggedIn()) {
      try {
        return await this.web.album(id);
      } catch (e) {
        console.warn('[vinyl] 网页直连获取专辑失败，回退网关', e);
      }
    }
    await this.ensureGatewayReady();
    return this.gateway.album(id);
  }

  async songUrl(id: number, level: string): Promise<SongUrlResult> {
    if (await this.web.isLoggedIn()) {
      try {
        return await this.web.songUrl(id, level);
      } catch (e) {
        console.warn('[vinyl] 网页直连获取音源失败，回退网关', e);
      }
    }
    await this.ensureGatewayReady();
    return this.gateway.songUrl(id, level);
  }

  async searchAlbum(keywords: string): Promise<any> {
    await this.ensureGatewayReady();
    return this.gateway.searchAlbum(keywords);
  }

  async fetchCover(url: string): Promise<ArrayBuffer> {
    await this.ensureGatewayReady();
    return this.gateway.fetchCover(url);
  }
}
