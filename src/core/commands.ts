// 宿主中立的命令注册表。
//
// 为什么要有这一层：同一条能力要喂三个宿主 —— Obsidian 的 addCommand（含默认快捷键）、
// 独立壳的应用菜单与键位表、以及测试。前两个宿主各自接线，第三个直接调 run(host)：
// 于是「写感想」「换封面」「整段上移」这些**只有鼠标路径**的动作第一次可以被断言
//（此前的测试全是扫源码文本，只能证明「代码里有这段模式」，证明不了「点了会发生什么」）。
//
// 纪律：
//   · 本文件不 import obsidian —— 命令只声明「我要做什么」，动作由宿主交出 CommandHost 实现；
//   · id 一旦发布不得改动（用户绑定的快捷键挂在 id 上）。现有 10 条是老入口，见 main.ts 的注释。
//   · **不给默认快捷键**：Obsidian 的插件规范（以及本仓库的 obsidianmd/* lint 闸门）明确建议
//     插件别设默认键 —— 可能撞上用户自己绑的键或宿主自带的键。命令面板里全都能搜到，
//     想用键的读者照 README「命令与快捷键」那一节绑一次即可（十秒的事）。
//
// 与方案文档 §8.E 的差异：那里的 CommandContext 写的是 HostUi / StoragePort / MediaPort / HttpPort
// 四个端口。那四个端口是脱壳阶段（T0.5/T0.7）的事，此刻还不存在；这里先按「命令真正用得着的动作」
// 收一个窄接口，端口落地后把 CommandHost 实现换成端口组合即可，命令表本身不用动。
// 同理，§8.E 里的 keys?: KeyChord[] 暂时不进接口：既然一条都不配，留着就是死字段。

/** 宿主交给命令的动作集合。命令不关心它背后是插件、独立壳还是假实现。 */
export interface CommandHost {
  openShelf(): void;
  openPlayer(): void;
  /** 在线导入（搜/链接导入同一个面板） */
  importAlbum(): void;
  /** 本地导入：有当前专辑就预选它 */
  importLocal(): void;
  /** 本地导入：**只**给当前专辑（没在播就如实报错，不开一个没有目标的导入面板） */
  importLocalToCurrent(): void;
  insertNowPlaying(): void | Promise<void>;
  // 落盘类动作声明成 Promise（不是 void | Promise）：二者都写会让调用方以为可以不等它，
  // 而 lint 的 no-misused-promises 也会盯着「拿了 Promise 却不 await」的那一处
  saveQueueNote(): Promise<void>;
  loadQueueNote(): Promise<void>;
  playerToggle(): void;
  playerNext(): void;
  playerPrev(): void;
  /** 在正在播放的那张专辑笔记末尾追加一条听歌记录 */
  appendListeningNote(): void | Promise<void>;
  /** 给正在播放的那张专辑设置封面 */
  setAlbumCover(): void;
  /** 在源站打开正在播放的那张专辑（没有关联在线音源时如实报错） */
  openAlbumInSource(): void;
  /** 正在播放的那一段（整张专辑）上移 / 下移一格 */
  moveSegment(delta: -1 | 1): void;
}

export interface Command {
  /** 稳定 ID：已发布的不许改（改了用户绑的快捷键就失效） */
  id: string;
  /** i18n 键，不是文案本身（命令面板里的名字随语言变） */
  titleKey: string;
  run(host: CommandHost): void | Promise<void>;
}

export const COMMANDS: Command[] = [
  // —— 视图与导入 ——
  { id: 'open-shelf', titleKey: 'cmd.openShelf', run: (h) => h.openShelf() },
  { id: 'open-player', titleKey: 'cmd.openPlayer', run: (h) => h.openPlayer() },
  { id: 'import-netease', titleKey: 'cmd.importAlbum', run: (h) => h.importAlbum() },
  { id: 'import-local', titleKey: 'cmd.importLocal', run: (h) => h.importLocal() },

  // —— 笔记 ——
  { id: 'insert-now-playing', titleKey: 'cmd.insertNowPlaying', run: (h) => h.insertNowPlaying() },
  {
    id: 'append-listening-note',
    titleKey: 'cmd.appendNote',
    run: (h) => h.appendListeningNote(),
  },
  { id: 'save-queue-note', titleKey: 'queueNote.save', run: (h) => h.saveQueueNote() },
  { id: 'load-queue-note', titleKey: 'queueNote.load', run: (h) => h.loadQueueNote() },

  // —— 播放控制（媒体键之外的第二条路；键位由用户自己绑，见 README「命令与快捷键」）——
  { id: 'player-toggle', titleKey: 'player.playPause', run: (h) => h.playerToggle() },
  { id: 'player-next', titleKey: 'player.next', run: (h) => h.playerNext() },
  { id: 'player-prev', titleKey: 'player.prev', run: (h) => h.playerPrev() },

  // —— 只有鼠标路径的动作（P0/P1 键盘缺口的补齐处）——
  { id: 'set-album-cover', titleKey: 'cmd.setCover', run: (h) => h.setAlbumCover() },
  { id: 'open-album-in-source', titleKey: 'cmd.openInSource', run: (h) => h.openAlbumInSource() },
  { id: 'import-local-to-current', titleKey: 'cmd.importLocalToCurrent', run: (h) => h.importLocalToCurrent() },

  // 整段调序（队列行的单曲调序是 Alt+↑/↓，整段这两个命令是它的上一档）
  { id: 'queue-move-segment-up', titleKey: 'cmd.segmentUp', run: (h) => h.moveSegment(-1) },
  { id: 'queue-move-segment-down', titleKey: 'cmd.segmentDown', run: (h) => h.moveSegment(1) },
];
