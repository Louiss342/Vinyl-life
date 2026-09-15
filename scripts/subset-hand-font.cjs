// 一次性工具（改了手写体文案后才需要跑）：生成两套手写体子集，并把 styles.css 末尾的
// @font-face 块整体重写。
//
//   拉丁：Excalidraw 官方 Excalifont（设计稿 Drawing 2026-09-15 14.14.52 用的就是它）
//   中文：霞鹜文楷 LXGW WenKai（Excalidraw 渲染中文时配的字体，也就是设计稿里中文的样子）
//
// 用得上手写体的两处文案，字符集都自动从这里取：
//   ① 专辑墙空态教程 —— src/core/i18n.ts 的 shelf.tutorial.*
//   ② 设置面板「关于」页 —— src/core/about.ts 的作者手记（中英） + 词典里的壳文案
//      （版本行 / 许可行） + 页面上写死的拉丁文（产品名 / 链接文字 / 分隔符）
// 两处都是固定内容，所以字能一个不落地进子集；改完文案重跑即可。
//
// 用法：
//   npm i @excalidraw/excalidraw subset-font --no-save          # 取官方字体与子集工具
//   mkdir -p tmp/fonts-src && curl -L -o tmp/fonts-src/LXGWWenKai-Regular.ttf \
//     https://github.com/lxgw/LxgwWenKai/releases/download/v1.520/LXGWWenKai-Regular.ttf
//   node scripts/subset-hand-font.cjs
//
// 授权：Excalifont © 2024 by Excalidraw，SIL OFL 1.1；LXGW WenKai © 2021-2026 LXGW，SIL OFL 1.1。
// 两个子集都属于修改版本，按 OFL 要求不沿用原字体名（本插件用 Vinyl Hand / Vinyl Hand CJK）；
// 授权全文见 assets/fonts/ 下的两个 -OFL.txt。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const EXCALIFONT = path.join(
  root,
  'node_modules/@excalidraw/excalidraw/dist/prod/fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2'
);
const WENKAI = path.join(root, 'tmp/fonts-src/LXGWWenKai-Regular.ttf');
const WENKAI_URL =
  'https://github.com/lxgw/LxgwWenKai/releases/download/v1.520/LXGWWenKai-Regular.ttf';

const OUT_LATIN = path.join(root, 'assets/fonts/vinyl-hand.woff2');
const OUT_CJK = path.join(root, 'assets/fonts/vinyl-hand-cjk.woff2');
const CSS = path.join(root, 'styles.css');
const CSS_MARKER = '/* ============ 手写体';

// 拉丁面额外保底的标点余量（漏字不会白屏，只会回落到下一个字体）。
// 数字虽然正文里没有，但版本号是动态的（1.0.9 → 1.10.0 …），0-9 一次给全。
const LATIN_EXTRA = ' .,:;!?()\'-"…—^_&+/%=*@#[]0123456789';
// 「关于」页上写死的拉丁文（不翻译：产品名 / 链接文字 / 分隔符“·”）
const ABOUT_EXTRA = 'Vinyl Life GitHub ·';
// 去掉 kerning / hinting：整块展示文字用不上，两个面各能省 1~3 KB
const OPTIONS = { targetFormat: 'woff2', keepFeatures: [], noHinting: true };

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** i18n 词典里某条的中英译文（只认 zh: '…' / en: '…' 的写法） */
function dictEntry(src, key) {
  const m = new RegExp(`'${key}'\\s*:\\s*\\{[^}]*\\}`, 's').exec(src);
  if (!m) return { zh: '', en: '' };
  const zh = /zh:\s*'([^']*)'/.exec(m[0]);
  const en = /en:\s*'([^']*)'/.exec(m[0]);
  return { zh: zh ? zh[1] : '', en: en ? en[1] : '' };
}

/** about.ts 里某个字符串常量的原文（写成 '…' + '…' 的拼接，逐段取出再拼起来） */
function aboutConstant(src, name, endMarker) {
  const from = src.indexOf(`export const ${name} =`);
  if (from < 0) throw new Error(`about.ts 里找不到 ${name}`);
  const to = endMarker ? src.indexOf(endMarker, from) : src.length;
  const block = src.slice(from, to);
  return [...block.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\n/g, '')).join('');
}

/** 手写体要覆盖的全部文案 */
function handText() {
  const i18nSrc = read('src/core/i18n.ts');
  const aboutSrc = read('src/core/about.ts');
  const out = { zh: '', en: '' };

  // ① 专辑墙空态教程
  const tutKeys = [...i18nSrc.matchAll(/'(shelf\.tutorial\.[a-zA-Z]+)'/g)].map((m) => m[1]);
  for (const k of new Set(tutKeys)) {
    const v = dictEntry(i18nSrc, k);
    out.zh += v.zh;
    out.en += v.en;
  }

  // ② 「关于」页：作者手记（中英并列，都是原文常量）+ 壳文案
  const aboutZh = aboutConstant(aboutSrc, 'ABOUT_TEXT', 'ABOUT_TEXT_EN');
  const aboutEn = aboutConstant(aboutSrc, 'ABOUT_TEXT_EN', 'REPO_URL');
  if (!aboutZh || !aboutEn) throw new Error('没从 about.ts 里取到手记正文，检查常量写法');
  out.zh += aboutZh;
  out.en += aboutEn;
  for (const k of ['settings.aboutVersion', 'settings.aboutLicense']) {
    out.zh += dictEntry(i18nSrc, k).zh;
    out.en += dictEntry(i18nSrc, k).en;
  }

  if (!out.zh || !out.en) throw new Error('没取到手写体文案，检查上面两处来源的写法');
  return out;
}

function fontFace(family, b64, label) {
  return [
    `@font-face {`,
    `  font-family: '${family}'; /* ${label} */`,
    '  font-style: normal;',
    '  font-weight: 400 700; /* 声明区间：手写体不做合成加粗（图纸标题也只是更大，不加粗） */',
    '  font-display: swap;',
    `  src: url(data:font/woff2;base64,${b64}) format('woff2');`,
    '}',
  ].join('\n');
}

async function main() {
  const subsetFont = require('subset-font');
  for (const [p, url] of [
    [EXCALIFONT, 'npm i @excalidraw/excalidraw --no-save'],
    [WENKAI, `curl -L -o tmp/fonts-src/LXGWWenKai-Regular.ttf ${WENKAI_URL}`],
  ]) {
    if (!fs.existsSync(p)) throw new Error(`缺少字体源：${path.relative(root, p)}\n跑一下：${url}`);
  }

  const text = handText();
  // 拉丁面：英文全部 + 中文里的拉丁字符 + 页面写死的拉丁文 + 标点余量
  const latinChars = text.en + text.zh + ABOUT_EXTRA + LATIN_EXTRA;
  const cjkChars = [...new Set([...text.zh].filter((c) => c.charCodeAt(0) > 0x7f))].join('');

  const latin = await subsetFont(fs.readFileSync(EXCALIFONT), latinChars, OPTIONS);
  const cjk = await subsetFont(fs.readFileSync(WENKAI), cjkChars, OPTIONS);
  fs.writeFileSync(OUT_LATIN, latin);
  fs.writeFileSync(OUT_CJK, cjk);

  const block =
    '\n' +
    [
      '/* ============ 手写体（拉丁 Excalifont + 中文霞鹜文楷，均为官方字体子集） ============',
      ' * 与设计稿同款：拉丁走 Excalifont，中文走霞鹜文楷（Excalidraw 渲染中文时配的就是它）。',
      ' * 用在哪：专辑墙空态教程（Drawing 2026-09-15 14.14.52）与设置面板「关于」页。',
      ' * 两个面都是按这两处文案裁过的子集，故不沿用原字体名；子集之外的字（生僻字等）',
      ' * 由浏览器回落到主题字体，最多是个别字没有手写感，不会空白。',
      ' * 授权：Excalifont © 2024 by Excalidraw、LXGW WenKai © 2021-2026 LXGW，均 SIL OFL 1.1，',
      ' * 全文见 assets/fonts/ 下的两个 -OFL.txt。',
      ' * 文案改了要重做子集：node scripts/subset-hand-font.cjs（说明见 assets/fonts/README.md） */',
      fontFace('Vinyl Hand', latin.toString('base64'), '拉丁：Excalifont 子集'),
      fontFace('Vinyl Hand CJK', cjk.toString('base64'), '中文：霞鹜文楷 子集'),
      '',
    ].join('\n');

  const css = fs.readFileSync(CSS, 'utf8');
  const at = css.indexOf(CSS_MARKER);
  if (at < 0) throw new Error(`styles.css 里找不到字体块标记：${CSS_MARKER}`);
  fs.writeFileSync(CSS, css.slice(0, at) + block);

  const check = fs.readFileSync(CSS, 'utf8');
  const faces = (check.match(/data:font\/woff2/g) || []).length;
  console.log(`拉丁子集 ${path.relative(root, OUT_LATIN)}  ${latin.length} B（${latinChars.length} 字符）`);
  console.log(`中文子集 ${path.relative(root, OUT_CJK)}  ${cjk.length} B（${cjkChars.length} 字）`);
  console.log(`styles.css 已重写：@font-face × ${faces}（应为 2）`);
  if (faces !== 2) throw new Error('styles.css 里的 @font-face 数量不对，检查一下');
}

main().catch((e) => {
  console.error(String((e && e.message) || e));
  process.exit(1);
});
