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
class TFile {}
class TFolder {
  constructor(path, children) {
    this.path = path;
    this.children = children;
  }
}
const notices = [];
const mod = { exports: {} };
vm.runInNewContext(source, {
  module: mod, exports: mod.exports,
  require: (name) => name === 'obsidian' ? {
    App: class {}, ItemView: class {}, MarkdownView: class {}, Modal: class {},
    Notice: class { constructor(msg) { notices.push(String(msg)); } },
    Plugin, PluginSettingTab: class {}, SettingPage: class {}, Setting: class {},
    TFile, TFolder, FuzzySuggestModal: class {}, normalizePath: (p) => p, setIcon: () => {},
  } : require(name),
  Buffer, process, console, Date, setTimeout, clearTimeout,
  window: { setTimeout: () => 0, clearTimeout: () => {} },
  document: { createElement: () => ({ style: {} }) },
  Audio: class { addEventListener() {} },
});

test('备份恢复：先保留当前数据，错误格式不覆盖；重启前旧会话不反写', async () => {
  let saved = { stats: { totalPlays: 3, albums: {}, tracks: {}, events: [] } };
  const created = [];
  const app = {
    vault: {
      adapter: { getBasePath: () => process.cwd() },
      getAbstractFileByPath: () => null,
      createFolder: async () => {},
      create: async (name, content) => { created.push({ name, content }); return { path: name }; },
    },
    workspace: { getLeavesOfType: () => [] },
  };
  const plugin = new mod.exports.default(app, { id: 'vinyl-life', dir: 'plugins/vinyl-life' });
  plugin.loadData = async () => saved;
  plugin.saveData = async (data) => { saved = data; };
  await plugin.loadSettings();

  await assert.rejects(plugin.restoreDataBackup('{"format":"other"}'));
  await assert.rejects(plugin.restoreDataBackup('{"format":"vinyl-life-backup","version":1,"settings":{}}'));
  assert.equal(saved.stats.totalPlays, 3);
  assert.equal(created.length, 0);

  const backup = { format: 'vinyl-life-backup', version: 1,
    settings: { stats: { totalPlays: 7, albums: {}, tracks: {}, events: [] } } };
  await plugin.restoreDataBackup(JSON.stringify(backup));
  assert.equal(created.length, 1);
  assert.equal(JSON.parse(created[0].content).settings.stats.totalPlays, 3);
  assert.equal(saved.stats.totalPlays, 7);
  plugin.settings.stats.totalPlays = 99;
  await plugin.saveSettings();
  assert.equal(saved.stats.totalPlays, 7);
});

// ============ 裁剪前归档（评审意见第 2 条）============
// 两年保留规则一旦执行，逐日明细就再也回不来；而「很久没打开插件」的用户没有机会手动备份。
// 所以裁剪之前先把完整明细写成一份**可恢复**的备份（格式与手动备份一致，「恢复备份」直接能用）。

const YEAR = 366 * 24 * 60 * 60 * 1000;

function bootWith(data, opts = {}) {
  let saved = data;
  const created = [];
  const app = {
    vault: {
      adapter: { getBasePath: () => process.cwd() },
      getAbstractFileByPath: () => null,
      createFolder: async () => {},
      create: async (name, content) => {
        if (opts.failCreate) throw new Error(opts.failCreate);
        // 归档写文件是异步的：onCreate 用来模拟「这段时间里播放还在继续」（见下面对应的用例）
        if (opts.onCreate) opts.onCreate();
        created.push({ name, content });
        return { path: name };
      },
    },
    workspace: { getLeavesOfType: () => [] },
  };
  const plugin = new mod.exports.default(app, { id: 'vinyl-life', dir: 'plugins/vinyl-life' });
  plugin.loadData = async () => saved;
  plugin.saveData = async (next) => { saved = next; };
  return { plugin, created, savedNow: () => saved };
}

test('裁剪前归档：先写一份带全部明细的备份，再裁内存与落盘', async () => {
  const now = Date.now();
  const { plugin, created, savedNow } = bootWith({
    stats: {
      totalPlays: 2,
      albums: {},
      tracks: {},
      events: [
        { at: now - 3 * YEAR, trackKey: 'ne:old', albumPath: 'A.md' },
        { at: now - 1000, trackKey: 'ne:new', albumPath: 'A.md' },
      ],
    },
  });
  await plugin.loadSettings();

  const archive = created.find((file) => file.name.includes('events archive'));
  assert.ok(archive, '写了一份归档文件');
  assert.match(archive.name, /Backups\/Vinyl Life events archive .*\.json$/, '落在 Backups 目录');
  const payload = JSON.parse(archive.content);
  assert.equal(payload.format, 'vinyl-life-backup', '归档就是备份格式：恢复流程原样可用');
  assert.deepEqual(
    payload.settings.stats.events.map((e) => e.trackKey),
    ['ne:old', 'ne:new'],
    '归档保留全部明细（含要被裁掉的那条）'
  );
  assert.deepEqual(
    plugin.settings.stats.events.map((e) => e.trackKey),
    ['ne:new'],
    '内存里的统计已按两年规则裁剪'
  );
  assert.deepEqual(
    savedNow().stats.events.map((e) => e.trackKey),
    ['ne:new'],
    '裁剪结果随即落盘：同一批明细不会下次启动再裁一遍'
  );
  assert.equal(payload.settings.stats.totalPlays, 2, '累计次数不受裁剪影响');
});

test('没有要丢的明细就不写归档', async () => {
  const now = Date.now();
  const { plugin, created } = bootWith({
    stats: { totalPlays: 1, albums: {}, tracks: {}, events: [{ at: now - 1000, trackKey: 'ne:new' }] },
  });
  await plugin.loadSettings();
  assert.equal(created.length, 0, '没触发裁剪：不该凭空多出归档文件');
});

// ============ 每周自动备份（数据管理）============
// 手动备份与裁剪归档之外，补一条「每周一次、只保留最近 N 份自动备份」的兜底；
// 清理只认自动备份的文件名前缀 —— 手动备份与裁剪归档绝不能被它删掉。

test('自动备份：到点才写、只保留最近 N 份自动备份，手动备份与归档不碰', async () => {
  const now = Date.now();
  const autos = ['a', 'b', 'c', 'd'].map(
    (tag, i) => `Vinyl Life/Backups/Vinyl Life auto backup 2026-09-0${i + 1}T00-00-00-000Z.json`
  );
  const manual = 'Vinyl Life/Backups/Vinyl Life backup 2026-09-01T00-00-00-000Z.json';
  const archive = 'Vinyl Life/Backups/Vinyl Life events archive 2026-09-01T00-00-00-000Z.json';
  // 目录子项必须是 TFile 实例：pruneAutoBackups 用 instanceof 过滤
  const mkFile = (full) => {
    const f = new TFile();
    f.path = full;
    f.name = full.split('/').pop();
    return f;
  };
  const docs = [manual, archive, ...autos].map(mkFile);
  const trashed = [];

  const app = {
    vault: {
      adapter: { getBasePath: () => process.cwd() },
      // 目录要 TFolder 实例：pruneAutoBackups 用 instanceof 认它
      getAbstractFileByPath: (p) =>
        p === 'Vinyl Life/Backups' ? new TFolder(p, [...docs]) : null,
      createFolder: async () => {},
      create: async (name) => {
        const entry = mkFile(name);
        docs.push(entry); // 新写的那份也要进目录，否则清理算不出「最近 N 份」
        return entry;
      },
    },
    fileManager: {
      trashFile: async (f) => {
        trashed.push(f.path);
        const i = docs.findIndex((d) => d.path === f.path);
        if (i >= 0) docs.splice(i, 1); // 删掉的就该从目录里消失
      },
    },
    workspace: { getLeavesOfType: () => [] },
  };
  const plugin = new mod.exports.default(app, { id: 'vinyl-life', dir: 'plugins/vinyl-life' });
  let saved = {
    lastBackupAt: now - 8 * 24 * 60 * 60 * 1000, // 8 天前：到点了
    backupKeep: 3,
    autoBackup: true,
    stats: { totalPlays: 1, albums: {}, tracks: {}, events: [] },
  };
  plugin.loadData = async () => saved;
  plugin.saveData = async (d) => { saved = d; };
  assert.equal(typeof plugin.maybeAutoBackup, 'function', '探针：自动备份入口还在');

  await plugin.loadSettings();
  await plugin.maybeAutoBackup();

  assert.equal(saved.lastBackupAt > now - 1000, true, '成功备份后刷新「最近成功备份」');
  assert.equal(
    docs.filter((d) => d.name.startsWith('Vinyl Life auto backup')).length,
    3,
    '写完第 5 份、按保留 3 份清掉最旧的 2 份 → 目录里正好剩保留的 3 份'
  );
  assert.deepEqual(
    trashed.sort(),
    [autos[0], autos[1]].sort(),
    '只清最旧的自动备份：手动备份与裁剪归档一份都不动'
  );
});

test('自动备份：没到一周不写；关掉开关不写', async () => {
  const created = [];
  const app = {
    vault: {
      adapter: { getBasePath: () => process.cwd() },
      getAbstractFileByPath: () => null,
      createFolder: async () => {},
      create: async (name, content) => { created.push(name); return { path: name }; },
    },
    fileManager: { trashFile: async () => {} },
    workspace: { getLeavesOfType: () => [] },
  };
  const make = async (data) => {
    const plugin = new mod.exports.default(app, { id: 'vinyl-life', dir: 'plugins/vinyl-life' });
    plugin.loadData = async () => data;
    plugin.saveData = async () => {};
    await plugin.loadSettings();
    await plugin.maybeAutoBackup?.();
    return plugin;
  };
  const fresh = { lastBackupAt: Date.now() - 1000, backupKeep: 3, autoBackup: true, stats: { totalPlays: 0, albums: {}, tracks: {}, events: [] } };
  await make(fresh);
  assert.equal(created.length, 0, '一周内不再备份');

  const off = { lastBackupAt: 0, backupKeep: 3, autoBackup: false, stats: { totalPlays: 0, albums: {}, tracks: {}, events: [] } };
  await make(off);
  assert.equal(created.length, 0, '开关关着就完全不碰');
});

test('归档期间新记的明细不会被一起丢掉', async () => {
  const now = Date.now();
  // 播放中碰上限/有超期明细时走的是 recordPlay → maybeRetainEvents 这条路径：
  // 传进去的 allEvents 就是 settings.stats.events 那个数组本身（recordTrackPlay 是原地 push）。
  // 归档要写文件、是异步的，这段时间里用户又点了一首 —— 它 push 进的是同一个数组，
  // 而 kept 是发起归档前算好的，直接拿它整段替换就会把这条新明细一起丢掉。
  const late = { at: now + 400, trackKey: 'ne:late' };
  let pluginRef = null;
  const { plugin, created, savedNow } = bootWith(
    {
      stats: {
        totalPlays: 1,
        albums: {},
        tracks: {},
        events: [{ at: now - 1000, trackKey: 'ne:seed' }],
      },
    },
    { onCreate: () => pluginRef.settings.stats.events.push(late) }
  );
  pluginRef = plugin;
  await plugin.loadSettings();
  assert.equal(created.length, 0, '启动时没有超期明细：不触发裁剪');

  // 手动制造一条超期明细，再记一次播放 —— 这条路径与真机上「播着播着到达保留边界」一致
  plugin.settings.stats.events.unshift({ at: now - 3 * YEAR, trackKey: 'ne:old' });
  plugin.recordPlay({ source: 'netease', id: 999, duration: 180, title: 'T' });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  const archive = created.find((file) => file.name.includes('events archive'));
  assert.ok(archive, '写了一份归档文件');
  assert.ok(
    JSON.parse(archive.content).settings.stats.events.some((e) => e.trackKey === 'ne:old'),
    '被裁掉的那条进了归档'
  );
  assert.ok(
    plugin.settings.stats.events.some((e) => e.trackKey === 'ne:late'),
    '归档期间新记的明细要留在内存里（这条以前会被 kept 整段替换掉）'
  );
  assert.ok(
    !plugin.settings.stats.events.some((e) => e.trackKey === 'ne:old'),
    '该裁的还是裁掉'
  );
  await plugin.saveSettings();
  assert.ok(
    savedNow().stats.events.some((e) => e.trackKey === 'ne:late'),
    '后续保存把这条新明细写下去'
  );
});

test('归档写不出去：明细全部保留、不裁剪，并给用户明确提示', async () => {
  const now = Date.now();
  notices.length = 0;
  // 写文件失败（磁盘满 / 权限 / 同步冲突）：archivePrunedEvents 会 catch 住，
  // 这时候**不能**认下裁剪结果 —— 否则「先归档、再裁剪」的承诺就破了，明细真丢了
  const { plugin, created, savedNow } = bootWith(
    {
      stats: {
        totalPlays: 2,
        albums: {},
        tracks: {},
        events: [
          { at: now - 3 * YEAR, trackKey: 'ne:old' },
          { at: now - 1000, trackKey: 'ne:new' },
        ],
      },
    },
    { failCreate: 'EACCES: permission denied' }
  );
  await plugin.loadSettings();

  assert.equal(created.length, 0, '归档没写成功');
  assert.deepEqual(
    plugin.settings.stats.events.map((e) => e.trackKey),
    ['ne:old', 'ne:new'],
    '裁剪作废：内存里留着完整明细'
  );
  assert.ok(
    notices.some((n) => n.includes('没有裁剪') || n.includes('没能写出')),
    `要有一条说清「明细保留、没有裁剪」的提示；实际：${JSON.stringify(notices)}`
  );
  await plugin.saveSettings();
  assert.equal(
    savedNow().stats.events.length,
    2,
    '后续保存把完整明细写回去 —— 原始明细不会被裁剪后的数据覆盖'
  );
});
