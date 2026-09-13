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
        normalizePath: (p) => p,
      };
    }
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
