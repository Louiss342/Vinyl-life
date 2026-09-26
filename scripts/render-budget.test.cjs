// 渲染契约（性能那几处的接线）：
//   这些改动都**不改变任何可见行为** —— 少了它们界面照样对，只是每 400ms 多扫一遍全部卡片、
//   打开墙时把几百张封面一起塞进解码队列、看不见的时候照样重建整面墙。正因为「行为不变」，
//   行为用例测不出来，只能把接线钉住（与 queue-actions 的「接线」一节同一路数）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('封面：列表类封面图一律 lazy（打开墙不该把几百张图一起解码）', () => {
  for (const [file, what] of [
    ['src/views/shelf-view.ts', '专辑墙卡片'],
    ['src/views/album-picker.ts', '唱片区'],
    ['src/views/stats-page.ts', '统计页当日唱片墙 / 排行'],
  ]) {
    const src = read(file);
    const imgs = src.match(/createEl\('img',[\s\S]{0,200}?\}\)/g) || [];
    assert.ok(imgs.length, `${what}：没找到封面图创建处（探针可能过期了）`);
    for (const img of imgs) {
      assert.match(img, /loading: 'lazy'/, `${what}：封面图要带 loading:'lazy'`);
      assert.match(img, /decoding: 'async'/, `${what}：封面图要带 decoding:'async'`);
    }
  }
});

test('快照：播放器只写变化的那两行，不再全量遍历队列行', () => {
  const src = read('src/views/player-view.ts');
  assert.doesNotMatch(
    src,
    /this\.queueRows\.forEach\(\(row, i\) => \{[\s\S]{0,200}?is-current/,
    '队列行不该每次快照都全量 toggle（几百行的队列 × 400ms 一次）'
  );
  assert.match(
    src,
    /const indexChanged = s\.index !== this\.lastIndex;[\s\S]{0,300}?if \(indexChanged \|\| queueRebuilt\)/,
    '只在「换曲」或「队列刚重建」时写高亮'
  );
});

test('快照：定位跟随只在换曲时量矩形（currentRowVisible 会强制回流）', () => {
  const src = read('src/views/player-view.ts');
  assert.match(
    src,
    /const wasVisible = indexChanged \? this\.currentRowVisible\(\) : false;/,
    'getBoundingClientRect 是强制回流，不能每次快照都问'
  );
});

test('不可见时不重建整墙：render 开头有可见性判据，重新可见时补一次', () => {
  const src = read('src/views/shelf-view.ts');
  assert.match(
    src,
    /render\(\) \{[\s\S]{0,400}?if \(!this\.isShown\(\)\) \{[\s\S]{0,80}?this\.dirty = true;[\s\S]{0,40}?return;/,
    '后台标签页 / 折叠侧栏里改属性不该重建上千张卡片'
  );
  assert.match(
    src,
    /if \(this\.dirty && this\.isShown\(\)\) this\.render\(\);/,
    '重新可见时要补上攒下的那次渲染'
  );
  assert.match(
    src,
    /private isShown\(\): boolean \{[\s\S]{0,300}?isShown\(\)/,
    '判据与播放器 syncVisibility 同源（isShown 缺失时按可见处理）'
  );
});

test('教程重绘：ResizeObserver / scroll / layout-change 走合流口，且有尺寸指纹', () => {
  const src = read('src/views/shelf-view.ts');
  assert.doesNotMatch(
    src,
    /new ResizeObserver\(\(\) => this\.layoutTutorial\(\)\)/,
    '直接挂在 ResizeObserver 上会在拖窗口时每帧重画十来个 SVG 节点'
  );
  assert.match(src, /requestTutorialLayout\(\)/, '合流口');
  assert.match(
    src,
    /if \(sizeKey === this\.tutorialKey\) return;/,
    '尺寸没变就不重画（同尺寸下这两路会反复报到）'
  );
});

test('vault 事件：两处（插件层缓存作废 / 专辑墙刷新）共用同一份判据，别各写一套', () => {
  const main = read('src/main.ts');
  const shelf = read('src/views/shelf-view.ts');
  for (const [name, src] of [['main.ts', main], ['shelf-view.ts', shelf]]) {
    assert.match(src, /vaultChangeMatters\(\{/, `${name}：要走 util.vaultChangeMatters`);
    assert.doesNotMatch(
      src,
      /this\.app\.vault\.on\('create',\s*onVaultStructureChanged\)/,
      `${name}：别再退回「不看路径一律作废」`
    );
  }
});
