// 播放器控制回归：音量电平表（点到哪一格就亮到哪）与歌曲进度条（拖动跟手、抬手才 seek）。
// 盯住两次真实踩坑：
//   ① 电平表按原生 range 的映射走 —— 它的行程是「宽度 − 滑块宽」，点第 k 格亮的格数总差半格，
//      最左边一格甚至够不到 0；改成自绘命中（ceil 映射）后，指针永远落在亮区里。
//   ② 进度条拖动时被引擎回声回写轨道（只挡了 range 的 value，没挡轨道）—— 手指和回声互相拽，
//      看着就像「拖了没反应」；现在拖动中与抬手保持期内一律不回写。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const view = fs.readFileSync(path.join(__dirname, '../src/views/player-view.ts'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');

const source = esbuild.buildSync({
  stdin: { contents: `export * from '../src/views/player-view';\n`, resolveDir: __dirname, loader: 'ts' },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian'],
}).outputFiles[0].text;

// 纯函数用例（刻度换算）要跑真源码，故与其它用例一样：esbuild 编译进 vm，stub 掉 obsidian
const ctx = { exports: {} };
vm.runInNewContext(source, {
  module: ctx,
  exports: ctx.exports,
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
});
const mod = ctx.exports;

test('音量表刻度：点哪一格，那一格（含）之前全亮', () => {
  const { activeVolumeSegments } = mod;
  const COUNT = 24;
  assert.equal(activeVolumeSegments(0, COUNT), 0, '拖到最左端之外 = 静音（0 格）');
  assert.equal(activeVolumeSegments(1e-9, COUNT), 1, '刚离开左端就亮 1 格（不是 0）');
  assert.equal(activeVolumeSegments(1 / COUNT, COUNT), 1, '第 1 格的右边界仍只亮 1 格');
  assert.equal(activeVolumeSegments(1 / COUNT + 1e-6, COUNT), 2, '踏进第 2 格 → 亮 2 格');
  assert.equal(activeVolumeSegments(0.5, COUNT), 12);
  assert.equal(activeVolumeSegments(0.5 + 1e-6, COUNT), 13, '越过格界才多亮一格');
  assert.equal(activeVolumeSegments(1, COUNT), COUNT, '到底 = 全亮');
  assert.equal(activeVolumeSegments(2, COUNT), COUNT, '越界 clamp');
  assert.equal(activeVolumeSegments(-1, COUNT), 0);
  // 亮区永远包含指针所在的那一格：这是「点哪格亮哪格」的判据
  for (let k = 0; k < COUNT; k++) {
    const inside = (k + 0.5) / COUNT; // 第 k 格（0 基）的正中
    assert.equal(activeVolumeSegments(inside, COUNT), k + 1, `点第 ${k + 1} 格要亮 ${k + 1} 格`);
  }
});

test('指针落点 → 比例：两端 clamp，宽度为 0 不除零', () => {
  const { pointerRatio } = mod;
  assert.equal(pointerRatio(150, { left: 100, width: 100 }), 0.5);
  assert.equal(pointerRatio(100, { left: 100, width: 100 }), 0);
  assert.equal(pointerRatio(200, { left: 100, width: 100 }), 1);
  assert.equal(pointerRatio(1, { left: 100, width: 100 }), 0, '拖出左边界仍然算 0');
  assert.equal(pointerRatio(999, { left: 100, width: 100 }), 1, '拖出右边界仍然算 1');
  assert.equal(pointerRatio(50, { left: 100, width: 0 }), 0, '宽度为 0（还没布局）不除零');
});

test('音量表与进度条：指针事件自己接管，原生 range 只留键盘', () => {
  assert.match(view, /export function bindPointerScrub/, '接管逻辑抽成一处，两处共用');
  assert.match(view, /bindPointerScrub\(volMeter, volSlider/, '电平表走接管');
  assert.match(view, /bindPointerScrub\(progressControl, progressSlider/, '进度条走接管');
  assert.match(view, /hit\.setPointerCapture\(ev\.pointerId\)/, 'pointer capture：拖出控件也不丢事件');
  assert.match(view, /ev\.pointerType === 'mouse' && ev\.button !== 0/, '右键 / 中键不当拖动');
  assert.match(view, /input\.focus\(\{ preventScroll: true \}\)/, '点一下也能接着用方向键微调');
  // 指针不再落到原生 range 上（否则它自己的拖动逻辑会和自绘几何打架）
  assert.match(css, /\.vinyl-range-input\s*\{[^}]*pointer-events:\s*none/);
  // 命中几何：进度条按内缩 7px 的轨道算，点哪滑块中心就落在哪
  assert.match(view, /geometry: \(\) => progressRail\.getBoundingClientRect\(\)/);
  assert.match(css, /\.vinyl-seek-rail\s*\{[^}]*left:\s*7px/);
  assert.match(css, /\.vinyl-seek-rail\s*\{[^}]*right:\s*7px/);
});

test('歌曲进度：填充与滑块共用同一条自绘轨道，拖动时不会分离', () => {
  assert.match(view, /vinyl-seek-rail/);
  assert.match(view, /vinyl-seek-fill/);
  assert.match(view, /vinyl-seek-thumb/);
  assert.match(css, /\.vinyl-seek-fill\s*\{[^}]*width:\s*var\(--seek-position/);
  assert.match(css, /\.vinyl-seek-thumb\s*\{[^}]*left:\s*var\(--seek-position/);
});

test('歌曲进度：拖动中与抬手保持期内，引擎回声不许回写轨道', () => {
  assert.match(view, /private seeking = false/);
  assert.match(view, /private seekHold/, '抬手后要压住轨道等引擎到位（在线源 seek 有往返）');
  assert.match(view, /const seekOwned = this\.seeking \|\| this\.seekHold !== null/);
  assert.match(view, /if \(!seekOwned && ratio !== this\.lastRatio\)/, '轨道回写必须过这道闸');
  assert.match(view, /if \(!seekOwned && timeText !== this\.lastTimeText\)/, '读数同理');
  assert.match(view, /onCommit: commitSeek/, '抬手才真正 seek（拖动中反复 seek 会让音频抽搐）');
  // 拖动中关掉缓动，填充与滑块直接跟手；「点一下」仍要那 220ms 的平滑推移，故从第一次移动才挂
  assert.match(css, /\.vinyl-seek-control\.is-scrubbing \.vinyl-seek-fill/);
  assert.match(view, /onDragStart: \(\) => progressControl\.addClass\('is-scrubbing'\)/);
  assert.match(view, /handlers\.onDragStart\?\.\(\)/, '接管层要在「真的拖起来」时才回调');
});

test('播放器控制顺序：音量在控制键上方，歌曲进度在控制键下方', () => {
  assert.ok(view.indexOf("cls: 'vinyl-vol-row'") < view.indexOf("cls: 'vinyl-controls'"));
  assert.ok(view.indexOf("cls: 'vinyl-controls'") < view.indexOf("cls: 'vinyl-progress'"));
});

test('音量表：至少 20 格，格高变化不超过 9px，哑光黑有专门对比色', () => {
  assert.match(view, /VOLUME_SEGMENT_COUNT\s*=\s*(2\d|[3-9]\d)/);
  assert.doesNotMatch(view, /vinyl-vol-icon|setIcon\([^\n]*'volume-2'/);
  assert.match(css, /--vinyl-meter-min-height:\s*\d+px/);
  assert.match(css, /--vinyl-meter-height-range:\s*[0-9]px/);
  assert.match(css, /\.vinyl-player\.is-deck-black \.vinyl-deck\s*\{[^}]*--vinyl-meter-off:/);
});

test('音量表：亮格的颜色变化有交互动画，拖动时摘掉延迟跟手', () => {
  assert.match(css, /@keyframes vinyl-meter-ignite/, '点火闪：刚亮起的那一格先闪品牌红');
  assert.match(css, /\.vinyl-volume-segment\.is-active\s*\{[^}]*animation:\s*vinyl-meter-ignite/);
  assert.match(css, /--vinyl-meter-flash:/);
  assert.match(css, /--vinyl-meter-glow:/);
  assert.match(
    css,
    /\.vinyl-volume-meter:not\(\.is-scrubbing\) \.vinyl-volume-segment\s*\{[^}]*transition-delay/,
    '跳格 / 键盘步进：按格序依次点亮（阶梯波浪）'
  );
  assert.match(
    css,
    /\.vinyl-volume-meter\.is-scrubbing \.vinyl-volume-segment\s*\{[^}]*transition-duration/,
    '拖动：没有延迟、时长更短'
  );
  assert.match(
    view,
    /onDragStart: \(\) => volMeter\.addClass\('is-scrubbing'\)/,
    '点一下要那串波浪，拖起来才摘掉延迟'
  );
  assert.match(view, /setVolumeSegments\(volSegments, r\)/, '拖动时本地立刻重画格子，不等引擎回声');
  // 减少动效：装饰性的推移与点火直接跳到终态
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,900}\.vinyl-volume-segment\.is-active\s*\{[^}]*animation: none/);
});
