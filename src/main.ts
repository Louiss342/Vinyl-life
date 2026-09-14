// Vinyl Life —— 主入口：注册视图 / 命令 / 设置面板，装配服务层与播放引擎。
// 本地源（零后端）+ 网易云源（懒加载 Node 网关）统一为 Track 队列。
import { Editor, Plugin, TFile, MarkdownView, WorkspaceLeaf, normalizePath } from 'obsidian';
import {
  VinylSettings,
  DEFAULT_SETTINGS,
  VinylSettingTab,
  normalizeLastPlayback,
  normalizePlayMode,
  normalizeQueueOrder,
  normalizeVolume,
} from './settings';
import { ServerManager } from './core/server-manager';
import { installStyleFallback } from './core/style-fallback';
import { STYLE_GZIP } from './core/style-bundle';
import { ServerClient } from './core/server-client';
import { WebClient } from './core/web-client';
import { NeteaseService } from './core/netease';
import { Auth } from './core/auth';
import { BrowserLogin, QQ_BROWSER_LOGIN } from './core/browser-login';
import { QqService } from './core/qq';
import { QqAuth } from './core/qq-auth';
import { LocalSource } from './core/local-source';
import { PlaybackEngine } from './core/player-state';
import type { PlayerSnapshot } from './core/player-state';
import { syncMediaSession } from './core/media-session';
import { VinylPlayerView, PLAYER_VIEW_TYPE } from './views/player-view';
import { VinylShelfView, SHELF_VIEW_TYPE } from './views/shelf-view';
import { HandoffController } from './animation/handoff';
import { QrLoginModal, qqQrProvider } from './views/qr-login-modal';
import {
  AlbumInfo,
  getAlbumInfo,
  findAlbumNotes,
  setAlbumTemplatePath,
} from './core/album-index';
import { normalizeShelfProps, normalizeShelfPropLabels } from './core/shelf-props';
import { DISC_DIRECTIONS, SPIN_SPEEDS } from './core/disc-motion';
import { normalizeDeckStyle, normalizeRecordColor } from './core/appearance';
import {
  notice,
  pluginAbsPath,
  ensureFolder,
  splitAudioFiles,
  skippedFormatsText,
  analyzeFolder,
  relPathOf,
  libraryRootHint,
} from './util';
import {
  ImportContext,
  importLocalAudio,
  createAlbumFromFiles,
  DEFAULT_ALBUM_TEMPLATE,
} from './import';
import { AlbumImportModal, LocalImportModal } from './views/import-modal';
import { DeleteAlbumModal } from './views/delete-album-modal';
import { collectAlbumDeleteTargets, deleteAlbumAssets } from './delete';
import { WebLoginModal, qqWebProvider } from './views/web-login-modal';
import { setLanguage, t, tf } from './core/i18n';
import { ensureStats, recordTrackPlay } from './core/stats';
import { Track, trackKey } from './core/track';

// wikilink 里不能安全出现的字符：|（别名分隔）与 [ ]（链接定界）、换行。
// 专辑名理论上可能含「]]」，路径也可能被手改成怪样子 —— 这类值一律不硬塞进链接。
const WIKILINK_UNSAFE = /[|[\]\r\n]/;

/** 「插入此刻正在听」用：专辑名 → 可点击的 wikilink。
 *  有专辑笔记路径时生成 [[路径|专辑名]]（带别名：源码模式不至于太长，阅读时显示专辑名）；
 *  别名或路径含 wikilink 语法字符时不硬凑，逐级降级：
 *    别名不安全（空 / 含 | [ ] 换行）→ [[路径]]（仍可点开笔记，显示名 = 笔记文件名）；
 *    路径不安全或没有路径 → 纯专辑名（宁可不能点，也不生成 [[|名]] 这类坏链接）。 */
function albumWikiLink(path: string | undefined, title: string): string {
  const name = (title || '').trim();
  const p = (path || '').trim();
  const safePath = p && !WIKILINK_UNSAFE.test(p) ? p : '';
  const safeName = name && !WIKILINK_UNSAFE.test(name) ? name : '';
  if (safePath && safeName) return `[[${safePath}|${safeName}]]`;
  if (safePath) return `[[${safePath}]]`;
  return name;
}

export default class VinylLifePlugin extends Plugin {
  settings: VinylSettings = { ...DEFAULT_SETTINGS };
  server!: ServerManager;
  client!: ServerClient;
  web!: WebClient;
  netease!: NeteaseService;
  auth!: Auth;
  browserLogin!: BrowserLogin;
  qq!: QqService;
  qqAuth!: QqAuth;
  qqBrowserLogin!: BrowserLogin;
  local!: LocalSource;
  engine!: PlaybackEngine;
  handoff!: HandoffController;

  async onload() {
    // 样式兜底：手工安装漏掉 styles.css 时挂上构建期内联的副本（正常安装返回 null，什么都不做）
    const disposeStyleFallback = installStyleFallback(pluginAbsPath(this, 'styles.css'), STYLE_GZIP);
    if (disposeStyleFallback) this.register(disposeStyleFallback);

    await this.loadSettings();

    // 首次运行自动搭好目录结构（默认 Vinyl Life/{audio, covers, Vinyl Note}）：
    // 新装用户装完即用；已有目录不动，失败不阻塞加载（导入流程里还会再兜一次）
    await this.ensureDataFolders();

    // 服务层：网关（Cookie 通道）+ 网页直连（官方登录页会话）统一路由
    this.server = new ServerManager(this);
    this.client = new ServerClient(
      () => this.server.base,
      () => this.server.token
    );
    this.web = new WebClient(
      pluginAbsPath(this, '.anon-token'),
      pluginAbsPath(this, '.device-id')
    );
    this.netease = new NeteaseService(this.web, this.client, () => this.server.ensure(), () => this.server.lastError);
    this.auth = new Auth(this, this.server, this.client);
    this.browserLogin = new BrowserLogin(this.auth);
    this.register(() => this.browserLogin.dispose());
    this.qq = new QqService(
      () => this.server.base,
      () => this.server.token
    );
    this.qqAuth = new QqAuth(this, this.server, this.qq);
    this.qqBrowserLogin = new BrowserLogin(this.qqAuth, QQ_BROWSER_LOGIN);
    this.register(() => this.qqBrowserLogin.dispose());
    this.local = new LocalSource(this.app);

    // 播放引擎
    this.engine = new PlaybackEngine({
      app: this.app,
      local: this.local,
      netease: this.netease,
      qq: this.qq,
      settings: () => this.settings,
      onTrackPlay: (track, albumPath, albumTitle) =>
        this.recordPlay(track, albumPath, albumTitle),
      // 队列自定义顺序：读设置（没存过 = undefined，按原顺序播）/ 拖拽后写入并防抖落盘 /
      // 「恢复原有顺序」后删掉该专辑的条目（下一步再播这张专辑即回到自然顺序）
      savedOrder: (albumPath) => this.settings.queueOrder[albumPath],
      onQueueOrderChange: (albumPath, keys) => this.rememberQueueOrder(albumPath, keys),
      onQueueOrderClear: (albumPath) => this.forgetQueueOrder(albumPath),
      // 播放模式是持久设置：引擎启动时读一次，之后由引擎自己维护
      playMode: () => this.settings.playMode,
    });
    // 音量沿用上次（引擎默认 0.8，这里覆盖成用户自己的值）
    this.engine.setVolume(this.settings.volume);
    // 系统媒体键（媒体键 / 耳机按键 / 系统媒体面板）：挂在插件层，播放器关着也管用。
    // 顺带把「音量 + 播放位置」防抖落盘（与统计、队列顺序共用同一条 5 秒防抖）。
    this.engine.subscribe((s) => {
      syncMediaSession(s, {
        play: () => void this.engine.play(),
        pause: () => this.engine.pause(),
        next: () => void this.engine.next(),
        prev: () => void this.engine.prev(),
        seek: (ratio) => this.engine.seek(ratio),
      });
      this.rememberPlayback(s);
    });
    this.handoff = new HandoffController(this);

    // 视图与命令
    this.registerView(PLAYER_VIEW_TYPE, (leaf) => new VinylPlayerView(leaf, this));
    this.registerView(SHELF_VIEW_TYPE, (leaf) => new VinylShelfView(leaf, this));
    // 图标与播放器视图一致（disc-3），方便一眼认出是 Vinyl Life
    this.addRibbonIcon('disc-3', t('cmd.ribbonShelf'), () => this.openShelf());
    // 命令面板：日常 5 条常驻（open-shelf / open-player / import-netease / import-local /
    // insert-now-playing）；登录 / 退出这类维护命令收进 registerDebugCommands()，
    // 仅当「设置 → 通用 → 调试命令」打开时注册（改开关后需重载插件生效）。
    // 命令 id 不得改动（改了会让已绑定的快捷键失效）
    this.addCommand({
      id: 'open-shelf',
      name: t('cmd.openShelf'),
      callback: () => this.openShelf(),
    });
    this.addCommand({
      id: 'open-player',
      name: t('cmd.openPlayer'),
      callback: () => this.openPlayer(),
    });
    this.addCommand({
      id: 'import-netease',
      name: t('cmd.importAlbum'),
      callback: () => this.openAlbumImport(),
    });
    this.addCommand({
      id: 'import-local',
      name: t('cmd.importLocal'),
      callback: () => this.openLocalImport(),
    });
    this.addCommand({
      id: 'insert-now-playing',
      name: t('cmd.insertNowPlaying'),
      callback: () => this.insertNowPlaying(),
    });
    // 播放控制：给快捷键与命令面板用（媒体键另走 MediaSession，见引擎订阅）
    this.addCommand({
      id: 'player-toggle',
      name: t('player.playPause'),
      callback: () => void this.engine.toggle(),
    });
    this.addCommand({
      id: 'player-next',
      name: t('player.next'),
      callback: () => void this.engine.next(),
    });
    this.addCommand({
      id: 'player-prev',
      name: t('player.prev'),
      callback: () => void this.engine.prev(),
    });
    if (this.settings.debugCommands) this.registerDebugCommands();
    this.addSettingTab(new VinylSettingTab(this.app, this));

    // 恢复上次的队列位置（不自动播放）：放在最后，失败也不影响插件可用
    void this.restoreLastPlayback();

  }

  /** 维护类命令（默认不注册）：登录 / 退出。触发条件见 onload 里的 settings.debugCommands。 */
  registerDebugCommands() {
    this.addCommand({
      id: 'netease-login',
      name: t('cmd.neteaseLogin'),
      callback: () => this.openLogin(),
    });
    this.addCommand({
      id: 'netease-web-login',
      name: t('cmd.neteaseWebLogin'),
      callback: () => new WebLoginModal(this.app, { auth: this.auth, browserLogin: this.browserLogin }).open(),
    });
    this.addCommand({
      id: 'qq-login',
      name: t('cmd.qqLogin'),
      callback: () => this.openQqLogin(),
    });
    this.addCommand({
      id: 'qq-browser-login',
      name: t('cmd.qqWebLogin'),
      callback: () =>
        new WebLoginModal(this.app, {
          auth: this.qqAuth,
          browserLogin: this.qqBrowserLogin,
          provider: qqWebProvider(),
        }).open(),
    });
    this.addCommand({
      id: 'qq-logout',
      name: t('cmd.qqLogout'),
      callback: () => this.logoutQq(),
    });
    this.addCommand({
      id: 'netease-logout',
      name: t('cmd.neteaseLogout'),
      callback: () => this.logout(),
    });
  }

  onunload() {
    if (this.statsSaveTimer) window.clearTimeout(this.statsSaveTimer);
    void this.saveSettings(); // 尽力落盘（防抖窗口内的统计）
    this.server?.stop();
    this.engine?.dispose();
    this.local?.clearAllBlobs();
  }

  async loadSettings() {
    const loaded: unknown = await this.loadData();
    const data: Partial<VinylSettings> = loaded && typeof loaded === 'object' ? loaded : {};
    this.settings = { ...DEFAULT_SETTINGS, ...data };
    this.settings.stats = ensureStats(data?.stats);
    // 卡片属性：数组结构必须显式归一化——Object.assign 对数组会产出 {0:…,length:…} 类数组怪物，
    // 且浅拷贝会让设置与 DEFAULT_SETTINGS 共享引用（push 即污染默认值）；归一化同时完成旧 boolean 结构迁移
    this.settings.shelfProps = normalizeShelfProps(data?.shelfProps);
    this.settings.shelfPropLabels = normalizeShelfPropLabels(data?.shelfPropLabels);
    // 队列自定义顺序：非对象 / 非字符串数组一律丢弃（data.json 可能被手改或来自旧版本）
    this.settings.queueOrder = normalizeQueueOrder(data?.queueOrder);
    // 音量与上次播放位置：脏数据一律回落（data.json 可能被手改或来自旧版本）
    this.settings.volume = normalizeVolume(data?.volume);
    this.settings.lastPlayback = normalizeLastPlayback(data?.lastPlayback);
    // 专辑队列模式：同样只认布尔 true（脏数据一律当关）
    this.settings.queueMode = data?.queueMode === true;
    this.settings.playMode = normalizePlayMode(data?.playMode);
    // 调试命令开关：只认布尔 true（data.json 可能被手改成字符串，别让 "false" 也开启）
    this.settings.debugCommands = data?.debugCommands === true;
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
    // 模板文件路径注入索引层（避免它自己被当成专辑）
    setAlbumTemplatePath(this.settings.albumNoteTemplate);
    // 界面语言（i18n 模块级当前语言）
    setLanguage(this.settings.language);
    // 配色项（不认识的旧值由 normalize* 回落默认）
    this.settings.playerDeck = normalizeDeckStyle(data?.playerDeck);
    this.settings.recordColor = normalizeRecordColor(data?.recordColor);
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
    // 模板文件本身不能被当成专辑展示（模板里通常也写着 tags: [album]）
    setAlbumTemplatePath(this.settings.albumNoteTemplate);
    setLanguage(this.settings.language);
    await this.saveData(this.settings);
  }

  // 语言切换后重绘已打开的专辑墙（工具栏 / 排序筛选 / 空态 / 卡片菜单文案）
  refreshLanguage() {
    for (const leaf of this.app.workspace.getLeavesOfType(SHELF_VIEW_TYPE)) {
      const v = leaf.view as unknown as { render?: () => void };
      if (typeof v.render === 'function') v.render();
    }
    // 播放器的壳只建一次（见 player-view 的增量渲染）：不能重建 DOM（会打断转盘旋转与入场动画、
    // 丢掉播放进度），改为就地重放文案标签——按钮 aria-label / title 与队列提示随语言切换
    for (const leaf of this.app.workspace.getLeavesOfType(PLAYER_VIEW_TYPE)) {
      const v = leaf.view;
      if (v instanceof VinylPlayerView) v.applyLanguage();
    }
  }

  // 生成一份可编辑的模板文件并写进设置（内容 = 内置模板，随便改）
  async createAlbumTemplate() {
    const root = this.settings.albumFolder.split('/').slice(0, -1).join('/');
    const path = normalizePath(`${root ? root + '/' : ''}模板/专辑笔记模板.md`);
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

  // 三个数据目录不存在则创建（新用户首次启用装完即用；用户改过路径设置也会补齐）
  private async ensureDataFolders() {
    for (const p of [
      this.settings.albumFolder,
      this.settings.coverFolder,
      this.settings.audioFolder,
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
      client: this.netease,
      qq: this.qq,
    };
  }

  openAlbumImport() {
    new AlbumImportModal(this.app, this.importCtx()).open();
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

  // 拖拽入库入口（专辑墙调用）：album 为 null 时从文件新建本地专辑
  async importAudioFromFiles(files: File[], album: AlbumInfo | null, rootName = '') {
    // 拖入的是文件夹 → 按「一张专辑一个文件夹」分析（音乐库根目录会被拦下）
    const scan = rootName
      ? analyzeFolder(
          rootName,
          files.map((f) => ({ file: f, relPath: relPathOf(f) }))
        )
      : null;
    if (scan?.verdict === 'library') {
      notice(tf('notice.libraryRoot', { hint: libraryRootHint(scan) }));
      return;
    }
    // 不支持的格式单独提示（静默忽略时拖进来没反应，用户不知道为什么）
    const { audio: pickedAudio, skipped } = splitAudioFiles(files);
    const audioFiles = scan ? scan.files : pickedAudio;
    if (!scan && skipped.length) notice(skippedFormatsText(skipped.map((f) => f.name)));
    if (!audioFiles.length) {
      if (scan) notice(t('notice.noSupportedAudio'));
      return;
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
          return;
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
        return;
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
    } catch (e) {
      notice(tf('notice.importFailed', { msg: (e as Error).message }));
    }
  }

  // ============ 删除专辑 ============

  // 专辑墙右键「删除专辑…」入口：资产盘点 + 二次确认在弹窗内完成
  openDeleteAlbum(album: AlbumInfo) {
    new DeleteAlbumModal(this.app, this, album).open();
  }

  // 执行删除：连带资产（可选）→ 笔记 → 统计 → 播放态复位
  async deleteAlbum(album: AlbumInfo, opts: { audio: boolean; cover: boolean }) {
    const targets = collectAlbumDeleteTargets(this.app, album);
    const removed = await deleteAlbumAssets(this.app, targets, opts);
    // 笔记可能已被外部删除/改名（卡片是快照）→ 存在才删，其余清理照旧
    if (this.app.vault.getAbstractFileByPath(album.path) instanceof TFile) {
      await this.app.fileManager.trashFile(album.file);
    }
    if (this.settings.stats.albums[album.path]) {
      delete this.settings.stats.albums[album.path];
      await this.saveSettings();
    }
    if (this.engine.snapshot().albumNotePath === album.path) this.engine.clear();
    notice(
      tf('notice.albumDeleted', { title: album.title }) +
        (removed ? tf('notice.albumDeletedAssets', { n: removed }) : '')
    );
  }

  // 感想联动：在播放中的专辑笔记正文末尾追加时间戳条目并定位光标
  async appendListeningNote() {
    const snap = this.engine.snapshot();
    const albumPath = snap.albumNotePath;
    const file = albumPath ? this.app.vault.getAbstractFileByPath(albumPath) : null;
    if (!(file instanceof TFile)) {
      notice(t('notice.noPlayingAlbum'));
      return;
    }
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
    const line = tf('note.listeningLine', { ts, title: snap.current?.title ?? '' });
    const content = await this.app.vault.read(file);
    const newContent = content.trimEnd() + (content.trim() ? '\n\n' : '') + line + '\n';
    await this.app.vault.modify(file, newContent);
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    const editor = (leaf.view as { editor?: Editor }).editor;
    if (editor) {
      const lastLine = editor.lastLine();
      editor.setCursor({ line: lastLine, ch: editor.getLine(lastLine).length });
    }
    notice(tf('notice.appended', { name: file.basename }));
  }

  // 插入此刻正在听：往「用户当前编辑的笔记」光标处插一行曲目信息。
  // 与上面的 appendListeningNote 是两件事：那个写专辑笔记正文末尾，这个只动当前编辑器、不碰文件。
  // 成功不弹通知（插入结果肉眼可见），只有失败路径才提示。
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
    // 专辑名优先取专辑笔记标题（队列加载后一定有）；收藏类队列没有笔记标题时退回曲目自带的专辑名
    // 有专辑笔记路径时把它做成 wikilink（专辑名可点击打开笔记）；模板本身不变，链接在调用处拼好
    const album = albumWikiLink(snap.albumNotePath, snap.albumTitle || track.album || '');
    const line = tf('notice.nowPlayingLine', { album, track: track.title });
    view.editor.replaceSelection(line + '\n');
  }

  recordPlay(track: Track, albumPath?: string, albumTitle?: string) {
    this.settings.stats = recordTrackPlay(
      this.settings.stats,
      trackKey(track),
      albumPath,
      albumTitle,
      track.title
    );
    this.scheduleStatsSave();
  }

  /** 队列拖拽重排后的持久化写入口（按专辑笔记路径记顺序；与统计共用 5 秒防抖落盘） */
  rememberQueueOrder(albumPath: string, orderKeys: string[]) {
    if (!albumPath) return;
    this.settings.queueOrder = { ...this.settings.queueOrder, [albumPath]: [...orderKeys] };
    this.scheduleStatsSave(); // saveSettings 会落整份设置，不必另起定时器
  }

  /** 「恢复原有顺序」后的持久化写入口：删掉该专辑存过的自定义顺序（与统计共用 5 秒防抖落盘）。
   *  没存过条目就直接返回（不白写盘）；本地专辑走不到这里（视图侧已按来源拦下）。 */
  forgetQueueOrder(albumPath: string) {
    if (!albumPath || !(albumPath in this.settings.queueOrder)) return;
    const rest = { ...this.settings.queueOrder };
    delete rest[albumPath];
    this.settings.queueOrder = rest;
    this.scheduleStatsSave(); // saveSettings 会落整份设置，不必另起定时器
  }

  private statsSaveTimer: number | null = null;
  private scheduleStatsSave() {
    if (this.statsSaveTimer) window.clearTimeout(this.statsSaveTimer);
    this.statsSaveTimer = window.setTimeout(() => {
      this.statsSaveTimer = null;
      void this.saveSettings();
    }, 5000);
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

  openLogin() {
    new QrLoginModal(this.app, { server: this.server, auth: this.auth }).open();
  }

  async logout() {
    await this.auth.clear();
    notice(t('notice.neteaseLoggedOut'));
  }

  openQqLogin() {
    new QrLoginModal(
      this.app,
      { server: this.server, auth: this.qqAuth },
      { provider: qqQrProvider() }
    ).open();
  }

  async logoutQq() {
    await this.qqAuth.clear();
    notice(t('notice.qqLoggedOut'));
  }
}
