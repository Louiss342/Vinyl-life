// 专辑删除回归：esbuild 编译真实 src/delete.ts（连带 album-index 的 frontmatter 解析）后在 vm 执行
// （stub obsidian + 假 vault）。覆盖：可删资产盘点（音频文件夹 / 零散文件 / 封面）、
// 其他专辑引用保护（含子目录嵌套）、外链路径不删、勾选项关闭时不动作、文件夹内文件不重复删除。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  stdin: {
    contents: `export * from '../src/delete';\nexport * from '../src/core/album-index';\n`,
    resolveDir: __dirname,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian'],
}).outputFiles[0].text;

const COVER = '06-专辑墙/covers/A.jpg';
const AUDIO_DIR = '06-专辑墙/audio/A';

class TFile {
  constructor(p, fm) {
    this.path = p;
    this.name = p.split('/').pop();
    this.basename = this.name.replace(/\.[^.]+$/, '');
    this.extension = this.name.split('.').pop();
    this.fm = fm || {};
  }
}

class TFolder {
  constructor(p) {
    this.path = p;
    this.name = p.split('/').pop();
    this.children = [];
  }
}

function setup() {
  const files = new Map();
  const folders = new Map();
  const trashed = [];

  const ensureFolder = (p) => {
    const hit = folders.get(p);
    if (hit) return hit;
    const f = new TFolder(p);
    folders.set(p, f);
    const i = p.lastIndexOf('/');
    if (i > 0) ensureFolder(p.slice(0, i)).children.push(f);
    return f;
  };

  const addFile = (p, fm) => {
    const f = new TFile(p, fm);
    files.set(p, f);
    const i = p.lastIndexOf('/');
    if (i > 0) ensureFolder(p.slice(0, i)).children.push(f);
    return f;
  };

  // 建音频文件夹：返回 TFolder，内部文件挂进 children（countFolderAudios 递归依赖）
  const addAudioDir = (dir, names) => {
    const f = ensureFolder(dir);
    for (const n of names) {
      const file = new TFile(`${dir}/${n}`, {});
      files.set(file.path, file);
      f.children.push(file);
    }
    return f;
  };

  const app = {
    vault: {
      getAbstractFileByPath: (p) => files.get(p) || folders.get(p) || null,
      getMarkdownFiles: () => [...files.values()].filter((f) => f.extension === 'md'),
      getResourcePath: (f) => 'app://local/' + f.path,
    },
    metadataCache: {
      getFileCache: (f) => (f.fm && Object.keys(f.fm).length ? { frontmatter: f.fm } : null),
      getFirstLinkpathDest: (link) => {
        if (files.has(link)) return files.get(link);
        for (const f of files.values()) if (f.path.endsWith('/' + link)) return f;
        return null;
      },
    },
    fileManager: {
      trashFile: async (t) => {
        trashed.push(t.path);
        if (t instanceof TFolder) {
          // 与 vault 一致：目录删除连带其下文件
          folders.delete(t.path);
          const prefix = t.path + '/';
          for (const p of [...files.keys()]) if (p.startsWith(prefix)) files.delete(p);
        } else {
          files.delete(t.path);
        }
      },
    },
  };

  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: (name) => {
      if (name === 'obsidian') {
        return {
          App: class {},
          TFile,
          TFolder,
          normalizePath: (p) => p,
          Notice: class {},
          Plugin: class {},
        };
      }
      return require(name);
    },
    console,
    Buffer,
  });

  const mod = module.exports;
  // 走真实解析链：frontmatter → AlbumInfo（避免测试自造形状与 src 漂移）
  const albumOf = (note) => mod.buildAlbumInfo(app, note, note.fm);

  return { mod, app, files, folders, trashed, addFile, addAudioDir, ensureFolder, albumOf };
}

// 专辑 A：独占音频文件夹 + 文件夹内文件 + 零散 vault 文件 + 外链 + 封面
function seedAlbumA(h) {
  h.addAudioDir(AUDIO_DIR, ['02.wav']);
  h.addFile(`${AUDIO_DIR}/01.mp3`);
  h.addFile('06-专辑墙/audio/loose.mp3');
  h.addFile(COVER);
  return h.addFile('06-专辑墙/专辑/A.md', {
    tags: ['album'],
    audioFolder: `[[${AUDIO_DIR}]]`,
    audio: [`${AUDIO_DIR}/01.mp3`, '06-专辑墙/audio/loose.mp3', 'D:/Music/out.flac'],
    cover: `[[${COVER}]]`,
  });
}

test('盘点：文件夹 / 零散文件 / 外链 / 封面各归其位，文件夹内文件不重复列出', () => {
  const h = setup();
  const note = seedAlbumA(h);
  const t = h.mod.collectAlbumDeleteTargets(h.app, h.albumOf(note));

  assert.deepEqual(Array.from(t.audioFolders, (f) => f.path), [AUDIO_DIR], '独占文件夹可删');
  assert.deepEqual(Array.from(t.audioFiles, (f) => f.path), ['06-专辑墙/audio/loose.mp3'], '文件夹内文件应被折叠，不重复列出');
  assert.deepEqual(Array.from(t.externalAudioRefs), ['D:/Music/out.flac'], '外链路径仅提示');
  assert.deepEqual(Array.from(t.sharedAudioPaths), [], '无其他专辑引用');
  assert.equal(t.coverFile?.path, COVER);
  assert.equal(t.coverShared, false);
});

test('安全：文件夹内混有非音频文件 → 只删音频、文件夹保留', () => {
  const h = setup();
  const note = seedAlbumA(h);
  h.addFile(`${AUDIO_DIR}/notes.pdf`, {}); // 用户的非音频文件混在专辑音频目录里
  const t = h.mod.collectAlbumDeleteTargets(h.app, h.albumOf(note));

  assert.deepEqual(Array.from(t.audioFolders), [], '混有非音频文件时不做整目录删除');
  assert.equal(t.keptFolders.length, 1, '应登记「保留文件夹」供弹窗提示');
  assert.equal(t.keptFolders[0].path, AUDIO_DIR);
  assert.equal(t.keptFolders[0].audios, 2, '02.wav + 01.mp3');
  assert.deepEqual(Array.from(t.keptFolders[0].others), [`${AUDIO_DIR}/notes.pdf`]);
  assert.deepEqual(
    Array.from(t.audioFiles, (f) => f.path).sort(),
    [`${AUDIO_DIR}/01.mp3`, `${AUDIO_DIR}/02.wav`, '06-专辑墙/audio/loose.mp3'].sort(),
    '文件夹内音频 + 零散文件都改为逐个删除'
  );
  assert.deepEqual(Array.from(t.sharedAudioPaths), []);
});

test('保护：其他专辑引用同一文件夹 / 封面 → 不进可删列表', () => {
  const h = setup();
  const note = seedAlbumA(h);
  h.addFile('06-专辑墙/专辑/B.md', {
    tags: ['album'],
    audioFolder: `[[${AUDIO_DIR}]]`,
    cover: `[[${COVER}]]`,
  });
  const t = h.mod.collectAlbumDeleteTargets(h.app, h.albumOf(note));

  assert.deepEqual(Array.from(t.audioFolders), [], '共享文件夹不可删');
  assert.deepEqual(Array.from(t.sharedAudioPaths), [AUDIO_DIR]);
  assert.equal(t.coverShared, true);
});

test('保护：其他专辑音频位于本专辑文件夹的子目录（嵌套）', () => {
  const h = setup();
  const note = seedAlbumA(h);
  h.ensureFolder(`${AUDIO_DIR}/sub`);
  h.addFile('06-专辑墙/专辑/C.md', { tags: ['album'], audioFolder: `[[${AUDIO_DIR}/sub]]` });
  const t = h.mod.collectAlbumDeleteTargets(h.app, h.albumOf(note));

  assert.deepEqual(Array.from(t.audioFolders), [], '子目录被他人占用时整棵目录不删');
  assert.deepEqual(Array.from(t.sharedAudioPaths), [AUDIO_DIR]);
});

test('执行：勾选项全开 → 删文件夹 + 零散文件 + 封面，各一次', async () => {
  const h = setup();
  const note = seedAlbumA(h);
  const t = h.mod.collectAlbumDeleteTargets(h.app, h.albumOf(note));
  const removed = await h.mod.deleteAlbumAssets(h.app, t, { audio: true, cover: true });

  assert.deepEqual(Array.from(h.trashed).sort(), [AUDIO_DIR, '06-专辑墙/audio/loose.mp3', COVER].sort());
  assert.equal(removed, 3);
  assert.equal(h.files.has(`${AUDIO_DIR}/01.mp3`), false, '文件夹内文件随目录一并删除（不单独 trash）');
  assert.equal(h.files.has('06-专辑墙/专辑/A.md'), true, '笔记不在资产清理范围内（由调用方单独删除）');
});

test('执行：勾选项关闭 → 不删任何资产', async () => {
  const h = setup();
  const note = seedAlbumA(h);
  const t = h.mod.collectAlbumDeleteTargets(h.app, h.albumOf(note));
  const removed = await h.mod.deleteAlbumAssets(h.app, t, { audio: false, cover: false });

  assert.deepEqual(Array.from(h.trashed), []);
  assert.equal(removed, 0);
});

test('执行：仅删音频（保留封面）', async () => {
  const h = setup();
  const note = seedAlbumA(h);
  const t = h.mod.collectAlbumDeleteTargets(h.app, h.albumOf(note));
  await h.mod.deleteAlbumAssets(h.app, t, { audio: true, cover: false });

  assert.deepEqual(Array.from(h.trashed).sort(), [AUDIO_DIR, '06-专辑墙/audio/loose.mp3'].sort());
});

test('边界：无音频 / 无封面的纯收藏专辑 → 无任何可删资产', () => {
  const h = setup();
  const note = h.addFile('06-专辑墙/专辑/D.md', { tags: ['album'], artist: 'Radiohead' });
  const t = h.mod.collectAlbumDeleteTargets(h.app, h.albumOf(note));

  assert.deepEqual(Array.from(t.audioFolders), []);
  assert.deepEqual(Array.from(t.audioFiles), []);
  assert.deepEqual(Array.from(t.externalAudioRefs), []);
  assert.equal(t.coverFile, null);
});

test('计数：countFolderAudios 递归统计（子目录计入 + 非音频文件不计）', () => {
  const h = setup();
  const dir = h.addAudioDir('06-专辑墙/audio/X', ['a.mp3', 'b.flac', 'cover.jpg']);
  const sub = h.ensureFolder('06-专辑墙/audio/X/cd1');
  const f = new TFile('06-专辑墙/audio/X/cd1/c.wav', {});
  h.files.set(f.path, f);
  sub.children.push(f);

  assert.equal(h.mod.countFolderAudios(dir), 3, 'a.mp3 / b.flac / cd1/c.wav（jpg 不计）');
});
