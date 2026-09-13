# Vinyl Life

[![CI](https://github.com/Louiss342/Vinyl-life/actions/workflows/ci.yml/badge.svg)](https://github.com/Louiss342/Vinyl-life/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Obsidian](https://img.shields.io/badge/Obsidian-1.4.0%2B-7c3aed)

Turn your album notes into a **vinyl wall with a turntable player**. Vinyl Life reads the
album notes already in your vault, renders them as a shelf of records, and plays them —
from your own audio files, or from your own NetEase Cloud Music / QQ Music account.

> **Read this first.** Vinyl Life uses **unofficial** NetEase Cloud Music and QQ Music
> endpoints for sign-in and for resolving stream URLs. This may violate those platforms'
> terms of service. It is intended for personal use with your own account, it does not
> bypass paid or membership-only restrictions, and it is not affiliated with Tencent or
> NetEase. See [Compliance](#compliance).

## Overview

Vinyl Life is a desktop-only Obsidian plugin (plugin id `vinyl-life`, `isDesktopOnly: true`).
It adds two custom views:

- **Album shelf** — a hand-drawn card grid of every album note in your vault.
- **Turntable player** — a record-spinning player that can live in the sidebar, in a main-area
  tab, or in its own pop-out window.

Pressing a record on the shelf detaches it from the wall, carries it to the platter, and starts
playback — the *handoff* animation is the plugin's signature interaction.

## Music sources

Each user signs in with **their own** account. The plugin ships no author credentials, no shared
tokens, and no author-operated backend: requests go from your machine to the provider, or through
the local gateway process described below.

| Source | Setup | Notes |
| --- | --- | --- |
| **Local audio** | None | Files inside the vault, or absolute paths outside the vault. No backend process, works fully offline. |
| **NetEase Cloud Music** | QR code login · browser login on the official page · paste Cookie manually | Requires Node.js (see below). |
| **QQ Music** | QR code login · browser login on the official page · paste Cookie manually | Requires Node.js (see below). |

Browser login opens the provider's own login page in an Electron window (QR code or
username/password both work there). The session lives in a plugin-scoped partition and only the
resulting credentials are kept — see [Privacy and network access](#privacy-and-network-access).

## Features

### Album shelf

- Custom-rendered view: card grid over the album notes found in your vault.
- Vinyl pop-out hover animation, with the direction configurable (left / right).
- Source badge per card (local / NetEase / QQ) and a highlight on the album currently playing.
- Toolbar with search, sort, filter, card-property selection and import.

### Player

- Turntable visual with a spinning record and a tonearm that moves between rest and play positions.
- Queue, seek/progress and volume controls.
- Dockable: sidebar, main-area tab, or a standalone pop-out window.
- Track list per album, with a "append a thought" action on the current track (see below).

### Handoff animation

Clicking a record on the shelf animates it off the wall and onto the platter before playback
begins, so the connection between "this note" and "this sound" stays visible.

### Import

- Paste a NetEase Cloud Music or QQ Music album link (or ID) to create an album note with the
  right frontmatter, then download the cover through the local gateway (avoids CORS).
- Drag local audio files in, in one of two modes: **copy into the vault**, or **link by reference**
  to a path outside the vault.
- **Pick or drop a folder** to import a whole album in one go: the folder name becomes the album
  title, every supported audio file inside (including subfolders) is imported, and the subfolder
  layout is kept — `audio/<album>/CD1/01.flac`. Non-audio files (covers, cue sheets, logs) are
  ignored.
- Dropping a folder **on the shelf** works too: on a card → into that album, on empty space →
  a new album named after the folder. (Disc subfolders like `CD1` / `CD2` count as one album.)
- **Music-library import**: pick a parent folder whose subfolders are individual albums and the
  dialog lists them as checkable albums — one import creates the whole batch
  (`Vinyl Life/Vinyl Note/<folder>.md` + `Vinyl Life/audio/<folder>/…`).

### Notes integration

- **Thoughts on playback** — while a record is playing, append a timestamped entry to that album's
  note with a single command, with the cursor placed on the new line.
- Playback never edits your notes on its own; only this explicit action writes to them.

### Playback statistics

Play counts, last-played timestamps and last-played track are stored in the plugin's own
`data.json`. Nothing is written into your notes, and nothing is sent anywhere.

### Covers

A cover can come from four places, in this order:

1. **Your own image, chosen from the card menu** — right-click a card → *Set cover…* → pick an
   image already in the vault, or a local image file (copied into the cover folder).
2. **`cover:` in the note frontmatter** — a vault wikilink (`"[[]]"`), an `https://` URL, or a
   colour like `#8b5cf6` (rendered as a solid block).
3. **A conventional file next to the music** — `cover.jpg` / `folder.jpg` / `front.jpg` (also
   `.jpeg` / `.png` / `.webp`) inside the album's audio folder, or a file named after the album.
4. **`<album title>.jpg` in the cover folder** — the same naming the online import uses.

Cases 3 and 4 need no action at all: drop the file in and the shelf picks it up on the next
refresh (nothing is written to your notes). Locally imported albums start with a ♪ placeholder
until one of these exists.

### Appearance

Player colour scheme, record colour, turntable speed, album-shelf column count, and more
(default source, streaming quality, autoplay, album/cover/audio folders) in the settings tab.

## Installation

### From the community plugin directory

Once the plugin is listed, search for **Vinyl Life** in *Settings → Community plugins → Browse*
and install it.

### Manually

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/Louiss342/Vinyl-life/releases).
2. Put them in `<your vault>/.obsidian/plugins/vinyl-life/`.
3. Reload Obsidian and enable **Vinyl Life** in *Settings → Community plugins*.

## Requirements

| | |
| --- | --- |
| Obsidian | 1.4.0 or newer |
| Platform | Desktop only (Windows / macOS / Linux). Not available on mobile. |
| Node.js | **Optional.** Required only for the NetEase Cloud Music and QQ Music sources. Version 18 or newer. |

### Why Node.js is needed

The online sources talk to a small local gateway process that runs on `127.0.0.1`. The Obsidian
binary disables `ELECTRON_RUN_AS_NODE`, so the plugin cannot reuse Obsidian's bundled Node — it
needs a system Node.js installation, either on `PATH` or in one of the usual install locations
(e.g. `C:\Program Files\nodejs\node.exe`, `%LOCALAPPDATA%\Programs\nodejs\node.exe`).

- The gateway source is **inlined inside `main.js`** at build time and released to the system temp
  directory the first time you use an online source. No extra files are downloaded.
- If you only use local audio, **you do not need Node.js** and the plugin spawns no process at all.
- If Node.js is missing, the plugin says so explicitly in its settings tab, where you can
  re-detect it after installing Node.js and restarting Obsidian.

### Supported audio formats

Playback is handed to Chromium's built-in decoders — the plugin does not decode audio itself.
These containers work: `mp3`, `m4a` / `m4b` / `mp4` (AAC · ALAC), `wav`, `ogg` / `oga` (Vorbis),
`opus`, `aac` (ADTS), `webm` / `weba`.

Anything else (`ape`, `wma`, `dsf`, `dff`, `tak`, `aiff`, …) is skipped on import — you get a
notice naming the skipped files, so convert those to `flac` or `mp3` first. The same list applies to
vault-internal files and to external-path (link) mode.

## Privacy and network access

- **No telemetry. No analytics. No usage reporting.** Nothing is sent to the author or to any
  third party other than the providers you sign in to.
- The local gateway binds to `127.0.0.1` on an idle port and is only reachable from your machine.

Domains contacted, and why:

| Domain | Purpose |
| --- | --- |
| `music.163.com` | NetEase Cloud Music web login page and web API |
| `interface.music.163.com` | NetEase Cloud Music eapi (album metadata, stream URLs) |
| `y.qq.com` | QQ Music album pages and login |
| `c.y.qq.com`, `u.y.qq.com` | QQ Music API |
| `ssl.ptlogin2.qq.com`, `xui.ptlogin2.qq.com` | QQ Music login |
| `graph.qq.com` | QQ account profile |
| `y.gtimg.cn` | QQ Music cover CDN |
| `aqqmusic.tc.qq.com` | QQ Music audio CDN (stream URL host) |
| `127.0.0.1:<port>` | The plugin's local gateway process |

What is stored on disk, and where — everything lives in the plugin folder
(`<vault>/.obsidian/plugins/vinyl-life/`) and **never in your notes**:

| File | Contents |
| --- | --- |
| `.cookie` | NetEase Cloud Music login Cookie |
| `.qq-cookie` | QQ Music login Cookie |
| `.anon-token` | NetEase anonymous device token |
| `.device-id` | Device identifier sent with NetEase requests |
| `.qq-guid` | QQ Music device GUID |
| `data.json` | Plugin settings and playback statistics |
| `gateway.log` | Diagnostic log from the gateway process (contains no Cookie values) |
| `.gateway.pid` | PID of the running gateway process, used to clean up stale processes |

You can clear your credentials at any time with **Log out** in the plugin settings.

## Compliance

This section is deliberately blunt — please read it before using the online sources.

- Some QQ Music and NetEase Cloud Music interfaces used by this plugin are **not public APIs**.
  The plugin implements login and stream-URL resolution through **unofficial** interfaces, which
  **may violate the terms of service of those platforms**.
- Use it only for normal, personal use under **your own account**, and evaluate the risk yourself.
- This plugin is **not affiliated with, endorsed by, or connected to Tencent or NetEase**.
- It does **not** bypass payment or membership restrictions. Tracks that require a VIP membership
  or a purchased album still require that entitlement — the plugin only plays what your own
  account is already allowed to play.
- The author provides no warranty and accepts no liability for account restrictions or any other
  consequences of use.

## Known limitations

Not implemented yet (planned):

- Lyrics display.
- A mini player in the status bar.
- ID3 / audio tag parsing for local files.

## Migrating from Vinyl Note (v0.6.0)

As of v0.6.0 the plugin was renamed from **Vinyl Note** to **Vinyl Life**:

- The plugin id changed from `vinyl-note` to `vinyl-life`. Your settings move with the plugin
  folder, but make sure the folder itself is named `vinyl-life` after upgrading.
- The browser-login session partition changed, so **you will need to sign in once more** to
  NetEase Cloud Music and/or QQ Music.
- If you used the earlier bases-based setup, you can now delete or disable `Music.base`, the
  Bases card view, and the `music-vinyl-shelf.css` CSS snippet — the plugin ships the same
  visuals on its own.
- The default folders are now `Vinyl Life/{audio, covers, Vinyl Note}` and are created
  automatically on first run. Existing folder settings are left untouched.

## Development

```bash
npm install
npm run build      # esbuild → main.js (+ src/core/gateway-bundle.ts and server.js)
npm run typecheck  # tsc --noEmit  — run the build first, it generates a file typecheck needs
npm test           # node:test suite, 130+ cases, no Obsidian runtime required
npm run version-bump
```

The test suite runs on plain Node.js (`node:test`) together with esbuild — no Obsidian
installation or test vault is needed.

### Architecture

| Path | Responsibility |
| --- | --- |
| `src/core/` | Album index, queue, playback engine, local source, gateway management, authentication |
| `src/views/` | Album shelf, player, and modals (import, QR login, web login, statistics, delete) |
| `src/animation/` | The record handoff animation |
| `server/` | Gateway source; bundled and inlined into `main.js` at build time |
| `scripts/` | `node:test` suites |

The build produces `main.js` (the only file the community directory installs) plus
`src/core/gateway-bundle.ts`, a generated module holding the gateway source as a string.
Both `main.js` and the generated module are gitignored.

### Releasing

Bump `version` in `manifest.json`, run `npm run version-bump`, commit, then push a tag matching
the version. The release workflow builds the plugin and attaches `main.js`, `manifest.json` and
`styles.css` to a GitHub release. Tags containing `-` (e.g. `0.7.0-beta.1`) are marked as
pre-releases.

## Credits

- The local gateway reuses a small number of endpoint modules from
  [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) (MIT).

## License

[MIT](LICENSE) © 2026 Louiss342

---

## 中文说明

**Vinyl Life** 把 Obsidian 里的专辑笔记变成「专辑墙 + 黑胶唱机播放器」。仅支持桌面端。

**三个音源**（都使用**你自己的**账号登录，插件不携带任何作者凭据）：

- **本地音频** —— vault 内文件或库外绝对路径，无后端、可离线播放。
- **网易云音乐** —— 扫码登录 / 官方登录页浏览器登录 / 手动粘贴 Cookie。
- **QQ 音乐** —— 扫码登录 / 官方登录页浏览器登录 / 手动粘贴 Cookie。

**主要功能**：专辑墙（卡片网格、黑胶弹出动效、音源角标、播放高亮、搜索/排序/筛选/卡片属性/导入工具栏）；播放器（黑胶转盘、唱臂姿态、队列、进度、音量，可停靠侧栏、主区或独立弹出窗口）；黑胶交接动效；专辑链接一键建笔记并代理下载封面，本地音频拖拽入库（复制进 vault 或外链引用；**选/拖一个文件夹即整张专辑导入**，按文件夹名建专辑并保留子目录结构 `audio/<专辑>/CD1/01.flac`）；播放中一键在专辑笔记追加时间戳感想；播放统计写入插件 `data.json`（不写笔记）；播放器配色、唱片颜色、转速、专辑墙列数等外观设置。

### 需要 Node.js

网易云 / QQ 音乐音源依赖一个本地网关进程。Obsidian 自带的二进制禁用了 `ELECTRON_RUN_AS_NODE`，因此**需要系统安装 Node.js（≥ 18，位于 PATH 或常见安装路径）**。网关源码在构建时内联进 `main.js`，首次使用在线音源时释放到系统临时目录运行。

只用本地音频的话**不需要 Node.js**，插件也不会 spawn 任何进程。

### 封面

封面按以下顺序取用：① 卡片右键「设置封面…」选库内图片或本地图片（本地图片会复制进封面目录）；② 笔记 frontmatter 的 `cover:`（vault 内图片 / `https://` 链接 / 色值如 `#8b5cf6`）；③ **约定文件**——专辑音频文件夹里的 `cover.jpg` / `folder.jpg` / `front.jpg`（也支持 `.jpeg` / `.png` / `.webp`）或与专辑同名的图片；④ 封面目录下与专辑同名的图片（与在线导入的命名一致）。

③④ 两步**零操作**：把图放进去，专辑墙下次刷新就会采用（不写笔记）。刚导入的本地专辑在这之前显示 ♪ 占位。

### 支持的音频格式

播放交给 Chromium 内置解码器（插件自身不解码）。可用容器：`mp3`、`m4a` / `m4b` / `mp4`（AAC · ALAC）、`wav`、`ogg` / `oga`（Vorbis）、`opus`、`aac`（ADTS）、`webm` / `weba`。

其余格式（`ape`、`wma`、`dsf`、`dff`、`tak`、`aiff` 等）导入时会被跳过并提示文件名，需先转成 `flac` / `mp3`。vault 内文件与外链模式共用同一份列表。

### 隐私与网络

无遥测、无统计上报。访问的域：`music.163.com`、`interface.music.163.com`（网易云）、`y.qq.com`、`c.y.qq.com`、`u.y.qq.com`、`ptlogin2.qq.com` 等 QQ 音乐登录与 CDN 域名。本地网关只监听 `127.0.0.1`。

凭据与数据全部存放在插件目录内（**不写入笔记**）：`.cookie`、`.qq-cookie`、`.anon-token`、`.device-id`、`.qq-guid`、`data.json`（设置与播放统计）、`gateway.log`（诊断日志，不含 Cookie 值）。可在设置里「退出登录」清除凭据。

### 合规声明

QQ 音乐与网易云的部分接口**并非公开 API**，插件通过**非官方接口**实现登录与取链，**可能违反相应平台的服务条款**；仅供个人在自己账号下正常使用，请自行评估风险。插件与腾讯、网易**无任何关联**，也**不绕过付费 / 会员限制** —— VIP 专享曲目仍需相应会员权益。

### 已知限制

歌词、状态栏迷你控制、ID3 标签解析尚未实现（规划中）。

### 从 Vinyl Note 迁移

v0.6.0 起由 "Vinyl Note" 更名为 "Vinyl Life"（插件 id 由 `vinyl-note` → `vinyl-life`，设置随插件目录迁移）。浏览器登录会话分区已更换，升级后需**重新登录一次**。旧版 `Music.base` + Bases 卡片视图 + `music-vinyl-shelf.css` 片段可删除 / 停用（插件自带同款视觉）。默认目录改为 `Vinyl Life/{audio, covers, Vinyl Note}`，首次运行自动创建；已有设置不受影响。

### 许可

MIT，详见 [LICENSE](LICENSE)。
