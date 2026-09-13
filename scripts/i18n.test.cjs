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
    'sort.titleAsc', 'sort.titleDesc', 'sort.yearDesc', 'sort.yearAsc',
    'sort.ratingDesc', 'sort.playsDesc', 'sort.recent',
    'filter.all', 'filter.local', 'filter.netease', 'filter.qq', 'filter.collect',
    'shelf.title', 'shelf.search', 'shelf.refresh', 'shelf.sort', 'shelf.filter',
    'shelf.props', 'shelf.importAlbum', 'shelf.importAudio',
    'shelf.empty.title', 'shelf.empty.hint', 'shelf.filtered.title', 'shelf.filtered.hint',
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
    i18n.tf('login.web.openFailed', { msg: 'boom', fallback: 'NetEase QR sign-in' }),
    'Could not open the sign-in window: boom (use "NetEase QR sign-in" or paste a cookie manually instead)'
  );
  i18n.setLanguage('zh');
});

test('i18n：语言切换后新建的登录 provider 文案跟着变（不能被模块加载时定型）', () => {
  const providers = esbuild.buildSync({
    stdin: {
      // setLanguage 从这里取：bundle 里的 i18n 是独立实例，改外层实例对它无效
      contents: `export * from '../src/views/qr-login-modal';\nexport * from '../src/views/web-login-modal';\nexport { setLanguage } from '../src/core/i18n';\n`,
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
  assert.equal(mod.exports.qqWebProvider().title, 'QQ Music sign-in (browser)');
  assert.equal(mod.exports.qqWebProvider().qrFallback, 'QQ Music QR sign-in', '兜底入口名跟命令名一致');

  mod.exports.setLanguage('zh');
  assert.equal(mod.exports.qqQrProvider().title, 'QQ 音乐登录', '切回中文仍是原文案');
});

// ============ 播放器视图：源码防护 + 切语言后就地更新 ============

// 提取源码里的字符串字面量内容（跳过注释），用于「不得硬编码中文」的断言。
// 只处理 ' " ` 三种引号与 // /* */ 注释；不处理正则字面量（本文件里没有含引号的正则）。
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

test('i18n：播放器视图源码不得硬编码中文文案（注释不算；防「壳只建一次」漏翻回潮）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/views/player-view.ts'), 'utf8');
  const lits = stringLiterals(src);
  assert.ok(lits.length >= 30, `只解析出 ${lits.length} 个字符串字面量，解析逻辑可能已失效`);
  const bad = lits.filter((s) => /[一-鿿]/.test(s));
  assert.deepEqual(
    bad,
    [],
    '提示 / 标签文案应改走 t()（随语言的标签用 bindLabel 登记，切语言时由 applyLanguage 重放）'
  );
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
      if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) child.setAttribute(k, v);
      return child;
    },
    getAnimations: () => [],
    animate: () => ({}),
    closest: () => null,
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
  });
  playerBundle = module.exports;
  return playerBundle;
}

// 引擎快照最小面（播放器只读这些字段）
function snap(over = {}) {
  return {
    status: 'idle',
    queue: [],
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
  view.update(snap()); // 首帧建壳（zh）
  const all = collect(root);
  const hasLabel = (v) => all.some((e) => e.getAttribute('aria-label') === v);
  const hasText = (v) => all.some((e) => e.textContent === v);

  const noteBtn = all.find((e) => e.getAttribute('title') === '在专辑笔记追加此刻感想');
  assert.ok(noteBtn, '建壳时「追加感想」的 tooltip 应为中文');
  assert.equal(noteBtn.getAttribute('aria-label'), '在专辑笔记追加此刻感想');
  assert.ok(hasLabel('上一首') && hasLabel('播放 / 暂停') && hasLabel('下一首'), '控制钮提示');
  assert.ok(hasLabel('选择专辑'), '换碟钮提示');
  assert.ok(hasLabel('恢复原有顺序'), '恢复顺序钮提示');
  assert.ok(hasText('黑胶播放器'), '头部标题');
  assert.ok(hasText('空队列'), '空队列提示');

  const vinylBefore = view.els.vinyl;
  const headerBefore = view.els.headerTitle;
  mod.setLanguage('en');
  view.applyLanguage();

  assert.ok(hasLabel('Previous track') && hasLabel('Play / pause') && hasLabel('Next track'));
  assert.ok(hasLabel('Choose album'), '选择专辑 → Choose album');
  assert.ok(hasLabel('Restore original order'), '恢复原有顺序 → Restore original order');
  assert.equal(noteBtn.getAttribute('title'), 'Append current thoughts to the album note');
  assert.equal(noteBtn.getAttribute('aria-label'), 'Append current thoughts to the album note');
  assert.equal(view.els.headerTitle.textContent, 'Vinyl player', '头部标题跟着换');
  assert.equal(view.els.headerTitle.getAttribute('title'), 'Vinyl player', '头部 tooltip 也跟着换');
  assert.ok(hasText('Empty queue'), '空队列 → Empty queue');
  assert.equal(view.els.vinyl, vinylBefore, '就地改文案：转盘节点没被换掉（旋转动画不被打断）');
  assert.equal(view.els.headerTitle, headerBefore, '壳只建一次：节点身份不变');

  mod.setLanguage('zh');
  view.applyLanguage();
  assert.equal(noteBtn.getAttribute('title'), '在专辑笔记追加此刻感想', '切回中文仍是原文案');
  assert.equal(view.els.headerTitle.textContent, '黑胶播放器');
});

test('播放器：队列行的拖拽提示随语言就更新（不重建队列行）', () => {
  const mod = playerModule();
  mod.setLanguage('zh');
  const { view } = makePlayerView(mod);
  const queue = [{ source: 'local-vault', path: 'a.mp3', title: 'A', duration: 65 }];
  view.update(snap({ queue, index: 0, status: 'paused' }));
  const row = view.queueRows[0];
  assert.ok(row, '队列行已建');
  assert.equal(row.getAttribute('title'), '拖拽调整顺序');

  mod.setLanguage('en');
  view.applyLanguage();
  assert.equal(row.getAttribute('title'), 'Drag to reorder');
  assert.equal(view.queueRows[0], row, '就地改属性：队列行没被重建');
  assert.equal(row.getAttribute('draggable'), 'true', '非文案属性不受影响');

  mod.setLanguage('zh');
  view.applyLanguage();
  assert.equal(row.getAttribute('title'), '拖拽调整顺序');
});

test('播放器：切语言后音质读数与来源角标按新语言重算（不重建节点）', () => {
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
  assert.equal(view.els.qualityEl.textContent, '网易云 · 较高');
  assert.equal(view.queueBadges[0].textContent, '网易云');
  assert.equal(view.queueBadges[1].textContent, '本地');

  const qualityEl = view.els.qualityEl;
  const badge = view.queueBadges[0];
  mod.setLanguage('en');
  view.applyLanguage();
  assert.equal(view.els.qualityEl.textContent, 'NetEase · Higher', '读数按新语言重算');
  assert.equal(badge.textContent, 'NetEase', '队列角标就地改文本');
  assert.equal(view.els.qualityEl, qualityEl, '读数节点没被换掉');
  assert.equal(view.queueBadges[0], badge, '角标节点没被重建');

  mod.setLanguage('zh');
  view.applyLanguage();
  assert.equal(view.els.qualityEl.textContent, '网易云 · 较高', '切回中文复原');
  assert.equal(badge.textContent, '网易云');
});
