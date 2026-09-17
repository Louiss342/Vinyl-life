// i18n 回归：字典完整性（每条都有中英）+ 切换 + 缺键回退。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/core/i18n.ts')],
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
  require: () => ({}),
  console,
});
const i18n = mod.exports;

test('i18n：默认中文，切到 en 后取英文', () => {
  i18n.setLanguage(undefined);
  assert.equal(i18n.getLanguage(), 'zh', '默认中文');
  assert.equal(i18n.t('shelf.refresh'), '刷新');

  i18n.setLanguage('en');
  assert.equal(i18n.getLanguage(), 'en');
  assert.equal(i18n.t('shelf.refresh'), 'Refresh');
  assert.equal(i18n.t('menu.setCover'), 'Set cover…');

  i18n.setLanguage('zh');
  assert.equal(i18n.t('shelf.refresh'), '刷新', '切回来仍是中文');
});

test('i18n：未知语言回落中文，未知键回落 key 本身', () => {
  i18n.setLanguage('fr');
  assert.equal(i18n.getLanguage(), 'zh', '不认识的语言按中文处理');
  assert.equal(i18n.t('nope.missing'), 'nope.missing', '缺键返回 key（便于发现漏翻）');
  i18n.setLanguage('zh');
});

test('i18n：专辑墙用到的键在中英两套里都有且非空', () => {
  const keys = [
    'sort.title', 'sort.artist', 'sort.year', 'sort.plays', 'sort.rating',
    'sort.recent', 'sort.custom', 'sort.customLabel', 'sort.noProps',
    'sort.dir.oldNew', 'sort.dir.newOld', 'sort.dir.leastMost', 'sort.dir.mostLeast',
    'sort.dir.lowHigh', 'sort.dir.highLow', 'sort.dir.oldRecent', 'sort.dir.recentOld',
    'sort.dir.asc', 'sort.dir.desc',
    'filter.all', 'filter.local', 'filter.netease', 'filter.qq', 'filter.collect',
    'shelf.title', 'shelf.search', 'shelf.refresh', 'shelf.sort', 'shelf.filter',
    'shelf.props', 'shelf.importAlbum', 'shelf.importAudio',
    'shelf.expand', 'shelf.collapse', 'shelf.batchDelete',
    'shelf.empty.title', 'shelf.empty.hint', 'shelf.filtered.title', 'shelf.filtered.hint',
    'batch.selected', 'batch.selectAll', 'batch.clear', 'batch.delete', 'batch.exit',
    'batchDelete.title', 'batchDelete.summary', 'batchDelete.more', 'batchDelete.playingHint',
    'batchDelete.alsoAudio', 'batchDelete.alsoCover', 'batchDelete.coverShared',
    'menu.play', 'menu.openNote', 'menu.importAudio', 'menu.setCover',
    'menu.openNetease', 'menu.openQq', 'menu.deleteAlbum',
  ];
  for (const k of keys) {
    for (const lang of ['zh', 'en']) {
      i18n.setLanguage(lang);
      const v = i18n.t(k);
      assert.notEqual(v, k, `${lang} 缺少键 ${k}`);
      assert.ok(v.trim().length > 0, `${lang} 的 ${k} 是空串`);
    }
  }
  i18n.setLanguage('zh');
});

test('i18n：词典全量自检（中英齐备 / 非空 / 两种语言确实不同）', () => {
  const keys = Object.keys(i18n.DICT);
  assert.ok(keys.length >= 200, `词典条目太少（${keys.length}），像是没加载到`);
  for (const k of keys) {
    const entry = i18n.DICT[k];
    assert.ok(entry && typeof entry.zh === 'string' && typeof entry.en === 'string', `${k} 结构不对`);
    assert.ok(entry.zh.trim().length > 0, `${k} 缺中文`);
    assert.ok(entry.en.trim().length > 0, `${k} 缺英文`);
    // 中英逐字相同 = 多半是把中文抄进了 en（分隔符 / 品牌名这类也不该建键）
    assert.notEqual(entry.zh, entry.en, `${k} 的中英文案完全相同，疑似漏翻`);

    i18n.setLanguage('zh');
    assert.equal(i18n.t(k), entry.zh, `${k} 在 zh 下应取 zh`);
    i18n.setLanguage('en');
    assert.equal(i18n.t(k), entry.en, `${k} 在 en 下应取 en`);
  }
  i18n.setLanguage('zh');
});

test('i18n：源码里用到的每个 t()/tf() 键都在词典里（防拼错）', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) files.push(p);
    }
  };
  walk(path.join(__dirname, '../src'));
  assert.ok(files.length > 0, '没扫到源文件');

  const missing = [];
  let used = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /\btf?\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src))) {
      used++;
      if (!i18n.DICT[m[1]]) missing.push(`${path.relative(__dirname, f)} → ${m[1]}`);
    }
  }
  assert.ok(used > 150, `只扫到 ${used} 处 t()/tf() 调用，像是只覆盖了部分界面`);
  assert.deepEqual(missing, [], '源码里用到了词典里没有的键');
});

// 收集 src/ 下所有 .ts（新写的源码扫描测试共用）
function srcTsFiles(dir = path.join(__dirname, '../src'), out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) srcTsFiles(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

// ============ 词典反向自检：不留「没人引用」的死键 ============
// 背景：功能删了、文案还留在词典里（旧版「粘贴链接」流程、重复的 noteExists 等就是这么攒下来的）。
// 扫描范围含 scripts/ 自身：只在测试里按名字引用的键也算「有引用」，不会被误报。
// 例外只有动态拼接的键族：modeLabelKey 用 `player.mode${name}${scope}` 现拼，源码里没有整串字面量。
const DYNAMIC_KEY_PATTERNS = [/^player\.mode(Once|Loop|Shuffle)(Album|List)$/];
test('i18n：词典里没有无人引用的死键（动态拼接的键族除外）', () => {
  const scriptsDir = __dirname;
  const files = srcTsFiles().concat(
    fs
      .readdirSync(scriptsDir)
      .filter((n) => n.endsWith('.cjs'))
      .map((n) => path.join(scriptsDir, n))
  );
  const haystack = files
    .filter((f) => !f.endsWith(path.join('core', 'i18n.ts')))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');

  const dead = Object.keys(i18n.DICT).filter(
    (k) => !haystack.includes(k) && !DYNAMIC_KEY_PATTERNS.some((re) => re.test(k))
  );
  assert.ok(files.length > 0, '探针：没扫到源文件');
  assert.deepEqual(dead, [], '词典里存在无人引用的键：删掉，或加进 DYNAMIC_KEY_PATTERNS 并注明拼接处');
});

// ============ 提示气泡防护：同一元素不得同时设 aria-label 与 title ============
// 背景：Obsidian 会按 aria-label 渲染自己那套样式化提示，浏览器又会为 title 弹原生提示；
// 同一元素上两个属性并存 ⇒ 悬停时弹两个气泡。
// 启发式（纯源码扫描，不执行 DOM）：
//   ① 行邻域内同一个接收者既 setAttribute('aria-label', X) 又 setAttribute('title', X)（文案相同才判失败）；
//   ② 同一个 attr: { … } 对象字面量里同时出现 aria-label 与 title 键（同一元素，必然双提示；这条是确定的）。
// 局限：启发式不是语义分析——把 aria-label 与 title 拆到相隔很远的两个函数里、或同一文案写成不同
//   表达式（如 t('k') 与 tf('k', {})）时可能漏检；同理，接收者重名（两个作用域里都叫 b）在窗口内可能误报，
//   但误报只会让人肉核对一眼，不会放过真问题。
// 反向见下一条测试：title 现在是全面禁止的（祖先的 title 会被浏览器继承到子元素上，启发式抓不到）。
// ============ 提示气泡：视图层不得再出现 title 属性 ============
// 背景：宿主按 aria-label 画样式化气泡，浏览器又会为 title 弹一个原生气泡 —— 而且 title 会被
// *继承*：只要祖先带 title，悬停它内部任何元素都会再冒一个（「写感想」按钮压在段头 title 上时
// 就是两个气泡）。启发式查不出这种跨元素的继承，所以这里直接禁掉 title：提示一律走 aria-label。
test('源码防护：视图层不出现 title 属性（提示统一走 aria-label）', () => {
  const hits = [];
  for (const f of srcTsFiles()) {
    const rel = path.relative(__dirname, f);
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/setAttribute\(\s*['"]title['"]/.test(line)) hits.push(`${rel}:${i + 1} setAttribute('title')`);
      const at = line.indexOf('attr: {');
      if (at < 0) return;
      // attr 对象可能跨行：从 attr: { 起数花括号，走到配对的 } 为止，只在这个切片里找 title 键
      let depth = 0;
      for (let j = i; j < lines.length; j++) {
        // 首行从 attr: { 处切起（前面可能还有别的键，别误判）；之后每行整行扫
        const text = j === i ? lines[j].slice(at) : lines[j];
        for (const ch of text) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
        if (/\btitle\s*:/.test(text)) hits.push(`${rel}:${j + 1} attr.title`);
        if (depth <= 0) break;
      }
    });
  }
  assert.deepEqual(hits, [], '提示改走 aria-label：title 会和宿主气泡叠成两个，还会被后代继承');
});

test('源码防护：同一元素不得同时设 aria-label 与 title（否则弹两个提示气泡）', () => {
  const files = srcTsFiles();
  assert.ok(files.length > 0, '没扫到源文件');

  const WINDOW = 5; // 行邻域：成对写法通常紧挨着，bindLabel 里最多隔一两行
  const norm = (s) => s.replace(/\s+/g, ''); // 抹掉空白再比，写法差异不该放过同文案
  const ariaRe = /(\w+)\.setAttribute\(\s*['"]aria-label['"]\s*,\s*([^;]+?)\s*\)\s*;/;
  const titleRe = /(\w+)\.setAttribute\(\s*['"]title['"]\s*,\s*([^;]+?)\s*\)\s*;/;
  const problems = [];
  let ariaSeen = 0;

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(__dirname, f);
    const lines = src.split(/\r?\n/);

    lines.forEach((line, i) => {
      const a = ariaRe.exec(line);
      if (!a) return;
      ariaSeen++;
      for (let j = Math.max(0, i - WINDOW); j <= Math.min(lines.length - 1, i + WINDOW); j++) {
        if (j === i) continue;
        const tt = titleRe.exec(lines[j]);
        if (tt && tt[1] === a[1] && norm(tt[2]) === norm(a[2])) {
          problems.push(
            `${rel}:${j + 1} → ${tt[1]}.setAttribute('title', ${tt[2]}) 与第 ${i + 1} 行的 aria-label 同文案重复`
          );
        }
      }
    });

    // attr: { … }：两个键同处一个对象 = 同一元素必然双提示（无启发式成分）
    const objRe = /attr:\s*\{([^}]*)\}/g;
    let om;
    while ((om = objRe.exec(src))) {
      if (/['"]?aria-label['"]?\s*:/.test(om[1]) && /['"]?title['"]?\s*:/.test(om[1])) {
        const line = src.slice(0, om.index).split(/\r?\n/).length;
        problems.push(`${rel}:${line} → attr 对象里同时设了 aria-label 与 title`);
      }
    }
  }

  // 探针：扫描逻辑或正则一旦失效（比如源码改用别的写法），这里会先响
  assert.ok(ariaSeen >= 6, `只扫到 ${ariaSeen} 处 aria-label 赋值，扫描逻辑可能已失效`);
  assert.deepEqual(problems, [], '同一元素别同时设 aria-label 与 title：Obsidian 提示 + 浏览器原生提示会叠成两个气泡');
});

test('i18n：tf() 占位符替换（缺变量 / 缺键时原样保留，不吞信息）', () => {
  i18n.setLanguage('zh');
  assert.equal(
    i18n.tf('import.importingProgress', { i: 2, n: 5, name: 'Abbey Road' }),
    '正在导入 2/5：Abbey Road…'
  );
  assert.equal(i18n.tf('import.candidateRow', { name: 'A', n: 3 }), 'A（3 个音频）');
  assert.equal(i18n.tf('import.candidateRow', { name: 'A' }), 'A（{n} 个音频）', '缺变量保留占位符');
  assert.equal(i18n.tf('nope.missing', { n: 1 }), 'nope.missing', '缺键回落 key');

  i18n.setLanguage('en');
  assert.equal(
    i18n.tf('import.importingProgress', { i: 2, n: 5, name: 'Abbey Road' }),
    'Importing 2/5: Abbey Road…'
  );
  assert.equal(
    i18n.tf('import.qqDone', {
      name: 'Unfinished',
      artist: 'Stefanie Sun',
      year: ', 2002',
      tracks: ', 11 track(s)',
    }),
    'Imported "Unfinished" (Stefanie Sun, 2002, 11 track(s))'
  );
  i18n.setLanguage('zh');
});

test('i18n：「插入此刻正在听」的行文案按语言逐字拼装（占位符两边都要替换）', () => {
  i18n.setLanguage('zh');
  assert.equal(
    i18n.tf('notice.nowPlayingLine', { album: '黑豹乐队', track: '无地自容' }),
    '此刻正在听《黑豹乐队》的《无地自容》'
  );

  i18n.setLanguage('en');
  const en = i18n.tf('notice.nowPlayingLine', { album: 'Black Panther', track: 'No Place to Hide' });
  assert.ok(en.trim().length > 0, 'en 文案非空');
  assert.equal(en.includes('{'), false, 'en 的占位符也要被替换掉');
  assert.notEqual(en, '此刻正在听《Black Panther》的《No Place to Hide》', 'en 不能回落到中文模板');
  i18n.setLanguage('zh');
});

test('i18n：语言切换后新建的登录 provider 文案跟着变（不能被模块加载时定型）', () => {
  const providers = esbuild.buildSync({
    stdin: {
      // setLanguage 从这里取：bundle 里的 i18n 是独立实例，改外层实例对它无效
      contents: `export * from '../src/views/qr-login-modal';\nexport { setLanguage } from '../src/core/i18n';\n`,
      resolveDir: __dirname,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text;

  const mod = { exports: {} };
  vm.runInNewContext(providers, {
    module: mod,
    exports: mod.exports,
    require: (name) => (name === 'obsidian' ? { Modal: class {}, TFile: class {} } : require(name)),
    window: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
    Buffer,
    AbortController,
    console,
  });

  mod.exports.setLanguage('zh');
  assert.equal(mod.exports.qqQrProvider().title, 'QQ 音乐登录');
  assert.equal(mod.exports.qqQrProvider().tempPng, 'qr-login-tmp-qq.png', '非文案字段不受语言影响');

  mod.exports.setLanguage('en');
  assert.equal(mod.exports.qqQrProvider().title, 'QQ Music sign-in');
  assert.equal(mod.exports.qqQrProvider().appHint.includes('QQ Connect QR code'), true);

  mod.exports.setLanguage('zh');
  assert.equal(mod.exports.qqQrProvider().title, 'QQ 音乐登录', '切回中文仍是原文案');
});

// ============ 播放器视图：源码防护 + 切语言后就地更新 ============

// 提取源码里的字符串字面量内容（跳过注释与正则），用于「不得硬编码中文」的断言。
// 正则字面量必须跳过：sanitizeFileName 里就有含引号的正则（/[\\/:*?"<>|#^[\]]/g），
// 不跳过的话扫描器会从那个引号一路吃到下一个引号，把中间的中文注释当成「字符串」误报。
// 正则判定是启发式：/ 出现在这些记号之后才算正则（赋值 / 括号 / 逗号 / 冒号 / return 等），
// 否则算除法。漏判的代价是误报（能人工核对），误判正则的代价是漏检 —— 所以宁可宽松。
function isRegexStart(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true; // 文件开头
  const prev = src[j];
  if ('=(,:[!&|?{};+*-'.includes(prev)) return true;
  // return / typeof / case 等关键字后也是正则
  const kw = /(^|[^\w$])(return|typeof|case|in|of|new|delete|void|instanceof)$/.exec(
    src.slice(Math.max(0, j - 12), j + 1)
  );
  return !!kw;
}

function stringLiterals(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '/' && isRegexStart(src, i)) {
      // 跳过整个正则字面量（含转义字符与字符类里的 /）
      i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        else if (src[i] === '\n') break; // 非法正则（或启发式判错）：别一路吞下去
        i++;
      }
      i++;
      // 跳过 flags
      while (i < n && /[a-z]/.test(src[i])) i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let v = '';
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          v += src[i + 1];
          i += 2;
          continue;
        }
        v += src[i];
        i++;
      }
      i++;
      out.push(v);
      continue;
    }
    i++;
  }
  return out;
}

// 例外清单（每一条都要有理由，别往里塞用户可见文案）：
//   src/core/i18n.ts      —— 词典本体
//   src/core/about.ts     —— 作者手记（原文常量，刻意不翻译；README 也逐字校验它）
//   `[vinyl] …`           —— 控制台日志：给开发者看的，不进界面（约定带这个前缀）
//   `…/专辑笔记模板.md`    —— 模板文件的**路径**，不是文案：固定路径才不会让老用户的模板失联
const CJK_ALLOWED_FILES = ['src/core/i18n.ts', 'src/core/about.ts'];
const CJK_ALLOWED_LITERALS = [/^\[vinyl\]/, /模板\/专辑笔记模板\.md$/];

test('i18n：除例外清单外，源码里的字符串字面量不得含中文（用户可见文案必须走 t()/tf()）', () => {
  const root = path.join(__dirname, '..');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) files.push(p);
    }
  })(path.join(root, 'src'));

  const problems = [];
  let seen = 0;
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (CJK_ALLOWED_FILES.includes(rel)) continue;
    for (const lit of stringLiterals(fs.readFileSync(f, 'utf8'))) {
      if (!/[一-鿿]/.test(lit)) continue;
      seen++;
      if (CJK_ALLOWED_LITERALS.some((re) => re.test(lit))) continue;
      problems.push(`${rel} → ${JSON.stringify(lit.slice(0, 40))}`);
    }
  }
  // 探针：扫描逻辑失效时（例如源码风格变了导致解析不出字面量）要红，而不是静默通过
  assert.ok(seen >= 8, `只扫到 ${seen} 处中文字面量，像是扫描逻辑失效了`);
  assert.deepEqual(problems, [], '这些文案要么走 t()/tf()，要么加进 CJK_ALLOWED_* 例外清单（附理由）');
});

test('i18n：refreshLanguage 会把已打开的播放器也接上（applyLanguage）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  // 只做接线断言：行为由下面「切语言后就地更新」的用例覆盖（main.ts 需要整个 Obsidian App 才能驱动）
  assert.match(src, /getLeavesOfType\(PLAYER_VIEW_TYPE\)[\s\S]{0,200}?applyLanguage\(\)/);
});

// —— 假 DOM：只实现播放器壳与队列用到的那部分成员 ——
function fakeEl(tag = 'div') {
  const vars = new Map();
  const el = {
    tag,
    children: [],
    attrs: new Map(),
    classes: new Set(),
    dataset: {},
    textContent: '',
    style: { display: '', setProperty: (k, v) => vars.set(k, v) },
    vars,
    empty() {
      el.children = [];
    },
    addClass(...names) {
      for (const n of String(names.join(' ')).split(/\s+/).filter(Boolean)) el.classes.add(n);
    },
    removeClass(...names) {
      for (const n of String(names.join(' ')).split(/\s+/).filter(Boolean)) el.classes.delete(n);
    },
    toggleClass(name, on) {
      const want = on === undefined ? !el.classes.has(name) : !!on;
      if (want) el.classes.add(name);
      else el.classes.delete(name);
    },
    setAttribute(k, v) {
      el.attrs.set(k, String(v));
    },
    getAttribute(k) {
      return el.attrs.has(k) ? el.attrs.get(k) : null;
    },
    addEventListener() {},
    setText(t) {
      el.textContent = String(t); // Obsidian 的 DOM 扩展：面板的分区图标回落会用到
      return el;
    },
    createDiv(o) {
      return el.createEl('div', o);
    },
    createSpan(o) {
      return el.createEl('span', o);
    },
    createEl(t, o) {
      const child = fakeEl(typeof t === 'string' ? t : 'div');
      el.children.push(child);
      const opts = typeof o === 'string' ? { cls: o } : o || {};
      if (opts.cls) child.addClass(opts.cls);
      if (opts.text != null) child.textContent = String(opts.text);
      if (opts.href) child.setAttribute('href', opts.href); // createEl('a', { href }) 落到属性上
      if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) child.setAttribute(k, v);
      return child;
    },
    getAnimations: () => [],
    animate: () => ({}),
    closest: () => null,
    // S 型臂管（player-view 的 buildArmTube）要往臂盒子里挂子节点：补齐与 arm-posture.test.cjs 同款的一面
    appendChild(child) {
      el.children.push(child);
      return child;
    },
  };
  el.classList = {
    toggle: (n, on) => el.toggleClass(n, on),
    add: (...n) => el.addClass(...n),
    remove: (...n) => el.removeClass(...n),
  };
  return el;
}

function collect(el, out = []) {
  out.push(el);
  for (const c of el.children) collect(c, out);
  return out;
}

let playerBundle = null;
function playerModule() {
  if (playerBundle) return playerBundle;
  const src = esbuild.buildSync({
    stdin: {
      // setLanguage 从 bundle 内部取：外层 i18n 实例与 bundle 里的不是同一个
      contents: `export * from '../src/views/player-view';\nexport { setLanguage, t } from '../src/core/i18n';\n`,
      resolveDir: __dirname,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text;
  class ItemView {
    constructor() {
      this.contentEl = fakeEl();
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(src, {
    module,
    exports: module.exports,
    require: (name) => {
      if (name === 'obsidian') {
        return {
          App: class {},
          ItemView,
          Menu: class {},
          Modal: class {},
          FuzzySuggestModal: class {},
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
    // 臂管是内联 SVG：真机经 document.createElementNS 建（见 player-view 的 svgEl）
    document: { createElementNS: (_ns, tag) => fakeEl(tag) },
  });
  playerBundle = module.exports;
  return playerBundle;
}

// 引擎快照最小面（播放器只读这些字段）。
// segments 必须与 queue 自洽：播放器按段渲染队列，段数/长度对不上就会画错行。
function snap(over = {}) {
  const queue = over.queue || [];
  const segments =
    over.segments ||
    (queue.length
      ? [{ albumPath: 'a.md', albumTitle: 'A', start: 0, count: queue.length, current: true }]
      : []);
  return {
    status: 'idle',
    queue,
    segments,
    index: -1,
    currentTime: 0,
    duration: 0,
    volume: 0.8,
    albumNotePath: null,
    albumTitle: '',
    sourceLabel: '',
    ...over,
  };
}

function makePlayerView(mod, engine) {
  const view = new mod.VinylPlayerView({}, { settings: {}, engine });
  const root = fakeEl();
  view.contentEl = root;
  return { view, root };
}

test('播放器：切语言后 applyLanguage 就地更新按钮提示与头部（不重建 DOM）', () => {
  const mod = playerModule();
  mod.setLanguage('zh');
  const { view, root } = makePlayerView(mod);
  const queue = [{ source: 'local-vault', path: 'a.mp3', title: 'A', duration: 65 }];
  // 取碟中（读数区已撤掉，这里只要求不炸、且播放键提示在位）
  view.update(snap({ queue, index: 0, status: 'loading' }));
  const all = collect(root);
  const hasLabel = (v) => all.some((e) => e.getAttribute('aria-label') === v);
  const hasText = (v) => all.some((e) => e.textContent === v);

  // 提示只走 aria-label（Obsidian 的原生样式化提示）；再设 title 会叠出第二个浏览器原生气泡
  const noteBtn = all.find((e) => e.getAttribute('aria-label') === '给「A」写点什么吧:)');
  assert.ok(noteBtn, '「写点什么吧」的提示应为中文（在专辑名那一栏的最后）');
  assert.equal(noteBtn.getAttribute('title'), null, '追加感想钮不得再设 title');
  assert.ok(hasLabel('选取专辑'), '「选取专辑」钮（翻到页面 2）');
  assert.ok(hasLabel('播放 / 暂停'), '唱盘上的播放键提示（⏮ ⏭ 已按设计稿删除）');
  assert.ok(hasLabel('单次播放整张专辑'), '播放模式钮提示就是当前模式名（不再缀「点击切换」）');
  assert.equal(hasText('♪ 正在取碟…'), false, '唱盘上的读数区已按用户要求撤掉（不再有取碟中文案）');

  const vinylBefore = view.els.vinyl;
  const playBtnBefore = view.els.deckPlayBtn;
  const pickBefore = view.els.pickBtn;
  mod.setLanguage('en');
  view.applyLanguage();

  assert.ok(hasLabel('Pick an album'), '选取专辑 → Pick an album');
  assert.ok(hasLabel('Play / pause'), '播放键提示跟着语言换');
  assert.ok(hasLabel('Play the album once'), '模式钮提示跟着语言换');
  assert.equal(noteBtn.getAttribute('aria-label'), 'Write something for “A” :)');
  assert.equal(noteBtn.getAttribute('title'), null, '切语言也不该多出 title');
  assert.equal(view.els.vinyl, vinylBefore, '就地改文案：转盘节点没被换掉（旋转动画不被打断）');
  assert.equal(view.els.deckPlayBtn, playBtnBefore, '壳只建一次：节点身份不变');
  assert.equal(view.els.pickBtn, pickBefore, '头部宽键也是原地改文案，不重建节点');

  mod.setLanguage('zh');
  view.applyLanguage();
  assert.equal(noteBtn.getAttribute('aria-label'), '给「A」写点什么吧:)', '切回中文仍是原文案');
});

test('播放器：空队列时不给「写点什么」（没有专辑名那一栏可挂）', () => {
  const mod = playerModule();
  mod.setLanguage('zh');
  const { view, root } = makePlayerView(mod);
  view.update(snap());
  const all = collect(root);
  assert.ok(all.some((e) => e.textContent === '空队列'), '空队列提示照旧');
  assert.equal(
    all.some((e) => String(e.getAttribute('aria-label') || '').includes('写点什么')),
    false,
    '列表里没有专辑就不该出现这个按键'
  );
});

test('播放器：队列行的拖拽提示随语言就更新（不重建队列行）', () => {
  const mod = playerModule();
  mod.setLanguage('zh');
  const { view } = makePlayerView(mod);
  const queue = [{ source: 'local-vault', path: 'a.mp3', title: 'A', duration: 65 }];
  view.update(snap({ queue, index: 0, status: 'paused' }));
  const row = view.queueRows[0];
  const idx = view.queueIdxs[0];
  assert.ok(row && idx, '队列行与序号格已建');
  // 提示只走 aria-label：行报曲名、序号格报拖拽 —— 同一元素只留一个提示来源
  // （浏览器会把祖先的 title 继承到子元素上，行上再挂 title 就会和宿主气泡叠成两个）
  assert.equal(idx.getAttribute('aria-label'), '拖拽调整顺序');
  assert.equal(row.getAttribute('title'), null, '行上不得再有 title');

  mod.setLanguage('en');
  view.applyLanguage();
  assert.equal(idx.getAttribute('aria-label'), 'Drag to reorder');
  assert.equal(view.queueIdxs[0], idx, '就地改属性：序号格没被重建');
  assert.equal(view.queueRows[0], row, '就地改属性：队列行没被重建');
  assert.equal(row.getAttribute('draggable'), 'true', '非文案属性不受影响');

  mod.setLanguage('zh');
  view.applyLanguage();
  assert.equal(idx.getAttribute('aria-label'), '拖拽调整顺序');
});

test('播放器：切语言后队列的来源角标按新语言重算（不重建节点）', () => {
  const mod = playerModule();
  mod.setLanguage('zh');
  const queue = [
    { source: 'netease', id: 1, duration: 100, title: 'A' },
    { source: 'local-vault', file: { path: 'a.mp3' }, title: 'B', duration: 65 },
  ];
  // 桩引擎：来源文案在 snapshot() 调用时才求值（与线上同语义——引擎存原始来源，快照现算文案）
  const engine = {
    snapshot: () =>
      snap({
        queue,
        index: 0,
        status: 'paused',
        sourceLabel: mod.t('src.netease'),
        quality: 'higher',
      }),
  };
  const { view } = makePlayerView(mod, engine);
  view.update(engine.snapshot());
  assert.equal(view.queueBadges[0].textContent, '网易云');
  assert.equal(view.queueBadges[1].textContent, '本地');

  const badge = view.queueBadges[0];
  mod.setLanguage('en');
  view.applyLanguage();
  assert.equal(badge.textContent, 'NetEase', '队列角标就地改文本');
  assert.equal(view.queueBadges[0], badge, '角标节点没被重建');

  mod.setLanguage('zh');
  view.applyLanguage();
  assert.equal(badge.textContent, '网易云', '切回中文复原');
});

// ============ 命令面板瘦身 + 插入此刻正在听（驱动 main.ts 真实代码） ============
// main.ts 的 onload / insertNowPlaying 需要整个 Obsidian App 才能跑，这里按「用到什么补什么」搭桩：
// Plugin 基类只给 app / manifest，vault 只给 adapter.getBasePath 与建目录，Audio 只给 addEventListener
// （PlaybackEngine 构造时挂监听），workspace 只给 getActiveViewOfType（假编辑器）。
// 够驱动命令注册与插入这两条路径，但**不是**完整 App 模拟：不覆盖视图渲染、真实 vault 与设置面板。
let mainBundle = null;
function mainModule() {
  if (mainBundle) return mainBundle;
  const src = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '../src/main.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian', 'electron', '@electron/remote'],
  }).outputFiles[0].text;

  class Plugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
    }
  }
  class MarkdownView {}
  const mod2 = { exports: {} };
  vm.runInNewContext(src, {
    module: mod2,
    exports: mod2.exports,
    require: (name) => {
      if (name === 'obsidian') {
        return {
          App: class {},
          ItemView: class {},
          MarkdownView,
          Modal: class {},
          Notice: class {},
          Plugin,
          PluginSettingTab: class {},
          SettingPage: class {},
          Setting: class {},
          TFile: class {},
          TFolder: class {},
          FuzzySuggestModal: class {},
          normalizePath: (p) => p,
          setIcon: () => {},
        };
      }
      return require(name);
    },
    console,
    Buffer,
    process,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    window: { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} },
    document: { createElement: () => ({ style: {} }) },
    Audio: class { addEventListener() {} },
  });
  mainBundle = mod2.exports;
  return mainBundle;
}

/** 造一个插件实例：命令进 plugin.commands，loadData 返回给定 data（模拟 data.json） */
function makePlugin({ view = null, data = {}, snapshot = null } = {}) {
  const VinylLifePlugin = mainModule().default;
  const app = {
    vault: {
      adapter: { getBasePath: () => process.cwd() },
      getAbstractFileByPath: () => null,
      createFolder: async () => {},
    },
    workspace: {
      getLeavesOfType: () => [],
      getActiveViewOfType: () => view,
    },
  };
  const plugin = new VinylLifePlugin(app, { id: 'vinyl-life', dir: 'plugins/vinyl-life' });
  plugin.commands = [];
  plugin.addCommand = (c) => {
    plugin.commands.push(c);
    return c;
  };
  plugin.registerView = () => {};
  plugin.addRibbonIcon = () => {};
  plugin.addSettingTab = () => {};
  plugin.register = () => {};
  plugin.loadData = async () => data;
  plugin.saveData = async () => {};
  if (snapshot) plugin.engine = { snapshot };
  return plugin;
}

// 日常常驻的 8 条（id 不能改：改了已绑定的快捷键就失效）
const KEPT_COMMANDS = [
  'open-shelf',
  'open-player',
  'import-netease',
  'import-local',
  'insert-now-playing',
  // 播放控制（1.0.6 起常驻）：给快捷键与系统媒体键之外的手动操作用
  'player-toggle',
  'player-next',
  'player-prev',
];
test('main：命令面板 — 默认恰好注册那 8 条日常命令（一条不多一条不少）', async () => {
  const plugin = makePlugin();
  await plugin.onload();
  assert.deepEqual(
    plugin.commands.map((c) => c.id),
    KEPT_COMMANDS,
    '非 debug 时命令列表应当恰好是这 8 条（多一条都算没裁干净）'
  );
});

test('main：旧数据里的 debugCommands 已废弃，不再注册登录 / 退出命令', async () => {
  const plugin = makePlugin({ data: { debugCommands: true } });
  await plugin.onload();
  assert.deepEqual(plugin.commands.map((c) => c.id), KEPT_COMMANDS);
  assert.equal('debugCommands' in plugin.settings, false, '废弃字段不应进入归一化后的设置');
});

test('main：专辑队列模式同样只认布尔 true（脏 data.json 一律当关）', async () => {
  for (const [raw, want] of [[true, true], ['true', false], [1, false], [undefined, false]]) {
    const plugin = makePlugin({ data: raw === undefined ? {} : { queueMode: raw } });
    await plugin.onload();
    assert.equal(plugin.settings.queueMode, want, `queueMode=${String(raw)} → ${want}`);
  }
});

// —— 插入此刻正在听：假编辑器收集插入内容 + 假 engine.snapshot（含 albumNotePath）——
function insertedLine(over = {}) {
  const lines = [];
  const plugin = makePlugin({
    view: { editor: { replaceSelection: (s) => lines.push(s) } },
    snapshot: () => ({
      current: { source: 'local-vault', path: 'a.flac', title: over.track ?? '无地自容' },
      albumNotePath: over.albumNotePath,
      albumTitle: over.albumTitle ?? '',
    }),
  });
  plugin.insertNowPlaying();
  assert.equal(lines.length, 1, '应当且只插入一次');
  return lines[0];
}

test('main：insertNowPlaying — 专辑名做成 [[路径|专辑名]]，曲名保持纯文本', () => {
  const line = insertedLine({
    albumNotePath: 'Vinyl Life/Vinyl Note/黑豹乐队.md',
    albumTitle: '黑豹乐队',
  });
  assert.equal(
    line,
    '此刻正在听《[[Vinyl Life/Vinyl Note/黑豹乐队.md|黑豹乐队]]》的《无地自容》\n',
    '专辑名走带别名的 wikilink（源码模式不至于太长，阅读时显示专辑名）'
  );
  assert.equal(line.includes('[[无地自容'), false, '曲名不加链接（只要求专辑名可点）');
});

test('main：insertNowPlaying — 没有专辑笔记路径时退化成纯专辑名（不生成 [[|名]]）', () => {
  const line = insertedLine({ albumTitle: '黑豹乐队' }); // 收藏类队列：只有曲目自带的专辑名
  assert.equal(line, '此刻正在听《黑豹乐队》的《无地自容》\n');
  assert.equal(line.includes('[['), false, '没有路径就退回纯标题');
});

test('main：insertNowPlaying — 专辑名 / 路径含 wikilink 语法字符时不硬凑坏链接', () => {
  // 别名含 | 会被当成别名分隔符 → 退回 [[路径]]（仍可点开笔记，显示名 = 笔记文件名）
  assert.equal(
    insertedLine({ albumNotePath: 'Vinyl Life/Vinyl Note/ACDC.md', albumTitle: 'AC|DC' }),
    '此刻正在听《[[Vinyl Life/Vinyl Note/ACDC.md]]》的《无地自容》\n'
  );
  // 别名含 ]] 会提前关掉链接 → 同样退回 [[路径]]
  assert.equal(
    insertedLine({ albumNotePath: 'Vinyl Life/Vinyl Note/怪名.md', albumTitle: '怪名]]' }),
    '此刻正在听《[[Vinyl Life/Vinyl Note/怪名.md]]》的《无地自容》\n'
  );
  // 路径本身不安全（含 ]]）→ 纯文本：宁可不能点，也不生成 [[|名]] / 半截链接
  assert.equal(
    insertedLine({ albumNotePath: 'Vinyl Life/Vinyl Note/怪]]名.md', albumTitle: '怪]]名' }),
    '此刻正在听《怪]]名》的《无地自容》\n'
  );
  // 有路径没标题：[[路径|]] 是坏链接 → 退回 [[路径]]
  assert.equal(
    insertedLine({ albumNotePath: 'Vinyl Life/Vinyl Note/黑豹乐队.md' }),
    '此刻正在听《[[Vinyl Life/Vinyl Note/黑豹乐队.md]]》的《无地自容》\n'
  );
});

// ============ 「关于」页：作者手记逐字保真 + 正文不进词典 ============
// 手记正文是原文常量（src/core/about.ts 的 ABOUT_TEXT）：不翻译、不进词典、不许「润色」。
// 期望值在这里独立抄一遍（不从源码读回），任何人改动正文都会让下面的断言先响。
const aboutSource = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/core/about.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian'],
}).outputFiles[0].text;

const aboutMod = { exports: {} };
vm.runInNewContext(aboutSource, {
  module: aboutMod,
  exports: aboutMod.exports,
  require: () => ({}),
  console,
});
const about = aboutMod.exports;

// 逐字期望值：首行末尾一个空格，段落之间空行，末尾一个换行（照录原文代码块的最后一个行尾）。
// 写法上刻意用 \n 转义而不是多行模板字符串：转义后的值不受编辑器「删行尾空格」与 git CRLF 影响。
const ABOUT_EXPECTED =
  '一首歌值得被写下来。 \n' +
  '\n' +
  '把唱针轻轻搭上，那一秒爆豆子似的静电声。它出现在哪一年、哪个城市、哪一场雨；它陪过你熬过哪一夜；它让你想起谁。这些不该沉在记忆里，也不该变成一个社交平台上的动态。它应该是你自己的一页纸，私人，安静，可以一直放在那儿。\n' +
  '\n' +
  '音乐和笔记也许本身有着天然的亲和力。\n';

// 英译逐字期望值：同样在测试里独立抄一遍（不从源码读回）。
// 段落结构与中文一致（三段、段间空行），末行行尾同样保留一个换行。
const ABOUT_EXPECTED_EN =
  'A song is worth writing down.\n' +
  '\n' +
  'Put the needle down, and for a second there is only that crackle — like beans popping. The year it came from, the city, the rain; the night it carried you through; the person it brings back. These things should not sink into memory, and should not become a post on a social platform. They should be a page of your own — private, quiet, somewhere it can stay.\n' +
  '\n' +
  'Music and notes may have a natural affinity for each other.\n';

/** 段落切分（抹掉行尾空白后取非空行）——README 里手记没有中文原文那份行尾空格 */
function aboutParagraphs(text) {
  return text.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
}

test('「关于」手记：ABOUT_TEXT 逐字照录（含首行行尾空格与段落间空行）', () => {
  assert.equal(typeof about.ABOUT_TEXT, 'string', 'ABOUT_TEXT 是字符串常量');
  assert.equal(about.ABOUT_TEXT.length, ABOUT_EXPECTED.length, '长度必须一致');
  assert.equal(about.ABOUT_TEXT, ABOUT_EXPECTED, '手记正文必须与原文逐字相同（标点 / 空格 / 换行都不许动）');

  // 分项断言：万一被「顺手排版」，失败信息直接指出坏在哪一处
  assert.equal(about.ABOUT_TEXT.includes('\r'), false, '不得含 CR（CRLF 换行会破坏逐字保真）');
  const lines = about.ABOUT_TEXT.split('\n');
  assert.equal(lines.length, 6, '5 行正文 + 末尾换行切出的空串');
  assert.equal(lines[1], '', '第一段与第二段之间是空行');
  assert.equal(lines[3], '', '第二段与第三段之间是空行');
  assert.equal(lines[0].endsWith(' '), true, '首行行尾的空格必须保留');
  assert.equal(lines[0], '一首歌值得被写下来。 ');
  assert.equal(lines[4], '音乐和笔记也许本身有着天然的亲和力。');
  // 逐字保真的反面样本：这些「修正」都不许出现
  assert.equal(about.ABOUT_TEXT.includes('她'), false, '不得出现原文没有的字（作者已确认删去行首那个「地」）');
});

test('「关于」手记：ABOUT_TEXT_EN 逐字照录（英译，与中文并列展示）', () => {
  const en = about.ABOUT_TEXT_EN;
  assert.equal(typeof en, 'string', 'ABOUT_TEXT_EN 是字符串常量');
  assert.ok(en.trim().length > 0, 'ABOUT_TEXT_EN 非空');
  assert.equal(en.length, ABOUT_EXPECTED_EN.length, '长度必须一致');
  assert.equal(en, ABOUT_EXPECTED_EN, '英译必须与作者授权的那份逐字相同（不许改写 / 润色）');
  assert.notEqual(en, ABOUT_EXPECTED, '英译与中文原文不能相同（否则等于没加译文）');
  assert.equal(en.includes('\r'), false, '不得含 CR（CRLF 换行会破坏逐字保真）');

  // 段落结构与中文一致：三段、段间空行、末行一个换行
  const lines = en.split('\n');
  assert.equal(lines.length, 6, '三段正文 + 两个段间空行 + 末尾换行切出的空串');
  assert.equal(lines[1], '', '第一段与第二段之间是空行');
  assert.equal(lines[3], '', '第二段与第三段之间是空行');
  assert.equal(lines[0], 'A song is worth writing down.');
  assert.equal(lines[4], 'Music and notes may have a natural affinity for each other.');
  assert.equal(aboutParagraphs(en).length, 3, '段落数（非空行）为 3');
  assert.equal(aboutParagraphs(ABOUT_EXPECTED).length, 3, '中文也是 3 段 —— 两份结构对齐');
});

test('「关于」手记：正文不进 i18n 词典（不是键、不翻译）', () => {
  // 词典测试强制 zh !== en；正文若进词典，要么被翻译（原文就没了），要么把中英抄成一样（词典测试会红）
  const values = Object.values(i18n.DICT).flatMap((e) => [e.zh, e.en]);
  assert.equal(values.includes(about.ABOUT_TEXT), false, '整段手记不得作为任何键的译文');
  // 英译同理：它是「正文」，与中文并列展示，不跟语言开关走
  assert.equal(values.includes(about.ABOUT_TEXT_EN), false, '英译手记不得作为任何键的译文');
  assert.equal(
    Object.prototype.hasOwnProperty.call(i18n.DICT, about.ABOUT_TEXT_EN),
    false,
    '英译手记不得被当成词典键'
  );

  // 整行抄进词典同样算违规（拿正文里每个「整行」去词典里找子串）——中英两份都查
  const lines = [...aboutParagraphs(about.ABOUT_TEXT), ...aboutParagraphs(about.ABOUT_TEXT_EN)]
    .filter((s) => s.length >= 8);
  assert.ok(lines.length >= 4, `探针：正文只切出 ${lines.length} 个可比对的行，切分逻辑可能已失效`);
  const hits = [];
  for (const [k, entry] of Object.entries(i18n.DICT)) {
    for (const lang of ['zh', 'en']) {
      if (lines.some((line) => entry[lang].includes(line))) hits.push(`${k}.${lang}`);
    }
  }
  assert.deepEqual(hits, [], '词典里出现了手记正文的整行 —— 正文不翻译、不进词典');

  // 「关于」页只该有壳文案那几个键
  const aboutKeys = Object.keys(i18n.DICT)
    .filter((k) => k === 'settings.tab.about' || k.startsWith('settings.about'))
    .sort();
  assert.deepEqual(
    aboutKeys,
    ['settings.aboutLicense', 'settings.aboutVersion', 'settings.tab.about'],
    '「关于」页只允许 3 条壳文案（标签名 / 版本行 / 许可行），正文不许建键'
  );
});

test('设置面板：自绘标签页（有意不走声明式分页）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/settings.ts'), 'utf8');
  // 自绘是刻意的：官方文档写明 getSettingDefinitions() 返回非空数组时 display() 不会被调用，
  // 两条路只能二选一。这条断言是闸门，别「顺手升级」回声明式分页（注释里提到它不算）。
  assert.equal(
    /^\s*getSettingDefinitions\s*\(/m.test(src),
    false,
    '不实现 getSettingDefinitions()：声明式分页会顶掉自绘标签条（见 CONTRIBUTING 与文件头注释）'
  );
  assert.match(src, /display\(\): void \{/, '面板整块由 display() 自绘');
  assert.match(src, /containerEl\.addClass\('vinyl-settings'\)/, '整块挂 vinyl-settings（样式在 styles.css）');
  assert.match(src, /private switchTab\(id: TabId\): void/, '点标签就地换内容走 switchTab');
});

test('「关于」页接线：about 标签页渲染手记正文，版本号与仓库地址都走常量', () => {
  const settingsSrc = fs.readFileSync(path.join(__dirname, '../src/settings.ts'), 'utf8');
  const aboutSrc = fs.readFileSync(path.join(__dirname, '../src/views/about-page.ts'), 'utf8');
  assert.match(
    settingsSrc,
    /renderAboutPage\(el, this\.plugin\.manifest\.version\)/,
    '版本号取自 manifest.version，交给「关于」页渲染'
  );
  assert.match(
    settingsSrc,
    /attachAboutInk\(root, note\)/,
    '便签外框的笔触要挂上 —— 手绘的关键，不是可选项'
  );
  assert.match(aboutSrc, /ABOUT_TEXT(?!_)/, '正文要用 ABOUT_TEXT 常量渲染，别另抄一份');
  assert.match(
    aboutSrc,
    /tf\('settings\.aboutVersion',\s*\{\s*v:\s*version\s*\}\)/,
    '版本行走 tf 占位符（壳文案不写死）'
  );
  assert.match(aboutSrc, /REPO_URL/, '底部 GitHub 外链走 REPO_URL 常量');
  assert.match(about.REPO_URL, /^https:\/\/github\.com\/Louiss342\/Vinyl-life$/, '仓库地址');

  // 接线顺序（只戳正文那两行：import 行会让「谁在前」变得没意义）：
  // 中文正文先建，英译后建 —— 真正的节点先后由下面假 DOM 的用例驱动验证
  assert.match(
    aboutSrc,
    /ABOUT_TEXT(?!_)[\s\S]{0,400}?ABOUT_TEXT_EN/,
    '「关于」页里英译要接在中文正文之后（不是只 import 进来）'
  );

  // 「全手绘」的「手」来自手写体：标题 / 便签 / 页脚三块都要挂在字体族里，漏一块就不是整页手绘了
  const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
  assert.match(
    css,
    /\.vinyl-about-title,\s*\.vinyl-about-note,\s*\.vinyl-about-meta\s*\{[^}]*font-family:\s*'Vinyl Hand',\s*'Vinyl Hand CJK'/,
    '「关于」页的标题 / 便签 / 页脚都要用上手写体'
  );
});

test('手写体子集：取材覆盖「关于」页（改文案要重跑脚本，字才有手写感）', () => {
  const script = fs.readFileSync(path.join(__dirname, 'subset-hand-font.cjs'), 'utf8');
  assert.match(script, /core\/about\.ts/, '子集要按 about.ts 的手记正文取材');
  assert.match(script, /ABOUT_TEXT_EN/, '英译正文也要进子集');
  assert.match(script, /settings\.aboutVersion|settings\.aboutLicense/, '版本行 / 许可行的字也要收');
  assert.match(script, /shelf\.tutorial\./, '教程文案的来源不能被删掉（两处共用一个字体族）');
  assert.match(script, /Vinyl Life/, '页面上写死的拉丁文（产品名等）不在 i18n 里，得在脚本里列出来');

  // 两个面都要真的内联在样式表尾部：子集没生成 / 被清掉的话，「关于」页会整页回落到主题字体
  const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
  assert.equal((css.match(/data:font\/woff2/g) || []).length, 2, 'styles.css 尾部是两个内联子集');
  assert.match(css, /font-family: 'Vinyl Hand'/, '拉丁面');
  assert.match(css, /font-family: 'Vinyl Hand CJK'/, '中文面');
});

test('设置面板：五个标签页，统计位于通用与外观之间（页名走词典）', () => {
  const mod = settingsModule();
  const tabs = mod.SETTINGS_TABS;
  // 展开一层再比：vm 沙箱里的数组原型与测试侧不同，deepStrictEqual 会判不等
  assert.deepEqual(
    [...tabs.map((tab) => tab.id)],
    ['general', 'stats', 'appearance', 'source', 'about'],
    '标签顺序：通用 / 统计 / 外观 / 源 / 关于'
  );
  assert.deepEqual(
    [...tabs.map((tab) => tab.key)],
    ['settings.tab.general', 'settings.tab.stats', 'settings.tab.appearance', 'settings.tab.source', 'settings.tab.about'],
    '页名键收在清单里，别在渲染处另拼'
  );
  for (const tab of tabs) {
    for (const lang of ['zh', 'en']) {
      const entry = i18n.DICT[tab.key];
      assert.ok(entry && entry[lang], `${tab.key} 缺 ${lang} 页名`);
    }
  }
});

test('设置面板：标签条五个按钮，点一下就换内容、高亮跟着走（假 DOM 驱动 display()）', () => {
  // 面板整块自绘，所以 display() 能在这个假 DOM 上跑起来：Setting 用链式桩顶掉，
  // 控件本身（下拉 / 开关的真实现）不需要 —— 这里验的是标签条与「点一下就换内容」。
  const mod = settingsModule();
  const tab = new mod.VinylSettingTab(
    {},
    {
      manifest: { version: '9.9.9' },
      settings: mod.DEFAULT_SETTINGS,
      server: {},
      saveSettings: async () => {},
      refreshLanguage: () => {},
      refreshAppearance: () => {},
    }
  );
  tab.containerEl = fakeEl();
  tab.display();

  const buttons = () => collect(tab.containerEl).filter((e) => e.classes.has('vinyl-settings-tab'));
  assert.equal(buttons().length, 5, '五个标签');
  assert.deepEqual(
    [...buttons().map((b) => b.textContent)],
    ['通用', '统计', '外观', '源', '关于'],
    '标签文案走词典（默认中文）'
  );
  assert.equal(buttons()[0].getAttribute('aria-current'), 'true', '当前标签要报给读屏软件');
  assert.equal(buttons()[1].getAttribute('aria-current'), 'false', '其余标签不是当前页');
  assert.ok(buttons()[0].classes.has('is-active'), '当前标签挂外观类');

  const has = (text) => collect(tab.containerEl).some((e) => String(e.textContent).includes(text));
  assert.ok(has('语言 / Language'), '默认停在「通用」：看得到语言这一行');
  assert.equal(has('调试命令'), false, '已移除的调试命令不应继续出现在通用页');
  assert.equal(has('默认位置'), false, '播放器默认位置已移出通用页');
  assert.equal(has('每行专辑数量'), false, '「外观」页的行还没渲染（切标签是重建，不是预建四份）');

  buttons()[2].onclick();
  assert.ok(buttons()[2].classes.has('is-active'), '切到「外观」后高亮跟过去');
  assert.equal(buttons()[0].getAttribute('aria-current'), 'false', '上一个标签不再报当前页');
  assert.ok(has('每行专辑数量'), '内容换成「外观」页的设置行');
  assert.ok(has('默认位置'), '播放器默认位置已移动到「外观」页');
  assert.equal(has('语言 / Language'), false, '「通用」页的行已经清掉');
});

test('设置面板：分区图标优先走宿主 Lucide，宿主没有该图标名才回落文本符号', () => {
  // 播放统计已单独成页；通用页剩四个分区。
  // 顺序 = 通用页分区的书写顺序 = 两栏网格里的排布（基础偏好与播放是半宽的一对，路径/模板整行）
  const generalIcons = ['sliders-horizontal', 'audio-lines', 'folder-tree', 'notebook-pen'];
  const render = (extra) => {
    const mod = settingsModule(extra);
    const tab = new mod.VinylSettingTab(
      {},
      {
        manifest: { version: '9.9.9' },
        settings: mod.DEFAULT_SETTINGS,
        server: {},
        saveSettings: async () => {},
        refreshLanguage: () => {},
        refreshAppearance: () => {},
      }
    );
    tab.containerEl = fakeEl();
    tab.display();
    return collect(tab.containerEl).filter((e) => e.classes.has('vinyl-settings-section-icon'));
  };

  const lucide = render({
    getIconIds: () => [...generalIcons],
    setIcon: (el, name) => el.setAttribute('data-icon', name),
  });
  assert.equal(lucide.length, 4, '四个分区各有一个图标位');
  assert.deepEqual(
    [...lucide.map((el) => el.getAttribute('data-icon'))],
    generalIcons,
    '宿主有这些图标名时必须用 Lucide（SVG 形状跨平台一致），别再用文本符号'
  );
  assert.deepEqual([...lucide.map((el) => el.textContent)], ['', '', '', ''], '走了 Lucide 就不再放文本');

  // 老宿主：没有 getIconIds（或图标名是较新才加的）→ 回落文本符号
  const legacy = render({});
  assert.equal(legacy.length, 4);
  assert.deepEqual(
    [...legacy.map((el) => el.textContent)],
    ['⌁', '≋', '⌂', '✎'],
    '取不到图标集时回落文本符号，界面不至于空一块'
  );
  assert.equal(legacy.every((el) => el.getAttribute('data-icon') === null), true);
});

// ============ 设置面板与「关于」页：esbuild + 假 DOM ============
// 面板整块自绘，所以能在这个假 DOM 上跑：Setting 顶成链式桩（控件回调不触发，
// 验的是行的装配与标签切换），「关于」页的文本部分是纯 DOM 构建，直接驱动。
let settingsBundle = null;
/** extra：额外（或覆盖）的 obsidian 导出，用于验宿主能力分支（如 getIconIds 有没有）。 */
function settingsModule(extra = null) {
  if (settingsBundle && !extra) return settingsBundle;
  const src = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '../src/settings.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(src, {
    module,
    exports: module.exports,
    require: (name) => {
      if (name === 'obsidian') {
        return {
          App: class {},
          ItemView: class {},
          Menu: class {},
          Modal: class {},
          Notice: class {},
          Plugin: class {},
          PluginSettingTab: class {
            constructor(app, plugin) {
              this.app = app;
              this.plugin = plugin;
            }
          },
          // 链式桩：设置行的装配只用得到这几个方法，控件本身不参与断言（回调不触发）。
          // setName 把标题落进 DOM（真实类名 setting-item-name），标签切换的用例靠它找行。
          Setting: class {
            constructor(containerEl) {
              this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
              this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
            }
            setName(text) {
              this.settingEl.createSpan({ cls: 'setting-item-name', text });
              return this;
            }
            setDesc() {
              return this;
            }
            setHeading() {
              return this;
            }
            addDropdown() {
              return this;
            }
            addToggle() {
              return this;
            }
            addText() {
              return this;
            }
            addButton() {
              return this;
            }
          },
          TFile: class {},
          TFolder: class {},
          WorkspaceLeaf: class {},
          FuzzySuggestModal: class {},
          normalizePath: (p) => p,
          setIcon: () => {},
          requestUrl: async () => ({}),
          ...(extra || {}), // 放最后：用例要用真实行为覆盖某个导出（如 setIcon / getIconIds）
        };
      }
      return require(name);
    },
    console,
    Buffer,
    setTimeout,
    clearTimeout,
  });
  if (!extra) settingsBundle = module.exports;
  return module.exports;
}

// 「关于」页单独起一份 bundle：它的文本渲染是纯 DOM 构建（笔触那半要真实 SVG，
// 由源码级断言把关），测试直接驱动 renderAboutPage 就行。
let aboutBundle = null;
function aboutModule() {
  if (aboutBundle) return aboutBundle;
  const src = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '../src/views/about-page.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(src, {
    module,
    exports: module.exports,
    require: () => ({}),
    console,
    Buffer,
    setTimeout,
    clearTimeout,
  });
  aboutBundle = module.exports;
  return aboutBundle;
}

test('「关于」页：中文正文在上、英译在下（渲染顺序 + 两份内容逐字进 DOM）', () => {
  const mod = aboutModule();
  const container = fakeEl();
  const { root, note } = mod.renderAboutPage(container, '9.9.9');
  assert.ok(root && note, '返回根块与便签块：手绘框要按便签的实际尺寸画');

  const nodes = collect(container);
  const zh = nodes.findIndex((e) => e.classes.has('vinyl-about-text'));
  const en = nodes.findIndex((e) => e.classes.has('vinyl-about-text-en'));
  const meta = nodes.findIndex((e) => e.classes.has('vinyl-about-meta'));
  assert.ok(zh >= 0, '中文正文块已渲染');
  assert.ok(en >= 0, '英译块已渲染（缺了就是没接线）');
  assert.ok(zh < en, '顺序：标题/版本 → 中文正文 → 英译 → 底部 MIT · GitHub');
  assert.ok(en < meta, '底部许可行仍在两份正文之后');
  assert.equal(nodes[zh].textContent, ABOUT_EXPECTED, '中文块原样进 DOM（textContent 不裁剪）');
  assert.equal(nodes[en].textContent, ABOUT_EXPECTED_EN, '英文块原样进 DOM（textContent 不裁剪）');
  assert.ok(
    nodes.some((e) => String(e.textContent).includes('9.9.9')),
    '版本号走版本行（入参由 settings.ts 从 manifest.version 取，接线另有用例把关）'
  );
  const link = nodes.find((e) => e.tag === 'a');
  assert.ok(link, '底部有 GitHub 外链');
  assert.equal(link.getAttribute('href'), about.REPO_URL, '链接指向仓库地址常量');
});

test('README：开头的中文手记下方跟着同一份英译（不加标题）', () => {
  // 归一化 CRLF：仓库开着 autocrlf，README 检出后带 \r，下面按行比的断言会误红
  const readme = fs
    .readFileSync(path.join(__dirname, '../README.md'), 'utf8')
    .replace(/\r\n/g, '\n');
  const zhParas = aboutParagraphs(ABOUT_EXPECTED);
  const enParas = aboutParagraphs(ABOUT_EXPECTED_EN);
  assert.equal(zhParas.length, 3, '探针：中文手记切出 3 段');
  assert.equal(enParas.length, 3, '探针：英译切出 3 段');

  for (const p of zhParas) assert.ok(readme.includes(p), `README 缺中文手记段落：${p.slice(0, 12)}…`);
  for (const p of enParas) assert.ok(readme.includes(p), `README 缺英译手记段落：${p.slice(0, 12)}…`);

  // 版式：中文三段在前，英文三段在后（README 里没有中文原文首行行尾那个空格，故按段落比）
  const zhLast = readme.indexOf(zhParas[zhParas.length - 1]);
  const enFirst = readme.indexOf(enParas[0]);
  assert.ok(enFirst > zhLast, '英译要排在中文手记下方');
  assert.ok(
    readme.indexOf(enParas[2]) > readme.indexOf(enParas[0]),
    '英文三段保持原顺序（不是倒着抄）'
  );

  // 英文块上方：只隔一个空行、不加标题（版式要求）
  const between = readme.slice(zhLast, enFirst);
  assert.equal(between.includes('#'), false, '英文块上方不加标题');
  assert.deepEqual(
    between.split('\n').filter((l) => l.trim()),
    [zhParas[zhParas.length - 1]],
    '中文手记与英译之间只隔一个空行'
  );
});

// ============ README：中文整版在上、英文整版在下，两份小节一一对应 ============
// 局限（写在断言旁边，免得把它当成了「翻译质量检查」）：
//   标题对等 != 内容逐段对等 —— 标题都在，只能说明没有整节漏掉；
//   长度下限也只挡得住「只翻了几行」，挡不住把长段落写成一句摘要、跳过表格某一行、
//   或者把代码块注释漏掉。真要判断有没有缩水，仍得中英两栏人工对着读一遍。
test('README：整版中英对照 —— 中文在上、英文在下，小节标题一一对应', () => {
  // 归一化 CRLF：仓库开着 autocrlf，换台机器检出后 README 可能带 \r，\n 硬匹配会误红
  const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8').replace(/\r\n/g, '\n');

  // 1) 两个语言标记各自独立成行：中文区在前，英文区在后
  const zhMark = readme.indexOf('\n## 中文\n');
  const enMark = readme.indexOf('\n## English\n');
  assert.ok(zhMark >= 0, 'README 缺「## 中文」标记（中文整版要收在它下面）');
  assert.ok(enMark >= 0, 'README 缺「## English」标记（英文整版要收在它下面）');
  assert.ok(zhMark < enMark, '中文整版在上、英文整版在下（顺序不许倒）');

  const zhBody = readme.slice(zhMark, enMark);
  const enBody = readme.slice(enMark);

  // 2) 切出各区里的 ## / ### 标题（语言标记自己不算小节）
  const headingsOf = (text) =>
    text
      .split('\n')
      .filter((line) => /^#{2,3} \S/.test(line))
      .map((line) => line.trim());
  const zhHeads = headingsOf(zhBody).filter((h) => h !== '## 中文');
  const enHeads = headingsOf(enBody).filter((h) => h !== '## English');

  assert.ok(zhHeads.length >= 12, `探针：中文区只切出 ${zhHeads.length} 个标题，切分逻辑可能已失效`);
  assert.equal(enHeads.length, zhHeads.length, '英文区小节数量必须与中文区相等（不许整节漏译）');
  // 层级也要对得上：## 与 ### 各自数量相等（英文区不该整体降一级或多一级）
  const isSub = (h) => h.startsWith('### ');
  assert.equal(enHeads.filter(isSub).length, zhHeads.filter(isSub).length, '### 子节数量相等');
  assert.equal(enHeads.filter((h) => !isSub(h)).length, zhHeads.filter((h) => !isSub(h)).length, '## 节数量相等');

  // 3) 顺序一一对应：两份标题按顺序抄死，插节 / 挪节 / 改标题都会红
  assert.deepEqual(
    zhHeads,
    [
      '## 专辑墙',
      '## 黑胶播放器',
      '## 导入音乐',
      '### 本地音频',
      '### 网易云音乐和 QQ 音乐',
      '## 专辑笔记与听歌记录',
      '## 封面与专辑整理',
      '## 播放统计',
      '## 设置',
      '## 安装与开始使用',
      '## 在线音源与数据',
      '## 权限说明',
      '## 开发与构建',
      '## 许可与致谢',
    ],
    '中文区小节清单（中文标题若有改动，这份期望值要同步）'
  );
  assert.deepEqual(
    enHeads,
    [
      '## Album shelf',
      '## Vinyl player',
      '## Importing music',
      '### Local audio',
      '### NetEase Cloud Music and QQ Music',
      '## Album notes and listening log',
      '## Covers and album organization',
      '## Playback statistics',
      '## Settings',
      '## Installation and getting started',
      '## Online sources and data',
      '## Permissions',
      '## Development',
      '## License and acknowledgements',
    ],
    '英文区小节清单（顺序与中文区一一对应）'
  );

  // 4) 英文区不能是「翻了两行就收工」：长度下限（英文按字符数本就比中文长，60% 是很松的下限）
  assert.ok(
    enBody.trim().length > zhBody.trim().length * 0.6,
    `英文区明显偏短（${enBody.trim().length} vs 中文 ${zhBody.trim().length}）—— 疑似只译了开头`
  );
});
