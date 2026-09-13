// i18n 回归：字典完整性（每条都有中英）+ 切换 + 缺键回退。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/core/i18n.ts')],
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
  require: () => ({}),
  console,
});
const i18n = mod.exports;

test('i18n：默认中文，切到 en 后取英文', () => {
  i18n.setLanguage(undefined);
  assert.equal(i18n.getLanguage(), 'zh', '默认中文');
  assert.equal(i18n.t('shelf.refresh'), '刷新');

  i18n.setLanguage('en');
  assert.equal(i18n.getLanguage(), 'en');
  assert.equal(i18n.t('shelf.refresh'), 'Refresh');
  assert.equal(i18n.t('menu.setCover'), 'Set cover…');

  i18n.setLanguage('zh');
  assert.equal(i18n.t('shelf.refresh'), '刷新', '切回来仍是中文');
});

test('i18n：未知语言回落中文，未知键回落 key 本身', () => {
  i18n.setLanguage('fr');
  assert.equal(i18n.getLanguage(), 'zh', '不认识的语言按中文处理');
  assert.equal(i18n.t('nope.missing'), 'nope.missing', '缺键返回 key（便于发现漏翻）');
  i18n.setLanguage('zh');
});

test('i18n：专辑墙用到的键在中英两套里都有且非空', () => {
  const keys = [
    'sort.titleAsc', 'sort.titleDesc', 'sort.yearDesc', 'sort.yearAsc',
    'sort.ratingDesc', 'sort.playsDesc', 'sort.recent',
    'filter.all', 'filter.local', 'filter.netease', 'filter.qq', 'filter.collect',
    'shelf.title', 'shelf.search', 'shelf.refresh', 'shelf.sort', 'shelf.filter',
    'shelf.props', 'shelf.importAlbum', 'shelf.importAudio',
    'shelf.empty.title', 'shelf.empty.hint', 'shelf.filtered.title', 'shelf.filtered.hint',
    'menu.play', 'menu.openNote', 'menu.importAudio', 'menu.setCover',
    'menu.openNetease', 'menu.openQq', 'menu.deleteAlbum',
  ];
  for (const k of keys) {
    for (const lang of ['zh', 'en']) {
      i18n.setLanguage(lang);
      const v = i18n.t(k);
      assert.notEqual(v, k, `${lang} 缺少键 ${k}`);
      assert.ok(v.trim().length > 0, `${lang} 的 ${k} 是空串`);
    }
  }
  i18n.setLanguage('zh');
});
