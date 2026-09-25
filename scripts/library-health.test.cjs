// 收藏健康检查回归：
//   A 扫描分档 —— 失效引用 / 指定音源不可用 / 播放失败是**错误**，无音源、无封面是**提示**，
//     标了 collectOnly 的专辑连提示都不出（评审意见第 1 条：别让有意只收藏的乐评淹没待办）；
//   B 试播范围 —— 全部已关联 / 仅每张实际会用的 / 仅上次失败的（评审意见第 4 条）。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/core/library-health.ts')],
  bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'],
}).outputFiles[0].text;
// TFile 必须是**同一个类**：模块里靠 instanceof 判「是不是库内文件」，
// 各写各的类永远判不出来（踩过一次）
class TFile {
  constructor(name) { this.name = name; }
}
const mod = { exports: {} };
new Function('require', 'module', 'exports', source)(
  (name) => name === 'obsidian' ? {
    TFile, TFolder: class {}, normalizePath: (value) => value,
  } : require(name), mod, mod.exports
);
const { scanLibraryHealth, probeJobs, normalizeProbeScope } = mod.exports;
// app 桩：默认什么都找不到（库外路径失效那条用例靠它），只放行一首「库内音频」
// —— 「实际会用的音源」那条用例需要本地音源真的成立。
const app = {
  vault: {
    getAbstractFileByPath: (p) => (p === 'Music/local.mp3' ? new TFile('local.mp3') : null),
  },
};

const missing = path.join(process.cwd(), '__vinyl_health_missing__', 'song.mp3');

test('健康检查区分缺失路径、封面、音源和已知播放失败', () => {
  const empty = {
    path: 'A.md', title: 'A', audioRefs: [missing], sourcePref: 'auto',
  };
  const online = {
    path: 'B.md', title: 'B', cover: 'https://example.com/cover.jpg',
    audioRefs: [], neteaseId: 42, sourcePref: 'netease',
  };
  const issues = scanLibraryHealth(app, [empty, online], {
    'B.md:netease': { message: 'Unavailable', at: 1 },
  });
  assert.deepEqual(issues.map((issue) => [issue.album.path, issue.kind]), [
    ['A.md', 'external'], ['A.md', 'cover'], ['A.md', 'source'], ['B.md', 'playback'],
  ]);
});

test('分档：坏的算错误，缺音源 / 缺封面算提示', () => {
  const review = { path: 'R.md', title: '乐评', audioRefs: [], sourcePref: 'auto' }; // 无音源无封面
  const broken = {
    path: 'X.md', title: 'X', audioRefs: [missing], cover: 'https://example.com/c.jpg',
    neteaseId: 7, sourcePref: 'qq', // 笔记里指定了 QQ，但这张压根没有 QQ 音源
  };
  const issues = scanLibraryHealth(app, [review, broken], {
    'X.md:netease': { message: 'Unavailable', at: 1234 },
  });
  const byKey = new Map(issues.map((issue) => [`${issue.album.path}:${issue.kind}`, issue]));
  assert.equal(byKey.get('R.md:source').severity, 'note', '一个音源都没有：提示');
  assert.equal(byKey.get('R.md:cover').severity, 'note');
  assert.equal(byKey.get('X.md:external').severity, 'error', '库外路径失效：错误');
  assert.equal(byKey.get('X.md:source').severity, 'error', '指定的音源没了：错误');
  assert.equal(byKey.get('X.md:source').detail, 'qq', '错误里点名是哪个音源');
  assert.equal(byKey.get('X.md:playback').severity, 'error');
  assert.equal(byKey.get('X.md:playback').at, 1234, '播放失败带上发生时间，界面要标「什么时候坏的」');
});

test('仅收藏（collectOnly）：无音源 / 无封面的提示不再出，失效引用与播放失败照旧报错', () => {
  const collectOnly = {
    path: 'C.md', title: '只收藏', audioRefs: [missing], sourcePref: 'auto', collectOnly: true,
  };
  const plain = { path: 'P.md', title: '普通', audioRefs: [], sourcePref: 'auto' };
  const issues = scanLibraryHealth(app, [collectOnly, plain], {
    'C.md:auto': { message: 'Unavailable', at: 9 },
  });
  assert.deepEqual(
    issues.map((issue) => [issue.album.path, issue.kind, issue.severity]),
    [
      ['C.md', 'external', 'error'], // 引用坏了就是坏了，与「仅收藏」无关
      ['C.md', 'playback', 'error'],
      ['P.md', 'cover', 'note'],
      ['P.md', 'source', 'note'],
    ]
  );
});

// ============ 试播范围 ============

const album = (path, extra) => ({ path, title: path, audioRefs: [], sourcePref: 'auto', ...extra });

test('试播范围：全部（只在线）/ 仅实际会用的 / 仅上次失败的', () => {
  const both = album('both.md', { neteaseId: 1, qqId: 'm1' });        // 自动：网易云优先
  const localFirst = album('local.md', { neteaseId: 2, audioRefs: ['Music/local.mp3'] }); // 本地优先 → 在线不试
  const kg = album('kg.md', { kugouId: 'k1' });
  const prefQq = album('pref.md', { neteaseId: 3, qqId: 'm3', sourcePref: 'qq' }); // 指定 QQ
  const albums = [both, localFirst, kg, prefQq];
  const failures = { 'kg.md:kugou': { message: 'bad', at: 1 } };
  const keys = (jobs) => jobs.map((job) => `${job.album.path}:${job.source}`);

  assert.deepEqual(keys(probeJobs(app, albums, failures, 'all')), [
    'both.md:netease', 'both.md:qq', 'local.md:netease', 'kg.md:kugou', 'pref.md:netease', 'pref.md:qq',
  ]);
  assert.deepEqual(keys(probeJobs(app, albums, failures, 'current')), [
    'both.md:netease', // 自动：按 本地 > 网易云 > QQ > 酷狗 取第一个可用的在线源
    'kg.md:kugou',
    'pref.md:qq', // 笔记里指定了 QQ，就只试 QQ
  ]);
  assert.deepEqual(keys(probeJobs(app, albums, failures, 'failing')), ['kg.md:kugou']);
  assert.equal(probeJobs(app, albums, {}, 'failing').length, 0, '没有失败记录时范围是空的');

  assert.equal(normalizeProbeScope('current'), 'current');
  assert.equal(normalizeProbeScope('nonsense'), 'all');
  assert.equal(normalizeProbeScope(undefined), 'all');
});
