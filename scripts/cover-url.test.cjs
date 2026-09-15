// 封面候选链回归：QQ 封面地址是拼出来的（y.gtimg.cn），部分网络下该 CDN 不可达 →
// 同路径换 y.qq.com 备用图床；网易云等接口直给的地址不受影响；库内封面优先、色值不当图片用。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/core/cover-url.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
}).outputFiles[0].text;

const mod = { exports: {} };
vm.runInNewContext(source, { module: mod, exports: mod.exports, console });
const { coverCandidates, coverChain } = mod.exports;

const MID = '001mvhPh0qevad';
const GTIMG = `https://y.gtimg.cn/music/photo_new/T002R300x300M000${MID}.jpg`;
const MIRROR = `https://y.qq.com/music/photo_new/T002R300x300M000${MID}.jpg`;

test('coverCandidates：QQ 封面主图床在前、备用图床在后（两个主机互相可回退）', () => {
  assert.deepEqual(Array.from(coverCandidates(GTIMG)), [GTIMG, MIRROR]);
  assert.deepEqual(Array.from(coverCandidates(MIRROR)), [MIRROR, GTIMG]);
});

test('coverCandidates：非 QQ 封面（网易云等）原样返回，不做加工', () => {
  const ne = 'https://p1.music.126.net/abc/cover.jpg?param=300y300';
  assert.deepEqual(Array.from(coverCandidates(ne)), [ne]);
  // 同主机但不在 /music/photo_new/ 下的地址也不换（不误伤 y.qq.com 的其它资源）
  const other = 'https://y.gtimg.cn/other/whatever.jpg';
  assert.deepEqual(Array.from(coverCandidates(other)), [other]);
});

test('coverCandidates：空值返回空表', () => {
  assert.deepEqual(Array.from(coverCandidates('')), []);
  assert.deepEqual(Array.from(coverCandidates(undefined)), []);
  assert.deepEqual(Array.from(coverCandidates('   ')), []);
});

test('coverChain：库内封面优先 → 远程封面 → 备用图床（去重、滤空、滤色值）', () => {
  assert.deepEqual(Array.from(coverChain('app://local/cover.jpg', GTIMG)), [
    'app://local/cover.jpg',
    GTIMG,
    MIRROR,
  ]);
  assert.deepEqual(Array.from(coverChain(undefined, GTIMG)), [GTIMG, MIRROR]);
  assert.deepEqual(Array.from(coverChain(GTIMG, GTIMG)), [GTIMG, MIRROR], '库内与远程同一地址不重复');
  assert.deepEqual(Array.from(coverChain('#222', undefined)), [], '色值是专辑墙的占位底色，不是图片');
  assert.deepEqual(Array.from(coverChain('', '  ')), []);
});

// 播放器接线（DOM 事件无法在纯 Node 用例里驱动，按仓库惯例用源码扫描锁住行为）
test('播放器接线：唱片封面走候选链、加载失败逐个回退、耗尽回占位', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/views/player-view.ts'), 'utf8');
  assert.match(
    src,
    /import \{ coverChain \} from '\.\.\/core\/cover-url'/,
    '候选链要复用共享实现，别在视图里各写一份'
  );
  assert.match(src, /coverChain\(this\.localCover\(s\), s\.current\?\.cover\)/, '链 = 库内封面优先 + 远程候选');
  assert.match(src, /labelImg\.onerror = \(\) => this\.showCover\(els, i \+ 1\)/, '当前候选加载失败换下一个');
  assert.match(
    src,
    /labelImg\.addClass\('vinyl-hidden'\);\s*?\r?\n\s*els\.labelEmpty\.removeClass\('vinyl-hidden'\)/,
    '候选耗尽回占位符（不是停在空白）'
  );
});
