// 卡片右键菜单的形状（2026-09-26 用户报的两处，都在这里钉住）：
//   ① 「在网易云打开」出现过两条 —— 菜单里既有一段按 neteaseId 硬编码的旧项，
//      又有 core/source-link 统一给的那条。同一套 URL 摆两遍。
//   ② 菜单里有「播放」，而左键点卡片就是播放 —— 打开菜单要的是「左键做不到的那些事」。
// 这一批只做源码扫描：菜单是宿主 Menu（假 DOM 里造不出来），能守住的是「摆了几条、摆的是哪条」。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const SHELF = read('src/views/shelf-view.ts');

/** showMenu 整段（只看这张菜单摆了什么） */
function menuBlock() {
  const start = SHELF.indexOf('private showMenu(');
  const end = SHELF.indexOf('menu.showAtPosition(pos)', start);
  assert.ok(start > 0 && end > start, '探针：没截到 showMenu');
  return SHELF.slice(start, end);
}

test('卡片菜单：源站入口只有一处（网易云 / QQ 那两条硬编码的旧项已并入 source-link）', () => {
  const block = menuBlock();
  // 唯一来源：albumSourceLinks 那份循环
  assert.match(block, /for \(const link of albumSourceLinks\(album\)\)/, '源站项走共享的规则');
  // 旧的硬编码：URL 与文案都不该再出现（出现即重复项回归）
  assert.doesNotMatch(block, /music\.163\.com/, '别再硬编码网易云地址');
  assert.doesNotMatch(block, /y\.qq\.com/, '别再硬编码 QQ 地址');
  assert.doesNotMatch(block, /t\('menu\.openNetease'\)/, '别再手写网易云菜单项');
  assert.doesNotMatch(block, /t\('menu\.openQq'\)/, '别再手写 QQ 菜单项');
  // 共享那份要真的按平台给全三条（少一条就是「菜单里找不到在酷狗打开」）
  const link = read('src/core/source-link.ts');
  for (const key of ['menu.openNetease', 'menu.openQq', 'menu.openKugou']) {
    assert.match(link, new RegExp(`'${key.replace('.', '\\.')}'`), `source-link 要给 ${key}`);
  }
});

test('卡片菜单：没有「播放」（左键点卡片就是播放）', () => {
  assert.doesNotMatch(menuBlock(), /t\('menu\.play'\)/, '菜单里不该再有一条「播放」');
  // 左键那条路还在（菜单删的是重复入口，不是播放本身）
  assert.match(
    SHELF,
    /card\.addEventListener\('click'[\s\S]{0,400}?playAlbum\(e\)/,
    '左键点卡片仍然播放'
  );
  assert.doesNotMatch(read('src/core/i18n.ts'), /'menu\.play'/, '没人用的键不留着（死键门禁）');
});
