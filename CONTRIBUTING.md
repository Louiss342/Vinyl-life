# 贡献指南

欢迎提 Issue 和 Pull Request。动手之前，请先读一遍 [README](README.md) 的「开发与构建」一节 —— 环境要求、构建命令、源码目录结构都在那里，这里只讲它没写的约定与流程。

## 环境与构建

最少五步（顺序不能反）：

```bash
npm install
npm run build      # 生成 src/core/gateway-bundle.ts / style-bundle.ts，typecheck 依赖它们
npm run typecheck
npm run lint
npm test
```

`npm run lint` 用的是 `eslint-plugin-obsidianmd`（官方审核规则集），提交前请保持零报错。跑完会看到一条常驻 warning（`obsidianmd/settings-tab/prefer-setting-definitions`）：那是自绘设置面板的既定取舍，不要为了消掉它改回声明式分页（见下面「代码约定」里那一条）。

本地调试：把 `main.js`、`manifest.json`、`styles.css` 放进 `<vault>/.obsidian/plugins/vinyl-life/`，重载插件（或重启 Obsidian）。插件自身的设置项存在同目录的 `data.json` 里。

## 代码约定

- **用户可见文案一律走 i18n**：用 `t()` / `tf()`，键写进 `src/core/i18n.ts` 的 `DICT`，中英两套都要有且不相同。测试会检查「源码里用到的每个键都在词典里」以及「中英齐备」，拼错键名或漏译文会直接红。
- **样式只写在 `styles.css`**：不要写内联 `style`（Obsidian 审核明确要求）。需要主题适配就用 `var(--...)` 变量。构建会把 `styles.css` **压缩后**内联一份进 `main.js`（`src/core/style-fallback.ts`：安装漏文件时用构造样式表兜底，不建 `<style>` 元素）——改样式只需改 `styles.css`（保持带注释的可读形态），压缩只发生在进产物的那份上，构建时自动同步且有测试盯着（`scripts/style-bundle.test.cjs`：载荷必须等于「`styles.css` 压缩后」逐字节，字体子集与版本戳不许被压掉）。
- **定时器走 `window.*`**：`window.setTimeout` / `window.setInterval`，弹出窗口场景下才正常。
- **网络请求用 `requestUrl`**，不要用 `fetch`（插件环境下的跨域与凭据行为不同）。
- **设置面板是自绘标签页（有意为之）**：整面板走 `display()`，不实现 `getSettingDefinitions()` —— 官方文档写明它一旦返回非空数组，`display()` 就不会被调用，两条路只能二选一。选自绘是为了认领设计稿（`Excalidraw/Drawing 2026-09-15 15.58.24`）的浏览器标签页与「关于」页手绘；代价是本插件的设置**不进 Obsidian 的全局设置搜索**（自绘面板的插件都如此），别再「顺手升级」回声明式分页。面板刷新用 `render()`：它为什么整块重建、标签页怎么保持，写在 `src/settings.ts` 的文件头注释里。
- **除此之外不引入已废弃 API**。
- **注释写中文**，并且写「为什么」而不是「做了什么」。仓库里现有的注释密度可以当参考。
- 新增依赖前先想一想：能内联进 `main.js` 的小实现，好过一个只用到一次的三方包。

## 审核的「能力披露」：这三项是有意保留的

社区审核会把下面三项作为能力列出来。它们是功能的一部分，不是待修的缺陷 —— 动手删任何一项之前，先看为什么需要它：

- **文件系统访问（`fs`）**：本地音源的两种形态都靠它 —— 库外绝对路径的音频（`audio:` 列表）由网关按 HTTP Range 供流（`server/gateway.js` 的 `/api/local/stream`；**只供登记过的路径**：取流地址之前插件先调 `/api/local/allow` 登记，见下一条「网关鉴权」），起不来网关时才退回「读整文件 → Blob URL」；另一个 fs 用途是**读内嵌标签**（`core/audio-tags`）：曲名 / 艺人 / 音轨号在文件头 128 KB 里，而 Obsidian 的 vault API 只能整文件读 —— 读前缀而不是整文件，正是为了不把 30 MB 的无损塞进内存；插件凭据（`.cookie` / `.qq-cookie` / `.kugou-cookie` / `.anon-token`）与网关产物也在 vault 之外。vault 内的笔记与附件一律走 Obsidian API（`app.vault.*`），不碰 `fs`。
- **应用内网关与请求鉴权**：网关只监听 `127.0.0.1`，每个请求都要带本次会话的随机 token（`x-vinyl-token`）。唯一的例外是给 `<audio>` 用的那条供流路由 —— 浏览器发媒体请求时加不了自定义头，token 只能放在查询串里（`?t=`）。为此收了两道闸：① 那条路由**只供登记过的路径**（插件取流前调 `/api/local/allow`，登记的就是 `audio:` 里那几个绝对路径），没登记的路径在碰文件系统之前就被 403 挡下；② 网关日志脱敏会抹掉 URL 的查询串，token 不落盘（`server/redact.js`）。没有 token 一律 401。
- **Shell 执行（`child_process`）**：全插件只有一处 —— `src/core/server-manager.ts` 清理 ≤1.0.8 遗留的常驻网关进程。要确认某个 PID 确实是本插件的网关，只能读它的命令行（`powershell` / `ps`）：只看 PID 会在号被系统复用后误杀别人的进程。只在 `.gateway.pid` 存在时跑一次（即从 ≤1.0.8 升上来的那次启动），不是常驻能力。
- **全库枚举（`vault.getMarkdownFiles` / `getFiles`）**：专辑墙的数据源就是「带 `album` 标签的笔记」，启动时要扫一遍建索引；之后按路径取单篇，不重复枚举。

插件是 `isDesktopOnly: true`（本地音频与本地网关都只在桌面端成立）。这三项的理由也写在各自的调用处注释里，方便审核对照。

## 测试

- `npm test`：`node --test`，纯 Node 环境，不需要 Obsidian。用例用 esbuild 把真实 TS 编译进 `node:vm`，再用 stub 顶掉 `obsidian` 模块 —— 所以如果你在新的源码里 import 了 stub 里没有的类（例如 `SettingPage`），记得在相关测试文件的 stub 里补上，否则整个用例文件会加载失败。
- 改动涉及解析、归一化、播放状态这类纯逻辑时，请补上用例：一个「名字说明它测什么」的 `test()` 比一堆断言注释有用。
- README 有中英对照与手记逐字校验的用例，改 README 时别破坏 `## 中文` / `## English` 结构。
- **本地 Node 24、CI 是 Node 20**：用例和被测代码都别依赖只在较新 Node 上成立的行为。已经踩过一次：`privateDecrypt` 配 `RSA_PKCS1_PADDING` 从 Node 20.11 起被 CVE-2023-46809 的修复禁掉、Node 24 又放开，本地 585 条全绿、CI 直接红（现在 `.test.cjs` 里改成无填充解密 + 手工剥填充，见 `kugou-auth.test.cjs` 的 `rsaPkcs1Decrypt`）。拿不准就换个 Node 20 跑一遍 `node --test` 再提交。

## 提交与 Pull Request

- 提交信息用中文，一句话说清这次改了什么；版本提交沿用 `1.0.x：一句话` 的格式（见 `git log`）。
- 提 PR 前请保证 `build` / `typecheck` / `lint` / `test` 四项全绿，CI 跑的就是这四项。
- PR 描述里写清：解决了什么问题、怎么验证的（手动步骤或新增的用例）、有没有用户可见的行为变化。
- 发版由维护者操作：改 `manifest.json` 的 `version` → `npm run version-bump` → 提交 → 打同名 tag 推送，GitHub Actions 会自动构建并创建 Release。`version-bump` 会把版本号同步到 `versions.json`、`package.json` 和 **`styles.css` 末尾的版本戳**；最后这行是插件启动时核对样式表版本的依据（用户升级时只覆盖了 `main.js`，就靠它把界面从「完全没样式」里救回来），有测试盯着，漏跑会红。三份元数据的相互一致（`manifest` ↔ `versions.json` ↔ `package.json`）同样有测试（`scripts/release-metadata.test.cjs`），本地 `npm test`、CI 与 release 工作流都会跑 —— 少了 `versions.json` 条目不会报错，只会让更新对用户永远不出现（见 `version-bump.mjs` 的注释）。

## 报告问题

带上这些信息，能省一轮来回：

- Obsidian 版本、插件版本、操作系统。
- 复现步骤与期望结果；涉及界面的话配一张截图。
- 在线音源相关的问题，附上 `<vault>/.obsidian/plugins/vinyl-life/gateway.log` 里的相关片段。

**不要提交凭据**：`.cookie`、`.qq-cookie`、`.anon-token`、`data.json`（含你自己的目录配置与听歌记录）都已写进 `.gitignore`，发日志前也请把 Cookie 值删掉。

## 许可

本项目采用 [MIT 许可](LICENSE)。提交贡献即表示你同意以同一许可分发你的贡献。

---

# Contributing

Issues and pull requests are welcome. Before you start, read the "Development" section of the [README](README.md) — environment requirements, build commands and the source layout live there. This file covers only the conventions and workflow that the README does not.

## Setup and build

The minimum is five steps, and the order matters:

```bash
npm install
npm run build      # generates src/core/gateway-bundle.ts / style-bundle.ts, which typecheck depends on
npm run typecheck
npm run lint
npm test
```

`npm run lint` runs `eslint-plugin-obsidianmd` (the official review rule set). Please keep it clean. One warning is permanent: `obsidianmd/settings-tab/prefer-setting-definitions` — that is the standing trade-off of the self-drawn settings panel; don't switch back to declarative pages just to silence it (see the matching bullet under "Code conventions").

Local debugging: copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/vinyl-life/` and reload the plugin (or restart Obsidian). Plugin settings live in `data.json` in the same folder.

## Code conventions

- **User-visible text always goes through i18n**: use `t()` / `tf()` and add the key to `DICT` in `src/core/i18n.ts` with both Chinese and English, non-identical. Tests fail if a key used in the source is missing from the dictionary, or if a translation is missing.
- **Styling belongs in `styles.css`**: no inline `style` attributes (an explicit Obsidian review requirement). Use `var(--...)` theme variables for theming. The build inlines a **minified** copy of `styles.css` into `main.js` (`src/core/style-fallback.ts`: applied via a constructed stylesheet when an install is missing the file — never by creating a `<style>` element), so editing `styles.css` (which stays readable, comments and all) is all it takes; minification applies to the inlined copy only, and a test pins it to exactly "`styles.css`, minified" — font subsets and the version stamp included.
- **Use `window.*` timers**: `window.setTimeout` / `window.setInterval`, so popout windows behave.
- **Use `requestUrl`**, not `fetch` — cross-origin and credential handling differ inside the plugin sandbox.
- **The settings panel is drawn by the plugin itself, on purpose**: it renders through `display()` and deliberately does not implement `getSettingDefinitions()` — the docs are explicit that once that method returns a non-empty array, `display()` is never called, so the two are mutually exclusive. The self-drawn route is what lets the panel claim the browser-style tabs and the hand-drawn About page from the design (`Excalidraw/Drawing 2026-09-15 15.58.24`); the price is that this plugin's settings **do not reach Obsidian's global settings search** (true of every self-drawn panel). Please don't "upgrade" it back to declarative pages. Refresh the panel with `render()`; the header comment in `src/settings.ts` explains the full rebuild and how the active tab survives it.
- **Other than that, no deprecated APIs.**
- **Comments are written in Chinese**, and they explain *why*, not *what*. Match the existing comment density.
- Think twice before adding a dependency: a small inlined implementation usually beats a third-party package used once.

## Review "capability disclosures": these three are intentional

Community review lists the three capabilities below. They are part of the feature set, not defects waiting to be fixed — read why each is needed before removing anything:

- **Filesystem access (`fs`)**: both shapes of local sources rely on it — audio at absolute paths outside the vault (the `audio:` list) is streamed by the gateway over HTTP Range (`/api/local/stream`; **registered paths only** — the plugin calls `/api/local/allow` before handing out a stream URL, see the gateway-auth note below), and only falls back to reading whole files as bytes and turning them into Blob URLs when the gateway cannot start. The other use of `fs` is reading **embedded audio tags** (`core/audio-tags`): title, artist and track number live in the first 128 KB of a file, while the vault API can only read whole files — reading a prefix instead is exactly what keeps a 30 MB lossless track out of memory, and the plugin's credentials (`.cookie` / `.qq-cookie` / `.kugou-cookie` / `.anon-token`) plus the gateway artefacts live outside the vault too. Notes and attachments *inside* the vault always go through the Obsidian API (`app.vault.*`), never `fs`.
- **The in-app gateway and request auth**: the gateway listens on `127.0.0.1` only and every request must carry the per-session random token (`x-vinyl-token`). The one exception is the streaming route used by `<audio>` — a browser media request cannot carry custom headers, so the token has to travel in the query string (`?t=`). Two guards make up for that: (1) the route serves **registered paths only** (the plugin calls `/api/local/allow` before handing out a stream URL, registering the absolute paths from the `audio:` list), and an unregistered path is refused with 403 before the filesystem is touched; (2) log redaction strips URL query strings, so the token never reaches `gateway.log` (`server/redact.js`). Without a token, everything is 401.
- **Shell execution (`child_process`)**: exactly one place — `src/core/server-manager.ts` cleaning up the resident gateway process left behind by ≤1.0.8. Confirming a PID really is this plugin's gateway requires reading its command line (`powershell` / `ps`): trusting the PID alone would kill an unrelated process once the OS recycles the number. It runs once, and only when `.gateway.pid` exists (i.e. the first launch after upgrading from ≤1.0.8) — not a standing capability.
- **Vault enumeration (`vault.getMarkdownFiles` / `getFiles`)**: the album shelf is built from "notes tagged `album`", so it scans once at startup to build the index; afterwards notes are fetched by path, with no repeat enumeration.

The plugin is `isDesktopOnly: true` (local audio and the local gateway only exist on desktop). The same reasoning sits in a comment at each call site, for reviewers to follow.

## Tests

- `npm test` runs `node --test`, entirely in Node, no Obsidian needed. Tests compile the real TypeScript with esbuild into `node:vm` and stub the `obsidian` module. If your source imports a class the stub lacks (e.g. `SettingPage`), add it to the stubs in the affected test files — otherwise the whole test file fails to load.
- For parsing, normalisation or playback-state logic, add cases: a `test()` whose name says what it checks beats a pile of commented assertions.
- The README has tests for its Chinese/English parity and the verbatim author's note. Keep the `## 中文` / `## English` structure intact when editing it.
- **Local Node is 24, CI runs Node 20**: neither the tests nor the code under test may rely on behaviour that only newer Node provides. We have been bitten once: `privateDecrypt` with `RSA_PKCS1_PADDING` is blocked by the CVE-2023-46809 fix from Node 20.11 on and allowed again in Node 24, so all 585 tests were green locally and CI went red (the tests now decrypt with no padding and strip it by hand — see `rsaPkcs1Decrypt` in `kugou-auth.test.cjs`). When in doubt, run `node --test` under Node 20 before committing.

## Commits and pull requests

- Write commit messages in Chinese, one line saying what changed; version commits follow the `1.0.x: one-liner` format (see `git log`).
- Before opening a PR, make sure `build` / `typecheck` / `lint` / `test` all pass — that is exactly what CI runs.
- In the PR description, state what problem it solves, how you verified it (manual steps or new test cases), and any user-visible behaviour change.
- Releases are cut by the maintainer: bump `version` in `manifest.json` → `npm run version-bump` → commit → push a tag with the same name; GitHub Actions builds and creates the Release. `version-bump` syncs the version into `versions.json`, `package.json` and the **version stamp at the end of `styles.css`** (the stamp is how the plugin detects a stale stylesheet — see `src/core/style-fallback.ts`). Their mutual agreement is covered by `scripts/release-metadata.test.cjs`, run by `npm test`, CI and the release workflow: a missing `versions.json` entry throws no error at all, it just means the update never reaches any user.

## Reporting issues

Please include:

- Obsidian version, plugin version, operating system.
- Steps to reproduce and the expected result; a screenshot for anything visual.
- For online-source problems, the relevant slice of `<vault>/.obsidian/plugins/vinyl-life/gateway.log`.

**Never post credentials**: `.cookie`, `.qq-cookie`, `.anon-token` and `data.json` (your personal folder config and listening history) are all listed in `.gitignore`. Strip cookie values before sharing logs.

## License

This project is licensed under the [MIT License](LICENSE). By contributing, you agree that your contributions are distributed under the same license.
