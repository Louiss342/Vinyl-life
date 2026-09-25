// 搓碟台回归：内存预算挑采样率、解码准备（幂等 / 可作废）、位置积分、方向翻转（负速率可用与不可用两条路）。
// 盯住的坑：
//   ① 反向出声：Chromium 的负速率没普及，不支持时必须换到「倒放副本 + 偏移 时长−位置」，
//      否则反向那一程要么无声要么从错误的位置起播（听感上是另一首歌）；
//   ② 位置由本模块积分，和声源自己的读数无关 —— 抬手要把积分出来的位置交还给元素；
//   ③ 换曲时必须丢弃在途的解码结果（几十 MB 的内存别为上一首留着）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  stdin: { contents: `export * from '../src/core/scratch-deck';\n`, resolveDir: __dirname, loader: 'ts' },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
}).outputFiles[0].text;

const mod = { exports: {} };
vm.runInNewContext(source, { module: mod, exports: mod.exports, require: () => ({}), console });
const deckMod = mod.exports;
const { ScratchDeck, chooseScratchRate, SCRATCH_BUDGET_BYTES } = deckMod;

const tick = () => new Promise((r) => setTimeout(r, 0));

// —— 假声卡 / 假解码（本模块只用到这几样，与 media-session 的替身同一取舍）——

function fakeParam() {
  const p = {
    value: 1,
    sets: [],
    setValueAtTime(v, t) {
      p.value = v;
      p.sets.push(['set', v, t]);
    },
    linearRampToValueAtTime(v, t) {
      p.value = v;
      p.sets.push(['ramp', v, t]);
    },
    cancelScheduledValues(t) {
      p.sets.push(['cancel', t]);
    },
  };
  return p;
}

function fakeBuffer(channels, length, sampleRate, fill) {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  if (fill) for (let c = 0; c < channels; c++) for (let i = 0; i < length; i++) data[c][i] = fill(i);
  return {
    duration: length / sampleRate,
    sampleRate,
    numberOfChannels: channels,
    length,
    getChannelData: (c) => data[c],
  };
}

function fakeCtx() {
  const ctx = {
    currentTime: 0,
    state: 'running',
    destination: {},
    sources: [],
    gains: [],
    closed: false,
    createGain() {
      const g = { gain: fakeParam(), connect() {} };
      ctx.gains.push(g);
      return g;
    },
    createBufferSource() {
      const s = {
        buffer: null,
        playbackRate: fakeParam(),
        started: null,
        stopped: null,
        connect() {},
        start(when, offset) {
          s.started = { when, offset };
        },
        stop(when) {
          s.stopped = when;
        },
      };
      ctx.sources.push(s);
      return s;
    },
    createBuffer: (c, l, r) => fakeBuffer(c, l, r),
    resume: () => Promise.resolve(),
    close: () => {
      ctx.closed = true;
      return Promise.resolve();
    },
  };
  return ctx;
}

/** 建一台搓碟台：默认解码出一段 1 秒、样本值 = 下标的双声道缓冲 */
function setup(over = {}) {
  const ctx = fakeCtx();
  const state = { loads: 0, decoded: null };
  const deck = new ScratchDeck({
    createContext: () => ctx,
    decode: async (bytes, rate) => {
      state.decoded = { rate, bytes };
      const buf = fakeBuffer(2, rate, rate, (i) => i); // 1 秒
      return buf;
    },
    negativeRate: over.negativeRate || (async () => true),
    volume: () => over.volume ?? 0.8,
    schedule: over.schedule || ((fn) => fn()), // 倒放副本默认同步建（测试里的缓冲很小）
    ...over.deps,
  });
  const load = over.load || (async () => new ArrayBuffer(8));
  return { deck, ctx, state, load };
}

/** 准备一首曲子（取料 → 解码 → 就绪）：load 给整轨字节，时长按参数走（也当 durationHint 传） */
async function prepare(deck, load, key = 'k', duration = 1) {
  deck.prepare(key, duration, async () => ({ bytes: await load(), durationSec: duration }));
  await tick();
  await tick();
  return deck;
}

/** 不真分配内存的假缓冲：只报 length（字节数按它算），用于内存淘汰用例 */
function virtualBuffer(sampleRate, seconds) {
  return {
    duration: seconds,
    sampleRate,
    numberOfChannels: 2,
    length: Math.round(seconds * sampleRate),
    getChannelData: () => new Float32Array(1),
  };
}

// —— 采样率档位 ——

test('采样率档位：按内存预算由高到低挑一档，都装不下返回 null', () => {
  const sPerSec = 22050 * 2 * 4; // 22.05 kHz 立体声 float32 = 176.4 KB/s
  const fit22050 = Math.floor(SCRATCH_BUDGET_BYTES / sPerSec);
  assert.equal(chooseScratchRate(fit22050), 22050, '正好装得下：取最高档');
  assert.equal(chooseScratchRate(fit22050 + 1), 16000, '装不下就降一档');
  assert.equal(chooseScratchRate(500), 16000, '16 kHz 装得下（500s × 128 KB/s ≈ 61 MB）');
  assert.equal(chooseScratchRate(600), 11025, '再长就降到 11.025 kHz');
  assert.equal(chooseScratchRate(900), 8000);
  assert.equal(chooseScratchRate(2000), null, '20 分钟的现场：不解码（走轻量音效）');
  assert.equal(chooseScratchRate(0), null, '时长未知不猜');
  assert.equal(chooseScratchRate(NaN), null);
  assert.equal(chooseScratchRate(16, 1024 * 1024), 8000, '预算缩小：挑最低档也得装下');
  assert.equal(chooseScratchRate(20, 1024 * 1024), null, '最低档也装不下：不解码');
  assert.equal(chooseScratchRate(10000, 1024 * 1024), null);
});

test('预算减半（负速率不可用时倒放副本要占一半）', () => {
  const half = SCRATCH_BUDGET_BYTES / 2;
  assert.equal(chooseScratchRate(200, SCRATCH_BUDGET_BYTES), 22050);
  assert.equal(chooseScratchRate(200, half), 16000, '同一首曲子：预算减半就降档');
});

// —— 准备 ——

test('准备：取字节 → 按挑中的档位解码 → 就绪；同键不重复准备', async () => {
  const { deck, state, load } = setup();
  const counting = async () => {
    state.loads++;
    return load();
  };
  await prepare(deck, counting);
  assert.equal(deck.prepared('k'), true);
  assert.equal(state.loads, 1);
  assert.equal(state.decoded.rate, 22050);
  await prepare(deck, counting); // 再来一次
  assert.equal(state.loads, 1, '已就绪：不该再取一遍字节');
});

test('准备：时长装不进预算就不准备（这首曲子只走轻量音效）', async () => {
  const { deck, ctx, state } = setup();
  await prepare(deck, async () => new ArrayBuffer(8), 'long', 3000);
  assert.equal(deck.prepared('long'), false);
  assert.equal(ctx.gains.length, 0, '连声卡上下文都不该建');
  assert.equal(state.decoded, null);
});

test('准备：两首并行准备互不作废（后发起的先回来也照样进缓存）', async () => {
  const { deck, state } = setup();
  let releaseA;
  const pendingA = new Promise((r) => {
    releaseA = r;
  });
  // a 先发起、卡在取料上；b 后发起、立刻完成 —— b 的发起不许把 a 作废（曾经的全局代次会）
  deck.prepare('a', 1, async () => {
    await pendingA;
    return { bytes: new ArrayBuffer(8), durationSec: 1 };
  });
  await tick();
  deck.prepare('b', 1, async () => ({ bytes: new ArrayBuffer(8), durationSec: 1 }));
  await tick();
  await tick();
  assert.equal(deck.prepared('b'), true, '后发起的先就绪');
  releaseA();
  await tick();
  await tick();
  assert.equal(deck.prepared('a'), true, '先发起的后回来也照样进缓存');
});

test('准备：在途最多两份，超了等下一次（当前那首优先排队）', async () => {
  const { deck } = setup();
  let release;
  const pending = new Promise((r) => {
    release = r;
  });
  const slow = async () => {
    await pending;
    return { bytes: new ArrayBuffer(8), durationSec: 1 };
  };
  assert.equal(deck.prepare('a', 1, slow), true, '排上了');
  deck.prepare('b', 1, slow);
  assert.equal(deck.prepare('c', 1, slow), false, '第三份排不下：要如实告诉调用方（预载表据此回头再挂）');
  assert.equal(deck.prepare('a', 1, slow), true, '同一首重复挂：已经排上了，不必回头再试');
  await tick();
  release();
  await tick();
  await tick();
  assert.equal(deck.prepared('a'), true);
  assert.equal(deck.prepared('b'), true);
  assert.equal(deck.prepared('c'), false, '超出在途上限的那份要等下一次调用');
  deck.prepare('c', 1, async () => ({ bytes: new ArrayBuffer(8), durationSec: 1 }));
  await tick();
  await tick();
  assert.equal(deck.prepared('c'), true, '腾出手来就能进来');
});

test('释放：在途的结果不许再进缓存（也不许把声卡重建起来）', async () => {
  const { deck, ctx, state } = setup();
  let release;
  const pending = new Promise((r) => {
    release = r;
  });
  deck.prepare('a', 1, async () => {
    await pending;
    return { bytes: new ArrayBuffer(8), durationSec: 1 };
  });
  await tick();
  deck.dispose();
  release();
  await tick();
  await tick();
  assert.equal(deck.prepared('a'), false, '已释放：回来了也不收');
  assert.equal(state.decoded, null, '连解码都不该发生（浪费 CPU 还建出声卡）');
  assert.equal(ctx.gains.length, 0, '声卡上下文也不许被重新建起来');
});

test('准备：取字节失败只影响这一首（静默降级，不抛）', async () => {
  const { deck } = setup();
  await prepare(deck, async () => null);
  assert.equal(deck.prepared('k'), false);
});

// —— 出声 ——

test('起手：按当帧倍速起播（不是正常转速），按倍速推进位置积分', async () => {
  const { deck, ctx } = setup();
  await prepare(deck, async () => new ArrayBuffer(8));
  assert.equal(deck.begin('k', 0.25, 0.4), true);
  const src = ctx.sources[0];
  assert.equal(src.buffer.duration, 1);
  assert.ok(Math.abs(src.started.offset - 0.25) < 1e-9, '从当前位置起播');
  assert.equal(src.playbackRate.value, 0.4, '起手就按手指这一帧的速度 —— 先响一截原速是听得出来的');
  deck.frame(100, 1); // 0.1 秒
  assert.ok(Math.abs(deck.position() - 0.35) < 1e-9, `位置积分：0.25 + 0.1 = 0.35，实得 ${deck.position()}`);
  deck.frame(100, 0.5);
  assert.ok(Math.abs(deck.position() - 0.4) < 1e-9);
});

test('起手：这一首没备好就不接（视图据此退回轻量音效，而不是「在搓但没声」）', async () => {
  const { deck, ctx } = setup();
  await prepare(deck, async () => new ArrayBuffer(8), 'k');
  assert.equal(deck.begin('other', 0), false);
  assert.equal(ctx.sources.length, 0, '接不了就一个源都不起');
});

test('位置积分：单帧上限 100ms（窗口切回来别让位置飞出去）', async () => {
  const { deck } = setup();
  await prepare(deck, async () => new ArrayBuffer(8));
  deck.begin('k', 0.1);
  deck.frame(5000, 1); // 5 秒的一帧
  assert.ok(Math.abs(deck.position() - 0.2) < 1e-9, `只推进 100ms，实得 ${deck.position()}`);
});

test('位置积分：两端 clamp（唱片有头有尾）', async () => {
  const { deck } = setup();
  await prepare(deck, async () => new ArrayBuffer(8));
  deck.begin('k', 0.9);
  deck.frame(100, 4);
  deck.frame(100, 4);
  assert.equal(deck.position(), 1, '顶到头就不再走');
  deck.frame(100, -4);
  deck.frame(100, -4);
  deck.frame(100, -4);
  assert.equal(deck.position(), 0, '回到头也不再走');
});

test('顶到头：声源作废、增益拉回，往回拖要能重新出声', async () => {
  const { deck, ctx } = setup();
  await prepare(deck, async () => new ArrayBuffer(8));
  deck.begin('k', 0.9, 1);
  const first = ctx.sources[0];
  deck.frame(100, 4); // 正着播到末尾
  assert.equal(deck.position(), 1);
  assert.notEqual(first.stopped, null, '到头的声源要停掉（已结束的节点写 playbackRate 是哑的）');
  const gain = ctx.gains[0].gain;
  assert.deepEqual(gain.sets[gain.sets.length - 1].slice(0, 2), ['set', 0.8], '增益要拉回本次会话的音量');

  deck.frame(100, -1); // 往回拖：重新起播
  assert.equal(ctx.sources.length, 2, '往回拖必须能出声');
  assert.ok(Math.abs(ctx.sources[1].started.offset - 0.9) < 1e-9, `从当前位置（0.9）起播，实得 ${ctx.sources[1].started.offset}`);
  assert.equal(ctx.sources[1].playbackRate.value, -1);
});

test('换向：增益自动化先撤销再排（快速来回不会把增益压在 0 上）', async () => {
  const { deck, ctx } = setup({ negativeRate: async () => false }); // 走「换源」那条路
  await prepare(deck, async () => new ArrayBuffer(8));
  deck.begin('k', 0.5, 1);
  const gain = ctx.gains[0].gain;
  const before = gain.sets.length;
  deck.frame(16, -1); // 换向：收掉旧的、起倒放副本
  deck.frame(16, 1); // 还没走完就又换回来
  const tail = gain.sets.slice(before);
  assert.equal(tail.filter((e) => e[0] === 'cancel').length, 4, '两次换向 = 两组「淡出 + 淡入」，每组各撤一次');
  assert.deepEqual(tail[tail.length - 1].slice(0, 2), ['ramp', 0.8], '最后要淡入到本次会话的音量（不是 0）');
});

test('has：只问有没有，不动 LRU 次序（视图每帧拿它看缓冲备好了没）', async () => {
  const { deck } = setup();
  await prepare(deck, async () => new ArrayBuffer(8), 'k1');
  await prepare(deck, async () => new ArrayBuffer(8), 'k2');
  await prepare(deck, async () => new ArrayBuffer(8), 'k3');
  assert.equal(deck.has('k1'), true);
  assert.equal(deck.has('nope'), false);
  for (let i = 0; i < 5; i++) deck.has('k1'); // 问再多遍也不该把它问成「刚用过」
  await prepare(deck, async () => new ArrayBuffer(8), 'k4'); // 超份数上限 → 淘汰最久没用过的
  assert.equal(deck.has('k1'), false, 'k1 才是被淘汰的那份');
  assert.equal(deck.has('k2'), true);
});

test('反向：支持负速率 → 一个源、带符号倍速、原缓冲', async () => {
  const { deck, ctx } = setup({ negativeRate: async () => true });
  await prepare(deck, async () => new ArrayBuffer(8));
  deck.begin('k', 0.5);
  deck.frame(100, -2);
  assert.equal(ctx.sources.length, 1, '同一台只用一个源（负速率直接倒着读）');
  assert.equal(ctx.sources[0].playbackRate.value, -2, '负倍速原样交给声源');
  assert.equal(ctx.sources[0].stopped, null, '不需要停掉重来');
});

test('反向：不支持负速率 → 换到倒放副本，偏移 = 时长 − 位置', async () => {
  const { deck, ctx } = setup({ negativeRate: async () => false });
  await prepare(deck, async () => new ArrayBuffer(8));
  const fwd = ctx.sources.length; // 0（还没起手）
  assert.equal(fwd, 0);
  deck.begin('k', 0.25);
  const forward = ctx.sources[0];
  assert.equal(forward.buffer.duration, 1);
  assert.ok(Math.abs(forward.started.offset - 0.25) < 1e-9);

  deck.frame(100, -1); // 反向：位置先退 0.1，再换源
  assert.equal(ctx.sources.length, 2, '方向翻转要起新源');
  const back = ctx.sources[1];
  assert.notEqual(back.buffer, forward.buffer, '反向走的是倒放副本');
  assert.ok(Math.abs(back.started.offset - 0.85) < 1e-9, `偏移 = 1 − 0.15 = 0.85，实得 ${back.started.offset}`);
  assert.equal(back.playbackRate.value, 1, '倒放副本正着读（倍速取绝对值）');
  assert.notEqual(forward.stopped, null, '上一程要停掉');
  // 倒放副本的内容确实是倒的：首个采样 = 原缓冲最后一个
  assert.equal(back.buffer.getChannelData(0)[0], 1 * 22050 - 1);

  deck.frame(100, 1); // 转回正向
  assert.equal(ctx.sources.length, 3);
  const fwd2 = ctx.sources[2];
  assert.equal(fwd2.buffer, forward.buffer, '正向回到原缓冲');
  assert.ok(Math.abs(fwd2.started.offset - 0.25) < 1e-9);
});

test('反向：倒放副本没就绪时保持安静，但位置照走（不是坏掉）', async () => {
  const { deck, ctx } = setup({ negativeRate: async () => false, schedule: () => {} }); // 副本永不推进
  await prepare(deck, async () => new ArrayBuffer(8));
  deck.begin('k', 0.5);
  const before = ctx.sources.length;
  deck.frame(100, -1);
  assert.equal(ctx.sources.length, before, '副本没就绪：不起新源');
  assert.ok(Math.abs(deck.position() - 0.4) < 1e-9, '位置照常积分');
});

test('抬手：渐弱收尾并交出位置', async () => {
  const { deck, ctx } = setup();
  await prepare(deck, async () => new ArrayBuffer(8));
  deck.begin('k', 0.2);
  deck.frame(100, 1);
  const end = deck.end();
  assert.ok(Math.abs(end - 0.3) < 1e-9, '交出的就是积分出来的位置');
  const gain = ctx.gains[0].gain;
  assert.deepEqual(gain.sets[gain.sets.length - 1].slice(0, 2), ['ramp', 0], '增益收到 0');
  assert.notEqual(ctx.sources[0].stopped, null);
});

test('释放：关上下文、丢缓冲（prepared 归 false）', async () => {
  const { deck, ctx } = setup();
  await prepare(deck, async () => new ArrayBuffer(8));
  deck.begin('k', 0); // 起一次手：声卡上下文这时才建
  deck.dispose();
  assert.equal(ctx.closed, true);
  assert.equal(deck.prepared('k'), false);
});

test('音量：起手时把当前音量写给增益节点；为 0 就是静音', async () => {
  const { deck, ctx } = setup({ volume: 0.3 });
  await prepare(deck, async () => new ArrayBuffer(8));
  deck.begin('k', 0);
  assert.equal(ctx.gains[0].gain.value, 0.3);
});

test('缓存：解码好的份留着 —— 回头再听不再取字节', async () => {
  const { deck, state } = setup();
  const load = async () => {
    state.loads++;
    return new ArrayBuffer(8);
  };
  await prepare(deck, load, 'a');
  await prepare(deck, load, 'b');
  assert.equal(state.loads, 2);
  assert.equal(deck.prepared('a'), true, '第二首准备完，第一首还在缓存里');
  await prepare(deck, load, 'a'); // 回头再听
  assert.equal(state.loads, 2, '缓存命中：不再取字节');
});

test('缓存：超过份数上限 → 丢最久没用过的那份', async () => {
  const { deck, state } = setup();
  const load = async () => {
    state.loads++;
    return new ArrayBuffer(8);
  };
  for (const key of ['a', 'b', 'c', 'd']) await prepare(deck, load, key);
  assert.equal(state.loads, 4);
  assert.equal(deck.prepared('a'), false, '第四首进来时淘汰了最久没用过的 a');
  assert.equal(deck.prepared('d'), true);
});

test('缓存：正在搓的那份不会被淘汰（手上这张碟不许被抽走）', async () => {
  const { deck, state } = setup();
  const load = async () => new ArrayBuffer(8);
  await prepare(deck, load, 'a');
  assert.equal(deck.begin('a', 0), true); // 手按在 a 上
  for (const key of ['b', 'c', 'd']) await prepare(deck, load, key);
  assert.equal(deck.prepared('a'), true, 'a 最久没用过，但正在搓：不丢');
});

test('缓存：内存总量超预算也淘汰（份数没超也一样）', async () => {
  const { deck, state } = setup({
    deps: { decode: async (bytes, rate) => virtualBuffer(rate, 240) }, // 每份 ≈ 42 MB
  });
  const load = async () => {
    state.loads++;
    return new ArrayBuffer(8);
  };
  await prepare(deck, load, 'a', 240);
  await prepare(deck, load, 'b', 240);
  await prepare(deck, load, 'c', 240); // 三份 ≈ 127 MB > 96 MB：淘汰最久没用过的
  assert.equal(deck.prepared('c'), true);
  assert.equal(deck.prepared('a'), false, 'a 被内存预算挤掉');
});

test('缓存：一份取料失败不影响别的份', async () => {
  const { deck, state } = setup();
  await prepare(deck, async () => new ArrayBuffer(8), 'a');
  await prepare(deck, async () => null, 'b'); // 失败：静默，不抛
  assert.equal(deck.prepared('a'), true, '已经好的那份不受影响');
  assert.equal(deck.prepared('b'), false);
  await prepare(deck, async () => new ArrayBuffer(8), 'b');
  assert.equal(deck.prepared('b'), true, '重试能进来');
});

test('释放：连缓存一起丢掉', async () => {
  const { deck } = setup();
  await prepare(deck, async () => new ArrayBuffer(8), 'a');
  await prepare(deck, async () => new ArrayBuffer(8), 'b');
  deck.dispose();
  assert.equal(deck.prepared('a'), false);
  assert.equal(deck.prepared('b'), false);
});
