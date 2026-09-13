// 音频格式白名单回归：受支持的容器（Chromium 能解码）+ 不支持格式的提示文案。
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
        normalizePath: (p) => p,
      };
    }
    if (name === 'fs') return { readdirSync: () => [] };
    if (name === 'path') return nodePath;
    throw new Error('Unexpected runtime import: ' + name);
  },
  console,
});
const u = mod.exports;

test('音频白名单：收录 Chromium 能解的容器，排除需转码的格式', () => {
  for (const ok of [
    'a.mp3', 'a.m4a', 'a.m4b', 'a.mp4', 'a.wav', 'a.ogg',
    'a.oga', 'a.flac', 'a.aac', 'a.opus', 'a.webm', 'a.weba',
  ]) {
    assert.equal(u.isAudioFile(ok), true, `${ok} 应被接受`);
  }
  for (const bad of ['a.ape', 'a.wma', 'a.dsf', 'a.dff', 'a.tak', 'a.aiff', 'a.txt', 'a']) {
    assert.equal(u.isAudioFile(bad), false, `${bad} 应被跳过（需转码）`);
  }
});

test('MIME 映射覆盖全部白名单扩展名（外链 Blob 播放依赖它）', () => {
  for (const ext of u.AUDIO_EXTENSIONS) {
    const mime = u.mimeFromName('x.' + ext);
    assert.notEqual(mime, 'application/octet-stream', `${ext} 缺少 MIME 映射`);
  }
  assert.equal(u.mimeFromName('x.m4b'), 'audio/mp4');
  assert.equal(u.mimeFromName('x.mp4'), 'audio/mp4');
  assert.equal(u.mimeFromName('x.weba'), 'audio/webm');
  assert.equal(u.mimeFromName('x.unknown'), 'application/octet-stream');
});

test('splitAudioFiles / skippedFormatsText：不支持的文件会被明确报出', () => {
  const files = [{ name: 'a.mp3' }, { name: 'b.ape' }, { name: 'c.flac' }, { name: 'd.wma' }];
  const { audio, skipped } = u.splitAudioFiles(files);
  assert.deepEqual(Array.from(audio, (f) => f.name), ['a.mp3', 'c.flac']);
  assert.deepEqual(Array.from(skipped, (f) => f.name), ['b.ape', 'd.wma']);
  assert.equal(u.skippedFormatsText(['b.ape', 'd.wma']), '已跳过 2 个不支持的文件：b.ape、d.wma');
  assert.match(
    u.skippedFormatsText(['1.ape', '2.ape', '3.ape', '4.ape']),
    /^已跳过 4 个不支持的文件：1\.ape、2\.ape、3\.ape 等$/,
    '超过 3 个只列前 3 并加「等」'
  );
});

test('suggestAlbumTitle：同目录多文件 → 目录名；单文件 / 跨目录 → 文件名', () => {
  const mk = (name, p) => (p ? { name, path: p } : { name });
  assert.equal(
    u.suggestAlbumTitle([
      mk('01.flac', 'D:/Music/Abbey Road/01.flac'),
      mk('02.flac', 'D:/Music/Abbey Road/02.flac'),
    ]),
    'Abbey Road',
    '一张专辑一个文件夹 → 用目录名'
  );
  assert.equal(
    u.suggestAlbumTitle([mk('song.mp3', 'D:/Music/song.mp3')]),
    'song',
    '单文件不用目录名（否则会猜成 Music）'
  );
  assert.equal(
    u.suggestAlbumTitle([mk('a.flac', 'D:/A/a.flac'), mk('b.flac', 'D:/B/b.flac')]),
    'a',
    '跨目录 → 首个文件名'
  );
  assert.equal(u.suggestAlbumTitle([mk('x.flac')]), 'x', '没有 path 信息也不报错');
  assert.equal(u.suggestAlbumTitle([mk('cover.jpg', 'D:/A/cover.jpg')]), '', '非音频不参与推断');
});

test('文件夹分析：根层音频 → 一张专辑；多个子目录 → 判定为音乐库', () => {
  const f = (relPath) => ({ file: { name: relPath.split('/').pop() }, relPath });

  const one = u.analyzeFolder('Abbey Road', [
    f('Abbey Road/01.flac'),
    f('Abbey Road/02.flac'),
    f('Abbey Road/cover.jpg'),
  ]);
  assert.equal(one.verdict, 'album');
  assert.equal(one.files.length, 2, '只收受支持的音频');
  assert.equal(one.others, 1, '封面等非音频单独计数');
  assert.equal(one.rootAudio, 2);

  const cd = u.analyzeFolder('Abbey Road', [
    f('Abbey Road/CD1/01.flac'),
    f('Abbey Road/CD2/01.flac'),
  ]);
  assert.equal(cd.verdict, 'album', '子目录都是碟号（CD1 / CD2）→ 仍是同一张专辑');
  assert.equal(cd.audioSubfolders, 2);
  assert.equal(cd.rootAudio, 0);

  const single = u.analyzeFolder('Abbey Road', [f('Abbey Road/disc/01.flac')]);
  assert.equal(single.verdict, 'album', '只有一个子目录 → 仍是这张专辑');

  const lib = u.analyzeFolder('Music', [f('Music/A/01.flac'), f('Music/B/01.flac')]);
  assert.equal(lib.verdict, 'library', '多个普通子文件夹各含音频 → 像音乐库根目录，不糊成一张');

  const empty = u.analyzeFolder('Empty', [f('Empty/notes.txt')]);
  assert.equal(empty.verdict, 'empty');
  assert.equal(empty.files.length, 0);

  assert.equal(u.relDirOfPath('A/CD1/01.flac'), 'CD1');
  assert.equal(u.relDirOfPath('A/01.flac'), '', '根层文件没有子目录');
  assert.equal(u.relDirOfPath('01.flac'), '', '没有文件夹前缀也不报错');
});

test('音乐库批量：按一级子文件夹分组 + 拖拽根名识别', () => {
  const p = (rel) => ({ file: { name: rel.split('/').pop() }, relPath: rel });
  const items = [
    p('Music/A/01.flac'),
    p('Music/A/02.flac'),
    p('Music/B/01.flac'),
    p('Music/A/cover.jpg'),
    p('Music/readme.txt'),
  ];
  const cands = u.libraryCandidates(items);
  assert.deepEqual(Array.from(cands, (c) => c.name), ['A', 'B'], '按子文件夹分组并排序');
  assert.equal(cands[0].files.length, 2, '非音频不进候选');

  assert.equal(u.droppedRootName([p('Abbey Road/01.flac')]), 'Abbey Road', '拖文件夹 → 根名');
  assert.equal(u.droppedRootName([p('Abbey Road/CD1/01.flac')]), 'Abbey Road', '嵌套也算同一个根');
  assert.equal(u.droppedRootName([p('01.flac')]), '', '散选文件没有根文件夹');
  assert.equal(
    u.droppedRootName([p('A/01.flac'), p('B/01.flac')]),
    '',
    '多个文件夹同时拖入 → 不硬猜'
  );

  const withProp = { name: 'x.flac' };
  withProp.relPath = 'Music/A/x.flac';
  assert.equal(u.relPathOf(withProp), 'Music/A/x.flac', '拖拽注入的 relPath 能被读到');
  assert.equal(u.relPathOf({ name: 'y.flac' }), '', '没有相对路径时返回空串');
});
