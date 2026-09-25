// 全直角（用户要求）：插件 UI 不再出现圆角矩形 —— 与专辑墙上的专辑一致。
// 纯文本扫描，不需要 Obsidian：
//   1) styles.css 里每一处 border-radius 只能是 0（直角）/ 50%（圆形对象）/ inherit；
//   2) 50% 只允许出现在「本来就是圆的」白名单选择器上（唱片 / 圆钮 / 圆勾 …）；
//   3) 用户点名的几处必须是 0：专辑架（.vinyl-pick）、专辑墙封面、设置页三件套、工具栏 / 动作条；
//   4) 宿主控件与弹层的兜底段在位：.modal.vinyl-modal / .menu.vinyl-menu + 各处接线。
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

test('样式：全插件的 border-radius 只有 0 / 50% / inherit，没有圆角矩形', () => {
  const decls = radiusDeclarations(CSS);
  assert.ok(decls.length > 40, `styles.css 的 border-radius 声明应有几十处，实际 ${decls.length}`);

  for (const [selector, value] of decls) {
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

test('样式：用户点名的几处是直角（专辑架 / 专辑墙封面 / 设置页 / 工具栏与动作条）', () => {
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
  // 专辑墙浮层（陈列 / 添加）：工具栏本身已无边框圆角（单行贴顶、不是盒子），改验这两处
  assert.equal(valueOf('.vinyl-panel {'), '0', '陈列 / 添加浮层：直角');
  assert.equal(valueOf('.vinyl-segment {'), '0', '来源分段控件：直角');
  assert.equal(valueOf('.vinyl-toolbar-textbtn {'), '0', '选择模式的文本按钮：直角');
});

test('样式：宿主控件与弹层的兜底段在位（弹窗壳 / 菜单 / 输入框与按钮）', () => {
  assert.match(CSS, /\.modal\.vinyl-modal\s*\{[^}]*border-radius:\s*0/, '插件弹窗壳：直角');
  assert.match(CSS, /\.modal\.vinyl-modal[\s\S]{0,700}?border-radius:\s*0/, '弹窗里的宿主控件：直角');
  assert.match(CSS, /\.menu\.vinyl-menu[\s\S]{0,120}?border-radius:\s*0/, '插件菜单：直角');
  // 宿主控件那一组是多行选择器表：截到规则体（`}` 之前）再验，别依赖两处之间的距离
  const hostAt = CSS.indexOf('.vinyl-settings button:not(.checkbox-container),');
  assert.ok(hostAt !== -1, '宿主控件兜底段缺少设置页按钮那一条');
  const hostRule = CSS.slice(hostAt, CSS.indexOf('}', hostAt));
  assert.match(hostRule, /border-radius:\s*0/, '设置页宿主按钮：直角');
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
