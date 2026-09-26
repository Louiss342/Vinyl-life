// 健康检查试播的节流回归（真跑 main 的 checkOnlineSource + 假音源服务）：
//   ① 取流固定按最低档（standard）而不是用户设置的音质 —— 取流是逐级降档的，
//      按无损试会把四档全走一遍（QQ 还要再 ×2 个 mid），一轮检查就是上千个请求；
//   ② 试播期间每一次上游请求之间留最小间隔（core/probe-pacing），跑完必须关掉 ——
//      漏关会让播放 / 搜索也跟着被节流。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

// main 与 probe-pacing 必须出自**同一份 bundle**：各加载一次会拿到两份模块状态，
// 那样测的就不是「试播期间真的打开了节流」了（shelf-appearance 用同一招）
const source = esbuild.buildSync({
  stdin: {
    contents:
      "export { default } from '../src/main';\n" +
      "export { setUpstreamPacing, paceUpstream, upstreamPacing } from '../src/core/probe-pacing';\n",
    resolveDir: __dirname,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian', 'electron', '@electron/remote'],
}).outputFiles[0].text;

class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; }
}
class TFile { constructor(p) { this.path = p; this.name = String(p).split('/').pop(); } }
class TFolder {}

const mod = { exports: {} };
vm.runInNewContext(source, {
  module: mod,
  exports: mod.exports,
  require: (name) => name === 'obsidian' ? {
    App: class {}, ItemView: class {}, MarkdownView: class {}, Modal: class {},
    Notice: class {}, Plugin, PluginSettingTab: class {}, SettingPage: class {}, Setting: class {},
    TFile, TFolder, FuzzySuggestModal: class {}, normalizePath: (p) => p, setIcon: () => {},
    requestUrl: async () => ({ status: 200, json: {} }),
  } : require(name),
  Buffer, process, console, Date, setTimeout, clearTimeout,
  window: { setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {} },
  document: { createElement: () => ({ style: {} }) },
  Audio: class { addEventListener() {} },
});

const { default: VinylLifePlugin, upstreamPacing, setUpstreamPacing, paceUpstream } = mod.exports;

test('节流本身：打开之后两次上游请求之间至少隔一个间隔，关掉就恢复原样', async () => {
  setUpstreamPacing(120);
  const t0 = Date.now();
  await paceUpstream(); // 第一次立即发车
  await paceUpstream(); // 第二次要等满一个间隔
  const waited = Date.now() - t0;
  assert.ok(waited >= 110, `第二次要等到间隔满足（实际 ${waited}ms）`);

  setUpstreamPacing(0);
  const t1 = Date.now();
  await paceUpstream();
  await paceUpstream();
  assert.ok(Date.now() - t1 < 50, '关掉之后不该再等（播放 / 搜索走的就是这条路）');
});

const album = {
  file: new TFile('Albums/A.md'),
  path: 'Albums/A.md',
  title: 'A',
  neteaseId: 42,
  audioRefs: [],
  displayProps: {},
};

/** 造一个插件：settings 里故意把音质设成无损（试播不该跟它走） */
function makePlugin(services) {
  const app = {
    vault: {
      adapter: { getBasePath: () => process.cwd() },
      getAbstractFileByPath: () => null,
      createFolder: async () => {},
      create: async (name) => ({ path: name }),
    },
    workspace: { getLeavesOfType: () => [] },
  };
  const plugin = new VinylLifePlugin(app, { id: 'vinyl-life', dir: 'plugins/vinyl-life' });
  plugin.settings = { quality: 'lossless', defaultSource: 'auto' };
  plugin.local = { buildTracks: async () => [] }; // buildAlbumQueue 每次都会问一次本地音轨
  plugin.netease = services.netease;
  plugin.qq = services.qq;
  plugin.kugou = services.kugou;
  return plugin;
}

test('试播固定按最低档取流，且第一首拿到地址就停', async () => {
  const levels = [];
  const pacingDuring = [];
  const plugin = makePlugin({
    netease: {
      album: async () => ({ songs: [{ id: 1, name: 'T1', dt: 180000, ar: [{ name: 'A' }] }] }),
      songUrl: async (_id, level) => {
        levels.push(level);
        pacingDuring.push(upstreamPacing());
        return { url: 'https://cdn/1.mp3' };
      },
    },
  });

  const error = await plugin.checkOnlineSource(album, 'netease');

  assert.equal(error, null, '拿到地址 = 这个音源可用');
  assert.deepEqual(levels, ['standard'], '不跟用户的 lossless 走：只问最低档拿不拿得到');
  assert.deepEqual(pacingDuring, [250], '取流那一刻节流是打开的');
  assert.equal(upstreamPacing(), 0, '跑完必须关掉：否则播放与搜索也会被节流');
});

test('试播失败也照样关掉节流（不把节流漏给后续的播放 / 搜索）', async () => {
  const plugin = makePlugin({
    netease: {
      album: async () => {
        throw new Error('上游 500');
      },
    },
  });
  const error = await plugin.checkOnlineSource(album, 'netease');
  assert.match(error, /上游 500/, '失败原因照实往上报');
  assert.equal(upstreamPacing(), 0, '提前 return / 抛错都要走 finally 关掉');
});

test('试播最多试三首，全部拿不到才报不可用', async () => {
  let calls = 0;
  const plugin = makePlugin({
    netease: {
      album: async () => ({
        songs: [1, 2, 3, 4, 5].map((i) => ({ id: i, name: `T${i}`, dt: 180000, ar: [{ name: 'A' }] })),
      }),
      songUrl: async () => {
        calls++;
        return { restriction: 'VIP 专享' };
      },
    },
  });
  const error = await plugin.checkOnlineSource(album, 'netease');
  assert.equal(calls, 3, '只试前三首（再多也只是把同一轮的请求量翻倍）');
  assert.match(error, /VIP 专享/, '报的是上游给的原因，不是笼统的「不可用」');
});
