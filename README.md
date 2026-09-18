# Vinyl Life

一首歌值得被写下来。

把唱针轻轻搭上，那一秒爆豆子似的静电声。它出现在哪一年、哪个城市、哪一场雨；它陪过你熬过哪一夜；它让你想起谁。这些不该沉在记忆里，也不该变成一个社交平台上的动态。它应该是你自己的一页纸，私人，安静，可以一直放在那儿。

音乐和笔记也许本身有着天然的亲和力。

A song is worth writing down.

Put the needle down, and for a second there is only that crackle — like beans popping. The year it came from, the city, the rain; the night it carried you through; the person it brings back. These things should not sink into memory, and should not become a post on a social platform. They should be a page of your own — private, quiet, somewhere it can stay.

Music and notes may have a natural affinity for each other.

[中文](#中文) | [English](#english)

## 中文

Vinyl Life 把专辑笔记展示成一张张唱片，配有黑胶唱机样式的播放器。可以听电脑里的音乐，也可以接入自己的网易云音乐或 QQ 音乐账号。每张唱片对应一篇普通的 Markdown 笔记，用来记专辑资料、评分，或某次听歌时想到的事。

支持 Obsidian 1.13.0 及以上版本，仅限桌面端。界面可切换中文和 English。

## 专辑墙

![专辑墙：封面卡片排列，正在播放的专辑在墙上高亮，右侧是黑胶播放器](assets/screenshots/album-shelf.zh.webp)

专辑以封面卡片排列。鼠标移上去，唱片会从封套里露出来；点击有音源的专辑，会出现唱片从墙上移到唱机的动画。正在播放的专辑会在墙上高亮。

顶部工具栏是一张紧凑的浮卡：**内容多长就多长**（带边框与轻投影，毛玻璃底——封面从它下面滚过时会被虚化）。左边是标题 + 手绘体的收藏数量，右边四枚图标（搜索、陈列、添加、更多）；点搜索，输入框在中间长出来、卡片跟着变长，清空或失焦收回、卡片缩回。工具栏与两个浮层照设置页（「通用」页）与苹果那套语言做（直角版）：发丝线、悬停淡底、分段控件、右侧弱化值 + 上下箭头、大而柔的投影，浮层的标题栏与设置页的分区块同款。

在外观页可以选**工具栏位置**：顶部 / 底部 × 左对齐 / 居中 / 右对齐 六档，默认「顶部居中」。

- **搜索**：点击原位展开输入框，输入即筛墙上的收藏（中文输入法组词期间不筛，组完再搜）；有搜索或来源筛选时，数量变成「匹配数/总数」。× 清空关键词并回到搜索前的浏览位置，Esc 只退出输入焦点。

- **陈列**：一个浮层里统管「看哪些、怎么排、怎么显示」—— 来源（本地 / 网易云 / QQ 音乐 / 无音源收藏，与关键词叠加）、排列（依据与方向两个下拉，缺失排序属性的专辑排在最后）、显示（每行数量；「封面下的信息」进第二层，勾选卡片显示的笔记属性、拖拽调序、改显示名）。筛选非「全部」时按钮上跟着来源名，条件在单行里始终看得见。
- **添加**：在线搜索与本地导入在同一个浮层，两层视图 —— 第一层搜专辑 / 艺人 / 粘贴专辑链接，结果逐条「添加 → 正在添加 → 已添加」（失败原位重试），已明确入库的同平台专辑标「已在收藏」；把本地音频拖到面板底部、或点「选择文件 / 选择文件夹」，就切到第二层的本地导入：选目标、选落库方式、按「开始导入」，导完留在原地接着导下一批，「返回添加」回到搜索层（原来的关键词与结果都还在）。不再另开一个导入窗口。
- **更多**：选择专辑（进入选择模式，工具栏整条切换用途：全选当前 / 清空选择 / 删除… / 完成，Esc 也能退出），以及刷新专辑墙（保留当前的搜索、筛选与陈列状态）。

浮层都从入口按钮附近展开，同时只开一个；点击外部或按 Esc 关闭，关闭后焦点回到入口。

右键卡片可以打开笔记、补充音频、更换封面，或打开对应的音乐平台页面。没有音源的专辑也能放在墙上，点击会直接打开笔记，适合只收藏资料和写乐评。

点击卡片即换碟：那张专辑的黑胶会从墙上抽走，交给播放器。开着专辑队列模式时，点击变成「排到队尾」——排进列表的专辑唱片同样从墙上收走（墙上就不再摆着已经在队列里的专辑），关掉队列模式时队列收敛回当前专辑、排在后面的唱片再滑回墙上。

## 黑胶播放器

播放器有转动的唱片和两段姿态的唱臂：不播放专辑或暂停时，唱针归位到支架上（姿态 1，唱臂竖直朝下）；播放专辑时，唱针落在唱片上（姿态 2），且唱针到唱片圆心的距离表示的正是这张专辑播到了哪里。播放器可以放在侧栏、主区标签页，也可以单独开一个窗口。

整页自上而下是三张卡片：顶部三枚按键（「选取专辑」占一半，队列模式与播放模式各占四分之一）、唱机、唱放。播放与暂停是唱机左下角的一枚长方形按键：黑色键面、边缘两道浅线，贴死在面板的左下角，键面是手写体的「Vinyl Life」——播放中点亮并像通电那样缓慢呼吸（键面也亮一档），暂停时暗下来、呼吸停掉；唱放卡里是单曲进度与音量。

顶部的「选取专辑」会让「唱机 + 唱放」这对卡片像立方体一样左转到背面 —— 那面是三行唱片架（按键卡与下面的队列都不动）：横着划过时三行会错开一点（视差），指针停在哪张，哪张就从侧脊放倒、摊开成整张封面。点一张即换碟；在专辑队列模式下点一张是排到队尾；按住 Ctrl（macOS 是 ⌘）点可以多选、Shift 点连选一段，选好后一次「加入队列」。

曲目列表可以直接点歌，也可以拖动改变播放顺序（只影响这一次会话，不会记住，下次打开仍是发行顺序）。每张专辑的名字那一栏末尾都有一个小按键，点一下就在那张专辑的笔记里追加一条带时间戳的听歌记录。是否在载入专辑后自动播放，可以在设置中调整。

## 导入音乐

### 本地音频

可以选择文件、选择文件夹，或直接把它们拖进导入窗口。导入时可以新建专辑，也可以给已有专辑添加曲目。

有两种存放方式：

| 方式 | 适合的情况 |
| --- | --- |
| 复制进笔记库 | 希望音频和笔记放在一起，随笔记库管理。 |
| 引用原文件 | 音乐已经整理在电脑或硬盘上，不想再复制一份。插件只记录绝对路径，原文件需要留在该位置。 |

导入整张专辑时，会沿用文件夹名称，并保留 `CD1`、`CD2` 等子目录结构。如果选择的是包含多张专辑的音乐库目录，可以勾选要导入的专辑，批量创建笔记。

也可以直接拖到专辑墙上：放在已有卡片上，就是给这张专辑添加音频；放在空白处，则新建专辑。

可导入的文件扩展名包括 `mp3`、`flac`、`m4a`、`m4b`、`mp4`、`wav`、`ogg`、`oga`、`opus`、`aac`、`webm` 和 `weba`，实际能否播放取决于文件编码及 Obsidian 内置的解码器。其他格式会跳过并提示。本地曲目以文件名作为标题，尚不读取 ID3 等音频标签。

### 网易云音乐和 QQ 音乐

粘贴专辑链接或 ID，插件会获取专辑资料、创建笔记并下载封面。之后可以从专辑墙打开播放。

也可以直接输入专辑或歌曲名搜索：结果里带封面、艺人、发行日期和曲目数，按歌曲搜出来的会注明它出自哪张专辑，点「导入」即按那张专辑建笔记；**已经在库里的专辑不再出现在结果里**（状态行会写明隐去了几张，避免看起来像搜索漏了）。

搜索是模糊的：错一个字、专辑名和歌手名颠倒着写、只记得标题后半截，都能把对的那张排到前面；看不出关联的兜底结果会被剪掉。首屏 20 条，往下可以「显示更多」（本地展开，不花网络），展开完了点「加载更多」继续向平台要下一页，两个平台的结果都和前面的一起重排。

搜索页可以连着导入：导入完成不会跳走，那张卡片就地变成「打开」——接着点下一张的「导入」就行；想立刻去看笔记时再点「打开」。

在设置的「源」页面用手机扫码登录自己的账号（目前只保留扫码这一条登录路径）。QQ 的二维码是 QQ 互联二维码，需要用手机 QQ 扫描，QQ 音乐 App 的「扫一扫」识别不了。

搜索和导入专辑不需要登录：两个平台都能在没有账号时查到专辑资料并建笔记（QQ 侧另有一条匿名搜索通道兜底）。登录决定的是播放——没登录时导入的笔记一样完整，到播放那一步才需要账号。

在线音源不需要安装 Node.js：首次使用时插件会用 Obsidian 自带的 Node 在应用内启动本机网关；只听本地文件则完全不会启动网关。

## 专辑笔记与听歌记录

每张专辑背后都是一篇笔记。你可以照常添加文字、图片、双链和自定义属性。

已有笔记只要在顶部属性中加入 `album` 标签，就可以被专辑墙识别。例如，以专辑名作为文件名，写入：

```yaml
---
tags: [album]
artist: 艺术家
year: 2024
genre: Jazz
rating: 4
cover: "[[Vinyl Life/covers/专辑封面.jpg]]"
---
```

封面路径换成自己的图片即可。暂时没有音源也没关系，以后可以从卡片右键菜单导入音频。

听歌时有两种记录方式：

- **写到专辑笔记里**：点击播放器的铅笔按钮，在这张专辑的笔记末尾追加时间和当前曲名，然后打开笔记继续写。
- **写到当前笔记里**：执行「插入此刻正在听」命令，在光标位置插入当前专辑和曲目，专辑名会链接回对应笔记。写日记时也可以随手留下一行。

本地导入支持自定义专辑笔记模板。在设置里选择一篇 Markdown 文件，或先生成模板再修改。模板可使用 `{{title}}`、`{{audioFolder}}`、`{{date}}`、`{{time}}`，分别填入专辑名、音频目录、日期和时间。

## 封面与专辑整理

右键专辑，选择「设置封面」，可以使用库里的图片，也可以从电脑上选择图片并复制到封面目录。笔记中的 `cover` 属性也支持图片链接、网络图片地址和纯色色值。

对于库内音频，还可以把 `cover.jpg`、`folder.jpg` 或 `front.jpg` 放进专辑的音频文件夹；在封面目录放入与专辑笔记同名的图片，也能自动识别。没有找到封面时，会显示音符占位。

删除专辑前会弹出确认窗口，可以选择是否一并删除库内音频和封面。被其他专辑引用的文件会保留，库外的原始音频不会被删除。库内文件的删除方式遵循 Obsidian 的「已删除文件」设置。

## 播放统计

独立的「统计」标签页会用近一年的日历热力图显示每天的播放量，热力图按时间倒序铺开：今天在最左边一列，往右回溯一年，最近在听什么一眼就能看到。点击某天会展开当天的紧密唱片墙，封面可直接点击播放；下方还有最近播放、播放最多和按艺术家、年份等卡片属性分组的自定义统计。

统计保存在插件自己的数据文件中，不会自动往专辑笔记里添加播放记录。从专辑墙删除有播放历史的专辑时，插件会保留一份封面和元数据快照：统计页仍能显示它，点击后可确认添加回专辑墙。已删除的本地音频不会被快照复制。页底可一键清除统计，或导出为 Markdown 笔记 —— 摘要与概览（含记录跨度、最活跃的一天）、近一年按月分布、播放最多、最近播放、按卡片属性汇总，以及每日播放（带文字柱状），页面上有的都在，另加几项页面没直接给的汇总。

## 设置

设置面板是五个标签页，点哪个就地换成哪一页：

| 标签页 | 可以调整的内容 |
| --- | --- |
| 通用 | 界面语言、专辑和封面目录、本地笔记模板、默认音源、在线音质与自动播放。 |
| 统计 | 日历热力图、当日唱片墙、最近/最多播放、自定义属性统计、清除与导出。 |
| 外观 | 专辑墙每行数量与工具栏位置、唱片弹出方向、唱片颜色、唱机配色和转盘动画速度。 |
| 源 | 网易云与 QQ 音乐登录、本地音频目录、默认导入方式，以及在线音源运行状态。 |
| 关于 | 版本、作者手记（中英对照）、项目地址和许可信息。整页手绘：文案用手写体，便签外框是一圈手画的虚线。 |

面板由插件自己绘制，所以这些设置在 Obsidian 的全局设置搜索里搜不到 —— 直接打开「设置 → Vinyl Life」看标签页。

唱机有胡桃木、贝壳白、哑光黑和珊瑚红四种配色（珊瑚红 = rgb(161 70 67) 的哑光砖红漆面 + 帆布织纹 + 奶白盘），唱片可选黑、黄、蓝、白。专辑墙可以按窗口宽度自动排版，也可以固定为每行 2—7 张；唱片弹出方向可选上、下、左、右。

默认文件位置如下，均可按自己的习惯修改：

```text
Vinyl Life/
├── Vinyl Note/    专辑笔记
├── covers/        封面图片
└── audio/         复制进库的音频
```

## 安装与开始使用

1. 从 [GitHub Releases](https://github.com/Louiss342/Vinyl-life/releases) 下载 `main.js`、`manifest.json` 和 `styles.css`。
2. 放进笔记库的 `.obsidian/plugins/vinyl-life/` 文件夹。
3. 重新加载 Obsidian，在「设置 → 第三方插件」中启用 Vinyl Life。
4. 在命令面板中搜索 Vinyl Life，打开专辑墙，导入一张专辑。

![空态专辑墙上的手绘教程](assets/screenshots/empty-shelf.zh.webp)

第一次打开时，空态教程会圈出两个导入按钮，并指出播放器的位置。

如果准备使用网易云或 QQ 音乐，直接在插件的「源」设置页扫码登录即可，无需安装 Node.js。

## 在线音源与数据

网易云和 QQ 音乐通过非官方接口接入，插件与网易、腾讯没有关联。播放范围和音质受账号权限及平台接口状态限制，不绕过付费或会员限制；使用这些接口可能涉及平台的服务条款。

插件不收集遥测或上传播放统计。在线功能会连接所选音乐平台的登录、音乐与图片服务，本机网关只监听 `127.0.0.1`。网关请求外网时跟随系统的代理设置（与浏览器一致）；需要手动指定时，可用 `VINYL_PROXY` 环境变量覆盖。笔记中使用网络封面时，也会访问对应的图片地址。

网易云的请求有两条通道：插件界面直连与本地网关，其中一条不可用时自动切换到另一条。搜索带节流保护——同一个关键词短时间内复用上次的结果，连续搜索之间保持最小间隔；平台明确限流时（网易云会回「操作频繁」），暂停该来源十几秒并在结果上方写明原因，而不是拿「网络失败」搪塞过去。

登录凭据、设置和播放统计保存在本机插件目录中。可以在设置里退出账号、清除统计；分享插件文件时，不要附带自己的 Cookie 和登录数据。

## 权限说明

社区插件审核会列出插件用到的系统能力，这里逐条说明用途。插件只在你的机器上运行，这些能力都只服务于上面写的功能。

- **本地文件读写（Node `fs`）**：按你填写的绝对路径读取库外的音频目录（外链模式）；在插件目录保存登录凭据、设备标识与播放统计；检查插件目录里的 `styles.css` 是否在位、是否与当前版本一致（手工安装漏了文件，或升级时只覆盖了 `main.js`，都会挂出内置副本，避免界面裸奔）；把内联的网关源码落到系统临时目录后再启动（用 Electron 自带的 Node 在应用内运行）。库内笔记、封面和复制进库的音频一律走 Obsidian 的 vault 接口，不直接读写文件系统。
- **应用内网关进程**：在线音源需要本机网关去对接网易云 / QQ 音乐的接口——插件用 Electron 自带的 Node（utility process）在应用内把它启动起来，监听 `127.0.0.1` 上的随机空闲端口；纯本地音源不会启动任何网关。网关随插件卸载 / Obsidian 退出一起回收；启动时还会清理一次旧版本（1.0.8 及更早）用系统 Node 起的遗留进程（读一次进程命令行，确认目标确实是本插件启动的，以免误杀别的程序）。
- **网关鉴权**：网关虽然只监听 `127.0.0.1`，但本机上任何程序、浏览器里的任何页面都能扫到这个端口。所以每次启动网关都会生成一个随机 token 交给它，插件发出的每个请求都必须带上；没有 token 的请求一律拒绝，网关也不发任何 CORS 头。封面的网络代理另有护栏：只允许 http(s)、目标地址不能是本机或内网、只接收图片，并限时 10 秒、限 12 MB。
- **列举库内文件**：专辑墙要找出所有带 `tags: [album]` 的笔记，因此会枚举库内 Markdown 笔记与图片的路径（封面选择器）。除此之外不读取笔记内容。

## 开发与构建

需要 Node.js 18 或以上版本和 npm。

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm test
```

- `npm install`：安装依赖。
- `npm run build`：构建，产出 `main.js`（插件本体）、`server.js`（本地网关，独立调试用）和 `src/core/gateway-bundle.ts`、`src/core/style-bundle.ts`（这两个是构建生成物，勿手改）。
- `npm run typecheck`：类型检查。它依赖 build 先生成 `src/core/gateway-bundle.ts` 与 `src/core/style-bundle.ts`，两步顺序不能反。
- `npm run lint`：ESLint（含官方审核规则集），提交前保持零报错。
- `npm test`：跑测试，200 多项，纯 Node 环境，不需要 Obsidian。
- `main.js` 有体积预算（384 KB，超出直接构建失败）：它是社区市场的下载主体，预算写在 `esbuild.config.mjs`。其中约 47 KB 是手写体（拉丁 Excalifont + 中文霞鹜文楷子集，空态教程与设置「关于」页共用，见 `assets/fonts/`）、约 26 KB 是手绘笔触引擎 roughjs。

源码目录结构：

- `src/core`：专辑索引、队列、播放引擎、本地源、网关管理与登录。
- `src/views`：专辑墙、播放器与各类弹窗。
- `src/animation`：交接动效。
- `server/`：本地网关源码，构建时内联进 `main.js`。
- `styles.css`：界面样式；构建时同样内联一份进 `main.js`（手工安装漏掉样式文件时的兜底，见 `src/core/style-fallback.ts`）。

本地调试时，把 `main.js`、`manifest.json` 和 `styles.css` 放进 `<vault>/.obsidian/plugins/vinyl-life/`，重新加载 Obsidian 即可。

发布时推送 tag，GitHub Actions 会自动构建并创建 Release，附上 `main.js`、`manifest.json` 和 `styles.css`。

## 许可与致谢

[MIT](LICENSE) © 2026 Louiss342

本地网关使用了 [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) 的部分接口模块，原项目采用 MIT 许可。

空态教程的手绘笔触（虚线框、虚线圈、箭头）用 [roughjs](https://github.com/rough-stuff/rough)，与 Excalidraw 内部同款引擎，MIT 许可。

专辑墙空态教程的手写体是两个子集（内联在 `styles.css` 里，随样式表分发）：

- 拉丁：[Excalidraw](https://github.com/excalidraw/excalidraw) 的 **Excalifont**，字体名 `Vinyl Hand`；
  Excalifont © 2024 by Excalidraw，SIL Open Font License 1.1
- 中文：[**霞鹜文楷 LXGW WenKai**](https://github.com/lxgw/LxgwWenKai)，字体名 `Vinyl Hand CJK`；
  © 2021-2026 LXGW，SIL Open Font License 1.1

两者都是按本插件教程文案裁出的子集（属 OFL 定义的修改版本，故不沿用原字体名），
授权全文与再生成步骤见 [`assets/fonts/`](assets/fonts/)。Excalifont 是 Excalidraw 的商标、
霞鹜文楷与 LXGW 是 LXGW 的保留名称，本项目与这两个项目均无从属关系。

---

## English

Vinyl Life presents album notes as records on a shelf, with a turntable-style player. You can listen to music on your computer, or connect your own NetEase Cloud Music or QQ Music account. Each record is an ordinary Markdown note, for album details, ratings, or whatever you happened to think about while listening.

Requires Obsidian 1.13.0 or later, desktop only. The interface can be switched between Chinese and English.

## Album shelf

![The album shelf: cover cards, the playing album highlighted, and the turntable player in the sidebar](assets/screenshots/album-shelf.en.webp)

Albums are laid out as cover cards. Hover over one and the record slides out of its sleeve; click an album that has audio and the record animates from the shelf to the turntable. The album that is playing is highlighted on the shelf.

The toolbar at the top lets you:

- Search by album name, artist, or genre.
- Sort by album title, artist, release date, play count, rating, or recently played; click the active option again to flip between ascending and descending. You can also pick any note property as a “custom sort”, with the same click-to-flip behavior.
- Filter by local, NetEase, or QQ Music, as well as collected albums that have no audio.
- Choose which note properties the cards show, drag to reorder them, and rename how a property is displayed.
- Import an album link or local audio.

Right-clicking a card lets you open the note, add audio, change the cover, or open the matching page on the music platform. Albums with no audio can sit on the shelf too; clicking them opens the note directly, which suits collecting information and writing reviews.

Clicking a card switches to that record: its vinyl slides off the wall and into the player. With album queue mode on, a click queues it instead — and a queued album's vinyl leaves the wall too (the wall never keeps a record that is already in the list). Turn queue mode off and the queue collapses back to the current album, sliding those records back onto the wall.

## Vinyl player

The player has a spinning record and a tonearm with two postures: off the record and resting on its cradle when nothing is playing or playback is paused (posture 1), and down on the record while an album plays (posture 2), where the distance between the stylus and the centre of the record is exactly how far into the album you are. The player can live in the sidebar, in a main-area tab, or in a window of its own.

The page is three cards, top to bottom: a row of three buttons (“Pick an album” takes half, queue mode and play mode a quarter each), the turntable, and the phono stage. Play/pause is a rectangular button in the turntable’s lower-left corner, its bottom edge level with the bottom of the record; the phono-stage card holds the track progress bar and the volume meter.

“Pick an album” at the top turns the page like a cube to its other face — a three-row record crate. The rows drift slightly out of step as you move across them (parallax), and the album under the pointer tips over from its spine into a full cover. Click one to switch to it; in album queue mode a click queues it instead. Ctrl-click (⌘ on macOS) selects several albums, Shift-click extends a run, and “Add to queue” takes them all at once.

The track list lets you click a song to play it, or drag to change the playing order — for this session only; nothing is remembered, so an album always opens in release order. Every album's name row ends with a small button that appends a timestamped listening line to that album's note. The player shows the current source, and for online playback the quality tier as well. Whether playback starts automatically after an album loads can be changed in the settings.

## Importing music

### Local audio

You can pick files, pick a folder, or simply drag them into the import window. When importing, you can create a new album or add tracks to an existing one.

There are two ways to store the files:

| Method | When it fits |
| --- | --- |
| Copy into the vault | When you want the audio to sit alongside the notes and be managed with the vault. |
| Reference the original files | When your music is already organized on your computer or a drive and you would rather not make a second copy. The plugin only records the absolute path, and the original files need to stay where they are. |

When you import a whole album, the folder name is carried over and subdirectories such as `CD1` and `CD2` are preserved. If you pick a music library folder that holds several albums, you can tick the albums you want and create the notes in bulk.

You can also drag files straight onto the album shelf: drop them on an existing card to add audio to that album, or on empty space to create a new album.

The file extensions you can import are `mp3`, `flac`, `m4a`, `m4b`, `mp4`, `wav`, `ogg`, `oga`, `opus`, `aac`, `webm`, and `weba`; whether a file actually plays depends on its encoding and on Obsidian's built-in decoders. Other formats are skipped with a notice. Local tracks use the file name as their title; audio tags such as ID3 are not read yet.

### NetEase Cloud Music and QQ Music

Paste an album link or ID and the plugin fetches the album information, creates a note, and downloads the cover. After that you can open it from the album shelf and play it.

You can also search by album or song name. Each result shows its cover, artists, release date, and track count; a song result tells you which album it comes from, and clicking Import creates that album's note. **Albums already in your vault no longer appear in the results at all** (the status line says how many were hidden, so it does not look like the search missed them).

Searching is fuzzy: a typo, the album and artist names typed in either order, or only the second half of a title will still rank the right one first, and loosely-related filler from the platforms is trimmed away. The first 20 results are shown; Show more reveals the rest of the local pool for free, and Load more asks the platforms for the next page and re-ranks everything together.

The search page is built for importing several albums in a row: importing does not navigate away, and that card turns into an Open button — just hit Import on the next result. Click Open only when you want to go to the note.

Sign in by scanning a QR code on the Sources settings page (for now this is the only sign-in path). The QQ code is a QQ Connect QR code — scan it with mobile QQ; the QQ Music app's own scanner cannot read it.

Searching and importing albums need no account: both platforms can be searched and imported while signed out (QQ has an anonymous fallback channel). What signing in unlocks is playback — notes imported without an account are complete, and the account is only needed when you press play.

Online sources do not require Node.js: on first use the plugin starts a local gateway in-app, on the Node bundled with Obsidian. If you only listen to local files, no gateway is started at all.

## Album notes and listening log

Behind every album is a note. You can add text, images, wikilinks, and custom properties as usual.

An existing note is recognized by the album shelf as long as you add the `album` tag to its frontmatter. For example, with the album name as the file name, write:

```yaml
---
tags: [album]
artist: 艺术家
year: 2024
genre: Jazz
rating: 4
cover: "[[Vinyl Life/covers/专辑封面.jpg]]"
---
```

Just point the cover path at your own image. Having no audio yet is fine — you can import audio later from the card's right-click menu.

There are two ways to write things down while listening:

- **Into the album note**: click the pencil button in the player to append the time and the current track name to the end of that album's note, then open the note and carry on writing.
- **Into the current note**: run the Insert the currently playing track command to insert the current album and track at the cursor; the album name links back to its note. Handy for leaving a line while you are writing your journal, too.

Local imports support a custom album note template. Choose a Markdown file in the settings, or generate a template first and then edit it. The template can use `{{title}}`, `{{audioFolder}}`, `{{date}}`, and `{{time}}`, which are filled in with the album name, the audio folder, the date, and the time.

## Covers and album organization

Right-click an album and choose Set cover to use an image from the vault, or pick an image from your computer and copy it into the cover folder. The `cover` property in a note also accepts image links, remote image URLs, and solid color values.

For audio inside the vault, you can also put `cover.jpg`, `folder.jpg`, or `front.jpg` into the album's audio folder; an image in the cover folder with the same name as the album note is picked up automatically as well. When no cover is found, a music-note placeholder is shown.

Deleting an album brings up a confirmation window where you can choose whether to delete the in-vault audio and covers along with it. Files referenced by other albums are kept, and original audio outside the vault is never deleted. How in-vault files are deleted follows Obsidian's Deleted files setting.

## Playback statistics

The dedicated Statistics tab uses a one-year calendar heatmap to show how much you listened each day. Select a day to open its compact record wall; click a cover to play it. Recent, most-played, and custom groupings by card properties such as artist or year appear below.

Statistics are stored in the plugin's own data file; play records are never added to your album notes automatically. When an album with listening history is removed through the shelf, Vinyl Life keeps a cover and metadata snapshot. The removed record remains visible in Statistics and can be added back after confirmation; deleted local audio is not copied into the snapshot. The bottom of the page can clear the statistics or export them as a Markdown note.

## Settings

The settings panel is five tabs; clicking a tab switches the content in place:

| Tab | What you can adjust |
| --- | --- |
| General | Interface language, album and cover folders, the local note template, the default source, online audio quality, and autoplay. |
| Statistics | Calendar heatmap, daily record wall, recent/most-played lists, custom property groupings, clearing, and export. |
| Appearance | How many albums per row on the shelf, which way records slide out, record color, turntable color scheme, and platter animation speed. |
| Sources | NetEase and QQ Music sign-in, the local audio folder, the default import method, and the status of the online source runtime. |
| About | Version, the author's note (Chinese and English side by side), the project URL, and license information. The whole page is hand-drawn: the text uses a handwriting font, and a dashed frame is sketched around the note. |

The panel is drawn by the plugin itself, so these settings do not show up in Obsidian's global settings search — open Settings → Vinyl Life and use the tabs.

The turntable comes in walnut, shell white, and matte black, and records come in black, yellow, blue, and white. The shelf can lay itself out to fit the window width, or be pinned to 2–7 per row; records can slide out upwards, downwards, leftwards, or rightwards.

The default file locations are as follows, and all of them can be changed to suit your own habits:

```text
Vinyl Life/
├── Vinyl Note/    专辑笔记
├── covers/        封面图片
└── audio/         复制进库的音频
```

## Installation and getting started

1. Download `main.js`, `manifest.json`, and `styles.css` from [GitHub Releases](https://github.com/Louiss342/Vinyl-life/releases).
2. Put them into your vault's `.obsidian/plugins/vinyl-life/` folder.
3. Reload Obsidian and enable Vinyl Life under Settings → Community plugins.
4. Search for Vinyl Life in the command palette, open the album shelf, and import an album.

![The hand-drawn tutorial on an empty album shelf](assets/screenshots/empty-shelf.en.webp)

The first time you open it, the empty-shelf tutorial rings the two import buttons and points out where the player lives.

To use NetEase Cloud Music or QQ Music, just scan the QR code on the plugin's Sources settings page — no Node.js installation is required.

## Online sources and data

NetEase Cloud Music and QQ Music are reached through unofficial APIs, and the plugin is not affiliated with NetEase or Tencent. What you can play and at what quality is limited by your account's permissions and by the state of the platforms' APIs; paid or membership restrictions are not bypassed. Using these APIs may fall under the platforms' terms of service.

The plugin collects no telemetry and uploads no playback statistics. Online features connect to the login, music, and image services of the music platform you choose, and the local gateway only listens on `127.0.0.1`. Requests the gateway makes to the outside world follow your system proxy settings (the same ones your browser uses); set the `VINYL_PROXY` environment variable to override them. When a note uses a remote cover, the corresponding image URL is fetched as well.

NetEase requests have two channels — a direct connection from the plugin window and the local gateway — and switch to the other automatically when one is unavailable. Search is throttled: the same keyword reuses its recent result, consecutive searches keep a minimum interval, and when a platform explicitly rate-limits a request (NetEase answers "too frequent"), that source is paused for a short while and the reason is shown above the results instead of being passed off as a network failure.

Login credentials, settings, and playback statistics are stored in the plugin folder on your own machine. You can sign out and clear the statistics in the settings; when you share plugin files, do not include your own cookies and login data.

## Permissions

Community plugin reviews list the system capabilities a plugin uses; here is what each one is for. The plugin runs only on your own machine, and every capability below serves the features described above.

- **Local file access (Node `fs`)**: reading audio folders outside the vault that you reference by absolute path (linked mode); keeping login credentials, the device identifier, and playback statistics in the plugin folder; checking whether `styles.css` is present in the plugin folder and matches the installed version (if it is missing — or was left behind by a partial update that only replaced `main.js` — a built-in copy is applied so the UI stays styled); and writing the inlined gateway source to the system temp folder before launching it (it runs in-app on Electron's bundled Node). Notes, covers, and audio copied into the vault all go through Obsidian's vault API instead.
- **In-app gateway process**: online sources need a local gateway to talk to the NetEase Cloud Music and QQ Music APIs — the plugin launches it in-app with Electron's bundled Node (utility process), listening on a random free port on `127.0.0.1`. Local audio starts no gateway. The gateway is reclaimed when the plugin unloads or Obsidian exits; on startup the plugin also cleans up the gateway process left behind by older versions (1.0.8 and earlier) that ran on system Node.js (that step reads the process command line once to confirm the target really is a gateway this plugin started, so it never kills an unrelated program).
- **Gateway authentication**: the gateway listens on `127.0.0.1` only, but any process on the machine — including a web page in a browser — can scan for that port. So every launch generates a random token for the gateway, and each request the plugin sends carries it; requests without the token are rejected, and the gateway sends no CORS headers at all. The cover proxy has its own guard rails: http(s) only, the target must not resolve to the local machine or a private network, only images are accepted, and it is capped at 10 seconds and 12 MB.
- **Scanning vault files**: the album shelf needs to find every note tagged `tags: [album]`, so it enumerates the paths of Markdown notes in the vault, and the cover picker lists images in the vault. Nothing else is read from your notes.

## Development

Requires Node.js 18 or later and npm.

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm test
```

- `npm install`: install dependencies.
- `npm run build`: build, producing `main.js` (the plugin itself), `server.js` (the local gateway, for standalone debugging), and `src/core/gateway-bundle.ts` / `src/core/style-bundle.ts` (both generated — do not edit them by hand).
- `npm run typecheck`: type-check. It depends on `npm run build` having generated `src/core/gateway-bundle.ts` / `src/core/style-bundle.ts` first, so the order cannot be reversed.
- `npm run lint`: ESLint with the official review rule set; keep it clean before committing.
- `npm test`: run the tests — 200+ of them, in plain Node, with no Obsidian required.
- `main.js` has a size budget (400 KB; exceeding it fails the build) because it is what the community store downloads — the budget lives in `esbuild.config.mjs`. About 47 KB of it is the handwriting fonts (Latin Excalifont + Chinese LXGW WenKai subsets, shared by the empty-shelf tutorial and the About settings page; see `assets/fonts/`) and ~26 KB is roughjs, the hand-drawn stroke engine.

Source layout:

- `src/core`: album index, queue, playback engine, local source, gateway management, and sign-in.
- `src/views`: album shelf, player, and the various modals.
- `src/animation`: handoff animation.
- `server/`: the local gateway source, inlined into `main.js` at build time.
- `styles.css`: the UI styling; a copy is also inlined into `main.js` at build time as a fallback for installs missing the stylesheet (see `src/core/style-fallback.ts`).

To debug locally, put `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/vinyl-life/` and reload Obsidian.

To release, push a tag: GitHub Actions builds the plugin and creates a Release automatically, with `main.js`, `manifest.json`, and `styles.css` attached.

## License and acknowledgements

[MIT](LICENSE) © 2026 Louiss342

The local gateway uses some API modules from [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi), which is released under the MIT license.

The hand-drawn strokes in the tutorial (dashed boxes, ring, arrows) use [roughjs](https://github.com/rough-stuff/rough), the same engine Excalidraw uses internally (MIT).

The hand-drawn fonts in the empty-shelf tutorial are two subsets inlined in `styles.css`
(they ship with the stylesheet):

- Latin: **Excalifont** from [Excalidraw](https://github.com/excalidraw/excalidraw), family name `Vinyl Hand`;
  Excalifont © 2024 by Excalidraw, SIL Open Font License 1.1
- Chinese: [**LXGW WenKai**](https://github.com/lxgw/LxgwWenKai), family name `Vinyl Hand CJK`;
  © 2021-2026 LXGW, SIL Open Font License 1.1

Both are subsets cut to this plugin's tutorial text (modified versions under the OFL, hence
the new family names) — see [`assets/fonts/`](assets/fonts/) for the full licenses and how to
regenerate them. Excalifont is a trademark of Excalidraw and LXGW WenKai / LXGW are reserved
names of their author; this project is not affiliated with either.
