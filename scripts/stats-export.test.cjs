// 导出笔记（历史页 → 一键导出为笔记）的版式回归：
//   摘要做成 callout、每个榜带一行字符柱状、播放最多的前五张给封面条（只有库内封面才嵌）、
//   结尾一段说明口径与导出时间的 callout。这里跑真 main.ts，用假库拼出几档数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/main.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian', 'electron', '@electron/remote'],
}).outputFiles[0].text;

class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; }
}
class TFile {
  constructor(p) {
    this.path = p;
    this.name = p.split('/').pop();
    this.basename = this.name.replace(/\.md$/, '');
    this.extension = this.name.split('.').pop();
  }
}
class TFolder {}
const mod = { exports: {} };
vm.runInNewContext(source, {
  module: mod,
  exports: mod.exports,
  require: (name) =>
    name === 'obsidian'
      ? {
          App: class {}, ItemView: class {}, MarkdownView: class {}, Modal: class {}, Notice: class {},
          Plugin, PluginSettingTab: class {}, SettingPage: class {}, Setting: class {},
          TFile, TFolder, FuzzySuggestModal: class {}, normalizePath: (p) => p, setIcon: () => {},
        }
      : require(name),
  Buffer, process, console, Date, Map, Object, Array, Math, JSON, isFinite,
  setTimeout, clearTimeout,
  window: { setTimeout: () => 0, clearTimeout: () => {} },
  document: { createElement: () => ({ style: {} }) },
  Audio: class { addEventListener() {} },
});

const NOTE = 'Vinyl Life/Vinyl Note/A.md';
const COVER = 'Vinyl Life/Covers/A.jpg';

/** 假库：专辑笔记与封面可选地存在，frontmatter 里带 cover 链接 */
function boot({ withNote = true, withCover = true } = {}) {
  const files = new Map();
  if (withNote) files.set(NOTE, new TFile(NOTE));
  // 封面文件本身也要按开关存在：不然「同名图片自动认封面」的约定分支会把它找回来
  if (withCover) files.set(COVER, new TFile(COVER));
  const app = {
    vault: {
      adapter: { getBasePath: () => process.cwd() },
      getAbstractFileByPath: (p) => files.get(p) ?? null,
      getResourcePath: (f) => `app://${f.path}`,
      createFolder: async () => {},
      create: async (name) => new TFile(name),
    },
    metadataCache: {
      getFileCache: (f) =>
        f.path === NOTE
          ? { frontmatter: { tags: ['album'], cover: withCover ? `[[${COVER}]]` : null } }
          : null,
      // 只认 frontmatter 里那个 cover 链接（「同名图片自动认封面」的约定探测一律不命中，
      // 否则 withCover:false 那档会从约定分支把封面找回来）
      getFirstLinkpathDest: (linkpath) =>
        withCover && linkpath === COVER ? files.get(COVER) : null,
    },
    fileManager: { trashFile: async () => {} },
    workspace: { getLeavesOfType: () => [], getLeaf: () => ({ setViewState: async () => {} }) },
  };
  const plugin = new mod.exports.default(app, { id: 'vinyl-life', dir: 'plugins/vinyl-life' });
  plugin.loadData = async () => ({ stats: { totalPlays: 0, albums: {}, tracks: {}, events: [] } });
  plugin.saveData = async () => {};
  plugin.settings = {
    ...mod.exports.default.prototype?.settings,
    albumFolder: 'Vinyl Life/Vinyl Note',
    coverFolder: 'Vinyl Life/Covers',
    shelfProps: ['artist', 'year'],
    shelfPropLabels: {},
    stats: { totalPlays: 0, albums: {}, tracks: {}, events: [] },
  };
  return plugin;
}

const day = (n) => new Date(2026, 8, n, 12, 0).getTime();

function sampleStats() {
  return {
    totalPlays: 24,
    albums: {
      [NOTE]: { plays: 16, lastPlayedAt: day(25), snapshot: { title: 'A' } },
      'Gone.md': { plays: 5, lastPlayedAt: day(10), snapshot: { title: '消失的专辑' } },
      'Other.md': { plays: 3, lastPlayedAt: day(5), snapshot: { title: 'Other' } },
    },
    tracks: { 'ne:1': { plays: 24, lastPlayedAt: day(25) } },
    events: [
      { at: day(25), trackKey: 'ne:1', albumPath: NOTE },
      { at: day(25), trackKey: 'ne:1', albumPath: NOTE },
      { at: day(20), trackKey: 'ne:1', albumPath: NOTE },
      { at: day(5), trackKey: 'ne:1', albumPath: 'Other.md' },
    ],
  };
}

const render = (plugin, stats) => plugin.statsNoteLines(stats).join('\n');

test('导出：摘要 callout + 记录跨度 + 每榜带柱状 + 结尾说明', () => {
  const text = render(boot(), sampleStats());
  assert.match(text, /^> \[!abstract\] 我的听歌统计$/m, '摘要是一个 callout');
  assert.match(text, /^> \*\*24\*\* 次播放 · \*\*3\*\* 张专辑/m, '关键数字加粗');
  assert.match(text, /^> 2026-09-05 → 2026-09-25 · 最活跃的一天：2026-09-25（2 次）$/m, '跨度与最活跃的一天');
  assert.match(text, /^\| 2026-09 \| 4 \| 100% \| █+ \|$/m, '月度表带占比与柱状');
  assert.match(text, /^\| \*\*1\*\* \| /m, '播放最多前三名加粗');
  assert.match(text, /\| 16 \| █+ \| 2026-09-25 \|$/m, '播放列后面跟柱状');
  assert.match(text, /^> \[!note\] 关于这份统计$/m, '结尾是说明 callout');
  assert.match(text, /^> 导出于 .+ · 数据来自 Vinyl Life 的本地统计$/m, '导出时间与来源');
  assert.doesNotMatch(text, /\{\{/, '不留没替换的占位符');
  assert.doesNotMatch(text, /^# /m, '不写 H1（文件名就是标题）');
});

test('封面条：只在前五名里挑能嵌的，嵌不到就整段不出现', () => {
  const withCover = render(boot({ withNote: true, withCover: true }), sampleStats());
  assert.match(withCover, /^### 封面$/m, '有可嵌封面时给封面条');
  assert.match(withCover, new RegExp(`^- !\\[\\[${COVER.replace(/[.]/g, '\\.')}\\|120\\]\\] \\*\\*A\\*\\* · 16 次$`, 'm'));
  assert.equal(
    (withCover.match(/^- !\[\[/gm) || []).length,
    1,
    '只有第一名那张有库内封面（其余两张是已移除 / 无封面）'
  );

  const noCover = render(boot({ withNote: true, withCover: false }), sampleStats());
  assert.doesNotMatch(noCover, /^### 封面$/m, '一张都嵌不到就不留空标题');
});

test('空统计也能导出：只有摘要与说明，没有空表', () => {
  const text = render(boot(), { totalPlays: 0, albums: {}, tracks: {}, events: [] });
  assert.match(text, /^> \[!abstract\] /m);
  assert.doesNotMatch(text, /^## /m, '没有任何分区标题');
  assert.doesNotMatch(text, /^\| /m, '没有空表格');
  assert.match(text, /^> \[!note\] /m);
});
