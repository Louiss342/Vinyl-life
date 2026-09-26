// 马达斜坡的纯换算回归（core/motor）：暂停 = 断电滑停、复播 = 马达起转。
// 盯住的坑：
//   ① 斜坡必须短（「快速的减速停止」）：滑停 0.35s 级、起转 0.5s 级，且单调；
//   ② 「差多少补多少」：中途反向（滑到一半又按播放）要能就地接着走 —— 曲线只与此刻的转速
//      有关，与已经走了多久无关（否则反向那一刻转速会跳）；
//   ③ motorAdvance 必须真的是 ∫rate：它同时是「唱片转过的角」与「元素位置前进的量」，
//      两者共用一个积分才是同步的；
//   ④ 增益只由转速换算：地板处正好 0（与元素停声同一刻），满音量线以上是 1。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/core/motor.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
}).outputFiles[0].text;

const mod = { exports: {} };
vm.runInNewContext(source, { module: mod, exports: mod.exports, console });
const {
  MOTOR_FULL_RATE,
  MOTOR_MAX_MS,
  MOTOR_MIN_RATE,
  MOTOR_FADE_RATE,
  motorAdvance,
  motorDone,
  motorGain,
  motorRate,
} = mod.exports;

test('停机：转速按指数衰减，0.35 秒滑到地板（不是「按下去就没了」也不是拖沓）', () => {
  const at = (ms) => motorRate(1, ms, 'stopping');
  assert.equal(at(0), 1);
  assert.ok(at(100) < 0.5 && at(100) > 0.4, `100ms 时约 0.46（实得 ${at(100)}）`);
  assert.ok(at(200) < 0.25 && at(200) > 0.18, `200ms 时约 0.21（实得 ${at(200)}）`);
  // 滑到地板（元素停声线）的时间：τ·ln(1/floor) ≈ 0.35s —— 「快速」的那一档
  let t = 0;
  while (motorRate(1, t, 'stopping') > MOTOR_MIN_RATE && t < 2000) t += 1;
  assert.ok(t > 250 && t < 450, `滑停总时长 ${t}ms 应落在 0.3–0.4s 量级`);
  // 单调：反向验证「中途不会回升」（回升听着就是「抖了一下」）
  let prev = 1;
  for (let ms = 0; ms <= 400; ms += 10) {
    const r = motorRate(1, ms, 'stopping');
    assert.ok(r <= prev + 1e-12, `${ms}ms 处不该回升`);
    prev = r;
  }
});

test('起步：约 0.5 秒到满速，其中听得出来的一段（地板 → 满音量）约 0.25 秒', () => {
  const at = (ms) => motorRate(MOTOR_MIN_RATE, ms, 'starting');
  assert.ok(Math.abs(at(0) - MOTOR_MIN_RATE) < 1e-12, '起点就是给的转速（浮点，不写等号）');
  assert.ok(at(100) > 0.55 && at(100) < 0.7, `100ms 时约 0.63（实得 ${at(100)}）`);
  assert.ok(at(250) >= MOTOR_FADE_RATE, `250ms 该到满音量线（实得 ${at(250)}）`);
  assert.ok(at(500) >= MOTOR_FULL_RATE, `500ms 该到满速（实得 ${at(500)}）`);
  let prev = 0;
  for (let ms = 0; ms <= 600; ms += 10) {
    const r = motorRate(MOTOR_MIN_RATE, ms, 'starting');
    assert.ok(r >= prev - 1e-12, `${ms}ms 处不该回落`);
    prev = r;
  }
});

test('「差多少补多少」：中途反向的起点就是当时的转速，接着走与一路走完全等价', () => {
  const t1 = 137;
  for (const phase of ['stopping', 'starting']) {
    const from = phase === 'stopping' ? 1 : MOTOR_MIN_RATE;
    const mid = motorRate(from, t1, phase);
    const continued = motorRate(mid, 200, phase); // 从当时的转速再走 200ms
    const direct = motorRate(from, t1 + 200, phase); // 一路走 337ms
    assert.ok(
      Math.abs(continued - direct) < 1e-9,
      `${phase}：从 ${mid} 接着走应等于一路走完（${continued} vs ${direct}）`
    );
  }
});

test('motorAdvance 就是 ∫rate：位置前进量与盘面转角共用这一个积分', () => {
  for (const phase of ['stopping', 'starting']) {
    const from = phase === 'stopping' ? 1 : MOTOR_MIN_RATE;
    const total = 300;
    const dt = 0.05; // 矩形法：步长够小才谈得上「对拍」（误差随步长线性收敛）
    let sum = 0;
    for (let ms = 0; ms < total; ms += dt) sum += motorRate(from, ms, phase) * (dt / 1000);
    const exact = motorAdvance(from, total, phase);
    assert.ok(Math.abs(sum - exact) < 1e-4, `${phase}：数值积分 ${sum} 与闭式 ${exact} 应一致`);
  }
  // 起步期间转速低于 1，位置前进得比真实时间慢；滑停更是走不满一秒 —— 差值就是「停下来的那一段」
  assert.ok(motorAdvance(MOTOR_MIN_RATE, 1000, 'starting') < 1, '起步期间位置前进得比真实时间慢');
  assert.ok(motorAdvance(MOTOR_MIN_RATE, 1000, 'starting') > 0.85, '但慢得有限 —— 0.5 秒后就基本是原速');
  assert.ok(motorAdvance(1, 1000, 'stopping') < 0.2, '滑停总共只走过零点几秒的音频');
  assert.equal(motorAdvance(1, 0, 'stopping'), 0);
});

test('增益只由转速换算：地板处 0、满音量线以上 1、中间单调', () => {
  assert.equal(motorGain(MOTOR_MIN_RATE), 0, '转速到地板 = 静音（与元素停声同一刻）');
  assert.equal(motorGain(0), 0, '低于地板也是 0（不出现负增益）');
  assert.equal(motorGain(MOTOR_FADE_RATE), 1);
  assert.equal(motorGain(1), 1);
  assert.ok(motorGain(0.5) > 0.4 && motorGain(0.5) < 0.65, `半速约半音量（实得 ${motorGain(0.5)}）`);
  let prev = -1;
  for (let r = 0; r <= 1; r += 0.02) {
    const g = motorGain(r);
    assert.ok(g >= prev, `增益随转速单调（${r}）`);
    prev = g;
  }
});

test('终点：滑到地板 / 升到满速 / 超过最长时限，三种都算到头', () => {
  assert.equal(motorDone('stopping', MOTOR_MIN_RATE, 0), true);
  assert.equal(motorDone('stopping', MOTOR_MIN_RATE + 0.01, 100), false);
  assert.equal(motorDone('starting', MOTOR_FULL_RATE, 0), true);
  assert.equal(motorDone('starting', MOTOR_FULL_RATE - 0.01, 100), false);
  // 后台节流时的兜底：定时器迟到很久，那一次 tick 也要直接落在终点上
  assert.equal(motorDone('stopping', 0.5, MOTOR_MAX_MS), true);
  assert.equal(motorDone('starting', 0.5, MOTOR_MAX_MS), true);
});
