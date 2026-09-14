// 双产物构建：
//   1) server.js —— 独立网关产物，供 CLI 联调 / 本地排查（发布不携带）
//   2) src/core/gateway-bundle.ts —— 把网关源码内联成 TS 模块，随 main.js 一起分发
//      （社区市场只安装 main.js / manifest.json / styles.css，运行时再把源码落盘到临时目录 spawn）
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
  for (const f of ['main.js', 'server.js', GATEWAY_BUNDLE]) {
    const s = fs.statSync(f).size;
    sizes[f] = s;
    console.log(`[vinyl-build] ${f}: ${(s / 1024).toFixed(1)} KB`);
  }

  // 体积预算：main.js 是社区市场分发的下载主体（server.js / gateway-bundle 都会内联进去）。
  // 超了就构建失败而不是只打日志 —— 悄悄涨到几 MB 是没人会注意的那种退化。改预算时同步 README。
  const MAIN_JS_BUDGET = 260 * 1024;
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
