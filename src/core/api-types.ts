export interface AccountProfile {
  nickname?: string;
  userId?: number | string;
  vipType?: number | string;
}

export interface AccountInfo {
  id?: number | string;
}

export interface LoginPayload {
  profile?: AccountProfile;
  account?: AccountInfo;
}

export interface LoginResponse extends LoginPayload {
  code?: number | string;
  data?: LoginPayload;
}

export interface QrKeyResponse {
  data?: { unikey?: string; qrimg?: string; qrurl?: string };
}

export interface NeteaseArtist {
  name?: string;
}

export interface NeteaseSong {
  id?: number | string;
  name?: string;
  ar?: NeteaseArtist[];
  al?: { id?: number | string; name?: string; picUrl?: string; publishTime?: number | string };
  dt?: number | string;
}

export interface NeteaseAlbumResponse {
  code?: number | string;
  album?: {
    name?: string;
    artist?: NeteaseArtist;
    publishTime?: number | string;
    picUrl?: string;
  };
  songs?: NeteaseSong[];
}

export interface SongUrlData {
  url?: string;
  br?: number;
  type?: string;
  level?: string;
  code?: number | string;
  msg?: string;
}

export interface SongUrlResponse {
  data?: SongUrlData[];
}

export interface QqSong {
  mid?: string;
  mediaMid?: string;
  name?: string;
  artist?: string;
  albumName?: string;
  cover?: string;
  interval?: number | string;
  pay?: number | string;
  trial?: boolean;
}

export interface QqAlbumResponse {
  code?: number | string;
  msg?: string;
  data?: {
    album?: {
      name?: string;
      artist?: string;
      publishTime?: string;
      coverUrl?: string;
      trackCount?: number;
    };
    songs?: QqSong[];
  };
}

export interface NeteaseSearchAlbum {
  id?: number | string;
  name?: string;
  artist?: NeteaseArtist;
  artists?: NeteaseArtist[];
  picUrl?: string;
  publishTime?: number | string;
  size?: number | string;
  status?: number | string;
  copyrightId?: number | string;
  available?: boolean;
}

export interface NeteaseSearchSong extends NeteaseSong {
  status?: number | string;
  copyrightId?: number | string;
  available?: boolean;
  artists?: NeteaseArtist[];
  album?: {
    id?: number | string;
    name?: string;
    picUrl?: string;
    publishTime?: number | string;
  };
}

export interface NeteaseSearchResponse {
  code?: number | string;
  result?: {
    albums?: NeteaseSearchAlbum[];
    songs?: NeteaseSearchSong[];
  };
}

/** 搜索结果的一页：要多少条（limit）、从第几条开始（offset，网易云用；QQ 那边换算成页码，见 album-discovery）。
 *  搜索页会一直往深处要（「加载更多」），所以翻页参数得穿过整条链路，不能在某一层写死。 */
export interface SearchPage {
  limit: number;
  offset: number;
}

export interface QqSearchAlbum {
  mid?: string;
  name?: string;
  artist?: string;
  coverUrl?: string;
  publishTime?: string;
  trackCount?: number;
  available?: boolean;
}

export interface QqSearchSong {
  mid?: string;
  name?: string;
  artist?: string;
  albumMid?: string;
  albumName?: string;
  albumCover?: string;
  available?: boolean;
}

export interface QqSearchResponse {
  code?: number | string;
  requiresLogin?: boolean;
  data?: {
    albums?: QqSearchAlbum[];
    songs?: QqSearchSong[];
  };
}

// ============ 酷狗（网关 /api/kugou/* 归一化后的形态） ============

export interface KugouSong {
  /** 音频 hash（小写 32 位十六进制） */
  id?: string;
  hash?: string;
  name?: string;
  artist?: string;
  albumName?: string;
  albumId?: string;
  /** mixsongid：取流必须与 hash 一起给 */
  albumAudioId?: string;
  duration?: number | string;
  cover?: string;
  pay?: number | string;
  trial?: boolean;
}

export interface KugouAlbum {
  id?: string;
  name?: string;
  artist?: string;
  songCount?: number | string;
  publishDate?: string;
  cover?: string;
}

export interface KugouSearchResponse {
  ok?: boolean;
  albums?: KugouAlbum[];
  songs?: KugouSong[];
}

export interface KugouAlbumResponse {
  code?: number | string;
  data?: {
    album?: KugouAlbum;
    songs?: KugouSong[];
  };
}

export interface ApiErrorResponse {
  error?: string;
}
