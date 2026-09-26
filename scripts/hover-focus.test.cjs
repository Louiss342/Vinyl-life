// hover-only 棘轮（执行手册 T0.2）：凡是「靠悬停把东西显出来」的规则，必须有键盘等价
// （:focus-visible / :focus-within），否则键盘用户看不到被显出来的东西。
//
// 实测基线（2026-09-26，T0.2 落地当日）：规则块 585，hover 选择器 39，同块内已有焦点分支 11，
// 债务 27（去重后），其中「隐藏→显形」= 真卡键盘的只有 1 条：
//   .vinyl-marquee:hover .vinyl-marquee-text   （截断的专辑名只在悬停时松开）
// 它同时是独立审计认定的头号 hover 缺口 —— 两条互不相干的路径交叉验证了同一个点。
// 手册 §8.B 首次验证时是 37 / 9 / 28；此后 1.1.0–1.3.1 的界面改动让总量涨了、债务没涨。
//
// **2026-09-26 收口**：marquee 那条已真修（不再只是白名单兜着）—— 卡片拿到键盘焦点时同样
// 松开截断并滚动（shelf-view 的 focusin → measureMarqueesIn，配 CSS 的 :focus-visible 分支），
// 减少动效下改为换行展示。三处 marquee 规则都改成「hover 与 focus 同块」，该选择器随之离开
// 债务列表：实测 hover 选择器 39，同块已覆盖 14，债务 25（真卡键盘 0，白名单已清空）。
//
// 判定逻辑（两次修正后的版本，别退回旧写法）：
//  ① 显形属性集含 max-width 等 —— 只判 opacity/visibility 会漏掉 marquee；
//     但排除 transform / box-shadow —— 那是装饰性抬升，不是阻碍。
//  ② 按「声明块」判定覆盖，不按选择器签名逐个比对 —— 后者会误报分组选择器
//     （.seg-head:hover .seg-note 与 .seg-note:focus-visible 同块，键盘路径其实是通的）。
//     这个启发式成立的前提是本项目一贯的书写纪律（hover 与 focus 配对写进同块），
//     已被 11/39 的实测证实。
// 已知局限：扫描器不理解 @media 上下文，减少动效块里的规则也会被扫进来。
// 棘轮模式下无妨 —— 多列的债务条目不影响判定。
//
// 棘轮纪律：DEBT_BASELINE 只减不增。新写一条「悬停才显形」的规则时：
//   · 有键盘路径可走（按钮 / 可聚焦元素）→ 同块里配上 :focus-visible，债务不动；
//   · 确实只是装饰反馈（变色 / 抬升）→ 不必配焦点样式，但那要把基线 +1，
//     并在提交信息里写明是哪一条 —— review 时只看这一行数字有没有涨。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** 存量债务基线（去重后的 hover-only 选择器条数）：只能减不能加 */
const DEBT_BASELINE = 25;

// 已知的真卡键盘条目白名单：修掉一条就删一行。
// 2026-09-26 清空 —— 最后一条（marquee 的截断只靠悬停松开）已按上面的收口修掉。
// 它非空时有一条自检：白名单条目必须仍在债务列表里，修好了会红着提醒一起收基线。
const KNOWN_BLOCKERS = new Set([]);

const REVEAL = /(?:^|;)\s*(?:opacity|visibility|display|max-width|max-height|clip-path|pointer-events)\s*:/;

function parseRules(source) {
  const RULE = /([^{}]+)\{([^{}]*)\}/g;
  const rules = []; let m;
  while ((m = RULE.exec(source))) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith('@')) continue;
    rules.push({ parts: sel.split(',').map((s) => s.trim()).filter(Boolean), decls: m[2].trim() });
  }
  return rules;
}

function scan() {
  const rules = parseRules(css);
  const debt = [];
  let hoverTotal = 0, covered = 0;
  for (const r of rules) {
    const hovers = r.parts.filter((p) => /:hover\b/.test(p));
    if (!hovers.length) continue;
    const hasFocus = r.parts.some((p) => /:(?:focus-visible|focus-within|focus)\b/.test(p));
    hoverTotal += hovers.length;
    if (hasFocus) { covered += hovers.length; continue; }
    // 同一选择器可能出现在多个块里（含 @media），去重后再比较
    for (const h of hovers) if (!debt.includes(h)) debt.push(h);
  }
  const blockers = debt.filter((sel) => {
    const r = rules.find((x) => x.parts.includes(sel) && REVEAL.test(x.decls));
    return r && !KNOWN_BLOCKERS.has(sel);
  });
  return { rules, debt, blockers, hoverTotal, covered };
}

test('可访问性：hover 显形规则必须有焦点等价（棘轮）', () => {
  const { rules, debt, blockers, hoverTotal, covered } = scan();

  // 探针：全库 hover 规则应有相当数量。掉到个位数说明 CSS 解析失效了
  assert.ok(hoverTotal >= 20, `只扫到 ${hoverTotal} 条 hover 规则（共 ${rules.length} 个规则块），像是解析失效`);

  assert.deepEqual(
    blockers, [],
    `这些 hover 显形规则没有键盘等价，键盘用户看不到被显出来的东西：\n  ${blockers.join('\n  ')}`
  );
  console.log(`[hover] hover 选择器 ${hoverTotal}，同块已覆盖 ${covered}，债务 ${debt.length}（真卡键盘 ${blockers.length}，已知白名单 ${KNOWN_BLOCKERS.size}）`);
});

test('可访问性：hover 债务不得增长（棘轮，只减不增）', () => {
  const { debt } = scan();

  assert.ok(
    debt.length <= DEBT_BASELINE,
    `无焦点分支的 hover 债务涨到 ${debt.length}（基线 ${DEBT_BASELINE}）：\n` +
      `  ${debt.join('\n  ')}\n` +
      '新写的那条能配 :focus-visible 就配；确实只是装饰反馈，才把 DEBT_BASELINE 改成新数字（并在提交信息里点名）'
  );

  // 白名单与债务列表必须同步：修掉 marquee 那条时，这里会提醒把白名单与基线一起收下来
  for (const known of KNOWN_BLOCKERS) {
    assert.ok(
      debt.includes(known),
      `白名单里的「${known}」已经不在债务列表里了（修好了？）——删掉白名单那一行，并把 DEBT_BASELINE 减一`
    );
  }
});
