// 搓碟换算与指针接管回归：角度环绕、半径收手、倍速换算、松手回正，以及手势的起手阈值与收尾纪律。
// 盯住的坑：
//   ① 指针跨过 ±180° 边界（从 359° 划到 1°）算成 −358° —— 盘面会猛地倒甩一圈；
//   ② 贴着圆心拖动时 1px 能算出几十度 —— 指针抖一下就把唱片甩飞；
//   ③ 「点一下唱片」被当成搓碟 —— 音乐被按停，用户没想干这个。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  stdin: { contents: `export * from '../src/core/scratch';\n`, resolveDir: __dirname, loader: 'ts' },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
}).outputFiles[0].text;

const mod = { exports: {} };
vm.runInNewContext(source, { module: mod, exports: mod.exports, require: () => ({}), console });
const s = mod.exports;

const R = 50; // 唱片半径（px，测试台）
const CENTER = { x: 100, y: 100 };

test('角度：屏幕坐标（0 = 正右，顺时针为正），环绕折回 (−180, 180]', () => {
  assert.equal(s.angleOf(200, 100, 100, 100), 0, '正右 = 0°');
  assert.equal(s.angleOf(100, 200, 100, 100), 90, '正下 = 90°（y 向下）');
  assert.equal(s.angleOf(0, 100, 100, 100), 180, '正左 = 180°');
  assert.equal(s.wrapDeg(2), 2);
  assert.equal(s.wrapDeg(-2), -2);
  assert.equal(s.wrapDeg(358), -2, '359° → 1° 是 +2°，不是 −358°');
  assert.equal(s.wrapDeg(-358), 2);
  assert.equal(s.wrapDeg(180), 180);
  assert.equal(s.wrapDeg(-180), 180, '−180 与 +180 同一条缝：统一取 +180');
});

test('单帧转角：盘上正常拖动原样返回', () => {
  // 在半径 40px 处转过 10°：唱片也转 10°
  assert.equal(s.turnOf(10, 0, 40, R), 10);
  assert.equal(s.turnOf(-10, 0, R, R), -10);
});

test('单帧转角：贴着圆心按比例收手（别让 1px 甩飞唱片）', () => {
  const floor = s.SCRATCH_MIN_RADIUS_RATIO * R; // 12.5px
  assert.equal(s.turnOf(10, 0, floor, R), 10, '正好在收手线上：原样');
  assert.equal(s.turnOf(10, 0, floor / 2, R), 5, '半径一半 → 只转一半');
  assert.equal(s.turnOf(10, 0, 0, R), 0, '正圆心：这一帧不转（0 × 任何角）');
});

test('单帧转角：跨过圆心的跳变按废帧丢弃（不是转动，是指针换了半边）', () => {
  assert.equal(s.turnOf(179, 1, R, R), 0, '179° 的跳变丢弃');
  assert.equal(s.turnOf(-179, 1, R, R), 0);
  assert.equal(s.turnOf(120, 0, R, R), 120, '阈值本身仍然算');
  assert.equal(s.turnOf(121, 0, R, R), 0, '超过阈值丢弃');
});

test('倍速：正常转速 = 转一圈花 spinSeconds 秒', () => {
  assert.equal(s.rateOfTurn(360, 1800, 1.8), 1, '1.8s 转一圈 = 1 倍速');
  assert.equal(s.rateOfTurn(180, 1800, 1.8), 0.5);
  assert.equal(s.rateOfTurn(360, 900, 1.8), 2, '半秒一圈 = 2 倍速');
  assert.equal(s.rateOfTurn(-360, 1800, 1.8), -1, '反向为负');
  assert.equal(s.rateOfTurn(360, 0, 1.8), 0, 'dt 为 0 不猜');
  assert.equal(s.rateOfTurn(360, 1800, 0), 0, 'spinSeconds 为 0 不猜');
});

test('倍速钳制：±4，NaN → 0', () => {
  assert.equal(s.clampRate(3), 3);
  assert.equal(s.clampRate(9), s.SCRATCH_MAX_RATE);
  assert.equal(s.clampRate(-9), -s.SCRATCH_MAX_RATE);
  assert.equal(s.clampRate(NaN), 0);
  assert.equal(s.clampRate(Infinity), s.SCRATCH_MAX_RATE);
});

test('松手回正：指数逼近目标，dt 为 0 不动', () => {
  const a = s.approachRate(0, 1, 150, 150); // 一个时间常数
  assert.ok(a > 0.6 && a < 0.65, `一个 τ 应到 ~63%，实得 ${a}`);
  assert.equal(s.approachRate(0.5, 1, 0), 0.5, 'dt 为 0 不动');
  assert.ok(s.approachRate(0.5, 0, 100, 150) < 0.5, '目标 0 时往下走（暂停起手）');
  let rate = -2;
  for (let i = 0; i < 60; i++) rate = s.approachRate(rate, 1, 16);
  assert.ok(Math.abs(rate - 1) < 0.01, '一秒内基本回到 1 倍速（马达抓得住）');
});

test('累计器：事件喂转角、帧消费；倍速是平滑后的值', () => {
  const t = new s.ScratchTracker();
  t.add(10);
  t.add(5);
  const first = t.frame(100, 1.8); // 100ms 转 15°：原始倍速 = 15×1.8/(360×0.1) = 0.75
  assert.equal(first.turn, 15, '本帧转角 = 攒下的全部（视觉原样跟手）');
  assert.ok(first.rate > 0 && first.rate < 0.75, `平滑后应小于原始值，实得 ${first.rate}`);
  const second = t.frame(100, 1.8);
  assert.equal(second.turn, 0, '没有新转角：本帧为 0');
  assert.ok(second.rate < first.rate, '没有新转角：平滑值往 0 收（按住不放 = 停声）');
  t.reset();
  assert.equal(t.rate, 0);
  assert.equal(t.frame(16, 1.8).turn, 0);
});

test('累计器：空帧不让倍速乱跳（窗口切回来 / 长时间没动）', () => {
  const t = new s.ScratchTracker();
  t.add(90);
  const r = t.frame(5000, 1.8); // 5 秒才转 90°：原始倍速很小，且必须被钳在 ±4 之内
  assert.ok(Math.abs(r.rate) <= s.SCRATCH_MAX_RATE);
  assert.equal(t.frame(0, 1.8).rate, r.rate, 'dt=0 保持上一步');
});

// —— 指针接管：用一个记账用的假元素跑完整的按下 / 拖动 / 抬手 ——

function fakeHit() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    setPointerCapture() {},
    fire(type, ev) {
      for (const fn of listeners.get(type) || []) fn(ev);
    },
  };
}

function ev(x, y, over = {}) {
  return {
    pointerId: 7,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    ...over,
  };
}

/** 极坐标 → 视口坐标（角度按屏幕坐标：0 = 正右、顺时针为正） */
function at(deg, radius = R) {
  const rad = (deg * Math.PI) / 180;
  return { x: CENTER.x + Math.cos(rad) * radius, y: CENTER.y + Math.sin(rad) * radius };
}

function gesture(over = {}) {
  const hit = fakeHit();
  const log = { engage: 0, turns: [], ends: 0 };
  s.bindScratchGesture(hit, {
    geometry: () => ({ cx: CENTER.x, cy: CENTER.y, radius: R }),
    accept: () => (typeof over.accept === 'function' ? over.accept() : true),
    onEngage: () => log.engage++,
    onTurn: (t) => log.turns.push(t),
    onEnd: () => log.ends++,
    engageTurn: over.engageTurn,
  });
  return { hit, log };
}

test('手势：只点一下不算搓碟（按下不动就抬手 → 不 engage、不 end）', () => {
  const { hit, log } = gesture();
  const p = at(0);
  hit.fire('pointerdown', ev(p.x, p.y));
  hit.fire('pointerup', ev(p.x, p.y, { buttons: 0 }));
  assert.equal(log.engage, 0);
  assert.equal(log.ends, 0, '没转起来过：不该给视图收尾信号');
  assert.equal(log.turns.length, 0);
});

test('手势：转过阈值才 engage，且起手前攒下的那段一起上报（角度与手指严格对应）', () => {
  const { hit, log } = gesture();
  const a = at(0);
  const b = at(2);
  const c = at(6);
  hit.fire('pointerdown', ev(a.x, a.y));
  hit.fire('pointermove', ev(b.x, b.y));
  assert.equal(log.engage, 0, '2° 不够阈值（3°）');
  assert.equal(log.turns.length, 0);
  hit.fire('pointermove', ev(c.x, c.y));
  assert.equal(log.engage, 1, '6° 越过阈值');
  assert.equal(log.turns.length, 1);
  assert.ok(Math.abs(log.turns[0] - 6) < 1e-6, `攒下的 6° 要一起给出来，实得 ${log.turns[0]}`);
  hit.fire('pointermove', ev(at(10).x, at(10).y));
  assert.ok(Math.abs(log.turns[1] - 4) < 1e-6, '之后每次只报增量');
  hit.fire('pointerup', ev(at(10).x, at(10).y, { buttons: 0 }));
  assert.equal(log.ends, 1, '转起来过才给收尾信号');
});

test('手势：跨过 ±180° 边界只算 2°，不会倒甩一圈', () => {
  const { hit, log } = gesture();
  hit.fire('pointerdown', ev(at(0).x, at(0).y));
  hit.fire('pointermove', ev(at(-5).x, at(-5).y)); // 攒够阈值（−5°）
  log.turns.length = 0;
  hit.fire('pointermove', ev(at(179).x, at(179).y));
  hit.fire('pointermove', ev(at(-179).x, at(-179).y)); // 跨过 180° 缝：+2°
  const total = log.turns.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 2) < 1e-6, `跨缝应只算 +2°，实得 ${total}`);
});

test('手势：跨过圆心的指针跳变被丢弃（不产生一转）', () => {
  const { hit, log } = gesture();
  hit.fire('pointerdown', ev(at(0, 40).x, at(0, 40).y));
  hit.fire('pointermove', ev(at(5, 40).x, at(5, 40).y)); // 越过阈值
  log.turns.length = 0;
  // 从圆心右侧跳到左侧对称点：方位角突变 ~180°
  hit.fire('pointermove', ev(at(185, 40).x, at(185, 40).y));
  assert.equal(log.turns.length, 0, '跳变那一帧不报转角');
});

test('手势：不接受时完全不接管（不 preventDefault、后续移动无效）', () => {
  const { hit, log } = gesture({ accept: () => false });
  const down = ev(at(0).x, at(0).y);
  hit.fire('pointerdown', down);
  assert.equal(down.prevented, false, '不接管就别拦事件');
  hit.fire('pointermove', ev(at(20).x, at(20).y));
  assert.equal(log.engage, 0);
});

test('手势：右键 / 中键不接管；缺几何（视图藏着）也不接管', () => {
  const right = gesture();
  const p = at(0);
  right.hit.fire('pointerdown', ev(p.x, p.y, { button: 2 }));
  right.hit.fire('pointermove', ev(at(30).x, at(30).y));
  assert.equal(right.log.engage, 0);

  const hit = fakeHit();
  const log = { engage: 0 };
  s.bindScratchGesture(hit, {
    geometry: () => null,
    accept: () => true,
    onEngage: () => log.engage++,
    onTurn: () => {},
    onEnd: () => {},
  });
  hit.fire('pointerdown', ev(p.x, p.y));
  hit.fire('pointermove', ev(at(30).x, at(30).y));
  assert.equal(log.engage, 0);
});

test('手势：丢过抬手事件（buttons=0 的 move）与捕获丢失都收尾', () => {
  const a = gesture();
  a.hit.fire('pointerdown', ev(at(0).x, at(0).y));
  a.hit.fire('pointermove', ev(at(10).x, at(10).y));
  assert.equal(a.log.engage, 1);
  a.hit.fire('pointermove', ev(at(20).x, at(20).y, { buttons: 0 }));
  assert.equal(a.log.ends, 1, 'buttons 判定兜住了丢失的抬手');

  const b = gesture();
  b.hit.fire('pointerdown', ev(at(0).x, at(0).y));
  b.hit.fire('pointermove', ev(at(10).x, at(10).y));
  b.hit.fire('lostpointercapture', { pointerId: 7 });
  assert.equal(b.log.ends, 1, '捕获丢失也要收尾');
});
