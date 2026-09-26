// 专辑笔记模板回归（1.3.0 重做）：
//   ① 占位符：值型（title/artist/year/genre/rating/date/time/三个平台 id）与行型
//      （audioFolder/cover —— 拿不到值整行消失）分开，未识别的原样保留；
//   ② frontmatter 补全：模板决定笔记长什么样，插件保证**功能键不丢** ——
//      tags 里一定有 album、已取到的 id / 链接 / 封面 / 艺人年份只在「缺失或为空」时写入，
//      模板里写死的非空值一律不动；
//   ③ 端到端：一篇自定义模板 + 在线资料 → 渲染出来的笔记既能被插件认出（tags + id），
//      又保留了用户自己的字段与正文。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/import.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian'],
}).outputFiles[0].text;
class TFile {}
class TFolder {}
const mod = { exports: {} };
new Function('require', 'module', 'exports', source)(
  (name) =>
    name === 'obsidian'
      ? {
          App: class {},
          TFile,
          TFolder,
          normalizePath: (p) => p,
          Notice: class {},
          parseYaml: () => ({}),
        }
      : require(name),
  mod,
  mod.exports
);
const { renderAlbumTemplate, fillAlbumFrontmatter } = mod.exports;

const fields = {
  title: '叶惠美',
  artist: '周杰伦',
  year: 2003,
  genre: 'Pop',
  rating: 4,
  cover: '"[[Vinyl Life/covers/叶惠美.jpg]]"',
  audioFolder: 'Vinyl Life/audio/叶惠美',
  neteaseId: 437968,
  netease: 'https://music.163.com/#/album?id=437968',
  now: new Date(2026, 8, 25, 9, 5),
};

test('占位符：值型替换成值本身，行型替换成整行 frontmatter', () => {
  const out = renderAlbumTemplate(
    [
      '---',
      'tags: [album]',
      '{{audioFolder}}',
      '{{cover}}',
      'note: {{title}} · {{artist}} · {{year}} · {{genre}} · {{rating}} · {{neteaseId}}',
      'stamp: {{date}} {{time}}',
      '---',
      '',
      '# {{title}}',
    ].join('\n'),
    fields
  );
  assert.match(out, /^audioFolder: "\[\[Vinyl Life\/audio\/叶惠美\]\]"$/m);
  assert.match(out, /^cover: "\[\[Vinyl Life\/covers\/叶惠美\.jpg\]\]"$/m);
  assert.match(out, /^note: 叶惠美 · 周杰伦 · 2003 · Pop · 4 · 437968$/m);
  assert.match(out, /^stamp: 2026-09-25 09:05$/m, '日期时间按本地时区');
  assert.match(out, /^# 叶惠美$/m);
});

test('拿不到值的行型占位符整行消失；未识别的占位符原样保留', () => {
  const out = renderAlbumTemplate(
    ['---', 'tags: [album]', '{{audioFolder}}', '{{cover}}', 'artist: {{artist}}', '---', '{{titel}}'].join('\n'),
    { title: '无源之乐', artist: '', now: fields.now }
  );
  assert.doesNotMatch(out, /audioFolder:/, '本地导入之外没有音频目录：整行消失');
  assert.doesNotMatch(out, /cover:/, '没有封面：整行消失');
  assert.match(out, /^artist: $/m, '值型占位符拿不到值替换成空');
  assert.match(out, /\{\{titel\}\}/, '拼错的占位符留着，用户能在笔记里看见');
});

test('frontmatter 补全：空字段填上、非空值不动、缺的键补上', () => {
  const tpl = [
    '---',
    'tags: [album]',
    'artist: ""',
    'year: 1999',
    'mood: 深夜',
    '---',
    '',
    '正文',
  ].join('\n');
  // 在线导入那一档（没有音频目录）
  const online = { ...fields, audioFolder: undefined };
  const out = fillAlbumFrontmatter(renderAlbumTemplate(tpl, online), online);
  assert.match(out, /^artist: "周杰伦"$/m, '空字段被已取到的资料填上');
  assert.match(out, /^year: 1999$/m, '模板里写死的值不动');
  assert.match(out, /^mood: 深夜$/m, '用户自己的字段原样保留');
  assert.match(out, /^neteaseId: 437968$/m, '缺的功能键补在最后');
  assert.match(out, /^netease: "https:\/\/music\.163\.com\/#\/album\?id=437968"$/m);
  assert.match(out, /^cover: "\[\[Vinyl Life\/covers\/叶惠美\.jpg\]\]"$/m);
  assert.match(out, /^genre: "Pop"$/m);
  assert.doesNotMatch(out, /audioFolder:/, '在线导入没有音频目录：不补');
  // 本地导入那一档：有音频目录就补上
  const local = fillAlbumFrontmatter(renderAlbumTemplate(tpl, fields), fields);
  assert.match(local, /^audioFolder: "\[\[Vinyl Life\/audio\/叶惠美\]\]"$/m);
});

test('tags 合并出 album：三种写法都要认（含块状列表）', () => {
  const cases = [
    ['tags: [music]', 'tags: [music, album]'],
    ['tags: [music, album]', 'tags: [music, album]'],
    ['tags: music', 'tags: [music, album]'],
    ['tags:', 'tags:\n  - album'],
  ];
  for (const [line, expected] of cases) {
    const out = fillAlbumFrontmatter(
      ['---', line, 'artist: ""', '---', '', '正文'].join('\n'),
      { title: 'T', now: fields.now }
    );
    assert.ok(out.includes(expected), `${line} → ${expected}；实际：\n${out}`);
  }
  const noTags = fillAlbumFrontmatter(['---', 'artist: ""', '---', '', '正文'].join('\n'), {
    title: 'T',
    now: fields.now,
  });
  assert.match(noTags, /^tags: \[album\]$/m, '模板没写 tags 就补一条');
});

test('模板没写 frontmatter：补一块在最前面，正文一字不动', () => {
  const out = fillAlbumFrontmatter('只有正文的模板\n第二行', fields);
  assert.match(out, /^---\ntags: \[album\]\n/, '补出 frontmatter 块');
  assert.match(out, /^neteaseId: 437968$/m);
  assert.match(out, /\n只有正文的模板\n第二行$/, '正文原样留在后面');
});

test('端到端：自定义模板 + 在线资料 → 笔记既认得出来也留得住用户的写法', () => {
  const userTpl = [
    '---',
    'tags: [album, 我的收藏]',
    'artist: ""',
    'year: ""',
    '评分:',
    '{{audioFolder}}',
    '---',
    '',
    '> 买这张的那天：',
    '',
    '{{title}} —— {{artist}}',
  ].join('\n');
  const out = fillAlbumFrontmatter(renderAlbumTemplate(userTpl, fields), fields);
  // 插件认专辑的依据
  assert.match(out, /^tags: \[album, 我的收藏\]$/m, 'album 已在 tags 里：不重复加');
  assert.match(out, /^neteaseId: 437968$/m);
  assert.match(out, /^netease: "https:\/\/music\.163\.com\/#\/album\?id=437968"$/m);
  // 用户的字段与正文
  assert.match(out, /^评分:$/m, '用户写的空键留着（没对应资料，不补）');
  assert.match(out, /^> 买这张的那天：$/m);
  assert.match(out, /^叶惠美 —— 周杰伦$/m);
  // 端到端后没有残留占位符
  assert.doesNotMatch(out, /\{\{/);
});

test('接线：模板行不设行名（免得被挤成竖排），读屏名字挂在输入框上', () => {
  const settings = fs.readFileSync(path.join(__dirname, '../src/settings.ts'), 'utf8');
  // 行名 + 输入框 + 两个按钮挤一行时，中文没有词边界会被压成一字一行
  assert.doesNotMatch(
    settings,
    /row\(body, t\('settings\.albumTemplate'\)/,
    '模板行不再套用带行名的 row()'
  );
  assert.match(settings, /const s = new Setting\(body\)/, '模板行自己建 Setting（无行名）');
  assert.match(settings, /vinyl-template-setting/, '行上有类名：样式里把空信息块收掉、控件铺满');
  assert.match(
    settings,
    /inputEl\.setAttribute\('aria-label', t\('settings\.albumTemplate'\)\)/,
    '输入框自己带 aria-label（占位文案不算标签）'
  );
  const i18n = fs.readFileSync(path.join(__dirname, '../src/core/i18n.ts'), 'utf8');
  assert.match(i18n, /'settings\.albumTemplate':/, '文案键留着：现在当 aria-label 用');
});

test('样式：模板行控件能被压窄、按钮不被压碎（英文长文案顶出卡片）', () => {
  const css = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf8');
  const rule = (selector) => {
    const at = css.indexOf(selector + ' {');
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };
  // 宿主（Obsidian）的 .setting-item-control 是 flex: 1 1 auto / min-width: auto，
  // min-content 里含着输入框那条定宽（min(310px, 34vw)）与两个按钮的完整文案。
  // 中文三项相加还在卡片内；英文按钮长一截，9 月 25 日实测（设置窗 900×700）
  // 控件右缘超出卡片 48px，靠卡片的 overflow: hidden 裁掉半颗按钮。
  const base = '.vinyl-settings-section .setting-item.vinyl-template-setting';
  const control = rule(`${base} .setting-item-control`);
  assert.match(control, /min-width:\s*0/, '控件要允许被压窄，否则整行顶出卡片');
  assert.match(control, /flex-wrap:\s*wrap/, '真放不下时按钮整颗换行，而不是被卡片裁掉');
  assert.match(
    rule(`${base} .setting-item-control > button`),
    /flex:\s*0 0 auto/,
    '按钮不参与伸缩：文案完整留在按钮里'
  );
  assert.match(
    rule(`${base} input[type='text']`),
    /flex:\s*1 1 140px/,
    '输入框基准是一个最小可用宽度：换行判定只看按钮，余下的宽度仍归输入框'
  );
});

test('接线：在线导入（三个平台）与本地导入都走同一条模板路', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/import.ts'), 'utf8');
  assert.equal(
    (src.match(/await buildAlbumNote\(ctx, \{/g) || []).length,
    3,
    '网易云 / QQ / 酷狗三处都用 buildAlbumNote'
  );
  assert.doesNotMatch(src, /const lines = \['---', 'tags: \[album\]'/, '不再各写各的 frontmatter');
  assert.match(
    src,
    /export async function buildLocalAlbumNote\([\s\S]{0,220}?buildAlbumNote\(ctx,/,
    '本地导入也是同一条路'
  );
});
