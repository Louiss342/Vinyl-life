// 设置旧键清理回归（core/settings-legacy）：删功能留下的死键必须真的被清掉。
// 为什么值得钉：loadSettings 是 `{ ...DEFAULT_SETTINGS, ...data }`，不清就会把死键原样写回
// 下一份 data.json —— 这个循环没有报错、没有提示，只有几年后有人翻存档时才发现。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const source = esbuild.buildSync({
  entryPoints: [path.join(root, 'src/core/settings-legacy.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
}).outputFiles[0].text;

const mod = { exports: {} };
vm.runInNewContext(source, { module: mod, exports: mod.exports });
const { REMOVED_SETTINGS, pruneRemovedSettings } = mod.exports;

test('清单里的每个键都被删掉', () => {
  const bag = { volume: 0.8, lastPlayback: { albumPath: 'a', trackKey: 'b', positionSec: 1 } };
  for (const key of REMOVED_SETTINGS) bag[key] = { 旧值: true };
  pruneRemovedSettings(bag);
  for (const key of REMOVED_SETTINGS) {
    assert.equal(key in bag, false, `${key} 没被清掉（它会一直跟着存档滚下去）`);
  }
});

test('只删清单里的键：其它设置与运行时字段一个都不能动', () => {
  const bag = {
    volume: 0.8,
    albumFolder: 'Vinyl Life/Vinyl Note',
    lastBackupAt: 123,
    lastProbeAt: 456,
    shelfProps: ['artist'],
    stats: { events: [] },
  };
  const before = { ...bag };
  pruneRemovedSettings(bag);
  assert.deepEqual(bag, before, '清旧键不能误伤现役字段 —— 那是真的丢数据');
});

test('miss 时不出错：空对象与不认识的键都照常返回', () => {
  assert.doesNotThrow(() => pruneRemovedSettings({}));
  const bag = { someoneElsesKey: 1 };
  pruneRemovedSettings(bag);
  assert.deepEqual(Object.keys(bag), ['someoneElsesKey'], '清单外的未知键不归这里管（各自的迁移负责）');
});

test('接线：main.ts 在 loadSettings 里调它，且这批旧键名只出现在 settings-legacy.ts', () => {
  const main = read('src/main.ts');
  const load = main.slice(main.indexOf('async loadSettings()'), main.indexOf('async saveSettings('));
  assert.ok(load.includes('pruneRemovedSettings(this.settings)'), 'loadSettings 里要真的调用（合并完默认值、往下走之前）');
  assert.ok(
    load.indexOf('pruneRemovedSettings') < load.indexOf('const statsRoot'),
    '清理要发生在目录补默认值之前：先扫干净再谈迁移'
  );
  for (const key of REMOVED_SETTINGS) {
    assert.equal(main.includes(key), false, `main.ts 里不该出现 ${key}（清单是它唯一的家）`);
    assert.equal(read('src/settings.ts').includes(key), false, `settings.ts 里不该出现 ${key}`);
  }
});
