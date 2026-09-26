// 专辑墙键盘网格（roving tabindex）回归：真类 + 假 DOM，卡片与网格由用例手工摆好。
//   · 走完整 render 需要一整套 vault / 索引桩，而这一批真正会错的是「哪张卡接得住这个键」：
//     行的切分（列数由 CSS 定，只有量 offsetTop 才准）、到边不吞键、末行不满时的落点、
//     光标卡被重画 / 离墙后停靠点还在不在。
//   · 「keydown 监听挂上了没有」是接线，由 a11y.test.cjs 的源码门禁守着（那边扫 onShelfKeydown）。
//   · 「⋯」按钮退出 Tab 序（menuBtn.tabIndex = -1）后，菜单必须有键盘入口 —— 就是这里的
//     Shift+F10 / 菜单键；这条对键盘用户是关键路径（设置封面 / 在源站打开只剩它）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const nodePath = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

// ============ 假 DOM：够键盘网格用（元素树 + dataset + offsetTop + focus / click 记账）============

function fakeEl(tag = 'div') {
  const el = {
    tag,
    children: [],
    classes: new Set(),
    attrs: new Map(),
    dataset: {},
    tabIndex: undefined,
    offsetTop: 0,
    style: { setProperty: () => {} },
    textContent: '',
    focused: 0,
    clicked: 0,
    addClass(...names) {
      for (const n of String(names.join(' ')).split(/\s+/).filter(Boolean)) el.classes.add(n);
      return el;
    },
    hasClass: (n) => el.classes.has(n),
    // shelfCardOf 只做鸭子类型判定：目标是不是一张卡片（这里目标就是卡片本身）
    closest(sel) {
      return sel === '.vinyl-shelf-card' && el.classes.has('vinyl-shelf-card') ? el : null;
    },
    focus() {
      el.focused++;
    },
    click() {
      el.clicked++;
    },
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 40, bottom: 40, width: 40, height: 40 }),
    empty() {
      el.children = [];
      return el;
    },
  };
  return el;
}

function loadModule(entry) {
  const source = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', entry)],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text;
  const mod = { exports: {} };
  vm.runInNewContext(source, {
    module: mod,
    exports: mod.exports,
    require: (name) => {
      if (name === 'obsidian') {
        return {
          App: class {},
          ItemView: class {},
          WorkspaceLeaf: class {},
          Menu: class {},
          Modal: class {},
          Notice: class {},
          FuzzySuggestModal: class {},
          Setting: class {},
          PluginSettingTab: class {},
          SettingPage: class {},
          TFile: class {},
          TFolder: class {},
          TAbstractFile: class {},
          setIcon: () => {},
          normalizePath: (p) => p,
        };
      }
      if (name === 'fs') return { existsSync: () => false, statSync: () => ({}), readdirSync: () => [] };
      if (name === 'path') return nodePath;
      throw new Error('Unexpected runtime import: ' + name);
    },
    fetch: async () => {
      throw new Error('no network in tests');
    },
    window: {
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => {},
      matchMedia: () => ({ matches: false }),
    },
    document: { hidden: false, body: fakeEl(), addEventListener() {}, removeEventListener() {} },
    AbortSignal,
    URL,
    URLSearchParams,
    Buffer,
    setTimeout,
    clearTimeout,
    console,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  });
  return mod.exports;
}

const { VinylShelfView } = loadModule('src/views/shelf-view.ts');

const plugin = {
  settings: { albumFolder: 'Vinyl Life/Vinyl Note', coverFolder: 'Covers', shelfProps: [] },
  app: { vault: { getMarkdownFiles: () => [] }, metadataCache: { getFileCache: () => null } },
};

/** 摆一面墙：rows = 每行几张（列数由 CSS 定，视图是按 offsetTop 量出来的）。
 *  卡片路径依次 A0…An，同一行的 offsetTop 相同（这正是视图切行的依据）。 */
function makeWall(rows) {
  const view = new VinylShelfView({}, plugin);
  view.gridEl = fakeEl('div');
  view.cardEls = new Map();
  view.entries = [];
  let n = 0;
  rows.forEach((count, r) => {
    for (let c = 0; c < count; c++) {
      const p = `Vinyl Life/Vinyl Note/A${n}.md`;
      const card = fakeEl('div');
      card.addClass('vinyl-shelf-card');
      card.dataset.path = p;
      card.offsetTop = r * 100;
      view.gridEl.children.push(card);
      view.cardEls.set(p, card);
      view.entries.push({
        album: { path: p, title: `专辑 ${n}` },
        local: false,
        netease: true,
        qq: false,
        kugou: false,
      });
      n++;
    }
  });
  view.syncRoving();
  return view;
}

const cards = (view) => view.gridEl.children;

/** 墙上那个唯一的 Tab 停靠点（顺带钉住「只能有一个」） */
function oneStop(view) {
  const stops = view.gridEl.children.filter((el) => el.tabIndex === 0);
  assert.equal(stops.length, 1, '整墙只能有一个 Tab 停靠点');
  return stops[0];
}

/** 按一个键（目标 = 那张卡片），返回两个「按键被吞掉了吗」的记账 */
function press(view, target, key, opts = {}) {
  const calls = { preventDefault: 0, stopPropagation: 0 };
  view.onShelfKeydown({
    key,
    shiftKey: !!opts.shiftKey,
    target,
    preventDefault: () => calls.preventDefault++,
    stopPropagation: () => calls.stopPropagation++,
  });
  return calls;
}

test('键盘网格：整墙只留一个 Tab 停靠点（默认首张），其余都是 -1', () => {
  const view = makeWall([4, 4, 2]);
  assert.equal(oneStop(view), cards(view)[0], '默认停在第一张');
  assert.equal(view.cardCursor, cards(view)[0].dataset.path, '光标与停靠点是同一张');
  assert.ok(
    cards(view).every((c) => c.tabIndex === 0 || c.tabIndex === -1),
    '卡片只该是 0 或 -1 两种取值'
  );
});

test('键盘网格：方向键在卡片间走，到边不吞键', () => {
  const view = makeWall([4, 4, 2]);
  const c = cards(view);

  // 行首往左：没有去处，别吞键（用户可能把 ← 绑到了别的命令上）
  const left = press(view, c[0], 'ArrowLeft');
  assert.equal(left.preventDefault, 0, '行首按 ← 没有去处：别吞键');
  assert.equal(left.stopPropagation, 0, '没处理就不该拦事件');
  assert.equal(oneStop(view), c[0], '没走动，停靠点不动');

  const right = press(view, c[0], 'ArrowRight');
  assert.equal(c[1].focused, 1, '→ 走到右边那张');
  assert.equal(right.preventDefault, 1, '走到位了才吞键');
  assert.equal(right.stopPropagation, 1, '方向键处理完别漏给全局快捷键（用户可能绑了别的命令）');
  assert.equal(c[0].tabIndex, -1, '停靠点跟着走');
  assert.equal(oneStop(view), c[1]);

  const down = press(view, c[1], 'ArrowDown');
  assert.equal(c[5].focused, 1, '↓ 走同一列（第 1 行第 2 列）');
  assert.equal(down.preventDefault, 1);

  const before = c[1].focused;
  const up = press(view, c[1], 'ArrowUp');
  assert.equal(up.preventDefault, 0, '顶行按 ↑ 没有去处');
  assert.equal(c[1].focused, before, '没有去处就不该动焦点');
});

test('键盘网格：末行不满时 ↓ 落在这一行最后一张，不掉出墙外', () => {
  const view = makeWall([4, 4, 2]);
  const c = cards(view);

  press(view, c[3], 'ArrowDown');
  assert.equal(c[7].focused, 1, '第 0 行第 4 列 → 第 1 行第 4 列');

  press(view, c[7], 'ArrowDown');
  assert.equal(c[9].focused, 1, '第 2 行只有 2 张：落点取这一行的最后一张');

  const end = press(view, c[9], 'ArrowDown');
  assert.equal(end.preventDefault, 0, '最后一行按 ↓ 没有去处');
});

test('键盘网格：Home / End 到首尾', () => {
  const view = makeWall([4, 4, 2]);
  const c = cards(view);

  press(view, c[5], 'End');
  assert.equal(c[9].focused, 1, 'End = 最后一张');
  assert.equal(c[9].tabIndex, 0, '停靠点一并跟过去');

  press(view, c[9], 'Home');
  assert.equal(c[0].focused, 1, 'Home = 第一张');
  assert.equal(c[0].tabIndex, 0);
});

test('键盘网格：焦点不在卡片上时，方向键一概不拦（搜索框 / 工具栏的键照常走）', () => {
  const view = makeWall([4, 4, 2]);
  const notACard = fakeEl('input'); // closest 返回 null
  const ev = press(view, notACard, 'ArrowRight');
  assert.equal(ev.preventDefault, 0);
  assert.equal(ev.stopPropagation, 0);
  assert.ok(cards(view).every((c) => c.focused === 0), '卡片一张都不该被碰到');
});

test('键盘网格：Shift+F10 / 菜单键开卡片菜单（「⋯」已退出 Tab 序，这是唯一键盘入口）', () => {
  const view = makeWall([4, 4, 2]);
  const opened = [];
  view.showMenu = (entry, pos) => opened.push({ path: entry.album.path, pos });
  const c = cards(view);

  const ev = press(view, c[2], 'F10', { shiftKey: true });
  assert.equal(opened.length, 1, 'Shift+F10 要开菜单');
  assert.equal(opened[0].path, c[2].dataset.path, '开的是这张卡的菜单');
  // 跨 realm 的对象不做 deepEqual（vm 里的 Object.prototype 不是这一个），逐字段看
  assert.equal(opened[0].pos.x, 0, '菜单横坐标按卡片左缘算');
  assert.equal(opened[0].pos.y, 40, '菜单纵坐标按卡片下缘算');
  assert.equal(ev.preventDefault, 1, 'Shift+F10 是宿主的快捷键位，要拦下');
  assert.equal(ev.stopPropagation, 1);

  press(view, c[0], 'ContextMenu');
  assert.equal(opened.length, 2, '菜单键同样开（标准「菜单按钮」模式）');

  press(view, c[0], 'F10');
  assert.equal(opened.length, 2, '光按 F10 不该开菜单（那是宿主的键）');
});

test('键盘网格：Enter / 空格 = 点击那张卡，且不漏给全局快捷键', () => {
  const view = makeWall([4, 4, 2]);
  const c = cards(view);

  const enter = press(view, c[3], 'Enter');
  assert.equal(c[3].clicked, 1, 'Enter 等价点击');
  assert.equal(enter.preventDefault, 1);
  assert.equal(enter.stopPropagation, 1, '用户把 Enter 绑到别的命令上时不该双触发');

  press(view, c[3], ' ');
  assert.equal(c[3].clicked, 2, '空格同样等价');

  press(view, cards(view)[3], 'Spacebar'); // 老写法（IE 时代的值）一并认
  assert.equal(c[3].clicked, 3);
});

test('键盘网格：光标卡被重画后停靠点补到新元素；离墙则回落到首张', () => {
  const view = makeWall([4, 4, 2]);
  const c = cards(view);
  press(view, c[2], 'ArrowRight'); // 光标挪到第 4 张
  const path = c[3].dataset.path;

  // 模拟 applyPlan 的 rebuild：同一个 path 换成新元素（buildCard 会带回默认的 tabIndex=-1），
  // 旧元素随 replaceWith 离墙、也不再被 cardEls 跟踪 —— 停靠点必须落到新元素上
  const fresh = fakeEl('div');
  fresh.addClass('vinyl-shelf-card');
  fresh.dataset.path = path;
  fresh.offsetTop = c[3].offsetTop;
  view.gridEl.children[3] = fresh;
  view.cardEls.set(path, fresh);
  view.syncRoving();
  assert.equal(fresh.tabIndex, 0, '停靠点认 path 不认元素：重画后要落在新元素上');
  assert.equal(oneStop(view), fresh, '整墙仍然只有一个停靠点');

  // 这张专辑离墙（被筛掉 / 删除）：停靠点回落到首张，而不是整墙一个都不剩
  view.cardEls.delete(path);
  view.gridEl.children.splice(3, 1);
  view.syncRoving();
  assert.equal(oneStop(view), cards(view)[0], '回落到首张');
});
