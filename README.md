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

支持 Obsidian 1.4.0 及以上版本，仅限桌面端。界面可切换中文和 English。

## 专辑墙

专辑以封面卡片排列。鼠标移上去，唱片会从封套里露出来；点击有音源的专辑，会出现唱片从墙上移到唱机的动画。正在播放的专辑会在墙上高亮。

顶部工具栏可以：

- 按专辑名、艺术家或流派搜索。
- 按标题、年份、评分、播放次数或最近播放排序。
- 筛选本地、网易云、QQ 音乐，以及没有音源的收藏专辑。
- 选择卡片显示哪些笔记属性，拖动调整顺序，也可以修改属性的显示名称。
- 导入专辑链接或本地音频。

右键卡片可以打开笔记、补充音频、更换封面，或打开对应的音乐平台页面。没有音源的专辑也能放在墙上，点击会直接打开笔记，适合只收藏资料和写乐评。

## 黑胶播放器

播放器有转动的唱片和随播放状态移动的唱臂，可以放在侧栏、主区标签页，也可以单独开一个窗口。

常用操作都在唱机下方：播放与暂停、上一首与下一首、进度拖动、音量调整。曲目列表可以直接点歌，也可以拖动改变播放顺序。每张专辑会记住自己的排序，下次打开时继续使用；在线专辑还可以恢复平台原有的曲目顺序。

播放器会显示当前音源，在线播放时还会显示音质档位。是否在载入专辑后自动播放，可以在设置中调整。

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

在设置的「源」页面登录自己的账号。支持扫码、打开官方登录页面，以及手动填写 Cookie。QQ 的插件内二维码需要用手机 QQ 扫描；也可以选择浏览器登录，在官方页面完成登录。

在线音源需要电脑安装 Node.js 18 或以上版本。首次使用时，插件会启动本机网关；只听本地文件不需要额外安装 Node.js。

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

在「通用」设置里可以查看累计播放次数、最近听过的专辑和播放最多的专辑。最近播放记录包含上次播放的曲目和时间，也可以从这里清除统计。

统计保存在插件自己的数据文件中，不会自动往专辑笔记里添加播放记录。

## 设置

设置页分为四个板块：

| 板块 | 可以调整的内容 |
| --- | --- |
| 通用 | 界面语言、专辑和封面目录、本地笔记模板、默认音源、在线音质、自动播放、播放器位置，以及播放统计。 |
| 外观 | 专辑墙每行数量、唱片弹出方向、唱片颜色、唱机配色和转盘动画速度。 |
| 源 | 网易云与 QQ 音乐登录、本地音频目录、默认导入方式，以及在线音源运行状态。 |
| 关于 | 版本、作者手记、项目地址和许可信息。 |

唱机有胡桃木和黑胶黑两种配色，唱片可选黑、黄、蓝、白。专辑墙可以按窗口宽度自动排版，也可以固定为每行 2—7 张；唱片弹出方向可选上、下、左、右。

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

如果准备使用网易云或 QQ 音乐，先安装 Node.js，重启 Obsidian 后到插件的「源」设置页登录账号。

## 在线音源与数据

网易云和 QQ 音乐通过非官方接口接入，插件与网易、腾讯没有关联。播放范围和音质受账号权限及平台接口状态限制，不绕过付费或会员限制；使用这些接口可能涉及平台的服务条款。

插件不收集遥测或上传播放统计。在线功能会连接所选音乐平台的登录、音乐与图片服务，本机网关只监听 `127.0.0.1`。笔记中使用网络封面时，也会访问对应的图片地址。

登录凭据、设置和播放统计保存在本机插件目录中。可以在设置里退出账号、清除统计；分享插件文件时，不要附带自己的 Cookie 和登录数据。

## 开发与构建

需要 Node.js 18 或以上版本和 npm。

```bash
npm install
npm run build
npm run typecheck
npm test
```

- `npm install`：安装依赖。
- `npm run build`：构建，产出 `main.js`（插件本体）、`server.js`（本地网关，独立调试用）和 `src/core/gateway-bundle.ts`（构建生成物，勿手改）。
- `npm run typecheck`：类型检查。它依赖 build 先生成 `src/core/gateway-bundle.ts`，两步顺序不能反。
- `npm test`：跑测试，200 多项，纯 Node 环境，不需要 Obsidian。

源码目录结构：

- `src/core`：专辑索引、队列、播放引擎、本地源、网关管理与登录。
- `src/views`：专辑墙、播放器与各类弹窗。
- `src/animation`：交接动效。
- `server/`：本地网关源码，构建时内联进 `main.js`。

本地调试时，把 `main.js`、`manifest.json` 和 `styles.css` 放进 `<vault>/.obsidian/plugins/vinyl-life/`，重新加载 Obsidian 即可。

发布时推送 tag，GitHub Actions 会自动构建并创建 Release，附上 `main.js`、`manifest.json` 和 `styles.css`。

## 许可与致谢

[MIT](LICENSE) © 2026 Louiss342

本地网关使用了 [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) 的部分接口模块，原项目采用 MIT 许可。

---

## English

Vinyl Life presents album notes as records on a shelf, with a turntable-style player. You can listen to music on your computer, or connect your own NetEase Cloud Music or QQ Music account. Each record is an ordinary Markdown note, for album details, ratings, or whatever you happened to think about while listening.

Requires Obsidian 1.4.0 or later, desktop only. The interface can be switched between Chinese and English.

## Album shelf

Albums are laid out as cover cards. Hover over one and the record slides out of its sleeve; click an album that has audio and the record animates from the shelf to the turntable. The album that is playing is highlighted on the shelf.

The toolbar at the top lets you:

- Search by album name, artist, or genre.
- Sort by title, year, rating, play count, or recently played.
- Filter by local, NetEase, or QQ Music, as well as collected albums that have no audio.
- Choose which note properties the cards show, drag to reorder them, and rename how a property is displayed.
- Import an album link or local audio.

Right-clicking a card lets you open the note, add audio, change the cover, or open the matching page on the music platform. Albums with no audio can sit on the shelf too; clicking them opens the note directly, which suits collecting information and writing reviews.

## Vinyl player

The player has a spinning record and a tonearm that moves with the playback state, and it can live in the sidebar, in a main-area tab, or in a window of its own.

The controls you reach for most sit below the turntable: play and pause, previous and next track, scrubbing, and volume. The track list lets you click a song to play it, or drag to change the playing order. Each album remembers its own ordering and keeps using it the next time you open it; for online albums you can also restore the platform's original track order.

The player shows the current source, and for online playback the quality tier as well. Whether playback starts automatically after an album loads can be changed in the settings.

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

Sign in to your own account on the Sources settings page. Scanning a QR code, opening the official login page, and entering cookies by hand are all supported. For QQ, the QR code shown inside the plugin has to be scanned with mobile QQ; you can also choose browser login and finish signing in on the official page.

Online sources require Node.js 18 or later installed on your computer. On first use the plugin starts a local gateway; if you only listen to local files, no extra Node.js installation is needed.

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

The General settings show the cumulative play count, the albums you played recently, and the albums you played most. The recent list includes the last track played and the time it was played, and you can clear the statistics from here as well.

Statistics are stored in the plugin's own data file; play records are never added to your album notes automatically.

## Settings

The settings page is split into four tabs:

| Tab | What you can adjust |
| --- | --- |
| General | Interface language, album and cover folders, the local note template, the default source, online audio quality, autoplay, player position, and playback statistics. |
| Appearance | How many albums per row on the shelf, which way records slide out, record color, turntable color scheme, and platter animation speed. |
| Sources | NetEase and QQ Music sign-in, the local audio folder, the default import method, and the status of the online source runtime. |
| About | Version, the author's note, the project URL, and license information. |

The turntable comes in walnut and vinyl black, and records come in black, yellow, blue, and white. The shelf can lay itself out to fit the window width, or be pinned to 2–7 per row; records can slide out upwards, downwards, leftwards, or rightwards.

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

If you plan to use NetEase Cloud Music or QQ Music, install Node.js first, restart Obsidian, and then sign in to your account on the plugin's Sources settings page.

## Online sources and data

NetEase Cloud Music and QQ Music are reached through unofficial APIs, and the plugin is not affiliated with NetEase or Tencent. What you can play and at what quality is limited by your account's permissions and by the state of the platforms' APIs; paid or membership restrictions are not bypassed. Using these APIs may fall under the platforms' terms of service.

The plugin collects no telemetry and uploads no playback statistics. Online features connect to the login, music, and image services of the music platform you choose, and the local gateway only listens on `127.0.0.1`. When a note uses a remote cover, the corresponding image URL is fetched as well.

Login credentials, settings, and playback statistics are stored in the plugin folder on your own machine. You can sign out and clear the statistics in the settings; when you share plugin files, do not include your own cookies and login data.

## Development

Requires Node.js 18 or later and npm.

```bash
npm install
npm run build
npm run typecheck
npm test
```

- `npm install`: install dependencies.
- `npm run build`: build, producing `main.js` (the plugin itself), `server.js` (the local gateway, for standalone debugging), and `src/core/gateway-bundle.ts` (a generated file — do not edit it by hand).
- `npm run typecheck`: type-check. It depends on `npm run build` having generated `src/core/gateway-bundle.ts` first, so the order cannot be reversed.
- `npm test`: run the tests — 200+ of them, in plain Node, with no Obsidian required.

Source layout:

- `src/core`: album index, queue, playback engine, local source, gateway management, and sign-in.
- `src/views`: album shelf, player, and the various modals.
- `src/animation`: handoff animation.
- `server/`: the local gateway source, inlined into `main.js` at build time.

To debug locally, put `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/vinyl-life/` and reload Obsidian.

To release, push a tag: GitHub Actions builds the plugin and creates a Release automatically, with `main.js`, `manifest.json`, and `styles.css` attached.

## License and acknowledgements

[MIT](LICENSE) © 2026 Louiss342

The local gateway uses some API modules from [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi), which is released under the MIT license.
