// 「听到这里 → 记下 → 日后重听」闭环的最后一跳：
//   写感想时把播放位置写成 obsidian://vinyl-life 链接；
//   在笔记里点那个位置 → 协议处理器载入专辑、按曲名定位、跳到那一刻并开始播。
// 这里跑真 main.ts（stub 掉 obsidian 与引擎），锁住参数编码、按曲名定位、脏数据与失败提示。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/main.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian', 'electron', '@electron/remote'],
}).outputFiles[0].text;

const notices = [];
class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; }
}
class TFile {
  constructor(path, basename) { this.path = path; this.basename = basename || path.split('/').pop(); }
}
const mod = { exports: {} };
vm.runInNewContext(source, {
  module: mod,
  exports: mod.exports,
  require: (name) =>
    name === 'obsidian'
      ? {
          App: class {},
          ItemView: class {},
          MarkdownView: class {},
          Modal: class {},
          Notice: class { constructor(msg) { notices.push(String(msg)); } },
          Plugin,
          PluginSettingTab: class {},
          SettingPage: class {},
          Setting: class {},
          TFile,
          TFolder: class {},
          FuzzySuggestModal: class {},
          normalizePath: (p) => p,
          setIcon: () => {},
        }
      : require(name),
  Buffer,
  process,
  console,
  Date,
  setTimeout,
  clearTimeout,
  window: { setTimeout: () => 0, clearTimeout: () => {} },
  document: { createElement: () => ({ style: {} }) },
  Audio: class { addEventListener() {} },
});

/** 起一个够跑跳转的插件壳：库里有 A.md，引擎调用都记下来 */
function boot({ withAlbum = true, tracks = ['One', 'Two', 'Three'] } = {}) {
  const calls = [];
  const albumFile = new TFile('Vinyl Life/Vinyl Note/A.md', 'A');
  const app = {
    vault: {
      adapter: { getBasePath: () => process.cwd() },
      getAbstractFileByPath: (p) => (withAlbum && p === albumFile.path ? albumFile : null),
      getResourcePath: (f) => `app://${f.path}`,
      createFolder: async () => {},
      create: async () => ({ path: 'x' }),
    },
    metadataCache: {
      getFileCache: () => ({ frontmatter: { tags: ['album'] }, tags: [{ tag: '#album' }] }),
    },
    workspace: {
      getLeavesOfType: () => [],
      getLeaf: () => ({ setViewState: async () => {}, openFile: async () => {} }),
      getRightLeaf: () => null,
      revealLeaf: async () => {},
    },
  };
  const plugin = new mod.exports.default(app, { id: 'vinyl-life', dir: 'plugins/vinyl-life' });
  plugin.loadData = async () => ({ stats: { totalPlays: 0, albums: {}, tracks: {}, events: [] } });
  plugin.saveData = async () => {};
  plugin.settings = {
    coverFolder: '',
    albumFolder: 'Vinyl Life/Vinyl Note',
    playerLocation: 'sidebar',
    stats: { totalPlays: 0, albums: {}, tracks: {}, events: [] },
    sourceFailures: {},
  };
  const queue = tracks.map((title) => ({
    title,
    album: 'A',
    albumNotePath: 'Vinyl Life/Vinyl Note/A.md',
    source: 'local-vault',
    path: `/music/${title}.mp3`,
  }));
  plugin.engine = {
    loadAlbum: async () => ({ tracks: queue, reason: '' }),
    snapshot: () => ({ queue }),
    preloadIndex: async (i, pos) => calls.push(['preload', i, pos]),
    play: async () => calls.push(['play']),
  };
  return { plugin, calls };
}

test('位置链接：专辑 / 曲名 / 秒数都编码进去，能直接贴进笔记', () => {
  const { plugin } = boot();
  const link = plugin.resumeLink('Vinyl Life/Vinyl Note/A · B.md', '曲名 & 符号', 192.7);
  assert.match(link, /^obsidian:\/\/vinyl-life\?album=/);
  assert.ok(link.includes(encodeURIComponent('Vinyl Life/Vinyl Note/A · B.md')), '路径编码');
  assert.ok(link.includes(`track=${encodeURIComponent('曲名 & 符号')}`), '曲名编码（含 & 这种会截断查询串的字符）');
  assert.ok(link.includes('pos=192'), '秒数取整：非整数秒进了 URL 会解析成 NaN');
});

test('点位置回来：载入专辑 + 按曲名定位 + 跳到那一刻 + 开播', async () => {
  const { plugin, calls } = boot();
  await plugin.resumeFromNote({
    album: encodeURIComponent('Vinyl Life/Vinyl Note/A.md'),
    track: encodeURIComponent('Two'),
    pos: '65',
  });
  assert.deepEqual(calls, [['preload', 1, 65], ['play']], '定位到第 2 首、从 65 秒开始播');
});

test('脏参数：专辑找不到 / 曲名对不上 / 位置不是数字，都只提示不乱播', async () => {
  notices.length = 0;
  const miss = boot({ withAlbum: false });
  await miss.plugin.resumeFromNote({ album: 'Vinyl Life/Vinyl Note/A.md', track: 'Two', pos: '65' });
  assert.equal(miss.calls.length, 0, '专辑笔记不在：引擎一动不动');
  assert.ok(notices.some((n) => n.includes('专辑笔记找不到')), '要告诉用户为什么没反应');

  notices.length = 0;
  const wrongTrack = boot();
  await wrongTrack.plugin.resumeFromNote({ album: 'Vinyl Life/Vinyl Note/A.md', track: '没有这首', pos: '65' });
  assert.equal(wrongTrack.calls.length, 0, '对不上曲名就别猜（宁可不开播）');
  assert.ok(notices.some((n) => n.includes('没找到那一首')));

  const badPos = boot();
  await badPos.plugin.resumeFromNote({
    album: encodeURIComponent('Vinyl Life/Vinyl Note/A.md'),
    track: 'One',
    pos: 'abc',
  });
  assert.deepEqual(badPos.calls, [['preload', 0, 0], ['play']], '位置坏了就当从头播，别整个失败');
});

test('接线：协议处理器注册在用感想写的同一条链路上', () => {
  const src = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
  assert.match(
    src,
    /registerObsidianProtocolHandler\('vinyl-life'/,
    '注册 obsidian://vinyl-life 处理器'
  );
  assert.match(
    src,
    /` · \[\$\{fmtTime\(snap\.currentTime\)\}\]\(\$\{this\.resumeLink\(/,
    '感想那一行把位置写成链接（不是普通文本）'
  );
  assert.match(src, /notice\(t\('notice\.jumpNoAlbum'\)\)/, '失败路径要有提示');
});
