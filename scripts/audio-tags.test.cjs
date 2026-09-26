// 本地音频的内嵌标签解析（core/audio-tags）：合成字节 → 断言解析结果。
// 为什么用合成数据而不是真音频文件：这里要验的是**字节搬运**（帧长 / 编码 / 大小写 / 版本差异），
// 合成出来的边界比真文件更好摆 —— 比如 UTF-16 带 BOM、2.2 的 3 字节帧 ID、syncsafe 长度。
// 覆盖：ID3v2.3（UTF-8 / UTF-16）、ID3v2.2、ID3v2.4（syncsafe）、FLAC、Ogg Vorbis、Opus、MP4（含 trkn）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  stdin: { contents: `export * from '../src/core/audio-tags';\n`, resolveDir: __dirname, loader: 'ts' },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
}).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(source, {
  module: mod,
  exports: mod.exports,
  TextDecoder,
  console,
});
const { parseAudioTags, audioTagReadHint } = mod.exports;

// 沙箱里造出来的对象带着另一个 realm 的原型，strict deepEqual 会判「结构相同但引用不同」——
// 先过一遍 JSON 归一（与 stats 用例里的 plain 同一个做法）
const plain = (v) => JSON.parse(JSON.stringify(v));

/** 拼字节：字符串按字符码、数字按字节、嵌套数组递归摊平（Uint8Array.from 不会自己摊） */
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

// —— ID3v2 合成 ——

/** syncsafe 长度（每字节 7 位） */
const syncsafe = (n) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
const be32 = (n) => [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

/** 一个 ID3v2.3 文本帧：帧头 = ID(4) + 长度(4，普通 32 位) + 标志(2) + 正文；正文首字节是编码（3 = UTF-8） */
function id3v23Frame(id, text) {
  const body = [3, ...Array.from(text, (c) => c.charCodeAt(0))];
  return bytes(id, be32(body.length), [0, 0], body);
}

function id3v23(...frames) {
  const body = bytes(...frames, [0, 0, 0, 0]);
  return bytes('ID3', [3, 0, 0], syncsafe(body.length), body);
}

/** 2.4：帧长是 syncsafe（标志 2 字节照写） */
function id3v24Frame(id, text) {
  const body = [3, ...Array.from(text, (c) => c.charCodeAt(0))];
  return bytes(id, syncsafe(body.length), [0, 0], body);
}

test('ID3v2.3：曲名 / 艺人 / 专辑 / 音轨号都读得出', () => {
  const buf = id3v23(
    id3v23Frame('TIT2', 'A Day in the Life'),
    id3v23Frame('TPE1', 'The Beatles'),
    id3v23Frame('TALB', 'Sgt. Pepper'),
    id3v23Frame('TRCK', '7/13'),
    id3v23Frame('TCON', 'Rock') // 不认识的帧：跳过而不是把后面解歪
  );
  assert.deepEqual(plain(parseAudioTags(buf)), {
    title: 'A Day in the Life',
    artist: 'The Beatles',
    album: 'Sgt. Pepper',
    track: 7,
  });
});

test('ID3v2.3：UTF-16 带 BOM 的正文（中文标签常见写法）', () => {
  const text = '晴天';
  const utf16 = [0xff, 0xfe]; // 小端 BOM
  for (const c of text) {
    const code = c.charCodeAt(0);
    utf16.push(code & 0xff, code >> 8);
  }
  const buf = id3v23(id3v23Frame('TIT2', 'x'), bytes('TPE1', be32(1 + utf16.length), [0, 0], [1, ...utf16]));
  assert.equal(parseAudioTags(buf).artist, '晴天');
});

test('ID3v2.2：3 字节帧 ID 与 3 字节长度（老编码器）', () => {
  const body = [3, ...Array.from('Old Title', (c) => c.charCodeAt(0))];
  const frame = bytes('TT2', [(body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff], body);
  const payload = bytes(frame, [0, 0, 0]);
  const buf = bytes('ID3', [2, 0, 0], syncsafe(payload.length), payload);
  assert.equal(parseAudioTags(buf).title, 'Old Title');
});

test('ID3v2.4：帧长走 syncsafe（当普通 32 位解会得到天文数字、整段解废）', () => {
  const buf = bytes('ID3', [4, 0, 0], syncsafe(0), bytes(id3v24Frame('TIT2', 'Syncsafe'), id3v24Frame('TPE1', 'Someone')));
  const tags = parseAudioTags(buf);
  assert.equal(tags.title, 'Syncsafe');
  assert.equal(tags.artist, 'Someone');
});

test('ID3v2：声明长度超过前缀时给出补读提示；读完就不提示', () => {
  const big = id3v23(id3v23Frame('TIT2', 'x'));
  // 头里声明的总长 = 整段长度（10 字节头 + 载荷），不是「10 + 整段」
  const declared = big.length;
  // 只给前 20 字节：头里声明的总长比它大 → 要求补读
  assert.equal(audioTagReadHint(big.subarray(0, 20)), declared);
  assert.equal(audioTagReadHint(big), 0, '整段都在手里就不再补读');
  assert.equal(audioTagReadHint(bytes('fLaC', [0, 0, 0, 0])), 0, '非 ID3 不补读');
});

// —— Vorbis comment（FLAC / Ogg / Opus）——

function vorbisComment(pairs, { vendor = 'test' } = {}) {
  const enc = (s) => Array.from(s, (c) => c.charCodeAt(0));
  const out = [...be32le(enc(vendor).length), ...enc(vendor), ...be32le(pairs.length)];
  for (const [k, v] of pairs) {
    const line = enc(`${k}=${v}`);
    out.push(...be32le(line.length), ...line);
  }
  return out;
}
const be32le = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];

test('FLAC：Vorbis comment 块（键不分大小写、TRACKNUMBER 取出数字）', () => {
  const comment = vorbisComment([
    ['TITLE', 'Bohemian Rhapsody'],
    ['artist', 'Queen'], // 小写键也要认
    ['Album', 'A Night at the Opera'],
    ['TRACKNUMBER', '11'],
    ['COMMENT', '忽略我'],
  ]);
  const block = bytes([0x84], [(comment.length >> 16) & 0xff, (comment.length >> 8) & 0xff, comment.length & 0xff], comment);
  const buf = bytes('fLaC', block);
  assert.deepEqual(plain(parseAudioTags(buf)), {
    title: 'Bohemian Rhapsody',
    artist: 'Queen',
    album: 'A Night at the Opera',
    track: 11,
  });
});

test('FLAC：先跳过 streaminfo 块再读 comment（块长度不认会整段错位）', () => {
  const streaminfo = bytes([0x00], [0, 0, 34], Array.from({ length: 34 }, () => 7));
  const comment = vorbisComment([['TITLE', 'Second Block']]);
  const block = bytes([0x84], [(comment.length >> 16) & 0xff, (comment.length >> 8) & 0xff, comment.length & 0xff], comment);
  assert.equal(parseAudioTags(bytes('fLaC', streaminfo, block)).title, 'Second Block');
});

test('Ogg Vorbis / Opus：两种标记都认', () => {
  const vorbis = bytes('OggS', [0, 2], 'x', [0x03], 'vorbis', vorbisComment([['TITLE', 'Ogg Song']]));
  assert.equal(parseAudioTags(vorbis).title, 'Ogg Song');
  const opus = bytes('OggS', [0, 2], 'x', 'OpusTags', vorbisComment([['TITLE', 'Opus Song'], ['ARTIST', 'Opus Artist']]));
  const tags = parseAudioTags(opus);
  assert.equal(tags.title, 'Opus Song');
  assert.equal(tags.artist, 'Opus Artist');
});

// —— MP4 / M4A ——

/** MP4 盒子：尺寸(4) + 类型(4) + 内容（顺序别写反 —— 类型在前是「盒子里的盒子」那种读法） */
function box(name, ...payload) {
  const body = bytes(...payload);
  return bytes(be32(body.length + 8), name, body);
}

test('MP4：moov.udta.meta.ilst 下的 ©nam / ©ART / ©alb / trkn', () => {
  const text = (s) => box('data', [0, 0, 0, 1, 0, 0, 0, 0], Array.from(s, (c) => c.charCodeAt(0)));
  const trkn = box('data', [0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 5, 0, 12, 0, 0]);
  const ilst = box(
    'ilst',
    box('©nam', text('M4A Title')),
    box('©ART', text('M4A Artist')),
    box('©alb', text('M4A Album')),
    box('trkn', trkn)
  );
  const meta = box('meta', [0, 0, 0, 0], ilst);
  const buf = bytes(box('ftyp', 'M4A '), box('moov', box('udta', meta)));
  assert.deepEqual(plain(parseAudioTags(buf)), {
    title: 'M4A Title',
    artist: 'M4A Artist',
    album: 'M4A Album',
    track: 5,
  });
});

test('MP4：没有 moov / 结构不认识时回空对象，不抛也不胡乱认字段', () => {
  assert.deepEqual(plain(parseAudioTags(bytes('ftyp', 'M4A ', box('moov', box('mvhd', [0, 0, 0, 0]))))), {});
  assert.deepEqual(plain(parseAudioTags(bytes('moov', be32(4)))), {});
});

// —— 边界 ——

test('不是音频 / 太短 / 空：一律回空对象（调用方回退文件名）', () => {
  assert.deepEqual(plain(parseAudioTags(bytes('RIFF', 'WAVE'))), {}, 'WAV 没有标签支持，回空');
  assert.deepEqual(plain(parseAudioTags(new Uint8Array(0))), {});
  assert.deepEqual(plain(parseAudioTags(new Uint8Array(4))), {});
  assert.deepEqual(plain(parseAudioTags(bytes('ID3', [9, 0, 0]))), {}, '版本号不认识（9）就放弃');
});

test('ID3v2：帧长度越过缓冲区就停下，不越界读', () => {
  // 声明 999 字节的正文，实际只给 4 字节
  const broken = bytes('ID3', [3, 0, 0], syncsafe(64), 'TIT2', be32(999), [0, 0], [3], 'abcd');
  assert.deepEqual(plain(parseAudioTags(broken)), {});
});
