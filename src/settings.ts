// 设置面板：四个标签页 —— 通用（路径 / 播放 / 播放器 / 播放统计）、
// 外观（专辑墙 / 播放器）、源（外来源 / 本地源）、关于（版本 / 作者手记 / 许可）。
// 卡片属性不在设置页出现：专辑墙工具栏「卡片属性」直接维护 shelfProps。
import { App, PluginSettingTab, Setting } from 'obsidian';
import type VinylLifePlugin from './main';
import { QrLoginModal, qqQrProvider } from './views/qr-login-modal';
import { WebLoginModal, qqWebProvider } from './views/web-login-modal';
import { StatsModal } from './views/stats-modal';
import { DiscDirection, DISC_DIRECTIONS, SpinSpeed, SPIN_SPEEDS } from './core/disc-motion';
import { notice } from './util';
import { Lang, LANGUAGES, t, tf } from './core/i18n';
import { EMPTY_STATS, VinylStats, ensureStats } from './core/stats';
import { DEFAULT_SHELF_PROPS } from './core/shelf-props';
import { ABOUT_TEXT, ABOUT_TEXT_EN, REPO_URL } from './core/about';
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
  /** 界面语言（默认中文；主要覆盖专辑墙文案） */
  language: Lang;
  /** 本地专辑笔记模板文件（vault 相对路径；空 = 内置模板） */
  albumNoteTemplate: string;
  coverFolder: string;
  audioFolder: string;
  /** 本地音频导入落库模式 */
  importMode: 'copy' | 'link';
  defaultSource: 'auto' | 'local' | 'netease' | 'qq';
  quality: 'standard' | 'higher' | 'exhigh' | 'lossless';
  /** 加载队列后立即播放（交接后即“落盘即播”） */
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
  /** 每张专辑记住自己的自定义队列顺序（专辑笔记路径 → trackKey 顺序）。
   *  只影响「下次播这张专辑时的排列」，不是「重启后恢复整条队列」 */
  queueOrder: Record<string, string[]>;
  /** 调试命令（通用标签页）：打开后命令面板才注册登录 / 退出这类维护命令
   *  （设置页里的按钮已覆盖其余日常操作）。默认关闭 —— 日常只需要那几条常用命令；
   *  改开关后需重载插件生效 */
  debugCommands: boolean;
}

export const DEFAULT_SETTINGS: VinylSettings = {
  albumFolder: 'Vinyl Life/Vinyl Note',
  language: 'zh',
  albumNoteTemplate: '',
  coverFolder: 'Vinyl Life/covers',
  audioFolder: 'Vinyl Life/audio',
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
  queueOrder: {},
  debugCommands: false,
};

/** data.json → queueOrder。脏数据一律丢弃：非对象容器 / 非数组值 / 数组里的非字符串项；
 *  返回全新对象（不与 DEFAULT_SETTINGS 共享引用，防就地改写污染默认值）。 */
export function normalizeQueueOrder(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [albumPath, keys] of Object.entries(raw as Record<string, unknown>)) {
    if (!albumPath || !Array.isArray(keys)) continue;
    const clean = keys.filter((k): k is string => typeof k === 'string' && !!k);
    if (clean.length) out[albumPath] = clean; // 空顺序 = 没存过，不留空壳
  }
  return out;
}

type TabKey = 'general' | 'appearance' | 'source' | 'about';

// 用函数而不是常量：语言在设置里切换后，标题要跟着变（常量在模块加载时就定型了）
const tabs = (): [TabKey, string][] => [
  ['general', t('settings.tab.general')],
  ['appearance', t('settings.tab.appearance')],
  ['source', t('settings.tab.source')],
  ['about', t('settings.tab.about')],
];

const columnOptions = (): [number, string][] => [
  [2, tf('settings.columnsN', { n: 2 })],
  [3, tf('settings.columnsN', { n: 3 })],
  [4, tf('settings.columnsN', { n: 4 })],
  [5, tf('settings.columnsN', { n: 5 })],
  [6, tf('settings.columnsN', { n: 6 })],
  [7, tf('settings.columnsN', { n: 7 })],
];

const discOptions = (): [DiscDirection, string][] => [
  ['right', t('settings.discRight')],
  ['left', t('settings.discLeft')],
  ['up', t('settings.discUp')],
  ['down', t('settings.discDown')],
];

// 配色下拉的显示名（core/appearance 的标签只服务于默认语言，这里按语言查表）
const DECK_LABEL_KEYS: Record<DeckStyle, string> = {
  walnut: 'settings.deckWalnut',
  black: 'settings.deckBlack',
};

const RECORD_LABEL_KEYS: Record<RecordColor, string> = {
  black: 'settings.recordBlack',
  yellow: 'settings.recordYellow',
  blue: 'settings.recordBlue',
  white: 'settings.recordWhite',
};

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
    else if (this.tab === 'about') this.renderAbout(body);
    else await this.renderSource(body);
  }

  private renderTabs(parent: HTMLElement) {
    const row = parent.createDiv({ cls: 'vinyl-settings-tabs' });
    for (const [key, label] of tabs()) {
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
    this.section(c, t('settings.section.general'));
    new Setting(c)
      .setName(t('settings.language'))
      .setDesc(t('settings.languageDesc'))
      .addDropdown((d) => {
        for (const l of LANGUAGES) d.addOption(l.value, l.label);
        d.setValue(this.plugin.settings.language);
        d.onChange(async (v) => {
          this.plugin.settings.language = v === 'en' ? 'en' : 'zh';
          await this.plugin.saveSettings();
          this.plugin.refreshLanguage();
          this.display(); // 设置面板自身立即按新语言重绘（否则要重开标签页才变）
        });
      });
    // 维护类命令（登录 / 退出）默认不注册。
    // 注册发生在 onload → 改完开关重载插件（或重开 Obsidian）才生效，描述里已写明。
    new Setting(c)
      .setName(t('settings.debugCommands'))
      .setDesc(t('settings.debugCommandsDesc'))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.debugCommands).onChange(async (v) => {
          this.plugin.settings.debugCommands = v;
          await this.plugin.saveSettings();
        })
      );

    this.section(c, t('settings.path'));
    new Setting(c)
      .setName(t('settings.albumFolder'))
      .setDesc(t('settings.albumFolderDesc'))
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
      .setName(t('settings.coverFolder'))
      .setDesc(t('settings.coverFolderDesc'))
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.coverFolder)
          .setValue(this.plugin.settings.coverFolder)
          .onChange(async (v) => {
            this.plugin.settings.coverFolder = v.trim() || DEFAULT_SETTINGS.coverFolder;
            await this.plugin.saveSettings();
          })
      );

    this.section(c, t('settings.template'));
    new Setting(c)
      .setName(t('settings.albumTemplate'))
      .setDesc(t('settings.albumTemplateDesc'))
      .addText((txt) =>
        txt
          .setPlaceholder(t('settings.albumTemplatePlaceholder'))
          .setValue(this.plugin.settings.albumNoteTemplate)
          .onChange(async (v) => {
            this.plugin.settings.albumNoteTemplate = v.trim();
            await this.plugin.saveSettings();
          })
      )
      // 原「创建专辑模板文件」命令的落点：写一份可编辑模板并回填上面的路径
      .addButton((b) =>
        b.setButtonText(t('settings.generateTemplate')).onClick(async () => {
          await this.plugin.createAlbumTemplate();
          this.display(); // 路径已被回填，重绘让输入框显示新值
        })
      );

    this.section(c, t('settings.section.playback'));
    new Setting(c)
      .setName(t('settings.defaultSource'))
      .setDesc(t('settings.defaultSourceDesc'))
      .addDropdown((d) =>
        d
          .addOption('auto', t('settings.sourceAuto'))
          .addOption('local', t('settings.sourceLocal'))
          .addOption('netease', t('settings.sourceNetease'))
          .addOption('qq', t('settings.sourceQq'))
          .setValue(this.plugin.settings.defaultSource)
          .onChange(async (v) => {
            this.plugin.settings.defaultSource = v as VinylSettings['defaultSource'];
            await this.plugin.saveSettings();
          })
      );
    new Setting(c)
      .setName(t('settings.quality'))
      .setDesc(t('settings.qualityDesc'))
      .addDropdown((d) =>
        d
          .addOption('standard', t('settings.qualityStandard'))
          .addOption('higher', t('settings.qualityHigher'))
          .addOption('exhigh', t('settings.qualityExhigh'))
          .addOption('lossless', t('settings.qualityLossless'))
          .setValue(this.plugin.settings.quality)
          .onChange(async (v) => {
            this.plugin.settings.quality = v as VinylSettings['quality'];
            await this.plugin.saveSettings();
          })
      );
    new Setting(c)
      .setName(t('settings.autoPlay'))
      .setDesc(t('settings.autoPlayDesc'))
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoPlay).onChange(async (v) => {
          this.plugin.settings.autoPlay = v;
          await this.plugin.saveSettings();
        })
      );

    this.section(c, t('settings.section.player'));
    new Setting(c)
      .setName(t('settings.playerLocation'))
      .setDesc(t('settings.playerLocationDesc'))
      .addDropdown((d) =>
        d
          .addOption('sidebar', t('settings.locSidebar'))
          .addOption('tab', t('settings.locTab'))
          .addOption('window', t('settings.locWindow'))
          .setValue(this.plugin.settings.playerLocation)
          .onChange(async (v) => {
            this.plugin.settings.playerLocation = v as VinylSettings['playerLocation'];
            await this.plugin.saveSettings();
          })
      );

    this.section(c, t('settings.section.stats'));
    const stats = this.plugin.settings.stats;
    new Setting(c)
      .setName(t('settings.statsTotal'))
      .setDesc(
        tf('settings.statsDesc', {
          plays: stats.totalPlays,
          albums: Object.keys(stats.albums).length,
          tracks: Object.keys(stats.tracks).length,
        })
      )
      // 原「显示播放统计」命令的落点：弹窗查看每张专辑 / 每首曲目的明细
      .addButton((b) =>
        b.setButtonText(t('settings.viewStats')).onClick(() => {
          new StatsModal(this.app, this.plugin.settings.stats).open();
        })
      )
      .addButton((b) =>
        b
          .setButtonText(t('settings.clearStats'))
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
    this.section(c, t('settings.section.shelf'));
    new Setting(c)
      .setName(t('settings.columns'))
      .setDesc(t('settings.columnsDesc'))
      .addDropdown((d) => {
        d.addOption('auto', t('settings.columnsAuto'));
        for (const [n, label] of columnOptions()) d.addOption(String(n), label);
        d.setValue(String(this.plugin.settings.shelfColumns)).onChange(async (v) => {
          this.plugin.settings.shelfColumns =
            v === 'auto' ? 'auto' : Number(v) || DEFAULT_SETTINGS.shelfColumns;
          await this.plugin.saveSettings();
          this.plugin.refreshAppearance();
        });
      });
    new Setting(c)
      .setName(t('settings.discDirection'))
      .setDesc(t('settings.discDirectionDesc'))
      .addDropdown((d) => {
        for (const [key, label] of discOptions()) d.addOption(key, label);
        d.setValue(this.plugin.settings.discDirection).onChange(async (v) => {
          const dir = DISC_DIRECTIONS.includes(v as DiscDirection)
            ? (v as DiscDirection)
            : DEFAULT_SETTINGS.discDirection;
          this.plugin.settings.discDirection = dir;
          await this.plugin.saveSettings();
          this.plugin.refreshAppearance();
        });
      });

    this.section(c, t('settings.section.vinyl'));
    new Setting(c)
      .setName(t('settings.recordColor'))
      .setDesc(t('settings.recordColorDesc'))
      .addDropdown((d) => {
        for (const [key] of RECORD_COLORS) d.addOption(key, t(RECORD_LABEL_KEYS[key]));
        d.setValue(this.plugin.settings.recordColor).onChange(async (v) => {
          this.plugin.settings.recordColor = normalizeRecordColor(v);
          await this.plugin.saveSettings();
          this.plugin.refreshAppearance();
        });
      });

    this.section(c, t('settings.section.player'));
    new Setting(c)
      .setName(t('settings.deck'))
      .setDesc(t('settings.deckDesc'))
      .addDropdown((d) => {
        for (const [key] of DECK_STYLES) d.addOption(key, t(DECK_LABEL_KEYS[key]));
        d.setValue(this.plugin.settings.playerDeck).onChange(async (v) => {
          this.plugin.settings.playerDeck = normalizeDeckStyle(v);
          await this.plugin.saveSettings();
          this.plugin.refreshAppearance();
        });
      });
    new Setting(c)
      .setName(t('settings.spinSpeed'))
      .setDesc(t('settings.spinSpeedDesc'))
      .addDropdown((d) => {
        d.addOption('slow', t('settings.spinSlow'));
        d.addOption('normal', t('settings.spinNormal'));
        d.addOption('fast', t('settings.spinFast'));
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
    this.section(c, t('settings.section.external'));

    this.sub(c, t('settings.sub.netease'));
    const neteaseStatus = c.createDiv({ cls: 'vinyl-auth-status' });
    let neteaseRefresh = 0;
    const refreshNetease = async () => {
      const request = ++neteaseRefresh;
      neteaseStatus.empty();
      neteaseStatus.createSpan({ text: t('settings.checkingLogin'), cls: 'vinyl-muted' });
      let st;
      try {
        st = await this.plugin.auth.getStatus();
      } catch (e) {
        if (request !== neteaseRefresh) return;
        neteaseStatus.empty();
        neteaseStatus.createSpan({ text: tf('settings.checkFailed', { msg: (e as Error).message }), cls: 'vinyl-muted' });
        return;
      }
      if (request !== neteaseRefresh) return;
      neteaseStatus.empty();
      neteaseStatus.createSpan({
        text: st.loggedIn
          ? tf('settings.statusLoggedIn', { name: st.nick || t('settings.loggedIn'), id: st.userId ?? '' }) +
            (st.vipType === 11 ? ' · VIP' : '')
          : st.cookieBytes > 0
            ? t('settings.cookieInvalid')
            : t('settings.notLoggedIn'),
      });
      neteaseStatus.createSpan({
        text: st.loggedIn ? `Cookie ${(st.cookieBytes / 1024).toFixed(1)} KB` : st.serverOk ? t('settings.gatewayOk') : t('settings.gatewayDown'),
        cls: 'vinyl-muted',
      });
    };
    new Setting(c)
      .setName(t('settings.qrLogin'))
      .setDesc(t('settings.qrLoginDescNetease'))
      .addButton((b) =>
        b.setButtonText(t('settings.qrLogin')).onClick(() => {
          new QrLoginModal(this.app, {
            server: this.plugin.server,
            auth: this.plugin.auth,
          }, { onLogin: refreshNetease }).open();
        })
      );
    new Setting(c)
      .setName(t('settings.webLogin'))
      .setDesc(t('settings.webLoginDescNetease'))
      .addButton((b) =>
        b.setButtonText(t('settings.webLogin')).onClick(() => {
          new WebLoginModal(this.app, {
            auth: this.plugin.auth,
            browserLogin: this.plugin.browserLogin,
            onLogin: refreshNetease,
          }).open();
        })
      );
    new Setting(c)
      .setName(t('settings.logout'))
      .setDesc(t('settings.logoutDescNetease'))
      .addButton((b) =>
        b
          .setButtonText(t('settings.logoutAction'))
          .setWarning()
          .onClick(async () => {
            this.plugin.browserLogin.cancel();
            await this.plugin.auth.clear();
            notice(t('notice.neteaseLoggedOut'));
            await refreshNetease();
          })
      );
    this.sub(c, t('settings.sub.qq'));
    const qqStatus = c.createDiv({ cls: 'vinyl-auth-status' });
    let qqRefresh = 0;
    const refreshQq = async () => {
      const request = ++qqRefresh;
      qqStatus.empty();
      qqStatus.createSpan({ text: t('settings.checkingLogin'), cls: 'vinyl-muted' });
      let st;
      try {
        st = await this.plugin.qqAuth.getStatus();
      } catch (e) {
        if (request !== qqRefresh) return;
        qqStatus.empty();
        qqStatus.createSpan({ text: tf('settings.checkFailed', { msg: (e as Error).message }), cls: 'vinyl-muted' });
        return;
      }
      if (request !== qqRefresh) return;
      qqStatus.empty();
      qqStatus.createSpan({
        text: st.loggedIn
          ? tf('settings.statusLoggedInQq', { name: st.nick || t('settings.loggedIn'), id: st.userId ?? '' })
          : st.cookieBytes > 0
            ? t('settings.cookieInvalid')
            : t('settings.notLoggedIn'),
      });
      qqStatus.createSpan({
        text: st.loggedIn ? `Cookie ${(st.cookieBytes / 1024).toFixed(1)} KB` : st.serverOk ? t('settings.gatewayOk') : t('settings.gatewayDown'),
        cls: 'vinyl-muted',
      });
    };
    new Setting(c)
      .setName(t('settings.qrLogin'))
      .setDesc(t('settings.qrLoginDescQq'))
      .addButton((b) =>
        b.setButtonText(t('settings.qrLogin')).onClick(() => {
          new QrLoginModal(
            this.app,
            { server: this.plugin.server, auth: this.plugin.qqAuth },
            { provider: qqQrProvider(), onLogin: refreshQq }
          ).open();
        })
      );
    new Setting(c)
      .setName(t('settings.webLogin'))
      .setDesc(t('settings.webLoginDescQq'))
      .addButton((b) =>
        b.setButtonText(t('settings.webLogin')).onClick(() => {
          new WebLoginModal(this.app, {
            auth: this.plugin.qqAuth,
            browserLogin: this.plugin.qqBrowserLogin,
            provider: qqWebProvider(),
            onLogin: refreshQq,
          }).open();
        })
      );
    new Setting(c)
      .setName(t('settings.logout'))
      .setDesc(t('settings.logoutDescQq'))
      .addButton((b) =>
        b
          .setButtonText(t('settings.logoutAction'))
          .setWarning()
          .onClick(async () => {
            this.plugin.qqBrowserLogin.cancel();
            await this.plugin.qqAuth.clear();
            notice(t('notice.qqLoggedOut'));
            await refreshQq();
          })
      );
    // 两个平台并行检测，先完整渲染设置项，再更新状态，避免一个慢源阻塞另一个。
    await Promise.all([refreshNetease(), refreshQq()]);

    this.sub(c, t('settings.sub.runtime'));
    new Setting(c)
      .setName('Node.js')
      .setDesc(
        this.plugin.server.nodeBinary
          ? this.plugin.server.nodeBinary
          : t('settings.nodeMissing')
      )
      .addButton((b) =>
        b.setButtonText(t('settings.redetect')).onClick(async () => {
          b.setButtonText(t('settings.detecting')).setDisabled(true);
          this.plugin.server.nodeBinary = await this.plugin.server.resolveNodeBinary();
          this.display();
        })
      );

    this.section(c, t('settings.section.local'));
    new Setting(c)
      .setName(t('settings.audioFolder'))
      .setDesc(t('settings.audioFolderDesc'))
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
      .setName(t('settings.importMode'))
      .setDesc(t('settings.importModeDesc'))
      .addDropdown((d) =>
        d
          .addOption('copy', t('settings.importCopy'))
          .addOption('link', t('settings.importLink'))
          .setValue(this.plugin.settings.importMode)
          .onChange(async (v) => {
            this.plugin.settings.importMode = v as VinylSettings['importMode'];
            await this.plugin.saveSettings();
          })
      );
  }

  // ============ 关于：版本 / 作者手记 / 许可 ============

  private renderAbout(c: HTMLElement) {
    const about = c.createDiv({ cls: 'vinyl-about' });

    const head = about.createDiv({ cls: 'vinyl-about-title' });
    head.createSpan({ text: 'Vinyl Life' }); // 产品名不翻译
    head.createSpan({
      text: tf('settings.aboutVersion', { v: this.plugin.manifest.version }),
      cls: 'vinyl-about-version',
    });

    // 作者手记：原文常量（core/about.ts），逐字照录、不走 i18n。
    // pre-wrap 保住换行与首行行尾空格；text 设的是 textContent，原样进 DOM 不做裁剪。
    about.createDiv({ text: ABOUT_TEXT, cls: 'vinyl-about-text' });

    // 英译紧跟在中文正文下方（中文在上、英文在下）：两份都是原文常量，不随语言开关切换。
    // 版式差异交给 vinyl-about-text-en（字号略小、颜色偏淡），读起来是「译文」而非第二段正文。
    about.createDiv({ text: ABOUT_TEXT_EN, cls: 'vinyl-about-text-en' });

    const meta = about.createDiv({ cls: 'vinyl-about-meta' });
    meta.createSpan({ text: t('settings.aboutLicense') });
    meta.createSpan({ text: ' · ' });
    meta.createEl('a', {
      text: 'GitHub',
      href: REPO_URL,
      attr: { target: '_blank', rel: 'noopener' },
    });
  }
}
