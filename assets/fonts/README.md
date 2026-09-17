# 手写体（`Vinyl Hand` / `Vinyl Hand CJK`）

手绘页面 / 段落的手写体，与设计稿 `Excalidraw/Drawing 2026-09-15 14.14.52`（专辑墙空态教程）、
`Excalidraw/Drawing 2026-09-15 15.58.24`（设置面板）和 `Excalidraw/Drawing 2026-09-17 16.15.55`
（统计页的累计播放行）同源：

| 面 | 字体 | 用在哪 | 子集大小 |
| --- | --- | --- | --- |
| `Vinyl Hand` | [Excalifont](https://github.com/excalidraw/excalidraw)（Excalidraw 的拉丁手写体） | 拉丁字母、数字、西文标点 | ~12 KB |
| `Vinyl Hand CJK` | [霞鹜文楷 LXGW WenKai](https://github.com/lxgw/LxgwWenKai)（Excalidraw 渲染中文时配的字体） | 中文与中文标点 | ~35 KB |

两个面按**三处文案**裁成子集：专辑墙空态教程（`src/core/i18n.ts` 的 `shelf.tutorial.*`）、
设置面板「关于」页（`src/core/about.ts` 的作者手记 + 词典里的版本 / 许可行 + 页面上写死的
拉丁文），以及统计页的累计播放行（词典里的 `stats.unit*`：次播放 / 听过 / 张专辑）。
三处都是固定内容，所以字能全进子集；改完文案重跑脚本即可。

子集内联在 `styles.css` 末尾的 `@font-face` 里（`data:font/woff2;base64,...`），随样式表一起分发。

## 授权

- **Excalifont** © 2024 by Excalidraw，SIL Open Font License 1.1 —— 全文见 `Excalifont-OFL.txt`
- **LXGW WenKai（霞鹜文楷）** © 2021-2026 LXGW，SIL Open Font License 1.1 —— 全文见 `LXGWWenKai-OFL.txt`
  （其中 [ADDITIONAL PERMISSION] 条款明确允许「为网页字体分发而做的子集化/格式转换」，
  本插件即按此内联分发、不提供可安装的桌面字体文件）
- 两个子集都属于 OFL 定义的修改版本，因此**不沿用原字体名**，改名为 `Vinyl Hand` / `Vinyl Hand CJK`；
  原字体名分别是 Excalidraw 与 LXGW 的保留名称/商标，本插件与这两个项目无从属关系。
- 中英文之外的字（生僻字、用户自己加的字）由浏览器回落到主题字体 —— 最多是个别字没有手写感，不会空白。

## 为什么内联

插件按「main.js / manifest.json / styles.css」三个文件分发（社区市场只装这三个），
`styles.css` 缺失时还会用 main.js 里的内联副本兜底（见 `src/core/style-fallback.ts`），
所以字体必须跟着样式表走，不能单独放一个文件。

## 改文案后重做子集

```bash
# 1) 取两套官方字体
npm i @excalidraw/excalidraw subset-font --no-save   # 拉丁源：dist/prod/fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2
mkdir -p tmp/fonts-src
curl -L -o tmp/fonts-src/LXGWWenKai-Regular.ttf \
  https://github.com/lxgw/LxgwWenKai/releases/download/v1.520/LXGWWenKai-Regular.ttf

# 2) 生成子集并就地重写 styles.css 末尾的 @font-face（字符集自动从这几处文案里取）
node scripts/subset-hand-font.cjs
```

脚本会打印两个子集的体积，并校验 `styles.css` 里正好有 2 个 `@font-face`。
字符集是自动从文案里取的，所以只要重跑脚本，新文案的字就会进子集。
新增手绘页面 / 段落时，把它的文案来源也加进脚本的 `handText()`，并同步 `esbuild.config.mjs`
的体积预算（字体变大，`main.js` 跟着变大）。
