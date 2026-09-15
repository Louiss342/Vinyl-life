// 设置面板：自绘标签页（通用 / 外观 / 源 / 关于），布局照设计稿
// Excalidraw/Drawing 2026-09-15 15.58.24：一行标签 + 右侧「Vinyl Life」+ 下方整块面板。
//
// 为什么不用 1.13 的声明式 API（getSettingDefinitions）：它渲染的是「分页列表 → 子页 + 返回键」，
// 做不出浏览器标签页那种「点谁就地换内容」。官方文档把话说死了：getSettingDefinitions() 一旦
// 返回非空数组，display() 就不会被调用 —— 两条路只能二选一。取舍的代价是本插件的设置不再进
// Obsidian 的全局设置搜索（自绘面板的插件都如此），约定与理由见 CONTRIBUTING.md。
//
// 切标签 = 清空内容区重画：不预建四份再藏起来 ——「关于」页的手绘框要按真实尺寸画，
// 藏起来的元素量出来是 0。语言 / 取值变了走 render()：整面板重建，仍停在当前标签页。
import { App, PluginSettingTab, Setting } from 'obsidian';
import type VinylLifePlugin from './main';
import { QrLoginModal, qqQrProvider } from './views/qr-login-modal';
import { StatsModal } from './views/stats-modal';
import { attachAboutInk, renderAboutPage } from './views/about-page';
import { DiscDirection, DISC_DIRECTIONS, SpinSpeed, SPIN_SPEEDS } from './core/disc-motion';
import { notice } from './util';
import { Lang, LANGUAGES, t, tf } from './core/i18n';
import { EMPTY_STATS, VinylStats, ensureStats } from './core/stats';
import type { PlayMode } from './core/player-state';
import { DEFAULT_SHELF_PROPS } from './core/shelf-props';
import type { LoginState } from './core/auth';
import {
  DeckStyle,
  RecordColor,
  DECK_STYLES,
  RECORD_COLORS,
  normalizeDeckStyle,
  normalizeRecordColor,
} from './core/appearance';

/** 四个标签页：顺序即标签条顺序，key 是页名键（进 i18n 词典，中英各一份） */
export const SETTINGS_TABS = [
  { id: 'general', key: 'settings.tab.general' },
  { id: 'appearance', key: 'settings.tab.appearance' },
  { id: 'source', key: 'settings.tab.source' },
  { id: 'about', key: 'settings.tab.about' },
] as const;

type TabId = (typeof SETTINGS_TABS)[number]['id'];

/** 上次播放位置（重启后恢复用） */
export interface LastPlayback {
  albumPath: string;
  trackKey: string;
  positionSec: number;
}

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
  /** 播放器面板配色（外观页）：胡桃木 / 贝壳白 / 哑光黑 */
  playerDeck: DeckStyle;
  /** 黑胶唱片配色（外观页）：专辑墙卡片与播放器转盘同时生效 */
  recordColor: RecordColor;
  /** 专辑墙每行卡片数（外观页） */
  shelfColumns: ShelfColumns;
  /** 专辑墙黑胶唱片弹出方向（外观页） */
  discDirection: DiscDirection;
  /** 播放器转盘转速（外观页） */
  turntableSpeed: SpinSpeed;
  /** 专辑墙卡片显示的属性键（专辑墙工具栏「卡片属性」维护；顺序即显示顺序）。
   *  对应专辑笔记 frontmatter 的键名。只读语义：永远整表替换（变更走 shelf-props 的 toggle/reorder helper） */
  shelfProps: string[];
  /** 卡片属性显示名覆写（frontmatter 键 → 名称）；空 = 用预设别名 / 键名兜底 */
  shelfPropLabels: Record<string, string>;
  /** 播放器音量（0–1）；上次用的音量，重启后沿用 */
  volume: number;
  /** 上次播放位置：重启后恢复队列并停在原处（不自动播放）；笔记被删则忽略 */
  lastPlayback?: LastPlayback;
  /** 专辑队列模式（播放器顶部开关，默认关）：开着时点专辑墙上的专辑是「排到队尾」而不是换碟 */
  queueMode: boolean;
  /** 播放模式（播放器顶部按钮，默认单次）：单次 / 循环 / 随机；队列模式下作用于整条列表 */
  playMode: PlayMode;
  /** 播放统计（次数/最近播放，仅存本插件 data.json，不写笔记） */
  stats: VinylStats;
  /** 每张专辑记住自己的自定义队列顺序（专辑笔记路径 → trackKey 顺序）。
   *  只影响「下次播这张专辑时的排列」，不是「重启后恢复整条队列」 */
  queueOrder: Record<string, string[]>;
  /** 调试命令（通用页）：打开后命令面板才注册登录 / 退出这类维护命令
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
  volume: 0.8,
  queueMode: false,
  playMode: 'once',
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

/** data.json → lastPlayback。脏数据一律丢弃（缺字段 / 类型不对 / 负数位置）；没有有效记录返回 undefined。 */
export function normalizeLastPlayback(raw: unknown): LastPlayback | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const j = raw as Record<string, unknown>;
  const albumPath = typeof j.albumPath === 'string' ? j.albumPath.trim() : '';
  const trackKey = typeof j.trackKey === 'string' ? j.trackKey.trim() : '';
  const rawPos = typeof j.positionSec === 'number' && isFinite(j.positionSec) ? j.positionSec : 0;
  if (!albumPath || !trackKey) return undefined;
  return { albumPath, trackKey, positionSec: Math.max(0, Math.floor(rawPos)) };
}

/** 播放模式归一：只认三个合法值（data.json 可能被手改或来自旧版本） */
export function normalizePlayMode(raw: unknown): PlayMode {
  return raw === 'loop' || raw === 'shuffle' ? raw : 'once';
}

/** 音量归一：非数字 / 越界一律回落默认（data.json 可能被手改） */
export function normalizeVolume(raw: unknown): number {
  return typeof raw === 'number' && isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_SETTINGS.volume;
}

/** 一行设置：标题 + 说明 + 控件。自绘面板没有声明式 API 那套搜索索引，
 *  这里的 name/desc 只管显示（写法与 1.13 的声明式定义保持一致，便于对照）。 */
const row = (parent: HTMLElement, name: string, desc: string, build: (s: Setting) => void): void => {
  const s = new Setting(parent).setName(name);
  if (desc) s.setDesc(desc);
  build(s);
};

/** 分组小标题：走 Setting.setHeading（Obsidian 审核要求，别自己建 h2/h3） */
const heading = (parent: HTMLElement, text: string): void => {
  new Setting(parent).setName(text).setHeading();
};

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
  shell: 'settings.deckShell',
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
  /** 当前标签页：切标签 / 重绘后仍停在这一页 */
  private activeTab: TabId = 'general';
  // 登录状态行的当前元素：回填时写这一份（重绘会换新元素，旧的自然作废）
  private neteaseStatusEl: HTMLElement | null = null;
  private qqStatusEl: HTMLElement | null = null;
  // 同一平台可能有多次并发检测（渲染 / 登录回调 / 退出），只认最后一次
  private neteaseRefresh = 0;
  private qqRefresh = 0;
  // 「关于」页手绘笔触的停止函数：重绘 / 关闭面板时要断开 ResizeObserver
  private aboutInkStop: (() => void) | null = null;

  constructor(app: App, plugin: VinylLifePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.containerEl.addClass('vinyl-settings');
    this.render();
  }

  hide(): void {
    this.stopAboutInk();
    super.hide();
  }

  /** 整面板重绘：标签条与内容区一起重建，仍停在当前标签页 */
  private render(): void {
    const { containerEl } = this;
    this.stopAboutInk();
    containerEl.empty();
    this.buildTabStrip(containerEl);
    const body = containerEl.createDiv({ cls: 'vinyl-settings-body' });
    switch (this.activeTab) {
      case 'appearance':
        this.renderAppearanceTab(body);
        break;
      case 'source':
        this.renderSourceTab(body);
        break;
      case 'about':
        this.renderAboutTab(body);
        break;
      default:
        this.renderGeneralTab(body);
    }
  }

  /** 标签条 + 右上角产品名（照设计稿：标签一行靠左，标题靠右）。
   *  用 <button> 而不是 div：键盘可聚焦、回车 / 空格即切换，不用自己补键盘处理。 */
  private buildTabStrip(containerEl: HTMLElement): void {
    const head = containerEl.createDiv({ cls: 'vinyl-settings-head' });
    const nav = head.createEl('nav', { cls: 'vinyl-settings-tabs' });
    for (const tab of SETTINGS_TABS) {
      const isActive = tab.id === this.activeTab;
      const btn = nav.createEl('button', {
        cls: `vinyl-settings-tab${isActive ? ' is-active' : ''}`,
        text: t(tab.key),
        // aria-current 让读屏软件报出「当前」；active 只是外观
        attr: { type: 'button', 'aria-current': isActive ? 'true' : 'false' },
      });
      btn.onclick = () => this.switchTab(tab.id);
    }
    head.createDiv({ cls: 'vinyl-settings-title', text: 'Vinyl Life' }); // 产品名不翻译
  }

  private switchTab(id: TabId): void {
    if (this.activeTab === id) return;
    this.activeTab = id;
    this.render();
  }

  private stopAboutInk(): void {
    this.aboutInkStop?.();
    this.aboutInkStop = null;
  }

  // ============ 通用：语言 / 维护 / 路径 / 模板 / 播放 / 播放器 / 统计 ============

  private renderGeneralTab(el: HTMLElement): void {
    const p = this.plugin;
    row(el, t('settings.language'), t('settings.languageDesc'), (s) =>
      s.addDropdown((d) => {
        for (const l of LANGUAGES) d.addOption(l.value, l.label);
        d.setValue(p.settings.language);
        d.onChange(async (v) => {
          p.settings.language = v === 'en' ? 'en' : 'zh';
          await p.saveSettings();
          p.refreshLanguage();
          // 改完语言整面板重绘（否则要重开设置才变）
          this.render();
        });
      })
    );
    // 维护类命令（登录 / 退出）默认不注册。
    // 注册发生在 onload → 改完开关重载插件（或重开 Obsidian）才生效，描述里已写明。
    row(el, t('settings.debugCommands'), t('settings.debugCommandsDesc'), (s) =>
      s.addToggle((tg) =>
        tg.setValue(p.settings.debugCommands).onChange(async (v) => {
          p.settings.debugCommands = v;
          await p.saveSettings();
        })
      )
    );

    heading(el, t('settings.path'));
    row(el, t('settings.albumFolder'), t('settings.albumFolderDesc'), (s) =>
      s.addText((txt) =>
        txt
          .setPlaceholder(DEFAULT_SETTINGS.albumFolder)
          .setValue(p.settings.albumFolder)
          .onChange(async (v) => {
            p.settings.albumFolder = v.trim() || DEFAULT_SETTINGS.albumFolder;
            await p.saveSettings();
          })
      )
    );
    row(el, t('settings.coverFolder'), t('settings.coverFolderDesc'), (s) =>
      s.addText((txt) =>
        txt
          .setPlaceholder(DEFAULT_SETTINGS.coverFolder)
          .setValue(p.settings.coverFolder)
          .onChange(async (v) => {
            p.settings.coverFolder = v.trim() || DEFAULT_SETTINGS.coverFolder;
            await p.saveSettings();
          })
      )
    );

    heading(el, t('settings.template'));
    row(el, t('settings.albumTemplate'), t('settings.albumTemplateDesc'), (s) =>
      s
        .addText((txt) =>
          txt
            .setPlaceholder(t('settings.albumTemplatePlaceholder'))
            .setValue(p.settings.albumNoteTemplate)
            .onChange(async (v) => {
              p.settings.albumNoteTemplate = v.trim();
              await p.saveSettings();
            })
        )
        // 原「创建专辑模板文件」命令的落点：写一份可编辑模板并回填上面的路径
        .addButton((b) =>
          b.setButtonText(t('settings.generateTemplate')).onClick(async () => {
            await p.createAlbumTemplate();
            this.render(); // 路径已被回填，重绘让输入框显示新值
          })
        )
    );

    heading(el, t('settings.section.playback'));
    row(el, t('settings.defaultSource'), t('settings.defaultSourceDesc'), (s) =>
      s.addDropdown((d) =>
        d
          .addOption('auto', t('settings.sourceAuto'))
          .addOption('local', t('settings.sourceLocal'))
          .addOption('netease', t('settings.sourceNetease'))
          .addOption('qq', t('settings.sourceQq'))
          .setValue(p.settings.defaultSource)
          .onChange(async (v) => {
            p.settings.defaultSource = v as VinylSettings['defaultSource'];
            await p.saveSettings();
          })
      )
    );
    row(el, t('settings.quality'), t('settings.qualityDesc'), (s) =>
      s.addDropdown((d) =>
        d
          .addOption('standard', t('settings.qualityStandard'))
          .addOption('higher', t('settings.qualityHigher'))
          .addOption('exhigh', t('settings.qualityExhigh'))
          .addOption('lossless', t('settings.qualityLossless'))
          .setValue(p.settings.quality)
          .onChange(async (v) => {
            p.settings.quality = v as VinylSettings['quality'];
            await p.saveSettings();
          })
      )
    );
    row(el, t('settings.autoPlay'), t('settings.autoPlayDesc'), (s) =>
      s.addToggle((tg) =>
        tg.setValue(p.settings.autoPlay).onChange(async (v) => {
          p.settings.autoPlay = v;
          await p.saveSettings();
        })
      )
    );

    heading(el, t('settings.section.player'));
    row(el, t('settings.playerLocation'), t('settings.playerLocationDesc'), (s) =>
      s.addDropdown((d) =>
        d
          .addOption('sidebar', t('settings.locSidebar'))
          .addOption('tab', t('settings.locTab'))
          .addOption('window', t('settings.locWindow'))
          .setValue(p.settings.playerLocation)
          .onChange(async (v) => {
            p.settings.playerLocation = v as VinylSettings['playerLocation'];
            await p.saveSettings();
          })
      )
    );

    heading(el, t('settings.section.stats'));
    row(
      el,
      t('settings.statsTotal'),
      tf('settings.statsDesc', {
        plays: p.settings.stats.totalPlays,
        albums: Object.keys(p.settings.stats.albums).length,
        tracks: Object.keys(p.settings.stats.tracks).length,
      }),
      (s) =>
        s
          // 原「显示播放统计」命令的落点：弹窗查看每张专辑 / 每首曲目的明细
          .addButton((b) =>
            b.setButtonText(t('settings.viewStats')).onClick(() => {
              new StatsModal(this.app, p.settings.stats).open();
            })
          )
          .addButton((b) =>
            b
              .setButtonText(t('settings.clearStats'))
              .setDestructive()
              .onClick(async () => {
                p.settings.stats = ensureStats(null);
                await p.saveSettings();
                this.render();
              })
          )
    );
  }

  // ============ 外观：专辑墙 / 黑胶唱片 / 播放器 ============

  private renderAppearanceTab(el: HTMLElement): void {
    const p = this.plugin;
    heading(el, t('settings.section.shelf'));
    row(el, t('settings.columns'), t('settings.columnsDesc'), (s) =>
      s.addDropdown((d) => {
        d.addOption('auto', t('settings.columnsAuto'));
        for (const [n, label] of columnOptions()) d.addOption(String(n), label);
        d.setValue(String(p.settings.shelfColumns)).onChange(async (v) => {
          p.settings.shelfColumns =
            v === 'auto' ? 'auto' : Number(v) || DEFAULT_SETTINGS.shelfColumns;
          await p.saveSettings();
          p.refreshAppearance();
        });
      })
    );
    row(el, t('settings.discDirection'), t('settings.discDirectionDesc'), (s) =>
      s.addDropdown((d) => {
        for (const [key, label] of discOptions()) d.addOption(key, label);
        d.setValue(p.settings.discDirection).onChange(async (v) => {
          const dir = DISC_DIRECTIONS.includes(v as DiscDirection)
            ? (v as DiscDirection)
            : DEFAULT_SETTINGS.discDirection;
          p.settings.discDirection = dir;
          await p.saveSettings();
          p.refreshAppearance();
        });
      })
    );

    heading(el, t('settings.section.vinyl'));
    row(el, t('settings.recordColor'), t('settings.recordColorDesc'), (s) =>
      s.addDropdown((d) => {
        for (const key of RECORD_COLORS) d.addOption(key, t(RECORD_LABEL_KEYS[key]));
        d.setValue(p.settings.recordColor).onChange(async (v) => {
          p.settings.recordColor = normalizeRecordColor(v);
          await p.saveSettings();
          p.refreshAppearance();
        });
      })
    );

    heading(el, t('settings.section.player'));
    row(el, t('settings.deck'), t('settings.deckDesc'), (s) =>
      s.addDropdown((d) => {
        for (const key of DECK_STYLES) d.addOption(key, t(DECK_LABEL_KEYS[key]));
        d.setValue(p.settings.playerDeck).onChange(async (v) => {
          p.settings.playerDeck = normalizeDeckStyle(v);
          await p.saveSettings();
          p.refreshAppearance();
        });
      })
    );
    row(el, t('settings.spinSpeed'), t('settings.spinSpeedDesc'), (s) =>
      s.addDropdown((d) => {
        d.addOption('slow', t('settings.spinSlow'));
        d.addOption('normal', t('settings.spinNormal'));
        d.addOption('fast', t('settings.spinFast'));
        d.setValue(p.settings.turntableSpeed).onChange(async (v) => {
          const speed = Object.keys(SPIN_SPEEDS).includes(v) ? (v as SpinSpeed) : 'normal';
          p.settings.turntableSpeed = speed;
          await p.saveSettings();
          p.refreshAppearance();
        });
      })
    );
  }

  // ============ 源：网易云 / QQ 音乐 / 本地源 ============

  private renderSourceTab(el: HTMLElement): void {
    const p = this.plugin;
    heading(el, t('settings.sub.netease'));
    this.statusRow(el, 'netease');
    row(el, t('settings.qrLogin'), t('settings.qrLoginDescNetease'), (s) =>
      s.addButton((b) =>
        b.setButtonText(t('settings.qrLogin')).onClick(() => {
          new QrLoginModal(
            this.app,
            { server: p.server, auth: p.auth },
            { onLogin: () => void this.refreshNetease() }
          ).open();
        })
      )
    );
    row(el, t('settings.logout'), t('settings.logoutDescNetease'), (s) =>
      s.addButton((b) =>
        b
          .setButtonText(t('settings.logoutAction'))
          .setDestructive()
          .onClick(async () => {
            await p.auth.clear();
            notice(t('notice.neteaseLoggedOut'));
            await this.refreshNetease();
          })
      )
    );

    heading(el, t('settings.sub.qq'));
    this.statusRow(el, 'qq');
    row(el, t('settings.qrLogin'), t('settings.qrLoginDescQq'), (s) =>
      s.addButton((b) =>
        b.setButtonText(t('settings.qrLogin')).onClick(() => {
          new QrLoginModal(
            this.app,
            { server: p.server, auth: p.qqAuth },
            { provider: qqQrProvider(), onLogin: () => void this.refreshQq() }
          ).open();
        })
      )
    );
    row(el, t('settings.logout'), t('settings.logoutDescQq'), (s) =>
      s.addButton((b) =>
        b
          .setButtonText(t('settings.logoutAction'))
          .setDestructive()
          .onClick(async () => {
            await p.qqAuth.clear();
            notice(t('notice.qqLoggedOut'));
            await this.refreshQq();
          })
      )
    );

    heading(el, t('settings.section.local'));
    row(el, t('settings.audioFolder'), t('settings.audioFolderDesc'), (s) =>
      s.addText((txt) =>
        txt
          .setPlaceholder(DEFAULT_SETTINGS.audioFolder)
          .setValue(p.settings.audioFolder)
          .onChange(async (v) => {
            p.settings.audioFolder = v.trim() || DEFAULT_SETTINGS.audioFolder;
            await p.saveSettings();
          })
      )
    );
    row(el, t('settings.importMode'), t('settings.importModeDesc'), (s) =>
      s.addDropdown((d) =>
        d
          .addOption('copy', t('settings.importCopy'))
          .addOption('link', t('settings.importLink'))
          .setValue(p.settings.importMode)
          .onChange(async (v) => {
            p.settings.importMode = v as VinylSettings['importMode'];
            await p.saveSettings();
          })
      )
    );
  }

  // ============ 关于：整页手绘（版本 / 作者手记 / 许可） ============

  private renderAboutTab(el: HTMLElement): void {
    const { root, note } = renderAboutPage(el, this.plugin.manifest.version);
    this.aboutInkStop = attachAboutInk(root, note);
  }

  // ============ 登录状态行 ============

  /** 状态行：控件区放状态文案，行渲染后异步回填 —— 先渲染设置项再取状态，
   *  两个平台并行检测，避免一个慢源阻塞另一个。 */
  private statusRow(parent: HTMLElement, platform: 'netease' | 'qq'): void {
    row(parent, t('settings.loginStatus'), t('settings.loginStatusDesc'), (s) => {
      const el = s.controlEl.createDiv({ cls: 'vinyl-auth-status' });
      if (platform === 'netease') {
        this.neteaseStatusEl = el;
        void this.refreshNetease();
      } else {
        this.qqStatusEl = el;
        void this.refreshQq();
      }
    });
  }

  /** 网易云登录态回填。不能拿 isConnected 当门槛：render 回调跑的时候行还没接进文档，
   *  那样首次回填会被直接挡掉（状态永远是空的）。旧元素被重绘丢弃时，写进去也无害；
   *  同一平台的并发检测用序号只认最后一次。 */
  private async refreshNetease() {
    const el = this.neteaseStatusEl;
    if (!el) return;
    const request = ++this.neteaseRefresh;
    el.empty();
    el.createSpan({ text: t('settings.checkingLogin'), cls: 'vinyl-muted' });
    let st: LoginState;
    try {
      st = await this.plugin.auth.getStatus();
    } catch (e) {
      if (request !== this.neteaseRefresh) return;
      el.empty();
      el.createSpan({
        text: tf('settings.checkFailed', { msg: (e as Error).message }),
        cls: 'vinyl-muted',
      });
      return;
    }
    if (request !== this.neteaseRefresh) return;
    el.empty();
    el.createSpan({
      text: st.loggedIn
        ? tf('settings.statusLoggedIn', { name: st.nick || t('settings.loggedIn'), id: st.userId ?? '' }) +
          (st.vipType === 11 ? ' · VIP' : '')
        : st.cookieBytes > 0
          ? t('settings.cookieInvalid')
          : t('settings.notLoggedIn'),
    });
    el.createSpan({
      text: st.loggedIn
        ? `Cookie ${(st.cookieBytes / 1024).toFixed(1)} KB`
        : st.serverOk
          ? t('settings.gatewayOk')
          : t('settings.gatewayDown'),
      cls: 'vinyl-muted',
    });
  }

  /** QQ 音乐登录态回填（同上）。 */
  private async refreshQq() {
    const el = this.qqStatusEl;
    if (!el) return;
    const request = ++this.qqRefresh;
    el.empty();
    el.createSpan({ text: t('settings.checkingLogin'), cls: 'vinyl-muted' });
    let st: LoginState;
    try {
      st = await this.plugin.qqAuth.getStatus();
    } catch (e) {
      if (request !== this.qqRefresh) return;
      el.empty();
      el.createSpan({
        text: tf('settings.checkFailed', { msg: (e as Error).message }),
        cls: 'vinyl-muted',
      });
      return;
    }
    if (request !== this.qqRefresh) return;
    el.empty();
    el.createSpan({
      text: st.loggedIn
        ? tf('settings.statusLoggedInQq', { name: st.nick || t('settings.loggedIn'), id: st.userId ?? '' })
        : st.cookieBytes > 0
          ? t('settings.cookieInvalid')
          : t('settings.notLoggedIn'),
    });
    el.createSpan({
      text: st.loggedIn
        ? `Cookie ${(st.cookieBytes / 1024).toFixed(1)} KB`
        : st.serverOk
          ? t('settings.gatewayOk')
          : t('settings.gatewayDown'),
      cls: 'vinyl-muted',
    });
  }
}
