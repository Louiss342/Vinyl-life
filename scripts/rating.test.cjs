// 评分与「人写的数值」的解析口径（core/rating + 三处调用点的接线）：
//   ① 读得宽容：数字 / '4' / '4/5' / '★★★★' / '⭐' 都能读出一个数；读不出来才算缺失（null），
//      不是 0 —— 「没打分」与「打了 0 分」在排序里是两件事；
//   ② 写得自由：评分弹窗写回去的是用户自己填的数字（不是字符串）；留空 = 删键；
//   ③ 排序那头跟着受益：'1997年' / '2003-05' 以前被当作缺失沉底，现在读得出年份。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const source = esbuild.buildSync({
  stdin: { contents: `export * from '../src/core/rating';\n`, resolveDir: __dirname, loader: 'ts' },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
}).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(source, { module: mod, exports: mod.exports, console });
const { parseLeadingNumber } = mod.exports;

test('解析：数字、字符串、分数、星星都能读出一个数', () => {
  assert.equal(parseLeadingNumber(4), 4);
  assert.equal(parseLeadingNumber('4'), 4);
  assert.equal(parseLeadingNumber('4/5'), 4, '分数取第一个数');
  assert.equal(parseLeadingNumber('4.5'), 4.5, '小数保留（排序不该被抹平）');
  assert.equal(parseLeadingNumber('★★★★'), 4, '实心星计数');
  assert.equal(parseLeadingNumber('★★★★☆'), 4, '空心星不算');
  assert.equal(parseLeadingNumber('⭐ ⭐ ⭐'), 3, '卡片前缀那颗 emoji 星也认');
  assert.equal(parseLeadingNumber('1997年'), 1997, '年份里带汉字');
  assert.equal(parseLeadingNumber('2003-05'), 2003);
  assert.equal(parseLeadingNumber('评分：8'), 8, '10 分制读得出原值（排序不夹取）');
});

test('缺失与 0 分分开：认不出来回 null，不是 0', () => {
  for (const v of ['', '   ', '待定', 'N/A', null, undefined, {}, [], true]) {
    assert.equal(parseLeadingNumber(v), null, `${JSON.stringify(v)} 应算缺失`);
  }
  assert.equal(parseLeadingNumber(0), 0, '0 是有效值（打了 0 分 ≠ 没打分）');
});

test('接线：卡片菜单有「评分」入口，弹窗自由填数字 / 留空则清除', () => {
  const shelf = read('src/views/shelf-view.ts');
  assert.match(shelf, /setTitle\(t\('menu\.rating'\)\)/, '卡片菜单要有评分子项');
  assert.match(shelf, /new RatingModal\(/, '菜单项开评分弹窗');
  const modal = read('src/views/rating-modal.ts');
  assert.match(modal, /fm\.rating = value/, '写入：数字（不是字符串）');
  assert.match(modal, /delete fm\.rating/, '留空 = 删键（不留空串这种残渣）');
  assert.match(modal, /\(fm: Record<string, unknown>\)/, '回调参数显式标注（审核口径）');
  assert.match(modal, /inputmode: 'decimal'/, '手机上弹数字键盘');
  assert.match(modal, /Number\.isFinite\(value\)/, '填了非数字就地提示、不关窗');
  assert.match(modal, /status\.setText\(t\('rating\.invalid'\)\)/, '提示走 i18n');
  assert.match(modal, /parseLeadingNumber\(this\.album\.rating\)/, '预填当前值（读得出的那个数）');
  // 星级选择器那套已随改版撤掉：不该再出现在源码里（否则就是两套并存的死代码）
  assert.doesNotMatch(read('src/core/rating.ts'), /ratingStars|RATING_MAX/, '星级那套已撤');
});

test('接线：排序的年份 / 评分走同一份解析（「1997年」不再被当缺失）', () => {
  const sort = read('src/core/shelf-sort.ts');
  assert.match(sort, /import \{ parseLeadingNumber \} from '\.\/rating'/, '排序用同一份解析');
  assert.match(sort, /parseLeadingNumber\(v\)/, '数值化走它');
});
