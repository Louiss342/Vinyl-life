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
  // 排序依据名；方向词见 sort.dir.*（A-Z / Z-A 两语言一致，不进词典，见 core/shelf-sort.ts）
  'sort.title': { zh: '专辑名称', en: 'Album title' },
  'sort.artist': { zh: '作者名称', en: 'Artist' },
  'sort.year': { zh: '发行日期', en: 'Release date' },
  'sort.plays': { zh: '播放次数', en: 'Play count' },
  'sort.rating': { zh: '评分', en: 'Rating' },
  'sort.recent': { zh: '最近播放', en: 'Recently played' },
  'sort.custom': { zh: '自定义排序依据', en: 'Custom sort' },
  'sort.customLabel': { zh: '自定义排序依据：{name}[{dir}]', en: 'Custom: {name}[{dir}]' },
  'sort.noProps': {
    zh: '专辑笔记里还没有可排序的属性',
    en: 'No sortable properties on your album notes yet',
  },
  // 方向词（工具栏方案：给具体动作，不再是「早-晚」这种两头式）
  'sort.dir.newestFirst': { zh: '最新在前', en: 'Newest first' },
  'sort.dir.earliestFirst': { zh: '最早在前', en: 'Earliest first' },
  'sort.dir.mostFirst': { zh: '最多在前', en: 'Most first' },
  'sort.dir.leastFirst': { zh: '最少在前', en: 'Least first' },
  'sort.dir.highFirst': { zh: '高分在前', en: 'Highest first' },
  'sort.dir.lowFirst': { zh: '低分在前', en: 'Lowest first' },
  'sort.dir.recentFirst': { zh: '最近在前', en: 'Most recent first' },
  'sort.dir.asc': { zh: '升序', en: 'Ascending' },
  'sort.dir.desc': { zh: '降序', en: 'Descending' },
  'filter.all': { zh: '全部', en: 'All' },
  'filter.local': { zh: '本地音源', en: 'Local audio' },
  'filter.netease': { zh: '网易云', en: 'NetEase' },
  'filter.qq': { zh: 'QQ 音乐', en: 'QQ Music' },
  'filter.kugou': { zh: '酷狗音乐', en: 'Kugou Music' },
  'filter.collect': { zh: '仅收藏（无音源）', en: 'Collection only (no source)' },
  // 分段控件里放得下的短名（完整名字仍在 aria-label 上）
  'filter.collectShort': { zh: '仅收藏', en: 'Collect' },

  // —— 专辑墙：视图标题 / 工具栏（工具栏方案 2026-09-18：单行，按钮只留图标） ——
  'shelf.title': { zh: '专辑墙', en: 'Album shelf' },
  'shelf.heading': { zh: '我的唱片', en: 'My records' },
  // 标题与数量同行：数量用手绘体；有搜索 / 来源筛选时改报「匹配数/总数」
  'shelf.search': { zh: '在这里快速检索你的唱片:)', en: 'Quickly search your records here :)' },
  'shelf.searchClear': { zh: '清空关键词', en: 'Clear the keyword' },
  'toolbar.search': { zh: '搜索', en: 'Search' },
  'toolbar.display': { zh: '陈列', en: 'Display' },
  'toolbar.add': { zh: '添加', en: 'Add' },
  'toolbar.more': { zh: '更多', en: 'More' },
  // 陈列：非「全部」的筛选要在单行工具栏里保持可见（按钮图标后面跟一个来源名）
  'toolbar.displayFiltered': { zh: '陈列 · {source}', en: 'Display · {source}' },
  'shelf.refresh': { zh: '刷新', en: 'Refresh' },
  'shelf.batchDelete': { zh: '批量删除', en: 'Batch delete' },
  'shelf.empty.title': { zh: '还没有专辑笔记', en: 'No album notes yet' },
  'shelf.empty.hint': {
    zh: '新建笔记并写入 frontmatter：tags: [album] + cover / artist / year… 即可上墙；也可用工具栏「添加」从网易云或本地音频起步。',
    en: 'Create a note with frontmatter tags: [album] plus cover / artist / year… to put it on the shelf, or start with Add in the toolbar.',
  },
  // —— 专辑墙：空态教程（文案取自 Excalidraw 设计稿 Drawing 2026-09-15 14.14.52）——
  'shelf.tutorial.title': { zh: 'Enjoy Your Vinyl Life！！！', en: 'Enjoy Your Vinyl Life!!!' },
  'shelf.tutorial.emptyTitle': { zh: '现在的专辑墙还什么都没有哦0.o', en: 'The album wall is still empty 0.o' },
  'shelf.tutorial.importA': { zh: '如果你想快速导入你心爱的专辑', en: 'Want to import your beloved albums in no time?' },
  'shelf.tutorial.importB': {
    zh: '尝试点击这个按钮吧，本地和在线都可以哦:)',
    en: 'Try this button — local and online both work :)',
  },
  'shelf.tutorial.onlineOnly': {
    zh: '在线平台目前支持网易云音乐、QQ音乐和酷狗音乐:)',
    en: 'Online platforms currently support NetEase Cloud Music, QQ Music and Kugou Music :)',
  },
  'shelf.tutorial.moreSoon': {
    zh: '其他平台等待我后续的更新吧^_^',
    en: 'More platforms are coming in future updates ^_^',
  },
  'shelf.tutorial.playerSidebar': {
    zh: '播放器默认是在侧边栏哦',
    en: 'The player lives in the sidebar by default',
  },
  'shelf.tutorial.playerHere': { zh: '大概是在这里', en: 'Roughly here' },
  'shelf.tutorial.playAfterImport': {
    zh: '当你导入你的专辑后 点击它应该就会出现了！',
    en: 'Once you import an album, click it and it should show up!',
  },
  'shelf.tutorial.loginNote': {
    zh: '使用在线播放别忘了在设置里登陆你的平台账号……',
    en: 'For online playback, remember to sign in to your platform account in Settings…',
  },
  'shelf.filtered.title': { zh: '没有符合条件的专辑', en: 'No albums match' },
  'shelf.filtered.hint': { zh: '调整搜索词或筛选条件试试', en: 'Try a different search or filter.' },
  'shelf.searchOnline': { zh: '在线查找「{q}」', en: 'Search online for “{q}”' },

  // —— 专辑墙：陈列面板（来源 / 排列 / 显示） ——
  'display.source': { zh: '来源', en: 'Source' },
  'display.arrange': { zh: '排列', en: 'Sort' },
  'display.sortBy': { zh: '依据', en: 'Sort by' },
  'display.dir': { zh: '方向', en: 'Direction' },
  'display.view': { zh: '显示', en: 'Display' },
  'display.columns': { zh: '每行数量', en: 'Per row' },
  'display.props': { zh: '封面下的信息', en: 'Info under cover' },
  'display.propsNone': { zh: '未显示', en: 'None' },
  'display.back': { zh: '返回陈列', en: 'Back to Display' },
  'display.customGroup': { zh: '自定义属性', en: 'Custom properties' },

  // —— 专辑墙：更多菜单 ——
  'more.select': { zh: '选择专辑', en: 'Select albums' },
  'more.refresh': { zh: '刷新专辑墙', en: 'Refresh shelf' },
  'menu.selectMany': { zh: '选择多张', en: 'Select multiple' },

  // —— 专辑墙：选择模式（工具栏切换用途；确认弹窗） ——
  'batch.selected': { zh: '已选择 {n} 张', en: '{n} selected' },
  'batch.selectAll': { zh: '全选当前 {n} 张', en: 'Select all {n}' },
  'batch.clear': { zh: '清空选择', en: 'Clear selection' },
  'batch.delete': { zh: '删除…', en: 'Delete…' },
  'batch.exit': { zh: '完成', en: 'Done' },
  'batchDelete.title': { zh: '批量删除专辑', en: 'Delete albums' },
  'batchDelete.summary': {
    zh: '将要删除以下 {n} 张专辑的笔记：',
    en: 'Notes for these {n} album(s) will be deleted:',
  },
  'batchDelete.more': { zh: '……等共 {n} 张', en: '…and {n} in total' },
  'batchDelete.playingHint': {
    zh: '其中包含正在播放的专辑，删除后将停止播放。',
    en: 'One of them is playing — deleting stops playback.',
  },
  'batchDelete.alsoAudio': {
    zh: '同时删除本地音频（{n} 个）',
    en: 'Also delete local audio ({n})',
  },
  'batchDelete.alsoCover': { zh: '同时删除封面（{n} 张）', en: 'Also delete covers ({n})' },
  'batchDelete.coverShared': {
    zh: '部分封面图被其他专辑引用，不会删除',
    en: 'Some cover images are used by other albums and are kept',
  },

  // —— 卡片属性弹层 ——
  'props.shown': { zh: '已显示（拖拽调整顺序）', en: 'Shown (drag to reorder)' },
  'props.nonePicked': { zh: '未选择任何属性：卡片只显示标题。', en: 'No properties picked: cards show the title only.' },
  'props.noAlbums': { zh: '还没有专辑笔记。先用工具栏「导入」建一张。', en: 'No album notes yet — create one with Import first.' },
  'props.allAdded': { zh: '目前已全部添加。', en: 'Everything is already added.' },
  'props.footer': {
    zh: '可显示的属性来自对应的专辑笔记，想要修改直接在你的专辑笔记中修改就可以啦:)',
    en: 'The showable properties come from the album note — to change them, just edit your album note :)',
  },

  // —— 卡片 / 角标 / 菜单 ——
  'card.collect': { zh: '收藏 ·', en: 'Collect ·' },
  'card.noSource': {
    zh: '该专辑暂无音源（本地音频、neteaseId、qqId 或 kugouId），已打开笔记',
    en: 'This album has no source (local audio, neteaseId, qqId or kugouId) — opened the note instead',
  },
  'menu.play': { zh: '播放', en: 'Play' },
  'menu.openNote': { zh: '打开笔记', en: 'Open note' },
  'menu.importAudio': { zh: '导入本地音频…', en: 'Import local audio…' },
  'menu.setCover': { zh: '设置封面…', en: 'Set cover…' },
  'menu.openNetease': { zh: '在网易云打开', en: 'Open in NetEase' },
  'menu.openQq': { zh: '在 QQ 音乐打开', en: 'Open in QQ Music' },
  'menu.openKugou': { zh: '在酷狗音乐打开', en: 'Open in Kugou Music' },
  'menu.deleteAlbum': { zh: '删除专辑…', en: 'Delete album…' },

  // —— 音源显示名 / 音质档（队列行角标 · 播放器音质读数） ——
  // 三处取值都来自函数调用（track.ts / queue.ts），切语言后立即生效；别抄进模块级常量表。
  'src.netease': { zh: '网易云', en: 'NetEase' },
  'src.qq': { zh: 'QQ音乐', en: 'QQ Music' },
  'src.kugou': { zh: '酷狗音乐', en: 'Kugou Music' },
  'src.local': { zh: '本地', en: 'Local' },
  // —— 通用（跨视图复用的小词 / 分隔符） ——
  'common.cancel': { zh: '取消', en: 'Cancel' },
  'common.close': { zh: '关闭', en: 'Close' },
  'common.delete': { zh: '删除', en: 'Delete' },
  'common.listSep': { zh: '、', en: ', ' },
  'common.comma': { zh: '，', en: ', ' },
  'common.semicolon': { zh: '；', en: '; ' },
  'common.colon': { zh: '：', en: ': ' },

  // —— 播放器视图 ——
  'player.title': { zh: '黑胶播放器', en: 'Vinyl player' },
  'player.prev': { zh: '上一首', en: 'Previous track' },
  'player.playPause': { zh: '播放 / 暂停', en: 'Play / pause' },
  'player.next': { zh: '下一首', en: 'Next track' },
  'player.volume': { zh: '音量', en: 'Volume' },
  'player.seek': { zh: '歌曲进度', en: 'Track position' },
  'player.noteAlbum': {
    zh: '给「{name}」写点什么吧:)',
    en: 'Write something for “{name}” :)',
  },
  'player.emptyQueue': { zh: '空队列', en: 'Empty queue' },
  'player.dragToReorder': { zh: '拖拽调整顺序', en: 'Drag to reorder' },
  // 「选取专辑」= 播放器翻到唱片区（设计稿：页面 1 做立方体左转，转到页面 2）
  'player.pickAlbum': { zh: '选取专辑', en: 'Pick an album' },

  // —— 唱片区（播放器的另一面：三行唱片架，水平移动视差 + 悬停平放展开）——
  'picker.empty': {
    zh: '还没有专辑可以选：先去专辑墙导入几张吧:)',
    en: 'No albums to pick yet — import some from the shelf first :)',
  },
  'picker.selected': { zh: '已选 {n} 张', en: '{n} selected' },
  'picker.enqueue': { zh: '加入队列', en: 'Add to queue' },
  'picker.clear': { zh: '取消选择', en: 'Clear selection' },
  'picker.queued': { zh: '已加入队列：{n} 张专辑', en: 'Queued {n} album(s)' },

  // —— 导入弹窗：专辑导入（网易云 / QQ 音乐） ——
  'import.title': { zh: '导入专辑', en: 'Import album' },
  'import.searchPlaceholder': {
    zh: '输入专辑、歌手、歌曲、专辑源链接都可以哦:)',
    en: 'Album, artist, song, or a source link — anything works :)',
  },
  'import.searchAction': { zh: '搜索', en: 'Search' },
  'import.searchEmpty': { zh: '请输入搜索内容', en: 'Enter something to search for' },
  'import.searching': {
    zh: '正在同时搜索网易云音乐、QQ 音乐和酷狗音乐…',
    en: 'Searching NetEase, QQ Music and Kugou Music…',
  },
  // 单源搜索（「搜索来源」选了网易云或 QQ）：不再说「同时搜索」
  'import.searchingOne': { zh: '正在搜索{source}…', en: 'Searching {source}…' },
  'import.searchFound': { zh: '找到 {n} 张专辑', en: 'Found {n} album(s)' },
  // 已在库中的（同平台同 id）照常出现在结果里、就地标「已在收藏」：这里如实报一声有几张
  'import.searchFoundOwned': {
    zh: '找到 {n} 张专辑（其中 {m} 张已在收藏）',
    en: 'Found {n} album(s) — {m} already in your library',
  },
  // 逐条结果的状态：添加 → 正在添加 → 已添加（按钮变「打开」）；失败原地重试
  'import.adding': { zh: '正在添加…', en: 'Adding…' },
  'import.retry': { zh: '重试', en: 'Retry' },
  'import.owned': { zh: '已在收藏', en: 'In library' },
  'import.sameNameHint': {
    zh: '库中有一张同名专辑（平台不同，可继续添加）',
    en: 'A same-name album is in your library (different platform — you can still add)',
  },
  // 结果池与翻页：先本地展开（不花网络），展开完了再向上游要下一页
  'import.showMore': { zh: '显示更多（还有 {n} 张）', en: 'Show more ({n} left)' },
  'import.loadMore': { zh: '加载更多', en: 'Load more' },
  'import.loadingMore': { zh: '正在加载…', en: 'Loading…' },
  'import.allShown': { zh: '已显示全部 {n} 张', en: 'All {n} shown' },
  // 搜索结果导入后不跳转（批量导入的前提）：每导一张就报一次进度
  'import.batchProgress': {
    zh: '已导入 {n} 张专辑，可以继续导入下一张',
    en: 'Imported {n} album(s) — keep going with the next one',
  },
  'import.searchNoResults': {
    zh: '没有找到专辑，试试更短的专辑名、歌手名或歌曲名。',
    en: 'No albums found. Try a shorter album, artist, or song name.',
  },
  'import.searchFailed': {
    zh: '所有在线平台都搜索失败，请检查网络后重试。',
    en: 'All online sources failed. Check your network and try again.',
  },
  'import.searchPartial': {
    zh: '{sources} 暂时不可用：{reason}。已显示其他来源的结果。',
    en: '{sources} is unavailable: {reason}. Results from other sources are shown.',
  },
  'import.searchNoResultsWithReason': {
    zh: '没有找到专辑（{sources} 暂时不可用：{reason}）。',
    en: 'No albums found ({sources} unavailable: {reason}).',
  },
  // 被上游限流时这一来源会冷却一会儿，这一轮根本不发请求 —— 得如实说，不然会被当成「没结果」
  'import.sourceCoolingDown': {
    zh: '触发接口限流，{n} 秒内暂停搜索该来源',
    en: 'rate-limited — this source is paused for {n}s',
  },
  'import.qqSearchLoginRequired': {
    zh: '请先在 Vinyl Life 内登录 QQ 音乐（无需打开浏览器）',
    en: 'Sign in to QQ Music inside Vinyl Life first (no browser required)',
  },
  'import.sourceNetease': { zh: '网易云', en: 'NetEase' },
  'import.sourceQq': { zh: 'QQ 音乐', en: 'QQ Music' },
  'import.sourceKugou': { zh: '酷狗音乐', en: 'Kugou Music' },
  // 搜索来源（「添加」面板搜索框下的分段控件）：聚合 / 仅网易云 / 仅 QQ / 仅酷狗
  'import.searchScope': { zh: '搜索来源', en: 'Search source' },
  'import.scopeAll': { zh: '聚合', en: 'All' },
  'import.scopeAllHint': {
    zh: '聚合搜索：网易云 + QQ 音乐 + 酷狗音乐',
    en: 'All sources: NetEase + QQ Music + Kugou Music',
  },
  'import.trackCount': { zh: '{n} 首', en: '{n} tracks' },
  'import.matchedTrack': { zh: '匹配歌曲：{name}', en: 'Matched song: {name}' },
  'import.openExisting': { zh: '打开', en: 'Open' },
  'import.fetchingShort': { zh: '正在获取专辑信息…', en: 'Fetching album info…' },
  'import.fetching': {
    zh: '正在获取专辑信息（在线音源首次使用需启动本地网关）…',
    en: 'Fetching album info (the local gateway starts on first online use)…',
  },
  'import.failed': { zh: '❌ 导入失败：', en: '❌ Import failed: ' },
  'import.action': { zh: '导入', en: 'Import' },

  // —— 专辑墙「添加」面板：在线搜索 + 本地导入同住一个浮层 ——
  'add.title': { zh: '添加唱片', en: 'Add records' },
  'add.placeholder': {
    zh: '搜索专辑、艺人，或粘贴专辑链接',
    en: 'Search albums, artists, or paste an album link',
  },
  'add.localHint': { zh: '将本地音频拖到这里，或', en: 'Drop local audio here, or' },
  'add.chooseFiles': { zh: '选择文件', en: 'Choose files' },
  'add.back': { zh: '返回添加', en: 'Back to Add' },
  // 新专辑不在当前视野里时的回执（看得见的那张贴边走边闪，不用打扰）

  // —— 导入弹窗：本地音频导入 ——
  'import.localTitle': { zh: '导入本地音频', en: 'Import local audio' },
  'import.step1': { zh: '① 选择音频文件或文件夹', en: '① Pick audio files or a folder' },
  'import.pickFiles': { zh: '选择文件…', en: 'Choose files…' },
  'import.pickFolder': { zh: '选择文件夹…', en: 'Choose folder…' },
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
    zh: '无法识别链接：请粘贴网易云专辑链接（music.163.com/#/album?id=… 或纯数字 ID）、QQ 音乐专辑链接（y.qq.com/n/ryqq/albumDetail/…）或酷狗专辑链接（kugou.com/yy/album/single/…）',
    en: 'Unrecognized link: paste a NetEase album link (music.163.com/#/album?id=… or a plain numeric ID), a QQ Music album link (y.qq.com/n/ryqq/albumDetail/…) or a Kugou album link (kugou.com/yy/album/single/…)',
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
  'import.badKugouId': {
    zh: '无法解析酷狗音乐专辑 ID（请粘贴专辑链接，如 https://www.kugou.com/yy/album/single/12345678.html）',
    en: 'Could not parse the Kugou album ID (paste an album link such as https://www.kugou.com/yy/album/single/12345678.html)',
  },
  'import.kugouNoData': {
    zh: '酷狗音乐专辑接口无数据（code={code}）',
    en: 'No data from the Kugou album API (code={code})',
  },
  'import.kugouDone': {
    zh: '已导入「{name}」（{artist}{year}{tracks}）',
    en: 'Imported "{name}" ({artist}{year}{tracks})',
  },
  'import.kugouTracks': { zh: '，{n} 曲', en: ', {n} track(s)' },
  // 封面下载彻底失败（含备用图床）时的可见提示：专辑照常建好，只有封面要用户知道
  'import.coverFailed': {
    zh: '封面下载失败（{msg}），可在专辑卡片右键手动设置封面',
    en: 'Cover download failed ({msg}) — you can set a cover from the album card later',
  },
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

  // —— 播放统计页 ——
  'stats.total': { zh: '共播放 {n} 次', en: '{n} plays in total' },
  'stats.recent': { zh: '最近播放', en: 'Recently played' },
  'stats.top': { zh: '播放最多', en: 'Most played' },
  'stats.noRecords': { zh: '暂无记录', en: 'No records yet' },
  'stats.plays': { zh: '{n} 次', en: '{n} plays' },
  'stats.totalLabel': { zh: '累计播放', en: 'Total plays' },
  // 累计播放行的手写体小字（Drawing 2026-09-17 16.15.55）：数字放大、单位是小字。
  // 英文用「·」把两组分开（中文靠空白分隔，见 styles.css 的 .vinyl-stats-hand）。
  'stats.unitPlays': { zh: '次播放', en: 'plays' },
  'stats.unitListened': { zh: '听过', en: '· listened to' },
  'stats.unitAlbums': { zh: '张专辑', en: 'albums' },
  'stats.unitTracks': { zh: '播放曲目', en: '· played' },
  'stats.unitSongs': { zh: '首', en: 'tracks' },
  'stats.calendar': { zh: '近一年播放', en: 'Listening in the last year' },
  'stats.weekMon': { zh: '一', en: 'Mon' },
  'stats.weekWed': { zh: '三', en: 'Wed' },
  'stats.weekFri': { zh: '五', en: 'Fri' },
  'stats.dayTooltip': { zh: '{date}：{n} 次', en: '{date}: {n} plays' },
  'stats.less': { zh: '少', en: 'Less' },
  'stats.more': { zh: '多', en: 'More' },
  'stats.dayAlbums': { zh: '当日唱片', en: 'Records for the day' },
  'stats.noDayRecords': { zh: '这一天没有播放记录', en: 'Nothing was played on this day' },
  'stats.removedBadge': { zh: '已移除', en: 'Removed' },
  'stats.removedBadgeTitle': { zh: '{title}（已不在专辑墙）', en: '{title} (no longer on the shelf)' },
  'stats.removedTitle': { zh: '这张专辑已不在专辑墙', en: 'This album is no longer on the shelf' },
  'stats.removedDesc': { zh: '是否把《{title}》添加回专辑墙？', en: 'Add “{title}” back to the album shelf?' },
  'stats.restoreHint': {
    zh: '会用历史快照重建专辑笔记和已缓存的封面；已删除的本地音频无法自动恢复。',
    en: 'The album note and cached cover will be rebuilt from history. Deleted local audio cannot be restored automatically.',
  },
  'stats.restoreAction': { zh: '添加回来', en: 'Add it back' },
  'stats.restoredNotice': { zh: '已将《{title}》添加回专辑墙', en: '“{title}” was added back to the shelf' },
  'stats.restoreFailed': { zh: '恢复专辑失败：{msg}', en: 'Could not restore the album: {msg}' },
  'stats.restoreUnavailable': {
    zh: '这是旧版本留下的播放统计，没有可用的专辑快照',
    en: 'This record came from older statistics and has no album snapshot to restore',
  },
  'stats.custom': { zh: '自定义统计', en: 'Custom statistics' },
  'stats.chooseProperty': { zh: '选择卡片属性…', en: 'Choose a card property…' },
  'stats.customResult': { zh: '{plays} 次 · {albums} 张专辑', en: '{plays} plays · {albums} albums' },
  'stats.noPropertyRecords': { zh: '暂无这个属性的播放记录', en: 'No listening data has this property yet' },
  'stats.exportNote': { zh: '一键导出为笔记', en: 'Export as note' },
  'stats.exportedNotice': { zh: '已导出统计：{path}', en: 'Statistics exported: {path}' },
  'stats.exportFile': { zh: 'Vinyl Life 播放统计 {date}', en: 'Vinyl Life playback statistics {date}' },
  // 导出笔记的骨架：摘要 callout / 各分区标题与表头（表格用 Markdown 管道表 + 字符柱状）。
  // 不设 H1：笔记标题就是文件名；落点目录固定英文 Stats，不进词典（不随语言变）
  'stats.exportTitle': { zh: '我的听歌统计', en: 'My listening statistics' },
  'stats.exportSummary': {
    zh: '**{plays}** 次播放 · **{albums}** 张专辑 · **{tracks}** 首曲目 · 记录了 **{days}** 天',
    en: '**{plays}** plays · **{albums}** albums · **{tracks}** tracks · **{days}** days with listening',
  },
  'stats.exportSpan': {
    zh: '{first} → {last} · 最活跃的一天：{date}（{n} 次）',
    en: '{first} → {last} · Busiest day: {date} ({n} plays)',
  },
  'stats.exportMonthlyHeading': { zh: '## 近一年播放', en: '## Listening by month' },
  'stats.exportMonthlyHead': { zh: '| 月份 | 播放 | 占比 | |', en: '| Month | Plays | Share | |' },
  'stats.exportTopHeading': { zh: '## 播放最多', en: '## Most played' },
  'stats.exportTopHead': {
    zh: '| # | 专辑 | 播放 | | 最近播放 |',
    en: '| # | Album | Plays | | Last played |',
  },
  'stats.exportCovers': { zh: '封面', en: 'Covers' },
  'stats.exportRemoved': { zh: '{title}（已移除）', en: '{title} (removed)' },
  'stats.exportRecentHeading': { zh: '## 最近播放', en: '## Recently played' },
  'stats.exportRecentHead': {
    zh: '| 专辑 | 播放 | | 上次播放 |',
    en: '| Album | Plays | | Last played |',
  },
  'stats.exportPropsHeading': { zh: '## 自定义统计', en: '## Custom statistics' },
  'stats.exportPropsHead': { zh: '| {name} | 播放 | 专辑数 | |', en: '| {name} | Plays | Albums | |' },
  'stats.exportDailyHeading': { zh: '## 每日播放', en: '## Daily plays' },
  'stats.exportDailyHead': { zh: '| 日期 | 播放 | |', en: '| Day | Plays | |' },
  'stats.exportAbout': { zh: '关于这份统计', en: 'About these statistics' },
  'stats.exportFooter': {
    zh: '导出于 {time} · 数据来自 Vinyl Life 的本地统计',
    en: 'Exported {time} · from Vinyl Life local statistics',
  },
  'stats.exportMigrationNote': {
    zh: '日历精确记录从支持日历统计的版本开始；升级前的累计次数仍保留在总计中。',
    en: 'Exact calendar history starts with the version that introduced calendar statistics; earlier totals remain included in the summary.',
  },

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

  // —— 登录弹窗（扫码）：公共部分 ——
  'login.qrSection': { zh: '扫码登录', en: 'Scan to sign in' },
  'login.generating': { zh: '正在生成二维码…', en: 'Generating the QR code…' },
  'login.refreshQr': { zh: '刷新二维码', en: 'Refresh QR code' },
  'login.qrRenderFailed': { zh: '二维码渲染失败：', en: 'Could not render the QR code: ' },
  'login.qrGenFailed': { zh: '生成二维码失败：', en: 'Could not generate the QR code: ' },
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
    zh: '❌ 已授权但未取得有效登录会话，请刷新二维码重试。',
    en: '❌ Authorized but no valid session was issued — refresh the QR code and try again.',
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
  'login.netease.noSessionHint': {
    zh: '❌ 已授权但未取得有效登录会话（新设备的匿名注册可能被网易云限流）。请稍等片刻后刷新二维码重试。',
    en: '❌ Authorized but no valid session was issued (anonymous device registration may be rate-limited by NetEase). Wait a moment, then refresh the QR code and try again.',
  },

  // —— 登录弹窗：音源文案（QQ 音乐） ——
  'login.qq.title': { zh: 'QQ 音乐登录', en: 'QQ Music sign-in' },
  'login.qq.appHint': {
    zh: '请用手机 QQ 扫码（此为 QQ 互联二维码，QQ 音乐 App 的「扫一扫」识别不了）',
    en: 'Scan with mobile QQ (this is a QQ Connect QR code — the QQ Music app scanner cannot read it)',
  },

  // —— 登录弹窗：音源文案（酷狗音乐） ——
  'login.kugou.title': { zh: '酷狗音乐登录', en: 'Kugou Music sign-in' },
  'login.kugou.appHint': {
    zh: '请用酷狗音乐 App 扫码（未登录也能搜到并播放免费曲目，登录后解锁会员音质与付费曲目）',
    en: 'Scan with the Kugou Music app (search and free tracks work unsigned — signing in unlocks member quality and paid tracks)',
  },

  // —— 设置面板：标签页 / 通用 ——
  'settings.tab.general': { zh: '通用', en: 'General' },
  'settings.tab.stats': { zh: '历史', en: 'History' },
  'settings.tab.appearance': { zh: '外观', en: 'Appearance' },
  'settings.tab.source': { zh: '源', en: 'Sources' },
  'settings.section.basics': { zh: '基础偏好', en: 'Essentials' },
  'settings.language': { zh: '语言 / Language', en: 'Language / 语言' },
  'settings.path': { zh: '路径', en: 'Paths' },
  'settings.albumFolder': { zh: '专辑文件夹', en: 'Album folder' },
  'settings.coverFolder': { zh: '封面目录', en: 'Cover folder' },
  'settings.audioFolder': { zh: '音频根目录', en: 'Audio root folder' },
  'settings.statsFolder': { zh: '统计导出目录', en: 'Stats export folder' },
  'settings.queueFolder': { zh: '队列笔记目录', en: 'Queue note folder' },
  'settings.template': { zh: '模板', en: 'Template' },
  'settings.albumTemplate': { zh: '专辑笔记模板', en: 'Album note template' },
  'settings.albumTemplatePlaceholder': {
    zh: '例如：Vinyl Life/Template/专辑笔记模板.md',
    en: 'e.g. Vinyl Life/Template/专辑笔记模板.md',
  },
  'settings.generateTemplate': { zh: '生成模板文件', en: 'Generate template file' },
  'settings.openTemplate': { zh: '打开模板', en: 'Open template' },
  'settings.pickTemplate': { zh: '选择文件…', en: 'Choose file…' },
  'settings.section.playback': { zh: '播放', en: 'Playback' },
  'settings.defaultSource': { zh: '默认音源', en: 'Default source' },
  'settings.sourceAuto': { zh: '自动（本地优先）', en: 'Auto (local first)' },
  'settings.sourceLocal': { zh: '仅本地', en: 'Local only' },
  'settings.sourceNetease': { zh: '仅网易云', en: 'NetEase only' },
  'settings.sourceQq': { zh: '仅 QQ 音乐', en: 'QQ Music only' },
  'settings.sourceKugou': { zh: '仅酷狗音乐', en: 'Kugou Music only' },
  'settings.quality': { zh: '在线音源音质', en: 'Online audio quality' },
  'settings.qualityStandard': { zh: '标准', en: 'Standard' },
  'settings.qualityHigher': { zh: '较高（默认）', en: 'Higher (default)' },
  'settings.qualityExhigh': { zh: '极高', en: 'Extra high' },
  'settings.qualityLossless': { zh: '无损', en: 'Lossless' },
  'settings.autoPlay': { zh: '自动播放', en: 'Autoplay' },
  'settings.section.player': { zh: '播放器', en: 'Player' },
  'settings.playerLocation': { zh: '默认位置', en: 'Default location' },
  'settings.locSidebar': { zh: '侧栏', en: 'Sidebar' },
  'settings.locTab': { zh: '主区标签页', en: 'Main tab' },
  'settings.locWindow': { zh: '独立窗口', en: 'Separate window' },
  'settings.clearStats': { zh: '清除统计', en: 'Clear stats' },

  // —— 设置面板：外观 ——
  'settings.section.shelf': { zh: '专辑墙', en: 'Album shelf' },
  'settings.toolbarPosition': { zh: '工具栏位置', en: 'Toolbar position' },
  // 六档位置：顶部 / 底部 × 左 / 中 / 右（默认为「顶部居中」）
  'settings.toolbarTopLeft': { zh: '顶部左对齐', en: 'Top left' },
  'settings.toolbarTopCenter': { zh: '顶部居中', en: 'Top center' },
  'settings.toolbarTopRight': { zh: '顶部右对齐', en: 'Top right' },
  'settings.toolbarBottomLeft': { zh: '底部左对齐', en: 'Bottom left' },
  'settings.toolbarBottomCenter': { zh: '底部居中', en: 'Bottom center' },
  'settings.toolbarBottomRight': { zh: '底部右对齐', en: 'Bottom right' },
  'settings.columns': { zh: '每行专辑数量', en: 'Albums per row' },
  'settings.columnsAuto': { zh: '自动', en: 'Auto' },
  'settings.columnsN': { zh: '{n} 张', en: '{n} per row' },
  'settings.discDirection': { zh: '黑胶动画方向', en: 'Vinyl animation direction' },
  'settings.discRight': { zh: '向右', en: 'Right' },
  'settings.discLeft': { zh: '向左', en: 'Left' },
  'settings.discUp': { zh: '向上', en: 'Up' },
  'settings.discDown': { zh: '向下', en: 'Down' },
  'settings.section.vinyl': { zh: '黑胶唱片', en: 'Vinyl record' },
  'settings.recordColor': { zh: '唱片配色', en: 'Record color' },
  'settings.recordBlack': { zh: '黑胶', en: 'Black' },
  'settings.recordYellow': { zh: '黄胶', en: 'Yellow' },
  'settings.recordBlue': { zh: '蓝胶', en: 'Blue' },
  'settings.recordWhite': { zh: '白胶', en: 'White' },
  'settings.deck': { zh: '播放器配色', en: 'Player finish' },
  'settings.deckWalnut': { zh: '胡桃木', en: 'Walnut' },
  'settings.deckShell': { zh: '雪域白', en: 'Snow white' },
  'settings.deckBlack': { zh: '哑光黑', en: 'Matte black' },
  'settings.deckCoral': { zh: '珊瑚红', en: 'Coral' },
  'settings.spinSpeed': { zh: '转盘转速', en: 'Turntable speed' },
  'settings.spinSlow': { zh: '慢', en: 'Slow' },
  'settings.spinNormal': { zh: '标准（默认）', en: 'Normal (default)' },
  'settings.spinFast': { zh: '快', en: 'Fast' },
  // 搓碟：鼠标按在唱片上拖动 = 手动转盘。音效分完整（解码整轨、前后都出声）与轻量（只向前）
  'settings.scratch': { zh: '搓碟', en: 'Scratch' },
  'settings.scratchSound': { zh: '搓碟音效', en: 'Scratch sound' },
  'settings.scratchFull': { zh: '完整（前后都出声）', en: 'Full (both directions)' },
  'settings.scratchLight': { zh: '轻量（只向前出声）', en: 'Light (forward only)' },
  'settings.scratchPreload': { zh: '预先备好搓碟缓冲', en: 'Preload the scratch buffer' },

  // —— 设置面板：源 ——
  'settings.sub.netease': { zh: '网易云', en: 'NetEase' },
  'settings.sub.qq': { zh: 'QQ 音乐', en: 'QQ Music' },
  'settings.sub.kugou': { zh: '酷狗音乐', en: 'Kugou Music' },
  'settings.loginStatus': { zh: '登录状态', en: 'Sign-in status' },
  'settings.checkingLogin': { zh: '检测登录态…', en: 'Checking the sign-in state…' },
  'settings.checkFailed': { zh: '登录态检测失败：{msg}', en: 'Sign-in check failed: {msg}' },
  'settings.loggedIn': { zh: '已登录', en: 'Signed in' },
  'settings.statusLoggedIn': { zh: '{name}（{id}）', en: '{name} ({id})' },
  'settings.statusLoggedInQq': { zh: '{name}（QQ {id}）', en: '{name} (QQ {id})' },
  'settings.statusLoggedInKugou': { zh: '{name}（酷狗 {id}）', en: '{name} (Kugou {id})' },
  'settings.cookieInvalid': { zh: 'Cookie 已失效，请重新登录', en: 'The cookie has expired — please sign in again' },
  'settings.notLoggedIn': { zh: '未登录', en: 'Not signed in' },
  'settings.gatewayOk': { zh: '网关正常', en: 'Gateway OK' },
  'settings.gatewayDown': { zh: '网关未运行', en: 'Gateway not running' },
  'settings.qrLogin': { zh: '扫码登录', en: 'QR sign-in' },
  'settings.logout': { zh: '退出登录', en: 'Sign out' },
  'settings.logoutAction': { zh: '退出', en: 'Sign out' },
  'settings.section.sourceDefaults': { zh: '默认与音质', en: 'Defaults & quality' },
  'settings.section.local': { zh: '本地源', en: 'Local sources' },
  'settings.importMode': { zh: '落库模式', en: 'Storage mode' },
  'settings.importCopy': { zh: '复制进 vault', en: 'Copy into vault' },
  'settings.importLink': { zh: '外链绝对路径', en: 'Absolute path link' },

  // —— 设置面板：关于 ——
  // 只有「壳」文案进词典（标签名 / 版本行 / 许可行）；作者手记正文是原文常量
  // （src/core/about.ts 的 ABOUT_TEXT），不翻译、不进词典 —— 别抄进来。
  'settings.tab.about': { zh: '关于', en: 'About' },
  'settings.aboutVersion': { zh: '版本 {v}', en: 'Version {v}' },
  'settings.aboutLicense': { zh: 'MIT 许可证', en: 'MIT License' },

  // —— 命令名（命令面板 / ribbon 提示） ——
  'cmd.openShelf': { zh: '打开专辑墙', en: 'Open album shelf' },
  'cmd.openPlayer': { zh: '打开播放器', en: 'Open player' },
  'cmd.importAlbum': { zh: '导入专辑', en: 'Import album' },
  'cmd.importLocal': { zh: '导入本地音频', en: 'Import local audio' },
  'cmd.insertNowPlaying': {
    zh: '插入此刻正在听的曲目',
    en: 'Insert the currently playing track',
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
  'notice.albumsDeleted': { zh: '已删除 {n} 张专辑', en: 'Deleted {n} album(s)' },
  'notice.albumDeletedAssets': { zh: '（含 {n} 项本地文件）', en: ' (including {n} local file(s))' },
  'notice.noAlbumNote': {
    zh: '找不到这张专辑的笔记（可能已被删除或改名）',
    en: 'The note for this album is gone (deleted or renamed)',
  },
  'notice.appended': { zh: '已追加到「{name}」', en: 'Appended to "{name}"' },
  // 插入此刻正在听：行文案（插进当前笔记，语法随语言变 → 用 tf 占位符拼）
  'notice.nowPlayingLine': {
    zh: '此刻正在听《{album}》的《{track}》',
    en: 'Now playing: {track} — {album}',
  },
  'notice.nothingPlaying': { zh: '当前没有正在播放的歌曲', en: 'Nothing is playing right now' },
  'notice.jumpNoAlbum': { zh: '这条跳转指向的专辑笔记找不到了。', en: 'The album note this link points to is gone.' },
  'notice.jumpNoTrack': {
    zh: '在《{title}》里没找到那一首（可能换过音源或改过名）。',
    en: 'Could not find that track in “{title}” (the source or the title may have changed).',
  },
  'notice.noActiveNote': {
    zh: '请先打开一篇笔记并把光标放到要插入的位置',
    en: 'Open a note first and put the cursor where you want to insert',
  },
  'notice.foldersRenamed': {
    zh: '目录名已统一（旧的默认名改成了首字母大写）：{list}',
    en: 'Folder names unified (old defaults renamed to title case): {list}',
  },
  'notice.templateMissing': {
    zh: '找不到专辑笔记模板：{path} —— 这一轮导入用的是内置模板（在设置「通用 → 模板」里可以重新生成或换一个文件）',
    en: 'Album note template not found: {path} — this import used the built-in template (regenerate or pick another file under Settings → General → Template)',
  },
  'notice.eventsArchived': {
    zh: '两年保留规则裁掉了 {n} 条播放明细，已先归档：{path}（可在「设置 → 历史」用「恢复备份」载回）',
    en: 'Retention dropped {n} play events; archived first: {path} (restore it from Settings → History)',
  },
  // 提示气泡不渲染 Markdown，正文里不要写 ** 之类的标记
  'notice.eventsArchiveFailed': {
    zh: '有 {n} 条播放明细超出两年，但归档没能写出（{msg}）—— 这批明细全部保留、没有裁剪；问题解决后重启 Obsidian 会再试一次归档。',
    en: '{n} play events are past the two-year window but the archive could not be written ({msg}) — all of them are kept and nothing was trimmed; restart Obsidian once the problem is fixed and it will archive again.',
  },
  'notice.neteaseLoggedOut': { zh: '已退出网易云登录', en: 'Signed out of NetEase' },
  'notice.qqLoggedOut': { zh: '已退出 QQ 音乐登录', en: 'Signed out of QQ Music' },
  'notice.kugouLoggedOut': { zh: '已退出酷狗音乐登录', en: 'Signed out of Kugou Music' },

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

  // —— 专辑队列模式（播放器顶部开关 + 队列分组）——
  // 播放模式（播放器顶部按钮）：队列模式下作用于整条列表，否则作用于当前专辑
  'player.modeOnceAlbum': { zh: '单次播放整张专辑', en: 'Play the album once' },
  'player.modeLoopAlbum': { zh: '循环播放整张专辑', en: 'Repeat the album' },
  'player.modeShuffleAlbum': { zh: '随机播放整张专辑的曲目', en: 'Shuffle the album’s tracks' },
  'player.modeOnceList': { zh: '单次播放整个列表', en: 'Play the list once' },
  'player.modeLoopList': { zh: '循环播放整个列表', en: 'Repeat the list' },
  'player.modeShuffleList': { zh: '随机播放列表中的曲目', en: 'Shuffle the tracks in the list' },
  'player.queueMode': { zh: '专辑队列模式', en: 'Album queue mode' },
  'player.queueModeOn': {
    zh: '专辑队列模式已开启：点专辑墙上的专辑会排到队尾，不换碟',
    en: 'Album queue mode is on: clicking an album queues it instead of switching',
  },
  'player.queueModeOff': {
    zh: '专辑队列模式已关闭：点专辑会立即换碟（已排入列表的专辑保持不动）',
    en: 'Album queue mode is off: clicking an album switches to it immediately (queued albums stay)',
  },
  'player.queueRemoveAlbum': { zh: '从队列移除「{name}」', en: 'Remove “{name}” from the queue' },
  'player.queueDragAlbum': { zh: '拖拽调整专辑顺序', en: 'Drag to reorder albums' },
  'notice.queuedAlbum': { zh: '已加入队列：{name}', en: 'Queued: {name}' },

  // —— 登录 / 凭据 / 网关错误（core/auth, qq-auth, credential-file, netease, server-client, qq, web-client）——
  'auth.gatewayNotReadyCannotLogin': {
    zh: '网关未就绪，无法登录',
    en: 'Cannot sign in — the gateway is not ready',
  },
  'auth.gatewayNotReadyNetease': { zh: '网易云网关未就绪', en: 'The NetEase gateway is not ready' },
  'auth.gatewayHttp': { zh: '网关 HTTP {status}（{path}）', en: 'Gateway HTTP {status} ({path})' },
  'auth.getUnikeyFailed': { zh: '获取登录 unikey 失败', en: 'Could not obtain the sign-in unikey' },
  'auth.qrGenerateFailed': { zh: '生成二维码失败', en: 'Could not generate the QR code' },
  'auth.qqQrFailed': { zh: '获取 QQ 登录二维码失败', en: 'Could not fetch the QQ sign-in QR code' },
  'auth.kugouQrFailed': { zh: '获取酷狗登录二维码失败', en: 'Could not fetch the Kugou sign-in QR code' },
  'auth.sourceUnavailable': { zh: '音源不可用', en: 'Source unavailable' },
  'auth.coverDownloadHttp': {
    zh: '封面下载失败 HTTP {status}',
    en: 'Cover download failed: HTTP {status}',
  },

  // —— 播放与队列（core/player-state, core/queue）——
  'player.noPlayableTrack': { zh: '无可播放音轨', en: 'No playable track' },
  'player.cannotPlay': { zh: '无法播放《{title}》：{msg}', en: 'Cannot play “{title}”: {msg}' },
  'player.queueEmpty': {
    zh: '队列为空，先在播放器选择专辑',
    en: 'The queue is empty — pick an album in the player first',
  },
  'player.playFailed': {
    zh: '《{title}》播放失败（格式不支持、文件损坏或网络问题）',
    en: '“{title}” failed to play (unsupported format, corrupt file, or a network problem)',
  },
  'player.vipNoUrl': {
    zh: '会员/付费曲目，该音源未提供播放地址',
    en: 'Member-only track — the source returned no playback URL',
  },
  'queue.noLocalTracks': {
    zh: '专辑「{title}」没有本地音轨（audioFolder/audio 为空）',
    en: '“{title}” has no local tracks (audioFolder/audio is empty)',
  },
  'queue.notBound': {
    zh: '专辑「{title}」既无本地音轨，也未绑定网易云 / QQ 音乐 / 酷狗音乐，仅作收藏展示',
    en: '“{title}” has no local tracks and no NetEase/QQ/Kugou binding — shown as a collection item only',
  },
  'queue.noNeteaseId': {
    zh: '该专辑未绑定网易云（无 neteaseId / netease 链接）',
    en: 'This album is not linked to NetEase (no neteaseId / netease URL)',
  },
  'queue.neteaseUnavailable': { zh: '网易云源不可用', en: 'The NetEase source is unavailable' },
  'queue.neteaseNoTracks': {
    zh: '专辑接口无曲目（code={code}）',
    en: 'The album API returned no tracks (code={code})',
  },
  'queue.neteaseFailed': { zh: '获取网易云专辑失败：{msg}', en: 'Could not fetch the NetEase album: {msg}' },
  'queue.noQqId': {
    zh: '该专辑未绑定 QQ 音乐（无 qqId / qq 链接）',
    en: 'This album is not linked to QQ Music (no qqId / qq URL)',
  },
  'queue.qqUnavailable': { zh: 'QQ 音乐源不可用', en: 'The QQ Music source is unavailable' },
  'queue.qqNoTracks': {
    zh: 'QQ 音乐专辑接口无曲目（{msg}）',
    en: 'The QQ Music album API returned no tracks ({msg})',
  },
  'queue.qqFailed': { zh: '获取 QQ 音乐专辑失败：{msg}', en: 'Could not fetch the QQ Music album: {msg}' },
  'queue.noKugouId': {
    zh: '该专辑未绑定酷狗音乐（无 kugouId / kugou 链接）',
    en: 'This album is not linked to Kugou Music (no kugouId / kugou URL)',
  },
  'queue.kugouUnavailable': { zh: '酷狗音乐源不可用', en: 'The Kugou Music source is unavailable' },
  'queue.kugouNoTracks': {
    zh: '酷狗音乐专辑接口无曲目（{msg}）',
    en: 'The Kugou Music album API returned no tracks ({msg})',
  },
  'queue.kugouFailed': {
    zh: '获取酷狗音乐专辑失败：{msg}',
    en: 'Could not fetch the Kugou Music album: {msg}',
  },

  // —— 网关（core/server-manager）——
  'gateway.inAppUnavailable': {
    zh: '应用内网关在本机不可用（Electron 的 utilityProcess 通道拿不到）：在线音源（网易云 / QQ 音乐 / 酷狗音乐）暂不可用。请重启 Obsidian 后再试。',
    en: 'The in-app gateway is unavailable on this machine (the Electron utilityProcess channel could not be reached): online sources (NetEase / QQ Music / Kugou Music) are unavailable. Restart Obsidian and try again.',
  },
  'gateway.inAppStartFailed': {
    zh: '应用内网关启动失败：{msg}。请重启 Obsidian 后再试（更多线索见 gateway.log）。',
    en: 'The in-app gateway failed to start: {msg}. Restart Obsidian and try again (see gateway.log for details).',
  },
  'gateway.crashLoop': {
    zh: '网关多次崩溃（最近一次退出码 {code}），已停止自动重启（可重启 Obsidian 重试，或查看 gateway.log）',
    en: 'The gateway crashed repeatedly (last exit code {code}); auto-restart stopped (restart Obsidian to retry, or check gateway.log)',
  },
  'gateway.notReady': { zh: '网关 15s 未就绪', en: 'The gateway did not become ready within 15s' },
  'gateway.exitCodeUnknown': { zh: '未知', en: 'unknown' },
  'gateway.tempWriteFailed': {
    zh: '无法写入网关临时文件（{file}）：{msg}。在线音源（网易云 / QQ 音乐 / 酷狗音乐）不可用，本地源不受影响；请检查系统临时目录权限。',
    en: 'Could not write the gateway temp file ({file}): {msg}. Online sources (NetEase / QQ Music / Kugou Music) are unavailable; local audio is unaffected — check permissions on the system temp folder.',
  },

  // —— 卡片属性名（core/shelf-props；用户可在「卡片属性」里改写）——
  'props.artist': { zh: '艺术家', en: 'Artist' },
  'props.year': { zh: '年份', en: 'Year' },
  'props.genre': { zh: '流派', en: 'Genre' },
  'props.rating': { zh: '评分', en: 'Rating' },
  'props.label': { zh: '厂牌', en: 'Label' },
  'props.country': { zh: '国家', en: 'Country' },
  'props.version': { zh: '版本', en: 'Version' },
  'props.catalog': { zh: '编号', en: 'Catalog no.' },
  'props.joiner': { zh: '、', en: ', ' },

  // —— 专辑墙卡片 / 属性弹层（views/shelf-view）——
  'props.frontmatterKey': { zh: 'frontmatter 键：{key}', en: 'frontmatter key: {key}' },
  'props.albumCount': { zh: '{count} 张', en: '{count} albums' },
  'props.rename': { zh: '重命名「{name}」', en: 'Rename “{name}”' },
  'props.hide': { zh: '不再显示「{name}」', en: 'Hide “{name}”' },

  // —— 导入与写进笔记的内容（import.ts, main.ts）——
  'import.albumFetchFailed': { zh: '获取专辑失败：{msg}', en: 'Could not fetch the album: {msg}' },
  'import.reflectionHeading': { zh: '## 感想', en: '## Reflections' },
  'note.listeningLine': { zh: '- [{ts}] 正在听 {title}{position}：', en: '- [{ts}] Now playing {title}{position}:' },
  'backup.create': { zh: '备份设置与统计', en: 'Back up settings and stats' },
  'backup.restore': { zh: '恢复备份', en: 'Restore backup' },
  'backup.restoreHint': { zh: '选择 Vinyl Life 备份 JSON。恢复前会自动保存当前数据；部分设置将在重启 Obsidian 后完全生效。', en: 'Choose a Vinyl Life backup JSON. Current data will be backed up first. Restart Obsidian to apply all settings.' },
  'backup.chooseFile': { zh: '请先选择备份文件。', en: 'Choose a backup file first.' },
  'backup.badFormat': { zh: '这不是受支持的 Vinyl Life 备份。', en: 'This is not a supported Vinyl Life backup.' },
  'backup.created': { zh: '已保存到 {path}', en: 'Saved to {path}' },
  'backup.failed': { zh: '备份失败：{msg}', en: 'Backup failed: {msg}' },
  // —— 历史页「数据管理」：只有行名与值，不要小字说明 ——
  'data.title': { zh: '数据管理', en: 'Data management' },
  'data.backupPlace': { zh: '备份位置', en: 'Backup location' },
  'data.lastBackup': { zh: '最近成功备份', en: 'Last successful backup' },
  'data.neverBackedUp': { zh: '还没有备份过', en: 'No backup yet' },
  'data.autoBackup': { zh: '每周自动备份', en: 'Weekly auto backup' },
  'data.keepCount': { zh: '保留份数', en: 'Keep' },
  'data.keepN': { zh: '最近 {n} 份', en: 'Last {n}' },
  // 清除统计的确认弹窗（不可撤销的动作，说明放在按下去之前）
  'data.clearScope': {
    zh: '将删掉累计播放次数与逐日明细，不可撤销；已删除专辑的历史封面缓存也会一并清掉。',
    en: 'This deletes all-time play counts and per-day events, irreversibly; cached covers of removed albums go too.',
  },
  'notice.autoBackupDone': { zh: '已自动备份到 {path}', en: 'Auto-backed up to {path}' },
  'stats.exportFailed': { zh: '导出统计失败：{msg}', en: 'Could not export statistics: {msg}' },
  'stats.clearFailed': { zh: '清除统计失败：{msg}', en: 'Could not clear statistics: {msg}' },
  'backup.restartNotice': { zh: '备份已恢复。请重启 Obsidian 后再继续使用 Vinyl Life。', en: 'Backup restored. Restart Obsidian before using Vinyl Life again.' },
  'health.title': { zh: '收藏健康检查', en: 'Library health' },
  'health.summary': { zh: '检查了 {albums} 张专辑：{errors} 项错误，{notes} 项提示（另有 {collectOnly} 张标为仅收藏）。', en: 'Checked {albums} albums: {errors} errors, {notes} notes ({collectOnly} marked collection-only).' },
  'health.errorsHeading': { zh: '错误（需要修）', en: 'Errors (need fixing)' },
  'health.notesHeading': { zh: '提示（可以不管）', en: 'Notes (can ignore)' },
  'health.external': { zh: '库外路径失效', en: 'External path missing' },
  'health.cover': { zh: '封面缺失', en: 'Cover missing' },
  'health.source': { zh: '当前音源不可用', en: 'Selected source unavailable' },
  'health.noSource': { zh: '没有音源', en: 'No source linked' },
  'health.playback': { zh: '最近播放失败', en: 'Recent playback failure' },
  'health.switch': { zh: '切换音源', en: 'Switch source' },
  'health.switchPrompt': { zh: '这个音源播放失败。', en: 'This source could not play.' },
  'health.noteMissing': { zh: '找不到专辑笔记。', en: 'Album note not found.' },
  'health.noAlternative': { zh: '这张专辑没有其他已关联音源。', en: 'No other source is linked to this album.' },
  'health.markCollectOnly': { zh: '标记为仅收藏', en: 'Mark collection-only' },
  // —— 健康检查：从「报告」变成「维护工具」的三个修复入口 ——
  'health.relocate': { zh: '重新定位文件夹…', en: 'Relocate folder…' },
  'health.relocateFor': { zh: '给《{title}》里这条失效的库外引用挑个新位置：', en: 'Pick a new location for this broken external reference in “{title}”:' },
  'health.relocatePick': { zh: '选择文件夹…', en: 'Choose folder…' },
  'health.relocateApply': { zh: '更新引用', en: 'Update reference' },
  'health.relocatePlaceholder': { zh: '新文件夹的绝对路径，例如 D:\\Music\\专辑名', en: 'Absolute path to the new folder, e.g. D:\\Music\\Album' },
  'health.relocateNeedAbs': { zh: '请填绝对路径（盘符开头或 / 开头）。', en: 'Use an absolute path (drive letter or leading /).' },
  'health.relocated': { zh: '已更新 {n} 处引用（库外的文件没有搬动）。', en: 'Updated {n} reference(s); files outside the vault were not moved.' },
  'health.relocateNoMatch': { zh: '笔记里没找到对应的引用（可能刚被改过）。', en: 'No matching reference in the note (it may have changed just now).' },
  'health.setCover': { zh: '设置封面…', en: 'Set cover…' },
  'health.retry': { zh: '重试并清除', en: 'Retry & clear' },
  'health.retrying': { zh: '正在重试…', en: 'Retrying…' },
  'health.retryOk': { zh: '这次能播了：已清掉这条失败记录。', en: 'It works now — the failure record has been cleared.' },
  'health.retryFailed': { zh: '还是不行：{msg}', en: 'Still failing: {msg}' },
  'health.markedNotice': { zh: '已在专辑笔记里写入 collectOnly: true —— 无音源 / 无封面不再计入提示。', en: 'Wrote collectOnly: true to the album note — missing source/cover no longer counts as a note.' },
  'health.markFailed': { zh: '写入标记失败：{msg}', en: 'Could not write the mark: {msg}' },
  'health.checkedAt': { zh: '检查于 {time}', en: 'checked {time}' },
  'health.lastProbe': { zh: '上次检查：{time}', en: 'Last checked: {time}' },
  'health.neverProbed': { zh: '还没有试播过在线地址。', en: 'Online URLs have not been tested yet.' },
  'health.probeOnline': { zh: '检查在线播放地址', en: 'Check online playback URLs' },
  'health.probeAbort': { zh: '中止', en: 'Stop' },
  'health.probeAborted': { zh: '已中止；已检查的结果保留。', en: 'Stopped; results so far are kept.' },
  'health.probeNothing': { zh: '这个范围里没有需要试播的在线音源。', en: 'No online sources to test in this scope.' },
  'health.probeProgress': { zh: '正在检查 {done}/{total} 个在线音源…', en: 'Checking online source {done}/{total}…' },
  'health.scope.all': { zh: '全部已关联音源', en: 'All linked sources' },
  'health.scope.current': { zh: '仅每张实际会用的音源', en: 'Only the source each album uses' },
  'health.scope.failing': { zh: '仅上次失败的音源', en: 'Only previously failed sources' },
  'edition.set': { zh: '设置专辑版本', en: 'Set album edition' },
  'edition.placeholder': { zh: '原版、重制版、现场版…', en: 'Original, remaster, live…' },
  'common.save': { zh: '保存', en: 'Save' },
  'link.title': { zh: '关联到已有专辑', en: 'Link to an existing album' },
  'link.action': { zh: '关联已有', en: 'Link existing' },
  'link.summary': { zh: '将「{title}」的 {source} 音源关联到哪张专辑笔记？', en: 'Link the {source} source for “{title}” to which album note?' },
  'link.versionHint': { zh: '请核对原版、重制版、现场版等版本信息；这里只添加音源，不合并或覆盖笔记内容。', en: 'Check the edition before linking. Only the source is added; note content is not merged or overwritten.' },
  'link.choose': { zh: '请选择目标专辑', en: 'Choose an album' },
  'link.searchPlaceholder': { zh: '搜索库里的专辑（标题 / 艺人，认错别字）', en: 'Search your albums (title / artist, typos OK)' },
  'link.noMatch': { zh: '没有匹配的专辑。', en: 'No matching albums.' },
  'link.sourceAlbum': { zh: '搜索结果', en: 'Search result' },
  'link.targetAlbum': { zh: '目标专辑笔记', en: 'Target album note' },
  'link.trackCount': { zh: '{n} 首曲目', en: '{n} tracks' },
  'link.hasSources': { zh: '已有音源：{list}', en: 'Sources: {list}' },
  'link.noSource': { zh: '尚无音源', en: 'No sources yet' },
  'link.localTracks': { zh: '本地曲目 {n} 首', en: '{n} local tracks' },
  'link.conflict': { zh: '目标笔记已有这个平台的音源，请先核对笔记。', en: 'This note already has a source from this platform.' },
  'queueNote.save': { zh: '保存队列为笔记', en: 'Save queue as note' },
  'queueNote.load': { zh: '从当前笔记载入队列', en: 'Load queue from current note' },
  'queueNote.heading': { zh: '我的播放队列', en: 'My listening queue' },
  'queueNote.empty': { zh: '队列里还没有可保存的曲目。', en: 'No tracks to save in the queue.' },
  'queueNote.saved': { zh: '队列已保存：{path}', en: 'Queue saved: {path}' },
  'queueNote.openFirst': { zh: '请先打开一篇 Vinyl 队列笔记。', en: 'Open a Vinyl queue note first.' },
  'queueNote.badFile': { zh: '当前笔记不是有效的 Vinyl 队列。', en: 'This note is not a valid Vinyl queue.' },
  'queueNote.nonePlayable': { zh: '队列里的曲目均无法找到或载入。', en: 'No tracks in this queue could be loaded.' },
  'queueNote.loaded': { zh: '已载入 {loaded} 首，跳过 {skipped} 首失效曲目。', en: 'Loaded {loaded} tracks; skipped {skipped} unavailable tracks.' },
  'queueNote.skippedList': { zh: '跳过的曲目：{titles}', en: 'Skipped: {titles}' },
  'queueNote.hint': { zh: '> 这份列表就是队列：直接增删改这里的曲目，再执行「从当前笔记载入队列」即可。', en: '> This list is the queue: edit the tracks here, then run "Load queue from current note".' },
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
