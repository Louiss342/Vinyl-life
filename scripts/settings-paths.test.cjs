// 设置页「路径」与统计导出目录回归（1.3.0）：
//   A 接线（源码扫描）：通用页「路径」卡四类目录齐全；音频根目录从「源」页移来、不再两处各一份；
//     收藏健康检查不再放「刷新专辑墙」（专辑墙「更多」里那枚是唯一入口）。
//   B 行为（main.ts 实跑）：旧 data.json 没有 statsFolder 时按原推导口径补齐
//     （专辑笔记目录的上一级 + Stats），显式设置照用，导出笔记落在设置的目录里。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const SETTINGS = read('src/settings.ts');
const I18N = read('src/core/i18n.ts');
const HEALTH = read('src/views/library-health.ts');
const SHELF = read('src/views/shelf-view.ts');

// ============ A. 接线 ============

test('设置：通用页「路径」卡五类目录齐全（顺序即卡片排布）', () => {
  const general = SETTINGS.slice(
    SETTINGS.indexOf('private renderGeneralTab'),
    SETTINGS.indexOf('private renderAppearanceTab')
  );
  assert.ok(general.length > 0, '探针：没截到通用页');
  // 每行都走带即时校验的 pathRow（校验细节见下一条）：专辑笔记 / 封面 / 音频 / 统计导出 / 队列笔记
  const keys = [...general.matchAll(/this\.pathRow\(body, t\('(settings\.\w+)'\), '\w+'\)/g)].map(
    (m) => m[1]
  );
  assert.deepEqual(keys, [
    'settings.albumFolder',
    'settings.coverFolder',
    'settings.audioFolder',
    'settings.statsFolder',
    'settings.queueFolder',
  ]);
});

test('设置：音频根目录只在通用页出现一次，「源」页只留落库模式', () => {
  assert.equal(
    (SETTINGS.match(/t\('settings\.audioFolder'\)/g) || []).length,
    1,
    '音频根目录应在「通用 → 路径」里，且不再于「源」页重复一份'
  );
  const sourceTab = SETTINGS.slice(
    SETTINGS.indexOf('private renderSourceTab'),
    SETTINGS.indexOf('private renderAboutTab')
  );
  assert.ok(sourceTab.length > 0, '探针：没截到源页');
  assert.doesNotMatch(sourceTab, /settings\.audioFolder/, '「源 → 本地源」不该再放音频目录');
  assert.match(sourceTab, /t\('settings\.importMode'\)/, '落库模式仍留在「源 → 本地源」');
});

test('设置：默认音源与音质在「源」页（音源管理入口），不在通用页', () => {
  const general = SETTINGS.slice(
    SETTINGS.indexOf('private renderGeneralTab'),
    SETTINGS.indexOf('private renderAppearanceTab')
  );
  const sourceTab = SETTINGS.slice(
    SETTINGS.indexOf('private renderSourceTab'),
    SETTINGS.indexOf('private renderAboutTab')
  );
  assert.doesNotMatch(general, /settings\.defaultSource/, '通用页不该再有「默认音源」');
  assert.doesNotMatch(general, /t\('settings\.quality'\)/, '通用页不该再有「音质」');
  assert.match(sourceTab, /t\('settings\.defaultSource'\)/, '「源」页要有默认音源');
  assert.match(sourceTab, /t\('settings\.quality'\)/, '「源」页要有音质');
  assert.match(
    sourceTab,
    /t\('settings\.defaultSource'\)[\s\S]*?t\('settings\.sub\.netease'\)/,
    '默认与音质排在平台登录之前（一张卡先回答「默认走哪一路」）'
  );
});

// util.ts 的路径校验：设置页的即时校验靠它（纯函数，单独 bundle 就能跑）
const utilMod = (() => {
  const src = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '../src/util.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text;
  const m = { exports: {} };
  new Function('require', 'module', 'exports', src)(
    (name) =>
      name === 'obsidian'
        ? {
            App: class {},
            Plugin: class {},
            Notice: class {},
            TFile: class {},
            TFolder: class {},
            Menu: class {},
            Modal: class {},
            normalizePath: (p) => p,
          }
        : require(name),
    m,
    m.exports
  );
  return m.exports;
})();

test('目录校验：库内相对路径放行，盘符 / 绝对路径 / .. / 保留字符都拦下', () => {
  const issue = utilMod.vaultFolderIssue;
  assert.equal(issue('Vinyl Life/Vinyl Note'), '', '正常相对路径');
  assert.equal(issue('  Vinyl Life/covers  '), '', '首尾空白不算错');
  assert.equal(issue(''), 'empty');
  assert.equal(issue('   '), 'empty');
  assert.equal(issue('C:\\Music\\Vinyl'), 'absolute', '盘符开头');
  assert.equal(issue('/Music'), 'absolute', '斜杠开头');
  assert.equal(issue('Library/../Music'), 'parent');
  assert.equal(issue('Music#1'), 'chars', '# 会被 Obsidian 截断');
  assert.equal(issue('Music:1'), 'chars', 'Windows 保留字符');
  assert.equal(issue('Music[1]'), 'chars');
});

// 目录行刻意保持「就是一个输入框」：只有填错时才描一圈告警色，不加状态行、不加卡片说明
// （早先版本加过「最终：… · 已存在」那种状态行和一句底部说明，用户嫌乱，已撤）
test('设置：目录行只在填错时描告警色，不加多余的状态行 / 说明', () => {
  assert.match(SETTINGS, /private pathRow\(/, '五类目录共用同一个带校验的行');
  assert.equal(
    (SETTINGS.match(/this\.pathRow\(body, t\('settings\.\w+Folder'\), '\w+'\)/g) || []).length,
    5,
    '五个目录都走 pathRow'
  );
  assert.match(SETTINGS, /vaultFolderIssue\(/, '输入时校验路径');
  assert.match(SETTINGS, /vinyl-path-invalid/, '无效路径挂告警类（样式在 styles.css）');
  assert.doesNotMatch(SETTINGS, /vinyl-path-state|vinyl-path-note/, '不再有状态行与底部说明');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /input\.vinyl-path-invalid\s*\{[^}]*--text-error/, '告警样式在');
  assert.doesNotMatch(css, /\.vinyl-path-state|\.vinyl-path-note/, '相关样式已清掉');
  assert.doesNotMatch(I18N, /settings\.pathExists|settings\.pathWillCreate|settings\.pathsNote/, '词典里也不留这些文案');
});

test('接线：收藏健康检查不再放「刷新专辑墙」，专辑墙「更多」保留唯一入口', () => {
  assert.doesNotMatch(HEALTH, /more\.refresh/, '弹窗里的刷新按钮应已删除（专辑墙「更多」已有同类操作）');
  assert.match(
    SHELF,
    /setTitle\(t\('more\.refresh'\)\)/,
    '专辑墙「更多」里的「刷新专辑墙」是保留项'
  );
});

// ============ B. 行为（跑真 main.ts）============

const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/main.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian', 'electron', '@electron/remote'],
}).outputFiles[0].text;

class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
}
class TFolder {
  constructor(path) {
    this.path = path;
  }
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
          Notice: class {},
          Plugin,
          PluginSettingTab: class {},
          SettingPage: class {},
          Setting: class {},
          TFile: class {},
          TFolder,
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
  Audio: class {
    addEventListener() {}
  },
});

const EMPTY_STATS = { totalPlays: 0, albums: {}, tracks: {}, events: [] };

/** 起一个只够跑设置与导出的插件壳：vault.create 记录落点，不真写盘。
 *  opts.folders 里的目录「已存在」，改名走 fileManager.renameFile 并被记下来。 */
function boot(data, opts = {}) {
  const created = [];
  const renames = [];
  const tree = new Map((opts.folders || []).map((p) => [p, new TFolder(p)]));
  const app = {
    vault: {
      adapter: { getBasePath: () => process.cwd() },
      getAbstractFileByPath: (p) => tree.get(p) ?? null,
      createFolder: async () => {},
      create: async (name, content) => {
        created.push({ name, content });
        return { path: name };
      },
    },
    fileManager: {
      renameFile: async (file, to) => {
        renames.push([file.path, to]);
        tree.delete(file.path);
        tree.set(to, new TFolder(to));
      },
    },
    workspace: { getLeavesOfType: () => [] },
  };
  const plugin = new mod.exports.default(app, { id: 'vinyl-life', dir: 'plugins/vinyl-life' });
  plugin.loadData = async () => data;
  plugin.saveData = async () => {};
  return { plugin, created, renames, tree };
}

test('目录名统一：旧默认名（covers / audio / template）启动时改成首字母大写', async () => {
  const { plugin, renames } = boot(
    {
      coverFolder: 'Vinyl Life/covers',
      audioFolder: 'Vinyl Life/audio',
      albumNoteTemplate: 'Vinyl Life/template/专辑笔记模板.md',
      stats: EMPTY_STATS,
    },
    { folders: ['Vinyl Life/covers', 'Vinyl Life/audio', 'Vinyl Life/template'] }
  );
  await plugin.loadSettings();
  assert.deepEqual(renames, [
    ['Vinyl Life/covers', 'Vinyl Life/Covers'],
    ['Vinyl Life/audio', 'Vinyl Life/Audio'],
    ['Vinyl Life/template', 'Vinyl Life/Template'],
  ]);
  assert.equal(plugin.settings.coverFolder, 'Vinyl Life/Covers');
  assert.equal(plugin.settings.audioFolder, 'Vinyl Life/Audio');
  assert.equal(
    plugin.settings.albumNoteTemplate,
    'Vinyl Life/Template/专辑笔记模板.md',
    '模板文件跟着目录一起搬，设置同步'
  );
});

test('目录名统一：自定义路径不碰；新目录已存在时跳过（绝不合并）', async () => {
  const custom = boot(
    { coverFolder: 'My/Artwork', albumNoteTemplate: 'My/Tpl.md', stats: EMPTY_STATS },
    { folders: ['Vinyl Life/covers', 'Vinyl Life/template'] }
  );
  await custom.plugin.loadSettings();
  assert.deepEqual(custom.renames, [], '设置不是旧默认值：一个目录都不动');
  assert.equal(custom.plugin.settings.coverFolder, 'My/Artwork');
  assert.equal(custom.plugin.settings.albumNoteTemplate, 'My/Tpl.md');

  const conflict = boot(
    { coverFolder: 'Vinyl Life/covers', stats: EMPTY_STATS },
    { folders: ['Vinyl Life/covers', 'Vinyl Life/Covers'] }
  );
  await conflict.plugin.loadSettings();
  assert.deepEqual(conflict.renames, [], '新目录已存在：跳过而不是合并');
  assert.equal(conflict.plugin.settings.coverFolder, 'Vinyl Life/covers', '设置也就不动');

  const nothing = boot({ stats: EMPTY_STATS });
  await nothing.plugin.loadSettings();
  assert.deepEqual(nothing.renames, [], '旧目录根本不存在：什么也不做');
});

test('默认值就是首字母大写那一套（新装的库不再长出混杂命名）', () => {
  for (const line of [
    "coverFolder: 'Vinyl Life/Covers'",
    "audioFolder: 'Vinyl Life/Audio'",
    "statsFolder: 'Vinyl Life/Stats'",
    "queueFolder: 'Vinyl Life/Queues'",
    "albumFolder: 'Vinyl Life/Vinyl Note'",
  ]) {
    assert.ok(SETTINGS.includes(line), `DEFAULT_SETTINGS 里应有 ${line}`);
  }
  const main = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
  assert.match(main, /\}Template\/专辑笔记模板\.md/, '模板默认落点也是 Template/');
  assert.doesNotMatch(main, /\}template\/专辑笔记模板\.md/, '不再是旧的 template/ 落点');
});

test('统计导出目录：默认值 + 旧数据按原口径补齐 + 显式设置照用', async () => {
  const fresh = boot({ stats: EMPTY_STATS });
  await fresh.plugin.loadSettings();
  assert.equal(fresh.plugin.settings.statsFolder, 'Vinyl Life/Stats', '新装默认');

  const legacy = boot({ albumFolder: 'Music/Notes', stats: EMPTY_STATS });
  await legacy.plugin.loadSettings();
  assert.equal(
    legacy.plugin.settings.statsFolder,
    'Music/Stats',
    '旧 data.json 没有 statsFolder：沿用「专辑笔记目录的上一级 + Stats」，导出落点不凭空换地方'
  );

  const custom = boot({ statsFolder: 'Archive/Vinyl Stats', stats: EMPTY_STATS });
  await custom.plugin.loadSettings();
  assert.equal(custom.plugin.settings.statsFolder, 'Archive/Vinyl Stats');
});

test('导出笔记落在设置的统计目录里', async () => {
  const { plugin, created } = boot({ statsFolder: 'Archive/Vinyl Stats', stats: EMPTY_STATS });
  await plugin.loadSettings();
  const file = await plugin.exportPlaybackStats();
  assert.match(
    file.path,
    /^Archive\/Vinyl Stats\/Vinyl Life 播放统计 \d{4}-\d{2}-\d{2}\.md$/,
    '导出走 settings.statsFolder，不再跟着专辑笔记目录推导'
  );
  assert.equal(created[0].name, file.path);
});
