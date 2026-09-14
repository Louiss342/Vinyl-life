// 可访问性回归（源码 + 样式文本扫描，不需要 Obsidian）：
//   ① 卡片 / 队列行可键盘操作（tabIndex + role=button + aria-label，Enter / 空格等价点击）
//   ② :focus-visible 焦点圈与 prefers-reduced-motion 兜底存在于 styles.css
//   ③ 所有 WAAPI 动画（element.animate）所在文件都引用减少动效判定（防新增动画绕过）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function tsFiles(dir = path.join(root, 'src'), out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

test('可访问性：专辑墙卡片可聚焦、有语义、键盘等价点击', () => {
  const src = read('src/views/shelf-view.ts');
  assert.match(src, /card\.tabIndex = 0/, '卡片要能被 Tab 选中');
  assert.match(src, /card\.setAttribute\('role', 'button'\)/, '读屏软件要能报出「按钮」');
  assert.match(src, /card\.setAttribute\('aria-label', album\.title\)/, '卡片要有可读名称');
  assert.match(src, /'keydown'[\s\S]{0,80}onShelfKeydown/, '要挂键盘监听');
  assert.match(
    src,
    /private onShelfKeydown[\s\S]{0,400}?ev\.preventDefault\(\)[\s\S]{0,120}?card\.click\(\)/,
    'Enter / 空格要等价于点击（空格还得 preventDefault，别让面板滚动）'
  );
});

test('可访问性：队列行可聚焦、Enter 切歌、Alt+↑/↓ 调序（拖拽的键盘等价）', () => {
  const src = read('src/views/player-view.ts');
  assert.match(src, /row\.tabIndex = 0/, '队列行要能被 Tab 选中');
  assert.match(src, /row\.setAttribute\('role', 'button'\)/);
  assert.match(src, /row\.setAttribute\('aria-label', t\.title\)/, '行要有可读名称（曲名）');
  assert.match(src, /ev\.key === 'Enter'[\s\S]{0,200}?playIndex\(idx\)/, 'Enter / 空格切歌');
  assert.match(
    src,
    /ev\.altKey[\s\S]{0,400}?moveTrack\(idx, to\)/,
    'Alt+↑/↓ 走引擎的 moveTrack（与拖拽同一条路径）'
  );
});

test('可访问性：styles.css 有 :focus-visible 焦点圈与减少动效兜底', () => {
  const css = read('styles.css');
  assert.match(css, /\.vinyl-shelf-card:focus-visible/, '卡片要有焦点样式');
  assert.match(css, /\.vinyl-queue-item:focus-visible/, '队列行要有焦点样式');
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}?\.vinyl-turntable-vinyl\.is-spinning[\s\S]{0,80}?animation: none/,
    '减少动效时转盘不该一直转'
  );
});

test('可访问性：每个 WAAPI 动画都做了减少动效判断（防新增动画绕过）', () => {
  const offenders = [];
  let animated = 0;
  for (const f of tsFiles()) {
    const src = fs.readFileSync(f, 'utf8');
    const hits = (src.match(/\.animate\(/g) || []).length;
    if (!hits) continue;
    animated += hits;
    if (!/prefersReducedMotion/.test(src)) {
      offenders.push(path.relative(root, f));
    }
  }
  // 探针：源码里确实有动画（全没了说明扫描或重构失效，这条守门就没意义了）
  assert.ok(animated >= 3, `只扫到 ${animated} 处 element.animate，像是扫描失效`);
  assert.deepEqual(offenders, [], '这些文件里有动画但没判断 prefersReducedMotion');
});
