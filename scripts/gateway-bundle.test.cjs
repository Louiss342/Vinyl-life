// 网关内联载荷：构建期把 server.js 压成 GATEWAY_GZIP 塞进 main.js，运行时 gunzipSync 还原。
// 这份载荷坏了 / 落后一版时，插件照常启动、只有在线音源整块不可用 —— 属于「用户先发现」的故障，
// 所以两处都钉住：① 构建脚本自己在写出产物前解压回验；② 产物与 server.js 逐字节一致。
// ② 挡的是构建期校验挡不住的那种状态：改了 server.js 却没重新构建（工作区里产物是旧的）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const BUNDLE = path.join(root, 'src/core/gateway-bundle.ts');

test('网关内联载荷与 server.js 逐字节一致（改了网关没重新构建会红）', () => {
  assert.ok(
    fs.existsSync(BUNDLE),
    '缺少构建产物 src/core/gateway-bundle.ts：先跑 npm run build'
  );
  const text = fs.readFileSync(BUNDLE, 'utf8');
  const gz = /GATEWAY_GZIP = "([^"]+)"/.exec(text);
  const hash = /GATEWAY_HASH = "([^"]+)"/.exec(text);
  assert.ok(gz, '产物里没有 GATEWAY_GZIP');
  assert.ok(hash, '产物里没有 GATEWAY_HASH');

  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.equal(
    zlib.gunzipSync(Buffer.from(gz[1], 'base64')).toString('utf8'),
    source,
    '解压结果必须与 server.js 逐字节一致'
  );
  assert.equal(
    hash[1],
    crypto.createHash('sha1').update(source).digest('hex').slice(0, 10),
    '临时文件名用的 hash 也要跟着 server.js 走（升级换新文件的依据）'
  );
});

test('构建脚本在写出网关产物之前自己做一遍解压回验', () => {
  const cfg = fs.readFileSync(path.join(root, 'esbuild.config.mjs'), 'utf8');
  const block = cfg.slice(cfg.indexOf("readFileSync('server.js'"), cfg.indexOf('// 2.5)'));
  assert.ok(block, '找不到网关内联那一段（构建脚本改结构了？）');
  assert.ok(block.includes('gunzipSync'), '构建期要解压回验网关载荷');
  assert.ok(
    block.indexOf('gunzipSync') < block.indexOf('GATEWAY_BUNDLE'),
    '回验要发生在写出产物之前 —— 写在后面等于没拦'
  );
});
