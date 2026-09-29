// 渲染契约（性能那几处的接线）：这些改动不改变可见行为（少了它们界面照样对，只是每 400ms 多扫一遍
// 全部卡片、开墙时把几百张封面一起塞进解码队列），行为用例测不出来，只能钉接线 —— 同 queue-actions「接线」一节。
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
    /const indexChanged = s\.index !== prevIndex;[\s\S]{0,300}?if \(indexChanged \|\| queueRebuilt\)/,
    '只在「换曲」或「队列刚重建」时写高亮'
  );
});

test('快照：定位跟随只在换曲时量矩形（currentRowVisible 会强制回流）', () => {
  const src = read('src/views/player-view.ts');
  assert.match(
    src,
    /const wasVisible = indexChanged \? this\.currentRowVisible\(prevIndex\) : false;/,
    'getBoundingClientRect 是强制回流，不能每次快照都问'
  );
  // 量的必须是**上一行**：lastIndex 紧接着就改写成新行，量成新行时跟随播放滚动会整条失效
  assert.match(src, /const prevIndex = this\.lastIndex;/, '先把上一行的下标记下来');
  assert.match(
    src,
    /private currentRowVisible\(index: number\): boolean \{\n\s*const row = this\.queueRows\[index\];/,
    '下标由调用方给，别读 this.lastIndex'
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

test('增量渲染：网格按 path 复用，不再整墙重建（判断在 core/shelf-diff，视图只执行）', () => {
  const src = read('src/views/shelf-view.ts');
  assert.doesNotMatch(
    src,
    /private renderGrid\(\) \{[\s\S]{0,400}?this\.gridHost\.empty\(\)/,
    'renderGrid 不再一上来就把整面墙清掉'
  );
  assert.match(src, /planCards\(this\.cardSig, next\)/, '走增量计划');
  assert.match(src, /private applyPlan\(/, '照计划执行（复用 / 重画 / 新建）');
  assert.match(
    src,
    /if \(grid\.children\[i\] !== el\) grid\.insertBefore\(el, grid\.children\[i\] \?\? null\)/,
    '顺序对的卡片不动 DOM（insertBefore 会把已有节点挪过来）'
  );
  assert.match(src, /private ensureGrid\(\)/, '网格容器跨渲染复用');
});

test('工具栏与网格跨渲染复用：render 只在首次（或 DOM 掉了）整套重建', () => {
  const src = read('src/views/shelf-view.ts');
  assert.match(
    src,
    /const fresh = this\.forceRebuild \|\| !this\.toolbarEl \|\| !this\.gridHost \|\| this\.toolbarEl\.isConnected === false;/,
    '判据要认「首次 / 容器没了」，别每次刷新都走整套重建'
  );
  assert.match(src, /this\.forceRebuild = false;/, '用完就复位：只在被要求的那一次重建');
  assert.match(
    src,
    /\} else \{[\s\S]{0,300}?this\.syncHeading\(\);[\s\S]{0,120}?this\.syncDisplayButton\(\);/,
    '增量路径只同步会变的两处（计数 / 陈列按钮态），搜索框与焦点都留着'
  );
});

test('分批渲染：首屏同步画一批，其余分帧追加，且能被新的渲染打断', () => {
  const src = read('src/views/shelf-view.ts');
  assert.match(src, /const FIRST_CARDS = \d+;/, '首屏批量');
  assert.match(src, /const APPEND_CARDS = \d+;/, '每帧追加量');
  assert.match(src, /private scheduleAppend\(/, '分帧追加');
  assert.match(
    src,
    /grid\.getBoundingClientRect\(\)\.height < coverTo/,
    '首屏要画到盖住恢复的滚动位置（否则位置会被浏览器夹回 0）'
  );
  assert.match(src, /private cancelGridBatch\(\)/, '新渲染要能打断上一轮没画完的批次');
  assert.match(src, /this\.cancelGridBatch\(\);\s*\n\s*this\.closePanel\(\);/, '关视图时也要收');
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

test('分批追加收尾：把播放态与勾选态补到新卡片上（它们只在第一帧那批上铺过）', () => {
  const src = read('src/views/shelf-view.ts');
  assert.match(
    src,
    /this\.gridBatch = null;[\s\S]{0,400}?this\.syncBatch\(\);[\s\S]{0,140}?if \(this\.lastSnap\) this\.updatePlaying\(this\.lastSnap, true\);/,
    '分帧追加结束后要补一次：否则 60 名之后的卡片永远拿不到 is-playing / is-batched-selected'
  );
});

test('切语言：走 applyLanguage 强制重建（增量分支补不上工具栏与卡片的文案）', () => {
  const view = read('src/views/shelf-view.ts');
  assert.match(view, /applyLanguage\(\) \{\n\s*this\.forceRebuild = true;\n\s*this\.render\(\);/, '视图侧：标一次强制重建');
  const main = read('src/main.ts');
  assert.match(
    main,
    /typeof v\.applyLanguage === 'function'\) v\.applyLanguage\(\)/,
    'main 的 refreshLanguage 要调它 —— 只调 render 会落到增量分支上，文案停在旧语言'
  );
});
