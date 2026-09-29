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
  // 1) 网关产物（内联用到的网易云子模块与 server/qq.js、server/kugou.js，可独立运行）
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
  // 与 styles.css 同一条保证：当场解压回验，坏字节 / 版本错位在构建时就失败 ——
  // 这份载荷坏了插件照常启动、只有在线音源整块不可用，那种故障不该留到用户那里才发现
  // （测试侧另有一条「产物与 server.js 逐字节一致」，见 scripts/gateway-bundle.test.cjs）。
  if (!zlib.gunzipSync(Buffer.from(gz, 'base64')).equals(Buffer.from(src, 'utf8'))) {
    throw new Error('网关内联校验失败：解压结果与 server.js 不一致');
  }
  fs.writeFileSync(
    GATEWAY_BUNDLE,
    '// 由 esbuild.config.mjs 构建时生成，请勿手改、勿提交（见 .gitignore）。\n' +
      `export const GATEWAY_HASH = ${JSON.stringify(hash)};\n` +
      `export const GATEWAY_GZIP = ${JSON.stringify(gz)};\n`
  );

  // 2.5) styles.css → TS 模块（构建中间产物，不提交）：
  //      手工安装漏掉 styles.css 时，插件用它挂一张构造样式表兜底（见 src/core/style-fallback.ts）。
  //      先压缩再 gzip：源文件保持带注释的可读形态，进产物的只有压缩结果 —— 省下的几乎全是注释
  //      （中文散文 gzip 压不动，是这份载荷里唯一一块纯浪费；两个字体子集的 base64 本身是 woff2，两边都动不了它）。
  //      压缩只动记号（空白 / 注释 / 颜色等价写法 / ::after 别名 / 同体相邻规则合并），不改规则 ——
  //      字体与版本戳逐字节保留，scripts/style-bundle.test.cjs 钉着这一点。
  //      与网关同一保证：构建期当场校验「解压结果与压缩后的源逐字节一致」，坏了直接构建失败。
  const cssSrc = fs.readFileSync('styles.css', 'utf8');
  const cssMin = esbuild.transformSync(cssSrc, { loader: 'css', minify: true }).code;
  const cssGz = zlib.gzipSync(Buffer.from(cssMin, 'utf8'), { level: 9 }).toString('base64');
  if (!zlib.gunzipSync(Buffer.from(cssGz, 'base64')).equals(Buffer.from(cssMin, 'utf8'))) {
    throw new Error('styles.css 内联校验失败：解压结果与压缩后的样式不一致');
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
  // 预算沿革 260 → … → 600 KB：逐档来由见 CHANGELOG.md（每一波都是真实功能进产物，没有新依赖）。
  // 要瘦身的话最大一根杠杆是**兜底副本里的字体**：内联样式载荷 64.5 KB 里有 48.6 KB（base64 后约 64.8 KB）
  // 是两个手写体子集，而它只在「手工安装漏了 styles.css」时用得上 —— 剥掉界面仍有完整样式、只退回系统字体；
  // 动它需同步 scripts/style-bundle.test.cjs 那条「载荷逐字节等于 styles.css 压缩后」的契约。
  // 教训：余量写过一次就不更新，维护者按错的地图做取舍（实测只剩 15.7 KB，注释还写着 54）——
  // 所以余量打进下面那行构建日志，数字再也漂不动。
  const MAIN_JS_BUDGET = 600 * 1024;
  console.log(
    `[vinyl-build] main.js 余量: ${((MAIN_JS_BUDGET - sizes['main.js']) / 1024).toFixed(1)} KB` +
      `（预算 ${MAIN_JS_BUDGET / 1024} KB）`
  );
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
