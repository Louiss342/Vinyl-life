// 样式兜底：手工安装漏掉 styles.css 时，把构建期内联的副本挂成构造样式表，界面不至于裸奔。
// 覆盖：缺失 → 挂上且内容与源文件逐字节一致、可清理 / 在位 → 不动 / 判定失败 → 不动 /
//       坏载荷 → 不抛、不挂 / 老宿主（无 adoptedStyleSheets）→ 静默跳过 / main.ts 接线。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const esbuild = require('esbuild');

const CSS = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');

function loadModule({ exists = true, existsThrows = false, withSheets = true } = {}) {
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
          existsSync: () => {
            if (existsThrows) throw new Error('boom');
            return exists;
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
  const { mod, doc, created, logs } = loadModule({ exists: false });
  const dispose = mod.installStyleFallback('somewhere/styles.css', gzip(CSS));
  assert.equal(typeof dispose, 'function', '应当返回清理函数');
  assert.equal(created.length, 1, '应恰好创建一张样式表');
  assert.equal(doc.adoptedStyleSheets.length, 1, '应挂到 document.adoptedStyleSheets');
  assert.equal(created[0].css, CSS, '样式内容必须与 styles.css 逐字节一致');
  assert.equal(logs.filter((l) => l[0] === 'warn').length, 1, '要留一条 [vinyl] 控制台日志');
  dispose();
  assert.equal(doc.adoptedStyleSheets.length, 0, '清理后应摘掉');
});

test('styles.css 在位 → 什么都不做（Obsidian 自己会加载）', () => {
  const { mod, doc, created, logs } = loadModule({ exists: true });
  assert.equal(mod.installStyleFallback('x/styles.css', gzip(CSS)), null);
  assert.equal(created.length, 0);
  assert.equal(doc.adoptedStyleSheets.length, 0);
  assert.deepEqual(logs, [], '正常安装不该有任何日志');
});

test('存在性判断失败 → 不挂（宁可不挂也不重复叠加）', () => {
  const { mod, doc, created } = loadModule({ existsThrows: true });
  assert.equal(mod.installStyleFallback('x/styles.css', gzip(CSS)), null);
  assert.equal(created.length, 0);
  assert.equal(doc.adoptedStyleSheets.length, 0);
});

test('内联载荷损坏 → 不抛异常、不挂（console.error 记录）', () => {
  const { mod, doc, created, logs } = loadModule({ exists: false });
  assert.equal(mod.installStyleFallback('x/styles.css', 'not-a-gzip'), null);
  assert.equal(created.length, 0);
  assert.equal(doc.adoptedStyleSheets.length, 0);
  assert.equal(logs.filter((l) => l[0] === 'error').length, 1, '失败要留一条 [vinyl] 控制台日志');
});

test('老宿主没有构造样式表 → 静默跳过', () => {
  const { mod, doc } = loadModule({ exists: false, withSheets: false });
  assert.equal(mod.installStyleFallback('x/styles.css', gzip(CSS)), null);
  assert.equal(doc.adoptedStyleSheets, undefined);
});

test('main.ts：接线（传入 styles.css 路径与内联载荷；清理函数进 register）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  assert.ok(
    /installStyleFallback\(pluginAbsPath\(this, 'styles\.css'\), STYLE_GZIP\)/.test(src),
    'onload 必须传入插件目录的 styles.css 路径与内联载荷'
  );
  assert.ok(
    /if \(disposeStyleFallback\) this\.register\(disposeStyleFallback\)/.test(src),
    '清理函数必须交给 register（插件卸载时摘掉样式）'
  );
});
