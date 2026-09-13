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

test('接线：applyAppearance 写方向类 + 列数变量 + 唱片配色类', () => {
  const mod = makeStub();
  const el = makeEl();
  const plugin = { settings: { discDirection: 'left', shelfColumns: 'auto', recordColor: 'yellow' } };
  const view = new mod.VinylShelfView({}, plugin);
  view.contentEl = el;

  view.applyAppearance();
  assert.deepEqual(Array.from(el.classes).sort(), ['is-disc-left', 'is-record-yellow']);
  assert.equal(el.props.get('--vinyl-shelf-columns'), 'repeat(auto-fill, minmax(230px, 1fr))');

  plugin.settings.discDirection = 'up';
  plugin.settings.shelfColumns = 5;
  view.applyAppearance();
  assert.deepEqual(Array.from(el.classes).sort(), ['is-disc-up', 'is-record-yellow'], '换方向应撤掉旧类');
  assert.equal(el.props.get('--vinyl-shelf-columns'), 'repeat(5, minmax(0, 1fr))');

  plugin.settings.discDirection = undefined; // 脏数据 → 回落到右向
  plugin.settings.recordColor = 'blue';
  view.applyAppearance();
  assert.deepEqual(Array.from(el.classes).sort(), ['is-disc-right', 'is-record-blue'], '唱片配色应即时切换');
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
