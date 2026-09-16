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

/** 空库（没有任何专辑笔记） */
function emptyApp() {
  return {
    vault: { getMarkdownFiles: () => [] },
    metadataCache: { getFileCache: () => null },
  };
}

/** 造「上游固定返回这几张」的搜索上下文。每个用例都用不同的词 ——
 *  模块级的池子按词缓存，撞词会让用例互相干扰。 */
function searchCtx(app, albums = [], songs = [], qqAlbums = []) {
  return {
    app,
    client: {
      searchAlbums: async () => ({ result: { albums } }),
      searchSongs: async () => ({ result: { songs } }),
    },
    qq: { search: async () => ({ data: { albums: qqAlbums, songs: [] } }) },
  };
}

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

test('已在库中的专辑不出现在结果里，隐去的条数如实报出', async () => {
  const file = { path: 'Vinyl Life/Vinyl Note/叶惠美.md', basename: '叶惠美' };
  const app = {
    vault: { getMarkdownFiles: () => [file] },
    metadataCache: { getFileCache: () => ({ frontmatter: { tags: ['album'], neteaseId: 1 } }) },
  };
  const result = await discovery.discoverAlbums(
    searchCtx(app, [
      { id: 1, name: '叶惠美', artist: { name: '周杰伦' }, size: 11 },
      { id: 2, name: '七里香', artist: { name: '周杰伦' }, size: 10 },
    ]),
    '周杰伦'
  );
  assert.deepEqual(Array.from(result.items, (x) => x.title), ['七里香']);
  assert.equal(result.hiddenImported, 1, '少了的那张要说清是「已在库中」，不能悄悄少');
});

test('已在库中：另一个平台的同一张专辑也要隐去（否则一点就是第二张重复笔记）', async () => {
  // 库里是网易云那版（neteaseId 匹配），结果里来的是 QQ 那版：id 对不上，但标题 + 艺人一致
  const file = { path: 'Vinyl Life/Vinyl Note/叶惠美.md', basename: '叶惠美' };
  const app = {
    vault: { getMarkdownFiles: () => [file] },
    metadataCache: {
      getFileCache: () => ({ frontmatter: { tags: ['album'], neteaseId: 18905, artist: '周杰伦' } }),
    },
  };
  const result = await discovery.discoverAlbums(
    searchCtx(app, [], [], [{ mid: '000MkMni19ClKG', name: '叶惠美', artist: '周杰伦', trackCount: 11 }]),
    '叶惠美'
  );
  assert.deepEqual(Array.from(result.items, (x) => x.title), []);
  assert.equal(result.hiddenImported, 1);
});

test('已在库中：艺人名对不上就不算同一张（宁可漏认，不能把别的专辑认成同一张）', async () => {
  const file = { path: 'Vinyl Life/Vinyl Note/七里香.md', basename: '七里香' };
  const app = {
    vault: { getMarkdownFiles: () => [file] },
    metadataCache: {
      getFileCache: () => ({ frontmatter: { tags: ['album'], neteaseId: 18906, artist: '周杰伦' } }),
    },
  };
  const result = await discovery.discoverAlbums(
    searchCtx(app, [], [], [{ mid: 'OTHERMID001', name: '七里香', artist: '王珏子乔', trackCount: 11 }]),
    '七里香'
  );
  assert.deepEqual(Array.from(result.items, (x) => x.title), ['七里香'], '同名不同人：照常显示');
  assert.equal(result.hiddenImported, 0);
});

test('模糊重排：拼错一个字 / 词序颠倒 / 只记得后半截，都能把对的那张排到最前', async () => {
  const albums = [
    { id: 1, name: '叶惠美', artist: { name: '周杰伦' }, size: 11 },
    { id: 2, name: '范特西', artist: { name: '周杰伦' }, size: 10 },
  ];
  const typo = await discovery.discoverAlbums(searchCtx(emptyApp(), albums), '叶慧美');
  assert.equal(typo.items[0].title, '叶惠美', '错一个字也要认出来');
  const reversed = await discovery.discoverAlbums(searchCtx(emptyApp(), albums), '周杰伦 叶惠美');
  assert.equal(reversed.items[0].title, '叶惠美', '专辑名 + 歌手的词序颠倒也要认出来');
  const tail = await discovery.discoverAlbums(searchCtx(emptyApp(), albums), '惠美');
  assert.equal(tail.items[0].title, '叶惠美', '只记得标题后半截也要认出来');
  assert.deepEqual(
    Array.from(tail.items, (x) => x.title),
    ['叶惠美'],
    '有真命中时，看不出关联的兜底项被剪掉'
  );
});

test('模糊重排：近似命中里，标题像的排在歌手名像的前面（真实上游里踩到的排序）', async () => {
  // 真实数据：搜「叶慧美」时上游会同时给出《叶惠美》（标题差一个字）和一首歌
  // 「新一天」，唱歌的人叫「叶慧婷」（歌手名差一个字）—— 后者的歌手名只该算弱证据
  const result = await discovery.discoverAlbums(
    searchCtx(
      emptyApp(),
      [{ id: 1, name: '叶惠美', artist: { name: '周杰伦' }, size: 11 }],
      [{ id: 2, name: '蝴蝶飞', ar: [{ name: '叶慧婷' }], al: { id: 3, name: '新一天' } }]
    ),
    '叶慧美'
  );
  assert.equal(result.items[0].title, '叶惠美', '标题近似要压过歌手名近似');
  assert.ok(result.items[0].score > result.items[1].score, '分数要拉开，不能只靠上游顺序');
});

test('模糊重排：多词查询里，专辑 + 歌手各中一个词的排在「整串嵌进标题」的前面', async () => {
  // 真实数据：搜「周杰伦 叶惠美」时，《周杰伦《叶惠美》吉他翻唱版》会把查询词整个嵌进标题，
  // 但用户要找的是专辑本身 —— 歌手名单独成一个词且完全相等，才是更强的信号
  const result = await discovery.discoverAlbums(
    searchCtx(
      emptyApp(),
      [
        { id: 1, name: '周杰伦《叶惠美》吉他翻唱版', artist: { name: '涛李TAOLEE' }, size: 3 },
        { id: 2, name: '叶惠美', artist: { name: '周杰伦' }, size: 11 },
      ],
      []
    ),
    '周杰伦 叶惠美'
  );
  assert.equal(result.items[0].title, '叶惠美');
});

test('剪尾：搜歌名时靠歌曲命中把专辑捞上来，上游塞的无关项被去掉', async () => {
  const result = await discovery.discoverAlbums(
    searchCtx(
      emptyApp(),
      [{ id: 9, name: '无关合辑', artist: { name: '某人' }, size: 10 }],
      [{ id: 2, name: '晴天', ar: [{ name: '周杰伦' }], al: { id: 1, name: '叶惠美' } }]
    ),
    '晴天'
  );
  assert.deepEqual(Array.from(result.items, (x) => x.title), ['叶惠美']);
  assert.equal(result.items[0].matchedBy, 'track');
  assert.equal(result.items[0].score, 96, '歌名整体命中：专辑标题里没有它，分数只能给在歌曲上');
});

test('加载更多：把上游更深的一页并进池子重排，翻到底后不再要下一页', async () => {
  const offsets = [];
  // 首页一整页「沾边」的合辑：网易云一页给满 → 判定它还有下一页。
  // 第二页才出现正主（靠歌曲命中《My Story》），重排后要顶到最前。
  // 词得是本文件独占的：模块级的池子按词缓存，跟别的用例撞词会直接命中上一轮的池子。
  const filler = (base) => Array.from({ length: 30 }, (_, i) => ({
    id: 100 + base + i,
    name: `雨天 精选 ${base + i}`,
    artist: { name: '群星' },
    size: 5,
  }));
  const ctx = {
    app: emptyApp(),
    client: {
      searchAlbums: async (_query, page) => {
        offsets.push(page.offset);
        if (page.offset === 0) return { result: { albums: filler(0) } };
        if (page.offset === 30) return { result: { albums: filler(30).slice(0, 29) } };
        return { result: { albums: [] } };
      },
      searchSongs: async (_query, page) => ({
        result: { songs: page.offset === 30
          ? [{ id: 999, name: '雨天', ar: [{ name: '孙燕姿' }], al: { id: 1000, name: 'My Story' } }]
          : [] },
      }),
    },
    qq: { search: async () => ({ data: { albums: [], songs: [] } }) },
  };

  const first = await discovery.discoverAlbums(ctx, '雨天');
  assert.equal(first.items.length, 30, '首屏是一整页');
  assert.equal(first.hasMore, true);

  const second = await discovery.loadMoreAlbums(ctx, '雨天');
  assert.equal(second.items[0].title, 'My Story', '翻页拿到的正主重排后顶到最前');
  assert.equal(second.items.length, 60, '池子只长不缩：老条目还在，只是排在后面');
  assert.equal(second.hasMore, true);

  const third = await discovery.loadMoreAlbums(ctx, '雨天');
  assert.equal(third.hasMore, false, '上游这一页什么都没给 = 到底了');
  assert.equal(third.items.length, 60, '到底以后不再改结果');
  assert.deepEqual(offsets, [0, 30, 60], '到底之后不该再向上游要下一页');
});

// 下面两个用例会改动模块级的节流状态（缓存 / 冷却），必须放在文件末尾，
// 否则同一文件里前面的用例会被「冷却中不发请求」影响。

test('搜索节流：同一个词第二次搜索走缓存，不再打网络', async () => {
  const app = emptyApp();
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
  const app = emptyApp();
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
