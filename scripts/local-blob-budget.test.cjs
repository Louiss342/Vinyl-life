// 库外音频的 Blob 缓存预算回归（驱动真实 LocalSource + 假 vault / 假 fs / 假 URL）：
//   Blob 缓存按「切专辑」清是不够的：一张 20 首的库外 FLAC 专辑能留到 GB 级内存。
//   现在按字节预算回收最久没用过的那份，正在用的那份永不回收。
//   ① 预算内全留（不白清）；② 超预算先丢最久没用过的；③ 命中即「最近使用」（保住它，丢下一个）；
//   ④ 单曲就超预算时也得放行（正在播的那份不能被回收）；⑤ clearBlobs 的账要与预算一致。
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

/** 造一个 LocalSource：files 是「绝对路径 → 字节数」，blobBudget 由用例给 */
function makeSource(files, blobBudget) {
  const revoked = [];
  const created = [];
  let seq = 0;
  const fsStub = {
    existsSync: (p) => files.has(p),
    statSync: () => ({ isFile: () => true }),
    readdirSync: () => [],
    readFileSync: (p) => {
      const size = files.get(p);
      if (size === undefined) throw new Error('ENOENT: ' + p);
      return Buffer.alloc(size, 1);
    },
  };
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
      if (name === 'fs') return fsStub;
      if (name === 'path') return nodePath;
      throw new Error('Unexpected runtime import: ' + name);
    },
    console,
    Buffer,
    TextDecoder,
    // 只替换两个方法：被 revoke 的顺序就是「谁被回收了」的证据
    URL: {
      createObjectURL: () => {
        const url = `blob:fake-${++seq}`;
        created.push(url);
        return url;
      },
      revokeObjectURL: (url) => revoked.push(url),
    },
    Blob: class {
      constructor(parts) {
        this.size = parts.reduce((n, p) => n + (p.byteLength || 0), 0);
      }
    },
    TextEncoder,
  });
  const { LocalSource } = mod.exports;
  return { src: new LocalSource({ vault: {} }, blobBudget), revoked, created };
}

const MB = 1024 * 1024;

test('预算内：全部留在缓存里（来回切歌不重读）', () => {
  const files = new Map([
    ['D:/m/a.flac', 1 * MB],
    ['D:/m/b.flac', 1 * MB],
  ]);
  const { src, revoked } = makeSource(files, 10 * MB);
  assert.ok(src.resolveExternalUrl('D:/m/a.flac'));
  assert.ok(src.resolveExternalUrl('D:/m/b.flac'));
  assert.deepEqual(revoked, [], '还没超预算，一份都不该回收');
});

test('超预算：先丢最久没用过的那份，正在用的那份留着', () => {
  const files = new Map([
    ['D:/m/a.flac', 4 * MB],
    ['D:/m/b.flac', 4 * MB],
    ['D:/m/c.flac', 4 * MB],
  ]);
  const { src, revoked } = makeSource(files, 10 * MB);
  const a = src.resolveExternalUrl('D:/m/a.flac');
  const b = src.resolveExternalUrl('D:/m/b.flac');
  assert.deepEqual(revoked, []);
  const c = src.resolveExternalUrl('D:/m/c.flac'); // 12 MB > 10 MB：得丢一份
  assert.deepEqual(revoked, [a], '丢的是最久没用过的 a');
  assert.equal(src.resolveExternalUrl('D:/m/b.flac'), b, 'b 还在缓存里（同一个 URL，不重读）');
  assert.equal(src.resolveExternalUrl('D:/m/c.flac'), c);
});

test('命中即最近使用：再摸一下 a，接下来被丢的就是 b', () => {
  const files = new Map([
    ['D:/m/a.flac', 4 * MB],
    ['D:/m/b.flac', 4 * MB],
    ['D:/m/c.flac', 4 * MB],
  ]);
  const { src, revoked } = makeSource(files, 10 * MB);
  const a = src.resolveExternalUrl('D:/m/a.flac');
  const b = src.resolveExternalUrl('D:/m/b.flac');
  assert.equal(src.resolveExternalUrl('D:/m/a.flac'), a, '命中缓存：还是同一个 URL');
  src.resolveExternalUrl('D:/m/c.flac'); // 超预算：a 刚被摸过，该丢 b
  assert.deepEqual(revoked, [b]);
});

test('单曲就超预算：也放行（正在播的那份不能被回收，否则播放直接断）', () => {
  const files = new Map([
    ['D:/m/huge.flac', 50 * MB],
  ]);
  const { src, revoked } = makeSource(files, 10 * MB);
  const url = src.resolveExternalUrl('D:/m/huge.flac');
  assert.ok(url, '要拿到地址');
  assert.deepEqual(revoked, [], '它自己超预算也不回收 —— 它就是要用的那一份');
});

test('清缓存（切专辑）与预算账一致：清完之后再进来不该被误回收', () => {
  const files = new Map([
    ['D:/m/a.flac', 4 * MB],
    ['D:/m/b.flac', 4 * MB],
  ]);
  const { src, revoked } = makeSource(files, 9 * MB);
  const a = src.resolveExternalUrl('D:/m/a.flac');
  const b = src.resolveExternalUrl('D:/m/b.flac');
  src.clearBlobs(new Set(['D:/m/b.flac'])); // 切专辑：只留 b
  assert.deepEqual(revoked, [a], '没被保留的那份按规矩回收');
  // 账已经减掉 a 的 4 MB：再进一份 4 MB 只剩 8 MB，不该触发回收
  const a2 = src.resolveExternalUrl('D:/m/a.flac');
  assert.deepEqual(revoked, [a], '预算账没算错（否则这里会多回收一份）');
  assert.notEqual(a2, a, '重新读进来是新的 URL（旧的已经 revoke）');
});

test('库内音频那份 Blob（readBinary 兜底）同样进预算账', async () => {
  const files = new Map();
  const { src, revoked } = makeSource(files, 5 * MB);
  const audio = new TFile('Music/big.flac');
  new TFolder('Music', [audio]);
  src.app = {
    vault: {
      readBinary: async () => Buffer.alloc(4 * MB, 1),
      getResourcePath: () => 'app://local/x',
    },
  };
  const first = await src.resolveVaultBlobUrl(audio);
  const other = await src.resolveVaultBlobUrl(new TFile('Music/other.flac'));
  assert.ok(first && other);
  assert.deepEqual(revoked, [first], '库内的那份也按同一本账回收（8 MB > 5 MB）');
});
