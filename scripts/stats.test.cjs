const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/core/stats.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
}).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(source, { module: mod, exports: mod.exports, Date, Map, Object, Array, isFinite });
const {
  calendarColumns,
  calendarMonthLabels,
  ensureStats,
  localDayKey,
  playsByDay,
  recentAlbums,
  recordTrackPlay,
  retainPlayEvents,
  TRIM_TARGET_EVENTS,
  needsRetention,
  trimPlayEvents,
  normalizePlayEvents,
  MAX_PLAY_EVENTS,
  PLAY_EVENT_RETENTION_MS,
  startOfLocalDay,
} = mod.exports;

test('裁剪把「留哪些 / 丢哪些」都交出来（裁剪前归档靠它）', () => {
  const now = Date.now();
  const old = { at: now - PLAY_EVENT_RETENTION_MS - 1, trackKey: 'old' };
  const older = { at: now - PLAY_EVENT_RETENTION_MS - 5000, trackKey: 'older' };
  const fresh = { at: now - 1000, trackKey: 'fresh' };
  const { kept, dropped } = trimPlayEvents([older, old, fresh], now);
  assert.deepEqual(kept.map((e) => e.trackKey), ['fresh']);
  assert.deepEqual(dropped.map((e) => e.trackKey), ['older', 'old'], '丢掉的是过期的那批，顺序不变');
  assert.deepEqual(trimPlayEvents([fresh], now).dropped, [], '没有要丢的就给空数组');
});

test('明细归一：脏数据一律丢弃（加载与归档共用同一份口径）', () => {
  const now = Date.now();
  const events = normalizePlayEvents([
    { at: now, trackKey: 'ok' },
    { at: now, trackKey: 'with album', albumPath: 'A.md' },
    null,
    'nonsense',
    { at: 0, trackKey: 'zero' },
    { at: NaN, trackKey: 'nan' },
    { at: now },
    { trackKey: 'no-at' },
  ]);
  // 跨 vm 边界的对象原型不同，先摊平成普通对象再比（同文件里 plain 的用法）
  assert.deepEqual(plain(events), [
    { at: now, trackKey: 'ok' },
    { at: now, trackKey: 'with album', albumPath: 'A.md' },
  ]);
  assert.equal(normalizePlayEvents(undefined).length, 0, '没有明细表就当空（原型跨 vm，只比长度）');
});

test('播放明细按时间与数量保留，累计次数不受裁剪影响', () => {
  const now = Date.now();
  const old = { at: now - PLAY_EVENT_RETENTION_MS - 1, trackKey: 'old' };
  const recent = Array.from({ length: MAX_PLAY_EVENTS + 2 }, (_, i) => ({ at: now - 1000 + i, trackKey: String(i) }));
  const kept = retainPlayEvents([old, ...recent], now);
  // 超上限时按**低水位**裁一批（裁到 45,000 而不是刚好 50,000）：不然连续播放时每条播放
  // 都会重新越界一次，等于每条播放都要归档 + 裁剪一次
  assert.equal(kept.length, TRIM_TARGET_EVENTS);
  assert.equal(kept[0].trackKey, String(MAX_PLAY_EVENTS + 2 - TRIM_TARGET_EVENTS));
  assert.equal(
    retainPlayEvents(recent.slice(0, MAX_PLAY_EVENTS), now).length,
    MAX_PLAY_EVENTS,
    '刚好到上限不裁'
  );
  const stats = ensureStats({ totalPlays: 123, events: [old] });
  assert.equal(stats.totalPlays, 123);
  assert.equal(stats.events.length, 0);
});

const plain = (value) => JSON.parse(JSON.stringify(value));

test('旧版统计升级：聚合数保留，日历事件从空表开始', () => {
  const stats = ensureStats({
    totalPlays: 8,
    albums: { 'A.md': { plays: 5, lastPlayedAt: 123, lastTrack: 'Song' } },
    tracks: { x: { plays: 8, lastPlayedAt: 123 } },
  });
  assert.equal(stats.totalPlays, 8);
  assert.equal(stats.albums['A.md'].plays, 5);
  assert.deepEqual(plain(stats.events), []);
});

test('记录播放：同一时刻同时更新总数、专辑、曲目、日历事件与快照', () => {
  const stats = ensureStats(null);
  const at = new Date(2026, 8, 17, 10, 30).getTime();
  recordTrackPlay(
    stats,
    'ne:1',
    'Vinyl Life/Vinyl Note/A.md',
    'A',
    'Track 1',
    { title: 'A', artist: 'Artist', displayProps: { artist: 'Artist', year: '2026' } },
    at
  );
  assert.equal(stats.totalPlays, 1);
  assert.equal(stats.tracks['ne:1'].lastPlayedAt, at);
  assert.equal(stats.albums['Vinyl Life/Vinyl Note/A.md'].lastTrack, 'Track 1');
  assert.equal(stats.albums['Vinyl Life/Vinyl Note/A.md'].snapshot.artist, 'Artist');
  assert.deepEqual(plain(stats.events), [
    { at, albumPath: 'Vinyl Life/Vinyl Note/A.md', trackKey: 'ne:1' },
  ]);
  assert.equal(playsByDay(stats).get(localDayKey(at)).length, 1);
});

test('快照渐进更新：新元数据覆盖旧值，未重新采集的缓存封面保留', () => {
  const stats = ensureStats(null);
  const path = 'A.md';
  recordTrackPlay(stats, 'x', path, 'A', 'One', { title: 'A', artist: 'Old', cachedCover: '.stats-covers/a.jpg' }, 1);
  recordTrackPlay(stats, 'y', path, 'A', 'Two', { title: 'A', artist: 'New' }, 2);
  assert.deepEqual(plain(stats.albums[path].snapshot), {
    title: 'A',
    artist: 'New',
    cachedCover: '.stats-covers/a.jpg',
  });
});

test('最近专辑优先使用快照标题，便于删除笔记后仍显示原名', () => {
  const stats = ensureStats({
    totalPlays: 1,
    albums: { 'old/path.md': { plays: 1, lastPlayedAt: 10, snapshot: { title: '原专辑名' } } },
    tracks: {},
    events: [],
  });
  assert.deepEqual(plain(recentAlbums(stats, 1)), [{ path: 'old/path.md', title: '原专辑名' }]);
});

// ============ 日历热力图：列序（时间倒序）============
// 需求：今天必须在最前面（第 0 列），而不是横铺 53 周后落在最右一列要拖滚动条才看得见。
const ymd = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const minus7 = (d) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - 7);
  return x;
};

test('日历：时间倒序 —— 第 0 列是含今天的那一周，往右每列回退一周', () => {
  const today = new Date(2026, 8, 17); // 2026-09-17 周四
  const cols = calendarColumns(today);
  assert.equal(cols.length, 53, '铺满 53 列（一年零几天）');
  assert.equal(cols[0].days.length, 7, '每列 7 格');
  assert.equal(ymd(cols[0].days[0]), '2026-9-13', '第 0 列第一格 = 本周日');
  assert.equal(ymd(cols[0].days[6]), '2026-9-19', '第 0 列最后一格 = 本周六');
  assert.equal(ymd(cols[0].days[today.getDay()]), ymd(today), '今天在第 0 列、第「星期几」格');
  assert.equal(ymd(cols[52].days[6]), '2025-9-20', '末列收在一年前那一周的周六');
  for (let c = 1; c < cols.length; c++) {
    assert.equal(ymd(cols[c].days[0]), ymd(minus7(cols[c - 1].days[0])), `第 ${c} 列比左邻早一周`);
  }
});

test('日历：任意星期几，今天都落在第 0 列（周日第一格 / 周六最后一格）', () => {
  for (const day of [1, 5, 6, 7, 12, 17, 19]) {
    const today = new Date(2026, 8, day);
    const cols = calendarColumns(today);
    assert.equal(ymd(cols[0].days[today.getDay()]), ymd(today), `9-${day} 在第 0 列`);
  }
});

test('日历：月份标题跟着时间倒序（当前月在最左），每段连续、相邻段正好差一个月', () => {
  const today = new Date(2026, 8, 17);
  const labels = calendarMonthLabels(calendarColumns(today), today);
  assert.equal(labels[0].column, 0, '当前月的标题落在第 0 列');
  assert.equal(labels[0].month.getMonth(), 8, '最左那段是 9 月');
  assert.equal(
    labels.reduce((n, l) => n + l.span, 0),
    53,
    '各段列数加起来 = 全表（漏一列就会错位）'
  );
  for (let i = 1; i < labels.length; i++) {
    const prev = labels[i - 1].month;
    const cur = labels[i].month;
    const gap = prev.getFullYear() * 12 + prev.getMonth() - (cur.getFullYear() * 12 + cur.getMonth());
    assert.equal(gap, 1, `${i} 段：往右正好回退一个月，不漏月`);
    assert.equal(labels[i].column, labels[i - 1].column + labels[i - 1].span, '标题落在这段的第一列');
  }
  assert.equal(labels[labels.length - 1].month.getFullYear(), 2025, '最右那段是去年');
});

test('日历：月初那周只占 1 列 —— 段宽为 1 时标题要右对齐，别压住下一段', () => {
  const today = new Date(2026, 8, 1); // 9 月 1 日（周二）：本周日 8/30 起，9 月只占末尾几天
  const cols = calendarColumns(today);
  assert.equal(ymd(cols[0].days[today.getDay()]), '2026-9-1');
  const labels = calendarMonthLabels(cols, today);
  assert.equal(labels[0].span, 1, '9 月这段只有 1 列 → stats-page 会挂 is-narrow');
  assert.equal(labels[0].month.getMonth(), 8);
  assert.equal(labels[1].month.getMonth(), 7, '右边紧接着是 8 月');
});

test('日历：跨月的那一周归给「最新一天」所在的月份（边界周不会两边都不认）', () => {
  // 2026-08-30(周日) ~ 09-05(周六)：7 天里 5 天是 9 月 → 这一列算 9 月
  const today = new Date(2026, 8, 20); // 周日：第 0 列 = 9/20~9/26，整列都在 9 月
  const cols = calendarColumns(today);
  assert.equal(ymd(cols[3].days[0]), '2026-8-30');
  assert.equal(ymd(cols[3].days[6]), '2026-9-5');
  const labels = calendarMonthLabels(cols, today);
  const covering = labels.find((l) => l.column <= 3 && l.column + l.span > 3);
  assert.equal(covering.column, 0, '9 月这段从第 0 列起');
  assert.equal(covering.span, 4, '9/20、9/13、9/6、8/30 这四列都属于 9 月');
  assert.equal(covering.month.getMonth(), 8);
  // 再往右才是 8 月
  assert.equal(ymd(cols[4].days[6]), '2026-8-29');
  assert.equal(labels[1].column, 4);
  assert.equal(labels[1].month.getMonth(), 7);
});

test('日历：未来格只出现在第 0 列（今天之后那几天），不会把整列铺满', () => {
  const today = new Date(2026, 8, 17); // 周四 → 周五、周六是未来
  const cols = calendarColumns(today);
  const future = cols.map((col) => col.days.filter((d) => d.getTime() > today.getTime()).length);
  assert.deepEqual(plain(future), [2, 0, 0, ...new Array(50).fill(0)], '只有第 0 列有未来格');
  assert.equal(ymd(startOfLocalDay(today)), '2026-9-17', '本地零点（日历按日对齐）');
});
