// 设置面板：四页原生分页（getSettingDefinitions 的 type: 'page'）——
// 通用（语言 / 维护 / 路径 / 模板 / 播放 / 播放器 / 统计）、外观（专辑墙 / 黑胶唱片 / 播放器）、
// 源（网易云 / QQ 音乐 / 运行环境 / 本地源）、关于（版本 / 作者手记 / 许可）。
// 每行都是一个设置定义：name/desc 进 Obsidian 的设置搜索（所以搜索能命中具体设置，而不是只有标签页名），
// 控件仍在 render 里按既有写法装配 —— 取值归一、副作用（refreshAppearance / refreshLanguage）
// 和文案都留在原处，不动原来的行为。
// 卡片属性不在设置页出现：专辑墙工具栏「卡片属性」直接维护 shelfProps。
import { App, PluginSettingTab, Setting, SettingPage } from 'obsidian';
import type { SettingDefinitionItem, SettingDefinitionRender } from 'obsidian';
import type VinylLifePlugin from './main';
import { QrLoginModal, qqQrProvider } from './views/qr-login-modal';
import { WebLoginModal, qqWebProvider } from './views/web-login-modal';
import { StatsModal } from './views/stats-modal';
import { DiscDirection, DISC_DIRECTIONS, SpinSpeed, SPIN_SPEEDS } from './core/disc-motion';
import { notice } from './util';
import { DICT, Lang, LANGUAGES, t, tf } from './core/i18n';
import { EMPTY_STATS, VinylStats, ensureStats } from './core/stats';
import { DEFAULT_SHELF_PROPS } from './core/shelf-props';
import { ABOUT_TEXT, ABOUT_TEXT_EN, REPO_URL } from './core/about';
import type { LoginState } from './core/auth';
import {
  DeckStyle,
  RecordColor,
  DECK_STYLES,
  RECORD_COLORS,
  normalizeDeckStyle,
  normalizeRecordColor,
} from './core/appearance';

/** 四个分页的页名键，顺序即分页顺序（刷新面板时按页码进回原页） */
const PAGE_KEYS = [
  'settings.tab.general',
  'settings.tab.appearance',
  'settings.tab.source',
  'settings.tab.about',
];

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
  /** 播放器面板配色（外观页）：胡桃木 / 黑胶黑 */
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

/** 一行设置。name/desc 是 Obsidian 设置搜索的索引来源，控件在 render 里装配。
 *  desc 传空串 = 这一行不带说明（如登录状态行，状态本身就在控件区）。 */
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

/** 音量归一：非数字 / 越界一律回落默认（data.json 可能被手改） */
export function normalizeVolume(raw: unknown): number {
  return typeof raw === 'number' && isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_SETTINGS.volume;
}

/** 一行设置。name/desc 是 Obsidian 设置搜索的索引来源，控件在 render 里装配。
 *  desc 传空串 = 这一行不带说明（如登录状态行，状态本身就在控件区）。 */
const row = (
  name: string,
  desc: string,
  build: (s: Setting) => void
): SettingDefinitionRender => ({
  name,
  desc: desc || undefined,
  render: (s) => {
    build(s);
  },
});

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

/** 「关于」页：整页自绘（产品名 / 版本 / 作者手记中英 / 许可），没有可检索的设置行，
 *  所以走 SettingDefinitionPage 的 page 工厂，而不是 items。 */
class AboutPage extends SettingPage {
  private plugin: VinylLifePlugin;

  constructor(plugin: VinylLifePlugin) {
    super();
    this.plugin = plugin;
  }

  display() {
    const about = this.containerEl.createDiv({ cls: 'vinyl-about' });

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

export class VinylSettingTab extends PluginSettingTab {
  plugin: VinylLifePlugin;
  // 登录状态行的当前元素：回填时写这一份（行重绘会换新元素，旧的自然作废）
  private neteaseStatusEl: HTMLElement | null = null;
  private qqStatusEl: HTMLElement | null = null;
  // 同一平台可能有多次并发检测（渲染 / 登录回调 / 退出），只认最后一次
  private neteaseRefresh = 0;
  private qqRefresh = 0;

  constructor(app: App, plugin: VinylLifePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { type: 'page', name: t('settings.tab.general'), items: this.generalItems() },
      { type: 'page', name: t('settings.tab.appearance'), items: this.appearanceItems() },
      { type: 'page', name: t('settings.tab.source'), items: this.sourceItems() },
      { type: 'page', name: t('settings.tab.about'), page: () => new AboutPage(this.plugin) },
    ];
  }

  /** 重绘整个设置面板（文案 / 取值跟着变）。
   *
   *  正在分页里时不能直接 update()：框架重建定义表会把这一页拆掉，之后不会自己回来（只剩空白页）。
   *  所以先退回分页列表，再重建，最后按原页码进去 —— 走的都是框架自己的导航，
   *  update() 期间没有分页开着，就没有可拆的东西。任何一步没接上（比如页已不在），
   *  用户也只是停在列表页，不会看到空白页。 */
  private refreshPanel() {
    const doc = this.containerEl.ownerDocument;
    const pageIndex = this.openPageIndex(doc);
    if (pageIndex < 0) {
      this.update();
      return;
    }
    const back = doc.querySelector<HTMLElement>('.setting-page-back-button');
    if (back) back.click();
    window.setTimeout(() => {
      this.update();
      // 列表是框架在 update() 之后重建的，重建会把刚点开的分页一并换掉，
      // 所以不能「点一次就完事」：分页连着几次都在，才算真的进回去了。
      let stable = 0;
      const reopen = (attempt: number) => {
        if (this.pageOpen()) stable += 1;
        else {
          stable = 0;
          const rows = this.containerEl.ownerDocument.querySelectorAll<HTMLElement>(
            '.setting-item.mod-navigable'
          );
          if (rows[pageIndex]) rows[pageIndex].click();
        }
        if (attempt < 12 && stable < 3) window.setTimeout(() => reopen(attempt + 1), 100);
      };
      reopen(0);
    }, 50);
  }

  /** 当前打开的是第几页；没在分页里返回 -1。
   *  页名随语言变，所以两种语言的页名都比一遍（词典里都有），跟当前语言无关。 */
  private openPageIndex(doc: Document): number {
    const titleEl = doc.querySelector('.setting-page-title');
    const title = titleEl ? titleEl.textContent : null;
    if (!title) return -1;
    return PAGE_KEYS.findIndex((key) => DICT[key].zh === title || DICT[key].en === title);
  }

  /** 分页是不是真的开着。不能只看元素在不在：退回过列表之后，上一页的标题元素还会留在 DOM 里
   *  （不可见），拿它当「已进入分页」会把重进分页那一步整个跳过。 */
  private pageOpen(): boolean {
    const titleEl = this.containerEl.ownerDocument.querySelector<HTMLElement>('.setting-page-title');
    return !!titleEl && titleEl.getBoundingClientRect().height > 0;
  }

  // ============ 通用：语言 / 维护 / 路径 / 模板 / 播放 / 播放器 / 统计 ============

  private generalItems(): SettingDefinitionItem[] {
    const p = this.plugin;
    return [
      row(t('settings.language'), t('settings.languageDesc'), (s) =>
        s.addDropdown((d) => {
          for (const l of LANGUAGES) d.addOption(l.value, l.label);
          d.setValue(p.settings.language);
          d.onChange(async (v) => {
            p.settings.language = v === 'en' ? 'en' : 'zh';
            await p.saveSettings();
            p.refreshLanguage();
            // 改完语言重绘面板本身（否则要重开设置才变）
            this.refreshPanel();
          });
        })
      ),
      // 维护类命令（登录 / 退出）默认不注册。
      // 注册发生在 onload → 改完开关重载插件（或重开 Obsidian）才生效，描述里已写明。
      row(t('settings.debugCommands'), t('settings.debugCommandsDesc'), (s) =>
        s.addToggle((tg) =>
          tg.setValue(p.settings.debugCommands).onChange(async (v) => {
            p.settings.debugCommands = v;
            await p.saveSettings();
          })
        )
      ),
      {
        type: 'group',
        heading: t('settings.path'),
        items: [
          row(t('settings.albumFolder'), t('settings.albumFolderDesc'), (s) =>
            s.addText((txt) =>
              txt
                .setPlaceholder(DEFAULT_SETTINGS.albumFolder)
                .setValue(p.settings.albumFolder)
                .onChange(async (v) => {
                  p.settings.albumFolder = v.trim() || DEFAULT_SETTINGS.albumFolder;
                  await p.saveSettings();
                })
            )
          ),
          row(t('settings.coverFolder'), t('settings.coverFolderDesc'), (s) =>
            s.addText((txt) =>
              txt
                .setPlaceholder(DEFAULT_SETTINGS.coverFolder)
                .setValue(p.settings.coverFolder)
                .onChange(async (v) => {
                  p.settings.coverFolder = v.trim() || DEFAULT_SETTINGS.coverFolder;
                  await p.saveSettings();
                })
            )
          ),
        ],
      },
      {
        type: 'group',
        heading: t('settings.template'),
        items: [
          row(t('settings.albumTemplate'), t('settings.albumTemplateDesc'), (s) =>
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
                  this.refreshPanel(); // 路径已被回填，重绘让输入框显示新值
                })
              )
          ),
        ],
      },
      {
        type: 'group',
        heading: t('settings.section.playback'),
        items: [
          row(t('settings.defaultSource'), t('settings.defaultSourceDesc'), (s) =>
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
          ),
          row(t('settings.quality'), t('settings.qualityDesc'), (s) =>
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
          ),
          row(t('settings.autoPlay'), t('settings.autoPlayDesc'), (s) =>
            s.addToggle((tg) =>
              tg.setValue(p.settings.autoPlay).onChange(async (v) => {
                p.settings.autoPlay = v;
                await p.saveSettings();
              })
            )
          ),
        ],
      },
      {
        type: 'group',
        heading: t('settings.section.player'),
        items: [
          row(t('settings.playerLocation'), t('settings.playerLocationDesc'), (s) =>
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
          ),
        ],
      },
      {
        type: 'group',
        heading: t('settings.section.stats'),
        items: [
          row(
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
                      this.refreshPanel();
                    })
                )
          ),
        ],
      },
    ];
  }

  // ============ 外观：专辑墙 / 黑胶唱片 / 播放器 ============

  private appearanceItems(): SettingDefinitionItem[] {
    const p = this.plugin;
    return [
      {
        type: 'group',
        heading: t('settings.section.shelf'),
        items: [
          row(t('settings.columns'), t('settings.columnsDesc'), (s) =>
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
          ),
          row(t('settings.discDirection'), t('settings.discDirectionDesc'), (s) =>
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
          ),
        ],
      },
      {
        type: 'group',
        heading: t('settings.section.vinyl'),
        items: [
          row(t('settings.recordColor'), t('settings.recordColorDesc'), (s) =>
            s.addDropdown((d) => {
              for (const key of RECORD_COLORS) d.addOption(key, t(RECORD_LABEL_KEYS[key]));
              d.setValue(p.settings.recordColor).onChange(async (v) => {
                p.settings.recordColor = normalizeRecordColor(v);
                await p.saveSettings();
                p.refreshAppearance();
              });
            })
          ),
        ],
      },
      {
        type: 'group',
        heading: t('settings.section.player'),
        items: [
          row(t('settings.deck'), t('settings.deckDesc'), (s) =>
            s.addDropdown((d) => {
              for (const key of DECK_STYLES) d.addOption(key, t(DECK_LABEL_KEYS[key]));
              d.setValue(p.settings.playerDeck).onChange(async (v) => {
                p.settings.playerDeck = normalizeDeckStyle(v);
                await p.saveSettings();
                p.refreshAppearance();
              });
            })
          ),
          row(t('settings.spinSpeed'), t('settings.spinSpeedDesc'), (s) =>
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
          ),
        ],
      },
    ];
  }

  // ============ 源：网易云 / QQ 音乐 / 运行环境 / 本地源 ============

  private sourceItems(): SettingDefinitionItem[] {
    const p = this.plugin;
    return [
      {
        type: 'group',
        heading: t('settings.sub.netease'),
        items: [
          this.statusRow('netease'),
          row(t('settings.qrLogin'), t('settings.qrLoginDescNetease'), (s) =>
            s.addButton((b) =>
              b.setButtonText(t('settings.qrLogin')).onClick(() => {
                new QrLoginModal(
                  this.app,
                  { server: p.server, auth: p.auth },
                  { onLogin: () => void this.refreshNetease() }
                ).open();
              })
            )
          ),
          row(t('settings.webLogin'), t('settings.webLoginDescNetease'), (s) =>
            s.addButton((b) =>
              b.setButtonText(t('settings.webLogin')).onClick(() => {
                new WebLoginModal(this.app, {
                  auth: p.auth,
                  browserLogin: p.browserLogin,
                  onLogin: () => void this.refreshNetease(),
                }).open();
              })
            )
          ),
          row(t('settings.logout'), t('settings.logoutDescNetease'), (s) =>
            s.addButton((b) =>
              b
                .setButtonText(t('settings.logoutAction'))
                .setDestructive()
                .onClick(async () => {
                  p.browserLogin.cancel();
                  await p.auth.clear();
                  notice(t('notice.neteaseLoggedOut'));
                  await this.refreshNetease();
                })
            )
          ),
        ],
      },
      {
        type: 'group',
        heading: t('settings.sub.qq'),
        items: [
          this.statusRow('qq'),
          row(t('settings.qrLogin'), t('settings.qrLoginDescQq'), (s) =>
            s.addButton((b) =>
              b.setButtonText(t('settings.qrLogin')).onClick(() => {
                new QrLoginModal(
                  this.app,
                  { server: p.server, auth: p.qqAuth },
                  { provider: qqQrProvider(), onLogin: () => void this.refreshQq() }
                ).open();
              })
            )
          ),
          row(t('settings.webLogin'), t('settings.webLoginDescQq'), (s) =>
            s.addButton((b) =>
              b.setButtonText(t('settings.webLogin')).onClick(() => {
                new WebLoginModal(this.app, {
                  auth: p.qqAuth,
                  browserLogin: p.qqBrowserLogin,
                  provider: qqWebProvider(),
                  onLogin: () => void this.refreshQq(),
                }).open();
              })
            )
          ),
          row(t('settings.logout'), t('settings.logoutDescQq'), (s) =>
            s.addButton((b) =>
              b
                .setButtonText(t('settings.logoutAction'))
                .setDestructive()
                .onClick(async () => {
                  p.qqBrowserLogin.cancel();
                  await p.qqAuth.clear();
                  notice(t('notice.qqLoggedOut'));
                  await this.refreshQq();
                })
            )
          ),
        ],
      },
      {
        type: 'group',
        heading: t('settings.sub.runtime'),
        items: [
          row(
            'Node.js', // 产品名不翻译
            p.server.nodeBinary ? p.server.nodeBinary : t('settings.nodeMissing'),
            (s) =>
              s.addButton((b) =>
                b.setButtonText(t('settings.redetect')).onClick(async () => {
                  b.setButtonText(t('settings.detecting')).setDisabled(true);
                  p.server.nodeBinary = await p.server.resolveNodeBinary();
                  this.refreshPanel();
                })
              )
          ),
        ],
      },
      {
        type: 'group',
        heading: t('settings.section.local'),
        items: [
          row(t('settings.audioFolder'), t('settings.audioFolderDesc'), (s) =>
            s.addText((txt) =>
              txt
                .setPlaceholder(DEFAULT_SETTINGS.audioFolder)
                .setValue(p.settings.audioFolder)
                .onChange(async (v) => {
                  p.settings.audioFolder = v.trim() || DEFAULT_SETTINGS.audioFolder;
                  await p.saveSettings();
                })
            )
          ),
          row(t('settings.importMode'), t('settings.importModeDesc'), (s) =>
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
          ),
        ],
      },
    ];
  }

  // ============ 登录状态行 ============

  /** 状态行：控件区放状态文案，行渲染后异步回填 —— 先渲染设置项再取状态，
   *  两个平台并行检测，避免一个慢源阻塞另一个。 */
  private statusRow(platform: 'netease' | 'qq'): SettingDefinitionRender {
    return row(t('settings.loginStatus'), t('settings.loginStatusDesc'), (s) => {
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
