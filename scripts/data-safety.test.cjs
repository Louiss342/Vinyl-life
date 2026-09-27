// 数据安全网的四条：读不出来的 data.json、追加听歌记录的原子性、恢复备份后的写入闸门、
// 重命名专辑时的键迁移。每一条都对着一次「不可逆」：
//   ① data.json 解析失败时 loadData 返回 null，与「文件不存在」不可区分 —— 一律按全新安装
//      处理的话，用户唯一一份设置与统计会被默认值盖掉；更糟的是自动备份还会写出一份空备份，
//      按保留份数把上一份真正的好备份挤掉（等于用一次坏读毁掉仅有的退路）。
//   ② vault.read + vault.modify 之间，编辑器里敲的字（约 2 秒防抖）会被后一次整篇写回盖掉。
//   ③ 恢复备份到重启之间 saveSettings 是早退的：这期间「先删文件、再写盘」的动作会留下
//      删了文件却没写盘的半截状态（封面副本没了，统计重启后又「复活」）。
//   ④ 统计与失败记录按「笔记路径」键控：重命名不搬键，统计页就会给出一颗会把专辑复制一份的
//      「恢复」按钮。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
  }
}
class TFile {
  constructor(filePath) {
    this.path = filePath;
    this.basename = path.basename(filePath).replace(/\.md$/, '');
    this.extension = 'md';
  }
}
class TFolder {}
const notices = [];
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
          Notice: class {
            constructor(msg) {
              notices.push(String(msg));
            }
          },
          Plugin,
          PluginSettingTab: class {},
          SettingPage: class {},
          Setting: class {},
          TFile,
          TFolder,
          FuzzySuggestModal: class {},
          normalizePath: (p) => p,
          setIcon: () => {},
        }
      : require(name),
  Buffer,
  process,
  console: { log() {}, warn() {}, error() {} },
  Date,
  setTimeout,
  clearTimeout,
  window: { setTimeout: () => 0, clearTimeout: () => {} },
  document: { createElement: () => ({ style: {} }) },
  Audio: class {
    addEventListener() {}
  },
});

/** 一次性装配：data.json 的盘面 + 库 API 都按用例给定 */
function boot(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinyl-data-'));
  const written = new Map(); // adapter.write 落下的文件（data.json / corrupt 副本）
  const saved = [];
  const created = [];
  const processCalls = [];
  let dataJson = opts.dataJson; // undefined = 盘上没有这个文件
  let failProcess = false;
  const files = new Map();

  const adapter = {
    getBasePath: () => dir,
    exists: async (p) => (p.endsWith('data.json') ? dataJson !== undefined : written.has(p)),
    read: async (p) => {
      if (p.endsWith('data.json')) {
        if (dataJson === undefined) throw new Error('ENOENT');
        return dataJson;
      }
      if (!written.has(p)) throw new Error('ENOENT');
      return written.get(p);
    },
    write: async (p, value) => {
      written.set(p, value);
    },
  };
  const vault = {
    adapter,
    getAbstractFileByPath: (p) => files.get(p) ?? null,
    create: async (p, content) => {
      created.push({ path: p, content });
      return new TFile(p);
    },
    createFolder: async () => {},
    process: async (file, fn) => {
      processCalls.push(file.path);
      if (failProcess) throw new Error('EACCES');
      return fn(opts.currentContent ?? '');
    },
    read: async () => {
      throw new Error('不该走 vault.read：读改写必须用 vault.process');
    },
    modify: async () => {
      throw new Error('不该走 vault.modify：同上');
    },
    getMarkdownFiles: () => [],
    on: () => ({}),
  };
  const app = {
    vault,
    workspace: {
      getLeavesOfType: () => [],
      getLeaf: () => ({ openFile: async () => {}, view: {} }),
      on: () => ({}),
    },
  };
  const plugin = new mod.exports.default(app, { id: 'vinyl-life', dir: 'plugins/vinyl-life' });
  // Obsidian 的 loadData：文件不存在**或** JSON 解析失败都返回 null —— 这正是这条用例的立足点
  plugin.loadData = async () => {
    if (dataJson === undefined) return null;
    try {
      return JSON.parse(dataJson);
    } catch {
      return null;
    }
  };
  plugin.saveData = async (next) => saved.push(JSON.parse(JSON.stringify(next)));

  return {
    dir,
    plugin,
    /** 封面缓存目录：按 pluginAbsPath 的口径算（base + manifest.dir + '.stats-covers'） */
    coversDir: path.join(dir, 'plugins', 'vinyl-life', '.stats-covers'),
    written,
    saved,
    created,
    processCalls,
    files,
    notices,
    setDataJson: (v) => (dataJson = v),
    failProcess: () => (failProcess = true),
    savedNow: () => saved[saved.length - 1],
  };
}

// ============ ① 读不出来的 data.json ============

test('data.json 存在但解析不出来 → 原文件另存一份，绝不静默按全新安装覆盖', async () => {
  const h = boot({ dataJson: '{"stats":{"totalPlays":42}, "albumFolder"' }); // 截断：同步写坏的典型
  notices.length = 0;
  await h.plugin.loadSettings();

  const copy = [...h.written.keys()].find((p) => p.includes('data.json.corrupt'));
  assert.ok(copy, '要留下损坏文件的副本：' + [...h.written.keys()].join(', '));
  assert.equal(h.written.get(copy), '{"stats":{"totalPlays":42}, "albumFolder"', '副本是原样的字节');
  assert.ok(
    notices.some((n) => n.includes('data.json') && n.includes(path.basename(copy))),
    '要提示用户副本落在哪：' + notices.join(' | ')
  );
  assert.equal(h.plugin.settings.stats.totalPlays, 0, '内存里按默认值（原数据在副本里）');
});

test('data.json 不存在（真·全新安装）→ 不写副本、不打扰用户', async () => {
  const h = boot({ dataJson: undefined });
  notices.length = 0;
  await h.plugin.loadSettings();
  assert.equal([...h.written.keys()].length, 0, '没有可留档的东西');
  assert.equal(notices.length, 0, '新装用户不该看到任何告警');
});

test('data.json 正常 → 一个字节都不多写', async () => {
  const good = JSON.stringify({ stats: { totalPlays: 7, albums: {}, tracks: {}, events: [] } });
  const h = boot({ dataJson: good });
  notices.length = 0;
  await h.plugin.loadSettings();
  assert.equal(h.plugin.settings.stats.totalPlays, 7);
  assert.equal([...h.written.keys()].length, 0);
  assert.equal(notices.length, 0);
});

test('读不出 data.json 的那次会话里不自动备份（空的「备份」会把上一份好备份挤掉）', async () => {
  const h = boot({ dataJson: '{ 坏掉的' });
  await h.plugin.loadSettings();
  const before = h.created.length;
  await h.plugin.maybeAutoBackup();
  assert.equal(h.created.length, before, '不许写自动备份：保留份数一裁，上一份真的备份就没了');
});

// ============ ② 追加听歌记录：原子写 ============

test('追加听歌记录走 vault.process（读改写原子），不再 read + modify', async () => {
  const h = boot({ currentContent: '正文第一行\n' });
  h.files.set('Vinyl Note/A.md', new TFile('Vinyl Note/A.md'));
  h.plugin.engine = {
    snapshot: () => ({ albumNotePath: 'Vinyl Note/A.md', current: null, currentTime: 0 }),
  };
  notices.length = 0;
  await h.plugin.appendListeningNote('Vinyl Note/A.md');
  assert.deepEqual(h.processCalls, ['Vinyl Note/A.md'], '必须走 process 这条路');
  assert.ok(
    notices.some((n) => n.includes('已追加')),
    '成功提示照旧：' + notices.join(' | ')
  );
});

test('追加失败要报出来（不能静默 void 掉）', async () => {
  const h = boot({ currentContent: 'x' });
  h.files.set('Vinyl Note/A.md', new TFile('Vinyl Note/A.md'));
  h.plugin.engine = { snapshot: () => ({ albumNotePath: 'Vinyl Note/A.md', current: null }) };
  h.failProcess();
  notices.length = 0;
  await h.plugin.appendListeningNote('Vinyl Note/A.md');
  assert.ok(
    notices.some((n) => n.includes('失败') && n.includes('EACCES')),
    '写不进去要让用户知道：' + notices.join(' | ')
  );
});

// ============ ③ 恢复备份后的写入闸门 ============

test('恢复备份后、重启前：「清除统计」不执行（否则删了封面缓存却写不回统计）', async () => {
  const h = boot({ dataJson: JSON.stringify({ stats: { totalPlays: 5, albums: {}, tracks: {}, events: [] } }) });
  await h.plugin.loadSettings();
  const cacheDir = h.coversDir;
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'a.jpg'), 'cover');

  h.plugin.awaitingRestartAfterRestore = true;
  notices.length = 0;
  await h.plugin.clearPlaybackStats();

  assert.ok(fs.existsSync(cacheDir), '封面缓存不能被删：统计还写不回去，重启后就成了破图');
  assert.equal(h.plugin.settings.stats.totalPlays, 5, '内存里的统计也不该清');
  assert.ok(
    notices.some((n) => n.includes('重启')),
    '要说清为什么没执行：' + notices.join(' | ')
  );
  assert.equal(h.saved.length, 0, '没有落盘动作');
});

test('没在等重启时：清除统照旧执行（闸门别开太大）', async () => {
  const h = boot({ dataJson: JSON.stringify({ stats: { totalPlays: 5, albums: {}, tracks: {}, events: [] } }) });
  await h.plugin.loadSettings();
  const cacheDir = h.coversDir;
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'a.jpg'), 'cover');
  await h.plugin.clearPlaybackStats();
  assert.equal(fs.existsSync(cacheDir), false, '正常路径下缓存该清就清');
  assert.equal(h.plugin.settings.stats.totalPlays, 0);
  assert.ok(h.saved.length > 0, '并且落盘');
});

// ============ ④ 重命名时的键迁移 ============

test('重命名专辑笔记：统计与失败记录的键跟着走', async () => {
  const h = boot({});
  await h.plugin.loadSettings();
  h.plugin.settings.stats.albums = { 'Vinyl Note/A.md': { plays: 3 }, 'Vinyl Note/B.md': { plays: 1 } };
  h.plugin.settings.sourceFailures = { 'Vinyl Note/A.md': { message: 'x', at: 1 } };

  h.plugin.migrateAlbumKeys('Vinyl Note/A.md', 'Vinyl Note/A2.md');

  assert.deepEqual(Object.keys(h.plugin.settings.stats.albums).sort(), [
    'Vinyl Note/A2.md',
    'Vinyl Note/B.md',
  ]);
  assert.equal(h.plugin.settings.stats.albums['Vinyl Note/A2.md'].plays, 3, '记录原样搬过去');
  assert.deepEqual(Object.keys(h.plugin.settings.sourceFailures), ['Vinyl Note/A2.md']);
  assert.ok(h.saved.length > 0, '搬完要落盘（否则统计页刷新一次又变回「已移除」）');
});

test('重命名整个文件夹：里面的专辑笔记按前缀整段搬', async () => {
  const h = boot({});
  await h.plugin.loadSettings();
  h.plugin.settings.stats.albums = {
    'Vinyl Life/Vinyl Note/A.md': { plays: 1 },
    'Vinyl Life/Vinyl Note/Sub/B.md': { plays: 2 },
    'Other/C.md': { plays: 3 },
  };
  h.plugin.migrateAlbumKeys('Vinyl Life/Vinyl Note', 'Vinyl Life/Albums');
  assert.deepEqual(Object.keys(h.plugin.settings.stats.albums).sort(), [
    'Other/C.md',
    'Vinyl Life/Albums/A.md',
    'Vinyl Life/Albums/Sub/B.md',
  ]);
});

test('键迁移：目标位置已有记录时不覆盖（两次 rename 事件谁先到都成立）', async () => {
  const h = boot({});
  await h.plugin.loadSettings();
  h.plugin.settings.stats.albums = { 'A.md': { plays: 1 }, 'C.md': { plays: 9 } };
  h.plugin.migrateAlbumKeys('A.md', 'C.md');
  assert.equal(h.plugin.settings.stats.albums['C.md'].plays, 9, '目标已有的那条不能被顶掉');
  assert.equal(h.plugin.settings.stats.albums['A.md'].plays, 1, '搬不过去就留在原处（宁可多一条也不要毁数据）');
});

test('键迁移：普通笔记改名不碰统计表', async () => {
  const h = boot({});
  await h.plugin.loadSettings();
  h.plugin.settings.stats.albums = { 'Vinyl Note/A.md': { plays: 1 } };
  h.plugin.migrateAlbumKeys('日记/2026-09-27.md', '日记/2026-09-28.md');
  assert.deepEqual(Object.keys(h.plugin.settings.stats.albums), ['Vinyl Note/A.md']);
  assert.equal(h.saved.length, 0, '没事发生就不落盘');
});

test('接线：vault 的 rename 事件里真的调了键迁移（方法写对而没接上，等于没修）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  assert.match(
    src,
    /on\('rename'[\s\S]{0,240}?migrateAlbumKeys\(/,
    'rename 订阅里要调 migrateAlbumKeys —— 否则统计页照旧把改名当删除'
  );
});
