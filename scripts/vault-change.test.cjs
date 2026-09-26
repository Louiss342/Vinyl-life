// vault 结构变化 → 「要不要重扫」的判据回归（util.vaultChangeMatters）。
// 为什么值得单独钉：这条判据错了的表现是**静默**的 ——
//   · 判宽了：别的插件写一篇日记也触发全库重算（500 张专辑各一次同步系统调用，界面卡住）；
//   · 判窄了：导入一首歌、加一张封面，墙上的角标与封面不跟着变（用户以为坏了）。
// 两头都不会报错，所以拿用例把边界钉死。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const nodePath = require('node:path');

const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/util.ts')],
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
        Plugin: class {},
        Notice: class {},
        TFile: class {},
        TFolder: class {},
        Modal: class {},
        Menu: class {},
        normalizePath: (p) => p,
      };
    }
    if (name === 'fs') return { readdirSync: () => [], existsSync: () => false, statSync: () => ({}) };
    if (name === 'path') return nodePath;
    throw new Error('Unexpected runtime import: ' + name);
  },
  console,
});
const { vaultChangeMatters } = mod.exports;

const ALBUM_FOLDER = 'Vinyl Life/Vinyl Note';
const change = (over = {}) =>
  vaultChangeMatters({
    path: 'Clippings/某篇文章.md',
    extension: 'md',
    isFolder: false,
    albumFolder: ALBUM_FOLDER,
    ...over,
  });

test('vault 变化：文件夹一律算（里面装什么都有可能）', () => {
  assert.equal(change({ path: '随便一个目录', extension: '', isFolder: true }), true);
});

test('vault 变化：音频与图片算（本地音源角标 / 封面自动识别）', () => {
  assert.equal(change({ path: 'Music/01.flac', extension: 'flac' }), true);
  assert.equal(change({ path: 'Vinyl Life/Covers/x.webp', extension: 'webp' }), true);
});

test('vault 变化：rename 时旧名一并判（改名成别的后缀 = 离开了专辑目录）', () => {
  assert.equal(change({ path: 'notes/a.md', extension: 'md', oldPath: 'Music/a.mp3' }), true);
  assert.equal(change({ path: 'Music/b.mp3', extension: 'mp3', oldPath: 'notes/b.md' }), true);
});

test('vault 变化：专辑笔记目录里的 md 算（这张专辑在不在收藏里会变）', () => {
  assert.equal(change({ path: `${ALBUM_FOLDER}/新专辑.md`, extension: 'md' }), true);
  assert.equal(
    change({ path: '无关/位置.md', extension: 'md', oldPath: `${ALBUM_FOLDER}/搬走的专辑.md` }),
    true,
    '从专辑目录搬出去也算'
  );
});

test('vault 变化：普通笔记 / canvas / 插件文件不算（这是「别的插件写日记」那条路径）', () => {
  assert.equal(change({ path: '日记/2026-09-26.md', extension: 'md' }), false);
  assert.equal(change({ path: '白板/图.canvas', extension: 'canvas' }), false);
  assert.equal(change({ path: '.obsidian/plugins/other/main.js', extension: 'js' }), false);
  assert.equal(change({ path: 'data.json', extension: 'json' }), false);
});

test('vault 变化：目录前缀要按整段比（Vinyl Note2 不是 Vinyl Note 里面的）', () => {
  assert.equal(
    change({ path: 'Vinyl Life/Vinyl Note2/x.md', extension: 'md' }),
    false,
    'startsWith(目录) 而不加分隔符就会误判 —— 这里留一条守着'
  );
  assert.equal(change({ path: ALBUM_FOLDER, extension: '', isFolder: true }), true, '目录本身算');
});
