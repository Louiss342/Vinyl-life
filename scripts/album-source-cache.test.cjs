// 音源检测的缓存回归（驱动真实 detectAlbumSources + 假 vault）：
//   ① 同一份结论不重算 —— 专辑墙每次刷新对每张专辑调一遍，缓存前是每次 N 次目录遍历
//   ② frontmatter 变了（id / 引用路径）不等作废就重算：sig 兜住
//   ③ 作废之后重算 —— 库内结构事件、专辑墙「刷新」、健康检查打开都走这个口子
//   ④ 返回的是副本：调用方改一处不会串到缓存里的结论
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const nodePath = require('node:path');

class TFile {
  constructor(p) {
    this.path = p;
    this.name = String(p).split('/').pop();
    this.extension = this.name.includes('.') ? this.name.split('.').pop() : '';
  }
}
class TFolder {
  constructor(p, children = []) {
    this.path = p;
    this.name = String(p).split('/').pop();
    this.children = children;
  }
}

function load() {
  const source = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '../src/core/album-index.ts')],
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
        return { App: class {}, TFile, TFolder, normalizePath: (p) => p };
      }
      if (name === 'fs') {
        // 库外路径那条分支在这条用例里用不到：给了也只回「什么都没有」
        return { existsSync: () => false, statSync: () => ({}), readdirSync: () => [] };
      }
      if (name === 'path') return nodePath;
      throw new Error('Unexpected runtime import: ' + name);
    },
    console,
    Buffer,
    process,
  });
  return mod.exports;
}

/** 一张专辑：本地音源指向 Albums/A/audio（走 vault 分支） */
function albumAt(folderRef, extra = {}) {
  return {
    file: new TFile('Albums/A.md'),
    path: 'Albums/A.md',
    title: 'A',
    audioFolderRef: folderRef,
    audioRefs: [],
    displayProps: {},
    ...extra,
  };
}

function appFor(folder) {
  return {
    vault: {
      getAbstractFileByPath: (p) => (p === folder.path ? folder : null),
    },
  };
}

test('同一份结论不重算；作废之后才重算', () => {
  const { detectAlbumSources, invalidateSourceCache } = load();
  const folder = new TFolder('Albums/A/audio', []);
  const app = appFor(folder);
  const album = albumAt('Albums/A/audio');

  assert.equal(detectAlbumSources(app, album).local, false, '空目录：没有本地音源');
  folder.children.push(new TFile('Albums/A/audio/01.flac'));
  assert.equal(
    detectAlbumSources(app, album).local,
    false,
    '没作废就还是上一次的结论（缓存生效：这正是省掉那 N 次目录遍历的原因）'
  );
  invalidateSourceCache();
  assert.equal(detectAlbumSources(app, album).local, true, '作废之后重算：音频进来了');
});

test('frontmatter 变了（id / 引用路径）不等作废就重算', () => {
  const { detectAlbumSources } = load();
  const folder = new TFolder('Albums/A/audio', [new TFile('Albums/A/audio/01.flac')]);
  const app = appFor(folder);
  const album = albumAt('Albums/A/audio');

  assert.deepEqual(
    { ...detectAlbumSources(app, album) },
    { local: true, netease: false, qq: false, kugou: false }
  );
  album.neteaseId = 12345;
  assert.equal(detectAlbumSources(app, album).netease, true, '笔记里补了 id：不用等作废');
  album.audioFolderRef = '';
  assert.equal(detectAlbumSources(app, album).local, false, '引用路径改了：同样立即反映');
});

test('返回的是副本：调用方改结果不会串到缓存', () => {
  const { detectAlbumSources } = load();
  const folder = new TFolder('Albums/A/audio', [new TFile('Albums/A/audio/01.flac')]);
  const app = appFor(folder);
  const album = albumAt('Albums/A/audio');

  const first = detectAlbumSources(app, album);
  first.local = false; // 调用方手里的那份被改脏
  assert.equal(detectAlbumSources(app, album).local, true, '缓存里那份不受影响');
});
