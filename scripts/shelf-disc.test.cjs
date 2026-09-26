// 专辑墙「唱片离墙」回归（列表模式 / 专辑队列模式）：
//   A 纯函数：queuedAlbumPaths —— 队列里排着哪些专辑；
//   B 视图：updatePlaying 的进出队列动画 —— 排进列表时唱片飞离墙面，
//     退出列表模式（队列收敛回当前专辑）时滑回封套，首帧只回写状态不播动画；
//   C 样式真值：离墙态覆盖「播放中 / 已排入列表」两种卡片，悬停不把已离墙的唱片勾回来。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const nodePath = require('node:path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const OBSIDIAN_STUB = {
  App: class {},
  ItemView: class {},
  Plugin: class {},
  PluginSettingTab: class {},
  SettingPage: class {},
  Setting: class {},
  Menu: class {},
  Modal: class {},
  FuzzySuggestModal: class {},
  Notice: class {},
  TFile: class {},
  TFolder: class {},
  normalizePath: (p) => p,
  setIcon: () => {},
};

function loadModule(entry, globals = {}) {
  const source = esbuild.buildSync({
    entryPoints: [path.join(root, entry)],
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
      if (name === 'obsidian') return OBSIDIAN_STUB;
      if (name === 'fs') return { existsSync: () => false, statSync: () => ({}), readdirSync: () => [] };
      if (name === 'path') return nodePath;
      throw new Error('Unexpected runtime import: ' + name);
    },
    fetch: async () => {
      throw new Error('no network in tests');
    },
    window: {
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      matchMedia: () => ({ matches: false }),
    },
    document: { hidden: false },
    AbortSignal,
    URL,
    URLSearchParams,
    Buffer,
    setTimeout,
    clearTimeout,
    console,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    ...globals,
  });
  return mod.exports;
}

// ============ A. 纯函数 ============

test('queuedAlbumPaths：队列涉及哪些专辑（去重、跳过没有 albumNotePath 的曲目）', () => {
  const { queuedAlbumPaths } = loadModule('src/core/queue.ts');
  const paths = queuedAlbumPaths([
    { albumNotePath: 'Albums/叶惠美.md' },
    { albumNotePath: 'Albums/叶惠美.md' }, // 同一张的第二首
    { albumNotePath: 'Albums/七里香.md' },
    {}, // 没归属的曲目（理论上不该有，但别把 undefined 塞进集合）
  ]);
  assert.deepEqual([...paths].sort(), ['Albums/七里香.md', 'Albums/叶惠美.md'].sort());
});

test('queuedAlbumPaths：空队列 → 空集合（播放停止时所有唱片都该回墙）', () => {
  const { queuedAlbumPaths } = loadModule('src/core/queue.ts');
  assert.equal(queuedAlbumPaths([]).size, 0);
});

// ============ B. 视图：进出队列的动画 ============

/** 假卡片：够 updatePlaying / playDiscReturn / animateDiscLiftOff 走完
 *（classList + Obsidian 的 addClass/removeClass + querySelector('.vinyl-shelf-disc')） */
function makeCard() {
  const classes = new Set();
  const disc = {
    anims: [],
    animate(keyframes, options) {
      const anim = {
        keyframes,
        options,
        playState: 'running',
        cancelled: false,
        listeners: [],
        addEventListener(type, fn) {
          anim.listeners.push({ type, fn });
        },
        cancel() {
          anim.cancelled = true;
          anim.playState = 'idle';
          // 真实 Animation 取消时派发 cancel 事件（收尾逻辑靠它摘类名）
          for (const l of anim.listeners) if (l.type === 'cancel') l.fn();
        },
        finish() {
          anim.playState = 'finished';
          for (const l of anim.listeners) if (l.type === 'finish') l.fn();
        },
      };
      disc.anims.push(anim);
      return anim;
    },
    getAnimations() {
      return disc.anims.filter((a) => !a.cancelled);
    },
  };
  return {
    disc,
    classes,
    addClass(...names) {
      for (const n of names.flatMap((x) => String(x).split(/\s+/)).filter(Boolean)) classes.add(n);
    },
    removeClass(...names) {
      for (const n of names.flatMap((x) => String(x).split(/\s+/)).filter(Boolean)) classes.delete(n);
    },
    classList: {
      contains: (n) => classes.has(n),
      add: (n) => classes.add(n),
      remove: (n) => classes.delete(n),
      toggle: (n, on) => {
        const want = on === undefined ? !classes.has(n) : !!on;
        if (want) classes.add(n);
        else classes.delete(n);
      },
    },
    querySelector: (sel) => (sel === '.vinyl-shelf-disc' ? disc : null),
  };
}

const track = (albumPath) => ({ albumNotePath: albumPath });
const snap = (queue, albumNotePath = null, status = 'playing') => ({ status, queue, albumNotePath });

function makeViewPair() {
  const { VinylShelfView } = loadModule('src/views/shelf-view.ts');
  const view = new VinylShelfView({}, {});
  const a = makeCard();
  const b = makeCard();
  view.cardEls = new Map([
    ['Albums/A.md', a],
    ['Albums/B.md', b],
  ]);
  return { view, a, b };
}

test('播放状态：首帧只回写状态，队列里的专辑唱片离墙但不播动画', () => {
  const { view, a, b } = makeViewPair();
  view.updatePlaying(snap([track('Albums/A.md'), track('Albums/B.md')], 'Albums/A.md'));
  assert.equal(a.classList.contains('is-playing'), true, '在播的那张：描边高亮 + 唱片离墙');
  assert.equal(b.classList.contains('is-queued'), true, '队列里排着的：唱片也离墙');
  assert.equal(b.classList.contains('is-playing'), false, '但不算「播放中」');
  assert.equal(a.disc.anims.length, 0, '首帧是一次渲染，不是一次动作：不播离墙动画');
  assert.equal(b.disc.anims.length, 0);
});

test('排进列表：唱片飞离墙面（列表模式下点专辑的即时反馈）', () => {
  const { view, a, b } = makeViewPair();
  // 第一帧：B 还在墙上（A 在播）
  view.updatePlaying(snap([track('Albums/A.md')], 'Albums/A.md'));
  assert.equal(b.classList.contains('is-queued'), false);
  // 列表模式下点了 B → 排到队尾
  view.updatePlaying(snap([track('Albums/A.md'), track('Albums/B.md')], 'Albums/A.md'));
  assert.equal(b.classList.contains('is-queued'), true);
  assert.equal(b.disc.anims.length, 1, '排进列表要播一次离墙动画');
  assert.equal(b.disc.anims[0].keyframes.length, 3, '与交接同一串关键帧（拾取 → 离墙）');
  assert.equal(b.disc.anims[0].options.fill, 'forwards', '终点保持：随后由 CSS 离墙态接管');
  b.disc.anims[0].finish();
  assert.equal(a.disc.anims.length, 0, '在播的那张不重复播');
});

test('退出列表模式：队列收敛后，被移出的唱片滑回封套', () => {
  const { view, a, b } = makeViewPair();
  // ① 只有 A 在播 + 在列表里 → B 还挂在墙上
  view.updatePlaying(snap([track('Albums/A.md')], 'Albums/A.md'));
  // ② 列表模式下点 B（排到队尾）→ 唱片飞离墙面
  view.updatePlaying(snap([track('Albums/A.md'), track('Albums/B.md')], 'Albums/A.md'));
  assert.equal(b.disc.anims.length, 1);
  // ③ 关掉列表模式 → 引擎 retainCurrentAlbum：队列只剩当前这张 → B 的唱片回位
  view.updatePlaying(snap([track('Albums/A.md')], 'Albums/A.md'));
  assert.equal(b.classList.contains('is-queued'), false);
  assert.equal(b.disc.anims.length, 2, '离墙那一次 + 回位这一次');
  const back = b.disc.anims[1];
  assert.equal(back.keyframes.length, 3, '回位与离墙同参数（离墙位 → 拾取位 → 探出位）');
  assert.equal(back.keyframes[0].opacity, '0', '原点在墙外');
  assert.equal(back.keyframes[back.keyframes.length - 1].opacity, '1', '终点回到墙上：不透明');
  assert.equal(a.disc.anims.length, 0, '当前播放的唱片留在播放器那边，不动');
  assert.equal(b.classes.has('is-returning'), true, '回位期间挂 is-returning（悬停摆动让位）');
  back.cancel();
  assert.equal(b.classes.has('is-returning'), false, '取消也要摘掉：否则这张卡永远不再有悬停摆动');
});

test('停止播放（空队列）：墙上的唱片全部回位', () => {
  const { view, a, b } = makeViewPair();
  view.updatePlaying(snap([track('Albums/A.md'), track('Albums/B.md')], 'Albums/A.md'));
  view.updatePlaying(snap([], null, 'idle'));
  assert.equal(a.classList.contains('is-playing'), false);
  assert.equal(b.classList.contains('is-queued'), false);
  assert.equal(a.disc.anims.length, 1, 'A 的回位动画');
  assert.equal(b.disc.anims.length, 1, 'B 的回位动画');
});

test('快照没变就不碰 DOM：队列引用与当前专辑都没换时直接返回', () => {
  const { view, a, b } = makeViewPair();
  const queue = [track('Albums/A.md'), track('Albums/B.md')];
  view.updatePlaying(snap(queue, 'Albums/A.md'));
  assert.equal(a.classList.contains('is-playing'), true);
  // 模拟「DOM 被别处改动」，再用同一个快照喂一次：输入没变就不该把它写回去
  a.classList.remove('is-playing');
  view.updatePlaying(snap(queue, 'Albums/A.md'));
  assert.equal(
    a.classList.contains('is-playing'),
    false,
    '同一个队列引用 + 同一个当前专辑：不该再逐张写 class（快照 400ms 一次，这是每条都在付的开销）'
  );
  // 换成新队列引用（引擎每次入队/重排都会产生新数组）→ 该写的还得写
  view.updatePlaying(snap([...queue], 'Albums/A.md'));
  assert.equal(a.classList.contains('is-playing'), true, '队列换了引用就要重写');
  assert.equal(b.classList.contains('is-queued'), true);
});

test('点「已经在唱机上」的唱片：暂停中接着放，播放中只翻出播放器', async () => {
  const { view } = makeViewPair();
  const calls = [];
  view.plugin = {
    settings: { queueMode: false },
    engine: { play: async () => calls.push('play') },
    openPlayer: async () => calls.push('open'),
    handoff: { handoff: async () => calls.push('handoff') },
  };
  const entry = {
    album: { path: 'Albums/A.md' },
    local: true,
    netease: false,
    qq: false,
    kugou: false,
  };
  // 重启后自动载入的「上次播放」：队列还在、状态是 paused —— 点它应当接着放
  view.lastSnap = { albumNotePath: 'Albums/A.md', queue: [track('Albums/A.md')], status: 'paused' };
  await view.playAlbum(entry);
  assert.deepEqual(calls, ['play', 'open'], '暂停中：先接着放，再把播放器翻出来（不重新取碟）');
  calls.length = 0;
  view.lastSnap = { albumNotePath: 'Albums/A.md', queue: [track('Albums/A.md')], status: 'playing' };
  await view.playAlbum(entry);
  assert.deepEqual(calls, ['open'], '已经在播：不重复触发播放，只翻出播放器');
});

test('减少动态效果：状态照旧回写，但不播位移动画', () => {
  // 这一份模块在「减少动效」环境里加载：prefersReducedMotion() 命中
  const { VinylShelfView } = loadModule('src/views/shelf-view.ts', {
    window: {
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      matchMedia: () => ({ matches: true }),
    },
  });
  const view = new VinylShelfView({}, {});
  const a = makeCard();
  view.cardEls = new Map([['Albums/A.md', a]]);
  view.updatePlaying(snap([track('Albums/A.md')], 'Albums/A.md'));
  view.updatePlaying(snap([], null, 'idle'));
  assert.equal(a.classList.contains('is-playing'), false, '状态照旧回写（回墙）');
  assert.equal(a.disc.anims.length, 0, '不做位移：动画一律不挂');
});

// ============ C. 样式真值 ============

test('样式：离墙态覆盖「播放中」与「已排入列表」，与交接关键帧终点同源', () => {
  const css = read('styles.css');
  const rule = /\.vinyl-shelf-card\.is-playing \.vinyl-shelf-disc,\s*\.vinyl-shelf-card\.is-queued \.vinyl-shelf-disc \{([^}]+)\}/.exec(css);
  assert.ok(rule, '播放中 / 已排入列表 共用同一条离墙规则');
  assert.match(rule[1], /opacity:\s*0/);
  assert.match(rule[1], /var\(--vinyl-disc-off/, '位移取方向变量（与 handoff 终点一致）');
});

test('样式：悬停摆动排除「已排入列表」的卡片（唱片已经不在墙上）', () => {
  const css = read('styles.css');
  assert.match(
    css,
    /\.vinyl-shelf-card:not\(\.is-playing\):not\(\.is-queued\):not\(\.is-handing-off\):not\(\.is-returning\):hover/,
    'hover 弹出摆动要跳过已离墙的卡片'
  );
});

test('接线：排进列表与交接共用同一串离墙关键帧（不各写一份）', () => {
  const handoff = read('src/animation/handoff.ts');
  assert.match(handoff, /export function animateDiscLiftOff/, '离墙动画抽成公共件');
  assert.match(handoff, /animateDiscLiftOff\(cardEl, discEl\)/, '交接走公共件');
  const view = read('src/views/shelf-view.ts');
  assert.match(view, /queuedAlbumPaths\(s\.queue\)/, '离墙集合来自队列');
  assert.match(view, /el\.classList\.toggle\('is-queued'/, '队列里的卡片挂 is-queued');
  assert.match(view, /animateDiscLiftOff\(el, disc\)/, '排进列表时播离墙动画');
  assert.match(view, /this\.playDiscReturn\(el\)/, '移出队列 / 停止播放时播回位动画');
  assert.match(view, /known && !wasAway && away && !el\.__vinylLift/, '交接动画在跑时不重复点火');
});
