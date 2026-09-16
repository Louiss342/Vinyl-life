// 专辑墙排序回归：菜单顺序 / 状态机（切换与翻转）/ 菜单标题（含中英与自定义属性）/ 比较器。
// esbuild 从真实 TS 编译进 node:vm（stub obsidian），不改 vault、不依赖 Obsidian 运行。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  stdin: {
    // 一并导出 i18n：菜单标题要验证中英两套词典
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

// ============ 菜单顺序与状态机 ============

test('SORT_BASES：菜单顺序与设计稿一致（名称 → 作者 → 发行日期 → 播放次数 → 评分 → 最近播放 → 自定义）', () => {
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

test('switchSort：没选中 = 切过来（用默认方向）；已选中 = 翻转方向', () => {
  const cur = { basis: 'title', dir: 'asc' };
  assert.deepEqual(plain(mod.switchSort(cur, 'plays')), { basis: 'plays', dir: 'desc' }, '换依据用该项默认方向');
  assert.deepEqual(plain(mod.switchSort(cur, 'year')), { basis: 'year', dir: 'asc' });
  assert.deepEqual(plain(mod.switchSort(cur, 'title')), { basis: 'title', dir: 'desc' }, '再点已选中 → 倒序');
  assert.deepEqual(
    plain(mod.switchSort({ basis: 'title', dir: 'desc' }, 'title')),
    { basis: 'title', dir: 'asc' },
    '倒序再点 → 换回顺序'
  );
});

test('switchSort：从自定义切走丢掉 custom 键（切回来要重新选属性）', () => {
  const cur = { basis: 'custom', dir: 'asc', custom: 'genre' };
  assert.deepEqual(plain(mod.switchSort(cur, 'artist')), { basis: 'artist', dir: 'asc' });
});

test('switchSort：在自定义上再点 = 翻转方向（保留属性）', () => {
  const cur = { basis: 'custom', dir: 'asc', custom: 'genre' };
  assert.deepEqual(plain(mod.switchSort(cur, 'custom')), { basis: 'custom', dir: 'desc', custom: 'genre' });
});

test('pickCustomSort：新属性按升序排；同一个属性再选 = 翻转（与固定依据同规则）', () => {
  assert.deepEqual(plain(mod.pickCustomSort({ basis: 'title', dir: 'asc' }, 'genre')), {
    basis: 'custom',
    dir: 'asc',
    custom: 'genre',
  });
  assert.deepEqual(plain(mod.pickCustomSort({ basis: 'custom', dir: 'asc', custom: 'genre' }, 'genre')), {
    basis: 'custom',
    dir: 'desc',
    custom: 'genre',
  });
  assert.deepEqual(plain(mod.pickCustomSort({ basis: 'custom', dir: 'desc', custom: 'genre' }, 'label')), {
    basis: 'custom',
    dir: 'asc',
    custom: 'label',
  });
});

// ============ 菜单标题 ============

test('菜单标题（中文）：未选中显示默认方向，选中显示当前方向', () => {
  mod.i18n.setLanguage('zh');
  const cur = { basis: 'plays', dir: 'desc' };
  assert.equal(mod.sortItemLabel('title', cur), '专辑名称[A-Z]');
  assert.equal(mod.sortItemLabel('artist', cur), '作者名称[A-Z]');
  assert.equal(mod.sortItemLabel('year', cur), '发行日期[早-晚]');
  assert.equal(mod.sortItemLabel('plays', cur), '播放次数[多-少]');
  assert.equal(mod.sortItemLabel('rating', cur), '评分[高-低]');
  assert.equal(mod.sortItemLabel('recent', cur), '最近播放[近-远]');
});

test('菜单标题：再点翻转后，括号里的表述跟着变', () => {
  mod.i18n.setLanguage('zh');
  assert.equal(mod.sortItemLabel('year', { basis: 'year', dir: 'asc' }), '发行日期[早-晚]');
  assert.equal(mod.sortItemLabel('year', { basis: 'year', dir: 'desc' }), '发行日期[晚-早]');
  assert.equal(mod.sortItemLabel('plays', { basis: 'plays', dir: 'asc' }), '播放次数[少-多]');
  assert.equal(mod.sortItemLabel('rating', { basis: 'rating', dir: 'asc' }), '评分[低-高]');
  assert.equal(mod.sortItemLabel('recent', { basis: 'recent', dir: 'asc' }), '最近播放[远-近]');
});

test('菜单标题：A-Z / Z-A 两种语言写法一致（不进词典）', () => {
  mod.i18n.setLanguage('en');
  assert.equal(mod.sortItemLabel('title', { basis: 'title', dir: 'asc' }), 'Album title[A-Z]');
  assert.equal(mod.sortItemLabel('title', { basis: 'title', dir: 'desc' }), 'Album title[Z-A]');
  mod.i18n.setLanguage('zh');
});

test('菜单标题（自定义）：没选属性就是光名字；选过带属性名与方向（含 settings 改名覆写）', () => {
  mod.i18n.setLanguage('zh');
  assert.equal(mod.sortItemLabel('custom', { basis: 'title', dir: 'asc' }), '自定义排序依据');
  const custom = { basis: 'custom', dir: 'asc', custom: 'genre' };
  assert.equal(mod.sortItemLabel('custom', custom), '自定义排序依据：流派[升序]');
  assert.equal(mod.sortItemLabel('custom', { ...custom, dir: 'desc' }), '自定义排序依据：流派[降序]');
  assert.equal(
    mod.sortItemLabel('custom', custom, { genre: '曲风' }),
    '自定义排序依据：曲风[升序]',
    '属性改名跟着走'
  );
  mod.i18n.setLanguage('en');
  assert.equal(mod.sortItemLabel('custom', custom), 'Custom: Genre[Ascending]');
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

test('排序：作者名称（缺作者按空串处理，升序排最前）', () => {
  const list = [shelfEntry('x', { artist: 'B' }), shelfEntry('y'), shelfEntry('z', { artist: 'A' })];
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'artist', dir: 'asc' })), ['y', 'z', 'x']);
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'artist', dir: 'desc' })), ['x', 'z', 'y']);
});

test('排序：发行日期 早-晚 / 晚-早（缺年份按最小处理）', () => {
  const list = [shelfEntry('a', { year: '2001' }), shelfEntry('b'), shelfEntry('c', { year: 1996 })];
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'year', dir: 'asc' })), ['b', 'c', 'a']);
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'year', dir: 'desc' })), ['a', 'c', 'b']);
});

test('排序：评分 高-低（默认）/ 低-高（缺评分按最小处理）', () => {
  const list = [shelfEntry('a', { rating: 3 }), shelfEntry('b', { rating: 5 }), shelfEntry('c')];
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'rating', dir: 'desc' })), ['b', 'a', 'c']);
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'rating', dir: 'asc' })), ['c', 'a', 'b']);
});

test('排序：播放次数 多-少 / 少-多（统计缺失按 0）', () => {
  const list = [shelfEntry('a'), shelfEntry('b'), shelfEntry('c')];
  const stats = { albums: { '专辑/b.md': { plays: 7 }, '专辑/c.md': { plays: 3 } } };
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'plays', dir: 'desc' }, stats)), [
    'b',
    'c',
    'a',
  ]);
  assert.deepEqual(titles(mod.sortShelfEntries(list, { basis: 'plays', dir: 'asc' }, stats)), [
    'a',
    'c',
    'b',
  ]);
});

test('排序：最近播放 近-远（默认）/ 远-近', () => {
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
    'b',
    'a',
    'c',
  ]);
});

test('排序：自定义属性 —— 数字串按数值比（不按字典序），缺失排最前', () => {
  const list = [
    shelfEntry('a', { displayProps: { serial: '9' } }),
    shelfEntry('b', { displayProps: { serial: '10' } }),
    shelfEntry('c'),
  ];
  const sort = { basis: 'custom', dir: 'asc', custom: 'serial' };
  assert.deepEqual(
    titles(mod.sortShelfEntries(list, sort)),
    ['c', 'a', 'b'],
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
