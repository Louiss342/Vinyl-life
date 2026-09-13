// 黑胶交接动效（M3，方案 5.8）：IDLE → HANDOFF → PLAYING 状态机
// 不做跨视图物理飞行（多 pane 不可靠且耗电）：
//   墙上「拾取 + 离墙淡出」（WAAPI，420ms）+ 播放器「落盘淡入」（视图内入场动画）两段拼接。
// 时间线（v0.3.1 修订：方向改为从封套右侧开口抽出，时长 700ms，缓动 easeOutCubic）：
//   A 拾取 0–370ms    唱片从封面右侧探出位向右抽出 + 轻微放大（现实中从开口抽出、拿起）
//   B 离墙 370–700ms  继续右上方离场 + 缩小 + 淡出
//   C 落盘 ~700ms+    播放器出现/聚焦，唱片滑入转盘（VinylPlayerView.playEntrance）
//   D 出声 与 C 并行   地址解析完成即 play()
// 播放中墙上唱片持续隐藏（is-playing 类，CSS 值与动画终点一致）；
// 换专辑时 cancel 冻结动画，唱片经 CSS transition 优雅滑回封套。
import type VinylLifePlugin from '../main';
import type { AlbumInfo } from '../core/album-index';
import { discTransform } from '../core/disc-motion';

export type HandoffState = 'idle' | 'handoff' | 'playing';

const LIFT_OFF_MS = 700;

export class HandoffController {
  private state: HandoffState = 'idle';

  constructor(private plugin: VinylLifePlugin) {}

  getState(): HandoffState {
    return this.state;
  }

  /**
   * 点击黑胶 → 交接。cardEl 为墙上卡片（含 .vinyl-shelf-disc），传 null 时跳过墙上动画（自检用）。
   * 返回最终状态（playing = 队列已加载并开始播放 / 落盘待命）。
   */
  async handoff(album: AlbumInfo, cardEl: HTMLElement | null): Promise<HandoffState> {
    if (this.state === 'handoff') return this.state; // 防重入
    this.state = 'handoff';

    // A 拾取 + B 离墙（墙上动画，与解析/开窗并行）
    const discEl = cardEl
      ? (cardEl.querySelector('.vinyl-shelf-disc') as HTMLElement | null)
      : null;
    if (cardEl && discEl) {
      cardEl.addClass('is-handing-off');
      // 关键帧取 CSS 变量（--vinyl-disc-{rest,lift,off}）：
      //   终点与 CSS 隐藏态（.is-playing .vinyl-shelf-disc）同源，播放中由 fill:forwards 保持；
      //   换专辑时 shelf-view cancel 后由 transition 回位；方向随「黑胶动画方向」设置变化。
      const lift = discEl.animate(
        [
          // A 拾取（0–370ms）：从探出位抽出 + 轻微放大 + 摆正
          {
            transform: discTransform(discEl, 'rest'),
            opacity: '1',
            offset: 0,
          },
          {
            transform: discTransform(discEl, 'lift'),
            opacity: '1',
            offset: 0.53,
          },
          // B 离墙（370–700ms）：继续离场 + 缩小 + 淡出
          {
            transform: discTransform(discEl, 'off'),
            opacity: '0',
            offset: 1,
          },
        ],
        {
          duration: LIFT_OFF_MS,
          easing: 'cubic-bezier(0.33, 1, 0.68, 1)',
          fill: 'forwards',
        }
      );
      lift.addEventListener('finish', () => cardEl.removeClass('is-handing-off'));
      // 挂在卡片上：渲染刷新时随 DOM 一起消亡，无需手动回收
      (cardEl as any).__vinylLift = lift;
    }

    // C 落盘前：先打开/聚焦播放器（未打开时先 revealLeaf）
    try {
      await this.plugin.openPlayer();
    } catch (_) {}

    // D 出声（并行于 C 的入场动画）：解析队列 + 播放
    let ok = false;
    try {
      const res = await this.plugin.engine.loadAlbum(album);
      ok = res.tracks.length > 0;
    } catch (e) {
      console.error('[vinyl] handoff loadAlbum 异常', e);
      ok = false;
    }

    if (ok) {
      this.state = 'playing';
    } else {
      // 失败回落：取消墙上动画，唱片归位（CSS transition 平滑回位）
      this.state = 'idle';
      if (discEl) discEl.getAnimations().forEach((a) => a.cancel());
      if (cardEl) cardEl.removeClass('is-handing-off');
    }
    return this.state;
  }
}
