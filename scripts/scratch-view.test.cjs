// 搓碟接线回归（源码 + 样式扫描，不需要 Obsidian）：
// 视图负责的几件事任何一件掉了都是「看着像坏了」而不是报错，所以逐条钉住：
//   ① 手势挂在转盘容器上、按几何判、排除播放键（唱臂裁剪层盖着盘面）；
//   ② 拖拽期间位置归手势（快照不回写轨道与唱臂）；
//   ③ 交还时用负 animation-delay 把当前角度续上（否则转盘会跳一下）；
//   ④ 装饰层让开指针事件（否则抓取光标永远落不到盘面上）；
//   ⑤ 关视图时释放解码缓冲（几十 MB 不能攥着）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('接线：手势挂在转盘上，几何判定 + 排除播放键，转角进累计器', () => {
  const src = read('src/views/player-view.ts');
  assert.match(src, /bindScratchGesture\(turntable, \{/, '手势要挂在转盘容器上（唱臂层盖着盘面）');
  assert.match(src, /geometry: \(\) => this\.scratchGeometry\(\)/);
  assert.match(src, /accept: \(ev\) => this\.canScratch\(\) && !this\.isDeckButton\(ev\)/);
  assert.match(src, /onTurn: \(turn\) => this\.scratchTracker\.add\(turn\)/);
  assert.match(src, /onEngage: \(\) => this\.scratchEngage\(\)/);
  assert.match(src, /onEnd: \(\) => this\.scratchRelease\(\)/);
  // 命中几何取的是内层唱片（正圆、绕心自转，旋转不改 bounding box）
  assert.match(src, /scratchGeometry[\s\S]{0,300}?els\.vinyl\.getBoundingClientRect\(\)/);
});

test('接线：拖拽期间位置归手势（快照不回写轨道 / 读数 / 唱臂）', () => {
  const src = read('src/views/player-view.ts');
  assert.match(
    src,
    /const seekOwned = this\.seeking \|\| this\.seekHold !== null \|\| this\.scratch !== null/,
    '搓碟期间要算「位置被本地方接管」'
  );
  assert.match(
    src,
    /if \(this\.scratch === null\) \{[\s\S]{0,400}?armPosture\(/,
    '搓碟期间唱臂姿态让给手势（起手即落针）'
  );
  assert.match(src, /private scratchPreview[\s\S]{0,900}?this\.writeArm\(/, '唱针跟着搓碟位置走');
});

test('接线：交还用负 animation-delay 续上角度，转盘不跳', () => {
  const src = read('src/views/player-view.ts');
  assert.match(src, /style\.setProperty\('animation-delay', `-\$\{Math\.round\(frac \* spinMs\)\}ms`\)/);
  assert.match(src, /private currentSpinAngle[\s\S]{0,500}?getAnimations\(\)/, '接手时读当前动画角度对齐');
  // 从暂停转回播放时动画会重建：那时清掉残留的负延迟
  assert.match(src, /if \(spinning && !this\.lastSpinning\) \{[\s\S]{0,200}?removeProperty\('animation-delay'\)/);
});

test('接线：可搓时才给抓取光标（唱机面 + 有曲目 + 不在换曲间隙）', () => {
  const src = read('src/views/player-view.ts');
  assert.match(src, /toggleClass\('is-scratchable', this\.canScratch\(\)\)/);
  assert.match(src, /private canScratch[\s\S]{0,400}?this\.face !== 'player'[\s\S]{0,200}?scratchEnabled/);
  assert.match(src, /private canScratch[\s\S]{0,600}?status === 'playing' \|\| s\.status === 'paused'/);
});

test('接线：换曲 / 关门都要收干净（作废手势、释放缓冲）', () => {
  const src = read('src/views/player-view.ts');
  // 判据是曲目键而不是下标：拖动重排只换位置不换曲子，那种情况不该把手里这张碟打断
  assert.match(
    src,
    /if \(this\.scratch && \(!s\.current \|\| trackKey\(s\.current\) !== this\.scratch\.key\)\) this\.scratchAbort\(\)/
  );
  assert.match(src, /async onClose\(\)[\s\S]{0,300}?this\.scratchAbort\(\)[\s\S]{0,120}?this\.disposeScratchDeck\(\)/);
  assert.match(src, /applyAppearance\(\)[\s\S]{0,800}?disposeScratchDeck\(\)/, '切到轻量档 / 关掉搓碟要还内存');
});

test('接线：缓冲的抓取时机 —— 开播几秒后预载（可关），起手兜底；不预取下一首', () => {
  const src = read('src/views/player-view.ts');
  // 预载：挂表 → 到点再抓。等待时长在 core/scratch（SCRATCH_PRELOAD_DELAY_MS，附理由）
  assert.match(src, /window\.setTimeout\(\(\) => \{[\s\S]{0,500}?this\.maybePrepareScratch\(cur, true\)/, '到点才去抓');
  assert.match(src, /}, SCRATCH_PRELOAD_DELAY_MS\);/, '等待时长走常量');
  assert.match(src, /if \(!this\.plugin\.settings\.scratchPreload\) return;/, '预载可以关掉');
  assert.match(src, /if \(!s\.current \|\| s\.status !== 'playing' \|\| this\.face !== 'player'\) return;/, '只有「在放 + 唱机面」才挂');
  assert.match(src, /this\.maybePrepareScratch\(s, true\)/, '起手时兜底（预载没赶上 / 关着预载）');
  assert.match(src, /deck\.prepared\(want\.key\)\) return true;/, '缓存命中什么都不做');
  assert.match(src, /deck\.canPrepare\(dur\)/, '时长装不下就不下载');
  // 排不下（在途满了）要回头再挂一次：连着切歌时后一首不该永远排不上队
  assert.match(src, /if \(!this\.maybePrepareScratch\(cur, true\)\) this\.armScratchPreload\(cur\)/);
  // 反向断言：不预取下一首（跟播放抢带宽 / 多解析一次地址，切歌会卡 —— 用户实测）
  assert.doesNotMatch(src, /const next = s\.index/, '不预取下一首');
});

test('接线：挂表 / 撤表的时机（曲目、播放状态、翻面、关门、切档）', () => {
  const src = read('src/views/player-view.ts');
  // 只在「曲目变了 / 播放状态翻了」时重挂 —— 每条快照都重挂的话等待时间永远走不完
  assert.match(
    src,
    /if \(scratchKey !== this\.preloadKey \|\| playing !== this\.preloadPlaying\) \{[\s\S]{0,200}?this\.armScratchPreload\(s\)/
  );
  assert.match(src, /if \(face === 'player' && this\.lastSnapshot\) this\.armScratchPreload\(this\.lastSnapshot\)/);
  assert.match(src, /else this\.disarmScratchPreload\(\)/, '翻到唱片区要撤表');
  assert.match(src, /async onClose\(\)[\s\S]{0,300}?this\.disarmScratchPreload\(\)/);
  assert.match(src, /applyAppearance\(\)[\s\S]{0,900}?disarmScratchPreload\(\)/, '切到轻量档 / 关掉搓碟要撤表');
});

test('接线：就绪状态说了算 —— 起手接不下就走轻量、中途备好就换过去', () => {
  const src = read('src/views/player-view.ts');
  // 起手：先按就绪状态定路线，搓碟台真的接下了（begin 返回 true）才算完整音效
  assert.match(src, /const useDeck = deckReady && !!this\.scratchDeck\?\.begin\(key, info\.time, this\.scratchTracker\.rate\)/);
  assert.match(src, /if \(!useDeck\) this\.plugin\.engine\.setScratchLive\(true\)/, '接不下要如实退回轻量（不能没声）');
  // 中途升级：每帧问一次，备好就把余下的交给搓碟台
  assert.match(src, /if \(!st\.deck && this\.canUpgrade\(st\) && this\.scratchDeck\?\.begin\(st\.key, st\.pos, st\.rate\)\)/);
  assert.match(src, /this\.plugin\.engine\.setScratchLive\(false\)/, '换路线要让元素让位');
  assert.match(src, /private canUpgrade[\s\S]{0,300}?this\.scratchDeck\.has\(st\.key\)/);
  // 位置先喂给引擎，再让轻量路按倍速起停（出声前要拿最新针位对齐元素）
  assert.match(
    src,
    /this\.plugin\.engine\.updateScratch\(st\.pos\);[\s\S]{0,120}?if \(!st\.deck\) this\.plugin\.engine\.scratchRate\(st\.rate\)/
  );
});

test('接线：取料分三路 + 时长自探测（本地未播过的曲子也能提前备）', () => {
  const src = read('src/views/player-view.ts');
  assert.match(src, /resolveVaultUrl\(track\.file\)/);
  assert.match(src, /resolveExternalUrl\(track\.path\)/);
  assert.match(src, /this\.plugin\.local\.readTrackBytes\(track\)/, '本地读字节');
  assert.match(src, /requestUrl\(\{ url \}\)\.then/, '在线走 requestUrl（主进程，无 CORS 限制）');
  assert.match(src, /probeMediaDuration\(url\)/, '时长未知（本地没播过的曲子）时探一次元数据');
  assert.match(src, /await Promise\.all\(\[bytes, duration\]\)/, '探测与取字节并行，不额外等');
});

test('搓碟台：缓存按 LRU 留几份，超内存丢最久没用过的（正在搓的不丢）', () => {
  const src = read('src/core/scratch-deck.ts');
  assert.match(src, /private entries = new Map<string, DeckEntry>\(\)/);
  assert.match(src, /SCRATCH_CACHE_BYTES = 96 \* 1024 \* 1024/);
  assert.match(src, /SCRATCH_CACHE_TRACKS = 3/);
  assert.match(src, /SCRATCH_MAX_INFLIGHT = 2/, '在途最多两份：当前 + 下一首');
  assert.match(src, /private evict\(\)[\s\S]{0,600}?if \(e === this\.active\) continue/);
});

test('样式：拖拽期间接管旋转、装饰层让开指针事件、光标只在可搓时出现', () => {
  const css = read('styles.css');
  assert.match(css, /\.vinyl-turntable-vinyl\.is-scratching \{[^}]*animation: none;/);
  assert.match(css, /\.vinyl-turntable-vinyl\.is-scratching \{[^}]*transform: rotate\(var\(--vinyl-scratch-angle/);
  assert.match(
    css,
    /\.vinyl-turntable-clip,\s*\.vinyl-arm-rest,\s*\.vinyl-turntable-spindle \{\s*pointer-events: none;/,
    '装饰层不让开的话，盘面永远不是命中目标（抓取光标落不到圆上）'
  );
  assert.match(css, /\.vinyl-turntable\.is-scratchable \.vinyl-turntable-platter[^}]*cursor: grab;/);
  assert.match(css, /\.vinyl-turntable\.is-scratching[^}]*cursor: grabbing;/);
  assert.match(css, /\.vinyl-turntable\.is-scratchable \.vinyl-turntable-pad \{\s*touch-action: none;/);
});

test('样式：全直角口径不受影响（搓碟没引入任何圆角）', () => {
  const css = read('styles.css');
  const block = css.slice(css.indexOf('.vinyl-turntable-vinyl.is-scratching'));
  const end = block.indexOf('/* 唱片中心标签');
  assert.ok(end > 0, '搓碟样式段落要能取到');
  assert.doesNotMatch(block.slice(0, end), /border-radius/, '搓碟这一段落里不许出现圆角');
});
