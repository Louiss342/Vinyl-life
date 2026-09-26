// 本地旁挂歌词（.lrc）回归：驱动真实 LocalSource.readSidecarLyrics + 假 vault / 假 fs。
//   ① 两种命名流派都认：`song.lrc`（换扩展名）与 `song.flac.lrc`（带原扩展名），大小写不敏感
//   ② 库内音轨走 vault.readBinary、库外音轨走 fs —— 两条路都要能读到
//   ③ 编码：UTF-8 与 GBK 都要解得出中文（中文歌词站导出的 .lrc 至今仍有 GBK）
//   ④ 找不到 / 读失败 → null（视图按「没有歌词」显示，不能抛到调用方）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const nodePath = require('node:path');

class TFile {
  constructor(p, parent = null) {
    this.path = p;
    this.name = String(p).split('/').pop();
    this.parent = parent;
  }
}
class TFolder {
  constructor(p, children = []) {
    this.path = p;
    this.name = String(p).split('/').pop();
    this.children = children;
    for (const c of children) c.parent = this;
  }
}

/** 假 fs：只认 files（绝对路径 → Buffer），其余一律「不存在」；overrides 可换掉任一动作 */
function makeFs(files, overrides = {}) {
  return {
    existsSync: (p) => files.has(p),
    statSync: () => ({ isFile: () => true }),
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error('ENOENT: ' + p);
      return files.get(p);
    },
    readdirSync: () => [],
    ...overrides,
  };
}

function load(files, fsOverrides = {}) {
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
          Plugin: class {},
          Notice: class {},
          Menu: class {},
          Modal: class {},
          TFile,
          TFolder,
          normalizePath: (p) => p,
        };
      }
      if (name === 'fs') return makeFs(files, fsOverrides);
      if (name === 'path') return nodePath;
      throw new Error('Unexpected runtime import: ' + name);
    },
    console,
    Buffer,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
  });
  return mod.exports;
}

const gbkOk = (() => {
  try {
    new TextDecoder('gbk');
    return true;
  } catch {
    return false;
  }
})();

/** 库内音轨夹具：一个文件夹里放着音频 `晴天.flac` 与若干旁挂文件（[文件名, 字节]） */
function vaultCase(sidecars = []) {
  const folder = 'Music/Album';
  const audio = new TFile(`${folder}/晴天.flac`);
  const bytes = new Map(sidecars);
  const children = [audio, ...bytes.keys()].map((x) => (typeof x === 'string' ? new TFile(`${folder}/${x}`) : x));
  new TFolder(folder, children);
  const app = {
    vault: {
      readBinary: async (f) => {
        if (!bytes.has(f.name)) throw new Error('没有这个旁挂文件：' + f.name);
        return bytes.get(f.name);
      },
    },
  };
  return { app, track: { source: 'local-vault', file: audio, title: '晴天' } };
}

test('库内音轨：同名换扩展名的 song.lrc 能读到（大小写不敏感）', async () => {
  const { LocalSource } = load(new Map());
  const { app, track } = vaultCase([['晴天.LRC', Buffer.from('[00:01.00]甲', 'utf8')]]);
  assert.equal(await new LocalSource(app).readSidecarLyrics(track), '[00:01.00]甲');
});

test('库内音轨：song.flac.lrc（带原扩展名）也认', async () => {
  const { LocalSource } = load(new Map());
  const { app, track } = vaultCase([['晴天.flac.lrc', Buffer.from('[00:02.00]乙', 'utf8')]]);
  assert.equal(await new LocalSource(app).readSidecarLyrics(track), '[00:02.00]乙');
});

test('库内音轨：同目录没有 .lrc → null（不是抛异常）', async () => {
  const { LocalSource } = load(new Map());
  const { app, track } = vaultCase([['cover.jpg', Buffer.from('x')]]);
  assert.equal(await new LocalSource(app).readSidecarLyrics(track), null);
});

test('库内音轨：同名的其它扩展名不算歌词（晴天.mp3 不是）', async () => {
  const { LocalSource } = load(new Map());
  const { app, track } = vaultCase([['晴天.mp3', Buffer.from('x')]]);
  assert.equal(await new LocalSource(app).readSidecarLyrics(track), null);
});

test('库外音轨：走 fs 找同名 .lrc', async () => {
  const lrcPath = nodePath.join('D:/Music', '晴天.lrc');
  const files = new Map([[lrcPath, Buffer.from('[00:03.00]丙', 'utf8')]]);
  const { LocalSource } = load(files);
  const src = new LocalSource({ vault: {} });
  const track = { source: 'local-external', path: 'D:/Music/晴天.flac', title: '晴天' };
  assert.equal(await src.readSidecarLyrics(track), '[00:03.00]丙');
});

test('库外音轨：读不到 → null', async () => {
  const { LocalSource } = load(new Map());
  const src = new LocalSource({ vault: {} });
  assert.equal(await src.readSidecarLyrics({ source: 'local-external', path: 'D:/Music/无词.flac' }), null);
});

test('库外音轨：读取抛异常（权限 / 竞态）→ null，不往上抛', async () => {
  const lrcPath = nodePath.join('D:/Music', '坏文件.lrc');
  const files = new Map([[lrcPath, Buffer.from('x')]]);
  const { LocalSource } = load(files, {
    readFileSync: () => {
      throw new Error('EIO');
    },
  });
  const src = new LocalSource({ vault: {} });
  assert.equal(await src.readSidecarLyrics({ source: 'local-external', path: 'D:/Music/坏文件.flac' }), null);
});

test('编码：GBK 的 .lrc 也能解出中文（否则是满屏乱码）', { skip: !gbkOk }, async () => {
  // '晴天' 的 GBK 码位：晴 C7E7、天 CCEC —— 这串字节不是合法 UTF-8
  const { LocalSource } = load(new Map());
  const { app, track } = vaultCase([['晴天.lrc', new Uint8Array([0xc7, 0xe7, 0xcc, 0xec])]]);
  assert.equal(await new LocalSource(app).readSidecarLyrics(track), '晴天');
});

test('非本地音轨（在线源）→ null：这条口子只服务本地文件', async () => {
  const { LocalSource } = load(new Map());
  const src = new LocalSource({ vault: {} });
  for (const track of [
    { source: 'netease', id: 1 },
    { source: 'qq', id: 'x' },
    { source: 'kugou', id: 'a'.repeat(32) },
  ]) {
    assert.equal(await src.readSidecarLyrics(track), null, `${track.source} 不该走本地旁挂`);
  }
});
