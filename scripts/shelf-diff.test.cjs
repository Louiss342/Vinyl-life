// 专辑墙卡片增量的决策回归（core/shelf-diff）：谁撤、谁留着、谁重画。两头都会出错，两头都不报错：
//   判粗了（该留的也重画）→ 改一个属性重建上千张卡片、滚动位置与焦点一起丢（就是这次的病灶）；
//   判细了（该重画的留着了）→ 换了封面墙上是旧图、加了音源点卡片还是打开笔记（最难发现）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/core/shelf-diff.ts')],
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
const { cardSignature, planCards } = mod.exports;

// vm 沙箱里的数组原型与测试侧不同：deepEqual 会判不等，比 JSON 形状（与 media-session 同一路数）
const eq = (actual, expected, msg) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), msg);

const album = (over = {}) => ({
  path: 'Vinyl Life/Vinyl Note/A.md',
  displayProps: { artist: 'A', year: '1997' },
  cover: 'app://old.png',
  edition: 'Original',
  ...over,
});
const flags = (over = {}) => ({ local: false, netease: true, qq: false, kugou: false, ...over });
const KEYS = ['artist', 'year'];

test('签名：卡片上画出来的字段一个都不能漏（漏了就是「该重画的留着了」）', () => {
  const base = cardSignature(album(), flags(), KEYS);
  assert.notEqual(
    cardSignature(album({ cover: 'app://new.png' }), flags(), KEYS),
    base,
    '换封面'
  );
  assert.notEqual(cardSignature(album({ edition: 'Remastered' }), flags(), KEYS), base, '改版本');
  assert.notEqual(
    cardSignature(album({ displayProps: { artist: 'B', year: '1997' } }), flags(), KEYS),
    base,
    '改已显示的属性'
  );
  assert.notEqual(
    cardSignature(album(), flags({ local: true }), KEYS),
    base,
    '加了本地音源（否则点卡片还是打开笔记）'
  );
  assert.equal(cardSignature(album(), flags(), KEYS), base, '什么都没改 → 签名不变');
});

test('签名：没在卡片上显示的属性不进签名（否则改笔记里的其它字段也会重画整墙）', () => {
  const base = cardSignature(album(), flags(), KEYS);
  assert.equal(
    cardSignature(album({ displayProps: { artist: 'A', year: '1997', genre: 'Jazz' } }), flags(), KEYS),
    base,
    'genre 没被勾选显示 → 不进签名'
  );
  assert.notEqual(
    cardSignature(album({ displayProps: { artist: 'A', year: '1997', genre: 'Jazz' } }), flags(), [
      'artist',
      'year',
      'genre',
    ]),
    base,
    '一旦勾选显示，它就要进签名'
  );
});

test('签名：值里出现分隔符也不串味（拼字符串的写法会在这里出错）', () => {
  const a = cardSignature(album({ path: 'x', displayProps: { artist: 'ab', year: '' } }), flags(), ['artist', 'year']);
  const b = cardSignature(album({ path: 'xa', displayProps: { artist: 'b', year: '' } }), flags(), ['artist', 'year']);
  assert.notEqual(a, b, '不同字段切分出的字符串必须不同');
});

test('计划：全新的墙 → 全部新建、没有要撤的', () => {
  const plan = planCards(new Map(), [
    { path: 'a.md', sig: '1' },
    { path: 'b.md', sig: '2' },
  ]);
  eq(plan.remove, []);
  eq(
    plan.order.map((o) => o.action),
    ['create', 'create']
  );
  eq(
    plan.order.map((o) => o.path),
    ['a.md', 'b.md'],
    '顺序照显示顺序给'
  );
});

test('计划：什么都没变 → 全部复用（这是「改一个属性不再重建整墙」的核心）', () => {
  const prev = new Map([
    ['a.md', '1'],
    ['b.md', '2'],
  ]);
  const plan = planCards(prev, [
    { path: 'a.md', sig: '1' },
    { path: 'b.md', sig: '2' },
  ]);
  eq(plan.remove, []);
  eq(
    plan.order.map((o) => o.action),
    ['reuse', 'reuse']
  );
});

test('计划：只有一张变了 → 只有那张重画', () => {
  const prev = new Map([
    ['a.md', '1'],
    ['b.md', '2'],
    ['c.md', '3'],
  ]);
  const plan = planCards(prev, [
    { path: 'a.md', sig: '1' },
    { path: 'b.md', sig: 'CHANGED' },
    { path: 'c.md', sig: '3' },
  ]);
  eq(plan.remove, []);
  eq(
    plan.order.map((o) => o.action),
    ['reuse', 'rebuild', 'reuse']
  );
});

test('计划：排序换了顺序 → 只挪位置，不重画（内容没变）', () => {
  const prev = new Map([
    ['a.md', '1'],
    ['b.md', '2'],
  ]);
  const plan = planCards(prev, [
    { path: 'b.md', sig: '2' },
    { path: 'a.md', sig: '1' },
  ]);
  eq(plan.remove, []);
  eq(
    plan.order.map((o) => o.action),
    ['reuse', 'reuse']
  );
  eq(
    plan.order.map((o) => o.path),
    ['b.md', 'a.md']
  );
});

test('计划：搜索 / 筛选把一部分挡掉 → 挡掉的撤、留下的复用', () => {
  const prev = new Map([
    ['a.md', '1'],
    ['b.md', '2'],
  ]);
  const plan = planCards(prev, [{ path: 'b.md', sig: '2' }]);
  eq(plan.remove, ['a.md']);
  eq(
    plan.order.map((o) => o.action),
    ['reuse']
  );
});

test('计划：笔记改名 = 旧的撤 + 新的建（不去猜是不是同一张）', () => {
  const prev = new Map([['A.md', 'sig-old']]);
  const plan = planCards(prev, [{ path: 'A (Remastered).md', sig: 'sig-new' }]);
  eq(plan.remove, ['A.md']);
  eq(
    plan.order.map((o) => o.action),
    ['create']
  );
});

test('签名：笔记里的 id / 音频目录 / 源偏好变了，卡片必须重画', () => {
  // 这些字段不画在卡片上，但点击闭包握着的那份 AlbumInfo 里有：签名不含它们的话，改了 neteaseId（或走「切换音源」把 source 写回笔记）之后卡片被复用，
  // 点下去按旧 id / 旧目录建队列 —— 播的是另一张专辑，且要等这张卡因别的原因重画才自愈。
  const base = {
    path: 'A.md',
    displayProps: {},
    cover: '',
    edition: '',
    neteaseId: 1,
    qqId: '',
    kugouId: '',
    audioFolderRef: '',
    audioRefs: [],
    sourcePref: 'auto',
  };
  const flags = { local: false, netease: true, qq: false, kugou: false };
  const sig = (over, labels) => cardSignature({ ...base, ...over }, flags, ['year'], labels);
  const plain = sig({});

  assert.notEqual(sig({ neteaseId: 2 }), plain, 'neteaseId 改了');
  assert.notEqual(sig({ qqId: 'mid' }), plain, 'qqId 改了');
  assert.notEqual(sig({ kugouId: '42' }), plain, 'kugouId 改了');
  assert.notEqual(sig({ audioFolderRef: 'Vinyl Life/Audio/B' }), plain, '音频目录改了');
  assert.notEqual(sig({ audioRefs: ['Vinyl Life/Audio/B/01.mp3'] }), plain, 'audio 列表改了');
  assert.notEqual(sig({ sourcePref: 'qq' }), plain, '笔记指定了音源');
  assert.notEqual(sig({}, { year: '发行年' }), plain, '属性显示名改了（卡片上的 aria-label 用它）');
  assert.equal(sig({}), plain, '内容一样就一样：别每次刷新都白重画');
});

test('签名：只变「有没有音源」这四个布尔时仍然重画（旧口径不能丢）', () => {
  const album = {
    path: 'A.md',
    displayProps: {},
    cover: '',
    edition: '',
    neteaseId: 1,
    audioRefs: [],
    sourcePref: 'auto',
  };
  const off = { local: false, netease: false, qq: false, kugou: false };
  const on = { local: true, netease: false, qq: false, kugou: false };
  assert.notEqual(cardSignature(album, off, []), cardSignature(album, on, []), '拖音频进专辑：角标与点击行为都变');
});
