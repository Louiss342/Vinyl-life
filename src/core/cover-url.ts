// 封面候选链（纯函数，无依赖）：库内封面 → 曲目远程封面 → QQ 图床备用主机。
// 背景：网易云的封面地址由接口直给（p*.music.126.net），QQ 的却是按固定模式拼出来的
// （y.gtimg.cn/music/photo_new/T002R300x300M000<专辑mid>.jpg）。有用户报告部分网络
// （DNS 拦截 / 系统代理 / IPv6 路由）下 y.gtimg.cn 不可达 —— 所以「只有 QQ 出问题」。
// 同一路径在 y.qq.com 上可达且是同一张图，于是下载（import.ts）与播放（player-view）
// 统一按候选列表依次回退：单点故障不再等于封面消失。

/** 备用图床（主机名互相回退；只对 /music/photo_new/ 下的 QQ 封面生效） */
const QQ_COVER_MIRROR: Record<string, string> = {
  'y.gtimg.cn': 'y.qq.com',
  'y.qq.com': 'y.gtimg.cn',
};

/** 远程封面 → 候选地址：主地址在前，备用图床在后；不认识的地址原样单个返回 */
export function coverCandidates(raw: string | undefined): string[] {
  const url = String(raw || '').trim();
  if (!url) return [];
  const m = /^(https?:\/\/)([^/]+)(\/music\/photo_new\/.+)$/i.exec(url);
  const alt = m ? QQ_COVER_MIRROR[m[2].toLowerCase()] : undefined;
  return m && alt ? [url, `${m[1]}${alt}${m[3]}`] : [url];
}

/** 可显示的封面候选链：库内封面（离线可用）→ 曲目远程封面 → 备用图床。
 *  色值（专辑墙的占位底色，如 #222）不是图片不能当 src；空值与重复项也去掉。 */
export function coverChain(local: string | undefined, remote: string | undefined): string[] {
  const out: string[] = [];
  const push = (v: string | undefined) => {
    const s = String(v || '').trim();
    if (!s || /^#[0-9a-fA-F]{3,8}$/.test(s) || out.includes(s)) return;
    out.push(s);
  };
  push(local);
  push(remote);
  for (const u of coverCandidates(remote)) push(u);
  return out;
}
