// 唱片区（播放器页面 2 —— 三行唱片架）回归：
//   A 纯函数：轮转分栏 / 点击意图（换碟 or 多选）；选中的增删与连选在 multi-select.test.cjs
//     （那对原语已抽到 core/multi-select，与专辑墙「批量删除」共用）；
//   B 交互（真类 + 假 DOM）：点一张 = 换碟；Ctrl/⌘ 点 = 多选；Shift 点 = 连选；
//     多选后「加入队列」按点选顺序交给引擎；点箱子空白 / Esc 清空；Esc（无选中）返回；
//   C 接线与样式：立方体两面 / 悬停平放展开 / 视差 / 减少动效。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

// ============ 假 DOM：够 AlbumPicker 用（元素树 + 事件 + 选择器）============

function fakeEl(tag = 'div', parent = null) {
  const vars = new Map();
  const el = {
    tag,
    parent,
    children: [],
    attrs: new Map(),
    classes: new Set(),
    listeners: {},
    dataset: {},
    textContent: '',
    style: { setProperty: (k, v) => vars.set(k, v) },
    vars,
    setCssProps(props) {
      for (const [k, v] of Object.entries(props)) vars.set(k, v);
    },
    instanceOf: () => true,
    empty() {
      el.children = [];
    },
    addClass(...names) {
      for (const n of String(names.join(' ')).split(/\s+/).filter(Boolean)) el.classes.add(n);
    },
    removeClass(...names) {
      for (const n of String(names.join(' ')).split(/\s+/).filter(Boolean)) el.classes.delete(n);
    },
    hasClass: (n) => el.classes.has(n),
    toggleClass(name, on) {
      const want = on === undefined ? !el.classes.has(name) : !!on;
      if (want) el.classes.add(name);
      else el.classes.delete(name);
    },
    setAttribute(k, v) {
      el.attrs.set(k, String(v));
    },
    getAttribute(k) {
      return el.attrs.has(k) ? el.attrs.get(k) : null;
    },
    addEventListener(type, fn) {
      (el.listeners[type] = el.listeners[type] || []).push(fn);
    },
    fire(type, ev = {}) {
      for (const fn of el.listeners[type] || []) fn({ preventDefault() {}, stopPropagation() {}, ...ev });
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 300, right: 200, bottom: 300 }),
    createDiv(o) {
      return el.createEl('div', o);
    },
    createSpan(o) {
      return el.createEl('span', o);
    },
    createEl(t, o) {
      const child = fakeEl(typeof t === 'string' ? t : 'div', el);
      el.children.push(child);
      const opts = typeof o === 'string' ? { cls: o } : o || {};
      if (opts.cls) child.addClass(opts.cls);
      if (opts.text != null) child.textContent = String(opts.text);
      if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) child.setAttribute(k, v);
      return child;
    },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    querySelectorAll(sel) {
      const cls = sel.replace(/^\./, '');
      const out = [];
      const walk = (node) => {
        for (const c of node.children) {
          if (c.classes.has(cls)) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
    closest(sel) {
      const cls = sel.replace(/^\./, '');
      let node = el;
      while (node) {
        if (node.classes.has(cls)) return node;
        node = node.parent;
      }
      return null;
    },
  };
  el.classList = {
    toggle: (n, on) => el.toggleClass(n, on),
    add: (...n) => el.addClass(...n),
    remove: (...n) => el.removeClass(...n),
  };
  return el;
}

function loadPicker(globals = {}) {
  const source = esbuild.buildSync({
    stdin: {
      contents: `export * from '../src/views/album-picker';\nexport { setLanguage, t } from '../src/core/i18n';`,
      resolveDir: __dirname,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text;
  const mod = { exports: {} };
  // Obsidian 的全局 DOM 扩展（createDiv / createEl / createSpan）：挂在沙箱全局上
  const detached = () => fakeEl('div');
  const createEl = (tag, o) => detached().createEl(tag, o);
  vm.runInNewContext(source, {
    module: mod,
    exports: mod.exports,
    require: (name) => (name === 'obsidian' ? { setIcon: () => {} } : require(name)),
    createDiv: (o) => createEl('div', o),
    createSpan: (o) => createEl('span', o),
    createEl,
    HTMLElement: class {}, // Obsidian 的跨窗口安全判定：遍历祖先链前先看是不是元素
    console,
    Buffer,
    ...globals,
  });
  return mod.exports;
}

// vm 沙箱里的数组与测试进程不是同一个 realm：比较前搬回来（与其它用例同一套手法）
const arr = (v) => Array.from(v);

const pickerMod = loadPicker();
const { pickerRows, pickIntent, AlbumPicker, PICKER_ROWS, PICKER_COLUMNS } = pickerMod;

// ============ A. 纯函数 ============

test('pickerRows：每行 8 张，先填满上一行，不足时仍保留三行视窗', () => {
  const items = Array.from({ length: 18 }, (_, i) => i + 1);
  const rows = pickerRows(items);
  assert.equal(rows.length, PICKER_ROWS);
  assert.equal(PICKER_COLUMNS, 8);
  assert.deepEqual(arr(rows[0]), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(arr(rows[1]), [9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(arr(rows[2]), [17, 18]);
  assert.equal(rows.flat().length, items.length, '一张都不能少');
  assert.equal(JSON.stringify(pickerRows(['a'])), JSON.stringify([['a'], [], []]), '不足 24 张也保留三行');
  assert.equal(pickerRows(Array.from({ length: 25 }, (_, i) => i)).length, 4, '超过三行后自动增加第四行');
});

test('pickIntent：空手点 = 换碟；已有选中时空手点 = 切换；Ctrl/⌘ 切换；Shift 连选', () => {
  assert.equal(pickIntent({ ctrl: false, meta: false, shift: false }, false), 'switch');
  assert.equal(pickIntent({ ctrl: false, meta: false, shift: false }, true), 'toggle');
  assert.equal(pickIntent({ ctrl: true, meta: false, shift: false }, false), 'toggle');
  assert.equal(pickIntent({ ctrl: false, meta: true, shift: false }, false), 'toggle', 'macOS 的 ⌘ 同样算多选');
  assert.equal(pickIntent({ ctrl: false, meta: false, shift: true }, false), 'range');
  assert.equal(pickIntent({ ctrl: false, meta: true, shift: true }, true), 'range', 'Shift 优先');
});

test('pickIntent 与选中原语接线：选中增删走共享的 core/multi-select', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/views/album-picker.ts'), 'utf8');
  assert.match(src, /from '\.\.\/core\/multi-select'/, '别在本文件里再抄一份 toggleInList / rangeInList');
  assert.match(src, /this\.selection = toggleInList\(/, '多选切换要落到共享原语上');
  assert.match(src, /this\.selection = rangeInList\(/, 'Shift 连选要落到共享原语上');
});

// ============ B. 交互（真类 + 假 DOM）============

const album = (path, title) => ({ path, title, file: { path }, audioRefs: [], displayProps: {} });
const entry = (path, title, src = 'netease') => ({
  album: album(path, title),
  local: src === 'local',
  netease: src === 'netease',
  qq: src === 'qq',
});

function makePicker({ albums = [], current = null, queueMode = false } = {}) {
  const calls = { switchTo: [], enqueue: [], back: 0 };
  const deps = {
    app: {},
    load: () => albums,
    currentPath: () => (deps._current ? deps._current : undefined),
    switchTo: (a) => calls.switchTo.push(a.path),
    enqueue: (list) => calls.enqueue.push(Array.from(list, (a) => a.path)),
    back: () => calls.back++,
  };
  deps._current = current;
  if (queueMode) deps._queueMode = true;
  const picker = new AlbumPicker(deps);
  return { picker, calls, deps };
}

const tiles = (picker) => picker.el.querySelectorAll('.vinyl-pick');
const tileByPath = (picker, p) => tiles(picker).find((t) => t.dataset.path === p);
const clickOn = (picker, path, mod = {}) => {
  const ev = { targetNode: tileByPath(picker, path), ctrlKey: false, metaKey: false, shiftKey: false, ...mod };
  picker.crate.fire('click', ev);
};

test('渲染：三行摆开，按顺序先填满第一行；正在播放的那张有高亮类', () => {
  const albums = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n) => entry(`专辑/${n}.md`, n));
  const { picker } = makePicker({ albums, current: '专辑/C.md' });
  const rows = picker.el.querySelectorAll('.vinyl-picker-row');
  assert.equal(rows.length, 3, '三行');
  assert.deepEqual(
    rows.map((r) => r.children.length),
    [7, 0, 0],
    '顺序分行：7 张全在第一行'
  );
  assert.equal(tiles(picker).length, 7);
  assert.ok(tiles(picker).every((t) => t.getAttribute('aria-label')), '每张都有可读名称');
  assert.equal(tileByPath(picker, '专辑/C.md').hasClass('is-current'), true, '正在播放的那张有高亮');
  assert.equal(tileByPath(picker, '专辑/A.md').hasClass('is-current'), false);
  // 正在播放的排在最前（找起来顺手），行内顺序跟着走
  assert.equal(tiles(picker)[0].dataset.path, '专辑/C.md');
});

test('渲染：一张专辑都没有 → 给出去哪儿导入的提示，不画空箱子', () => {
  const { picker } = makePicker({ albums: [] });
  assert.equal(tiles(picker).length, 0);
  const empty = picker.el.querySelectorAll('.vinyl-picker-empty');
  assert.equal(empty.length, 1);
  assert.ok(empty[0].textContent.includes('专辑'), empty[0].textContent);
});

test('点一张 = 换碟（交给播放器的换碟路径，唱片区自己不碰引擎）', () => {
  const albums = [entry('专辑/A.md', 'A'), entry('专辑/B.md', 'B')];
  const { picker, calls } = makePicker({ albums });
  clickOn(picker, '专辑/B.md');
  assert.deepEqual(calls.switchTo, ['专辑/B.md']);
  assert.deepEqual(calls.enqueue, [], '没多选就不该排队');
  assert.equal(picker.hasSelection(), false);
});

test('Ctrl / ⌘ 点 = 多选：标记点亮、动作条出现、计数跟着走', () => {
  const albums = [entry('专辑/A.md', 'A'), entry('专辑/B.md', 'B'), entry('专辑/C.md', 'C')];
  const { picker, calls } = makePicker({ albums });
  const actions = picker.el.querySelectorAll('.vinyl-picker-actions')[0];
  assert.equal(actions.hasClass('is-on'), false, '没选中时动作条是收起的');

  clickOn(picker, '专辑/A.md', { ctrlKey: true });
  clickOn(picker, '专辑/C.md', { metaKey: true });
  assert.equal(picker.hasSelection(), true);
  assert.equal(tileByPath(picker, '专辑/A.md').hasClass('is-selected'), true);
  assert.equal(tileByPath(picker, '专辑/C.md').hasClass('is-selected'), true);
  assert.equal(tileByPath(picker, '专辑/B.md').hasClass('is-selected'), false);
  assert.equal(actions.hasClass('is-on'), true, '有选中就露出动作条');
  assert.equal(picker.el.querySelectorAll('.vinyl-picker-count')[0].textContent, '已选 2 张');
  assert.deepEqual(calls.switchTo, [], '多选时不换碟');

  clickOn(picker, '专辑/A.md', { ctrlKey: true }); // 再点一次取消
  assert.equal(tileByPath(picker, '专辑/A.md').hasClass('is-selected'), false);
  assert.equal(picker.el.querySelectorAll('.vinyl-picker-count')[0].textContent, '已选 1 张');
});

test('已经在多选时，空手点 = 继续选（不会误换碟）', () => {
  const albums = [entry('专辑/A.md', 'A'), entry('专辑/B.md', 'B')];
  const { picker, calls } = makePicker({ albums });
  clickOn(picker, '专辑/A.md', { ctrlKey: true });
  clickOn(picker, '专辑/B.md'); // 空手
  assert.deepEqual(calls.switchTo, [], '不换碟');
  assert.equal(tileByPath(picker, '专辑/B.md').hasClass('is-selected'), true);
});

test('Shift 点 = 连选一段（从上一个点到这一个）', () => {
  const albums = ['A', 'B', 'C', 'D'].map((n) => entry(`专辑/${n}.md`, n));
  const { picker } = makePicker({ albums });
  clickOn(picker, '专辑/B.md', { ctrlKey: true });
  clickOn(picker, '专辑/D.md', { shiftKey: true });
  const selected = tiles(picker).filter((t) => t.hasClass('is-selected')).map((t) => t.dataset.path);
  assert.deepEqual(selected.sort(), ['专辑/B.md', '专辑/C.md', '专辑/D.md']);
});

test('加入队列：按点选顺序把专辑交给引擎，交完清空选择', () => {
  const albums = [entry('专辑/A.md', 'A'), entry('专辑/B.md', 'B'), entry('专辑/C.md', 'C')];
  const { picker, calls } = makePicker({ albums });
  clickOn(picker, '专辑/C.md', { ctrlKey: true });
  clickOn(picker, '专辑/A.md', { ctrlKey: true });
  const enqueueBtn = picker.el.querySelectorAll('.vinyl-picker-actions')[0].children.find((c) => c.tag === 'button');
  enqueueBtn.fire('click');
  assert.deepEqual(calls.enqueue, [['专辑/C.md', '专辑/A.md']], '点选顺序 = 排队顺序');
  assert.equal(picker.hasSelection(), false, '交完就清空');
  assert.equal(picker.el.querySelectorAll('.vinyl-picker-actions')[0].hasClass('is-on'), false);
});

test('点箱子空白 = 取消选择；Esc 有选中先清空，没选中才返回播放器', () => {
  const albums = [entry('专辑/A.md', 'A'), entry('专辑/B.md', 'B')];
  const { picker, calls } = makePicker({ albums });
  clickOn(picker, '专辑/A.md', { ctrlKey: true });
  picker.crate.fire('click', { targetNode: picker.crate });
  assert.equal(picker.hasSelection(), false, '点空白清空选择');
  assert.deepEqual(calls.switchTo, [], '点空白不是换碟');

  picker.crate.fire('keydown', { key: 'Escape' });
  assert.equal(calls.back, 1, '没选中时 Esc = 返回播放器');

  clickOn(picker, '专辑/B.md', { ctrlKey: true });
  picker.crate.fire('keydown', { key: 'Escape' });
  assert.equal(picker.hasSelection(), false, '有选中时 Esc 只清空');
  assert.equal(calls.back, 1, '不该顺手返回');

  // Shift+Enter = 键盘上的多选（原生 Enter / 空格仍走「换碟」）
  picker.crate.fire('keydown', { key: 'Enter', shiftKey: true, target: tileByPath(picker, '专辑/A.md') });
  assert.equal(picker.hasSelection(), true, 'Shift+Enter 选中');
});

test('语言切换：只就地更新计数与唱片可读名，不重建唱片架', () => {
  const albums = [entry('专辑/A.md', 'A')];
  const { picker } = makePicker({ albums });
  const tileBefore = tiles(picker)[0];
  assert.equal(picker.el.querySelectorAll('.vinyl-picker-bar').length, 0, '纯唱片架不再渲染返回键、标题和提示');
  pickerMod.setLanguage('en');
  picker.applyLabels();
  assert.ok(tiles(picker)[0].getAttribute('aria-label').includes('Click to switch'));
  assert.equal(tiles(picker)[0], tileBefore, '唱片节点没被重建');
  pickerMod.setLanguage('zh');
  picker.applyLabels();
  assert.ok(tiles(picker)[0].getAttribute('aria-label').includes('点击换碟'));
});

// ============ C. 接线与样式（源码 / 样式表级）============

test('播放器：翻转区两面 + 选取专辑翻面（只有②③卡片转，其他不动）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/views/player-view.ts'), 'utf8');
  assert.match(src, /vinyl-flip-inner[\s\S]{0,200}?vinyl-flip-face is-deck[\s\S]{0,120}?vinyl-flip-face is-crate/, '两面挂在同一个翻转区里');
  assert.match(src, /pickBtn\.addEventListener\('click', \(\) => this\.flipTo\(this\.face === 'picker' \? 'player' : 'picker'\)\)/, '「选取专辑」= 翻转区的开关（再点转回来）');
  assert.match(src, /flipTo\('player'\)[\s\S]{0,400}?loadAlbum\(album\)/, '点专辑 = 先转回唱机卡再换碟');
  assert.match(src, /els\.flip\.toggleClass\('is-crate'/, '翻面只切类（不重建 DOM）');
  assert.match(src, /new AlbumPicker\(\{[\s\S]{0,600}?enqueue: \(albums\)/, '唱片区与播放器接线（换碟 / 批量排队 / 返回）');
  assert.match(src, /if \(!on\) this\.plugin\.engine\.retainCurrentAlbum\(\)/, '关闭队列模式时只保留当前专辑');
  const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
  assert.match(css, /\.vinyl-flip\s*\{[^}]*perspective:/, '翻转区要有透视');
  assert.match(css, /\.vinyl-flip-inner\s*\{[^}]*preserve-3d/, '两面在 3D 空间里');
  assert.match(css, /\.vinyl-flip\.is-crate \.vinyl-flip-inner\s*\{[^}]*rotateY\(-90deg\)/, '左转 90°（负角 = 卡片摆向左侧）');
  assert.match(css, /\.vinyl-flip-face\.is-crate\s*\{[^}]*rotateY\(90deg\) translateZ/, '唱片区是翻转区的背面');
  // 「其他不要变」：按键卡与队列建在板上（翻转区之外），翻面时纹丝不动
  assert.match(src, /const header = board\.createDiv\(\{ cls: 'vinyl-player-header' \}\)/, '按键卡不参与翻面');
  assert.match(src, /const queueBox = board\.createDiv\(\{ cls: 'vinyl-queue' \}\)/, '队列不参与翻面');
});

test('视差：只移动鼠标所在行，第一行交互不再带动下方专辑', () => {
  const albums = Array.from({ length: 17 }, (_, i) => entry(`专辑/${i}.md`, String(i)));
  const { picker } = makePicker({ albums });
  const rows = picker.el.querySelectorAll('.vinyl-picker-row');
  picker.crate.fire('pointermove', { clientX: 180, targetNode: rows[0].children[0] });
  assert.notEqual(rows[0].vars.get('--vinyl-parallax'), '0px', '当前行保留视差');
  assert.equal(rows[1].vars.get('--vinyl-parallax'), undefined, '第二行不被带动');
  assert.equal(rows[2].vars.get('--vinyl-parallax'), undefined, '第三行不被带动');

  picker.crate.fire('pointermove', { clientX: 20, targetNode: rows[1].children[0] });
  assert.equal(rows[0].vars.get('--vinyl-parallax'), '0px', '换行时上一行复位');
  assert.notEqual(rows[1].vars.get('--vinyl-parallax'), '0px', '新行接管视差');
});

test('样式：恢复原来的窄侧脊 → 悬停展开封面，保留纵向视窗与行视差', () => {
  const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
  assert.match(css, /\.vinyl-picker-row\s*\{[^}]*display:\s*flex/, '唱片仍是原来的横向侧脊队列');
  assert.match(css, /\.vinyl-picker-crate\s*\{[^}]*overflow-y:\s*auto/, '唱片架纵向滚动');
  assert.match(css, /\.vinyl-pick\s*\{[^}]*border-radius:\s*3px/, '恢复原来的封面圆角');
  assert.match(css, /\.vinyl-pick\s*\{[^}]*width:\s*24px[^}]*height:\s*var\(--vinyl-pick-h/, '默认是原来的窄侧脊');
  assert.match(css, /\.vinyl-pick:hover,[\s\S]{0,120}?\.vinyl-pick:focus-visible\s*\{[^}]*width:\s*var\(--vinyl-pick-h/, '悬停展开成完整封面');
  assert.match(
    css,
    /\.vinyl-picker-row:has\(> \.vinyl-pick:nth-child\(n \+ 5\):(?:hover|focus-visible)\)[\s\S]{0,180}?--vinyl-hover-shift:\s*calc\(24px - var\(--vinyl-pick-h, 108px\)\)/,
    '右半区悬停时整行等量左移，让前面的唱片产生被推开的动画'
  );
  assert.match(
    css,
    /\.vinyl-picker-row\s*\{[^}]*transform:\s*translateX\(calc\([^;]*--vinyl-hover-shift/,
    '右半区的补偿位移要与原有行视差合成'
  );
  assert.doesNotMatch(css, /\.vinyl-pick:nth-child\(n \+ 5\)[\s\S]{0,160}?margin-left:/, '不能再用不参与推挤的负外边距覆盖邻居');
  assert.match(css, /\.vinyl-pick\s*\{[^}]*transform-origin:\s*50% 100%/, '绕底边放倒');
  assert.match(css, /\.vinyl-pick:hover[\s\S]{0,220}?rotateX\(-8deg\)/, '保留原有放倒的 3D 视觉');
  assert.match(css, /\.vinyl-picker-row\s*\{[^}]*translateX\(calc\(var\(--vinyl-parallax[^)]*\)\s*\*\s*var\(--vinyl-row-k/, '保留每行不同深度的视差');
  const src = fs.readFileSync(path.join(__dirname, '../src/views/album-picker.ts'), 'utf8');
  assert.match(src, /--vinyl-parallax/, '鼠标位置仍会写入视差变量');
  assert.match(src, /--vinyl-row-k/, '行深度系数保留');
});

test('样式：减少动效时翻面直接切、悬停不倾斜、视差不追手', () => {
  const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
  const block = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(block, /\.vinyl-flip-inner\s*\{[^}]*transition:\s*none/, '翻面不做动画');
  assert.match(block, /\.vinyl-pick:hover,[\s\S]{0,80}?\{[^}]*transform:\s*none/, '悬停不倾斜');
  assert.match(block, /\.vinyl-picker-row\s*\{[^}]*transform:\s*none/, '减少动效时关闭行视差');
  // JS 侧：翻面时也读一次偏好（CSS 类 + prefersReducedMotion）
  const src = fs.readFileSync(path.join(__dirname, '../src/views/player-view.ts'), 'utf8');
  assert.match(src, /is-reduced', prefersReducedMotion\(\)/, '视图侧同样判断减少动效');
});

test('Esc：箱内由唱片区处理（并阻止冒泡），箱外由视图兜底，一次手势只做一件事', () => {
  const pickerSrc = fs.readFileSync(path.join(__dirname, '../src/views/album-picker.ts'), 'utf8');
  assert.match(pickerSrc, /if \(ev\.key === 'Escape'\)[\s\S]{0,200}?ev\.stopPropagation\(\)/, '唱片区处理 Esc 后要阻止冒泡');
  const viewSrc = fs.readFileSync(path.join(__dirname, '../src/views/player-view.ts'), 'utf8');
  assert.match(viewSrc, /registerDomEvent\(this\.contentEl, 'keydown', \(ev\) => this\.onEscape\(ev\)\)/, '视图要挂 Esc（焦点不在箱里时也管用）');
  assert.match(
    viewSrc,
    /private onEscape\([\s\S]{0,600}?clearSelection\(\)[\s\S]{0,200}?flipTo\('player'\)/,
    '有选中先清空、没选中才翻回页面 1'
  );
});

test('可访问性：唱片是按钮、可聚焦、有焦点圈；滚轮保持原生纵向翻架', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/views/album-picker.ts'), 'utf8');
  assert.match(src, /createEl\('button', \{ cls: 'vinyl-pick' \}\)/, '唱片用真按钮（Tab 可达、回车 / 空格即点击）');
  assert.doesNotMatch(src, /addEventListener\(\s*'wheel'/, '不拦截滚轮，交给纵向容器');
  const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
  assert.match(css, /\.vinyl-pick:focus-visible/, '唱片的焦点圈');
  assert.match(css, /\.vinyl-queue-segment-note:focus-visible/, '写感想按钮的焦点圈');
});
