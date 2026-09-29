// 「设置封面 → 从电脑上选图片」的落点回归（真弹窗 + 假 DOM / 假 vault）：
//   同名专辑（笔记可在任意目录，重名只在导入时挡过）里，第二张不能就地覆盖第一张用着的图 —— 覆盖不进回收站、原笔记的 wikilink 仍指着它（两张同图、原图找不回来）；
//   「换封面」的正常路径（本专辑 cover 指着那个文件）则就地覆盖不留垃圾，反复换也只用本专辑自己的「标题 2.jpg」不越堆越多。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

function fakeEl(tag = 'div') {
  const el = {
    tag,
    children: [],
    attrs: new Map(),
    classes: new Set(),
    textContent: '',
    listeners: new Map(),
    files: [],
    empty() {
      el.children = [];
      return el;
    },
    addClass(...names) {
      for (const n of String(names.join(' ')).split(/\s+/).filter(Boolean)) el.classes.add(n);
      return el;
    },
    setAttribute(k, v) {
      el.attrs.set(k, String(v));
      return el;
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
    addEventListener(type, fn) {
      if (!el.listeners.has(type)) el.listeners.set(type, []);
      el.listeners.get(type).push(fn);
    },
    click() {
      el.clicked = true;
    },
    remove() {},
  };
  return el;
}

const collect = (el, out = []) => {
  out.push(el);
  for (const c of el.children) collect(c, out);
  return out;
};

const fire = (el, type, ev = {}) => {
  for (const fn of el.listeners.get(type) || []) fn({ preventDefault() {}, ...ev });
};

/** 放行若干轮微任务：pickLocal 是 async 链（arrayBuffer → createBinary → processFrontMatter） */
async function flush(times = 6) {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

const COVERS = 'Vinyl Life/covers';

function setup(existing = []) {
  const source = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '../src/views/set-cover-modal.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text;

  class TFile {
    constructor(p) {
      this.path = p;
      this.name = p.split('/').pop();
    }
  }
  const files = new Map(existing.map((p) => [p, new TFile(p)]));
  const folders = new Set();
  const calls = { created: [], modified: [], fm: [] };

  const app = {
    vault: {
      getAbstractFileByPath: (p) =>
        files.get(p) || (folders.has(p) ? { path: p, children: [] } : null),
      createFolder: async (p) => {
        folders.add(p);
      },
      createBinary: async (p) => {
        calls.created.push(p);
        const f = new TFile(p);
        files.set(p, f);
        return f;
      },
      modifyBinary: async (f) => {
        calls.modified.push(f.path);
      },
      getResourcePath: (f) => 'app://local/' + f.path,
    },
    metadataCache: {
      // 与 Obsidian 一致：wikilink 按 linkpath 解析（全路径 / 后缀 / 裸文件名）
      getFirstLinkpathDest: (link) => {
        if (files.has(link)) return files.get(link);
        for (const f of files.values()) if (f.path.endsWith('/' + link)) return f;
        return null;
      },
    },
    fileManager: {
      processFrontMatter: async (_file, fn) => {
        const fm = {};
        fn(fm);
        calls.fm.push(fm);
      },
    },
  };

  class Modal {
    constructor(a) {
      this.app = a;
      this.contentEl = fakeEl();
      this.titleEl = fakeEl();
      this.modalEl = fakeEl();
      this.closed = false;
    }
    open() {
      void this.onOpen();
    }
    close() {
      this.closed = true;
    }
  }

  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: (name) =>
      name === 'obsidian'
        ? {
            App: class {},
            TFile,
            FuzzySuggestModal: class {},
            Modal,
            Notice: class {},
            normalizePath: (p) => p,
          }
        : require(name),
    console,
    Buffer,
    setTimeout,
    clearTimeout,
    Promise,
    window: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: () => {} },
    document: { createElement: (tag) => fakeEl(tag) },
  };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(source, sandbox);

  const plugin = { settings: { coverFolder: COVERS } };

  const chooseLocal = async (album, name = 'pic.jpg') => {
    const modal = new sandbox.module.exports.SetCoverModal(app, plugin, album);
    modal.open();
    await flush(1);
    const input = collect(modal.contentEl).find((el) => el.tag === 'input');
    input.files = [new File(['bytes'], name)];
    fire(input, 'change');
    await flush();
    return modal;
  };

  return { chooseLocal, calls };
}

const album = (title, notePath, coverRaw) => ({
  title,
  path: notePath,
  coverRaw,
  file: { path: notePath },
});

test('同名专辑：封面目录里已有别人的同名图 → 另取「标题 (2).jpg」，既有文件一个字节都不动', async () => {
  const h = setup([`${COVERS}/Greatest Hits.jpg`]);
  await h.chooseLocal(album('Greatest Hits', 'Archive/Greatest Hits.md'));

  assert.deepEqual(h.calls.modified, [], '不得就地覆盖：那是另一张同名笔记正用着的图');
  assert.deepEqual(h.calls.created, [`${COVERS}/Greatest Hits (2).jpg`], '按 (2) 命名口径另取一个位置');
  assert.equal(
    h.calls.fm[0].cover,
    `[[${COVERS}/Greatest Hits (2).jpg]]`,
    '笔记指向新文件（不是那张要保住的图）'
  );
});

test('换扩展名：新版同名图是别人的 → 另取 (2)，两张既有图都不动', async () => {
  const h = setup([`${COVERS}/A.jpg`, `${COVERS}/A.png`]);
  await h.chooseLocal(album('A', 'Albums/A.md', `[[${COVERS}/A.png]]`));

  assert.deepEqual(h.calls.modified, [], '本专辑那一张是 .png，与这次要写的 .jpg 无关');
  assert.deepEqual(h.calls.created, [`${COVERS}/A (2).jpg`]);
  assert.equal(h.calls.fm[0].cover, `[[${COVERS}/A (2).jpg]]`);
});

test('换封面：本专辑的 cover 就指着那个文件 → 就地覆盖，不新建', async () => {
  const h = setup([`${COVERS}/A.jpg`]);
  await h.chooseLocal(album('A', 'Albums/A.md', `[[${COVERS}/A.jpg]]`));

  assert.deepEqual(h.calls.modified, [`${COVERS}/A.jpg`], '「换封面」的正常路径');
  assert.deepEqual(h.calls.created, [], '不新建多余文件');
});

test('反复换封面：沿用本专辑自己的「标题 (2).jpg」，不一路堆到 3、4', async () => {
  const h = setup([`${COVERS}/A.jpg`, `${COVERS}/A (2).jpg`]);
  await h.chooseLocal(album('A', 'Albums/A.md', `[[${COVERS}/A (2).jpg]]`));

  assert.deepEqual(h.calls.modified, [`${COVERS}/A (2).jpg`]);
  assert.deepEqual(h.calls.created, []);
});
