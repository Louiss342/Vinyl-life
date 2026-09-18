// 专辑墙工具栏回归（工具栏方案 2026-09-18），纯文本扫描，不需要 Obsidian：
//   A 样式真值（styles.css）：单行贴顶、无胶囊；搜索原位展开；选择模式换用途；浮层（陈列 / 添加）直角轻影；
//     勾选圈 / 空态出路 / 新卡片描边；
//   B 接线（shelf-view.ts 源码）：标题计数走手绘体、搜索行为（组词 / 失焦 / Esc / 回滚浏览位置）、
//     陈列浮层（来源 / 排列 / 显示 + 第二层属性）、添加浮层（AddPanel + 本地拖放）、更多菜单、
//     选择模式（scope 快照 / 全选 / 清空 / 删除禁用 / 卡片菜单进入）、浮层单开与关闭规则、教程圈「添加」。
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

test('样式：工具栏是「内容多长就多长」的紧凑浮卡（居中、毛玻璃、直角）', () => {
  const bar = rule(CSS, '.vinyl-shelf-toolbar');
  assert.match(bar, /flex-wrap:\s*nowrap/, '单行是硬约定（方案 §7：窄窗也不分两行）');
  assert.match(bar, /position:\s*sticky/, '滚动时钉在窗格顶部');
  assert.match(bar, /top:\s*10px/, '离窗格顶留一档（浮起来）');
  assert.match(bar, /width:\s*fit-content/, '宽度跟着内容走：中间不留空白（用户口径）');
  assert.match(bar, /max-width:\s*calc\(100% - 32px\)/, '窄窗格时给两侧留缝');
  // 摆位（align-self / order / top / bottom / 外侧留白）不在这条里 —— 归「工具栏位置」六档那组，
  // 默认那档（顶部居中）与它同值，读设置之前不跳（见上面那条位置用例）
  assert.doesNotMatch(bar, /align-self/, '基础规则只管长相，摆位归位置组');
  assert.match(bar, /border:\s*1px solid var\(--background-modifier-border\)/, '1px 发丝边');
  assert.match(bar, /border-radius:\s*0/, '直角（用户口径）');
  assert.match(bar, /box-shadow:[\s\S]{0,80}?0 4px 14px/, '轻投影（视觉上收着）');
  assert.match(bar, /backdrop-filter:\s*blur\(18px\)/, '毛玻璃：封面从卡片下滚过时被虚化');
  assert.match(bar, /background:\s*color-mix\(in srgb, var\(--background-primary\) 86%, transparent\)/, '半透明底（毛玻璃的另一半）');

  const shelf = rule(CSS, '.vinyl-shelf');
  assert.match(shelf, /container-type:\s*inline-size/, '窗格是容器查询的宿主（窄窗规则要用）');
});

test('样式：工具栏位置六档（顶部 / 底部 × 左 / 中 / 右），默认顶部居中', () => {
  // 没有任何位置类时也按「顶部居中」摆：设置读到之前不跳
  const base = rule(
    CSS,
    '.vinyl-shelf .vinyl-shelf-toolbar,\n.vinyl-shelf.is-toolbar-top-center .vinyl-shelf-toolbar'
  );
  assert.match(base, /align-self:\s*center/, '默认 = 顶部居中');
  assert.match(
    CSS,
    /\.vinyl-shelf\.is-toolbar-top-left \.vinyl-shelf-toolbar\s*\{[^}]*align-self:\s*flex-start/,
    '顶部左对齐'
  );
  assert.match(
    CSS,
    /\.vinyl-shelf\.is-toolbar-top-right \.vinyl-shelf-toolbar\s*\{[^}]*align-self:\s*flex-end/,
    '顶部右对齐'
  );
  // 底部三档：排到网格之后（order: 2）+ 钉在滚动视口底边（bottom），不再用 top
  const bottom = rule(
    CSS,
    '.vinyl-shelf.is-toolbar-bottom-left .vinyl-shelf-toolbar,\n.vinyl-shelf.is-toolbar-bottom-center .vinyl-shelf-toolbar,\n.vinyl-shelf.is-toolbar-bottom-right .vinyl-shelf-toolbar'
  );
  assert.match(bottom, /order:\s*2/, '排到网格之后');
  assert.match(bottom, /bottom:\s*10px/, '钉在窗格底边');
  assert.match(bottom, /top:\s*auto/, '撤掉顶部的 sticky 位');
  assert.match(
    CSS,
    /\.vinyl-shelf\.is-toolbar-bottom-left \.vinyl-shelf-toolbar\s*\{[^}]*align-self:\s*flex-start/,
    '底部左对齐'
  );
  assert.match(
    CSS,
    /\.vinyl-shelf\.is-toolbar-bottom-center \.vinyl-shelf-toolbar\s*\{[^}]*align-self:\s*center/,
    '底部居中'
  );
  assert.match(
    CSS,
    /\.vinyl-shelf\.is-toolbar-bottom-right \.vinyl-shelf-toolbar\s*\{[^}]*align-self:\s*flex-end/,
    '底部右对齐'
  );
});

test('接线：外观页新增「工具栏位置」下拉，六个档位与 CSS 类同名', () => {
  const SETTINGS = read('src/settings.ts');
  const APP = read('src/core/appearance.ts');
  assert.match(APP, /export const TOOLBAR_POSITIONS[\s\S]{0,240}?'top-left'/, '六档枚举');
  assert.match(APP, /export const DEFAULT_TOOLBAR_POSITION: ToolbarPosition = 'top-center'/, '默认顶部居中');
  assert.match(SETTINGS, /row\(body, t\('settings\.toolbarPosition'\)/, '外观页那一行');
  assert.match(
    SETTINGS,
    /for \(const key of TOOLBAR_POSITIONS\) d\.addOption\(key, t\(TOOLBAR_POS_KEYS\[key\]\)\)/,
    '六个选项'
  );
  // 键写成字面量（别现拼）：词典的「没有死键」自检才扫得到
  assert.match(SETTINGS, /'top-center': 'settings\.toolbarTopCenter'/, '键表是字面量');
  assert.match(
    SETTINGS,
    /p\.settings\.toolbarPosition = normalizeToolbarPosition\(v\);[\s\S]{0,80}?p\.refreshAppearance\(\)/,
    '改动即时广播给已打开的专辑墙'
  );
  assert.match(VIEW, /TOOLBAR_POSITIONS,[\s\S]{0,80}?toolbarPositionClass,/, '视图用同一份枚举');
  assert.match(
    VIEW,
    /for \(const v of TOOLBAR_POSITIONS\) c\.toggleClass\(toolbarPositionClass\(v\), v === pos\)/,
    'applyAppearance 写位置类（互斥切换）'
  );
  // 教程要躲开底部工具栏（那时它不是「上方」而是「下方」的遮挡）
  assert.match(VIEW, /const barAtBottom = isToolbarAtBottom\(/, '教程布局认底部分族');
  assert.match(
    VIEW,
    /if \(barAtBottom\) \{[\s\S]{0,160}?barTop - T\.main\.offsetHeight - 12/,
    '底部时整块收在工具栏上方'
  );
});

test('样式：工具栏按钮 = 收着的字形按钮（28px、无边框、悬停才给淡底）', () => {
  const chip = rule(CSS, '.vinyl-shelf-toolbar .vinyl-toolbar-icon,\n.vinyl-shelf-toolbar .vinyl-shelf-search-toggle');
  assert.match(chip, /width:\s*28px/, '28px（比常规 32 再收一号）');
  assert.match(chip, /border:\s*none/, '无边框：不跟卡片抢视线');
  assert.match(chip, /background:\s*transparent/, '常态透明');
  assert.match(chip, /color:\s*var\(--text-muted\)/, '图标弱化色');
  assert.match(
    CSS,
    /\.vinyl-shelf-toolbar \.vinyl-toolbar-icon:hover,[\s\S]{0,120}?background:\s*var\(--background-modifier-hover\)/,
    '悬停才给淡底'
  );
  assert.match(
    CSS,
    /\.vinyl-shelf-toolbar \.vinyl-toolbar-icon\.has-filter\s*\{[^}]*interactive-accent/,
    '筛了来源：挂来源名 + 强调色淡底'
  );
});

test('样式：窄窗一格一格让位（先省计数，再让搜索占用标题区）', () => {
  // 两条容器查询：460px 省计数、380px 搜索展开时藏标题
  const q460 = /@container \(max-width: 460px\) \{[\s\S]*?\.vinyl-shelf-heading-count\s*\{[^}]*display:\s*none/;
  assert.match(CSS, q460, '≤460px：先省计数');
  const q380 = /@container \(max-width: 380px\) \{[\s\S]*?\.vinyl-shelf-search\.is-open[\s\S]{0,80}?\.vinyl-shelf-heading\s*\{[^}]*display:\s*none/;
  assert.match(CSS, q380, '≤380px：搜索展开时输入框占用标题那一片');
});

test('样式：搜索原位展开（图标 ↔ 输入框），输入框宽度跟窗格走', () => {
  assert.match(
    CSS,
    /\.vinyl-shelf-search\.is-open \.vinyl-shelf-search-toggle\s*\{[^}]*display:\s*none/,
    '展开后图标让位'
  );
  assert.match(
    CSS,
    /\.vinyl-shelf-search-box\s*\{[^}]*display:\s*none/,
    '常态：输入框收起'
  );
  assert.match(
    CSS,
    /\.vinyl-shelf-search\.is-open \.vinyl-shelf-search-box\s*\{[^}]*display:\s*flex/,
    '展开才显示输入框（向左长出来，右侧按钮原地不动）'
  );
  assert.match(rule(CSS, '.vinyl-shelf-search-box input'), /clamp\(/, '宽度按窗格宽度自适应');
  assert.match(
    rule(CSS, '.vinyl-shelf-toolbar .vinyl-toolbar-icon,\n.vinyl-shelf-toolbar .vinyl-shelf-search-toggle'),
    /width:\s*28px/,
    '按钮收成 28px'
  );
});

test('样式：选择模式换用途（整条工具栏），不再是底部浮条', () => {
  const bar = rule(CSS, '.vinyl-shelf-toolbar.is-batch');
  assert.match(bar, /gap:/, '选择模式整条换用途（同一张紧凑卡）');
  assert.match(CSS, /\.vinyl-shelf-batch-info\s*\{[^}]*font-weight:\s*700/, '左：已选数量');
  assert.match(CSS, /\.vinyl-shelf-batch-actions\s*\{[^}]*flex:\s*none/, '右：动作组');
  assert.match(rule(CSS, '.vinyl-toolbar-textbtn'), /height:\s*28px/, '文本动作按钮 28px（与图标钮同档）');
  assert.match(rule(CSS, '.vinyl-toolbar-textbtn:disabled'), /opacity/, '不可用态有区分');
  assert.doesNotMatch(CSS, /vinyl-shelf-batchbar/, '底部动作条已删除（方案 §6）');
});

test('样式：选择模式的勾选圈（常态不显示 / 选中点亮）', () => {
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
});

test('样式：浮层（陈列 / 添加）直角、轻边框、短动效、限高滚动', () => {
  const panel = rule(CSS, '.vinyl-panel');
  assert.match(panel, /border-radius:\s*0/, '全直角');
  assert.match(panel, /border:\s*1px solid var\(--background-modifier-border\)/, '轻边框');
  assert.match(panel, /box-shadow:[\s\S]{0,60}?0 24px 60px/, '大而柔的投影');
  assert.match(panel, /animation:\s*vinyl-panel-in 0\.14s/, '短促动效（不弹跳）');
  assert.match(rule(CSS, '.vinyl-panel-body'), /overflow-y:\s*auto/, '内容超高在浮层内滚动');
  assert.match(
    CSS,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,200}?\.vinyl-panel\s*\{[^}]*animation:\s*none/,
    '减少动效：不做入场动画'
  );
});

test('样式：浮层学设置页的分区块（标题栏 + 图标芯片 + 行分隔线 / 悬停）', () => {
  const head = rule(CSS, '.vinyl-panel-head');
  assert.match(
    head,
    /background:\s*color-mix\(in srgb, var\(--background-secondary\) 86%, transparent\)/,
    '浅色标题栏（与设置页分区标题同款，毛玻璃半透明）'
  );
  assert.match(head, /border-bottom:\s*1px solid var\(--background-modifier-border\)/, '标题栏下一条发丝线');
  assert.match(head, /min-height:\s*44px/, '与设置页标题栏同一档高度');
  const icon = rule(CSS, '.vinyl-panel-icon');
  assert.match(icon, /width:\s*26px/, '26px 图标芯片（设置页那枚收一号）');
  assert.match(icon, /border:\s*1px solid var\(--background-modifier-border\)/, '芯片边框');
  assert.match(icon, /background:\s*var\(--background-primary\)/, '芯片浅底');

  const row = rule(CSS, '.vinyl-panel-row');
  assert.match(row, /border-top:\s*1px solid var\(--background-modifier-border\)/, '行与行之间发丝线');
  assert.match(row, /min-height:\s*42px/, '行高与设置行同档');
  assert.match(CSS, /\.vinyl-panel-row:hover\s*\{[^}]*background:\s*var\(--background-modifier-hover\)/, '悬停淡底');
  assert.match(
    CSS,
    /\.vinyl-panel-section \+ \.vinyl-panel-row\s*\{[^}]*border-top:\s*none/,
    '小节标题下面不画线（标题自己开一组）'
  );
  const seg = rule(CSS, '.vinyl-segment');
  assert.match(seg, /height:\s*30px/, '分段控件 30px');
  assert.match(CSS, /\.vinyl-segments\s*\{[^}]*border:\s*1px solid var\(--background-modifier-border\)/, '分段控件外框');
  assert.match(CSS, /\.vinyl-segment\.is-on\s*\{[^}]*interactive-accent/, '选中那一段才用强调色');
  // 「封面下的信息」：同一套行，但整行不是按钮 —— 右边一小枚按键可点（用户口径）
  assert.match(
    CSS,
    /\.vinyl-panel-value-btn\s*\{[^}]*border:\s*1px solid transparent/,
    '常态没有轮廓（与上面几行的值一样，只是弱化的值 + ›）'
  );
  assert.match(
    CSS,
    /\.vinyl-panel-value-btn:hover\s*\{[^}]*border-color:\s*var\(--background-modifier-border-hover\)/,
    '悬停才浮出按键的轮廓'
  );
  assert.match(CSS, /\.vinyl-panel-value-btn:focus-visible\s*\{/, '键盘走到它时有焦点圈');
  assert.match(
    CSS,
    /\.vinyl-panel-row\.is-static:hover\s*\{[^}]*background:\s*transparent/,
    '整行不可点：悬停不给反馈'
  );
  assert.match(
    VIEW,
    /const propsBtn = propsRow\.createEl\('button', \{ cls: 'vinyl-panel-value-btn' \}\)/,
    '可点的只有那一小枚按键'
  );
  assert.match(
    VIEW,
    /const propsRow = body\.createDiv\(\{ cls: 'vinyl-panel-row is-static' \}\)/,
    '行本身是普通行（不是按钮）'
  );
  assert.doesNotMatch(CSS, /vinyl-panel-props-row/, '整行按钮的样式已删除');
  // 苹果那种「右侧弱化值 + 上下箭头」的行
  assert.match(rule(CSS, '.vinyl-panel-value'), /text-align:\s*right/, '值右对齐');
  assert.match(rule(CSS, '.vinyl-panel-value'), /appearance:\s*none/, '值行不带宿主输入框的样子');
  assert.match(rule(CSS, '.vinyl-panel-row-chevron'), /pointer-events:\s*none/, '箭头不吃点击');
  assert.match(rule(CSS, '.vinyl-panel'), /backdrop-filter:\s*blur\(24px\)/, '浮层也是毛玻璃材质');
});

test('样式：本地导入层（添加浮层第二层）', () => {
  assert.match(
    CSS,
    /\.vinyl-panel \.vinyl-local-import\s*\{[^}]*min-width:\s*0/,
    '面板里不撑 320px 最小宽（弹窗里才需要）'
  );
  assert.match(rule(CSS, '.vinyl-local-layer .vinyl-import-section'), /padding:\s*0 14px/, '与设置行同一档内边距');
  // 操作区 / 状态行是这一层的直接子元素（不在 section 里）：也要同一档左缘，
  // 否则「开始导入」贴着浮层左缘、与上面的选择文件 / 目标 / 落库方式对不齐（用户反馈）。
  // 只认直接子元素：section 里那两行已经吃过 section 的内边距，再补一层会双双推到 29px（实测踩到）
  assert.match(
    rule(CSS, '.vinyl-local-import > .vinyl-import-actions'),
    /padding:\s*0 14px/,
    'section 之外的操作区同左缘'
  );
  assert.match(
    rule(CSS, '.vinyl-local-import > .vinyl-import-status'),
    /margin:\s*8px 14px 0/,
    '状态行同左缘'
  );
});

test('样式：来源分段 / 新卡片描边 / 空态出路', () => {
  assert.match(rule(CSS, '.vinyl-segment.is-on'), /interactive-accent/, '选中才用强调色');
  assert.match(
    CSS,
    /\.vinyl-add-local\.is-drag-over\s*\{[^}]*outline:\s*2px dashed var\(--interactive-accent\)/,
    '本地拖放区：拖进来时高亮'
  );
  assert.match(
    CSS,
    /\.vinyl-shelf-card\.is-just-added \.vinyl-shelf-cover[\s\S]{0,120}?animation:\s*vinyl-card-flash/,
    '新入库的卡片描边闪一下'
  );
  assert.match(rule(CSS, '.vinyl-shelf-empty-cta'), /margin-top/, '空态出路的按钮');
});

// ============ B. 接线（shelf-view.ts 源码） ============

test('接线：单行工具栏 —— 标题 + 计数（手绘体）+ 四枚图标钮，抽屉已删除', () => {
  assert.match(VIEW, /el\.createSpan\(\{ text: t\('shelf\.heading'\)/, '标题「我的唱片」');
  assert.match(
    VIEW,
    /text: filtered \? `\[\$\{this\.shownCount\}\/\$\{this\.entries\.length\}\]`/,
    '有筛选报「匹配/总数」'
  );
  assert.match(VIEW, /private syncHeading\(\)[\s\S]{0,400}?this\.shownCount/, '计数与网格共用同一个数（退出选择模式后重建工具栏也回填得上）');
  assert.match(
    CSS,
    /\.vinyl-shelf-heading-count\s*\{[^}]*font-family:\s*'Vinyl Hand'/,
    '计数走手绘体'
  );
  assert.match(VIEW, /mk\('search'|setIcon\(toggle, 'search'\)/, '搜索图标钮');
  assert.match(VIEW, /t\('toolbar\.display'\)/, '陈列入口');
  assert.match(VIEW, /t\('toolbar\.add'\)/, '添加入口');
  assert.match(VIEW, /t\('toolbar\.more'\)/, '更多入口');
  assert.doesNotMatch(VIEW, /drawerOpen|drawerForced|toolbarToggle|syncDrawer/, '抽屉交互整体删除');
  assert.doesNotMatch(VIEW, /vinyl-btn-wide|vinyl-shelf-toolbar-toggle/, '旧的把手 / 胶囊结构不再出现');
});

test('接线：搜索 —— 组词期间不筛、失焦收回、Esc 只退焦点、清空回滚浏览位置', () => {
  assert.match(VIEW, /compositionstart[\s\S]{0,120}?this\.composing = true/, '组词开始：挂起');
  assert.match(VIEW, /compositionend[\s\S]{0,120}?this\.composing = false;[\s\S]{0,60}?schedule\(0\)/, '组词结束：立即筛');
  assert.match(VIEW, /if \(this\.composing\) return;/, '组词中的 input 事件直接跳过');
  assert.match(
    VIEW,
    /input\.addEventListener\('blur', \(\) => \{[\s\S]{0,120}?if \(!input\.value\.trim\(\)\) this\.setSearchOpen\(false\)/,
    '无关键词失焦：收回图标'
  );
  assert.match(
    VIEW,
    /if \(ev\.key === 'Escape'\) \{[\s\S]{0,80}?input\.blur\(\);[\s\S]{0,40}?\}/,
    'Esc：只退焦点（不清条件）'
  );
  assert.match(VIEW, /this\.preSearchScroll = this\.contentEl\.scrollTop/, '进搜索前记住浏览位置');
  assert.match(VIEW, /else this\.contentEl\.scrollTop = this\.preSearchScroll/, '清空后回到那里');
  assert.match(VIEW, /\.addEventListener\('click', \(\) => \{\s*input\.value = '';/, '× 清空关键词');
});

test('接线：陈列浮层 —— 来源 / 依据 + 方向两个下拉 / 显示 + 第二层', () => {
  assert.match(VIEW, /body\.createDiv\(\{ text: t\('display\.source'\)/, '来源区');
  assert.match(VIEW, /for \(const \[key, label\] of filterOptions\(\)\)/, '来源芯片 = 现有五个筛选项');
  assert.match(VIEW, /this\.renderGrid\(\);\s*this\.contentEl\.scrollTop = 0;/, '换来源 / 排序：从结果顶部展示');
  assert.match(VIEW, /t\('display\.sortBy'\)/, '依据行');
  assert.match(VIEW, /t\('display\.dir'\)/, '方向行');
  assert.match(VIEW, /setSortBasis\(this\.state\.sort, v as SortBasis\)/, '换依据走 setSortBasis');
  assert.match(VIEW, /setCustomSortKey\(this\.state\.sort/, '自定义属性走 setCustomSortKey');
  assert.match(VIEW, /sortDirOptions\(this\.state\.sort\.basis\)/, '方向下拉文案跟依据走');
  assert.match(VIEW, /t\('display\.columns'\)[\s\S]{0,240}?SHELF_COLUMN_CHOICES/, '每行数量：自动 + 手动档');
  assert.match(VIEW, /private async applyShelfColumns[\s\S]{0,240}?this\.applyAppearance\(\)/, '列数即时预览（只换变量）');
  assert.match(VIEW, /t\('display\.props'\)/, '封面下的信息入口');
  assert.match(VIEW, /this\.displayLayer = 'props';/, '进第二层');
  assert.match(VIEW, /t\('display\.back'\)/, '第二层的「返回陈列」');
  assert.match(VIEW, /private renderPropsLayer[\s\S]{0,600}?this\.renderProps\(host\)/, '第二层画属性行');
});

test('接线：浮层单开、点外关闭、Esc 关闭且焦点回到入口', () => {
  assert.match(VIEW, /private openPanel\(kind: 'display' \| 'add', anchor: HTMLElement\)[\s\S]{0,80}?this\.closePanel\(\);/, '开新浮层先收旧的（同时最多一个）');
  assert.match(VIEW, /p\.el\.contains\(target\) \|\| p\.anchor\.contains\(target\)/, '点浮层内 / 点入口本身：不关');
  assert.match(VIEW, /document\.addEventListener\('pointerdown', this\.onPanelDocPointer, true\)/, '点外关闭走 pointerdown 捕获');
  assert.match(VIEW, /ev\.key !== 'Escape'[\s\S]{0,200}?anchorEl\?\.focus\(\)/, 'Esc 关闭后焦点还给入口');
  assert.match(VIEW, /private placePanel[\s\S]{0,1400}?pane\.left \+ 8/, '位置夹在专辑墙窗格内');
  // 宽度：优先收在窗格里，窗格太窄时保底一个可读下限（搜索结果「封面 + 标题 + 操作」三栏挤不下）
  assert.match(VIEW, /const preferred = kind === 'add' \? 440 : 340;/, '添加浮层比陈列宽一档');
  assert.match(VIEW, /const floor = kind === 'add' \? 340 : 260;/, '窄窗格时的可读下限');
  assert.match(
    VIEW,
    /const available = Math\.max\(pane\.width - 24, floor\);/,
    '窗格装不下就用下限（不跟着窗格一起缩没）'
  );
  assert.match(VIEW, /Math\.min\(preferred, available, win\.innerWidth - 24\)/, '再兜一道：不出窗口');
});

test('接线：后台刷新不关浮层（重建后把锚点换到新按钮上）', () => {
  assert.match(VIEW, /const keepPanel = this\.panel\?\.kind \?\? null;/, 'render 记住开着的浮层');
  assert.match(VIEW, /if \(keepPanel\) this\.reattachPanel\(keepPanel\);/, '重建后接回来');
  assert.match(
    VIEW,
    /private reattachPanel[\s\S]{0,420}?panel\.anchor = anchor;[\s\S]{0,120}?this\.placePanel\(panel\.el, anchor\)/,
    '锚点换成新按钮并重新摆位'
  );
  assert.doesNotMatch(
    VIEW,
    /render\(\) \{\s*\n\s*this\.loadEntries\(\);\s*\n\s*this\.closePanel\(\);/,
    '不再无条件关浮层（在添加面板里导入专辑会触发后台刷新）'
  );
});

test('接线：添加浮层两层 —— 在线搜索 + 本地导入（不再另开老弹窗）', () => {
  const ADD = read('src/views/add-panel.ts');
  assert.match(ADD, /new AlbumSearchPane\(ctx/, '第一层：复用搜索面板（与导入弹窗同一套机制）');
  assert.match(ADD, /withButton: false/, '面板里不需要搜索按钮（输入 / 回车即搜）');
  assert.match(ADD, /new LocalImportPane\(ctx, albums/, '第二层：本地导入用共用面板');
  assert.match(ADD, /t\('add\.localHint'\)/, '本地拖放区文案');
  assert.match(ADD, /t\('add\.chooseFiles'\)[\s\S]{0,200}?this\.showLayer\('local'\);[\s\S]{0,80}?pickFiles\(\)/, '「选择文件」切到本地层并弹选择器');
  assert.match(ADD, /collectDroppedFiles\(ev\.dataTransfer\)[\s\S]{0,300}?this\.showLayer\('local'\);[\s\S]{0,160}?takeFiles\(/, '拖进来的音频进本地层（选目标 / 落库方式都在那边）');
  assert.match(ADD, /t\('add\.back'\)/, '本地层标题栏有「返回添加」');
  assert.match(ADD, /t\('import\.localTitle'\)/, '本地层标题就是「导入本地音频」');
  assert.doesNotMatch(ADD, /openLocalImport/, '不再从浮层里开老的本机导入弹窗');
  assert.match(VIEW, /new AddPanel\(this\.plugin\.importCtx\(\), albums/, '视图挂载 AddPanel（带上本地导入的目标列表）');
  assert.match(VIEW, /onLocalDone: \(path\) => this\.flashAlbum\(path\)/, '本地入库后给新卡片描边');
  assert.match(VIEW, /tf\('shelf\.searchOnline', \{ q \}\)/, '空态：在线查找「词」');
  assert.match(VIEW, /private openAddPanelWith[\s\S]{0,220}?this\.addPanel\?\.prefill\(query\)/, '带入关键词立刻搜');
});

test('接线：本地导入面板与弹窗共用一份实现（弹窗只剩薄壳）', () => {
  const PANE = read('src/views/local-import-pane.ts');
  const MODAL = read('src/views/import-modal.ts');
  assert.match(PANE, /export class LocalImportPane/, '面板本体');
  assert.match(PANE, /t\('import\.step1'\)[\s\S]{0,4000}?t\('import\.step3'\)/, '三步流程都在面板里');
  assert.match(PANE, /this\.host\.onDone\(\{ imported: res\.added\.length, album, created \}\)/, '收尾交给宿主（弹窗关窗 / 浮层描边）');
  assert.match(PANE, /reset\(\): void \{[\s\S]{0,120}?this\.applyFiles\?\.\(\[\], ''\)/, '导完一批：清空已选，浮层接着导下一批');
  assert.match(MODAL, /new LocalImportPane\(ctx, albums, presetAlbum/, '弹窗用同一个面板');
  assert.match(MODAL, /onDone: \(\{ created, album \}\)[\s\S]{0,300}?openFile\(album\.file\)[\s\S]{0,60}?this\.close\(\)/, '弹窗路径：新建的专辑开笔记再关窗');
  assert.doesNotMatch(MODAL, /createDiv\(\{ cls: 'vinyl-import-section'/, '弹窗里不再自带一套表单');
});

test('接线：更多菜单 —— 选择专辑 / 刷新专辑墙（刷新保留筛选与陈列状态）', () => {
  assert.match(VIEW, /private showMoreMenu[\s\S]{0,400}?t\('more\.select'\)/, '选择专辑');
  assert.match(VIEW, /t\('more\.refresh'\)[\s\S]{0,160}?this\.render\(\)/, '刷新专辑墙（state 不动）');
  assert.doesNotMatch(VIEW, /t\('shelf\.refresh'\)/, '旧的刷新按钮不在工具栏');
  assert.doesNotMatch(VIEW, /showSortMenu|showFilterMenu|showCustomSortMenu/, '旧的排序 / 筛选菜单已进陈列浮层');
});

test('接线：选择模式 —— scope 快照、全选当前、清空、删除禁用、卡片菜单进入', () => {
  assert.match(VIEW, /const scope = this\.visiblePaths\(\);[\s\S]{0,120}?this\.batch = \{ active: true, selection: \[\], anchor: '', scope \}/, '进入时快照当前结果');
  assert.match(VIEW, /this\.batch\.scope = this\.batch\.scope\.filter\(\(p\) => alive\.has\(p\)\)/, '专辑被删时范围跟着收缩');
  assert.match(VIEW, /tf\('batch\.selectAll', \{ n: scope\.length \}\)/, '全选当前 N 张');
  assert.match(VIEW, /this\.batchAllBtn\.disabled = allPicked \|\| !scope\.length/, '都选上了就没有全选可点');
  assert.match(VIEW, /this\.batchDeleteBtn\.disabled = !this\.batch\.selection\.length/, '没选专辑删除不可用');
  assert.match(VIEW, /this\.batchClearBtn\.disabled = !this\.batch\.selection\.length/, '没选清空也不可用');
  assert.match(VIEW, /t\('menu\.selectMany'\)[\s\S]{0,260}?this\.batch\.selection = \[album\.path\]/, '卡片菜单「选择多张」自动选中这张');
  assert.match(VIEW, /if \(ev\.key === 'Escape' && this\.batch\.active\)/, 'Esc 退出选择模式');
  assert.match(VIEW, /bar\.toggleClass\('is-batch', this\.batch\.active\)/, '整条工具栏换用途');
  assert.match(
    VIEW,
    /private syncBatch\(\)[\s\S]{0,600}?if \(!active\) return;/,
    '退出模式：只还原卡片与整条工具栏，不再碰动作条元素'
  );
});

test('接线：空墙教程圈住「添加」按钮（两个导入按钮已合成一个入口）', () => {
  assert.match(VIEW, /const group = this\.addBtnEl;/, '虚线圈的目标 = 添加按钮');
  assert.doesNotMatch(VIEW, /importGroupEl/, '旧的导入组已删除（教程不再圈两个按钮）');
});

test('接线：教程箭头自适应 —— 按钮不在框右侧时改成竖箭头（不能整条消失）', () => {
  // 老画法只在「框右侧有横向净空」时成立（图纸里按钮在右上角）；工具栏改成紧凑浮卡后按钮常落在框上方 /
  // 下方，横向净空为负会把箭头整条判掉 —— 用户反馈「指向添加按钮的箭头没了」
  assert.match(
    VIEW,
    /const arrowTipX = Math\.round\(Math\.max\(box1Left \+ 30, Math\.min\(tip\.x, box1Right - 30\)\)\)/,
    '箭尾 x 跟着圈心走、夹在框内 30px'
  );
  assert.match(VIEW, /else if \(ringBottom < box1Top\) \{/, '圈在框上方 → 竖着往上指');
  assert.match(VIEW, /else if \(ringTop > box1Bottom\) \{/, '圈在框下方（工具栏摆底部那三档）→ 竖着往下指');
  assert.match(VIEW, /const up = \{ x: arrowTipX \+ 2, y: ringBottom \+ 1 \};/, '往上：箭尖压在圈底（与老画法同一口径）');
  assert.match(VIEW, /const down = \{ x: arrowTipX \+ 2, y: ringTop - 1 \};/, '往下：箭尖戳圈顶');
  assert.match(
    VIEW,
    /ringTop > box1Bottom \? ringTop - 1 : ringBottom \+ 1/,
    '老画法的箭尖也认上下（工具栏在右下角时从下方戳圈顶）'
  );
  const seeds = (VIEW.match(/TUT\.seed\.arrowBent/g) || []).length;
  assert.ok(seeds >= 3, '三种走法共用 arrowBent 那对种子（换布局时手绘抖动一致）');
});
