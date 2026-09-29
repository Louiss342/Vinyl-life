/**
 * 从 src/core/i18n.ts 生成 I18N.md：求值拿 DICT → 扫 src/ 与 server/ 里每个键的字面量
 * → 输出分组键表 + 未被引用的键 + 模板串构造的键。
 *
 *   node scripts/gen-i18n.cjs           重新生成
 *   node scripts/gen-i18n.cjs --check   只比对，不一致非零退出（CI 用）
 *
 * 路径相对脚本自身（上一级 = 插件根），任意工作目录都能跑。
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const outPath = path.join(root, 'I18N.md');
const args = process.argv.slice(2);
const check = args.includes('--check'); // --check：只比对，不写盘（CI 用）

// ---------- ① 求值拿 DICT ----------
const built = esbuild.buildSync({
  entryPoints: [path.join(root, 'src/core/i18n.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian'],
}).outputFiles[0].text;

const mod = { exports: {} };
const api = new Function('module', 'exports', 'require',
  built + '\nreturn module.exports;')(mod, mod.exports, () => ({}));

const DICT = api.DICT;
const keys = Object.keys(DICT);

// ---------- ② 扫字面量 ----------
const srcFiles = [];
for (const top of ['src', 'server']) {
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
      else if (/\.(ts|js)$/.test(e.name)) srcFiles.push(p);
    }
  })(path.join(root, top));
}

// 判据：该键是否以**任何**字符串字面量的形式出现。
// 这比逐个数调用点稳：t('k') / t(cond ? 'a' : 'b') / { walnut: 'k' } / titleKey: 'k'
// —— 四种形态无论落在哪个位置，都是字面量。
// 「使用处」列优先给 t()/tf() 调用点（人工研判用），没有则退回字面量所在文件并打 * 标记。
const usage = new Map();
for (const k of keys) usage.set(k, { files: new Set(), calls: new Set() });

const LITERAL = /'([a-zA-Z][\w.]*)'/g;
const CALL = /\b(?:t|tf)\(([^\n]*)/g;

for (const f of srcFiles) {
  const text = fs.readFileSync(f, 'utf8');
  const rel = path.relative(root, f).split(path.sep).join('/');
  if (rel === 'src/core/i18n.ts') continue;

  for (const m of text.matchAll(LITERAL)) {
    const k = m[1];
    if (usage.has(k)) usage.get(k).files.add(rel);
  }
  for (const call of text.matchAll(CALL)) {
    for (const lit of call[1].matchAll(LITERAL)) {
      const k = lit[1];
      if (usage.has(k)) usage.get(k).calls.add(rel);
    }
  }
}

// ---------- ③ 分组 ----------
const NS = [
  ['import.', '导入'],
  ['settings.', '设置页'],
  ['stats.', '统计'],
  ['player.', '播放器'],
  ['health.', '收藏健康检查'],
  ['notice.', '通知与提示'],
  ['shelf.', '专辑墙'],
  ['login.', '登录'],
  ['sort.', '排序'],
  ['props.', '卡片属性'],
  ['data.', '数据管理'],
  ['delete.', '删除'],
  ['batchDelete.', '批量删除'],
  ['batch.', '选择模式'],
  ['queueNote.', '队列笔记'],
  ['queue.', '队列'],
  ['link.', '音源关联'],
  ['cmd.', '命令'],
  ['display.', '陈列浮层'],
  ['cover.', '封面'],
  ['auth.', '鉴权与网关'],
  ['gateway.', '网关'],
  ['util.', '工具'],
  ['menu.', '右键菜单'],
  ['backup.', '备份与恢复'],
  ['filter.', '来源筛选'],
  ['common.', '通用'],
  ['lyrics.', '歌词'],
  ['toolbar.', '工具栏'],
  ['picker.', '唱片区'],
  ['edition.', '专辑版本'],
  ['rating.', '评分'],
  ['src.', '音源名'],
  ['more.', '更多菜单'],
  ['restore.', '恢复专辑'],
  ['note.', '听歌记录'],
  ['add.', '添加面板'],
  ['card.', '卡片'],
  ['empty.', '空态'],
  ['tutorial.', '空态教程'],
  ['about.', '关于页'],
  ['lang.', '语言'],
];

// 模板串构造的键家族：静态扫不到字面量，但确实是活的。
// 构建点只写「文件 + 可 grep 的调用表达式」，**不写行号** —— 这是生成物里的行号，源码一动就错，
// 而没有任何闸门能发现（--check 比的是「文档 vs 生成器」，不是「文档 vs 源码」）。
const DYNAMIC = [
  { pfx: 'health.scope.', site: 'views/library-health.ts —— t(`health.scope.${value}`)' },
  { pfx: 'health.', site: 'views/library-health.ts —— t(`health.${issue.kind}`)' },
  { pfx: 'player.playMode.', site: 'views/player-view.ts —— t(`player.playMode.${mode}`)（读数区 / 队列 / 设置三处）' },
  { pfx: 'player.mode', suffix: ['Album', 'List'], site: 'views/player-view.ts modeLabelKey() —— `player.mode${name}${scope}`' },
];
const dynamicSite = (k) => {
  for (const f of DYNAMIC) {
    if (k.startsWith(f.pfx) && (!f.suffix || f.suffix.some((s) => k.endsWith(s)))) return f.site;
  }
  return null;
};

const groups = new Map(NS.map(([p, l]) => [p, { label: l, items: [] }]));
const other = { label: '（无前缀）', items: [] };

for (const k of keys) {
  const u = usage.get(k);
  const calls = [...u.calls].sort();
  const entry = {
    k,
    zh: DICT[k].zh,
    en: DICT[k].en,
    sites: calls.length ? calls : [...u.files].sort(),
    literalOnly: calls.length === 0 && u.files.size > 0,
    dead: u.files.size === 0 && !dynamicSite(k),
    dynamic: u.files.size === 0 && !!dynamicSite(k),
  };
  const hit = NS.find(([p]) => k.startsWith(p));
  (hit ? groups.get(hit[0]).items : other.items).push(entry);
}

// ---------- ④ 生成 ----------
const esc = (s) => String(s == null ? '' : s).split('|').join('\\|').replace(/\n/g, ' ');
const code = (s) => '`' + esc(s) + '`';

const L = [];
L.push('# 国际化键参考 / i18n Key Reference');
L.push('');
L.push('> 由 `scripts/gen-i18n.cjs` 从 `src/core/i18n.ts` 生成，勿手改；改文案后重新生成。');
L.push('');

const allItems = [...groups.values()].flatMap((g) => g.items).concat(other.items);
const dead = allItems.filter((i) => i.dead);
const dyn = allItems.filter((i) => i.dynamic);
const litOnly = allItems.filter((i) => i.literalOnly);

L.push('## 速览');
L.push('');
L.push('| 项 | 值 |');
L.push('| --- | --- |');
L.push('| 键总数 | **' + keys.length + '** |');
L.push('| 语言 | `zh`（默认）· `en` |');
L.push('| 定义位置 | `src/core/i18n.ts` 的 `DICT` |');
L.push('| 查表函数 | `t(key)` · `tf(key, vars)` |');
L.push('| 回退链 | `DICT[key][当前语言]` → `DICT[key].zh` → `key` 本身 |');
L.push('| 未被引用的键 | ' + dead.length + '（见下） |');
L.push('| 模板串构造的键 | ' + dyn.length + '（见下） |');
L.push('| 表驱动（无直接调用点）的键 | ' + litOnly.length + ' |');
L.push('');
L.push('**写新文案的约定**');
L.push('');
L.push('- `t()` / `tf()` 必须在**渲染或事件发生时**求值，不能写进模块级常量——否则切换语言后文案不会变。');
L.push('- `zh === en` 的键会被 `scripts/i18n.test.cjs` 判为**漏翻**。中英同形的品牌名（如 `QQ`）不建键，由 `src/core/track.ts` 的 `sourceShortName()` 直接给字符串。');
L.push('- 占位符写作 `{name}`，由 `tf()` 替换；**缺键或缺变量时原样保留**（便于发现漏配）。');
L.push('- 键按命名空间前缀分组（`import.` / `settings.` / …），新增请沿用既有前缀。');
L.push('- 使用处单元格里的 `*` 表示该键只以字面量形式出现在数据表里（由表驱动求值），没有直接调用点——改键名时要连表一起改。');
L.push('');
L.push('## 分组索引');
L.push('');
L.push('| 前缀 | 含义 | 条数 |');
L.push('| --- | --- | --- |');
for (const [p, g] of groups) if (g.items.length) L.push('| `' + p + '` | ' + g.label + ' | ' + g.items.length + ' |');
if (other.items.length) L.push('| — | ' + other.label + ' | ' + other.items.length + ' |');
L.push('');

function emit(title, items) {
  if (!items.length) return;
  L.push('## ' + title);
  L.push('');
  L.push('| 键 | 中文 | English | 使用处 |');
  L.push('| --- | --- | --- | --- |');
  for (const it of items.sort((a, b) => a.k.localeCompare(b.k, 'en'))) {
    const shown = it.sites.slice(0, 3).map((f) => code(f)).join(' ');
    const more = it.sites.length > 3 ? ' +' + (it.sites.length - 3) : '';
    L.push('| ' + code(it.k) + ' | ' + esc(it.zh) + ' | ' + esc(it.en) + ' | '
      + (it.sites.length ? shown + more + (it.literalOnly ? ' *' : '') : '（无）') + ' |');
  }
  L.push('');
}

for (const [p, g] of groups) emit('`' + p + '` — ' + g.label, g.items);
emit(other.label, other.items);

L.push('## 未被引用的键');
L.push('');
L.push('以下键在 `src/` 与 `server/` 中**既没有直接调用点，也没有任何字符串字面量**，');
L.push('且不属于模板串构造的家族。它们很可能是**死键**（功能删改后未清理的残留）。');
L.push('删除前请先确认：全库再搜一次（含 `styles.css` 与文档），并跑一遍 `npm test`。');
L.push('');
if (dead.length) {
  L.push('| 键 | 中文 | English |');
  L.push('| --- | --- | --- |');
  for (const it of dead.sort((a, b) => a.k.localeCompare(b.k, 'en'))) {
    L.push('| ' + code(it.k) + ' | ' + esc(it.zh) + ' | ' + esc(it.en) + ' |');
  }
} else {
  L.push('（无）');
}
L.push('');

L.push('## 模板串构造的键');
L.push('');
L.push('以下键由**模板字符串**拼出，静态扫描抓不到字面量，但确有调用点。');
L.push('改这些键名时**必须同时改构建点**，否则运行时会静默回退成键名本身（界面上直接显示 `health.cover` 这样的原始键）。');
L.push('');
if (dyn.length) {
  L.push('| 键 | 中文 | 构建点 |');
  L.push('| --- | --- | --- |');
  for (const it of dyn.sort((a, b) => a.k.localeCompare(b.k, 'en'))) {
    L.push('| ' + code(it.k) + ' | ' + esc(it.zh) + ' | ' + esc(dynamicSite(it.k)) + ' |');
  }
} else {
  L.push('（无）');
}
L.push('');


const next = L.join('\n');

if (check) {
  const cur = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  if (cur !== next) {
    console.error('I18N.md 与 src/core/i18n.ts 不一致。');
    console.error('跑 `node scripts/gen-i18n.cjs` 重新生成后一并提交。');
    process.exit(1);
  }
  console.log('I18N.md 与 i18n.ts 一致（' + keys.length + ' 键）');
  process.exit(0);
}

fs.writeFileSync(outPath, next, 'utf8');
console.log('DICT 键数 =', keys.length);
console.log('未被引用 =', dead.length, '| 模板串构造 =', dyn.length, '| 表驱动字面量 =', litOnly.length);
console.log('写入', outPath);
if (dead.length) console.log('死键：', dead.map((d) => d.k).join(', '));
