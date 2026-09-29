// Vinyl Life —— 主入口：注册视图 / 命令 / 设置面板，装配服务层与播放引擎。
// 本地源（零后端）+ 在线源（应用内网关）统一为 Track 队列。
import { Editor, Plugin, TAbstractFile, TFile, TFolder, MarkdownView, WorkspaceLeaf, normalizePath, Notice } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import {
  VinylSettings,
  DEFAULT_SETTINGS,
  VinylSettingTab,
  normalizeLastPlayback,
  normalizePlayMode,
  normalizeVolume,
} from './settings';
import { pruneRemovedSettings } from './core/settings-legacy';
import { ServerManager } from './core/server-manager';
import { installStyleFallback } from './core/style-fallback';
import { STYLE_GZIP } from './core/style-bundle';
import { ServerClient } from './core/server-client';
import { WebClient } from './core/web-client';
import { NeteaseService } from './core/netease';
import { Auth } from './core/auth';
import { QqService } from './core/qq';
import { QqAuth } from './core/qq-auth';
import { KugouService } from './core/kugou';
import { KugouAuth } from './core/kugou-auth';
import { LocalSource, BLOB_BUDGET_BYTES } from './core/local-source';
import { PlaybackEngine } from './core/player-state';
import type { PlayerSnapshot } from './core/player-state';
import { setUpstreamPacing } from './core/probe-pacing';
import { syncMediaSession } from './core/media-session';
import { VinylPlayerView, PLAYER_VIEW_TYPE } from './views/player-view';
import { VinylShelfView, SHELF_VIEW_TYPE } from './views/shelf-view';
import { registerBrandIcons } from './views/brand-icons';
import { HandoffController } from './animation/handoff';
import {
  AlbumInfo,
  findConventionCover,
  getAlbumInfo,
  findAlbumNotes,
  setAlbumTemplatePath,
  stripWikilink,
  detectAlbumSources,
  invalidateSourceCache,
} from './core/album-index';
import { normalizeShelfProps, normalizeShelfPropLabels, propLabel } from './core/shelf-props';
import { DISC_DIRECTIONS, SPIN_SPEEDS } from './core/disc-motion';
import {
  normalizeDeckStyle,
  normalizeRecordColor,
  normalizeToolbarPosition,
} from './core/appearance';
import { normalizeScratchSound } from './core/scratch';
import { normalizeSearchScope } from './core/album-discovery';
import {
  notice,
  pluginAbsPath,
  ensureFolder,
  splitAudioFiles,
  skippedFormatsText,
  analyzeFolder,
  relPathOf,
  libraryRootHint,
  fmtTime,
  vaultChangeMatters,
  IMAGE_EXTENSIONS,
} from './util';
import {
  ImportContext,
  importLocalAudio,
  createAlbumFromFiles,
  DEFAULT_ALBUM_TEMPLATE,
} from './import';
import { AlbumImportModal, LocalImportModal } from './views/import-modal';
import { DeleteAlbumModal } from './views/delete-album-modal';
import { DeleteBatchModal } from './views/delete-batch-modal';
import { collectAlbumBatchDeleteTargets, deleteAlbumBatchAssets } from './delete';
import { setLanguage, t, tf } from './core/i18n';
import {
  AlbumPlayStat,
  AlbumStatSnapshot,
  PlayEvent,
  VinylStats,
  ensureStats,
  localDayKey,
  needsRetention,
  normalizePlayEvents,
  recordTrackPlay,
  trimPlayEvents,
} from './core/stats';
import { normalizeProbeScope } from './core/library-health';
import { Track, trackKey, isLocalTrack } from './core/track';
import { LyricLine, parseLrc } from './core/lyrics';
import { buildAlbumQueue } from './core/queue';
import { segmentMoveBy } from './core/queue-move';
import { albumSourceLinks } from './core/source-link';
import { COMMANDS, CommandHost } from './core/commands';
import { SetCoverModal } from './views/set-cover-modal';
import { parseQueueEntries, pickTrackByTitle, queueNoteLines } from './core/queue-note';
import type { ActiveSource } from './core/queue';
import { LibraryHealthModal, SourceSwitchModal } from './views/library-health';

// wikilink 危险字符：|（别名分隔）、[ ]（链接定界）、换行 —— 专辑名 / 路径都可能含，一律不硬塞进链接。
const WIKILINK_UNSAFE = /[|[\]\r\n]/;

/** 「插入此刻正在听」用：专辑名 → 可点击的 wikilink，路径安全时带别名 [[路径|专辑名]]（源码不至于太长，
 *  阅读时显示专辑名）。不安全就逐级降级：别名不安全（空 / 含 | [ ] 换行）→ [[路径]]（显示名 = 笔记文件名），
 *  路径不安全 / 无路径 → 纯专辑名（宁可不能点，也不生成 [[|名]] 这类坏链接）。 */
function albumWikiLink(path: string | undefined, title: string): string {
  const name = (title || '').trim();
  const p = (path || '').trim();
  const safePath = p && !WIKILINK_UNSAFE.test(p) ? p : '';
  const safeName = name && !WIKILINK_UNSAFE.test(name) ? name : '';
  if (safePath && safeName) return `[[${safePath}|${safeName}]]`;
  if (safePath) return `[[${safePath}]]`;
  return name;
}

/** 历史封面副本（`.stats-covers/<hash>.<扩展名>`）的名字判据：扩展名必须取自 util 的 IMAGE_EXTENSIONS ——
 *  手抄白名单漏掉 avif / bmp 会让备份静默跳过副本、恢复也写不回，换设备后那封面就永久没了。 */
const STATS_COVER_NAME_RE = new RegExp(
  `^\\.stats-covers/[0-9a-f]{1,8}\\.(?:${IMAGE_EXTENSIONS.join('|')})$`,
  'i'
);

/** 自动备份：文件名前缀（清理旧份数时只认这个前缀，手动备份 / 裁剪归档不碰）与间隔（一周） */
const AUTO_BACKUP_PREFIX = 'Vinyl Life auto backup';
const AUTO_BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** 落盘节奏：平时 5 秒防抖；连续播放会一直推后防抖，故另加一条 30 秒的最长等待（见 scheduleStatsSave）。 */
const STATS_SAVE_DEBOUNCE_MS = 5000;
const STATS_SAVE_MAX_WAIT_MS = 30 * 1000;

/** 健康检查的试播节奏：取流固定按最低档、请求之间留最小间隔（理由见 checkOnlineSource）。 */
const PROBE_QUALITY = 'standard';
const PROBE_REQUEST_GAP_MS = 250;

/** 歌词缓存上限（首）：满了先丢最早的一半。一首歌词几十 KB，长会话里别无限涨 */
const LYRICS_CACHE_MAX = 60;

/** 解码失败就原样返回：链接可能是用户手打的，半个 % 会让 decodeURIComponent 抛异常 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Markdown 表格单元格：管道会截断列、换行会断行 —— wikilink 的别名分隔符靠这一步进表格 */
function tableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** 导出笔记里的字符柱状：按最大值等比缩放到最多 16 格（页面热力图在笔记里的等价物） */
function textBar(count: number, max: number): string {
  return '█'.repeat(Math.max(1, Math.round((count / Math.max(1, max)) * 16)));
}

export default class VinylLifePlugin extends Plugin {
  settings: VinylSettings = { ...DEFAULT_SETTINGS };
  server!: ServerManager;
  client!: ServerClient;
  web!: WebClient;
  netease!: NeteaseService;
  auth!: Auth;
  qq!: QqService;
  qqAuth!: QqAuth;
  kugou!: KugouService;
  kugouAuth!: KugouAuth;
  local!: LocalSource;
  engine!: PlaybackEngine;
  handoff!: HandoffController;
  private lastReportedSourceFailure = '';
  private pendingSourceSwitch: { path: string; source: ActiveSource } | null = null;
  /** 恢复备份后到重启前：saveSettings 一直早退（见其第一行），新的播放事件与设置改动只留在内存 ——
   *  UI 必须常驻说出来（一条几秒的 Notice 兜不住「用户没重启就接着用了几小时」这个场景）。 */
  awaitingRestartAfterRestore = false;
  /** 本轮会话里播放明细归档失败过（播放中反复触发时只提示一次） */
  private archiveFailedThisSession = false;
  /** 本轮会话里自动备份失败过（同上：每小时检查一次，失败别反复弹） */
  private autoBackupFailedThisSession = false;
  /** 本次启动读不出 data.json、已把原文件另存（见 readSettingsFile）。这段会话绝不能自动备份：
   *  内存中是默认值，那份「备份」是空的，而保留份数一裁就会把上一份好备份挤掉 —— 用一次坏读毁掉仅有的退路。 */
  private dataQuarantined = false;
  /** 歌词缓存（trackKey → 行；null = 这首歌确实没有歌词）。一首几十 KB，见 rememberLyrics 的上限 */
  private lyricsCache = new Map<string, LyricLine[] | null>();
  /** 在途的取歌词：同一首并发问两次只打一次网（来回翻面很容易撞上） */
  private lyricsInflight = new Map<string, Promise<LyricLine[] | null>>();

  async onload() {
    // 品牌图标：设置面板「源」页按图标名取用，必须赶在面板第一次渲染之前注册
    // （样式兜底 / 读设置 / 建目录那几步都在后面，谁先谁后都不影响它）
    registerBrandIcons();

    // 样式兜底：styles.css 缺失、或与插件版本不一致（只覆盖了 main.js / 同步到一半）时挂上内联副本
    const disposeStyleFallback = installStyleFallback(
      pluginAbsPath(this, 'styles.css'),
      STYLE_GZIP,
      this.manifest.version
    );
    if (disposeStyleFallback) this.register(disposeStyleFallback);

    await this.loadSettings();

    // 音源检测缓存作废（口径见 album-index 的 invalidateSourceCache）：墙开着时它自己刷新就够，但
    // 播放器 / 健康检查 / 失败提示在墙关着时也读这份结论，故在插件层再兜一道。
    // **只认会影响结论的那几类变化**（判据同专辑墙的 onVaultChanged，另加「专辑笔记目录里的 md」）：一次
    // 作废 = 对每张专辑重算并碰文件系统（库外引用走 fs.existsSync / 递归 readdir）—— 曾经不看路径一律
    // 作废，别的插件写篇日记就让 500 张的墙各来一遍同步调用。其余早退；库外目录自己变了听不到。
    const onVaultStructureChanged = (f: TAbstractFile, oldPath?: string) => {
      const isFolder = f instanceof TFolder;
      const isFile = f instanceof TFile;
      if (!isFolder && !isFile) return;
      if (
        vaultChangeMatters({
          path: f.path,
          extension: isFile ? f.extension : '',
          isFolder,
          albumFolder: this.settings.albumFolder,
          oldPath,
        })
      ) {
        invalidateSourceCache();
      }
    };
    this.registerEvent(this.app.vault.on('create', (f) => onVaultStructureChanged(f)));
    this.registerEvent(this.app.vault.on('delete', (f) => onVaultStructureChanged(f)));
    this.registerEvent(
      this.app.vault.on('rename', (f, oldPath) => {
        onVaultStructureChanged(f, oldPath);
        this.migrateAlbumKeys(oldPath, f.path);
      })
    );

    // 首次运行搭好目录结构（新装即用；已有目录不动，失败不阻塞加载 —— 导入流程里还会再兜一次）
    await this.ensureDataFolders();

    // 服务层：网关（Cookie 通道）+ 网页直连（渲染进程 requestUrl）统一路由
    this.server = new ServerManager(this);
    // 网关起不来必须说出来（各调用方只会各自降级）：文案点明本地音频不受影响，免得用户以为插件坏了
    this.server.onFailure = (msg) => {
      notice(tf('gateway.unavailable', { msg }), 10_000);
    };
    this.client = new ServerClient(
      () => this.server.base,
      () => this.server.token
    );
    // 第三个参数是登录凭据文件：不接的话渲染进程永远「未登录」，网页直连通道形同虚设
    this.web = new WebClient(
      pluginAbsPath(this, '.anon-token'),
      pluginAbsPath(this, '.device-id'),
      pluginAbsPath(this, '.cookie')
    );
    this.netease = new NeteaseService(this.web, this.client, () => this.server.ensure(), () => this.server.lastError);
    this.auth = new Auth(this, this.server, this.client);
    this.qq = new QqService(
      () => this.server.base,
      () => this.server.token
    );
    this.qqAuth = new QqAuth(this, this.server, this.qq);
    this.kugou = new KugouService(
      () => this.server.base,
      () => this.server.token
    );
    this.kugouAuth = new KugouAuth(this, this.server, this.kugou);
    // 第三个参数是网关：库外音频按 HTTP Range 供流（整轨不进内存），起不来时 LocalSource 自行退回 Blob
    this.local = new LocalSource(this.app, BLOB_BUDGET_BYTES, this.server);

    this.engine = new PlaybackEngine({
      app: this.app,
      local: this.local,
      netease: this.netease,
      qq: this.qq,
      kugou: this.kugou,
      settings: () => this.settings,
      onTrackPlay: (track, albumPath, albumTitle) => {
        this.recordPlay(track, albumPath, albumTitle);
        const pending = this.pendingSourceSwitch;
        if (pending?.path === albumPath) {
          const active = track.source === 'local-vault' || track.source === 'local-external'
            ? 'local' : track.source;
          if (active === pending.source) {
            this.pendingSourceSwitch = null;
            const file = this.app.vault.getAbstractFileByPath(pending.path);
            if (file instanceof TFile) {
              // 回调参数显式标注（理由同 import.ts）：不标注则 fm 是 any，写属性算不安全访问
              void this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
                fm.source = pending.source;
              });
            }
          }
        }
      },
      onAlbumLoadFailed: (album, policy, reason) => this.reportAlbumSourceFailure(album, policy, reason),
      // 播放模式是持久设置：引擎启动时读一次，之后由引擎自己维护
      playMode: () => this.settings.playMode,
    });
    // 音量沿用上次（引擎默认 0.8，这里覆盖成用户自己的值）
    this.engine.setVolume(this.settings.volume);
    // 系统媒体键挂在插件层（播放器关着也管用）；顺带把「音量 + 播放位置」落进同一条 5 秒防抖
    this.engine.subscribe((s) => {
      syncMediaSession(s, {
        play: () => void this.engine.play(),
        pause: () => this.engine.pause(),
        next: () => void this.engine.next(),
        prev: () => void this.engine.prev(),
        seek: (ratio) => this.engine.seek(ratio),
      });
      this.rememberPlayback(s);
      this.trackSourceHealth(s);
    });
    this.handoff = new HandoffController(this);

    this.registerView(PLAYER_VIEW_TYPE, (leaf) => new VinylPlayerView(leaf, this));
    this.registerView(SHELF_VIEW_TYPE, (leaf) => new VinylShelfView(leaf, this));
    // 图标与播放器视图一致（disc-3），一眼认出是 Vinyl Life
    this.addRibbonIcon('disc-3', t('cmd.ribbonShelf'), () => this.openShelf());
    // 命令表在 core/commands.ts（宿主中立，独立壳将来直接吃同一份），这里只做 Obsidian 这一侧的接线；
    // 登录 / 退出统一从「设置 → 源」操作，不占命令面板。
    // 命令 id 不得改动（改了会让已绑定的快捷键失效）；也**不给默认快捷键**（可能撞上用户自己的键）
    // —— 想用键的去「设置 → 快捷键」绑，README 的「命令与快捷键」列了推荐键位。
    const commandHost = this.commandHost();
    for (const cmd of COMMANDS) {
      this.addCommand({
        id: cmd.id,
        name: t(cmd.titleKey),
        callback: () => void cmd.run(commandHost),
      });
    }
    // 笔记里的播放位置 → 跳回音乐（写感想时把位置写成 obsidian:// 链接，见 appendListeningNote）：
    // 「听到这里 → 记下 → 日后重听」闭环里最后那一跳。
    this.registerObsidianProtocolHandler('vinyl-life', (params) => void this.resumeFromNote(params));

    this.addSettingTab(new VinylSettingTab(this.app, this));

    // 恢复上次的队列位置（不自动播放）：放在最后，失败也不影响插件可用
    void this.restoreLastPlayback();

    // 每周自动备份：启动时查一次，之后每小时查一次（长期开着 Obsidian 也会到点就备）
    void this.maybeAutoBackup();
    this.registerInterval(
      window.setInterval(() => void this.maybeAutoBackup(), 60 * 60 * 1000)
    );

  }

  onunload() {
    if (this.statsSaveTimer) window.clearTimeout(this.statsSaveTimer);
    void this.saveSettings(); // 尽力落盘（防抖窗口内的统计）
    // dispose 而不是 stop：网关的自愈定时器也得撤掉，否则它会在卸载之后把网关拉起来（见其注释）
    this.server?.dispose();
    this.engine?.dispose();
    this.local?.clearAllBlobs();
  }

  /** data.json 的读取：「还没有这个文件」（新装）与「文件在、但读不出来」（同步工具写到一半 / 断电 /
   *  手改坏了）必须区分 —— loadData 在 JSON 解析失败时返回的也是 null。一律按全新安装处理，用户唯一
   *  一份设置与统计会在启动后几秒内被默认值盖掉（顺带写出一份空备份，还可能按保留份数挤掉上一份好的）
   *  —— 所以坏文件先原样另存一份，再退回默认值。 */
  private async readSettingsFile(): Promise<Partial<VinylSettings>> {
    const dir = this.manifest.dir || '';
    const dataPath = dir ? `${dir}/data.json` : 'data.json';
    let raw: string | null = null;
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(dataPath)) raw = await adapter.read(dataPath);
    } catch {
      raw = null; // 读不到（adapter 不给这能力 / 权限）：按「拿不到内容」处理
    }
    const loaded: unknown = await this.loadData();
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
      return loaded;
    }
    if (raw && raw.trim()) {
      this.dataQuarantined = true;
      const name = `data.json.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const target = normalizePath(dir ? `${dir}/${name}` : name);
      try {
        await this.app.vault.adapter.write(target, raw);
        notice(tf('data.corruptQuarantined', { name }));
      } catch (e) {
        // 留档失败也绝不能静默：用户至少要知道原文件没了
        console.error('[vinyl] 无法另存损坏的 data.json', e);
        notice(tf('data.corruptUnreadable', { name: dataPath }));
      }
    }
    return {};
  }

  async loadSettings() {
    const data: Partial<VinylSettings> = await this.readSettingsFile();
    this.settings = { ...DEFAULT_SETTINGS, ...data };
    // 已移除功能的旧键：清掉再往下走，否则会被原样写回下一份 data.json（清单见 settings-legacy）
    pruneRemovedSettings(this.settings);
    // 统计 / 队列目录：按旧口径补默认值（专辑笔记目录的上一级 + Stats / Queues），老用户落点不换地方
    const statsRoot = this.settings.albumFolder.split('/').slice(0, -1).join('/') || 'Vinyl Life';
    const savedStatsFolder = typeof data?.statsFolder === 'string' ? data.statsFolder.trim() : '';
    this.settings.statsFolder = savedStatsFolder || `${statsRoot}/Stats`;
    const savedQueueFolder = typeof data?.queueFolder === 'string' ? data.queueFolder.trim() : '';
    this.settings.queueFolder = savedQueueFolder || `${statsRoot}/Queues`;
    // 播放明细裁剪：**先归档，再裁**。两年保留规则一旦执行就再也回不来，而「很久没打开插件」的
    // 用户根本没机会手动备份 —— 故把要被裁的明细连同一份完整设置写成可恢复的备份 JSON，再裁内存里的。
    const allEvents = normalizePlayEvents(data?.stats?.events);
    this.settings.stats = ensureStats(data?.stats);
    // **先归档成功，才认裁剪结果**（启动路径；播放中的那条在 recordPlay 里走同一个函数）
    await this.retainEventsOrKeepAll(allEvents, this.settings.stats.events);
    this.settings.sourceFailures = data?.sourceFailures && typeof data.sourceFailures === 'object' && !Array.isArray(data.sourceFailures)
      ? { ...data.sourceFailures } : {};
    // 卡片属性：必须显式归一化 —— Object.assign 对数组会产出 {0:…,length:…} 的类数组怪物，
    // 浅拷贝还会让设置与 DEFAULT_SETTINGS 共享引用（push 即污染默认值）；顺带迁移旧 boolean 结构
    this.settings.shelfProps = normalizeShelfProps(data?.shelfProps);
    this.settings.shelfPropLabels = normalizeShelfPropLabels(data?.shelfPropLabels);
    // 音量与上次播放位置：脏数据一律回落（data.json 可能被手改或来自旧版本）
    this.settings.volume = normalizeVolume(data?.volume);
    this.settings.lastPlayback = normalizeLastPlayback(data?.lastPlayback);
    // 专辑队列模式：同样只认布尔 true（脏数据一律当关）
    this.settings.queueMode = data?.queueMode === true;
    this.settings.playMode = normalizePlayMode(data?.playMode);
    // 外观项归一（data.json 可能来自旧版本或被手改）
    if (!DISC_DIRECTIONS.includes(this.settings.discDirection)) {
      this.settings.discDirection = DEFAULT_SETTINGS.discDirection;
    }
    const cols = this.settings.shelfColumns;
    if (cols !== 'auto' && !(typeof cols === 'number' && cols >= 2 && cols <= 8)) {
      this.settings.shelfColumns = DEFAULT_SETTINGS.shelfColumns;
    }
    if (!Object.keys(SPIN_SPEEDS).includes(this.settings.turntableSpeed)) {
      this.settings.turntableSpeed = DEFAULT_SETTINGS.turntableSpeed;
    }
    // 七个目录名统一（旧默认名 → 首字母大写）：设置都归一完了再改名，saveSettings 落的就是干净
    // 数据；它也可能把模板路径改掉，故必须排在下面「模板文件路径注入索引层」之前。
    await this.migrateFolderNames();
    // 模板文件路径注入索引层（避免它自己被当成专辑）
    setAlbumTemplatePath(this.settings.albumNoteTemplate);
    // 界面语言（i18n 模块级当前语言）
    setLanguage(this.settings.language);
    // 配色项（不认识的旧值由 normalize* 回落默认）
    this.settings.playerDeck = normalizeDeckStyle(data?.playerDeck);
    this.settings.recordColor = normalizeRecordColor(data?.recordColor);
    this.settings.toolbarPosition = normalizeToolbarPosition(data?.toolbarPosition);
    // 搓碟（外观页）：开关与预载默认开（只有显式写了 false 才当关），音效档不认识就回落「完整」
    this.settings.scratchEnabled = data?.scratchEnabled !== false;
    this.settings.scratchSound = normalizeScratchSound(data?.scratchSound);
    this.settings.scratchPreload = data?.scratchPreload !== false;
    // 在线搜索的来源范围（「添加」面板记住的上次选择；不认识的旧值回落聚合）
    this.settings.searchSource = normalizeSearchScope(data?.searchSource);
    // 健康检查的试播范围（同上：记忆型，不认识的旧值回落「全部」）
    this.settings.probeScope = normalizeProbeScope(data?.probeScope);
  }

  /** 音量与播放位置的防抖持久化入口（引擎每次 emit 都会调，落盘由 5 秒防抖兜住） */
  private rememberPlayback(s: PlayerSnapshot) {
    this.settings.volume = s.volume;
    // 没有当前曲目时别覆盖上次的记录（否则关掉播放器再重启就恢复不出东西了）
    if (s.current && s.albumNotePath) {
      this.settings.lastPlayback = {
        albumPath: s.albumNotePath,
        trackKey: trackKey(s.current),
        positionSec: Math.max(0, Math.floor(s.currentTime)),
      };
    }
    this.scheduleStatsSave();
  }

  /** 恢复上次播放的专辑与进度（不自动播放）。任何一步失败都静默放弃 —— 这属于锦上添花，不该阻塞启动。 */
  private async restoreLastPlayback() {
    const saved = this.settings.lastPlayback;
    if (!saved) return;
    try {
      const file = this.app.vault.getAbstractFileByPath(saved.albumPath);
      if (!(file instanceof TFile)) return; // 笔记被删 / 改名了
      const album = getAlbumInfo(this.app, file, { coverFolder: this.settings.coverFolder });
      if (!album) return;
      const res = await this.engine.loadAlbum(album, { autoplay: false });
      if (!res.tracks.length) return;
      const queue = this.engine.snapshot().queue;
      const i = queue.findIndex((tr) => trackKey(tr) === saved.trackKey);
      await this.engine.preloadIndex(i >= 0 ? i : 0, saved.positionSec);
    } catch (e) {
      console.warn('[vinyl] 恢复上次播放失败', e);
    }
  }

  // 设置页改动外观项后，就地刷新已打开的专辑墙与播放器（不重建 DOM，仅换类与 CSS 变量）
  refreshAppearance() {
    for (const leaf of this.app.workspace.getLeavesOfType(SHELF_VIEW_TYPE)) {
      const v = leaf.view;
      if (v instanceof VinylShelfView) v.applyAppearance();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(PLAYER_VIEW_TYPE)) {
      const v = leaf.view;
      if (v instanceof VinylPlayerView) v.applyAppearance();
    }
  }

  // 卡片属性变更后广播（与 refreshAppearance 对称）：属性变化要重建卡片行与已打开的弹层
  refreshShelfProps() {
    for (const leaf of this.app.workspace.getLeavesOfType(SHELF_VIEW_TYPE)) {
      const v = leaf.view;
      if (v instanceof VinylShelfView) v.refreshProps();
    }
  }

  async saveSettings() {
    // 恢复后旧播放引擎仍在运行；在重启前不允许它把旧会话状态覆盖刚恢复的 data.json。
    if (this.awaitingRestartAfterRestore) return;
    // 模板文件本身不能被当成专辑展示（模板里通常也写着 tags: [album]）
    setAlbumTemplatePath(this.settings.albumNoteTemplate);
    setLanguage(this.settings.language);
    await this.saveData(this.settings);
  }

  // 语言切换后重绘已打开的专辑墙（工具栏 / 排序筛选 / 空态 / 卡片菜单文案）
  refreshLanguage() {
    for (const leaf of this.app.workspace.getLeavesOfType(SHELF_VIEW_TYPE)) {
      const v = leaf.view as unknown as { applyLanguage?: () => void; render?: () => void };
      // 工具栏与卡片文案是建的时候写死的：必须走 applyLanguage（强制重建），光调 render 会落到
      // 增量分支上，文案停在旧语言（见 shelf-view 的 applyLanguage）
      if (typeof v.applyLanguage === 'function') v.applyLanguage();
      else if (typeof v.render === 'function') v.render();
    }
    // 播放器的壳只建一次（见 player-view 的增量渲染）：重建 DOM 会打断转盘旋转与入场动画、
    // 丢掉播放进度 —— 改为就地重放文案标签（按钮 aria-label / title 与队列提示）
    for (const leaf of this.app.workspace.getLeavesOfType(PLAYER_VIEW_TYPE)) {
      const v = leaf.view;
      if (v instanceof VinylPlayerView) v.applyLanguage();
    }
  }

  /** 模板文件默认落点：专辑笔记目录的上一级 + Template/（与其它目录同一套命名；文件名仍是中文） */
  defaultTemplatePath(): string {
    const root = this.settings.albumFolder.split('/').slice(0, -1).join('/');
    return normalizePath(`${root ? root + '/' : ''}Template/专辑笔记模板.md`);
  }

  /** 打开模板文件；配置的路径上没有文件就按内置模板生成一份再打开。顺带认下 1.3.0 之前的旧默认
   *  目录（模板/）—— 那是「设置里指着不存在的文件、导入却静默用内置模板」最常见的来源。 */
  async openAlbumTemplate(): Promise<void> {
    const configured = String(this.settings.albumNoteTemplate || '').trim();
    if (configured) {
      const found = this.app.vault.getAbstractFileByPath(normalizePath(configured));
      if (found instanceof TFile) {
        await this.app.workspace.getLeaf(false).openFile(found);
        return;
      }
    }
    const legacy = !configured || /(^|\/)(模板|template|Template)\/专辑笔记模板\.md$/.test(configured);
    const path = legacy ? this.defaultTemplatePath() : normalizePath(configured);
    let file: TFile;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      file = existing;
    } else {
      try {
        await ensureFolder(this.app, path.split('/').slice(0, -1).join('/'));
        file = await this.app.vault.create(path, DEFAULT_ALBUM_TEMPLATE);
      } catch (e) {
        notice(tf('notice.templateFailed', { msg: (e as Error).message }));
        return;
      }
    }
    this.settings.albumNoteTemplate = path;
    await this.saveSettings();
    await this.app.workspace.getLeaf(false).openFile(file);
    notice(tf('notice.templateReady', { path }));
  }

  /** 目录名统一（1.3.0）：旧默认名 → 首字母大写。**只迁仍是旧默认值的那一项** —— 用户改过路径的
   *  一律不碰，旧目录不在 / 新目录已存在也跳过（绝不合并，宁可不动）。走 fileManager，链接跟着更新。 */
  private async migrateFolderNames(): Promise<void> {
    const root = this.settings.albumFolder.split('/').slice(0, -1).join('/') || 'Vinyl Life';
    const renamed: string[] = [];
    const rename = async (oldPath: string, newPath: string, apply: () => void) => {
      const folder = this.app.vault.getAbstractFileByPath(oldPath);
      if (!(folder instanceof TFolder)) return;
      if (this.app.vault.getAbstractFileByPath(newPath)) return;
      try {
        await this.app.fileManager.renameFile(folder, newPath);
        apply();
        renamed.push(`${oldPath.slice(root.length + 1)} → ${newPath.slice(root.length + 1)}`);
      } catch (e) {
        console.warn('[vinyl] 目录改名失败', oldPath, e);
      }
    };
    // 封面 / 音频：设置里还是旧默认名时才迁
    const coverOld = normalizePath(`${root}/covers`);
    if (this.settings.coverFolder === coverOld) {
      await rename(coverOld, normalizePath(`${root}/Covers`), () => {
        this.settings.coverFolder = normalizePath(`${root}/Covers`);
      });
    }
    const audioOld = normalizePath(`${root}/audio`);
    if (this.settings.audioFolder === audioOld) {
      await rename(audioOld, normalizePath(`${root}/Audio`), () => {
        this.settings.audioFolder = normalizePath(`${root}/Audio`);
      });
    }
    // 模板目录：模板/（最早的默认）或 template/（上一个默认）→ Template/
    const tplOld = [normalizePath(`${root}/模板`), normalizePath(`${root}/template`)].find(
      (p) => this.app.vault.getAbstractFileByPath(p) instanceof TFolder
    );
    const tplConfigured = String(this.settings.albumNoteTemplate || '').trim();
    const tplIsLegacy =
      !tplConfigured || /(^|\/)(模板|template)\/专辑笔记模板\.md$/.test(tplConfigured);
    if (tplOld && tplIsLegacy) {
      await rename(tplOld, normalizePath(`${root}/Template`), () => {
        if (tplConfigured) {
          this.settings.albumNoteTemplate = normalizePath(`${root}/Template/专辑笔记模板.md`);
        }
      });
    }
    if (renamed.length) {
      await this.saveSettings();
      notice(tf('notice.foldersRenamed', { list: renamed.join('、') }));
    }
  }

  // 五个数据目录不存在则创建（新用户首次启用装完即用；用户改过路径设置也会补齐）
  private async ensureDataFolders() {
    for (const p of [
      this.settings.albumFolder,
      this.settings.coverFolder,
      this.settings.audioFolder,
      this.settings.statsFolder,
      this.settings.queueFolder,
    ]) {
      try {
        await ensureFolder(this.app, p);
      } catch {
        // Folder creation is retried when the corresponding feature is used.
      }
    }
  }

  // ============ 导入 / 感想 / 统计 ============

  importCtx(): ImportContext {
    return {
      app: this.app,
      settings: () => this.settings,
      // 搜索来源这类界面偏好由面板自己写回设置，落盘走插件的统一出口
      saveSettings: () => this.saveSettings(),
      client: this.netease,
      qq: this.qq,
      kugou: this.kugou,
    };
  }

  openAlbumImport(query = '') {
    new AlbumImportModal(this.app, this.importCtx(), query).open();
  }

  // —— 命令层（core/commands.ts 的 CommandHost 实现）——
  // 命令表只声明「做什么」：因此能在纯 Node 测试里跑（交假宿主），也能在独立壳里换实现，id 只有一份。

  /** 正在播放的那张专辑（口径同 appendListeningNote）；没在播 / 笔记被删或改名时返回 null，调用方如实报错。 */
  private currentAlbum(): AlbumInfo | null {
    const path = this.engine.snapshot().albumNotePath;
    if (!path) return null;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    return getAlbumInfo(this.app, file, { coverFolder: this.settings.coverFolder });
  }

  /** 设置封面（命令）：此前唯一入口是卡片右键菜单，键盘够不着 */
  private setCurrentAlbumCover(): void {
    const album = this.currentAlbum();
    if (!album) {
      notice(t('notice.noAlbumNote'));
      return;
    }
    new SetCoverModal(this.app, this, album).open();
  }

  /** 在源站打开（命令）：按 网易云 → QQ → 酷狗 取第一个有关联的；一个都没有如实说 */
  private openCurrentAlbumInSource(): void {
    const album = this.currentAlbum();
    const links = album ? albumSourceLinks(album) : [];
    if (!links.length) {
      notice(t('notice.noOnlineSource'));
      return;
    }
    window.open(links[0].url);
  }

  /** 给当前专辑导入本地音频（命令）。与「导入本地音频」的差别是这条**要求**有当前专辑 —— 否则
   *  打开的是没有目标的导入面板，用户以为导给了这张专辑（卡片拖拽在键盘上要有个说得清的等价物）。 */
  private importLocalToCurrent(): void {
    const album = this.currentAlbum();
    if (!album) {
      notice(t('notice.noAlbumNote'));
      return;
    }
    this.openLocalImport(album);
  }

  /** 整段（整张专辑）上下移：命令队列与播放器段头的 Alt+Shift+↑/↓ 共用这一条 */
  private moveCurrentSegment(delta: -1 | 1): void {
    const snap = this.engine.snapshot();
    const move = segmentMoveBy(snap.segments, snap.index, delta);
    if (!move) return; // 已经是第一段 / 最后一段：没有可去的地方，静默不动
    this.engine.moveRange(move.start, move.count, move.to);
  }

  private commandHost(): CommandHost {
    return {
      // 视图打开是异步的（等 leaf），但命令层不关心结果：不 await，也不把 Promise 传出去
      openShelf: () => void this.openShelf(),
      openPlayer: () => void this.openPlayer(),
      importAlbum: () => this.openAlbumImport(),
      importLocal: () => this.openLocalImport(),
      importLocalToCurrent: () => this.importLocalToCurrent(),
      insertNowPlaying: () => void this.insertNowPlaying(),
      saveQueueNote: async () => void (await this.saveQueueNote()),
      loadQueueNote: async () => void (await this.loadQueueFromActiveNote()),
      // 播放控制：给快捷键与命令面板用（媒体键另走 MediaSession，见引擎订阅）
      playerToggle: () => void this.engine.toggle(),
      playerNext: () => void this.engine.next(),
      playerPrev: () => void this.engine.prev(),
      appendListeningNote: () => this.appendListeningNote(),
      setAlbumCover: () => this.setCurrentAlbumCover(),
      openAlbumInSource: () => this.openCurrentAlbumInSource(),
      moveSegment: (delta) => this.moveCurrentSegment(delta),
    };
  }

  openLocalImport(presetAlbum?: AlbumInfo) {
    const albums = findAlbumNotes(this.app)
      .map((f) => getAlbumInfo(this.app, f, { coverFolder: this.settings.coverFolder }))
      .filter((a): a is AlbumInfo => !!a)
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    const snap = this.engine.snapshot();
    let preset = presetAlbum;
    if (!preset && snap.albumNotePath) {
      preset = albums.find((a) => a.path === snap.albumNotePath);
    }
    new LocalImportModal(this.app, this.importCtx(), albums, preset).open();
  }

  // 拖拽入库入口（专辑墙调用）：album 为 null 时从文件新建专辑；返回落库到的笔记路径，供墙描边新卡片
  async importAudioFromFiles(
    files: File[],
    album: AlbumInfo | null,
    rootName = ''
  ): Promise<string | null> {
    // 拖入的是文件夹 → 按「一张专辑一个文件夹」分析（音乐库根目录会被拦下）
    const scan = rootName
      ? analyzeFolder(
          rootName,
          files.map((f) => ({ file: f, relPath: relPathOf(f) }))
        )
      : null;
    if (scan?.verdict === 'library') {
      notice(tf('notice.libraryRoot', { hint: libraryRootHint(scan) }));
      return null;
    }
    // 不支持的格式单独提示（静默忽略时拖进来没反应，用户不知道为什么）
    const { audio: pickedAudio, skipped } = splitAudioFiles(files);
    const audioFiles = scan ? scan.files : pickedAudio;
    if (!scan && skipped.length) notice(skippedFormatsText(skipped.map((f) => f.name)));
    if (!audioFiles.length) {
      if (scan) notice(t('notice.noSupportedAudio'));
      return null;
    }
    try {
      let target = album;
      if (!target) {
        target = await createAlbumFromFiles(
          this.importCtx(),
          audioFiles,
          scan?.rootName,
          this.settings.importMode
        );
        if (!target) {
          notice(t('notice.createAlbumFailed'));
          return null;
        }
      }
      const mode = this.settings.importMode;
      const res = await importLocalAudio(this.importCtx(), target, audioFiles, mode);
      if (!res.added.length) {
        notice(
          res.skippedExisting.length
            ? t('notice.nothingToImportExisting')
            : t('notice.nothingToImport')
        );
        return null;
      }
      notice(
        tf('notice.imported', {
          n: res.added.length,
          title: target.title,
          mode: mode === 'copy' ? t('import.modeCopyShort') : t('import.modeLinkShort'),
        }) +
          (res.skippedExisting.length
            ? tf('notice.importedSkipped', { n: res.skippedExisting.length })
            : '') +
          (res.fallback ? t('notice.importFallback') : '')
      );
      return target.path;
    } catch (e) {
      notice(tf('notice.importFailed', { msg: (e as Error).message }));
      return null;
    }
  }

  // ============ 删除专辑 ============

  // 专辑墙右键「删除专辑…」入口：资产盘点 + 二次确认在弹窗内完成
  openDeleteAlbum(album: AlbumInfo) {
    new DeleteAlbumModal(this.app, this, album).open();
  }

  // 专辑墙「批量删除」入口（选择模式 → 确认弹窗）；onDeleted 供视图在删完后退出选择模式
  openDeleteAlbums(albums: AlbumInfo[], onDeleted?: () => void) {
    new DeleteBatchModal(this.app, this, albums, onDeleted).open();
  }

  // 执行删除：历史快照 → 连带资产（可选）→ 笔记 → 播放态复位。单张与批量共用这一条路径 ——
  // 批量时同批专辑互相视为「不存在」，共用的音频目录才不会被误判成「还有别张在用」（见
  // collectAlbumBatchDeleteTargets）。
  async deleteAlbums(albums: AlbumInfo[], opts: { audio: boolean; cover: boolean }) {
    if (!albums.length) return;
    // 统计是历史，不应随专辑删除：先保留封面副本和 YAML，日后可从统计页重建。
    for (const album of albums) await this.captureDeletedAlbum(album);
    const targets = collectAlbumBatchDeleteTargets(this.app, albums);
    const removed = await deleteAlbumBatchAssets(this.app, targets, opts);
    for (const album of albums) {
      // 笔记可能已被外部删除/改名（卡片是快照）→ 存在才删，其余清理照旧
      if (this.app.vault.getAbstractFileByPath(album.path) instanceof TFile) {
        await this.app.fileManager.trashFile(album.file);
      }
    }
    await this.saveSettings();
    const current = this.engine.snapshot().albumNotePath;
    if (current && albums.some((a) => a.path === current)) this.engine.clear();
    const assets = removed ? tf('notice.albumDeletedAssets', { n: removed }) : '';
    notice(
      albums.length === 1
        ? tf('notice.albumDeleted', { title: albums[0].title }) + assets
        : tf('notice.albumsDeleted', { n: albums.length }) + assets
    );
  }

  async deleteAlbum(album: AlbumInfo, opts: { audio: boolean; cover: boolean }) {
    await this.deleteAlbums([album], opts);
  }

  // 感想联动：在目标专辑笔记正文末尾追加时间戳条目并定位光标。albumPath 缺省 = 正在播放的那张
  //（命令面板等旧入口）；队列里每张专辑的小按钮会传自己的路径。
  async appendListeningNote(albumPath?: string) {
    const snap = this.engine.snapshot();
    const target = albumPath || snap.albumNotePath;
    const file = target ? this.app.vault.getAbstractFileByPath(target) : null;
    if (!(file instanceof TFile)) {
      notice(t('notice.noAlbumNote'));
      return;
    }
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
    // 行里的曲名只有「正在播这张专辑」时才有意义；否则退回专辑名（笔记文件名即专辑名）
    const playingThis = !!snap.albumNotePath && snap.albumNotePath === target;
    const title = playingThis ? snap.current?.title ?? '' : file.basename;
    // 位置写成可点的链接（obsidian://vinyl-life）：日后从笔记里点回来，直接续上那一刻
    const position = playingThis && snap.current
      ? ` · [${fmtTime(snap.currentTime)}](${this.resumeLink(target, snap.current.title, snap.currentTime)})`
      : '';
    const line = tf('note.listeningLine', { ts, title, position });
    // 走 process（读改写是原子的）：read + modify 两步之间，编辑器里敲的字（约 2 秒防抖）或同一篇
    // 笔记的另一次追加都会被后一次写回整篇盖掉 —— 而「边听边写感想」正是主路径。
    try {
      await this.app.vault.process(file, (content) => {
        return content.trimEnd() + (content.trim() ? '\n\n' : '') + line + '\n';
      });
    } catch (e) {
      // 写不进去（占用 / 磁盘满 / 权限）必须说出来：记录是用户手动触发的，静默失败会让他以为写上了
      notice(tf('notice.appendFailed', { name: file.basename, msg: (e as Error).message }));
      return;
    }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    const editor = (leaf.view as { editor?: Editor }).editor;
    if (editor) {
      const lastLine = editor.lastLine();
      editor.setCursor({ line: lastLine, ch: editor.getLine(lastLine).length });
    }
    notice(tf('notice.appended', { name: file.basename }));
  }

  /** 笔记里那条播放位置的链接：点一下回到那首歌的那一秒。走 Obsidian 的协议处理器
   *  （obsidian://vinyl-life?…），笔记被同步到别的设备也照样能用。 */
  resumeLink(albumPath: string, trackTitle: string, posSec: number): string {
    const q = (v: string | number) => encodeURIComponent(String(v));
    return (
      `obsidian://vinyl-life?album=${q(albumPath)}` +
      `&track=${q(trackTitle)}&pos=${Math.max(0, Math.floor(posSec))}`
    );
  }

  /** 健康检查的「重试并清除」：按那条失败记录的音源策略再试一次。成功（能建出队列 / 拿到地址）
   *  返回 null，失败返回错误文本。 */
  async retryAlbumSource(album: AlbumInfo, source: ActiveSource | 'auto'): Promise<string | null> {
    if (source === 'netease' || source === 'qq' || source === 'kugou') {
      return this.checkOnlineSource(album, source);
    }
    try {
      const result = await buildAlbumQueue({ ...album, sourcePref: source === 'auto' ? 'auto' : 'local' }, {
        local: this.local, netease: this.netease, qq: this.qq, kugou: this.kugou,
        defaultSource: this.settings.defaultSource,
      });
      return result.tracks.length ? null : result.reason || t('player.noPlayableTrack');
    } catch (e) {
      return (e as Error).message;
    }
  }

  /** 从笔记里的时间点跳回播放：载入那张专辑、按曲名定位、跳到那一刻并开始播。
   *  参数全来自笔记正文（用户可能手改过），一律当脏数据校验。 */
  async resumeFromNote(params: Record<string, string>): Promise<void> {
    // 协议处理器给的是已解码的值；手写的链接可能是编码过的，兜一次解码
    const rawAlbum = String(params?.album || '');
    const albumPath = (rawAlbum.includes('%') ? safeDecode(rawAlbum) : rawAlbum).trim();
    const trackTitle = String(params?.track || '').trim();
    const pos = Number(params?.pos);
    const file = albumPath ? this.app.vault.getAbstractFileByPath(albumPath) : null;
    const album = file instanceof TFile
      ? getAlbumInfo(this.app, file, { coverFolder: this.settings.coverFolder })
      : null;
    if (!album) {
      notice(t('notice.jumpNoAlbum'));
      return;
    }
    const result = await this.engine.loadAlbum(album, { autoplay: false });
    if (!result.tracks.length) {
      notice(tf('notice.jumpNoTrack', { title: album.title }));
      return;
    }
    const queue = this.engine.snapshot().queue;
    const found = trackTitle ? pickTrackByTitle(queue, trackTitle) : queue[0];
    const index = found ? queue.indexOf(found) : -1;
    if (index < 0) {
      notice(tf('notice.jumpNoTrack', { title: trackTitle || album.title }));
      return;
    }
    await this.engine.preloadIndex(index, Number.isFinite(pos) && pos > 0 ? pos : 0);
    await this.engine.play();
    await this.openPlayer();
  }

  // 插入此刻正在听：往当前编辑器光标处插一行曲目信息（只动编辑器、不碰文件 —— 与上面的
  // appendListeningNote 是两件事，那个写专辑笔记正文末尾）。成功不弹通知（肉眼可见），只在失败时提示。
  insertNowPlaying() {
    const snap = this.engine.snapshot();
    const track = snap.current;
    if (!track) {
      notice(t('notice.nothingPlaying'));
      return;
    }
    // 焦点可能在设置页 / 其他视图（没有可编辑的 Markdown 编辑器）→ 提示，别静默吞掉
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      notice(t('notice.noActiveNote'));
      return;
    }
    // 专辑名优先取专辑笔记标题（队列加载后一定有），收藏类队列退回曲目自带的专辑名；
    // 链接在调用处拼好（模板本身不变）
    const album = albumWikiLink(snap.albumNotePath, snap.albumTitle || track.album || '');
    const line = tf('notice.nowPlayingLine', { album, track: track.title });
    view.editor.replaceSelection(line + '\n');
  }

  /** 保存队列为笔记：写出来的曲目列表**就是**队列本身（不再藏 JSON 标记） */
  async saveQueueNote(): Promise<TFile | null> {
    const tracks = this.engine.snapshot().queue;
    const lines = queueNoteLines(tracks, albumWikiLink);
    if (!lines.length) { notice(t('queueNote.empty')); return null; }
    const folder = normalizePath(this.settings.queueFolder);
    await ensureFolder(this.app, folder);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = normalizePath(`${folder}/Vinyl queue ${stamp}.md`);
    const content = [
      '---',
      'tags: [vinyl-queue]',
      '---',
      '',
      `# ${t('queueNote.heading')}`,
      '',
      t('queueNote.hint'),
      '',
      ...lines,
      '',
    ].join('\n');
    const file = await this.app.vault.create(target, content);
    await this.app.workspace.getLeaf(false).openFile(file);
    notice(tf('queueNote.saved', { path: file.path }));
    return file;
  }

  /** 从当前笔记载入队列：按可见列表逐行还原（改列表即改队列，见 core/queue-note） */
  async loadQueueFromActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) { notice(t('queueNote.openFirst')); return; }
    const entries = parseQueueEntries(await this.app.vault.read(file));
    if (!entries.length) { notice(t('queueNote.badFile')); return; }
    const tracks: Track[] = [];
    const skipped: string[] = [];
    // 每张专辑解析出来的曲目缓存（同一张专辑在列表里出现多次时不重复请求）
    const cache = new Map<string, Track[]>();
    for (const entry of entries) {
      const albumFile = this.app.vault.getAbstractFileByPath(entry.albumPath);
      const album = albumFile instanceof TFile
        ? getAlbumInfo(this.app, albumFile, { coverFolder: this.settings.coverFolder })
        : null;
      if (!album) { skipped.push(entry.trackTitle); continue; }
      // 队列可能混着来源（本地 + 在线）：按「这张笔记实际会用的音源」优先，再依次试其余已关联的
      //（旧口径靠隐藏标记里的来源键，已废 —— 现在以「能不能找到这首」为准）
      const sources = detectAlbumSources(this.app, album);
      const order: ActiveSource[] = [];
      const preferred = this.settings.defaultSource !== 'auto' ? this.settings.defaultSource : null;
      for (const candidate of [
        album.sourcePref !== 'auto' ? album.sourcePref : null,
        preferred,
        'local',
        'netease',
        'qq',
        'kugou',
      ] as Array<ActiveSource | null>) {
        if (candidate && sources[candidate] && !order.includes(candidate)) order.push(candidate);
      }
      let found: Track | undefined;
      for (const source of order) {
        const key = `${album.path}:${source}`;
        let albumTracks = cache.get(key);
        if (!albumTracks) {
          try {
            const result = await buildAlbumQueue({ ...album, sourcePref: source }, {
              local: this.local, netease: this.netease, qq: this.qq, kugou: this.kugou,
              defaultSource: this.settings.defaultSource,
            });
            albumTracks = result.tracks;
          } catch { albumTracks = []; }
          cache.set(key, albumTracks);
        }
        found = pickTrackByTitle(albumTracks, entry.trackTitle);
        if (found) break;
      }
      if (found) tracks.push(found);
      else skipped.push(entry.trackTitle);
    }
    if (!tracks.length) { notice(t('queueNote.nonePlayable')); return; }
    const first = tracks[0];
    const source: ActiveSource = first.source === 'local-vault' || first.source === 'local-external'
      ? 'local' : first.source;
    this.engine.setQueue(tracks, first.albumNotePath || '', first.album || '', source);
    this.settings.queueMode = true;
    await this.saveSettings();
    await this.engine.preloadIndex(0);
    await this.openPlayer();
    notice(tf('queueNote.loaded', { loaded: tracks.length, skipped: skipped.length }));
    // 跳过的是哪几首：只报数用户没法修（歌名对不上要靠改列表或补音源）
    if (skipped.length) notice(tf('queueNote.skippedList', { titles: skipped.slice(0, 5).join('、') }));
  }

  recordPlay(track: Track, albumPath?: string, albumTitle?: string) {
    let snapshot: AlbumStatSnapshot | undefined;
    if (albumPath) {
      const file = this.app.vault.getAbstractFileByPath(albumPath);
      const album = file instanceof TFile
        ? getAlbumInfo(this.app, file, { coverFolder: this.settings.coverFolder })
        : null;
      if (album) snapshot = this.albumStatSnapshot(album);
    }
    this.settings.stats = recordTrackPlay(
      this.settings.stats,
      trackKey(track),
      albumPath,
      albumTitle,
      track.title,
      snapshot
    );
    // 连续使用中也会到上限（或有超期明细）：与启动时同一条「先归档、再裁剪」流程
    this.maybeRetainEvents();
    this.scheduleStatsSave();
  }

  private trackSourceHealth(s: PlayerSnapshot): void {
    const track = s.current;
    if (!track || !s.albumNotePath) return;
    const source: ActiveSource = track.source === 'local-vault' || track.source === 'local-external'
      ? 'local' : track.source;
    const key = `${s.albumNotePath}:${source}`;
    if (s.status === 'playing') {
      if (this.settings.sourceFailures[key] || this.settings.sourceFailures[`${s.albumNotePath}:auto`]) {
        delete this.settings.sourceFailures[key];
        delete this.settings.sourceFailures[`${s.albumNotePath}:auto`];
        this.scheduleStatsSave();
      }
      this.lastReportedSourceFailure = '';
      return;
    }
    if (s.status !== 'error' || !s.error || this.lastReportedSourceFailure === `${key}:${s.error}`) return;
    this.lastReportedSourceFailure = `${key}:${s.error}`;
    this.settings.sourceFailures[key] = { message: s.error, at: Date.now() };
    this.scheduleStatsSave();
    const file = this.app.vault.getAbstractFileByPath(s.albumNotePath);
    const album = file instanceof TFile ? getAlbumInfo(this.app, file) : null;
    if (!album) return;
    const sources = detectAlbumSources(this.app, album);
    if (!Object.entries(sources).some(([name, available]) => available && name !== source)) return;
    const prompt = new Notice('', 12000);
    prompt.messageEl.createSpan({ text: `${t('health.switchPrompt')} ` });
    prompt.messageEl.createEl('button', { text: t('health.switch') }).onclick = () => {
      prompt.hide();
      this.openSourceSwitch(album.path, source);
    };
  }

  private reportAlbumSourceFailure(album: AlbumInfo, policy: string, reason: string): void {
    this.settings.sourceFailures[`${album.path}:${policy}`] = { message: reason, at: Date.now() };
    this.scheduleStatsSave();
    const sources = detectAlbumSources(this.app, album);
    if (Object.values(sources).filter(Boolean).length < 2) return;
    const prompt = new Notice('', 12000);
    prompt.messageEl.createSpan({ text: `${t('health.switchPrompt')} ` });
    prompt.messageEl.createEl('button', { text: t('health.switch') }).onclick = () => {
      prompt.hide();
      this.openSourceSwitch(album.path);
    };
  }

  openLibraryHealth(): void {
    new LibraryHealthModal(this).open();
  }

  openSourceSwitch(albumPath: string, exclude?: ActiveSource): void {
    new SourceSwitchModal(this, albumPath, exclude).open();
  }

  async switchAlbumSource(albumPath: string, source: ActiveSource): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(albumPath);
    if (!(file instanceof TFile)) return false;
    const album = getAlbumInfo(this.app, file, { coverFolder: this.settings.coverFolder });
    if (!album) return false;
    this.pendingSourceSwitch = { path: albumPath, source };
    try {
      const res = await this.engine.loadAlbum(album, { source });
      if (!res.tracks.length) { this.pendingSourceSwitch = null; return false; }
      await this.openPlayer();
      return true;
    } catch (e) {
      this.pendingSourceSwitch = null;
      notice((e as Error).message);
      return false;
    }
  }

  /** 用户主动发起的在线检查：只取少量曲目的播放地址，不启动播放。 */
  async checkOnlineSource(album: AlbumInfo, source: Exclude<ActiveSource, 'local'>): Promise<string | null> {
    // 取流按 PROBE_QUALITY（最低档）而不是用户设置的音质：这里只问「拿不拿得到地址」，而取流是
    // 逐级降档的 —— 按无损试，没会员的账号会把四档全走一遍（QQ 还要再 ×2 个 mid）。整段过程另给
    // 上游请求加最小间隔（试播是唯一会成串打平台的路径，见 core/probe-pacing）。
    setUpstreamPacing(PROBE_REQUEST_GAP_MS);
    try {
      const result = await buildAlbumQueue({ ...album, sourcePref: source }, {
        local: this.local, netease: this.netease, qq: this.qq, kugou: this.kugou,
        defaultSource: this.settings.defaultSource,
      });
      if (!result.tracks.length) return result.reason || t('player.noPlayableTrack');
      let error = '';
      for (const track of result.tracks.slice(0, 3)) {
        try {
          const response = track.source === 'netease'
            ? await this.netease.songUrl(track.id, PROBE_QUALITY)
            : track.source === 'qq'
              ? await this.qq.songUrl(track.id, PROBE_QUALITY, track.mediaMid)
              : track.source === 'kugou'
                ? await this.kugou.songUrl(track.id, PROBE_QUALITY, track.albumId, track.albumAudioId)
                : null;
          if (response?.url) return null;
          error = response?.restriction || t('auth.sourceUnavailable');
        }
        catch (e) { error = (e as Error).message; }
      }
      return error || t('player.noPlayableTrack');
    } catch (e) {
      return (e as Error).message;
    } finally {
      setUpstreamPacing(0); // 关掉：播放、搜索、导入照旧不受节流（异常 / 提前 return 也要关）
    }
  }

  /** 歌词：同一首只取一次（在途去重，来回翻面、切回来都不重复打网）。
   *  返回 null = 这首歌没有歌词（上游没收录，对在线源是稳定结论，照样进缓存）或这次没取到
   *  （网络 / 上游故障，也返回 null 但**不进缓存**，下次翻回歌词页还能再试一次）。
   *  本地音轨两侧都不进缓存：歌词是与音频同目录的旁挂文件，用户随时可能补一个或改一个，
   *  而读它只是一次目录扫描 + 一次文件读，不值得让新歌词要重启才认。 */
  async loadLyrics(track: Track): Promise<LyricLine[] | null> {
    const key = trackKey(track);
    const local = isLocalTrack(track);
    if (!local && this.lyricsCache.has(key)) return this.lyricsCache.get(key) ?? null;
    const inflight = this.lyricsInflight.get(key);
    if (inflight !== undefined) return inflight; // 显式比 undefined：Promise 不进真值判断（lint 要求）
    const job = (async (): Promise<LyricLine[] | null> => {
      try {
        const lines = await this.fetchLyrics(track);
        if (!local) this.rememberLyrics(key, lines);
        return lines;
      } catch (e) {
        console.warn('[vinyl] 歌词获取失败：' + ((e as Error).message || String(e)));
        return null;
      } finally {
        this.lyricsInflight.delete(key);
      }
    })();
    this.lyricsInflight.set(key, job);
    return job;
  }

  private async fetchLyrics(track: Track): Promise<LyricLine[] | null> {
    let lines: LyricLine[] = [];
    if (track.source === 'netease') {
      const body = await this.netease.lyric(track.id);
      lines = parseLrc(body?.lrc?.lyric ?? '', body?.tlyric?.lyric ?? '');
    } else if (track.source === 'qq') {
      const body = await this.qq.lyric(String(track.id));
      lines = parseLrc(body?.lyric ?? '', body?.trans ?? '');
    } else if (track.source === 'kugou') {
      // 关键词与时长由网关用来挑候选（酷狗的歌词是「按歌搜词」而不是「按 id 取词」）
      const body = await this.kugou.lyric(track.id, {
        title: track.title,
        artist: track.artist,
        duration: track.duration,
        albumAudioId: track.albumAudioId,
      });
      lines = parseLrc(body?.lyric ?? '', body?.trans ?? '');
    } else if (isLocalTrack(track)) {
      // 本地：与音频同目录的旁挂 .lrc；没有就是没有（不读内嵌歌词，见 local-source 的取舍）
      const lrc = await this.local.readSidecarLyrics(track);
      lines = lrc ? parseLrc(lrc) : [];
    }
    return lines.length ? lines : null;
  }

  private rememberLyrics(key: string, lines: LyricLine[] | null): void {
    if (this.lyricsCache.size >= LYRICS_CACHE_MAX) {
      const drop = Math.ceil(LYRICS_CACHE_MAX / 2);
      let i = 0;
      for (const k of this.lyricsCache.keys()) {
        this.lyricsCache.delete(k);
        if (++i >= drop) break;
      }
    }
    this.lyricsCache.set(key, lines);
  }

  private albumStatSnapshot(album: AlbumInfo): AlbumStatSnapshot {
    const coverFile = this.albumCoverFile(album);
    return {
      title: album.title,
      artist: album.artist,
      edition: album.edition,
      year: album.year,
      genre: album.genre,
      rating: album.rating,
      cover: album.cover,
      coverRaw: album.coverRaw,
      coverVaultPath: coverFile?.path,
      neteaseId: album.neteaseId,
      qqId: album.qqId,
      kugouId: album.kugouId,
      audioFolderRef: album.audioFolderRef,
      audioRefs: [...album.audioRefs],
      sourcePref: album.sourcePref,
      displayProps: { ...album.displayProps },
    };
  }

  private albumCoverFile(album: AlbumInfo): TFile | null {
    if (album.coverRaw && !/^https?:\/\//i.test(album.coverRaw) && !/^#[0-9a-f]{3,8}$/i.test(album.coverRaw)) {
      const hit = this.app.metadataCache.getFirstLinkpathDest(stripWikilink(album.coverRaw), album.path);
      if (hit instanceof TFile) return hit;
    }
    return findConventionCover(
      this.app,
      album.file,
      album.audioFolderRef,
      this.settings.coverFolder
    );
  }

  private historyCoverName(albumPath: string, extension: string): string {
    let hash = 2166136261;
    for (let i = 0; i < albumPath.length; i++) {
      hash ^= albumPath.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `.stats-covers/${(hash >>> 0).toString(16)}.${extension || 'jpg'}`;
  }

  private async captureDeletedAlbum(album: AlbumInfo): Promise<void> {
    const stat = this.settings.stats.albums[album.path];
    if (!stat) return;
    const snapshot = { ...stat.snapshot, ...this.albumStatSnapshot(album) };
    try {
      const text = await this.app.vault.read(album.file);
      snapshot.frontmatter = text.match(/^---\r?\n[\s\S]*?\r?\n---/)?.[0];
    } catch {
      // 笔记已被外部删除时仍保留已有快照。
    }
    const coverFile = this.albumCoverFile(album);
    if (coverFile) {
      try {
        const rel = this.historyCoverName(album.path, coverFile.extension);
        const dest = pluginAbsPath(this, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(await this.app.vault.readBinary(coverFile)));
        snapshot.cachedCover = rel;
        snapshot.coverVaultPath = coverFile.path;
      } catch (e) {
        console.warn('[vinyl] 保留历史封面失败', e);
      }
    }
    stat.snapshot = snapshot;
  }

  statsCoverSrc(snapshot: AlbumStatSnapshot | undefined): string | undefined {
    if (!snapshot) return undefined;
    if (snapshot.cachedCover) {
      const rel = normalizePath(`${this.app.vault.configDir}/${this.manifest.dir}/${snapshot.cachedCover}`);
      return this.app.vault.adapter.getResourcePath(rel);
    }
    return snapshot.cover;
  }

  async playAlbumFromStats(albumPath: string, cardEl: HTMLElement | null = null): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(albumPath);
    if (!(file instanceof TFile)) return false;
    const album = getAlbumInfo(this.app, file, { coverFolder: this.settings.coverFolder });
    if (!album) return false;
    await this.handoff.handoff(album, cardEl);
    return true;
  }

  async restoreAlbumFromStats(albumPath: string): Promise<boolean> {
    if (this.app.vault.getAbstractFileByPath(albumPath) instanceof TFile) return true;
    const snapshot = this.settings.stats.albums[albumPath]?.snapshot;
    if (!snapshot) {
      notice(t('stats.restoreUnavailable'));
      return false;
    }
    try {
      const parent = albumPath.split('/').slice(0, -1).join('/');
      if (parent) await ensureFolder(this.app, parent);
      let frontmatter = snapshot.frontmatter;
      if (!frontmatter) {
        const lines = ['---', 'tags: [album]'];
        const add = (key: string, value: string | number | undefined) => {
          if (value !== undefined && value !== '') lines.push(`${key}: ${JSON.stringify(value)}`);
        };
        add('artist', snapshot.artist);
        add('edition', snapshot.edition);
        add('year', snapshot.year);
        add('genre', snapshot.genre);
        add('rating', snapshot.rating);
        add('cover', snapshot.coverRaw);
        add('neteaseId', snapshot.neteaseId);
        add('qqId', snapshot.qqId);
        add('kugouId', snapshot.kugouId);
        add('audioFolder', snapshot.audioFolderRef);
        if (snapshot.audioRefs?.length) {
          lines.push('audio:');
          for (const ref of snapshot.audioRefs) lines.push(`  - ${JSON.stringify(ref)}`);
        }
        if (snapshot.sourcePref && snapshot.sourcePref !== 'auto') add('source', snapshot.sourcePref);
        lines.push('---');
        frontmatter = lines.join('\n');
      }
      if (snapshot.cachedCover && snapshot.coverVaultPath) {
        const existing = this.app.vault.getAbstractFileByPath(snapshot.coverVaultPath);
        if (!existing) {
          const coverParent = snapshot.coverVaultPath.split('/').slice(0, -1).join('/');
          if (coverParent) await ensureFolder(this.app, coverParent);
          const bytes = fs.readFileSync(pluginAbsPath(this, snapshot.cachedCover));
          const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          await this.app.vault.createBinary(snapshot.coverVaultPath, data);
        }
      }
      await this.app.vault.create(
        albumPath,
        `${frontmatter}\n\n# ${snapshot.title}\n\n${t('import.reflectionHeading')}\n`
      );
      notice(tf('stats.restoredNotice', { title: snapshot.title }));
      return true;
    } catch (e) {
      notice(tf('stats.restoreFailed', { msg: (e as Error).message }));
      return false;
    }
  }

  /** 重命名专辑笔记（或整个文件夹）时，把以「笔记路径」为键的两张表一起搬过去（文件夹按前缀整段搬）。
   *  不搬的话：统计页会把这张专辑显示成「已移除」，点「恢复」会在**旧路径**重建一篇带 album 标签的
   *  笔记 —— 墙上凭空多一张重复专辑、播放次数拆成两笔；而 sourceFailures 里那条以旧路径为键的
   *  记录既不显示也不清除，永久留在 data.json 里。 */
  private migrateAlbumKeys(oldPath: string, newPath: string): void {
    if (!oldPath || oldPath === newPath) return;
    const under = (key: string) => key === oldPath || key.startsWith(oldPath + '/');
    const move = <T>(table: Record<string, T>): number => {
      let n = 0;
      for (const key of Object.keys(table)) {
        if (!under(key)) continue;
        const target = newPath + key.slice(oldPath.length);
        if (target === key || table[target] !== undefined) continue; // 目标已有记录：不覆盖
        table[target] = table[key];
        delete table[key];
        n++;
      }
      return n;
    };
    // 两次 rename 事件（文件夹一次、其中的文件各一次）谁先到都成立：搬过的键第二次找不到了
    const moved = move(this.settings.stats.albums) + move(this.settings.sourceFailures);
    if (moved) void this.saveSettings();
  }

  async clearPlaybackStats(): Promise<void> {
    // 恢复备份之后到重启之前，saveSettings 是早退的（见它的第一行）：而这里会先把历史封面缓存
    // 从盘上删掉、统计却写不回去 —— 重启后统计「复活」而封面副本已没了（破图，且再也补不回）。
    // 所以写盘恢复之前，这一步一律不执行。
    if (this.awaitingRestartAfterRestore) {
      notice(t('data.writePausedAfterRestore'));
      return;
    }
    this.settings.stats = ensureStats(null);
    const cache = pluginAbsPath(this, '.stats-covers');
    try {
      if (path.basename(cache) === '.stats-covers') fs.rmSync(cache, { recursive: true, force: true });
    } catch (e) {
      console.warn('[vinyl] 清理历史封面失败', e);
    }
    await this.saveSettings();
  }

  async exportPlaybackStats(): Promise<TFile> {
    const stats = this.settings.stats;
    const now = new Date();
    const day = localDayKey(now.getTime());
    const folder = normalizePath(this.settings.statsFolder);
    await ensureFolder(this.app, folder);
    const baseName = tf('stats.exportFile', { date: day });
    let target = normalizePath(`${folder}/${baseName}.md`);
    let i = 2;
    while (this.app.vault.getAbstractFileByPath(target)) {
      target = normalizePath(`${folder}/${baseName} (${i++}).md`);
    }
    const file = await this.app.vault.create(target, this.statsNoteLines(stats).join('\n'));
    notice(tf('stats.exportedNotice', { path: target }));
    return file;
  }

  /** 可随笔记库同步的完整设置与统计快照；登录凭据另存，不包含在内。 */
  async exportDataBackup(): Promise<TFile> {
    const file = await this.writeBackupFile('Vinyl Life backup', this.settings.stats);
    // 手动备份也算「最近成功备份」：历史页显示的时间是两者的最近一次
    this.settings.lastBackupAt = Date.now();
    await this.saveSettings();
    return file;
  }

  /** 每周自动备份：到点了写一份，并按保留份数清掉最旧的**自动**备份（手动备份与裁剪归档
   *  —— `Vinyl Life backup` / `Vinyl Life events archive` —— 一律不碰）。
   *  失败只提示一次且不更新「最近成功备份」，下次检查会再试。 */
  private async maybeAutoBackup(): Promise<void> {
    if (!this.settings.autoBackup || this.autoBackupFailedThisSession) return;
    // 这次启动没读出 data.json（已另存一份，见 readSettingsFile）：内存里是默认值，这份「自动备份」
    // 是空的，而 pruneAutoBackups 按份数留 —— 一裁就会挤掉上一份真正的好备份。本次会话不备份。
    if (this.dataQuarantined) return;
    const last = this.settings.lastBackupAt || 0;
    if (Date.now() - last < AUTO_BACKUP_INTERVAL_MS) return;
    try {
      await this.writeBackupFile(AUTO_BACKUP_PREFIX, this.settings.stats);
      this.settings.lastBackupAt = Date.now();
      await this.pruneAutoBackups();
      await this.saveSettings();
      notice(tf('notice.autoBackupDone', { path: this.backupFolderPath() + '/' }));
    } catch (e) {
      console.warn('[vinyl] 自动备份失败', e);
      this.autoBackupFailedThisSession = true;
      notice(tf('backup.failed', { msg: (e as Error).message }));
    }
  }

  /** 只保留最近 N 份自动备份（按文件名里的时间戳排序，时间戳是 ISO 格式，字典序即时间序） */
  private async pruneAutoBackups(): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(this.backupFolderPath());
    if (!(folder instanceof TFolder)) return;
    const keep = Math.max(1, Math.floor(this.settings.backupKeep || 1));
    const autos = folder.children
      .filter((c): c is TFile => c instanceof TFile && c.name.startsWith(AUTO_BACKUP_PREFIX))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const old of autos.slice(0, Math.max(0, autos.length - keep))) {
      try {
        await this.app.fileManager.trashFile(old); // 走 Obsidian 的删除方式（回收站 / 永久删除）
      } catch (e) {
        console.warn('[vinyl] 清理旧自动备份失败', old.path, e);
      }
    }
  }

  /** 备份目录（Backups 固定在专辑笔记目录的上一级；裁剪归档与自动备份都写这里） */
  backupFolderPath(): string {
    const root = this.settings.albumFolder.split('/').slice(0, -1).join('/') || 'Vinyl Life';
    return normalizePath(`${root}/Backups`);
  }

  /** 备份目录清单（份数 / 体积），给「数据管理」当只读状态行：只统计不清理 —— 手动备份与裁剪归档
   *  刻意不自动删（自动备份那部分见 pruneAutoBackups），但用户至少该看得见它在长大。 */
  backupInventory(): { count: number; bytes: number } {
    const folder = this.app.vault.getAbstractFileByPath(this.backupFolderPath());
    if (!(folder instanceof TFolder)) return { count: 0, bytes: 0 };
    let count = 0;
    let bytes = 0;
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === 'json') {
        count++;
        bytes += child.stat.size;
      }
    }
    return { count, bytes };
  }

  /** 写一份备份格式的 JSON：设置 + 指定统计快照 + 历史封面缓存。手动备份与「裁剪前归档」共用它
   *  —— 归档出来的文件能直接用「恢复备份」载回。 */
  private async writeBackupFile(prefix: string, stats: VinylStats): Promise<TFile> {
    const folder = this.backupFolderPath();
    await ensureFolder(this.app, folder);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let target = normalizePath(`${folder}/${prefix} ${stamp}.json`);
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(target)) {
      target = normalizePath(`${folder}/${prefix} ${stamp} (${suffix++}).json`);
    }
    const coverAssets: Record<string, string> = {};
    for (const stat of Object.values(stats.albums)) {
      const rel = stat.snapshot?.cachedCover;
      if (!rel || !STATS_COVER_NAME_RE.test(rel)) continue;
      try { coverAssets[rel] = fs.readFileSync(pluginAbsPath(this, rel)).toString('base64'); }
      catch { /* 图片已不存在：统计元数据仍能备份。 */ }
    }
    const content = JSON.stringify(
      { format: 'vinyl-life-backup', version: 1, settings: { ...this.settings, stats }, coverAssets },
      null,
      2
    );
    return this.app.vault.create(target, content);
  }

  /** 播放明细的保留流程：**先归档成功，才认裁剪结果** —— 归档写不出去（磁盘满 / 权限 / 同步冲突）
   *  就把完整明细留在内存里并提示，之后的保存会原样写回，绝不会「没归档、明细还被裁掉」；
   *  启动时与播放中（到达上限 / 有超期明细）共用这一条。
   *  归档是异步的而播放还在继续：期间 recordPlay 会往**同一个** events 数组里接着 push（原地 push、
   *  不换数组），故裁完不能拿发起前算好的 kept 整段替换 —— 会丢掉期间新记的明细（既不在归档文件
   *  里、也不在内存里）；收口时按「归档前留下的」+「归档后新来的全部」重新拼一次。 */
  private async retainEventsOrKeepAll(allEvents: PlayEvent[], kept: PlayEvent[]): Promise<void> {
    const dropped = allEvents.length - kept.length;
    if (dropped <= 0) return;
    const before = allEvents.length;
    const archived = await this.archivePrunedEvents(allEvents, dropped);
    if (!archived) {
      this.settings.stats = { ...this.settings.stats, events: allEvents };
      return;
    }
    // 数组整体被换掉过（恢复备份一类的路径）就没有「尾部新增」可言，按原口径收口
    const survivors =
      this.settings.stats.events === allEvents
        ? kept.concat(allEvents.slice(before))
        : kept;
    this.settings.stats = { ...this.settings.stats, events: survivors };
  }

  /** 播放中检查一次：到上限或有超期明细就走上面那条流程（归档失败只提示一次，下次启动再试）。 */
  private maybeRetainEvents(): void {
    if (this.archiveFailedThisSession) return;
    if (!needsRetention(this.settings.stats.events)) return;
    const { kept } = trimPlayEvents(this.settings.stats.events);
    void this.retainEventsOrKeepAll(this.settings.stats.events, kept);
  }

  /** 裁剪前的自动归档（见 loadSettings）。**返回值就是归档成功与否** —— 调用方据此决定保住还是
   *  丢掉未裁剪的明细：归档失败必须让用户知道，不能只是一行 console.warn。 */
  private async archivePrunedEvents(allEvents: PlayEvent[], dropped: number): Promise<boolean> {
    try {
      const file = await this.writeBackupFile('Vinyl Life events archive', {
        ...this.settings.stats,
        events: allEvents,
      });
      // 归档写完才把裁剪结果落盘：同一批明细不会在下次启动时再裁一遍 / 再归档一份
      await this.saveSettings();
      notice(tf('notice.eventsArchived', { n: dropped, path: file.path }));
      return true;
    } catch (e) {
      console.warn('[vinyl] 播放明细归档失败', e);
      // 一轮会话里只提醒一次：播放中可能反复触发，别每条播放都弹一个气泡
      if (!this.archiveFailedThisSession) {
        this.archiveFailedThisSession = true;
        notice(tf('notice.eventsArchiveFailed', { n: dropped, msg: (e as Error).message }));
      }
      return false;
    }
  }

  /** 恢复前由 UI 明确确认；先保存现状，旧备份始终可回退。 */
  async restoreDataBackup(raw: string): Promise<void> {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error(t('backup.badFormat'));
    const backup = parsed as { format?: unknown; version?: unknown; settings?: unknown; coverAssets?: unknown };
    if (backup.format !== 'vinyl-life-backup' || backup.version !== 1 ||
        !backup.settings || typeof backup.settings !== 'object' || Array.isArray(backup.settings)) {
      throw new Error(t('backup.badFormat'));
    }
    const restoredSettings = backup.settings as Record<string, unknown>;
    if (!restoredSettings.stats || typeof restoredSettings.stats !== 'object' ||
        typeof (restoredSettings.stats as Record<string, unknown>).totalPlays !== 'number') {
      throw new Error(t('backup.badFormat'));
    }
    await this.exportDataBackup();
    if (backup.coverAssets && typeof backup.coverAssets === 'object' && !Array.isArray(backup.coverAssets)) {
      const cache = pluginAbsPath(this, '.stats-covers');
      fs.mkdirSync(cache, { recursive: true });
      for (const [rel, encoded] of Object.entries(backup.coverAssets)) {
        if (!STATS_COVER_NAME_RE.test(rel) ||
            typeof encoded !== 'string' || encoded.length > 16_000_000) continue;
        fs.writeFileSync(path.join(cache, path.basename(rel)), Buffer.from(encoded, 'base64'));
      }
    }
    await this.saveData(backup.settings);
    await this.loadSettings();
    this.awaitingRestartAfterRestore = true;
    this.refreshLanguage();
    this.refreshAppearance();
    notice(t('backup.restartNotice'));
  }

  /** 专辑在导出笔记里的写法：笔记还在就给可点击链接，删了只报名字；单元格的管道交给 tableCell 转义。 */
  private albumCell(albumPath: string, stat: AlbumPlayStat): string {
    const title = stat.snapshot?.title || albumPath.split('/').pop()?.replace(/\.md$/, '') || albumPath;
    const exists = this.app.vault.getAbstractFileByPath(albumPath) instanceof TFile;
    return tableCell(exists ? albumWikiLink(albumPath, title) : tf('stats.exportRemoved', { title }));
  }

  /** 按卡片属性汇总（取值与统计页「自定义统计」同一套：笔记优先，其次历史快照）。属性多了笔记会
   *  很长，最多取前四个；某个属性一条数据都没有就整块略过。 */
  private statsNotePropBlocks(stats: VinylStats): string[] {
    const out: string[] = [];
    for (const prop of this.settings.shelfProps.slice(0, 4)) {
      const groups = new Map<string, { plays: number; albums: number }>();
      for (const [albumPath, stat] of Object.entries(stats.albums)) {
        const current = this.app.vault.getAbstractFileByPath(albumPath);
        const album = current instanceof TFile ? getAlbumInfo(this.app, current) : null;
        const value = album?.displayProps[prop] || stat.snapshot?.displayProps?.[prop];
        if (!value) continue;
        const group = groups.get(value) ?? { plays: 0, albums: 0 };
        group.plays += stat.plays;
        group.albums++;
        groups.set(value, group);
      }
      if (!groups.size) continue;
      const label = propLabel(prop, this.settings.shelfPropLabels);
      const max = Math.max(...Array.from(groups.values(), (g) => g.plays));
      out.push(`### ${label}`, '', tf('stats.exportPropsHead', { name: label }), '| --- | ---: | ---: | --- |');
      for (const [value, group] of Array.from(groups).sort((a, b) => b[1].plays - a[1].plays)) {
        out.push(`| ${tableCell(value)} | ${group.plays} | ${group.albums} | ${textBar(group.plays, max)} |`);
      }
      out.push('');
    }
    return out;
  }

  /** 专辑封面在笔记里的嵌入写法：只有**库内**文件或 http(s) 图能嵌（快照的缓存副本在插件目录，
   *  笔记够不着）；拿不到返回空串。 */
  private albumCoverEmbed(albumPath: string, stat: AlbumPlayStat): string {
    const current = this.app.vault.getAbstractFileByPath(albumPath);
    if (current instanceof TFile) {
      const album = getAlbumInfo(this.app, current);
      const file = album ? this.albumCoverFile(album) : null;
      if (file) return `![[${file.path}|120]]`;
      const raw = String(album?.coverRaw || '').trim();
      if (/^https?:\/\//i.test(raw)) return `![](${raw})`;
      return '';
    }
    const vaultPath = stat.snapshot?.coverVaultPath;
    return vaultPath && this.app.vault.getAbstractFileByPath(vaultPath) instanceof TFile
      ? `![[${vaultPath}|120]]`
      : '';
  }

  /** 导出笔记的正文，版式按「笔记里读着舒服」排：摘要做成 callout（Obsidian 会渲染成带图标的一块）
   *  且关键数字加粗；每个榜配一行字符柱状（页面是热力图，笔记里给等价的文字版）；播放最多的前五张
   *  给封面条（库内封面才嵌，嵌不到就略过）；末尾一段「关于这份统计」的 callout 说明口径与导出时间。 */
  private statsNoteLines(stats: VinylStats): string[] {
    const albumCount = Object.keys(stats.albums).length;
    const trackCount = Object.keys(stats.tracks).length;
    const daily = new Map<string, number>();
    for (const event of stats.events) {
      const key = localDayKey(event.at);
      daily.set(key, (daily.get(key) ?? 0) + 1);
    }
    const days = Array.from(daily.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const busiest = days.reduce<[string, number] | null>(
      (best, cur) => (!best || cur[1] > best[1] ? cur : best),
      null
    );
    const albums = Object.entries(stats.albums).sort((a, b) => b[1].plays - a[1].plays);

    // 不写 H1：笔记标题就是文件名
    const lines = [
      `> [!abstract] ${t('stats.exportTitle')}`,
      `> ${tf('stats.exportSummary', {
        plays: stats.totalPlays,
        albums: albumCount,
        tracks: trackCount,
        days: days.length,
      })}`,
    ];
    if (days.length && busiest) {
      lines.push(
        `> ${tf('stats.exportSpan', {
          first: days[0][0],
          last: days[days.length - 1][0],
          date: busiest[0],
          n: busiest[1],
        })}`
      );
    }
    lines.push('');

    if (days.length) {
      const months = new Map<string, number>();
      for (const [date, count] of days) {
        const month = date.slice(0, 7);
        months.set(month, (months.get(month) ?? 0) + count);
      }
      const rows = Array.from(months.entries()).sort((a, b) => b[0].localeCompare(a[0]));
      const max = Math.max(...rows.map(([, n]) => n));
      const total = rows.reduce((sum, [, n]) => sum + n, 0);
      lines.push(t('stats.exportMonthlyHeading'), '', t('stats.exportMonthlyHead'), '| --- | ---: | ---: | --- |');
      for (const [month, count] of rows) {
        const share = total ? `${Math.round((count / total) * 100)}%` : '';
        lines.push(`| ${month} | ${count} | ${share} | ${textBar(count, max)} |`);
      }
      lines.push('');
    }

    if (albums.length) {
      const max = albums[0][1].plays;
      lines.push(t('stats.exportTopHeading'), '', t('stats.exportTopHead'), '| ---: | --- | ---: | --- | --- |');
      albums.forEach(([albumPath, stat], index) => {
        const rank = index < 3 ? `**${index + 1}**` : String(index + 1); // 前三名加粗，扫一眼就找到
        lines.push(
          `| ${rank} | ${this.albumCell(albumPath, stat)} | ${stat.plays} | ${textBar(stat.plays, max)} | ${localDayKey(stat.lastPlayedAt)} |`
        );
      });
      lines.push('');

      // 封面条：前五张里能嵌的才列（嵌不到图的不占位置）
      const covers = albums
        .slice(0, 5)
        .map(([albumPath, stat]) => {
          const embed = this.albumCoverEmbed(albumPath, stat);
          if (!embed) return '';
          const title = stat.snapshot?.title || albumPath.split('/').pop()?.replace(/\.md$/, '') || albumPath;
          return `- ${embed} **${tableCell(title)}** · ${tf('stats.plays', { n: stat.plays })}`;
        })
        .filter(Boolean);
      if (covers.length) lines.push(`### ${t('stats.exportCovers')}`, '', ...covers, '');
    }

    const recent = [...albums].sort((a, b) => b[1].lastPlayedAt - a[1].lastPlayedAt).slice(0, 10);
    if (recent.length) {
      const max = Math.max(...recent.map(([, stat]) => stat.plays));
      lines.push(t('stats.exportRecentHeading'), '', t('stats.exportRecentHead'), '| --- | ---: | --- | --- |');
      for (const [albumPath, stat] of recent) {
        lines.push(
          `| ${this.albumCell(albumPath, stat)} | ${stat.plays} | ${textBar(stat.plays, max)} | ${localDayKey(stat.lastPlayedAt)} |`
        );
      }
      lines.push('');
    }

    const props = this.statsNotePropBlocks(stats);
    if (props.length) lines.push(t('stats.exportPropsHeading'), '', ...props);

    if (days.length) {
      const max = Math.max(...days.map(([, n]) => n));
      lines.push(t('stats.exportDailyHeading'), '', t('stats.exportDailyHead'), '| --- | ---: | --- |');
      for (const [date, count] of [...days].reverse()) {
        lines.push(`| ${date} | ${count} | ${textBar(count, max)} |`);
      }
      lines.push('');
    }

    lines.push(
      '---',
      '',
      `> [!note] ${t('stats.exportAbout')}`,
      `> ${t('stats.exportMigrationNote')}`,
      `> ${tf('stats.exportFooter', { time: new Date().toLocaleString() })}`,
      ''
    );
    return lines;
  }

  private statsSaveTimer: number | null = null;
  /** 这批待落盘改动是从什么时候开始攒的（0 = 没有攒着的改动）。为什么需要它：播放中 timeupdate
   *  每 400ms 就调一次 scheduleStatsSave，纯防抖永远等不到那 5 秒空闲 —— 崩溃或强杀会丢掉整场
   *  明细、音量与播放位置。所以从第一次改动起算满 STATS_SAVE_MAX_WAIT_MS 就强制写一次。 */
  private statsSaveSince = 0;
  private scheduleStatsSave() {
    const now = Date.now();
    if (!this.statsSaveSince) this.statsSaveSince = now;
    if (this.statsSaveTimer) window.clearTimeout(this.statsSaveTimer);
    const remaining = this.statsSaveSince + STATS_SAVE_MAX_WAIT_MS - now;
    this.statsSaveTimer = window.setTimeout(() => {
      this.statsSaveTimer = null;
      this.statsSaveSince = 0;
      void this.saveSettings();
    }, Math.max(0, Math.min(STATS_SAVE_DEBOUNCE_MS, remaining)));
  }

  // —— 专辑墙落位（主区：命令 / ribbon 都开在主区标签页）——
  async openShelf() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(SHELF_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: SHELF_VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  // —— 播放器落位（G2：侧栏 / 主区 / 独立窗口）——
  async openPlayer(location?: 'sidebar' | 'tab' | 'window') {
    const loc = location || this.settings.playerLocation;
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(PLAYER_VIEW_TYPE)[0];
    if (!leaf) {
      if (loc === 'window') {
        try {
          const popoutWorkspace = workspace as typeof workspace & {
            openPopoutLeaf(): WorkspaceLeaf;
          };
          leaf = popoutWorkspace.openPopoutLeaf();
        } catch {
          leaf = workspace.getLeaf('tab');
        }
      } else if (loc === 'tab') {
        leaf = workspace.getLeaf('tab');
      } else {
        leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf('tab');
      }
      await leaf.setViewState({ type: PLAYER_VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

}
