const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/core/album-discovery.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian'],
}).outputFiles[0].text;

const moduleBox = { exports: {} };
vm.runInNewContext(source, {
  module: moduleBox,
  exports: moduleBox.exports,
  require: (name) => name === 'obsidian'
    ? { App: class {}, TFile: class {}, TFolder: class {}, normalizePath: (p) => p }
    : require(name),
  console,
});
const discovery = moduleBox.exports;

test('网易云：专辑与歌曲命中归一化，同专辑去重时保留专辑命中', () => {
  const rows = discovery.normalizeNeteaseSearch(
    { result: { albums: [{ id: 1, name: '叶惠美', artist: { name: '周杰伦' }, size: 11 }] } },
    { result: { songs: [
      { id: 2, name: '晴天', ar: [{ name: '周杰伦' }], al: { id: 1, name: '叶惠美' } },
      { id: 3, name: '七里香', ar: [{ name: '周杰伦' }], al: { id: 9, name: '七里香' } },
    ] } }
  );
  assert.equal(rows.length, 2);
  assert.equal(rows.find((x) => x.sourceAlbumId === '1').matchedBy, 'album');
  assert.equal(rows.find((x) => x.sourceAlbumId === '9').matchedTrack, '七里香');
});

test('QQ：专辑与歌曲命中归一化', () => {
  const rows = discovery.normalizeQqSearch({ data: {
    albums: [{ mid: 'ALBUM001', name: '未完成', artist: '孙燕姿', publishTime: '2002-05-01' }],
    songs: [{ mid: 'SONG0001', name: '遇见', artist: '孙燕姿', albumMid: 'ALBUM002', albumName: 'The Moment' }],
  } });
  assert.deepEqual(Array.from(rows, (x) => x.key), ['qq:ALBUM001', 'qq:ALBUM002']);
  assert.equal(rows[1].matchedBy, 'track');
});

test('平台明确标记不可用的专辑不进入搜索结果', () => {
  const netease = discovery.normalizeNeteaseSearch(
    { result: { albums: [
      { id: 1, name: '可用专辑', status: 1, size: 10 },
      { id: 2, name: '已下架专辑', status: -4, size: 12 },
      { id: 3, name: '空专辑', status: 1, size: 0 },
    ] } },
    { result: { songs: [
      { id: 10, name: '无版权歌曲', copyrightId: 0, status: 0, album: { id: 4, name: '无版权专辑' } },
    ] } }
  );
  const qq = discovery.normalizeQqSearch({ data: { albums: [
    { mid: 'AVAILABLE1', name: '可用专辑', available: true },
    { mid: 'REMOVED001', name: '已下架专辑', available: false },
  ] } });
  assert.deepEqual(Array.from(netease, (x) => x.sourceAlbumId), ['1']);
  assert.deepEqual(Array.from(qq, (x) => x.sourceAlbumId), ['AVAILABLE1']);
});

test('聚合搜索：单源失败仍返回另一源，并标记已导入', async () => {
  const file = { path: 'Vinyl Life/Vinyl Note/叶惠美.md', basename: '叶惠美' };
  const app = {
    vault: { getMarkdownFiles: () => [file] },
    metadataCache: { getFileCache: () => ({ frontmatter: { tags: ['album'], neteaseId: 1 } }) },
  };
  const result = await discovery.discoverAlbums({
    app,
    client: {
      searchAlbums: async () => ({ result: { albums: [{ id: 1, name: '叶惠美', artist: { name: '周杰伦' } }] } }),
      searchSongs: async () => ({ result: { songs: [] } }),
    },
    qq: { search: async () => { throw new Error('QQ timeout'); } },
  }, '叶惠美');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].importedFilePath, file.path);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].source, 'qq');
});
