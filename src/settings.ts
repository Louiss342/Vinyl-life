// 设置面板（M6 改版）：三个标签页 —— 通用（路径 / 播放 / 播放器 / 播放统计）、
// 外观（专辑墙 / 播放器）、源（外来源 / 本地源）。
// 卡片属性不在设置页出现：专辑墙工具栏「卡片属性」直接维护 shelfProps。
import { App, PluginSettingTab, Setting } from 'obsidian';
import type VinylLifePlugin from './main';
import { QrLoginModal, QQ_QR_PROVIDER } from './views/qr-login-modal';
import { WebLoginModal, QQ_WEB } from './views/web-login-modal';
import { DiscDirection, DISC_DIRECTIONS, SpinSpeed, SPIN_SPEEDS } from './core/disc-motion';
import { notice } from './util';
import { EMPTY_STATS, VinylStats, ensureStats } from './core/stats';
import { DEFAULT_SHELF_PROPS } from './core/shelf-props';
import {
  DeckStyle,
  RecordColor,
  DECK_STYLES,
  RECORD_COLORS,
  normalizeDeckStyle,
  normalizeRecordColor,
} from './core/appearance';

/** 专辑墙每行卡片数：'auto' = 随面板宽度自适应 */
export type ShelfColumns = 'auto' | number;

export interface VinylSettings {
  albumFolder: string;
  coverFolder: string;
  audioFolder: string;
  /** 本地音频导入落库模式 */
  importMode: 'copy' | 'link';
  defaultSource: 'auto' | 'local' | 'netease' | 'qq';
  quality: 'standard' | 'higher' | 'exhigh' | 'lossless';
  /** 加载队列后立即播放（M3 交接后即“落盘即播”） */
  autoPlay: boolean;
  playerLocation: 'sidebar' | 'tab' | 'window';
  /** 播放器面板配色（外观标签页）：胡桃木 / 黑胶黑 */
  playerDeck: DeckStyle;
  /** 黑胶唱片配色（外观标签页）：专辑墙卡片与播放器转盘同时生效 */
  recordColor: RecordColor;
  /** 专辑墙每行卡片数（外观标签页） */
  shelfColumns: ShelfColumns;
  /** 专辑墙黑胶唱片弹出方向（外观标签页） */
  discDirection: DiscDirection;
  /** 播放器转盘转速（外观标签页） */
  turntableSpeed: SpinSpeed;
  /** 专辑墙卡片显示的属性键（专辑墙工具栏「卡片属性」维护；顺序即显示顺序）。
   *  对应专辑笔记 frontmatter 的键名。只读语义：永远整表替换（变更走 shelf-props 的 toggle/reorder helper） */
  shelfProps: string[];
  /** 卡片属性显示名覆写（frontmatter 键 → 名称）；空 = 用预设别名 / 键名兜底 */
  shelfPropLabels: Record<string, string>;
  /** 播放统计（次数/最近播放，仅存本插件 data.json，不写笔记） */
  stats: VinylStats;
}

export const DEFAULT_SETTINGS: VinylSettings = {
  albumFolder: '06-专辑墙/专辑',
  coverFolder: '06-专辑墙/covers',
  audioFolder: '06-专辑墙/audio',
  importMode: 'copy',
  defaultSource: 'auto',
  quality: 'higher',
  autoPlay: true,
  playerLocation: 'sidebar',
  playerDeck: 'walnut',
  recordColor: 'black',
  shelfColumns: 'auto',
  discDirection: 'right',
  turntableSpeed: 'normal',
  shelfProps: [...DEFAULT_SHELF_PROPS],
  shelfPropLabels: {},
  stats: EMPTY_STATS,
};

type TabKey = 'general' | 'appearance' | 'source';

const TABS: [TabKey, string][] = [
  ['general', '通用'],
  ['appearance', '外观'],
  ['source', '源'],
];

const COLUMN_OPTIONS: [number, string][] = [
  [2, '2 张'],
  [3, '3 张'],
  [4, '4 张'],
  [5, '5 张'],
  [6, '6 张'],
  [7, '7 张'],
];

const DISC_OPTIONS: [DiscDirection, string][] = [
  ['right', '向右'],
  ['left', '向左'],
  ['up', '向上'],
  ['down', '向下'],
];

export class VinylSettingTab extends PluginSettingTab {
  plugin: VinylLifePlugin;
  private tab: TabKey = 'general';

  constructor(app: App, plugin: VinylLifePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('vinyl-settings');
    this.renderTabs(containerEl);
    const body = containerEl.createDiv({ cls: 'vinyl-settings-body' });
    if (this.tab === 'general') this.renderGeneral(body);
    else if (this.tab === 'appearance') this.renderAppearance(body);
    else await this.renderSource(body);
  }

  private renderTabs(parent: HTMLElement) {
    const row = parent.createDiv({ cls: 'vinyl-settings-tabs' });
    for (const [key, label] of TABS) {
      const btn = row.createEl('button', { text: label, cls: 'vinyl-settings-tab' });
      if (key === this.tab) btn.addClass('is-active');
      btn.addEventListener('click', () => {
        if (this.tab === key) return;
        this.tab = key;
        this.display();
      });
    }
  }

  // 板块标题 / 子板块标题
  private section(parent: HTMLElement, title: string) {
    new Setting(parent).setName(title).setHeading();
  }

  private sub(parent: HTMLElement, title: string) {
    parent.createDiv({ text: title, cls: 'vinyl-settings-sub' });
  }

  // ============ 通用：路径 / 播放 / 播放器 / 播放统计 ============

  private renderGeneral(c: HTMLElement) {
    this.section(c, '路径');
    new Setting(c)
      .setName('专辑文件夹')
      .setDesc('专辑笔记所在目录（tags: [album]）')
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.albumFolder)
          .setValue(this.plugin.settings.albumFolder)
          .onChange(async (v) => {
            this.plugin.settings.albumFolder = v.trim() || DEFAULT_SETTINGS.albumFolder;
            await this.plugin.saveSettings();
          })
      );
    new Setting(c)
      .setName('封面目录')
      .setDesc('导入专辑时封面落盘位置')
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.coverFolder)
          .setValue(this.plugin.settings.coverFolder)
          .onChange(async (v) => {
            this.plugin.settings.coverFolder = v.trim() || DEFAULT_SETTINGS.coverFolder;
            await this.plugin.saveSettings();
          })
      );

    this.section(c, '播放');
    new Setting(c)
      .setName('默认音源')
      .setDesc('笔记里的 source 字段优先')
      .addDropdown((d) =>
        d
          .addOption('auto', '自动（本地优先）')
          .addOption('local', '仅本地')
          .addOption('netease', '仅网易云')
          .addOption('qq', '仅 QQ 音乐')
          .setValue(this.plugin.settings.defaultSource)
          .onChange(async (v) => {
            this.plugin.settings.defaultSource = v as VinylSettings['defaultSource'];
            await this.plugin.saveSettings();
          })
      );
    new Setting(c)
      .setName('在线音源音质')
      .setDesc('本地音频按原文件播放；无损需对应平台会员')
      .addDropdown((d) =>
        d
          .addOption('standard', '标准')
          .addOption('higher', '较高（默认）')
          .addOption('exhigh', '极高')
          .addOption('lossless', '无损')
          .setValue(this.plugin.settings.quality)
          .onChange(async (v) => {
            this.plugin.settings.quality = v as VinylSettings['quality'];
            await this.plugin.saveSettings();
          })
      );
    new Setting(c)
      .setName('自动播放')
      .setDesc('队列就绪后立即播放')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoPlay).onChange(async (v) => {
          this.plugin.settings.autoPlay = v;
          await this.plugin.saveSettings();
        })
      );

    this.section(c, '播放器');
    new Setting(c)
      .setName('默认位置')
      .setDesc('打开播放器时的落位')
      .addDropdown((d) =>
        d
          .addOption('sidebar', '侧栏')
          .addOption('tab', '主区标签页')
          .addOption('window', '独立窗口')
          .setValue(this.plugin.settings.playerLocation)
          .onChange(async (v) => {
            this.plugin.settings.playerLocation = v as VinylSettings['playerLocation'];
            await this.plugin.saveSettings();
          })
      );

    this.section(c, '播放统计');
    const stats = this.plugin.settings.stats;
    new Setting(c)
      .setName('累计播放')
      .setDesc(
        `${stats.totalPlays} 次 · ${Object.keys(stats.albums).length} 张专辑 · ${
          Object.keys(stats.tracks).length
        } 首曲目（存插件 data.json）`
      )
      .addButton((b) =>
        b
          .setButtonText('清除统计')
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.stats = ensureStats(null);
            await this.plugin.saveSettings();
            this.display();
          })
      );
  }

  // ============ 外观：专辑墙 / 播放器 ============

  private renderAppearance(c: HTMLElement) {
    this.section(c, '专辑墙');
    new Setting(c)
      .setName('每行专辑数量')
      .setDesc('自动＝随面板宽度')
      .addDropdown((d) => {
        d.addOption('auto', '自动');
        for (const [n, label] of COLUMN_OPTIONS) d.addOption(String(n), label);
        d.setValue(String(this.plugin.settings.shelfColumns)).onChange(async (v) => {
          this.plugin.settings.shelfColumns =
            v === 'auto' ? 'auto' : Number(v) || DEFAULT_SETTINGS.shelfColumns;
          await this.plugin.saveSettings();
          this.plugin.refreshAppearance();
        });
      });
    new Setting(c)
      .setName('黑胶动画方向')
      .setDesc('悬停时唱片从封面弹出的一侧')
      .addDropdown((d) => {
        for (const [key, label] of DISC_OPTIONS) d.addOption(key, label);
        d.setValue(this.plugin.settings.discDirection).onChange(async (v) => {
          const dir = DISC_DIRECTIONS.includes(v as DiscDirection)
            ? (v as DiscDirection)
            : DEFAULT_SETTINGS.discDirection;
          this.plugin.settings.discDirection = dir;
          await this.plugin.saveSettings();
          this.plugin.refreshAppearance();
        });
      });

    this.section(c, '黑胶唱片');
    new Setting(c)
      .setName('唱片配色')
      .setDesc('专辑墙卡片与播放器转盘同时生效')
      .addDropdown((d) => {
        for (const [key, label] of RECORD_COLORS) d.addOption(key, label);
        d.setValue(this.plugin.settings.recordColor).onChange(async (v) => {
          this.plugin.settings.recordColor = normalizeRecordColor(v);
          await this.plugin.saveSettings();
          this.plugin.refreshAppearance();
        });
      });

    this.section(c, '播放器');
    new Setting(c)
      .setName('播放器配色')
      .setDesc('设备面板材质')
      .addDropdown((d) => {
        for (const [key, label] of DECK_STYLES) d.addOption(key, label);
        d.setValue(this.plugin.settings.playerDeck).onChange(async (v) => {
          this.plugin.settings.playerDeck = normalizeDeckStyle(v);
          await this.plugin.saveSettings();
          this.plugin.refreshAppearance();
        });
      });
    new Setting(c)
      .setName('转盘转速')
      .setDesc('播放时唱片一圈的时间')
      .addDropdown((d) => {
        d.addOption('slow', '慢');
        d.addOption('normal', '标准（默认）');
        d.addOption('fast', '快');
        d.setValue(this.plugin.settings.turntableSpeed).onChange(async (v) => {
          const speed = Object.keys(SPIN_SPEEDS).includes(v) ? (v as SpinSpeed) : 'normal';
          this.plugin.settings.turntableSpeed = speed;
          await this.plugin.saveSettings();
          this.plugin.refreshAppearance();
        });
      });
  }

  // ============ 源：外来源（网易云 / QQ 音乐 / 运行环境）/ 本地源 ============

  private async renderSource(c: HTMLElement) {
    this.section(c, '外来源');

    this.sub(c, '网易云');
    const neteaseStatus = c.createDiv({ cls: 'vinyl-auth-status' });
    let neteaseRefresh = 0;
    const refreshNetease = async () => {
      const request = ++neteaseRefresh;
      neteaseStatus.empty();
      neteaseStatus.createSpan({ text: '检测登录态…', cls: 'vinyl-muted' });
      let st;
      try {
        st = await this.plugin.auth.getStatus();
      } catch (e) {
        if (request !== neteaseRefresh) return;
        neteaseStatus.empty();
        neteaseStatus.createSpan({ text: `登录态检测失败：${(e as Error).message}`, cls: 'vinyl-muted' });
        return;
      }
      if (request !== neteaseRefresh) return;
      neteaseStatus.empty();
      neteaseStatus.createSpan({
        text: st.loggedIn
          ? `✅ ${st.nick || '已登录'}（${st.userId ?? ''}）${st.vipType === 11 ? ' · VIP' : ''}`
          : st.cookieBytes > 0
            ? '❌ Cookie 已失效，请重新登录'
            : '未登录',
      });
      neteaseStatus.createSpan({
        text: st.loggedIn ? `Cookie ${(st.cookieBytes / 1024).toFixed(1)} KB` : st.serverOk ? '网关正常' : '网关未运行',
        cls: 'vinyl-muted',
      });
    };
    new Setting(c)
      .setName('扫码登录')
      .setDesc('手机网易云 App 扫码授权')
      .addButton((b) =>
        b.setButtonText('扫码登录').onClick(() => {
          new QrLoginModal(this.app, {
            server: this.plugin.server,
            auth: this.plugin.auth,
          }, { onLogin: refreshNetease }).open();
        })
      );
    new Setting(c)
      .setName('浏览器登录')
      .setDesc('独立窗口登录 music.163.com')
      .addButton((b) =>
        b.setButtonText('浏览器登录').onClick(() => {
          new WebLoginModal(this.app, {
            auth: this.plugin.auth,
            browserLogin: this.plugin.browserLogin,
            onLogin: refreshNetease,
          }).open();
        })
      );
    new Setting(c)
      .setName('退出登录')
      .setDesc('清除本机 Cookie（.cookie）')
      .addButton((b) =>
        b
          .setButtonText('退出')
          .setWarning()
          .onClick(async () => {
            this.plugin.browserLogin.cancel();
            await this.plugin.auth.clear();
            notice('已退出网易云登录');
            await refreshNetease();
          })
      );
    this.sub(c, 'QQ 音乐');
    const qqStatus = c.createDiv({ cls: 'vinyl-auth-status' });
    let qqRefresh = 0;
    const refreshQq = async () => {
      const request = ++qqRefresh;
      qqStatus.empty();
      qqStatus.createSpan({ text: '检测登录态…', cls: 'vinyl-muted' });
      let st;
      try {
        st = await this.plugin.qqAuth.getStatus();
      } catch (e) {
        if (request !== qqRefresh) return;
        qqStatus.empty();
        qqStatus.createSpan({ text: `登录态检测失败：${(e as Error).message}`, cls: 'vinyl-muted' });
        return;
      }
      if (request !== qqRefresh) return;
      qqStatus.empty();
      qqStatus.createSpan({
        text: st.loggedIn
          ? `✅ ${st.nick || '已登录'}（QQ ${st.userId ?? ''}）`
          : st.cookieBytes > 0
            ? '❌ Cookie 已失效，请重新登录'
            : '未登录',
      });
      qqStatus.createSpan({
        text: st.loggedIn ? `Cookie ${(st.cookieBytes / 1024).toFixed(1)} KB` : st.serverOk ? '网关正常' : '网关未运行',
        cls: 'vinyl-muted',
      });
    };
    new Setting(c)
      .setName('扫码登录')
      .setDesc('手机 QQ 扫码授权')
      .addButton((b) =>
        b.setButtonText('扫码登录').onClick(() => {
          new QrLoginModal(
            this.app,
            { server: this.plugin.server, auth: this.plugin.qqAuth },
            { provider: QQ_QR_PROVIDER, onLogin: refreshQq }
          ).open();
        })
      );
    new Setting(c)
      .setName('浏览器登录')
      .setDesc('独立窗口登录 y.qq.com')
      .addButton((b) =>
        b.setButtonText('浏览器登录').onClick(() => {
          new WebLoginModal(this.app, {
            auth: this.plugin.qqAuth,
            browserLogin: this.plugin.qqBrowserLogin,
            provider: QQ_WEB,
            onLogin: refreshQq,
          }).open();
        })
      );
    new Setting(c)
      .setName('退出登录')
      .setDesc('清除本机 Cookie（.qq-cookie）')
      .addButton((b) =>
        b
          .setButtonText('退出')
          .setWarning()
          .onClick(async () => {
            this.plugin.qqBrowserLogin.cancel();
            await this.plugin.qqAuth.clear();
            notice('已退出 QQ 音乐登录');
            await refreshQq();
          })
      );
    // 两个平台并行检测，先完整渲染设置项，再更新状态，避免一个慢源阻塞另一个。
    await Promise.all([refreshNetease(), refreshQq()]);

    this.sub(c, '运行环境');
    new Setting(c)
      .setName('Node.js')
      .setDesc(
        this.plugin.server.nodeBinary
          ? this.plugin.server.nodeBinary
          : '未探测（在线音源首次使用时自动探测；未安装则仅本地源可用）'
      )
      .addButton((b) =>
        b.setButtonText('重新探测').onClick(async () => {
          b.setButtonText('探测中…').setDisabled(true);
          this.plugin.server.nodeBinary = await this.plugin.server.resolveNodeBinary();
          this.display();
        })
      );

    this.section(c, '本地源');
    new Setting(c)
      .setName('音频根目录')
      .setDesc('复制入库时落到 <根目录>/<专辑名>/')
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.audioFolder)
          .setValue(this.plugin.settings.audioFolder)
          .onChange(async (v) => {
            this.plugin.settings.audioFolder = v.trim() || DEFAULT_SETTINGS.audioFolder;
            await this.plugin.saveSettings();
          })
      );
    new Setting(c)
      .setName('落库模式')
      .setDesc('复制进 vault（可随库同步），或仅记录外链绝对路径')
      .addDropdown((d) =>
        d
          .addOption('copy', '复制进 vault')
          .addOption('link', '外链绝对路径')
          .setValue(this.plugin.settings.importMode)
          .onChange(async (v) => {
            this.plugin.settings.importMode = v as VinylSettings['importMode'];
            await this.plugin.saveSettings();
          })
      );
  }
}
