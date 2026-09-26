// 命令层回归（core/commands.ts）——**本仓库第一批真正的行为测试**：
// 此前 70 多个文件绝大多数是「扫源码里有没有这段模式」，证明不了「调用了会发生什么」。
// 命令把动作收成 run(host) 之后，测试可以交一份假宿主，看它到底点了哪几个动作。
//
//   ① id 冻结：已发布的 10 条 id 一个都不许改（用户的快捷键绑在 id 上）
//   ② 映射完整：每条命令恰好驱动一个宿主动作；没有多余的命令，也没有够不着的动作
//   ③ 默认键：只给该给的几条配（音乐控制 + 插曲目 + 整段上下移），键位与文档一致
//   ④ 文案：titleKey 必须真在词典里（命令面板里不能冒出一个原始键名）
//   ⑤ 源站地址规则（在源站打开那条命令的领域逻辑）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const nodePath = require('node:path');

function loadModule(entry, globals = {}) {
  const abs = path.join(__dirname, '..', entry);
  const source = esbuild.buildSync({
    entryPoints: [abs],
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
      if (name === 'obsidian') return new Proxy({}, { get: () => class {} });
      if (name === 'fs') return { existsSync: () => false, statSync: () => ({}), readdirSync: () => [] };
      if (name === 'path') return nodePath;
      throw new Error('Unexpected runtime import: ' + name);
    },
    console,
    Buffer,
    URL,
    URLSearchParams,
    ...globals,
  });
  return mod.exports;
}

const { COMMANDS } = loadModule('src/core/commands.ts');
const { DICT } = loadModule('src/core/i18n.ts');
const { albumSourceLinks } = loadModule('src/core/source-link.ts');

/** 已发布的 10 条：写在 commands.ts 之前就在命令面板里了，id 是承诺 */
const FROZEN_IDS = [
  'open-shelf',
  'open-player',
  'import-netease',
  'import-local',
  'insert-now-playing',
  'save-queue-note',
  'load-queue-note',
  'player-toggle',
  'player-next',
  'player-prev',
];

/** 假宿主：把「被调用了什么」记下来。每个动作对应命令表里的一条命令。 */
function fakeHost() {
  const calls = [];
  const record = (name) => () => {
    calls.push(name);
  };
  const host = {};
  for (const name of [
    'openShelf',
    'openPlayer',
    'importAlbum',
    'importLocal',
    'importLocalToCurrent',
    'insertNowPlaying',
    'saveQueueNote',
    'loadQueueNote',
    'playerToggle',
    'playerNext',
    'playerPrev',
    'appendListeningNote',
    'setAlbumCover',
    'openAlbumInSource',
  ]) {
    host[name] = record(name);
  }
  host.moveSegment = (delta) => calls.push('moveSegment:' + delta);
  return { host, calls };
}

// ============ ① id 冻结 ============

test('命令表：已发布的 10 条 id 原样保留（改了用户绑的快捷键就失效）', () => {
  const ids = COMMANDS.map((c) => c.id);
  for (const id of FROZEN_IDS) {
    assert.ok(ids.includes(id), `命令 id '${id}' 不能改也不能删`);
  }
  assert.equal(new Set(ids).size, ids.length, 'id 不许重复（同 id 后注册的会盖掉先注册的）');
});

test('命令表：新增的 5 个动作都有命令入口（此前只有鼠标路径）', () => {
  const ids = COMMANDS.map((c) => c.id);
  for (const id of [
    'append-listening-note',
    'set-album-cover',
    'open-album-in-source',
    'import-local-to-current',
    'queue-move-segment-up',
    'queue-move-segment-down',
  ]) {
    assert.ok(ids.includes(id), `缺命令：${id}`);
  }
});

// ============ ② 映射完整 ============

test('映射：每条命令恰好驱动一个宿主动作，且没有够不着的动作', () => {
  const { host } = fakeHost();
  const seen = new Map();
  for (const cmd of COMMANDS) {
    const { host: h, calls } = fakeHost();
    cmd.run(h);
    assert.equal(calls.length, 1, `${cmd.id} 应当只驱动一个动作，实际 ${calls.join(' / ')}`);
    seen.set(calls[0], cmd.id);
  }
  // 宿主接口里的每个动作都要有命令能到（否则是死接口）
  const actions = Object.keys(host);
  for (const a of actions) {
    const hit = [...seen.keys()].some((k) => k === a || k.startsWith(a + ':'));
    assert.ok(hit, `宿主动作 ${a} 没有任何命令能触发`);
  }
  // 整段上下移是一条命令驱动同一个动作的两个方向（delta 要分得开）
  assert.equal(seen.get('moveSegment:-1'), 'queue-move-segment-up');
  assert.equal(seen.get('moveSegment:1'), 'queue-move-segment-down');
});

test('映射：异步动作返回 Promise 或 undefined 都行，但不许抛', () => {
  for (const cmd of COMMANDS) {
    const { host } = fakeHost();
    assert.doesNotThrow(() => void cmd.run(host), `${cmd.id} 不该抛错`);
  }
});

// ============ ③ 默认快捷键（刻意不配） ============

test('默认键：一条都不许配 —— 规范建议插件别设，键位交给用户自己绑', () => {
  // Obsidian 的插件规范与 obsidianmd/commands/no-default-hotkeys 都建议不要默认键：
  // 可能撞上用户已经绑好的键，或宿主自带的键。命令面板里全都能搜到，
  // 想用键的读者照 README「命令与快捷键」那一节绑一次即可（十秒的事）。
  for (const cmd of COMMANDS) {
    assert.equal(cmd.keys, undefined, `${cmd.id} 不该带默认键`);
  }
  // 去注释再看：文件头会点名 keys?: KeyChord[] 说明为什么不留它，那不是违规
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const src = strip(fs.readFileSync(path.join(__dirname, '../src/core/commands.ts'), 'utf8'));
  assert.doesNotMatch(src, /\bkeys\s*[?:]/, '接口里也不该留 keys 字段（一条都不配，留着就是死字段）');
  const main = strip(fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8'));
  assert.doesNotMatch(main, /hotkeys:/, 'addCommand 不该传默认 hotkeys');
});

// ============ ④ 文案 ============

test('文案：每条命令的 titleKey 都在词典里，且中英都不是键名本身', () => {
  for (const cmd of COMMANDS) {
    const entry = DICT[cmd.titleKey];
    assert.ok(entry, `${cmd.id} 的 titleKey '${cmd.titleKey}' 不在词典里`);
    assert.ok(entry.zh && entry.en, `${cmd.titleKey} 缺中文或英文`);
    assert.notEqual(entry.zh, cmd.titleKey, `${cmd.titleKey} 的中文还是键名`);
    assert.notEqual(entry.en, cmd.titleKey, `${cmd.titleKey} 的英文还是键名`);
  }
});

// ============ ⑤ 源站地址规则 ============

test('在源站打开：三种平台的地址规则 + 一个都没有时为空', () => {
  assert.deepEqual(Array.from(albumSourceLinks({}), (l) => l.source), [], '没有关联音源 → 空（调用方如实报错）');
  const all = albumSourceLinks({ neteaseId: 123, qqId: 'mid1', kugouId: 'abc' });
  assert.deepEqual(Array.from(all, (l) => l.source), ['netease', 'qq', 'kugou'], '顺序固定：网易云 → QQ → 酷狗');
  assert.equal(all[0].url, 'https://music.163.com/#/album?id=123');
  assert.equal(all[1].url, 'https://y.qq.com/n/ryqq/albumDetail/mid1');
  assert.equal(all[2].url, 'https://www.kugou.com/yy/album/single/abc.html');
  // url 里不能出现 undefined / null（拼半截地址会让用户点到一个坏页面）
  for (const l of all) assert.doesNotMatch(l.url, /undefined|null/, `${l.source} 的地址拼进了空值`);
});

// ============ ⑥ 接线（main.ts 那一侧） ============

test('接线：main.ts 逐条注册命令表的命令（名字 + 回调，不给默认键）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  assert.match(src, /for \(const cmd of COMMANDS\)/, '命令要由命令表驱动注册，别在 main.ts 里再抄一遍');
  assert.match(src, /id: cmd\.id/, 'id 从命令表来（两处各写一份迟早会漂）');
  assert.match(src, /name: t\(cmd\.titleKey\)/, '名字从命令表的 i18n 键来');
  assert.match(src, /cmd\.run\(commandHost\)/, '回调走命令表的 run(host)');
  assert.doesNotMatch(src, /hotkeys:/, '默认键不映射（一条都不配）');
  for (const c of COMMANDS) {
    assert.doesNotMatch(
      src,
      new RegExp(`id:\\s*'${c.id}'`),
      `main.ts 里不该再单独注册 '${c.id}'（命令表是唯一出处）`
    );
  }
});
