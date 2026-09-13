// 外观选项（播放器配色 / 唱片配色）回归：类名映射 + 脏 data.json 回落。
// 同 shelf-props.test.cjs 套路：esbuild 从真实 TS 编译进 node:vm（stub obsidian），不吃盘、不依赖 Obsidian。
// 本模块刻意不依赖 settings.ts，脚本测试才能只 bundle 这一小块。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  stdin: {
    contents: `export * from '../src/core/appearance';\n`,
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

test('播放器配色：两个方案、默认胡桃木，类名 is-deck-*', () => {
  assert.deepEqual(Array.from(mod.DECK_STYLES, (x) => x[0]), ['walnut', 'black']);
  assert.equal(mod.DEFAULT_DECK_STYLE, 'walnut');
  assert.equal(mod.deckClass('black'), 'is-deck-black');
  assert.equal(mod.deckClass('walnut'), 'is-deck-walnut');
  // 每个方案都有中文名（防新增方案忘配文案）
  for (const [v, label] of mod.DECK_STYLES) assert.ok(label && label !== v, `${v} 缺文案`);
});

test('唱片配色：四个方案、默认黑胶，类名 is-record-*', () => {
  assert.deepEqual(Array.from(mod.RECORD_COLORS, (x) => x[0]), ['black', 'yellow', 'blue', 'white']);
  assert.equal(mod.DEFAULT_RECORD_COLOR, 'black');
  assert.equal(mod.recordClass('white'), 'is-record-white');
  for (const [v, label] of mod.RECORD_COLORS) assert.ok(label && label !== v, `${v} 缺文案`);
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
  for (const [v] of mod.DECK_STYLES) {
    if (v === mod.DEFAULT_DECK_STYLE) continue; // 默认方案是 .vinyl-deck 本体，没有额外规则
    assert.ok(css.includes(`is-deck-${v}`), `styles.css 缺少 .is-deck-${v}`);
  }
  for (const [v] of mod.RECORD_COLORS) {
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
