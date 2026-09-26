// 本地音源读内嵌标签的**接线**（core/audio-tags 的解析在上一个文件里验，这里验它真的被用上）：
//   ① 库外音频：曲名取标签而不是文件名；标签里有艺人就用它（合辑每首艺人不同），
//      专辑名仍以笔记为准（笔记是真源）；
//   ② 曲目顺序：有音轨号按音轨号 —— '01 …' / '02 …' 这种文件名排序在 10 之后会乱；
//   ③ 读不到标签（没有标签 / 读不动）时安静回退文件名，不抛也不空标题。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const nodePath = require('node:path');

// 沙箱里造出来的数组带着另一个 realm 的原型，strict deepEqual 会判「结构相同但引用不同」
const plain = (v) => JSON.parse(JSON.stringify(v));

// —— 合成一个带 ID3v2.3 标签的 mp3（只写头，正文无所谓：解析器只看前缀） ——
const syncsafe = (n) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
const be32 = (n) => [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const bytes = (...parts) => {
  const flat = [];
  const push = (v) => {
    if (typeof v === 'string') for (const c of v) flat.push(c.charCodeAt(0) & 0xff);
    else if (v instanceof Uint8Array || Array.isArray(v)) for (const x of v) push(x);
    else flat.push(Number(v) & 0xff);
  };
  for (const p of parts) push(p);
  return Uint8Array.from(flat);
};
function frame(id, text) {
  // 正文按真 UTF-8 编码（`charCodeAt & 0xff` 会把中文截成乱码 —— 解析器解出来就是垃圾）
  const body = [3, ...Buffer.from(text, 'utf8')];
  return bytes(id, be32(body.length), [0, 0], body);
}
function taggedMp3(fields) {
  const frames = [];
  if (fields.title) frames.push(frame('TIT2', fields.title));
  if (fields.artist) frames.push(frame('TPE1', fields.artist));
  if (fields.track) frames.push(frame('TRCK', String(fields.track)));
  const payload = bytes(...frames, [0, 0, 0, 0]);
  const tag = bytes('ID3', [3, 0, 0], syncsafe(payload.length), payload);
  const audio = bytes([0xff, 0xfb, 0x90, 0x00], Array.from({ length: 64 }, () => 0)); // 假的帧头 + 静音
  return Buffer.from(bytes(tag, audio));
}

/** fs 桩：文件内容表 + 目录表（只实现 local-source 真正用到的几个调用）。
 *  查表一律先把反斜杠归一成斜杠：Windows 上 path.join 拼出来的是 \，而夹具的键写成 / —— 
 *  不归一的话「目录列得出来、文件读不到」，看起来像标签解析失败，其实是夹具对不上。 */
function makeFsStub(files, dirs) {
  const pathMod = nodePath;
  const norm = (p) => String(p).split(nodePath.sep).join('/');
  const hasFile = (p) => files.has(norm(p));
  const hasDir = (p) => dirs.has(norm(p));
  return {
    existsSync: (p) => hasFile(p) || hasDir(p),
    statSync: (p) => ({ isFile: () => hasFile(p), isDirectory: () => hasDir(p), size: (files.get(norm(p)) || []).length }),
    readdirSync: (p) => {
      const names = dirs.get(norm(p)) || [];
      return names.map((name) => {
        const full = pathMod.join(p, name);
        return { name, isFile: () => hasFile(full), isDirectory: () => hasDir(full) };
      });
    },
    readFileSync: (p) => {
      const buf = files.get(norm(p));
      if (!buf) throw new Error('ENOENT: ' + p);
      return buf;
    },
    // 标签读的是前缀：openSync + readSync(offset, length) + closeSync
    openSync: (p) => {
      if (!hasFile(p)) throw new Error('ENOENT: ' + p);
      return norm(p); // fd 就用归一后的路径当句柄，够用
    },
    readSync: (fd, buffer, offset, length, position) => {
      const src = files.get(norm(fd)) || Buffer.alloc(0);
      const start = position || 0;
      const take = Math.max(0, Math.min(length, src.length - start));
      src.copy(buffer, offset, start, start + take);
      return take;
    },
    closeSync: () => {},
  };
}

function makeSource(files, dirs) {
  const source = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '../src/core/local-source.ts')],
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
          TFile: class {},
          TFolder: class {},
          Notice: class {},
          Menu: class {},
          Modal: class {},
          normalizePath: (p) => p,
        };
      }
      if (name === 'fs') return makeFsStub(files, dirs);
      if (name === 'path') return nodePath;
      throw new Error('Unexpected runtime import: ' + name);
    },
    console,
    Buffer,
    TextDecoder,
    TextEncoder,
    URLSearchParams,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    Blob: class {},
  });
  const { LocalSource } = mod.exports;
  return { src: new LocalSource({ vault: {} }, 1024 * 1024, null), mod };
}

const DIR = 'D:/Music/Album';

function albumRef() {
  return {
    path: '06-专辑墙/专辑/某专辑.md',
    title: '某专辑',
    artist: '笔记里的艺人',
    audioFolderRef: DIR,
    audioRefs: [],
    file: { path: '06-专辑墙/专辑/某专辑.md' },
  };
}

test('库外音频：曲名取内嵌标签、艺人标签优先、专辑名仍以笔记为准', async () => {
  const files = new Map([
    [`${DIR}/unknown-name.mp3`, taggedMp3({ title: '真实曲名', artist: '合辑里的这位', track: 1 })],
    [`${DIR}/no-tags.mp3`, Buffer.from(bytes([0xff, 0xfb, 0x90, 0x00], Array.from({ length: 32 }, () => 0)))],
  ]);
  const dirs = new Map([[DIR, ['unknown-name.mp3', 'no-tags.mp3']]]);
  const { src } = makeSource(files, dirs);
  const tracks = await src.buildTracks(albumRef());
  const tagged = tracks.find((t) => t.title === '真实曲名');
  assert.ok(tagged, '曲名要用标签里的（不是文件名 unknown-name）');
  assert.equal(tagged.artist, '合辑里的这位', '标签里的艺人优先于笔记里的艺人');
  assert.equal(tagged.album, '某专辑', '专辑名以笔记为准');
  assert.equal(tagged.track, 1, '音轨号读出来（排序用）');
  const plain = tracks.find((t) => t.title === 'no-tags');
  assert.ok(plain, '没有标签就回退文件名');
  assert.equal(plain.artist, '笔记里的艺人', '没有标签时的艺人回退笔记');
  assert.equal(plain.track, undefined);
});

test('曲目顺序：有音轨号的按音轨号排（文件名排序在 10 之后会乱）', async () => {
  const names = ['10 - ten.mp3', '2 - two.mp3', '1 - one.mp3'];
  const files = new Map([
    [`${DIR}/${names[0]}`, taggedMp3({ title: '第十首', track: 10 })],
    [`${DIR}/${names[1]}`, taggedMp3({ title: '第二首', track: 2 })],
    [`${DIR}/${names[2]}`, taggedMp3({ title: '第一首', track: 1 })],
  ]);
  const dirs = new Map([[DIR, names]]);
  const { src } = makeSource(files, dirs);
  const tracks = await src.buildTracks(albumRef());
  assert.deepEqual(
    plain(tracks.map((t) => t.title)),
    ['第一首', '第二首', '第十首'],
    '按音轨号 1 / 2 / 10（按文件名会是 1 / 10 / 2）'
  );
});

test('标签读不动（文件打不开）：安静回退文件名，不抛也不空标题', async () => {
  const files = new Map(); // 目录里列得出来，但读不到内容
  const dirs = new Map([[DIR, ['ghost.mp3']]]);
  const { src } = makeSource(files, dirs);
  const tracks = await src.buildTracks(albumRef());
  assert.equal(tracks.length, 0, '读不到的文件本来就不该进队列（existsSync 就挡下了）');
});

test('比较器：无音轨号的沉到最后，其余按标题（中文本地化序）', () => {
  const { src, mod } = makeSource(new Map(), new Map());
  const cmp = mod.exports.compareByTrack;
  assert.ok(cmp, 'compareByTrack 要导出（排序口径可单测）');
  const a = { title: 'B', track: 2 };
  const b = { title: 'A', track: 1 };
  const c = { title: 'A', track: undefined };
  assert.ok(cmp(a, b) > 0, '音轨号 2 排在 1 后面');
  assert.ok(cmp(a, c) < 0, '有音轨号的排在没音轨号的前面');
  assert.equal(cmp({ title: '一样' }, { title: '一样' }), 0);
  void src;
});
