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
  // 命中几何：进度条按内缩半个滑块（唱放卡压高后是 6px = 12 / 2）的轨道算，点哪滑块中心就落在哪
  assert.match(view, /geometry: \(\) => progressRail\.getBoundingClientRect\(\)/);
  assert.match(css, /\.vinyl-seek-rail\s*\{[^}]*left:\s*6px/);
  assert.match(css, /\.vinyl-seek-rail\s*\{[^}]*right:\s*6px/);
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

test('播放器版面（设计稿）：三张卡 —— 顶部三键 / 唱机 / 唱放（②③在翻转区里），自上而下', () => {
  // 建 DOM 的顺序 = 版面的上下顺序：header（按键卡）→ flip（②③翻转区）→ deck → amp → Vinyl order → 队列
  const at = (s) => view.indexOf(s);
  assert.ok(at("cls: 'vinyl-player-header'") < at("cls: 'vinyl-flip'"), '按键卡在最上');
  assert.ok(at("cls: 'vinyl-flip'") < at("cls: 'vinyl-deck'"), '唱机卡在翻转区里');
  assert.ok(at("cls: 'vinyl-deck'") < at("cls: 'vinyl-amp'"), '唱机卡在中间');
  assert.ok(at("cls: 'vinyl-amp'") < at("cls: 'vinyl-order-row'"), '唱放卡在队列之前');
  // 进度条与音量条都在唱放卡里（不在唱机卡里）
  assert.match(view, /const amp = deckFace\.createDiv\(\{ cls: 'vinyl-amp' \}\)/);
  assert.match(view, /const progress = amp\.createDiv\(\{ cls: 'vinyl-progress' \}\)/);
  assert.match(view, /const volRow = amp\.createDiv\(\{ cls: 'vinyl-vol-row' \}\)/);
  assert.doesNotMatch(view, /deck\.createDiv\(\{ cls: 'vinyl-(progress|vol-row)' \}\)/);
  // ②③ 合并成一张卡（用户要求）：面板材质 / 落影改挂翻转面，两张卡只留外框线；
  // 唱片区（背面）与唱机面共用同一块面板 —— 翻面时两面材质一致，不会「转到一半换脸」
  assert.match(
    css,
    /\.vinyl-flip-face\.is-deck,\s*\.vinyl-flip-face\.is-crate\s*\{[^}]*background-image:/,
    '材质挂在翻转面（木纹一张到底，两面同一块面板）'
  );
  assert.match(
    css,
    /\.vinyl-flip-face\.is-deck,\s*\.vinyl-flip-face\.is-crate\s*\{[^}]*box-shadow:/,
    '落影也归翻转面（两面共用一道影）'
  );
  assert.match(css, /\.vinyl-deck,\s*\.vinyl-amp\s*\{[^}]*border:\s*1px solid/, '两张卡保留外框线（拼成同一道外框）');
  assert.match(css, /\.vinyl-deck,\s*\.vinyl-amp\s*\{[^}]*border-radius:\s*0/, '棱角照旧');
  const cardFrame = css.match(/\.vinyl-deck,\s*\.vinyl-amp \{[^}]*\}/);
  assert.doesNotMatch(cardFrame[0], /background-image:|box-shadow:/, '卡片自己不该再有材质 / 落影（否则接缝会露馅）');
  for (const v of ['black', 'shell', 'coral']) {
    assert.match(
      css,
      new RegExp(
        `\\.vinyl-player\\.is-deck-${v} \\.vinyl-flip-face\\.is-deck,\\s*\\.vinyl-player\\.is-deck-${v} \\.vinyl-flip-face\\.is-crate`
      ),
      `${v} 配色要挂在翻转面上（唱机面与唱片区共用）`
    );
    assert.match(
      css,
      new RegExp(`\\.vinyl-player\\.is-deck-${v} \\.vinyl-deck,\\s*\\.vinyl-player\\.is-deck-${v} \\.vinyl-amp`),
      `${v} 配色要同时覆盖唱机卡与唱放条的外框`
    );
  }
});

test('②③ 合并处：接缝描边去掉、内边距补回，尺寸与合并前逐像素一致', () => {
  // 按键卡 ↔ 翻转区（唱机卡）：板上行距 10px，由翻转区的负外边距吃掉一半（合并前就这样，不动）
  assert.match(css, /\.vinyl-flip\s*\{[^}]*margin-top:\s*-5px/, '按键卡与唱机卡之间 5px');
  // 接缝：不再有 5px 间隔，两张卡之间也没有描边
  assert.match(css, /\.vinyl-flip-face\s*\{[^}]*gap:\s*0/, '接缝那道间隔挪进唱机卡的下内边距');
  assert.match(
    css,
    /\.vinyl-flip-face\.is-deck > \.vinyl-deck\s*\{[^}]*border-bottom:\s*none/,
    '唱机卡的下描边去掉（否则接缝处横着一道线）'
  );
  assert.match(
    css,
    /\.vinyl-flip-face\.is-deck > \.vinyl-deck\s*\{[^}]*padding-bottom:\s*18px/,
    '12 + 5（原间隔）+ 1（原下描边）'
  );
  assert.match(
    css,
    /\.vinyl-flip-face\.is-deck > \.vinyl-amp\s*\{[^}]*border-top:\s*none/,
    '唱放条的上描边去掉'
  );
  assert.match(
    css,
    /\.vinyl-flip-face\.is-deck > \.vinyl-amp\s*\{[^}]*padding:\s*4px 12px 3px/,
    '上 = 3 + 1（原上描边）；左右下照旧'
  );
  // 尺寸账（用户要求：大小不要发生改变）：
  //   改造前 = 唱机卡 14+12+2 + 间隔 5 + 唱放条 3+3+2 = 41
  //   改造后 = 唱机卡 14+18+1 + 间隔 0 + 唱放条 4+3+1 = 41
  const deck = /\.vinyl-deck \{[^}]*padding:\s*(\d+)px \d+px (\d+)px/.exec(css);
  const deckMerge = /\.vinyl-flip-face\.is-deck > \.vinyl-deck\s*\{[^}]*padding-bottom:\s*(\d+)px/.exec(css);
  const ampMerge = /\.vinyl-flip-face\.is-deck > \.vinyl-amp\s*\{[^}]*padding:\s*(\d+)px \d+px (\d+)px/.exec(css);
  assert.ok(deck && deckMerge && ampMerge, '两张卡的内边距与合并处的补偿都要在');
  const before = 14 + 12 + 2 + 5 + 3 + 3 + 2;
  const after =
    Number(deck[1]) + Number(deckMerge[1]) + 1 + 0 + Number(ampMerge[1]) + Number(ampMerge[2]) + 1;
  assert.equal(after, before, `合并后应仍是 ${before}px，实际 ${after}px`);
  // 唱放条：设计的两行版式不动（进度在上、音量在下），只压高度
  assert.match(css, /\.vinyl-amp\s*\{[^}]*flex-direction:\s*column/, '两行版式照设计（进度在上、音量在下）');
  assert.match(css, /\.vinyl-amp\s*\{[^}]*gap:\s*2px/, '两行之间 10 → 2');
  assert.match(css, /\.vinyl-seek-control\s*\{[^}]*height:\s*14px/, '进度行 24 → 14');
  assert.match(css, /\.vinyl-volume-meter\s*\{[^}]*height:\s*14px/, '音量行 24 → 14（两行等高）');
  assert.match(css, /\.vinyl-vol-row\s*\{[^}]*min-height:\s*14px/);
});

test('页面 1：圆钮（⏮ ▶ ⏭）与走带条整体删除，播放键只剩唱盘左下角那一枚', () => {
  assert.doesNotMatch(view, /cls: 'vinyl-controls'/, '圆钮组没了');
  assert.doesNotMatch(view, /cls: 'vinyl-transport'/, '走带条没了');
  assert.doesNotMatch(view, /setIcon\(prevBtn|setIcon\(nextBtn|cls: 'vinyl-btn vinyl-btn-primary'/, '⏮ ⏭ 与圆形的播放钮都没了');
  assert.doesNotMatch(view, /engine\.prev\(\)|engine\.next\(\)/, '视图里不再挂上一首 / 下一首（命令面板与媒体键仍走引擎）');
  assert.match(view, /els\.deckPlayBtn\.toggleClass\('is-playing', lit\)/, '唯一的播放键 = 唱机左下角那枚（字标点亮 / 未点亮）');
});

test('音量表：至少 20 格，格高变化不超过 9px，配色随面板材质（用户改：不再跟主题）', () => {
  assert.match(view, /VOLUME_SEGMENT_COUNT\s*=\s*(2\d|[3-9]\d)/);
  assert.doesNotMatch(view, /vinyl-vol-icon|setIcon\([^\n]*'volume-2'/);
  assert.match(css, /--vinyl-meter-min-height:\s*\d+px/);
  assert.match(css, /--vinyl-meter-height-range:\s*[0-9]px/);
  // 电平表就在唱放卡的面板上：亮格 / 暗格 / 发光随面板材质走 —— 深色面板奶白墨、贝壳白深灰墨
  assert.match(css, /\.vinyl-amp\s*\{[^}]*--vinyl-meter-on:\s*rgba\(245,\s*239,\s*227/, '深色面板：奶白亮格');
  assert.match(css, /\.vinyl-amp\s*\{[^}]*--vinyl-meter-off:/, '深色面板：暗格跟着给');
  assert.match(
    css,
    /\.vinyl-player\.is-deck-shell \.vinyl-amp\s*\{[^}]*--vinyl-meter-on:/,
    '贝壳白面板：亮格翻成深灰墨'
  );
  // 反向断言：表自己不定义配色（自己定会盖掉材质给的继承值），只留闪色
  const rowBlock = css.match(/\.vinyl-vol-row \{[^}]*\}/);
  assert.ok(rowBlock, '电平表样式块还在');
  assert.doesNotMatch(rowBlock[0], /--vinyl-meter-(on|off|edge|glow):/, '配色归面板材质，不在表自己身上');
});

// 立方体的两个面：滚动 / 裁剪绝不能挂在「面」上 —— 可滚动区域 + 3D 变换会让 Blink 对这一面
// （连同整棵子树）的命中测试整面失效：翻到页面 2 后返回键、唱片、多选全都点不到（真机实测）。
// 这条回归盯的就是那次「返回键失效」。
test('翻转区命中测试：overflow 不在「面」上，滚动交给板与唱片区自己', () => {
  const faceBlock = css.match(/\.vinyl-flip-face \{[^}]*\}/);
  assert.ok(faceBlock, '面的样式块还在');
  assert.doesNotMatch(faceBlock[0], /overflow(-[xy])?:/, '面自己不能带 overflow（会让整面点不到）');
  assert.match(css, /\.vinyl-board \{[^}]*overflow-y:\s*auto/, '板承接整页纵向滚动');
  // 视图侧：不参与翻面的内容（按键卡 / 队列）建在板上；唱片区挂进背面
  assert.match(view, /const board = c\.createDiv\(\{ cls: 'vinyl-board' \}\)/);
  assert.match(view, /const deckFace = flipInner\.createDiv\(\{ cls: 'vinyl-flip-face is-deck' \}\)/);
  assert.match(view, /const crateFace = flipInner\.createDiv\(\{ cls: 'vinyl-flip-face is-crate' \}\)/);
  assert.match(view, /this\.pickerFace = crateFace/);
  assert.match(view, /const deck = deckFace\.createDiv\(\{ cls: 'vinyl-deck' \}\)/);
  assert.match(view, /const queueBox = board\.createDiv\(\{ cls: 'vinyl-queue' \}\)/);
});

test('按键卡（设计稿）：三枚键 2 : 1 : 1 —— 选取专辑占一半，两个模式开关各占四分之一', () => {
  assert.match(view, /cls: 'vinyl-btn-wide vinyl-pick-album'/);
  assert.match(view, /const queueModeBtn = header\.createEl\('button', \{ cls: 'vinyl-btn-mode vinyl-queue-mode' \}\)/);
  assert.match(view, /const playModeBtn = header\.createEl\('button', \{ cls: 'vinyl-btn-mode vinyl-play-mode' \}\)/);
  // 卡片底色 + 描边；宽度写死百分比（flex-basis 0 会被 padding 撑出「地板宽」，比例就不准了）
  assert.match(css, /\.vinyl-player-header\s*\{[^}]*border/, '按键卡有自己的描边');
  assert.match(css, /\.vinyl-btn-wide\s*\{[^}]*flex:\s*0 0 calc\(50% - 3px\)/, '宽键占一半');
  assert.match(css, /\.vinyl-btn-mode\s*\{[^}]*flex:\s*0 0 calc\(25% - 3px\)/, '模式键各占四分之一');
  // 标题行没了：专辑名归 Vinyl order 行（orderAlbum）；播放错误由引擎的 Notice 弹窗报出
  assert.doesNotMatch(view, /vinyl-player-header-title/);
  // 唱盘上那块「来源 · 档位」读数已按用户要求撤掉（视图里不再有对应节点）
  assert.doesNotMatch(view, /qualityEl|qualityReadout|vinyl-quality/);
  // 用户改：选取专辑只留图标（去文字）；整卡瘦长（键高 28）且全棱角
  assert.doesNotMatch(view, /vinyl-btn-wide-label/);
  assert.doesNotMatch(css, /vinyl-btn-wide-label/);
  assert.match(css, /\.vinyl-player \.vinyl-btn-wide,[\s\S]{0,80}?height:\s*28px/, '键高 28（整卡瘦长）');
  assert.match(css, /\.vinyl-player-header\s*\{[^}]*border-radius:\s*0/, '按键卡全棱角');
  assert.match(css, /\.vinyl-player \.vinyl-btn-wide,[\s\S]{0,320}?border-radius:\s*0/, '键也全棱角');
});

test('唱机卡（设计稿）：横向长方形唱盘 + 左下角长方形播放键（棱角、离唱片留缝）', () => {
  assert.match(css, /\.vinyl-turntable\s*\{[^}]*aspect-ratio:\s*1\.3/, '唱盘是横向长方形（宽 > 高）');
  assert.match(view, /const deckPlayBtn = turntable\.createEl\('button', \{ cls: 'vinyl-deck-play' \}\)/, '播放键建在唱盘里');
  // 用户改（第四轮）：键放大到「顶部按键卡的四分之一键」那么大；第五轮再收窄一档、右移一点。
  // 顶部那张键 = 卡宽 × 25% - 3px；转盘宽 = 卡宽 - 30px（卡片左右各 14 内边距 + 1 描边）
  // → 25% + 2.5px 是等宽；用户要「稍微窄一点」→ 25% - 3px（比顶部键窄 5.5px）。
  assert.match(css, /\.vinyl-deck-play\s*\{[^}]*width:\s*calc\(25% - 3px\)/, '键宽比顶部四分之一键窄一档');
  assert.match(css, /\.vinyl-deck-play\s*\{[^}]*max-height:\s*28px/, '键高封顶 = 顶部键高（28px）');
  assert.match(css, /\.vinyl-deck-play\s*\{[^}]*left:\s*-2%/, '往左让开唱盘（第五轮又右移一点）');
  assert.match(css, /\.vinyl-deck-play\s*\{[^}]*bottom:\s*-7\.5%/, '往下让开唱盘');
  assert.match(css, /\.vinyl-deck-play\s*\{[^}]*aspect-ratio:\s*2\.3/, '长方形：宽 : 高 = 2.3');
  // 几何校验（用户要求：放大后不许碰到唱盘）：按样式表里的百分比真值算一遍 ——
  // 唱盘圆心 (46.92%, 49%)、半径 40.385%（.vinyl-turntable-platter），键的右上角必须落在圆外。
  // 转盘高 = 宽 / 1.3；键宽 = 25% - 3px、高 = min(宽 / 2.3, 28px)、左 = -2%、下 = -7.5% 高。
  const play = {
    left: (T) => -T * 0.02,
    w: (T) => T * 0.25 - 3,
    h: (T) => Math.min((T * 0.25 - 3) / 2.3, 28),
    bottom: (T) => -(T / 1.3) * 0.075,
  };
  for (const T of [140, 200, 252, 320, 430]) {
    const H = T / 1.3;
    const cx = T * 0.4692;
    const cy = H * 0.49;
    const r = T * 0.40385;
    const xr = play.left(T) + play.w(T); // 键的右边缘
    const yt = H - play.bottom(T) - play.h(T); // 键的上边缘（bottom 是负的偏移）
    const gap = Math.hypot(xr - cx, yt - cy) - r;
    assert.ok(gap > 1, `转盘宽 ${T}px 时键的右上角离唱盘只有 ${gap.toFixed(1)}px（要 > 1px）`);
  }
  assert.match(css, /\.vinyl-deck-play\s*\{[^}]*border-radius:\s*0/, '全棱角：圆角为 0');
  assert.doesNotMatch(css, /\.vinyl-deck-play\s*\{[^}]*border-radius:\s*50%/, '不能是圆钮');
  // 用户改：键面黑色 + 边缘双线条，还要和哑光黑面板分得开（黑底 + 至少两道浅色线 + 光泽）。
  // 第三轮：这套键面抽成了共享变量，顶部三键与唱机键共用（--vinyl-key-* 定义在 .vinyl-player 上）
  assert.match(css, /\.vinyl-deck-play\s*\{[^}]*background:\s*var\(--vinyl-key-face\)/, '键面用共享的黑键面变量');
  assert.match(css, /--vinyl-key-face:\s*linear-gradient\(180deg, #3b3d45/, '黑键面 = 有光泽的黑（不是银键）');
  assert.match(css, /--vinyl-key-shadow:[\s\S]{0,200}?inset 0 0 0 2px[\s\S]{0,120}?inset 0 0 0 3px/, '双线条：外描边之内再收一道线');
  // 真机踩坑：宿主的 button:not(.clickable-icon) 是 (0,1,1)，会盖掉单类选择器 (0,1,0) 的
  // color / box-shadow —— 黑键面（双线条是 inset box-shadow 画的）那几条必须挂前缀，否则真机上不生效
  assert.match(css, /\.vinyl-player \.vinyl-btn-wide,\s*\.vinyl-player \.vinyl-btn-mode\s*\{/, '三键基样式带 .vinyl-player 前缀（压过宿主按钮样式）');
  assert.match(css, /\.vinyl-turntable \.vinyl-deck-play\s*\{/, '唱机键基样式带 .vinyl-turntable 前缀');
  // 用户改（第三轮）：顶部三键做成唱机暂停键那样的样式与动效
  assert.match(css, /\.vinyl-player \.vinyl-btn-wide,[\s\S]{0,400}?background:\s*var\(--vinyl-key-face\)/, '三键共用同一套黑键面');
  assert.match(css, /\.vinyl-player \.vinyl-btn-wide,[\s\S]{0,500}?box-shadow:\s*var\(--vinyl-key-shadow\)/, '三键共用同一套双线条 + 落影');
  assert.match(css, /\.vinyl-btn-mode\.is-active,[\s\S]{0,120}?background:\s*var\(--vinyl-key-face-lit\)/, '亮起 = 键面亮一档');
  assert.match(css, /@keyframes vinyl-key-breathe-icon/, '图标版呼吸关键帧');
  assert.match(css, /\.vinyl-btn-mode\.is-active \.svg-icon,[\s\S]{0,120}?animation:\s*vinyl-key-breathe-icon/, '亮起时图标呼吸');
  assert.match(css, /\.vinyl-btn-wide:active,[\s\S]{0,120}?transform:\s*translateY\(1px\)/, '按下有行程感（与唱机键一致）');
  // 用户改：键面图标换成那一版手写体字标（第四轮去掉「Life」、第五轮缩成品牌缩写「V-L」，不折行）
  assert.match(view, /deckPlayBtn\.createSpan\(\{ cls: 'vinyl-deck-play-mark', text: 'V-L' \}\)/, '键面 = 手写体字标「V-L」');
  assert.doesNotMatch(view, /setIcon\(deckPlayBtn/, '三角图标已撤掉');
  assert.doesNotMatch(view, /text: 'Vinyl Life'/, '「Life」已按用户要求去掉');
  assert.match(css, /\.vinyl-deck-play-mark\s*\{[^}]*font-family:\s*'Vinyl Hand'/, '字标用手写体');
  assert.match(css, /\.vinyl-deck-play-mark\s*\{[^}]*font-size:\s*4\.5cqw/, '字标跟着放大的键面同比例放大');
  assert.match(css, /\.vinyl-deck-play-mark\s*\{[^}]*white-space:\s*nowrap/, '一个字词也不许折行');
  assert.match(css, /\.vinyl-deck-play\.is-playing \.vinyl-deck-play-mark/, '播放中点亮字标（代替原来的三角 / 双竖条）');
  // 用户改（第二轮）：播放 / 暂停要有一档看得出来的特效区分 —— 播放中字标呼吸式发光 + 键面亮一档
  assert.match(css, /@keyframes vinyl-key-breathe/, '播放中：字标呼吸发光');
  assert.match(css, /\.vinyl-deck-play\.is-playing \.vinyl-deck-play-mark\s*\{[^}]*animation:\s*vinyl-key-breathe/, '动画只在播放态挂上');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,400}?\.vinyl-deck-play\.is-playing/, '减少动效：不呼吸（仍分点亮 / 熄灭）');
  assert.match(css, /\.vinyl-deck-play\.is-playing\s*\{[^}]*background:/, '播放中键面也亮一档');
  // 读数行（来源 · 档位）已按用户要求整块撤掉：视图与样式里都不该再有它的痕迹
  assert.doesNotMatch(view, /vinyl-deck-brand-row|brandRow/);
  assert.doesNotMatch(css, /vinyl-deck-brand-row|\.vinyl-quality/);
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
