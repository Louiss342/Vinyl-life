// 专辑墙排序回归：依据顺序 / 状态机（换依据 / 换方向 / 换属性）/ 方向文案（含中英）/ 比较器。
// 工具栏方案 2026-09-18：依据与方向是两个独立下拉（不再靠重复点击翻转）；缺失排序属性一律排最后。
// esbuild 从真实 TS 编译进 node:vm（stub obsidian），不改 vault、不依赖 Obsidian 运行。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  stdin: {
    // 一并导出 i18n：方向文案要验证中英两套词典
    contents: `export * from '../src/core/shelf-sort';\nexport * as i18n from '../src/core/i18n';\n`,
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

// 构造一个专辑墙条目（比较器只看 album 上的字段）
const shelfEntry = (title, extra = {}) => ({ album: { path: `专辑/${title}.md`, title, ...extra } });
// 返回值跨了 vm realm（原型不同），断言前一律搬回测试侧：数组用 Array.from、对象用展开
const titles = (list) => Array.from(list, (e) => e.album.title);
const plain = (o) => ({ ...o });

// ============ 依据顺序与状态机 ============

test('SORT_BASES：下拉顺序与设计稿一致（名称 → 作者 → 发行日期 → 播放次数 → 评分 → 最近播放 → 自定义）', () => {
  assert.deepEqual(Array.from(mod.SORT_BASES), [
    'title',
    'artist',
    'year',
    'plays',
    'rating',
    'recent',
    'custom',
  ]);
});

test('defaultDirOf：文本 / 日期类默认升序；热度类（播放次数 / 评分 / 最近播放）默认降序', () => {
  for (const b of ['title', 'artist', 'year', 'custom']) {
    assert.equal(mod.defaultDirOf(b), 'asc', `${b} 默认升序`);
  }
  for (const b of ['plays', 'rating', 'recent']) {
    assert.equal(mod.defaultDirOf(b), 'desc', `${b} 默认降序`);
  }
});

test('setSortBasis：换依据用该依据的默认方向；选同一个依据不动方向', () => {
  const cur = { basis: 'title', dir: 'asc' };
  assert.deepEqual(plain(mod.setSortBasis(cur, 'plays')), { basis: 'plays', dir: 'desc' });
  assert.deepEqual(plain(mod.setSortBasis(cur, 'year')), { basis: 'year', dir: 'asc' });
  // 方向是独立下拉：同一个依据被再选一次，不该翻转（那是旧交互）
  assert.deepEqual(plain(mod.setSortBasis(cur, 'title')), { basis: 'title', dir: 'asc' });
  assert.deepEqual(
    plain(mod.setSortBasis({ basis: 'title', dir: 'desc' }, 'title')),
    { basis: 'title', dir: 'desc' },
    '再选同一个依据：方向保持用户选的那档'
  );
});

test('setSortBasis：从自定义切走丢掉 custom 键（切回来要重新选属性）', () => {
  const cur = { basis: 'custom', dir: 'asc', custom: 'genre' };
  assert.deepEqual(plain(mod.setSortBasis(cur, 'artist')), { basis: 'artist', dir: 'asc' });
});

test('setCustomSortKey：选属性即切到自定义依据、按升序；同一个属性再选不动方向', () => {
  assert.deepEqual(plain(mod.setCustomSortKey({ basis: 'title', dir: 'asc' }, 'genre')), {
    basis: 'custom',
    dir: 'asc',
    custom: 'genre',
  });
  assert.deepEqual(
    plain(mod.setCustomSortKey({ basis: 'custom', dir: 'desc', custom: 'genre' }, 'genre')),
    { basis: 'custom', dir: 'desc', custom: 'genre' },
    '同一个属性再选：方向保持'
  );
  assert.deepEqual(plain(mod.setCustomSortKey({ basis: 'custom', dir: 'desc', custom: 'genre' }, 'label')), {
    basis: 'custom',
    dir: 'asc',
    custom: 'label',
  });
});

test('setSortDir：只动方向，依据与自定义键都不碰；同值返回原对象', () => {
  const cur = { basis: 'custom', dir: 'asc', custom: 'genre' };
  assert.deepEqual(plain(mod.setSortDir(cur, 'desc')), { basis: 'custom', dir: 'desc', custom: 'genre' });
  assert.equal(mod.setSortDir(cur, 'asc'), cur, '同值不必新建');
});

// ============ 方向文案 ============

test('方向文案（中文）：给具体动作，方向跟着依据换', () => {
  mod.i18n.setLanguage('zh');
  assert.equal(mod.dirWord('title', 'asc'), 'A → Z');
  assert.equal(mod.dirWord('title', 'desc'), 'Z → A');
  assert.equal(mod.dirWord('artist', 'asc'), 'A → Z');
  assert.equal(mod.dirWord('year', 'desc'), '最新在前');
  assert.equal(mod.dirWord('year', 'asc'), '最早在前');
  assert.equal(mod.dirWord('plays', 'desc'), '最多在前');
  assert.equal(mod.dirWord('plays', 'asc'), '最少在前');
  assert.equal(mod.dirWord('rating', 'desc'), '高分在前');
  assert.equal(mod.dirWord('rating', 'asc'), '低分在前');
  assert.equal(mod.dirWord('recent', 'desc'), '最近在前');
  assert.equal(mod.dirWord('custom', 'asc'), '升序');
});

test('方向文案：A → Z / Z → A 两种语言写法一致（不进词典）', () => {
  mod.i18n.setLanguage('en');
  assert.equal(mod.dirWord('title', 'asc'), 'A → Z');
  assert.equal(mod.dirWord('title', 'desc'), 'Z → A');
  assert.equal(mod.dirWord('plays', 'desc'), 'Most first');
  mod.i18n.setLanguage('zh');
});

test('sortDirOptions：两个方向 + 两个文案（先升后降，与依据绑定）', () => {
  mod.i18n.setLanguage('zh');
  assert.deepEqual(
    Array.from(mod.sortDirOptions('rating'), (o) => ({ ...o })),
    [
      { dir: 'asc', label: '低分在前' },
      { dir: 'desc', label: '高分在前' },
    ]
  );
});

test('basisName：固定依据走词典；自定义带属性名（含 settings 改名覆写）', () => {
  mod.i18n.setLanguage('zh');
  assert.equal(mod.basisName('title'), '专辑名称');
  assert.equal(mod.basisName('recent'), '最近播放');
  assert.equal(mod.basisName('custom', 'genre'), '流派');
  assert.equal(mod.basisName('custom', 'genre', { genre: '曲风' }), '曲风', '属性改名跟着走');
  assert.equal(mod.basisName('custom'), '自定义排序依据', '没选属性时给个兜底名');
  mod.i18n.setLanguage('en');
  assert.equal(mod.basisName('plays'), 'Play count');
  mod.i18n.setLanguage('zh');
});

// ============ 比较器 ============

test('排序：专辑名称 A-Z / Z-A；返回新数组、不改入参', () => {
  const list = [shelfEntry('C'), shelfEntry('A'), shelfEntry('B')];
  const asc = mod.sortShelfEntries(list, { basis: 'title', dir: 'asc' });
  assert.deepEqual(titles(asc), ['A', 'B', 'C']);
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'title', dir: 'desc' })), ['C', 'B', 'A']);
  assert.deepEqual(titles(list), ['C', 'A', 'B'], '入参顺序不动');
  assert.notEqual(asc, list, '返回的是新数组');
});

test('排序：作者名称（缺作者一律排最后，与方向无关）', () => {
  const list = [shelfEntry('x', { artist: 'B' }), shelfEntry('y'), shelfEntry('z', { artist: 'A' })];
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'artist', dir: 'asc' })), ['z', 'x', 'y']);
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'artist', dir: 'desc' })), ['x', 'z', 'y']);
});

test('排序：发行日期 最新在前 / 最早在前（缺年份、非数值串都排最后）', () => {
  const list = [
    shelfEntry('a', { year: '2001' }),
    shelfEntry('b'),
    shelfEntry('c', { year: 1996 }),
    shelfEntry('d', { year: '待定' }),
  ];
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'year', dir: 'asc' })), ['c', 'a', 'b', 'd']);
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'year', dir: 'desc' })), ['a', 'c', 'b', 'd']);
});

test('排序：评分 高分在前（默认）/ 低分在前（缺评分排最后）', () => {
  const list = [shelfEntry('a', { rating: 3 }), shelfEntry('b', { rating: 5 }), shelfEntry('c')];
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'rating', dir: 'desc' })), ['b', 'a', 'c']);
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'rating', dir: 'asc' })), ['a', 'b', 'c']);
});

test('排序：播放次数 最多在前 / 最少在前（没播过的排最后）', () => {
  const list = [shelfEntry('a'), shelfEntry('b'), shelfEntry('c')];
  const stats = { albums: { '专辑/b.md': { plays: 7 }, '专辑/c.md': { plays: 3 } } };
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'plays', dir: 'desc' }, stats)), [
    'b',
    'c',
    'a',
  ]);
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'plays', dir: 'asc' }, stats)), [
    'c',
    'b',
    'a',
  ]);
});

test('排序：最近播放 最近在前（默认）/ 最早在前（没播过的排最后）', () => {
  const list = [shelfEntry('a'), shelfEntry('b'), shelfEntry('c')];
  const stats = {
    albums: { '专辑/a.md': { lastPlayedAt: 100 }, '专辑/c.md': { lastPlayedAt: 300 } },
  };
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'recent', dir: 'desc' }, stats)), [
    'c',
    'a',
    'b',
  ]);
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'recent', dir: 'asc' }, stats)), [
    'a',
    'c',
    'b',
  ]);
});

test('排序：自定义属性 —— 数字串按数值比（不按字典序），缺失排最后', () => {
  const list = [
    shelfEntry('a', { displayProps: { serial: '9' } }),
    shelfEntry('b', { displayProps: { serial: '10' } }),
    shelfEntry('c'),
  ];
  const sort = { basis: 'custom', dir: 'asc', custom: 'serial' };
  assert.deepEqual(
    titles(mod.sortShelfEntries(list, sort)),
    ['a', 'b', 'c'],
    '数字串：9 < 10（纯字典序会得到相反的 10 < 9）'
  );
  assert.deepEqual(titles(mod.sortShelfEntries(list, { ...sort, dir: 'desc' })), ['b', 'a', 'c']);
});

test('排序：自定义属性 —— 文本按中文排序（拼音）', () => {
  const list = [
    shelfEntry('a', { displayProps: { genre: '摇滚' } }),
    shelfEntry('b', { displayProps: { genre: '流行' } }),
  ];
  assert.deepEqual(
    titles(mod.sortShelfEntries(list, { basis: 'custom', dir: 'asc', custom: 'genre' })),
    ['b', 'a'],
    '流行 (liu) < 摇滚 (yao)'
  );
});

test('排序：自定义依据没有键时不动顺序（防御：视图不会走到这里）', () => {
  const list = [shelfEntry('b'), shelfEntry('a')];
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'custom', dir: 'asc' })), ['b', 'a']);
});
