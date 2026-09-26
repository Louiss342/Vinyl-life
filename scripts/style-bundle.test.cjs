// 样式内联载荷：构建期把 styles.css 压缩（去注释 / 收空白）后再 gzip，塞进 main.js 的
// STYLE_GZIP；运行时由 style-fallback 还原成构造样式表兜底（styles.css 缺失或版本不符时）。
// 这份载荷坏了 / 落后一版时，插件照常启动、界面裸奔或样式错位 —— 属于「用户先发现」的故障，
// 所以两处都钉住：
//   ① 构建脚本自己在写出产物前解压回验（见下面第二个用例）；
//   ② 产物与「styles.css 压缩后」逐字节一致（挡的是构建期校验挡不住的那种状态：
//      改了 styles.css 却没重新构建，工作区里的产物还是旧的）。
//   ③ 压缩只动记号、不动规则 —— 用例三盯住用户看得见的两个证据：版本戳与两个字体子集。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const BUNDLE = path.join(root, 'src/core/style-bundle.ts');
const CSS = path.join(root, 'styles.css');

/** 构建期用的同一步压缩（同工具、同参数） */
const minify = (css) => esbuild.transformSync(css, { loader: 'css', minify: true }).code;

/** 产物里的 STYLE_GZIP 解压回文本 */
function payloadCss() {
  assert.ok(
    fs.existsSync(BUNDLE),
    '缺少构建产物 src/core/style-bundle.ts：先跑 npm run build'
  );
  const text = fs.readFileSync(BUNDLE, 'utf8');
  const m = /STYLE_GZIP = "([^"]+)"/.exec(text);
  assert.ok(m, '产物里没有 STYLE_GZIP');
  return zlib.gunzipSync(Buffer.from(m[1], 'base64')).toString('utf8');
}

test('样式内联载荷与「styles.css 压缩后」逐字节一致（改了样式没重新构建会红）', () => {
  const source = fs.readFileSync(CSS, 'utf8');
  assert.equal(
    payloadCss(),
    minify(source),
    '解压结果必须与 styles.css 压缩后逐字节一致'
  );
});

test('压缩后的载荷仍带版本戳与两个字体子集（压缩不能吃掉它们）', () => {
  const source = fs.readFileSync(CSS, 'utf8');
  const payload = payloadCss();

  // 版本戳：esbuild 保留 /*! 开头的版权注释（构建把压缩结果整份内联，样式里也就只剩这一条注释）
  const stamp = /\/\*! vinyl-life styles v([0-9][0-9.]*)/.exec(payload);
  assert.ok(stamp, '兜底副本丢了版本戳：esbuild 若改成丢弃 /*! 注释，这里要跟上');

  // 字体子集：两处 @font-face 的 base64 载荷必须逐字节不变 —— 手写体是设计的一部分，
  // 兜底路径同样要长出手写体（丢了不会报错，只会静默回落到系统字体）
  const fonts = (s) => [...s.matchAll(/url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/g)].map((m) => m[1]);
  const before = fonts(source);
  const after = fonts(payload);
  assert.equal(before.length, 2, 'styles.css 里应有 2 个字体子集（拉丁 Excalifont + 中文霞鹜文楷）');
  assert.deepEqual(after, before, '压缩后的字体载荷必须逐条与源文件相同');
});

test('构建脚本在写出样式产物之前自己做一遍解压回验', () => {
  const cfg = fs.readFileSync(path.join(root, 'esbuild.config.mjs'), 'utf8');
  const block = cfg.slice(cfg.indexOf("readFileSync('styles.css'"), cfg.indexOf('// 3) 前端插件产物'));
  assert.ok(block, '找不到样式内联那一段（构建脚本改结构了？）');
  assert.ok(block.includes('gunzipSync'), '构建期要解压回验样式载荷');
  assert.ok(block.includes('minify: true'), '进产物的样式要先压缩（省下的全是注释，见 esbuild.config.mjs）');
  assert.ok(
    block.indexOf('gunzipSync') < block.indexOf('STYLE_BUNDLE'),
    '回验要发生在写出产物之前 —— 写在后面等于没拦'
  );
});

// 端到端：拿**真实构建出来的载荷**走一遍兜底挂载（前面几条用的是测试自己压的那份）。
// 这条把「构建产物 → 运行时还原 → 挂成构造样式表」整段串起来 —— 用户装漏 styles.css 时走的就是它。
test('用真实载荷挂兜底：挂上去的样式 == styles.css 压缩后（含字体）', () => {
  const source = esbuild.buildSync({
    stdin: {
      contents:
        "export { installStyleFallback } from '../src/core/style-fallback';\n" +
        "export { STYLE_GZIP } from '../src/core/style-bundle';\n",
      resolveDir: __dirname,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text;

  const created = [];
  const logs = [];
  const doc = { adoptedStyleSheets: [] };
  const mod = { exports: {} };
  vm.runInNewContext(source, {
    module: mod,
    exports: mod.exports,
    require: (name) => {
      if (name === 'fs') return { readFileSync: () => { throw new Error('ENOENT'); } };
      if (name === 'zlib') return zlib;
      return require(name);
    },
    Buffer,
    console: { warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) },
    document: doc,
    CSSStyleSheet: class {
      constructor() {
        this.css = '';
        created.push(this);
      }
      replaceSync(css) {
        this.css = css;
      }
    },
  });

  const api = mod.exports; // esbuild 会整体重写 module.exports，跑完再取
  const dispose = api.installStyleFallback('/plugin/styles.css', api.STYLE_GZIP, '1.3.1');
  assert.equal(typeof dispose, 'function', 'styles.css 读不到时必须兜底');
  assert.equal(created.length, 1, '应恰好挂一张构造样式表');
  assert.deepEqual(logs.filter((l) => l[0] === 'error'), [], '真实载荷解压不能失败');
  assert.equal(
    created[0].css,
    minify(fs.readFileSync(CSS, 'utf8')),
    '挂上去的必须就是「styles.css 压缩后」'
  );
  assert.equal(
    [...created[0].css.matchAll(/url\(data:font\/woff2;base64,/g)].length,
    2,
    '兜底样式里两个字体子集都要在（手写体不能只在正常安装时才有）'
  );
  dispose();
  assert.equal(doc.adoptedStyleSheets.length, 0, '清理函数要能摘掉');
});
