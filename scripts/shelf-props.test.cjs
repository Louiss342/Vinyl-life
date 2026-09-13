// 卡片属性回归：黑名单 / 值格式化 / 旧设置迁移 / 有序变更 / 属性发现 / 卡片采集。
// esbuild 从真实 TS 编译进 node:vm（stub obsidian），不改 vault、不依赖 Obsidian 运行。
// 注意：不要 import settings.ts（会拉起登录弹窗整条依赖链）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  stdin: {
    contents: `export * from '../src/core/shelf-props';\nexport * from '../src/core/album-index';\n`,
    resolveDir: __dirname,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian'],
}).outputFiles[0].text;

function makeStub() {
  class TFile {}
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: (name) => {
      if (name === 'obsidian') {
        return {
          App: class {},
          Notice: class {},
          Plugin: class {},
          TFile,
          TFolder: class {},
          normalizePath: (p) => p,
        };
      }
      return require(name);
    },
    console,
    Buffer,
  });
  return module.exports;
}

const mod = makeStub();
const DEFAULTS = ['artist', 'year', 'genre', 'rating'];

// ============ 设置迁移 / 归一化 ============

test('normalizeShelfProps：全新安装（undefined）→ 默认 4 键', () => {
  assert.deepEqual(Array.from(mod.normalizeShelfProps(undefined)), DEFAULTS);
});

test('normalizeShelfProps：真实 data.json 旧结构快照 → 用户关掉的 rating 保持关闭', () => {
  const old = { artist: true, year: true, genre: true, rating: false };
  assert.deepEqual(Array.from(mod.normalizeShelfProps(old)), ['artist', 'year', 'genre']);
});

test('normalizeShelfProps：旧结构全 false → []（不得回落默认）', () => {
  const old = { artist: false, year: false, genre: false, rating: false };
  assert.deepEqual(Array.from(mod.normalizeShelfProps(old)), []);
});

test('normalizeShelfProps：新数组 [] → []（用户显式全关）', () => {
  assert.deepEqual(Array.from(mod.normalizeShelfProps([])), []);
});

test('normalizeShelfProps：脏数组 → trim + 黑名单过滤 + 稳定去重保序', () => {
  const raw = ['artist', 'artist', 'tags', 'cover', 'netease', '', ' year ', 42, null, 'artist'];
  assert.deepEqual(Array.from(mod.normalizeShelfProps(raw)), ['artist', 'year']);
});

test('normalizeShelfProps：脏类型 → 默认 4 键', () => {
  for (const raw of ['artist', 42, true, null, undefined]) {
    assert.deepEqual(Array.from(mod.normalizeShelfProps(raw)), DEFAULTS, `raw=${String(raw)}`);
  }
});

test('normalizeShelfProps：返回值与 DEFAULT_SHELF_PROPS 不共享引用', () => {
  const out = mod.normalizeShelfProps(undefined);
  assert.notEqual(out, mod.DEFAULT_SHELF_PROPS);
  out.push('label');
  assert.deepEqual(Array.from(mod.DEFAULT_SHELF_PROPS), DEFAULTS, '默认值被就地改写');
});

test('normalizeShelfPropLabels：非 string / 空串 / 与预设同名 → 丢弃，自定义保留', () => {
  const raw = {
    artist: '艺术家', // 与预设别名相同 → 丢弃（保持 data.json 干净）
    label: '  唱片公司  ', // trim 后保留
    year: 1969, // 非 string → 丢弃
    genre: '', // 空 → 丢弃
    country: '   ', // 空白 → 丢弃
  };
  assert.deepEqual({ ...mod.normalizeShelfPropLabels(raw) }, { label: '唱片公司' });
  assert.deepEqual({ ...mod.normalizeShelfPropLabels(null) }, {});
  assert.deepEqual({ ...mod.normalizeShelfPropLabels('x') }, {});
});

// ============ 有序变更 ============

test('toggleShelfProp：新键追加末尾；取消则移除；原数组与默认值均不被改动', () => {
  const cur = ['artist'];
  const added = mod.toggleShelfProp(cur, 'rating', true);
  assert.deepEqual(Array.from(added), ['artist', 'rating']);
  assert.deepEqual(cur, ['artist'], '原数组被就地改写');

  const noop = mod.toggleShelfProp(cur, 'artist', true);
  assert.deepEqual(Array.from(noop), ['artist']);

  const removed = mod.toggleShelfProp(['artist', 'rating'], 'artist', false);
  assert.deepEqual(Array.from(removed), ['rating']);

  mod.toggleShelfProp(mod.DEFAULT_SHELF_PROPS, 'label', true);
  assert.deepEqual(Array.from(mod.DEFAULT_SHELF_PROPS), DEFAULTS, 'DEFAULT_SHELF_PROPS 被就地改写');
});

test('reorderShelfProp：移到任意位 / 越界 clamp / 返回新数组', () => {
  const cur = ['artist', 'year', 'genre'];
  assert.deepEqual(Array.from(mod.reorderShelfProp(cur, 'year', 0)), ['year', 'artist', 'genre']);
  assert.deepEqual(Array.from(mod.reorderShelfProp(cur, 'artist', 2)), ['year', 'genre', 'artist']);
  assert.deepEqual(Array.from(mod.reorderShelfProp(cur, 'artist', 99)), ['year', 'genre', 'artist']);
  assert.deepEqual(Array.from(mod.reorderShelfProp(cur, 'artist', -5)), ['artist', 'year', 'genre']);
  assert.deepEqual(cur, ['artist', 'year', 'genre'], '原数组被就地改写');
  const unknown = mod.reorderShelfProp(cur, 'label', 0);
  assert.deepEqual(Array.from(unknown), cur);
  assert.notEqual(unknown, cur);
});

test('resolveDropIndex + reorderShelfProp：拖拽落点 → 卡片行序（含落到自己身上）', () => {
  const cur = ['artist', 'year', 'genre', 'label'];
  const drop = (drag, target, after) =>
    Array.from(mod.reorderShelfProp(cur, drag, mod.resolveDropIndex(cur, drag, target, after)));

  assert.deepEqual(drop('artist', 'genre', true), ['year', 'genre', 'artist', 'label'], '拖到 genre 下方');
  assert.deepEqual(drop('artist', 'genre', false), ['year', 'artist', 'genre', 'label'], '拖到 genre 上方');
  assert.deepEqual(drop('label', 'artist', false), ['label', 'artist', 'year', 'genre'], '末尾拖到最前');
  assert.deepEqual(drop('artist', 'label', true), ['year', 'genre', 'label', 'artist'], '最前拖到末尾');
  assert.deepEqual(drop('year', 'year', false), cur, '落到自己上半 → 原位');
  assert.deepEqual(drop('year', 'year', true), cur, '落到自己下半 → 原位');
  assert.deepEqual(cur, ['artist', 'year', 'genre', 'label'], '原数组被就地改写');
  assert.equal(mod.resolveDropIndex(cur, 'nope', 'genre', true), -1, '未知被拖键');
});

// ============ 值格式化 ============

test('formatPropValue：标量 / 布尔 / 数字（0 必须有值）', () => {
  assert.equal(mod.formatPropValue('The Beatles'), 'The Beatles');
  assert.equal(mod.formatPropValue(1969), '1969');
  assert.equal(mod.formatPropValue(0), '0', '0 被当成空值丢弃');
  assert.equal(mod.formatPropValue(true), '✓');
  assert.equal(mod.formatPropValue(false), '✗', 'false 被当成空值丢弃');
  assert.equal(mod.formatPropValue(null), '');
  assert.equal(mod.formatPropValue(undefined), '');
  assert.equal(mod.formatPropValue(''), '');
});

test('formatPropValue：wikilink 显示语义 / 换行折叠 / 对象不展开', () => {
  assert.equal(mod.formatPropValue('[[06-专辑墙/covers/x.jpg]]'), '06-专辑墙/covers/x.jpg');
  // 带别名取别名（Obsidian 显示约定）；无别名取目标
  assert.equal(mod.formatPropValue('[[Blue Note|蓝调之音]]'), '蓝调之音');
  assert.equal(mod.formatPropValue('[[Blue Note Records]]'), 'Blue Note Records');
  assert.equal(mod.formatPropValue('a\nb'), 'a b');
  assert.equal(mod.formatPropValue({ a: 1 }), '');
  assert.equal(mod.formatPropValue([{ a: 1 }, 'Rock']), 'Rock');
});

test('formatPropValue：数组用「、」连接，空项折叠，全空 → 空串', () => {
  assert.equal(mod.formatPropValue(['Rock', 'Pop']), 'Rock、Pop');
  assert.equal(mod.formatPropValue(['Rock', '']), 'Rock');
  assert.equal(mod.formatPropValue([null, '']), '');
  assert.equal(mod.formatPropValue([]), '');
});

test('formatPropValue：Date 用本地日期（toISOString 会跨日错位）', () => {
  assert.equal(mod.formatPropValue(new Date(2024, 0, 2)), '2024-01-02');
  // 本地 00:30：UTC 输出在 +08:00 会退回前一天，本地字段不会
  assert.equal(mod.formatPropValue(new Date(2024, 0, 2, 0, 30)), '2024-01-02');
});

// ============ 卡片采集（buildAlbumInfo 集成） ============

function fakeApp() {
  return { metadataCache: { getFirstLinkpathDest: () => null } };
}

test('buildAlbumInfo：displayProps 采集非黑名单键，类型化字段保持不变', () => {
  const fm = {
    tags: ['album'],
    neteaseId: 15185,
    cover: '[[06-专辑墙/covers/太平盛世.jpg]]',
    artist: '陶喆',
    year: 2005,
    genre: 'R&B',
    netease: 'https://music.163.com/#/album?id=15185',
    label: 'Apple Records',
    rating: 0,
  };
  const file = { path: '06-专辑墙/专辑/太平盛世.md', basename: '太平盛世' };
  const a = mod.buildAlbumInfo(fakeApp(), file, fm);

  // 既有类型化字段（排序/搜索/Track/右键菜单依赖）零变化
  assert.equal(a.artist, '陶喆');
  assert.equal(a.year, 2005);
  assert.equal(a.genre, 'R&B');
  assert.equal(a.rating, 0);
  assert.equal(a.neteaseId, 15185);
  assert.equal(a.title, '太平盛世');

  // 新增：显示属性
  assert.equal(a.displayProps.artist, '陶喆');
  assert.equal(a.displayProps.year, '2005');
  assert.equal(a.displayProps.genre, 'R&B');
  assert.equal(a.displayProps.label, 'Apple Records');
  assert.equal(a.displayProps.rating, '0', 'rating: 0 应保留为有值');
  for (const k of ['tags', 'cover', 'netease', 'neteaseId', 'qq', 'qqId', 'audio', 'audioFolder', 'source']) {
    assert.ok(!(k in a.displayProps), `黑名单键 ${k} 不应进 displayProps`);
  }
});

// ============ 属性发现 ============

test('collectShelfPropKeys：计数只算非空专辑，排序 count desc → 键名，黑名单不出现', () => {
  const albums = [
    { displayProps: { artist: 'A', year: '1999', label: '', genre: 'Rock' } },
    { displayProps: { artist: 'B', label: 'Blue Note', genre: 'Jazz' } },
    { displayProps: { artist: 'C', year: '2001' } },
    { displayProps: {} },
    {},
  ];
  const usage = mod.collectShelfPropKeys(albums);
  const byKey = Object.fromEntries(usage.map((u) => [u.key, u.count]));
  assert.deepEqual(byKey, { artist: 3, genre: 2, year: 2, label: 1 }, '空值键不应计数（label 只有 1 张）');
  // 排序：count desc，同 count 按键名
  assert.deepEqual(Array.from(usage, (u) => u.key), ['artist', 'genre', 'year', 'label']);
  for (const u of usage) {
    assert.ok(mod.isDisplayablePropKey(u.key), `${u.key} 不应出现（黑名单）`);
  }
});

test('collectShelfPropKeys：空输入 → []', () => {
  assert.deepEqual(Array.from(mod.collectShelfPropKeys([])), []);
});

// ============ 一致性（防新增默认键忘配别名） ============

test('一致性：DEFAULT_SHELF_PROPS 每个键都有预设中文别名', () => {
  for (const key of mod.DEFAULT_SHELF_PROPS) {
    const meta = mod.PROP_META[key];
    assert.ok(meta && meta.label && meta.label !== key, `默认键 ${key} 缺少中文别名`);
    assert.equal(mod.propLabel(key), meta.label);
  }
  assert.equal(mod.propLabel('unknown-key'), 'unknown-key', '未覆盖键应回退键名');
  assert.equal(mod.propLabel('artist', { artist: '乐队' }), '乐队', '自定义别名应优先');
  assert.equal(mod.propLabel('artist', { artist: '  ' }), '艺术家', '空白覆写应回落预设');
  assert.equal(mod.propPrefix('rating'), '⭐ ', '评分星号不能丢');
  assert.equal(mod.propPrefix('artist'), '');
});
