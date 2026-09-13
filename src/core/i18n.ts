// 轻量 i18n：模块级当前语言 + 字典查表（插件设置里切换，默认中文）。
// 覆盖面：专辑墙、播放器、各弹窗（导入 / 登录 / 删除 / 统计 / 封面）、设置面板、命令名与提示。
// 约定：t() 在渲染 / 事件发生时求值（不要写进模块级常量，否则切换语言后不会变）。
export type Lang = 'zh' | 'en';

export const LANGUAGES: Array<{ value: Lang; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
];

export const DICT: Record<string, { zh: string; en: string }> = {
  // —— 专辑墙：排序 / 筛选 ——
  'sort.titleAsc': { zh: '标题 A → Z', en: 'Title A → Z' },
  'sort.titleDesc': { zh: '标题 Z → A', en: 'Title Z → A' },
  'sort.yearDesc': { zh: '年份：新 → 旧', en: 'Year: new → old' },
  'sort.yearAsc': { zh: '年份：旧 → 新', en: 'Year: old → new' },
  'sort.ratingDesc': { zh: '评分：高 → 低', en: 'Rating: high → low' },
  'sort.playsDesc': { zh: '播放次数：多 → 少', en: 'Plays: most → least' },
  'sort.recent': { zh: '最近播放', en: 'Recently played' },
  'filter.all': { zh: '全部', en: 'All' },
  'filter.local': { zh: '本地音源', en: 'Local audio' },
  'filter.netease': { zh: '网易云', en: 'NetEase' },
  'filter.qq': { zh: 'QQ 音乐', en: 'QQ Music' },
  'filter.collect': { zh: '仅收藏（无音源）', en: 'Collection only (no source)' },

  // —— 专辑墙：视图标题 / 工具栏 ——
  'shelf.title': { zh: '专辑墙', en: 'Album shelf' },
  'shelf.titleWithCount': { zh: '专辑墙（{n} 张）', en: 'Album shelf ({n})' },
  'shelf.search': { zh: '搜索专辑 / 艺术家 / 流派…', en: 'Search album / artist / genre…' },
  'shelf.refresh': { zh: '刷新', en: 'Refresh' },
  'shelf.sort': { zh: '排序', en: 'Sort' },
  'shelf.filter': { zh: '音源筛选', en: 'Filter by source' },
  'shelf.props': { zh: '卡片属性', en: 'Card properties' },
  'shelf.importAlbum': { zh: '导入专辑', en: 'Import album' },
  'shelf.importAudio': { zh: '导入本地音频', en: 'Import local audio' },
  'shelf.empty.title': { zh: '还没有专辑笔记', en: 'No album notes yet' },
  'shelf.empty.hint': {
    zh: '新建笔记并写入 frontmatter：tags: [album] + cover / artist / year… 即可上墙；也可用工具栏「导入」从网易云或本地音频起步。',
    en: 'Create a note with frontmatter tags: [album] plus cover / artist / year… to put it on the shelf, or start with Import in the toolbar.',
  },
  'shelf.filtered.title': { zh: '没有符合条件的专辑', en: 'No albums match' },
  'shelf.filtered.hint': { zh: '调整搜索词或筛选条件试试', en: 'Try a different search or filter.' },

  // —— 卡片属性弹层 ——
  'props.shown': { zh: '已显示（拖拽调整顺序）', en: 'Shown (drag to reorder)' },
  'props.nonePicked': { zh: '未选择任何属性：卡片只显示标题。', en: 'No properties picked: cards show the title only.' },
  'props.available': { zh: '可添加（来自笔记 frontmatter）', en: 'Available (from note frontmatter)' },
  'props.noAlbums': { zh: '还没有专辑笔记。先用工具栏「导入」建一张。', en: 'No album notes yet — create one with Import first.' },
  'props.allAdded': { zh: '已全部添加。', en: 'Everything is already shown.' },
  'props.footer': {
    zh: '属性来自专辑笔记，部分省略；在笔记中添加属性后回到这里即可添加勾选。',
    en: 'Properties come from album notes (some hidden). Add one to a note, then come back to pick it here.',
  },

  // —— 卡片 / 角标 / 菜单 ——
  'card.collect': { zh: '收藏 ·', en: 'Collect ·' },
  'card.noSource': {
    zh: '该专辑暂无音源（本地音频、neteaseId 或 QQ 音乐），已打开笔记',
    en: 'This album has no source (local audio, neteaseId or QQ Music) — opened the note instead',
  },
  'menu.play': { zh: '播放', en: 'Play' },
  'menu.openNote': { zh: '打开笔记', en: 'Open note' },
  'menu.importAudio': { zh: '导入本地音频…', en: 'Import local audio…' },
  'menu.setCover': { zh: '设置封面…', en: 'Set cover…' },
  'menu.openNetease': { zh: '在网易云打开', en: 'Open in NetEase' },
  'menu.openQq': { zh: '在 QQ 音乐打开', en: 'Open in QQ Music' },
  'menu.deleteAlbum': { zh: '删除专辑…', en: 'Delete album…' },

  // —— 音源显示名 / 音质档（队列行角标 · 播放器音质读数） ——
  // 三处取值都来自函数调用（track.ts / queue.ts），切语言后立即生效；别抄进模块级常量表。
  'src.netease': { zh: '网易云', en: 'NetEase' },
  'src.qq': { zh: 'QQ音乐', en: 'QQ Music' },
  'src.local': { zh: '本地', en: 'Local' },
  // 与 settings.quality* 区分：那组是设置面板的选项文案（较高带「（默认）」），这里是读数用的档位名
  'quality.standard': { zh: '标准', en: 'Standard' },
  'quality.higher': { zh: '较高', en: 'Higher' },
  'quality.exhigh': { zh: '极高', en: 'Extra high' },
  'quality.lossless': { zh: '无损', en: 'Lossless' },

  // —— 通用（跨视图复用的小词 / 分隔符） ——
  'common.cancel': { zh: '取消', en: 'Cancel' },
  'common.delete': { zh: '删除', en: 'Delete' },
  'common.listSep': { zh: '、', en: ', ' },
  'common.comma': { zh: '，', en: ', ' },
  'common.semicolon': { zh: '；', en: '; ' },

  // —— 播放器视图 ——
  'player.title': { zh: '黑胶播放器', en: 'Vinyl player' },
  'player.pickAlbum': { zh: '选择专辑', en: 'Choose album' },
  'player.noAlbumNotes': { zh: '（没有找到专辑笔记）', en: '(No album notes found)' },
  'player.prev': { zh: '上一首', en: 'Previous track' },
  'player.playPause': { zh: '播放 / 暂停', en: 'Play / pause' },
  'player.next': { zh: '下一首', en: 'Next track' },
  'player.appendNote': {
    zh: '在专辑笔记追加此刻感想',
    en: 'Append current thoughts to the album note',
  },
  'player.loading': { zh: '♪ 正在取碟…', en: '♪ Loading album…' },
  'player.emptyQueue': { zh: '空队列', en: 'Empty queue' },
  'player.dragToReorder': { zh: '拖拽调整顺序', en: 'Drag to reorder' },
  'player.restoreOriginal': { zh: '恢复原有顺序', en: 'Restore original order' },
  'player.restoreDone': { zh: '已恢复专辑原有顺序', en: 'Original album order restored' },
  'player.restoreLocalUnsupported': {
    zh: '本地专辑按文件名顺序播放，不支持恢复原有顺序',
    en: 'Local albums play in file-name order; restoring is not supported',
  },

  // —— 导入弹窗：专辑导入（网易云 / QQ 音乐） ——
  'import.title': { zh: '导入专辑', en: 'Import album' },
  'import.pasteHint': {
    zh: '粘贴专辑链接（或 ID），网易云与 QQ 音乐都支持：',
    en: 'Paste an album link (or ID) — both NetEase and QQ Music are supported:',
  },
  'import.exampleHint': {
    zh: '网易云：https://music.163.com/#/album?id=437968 ／ QQ 音乐：https://y.qq.com/n/ryqq/albumDetail/004VSvF52mQoQp',
    en: 'NetEase: https://music.163.com/#/album?id=437968 / QQ Music: https://y.qq.com/n/ryqq/albumDetail/004VSvF52mQoQp',
  },
  'import.linkPlaceholder': {
    zh: '网易云或 QQ 音乐专辑链接 / ID',
    en: 'NetEase or QQ Music album link / ID',
  },
  'import.linkEmpty': { zh: '请输入专辑链接或 ID', en: 'Enter an album link or ID' },
  'import.fetching': {
    zh: '正在获取专辑信息（在线音源首次使用需启动本地网关）…',
    en: 'Fetching album info (the local gateway starts on first online use)…',
  },
  'import.failed': { zh: '❌ 导入失败：', en: '❌ Import failed: ' },
  'import.action': { zh: '导入', en: 'Import' },

  // —— 导入弹窗：本地音频导入 ——
  'import.localTitle': { zh: '导入本地音频', en: 'Import local audio' },
  'import.step1': { zh: '① 选择音频文件或文件夹', en: '① Pick audio files or a folder' },
  'import.pickFiles': { zh: '选择文件…', en: 'Choose files…' },
  'import.pickFolder': { zh: '选择文件夹…', en: 'Choose folder…' },
  'import.noFilesPicked': {
    zh: '尚未选择——点上面的按钮，或把文件 / 文件夹直接拖进本窗口（文件夹按一张专辑导入，子目录结构保留）',
    en: 'Nothing picked yet — use the buttons above, or drag files / a folder into this window (a folder imports as one album and keeps its subfolders)',
  },
  'import.step2': { zh: '② 导入到', en: '② Import into' },
  'import.targetNew': { zh: '新建专辑', en: 'New album' },
  'import.namePlaceholder': {
    zh: '专辑名（自动从文件夹 / 文件名推断）',
    en: 'Album name (inferred from the folder / file names)',
  },
  'import.targetExisting': { zh: '已有专辑', en: 'Existing album' },
  'import.pickAlbum': { zh: '选择专辑…', en: 'Choose album…' },
  'import.noAlbumNotes': { zh: '（还没有专辑笔记）', en: '(No album notes yet)' },
  'import.step3': { zh: '③ 落库方式', en: '③ Storage mode' },
  'import.modeCopyLong': {
    zh: '复制进 vault（可随库同步）',
    en: 'Copy into the vault (syncs with it)',
  },
  'import.modeLinkLong': {
    zh: '外链绝对路径（不复制，仅记路径）',
    en: 'Absolute path link (path only, no copy)',
  },
  'import.start': { zh: '开始导入', en: 'Start import' },
  'import.folderSummary': {
    zh: '文件夹「{name}」→ {n} 个音频',
    en: 'Folder "{name}" → {n} audio file(s)',
  },
  'import.folderSubfolders': {
    zh: '，含 {n} 个子文件夹',
    en: ', {n} subfolder(s)',
  },
  'import.folderOthers': {
    zh: '（另有 {n} 个非音频文件已忽略）',
    en: ' ({n} non-audio file(s) ignored)',
  },
  'import.filesSelected': { zh: '已选 {n} 个文件：{names}', en: '{n} file(s) selected: {names}' },
  'import.filesMore': { zh: ' 等', en: ' …' },
  'import.libraryFound': {
    zh: '发现 {n} 张专辑（勾选后逐张建笔记并导入）',
    en: 'Found {n} album(s) — check the ones to create and import',
  },
  'import.candidateRow': { zh: '{name}（{n} 个音频）', en: '{name} ({n} audio file(s))' },
  'import.importNAlbums': { zh: '导入 {n} 张专辑', en: 'Import {n} album(s)' },
  'import.pickAtLeastOne': { zh: '请至少勾选一张专辑', en: 'Check at least one album' },
  'import.importingProgress': {
    zh: '正在导入 {i}/{n}：{name}…',
    en: 'Importing {i}/{n}: {name}…',
  },
  'import.batchDone': {
    zh: '✅ 已导入 {albums} 张专辑 / {n} 个音频',
    en: '✅ Imported {albums} album(s) / {n} audio file(s)',
  },
  'import.batchFailed': { zh: '，{n} 张失败（见控制台）', en: ', {n} failed (see the console)' },
  'import.noSupportedAudio': {
    zh: '这个文件夹里没有受支持的音频文件',
    en: 'No supported audio files in this folder',
  },
  'import.pickFirst': {
    zh: '请先选择音频文件或文件夹',
    en: 'Pick audio files or a folder first',
  },
  'import.needAlbumName': { zh: '请填写专辑名', en: 'Enter an album name' },
  'import.needTargetAlbum': { zh: '请选择目标专辑', en: 'Choose the target album' },
  'import.createFailed': { zh: '❌ 创建专辑失败', en: '❌ Could not create the album' },
  'import.importingFiles': {
    zh: '正在导入 {n} 个文件（{mode}）…',
    en: 'Importing {n} file(s) ({mode})…',
  },
  'import.modeCopyShort': { zh: '复制进 vault', en: 'copying into the vault' },
  'import.modeLinkShort': { zh: '外链引用', en: 'linking absolute paths' },
  'import.skippedExisting': {
    zh: '跳过已存在 {n} 个',
    en: 'skipped {n} already present',
  },
  'import.doneInto': {
    zh: '✅ 已导入 {n} 个音频到「{title}」',
    en: '✅ Imported {n} audio file(s) into "{title}"',
  },
  'import.nothingToImport': { zh: '⚠️ 没有可导入的音频', en: '⚠️ Nothing to import' },
  'import.fallbackCopy': {
    zh: '（部分文件无路径信息，已回退复制进 vault）',
    en: ' (some files had no path info — copied into the vault instead)',
  },
  'import.detailSuffix': { zh: '，{details}', en: ', {details}' },

  // —— 导入 / 删除：模块内文案（ImportResult.detail 等） ——
  'import.badLink': {
    zh: '无法识别链接：请粘贴网易云专辑链接（music.163.com/#/album?id=… 或纯数字 ID）或 QQ 音乐专辑链接（y.qq.com/n/ryqq/albumDetail/…）',
    en: 'Unrecognized link: paste a NetEase album link (music.163.com/#/album?id=… or a plain numeric ID) or a QQ Music album link (y.qq.com/n/ryqq/albumDetail/…)',
  },
  'import.badId': {
    zh: '无法解析专辑 ID（请粘贴专辑链接或纯数字 ID）',
    en: 'Could not parse the album ID (paste an album link or a plain numeric ID)',
  },
  'import.duplicate': {
    zh: '已存在「{title}」，无需重复导入',
    en: '"{title}" already exists — no need to import it again',
  },
  'import.fetchFailed': { zh: '获取专辑失败：{msg}', en: 'Could not fetch the album: {msg}' },
  'import.albumNoData': {
    zh: '专辑接口无数据（code={code}）',
    en: 'No data from the album API (code={code})',
  },
  'import.noteExists': { zh: '笔记已存在：{path}', en: 'Note already exists: {path}' },
  'import.neteaseDone': {
    zh: '已导入「{name}」（{artist}{year}，{n} 曲）',
    en: 'Imported "{name}" ({artist}{year}, {n} track(s))',
  },
  'import.badQqId': {
    zh: '无法解析 QQ 音乐专辑 ID（请粘贴专辑链接，如 https://y.qq.com/n/ryqq/albumDetail/004VSvF52mQoQp）',
    en: 'Could not parse the QQ Music album ID (paste an album link such as https://y.qq.com/n/ryqq/albumDetail/004VSvF52mQoQp)',
  },
  'import.qqNoData': {
    zh: 'QQ 音乐专辑接口无数据（code={code}）',
    en: 'No data from the QQ Music album API (code={code})',
  },
  'import.qqDone': {
    zh: '已导入「{name}」（{artist}{year}{tracks}）',
    en: 'Imported "{name}" ({artist}{year}{tracks})',
  },
  'import.qqTracks': { zh: '，{n} 曲', en: ', {n} track(s)' },
  'import.nameConflict': {
    zh: '已存在同名文件「{path}」，请先改名或移走后再拖入',
    en: 'A file named "{path}" already exists — rename or move it, then drop again',
  },

  // —— 删除专辑弹窗 ——
  'delete.title': { zh: '删除专辑', en: 'Delete album' },
  'delete.quoted': { zh: '「{title}」', en: '"{title}"' },
  'delete.playingHint': {
    zh: '该专辑正在播放，删除后将停止播放。',
    en: 'This album is playing — deleting it stops playback.',
  },
  'delete.alsoAudio': {
    zh: '同时删除本地音频（{n} 个文件）',
    en: 'Also delete local audio ({n} file(s))',
  },
  'delete.folderPart': { zh: '{path}（{n} 个音频）', en: '{path} ({n} audio file(s))' },
  'delete.looseFiles': { zh: '零散文件 {n} 个：{names}', en: '{n} loose file(s): {names}' },
  'delete.alsoCover': { zh: '同时删除封面图', en: 'Also delete the cover image' },
  'delete.keptFolder': {
    zh: '文件夹 {path} 内另有 {n} 个非音频文件（{names}）：只删除其中 {audios} 个音频，文件夹保留',
    en: 'Folder {path} also holds {n} non-audio file(s) ({names}): only its {audios} audio file(s) are deleted, the folder is kept',
  },
  'delete.othersMore': { zh: ' 等', en: ' …' },
  'delete.sharedAudio': {
    zh: '另有 {n} 项音频被其他专辑引用，不会删除：{paths}',
    en: '{n} audio item(s) are used by other albums and are kept: {paths}',
  },
  'delete.externalAudio': {
    zh: '外链音频 {n} 项位于库外，不会被删除（笔记删除后需自行清理）',
    en: '{n} linked audio item(s) live outside the vault and are kept (clean them up yourself after deleting the note)',
  },
  'delete.coverShared': {
    zh: '封面图被其他专辑引用，不会删除',
    en: 'The cover image is used by other albums and is kept',
  },
  'delete.trashHint': {
    zh: '文件按 Obsidian「已删除文件」设置移入回收站或永久删除。',
    en: 'Files follow your Obsidian "Deleted files" setting — trashed or deleted permanently.',
  },
  'delete.deleting': { zh: '正在删除…', en: 'Deleting…' },
  'delete.failed': { zh: '删除失败：{msg}', en: 'Delete failed: {msg}' },

  // —— 播放统计弹窗 ——
  'stats.title': { zh: '播放统计', en: 'Playback stats' },
  'stats.total': { zh: '共播放 {n} 次', en: '{n} plays in total' },
  'stats.recent': { zh: '最近播放', en: 'Recently played' },
  'stats.top': { zh: '播放最多', en: 'Most played' },
  'stats.noRecords': { zh: '暂无记录', en: 'No records yet' },
  'stats.lastTrackAt': { zh: '《{track}》 · {time}', en: '“{track}” · {time}' },
  'stats.plays': { zh: '{n} 次', en: '{n} plays' },

  // —— 设置封面弹窗 ——
  'cover.title': { zh: '设置封面 — {title}', en: 'Set cover — {title}' },
  'cover.pickInVault': { zh: '在库中选择一张图片…', en: 'Pick an image from the vault…' },
  'cover.fromVault': { zh: '从库中选择图片…', en: 'Pick from the vault…' },
  'cover.fromLocal': { zh: '选择本地图片…', en: 'Choose a local image…' },
  'cover.remove': { zh: '移除封面', en: 'Remove cover' },
  'cover.conventionHint': {
    zh: '也可以不设置：把 cover.jpg / folder.jpg / front.jpg 放进专辑的音频文件夹，或把与专辑同名的图片放进封面目录，插件会自动识别。',
    en: 'You can also skip this: drop cover.jpg / folder.jpg / front.jpg into the album audio folder, or put an image named after the album into the cover folder — the plugin finds it automatically.',
  },
  'cover.setFailed': { zh: '❌ 设置失败：', en: '❌ Failed: ' },
  'cover.updated': { zh: '封面已更新（{label}）', en: 'Cover updated ({label})' },
  'cover.removed': { zh: '已移除封面', en: 'Cover removed' },
  'cover.writeFailed': { zh: '设置封面失败：{msg}', en: 'Could not set the cover: {msg}' },

  // —— 登录弹窗（扫码 / 浏览器）：公共部分 ——
  'login.qrSection': { zh: '扫码登录', en: 'Scan to sign in' },
  'login.manualSection': { zh: '手动粘贴 Cookie（兜底）', en: 'Paste a cookie manually (fallback)' },
  'login.generating': { zh: '正在生成二维码…', en: 'Generating the QR code…' },
  'login.refreshQr': { zh: '刷新二维码', en: 'Refresh QR code' },
  'login.qrRenderFailed': { zh: '二维码渲染失败：', en: 'Could not render the QR code: ' },
  'login.qrGenFailed': { zh: '生成二维码失败：', en: 'Could not generate the QR code: ' },
  'login.saveCookie': { zh: '保存 Cookie', en: 'Save cookie' },
  'login.cookieEmpty': { zh: '请输入 Cookie 内容', en: 'Paste the cookie content first' },
  'login.verifying': { zh: '正在保存并验证…', en: 'Saving and verifying…' },
  'login.cookieOk': {
    zh: '✅ Cookie 有效，已登录：{nick}（{id}）',
    en: '✅ Cookie is valid, signed in: {nick} ({id})',
  },
  'login.cookieInvalid': {
    zh: '❌ 登录态无效（Cookie 可能过期或格式不对）',
    en: '❌ Sign-in is invalid (the cookie may be expired or malformed)',
  },
  'login.saveFailed': { zh: '保存失败：', en: 'Save failed: ' },
  'login.qrExpired': { zh: '二维码已过期，正在刷新…', en: 'QR code expired, refreshing…' },
  'login.waitScan': { zh: '等待扫码，', en: 'Waiting for the scan — ' },
  'login.scannedConfirm': {
    zh: '已扫码，请在手机上确认登录…',
    en: 'Scanned — confirm the sign-in on your phone…',
  },
  'login.authorizing': {
    zh: '授权成功，正在读取登录态…',
    en: 'Authorized — reading the sign-in state…',
  },
  'login.loggedIn': {
    zh: '✅ 已登录：{nick}（{id}）{vip}。登录会话已保存。',
    en: '✅ Signed in: {nick} ({id}){vip}. The session has been saved.',
  },
  'login.noSession': {
    zh: '❌ 已授权但未取得有效登录会话，请刷新二维码重试，或使用「手动粘贴 Cookie」。',
    en: '❌ Authorized but no valid session was issued — refresh the QR code, or use "Paste a cookie manually".',
  },
  'login.qrAbnormal': {
    zh: '扫码状态异常（{code}），正在重试；也可刷新二维码。',
    en: 'Unexpected QR status ({code}), retrying — you can also refresh the QR code.',
  },
  'login.qrCheckFailed': {
    zh: '扫码检查失败：{msg}。正在重试，也可刷新二维码。',
    en: 'QR check failed: {msg}. Retrying — you can also refresh the QR code.',
  },

  // —— 登录弹窗：音源文案（网易云） ——
  'login.netease.title': { zh: '网易云登录', en: 'NetEase sign-in' },
  'login.netease.appHint': { zh: '请用网易云音乐 App 扫码', en: 'Scan with the NetEase Cloud Music app' },
  'login.netease.manualHint': {
    zh: '浏览器打开 music.163.com 登录 → F12 → Application（应用）→ Cookies → music.163.com，复制 MUSIC_U 的 Value，按 MUSIC_U=复制的值 粘贴到下面。此方法也可读取 HttpOnly Cookie。',
    en: 'Sign in to music.163.com in a browser → F12 → Application → Cookies → music.163.com, copy the Value of MUSIC_U, then paste it below as MUSIC_U=<value>. This also reads HttpOnly cookies.',
  },
  'login.netease.noSessionHint': {
    zh: '❌ 已授权但未取得有效登录会话（新设备的匿名注册可能被网易云限流）。请刷新二维码重试；仍不行请改用「网易云浏览器登录（官方登录页）」，也可手动粘贴 Cookie。',
    en: '❌ Authorized but no valid session was issued (anonymous device registration may be rate-limited by NetEase). Refresh the QR code and try again; if that fails, use "NetEase browser sign-in (official page)" or paste a cookie manually.',
  },

  // —— 登录弹窗：音源文案（QQ 音乐） ——
  'login.qq.title': { zh: 'QQ 音乐登录', en: 'QQ Music sign-in' },
  'login.qq.appHint': {
    zh: '请用手机 QQ 扫码（此为 QQ 互联二维码，QQ 音乐 App 的「扫一扫」识别不了）',
    en: 'Scan with mobile QQ (this is a QQ Connect QR code — the QQ Music app scanner cannot read it)',
  },
  'login.qq.fallbackHint': {
    zh: '若扫码后长时间停在「已扫码」，请改用设置里的「QQ 浏览器登录」——在官方页面里微信 / QQ 扫码都能完成登录（已实测可用）。',
    en: 'If it stays on "scanned" for a long time, use "QQ browser sign-in" in the settings — both WeChat and QQ scans work on the official page (verified).',
  },
  'login.qq.manualHint': {
    zh: '浏览器打开 y.qq.com 登录 → F12 → Application（应用）→ Cookies → y.qq.com，复制 qm_keyst 的 Value，按 qm_keyst=复制的值 粘贴到下面。此方法也可读取 HttpOnly Cookie。',
    en: 'Sign in to y.qq.com in a browser → F12 → Application → Cookies → y.qq.com, copy the Value of qm_keyst, then paste it below as qm_keyst=<value>. This also reads HttpOnly cookies.',
  },

  // —— 浏览器登录弹窗 ——
  'login.web.netease.title': { zh: '网易云登录（浏览器）', en: 'NetEase sign-in (browser)' },
  'login.web.netease.displayName': { zh: '网易云', en: 'NetEase' },
  'login.web.qq.title': { zh: 'QQ 音乐登录（浏览器）', en: 'QQ Music sign-in (browser)' },
  'login.web.qq.displayName': { zh: 'QQ 音乐', en: 'QQ Music' },
  'login.web.readingAccount': { zh: '正在读取当前账号…', en: 'Reading the current account…' },
  'login.web.account': {
    zh: '当前账号：{nick}（{id}）；新登录验证通过后才会替换。',
    en: 'Current account: {nick} ({id}) — it is replaced only after a new sign-in verifies.',
  },
  'login.web.notLoggedIn': {
    zh: '当前未登录；登录完成后自动验证并接回账号。',
    en: 'Not signed in yet — once you finish, the account is verified and attached automatically.',
  },
  'login.web.accountFailed': {
    zh: '当前账号读取失败，可在设置页查看登录态。',
    en: 'Could not read the current account — check the sign-in state in the settings.',
  },
  'login.web.step1': {
    zh: '第 1 步：点击下方按钮，在弹出的官方窗口内完成登录（扫码 / 账号密码均可）。',
    en: 'Step 1: click the button below and sign in inside the official window that opens (QR code or password).',
  },
  'login.web.step2': {
    zh: '第 2 步：登录完成后无需操作——插件会自动检测、验证并接回账号；验证通过前不会覆盖现有登录。',
    en: 'Step 2: nothing else to do — the plugin detects, verifies and attaches the account automatically; the existing sign-in is never overwritten before verification.',
  },
  'login.web.openWindow': {
    zh: '打开官方登录窗口',
    en: 'Open the official sign-in window',
  },
  'login.web.check': { zh: '检测登录', en: 'Check sign-in' },
  'login.web.opening': {
    zh: '正在打开官方登录窗口…',
    en: 'Opening the official sign-in window…',
  },
  'login.web.openFailed': {
    zh: '无法打开登录窗口：{msg}（可改用「{fallback}」或手动粘贴 Cookie）',
    en: 'Could not open the sign-in window: {msg} (use "{fallback}" or paste a cookie manually instead)',
  },
  'login.web.success': { zh: '{name}登录成功，已接回账号', en: '{name} signed in — account attached' },
  'login.web.saved': { zh: '✅ 登录成功，账号已保存。', en: '✅ Signed in, account saved.' },
  'login.web.closed': {
    zh: '登录窗口已关闭，尚未完成登录。可点击「打开官方登录窗口」重试。',
    en: 'The sign-in window was closed before finishing. Click "Open the official sign-in window" to retry.',
  },

  // —— 设置面板：标签页 / 通用 ——
  'settings.tab.general': { zh: '通用', en: 'General' },
  'settings.tab.appearance': { zh: '外观', en: 'Appearance' },
  'settings.tab.source': { zh: '源', en: 'Sources' },
  'settings.section.general': { zh: '通用', en: 'General' },
  'settings.language': { zh: '语言 / Language', en: 'Language / 语言' },
  'settings.languageDesc': {
    zh: '界面语言（主要覆盖专辑墙：工具栏、排序筛选、空态、卡片菜单）。默认中文。',
    en: 'Interface language (shelf toolbar, sorting, filters, empty states, card menus). Chinese by default.',
  },
  'settings.path': { zh: '路径', en: 'Paths' },
  'settings.albumFolder': { zh: '专辑文件夹', en: 'Album folder' },
  'settings.albumFolderDesc': {
    zh: '专辑笔记所在目录（tags: [album]）',
    en: 'Folder holding album notes (tags: [album])',
  },
  'settings.coverFolder': { zh: '封面目录', en: 'Cover folder' },
  'settings.coverFolderDesc': { zh: '导入专辑时封面落盘位置', en: 'Where imported covers are stored' },
  'settings.template': { zh: '模板', en: 'Template' },
  'settings.albumTemplate': { zh: '本地专辑笔记模板', en: 'Local album note template' },
  'settings.albumTemplateDesc': {
    zh: '留空 = 用内置模板。可指定 vault 内任意 .md（如 Vinyl Life/模板/专辑笔记模板.md）；支持占位符 {{title}} / {{audioFolder}} / {{date}} / {{time}}，不需要的占位符留空行会被自动清掉。',
    en: 'Empty = built-in template. Point it at any .md in the vault (e.g. Vinyl Life/模板/专辑笔记模板.md); the placeholders {{title}} / {{audioFolder}} / {{date}} / {{time}} are supported, and blank lines left by unused placeholders are stripped.',
  },
  'settings.albumTemplatePlaceholder': {
    zh: '例如：Vinyl Life/模板/专辑笔记模板.md',
    en: 'e.g. Vinyl Life/模板/专辑笔记模板.md',
  },
  'settings.section.playback': { zh: '播放', en: 'Playback' },
  'settings.defaultSource': { zh: '默认音源', en: 'Default source' },
  'settings.defaultSourceDesc': { zh: '笔记里的 source 字段优先', en: 'The source field in the note wins' },
  'settings.sourceAuto': { zh: '自动（本地优先）', en: 'Auto (local first)' },
  'settings.sourceLocal': { zh: '仅本地', en: 'Local only' },
  'settings.sourceNetease': { zh: '仅网易云', en: 'NetEase only' },
  'settings.sourceQq': { zh: '仅 QQ 音乐', en: 'QQ Music only' },
  'settings.quality': { zh: '在线音源音质', en: 'Online audio quality' },
  'settings.qualityDesc': {
    zh: '本地音频按原文件播放；无损需对应平台会员',
    en: 'Local audio plays as-is; lossless needs the platform membership',
  },
  'settings.qualityStandard': { zh: '标准', en: 'Standard' },
  'settings.qualityHigher': { zh: '较高（默认）', en: 'Higher (default)' },
  'settings.qualityExhigh': { zh: '极高', en: 'Extra high' },
  'settings.qualityLossless': { zh: '无损', en: 'Lossless' },
  'settings.autoPlay': { zh: '自动播放', en: 'Autoplay' },
  'settings.autoPlayDesc': { zh: '队列就绪后立即播放', en: 'Start playing as soon as the queue is ready' },
  'settings.section.player': { zh: '播放器', en: 'Player' },
  'settings.playerLocation': { zh: '默认位置', en: 'Default location' },
  'settings.playerLocationDesc': { zh: '打开播放器时的落位', en: 'Where the player opens' },
  'settings.locSidebar': { zh: '侧栏', en: 'Sidebar' },
  'settings.locTab': { zh: '主区标签页', en: 'Main tab' },
  'settings.locWindow': { zh: '独立窗口', en: 'Separate window' },
  'settings.section.stats': { zh: '播放统计', en: 'Playback stats' },
  'settings.statsTotal': { zh: '累计播放', en: 'Total plays' },
  'settings.statsDesc': {
    zh: '{plays} 次 · {albums} 张专辑 · {tracks} 首曲目（存插件 data.json）',
    en: '{plays} plays · {albums} albums · {tracks} tracks (stored in the plugin data.json)',
  },
  'settings.clearStats': { zh: '清除统计', en: 'Clear stats' },

  // —— 设置面板：外观 ——
  'settings.section.shelf': { zh: '专辑墙', en: 'Album shelf' },
  'settings.columns': { zh: '每行专辑数量', en: 'Albums per row' },
  'settings.columnsDesc': { zh: '自动＝随面板宽度', en: 'Auto = follow the panel width' },
  'settings.columnsAuto': { zh: '自动', en: 'Auto' },
  'settings.columnsN': { zh: '{n} 张', en: '{n} per row' },
  'settings.discDirection': { zh: '黑胶动画方向', en: 'Vinyl animation direction' },
  'settings.discDirectionDesc': { zh: '悬停时唱片从封面弹出的一侧', en: 'Side the record slides out from on hover' },
  'settings.discRight': { zh: '向右', en: 'Right' },
  'settings.discLeft': { zh: '向左', en: 'Left' },
  'settings.discUp': { zh: '向上', en: 'Up' },
  'settings.discDown': { zh: '向下', en: 'Down' },
  'settings.section.vinyl': { zh: '黑胶唱片', en: 'Vinyl record' },
  'settings.recordColor': { zh: '唱片配色', en: 'Record color' },
  'settings.recordColorDesc': {
    zh: '专辑墙卡片与播放器转盘同时生效',
    en: 'Applies to shelf cards and the player turntable',
  },
  'settings.recordBlack': { zh: '黑胶', en: 'Black' },
  'settings.recordYellow': { zh: '黄胶', en: 'Yellow' },
  'settings.recordBlue': { zh: '蓝胶', en: 'Blue' },
  'settings.recordWhite': { zh: '白胶', en: 'White' },
  'settings.deck': { zh: '播放器配色', en: 'Player finish' },
  'settings.deckDesc': { zh: '设备面板材质', en: 'Deck panel material' },
  'settings.deckWalnut': { zh: '胡桃木', en: 'Walnut' },
  'settings.deckBlack': { zh: '黑胶黑', en: 'Vinyl black' },
  'settings.spinSpeed': { zh: '转盘转速', en: 'Turntable speed' },
  'settings.spinSpeedDesc': { zh: '播放时唱片一圈的时间', en: 'Time for one record revolution while playing' },
  'settings.spinSlow': { zh: '慢', en: 'Slow' },
  'settings.spinNormal': { zh: '标准（默认）', en: 'Normal (default)' },
  'settings.spinFast': { zh: '快', en: 'Fast' },

  // —— 设置面板：源 ——
  'settings.section.external': { zh: '外来源', en: 'Online sources' },
  'settings.sub.netease': { zh: '网易云', en: 'NetEase' },
  'settings.sub.qq': { zh: 'QQ 音乐', en: 'QQ Music' },
  'settings.checkingLogin': { zh: '检测登录态…', en: 'Checking the sign-in state…' },
  'settings.checkFailed': { zh: '登录态检测失败：{msg}', en: 'Sign-in check failed: {msg}' },
  'settings.loggedIn': { zh: '已登录', en: 'Signed in' },
  'settings.statusLoggedIn': { zh: '✅ {name}（{id}）', en: '✅ {name} ({id})' },
  'settings.statusLoggedInQq': { zh: '✅ {name}（QQ {id}）', en: '✅ {name} (QQ {id})' },
  'settings.cookieInvalid': { zh: '❌ Cookie 已失效，请重新登录', en: '❌ The cookie has expired — please sign in again' },
  'settings.notLoggedIn': { zh: '未登录', en: 'Not signed in' },
  'settings.gatewayOk': { zh: '网关正常', en: 'Gateway OK' },
  'settings.gatewayDown': { zh: '网关未运行', en: 'Gateway not running' },
  'settings.qrLogin': { zh: '扫码登录', en: 'QR sign-in' },
  'settings.qrLoginDescNetease': {
    zh: '手机网易云 App 扫码授权',
    en: 'Authorize by scanning with the NetEase Cloud Music app',
  },
  'settings.webLogin': { zh: '浏览器登录', en: 'Browser sign-in' },
  'settings.webLoginDescNetease': {
    zh: '独立窗口登录 music.163.com',
    en: 'Sign in to music.163.com in a separate window',
  },
  'settings.logout': { zh: '退出登录', en: 'Sign out' },
  'settings.logoutDescNetease': { zh: '清除本机 Cookie（.cookie）', en: 'Clear the local cookie (.cookie)' },
  'settings.logoutAction': { zh: '退出', en: 'Sign out' },
  'settings.qrLoginDescQq': { zh: '手机 QQ 扫码授权', en: 'Authorize by scanning with mobile QQ' },
  'settings.webLoginDescQq': {
    zh: '独立窗口登录 y.qq.com',
    en: 'Sign in to y.qq.com in a separate window',
  },
  'settings.logoutDescQq': { zh: '清除本机 Cookie（.qq-cookie）', en: 'Clear the local cookie (.qq-cookie)' },
  'settings.sub.runtime': { zh: '运行环境', en: 'Runtime' },
  'settings.nodeMissing': {
    zh: '未探测（在线音源首次使用时自动探测；未安装则仅本地源可用）',
    en: 'Not detected yet (detected on first online use; without Node.js only local sources work)',
  },
  'settings.redetect': { zh: '重新探测', en: 'Detect again' },
  'settings.detecting': { zh: '探测中…', en: 'Detecting…' },
  'settings.section.local': { zh: '本地源', en: 'Local sources' },
  'settings.audioFolder': { zh: '音频根目录', en: 'Audio root folder' },
  'settings.audioFolderDesc': {
    zh: '复制入库时落到 <根目录>/<专辑名>/',
    en: 'Copies land in <root>/<album name>/',
  },
  'settings.importMode': { zh: '落库模式', en: 'Storage mode' },
  'settings.importModeDesc': {
    zh: '复制进 vault（可随库同步），或仅记录外链绝对路径',
    en: 'Copy into the vault (syncs with it), or only record the absolute path',
  },
  'settings.importCopy': { zh: '复制进 vault', en: 'Copy into vault' },
  'settings.importLink': { zh: '外链绝对路径', en: 'Absolute path link' },

  // —— 命令名（命令面板 / ribbon 提示） ——
  'cmd.openShelf': { zh: '打开专辑墙', en: 'Open album shelf' },
  'cmd.openShelfSidebar': { zh: '在侧栏打开专辑墙', en: 'Open album shelf in the sidebar' },
  'cmd.openPlayer': { zh: '打开播放器', en: 'Open player' },
  'cmd.popoutPlayer': { zh: '弹出播放器窗口', en: 'Open the player in a popout window' },
  'cmd.neteaseLogin': { zh: '网易云扫码登录', en: 'NetEase QR sign-in' },
  'cmd.neteaseWebLogin': {
    zh: '网易云浏览器登录（官方登录页）',
    en: 'NetEase browser sign-in (official page)',
  },
  'cmd.qqLogin': { zh: 'QQ 音乐扫码登录', en: 'QQ Music QR sign-in' },
  'cmd.qqWebLogin': {
    zh: 'QQ 音乐浏览器登录（官方登录页）',
    en: 'QQ Music browser sign-in (official page)',
  },
  'cmd.qqLogout': { zh: '退出 QQ 音乐登录', en: 'Sign out of QQ Music' },
  'cmd.neteaseLogout': { zh: '退出网易云登录', en: 'Sign out of NetEase' },
  'cmd.migrateCookie': {
    zh: '从 Mineradio 迁移登录 Cookie',
    en: 'Migrate the sign-in cookie from Mineradio',
  },
  'cmd.m1SelfTest': {
    zh: 'M1 自检：双源队列 + 播放验证',
    en: 'M1 self-test: dual-source queue + playback',
  },
  'cmd.m2SelfTest': {
    zh: 'M2 自检：专辑墙数据 + 音源角标',
    en: 'M2 self-test: shelf data + source badges',
  },
  'cmd.m3SelfTest': { zh: 'M3 自检：交接状态机验证', en: 'M3 self-test: handoff state machine' },
  'cmd.importAlbum': { zh: '导入专辑', en: 'Import album' },
  'cmd.importLocal': { zh: '导入本地音频', en: 'Import local audio' },
  'cmd.appendNote': {
    zh: '在专辑笔记追加此刻感想',
    en: 'Append current thoughts to the album note',
  },
  'cmd.insertNowPlaying': {
    zh: '插入此刻正在听的曲目',
    en: 'Insert the currently playing track',
  },
  'cmd.showStats': { zh: '显示播放统计', en: 'Show playback stats' },
  'cmd.m4SelfTest': {
    zh: 'M4 自检：导入 + 感想 + 统计验证',
    en: 'M4 self-test: import + notes + stats',
  },
  'cmd.qqSelfTest': {
    zh: 'M5 自检：QQ 音乐源（登录 + 专辑播放）',
    en: 'M5 self-test: QQ Music source (sign-in + playback)',
  },
  'cmd.createTemplate': {
    zh: '创建本地专辑模板文件（可编辑）',
    en: 'Create an editable local album template file',
  },
  'cmd.ribbonShelf': { zh: 'Vinyl Life 专辑墙', en: 'Vinyl Life album shelf' },

  // —— 提示（main.ts 里的 notice） ——
  'notice.templateFailed': { zh: '创建模板失败：{msg}', en: 'Could not create the template: {msg}' },
  'notice.templateReady': {
    zh: '模板已就绪：{path} —— 随便改，之后导入本地专辑按它生成笔记',
    en: 'Template ready: {path} — edit it freely; local album imports use it from now on',
  },
  'notice.libraryRoot': {
    zh: '{hint}——请用命令「导入本地音频」选择具体的专辑文件夹（可批量勾选）',
    en: '{hint} — use the "Import local audio" command to pick a specific album folder (you can check several at once)',
  },
  'notice.noSupportedAudio': {
    zh: '这个文件夹里没有受支持的音频文件',
    en: 'No supported audio files in this folder',
  },
  'notice.createAlbumFailed': {
    zh: '从文件新建专辑失败',
    en: 'Could not create an album from these files',
  },
  'notice.nothingToImportExisting': {
    zh: '没有可导入的音频（文件已存在）',
    en: 'Nothing to import (the files are already there)',
  },
  'notice.nothingToImport': { zh: '没有可导入的音频', en: 'Nothing to import' },
  'notice.imported': {
    zh: '已导入 {n} 个音频到「{title}」（{mode}）',
    en: 'Imported {n} audio file(s) into "{title}" ({mode})',
  },
  'notice.importedSkipped': { zh: '，跳过已存在 {n} 个', en: ', skipped {n} already present' },
  'notice.importFallback': {
    zh: '（部分文件无路径信息，已回退复制）',
    en: ' (some files had no path info — copied instead)',
  },
  'notice.importFailed': { zh: '导入失败：{msg}', en: 'Import failed: {msg}' },
  'notice.albumDeleted': { zh: '已删除专辑「{title}」', en: 'Deleted album "{title}"' },
  'notice.albumDeletedAssets': { zh: '（含 {n} 项本地文件）', en: ' (including {n} local file(s))' },
  'notice.noPlayingAlbum': {
    zh: '当前没有正在播放的专辑（先播放一张专辑再追加感想）',
    en: 'No album is playing right now (play one first, then append your thoughts)',
  },
  'notice.appended': { zh: '已追加到「{name}」', en: 'Appended to "{name}"' },
  // 插入此刻正在听：行文案（插进当前笔记，语法随语言变 → 用 tf 占位符拼）
  'notice.nowPlayingLine': {
    zh: '此刻正在听《{album}》的《{track}》',
    en: 'Now playing: {track} — {album}',
  },
  'notice.nothingPlaying': { zh: '当前没有正在播放的歌曲', en: 'Nothing is playing right now' },
  'notice.noActiveNote': {
    zh: '请先打开一篇笔记并把光标放到要插入的位置',
    en: 'Open a note first and put the cursor where you want to insert',
  },
  'notice.neteaseLoggedOut': { zh: '已退出网易云登录', en: 'Signed out of NetEase' },
  'notice.qqLoggedOut': { zh: '已退出 QQ 音乐登录', en: 'Signed out of QQ Music' },
  'notice.migrateFailed': { zh: '迁移失败：{detail}', en: 'Migration failed: {detail}' },

  // —— util：用户可见的通用提示 ——
  'util.skippedFormats': {
    zh: '已跳过 {n} 个不支持的文件：{names}{more}',
    en: 'Skipped {n} unsupported file(s): {names}{more}',
  },
  'util.skippedFormatsMore': { zh: ' 等', en: ' …' },
  'util.libraryRootHint': {
    zh: '「{name}」根层没有音频，但有 {n} 个子文件夹各含音频——看起来是音乐库根目录',
    en: '"{name}" has no audio at the top level, but {n} subfolder(s) hold audio — this looks like a music library root',
  },
  'util.restrictionLoginRequired': { zh: '需登录（login_required）', en: 'Sign-in required (login_required)' },
  'util.restrictionVip': { zh: '会员专享（vip_required）', en: 'Members only (vip_required)' },
  'util.restrictionCopyright': {
    zh: '无版权/下架（copyright_unavailable）',
    en: 'Unavailable / removed (copyright_unavailable)',
  },
  'util.restrictionTrial': { zh: '仅试听（trial_only）', en: 'Trial only (trial_only)' },
  'util.restrictionUnknown': { zh: '未知限制码 {code}', en: 'Unknown restriction code {code}' },
  'util.restrictionUnavailable': { zh: '音源不可用', en: 'Source unavailable' },
};

let current: Lang = 'zh';

export function setLanguage(lang: string | undefined): void {
  current = lang === 'en' ? 'en' : 'zh';
}

export function getLanguage(): Lang {
  return current;
}

/** 查表；缺键时回退中文，再缺则返回 key 本身（便于发现漏翻） */
export function t(key: string): string {
  const entry = DICT[key];
  if (!entry) return key;
  return entry[current] || entry.zh;
}

/** 带占位符的查表：值里的 {name} 用 vars 替换（缺键 / 缺变量时原样保留） */
export function tf(key: string, vars: Record<string, string | number>): string {
  return t(key).replace(/\{(\w+)\}/g, (m, k: string) =>
    vars[k] == null ? m : String(vars[k])
  );
}
