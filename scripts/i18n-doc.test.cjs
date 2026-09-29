// I18N.md 生成一致性门禁：比对逻辑在 `gen-i18n.cjs --check`（要真求值 DICT），这里接进 npm test 并查产物结构；改文案忘了重新生成就会失败。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const docPath = path.join(root, 'I18N.md');
const genPath = path.join(__dirname, 'gen-i18n.cjs');

test('I18N.md 与 src/core/i18n.ts 一致（改了文案就要重新生成）', () => {
  const r = spawnSync(process.execPath, [genPath, '--check'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(
    r.status,
    0,
    `生成物与源不一致。\n${r.stderr || ''}${r.stdout || ''}\n` +
      '修法：在插件目录跑 `node scripts/gen-i18n.cjs`，把更新后的 I18N.md 一并提交。'
  );
});

test('I18N.md：键表结构完整（含速览 / 分组索引 / 三个专节）', () => {
  const doc = fs.readFileSync(docPath, 'utf8');
  for (const heading of [
    '## 速览',
    '## 分组索引',
    '## 未被引用的键',
    '## 模板串构造的键',
  ]) {
    assert.ok(doc.includes(heading), `缺少「${heading}」一节`);
  }
  // 每个分组表都得有表头，否则渲染出来是一堆裸竖线
  const tables = doc.match(/^\| 键 \| 中文 \| English \| 使用处 \|$/gm) || [];
  assert.ok(tables.length >= 30, `键表数量异常：${tables.length}`);
});

test('I18N.md：键既不重复也不遗漏', () => {
  const doc = fs.readFileSync(docPath, 'utf8');
  // 只取「分组索引」到「未被引用的键」之间的正文：这段里只有主键表，行首是「反引号包起来的键 + 一个竖线」。
  // 两处必须排除，否则去重那一条会误报：索引表每行是**命名空间前缀**（`health.` 这种，多条键共用）；两个专节的键**已在主表出现过**（专节是索引，不是新键）。
  const mainStart = doc.indexOf('## `import.`');
  const mainEnd = doc.indexOf('## 未被引用的键');
  assert.ok(mainStart > 0 && mainEnd > mainStart, 'I18N.md 的分节结构变了，测试需要跟着改');
  const mainBody = doc.slice(mainStart, mainEnd);

  const rows = mainBody
    .split('\n')
    .filter((l) => l.startsWith('| `') && l.indexOf('`', 3) > 3);
  const listed = rows.map((r) => r.split('`')[1]);

  const dupes = listed.filter((k, i) => listed.indexOf(k) !== i);
  assert.deepEqual([...new Set(dupes)], [], '文档里出现了重复的键');

  // 反向核对：DICT 的每个键都必须出现在文档里 —— 用与生成脚本同一套求值方式取 DICT（正则猜源码会和源脱节）。
  const esbuild = require('esbuild');
  const built = esbuild.buildSync({
    entryPoints: [path.join(root, 'src/core/i18n.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text;
  const mod = { exports: {} };
  const api = new Function('module', 'exports', 'require', built + '\nreturn module.exports;')(
    mod,
    mod.exports,
    () => ({})
  );
  const missing = Object.keys(api.DICT).filter((k) => !listed.includes(k));
  assert.deepEqual(missing, [], '这些键在 DICT 里但没进文档');
});
