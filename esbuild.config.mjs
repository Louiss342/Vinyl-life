// 三产物构建：
//   1) server.js —— 独立网关产物，供 CLI 联调 / 本地排查（发布不携带）
//   2) src/core/gateway-bundle.ts —— 把网关源码内联成 TS 模块，随 main.js 一起分发
//      （社区市场只安装 main.js / manifest.json / styles.css，运行时再把源码落盘到临时目录 spawn）
//   3) src/core/style-bundle.ts —— 把 styles.css 内联成 TS 模块：手工安装漏掉样式文件时，
//      插件把它挂成构造样式表兜底（见 src/core/style-fallback.ts），界面不至于完全无样式
import esbuild from 'esbuild';
import fs from 'fs';
import crypto from 'crypto';
import zlib from 'zlib';

const NODE_BUILTINS = [
  'fs', 'path', 'net', 'http', 'https', 'child_process', 'os', 'crypto',
  'url', 'events', 'stream', 'buffer', 'util', 'zlib', 'querystring',
  'string_decoder', 'tty', 'dns', 'tls', 'assert', 'timers', 'constants',
];

// sourcemap 用外部文件（main.js.map / server.js.map），不占产物本体体积
const common = {
  bundle: true,
  minify: true,
  sourcemap: true,
  charset: 'utf8', // 保留中文文案原文（可读性 + 便于排查）
  logLevel: 'info',
};

const GATEWAY_BUNDLE = 'src/core/gateway-bundle.ts';
const STYLE_BUNDLE = 'src/core/style-bundle.ts';

async function build() {
  // 1) 网关产物（内联用到的网易云子模块与 server/qq.js，可独立运行）
  await esbuild.build({
    ...common,
    entryPoints: ['server/gateway.js'],
    outfile: 'server.js',
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    external: NODE_BUILTINS,
  });

  // 2) 网关源码 → TS 模块（构建中间产物，不提交）。
  //    gzip + base64 后内联：88 KB 明文字符串会吃掉 main.js 三分之一体积，压缩后仅 ~20 KB；
  //    运行时用 zlib.gunzipSync 还原（渲染进程可直接 require node 内建模块）。
  //    hash 用于临时文件名，升级即换新文件。
  const src = fs.readFileSync('server.js', 'utf8');
  const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 10);
  const gz = zlib.gzipSync(Buffer.from(src, 'utf8'), { level: 9 }).toString('base64');
  fs.writeFileSync(
    GATEWAY_BUNDLE,
    '// 由 esbuild.config.mjs 构建时生成，请勿手改、勿提交（见 .gitignore）。\n' +
      `export const GATEWAY_HASH = ${JSON.stringify(hash)};\n` +
      `export const GATEWAY_GZIP = ${JSON.stringify(gz)};\n`
  );

  // 2.5) styles.css → TS 模块（构建中间产物，不提交）：
  //      手工安装漏掉 styles.css 时，插件用它挂一张构造样式表兜底（见 src/core/style-fallback.ts）。
  //      与网关同一保证：构建期当场校验「解压结果与源文件逐字节一致」，坏了直接构建失败。
  const cssSrc = fs.readFileSync('styles.css');
  const cssGz = zlib.gzipSync(cssSrc, { level: 9 }).toString('base64');
  if (!zlib.gunzipSync(Buffer.from(cssGz, 'base64')).equals(cssSrc)) {
    throw new Error('styles.css 内联校验失败：解压结果与源文件不一致');
  }
  fs.writeFileSync(
    STYLE_BUNDLE,
    '// 由 esbuild.config.mjs 构建时生成，请勿手改、勿提交（见 .gitignore）。\n' +
      `export const STYLE_GZIP = ${JSON.stringify(cssGz)};\n`
  );

  // 3) 前端插件产物（minify；体积预算见 build 末尾的 MAIN_JS_BUDGET，超了直接失败）
  await esbuild.build({
    ...common,
    entryPoints: ['src/main.ts'],
    outfile: 'main.js',
    format: 'cjs',
    platform: 'browser',
    target: 'es2021',
    external: ['obsidian', 'electron', '@electron/remote', ...NODE_BUILTINS],
  });

  const sizes = {};
  for (const f of ['main.js', 'server.js', GATEWAY_BUNDLE, STYLE_BUNDLE]) {
    const s = fs.statSync(f).size;
    sizes[f] = s;
    console.log(`[vinyl-build] ${f}: ${(s / 1024).toFixed(1)} KB`);
  }

  // 体积预算：main.js 是社区市场分发的下载主体（server.js / gateway-bundle / styles.css 都会内联进去）。
  // 超了就构建失败而不是只打日志 —— 悄悄涨到几 MB 是没人会注意的那种退化。改预算时同步 README。
  // 260 → 318：空态教程的两处开销 —— 手写体（拉丁 Excalifont + 中文霞鹜文楷两个子集，内联在
  // styles.css 尾部，见 assets/fonts/）约 41 KB，手绘笔触引擎 roughjs（与 Excalidraw 同款）约 26 KB。
  // 318 → 348：设置面板「关于」页也走手写体，同一对字体按两处文案重做子集（中文多收 160 多字）
  // —— 字体从 31 KB 涨到 47 KB。两处都是为了把设计稿 1:1 搬到插件里；哪天不要了，把预算调回 260。
  // 348 → 384：播放器改成「立方体两面」（Drawing 2026-09-16 10.26.32）—— 新增唱片区（三行唱片架：
  // 视差 / 悬停平放展开 / 多选排队，src/views/album-picker.ts）与唱臂几何换算
  // （src/core/arm-geometry.ts，余弦定理把专辑进度换算成落针距离），styles.css 也多了这一套样式。
  // 都是设计稿要求的功能代码，没有新依赖；哪天不要唱片区了，把预算调回 348。
  // （常数此前忘了跟着注释一起改，实际卡在 368；这次改到 384，同时补上这一轮的面板按键样式。）
  // 384 → 400：导入搜索重做 —— 本地模糊重排（归一化 / 编辑距离近似）、结果池与上游翻页，
  // 加上弹窗的展开 / 翻页状态机，共约 6 KB。没有新依赖，全是搜索质量本身的代码。
  // 400 → 420：独立统计页 —— 近一年热力日历、当日唱片墙、专辑快照恢复、
  // 自定义属性汇总和 Markdown 导出。新增为功能代码与样式，没有引入依赖。
  // （累计播放行另走手写体：文案进了两个字体子集，中文面 +0.7 KB，仍在这条预算之内。）
  const MAIN_JS_BUDGET = 420 * 1024;
  if (sizes['main.js'] > MAIN_JS_BUDGET) {
    throw new Error(
      `main.js 体积 ${(sizes['main.js'] / 1024).toFixed(1)} KB 超出预算 ${MAIN_JS_BUDGET / 1024} KB：` +
        '看看是不是误引入了大依赖（能内联的小实现优先），确有必要再调 esbuild.config.mjs 里的预算'
    );
  }
}

build().catch((e) => {
  console.error('[vinyl-build] failed', e);
  process.exit(1);
});
