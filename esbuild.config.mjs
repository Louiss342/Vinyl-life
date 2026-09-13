// 双产物构建：
//   1) server.js —— 独立网关产物，供 CLI 联调 / 本地排查（发布不携带）
//   2) src/core/gateway-bundle.ts —— 把网关源码内联成 TS 模块，随 main.js 一起分发
//      （社区市场只安装 main.js / manifest.json / styles.css，运行时再把源码落盘到临时目录 spawn）
import esbuild from 'esbuild';
import fs from 'fs';
import crypto from 'crypto';

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

  // 2) 网关源码 → TS 模块（构建中间产物，不提交；hash 用于临时文件名，升级即换新文件）
  const src = fs.readFileSync('server.js', 'utf8');
  const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 10);
  fs.writeFileSync(
    GATEWAY_BUNDLE,
    '// 由 esbuild.config.mjs 构建时生成，请勿手改、勿提交（见 .gitignore）。\n' +
      `export const GATEWAY_HASH = ${JSON.stringify(hash)};\n` +
      `export const GATEWAY_SOURCE = ${JSON.stringify(src)};\n`
  );

  // 3) 前端插件产物（M1 起开启 minify，体积预算见 README）
  await esbuild.build({
    ...common,
    entryPoints: ['src/main.ts'],
    outfile: 'main.js',
    format: 'cjs',
    platform: 'browser',
    target: 'es2021',
    external: ['obsidian', 'electron', '@electron/remote', ...NODE_BUILTINS],
  });

  for (const f of ['main.js', 'server.js', GATEWAY_BUNDLE]) {
    const s = fs.statSync(f).size;
    console.log(`[vinyl-build] ${f}: ${(s / 1024).toFixed(1)} KB`);
  }
}

build().catch((e) => {
  console.error('[vinyl-build] failed', e);
  process.exit(1);
});
