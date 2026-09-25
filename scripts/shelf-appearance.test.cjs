// 专辑墙外观回归：黑胶动画方向（四方互为镜像）+ 每行卡片数 + applyAppearance 接线。
// A 部分解析 styles.css 真值（设置改方向时最容易改错的几何关系）；
// B 部分带假元素跑 shelf-view.applyAppearance（esbuild + vm，stub obsidian）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const CSS = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');

const source = esbuild.buildSync({
  stdin: {
    contents: `export * from '../src/views/shelf-view';\nexport * from '../src/views/player-view';\nexport * from '../src/core/disc-motion';\n`,
    resolveDir: __dirname,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian'],
}).outputFiles[0].text;

// —— 极简 CSS 块与变量提取 ——
/** 命中处是否在顶层：@container / @media 里还有同名规则（窄窗格让位那几条），
 *  朴素地取「第一个同名块」会静默比到嵌套的那一份。计数时跳过注释块，
 *  免得注释里出现的花括号把深度算歪。 */
function atTopLevel(css, index) {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (css.startsWith('/*', i)) {
      i = css.indexOf('*/', i + 2) + 1;
      continue;
    }
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
  }
  return depth === 0;
}

function cssBlock(css, selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{', 'g');
  let m;
  while ((m = re.exec(css))) {
    if (!atTopLevel(css, m.index)) continue;
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
  return null;
}

function cssVar(css, block, name) {
  const body = cssBlock(css, block);
  assert.ok(body, `styles.css 缺少规则 ${block}`);
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(body);
  assert.ok(m, `${block} 缺少 --${name}`);
  return m[1].trim();
}

// translate(x%, y%) 取数；rotate(deg) 取数
function tx(t) {
  const m = /translate\(\s*(-?[\d.]+)%\s*,\s*(-?[\d.]+)%/.exec(t);
  assert.ok(m, `transform 解析失败：${t}`);
  return [Number(m[1]), Number(m[2])];
}
function rot(t) {
  const m = /rotate\(\s*(-?[\d.]+)deg/.exec(t);
  return m ? Number(m[1]) : null;
}

const DIRS = ['right', 'left', 'up', 'down'];
const PHASES = ['rest', 'lift', 'off'];
// 方向块的变量表：右向在基础 .vinyl-shelf 里，其余在 .is-disc-*
const varsOf = (dir) => {
  const block = dir === 'right' ? '.vinyl-shelf' : `.vinyl-shelf.is-disc-${dir}`;
  const out = {};
  for (const p of PHASES) out[p] = cssVar(CSS, block, `vinyl-disc-${p}`);
  return out;
};

function makeStub() {
  const files = new Map();
  class TFile {}
  class ItemView {
    constructor() {
      this.contentEl = makeEl();
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: (name) => {
      if (name === 'obsidian') {
        return {
          App: class {},
          ItemView,
          Menu: class {},
          Modal: class {},
          FuzzySuggestModal: class {},
          Notice: class {},
          Plugin: class {},
          TFile,
          TFolder: class {},
          normalizePath: (p) => p,
          setIcon: () => {},
        };
      }
      return require(name);
    },
    console,
    Buffer,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  });
  return module.exports;
}

function makeEl() {
  const classes = new Set();
  const props = new Map();
  return {
    classes,
    props,
    toggleClass(name, on) {
      if (on) classes.add(name);
      else classes.delete(name);
    },
    style: { setProperty: (k, v) => props.set(k, v) },
  };
}

test('方向变量：四个方向都定义 rest/lift/off 三态', () => {
  for (const dir of DIRS) {
    const v = varsOf(dir);
    for (const p of PHASES) {
      assert.ok(v[p].length > 0, `${dir} 的 ${p} 为空`);
      assert.ok(tx(v[p]), `${dir} 的 ${p} 不是 translate 形式：${v[p]}`);
    }
  }
});

test('几何：向左 = 向右的 x 镜像（-100% - x），纵向不变', () => {
  const right = varsOf('right');
  const left = varsOf('left');
  for (const p of PHASES) {
    const [rx, ry] = tx(right[p]);
    const [lx, ly] = tx(left[p]);
    assert.equal(lx, -100 - rx, `${p}：向左 x 应为 -100 - (${rx})`);
    assert.equal(ly, ry, `${p}：向左不应改纵向位移`);
  }
  assert.equal(rot(left.rest), -rot(right.rest), '向左的倾斜角应取反');
});

test('几何：向上 / 向下 = 纵向镜像，横向居中在 -50%', () => {
  const down = varsOf('down');
  const up = varsOf('up');
  for (const p of PHASES) {
    const [dx, dy] = tx(down[p]);
    const [ux, uy] = tx(up[p]);
    assert.equal(dx, -50, `向下 ${p}：横向应居中`);
    assert.equal(ux, -50, `向上 ${p}：横向应居中`);
    assert.equal(uy, -100 - dy, `${p}：向上 y 应为 -100 - (${dy})`);
  }
});

test('几何：探出方向正确（右/左/下/上各自的常驻位探出封面该侧）', () => {
  // 唱片宽高 95%、贴 left/top 50%：translate 百分比相对唱片自身；
  // 常驻位探出量 ≈ 26%（探出侧），即中心偏移 ~0.285 个封面宽度。
  const out = (dir, axis) => {
    const [x, y] = tx(varsOf(dir).rest);
    return axis === 'x' ? x : y;
  };
  assert.ok(out('right', 'x') > -50, '右向：应偏右');
  assert.ok(out('left', 'x') < -50, '左向：应偏左');
  assert.ok(out('down', 'y') > -50, '向下：应偏下');
  assert.ok(out('up', 'y') < -50, '向上：应偏上');
});

test('一致性：CSS 基础值（右向）与 disc-motion.ts 兜底值一致', () => {
  const mod = makeStub();
  const right = varsOf('right');
  for (const p of PHASES) {
    assert.equal(mod.DISC_FALLBACK[p], right[p], `${p} 兜底值已与 styles.css 漂移`);
  }
  assert.deepEqual(Array.from(mod.DISC_DIRECTIONS), DIRS, '方向枚举应与 CSS 类名一致');
});

test('接线：applyAppearance 写方向类 + 列数变量 + 唱片配色类 + 工具栏位置类', () => {
  const mod = makeStub();
  const el = makeEl();
  const plugin = {
    settings: {
      discDirection: 'left',
      shelfColumns: 'auto',
      recordColor: 'yellow',
      toolbarPosition: 'bottom-right',
    },
  };
  const view = new mod.VinylShelfView({}, plugin);
  view.contentEl = el;

  view.applyAppearance();
  assert.deepEqual(Array.from(el.classes).sort(), [
    'is-disc-left',
    'is-record-yellow',
    'is-toolbar-bottom-right',
  ]);
  assert.equal(
    el.props.get('--vinyl-shelf-columns'),
    'repeat(auto-fill, minmax(min(230px, 100%), 1fr))'
  );

  plugin.settings.discDirection = 'up';
  plugin.settings.shelfColumns = 5;
  plugin.settings.toolbarPosition = 'top-left';
  view.applyAppearance();
  assert.deepEqual(
    Array.from(el.classes).sort(),
    ['is-disc-up', 'is-record-yellow', 'is-toolbar-top-left'],
    '换方向 / 换位置都应撤掉旧类'
  );
  assert.equal(el.props.get('--vinyl-shelf-columns'), mod.shelfColumnsTemplate(5));

  plugin.settings.discDirection = undefined; // 脏数据 → 回落到右向
  plugin.settings.recordColor = 'blue';
  plugin.settings.toolbarPosition = 'nonsense'; // 脏数据 → 回落到顶部居中
  view.applyAppearance();
  assert.deepEqual(
    Array.from(el.classes).sort(),
    ['is-disc-right', 'is-record-blue', 'is-toolbar-top-center'],
    '唱片配色即时切换；工具栏位置脏值回落默认'
  );
});

// 窄窗格：固定列数不能写成 repeat(N, minmax(0, 1fr)) —— 实测 200px 窗格里四列 =
// 4 条 0px 轨道，封面整块消失（用户报的「窗口很小的时候专辑墙上的内容会消失不见」）。
// 改成 auto-fill + 卡片下限：宽窗格与固定列数完全等价，窄了按装得下的张数让位。
test('窄窗格：固定列数按卡片下限逐级让位，不做 0 宽轨道', () => {
  const mod = makeStub();
  const auto = mod.shelfColumnsTemplate('auto');
  assert.match(auto, /min\(230px, 100%\)/, '自动档：轨道下限不超出窗格（窄窗格不横向溢出）');
  assert.doesNotMatch(auto, /minmax\(230px, 1fr\)/, '自动档不能写死 230px（窄窗格里会溢出）');

  for (const n of [2, 3, 5, 7]) {
    const tpl = mod.shelfColumnsTemplate(n);
    assert.doesNotMatch(tpl, /minmax\(0, 1fr\)/, `${n} 列不能用 0 下限：窄窗格里轨道会塌成 0`);
    assert.match(
      tpl,
      /^repeat\(auto-fill, minmax\(max\(var\(--vinyl-shelf-card-floor/,
      `${n} 列：轨道下限走样式表常量`
    );
    assert.ok(tpl.includes(`* ${n - 1}) / ${n})`), `${n} 列：按设置值算每张的宽度份额`);
  }
  assert.equal(mod.shelfColumnsTemplate(1), 'minmax(0, 1fr)', '单列没有列间距可算，直接铺满');
  assert.equal(mod.shelfColumnsTemplate(undefined), auto, '脏数据回落自动档');
  assert.equal(mod.shelfColumnsTemplate(0), auto, '0 / 空值回落自动档');

  // 常量归属：下限与列间距写在 styles.css，网格 gap 读同一个变量 —— calc 不会与真实间距漂开
  const grid = cssBlock(CSS, '.vinyl-shelf-grid');
  assert.match(grid, /--vinyl-shelf-col-gap:\s*42px/, '列间距常量在样式表里');
  assert.match(grid, /--vinyl-shelf-card-floor:\s*\d+px/, '卡片下限宽在样式表里');
  assert.match(grid, /gap:\s*28px var\(--vinyl-shelf-col-gap\)/, 'gap 与 calc 同源');
});

test('接线：播放器 applyAppearance 写转速变量', () => {
  const mod = makeStub();
  const plugin = { settings: { turntableSpeed: 'fast' } };
  const view = new mod.VinylPlayerView({}, plugin);
  const el = makeEl();
  view.contentEl = el;

  view.applyAppearance();
  assert.equal(el.props.get('--vinyl-spin-duration'), '1.2s');

  plugin.settings.turntableSpeed = 'slow';
  view.applyAppearance();
  assert.equal(el.props.get('--vinyl-spin-duration'), '2.6s');

  plugin.settings.turntableSpeed = 'bogus'; // 脏数据 → 标准
  view.applyAppearance();
  assert.equal(el.props.get('--vinyl-spin-duration'), '1.8s');
});

test('接线：播放器配色 + 唱片配色即时切换（两套互斥类）', () => {
  const mod = makeStub();
  const plugin = { settings: { turntableSpeed: 'normal', playerDeck: 'black', recordColor: 'white' } };
  const view = new mod.VinylPlayerView({}, plugin);
  const el = makeEl();
  view.contentEl = el;

  view.applyAppearance();
  assert.deepEqual(Array.from(el.classes).sort(), ['is-deck-black', 'is-record-white']);

  plugin.settings.playerDeck = 'walnut';
  plugin.settings.recordColor = 'blue';
  view.applyAppearance();
  assert.deepEqual(
    Array.from(el.classes).sort(),
    ['is-deck-walnut', 'is-record-blue'],
    '换配色应撤掉旧类（两套各自互斥）'
  );
});

test('一致性：转速表默认值与 CSS 兜底一致 + 转盘动画读变量', () => {
  const mod = makeStub();
  const body = cssBlock(CSS, '.vinyl-turntable-vinyl.is-spinning');
  assert.match(body, /animation:\s*vinyl-spin var\(--vinyl-spin-duration,\s*1\.8s\)/);
  assert.equal(mod.SPIN_SPEEDS.normal, '1.8s', '标准档应与 CSS 兜底一致');
  assert.ok(Number.parseFloat(mod.SPIN_SPEEDS.slow) > Number.parseFloat(mod.SPIN_SPEEDS.normal));
  assert.ok(Number.parseFloat(mod.SPIN_SPEEDS.fast) < Number.parseFloat(mod.SPIN_SPEEDS.normal));
});

test('CSS：卡片探出位随方向换边 + 网格列数读变量', () => {
  assert.match(cssBlock(CSS, '.vinyl-shelf-card'), /padding:\s*0 54px 0 0/, '默认（右）应在右侧留位');
  assert.match(cssBlock(CSS, '.vinyl-shelf.is-disc-left .vinyl-shelf-card'), /padding:\s*0 0 0 54px/);
  assert.match(cssBlock(CSS, '.vinyl-shelf.is-disc-up .vinyl-shelf-card'), /padding:\s*54px 0 0 0/);
  assert.match(cssBlock(CSS, '.vinyl-shelf.is-disc-down .vinyl-shelf-card'), /padding:\s*0 0 54px 0/);
  assert.match(
    cssBlock(CSS, '.vinyl-shelf-grid'),
    /grid-template-columns:\s*var\(--vinyl-shelf-columns/,
    '网格列数应读 --vinyl-shelf-columns'
  );
});
