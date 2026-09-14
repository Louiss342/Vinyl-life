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
  al?: { name?: string; picUrl?: string };
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

export interface SearchAlbumResponse {
  result?: unknown;
}

export interface ApiErrorResponse {
  error?: string;
}
