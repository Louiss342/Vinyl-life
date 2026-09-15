const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

// 与被测模块打进同一个 bundle 才能拿到同一个类身份（跨 bundle 的 instanceof 恒为 false）：
// 冷却用例要造「上游限流 429」这个输入，必须用同一份 GatewayError。
const source = esbuild.buildSync({
  stdin: {
    contents:
      `export * from '../src/core/album-discovery';\n` +
      `export { GatewayError } from '../src/core/request-error';\n`,
    resolveDir: __dirname,
  },
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
  window: { setTimeout, clearTimeout },
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

// 下面两个用例会改动模块级的节流状态（缓存 / 冷却），必须放在文件末尾，
// 否则同一文件里前面的用例会被「冷却中不发请求」影响。

test('搜索节流：同一个词第二次搜索走缓存，不再打网络', async () => {
  const app = { vault: { getMarkdownFiles: () => [] }, metadataCache: { getFileCache: () => null } };
  let neteaseCalls = 0;
  let qqCalls = 0;
  const ctx = {
    app,
    client: {
      searchAlbums: async () => { neteaseCalls++; return { result: { albums: [{ id: 77, name: '缓存专辑' }] } }; },
      searchSongs: async () => { neteaseCalls++; return { result: { songs: [] } }; },
    },
    qq: { search: async () => { qqCalls++; return { data: { albums: [], songs: [] } }; } },
  };
  const first = await discovery.discoverAlbums(ctx, '缓存用词');
  assert.equal(first.items.length, 1);
  assert.equal(neteaseCalls, 2, '首搜 = 专辑 + 单曲两次请求');
  assert.equal(qqCalls, 1);
  const second = await discovery.discoverAlbums(ctx, '缓存用词');
  assert.equal(second.items.length, 1);
  assert.equal(second.warnings.length, 0, '缓存命中的结果不该再带警告');
  assert.equal(neteaseCalls, 2, '第二次命中缓存，请求数不得增长');
  assert.equal(qqCalls, 1);
});

test('搜索节流：上游 429 后该来源进入冷却，这一轮不发请求也不谎报「没结果」', async () => {
  const app = { vault: { getMarkdownFiles: () => [] }, metadataCache: { getFileCache: () => null } };
  let neteaseCalls = 0;
  const ctx = {
    app,
    client: {
      searchAlbums: async () => { neteaseCalls++; throw new discovery.GatewayError('网易云接口限流（操作频繁），请等几秒再搜', 429); },
      searchSongs: async () => { neteaseCalls++; throw new discovery.GatewayError('网易云接口限流（操作频繁），请等几秒再搜', 429); },
    },
    qq: { search: async () => ({ data: { albums: [{ mid: 'ALBUM001', name: 'QQ 专辑' }], songs: [] } }) },
  };
  const first = await discovery.discoverAlbums(ctx, '限流用词');
  assert.equal(first.items.length, 1, '网易云挂了不影响 QQ 的结果');
  const neteaseWarning = first.warnings.find((w) => w.source === 'netease');
  assert.match(neteaseWarning.message, /限流/);
  assert.equal(neteaseCalls, 2);
  // 冷却期内换一个词再搜：网易云侧一个请求都不该发出去
  const second = await discovery.discoverAlbums(ctx, '限流用词二');
  assert.equal(neteaseCalls, 2, '冷却期内不得再打网易云');
  assert.equal(second.items.length, 1);
  const cooling = second.warnings.find((w) => w.source === 'netease');
  assert.ok(cooling, '冷却中的来源要给出解释，否则会被当成「没有结果」');
  assert.match(cooling.message, /限流/);
});
