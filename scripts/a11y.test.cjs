// 可访问性回归（源码 + 样式文本扫描，不需要 Obsidian）：
//   ① 卡片 / 队列行可键盘操作（role=button + aria-label，Enter / 空格等价点击；专辑墙是
//      roving tabindex + 方向键网格：整墙只占一个 Tab 停靠点）
//   ② :focus-visible 焦点圈与 prefers-reduced-motion 兜底存在于 styles.css
//   ③ 所有 WAAPI 动画（element.animate）所在文件都引用减少动效判定（防新增动画绕过）
//   ④ 浮层打开时焦点跟着进去、并报出「这是什么浮层」（挂在 body 末尾的面板，
//      不搬焦点的话键盘用户得从头 Tab 一整圈才进得来）
//   ⑤ 异步替换的状态行（搜索 / 批量已选 / 导入进度）标成 status 区，读屏软件才播报
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
  // 2026-09-26：卡片从「每张都是 Tab 停靠点」改成 roving —— 默认 -1，唯一的 0 由 syncRoving
  // 指派给光标那张（网格导航本身在下一条用例里守着）。
  assert.match(src, /card\.tabIndex = -1/, '卡片默认退出 Tab 序（停靠点由 syncRoving 指派）');
  assert.match(
    src,
    /private syncRoving[\s\S]{0,600}?want = path === this\.cardCursor \? 0 : -1/,
    'syncRoving 指派唯一停靠点'
  );
  assert.match(src, /card\.setAttribute\('role', 'button'\)/, '读屏软件要能报出「按钮」');
  assert.match(src, /card\.setAttribute\('aria-label', album\.title\)/, '卡片要有可读名称');
  assert.match(src, /'keydown'[\s\S]{0,80}onShelfKeydown/, '要挂键盘监听');
  assert.match(
    src,
    /ev\.key === 'Enter' \|\| ev\.key === ' ' \|\| ev\.key === 'Spacebar'[\s\S]{0,200}?ev\.preventDefault\(\)[\s\S]{0,120}?card\.click\(\)/,
    'Enter / 空格要等价于点击（空格还得 preventDefault，别让面板滚动）'
  );
});

test('可访问性：专辑墙是方向键网格（整墙一个停靠点，100 张专辑不该要 100 次 Tab）', () => {
  const src = read('src/views/shelf-view.ts');
  // 方向键在卡片间走、Home / End 到首尾（与统计页热力图同一套 roving 口径）
  assert.match(src, /private moveCardFocus/, '网格导航要有独立的判定函数');
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
    assert.match(src, new RegExp(`'${key}'`), `方向键 ${key} 要在卡片间走`);
  }
  // 到边了不吞按键：处理成功才 preventDefault（否则用户绑在方向键上的命令会失灵）
  assert.match(
    src,
    /if \(this\.moveCardFocus\(card, ev\.key\)\) \{\s*ev\.preventDefault\(\)/,
    '没有去处时别吞按键'
  );
  assert.match(src, /ev\.stopPropagation\(\);\s*\/\/ 别漏给全局快捷键/, '处理完别漏给全局快捷键');
  // 每轮渲染后把停靠点补回去（卡片可能刚建出来 / 刚被重画）
  assert.match(src, /this\.syncRoving\(\)/, '渲染后要同步停靠点');
  // 「⋯」退出 Tab 序后，卡片菜单必须有键盘入口（标准「菜单按钮」模式），否则
  // 「设置封面 / 在源站打开」对键盘用户又变成不可达
  assert.match(src, /menuBtn\.tabIndex = -1/, '「⋯」按钮不再逐张占一个 Tab 停靠点');
  assert.match(
    src,
    /ev\.key === 'ContextMenu' \|\| \(ev\.key === 'F10' && ev\.shiftKey\)/,
    'Shift+F10 / 菜单键要能打开卡片菜单'
  );
  assert.match(src, /this\.showMenu\(entry, \{ x: r\.left, y: r\.bottom \}\)/, '菜单落点按卡片矩形算');
});

test('可访问性：队列行可聚焦、Enter 切歌、Alt+↑/↓ 调序（拖拽的键盘等价）', () => {
  const src = read('src/views/player-view.ts');
  assert.match(src, /row\.tabIndex = 0/, '队列行要能被 Tab 选中');
  assert.match(src, /row\.setAttribute\('role', 'button'\)/);
  assert.match(src, /row\.setAttribute\('aria-label', track\.title\)/, '行要有可读名称（曲名）');
  assert.match(src, /ev\.key === 'Enter'[\s\S]{0,200}?playIndex\(idx\)/, 'Enter / 空格切歌');
  assert.match(
    src,
    /ev\.altKey[\s\S]{0,400}?moveTrack\(idx, to\)/,
    'Alt+↑/↓ 走引擎的 moveTrack（与拖拽同一条路径）'
  );
});

test('长文本可读性：专辑墙卡片标题的悬停滚动走共享模块', () => {
  assert.match(read('src/views/marquee.ts'), /export function onMarqueeOver/, '滚动逻辑抽成共享模块');
  const shelf = read('src/views/shelf-view.ts');
  assert.match(shelf, /from '\.\/marquee'/, 'shelf-view 要用共享的 marquee（别再各写一份）');
  assert.match(shelf, /'pointerover'[\s\S]{0,60}onMarqueeOver/, '要注册悬停进入');
  assert.match(shelf, /'pointerout'[\s\S]{0,60}onMarqueeOut/, '要注册悬停离开');
  assert.match(shelf, /vinyl-shelf-card-title vinyl-marquee/, '卡片标题要挂 marquee 类');
  // 键盘等价（2026-09-26）：读全一张卡片的完整专辑名曾经只有鼠标一条路 —— 焦点进卡片什么都不发生。
  // 现在焦点进入时同样量一遍（CSS 那条 :focus-visible 分支才有变量可用），离开时复位。
  const marquee = read('src/views/marquee.ts');
  assert.match(marquee, /export function measureMarqueesIn/, '要有「量一块宿主里的 marquee」的入口');
  assert.match(marquee, /export function resetMarqueesIn/, '要有对应的复位入口');
  assert.match(shelf, /'focusin'[\s\S]{0,80}measureMarqueesIn/, '焦点进入卡片要量一遍');
  assert.match(shelf, /'focusout'[\s\S]{0,320}resetMarqueesIn/, '焦点离开要复位');
  const css = read('styles.css');
  assert.match(
    css,
    /\.vinyl-shelf-card:focus-visible \.vinyl-marquee-text/,
    '松开截断要有焦点分支（hover 与 focus 同块，hover 棘轮门禁也认这条）'
  );
  assert.match(
    css,
    /\.vinyl-marquee\.is-overflowing:hover[\s\S]{0,400}white-space:\s*normal/,
    '减少动效下不滚，但要换成换行把全文读出来（只关动画会把长标题裁掉）'
  );
  // 播放器这边目前没有 marquee 元素（Vinyl order 行不放专辑名，用户 2026-09-25 定稿）：
  // 委托监听也跟着撤了。真要再挂一个 marquee 元素，记得把 contentEl 上的 pointerover / pointerout 接回来
  assert.doesNotMatch(
    read('src/views/player-view.ts'),
    /vinyl-marquee/,
    '播放器现在不用 marquee；要用就把 onMarqueeOver / onMarqueeOut 的委托一并接回来'
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

test('可访问性：设置面板标签条是键盘可操作的真按钮，当前页报给读屏软件', () => {
  const src = read('src/settings.ts');
  assert.match(src, /createEl\('button'/, '标签用 <button>：键盘可聚焦、回车 / 空格即切换（div 得自己补键盘处理）');
  assert.match(
    src,
    /'aria-current': isActive \? 'true' : 'false'/,
    '当前标签要标注出来，读屏软件才知道在哪一页'
  );
  // 焦点样式：标签清过底与阴影，默认焦点圈在这层不显眼，样式表里得自己给一圈
  assert.match(
    read('styles.css'),
    /\.vinyl-settings-tabs \.vinyl-settings-tab:focus-visible/,
    '标签要有焦点样式'
  );
  // 「关于」页的虚线框是纯装饰：不给 aria-hidden，读屏软件会念出一坨图形节点
  assert.match(
    read('src/views/about-page.ts'),
    /svg\.setAttribute\('aria-hidden', 'true'\)/,
    '手绘覆盖层要标成装饰'
  );
});

test('可访问性：浮层打开时把焦点搬进去，并报出这是个什么浮层', () => {
  const src = read('src/views/shelf-view.ts');
  assert.match(src, /el\.setAttribute\('tabindex', '-1'\)/, '浮层容器要能接焦点');
  assert.match(src, /el\.setAttribute\('role', 'dialog'\)/, '浮层要有角色，读屏软件才知道跳出的是个对话层');
  assert.match(
    src,
    /el\.focus\(\{ preventScroll: true \}\)/,
    '打开即聚焦；preventScroll 免得把专辑墙滚走'
  );
  assert.match(
    src,
    /el\.setAttribute\('aria-label', props \? t\('display\.props'\) : t\('toolbar\.display'\)\)/,
    '陈列浮层要按当前层给可读名称'
  );
  assert.match(
    src,
    /private renderAddPanel\(el: HTMLElement\): void \{\n\s*el\.setAttribute\('aria-label', t\('add\.title'\)\)/,
    '添加浮层要有可读名称'
  );
});

test('可访问性：异步状态行标成 status 区（搜索 / 批量已选 / 导入进度）', () => {
  assert.match(
    read('src/views/album-search.ts'),
    /vinyl-import-status',[\s\S]{0,60}role: 'status'/,
    '搜索结果状态行（搜索中 / 找到 N 张 / 失败原因）'
  );
  assert.match(
    read('src/views/shelf-view.ts'),
    /vinyl-shelf-batch-info', attr: \{ role: 'status' \}/,
    '批量模式「已选 N 张」'
  );
  assert.match(
    read('src/views/local-import-pane.ts'),
    /vinyl-import-status', attr: \{ role: 'status' \}/,
    '本地导入进度行'
  );
});

test('可访问性：载入 / 缓冲状态位是 live 区，且文案走 i18n', () => {
  const src = read('src/views/player-view.ts');
  assert.match(
    src,
    /vinyl-buffering[\s\S]{0,140}role: 'status'/,
    '状态位要报给读屏 —— 否则「在等数据」与「死了」听起来一模一样'
  );
  assert.match(src, /t\('player\.loading'\)/, '载入文案走 i18n');
  assert.match(src, /t\('player\.buffering'\)/, '缓冲文案走 i18n');
  const css = read('styles.css');
  assert.match(css, /\.vinyl-buffering \{[\s\S]{0,240}display: none/, '不等待时不占位（一行布局不能被它顶歪）');
  assert.match(css, /\.vinyl-buffering\.is-on/, '要有露面的一档');
});

// ============ 1.1.0 之后新增界面的覆盖（上面几条停在 1.0.16，见 e74fe9a）============
// 这一批补的是 1.1.0 / 1.2.0 / 1.3.0 三版界面里从没被门禁覆盖过的交互：
// 浮层焦点与 Tab 陷阱、拖拽的键盘等价、aria-current、菜单落点、卡片的菜单入口、翻面后的焦点。

test('可访问性：陈列浮层打开后焦点进入，且 Tab 在浮层内循环（曾整层不可达）', () => {
  const src = read('src/views/shelf-view.ts');
  assert.match(
    src,
    /private openPanel[\s\S]*?\.focus\(/,
    'openPanel 里必须有初始焦点：否则 Tab 要从工具栏走遍整个宿主界面才轮到这里'
  );
  assert.match(
    src,
    /private openPanel[\s\S]*?ev\.key !== 'Tab'[\s\S]*?FOCUSABLE/,
    '浮层要有 Tab 循环陷阱，且可聚焦元素走同一个选择器'
  );
  // 陷阱挂在 document 的捕获阶段：不先确认焦点在浮层里，就会吃掉宿主界面（编辑器 / 设置）的正常 Tab
  assert.match(
    src,
    /if \(!active \|\| !panelEl\.contains\(active\)\) return;/,
    'Tab 陷阱必须先限定在浮层内 —— 漏了这条比不修还糟'
  );
});

test('可访问性：每处拖拽都有键盘等价（tabIndex + Alt+方向键）', () => {
  for (const f of ['src/views/shelf-view.ts', 'src/views/player-view.ts']) {
    const src = read(f);
    const drags = (src.match(/setAttribute\('draggable', 'true'\)/g) || []).length;
    if (!drags) continue;
    assert.match(src, /tabIndex = 0/, `${f} 有 ${drags} 处拖拽，但拖拽元素没有 tabIndex`);
    assert.match(src, /ev\.altKey/, `${f} 有 ${drags} 处拖拽，但没有 Alt+方向键的键盘等价`);
  }
});

test('可访问性：状态行都带 live 语义（role=status 与容器写在同处）', () => {
  // 判据：凡是建了一个 class 里带 status 的容器，同一处就要写 role: 'status'。
  // 比「按文件判定」严：同一文件里新加一个状态行而忘了 role，这条会点名它。
  const offenders = [];
  let live = 0;
  for (const f of tsFiles()) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /cls:\s*'[^']*status[^']*'/g;
    let m;
    while ((m = re.exec(src))) {
      const near = src.slice(Math.max(0, m.index - 120), m.index + 160);
      // vault 适配器那行（getAbstractFileByPath('status')）之类不算数：必须有 role / aria-live 才算
      if (/role:\s*'status'|aria-live/.test(near)) live++;
      else offenders.push(`${path.relative(root, f)}：${m[0]}`);
    }
  }
  // 探针：搜索 / 导入 / 本地导入 / 单删 / 批删 / 扫码 / 登录态 / 封面 / 恢复备份 / 批量已选
  assert.ok(live >= 6, `只扫到 ${live} 处 live 状态行，预期 ≥6（扫描逻辑可能已失效）`);
  assert.deepEqual(offenders, [], `这些状态行没有 live 语义：\n${offenders.join('\n')}`);
});

test('可访问性：当前播放项要标出来（aria-current）', () => {
  assert.match(read('src/views/player-view.ts'), /aria-current/, '队列当前行要标 aria-current');
  assert.match(read('src/views/album-picker.ts'), /aria-current/, '当前唱片要标 aria-current');
});

test('可访问性：菜单落点不能用鼠标事件坐标（键盘触发时 clientX/Y 为 0）', () => {
  // 去掉注释再看：实现处的注释会点名旧 API 说明为什么不能用它，那不是违规
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const src = strip(read('src/views/shelf-view.ts'));
  assert.doesNotMatch(
    src,
    /showAtMouseEvent/,
    '改用 showAtPosition(锚元素的矩形)：键盘与鼠标两条路径的落点才都对'
  );
  assert.match(src, /showAtPosition/, '菜单要用 showAtPosition 落位');
});

test('可访问性：卡片要有可聚焦的菜单入口（右键菜单曾是设置封面的唯一入口）', () => {
  const src = read('src/views/shelf-view.ts');
  assert.match(
    src,
    /card[\s\S]{0,600}aria-label[\s\S]{0,200}addEventListener\('click'/,
    '卡片内要有可聚焦的「⋯」按钮，右键菜单不能是唯一入口'
  );
  assert.match(
    src,
    /vinyl-shelf-card-menu[\s\S]{0,200}?aria-label/,
    '这枚按钮要有可读名称（不能只有一个图标）'
  );
  // 键盘用户在「无鼠标」时也要看得见它：不能 display:none 藏掉。
  // 2026-09-26：它此后**刻意退出 Tab 序**（menuBtn.tabIndex = -1，整墙只留一个 roving 停靠点），
  // 菜单的键盘入口改成卡片上的 Shift+F10 / 菜单键（见「专辑墙是方向键网格」一条）——
  // 这里只管「在 DOM 与可访问性树里、可读、聚焦时显形」，键盘可达性由那一条守。
  const css = read('styles.css');
  assert.match(css, /\.vinyl-shelf-card-menu \{[\s\S]{0,200}?opacity:\s*0/, '常态淡出');
  assert.match(
    css,
    /\.vinyl-shelf-card:focus-within \.vinyl-shelf-card-menu/,
    '键盘聚焦时要显形（只写 :hover 的话键盘用户永远看不到它）'
  );
});

test('可访问性：命令面板能触达只有鼠标路径的那些动作，旧命令 ID 冻结', () => {
  const src = read('src/main.ts');
  const cmds = read('src/core/commands.ts');
  // 命令表在 core/commands.ts（宿主中立），main.ts 只做接线 —— 两处一起看才完整
  assert.match(src, /for \(const cmd of COMMANDS\)/, 'main.ts 必须由命令表驱动注册');
  for (const id of ['open-shelf', 'open-player', 'import-netease', 'import-local',
                    'insert-now-playing', 'player-toggle', 'player-next', 'player-prev']) {
    assert.match(cmds, new RegExp(`id: '${id}'`), `命令 ID '${id}' 不能改（用户绑的快捷键会失效）`);
  }
  // 此前只有鼠标路径的五个动作，现在都要能从命令面板触达
  for (const id of ['append-listening-note', 'set-album-cover', 'open-album-in-source',
                    'import-local-to-current', 'queue-move-segment-up']) {
    assert.match(cmds, new RegExp(`'${id}'`), `${id} 必须可从命令面板触达`);
  }
  // 默认快捷键刻意不配（插件规范建议别设，键位交给用户在「设置 → 快捷键」里绑）。
  // 去注释再看：文件头会点名 keys?: KeyChord[] 说明为什么不留它，那不是违规
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /hotkeys:/, '不设默认快捷键');
  assert.doesNotMatch(strip(cmds), /\bkeys\s*[?:]/, '命令表里也不留 keys 字段');
});

test('可访问性：翻面时焦点跟着走（不能留在已经转到背面的元素上）', () => {
  const src = read('src/views/player-view.ts');
  assert.match(src, /private moveFocusAcrossFlip/, '翻面要有焦点转移');
  assert.match(
    src,
    /if \(!active \|\| !els\.flip\.contains\(active\)\) return;/,
    '只在焦点确实落在翻转区里时才搬（别抢用户点按钮后留在按钮上的焦点）'
  );
});

test('可访问性：统计页热力图是 roving tabindex（371 格不该各自是 Tab 停靠点）', () => {
  const src = read('src/views/stats-page.ts');
  assert.match(
    src,
    /cells\.forEach\(\(el, n\) => \(el\.tabIndex = n === at \? 0 : -1\)\)/,
    '整张图只留一个停靠点，其余 -1（53 周 × 7 天 = 371 个停靠点，Tab 一遍走不完）'
  );
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
    assert.match(src, new RegExp(`'${key}'`), `方向键 ${key} 要在格间走`);
  }
  assert.match(src, /ev\.stopPropagation\(\)/, '方向键处理完别漏给全局快捷键');
  assert.match(src, /this\.focusDay = key/, '选中后重绘要把焦点接回这一格');
});

test('可访问性：强制色彩与对比度偏好都有兜底（自绘 UI 在这两档下最容易糊）', () => {
  const css = read('styles.css');
  assert.match(css, /@media \(forced-colors: active\)/, '强制色彩要有一段专门规则');
  assert.match(
    css,
    /\.vinyl-volume-segment\.is-active[\s\S]{0,120}background:\s*Highlight/,
    '音量格子靠背景色区分亮暗：强制色彩下要给系统高亮色'
  );
  assert.match(
    css,
    /\.vinyl-stats-day:not\(\.is-level-0\):not\(\.is-future\)[\s\S]{0,80}Highlight/,
    '热力档位在强制色彩下退化成「有播放 / 没播放」两档'
  );
  assert.match(
    css,
    /\.vinyl-tutorial-ink[\s\S]{0,120}forced-color-adjust:\s*none/,
    '手绘装饰层不参与重着色（否则会变成实心块盖住按钮）'
  );
  assert.match(css, /@media \(prefers-contrast: more\)/, '对比度偏好要有一段专门规则');
  assert.match(
    css,
    /prefers-contrast: more[\s\S]{0,300}\.vinyl-muted[\s\S]{0,400}var\(--text-normal\)/,
    '弱化的灰字在对比度偏好下要拉回正文色'
  );
});

test('可访问性：截断文本的可读性靠 aria-label（title 在本仓库是禁用的）', () => {
  const view = read('src/views/player-view.ts');
  assert.match(
    view,
    /row\.setAttribute\('aria-label', track\.title\)/,
    '队列行用 aria-label 报完整曲名（截断只影响视觉）'
  );
  assert.doesNotMatch(view, /setAttribute\('title'/, '视图层不写 title：宿主气泡 + 原生气泡会叠两个');
  const shelf = read('src/views/shelf-view.ts');
  assert.match(
    shelf,
    /card\.setAttribute\('aria-label', album\.title\)/,
    '卡片同样用 aria-label 报完整专辑名'
  );
});

test('可访问性：专辑墙的数量是 live 区（搜完 / 筛完要报出「匹配 N 张」）', () => {
  const src = read('src/views/shelf-view.ts');
  assert.match(
    src,
    /cls: 'vinyl-shelf-heading-count',\n\s*attr: \{ role: 'status' \}/,
    '数量随搜索 / 筛选异步变化：标成 status 读屏才播报'
  );
});
