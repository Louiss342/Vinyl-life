// 多选原语回归（core/multi-select）：保序切换 / Shift 连选；并守住「只有这一份实现」——
// 专辑墙「批量删除」与播放器唱片区都从共享模块取，别再各写一份（免得两处手势语义漂移）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const source = esbuild.buildSync({
  entryPoints: [path.join(root, 'src/core/multi-select.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
}).outputFiles[0].text;

const mod = { exports: {} };
vm.runInNewContext(source, { module: mod, exports: mod.exports });
const { toggleInList, rangeInList } = mod.exports;

// vm 沙箱里的数组与测试进程不是同一个 realm：比较前搬回来（与其它用例同一套手法）
const arr = (v) => Array.from(v);

test('toggleInList：保序（点选顺序就是删除 / 排队的顺序）', () => {
  assert.deepEqual(arr(toggleInList([], 'a')), ['a']);
  assert.deepEqual(arr(toggleInList(['a'], 'b')), ['a', 'b'], '新选的排在末尾');
  assert.deepEqual(arr(toggleInList(['a', 'b'], 'a')), ['b'], '再点一次 = 取消');
  assert.deepEqual(arr(toggleInList(['a', 'b'], 'c')), ['a', 'b', 'c']);
});

test('rangeInList：连选只并入、不取消；反向连选与无效锚点都不出错', () => {
  assert.deepEqual(arr(rangeInList([], ['a', 'b', 'c', 'd'], 'b', 'd')), ['b', 'c', 'd']);
  assert.deepEqual(arr(rangeInList(['a'], ['a', 'b', 'c', 'd'], 'd', 'b')), ['a', 'b', 'c', 'd'], '反向连选也一样');
  assert.deepEqual(arr(rangeInList(['d'], ['a', 'b', 'c', 'd'], 'a', 'b')), ['d', 'a', 'b'], '已选中的不重复追加');
  assert.deepEqual(arr(rangeInList([], ['a'], 'x', 'a')), [], '锚点不在列表里 = 不动作');
});

test('接线：专辑墙与唱片区共用这一份实现（别再各写一份）', () => {
  for (const f of ['src/views/shelf-view.ts', 'src/views/album-picker.ts']) {
    const src = read(f);
    assert.match(src, /from '\.\.\/core\/multi-select'/, `${f} 要从共享模块取多选原语`);
  }
  // 探针：原实现所在的位置不该再出现函数定义（搬走了却没删干净会留下两份语义）
  assert.doesNotMatch(read('src/views/album-picker.ts'), /export function toggleInList/, '旧实现没删干净');
  assert.doesNotMatch(read('src/views/album-picker.ts'), /export function rangeInList/, '旧实现没删干净');
});
