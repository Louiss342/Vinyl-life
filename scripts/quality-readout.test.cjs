// 实际音质读数回归：档位文案 + 引擎快照透出 + 播放器读数文案。
// 关注点：请求「无损」而接口只给「较高」时，读数要显示实际拿到的档位（这才是会员档位的可见证据）；
// 本地音轨无档位概念，只显示来源。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  stdin: {
    contents: `export * from '../src/core/player-state';\nexport * from '../src/core/track';\nexport * from '../src/views/player-view';\n`,
    resolveDir: __dirname,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian'],
}).outputFiles[0].text;

// 极简 Audio：引擎只用到这几个成员（不开真声）
class FakeAudio {
  constructor() {
    this.listeners = {};
    this.volume = 1;
    this.preload = '';
    this.currentTime = 0;
    this.duration = 0;
    this.paused = true;
    this._src = '';
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  async play() {
    this.paused = false;
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {}
  load() {}
  set src(v) {
    this._src = v;
  }
  get src() {
    return this._src;
  }
}

function setup(overrides = {}) {
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: (name) => {
      if (name === 'obsidian') {
        return {
          App: class {},
          ItemView: class {},
          Menu: class {},
          Notice: class {},
          Plugin: class {},
          TFile: class {},
          TFolder: class {},
          normalizePath: (p) => p,
          setIcon: () => {},
        };
      }
      return require(name);
    },
    console,
    Buffer,
    Audio: FakeAudio,
  });
  const mod = module.exports;

  // songUrl 的返回值模拟服务层：netease 已逐级降档后给 level，qq 无降档
  const deps = {
    app: {},
    local: {
      clearBlobs() {},
      keysOf() {
        return new Set();
      },
      resolveVaultUrl: (f) => 'app://local/' + f.path,
      resolveExternalUrl: (p) => 'app://ext/' + p,
    },
    netease: { songUrl: async () => ({ url: 'https://cdn/ne.mp3', level: 'higher' }) },
    qq: { songUrl: async () => ({ url: 'https://cdn/qq.m4a', level: 'standard' }) },
    settings: () => ({ quality: 'lossless', autoPlay: false }),
    onTrackPlay: () => {},
    ...overrides,
  };
  return { mod, engine: new mod.PlaybackEngine(deps) };
}

test('文案：档位映射 + 未知名透传 + 空值', () => {
  const { mod } = setup();
  assert.equal(mod.qualityText('lossless'), '无损');
  assert.equal(mod.qualityText('exhigh'), '极高');
  assert.equal(mod.qualityText('higher'), '较高');
  assert.equal(mod.qualityText('standard'), '标准');
  assert.equal(mod.qualityText('jymaster'), 'jymaster', '未知档位原样显示，不吞信息');
  assert.equal(mod.qualityText(undefined), '');
});

test('读数：队列/来源/档位三种组合', () => {
  const { mod } = setup();
  const base = { queue: [{}], status: 'playing', index: 0, currentTime: 0, duration: 0, volume: 1 };
  assert.equal(
    mod.qualityReadout({ ...base, sourceLabel: '网易云', quality: 'higher' }),
    '网易云 · 较高'
  );
  assert.equal(mod.qualityReadout({ ...base, sourceLabel: '本地' }), '本地', '本地无档位');
  assert.equal(
    mod.qualityReadout({ ...base, queue: [], sourceLabel: '网易云', quality: 'lossless' }),
    '',
    '空队列不显示'
  );
});

test('引擎：请求无损、实际较高 → 快照透出实际档位', async () => {
  const { mod, engine } = setup();
  engine.setQueue(
    [{ source: 'netease', id: 437968, title: 'Come Together', duration: 259 }],
    '06-专辑墙/专辑/Abbey Road.md',
    'Abbey Road',
    'netease'
  );
  await engine.playIndex(0);

  const s = engine.snapshot();
  assert.equal(s.status, 'playing');
  assert.equal(s.quality, 'higher', '应为接口实际返回的档位，而非请求的 lossless');
  assert.equal(mod.qualityReadout(s), '网易云 · 较高');
});

test('引擎：QQ 档位同样透出', async () => {
  const { mod, engine } = setup();
  engine.setQueue(
    [{ source: 'qq', id: '004VSvF52mQoQp', title: 'x', duration: 200 }],
    'p',
    'T',
    'qq'
  );
  await engine.playIndex(0);
  assert.equal(mod.qualityReadout(engine.snapshot()), 'QQ音乐 · 标准');
});

test('引擎：本地音轨无档位；换队列 / 清空后读数复位', async () => {
  const { mod, engine } = setup();
  engine.setQueue(
    [{ source: 'netease', id: 1, title: 'a', duration: 100 }],
    'p',
    'A',
    'netease'
  );
  await engine.playIndex(0);
  assert.equal(engine.snapshot().quality, 'higher');

  // 换成本地专辑：档位必须清掉（否则会残留上一张的「较高」）
  engine.setQueue(
    [{ source: 'local-external', path: 'D:/Music/a.flac', title: 'b' }],
    'q',
    'B',
    'local'
  );
  assert.equal(engine.snapshot().quality, undefined, '换队列即复位');
  await engine.playIndex(0);
  assert.equal(engine.snapshot().quality, undefined);
  assert.equal(mod.qualityReadout(engine.snapshot()), '本地');

  engine.clear();
  assert.equal(mod.qualityReadout(engine.snapshot()), '');
});
