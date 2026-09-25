// 队列笔记回归（1.3.0 起：**可见的曲目列表就是数据源**）。
// 背景：早先版本在笔记末尾藏一段 JSON 标记，人能读的列表只是投影 —— 用户改了列表，
// 载入结果纹丝不动（评审意见第 5 条）。现在只认列表，这里锁住三件事：
//   ① 写出去的列表能被原样解析回来（含曲名里带「 · 」这种边界）；
//   ② 用户手改列表（删行 / 换序 / 改曲名）就是改队列；
//   ③ 曲名 → 曲目的匹配：精确命中，退一步只认**唯一**的近似命中，歧义宁可跳过。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/core/queue-note.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
}).outputFiles[0].text;
const mod = { exports: {} };
new Function('module', 'exports', source)(mod, mod.exports);
const { parseQueueEntries, queueNoteLines, pickTrackByTitle } = mod.exports;

// 与 main.ts 的 albumWikiLink 同一口径（有名字走别名，没有就裸路径）
const link = (p, name) => (name ? `[[${p}|${name}]]` : `[[${p}]]`);
const note = (...lines) =>
  ['---', 'tags: [vinyl-queue]', '---', '', '# 我的播放队列', '', '> 这份列表就是队列', '', ...lines, ''].join('\n');

const track = (title, albumPath, album) => ({
  title,
  album,
  albumNotePath: albumPath,
  source: 'local-vault',
  path: `/music/${title}.mp3`,
});

test('写出去的曲目列表能被原样解析回来', () => {
  const tracks = [
    track('One', 'A.md', 'Album A'),
    track('Two', 'B.md', 'Album B'),
    { ...track('NoNote', 'C.md', 'Album C'), albumNotePath: undefined }, // 没有专辑笔记的不写进列表
  ];
  const lines = queueNoteLines(tracks, link);
  assert.deepEqual(lines, ['- [[A.md|Album A]] · One', '- [[B.md|Album B]] · Two']);
  assert.deepEqual(parseQueueEntries(note(...lines)), [
    { albumPath: 'A.md', trackTitle: 'One' },
    { albumPath: 'B.md', trackTitle: 'Two' },
  ]);
});

test('曲名里带分隔符 / 换行：解析只吃第一个 wikilink，剩下的都算曲名', () => {
  const lines = queueNoteLines(
    [track('A · B', 'A.md', 'Album · 名字里有分隔符'), track('多\n行', 'B.md', 'B')],
    link
  );
  // 换行在存盘时压成空格（Markdown 列表一行一首）
  assert.deepEqual(parseQueueEntries(note(...lines)), [
    { albumPath: 'A.md', trackTitle: 'A · B' },
    { albumPath: 'B.md', trackTitle: '多 行' },
  ]);
});

test('用户手改列表 = 改队列（删行 / 换序 / 改曲名）', () => {
  const markdown = note('- [[A.md|A]] · One', '- [[B.md|B]] · Two', '- [[C.md|C]] · Three');
  assert.deepEqual(parseQueueEntries(markdown).map((e) => e.trackTitle), ['One', 'Two', 'Three']);

  const edited = note('- [[C.md|C]] · Three 改名版', '- [[A.md|A]] · One');
  assert.deepEqual(parseQueueEntries(edited), [
    { albumPath: 'C.md', trackTitle: 'Three 改名版' },
    { albumPath: 'A.md', trackTitle: 'One' },
  ]);
});

test('说明文字 / 标题 / 没有 wikilink 的行都不算曲目；旧笔记里的隐藏标记也不再被当成队列', () => {
  const mixed = note(
    '这里是随手写的说明',
    '- 只有曲名没有链接',
    '* [[A.md]] 漏了分隔符也能认',
    '<!-- vinyl-life-queue-v1',
    '[{"albumPath":"Z.md","trackKey":"ne:1"}]',
    '-->'
  );
  assert.deepEqual(parseQueueEntries(mixed), [{ albumPath: 'A.md', trackTitle: '漏了分隔符也能认' }]);
  assert.deepEqual(parseQueueEntries('# 一篇普通笔记\n\n没有列表'), []);
});

test('曲名 → 曲目：精确优先；只认「专辑那侧多一截后缀」且唯一的候选，歧义 / 打错字跳过', () => {
  const tracks = [
    { title: 'Song', album: 'A', source: 'local-vault', path: '/a/1.mp3' },
    { title: 'Song (Live)', album: 'A', source: 'local-vault', path: '/a/2.mp3' },
    { title: 'Other', album: 'A', source: 'local-vault', path: '/a/3.mp3' },
  ];
  assert.equal(pickTrackByTitle(tracks, 'song')?.title, 'Song', '忽略大小写与首尾空白');
  assert.equal(pickTrackByTitle(tracks, '  Song  ')?.title, 'Song');
  assert.equal(pickTrackByTitle(tracks, 'Other')?.title, 'Other');
  assert.equal(pickTrackByTitle(tracks, '找不到'), undefined);
  assert.equal(pickTrackByTitle(tracks, 'So'), undefined, '两首都以 So 开头：歧义宁可跳过');
  assert.equal(pickTrackByTitle(tracks, 'Song (Liv)'), undefined, '打错字的长名字不能掉到短曲目上');

  // 专辑那侧带了后缀（平台改名）：唯一候选才认
  const annotated = [
    { title: 'Intro', album: 'B', source: 'local-vault', path: '/b/1.mp3' },
    { title: 'Intro (Remastered)', album: 'C', source: 'local-vault', path: '/c/1.mp3' },
  ];
  assert.equal(pickTrackByTitle([annotated[1]], 'Intro')?.title, 'Intro (Remastered)');
  assert.equal(pickTrackByTitle(annotated, 'Intro')?.title, 'Intro', '两首都命中前缀时靠精确那条');
  const ambiguous = [annotated[1], { title: 'Intro (Live)', album: 'D', source: 'local-vault', path: '/d/1.mp3' }];
  assert.equal(pickTrackByTitle(ambiguous, 'Intro'), undefined, '多个后缀候选：跳过而不是猜');
});

test('接线：载入走列表解析（不再读隐藏标记），保存不再写标记', () => {
  const main = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
  assert.match(main, /parseQueueEntries\(await this\.app\.vault\.read\(file\)\)/, '载入按列表解析');
  assert.match(main, /pickTrackByTitle\(albumTracks, entry\.trackTitle\)/, '按曲名还原曲目');
  assert.match(main, /queueNoteLines\(tracks, albumWikiLink\)/, '保存写列表');
  assert.match(main, /notice\(tf\('queueNote\.skippedList'/, '跳过的曲目要点名（只报数用户没法修）');
  assert.doesNotMatch(main, /vinyl-life-queue-v1|serializeQueueItems/, '隐藏标记已彻底退场');
});
