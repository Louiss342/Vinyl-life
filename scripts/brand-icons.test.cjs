// 品牌图标（views/brand-icons）：设置页「源」页三块用平台自己的标记，靠 addIcon 注册进宿主图标表。
//
// 这里守两件事：
//   ① 注册的形状是宿主认的那套 —— 完整 <svg viewBox=…>，不是裸 <path>（surfing / editing-toolbar
//      这两个已装插件都是这么注册的）；
//   ② 路径上的 fill-rule / fill 不能被顺手删掉 —— **删了不报错，只会静默画错**：
//      potrace 输出的子路径绕向相同，而酷狗的「圆环 + K」是三层嵌套轮廓，用默认的 nonzero
//      会把整块填成一枚实心圆（改版时最容易被当成「图标本来就长这样」）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

let bundle = null;
/** 载入 brand-icons 并把它注册进一张假图标表，返回 [id → svg 内容] */
function registered() {
  if (!bundle) {
    const src = esbuild.buildSync({
      entryPoints: [path.join(__dirname, '../src/views/brand-icons.ts')],
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'node',
      external: ['obsidian'],
    }).outputFiles[0].text;
    const module = { exports: {} };
    const table = new Map();
    vm.runInNewContext(src, {
      module,
      exports: module.exports,
      require: (name) =>
        name === 'obsidian'
          ? { addIcon: (id, svg) => table.set(id, svg) }
          : require(name),
      console,
    });
    bundle = { mod: module.exports, table };
  }
  bundle.table.clear();
  bundle.mod.registerBrandIcons();
  return bundle.table;
}

const EXPECTED = ['vinyl-brand-netease', 'vinyl-brand-qq', 'vinyl-brand-kugou'];

test('品牌图标：注册成宿主认的完整 <svg viewBox>，名字带前缀免得撞名', () => {
  const table = registered();
  assert.deepEqual([...table.keys()], EXPECTED, '三家各注册一枚，顺序与源页一致');
  assert.ok(
    [...table.keys()].every((id) => id.startsWith('vinyl-brand-')),
    '带命名空间前缀：宿主的图标表是全局的，裸名字会与别的插件撞'
  );
  for (const [id, svg] of table) {
    assert.match(
      svg,
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 480 480">/,
      `${id}: 必须是完整 svg（带 viewBox）—— 裸 <path> 宿主认不出坐标系`
    );
    assert.match(svg, /<\/svg>$/, `${id}: 标签要闭合`);
  }
});

test('品牌图标：路径带 fill-rule="evenodd" 与 fill="currentColor"（删了会静默画错）', () => {
  const table = registered();
  for (const [id, svg] of table) {
    const paths = svg.match(/<path[^>]*\/>/g) ?? [];
    assert.ok(paths.length >= 1, `${id}: 至少一条路径`);
    for (const p of paths) {
      assert.match(
        p,
        /fill-rule="evenodd"/,
        `${id}: 嵌套轮廓靠 evenodd 挖空 —— 用默认的 nonzero，酷狗的「圆环 + K」会填成一枚实心圆`
      );
      assert.match(p, /fill="currentColor"/, `${id}: 墨色要跟主题走（徽章给的是 --text-muted）`);
    }
  }
});

test('品牌图标：酷狗确实是三层嵌套轮廓（evenodd 不是随手加的）', () => {
  const table = registered();
  // 外圆 / 内圆 / K —— 三层。少于三条子路径，说明描摹或后处理被改坏了，
  // 那条 evenodd 也就失去了理由（真到那时应当连这条用例一起重新想）。
  const d = table.get('vinyl-brand-kugou').match(/ d="([^"]+)"/)[1];
  assert.ok(
    (d.match(/M/g) ?? []).length >= 3,
    '酷狗 = 圆环（外圆 + 内圆）+ K，共三条子路径'
  );
  // 网易云 / QQ 的标记也有内洞（唱针的留白），同样靠 evenodd
  for (const id of ['vinyl-brand-netease', 'vinyl-brand-qq']) {
    const dd = table.get(id).match(/ d="([^"]+)"/)[1];
    assert.ok(dd.length > 200, `${id}: 路径不该是退化成一个点`);
  }
});
