// 页面内保持直角；功能弹窗与菜单统一圆角（用户 2026-09-27 口径）。纯文本扫 styles.css，不需要 Obsidian：
//   1) border-radius 只许 0（直角）/ 50%（圆形对象）/ inherit，外加弹层登记的那组（弹窗 14 / 浮层与菜单 12 / 分段 10 / 控件 7）；
//   2) 50% 只许上「本来就是圆的」白名单（唱片 / 圆钮 / 圆勾 …）；:has 一律不出现（审核口径：宽泛选择器失效）—— 同为「全插件成立」的纪律；
//   3) 用户点名必须 0 的几处：专辑架（.vinyl-pick）/ 专辑墙封面 / 设置页三件套 —— 工具栏不在此列，它是浮在墙上的操作面，同陈列 / 添加浮层那一档；
//   4) 宿主控件与弹层的兜底段在位：.modal.vinyl-modal / .menu.vinyl-menu + 各视图接线。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const CSS = read('styles.css');

/** 逐行扫出 [选择器, border-radius 值]：选择器取最近一条以 { 结束的行（够用：白名单里的都是单行规则）。 */
function radiusDeclarations(css) {
  const out = [];
  let selector = '';
  for (const line of css.split('\n')) {
    if (/^\s*[.#a-zA-Z][^{}]*\{\s*$/.test(line)) selector = line.trim();
    const m = line.match(/border-radius:\s*([^;]+);/);
    if (m) out.push([selector, m[1].trim()]);
  }
  return out;
}

// 圆形对象白名单（是圆，不是圆角 —— 全直角口径的例外，用户要求「只改角」）
const CIRCLES = [
  '.vinyl-shelf-disc {', // 卡片探出的黑胶唱片
  '.vinyl-shelf-card-check {', // 勾选圈（用户口径里的「圈」）
  '.vinyl-turntable-platter {', // 转盘毛毡垫
  '.vinyl-turntable-disc {', // 唱片定位层
  '.vinyl-turntable-vinyl {', // 唱片本体
  '.vinyl-turntable-label {', // 中心标签（封面圆标）
  '.vinyl-turntable-spindle {', // 中心轴
  '.vinyl-seek-thumb {', // 进度滑块（圆形旋钮）
  '.vinyl-btn {', // 索尼式金属圆钮
  '.vinyl-auth-primary::before {', // 登录状态圆点
  '.vinyl-pick-mark {', // 专辑架多选的小圆勾
];

// 弹层里那一组：档位由「功能弹层」段统一登记，这里只放行，页面内的自绘 UI 仍一律直角。
// '.vinyl-panel {' 用全等比对 —— 换成 includes 会把页面内的 .vinyl-panel-icon 之类也一并放行。
const PANEL_ROUNDED = [
  '.vinyl-panel {',
  '.vinyl-panel :is(button', // 浮层里宿主画的控件（关闭键 / 选择文件…）：与弹窗同一档 7px
  '.modal.vinyl-modal',
  '.menu.vinyl-menu',
  'vinyl-queue-panel',
  'vinyl-import-dialog',
  'vinyl-import-workspace',
  'vinyl-import-search-row', // 弹层里的搜索行（输入框与搜索键）
  'vinyl-segment', // 来源 / 搜索来源的单选段（2026-09-27 第三轮：一排描边药丸，不再是灰底轨道）
  'vinyl-import-result', // 搜索结果行：只出现在浮层 / 弹窗里，按弹层里的控件那一档
  'vinyl-panel-value-btn', // 「封面下的信息」那一小枚按键：悬停浮出的轮廓与浮层里的控件同一档
  'vinyl-props-row', // 陈列第二层（封面下的信息）的行：只在浮层里用，悬停高亮按控件那一档收圆
  'vinyl-shelf-toolbar', // 专辑墙工具栏：浮在墙上的操作面，按浮层那一档算（用户口径 2026-09-27 第二轮）
  'vinyl-shelf-search-box', // 工具栏里展开的搜索框：与弹层输入框同款
  'vinyl-toolbar-textbtn', // 选择模式的文本钮：与弹层按钮同款
];
const isPanelScoped = (selector) =>
  PANEL_ROUNDED.some((s) => (s.endsWith(' {') ? selector === s : selector.includes(s)));

test('样式：页面内保持直角，圆角仅作用于功能弹层', () => {
  const decls = radiusDeclarations(CSS);
  assert.ok(decls.length > 40, `styles.css 的 border-radius 声明应有几十处，实际 ${decls.length}`);

  for (const [selector, value] of decls) {
    if (isPanelScoped(selector)) continue; // 功能弹层统一使用圆角，页面内保持直角
    assert.ok(
      value === '0' || value === '50%' || value === 'inherit',
      `${selector} 的 border-radius 是 ${value}：全直角口径下只允许 0 / 50% / inherit`
    );
  }

  // 50% 只许出现在白名单上（新增圆形对象先想清楚：它是「圆」才配 50%）
  for (const [selector, value] of decls) {
    if (value === '50%') {
      assert.ok(CIRCLES.includes(selector), `${selector} 用了 50%：不在圆形白名单里，改用直角或补白名单`);
    }
  }
  for (const selector of CIRCLES) {
    assert.ok(
      decls.some(([sel, value]) => sel === selector && value === '50%'),
      `圆形白名单里的 ${selector} 不再是 50% —— 圆形对象被改动了吗`
    );
  }
});

test('样式：styles.css 里不出现 :has（审核口径：宽泛选择器失效是性能警告）', () => {
  // 与全直角同一性质的「全插件成立」纪律（原来那两处 :has 已改成 JS 把状态类写在父元素上，触发条件不变）。
  // 先剥掉注释只扫真选择器（注释里要能自由讨论这条纪律）；正则写 \s*\( 不写字面量，免得本文件自己成为仓库里那一处。
  const selectorsOnly = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(selectorsOnly, /:has\s*\(/, 'styles.css 里出现 :has —— 状态该由 JS 写在父元素上');
});

test('样式：用户点名的几处是直角（专辑架 / 专辑墙封面 / 设置页），浮层与工具栏是圆角', () => {
  const decls = radiusDeclarations(CSS);
  const valueOf = (selector) => {
    const hit = decls.find(([sel]) => sel === selector);
    assert.ok(hit, `styles.css 缺少规则 ${selector}`);
    return hit[1];
  };
  // 专辑架（黑胶播放器 → 选取专辑 → 跳转过去的唱片架）：用户点名要直角
  assert.equal(valueOf('.vinyl-pick {'), '0', '专辑架上的专辑：直角（与专辑墙一致）');
  // 专辑墙封面（用户拿来当口径的基准）
  assert.equal(valueOf('.vinyl-shelf-cover {'), '0', '专辑墙封面：直角');
  // 设置页（用户点名的「设计页」）：面板 / 卡片 / 标签页
  assert.equal(valueOf('.vinyl-settings-body {'), '0', '设置面板：直角');
  assert.equal(valueOf('.vinyl-settings-section {'), '0', '设置卡片：直角');
  assert.equal(valueOf('.vinyl-settings-tabs .vinyl-settings-tab {'), '0', '设置标签页：直角');
  // 专辑墙浮层（陈列 / 添加）与工具栏：同一档浮层表面
  assert.equal(valueOf('.vinyl-panel {'), '12px', '陈列 / 添加浮层：统一圆角');
  assert.equal(valueOf('.vinyl-shelf-toolbar {'), '12px', '工具栏：与浮层同一档（用户口径 2026-09-27 第二轮）');
  // 分段控件（来源 / 搜索来源）：一排描边的单选段，只剩段面这一档（灰底轨道已撤，旧口径作废）
  assert.equal(valueOf('.vinyl-segment {'), '7px', '分段控件的段面：与输入框 / 按钮同一档圆角');
  assert.equal(valueOf('.vinyl-import-result {'), '7px', '搜索结果行：与弹层里的控件同一档圆角');
  assert.equal(valueOf('.vinyl-toolbar-textbtn {'), '7px', '选择模式的文本按钮：与弹层按钮同一档圆角');
});

test('样式：宿主控件与弹层的兜底段在位（弹窗壳 / 菜单 / 输入框与按钮）', () => {
  assert.match(CSS, /\.modal\.vinyl-modal\s*\{[^}]*border-radius:\s*14px/, '插件弹窗壳：统一圆角');
  assert.match(CSS, /\.modal\.vinyl-modal button:where[^}]*border-radius:\s*7px/, '弹窗里的宿主按钮：统一圆角');
  assert.match(CSS, /\.menu\.vinyl-menu\s*\{[^}]*border-radius:\s*12px/, '插件菜单：统一圆角');
  // 宿主控件那一组是多行选择器表：截到规则体（`}` 之前）再验，别依赖两处之间的距离
  const hostAt = CSS.indexOf('.vinyl-settings button:not(.checkbox-container),');
  assert.ok(hostAt !== -1, '宿主控件兜底段缺少设置页按钮那一条');
  const hostRule = CSS.slice(hostAt, CSS.indexOf('}', hostAt));
  assert.match(hostRule, /border-radius:\s*0/, '设置页宿主按钮：直角');
});

test('样式：弹层里的按键是「完整的按键」（描边 + 圆角），不再有无边框的菜单行', () => {
  // 用户口径 2026-09-27 第三轮：全族按键一种长相 —— 描边 + 7px 圆角 + 34px 高（此前健康检查行的动作是
  // 撑满整行的无边框文本，同一个窗里两种按钮形状，用户说「按键显示都不完整」）。
  assert.doesNotMatch(
    CSS,
    /\.modal\.vinyl-modal \.vinyl-health-row button\s*\{[^}]*border:\s*none/,
    '健康检查行的按键不再被抹掉描边'
  );
  assert.doesNotMatch(
    CSS,
    /\.modal\.vinyl-modal \.vinyl-health-row button\s*\{[^}]*background:\s*transparent/,
    '也不再把底色抹透（mod-cta 的强调色底要留得住）'
  );
  assert.doesNotMatch(
    CSS,
    /\.modal\.vinyl-modal\.vinyl-dialog-actions \.modal-content button\s*\{[^}]*border:\s*none/,
    '单列选择窗（换源 / 扫码登录 / 设置封面）的按键同样是完整按键'
  );
  // 单列选择窗只把排布压成一列（上下排开），不改按键长相
  const single = /\.modal\.vinyl-modal\.vinyl-dialog-actions \.modal-content > button\s*\{([^}]*)\}/.exec(CSS)?.[1] || '';
  assert.match(single, /width:\s*100%/, '一列排开：按键占满整行宽');
  assert.doesNotMatch(single, /border|background|box-shadow/, '只改排布，不碰按键的表面');
  // 健康检查行的动作排在说明下面一行里：描边按键 + 换行（不再是撑满整行的条）
  assert.match(
    CSS,
    /\.vinyl-health-row button\s*\{\s*margin:\s*0 8px 6px 0/,
    '行里的按键按内容宽排一行，放不下自己换行'
  );
});

test('样式：分段控件在两处（浮层 / 弹窗）长得一样', () => {
  // 兜底那条 .modal.vinyl-modal button:where(…) 是 0,2,1：段的外观不挂两级祖先就压不过它，同一段在弹窗里
  // 是 text-normal、在浮层里是 text-muted（用户说的「两处不统一」正是这一类）。
  const block = /:is\(\.vinyl-panel, \.modal\.vinyl-modal\) \.vinyl-segment\s*\{([^}]*)\}/.exec(CSS)?.[1] || '';
  assert.ok(block, '段的外观要挂在「浮层 / 弹窗」两级祖先上（两处共用一份）');
  for (const prop of ['border:', 'background:', 'font-size:']) {
    assert.ok(block.includes(prop), `段的 ${prop} 归这一条（两处一致）`);
  }
  assert.match(
    CSS,
    /:is\(\.vinyl-panel, \.modal\.vinyl-modal\) \.vinyl-segment\.is-on\s*\{[^}]*font-weight:\s*var\(--font-medium\)/,
    '选中那一段加粗（两处一致）'
  );
});

test('接线：弹窗挂 vinyl-modal、菜单挂 vinyl-menu（只影响插件自己的弹层）', () => {
  const UTIL = read('src/util.ts');
  assert.match(UTIL, /export function markVinylModal\(/, 'util 里要有 markVinylModal');
  assert.match(UTIL, /export function markVinylMenu\(/, 'util 里要有 markVinylMenu');

  // 每个插件弹窗的构造函数里都要挂上（按文件数：导入弹窗与设置封面弹窗各两个 Modal）
  const modals = [
    ['src/views/import-modal.ts', 2],
    ['src/views/set-cover-modal.ts', 2],
    ['src/views/qr-login-modal.ts', 1],
    ['src/views/delete-album-modal.ts', 1],
    ['src/views/delete-batch-modal.ts', 1],
    ['src/views/stats-page.ts', 3], // 恢复备份 / 清除统计确认（+页面自绘的壳）
    ['src/views/library-health.ts', 3], // 健康检查 / 换源 / 重新定位音频
    ['src/views/link-source-modal.ts', 1],
    ['src/views/album-edition-modal.ts', 1],
  ];
  for (const [file, n] of modals) {
    const src = read(file);
    const hits = src.match(/markVinylModal\(this\)/g) ?? [];
    assert.equal(hits.length, n, `${file} 应挂 ${n} 处 markVinylModal(this)`);
  }

  const SHELF = read('src/views/shelf-view.ts');
  const menus = SHELF.match(/markVinylMenu\(menu\)/g) ?? [];
  assert.equal(menus.length, 2, '「更多」与卡片右键菜单都要挂 vinyl-menu（排序 / 筛选已进陈列浮层）');
});
