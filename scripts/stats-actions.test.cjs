// 历史页底部那排按钮的交互契约（源扫描）：
//   结果一律走 Notice，**不写回按钮文案**。
// 背景：备份按钮曾经把备份路径 setText 进自己 —— 这一行是 flex、卡片又 overflow: hidden，
// 长文案把那颗按钮撑大，把右边的「恢复备份 / 清除统计」推出可视区，用户既看不见也点不到。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const PAGE = read('src/views/stats-page.ts');
const CSS = read('styles.css');

/** 取出 renderActions 整段（只看这一排按钮的接线） */
function actionsBlock() {
  const start = PAGE.indexOf('private renderActions');
  const end = PAGE.indexOf('\n  }', start);
  assert.ok(start > 0 && end > start, '探针：没截到 renderActions');
  return PAGE.slice(start, end);
}

test('历史页按钮：结果只走 Notice，不许把路径 / 长文案写回按钮', () => {
  const block = actionsBlock();
  assert.doesNotMatch(
    block,
    /\.setText\(/,
    '按钮文案不许被结果改写（会被卡片裁掉、连带挤掉旁边的按钮）'
  );
  assert.match(block, /notice\(tf\('backup\.created'/, '备份成功：Notice 报落点');
  assert.match(block, /notice\(tf\('backup\.failed'/, '备份失败：也要有可见提示');
  assert.match(block, /notice\(tf\('stats\.exportFailed'/, '导出失败：同上');
  // 清空是不可撤销的：先过确认弹窗，失败提示也在那个弹窗里（页面不再写小字说明）
  assert.match(block, /new ClearStatsModal\(/, '清除先确认');
  assert.doesNotMatch(block, /clearPlaybackStats\(\)/, '按钮不再直接清库');
  assert.match(
    PAGE,
    /ClearStatsModal[\s\S]*?notice\(tf\('stats\.clearFailed'/,
    '清除失败：提示在确认弹窗里'
  );
});

test('历史页按钮：每个都复位 disabled，且四颗按钮各自接线完整', () => {
  const block = actionsBlock();
  const disabledTrue = (block.match(/\.disabled = true/g) || []).length;
  const disabledFalse = (block.match(/\.disabled = false/g) || []).length;
  assert.equal(disabledTrue, disabledFalse, '有一处 disable 就必须有一处 finally 复位');
  for (const key of ['stats.exportNote', 'backup.create', 'backup.restore', 'settings.clearStats']) {
    assert.ok(block.includes(`t('${key}')`), `按钮文案还在：${key}`);
  }
});

test('样式兜底：这排按钮可以换行、单颗不会撑出卡片', () => {
  const rule = /\.vinyl-stats-actions\s*\{[^}]*\}/.exec(CSS);
  assert.ok(rule, '有 .vinyl-stats-actions 规则');
  assert.match(rule[0], /flex-wrap:\s*wrap/, '允许换行');
  const button = /\.vinyl-stats-actions button\s*\{[^}]*\}/.exec(CSS);
  assert.ok(button, '有按钮规则');
  assert.match(button[0], /max-width:\s*100%/, '单颗按钮不撑出卡片');
});

test('自定义属性汇总：全库扫描带签名缓存（不该每次重绘白扫一遍 frontmatter）', () => {
  assert.match(PAGE, /private albumPropKeys\(\): string\[\]/, '扫全库那一步抽成带缓存的方法');
  assert.match(PAGE, /f\.stat\?\.mtime/, '签名含 mtime：改了笔记 / 增删了专辑才重扫');
  assert.match(
    PAGE,
    /if \(this\.propKeyCache\?\.sig === sig\) return this\.propKeyCache\.keys;/,
    '命中签名就直接用缓存'
  );
  assert.doesNotMatch(
    PAGE,
    /private renderCustom[\s\S]{0,400}?for \(const file of findAlbumNotes/,
    'renderCustom 里不该再直接扫全库（走 albumPropKeys）'
  );
});
