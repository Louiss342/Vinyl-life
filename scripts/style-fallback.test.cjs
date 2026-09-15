// 样式兜底：styles.css 缺失、或与插件不同版本时，把构建期内联的副本挂成构造样式表。
// 覆盖：缺失 → 挂上且内容与源文件逐字节一致、可清理 / 版本一致 → 不动 / 旧版本戳 → 挂上 /
//       没戳（截断）→ 挂上 / 读不到 → 不动 / 坏载荷 → 不抛、不挂 /
//       老宿主（无 adoptedStyleSheets）→ 静默跳过 / main.ts 接线 / styles.css 版本戳与 manifest 同步。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const esbuild = require('esbuild');

const CSS = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
const VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8')
).version;

test('styles.css 的版本戳与 manifest.json 同版本（version-bump 漏跑会红）', () => {
  const stamp = /\/\*! vinyl-life styles v([0-9][0-9.]*)/.exec(CSS);
  assert.ok(stamp, 'styles.css 末尾缺少版本戳：跑 npm run version-bump 补上');
  assert.equal(stamp[1], VERSION, 'styles.css 的版本戳与 manifest.json 不一致');
});

function loadModule({ read = CSS, readThrows = false, withSheets = true } = {}) {
  const source = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '../src/core/style-fallback.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text;
  const created = [];
  const logs = [];
  class FakeSheet {
    constructor() {
      this.css = '';
      created.push(this);
    }
    replaceSync(css) {
      this.css = css;
    }
  }
  const doc = { adoptedStyleSheets: [] };
  if (!withSheets) delete doc.adoptedStyleSheets;
  const mod = { exports: {} };
  vm.runInNewContext(source, {
    module: mod,
    exports: mod.exports,
    require: (name) => {
      if (name === 'fs') {
        return {
          readFileSync: () => {
            if (readThrows) throw new Error('ENOENT');
            return read;
          },
        };
      }
      if (name === 'zlib') return zlib;
      throw new Error('Unexpected runtime import: ' + name);
    },
    Buffer,
    console: {
      warn: (...a) => logs.push(['warn', ...a]),
      error: (...a) => logs.push(['error', ...a]),
    },
    document: doc,
    CSSStyleSheet: FakeSheet,
  });
  return { mod: mod.exports, doc, created, logs };
}

const gzip = (s) => zlib.gzipSync(Buffer.from(s, 'utf8'), { level: 9 }).toString('base64');

test('styles.css 缺失 → 挂上构造样式表，内容与源文件逐字节一致，可清理', () => {
  const { mod, doc, created, logs } = loadModule({ readThrows: true });
  const dispose = mod.installStyleFallback('somewhere/styles.css', gzip(CSS), VERSION);
  assert.equal(typeof dispose, 'function', '应当返回清理函数');
  assert.equal(created.length, 1, '应恰好创建一张样式表');
  assert.equal(doc.adoptedStyleSheets.length, 1, '应挂到 document.adoptedStyleSheets');
  assert.equal(created[0].css, CSS, '样式内容必须与 styles.css 逐字节一致');
  assert.equal(logs.filter((l) => l[0] === 'warn').length, 1, '要留一条 [vinyl] 控制台日志');
  dispose();
  assert.equal(doc.adoptedStyleSheets.length, 0, '清理后应摘掉');
});

test('styles.css 在位且版本一致 → 什么都不做（Obsidian 自己会加载）', () => {
  const { mod, doc, created, logs } = loadModule({ read: CSS });
  assert.equal(mod.installStyleFallback('x/styles.css', gzip(CSS), VERSION), null);
  assert.equal(created.length, 0);
  assert.equal(doc.adoptedStyleSheets.length, 0);
  assert.deepEqual(logs, [], '正常安装不该有任何日志');
});

// 「升级时只覆盖了 main.js」——新代码配旧样式：设置面板整块改版过，这时会完全没样式
test('styles.css 是旧版本（戳与插件不符）→ 照挂兜底', () => {
  const old = CSS.replace(/vinyl-life styles v[0-9.]+/, 'vinyl-life styles v1.0.9');
  const { mod, doc, created, logs } = loadModule({ read: old });
  const dispose = mod.installStyleFallback('x/styles.css', gzip(CSS), VERSION);
  assert.equal(typeof dispose, 'function', '版本不符必须兜底');
  assert.equal(created[0].css, CSS, '兜底内容用当前版本的样式');
  assert.match(String(logs[0]), /v1\.0\.9/, '日志要写明用户那份是什么版本');
});

test('styles.css 被截断（没有版本戳）→ 照挂兜底', () => {
  const truncated = CSS.slice(0, 20000); // 尾巴连同版本戳一起丢
  const { mod, doc, created } = loadModule({ read: truncated });
  assert.equal(typeof mod.installStyleFallback('x/styles.css', gzip(CSS), VERSION), 'function');
  assert.equal(doc.adoptedStyleSheets.length, 1);
  assert.equal(created.length, 1);
});

test('读不到文件（缺失 / 权限）→ 照挂兜底：内置副本就是当前版本的样式', () => {
  const { mod, doc, created } = loadModule({ readThrows: true });
  assert.equal(typeof mod.installStyleFallback('x/styles.css', gzip(CSS), VERSION), 'function');
  assert.equal(created.length, 1);
  assert.equal(doc.adoptedStyleSheets.length, 1);
});

test('内联载荷损坏 → 不抛异常、不挂（console.error 记录）', () => {
  const { mod, doc, created, logs } = loadModule({ readThrows: true });
  assert.equal(mod.installStyleFallback('x/styles.css', 'not-a-gzip', VERSION), null);
  assert.equal(created.length, 0);
  assert.equal(doc.adoptedStyleSheets.length, 0);
  assert.equal(logs.filter((l) => l[0] === 'error').length, 1, '失败要留一条 [vinyl] 控制台日志');
});

test('老宿主没有构造样式表 → 静默跳过', () => {
  const { mod, doc } = loadModule({ readThrows: true, withSheets: false });
  assert.equal(mod.installStyleFallback('x/styles.css', gzip(CSS), VERSION), null);
  assert.equal(doc.adoptedStyleSheets, undefined);
});

test('main.ts：接线（传入 styles.css 路径、内联载荷与版本；清理函数进 register）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  assert.ok(
    /installStyleFallback\(\s*pluginAbsPath\(this, 'styles\.css'\),\s*STYLE_GZIP,\s*this\.manifest\.version\s*\)/.test(
      src
    ),
    'onload 必须传入插件目录的 styles.css 路径、内联载荷与当前版本（版本拿来核样式表）'
  );
  assert.ok(
    /if \(disposeStyleFallback\) this\.register\(disposeStyleFallback\)/.test(src),
    '清理函数必须交给 register（插件卸载时摘掉样式）'
  );
});
