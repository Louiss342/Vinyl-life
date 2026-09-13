// Vinyl Life —— 主入口（M4：导入+增强 + M3 交接动效 + M2 专辑墙 + M1 双源播放底座）
// 本地源（零后端）+ 网易云源（懒加载 Node 网关，M0 已验证）统一为 Track 队列。
import { Plugin, Notice, TFile } from 'obsidian';
import * as fs from 'fs';
import { VinylSettings, DEFAULT_SETTINGS, VinylSettingTab } from './settings';
import { ServerManager } from './core/server-manager';
import { ServerClient } from './core/server-client';
import { WebClient } from './core/web-client';
import { NeteaseService } from './core/netease';
import { Auth } from './core/auth';
import { BrowserLogin, QQ_BROWSER_LOGIN } from './core/browser-login';
import { QqService } from './core/qq';
import { QqAuth } from './core/qq-auth';
import { LocalSource } from './core/local-source';
import { PlaybackEngine } from './core/player-state';
import { VinylPlayerView, PLAYER_VIEW_TYPE } from './views/player-view';
import { VinylShelfView, SHELF_VIEW_TYPE } from './views/shelf-view';
import { HandoffController } from './animation/handoff';
import { QrLoginModal, QQ_QR_PROVIDER } from './views/qr-login-modal';
import {
  AlbumInfo,
  buildAlbumInfo,
  parseFrontmatterSimple,
  getAlbumInfo,
  findAlbumNotes,
  detectAlbumSources,
} from './core/album-index';
import { buildAlbumQueue, QueueDeps } from './core/queue';
import { normalizeShelfProps, normalizeShelfPropLabels } from './core/shelf-props';
import { DISC_DIRECTIONS, SPIN_SPEEDS } from './core/disc-motion';
import { normalizeDeckStyle, normalizeRecordColor } from './core/appearance';
import { notice, isAudioFile, pluginAbsPath } from './util';
import {
  ImportContext,
  importNeteaseAlbum,
  importLocalAudio,
  createAlbumFromFiles,
} from './import';
import { AlbumImportModal, LocalImportModal } from './views/import-modal';
import { DeleteAlbumModal } from './views/delete-album-modal';
import { collectAlbumDeleteTargets, deleteAlbumAssets } from './delete';
import { WebLoginModal, QQ_WEB } from './views/web-login-modal';
import { StatsModal } from './views/stats-modal';
import { ensureStats, recordTrackPlay } from './core/stats';
import { Track, trackKey } from './core/track';

const SELF_TEST_LOG = '06-专辑墙/M1-自检日志.md';
const SHELF_TEST_LOG = '06-专辑墙/M2-自检日志.md';
const HANDOFF_TEST_LOG = '06-专辑墙/M3-自检日志.md';
const IMPORT_TEST_LOG = '06-专辑墙/M4-自检日志.md';
const QQ_TEST_LOG = '06-专辑墙/M5-自检日志.md';
const SELF_TEST_DIR = '06-专辑墙/tmp-m1-test';
const SELF_TEST_EXT = 'D:/Music/vinyl-note-spike.wav';

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
    await this.loadSettings();

    // 服务层：网关（Cookie 通道）+ 网页直连（官方登录页会话）统一路由
    this.server = new ServerManager(this);
    this.client = new ServerClient(() => this.server.base);
    this.web = new WebClient(
      pluginAbsPath(this, '.anon-token'),
      pluginAbsPath(this, '.device-id')
    );
    this.netease = new NeteaseService(this.web, this.client, () => this.server.ensure(), () => this.server.lastError);
    this.auth = new Auth(this, this.server, this.client);
    this.browserLogin = new BrowserLogin(this.auth);
    this.register(() => this.browserLogin.dispose());
    this.qq = new QqService(() => this.server.base);
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
    });
    this.handoff = new HandoffController(this);

    // 视图与命令
    this.registerView(PLAYER_VIEW_TYPE, (leaf) => new VinylPlayerView(leaf, this));
    this.registerView(SHELF_VIEW_TYPE, (leaf) => new VinylShelfView(leaf, this));
    this.addRibbonIcon('library', 'Vinyl Life 专辑墙', () => this.openShelf());
    this.addCommand({
      id: 'open-shelf',
      name: '打开专辑墙',
      callback: () => this.openShelf(),
    });
    this.addCommand({
      id: 'open-shelf-sidebar',
      name: '在侧栏打开专辑墙',
      callback: () => this.openShelf('sidebar'),
    });
    this.addCommand({
      id: 'open-player',
      name: '打开播放器',
      callback: () => this.openPlayer(),
    });
    this.addCommand({
      id: 'popout-player',
      name: '弹出播放器窗口',
      callback: () => this.openPlayer('window'),
    });
    this.addCommand({
      id: 'netease-login',
      name: '网易云扫码登录',
      callback: () => this.openLogin(),
    });
    this.addCommand({
      id: 'netease-web-login',
      name: '网易云浏览器登录（官方登录页）',
      callback: () => new WebLoginModal(this.app, { auth: this.auth, browserLogin: this.browserLogin }).open(),
    });
    this.addCommand({
      id: 'qq-login',
      name: 'QQ 音乐扫码登录',
      callback: () => this.openQqLogin(),
    });
    this.addCommand({
      id: 'qq-browser-login',
      name: 'QQ 音乐浏览器登录（官方登录页）',
      callback: () =>
        new WebLoginModal(this.app, {
          auth: this.qqAuth,
          browserLogin: this.qqBrowserLogin,
          provider: QQ_WEB,
        }).open(),
    });
    this.addCommand({
      id: 'qq-logout',
      name: '退出 QQ 音乐登录',
      callback: () => this.logoutQq(),
    });
    this.addCommand({
      id: 'netease-logout',
      name: '退出网易云登录',
      callback: () => this.logout(),
    });
    this.addCommand({
      id: 'migrate-cookie',
      name: '从 Mineradio 迁移登录 Cookie',
      callback: () => this.migrate(),
    });
    this.addCommand({
      id: 'm1-selftest',
      name: 'M1 自检：双源队列 + 播放验证',
      callback: () => this.runM1SelfTest(),
    });
    this.addCommand({
      id: 'm2-selftest',
      name: 'M2 自检：专辑墙数据 + 音源角标',
      callback: () => this.runM2SelfTest(),
    });
    this.addCommand({
      id: 'm3-selftest',
      name: 'M3 自检：交接状态机验证',
      callback: () => this.runM3SelfTest(),
    });
    this.addCommand({
      // id 保持不变：改了会让已绑定的快捷键失效
      id: 'import-netease',
      name: '导入专辑',
      callback: () => this.openAlbumImport(),
    });
    this.addCommand({
      id: 'import-local',
      name: '导入本地音频',
      callback: () => this.openLocalImport(),
    });
    this.addCommand({
      id: 'append-listening-note',
      name: '在专辑笔记追加此刻感想',
      callback: () => this.appendListeningNote(),
    });
    this.addCommand({
      id: 'show-stats',
      name: '显示播放统计',
      callback: () => new StatsModal(this.app, this.settings.stats).open(),
    });
    this.addCommand({
      id: 'm4-selftest',
      name: 'M4 自检：导入 + 感想 + 统计验证',
      callback: () => this.runM4SelfTest(),
    });
    this.addCommand({
      id: 'qq-selftest',
      name: 'M5 自检：QQ 音乐源（登录 + 专辑播放）',
      callback: () => this.runQqSelfTest(),
    });
    this.addSettingTab(new VinylSettingTab(this.app, this));

    console.log('[vinyl] M4 导入+增强 · M3 交接动效 · M2 专辑墙 · M1 双源底座已加载');
  }

  onunload() {
    if (this.statsSaveTimer) window.clearTimeout(this.statsSaveTimer);
    void this.saveSettings(); // 尽力落盘（防抖窗口内的统计）
    this.server?.stop();
    this.engine?.dispose();
    this.local?.clearAllBlobs();
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.settings.stats = ensureStats(data?.stats);
    // 卡片属性（M7）：数组结构必须显式归一化——Object.assign 对数组会产出 {0:…,length:…} 类数组怪物，
    // 且浅拷贝会让设置与 DEFAULT_SETTINGS 共享引用（push 即污染默认值）；归一化同时完成旧 boolean 结构迁移
    this.settings.shelfProps = normalizeShelfProps(data?.shelfProps);
    this.settings.shelfPropLabels = normalizeShelfPropLabels(data?.shelfPropLabels);
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
    // 配色项（M8：原「主题 follow/dark」已被「播放器配色」取代，旧值直接忽略）
    this.settings.playerDeck = normalizeDeckStyle(data?.playerDeck);
    this.settings.recordColor = normalizeRecordColor(data?.recordColor);
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
    await this.saveData(this.settings);
  }

  // ============ M4：导入 / 感想 / 统计 ============

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
      .map((f) => getAlbumInfo(this.app, f))
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
  async importAudioFromFiles(files: File[], album: AlbumInfo | null) {
    const audioFiles = files.filter((f) => isAudioFile(f.name));
    if (!audioFiles.length) return;
    try {
      let target = album;
      if (!target) {
        target = await createAlbumFromFiles(this.importCtx(), audioFiles);
        if (!target) {
          notice('从文件新建专辑失败');
          return;
        }
      }
      const mode = this.settings.importMode;
      const res = await importLocalAudio(this.importCtx(), target, audioFiles, mode);
      if (!res.added.length) {
        notice('没有可导入的音频（可能已存在同名文件）');
        return;
      }
      notice(
        `已导入 ${res.added.length} 个音频到「${target.title}」（${
          mode === 'copy' ? '复制进 vault' : '外链引用'
        }）${res.fallback ? '（部分文件无路径信息，已回退复制）' : ''}`
      );
    } catch (e) {
      notice(`导入失败：${(e as Error).message}`);
      console.error('[vinyl] 导入异常', e);
    }
  }

  // ============ M6：删除专辑 ============

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
      `已删除专辑「${album.title}」${removed ? `（含 ${removed} 项本地文件）` : ''}`
    );
  }

  // 感想联动（P1）：在播放中的专辑笔记正文末尾追加时间戳条目并定位光标
  async appendListeningNote() {
    const snap = this.engine.snapshot();
    const albumPath = snap.albumNotePath;
    const file = albumPath ? this.app.vault.getAbstractFileByPath(albumPath) : null;
    if (!(file instanceof TFile)) {
      notice('当前没有正在播放的专辑（先播放一张专辑再追加感想）');
      return;
    }
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
    const line = `- [${ts}] 正在听 ${snap.current?.title ?? ''}：`;
    const content = await this.app.vault.read(file);
    const newContent = content.trimEnd() + (content.trim() ? '\n\n' : '') + line + '\n';
    await this.app.vault.modify(file, newContent);
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    const editor = (leaf.view as any)?.editor;
    if (editor) {
      const lastLine = editor.lastLine();
      editor.setCursor({ line: lastLine, ch: editor.getLine(lastLine).length });
    }
    notice(`已追加到「${file.basename}」`);
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

  private statsSaveTimer: number | null = null;
  private scheduleStatsSave() {
    if (this.statsSaveTimer) window.clearTimeout(this.statsSaveTimer);
    this.statsSaveTimer = window.setTimeout(() => {
      this.statsSaveTimer = null;
      void this.saveSettings();
    }, 5000);
  }

  // —— 专辑墙落位（主区 / 侧栏）——
  async openShelf(location?: 'tab' | 'sidebar') {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(SHELF_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = location === 'sidebar' ? workspace.getRightLeaf(false) ?? workspace.getLeaf('tab') : workspace.getLeaf('tab');
      await leaf.setViewState({ type: SHELF_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  // —— 播放器落位（G2：侧栏 / 主区 / 独立窗口）——
  async openPlayer(location?: 'sidebar' | 'tab' | 'window') {
    const loc = location || this.settings.playerLocation;
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(PLAYER_VIEW_TYPE)[0];
    if (!leaf) {
      if (loc === 'window') {
        try {
          leaf = (workspace as any).openPopoutLeaf();
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
    workspace.revealLeaf(leaf);
  }

  openLogin() {
    new QrLoginModal(this.app, { server: this.server, auth: this.auth }).open();
  }

  async logout() {
    await this.auth.clear();
    notice('已退出网易云登录');
  }

  openQqLogin() {
    new QrLoginModal(
      this.app,
      { server: this.server, auth: this.qqAuth },
      { provider: QQ_QR_PROVIDER }
    ).open();
  }

  async logoutQq() {
    await this.qqAuth.clear();
    notice('已退出 QQ 音乐登录');
  }

  async migrate() {
    const r = await this.auth.migrateMineradio();
    notice(r.ok ? r.detail : `迁移失败：${r.detail}`);
  }

  // ============ M1 自检套件 ============
  // 验收标准：本地（vault + 外链）与网易云曲都能进队列播放；Cookie 落盘。
  async runM1SelfTest() {
    const lines: string[] = [];
    const log = (test: string, ok: boolean, detail: string) => {
      lines.push(
        `- [${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] **${test}** ${
          ok ? '✅' : '❌'
        } ${detail}`
      );
      console.log(`[vinyl-m1] ${test} ${ok ? 'PASS' : 'FAIL'} ${detail}`);
    };
    const writeLog = async () => {
      try {
        const header =
          '# M1 自检日志\n\n> 由插件「M1 自检」命令生成。验收标准见 [[M1-结论]]。\n\n';
        await this.app.vault.adapter.write(SELF_TEST_LOG, header + lines.join('\n') + '\n');
      } catch (e) {
        console.error('[vinyl-m1] 日志写入失败', e);
      }
    };

    new Notice('Vinyl Life M1 自检开始…');
    const t0 = Date.now();

    // 0. Cookie 落盘检查
    const bytes = this.auth.cookieBytes();
    log(
      'COOKIE',
      bytes > 0 && this.auth.hasLocalCookie(),
      `.cookie ${bytes} 字节，MUSIC_U=${this.auth.hasLocalCookie() ? '存在' : '缺失'}`
    );

    // 1. 本地 vault 音轨 → 队列 → 播放
    try {
      const note = await this.writeTempAlbumNote({
        title: '__m1-test-vault',
        body: 'tags: [album]\naudioFolder: "[[06-专辑墙/audio/spike]]"\n',
      });
      const fm = parseFrontmatterSimple(await this.app.vault.read(note));
      const album = buildAlbumInfo(this.app, note, fm);
      const res = await buildAlbumQueue(album, this.queueDeps());
      const ok = res.resolvedSource === 'local' && res.tracks.length > 0;
      log(
        'LOCAL-VAULT',
        ok,
        `队列 ${res.tracks.length} 曲（${res.tracks.map((t) => t.title).join(', ')}）`
      );
      if (ok) {
        const p = await this.engine.probePlay(res.tracks[0], 1200);
        log('LOCAL-VAULT-PLAY', p.ok, p.detail);
      }
    } catch (e) {
      log('LOCAL-VAULT', false, `异常: ${e}`);
    }

    // 2. 外链绝对路径 → 队列 → 播放
    try {
      if (fs.existsSync(SELF_TEST_EXT)) {
        const note = await this.writeTempAlbumNote({
          title: '__m1-test-ext',
          body: 'tags: [album]\naudio:\n  - "D:/Music/vinyl-note-spike.wav"\n',
        });
        const fm = parseFrontmatterSimple(await this.app.vault.read(note));
        const album = buildAlbumInfo(this.app, note, fm);
        const res = await buildAlbumQueue(album, this.queueDeps());
        const ok =
          res.resolvedSource === 'local' &&
          res.tracks.length > 0 &&
          res.tracks[0].source === 'local-external';
        log(
          'LOCAL-EXT',
          ok,
          `队列 ${res.tracks.length} 曲，source=${res.tracks[0]?.source}`
        );
        if (ok) {
          const p = await this.engine.probePlay(res.tracks[0], 1200);
          log('LOCAL-EXT-PLAY', p.ok, p.detail);
        }
      } else {
        log('LOCAL-EXT', false, `测试文件不存在：${SELF_TEST_EXT}`);
      }
    } catch (e) {
      log('LOCAL-EXT', false, `异常: ${e}`);
    }

    // 3. 网易云专辑（Abbey Road 真实笔记，auto 策略 → 本地无 → 网易云）
    try {
      const note = this.app.vault.getAbstractFileByPath('06-专辑墙/专辑/Abbey Road.md');
      if (note instanceof TFile) {
        const album = getAlbumInfo(this.app, note);
        if (!album) {
          log('NETEASE', false, 'Abbey Road 笔记未索引或缺少 album 标签');
        } else {
          const res = await buildAlbumQueue(album, this.queueDeps());
          const ok = res.resolvedSource === 'netease' && res.tracks.length > 0;
          log(
            'NETEASE',
            ok,
            `队列 ${res.tracks.length} 曲${ok ? `（首曲：${res.tracks[0].title}）` : `（${res.reason}）`}`
          );
          if (ok) {
            const p = await this.engine.probePlay(res.tracks[0], 1500);
            log('NETEASE-PLAY', p.ok, p.detail);
          }
        }
      } else {
        log('NETEASE', false, '找不到 Abbey Road 笔记');
      }
    } catch (e) {
      log('NETEASE', false, `异常: ${e}`);
    }

    // 4. 登录态
    const st = await this.auth.getStatus();
    log(
      'LOGIN',
      st.loggedIn,
      st.loggedIn
        ? `nick=${st.nick}, userId=${st.userId}${st.vipType === 11 ? ', VIP' : ''}`
        : '未登录（Cookie 缺失或已过期）'
    );

    // 5. 清理临时笔记
    await this.removeTempAlbumNotes();

    lines.push(`- 总耗时 ${Date.now() - t0}ms`);
    await writeLog();
    new Notice('M1 自检完成，结果见 06-专辑墙/M1-自检日志.md');
  }

  // ============ M2 自检套件 ============
  // 验收标准：卡片视觉对齐（人工确认）；点击不跳外链（= loadAlbum + openPlayer，引擎链路 M1 已验证）；
  // 音源角标正确（本命令逐张核对 + 三种临时笔记形态验证）。
  async runM2SelfTest() {
    const lines: string[] = [];
    const log = (test: string, ok: boolean, detail: string) => {
      lines.push(
        `- [${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] **${test}** ${
          ok ? '✅' : '❌'
        } ${detail}`
      );
      console.log(`[vinyl-m2] ${test} ${ok ? 'PASS' : 'FAIL'} ${detail}`);
    };
    const writeLog = async () => {
      try {
        const header =
          '# M2 自检日志\n\n> 由插件「M2 自检」命令生成。验收标准见 [[M2-结论]]。\n\n';
        await this.app.vault.adapter.write(SHELF_TEST_LOG, header + lines.join('\n') + '\n');
      } catch (e) {
        console.error('[vinyl-m2] 日志写入失败', e);
      }
    };

    new Notice('Vinyl Life M2 自检开始…');

    // 0. 扫描专辑笔记
    const files = findAlbumNotes(this.app);
    log('SHELF-SCAN', files.length > 0, `tags:[album] 专辑笔记 ${files.length} 张`);

    // 1. 逐张角标
    let badged = 0;
    for (const f of files) {
      const album = getAlbumInfo(this.app, f);
      if (!album) continue;
      const src = detectAlbumSources(this.app, album);
      const badges = `${src.local ? '[本地]' : ''}${src.netease ? '[网易云]' : ''}${
        !src.local && !src.netease ? '[收藏·]' : ''
      }`;
      log(
        'BADGE',
        true,
        `${album.title}: ${badges} (neteaseId=${album.neteaseId ?? '-'}, audioFolder=${
          album.audioFolderRef ?? '-'
        }, audio 列表 ${album.audioRefs.length} 项)`
      );
      badged++;
    }
    log('BADGE-COUNT', badged === files.length, `共核对 ${badged}/${files.length} 张角标`);

    // 2. 临时笔记三形态：仅本地（audioFolder）/ 仅外链 / 本地+网易云双源
    const testCase = async (
      name: string,
      body: string,
      expect: { local: boolean; netease: boolean }
    ) => {
      try {
        const note = await this.writeTempAlbumNote({ title: `__m2-test-${name}`, body });
        const fm = parseFrontmatterSimple(await this.app.vault.read(note));
        const album = buildAlbumInfo(this.app, note, fm);
        const src = detectAlbumSources(this.app, album);
        const ok = src.local === expect.local && src.netease === expect.netease;
        log(
          `BADGE-${name.toUpperCase()}`,
          ok,
          `本地=${src.local}（期望 ${expect.local}）, 网易云=${src.netease}（期望 ${expect.netease}）`
        );
      } catch (e) {
        log(`BADGE-${name.toUpperCase()}`, false, `异常: ${e}`);
      }
    };
    await testCase('local', 'tags: [album]\naudioFolder: "[[06-专辑墙/audio/spike]]"\n', {
      local: true,
      netease: false,
    });
    await testCase('ext', 'tags: [album]\naudio:\n  - "D:/Music/vinyl-note-spike.wav"\n', {
      local: true,
      netease: false,
    });
    await testCase(
      'both',
      'tags: [album]\nnetease: "https://music.163.com/#/album?id=437968"\naudioFolder: "[[06-专辑墙/audio/spike]]"\n',
      { local: true, netease: true }
    );
    await testCase('collect', 'tags: [album]\n', { local: false, netease: false });

    // 3. 清理
    await this.removeTempAlbumNotes();
    await writeLog();
    new Notice('M2 自检完成，结果见 06-专辑墙/M2-自检日志.md');
  }

  // ============ M3 自检套件 ============
  // 验收标准：点击 → 播放器出现 + 落盘 + 播放，状态机正确（IDLE→HANDOFF→PLAYING）。
  // 本命令验证状态机两条路径：成功交接（本地音轨）与失败回落（无音源）；墙上动画为视觉项，人工确认。
  async runM3SelfTest() {
    const lines: string[] = [];
    const log = (test: string, ok: boolean, detail: string) => {
      lines.push(
        `- [${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] **${test}** ${
          ok ? '✅' : '❌'
        } ${detail}`
      );
      console.log(`[vinyl-m3] ${test} ${ok ? 'PASS' : 'FAIL'} ${detail}`);
    };
    const writeLog = async () => {
      try {
        const header =
          '# M3 自检日志\n\n> 由插件「M3 自检」命令生成。验收标准见 [[M3-结论]]。\n\n';
        await this.app.vault.adapter.write(HANDOFF_TEST_LOG, header + lines.join('\n') + '\n');
      } catch (e) {
        console.error('[vinyl-m3] 日志写入失败', e);
      }
    };

    new Notice('Vinyl Life M3 自检开始…');

    // 0. 初始状态
    log('STATE-INIT', this.handoff.getState() === 'idle', `初始状态 = ${this.handoff.getState()}`);

    // 1. 成功交接：临时专辑（本地 vault 音轨）→ handoff → playing + 队列 + 播放器打开
    try {
      const note = await this.writeTempAlbumNote({
        title: '__m3-test',
        body: 'tags: [album]\naudioFolder: "[[06-专辑墙/audio/spike]]"\n',
      });
      const fm = parseFrontmatterSimple(await this.app.vault.read(note));
      const album = buildAlbumInfo(this.app, note, fm);
      await this.handoff.handoff(album, null); // 自检无卡片元素 → 跳过墙上动画，验证状态机与链路
      const snap = this.engine.snapshot();
      const playerOpen = this.app.workspace.getLeavesOfType(PLAYER_VIEW_TYPE).length > 0;
      const ok =
        this.handoff.getState() === 'playing' && snap.queue.length > 0 && playerOpen;
      log(
        'HANDOFF-OK',
        ok,
        `state=${this.handoff.getState()}（期望 playing）, 队列=${snap.queue.length} 曲, 播放器已打开=${playerOpen}`
      );
      if (ok) {
        const p = await this.engine.probePlay(snap.queue[0], 1200);
        log('HANDOFF-PLAY', p.ok, p.detail);
      }
    } catch (e) {
      log('HANDOFF-OK', false, `异常: ${e}`);
    }

    // 2. 失败回落：无音源专辑 → handoff → idle
    try {
      const note = await this.writeTempAlbumNote({
        title: '__m3-test-empty',
        body: 'tags: [album]\n',
      });
      const fm = parseFrontmatterSimple(await this.app.vault.read(note));
      const album = buildAlbumInfo(this.app, note, fm);
      await this.handoff.handoff(album, null);
      log(
        'HANDOFF-EMPTY',
        this.handoff.getState() === 'idle',
        `无音源交接后 state=${this.handoff.getState()}（期望 idle）`
      );
    } catch (e) {
      log('HANDOFF-EMPTY', false, `异常: ${e}`);
    }

    // 3. 清理
    await this.removeTempAlbumNotes();
    await writeLog();
    new Notice('M3 自检完成，结果见 06-专辑墙/M3-自检日志.md');
  }

  // ============ M4 自检套件 ============
  // 验收标准：网易云专辑一键建笔记+封面（以去重路径验证，不实际新建）；本地导入两模式；
  // 感想可追加；统计记录。
  async runM4SelfTest() {
    const lines: string[] = [];
    const log = (test: string, ok: boolean, detail: string) => {
      lines.push(
        `- [${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] **${test}** ${
          ok ? '✅' : '❌'
        } ${detail}`
      );
      console.log(`[vinyl-m4] ${test} ${ok ? 'PASS' : 'FAIL'} ${detail}`);
    };
    const writeLog = async () => {
      try {
        const header =
          '# M4 自检日志\n\n> 由插件「M4 自检」命令生成。验收标准见 [[M4-结论]]。\n\n';
        await this.app.vault.adapter.write(IMPORT_TEST_LOG, header + lines.join('\n') + '\n');
      } catch (e) {
        console.error('[vinyl-m4] 日志写入失败', e);
      }
    };

    new Notice('Vinyl Life M4 自检开始…');
    const cleanupDirs: string[] = [];

    // 0. 统计：recordPlay 计数
    try {
      const before = this.settings.stats.totalPlays;
      this.recordPlay(
        { source: 'local-external', path: 'D:/fake-self-test.wav', title: '统计自检' },
        '06-专辑墙/tmp-m1-test/__m4-fake.md',
        '__m4-fake'
      );
      const ok = this.settings.stats.totalPlays === before + 1;
      log('STATS', ok, `totalPlays ${before} → ${this.settings.stats.totalPlays}（防抖 5s 落盘 data.json）`);
    } catch (e) {
      log('STATS', false, `异常: ${e}`);
    }

    // 1. 本地导入 - 复制进 vault
    try {
      const note = await this.writeTempAlbumNote({
        title: '__m4-test-copy',
        body: 'tags: [album]\n',
      });
      const fm = parseFrontmatterSimple(await this.app.vault.read(note));
      const album = buildAlbumInfo(this.app, note, fm);
      const spike = this.app.vault.getAbstractFileByPath('06-专辑墙/audio/spike/spike-test.wav');
      if (spike instanceof TFile) {
        const buf = await this.app.vault.readBinary(spike);
        const file = new File([buf], 'm4-copy-test.wav', { type: 'audio/wav' });
        const res = await importLocalAudio(this.importCtx(), album, [file], 'copy');
        const content = await this.app.vault.read(note);
        const ok = res.added.length === 1 && content.includes('audioFolder');
        log(
          'IMPORT-COPY',
          ok,
          `新增 ${res.added.length} 个文件，frontmatter audioFolder=${content.includes('audioFolder') ? '已写入' : '缺失'}`
        );
        cleanupDirs.push('06-专辑墙/audio/__m4-test-copy');
      } else {
        log('IMPORT-COPY', false, '找不到测试音频 spike-test.wav');
      }
    } catch (e) {
      log('IMPORT-COPY', false, `异常: ${e}`);
    }

    // 2. 本地导入 - 外链绝对路径
    try {
      const note = await this.writeTempAlbumNote({
        title: '__m4-test-link',
        body: 'tags: [album]\n',
      });
      const fm = parseFrontmatterSimple(await this.app.vault.read(note));
      const album = buildAlbumInfo(this.app, note, fm);
      const file = new File(['x'], 'm4-link-test.wav');
      (file as any).path = SELF_TEST_EXT;
      const res = await importLocalAudio(this.importCtx(), album, [file], 'link');
      const content = await this.app.vault.read(note);
      const ok = res.added.length === 1 && content.includes(SELF_TEST_EXT);
      log(
        'IMPORT-LINK',
        ok,
        `外链写入 ${res.added.length} 条，frontmatter audio 列表=${content.includes(SELF_TEST_EXT) ? '已写入' : '缺失'}`
      );
    } catch (e) {
      log('IMPORT-LINK', false, `异常: ${e}`);
    }

    // 3. 网易云导入 - 去重路径（437968 已存在 Abbey Road，验证解析/网关/查重，不新建笔记）
    try {
      const res = await importNeteaseAlbum(this.importCtx(), 'https://music.163.com/#/album?id=437968');
      const ok = !res.ok && !!res.file && res.detail.includes('已存在');
      log(
        'IMPORT-NETEASE-DUP',
        ok,
        `去重命中：${res.detail}${res.file ? ` → ${res.file.path}` : ''}`
      );
    } catch (e) {
      log('IMPORT-NETEASE-DUP', false, `异常: ${e}`);
    }

    // 4. 感想追加：临时专辑进队列 → 追加 → 验证内容
    try {
      const note = await this.writeTempAlbumNote({
        title: '__m4-test-note',
        body: 'tags: [album]\naudioFolder: "[[06-专辑墙/audio/spike]]"\n',
      });
      const fm = parseFrontmatterSimple(await this.app.vault.read(note));
      const album = buildAlbumInfo(this.app, note, fm);
      await this.engine.loadAlbum(album);
      await this.appendListeningNote();
      const content = await this.app.vault.read(note);
      const ok = content.includes('正在听');
      log('NOTE-APPEND', ok, `笔记末尾感想条目=${ok ? '已追加' : '缺失'}`);
    } catch (e) {
      log('NOTE-APPEND', false, `异常: ${e}`);
    }

    // 5. 清理
    await this.removeTempAlbumNotes();
    for (const dir of cleanupDirs) {
      try {
        const folder = this.app.vault.getAbstractFileByPath(dir);
        if (folder) await this.app.vault.delete(folder, true);
      } catch (_) {}
    }
    await writeLog();
    new Notice('M4 自检完成，结果见 06-专辑墙/M4-自检日志.md');
  }

  // ============ M5 自检套件（QQ 音乐源） ============
  // 验收标准：.qq-cookie 存在且登录态可查；绑定 QQ 的专辑可建队列并实际播放。
  async runQqSelfTest() {
    const lines: string[] = [];
    const log = (test: string, ok: boolean, detail: string) => {
      lines.push(
        `- [${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] **${test}** ${
          ok ? '✅' : '❌'
        } ${detail}`
      );
      console.log(`[vinyl-m5] ${test} ${ok ? 'PASS' : 'FAIL'} ${detail}`);
    };
    const writeLog = async () => {
      try {
        const header = '# M5 自检日志\n\n> 由插件「M5 自检」命令生成。验收标准见 [[M5-结论]]。\n\n';
        await this.app.vault.adapter.write(QQ_TEST_LOG, header + lines.join('\n') + '\n');
      } catch (e) {
        console.error('[vinyl-m5] 日志写入失败', e);
      }
    };

    new Notice('Vinyl Life M5 自检开始…');

    // 0. 凭据与登录态
    const bytes = this.qqAuth.cookieBytes();
    log(
      'COOKIE',
      bytes > 0 && this.qqAuth.hasLocalCookie(),
      `.qq-cookie ${bytes} 字节，qm_keyst=${this.qqAuth.hasLocalCookie() ? '存在' : '缺失'}`
    );
    const st = await this.qqAuth.getStatus();
    log(
      'LOGIN',
      st.loggedIn,
      st.loggedIn ? `nick=${st.nick}, uin=${st.userId}` : '未登录（Cookie 缺失或已失效）'
    );

    // 1. 绑定 QQ 的专辑：角标 → 队列 → 试播
    try {
      const bound = findAlbumNotes(this.app)
        .map((f) => getAlbumInfo(this.app, f))
        .filter((a): a is AlbumInfo => !!a && !!a.qqId);
      log('ALBUM-SCAN', true, `绑定 QQ 音乐的专辑 ${bound.length} 张`);
      if (bound.length) {
        const album = bound[0];
        const src = detectAlbumSources(this.app, album);
        log('BADGE', src.qq, `「${album.title}」角标 qq=${src.qq}`);
        const res = await buildAlbumQueue(album, this.queueDeps());
        const ok = res.resolvedSource === 'qq' && res.tracks.length > 0;
        log(
          'QUEUE',
          ok,
          ok
            ? `队列 ${res.tracks.length} 曲（首曲：${res.tracks[0].title}）`
            : `未解析为 QQ 队列（${res.reason || res.resolvedSource}）`
        );
        if (ok) {
          const p = await this.engine.probePlay(res.tracks[0], 1500);
          log('PLAY', p.ok, p.detail);
        }
      } else {
        log('ALBUM-SCAN', false, '未找到绑定 QQ 音乐（qqId / qq 链接）的专辑笔记，先加一张再跑本自检');
      }
    } catch (e) {
      log('QUEUE', false, `异常: ${e}`);
    }

    await writeLog();
    new Notice('M5 自检完成，结果见 06-专辑墙/M5-自检日志.md');
  }

  private queueDeps(): QueueDeps {
    return {
      local: this.local,
      netease: this.netease,
      qq: this.qq,
      defaultSource: this.settings.defaultSource,
    };
  }

  private tempNotePaths: string[] = [];

  private async writeTempAlbumNote(opt: { title: string; body: string }): Promise<TFile> {
    const p = `${SELF_TEST_DIR}/${opt.title}.md`;
    await this.app.vault.adapter.write(p, `---\n${opt.body}---\n`);
    const f = this.app.vault.getAbstractFileByPath(p);
    if (!(f instanceof TFile)) throw new Error('临时笔记创建失败: ' + p);
    this.tempNotePaths.push(p);
    return f;
  }

  private async removeTempAlbumNotes() {
    for (const p of this.tempNotePaths) {
      try {
        await this.app.vault.adapter.remove(p);
      } catch (_) {}
    }
    this.tempNotePaths = [];
    try {
      await this.app.vault.adapter.rmdir(SELF_TEST_DIR, true);
    } catch (_) {}
  }
}
