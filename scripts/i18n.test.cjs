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
