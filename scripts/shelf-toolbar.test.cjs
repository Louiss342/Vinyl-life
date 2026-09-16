// 专辑墙工具栏回归（抽屉 + 批量删除），纯文本扫描，不需要 Obsidian：
//   A 样式真值（styles.css）：悬浮圆角长条、两侧留缝（不连通页面边缘）、收起时抽屉不占位、
//     搜索框收窄、选择模式的勾选圈 / 动作条、减少动效兜底；
//   B 接线（shelf-view.ts 源码）：把手报 aria-expanded、空墙强制展开、选择模式的手势与出口、
//     删除走 plugin.openDeleteAlbums（批量入口一路通到 delete.ts 的批量盘点）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const CSS = read('styles.css');
const VIEW = read('src/views/shelf-view.ts');

// 极简 CSS 块提取（与 shelf-appearance.test.cjs 同一套手法）
function cssBlock(css, selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{');
  const m = re.exec(css);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  let out = '';
  while (i < css.length && depth > 0) {
    const ch = css[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth > 0) out += ch;
    i++;
  }
  return out;
}

function rule(css, selector) {
  const body = cssBlock(css, selector);
  assert.ok(body, `styles.css 缺少规则 ${selector}`);
  return body;
}

// ============ A. 样式真值 ============

test('样式：工具栏是悬浮圆角长条，两侧留缝（不再拉满、不连通页面两侧）', () => {
  const bar = rule(CSS, '.vinyl-shelf-toolbar');
  assert.match(bar, /border-radius:\s*1[0-9]px/, '要有圆角');
  assert.match(bar, /width:\s*fit-content/, '收起时宽度跟着内容走（一枚小胶囊）');
  assert.match(bar, /max-width:\s*calc\(100% - 32px\)/, '到面板宽度为止，两侧那 16px 的缝不吞掉');
  assert.match(bar, /align-self:\s*flex-start/, 'flex 列默认拉伸：不写这条会重新拉满整行');
  assert.match(bar, /margin:\s*10px 16px/, '左右各留 16px（两侧不连通）');
  assert.match(bar, /position:\s*sticky/, '滚动时钉在视图顶部');
  // 展开态不能靠 fit-content 定宽：宿主算「换行 flex 容器」的 max-content 时不计项间距，
  // 会少算 7 个 8px —— 展开后还是两行（2026-09-16 实测 589px vs 需要 645px）
  assert.match(
    rule(CSS, '.vinyl-shelf-toolbar.is-open'),
    /width:\s*100%/,
    '展开：铺满可用宽度，一行放得下就不换行'
  );
});

test('样式：收起 / 展开同高（点开把手时这条不许长高）', () => {
  // 回归（2026-09-16 实测）：收起时最高的控件是把手（25px），展开时是搜索框（--input-height = 30px）。
  // 不预留高度的话，点一下把手这条从 39px 变 44px —— 把手自己上下跳 2.5px、下面的网格整体位移 5px，
  // 看起来就是「按键被点大了」。所以收起态也要按展开态的最高控件留出内空。
  assert.match(
    rule(CSS, '.vinyl-shelf-toolbar'),
    /min-height:\s*calc\(var\(--input-height,\s*30px\)\s*\+\s*14px\)/,
    '长条要按搜索框的高度预留：14 = 上下内边距 6×2 + 上下边框 1×2'
  );
});

test('样式：常态只露把手 —— 抽屉收起时整块不占位，展开才铺开', () => {
  assert.match(
    CSS,
    /\.vinyl-shelf-toolbar:not\(\.is-open\)\s*>\s*:not\(\.vinyl-shelf-toolbar-toggle\)\s*\{[^}]*display:\s*none/,
    '收起的抽屉要 display: none（焦点与读屏也一并藏住）'
  );
  assert.match(
    CSS,
    /\.vinyl-shelf-toolbar\.is-open\s*>\s*:not\(\.vinyl-shelf-toolbar-toggle\)\s*\{[^}]*animation:/,
    '展开要有入场动画（弹出感）'
  );
  // 把手是内容里的真按钮：hover 有反馈、空墙态（is-static）没有
  const toggle = rule(CSS, '.vinyl-shelf-toolbar .vinyl-shelf-toolbar-toggle');
  assert.match(toggle, /background:\s*transparent/, '把手清掉宿主按钮底色（选择器两级，压过 button:not(.clickable-icon)）');
  assert.match(toggle, /cursor:\s*pointer/);
  assert.match(
    rule(CSS, '.vinyl-shelf-toolbar .vinyl-shelf-toolbar-toggle.is-static'),
    /cursor:\s*default/,
    '空墙：把手不可点'
  );
});

test('接线：任务栏控件平铺在条上（别再造内层 flex 容器）', () => {
  // 回归：嵌套的「换行 flex」会让宿主把整条的 max-content 算小 —— 977px 宽的视图里
  // 整条只量到 589px，导入组被挤到第二行，展开后看着还是「两行」。
  assert.doesNotMatch(CSS, /\.vinyl-shelf-toolbar-body/, '不该再有内层容器样式');
  assert.match(
    VIEW,
    /const searchWrap = bar\.createDiv\(\{ cls: 'vinyl-shelf-search' \}\)/,
    '搜索框直接挂在条上'
  );
  assert.match(
    VIEW,
    /host = bar\.createDiv\(\{ cls: 'vinyl-shelf-import-group' \}\)/,
    '导入组也直接挂在条上（教程的虚线圈照样圈得住）'
  );
});

test('样式：搜索框吃走富余宽度（展开后长条右端不留空），窄面板先收缩再换行', () => {
  const search = rule(CSS, '.vinyl-shelf-search');
  assert.match(search, /flex:\s*1 1 200px/, '基准 200px，富余宽度归它');
  assert.match(search, /min-width:\s*110px/, '窄面板：先收缩到 110px，撑不住才换行');
});

test('样式：选择模式的勾选圈 / 动作条', () => {
  const check = rule(CSS, '.vinyl-shelf-card-check');
  assert.match(check, /display:\s*none/, '常态不显示勾选圈');
  assert.match(check, /pointer-events:\s*none/, '圈不吃点击（点哪儿都由卡片接管）');
  assert.match(
    CSS,
    /\.vinyl-shelf\.is-batching\s+\.vinyl-shelf-card-check\s*\{[^}]*display:\s*flex/,
    '进选择模式才露出来'
  );
  assert.match(
    CSS,
    /\.vinyl-shelf-card\.is-batch-selected\s+\.vinyl-shelf-card-check\s*\{[^}]*background:\s*var\(--interactive-accent\)/,
    '选中：圈点亮'
  );

  const bar = rule(CSS, '.vinyl-shelf-batchbar');
  assert.match(bar, /display:\s*none/, '收起时不占版面');
  assert.match(bar, /position:\s*sticky/, '贴着视图底部浮着');
  assert.match(bar, /border-radius:\s*999px/, '小圆条（与顶部工具栏同一种「浮起来」的观感）');
  assert.match(CSS, /\.vinyl-shelf-batchbar\.is-on\s*\{[^}]*display:\s*flex/, '选择模式中：浮出来');
});

test('样式：减少动效时抽屉 / 动作条不做入场动画', () => {
  // 文件里有多处「减少动效」媒体块（各自挨着自己的主体规则）：把含动作条的那块摘出来验
  const blocks = [];
  let idx = 0;
  while ((idx = CSS.indexOf('@media (prefers-reduced-motion: reduce)', idx)) !== -1) {
    let i = CSS.indexOf('{', idx) + 1;
    let depth = 1;
    let out = '';
    while (i < CSS.length && depth > 0) {
      const ch = CSS[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (depth > 0) out += ch;
      i++;
    }
    blocks.push(out);
    idx = i;
  }
  const block = blocks.find((b) => b.includes('.vinyl-shelf-batchbar.is-on'));
  assert.ok(block, '抽屉 / 动作条要有「减少动效」兜底块');
  assert.match(
    block,
    /\.vinyl-shelf-toolbar\.is-open\s*>\s*:not\(\.vinyl-shelf-toolbar-toggle\)/,
    '抽屉入场动画'
  );
  assert.match(block, /animation:\s*none/);
  assert.match(block, /\.vinyl-shelf-toggle-chevron\s*\{[^}]*transition:\s*none/, '雪佛龙不做旋转过渡');
});

// ============ B. 接线（源码扫描） ============

test('样式：把手箭头是横向的（抽屉朝右铺开，别用上下箭头）', () => {
  // 抽屉展开是横向的（宽度 fit-content → 100%），箭头也跟着横向：
  // 收起朝右（点它向右展开），展开后 rotate(180deg) 朝左（点它收回来）
  assert.match(VIEW, /setIcon\(chevron, 'chevron-right'\)/, '收起态箭头朝右');
  assert.doesNotMatch(VIEW, /setIcon\(chevron, 'chevron-(down|up)'\)/, '上下箭头与抽屉方向对不上');
  assert.match(
    rule(CSS, '.vinyl-shelf-toolbar.is-open .vinyl-shelf-toggle-chevron'),
    /transform:\s*rotate\(180deg\)/,
    '展开后转 180° 朝左（点它就是收回）'
  );
});

test('接线：把手报 aria-expanded、空墙固定展开（教程指着导入按钮）', () => {
  assert.match(VIEW, /this\.drawerForced = !this\.entries\.length/, '空墙判定：没有专辑可删，只有导入一条路');
  assert.match(
    VIEW,
    /this\.toolbarToggle\.setAttribute\('aria-expanded', String\(open\)\)/,
    '读屏要能报出抽屉的展开 / 收起'
  );
  assert.match(VIEW, /drawerForced \|\| this\.drawerOpen/, '空墙时展开态不可被用户收起');
  assert.match(
    VIEW,
    /shelf\.collapse' : 'shelf\.expand'/,
    '提示文案随状态切换（展开 / 收起工具栏）'
  );
});

test('接线：选择模式 —— 点卡片勾选、Shift 连选、Esc 退出、删完自动退出', () => {
  assert.match(
    VIEW,
    /if \(this\.batch\.active\) \{\s*this\.pickForBatch\(album\.path, ev\);/,
    '选择模式里点卡片 = 勾选（不是播放）'
  );
  assert.match(VIEW, /ev\.shiftKey[\s\S]{0,120}?rangeInList\(/, 'Shift 连选走共享原语');
  assert.match(VIEW, /toggleInList\(this\.batch\.selection, path\)/, '普通点击 = 选择原语');
  assert.match(
    VIEW,
    /ev\.key === 'Escape' && this\.batch\.active[\s\S]{0,80}?this\.exitBatch\(\)/,
    'Esc 是选择模式的出口'
  );
  assert.match(
    VIEW,
    /openDeleteAlbums\(albums, \(\) => this\.exitBatch\(\)\)/,
    '删完收工：退出选择模式（回调由弹窗删除成功后触发）'
  );
  assert.match(
    VIEW,
    /this\.plugin\.openDeleteAlbums\(albums,/,
    '删除走 plugin 的批量入口（与单张删除共用 deleteAlbums 一条路径）'
  );
  assert.match(
    VIEW,
    /if \(this\.batch\.active\) return;[\s\S]*?this\.showMenu\(e, ev\)/,
    '选择模式里右键不弹专辑菜单（避免误播 / 误删）'
  );
});

test('接线：批量删除在空墙时不出现；勾选圈只建一次、状态由 syncBatch 回写', () => {
  assert.match(
    VIEW,
    /this\.batchBtn = this\.entries\.length\s*\?\s*mk\('trash-2', t\('shelf\.batchDelete'\)/,
    '没有专辑可删时不渲染入口按钮'
  );
  assert.match(VIEW, /vinyl-shelf-card-check/, '卡片要带勾选圈');
  assert.match(VIEW, /private syncBatch\(\)/, '状态回写集中在一处');
  assert.match(
    VIEW,
    /el\.removeAttribute\('aria-pressed'\)/,
    '退出选择模式要撤掉开关语义（卡片恢复成普通按钮）'
  );
});
