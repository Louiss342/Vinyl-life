// 专辑 → 源站地址。卡片右键菜单与命令「在源站打开」共用同一条 URL 规则
//（此前三个平台的地址各自硬编码在 shelf-view 的菜单项里，只有鼠标那一条路到得了）。
// 纯函数、不碰宿主：真正打开由调用方做（window.open / 壳里的 shell.openExternal）。
import type { AlbumInfo } from './album-index';

export type OnlineSource = 'netease' | 'qq' | 'kugou';

export interface SourceLink {
  source: OnlineSource;
  /** 菜单 / 提示用的 i18n 键（文案集中在词典里，这里只给键） */
  labelKey: string;
  url: string;
}

/** 这张专辑能去哪几个源站（顺序 = 界面里的呈现顺序：网易云 → QQ 音乐 → 酷狗音乐）。
 *  没有关联任何在线音源时返回空数组 —— 调用方按「无处可去」处理，别拼一个半截地址出来。 */
export function albumSourceLinks(
  album: Pick<AlbumInfo, 'neteaseId' | 'qqId' | 'kugouId'>
): SourceLink[] {
  const out: SourceLink[] = [];
  if (album.neteaseId) {
    out.push({
      source: 'netease',
      labelKey: 'menu.openNetease',
      url: `https://music.163.com/#/album?id=${album.neteaseId}`,
    });
  }
  if (album.qqId) {
    out.push({
      source: 'qq',
      labelKey: 'menu.openQq',
      url: `https://y.qq.com/n/ryqq/albumDetail/${album.qqId}`,
    });
  }
  if (album.kugouId) {
    out.push({
      source: 'kugou',
      labelKey: 'menu.openKugou',
      url: `https://www.kugou.com/yy/album/single/${album.kugouId}.html`,
    });
  }
  return out;
}
