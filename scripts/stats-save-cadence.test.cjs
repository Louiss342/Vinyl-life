// 音量 / 播放位置 / 播放明细的落盘节奏回归（用可控的假时钟把 30 秒跑成毫秒）：
//   ① 播放中 timeupdate 每 400ms 调一次 scheduleStatsSave —— 纯防抖会把落盘无限推后，
//      崩溃或强杀就丢掉整场明细。最长等待保证连续播放时也一定写得下去；
//   ② 但也不能变成「每改必写」：停手之后仍然是一次防抖写入。
const { test } = require('node:test');
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

// —— 假时钟：用例自己决定「现在几点」，以及哪些定时器到点了 ——
let fakeNow = 1_700_000_000_000;
class FakeDate extends Date {
  constructor(...args) { if (args.length === 0) super(fakeNow); else super(...args); }
  static now() { return fakeNow; }
}
const timers = new Map();
let nextTimerId = 0;
const setTimeoutFake = (fn, ms) => {
  const id = ++nextTimerId;
  timers.set(id, { fn, due: fakeNow + Math.max(0, Number(ms) || 0) });
  return id;
};
const clearTimeoutFake = (id) => { timers.delete(id); };

const mod = { exports: {} };
vm.runInNewContext(source, {
  module: mod, exports: mod.exports,
  require: (name) => name === 'obsidian' ? {
    App: class {}, ItemView: class {}, MarkdownView: class {}, Modal: class {},
    Notice: class { constructor() {} },
    Plugin, PluginSettingTab: class {}, SettingPage: class {}, Setting: class {},
    TFile, TFolder: class {}, FuzzySuggestModal: class {}, normalizePath: (p) => p, setIcon: () => {},
  } : require(name),
  Buffer, process, console, Date: FakeDate,
  setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake,
  window: { setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake, setInterval: () => 0, clearInterval: () => {} },
  document: { createElement: () => ({ style: {} }) },
  Audio: class { addEventListener() {} },
});

const flush = async (times = 4) => { for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r)); };

/** 让所有到点的定时器跑掉（跑掉之后可能又排新的，继续跟到没有为止） */
async function runDueTimers() {
  for (let round = 0; round < 100; round++) {
    const due = [...timers.entries()].filter(([, t]) => t.due <= fakeNow);
    if (!due.length) return;
    for (const [id, t] of due) {
      if (!timers.has(id)) continue; // 期间被 clearTimeout 推后的（防抖的正常行为）就别跑
      timers.delete(id);
      t.fn();
    }
    await flush();
  }
  throw new Error('定时器没有收敛');
}

async function boot() {
  let saves = 0;
  const app = {
    vault: {
      adapter: { getBasePath: () => process.cwd() },
      getAbstractFileByPath: () => null,
      createFolder: async () => {},
      create: async (name) => ({ path: name }),
    },
    workspace: { getLeavesOfType: () => [] },
  };
  const plugin = new mod.exports.default(app, { id: 'vinyl-life', dir: 'plugins/vinyl-life' });
  plugin.loadData = async () => ({
    autoBackup: false,
    lastBackupAt: fakeNow,
    stats: { totalPlays: 0, albums: {}, tracks: {}, events: [] },
  });
  plugin.saveData = async () => { saves++; };
  await plugin.loadSettings();
  saves = 0; // 启动过程中的写入不算数
  return { plugin, saves: () => saves };
}

test('连续播放也会落盘：最长等待 30 秒兜住被无限推后的防抖', async () => {
  const { plugin, saves } = await boot();
  const start = fakeNow;
  // 40 秒连续播放：每 400ms 一次 timeupdate（播放器里就是这个节奏）
  for (let i = 0; i < 100; i++) {
    fakeNow = start + i * 400;
    plugin.rememberPlayback({ volume: 0.8, currentTime: i, current: null, albumNotePath: null });
    await runDueTimers();
  }
  const during = saves();
  assert.ok(during >= 1, `40 秒连续播放至少要落盘一次（实际 ${during} 次）`);
  assert.ok(during <= 3, `但也不能每来一次改动就写一次（实际 ${during} 次）`);

  // 停手（暂停 / 停止播放）之后：防抖照旧，一次写入
  const before = saves();
  fakeNow += 5000;
  await runDueTimers();
  assert.equal(saves() - before, 1, '停手 5 秒后写一次');
});

test('改动稀疏时按 5 秒防抖走，不提前写', async () => {
  const { plugin, saves } = await boot();
  plugin.rememberPlayback({ volume: 0.5, currentTime: 0, current: null, albumNotePath: null });

  fakeNow += 4999;
  await runDueTimers();
  assert.equal(saves(), 0, '还没到 5 秒：不写');

  fakeNow += 1;
  await runDueTimers();
  assert.equal(saves(), 1, '到 5 秒：写一次');

  // 攒着改动又被打断的长窗口：30 秒封顶，之后重新起算
  plugin.rememberPlayback({ volume: 0.6, currentTime: 1, current: null, albumNotePath: null });
  for (let i = 1; i <= 8; i++) {
    fakeNow += 4000; // 每 4 秒改一次：单次防抖 5 秒够不到，攒到 30 秒才写
    plugin.rememberPlayback({ volume: 0.6, currentTime: i, current: null, albumNotePath: null });
    await runDueTimers();
  }
  assert.equal(saves(), 2, '攒了 32 秒、只写了 1 次（封顶后重新起算）');
});
