// 「导完一批、留在原地接着导下一批」的行为回归（驱动真实的 LocalImportPane + 假 DOM）：
//   这条流程以前是假的 —— reset() 把空列表喂给 applyFiles，而那个入口见到空列表就 return，
//   于是摘要、专辑名、勾选状态全留在原地，再点「开始导入」会拿上一批的旧列表重跑。
//   用例从「喂进一批文件」开始，到「reset 之后看不见任何上一批的痕迹」结束。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

// ============ 假 DOM（与 import-batch.test.cjs 同一套：够面板用）============
function fakeEl(tag = 'div') {
  const el = {
    tag,
    children: [],
    attrs: new Map(),
    classes: new Set(),
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    listeners: new Map(),
    style: {},
    empty() {
      el.children = [];
      return el;
    },
    addClass(...names) {
      for (const n of String(names.join(' ')).split(/\s+/).filter(Boolean)) el.classes.add(n);
      return el;
    },
    removeClass(...names) {
      for (const n of String(names.join(' ')).split(/\s+/).filter(Boolean)) el.classes.delete(n);
      return el;
    },
    toggleClass(name, on) {
      const want = on === undefined ? !el.classes.has(name) : !!on;
      if (want) el.classes.add(name);
      else el.classes.delete(name);
      return el;
    },
    setAttribute(k, v) {
      el.attrs.set(k, String(v));
      return el;
    },
    setAttr(k, v) {
      return el.setAttribute(k, v);
    },
    getAttribute(k) {
      return el.attrs.has(k) ? el.attrs.get(k) : null;
    },
    setText(t) {
      el.textContent = String(t);
      return el;
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
    createDiv(o) {
      return el.createEl('div', o);
    },
    createSpan(o) {
      return el.createEl('span', o);
    },
    addEventListener(type, fn) {
      if (!el.listeners.has(type)) el.listeners.set(type, []);
      el.listeners.get(type).push(fn);
    },
    removeEventListener() {},
    focus() {},
    blur() {},
    remove() {},
  };
  return el;
}

const collect = (el, out = []) => {
  out.push(el);
  for (const c of el.children) collect(c, out);
  return out;
};

function loadPane() {
  const source = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '../src/views/local-import-pane.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text;

  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: (name) => {
      if (name === 'obsidian') {
        return {
          TFile: class TFile {},
          TFolder: class TFolder {},
          Notice: class Notice {},
          normalizePath: (p) => p,
        };
      }
      return require(name);
    },
    console,
    Buffer,
    window: { setTimeout: () => 0, clearTimeout: () => {} },
    document: { createElement: (tag) => fakeEl(tag) },
    setTimeout,
    clearTimeout,
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(source, sandbox);
  return sandbox.module.exports;
}

const { LocalImportPane } = loadPane();

/** 造一批带相对路径的「文件」（选择文件夹时浏览器给的就是这个形状） */
const filesIn = (root, rels) =>
  rels.map((rel) => ({ name: rel.split('/').pop(), webkitRelativePath: `${root}/${rel}` }));

function mountPane(presetAlbum) {
  const container = fakeEl();
  const pane = new LocalImportPane(
    { settings: () => ({ importMode: 'copy' }) },
    [],
    presetAlbum,
    { onDone() {} }
  );
  pane.mount(container);
  const byClass = (cls) => collect(container).find((el) => el.classes.has(cls)) || null;
  const startBtn = () =>
    collect(container)
      .filter((el) => el.tag === 'button' && el.classes.has('mod-cta'))
      .pop() || null;
  return { pane, container, byClass, startBtn };
}

test('导完一批：reset 之后看不见上一批的任何痕迹', () => {
  const { pane, byClass, startBtn } = mountPane();
  pane.takeFiles(filesIn('Parachutes', ['01.flac', '02.flac']), 'Parachutes');

  assert.equal(pane.picked.length, 2, '先确认这批文件真的进来了');
  assert.match(byClass('vinyl-import-files').textContent, /Parachutes/, '摘要在');
  assert.equal(byClass('vinyl-import-input').value, 'Parachutes', '专辑名自动填成文件夹名');
  assert.equal(startBtn().textContent, '开始导入');

  pane.reset();

  assert.equal(pane.picked.length, 0, '已选文件清空');
  assert.equal(pane.rootName, '', '文件夹名清空');
  assert.equal(pane.scan, null, '文件夹分析结果清空');
  assert.equal(pane.nameTouched, false, '「名字被手动改过」的标记复位');
  assert.equal(pane.batchRows.length, 0, '音乐库模式的勾选行清空');
  assert.equal(
    byClass('vinyl-import-status').attrs.get('role'),
    'status',
    '导入进度行是 status 区（读屏软件才播报得到）'
  );
  assert.equal(byClass('vinyl-import-files').textContent, '', '摘要清空');
  assert.equal(byClass('vinyl-import-files').getAttribute('title'), '', '摘要的悬停清单清空');
  assert.equal(byClass('vinyl-import-input').value, '', '专辑名清空（下一批重新按文件夹名建议）');
  assert.equal(byClass('vinyl-import-status').textContent, '', '状态行清空');
  assert.equal(byClass('vinyl-import-batch').children.length, 0, '勾选区清空');
  assert.equal(startBtn().textContent, '开始导入');
});

test('上一批是音乐库根目录：reset 之后目标单选铺回来、按钮文案复位', () => {
  const { pane, byClass, startBtn } = mountPane();
  // 根目录没有音频、两个专辑子目录 → 音乐库模式
  pane.takeFiles(
    filesIn('MyLib', ['专辑A/01.flac', '专辑A/02.flac', '专辑B/01.flac', '专辑B/02.flac']),
    'MyLib'
  );

  assert.match(startBtn().textContent, /导入 2 张专辑|Import 2 albums/, '音乐库模式：按钮改成逐张导入');
  assert.ok(byClass('vinyl-import-batch').children.length > 0, '勾选区画出来了');
  const nameInput = byClass('vinyl-import-input');
  assert.ok(nameInput.classes.has('vinyl-hidden'), '目标单选被收起来（这一批按子目录逐张建）');

  pane.reset();

  assert.equal(byClass('vinyl-import-batch').children.length, 0, '勾选区清空');
  assert.ok(!nameInput.classes.has('vinyl-hidden'), '目标区铺回来（下一批可能是一张普通专辑）');
  assert.equal(startBtn().textContent, '开始导入', '按钮文案复位');
});
