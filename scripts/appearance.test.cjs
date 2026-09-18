// 外观选项（播放器配色 / 唱片配色）回归：类名映射 + 脏 data.json 回落。
// 同 shelf-props.test.cjs 套路：esbuild 从真实 TS 编译进 node:vm（stub obsidian），不吃盘、不依赖 Obsidian。
// 本模块刻意不依赖 settings.ts，脚本测试才能只 bundle 这一小块。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  stdin: {
    // 一并导出 i18n：下面要查「配色显示名的词典键齐备」（文案归词典，这里只查键）
    contents: `export * from '../src/core/appearance';\nexport * as i18n from '../src/core/i18n';\n`,
    resolveDir: __dirname,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian'],
}).outputFiles[0].text;

const module_ = { exports: {} };
vm.runInNewContext(source, {
  module: module_,
  exports: module_.exports,
  require: () => ({}),
  console,
});
const mod = module_.exports;
const i18n = mod.i18n;

test('播放器配色：四个方案、默认胡桃木，类名 is-deck-*', () => {
  assert.deepEqual([...mod.DECK_STYLES], ['walnut', 'shell', 'black', 'coral']);
  assert.equal(mod.DEFAULT_DECK_STYLE, 'walnut');
  assert.equal(mod.deckClass('black'), 'is-deck-black');
  assert.equal(mod.deckClass('walnut'), 'is-deck-walnut');
  assert.equal(mod.deckClass('shell'), 'is-deck-shell');
  assert.equal(mod.deckClass('coral'), 'is-deck-coral');
  // 每个方案的显示名都在词典里（防新增方案忘配文案）——文案本身归 i18n，这里只查键
  for (const v of mod.DECK_STYLES) {
    const key = {
      walnut: 'settings.deckWalnut',
      shell: 'settings.deckShell',
      black: 'settings.deckBlack',
      coral: 'settings.deckCoral',
    }[v];
    assert.ok(i18n.DICT[key]?.zh && i18n.DICT[key]?.en, `${v} 缺词典文案（${key}）`);
  }
});

test('唱片配色：四个方案、默认黑胶，类名 is-record-*', () => {
  assert.deepEqual([...mod.RECORD_COLORS], ['black', 'yellow', 'blue', 'white']);
  assert.equal(mod.DEFAULT_RECORD_COLOR, 'black');
  assert.equal(mod.recordClass('white'), 'is-record-white');
  for (const v of mod.RECORD_COLORS) {
    const key = {
      black: 'settings.recordBlack',
      yellow: 'settings.recordYellow',
      blue: 'settings.recordBlue',
      white: 'settings.recordWhite',
    }[v];
    assert.ok(i18n.DICT[key]?.zh && i18n.DICT[key]?.en, `${v} 缺词典文案（${key}）`);
  }
});

test('工具栏位置：六档（顶部 / 底部 × 左 / 中 / 右），默认顶部居中', () => {
  assert.deepEqual(Array.from(mod.TOOLBAR_POSITIONS), [
    'top-left',
    'top-center',
    'top-right',
    'bottom-left',
    'bottom-center',
    'bottom-right',
  ]);
  assert.equal(mod.DEFAULT_TOOLBAR_POSITION, 'top-center');
  for (const v of Array.from(mod.TOOLBAR_POSITIONS)) {
    assert.equal(mod.normalizeToolbarPosition(v), v, `合法值原样通过：${v}`);
    assert.equal(mod.toolbarPositionClass(v), `is-toolbar-${v}`, '类名 = is-toolbar-<值>');
    assert.equal(
      mod.isToolbarAtBottom(v),
      String(v).startsWith('bottom'),
      `底部分族对不对：${v}`
    );
  }
  for (const raw of [undefined, null, '', 'left', 'bottom', 42, {}, 'top-middle']) {
    assert.equal(
      mod.normalizeToolbarPosition(raw),
      'top-center',
      `脏值回落默认：${String(raw)}`
    );
  }
});

test('归一化：脏值 / 旧值回落默认，合法值原样通过', () => {
  for (const raw of [undefined, null, '', 42, true, {}, 'follow', 'dark', 'sepia']) {
    assert.equal(mod.normalizeDeckStyle(raw), 'walnut', `deck raw=${String(raw)}`);
  }
  assert.equal(mod.normalizeDeckStyle('black'), 'black');

  for (const raw of [undefined, null, '', 0, [], 'purple', 'clear']) {
    assert.equal(mod.normalizeRecordColor(raw), 'black', `record raw=${String(raw)}`);
  }
  for (const v of ['yellow', 'blue', 'white']) assert.equal(mod.normalizeRecordColor(v), v);
});

test('类名与方案表同源：不会出现「设置里能选、样式里没有」的配色', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'styles.css'), 'utf8');
  for (const v of mod.DECK_STYLES) {
    if (v === mod.DEFAULT_DECK_STYLE) continue; // 默认方案是 .vinyl-deck 本体，没有额外规则
    assert.ok(css.includes(`is-deck-${v}`), `styles.css 缺少 .is-deck-${v}`);
  }
  for (const v of mod.RECORD_COLORS) {
    if (v === mod.DEFAULT_RECORD_COLOR) continue; // 默认配色写在基类上，没有额外规则
    assert.ok(css.includes(`is-record-${v}`), `styles.css 缺少 .is-record-${v}`);
  }
  // 每个唱片配色都要给全 5 个变量，否则会串色（例如白胶用了黑胶的纹路）
  const vars = [
    '--vinyl-record-base',
    '--vinyl-record-groove',
    '--vinyl-record-label',
    '--vinyl-record-edge',
    '--vinyl-record-hairline',
  ];
  const blocks = [css.slice(0, 0)]; // 占位，下一行才是默认块
  const defStart = css.indexOf('--vinyl-record-base:');
  blocks[0] = css.slice(defStart, css.indexOf('}', defStart));
  for (const v of ['yellow', 'blue', 'white']) {
    const start = css.indexOf(`is-record-${v}`);
    blocks.push(css.slice(start, css.indexOf('}', start)));
  }
  for (const block of blocks) {
    for (const name of vars) {
      assert.ok(block.includes(name), `配色块缺 ${name}：${block.slice(0, 40)}…`);
    }
  }
});
