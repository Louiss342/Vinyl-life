// 歌词纯逻辑回归（解析 / 定位 / 滚动计划 / 景深 / 行内推进）：
//   ① LRC 的坑：元数据行、一行多时间戳、小数位 1/2/3 位、乱序、间奏空行、翻译配对
//   ② 定位必须用二分（每帧都要问一次），边界是「最后一条 at ≤ t」
//   ③ 连续滚动：两行之间的全部时间都在走（没有静止期）、线性且单调、速度跟着行距走
//   ④ 景深档位：离当前行多远、封顶、还没唱到第一行时的口径
// 注：vm 里 map 出来的数组 / 字面量对象原型与测试 realm 不同，deepStrictEqual 会假红 ——
// 一律走 Array.from / 展开后再比。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/core/lyrics.ts')],
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
  TextDecoder, // 本地 .lrc 的字节解码要用（utf-8 / gbk）
});

const {
  parseLrc,
  activeLineIndex,
  scrollPlan,
  lineProgress,
  lineDepth,
  centerLineIndex,
  easeInOutCubic,
  decodeLyricBytes,
  MAX_LYRIC_DEPTH,
} = mod.exports;

// ============ A. 解析 ============

test('解析：时间戳三种小数位 + 元数据行 + 空行', () => {
  const lines = parseLrc(
    [
      '[ti:测试歌曲]',
      '[ar:测试歌手]',
      '[offset:0]',
      '',
      '[00:01.50]第一行（厘秒）',
      '[00:03.123]第二行（毫秒）',
      '[00:05.5]第三行（一位小数 = 百毫秒）',
    ].join('\n')
  );
  assert.deepEqual(
    Array.from(lines, (l) => [l.at, l.text]),
    [
      [1500, '第一行（厘秒）'],
      [3123, '第二行（毫秒）'],
      [5500, '第三行（一位小数 = 百毫秒）'],
    ],
    '元数据行不进歌词，三种小数位都要认'
  );
});

test('解析：一行挂多个时间戳 = 同一句唱两遍', () => {
  const lines = parseLrc('[00:10.00][01:20.00]副歌这一句');
  assert.deepEqual(Array.from(lines, (l) => l.at), [10000, 80000]);
  assert.equal(lines[1].text, '副歌这一句', '去掉时间戳后正文一致');
});

test('解析：乱序时间戳要排好序（二分的前提）', () => {
  const lines = parseLrc('[00:30.00]后\n[00:10.00]前');
  assert.deepEqual(Array.from(lines, (l) => l.text), ['前', '后']);
});

test('解析：只有时间戳的行 = 间奏（保留空文本，不能在解析阶段丢掉）', () => {
  const lines = parseLrc('[00:00.00]\n[00:05.00]开口');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, '', '间奏行留着：定位要对得上时间轴');
  assert.equal(lines[0].at, 0);
});

test('解析：翻译按时间戳配对，对不上的不硬塞', () => {
  const lines = parseLrc('[00:01.00]Hello\n[00:02.00]World', '[00:01.00]你好\n[00:09.00]没人理我');
  assert.equal(lines[0].trans, '你好');
  assert.equal(lines[1].trans, undefined, '时间戳对不上就不给翻译');
});

test('解析：整篇没有时间戳 → 空（宁可不显示，也不要一行行没时间的文字）', () => {
  for (const raw of ['这首歌没有时间轴', '', undefined]) {
    assert.equal(parseLrc(raw).length, 0, `不该解析出歌词行：${String(raw)}`);
  }
});

// ============ A2. 全局偏移（[offset:]） ============

test('偏移：正值 = 整篇提前（每行时间戳减去 offset）', () => {
  const lines = parseLrc('[offset:+500]\n[00:10.00]甲\n[00:20.00]乙');
  assert.deepEqual(
    Array.from(lines, (l) => l.at),
    [9500, 19500],
    '本地 .lrc 对不齐时全靠它，解错方向就是整篇系统性偏一口'
  );
});

test('偏移：负值 = 整篇延后；不带符号按正值算', () => {
  assert.deepEqual(
    Array.from(parseLrc('[offset:-200]\n[00:10.00]甲'), (l) => l.at),
    [10200]
  );
  assert.deepEqual(
    Array.from(parseLrc('[offset:300]\n[00:10.00]甲'), (l) => l.at),
    [9700]
  );
});

test('偏移：夹在 0 以上（补偿过头不留负时间戳）', () => {
  const lines = parseLrc('[offset:+5000]\n[00:01.00]甲\n[00:09.00]乙');
  assert.deepEqual(Array.from(lines, (l) => l.at), [0, 4000]);
  assert.equal(lines.length, 2, '行不能因为夹住就被合并掉');
});

test('偏移：没有这条标签就是 0；翻译跟主歌词共用同一份偏移', () => {
  assert.deepEqual(
    Array.from(parseLrc('[00:10.00]甲'), (l) => l.at),
    [10000],
    '普通歌词不受影响'
  );
  const withTrans = parseLrc('[offset:+500]\n[00:10.00]甲', '[00:10.00]A');
  assert.equal(withTrans[0].at, 9500);
  assert.equal(
    withTrans[0].trans,
    'A',
    '翻译与主歌词共用一份偏移 —— 各减各的会因时间戳不再全等而整篇配不上'
  );
});

// ============ A3. 字节解码（本地 .lrc） ============

const gbkOk = (() => {
  try {
    new TextDecoder('gbk');
    return true;
  } catch {
    return false; // 小 ICU 的 Node 构建：下面那条用例跳过，实现侧会自己退回 UTF-8
  }
})();

test('解码：UTF-8（含 BOM）原样解出，BOM 不进正文', () => {
  const text = '﻿[00:01.00]晴天';
  const decoded = decodeLyricBytes(new TextEncoder().encode(text));
  assert.equal(decoded.replace(/^﻿/, ''), '[00:01.00]晴天');
  assert.deepEqual(
    Array.from(parseLrc(decoded), (l) => [l.at, l.text]),
    [[1000, '晴天']],
    '带 BOM 也要能解析出歌词行（BOM 会让首行的标签判定失配）'
  );
});

test('解码：GBK 字节按 GBK 解（中文歌词站导出的 .lrc 至今仍有 GBK）', { skip: !gbkOk }, () => {
  // '晴天' 的 GBK 码位：晴 C7E7、天 CCEC；这串字节不是合法 UTF-8，宽松解会出替换符
  const bytes = Uint8Array.from([0xc7, 0xe7, 0xcc, 0xec]);
  assert.equal(decodeLyricBytes(bytes), '晴天');
});

test('解码：两种都不是（二进制垃圾）→ 不抛异常，也不返回空', { skip: !gbkOk }, () => {
  const bytes = Uint8Array.from([0x00, 0xff, 0xfe, 0x01, 0x80]);
  const text = decodeLyricBytes(bytes);
  assert.equal(typeof text, 'string');
});

// ============ B. 定位 ============

const L = parseLrc('[00:00.00]\n[00:05.00]A\n[00:10.00]B\n[00:15.00]C');

test('定位：最后一条 at ≤ t 的行；第一行之前是 -1', () => {
  assert.equal(activeLineIndex(L, -1), -1, '还没开始');
  assert.equal(activeLineIndex(L, 0), 0, '正好落在行首（含等于）');
  assert.equal(activeLineIndex(L, 4999), 0);
  assert.equal(activeLineIndex(L, 5000), 1);
  assert.equal(activeLineIndex(L, 12345), 2);
  assert.equal(activeLineIndex(L, 999999), 3, '过了最后一行停在最后一行');
  assert.equal(activeLineIndex([], 1000), -1, '没有歌词');
});

// ============ C. 连续滚动 ============

test('连续滚动：两行之间一直在走，走到下一行时刻正好落位', () => {
  // L = [00:00 间奏, 00:05 A, 00:10 B, 00:15 C]；t=6000 正在唱 A（index 1）
  const plan = scrollPlan(L, 6000);
  assert.equal(plan.from, 1, '从当前行出发');
  assert.equal(plan.to, 2, '目标是下一行');
  assert.ok(Math.abs(plan.progress - 0.2) < 1e-9, `进度 = 已唱时间占行距的比例（实际 ${plan.progress}）`);
  assert.equal(scrollPlan(L, 5000).progress, 0, '行首：正好停在当前行上');
  assert.ok(scrollPlan(L, 10000 - 0.001).progress > 0.999, '行尾：已经走到了下一行');
  // 关键差别（旧版是「换行前的窗口里才动、其余时间静止」）：行中间任意时刻都在走
  assert.ok(scrollPlan(L, 5200).progress > scrollPlan(L, 5100).progress, '行中间也在走');
});

test('连续滚动：线性且单调 —— 匀速、不会回弹', () => {
  // progress 到换行会归零（换的是「从哪一行走到哪一行」），所以单调要看**像素位置**：
  // 位置 = 从当前行中心走到下一行中心，视图就是这么插值的。行距 40px 的假像素位置。
  const px = (i) => i * 40;
  const posAt = (t) => {
    const p = scrollPlan(L, t);
    return px(p.from) + (px(p.to) - px(p.from)) * p.progress;
  };
  let last = -Infinity;
  for (let t = 5000; t <= 15000; t += 100) {
    const pos = posAt(t);
    assert.ok(pos >= last, '位置只朝一个方向走（回弹会让人看到画面倒退）');
    last = pos;
  }
  assert.equal(posAt(5000), px(1), '行首正好在当前行中心');
  assert.equal(posAt(10000), px(2), '换行那一刻正好落在下一行中心（位置连续，不会跳）');
  // 线性（不做缓动）：同一段行距里，等长时间走出等长距离
  const d1 = scrollPlan(L, 7000).progress - scrollPlan(L, 6000).progress;
  const d2 = scrollPlan(L, 9000).progress - scrollPlan(L, 8000).progress;
  assert.ok(Math.abs(d1 - d2) < 1e-9, '匀速 —— 缓动会在两端停下来，那正是要取消的静止期');
  assert.ok(Math.abs(d1 - 1000 / 5000) < 1e-9);
});

test('连续滚动：短句走得快、长句走得慢（速度跟着歌唱走）', () => {
  const fast = parseLrc('[00:00.00]一\n[00:00.60]二'); // 行距 600ms
  const slow = parseLrc('[00:00.00]一\n[00:12.00]二'); // 行距 12s
  assert.ok(Math.abs(scrollPlan(fast, 100).progress - 100 / 600) < 1e-9);
  assert.ok(Math.abs(scrollPlan(slow, 100).progress - 100 / 12000) < 1e-9);
  assert.ok(
    scrollPlan(fast, 100).progress > scrollPlan(slow, 100).progress,
    '同样走 100ms，行距短的走得更远'
  );
});

test('连续滚动：还没到第一行 / 已是最后一行 → 不动（没有可去的地方）', () => {
  const late = parseLrc('[00:10.00]一\n[00:20.00]二');
  const before = scrollPlan(late, 5000);
  assert.deepEqual({ ...before }, { from: 0, to: 0, progress: 0 }, '开场前停在第一行上');

  const after = scrollPlan(L, 20000);
  assert.equal(after.from, after.to, '最后一行之后没有下一行可去');
  assert.equal(after.progress, 0);
  assert.equal(scrollPlan([], 1000).from, 0, '没有歌词也不炸');
});

test('连续滚动：两行同一时刻 → 直接落位（行距为 0 不能除出 NaN）', () => {
  const same = parseLrc('[00:05.00]一\n[00:05.00]二');
  const plan = scrollPlan(same, 5000);
  assert.equal(plan.from, 1, '定位落在后一行（最后一条 at ≤ t）');
  assert.equal(plan.to, 1);
  assert.ok(Number.isFinite(plan.progress));
});

// ============ C2. 景深档位 ============

test('景深：离当前行多远（0 = 正在唱），唱过的与没唱的对称', () => {
  assert.equal(lineDepth(3, 3), 0, '正在唱的那一行');
  assert.equal(lineDepth(4, 3), 1);
  assert.equal(lineDepth(2, 3), 1, '唱过的和还没唱的，距离一样就一样近');
  assert.equal(lineDepth(0, 3), 3);
  assert.equal(lineDepth(0, MAX_LYRIC_DEPTH + 2), MAX_LYRIC_DEPTH, '封顶：更远的行已经在渐隐里了');
  assert.equal(lineDepth(99, 3), MAX_LYRIC_DEPTH, '越界也封顶');
});

test('景深：还没唱到第一行时，把第 0 行当作当前行', () => {
  assert.equal(lineDepth(0, -1), 0, '开场前第一行就该是清晰的那一句');
  assert.equal(lineDepth(1, -1), 1);
  assert.equal(lineDepth(99, -1), MAX_LYRIC_DEPTH);
});

// ============ C3. 视觉中心（滚动位置 → 画面正中是第几行） ============

test('视觉中心：取离容器正中最近的那一行', () => {
  const off = [60, 100, 140, 180]; // 各行中心的像素位置（升序）
  // 容器高 200 → 中心 = scrollTop + 100
  assert.equal(centerLineIndex(off, 0, 200), 1, '中心 100 正对第 2 行');
  assert.equal(centerLineIndex(off, 20, 200), 1, '中心 120：两行等距 → 取上面那一行（手往下滚时中心不该先跳）');
  assert.equal(centerLineIndex(off, 21, 200), 2, '中心 121：下面那行更近了');
  assert.equal(centerLineIndex(off, 9999, 200), 3, '滚过头 → 停在最后一行');
  assert.equal(centerLineIndex([50], 0, 200), 0, '只有一行');
  assert.equal(centerLineIndex([], 0, 200), -1, '还没有行');
});

test('视觉中心：随滚动位置单调 —— 往下滚，中心只会往后走', () => {
  const off = [60, 100, 140, 180, 220];
  let last = -1;
  for (let y = 0; y <= 300; y += 5) {
    const i = centerLineIndex(off, y, 200);
    assert.ok(i >= last, `y=${y} 时中心回退了（${i} < ${last}）`);
    last = i;
  }
});

test('回位缓动：两端为 0 / 1，中点 0.5，单调，越界夹住', () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(0.5), 0.5);
  assert.equal(easeInOutCubic(-1), 0, '越界夹住');
  assert.equal(easeInOutCubic(2), 1);
  let last = -1;
  for (let i = 0; i <= 20; i++) {
    const v = easeInOutCubic(i / 20);
    assert.ok(v >= last, '单调不减（回位不能倒着走）');
    last = v;
  }
});

// ============ D. 行内推进（卡拉OK填充） ============

test('行内推进：按到下一行的距离算，间奏行不做填充', () => {
  assert.equal(lineProgress(L, 1, 5000), 0, '刚进这一行');
  assert.equal(lineProgress(L, 1, 7500), 0.5, '行中间一半');
  assert.equal(lineProgress(L, 2, 99999), 1, '越界夹在 1');
  assert.equal(lineProgress(L, 0, 2000), 1, '间奏行（没有文字）不填充');
  assert.equal(lineProgress(L, -1, 2000), 1, '还没到第一行');
  assert.equal(lineProgress(L, 3, 15500), 0.125, '最后一行按 4 秒兜底');
});
