// 依赖方向棘轮（执行手册 T0.1）：src/core 不得**新增**对 obsidian 的运行时依赖。
//
// 口径：沿 import 图传播运行时污点，但 `import type` 不传播 —— 类型边编译后消失，
// 只需要 .d.ts 垫片，不会把被导入文件的 obsidian 依赖带过来。
// 这条判断是有代价的：它让 arm-geometry / media-session（只从 player-state 取类型）
// 从越界名单里正确移出。只 grep `from 'obsidian'` 会得到 14 个直接依赖，
// 而真实运行时依赖图是 19 个 —— 另外 6 个是经 album-index / ../util / server-client 间接污染的。
//
// 棘轮纪律：BASELINE 是**存量债务基线，只能删不能加**。还清一个就从名单里删一行；
// 新增一行意味着「新写的 core 文件又依赖了 obsidian」——review 时只看这一点。
// 基线（2026-09-26 实测，T0.1 落地当日）：运行时越界 19 / 干净 23（core 共 42 个 .ts）。
// 与手册 §8.A 首次验证时的 19/18 相比：queue-note.ts 已还清（改走队列笔记的纯逻辑），
// probe-pacing.ts 是新债（经 ../util 传导）—— 名单换了成员，数量持平。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const CORE = path.join(root, 'src/core');

// 19 个运行时越界文件。6 个是间接污染（queue / shelf-sort / shelf-props / netease /
// library-health / probe-pacing），只看 import 语句会漏掉它们。
const BASELINE = new Set([
  'album-discovery.ts', 'album-index.ts', 'auth.ts', 'kugou-auth.ts', 'kugou.ts',
  'library-health.ts', 'local-source.ts', 'netease.ts', 'player-state.ts', 'probe-pacing.ts',
  'qq-auth.ts', 'qq.ts', 'queue.ts', 'server-client.ts', 'server-manager.ts',
  'shelf-props.ts', 'shelf-sort.ts', 'track.ts', 'web-client.ts',
]);

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^'"]*?from\s*)?['"]([^'"]+)['"]/g;

function resolve(spec, fromFile) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, base + '.ts', path.join(base, 'index.ts')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function parse(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = []; let m; IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src))) out.push({ typeOnly: !!m[1], spec: m[2] });
  return out;
}

/** 沿运行时 import 图找 obsidian；返回命中的文件（相对 root）或 null */
function findRuntimeObsidian(start) {
  const seen = new Set([start]); const q = [start];
  while (q.length) {
    const cur = q.shift();
    for (const imp of parse(cur)) {
      if (imp.spec === 'obsidian') { if (!imp.typeOnly) return path.relative(root, cur); continue; }
      if (imp.typeOnly) continue;                     // 类型边不传播运行时污点
      const next = resolve(imp.spec, cur);
      if (next && !seen.has(next)) { seen.add(next); q.push(next); }
    }
  }
  return null;
}

test('依赖方向：src/core 不得新增 obsidian 运行时依赖（棘轮）', () => {
  const files = fs.readdirSync(CORE).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  const offenders = [];
  for (const f of files) if (findRuntimeObsidian(path.join(CORE, f))) offenders.push(f);

  const added = offenders.filter((f) => !BASELINE.has(f));
  assert.deepEqual(added, [], `这些文件新引入了 obsidian 运行时依赖：${added.join(', ')}`);

  // 探针：基线文件应仍存在。全没了说明扫描失效，这条闸门就没意义了
  assert.ok(offenders.length >= 1, `一个越界文件都扫不到（core 共 ${files.length} 个），像是扫描失效`);
  console.log(`[deps] 运行时越界 ${offenders.length} / 干净 ${files.length - offenders.length}`);
});
