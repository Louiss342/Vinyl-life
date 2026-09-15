// 专辑导入回归：esbuild 编译真实 src/import.ts 后在 vm 执行（stub obsidian + 假 vault），
// 覆盖「导入专辑」双来源：链接识别 / 派发 / 建笔记字段 / 查重 / 失败不落笔记。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const source = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/import.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['obsidian'],
}).outputFiles[0].text;

const NETEASE_URL = 'https://music.163.com/#/album?id=437968';
const QQ_MID = '004VSvF52mQoQp';
const QQ_URL = `https://y.qq.com/n/ryqq/albumDetail/${QQ_MID}`;

// —— 极简 frontmatter 读取（只取本用例关心的键）——
function readFm(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(content || ''));
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const v = kv[2].trim();
    if (v.startsWith('[')) {
      fm[kv[1]] = v
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      fm[kv[1]] = v.replace(/^"|"$/g, '');
    }
  }
  return fm;
}

class TFile {
  constructor(p, content) {
    this.path = p;
    // 与 Obsidian TFile 一致：basename 无扩展名（查重提示文案依赖它）
    this.basename = p.split('/').pop().replace(/\.md$/, '');
    this._content = content;
  }
}

function setup() {
  const files = new Map();
  const binaries = new Map();
  const calls = { qqAlbum: [], neteaseAlbum: [], covers: [], notices: [] };

  // 目录单独登记（不混进 getMarkdownFiles），模拟 Obsidian「createFolder 逐级建目录」
  const folders = new Set();
  // 与 Obsidian 一致：父目录不存在时 vault.create / createBinary 直接抛错
  const assertParent = (p) => {
    const i = String(p).lastIndexOf('/');
    if (i > 0 && !folders.has(String(p).slice(0, i))) {
      throw new Error(`ENOENT: 父目录不存在 ${p}`);
    }
  };
  const vault = {
    getAbstractFileByPath: (p) =>
      files.get(p) || (folders.has(p) ? { path: p, children: [] } : null),
    getMarkdownFiles: () => [...files.values()],
    read: async (f) => f._content ?? '',
    createFolder: async (p) => {
      let cur = '';
      for (const part of String(p).split('/')) {
        cur = cur ? `${cur}/${part}` : part;
        folders.add(cur);
      }
      return { path: p, children: [] };
    },
    create: async (p, content) => {
      assertParent(p);
      const f = new TFile(p, content);
      files.set(p, f);
      return f;
    },
    createBinary: async (p, ab) => {
      assertParent(p);
      binaries.set(p, ab);
      files.set(p, new TFile(p, null));
      return files.get(p);
    },
  };
  const app = {
    vault,
    // importLocalAudio 落库后要写 frontmatter（本地导入用例依赖）
    fileManager: {
      processFrontMatter: async (file, fn) => {
        const fm = {};
        fn(fm);
        file._fm = fm;
      },
    },
    metadataCache: {
      getFileCache: (f) => {
        const fm = readFm(f._content);
        return Object.keys(fm).length ? { frontmatter: fm } : null;
      },
    },
  };

  // 稳定的设置对象（测试可改，如 albumNoteTemplate）
  const settings = {
    albumFolder: 'Vinyl Life/Vinyl Note',
    coverFolder: 'Vinyl Life/covers',
    audioFolder: 'Vinyl Life/audio',
    importMode: 'copy',
    albumNoteTemplate: '',
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: (name) => {
      if (name === 'obsidian') {
        return {
          App: class {},
          TFile,
          TFolder: class {},
          normalizePath: (p) => p,
          // 封面失败提示走 Notice：这里收集下来（断言「失败可见」）
          Notice: class {
            constructor(message) {
              calls.notices.push(String(message));
            }
          },
          Plugin: class {},
          Modal: class {},
        };
      }
      return require(name);
    },
    console,
    Buffer,
    URL,
    fetch: async () => {
      throw new Error('unexpected network call in test');
    },
  });
  const mod = module.exports;

  const neteaseAlbum = {
    code: 200,
    album: {
      name: 'Abbey Road (Remastered)',
      artist: { name: 'The Beatles' },
      publishTime: 1442188800000,
      picUrl: 'https://p1.music.126.net/cover.jpg',
    },
    songs: [{}, {}],
  };
  const qqAlbum = {
    code: 0,
    data: {
      album: {
        mid: QQ_MID,
        name: '未完成',
        artist: '孙燕姿',
        coverUrl: `https://y.gtimg.cn/music/photo_new/T002R300x300M000${QQ_MID}.jpg`,
        publishTime: '2002-05-01',
        trackCount: 11,
      },
      songs: [],
    },
  };

  const ctx = {
    app,
    settings: () => settings,
    client: {
      album: async (id) => {
        calls.neteaseAlbum.push(id);
        return neteaseAlbum;
      },
      fetchCover: async (url) => {
        calls.covers.push(url);
        return new ArrayBuffer(8);
      },
    },
    qq: {
      album: async (mid) => {
        calls.qqAlbum.push(mid);
        return qqAlbum;
      },
    },
  };

  return { mod, ctx, files, folders, binaries, calls, app, settings };
}

// ============ 链接识别 ============

test('parseAlbumInput：网易云链接 / 纯数字 ID', () => {
  const h = setup();
  assert.deepEqual({ ...h.mod.parseAlbumInput(NETEASE_URL) }, { source: 'netease', id: 437968 });
  assert.deepEqual({ ...h.mod.parseAlbumInput('437968') }, { source: 'netease', id: 437968 });
  assert.deepEqual({ ...h.mod.parseAlbumInput('  437968  ') }, { source: 'netease', id: 437968 });
});

test('parseAlbumInput：QQ 音乐 新版 / 旧版 / 纯 mid', () => {
  const h = setup();
  assert.deepEqual({ ...h.mod.parseAlbumInput(QQ_URL) }, { source: 'qq', mid: QQ_MID });
  assert.deepEqual(
    { ...h.mod.parseAlbumInput(`https://y.qq.com/n/ryqq/album/${QQ_MID}.html`) },
    { source: 'qq', mid: QQ_MID }
  );
  assert.deepEqual({ ...h.mod.parseAlbumInput(QQ_MID) }, { source: 'qq', mid: QQ_MID });
});

test('parseAlbumInput：无法识别时返回 undefined', () => {
  const h = setup();
  for (const bad of ['', '   ', '随便一句话', 'https://example.com/song/123']) {
    assert.equal(h.mod.parseAlbumInput(bad), undefined, `不应识别：${bad}`);
  }
});

// ============ 派发与建笔记 ============

test('本地导入：不支持的格式 / 已存在 分开计数（不再混为「跳过重复」）', async () => {
  const h = setup();
  const album = { title: 'A', file: { path: 'Vinyl Life/Vinyl Note/A.md' } };
  h.files.set('Vinyl Life/audio/A/dup.wav', { path: 'Vinyl Life/audio/A/dup.wav' });
  const files = [
    new File(['x'], 'ok.wav'),
    new File(['x'], 'bad.ape'),
    new File(['x'], 'dup.wav'),
  ];
  const res = await h.mod.importLocalAudio(h.ctx, album, files, 'copy');
  assert.deepEqual(Array.from(res.added), ['Vinyl Life/audio/A/ok.wav'], '只导入受支持且不重复的');
  assert.deepEqual(Array.from(res.skippedUnsupported), ['bad.ape'], '不支持格式单独成列');
  assert.deepEqual(Array.from(res.skippedExisting), ['dup.wav'], '已存在单独成列');
});

test('文件夹导入：复制模式保留子目录结构（同名文件不再互相「已存在」）', async () => {
  const h = setup();
  const album = { title: 'A', file: { path: 'Vinyl Life/Vinyl Note/A.md' } };
  const mk = (name, rel) => {
    const f = new File(['x'], name);
    Object.defineProperty(f, 'webkitRelativePath', { value: rel });
    return f;
  };
  const files = [
    mk('01.flac', 'Abbey Road/CD1/01.flac'),
    mk('01.flac', 'Abbey Road/CD2/01.flac'),
  ];
  const res = await h.mod.importLocalAudio(h.ctx, album, files, 'copy');
  assert.deepEqual(
    Array.from(res.added).sort(),
    ['Vinyl Life/audio/A/CD1/01.flac', 'Vinyl Life/audio/A/CD2/01.flac'],
    '两个 CD 里的同名曲各自落位'
  );
  assert.deepEqual(Array.from(res.skippedExisting), [], '不把同名文件误判成重复');
});

test('模板：可用设置指定的模板文件（占位符替换 + 落空行清理）', async () => {
  const h = setup();
  h.files.set(
    '模板/album.md',
    new TFile(
      '模板/album.md',
      '---\ntags: [album]\nartist: ""\n{{audioFolder}}\nnote: {{title}} @ {{date}}\n---\n\n## 感想\n'
    )
  );
  h.settings.albumNoteTemplate = '模板/album.md';
  await h.mod.createAlbumFromFiles(h.ctx, [new File(['x'], '01.flac')], 'A', 'copy');
  const c = h.files.get('Vinyl Life/Vinyl Note/A.md')._content;
  assert.match(c, /audioFolder: "\[\[Vinyl Life\/audio\/A\]\]"/, '占位符填入音频目录');
  assert.match(c, /note: A @ \d{4}-\d{2}-\d{2}/, '标题与日期占位符');
  assert.doesNotMatch(c, /\{\{/, '不得残留占位符');
  assert.match(c, /## 感想/, '模板正文保留');

  // 外链模式：{{audioFolder}} 落空 → 整行被清掉，其他字段保留
  const h2 = setup();
  h2.files.set(
    '模板/album.md',
    new TFile('模板/album.md', '---\ntags: [album]\n{{audioFolder}}\nartist: ""\n---\n')
  );
  h2.settings.albumNoteTemplate = '模板/album.md';
  await h2.mod.createAlbumFromFiles(h2.ctx, [new File(['x'], 'b.flac')], 'B', 'link');
  const c2 = h2.files.get('Vinyl Life/Vinyl Note/B.md')._content;
  assert.doesNotMatch(c2, /audioFolder/, '落空的占位符行被清掉');
  assert.match(c2, /artist: ""/, '其他字段保留');
});

test('本地专辑骨架：属性齐备可填空 + 复制模式预写 audioFolder', async () => {
  const h = setup();
  await h.mod.createAlbumFromFiles(h.ctx, [new File(['x'], '01.flac')], 'A', 'copy');
  const note = h.files.get('Vinyl Life/Vinyl Note/A.md');
  assert.ok(note, '应建笔记');
  for (const key of ['artist', 'year', 'genre', 'rating', 'cover']) {
    assert.match(note._content, new RegExp(`^${key}: ""$`, 'm'), `${key} 应留空待填`);
  }
  assert.match(
    note._content,
    /audioFolder: "\[\[Vinyl Life\/audio\/A\]\]"/,
    '复制模式预写音频目录'
  );
  assert.match(note._content, /## 感想/, '正文留感想区');

  await h.mod.createAlbumFromFiles(h.ctx, [new File(['x'], 'b.flac')], 'B', 'link');
  const noteB = h.files.get('Vinyl Life/Vinyl Note/B.md');
  assert.doesNotMatch(noteB._content, /audioFolder/, '外链模式不预写 audioFolder');
});

test('从文件新建专辑：可指定专辑名（弹窗「新建专辑」路径）', async () => {
  const h = setup();
  const files = [new File(['x'], '01.flac'), new File(['x'], '02.flac')];
  const album = await h.mod.createAlbumFromFiles(h.ctx, files, 'Abbey Road');
  assert.equal(album?.title, 'Abbey Road', '专辑名以指定值为准');
  assert.ok(h.files.has('Vinyl Life/Vinyl Note/Abbey Road.md'), '笔记落在专辑目录下');
  const again = await h.mod.createAlbumFromFiles(h.ctx, files, 'Abbey Road');
  assert.equal(again?.title, 'Abbey Road', '同名已存在 → 复用而不是报错');
});

test('导入专辑：目标目录不存在时自动创建（新装用户回归）', async () => {
  const h = setup();
  h.folders.clear(); // 模拟全新 vault：专辑 / 封面目录都还不存在
  const res = await h.mod.importAlbum(h.ctx, NETEASE_URL);
  assert.equal(res.ok, true, res.detail);
  assert.ok(h.folders.has('Vinyl Life/Vinyl Note'), '应自动创建专辑目录');
  assert.ok(h.folders.has('Vinyl Life/covers'), '应自动创建封面目录');
  assert.ok(h.files.has('Vinyl Life/Vinyl Note/Abbey Road (Remastered).md'), '应建立专辑笔记');
});

test('导入专辑：网易云链接 → 走网易云，字段与既有行为一致（回归）', async () => {
  const h = setup();
  const res = await h.mod.importAlbum(h.ctx, NETEASE_URL);
  assert.equal(res.ok, true, res.detail);
  assert.deepEqual(h.calls.neteaseAlbum, [437968]);
  assert.equal(h.calls.qqAlbum.length, 0, '不得误走 QQ 接口');
  const note = h.files.get('Vinyl Life/Vinyl Note/Abbey Road (Remastered).md');
  assert.ok(note, '应建立专辑笔记');
  assert.match(note._content, /tags: \[album\]/);
  assert.match(note._content, /neteaseId: 437968/);
  assert.match(note._content, /netease: "https:\/\/music\.163\.com\/#\/album\?id=437968"/);
  assert.doesNotMatch(note._content, /qqId:/, '网易云导入不得写入 qqId');
  assert.match(note._content, /cover: "\[\[Vinyl Life\/covers\/Abbey Road \(Remastered\)\.jpg\]\]"/);
  assert.ok(h.binaries.has('Vinyl Life/covers/Abbey Road (Remastered).jpg'));
});

test('导入专辑：艺人名含引号 / 反斜杠时 frontmatter 仍合法（YAML 转义）', async () => {
  const h = setup();
  const artist = 'AC"DC\Backslash';
  h.ctx.client.album = async () => ({
    code: 200,
    album: {
      name: 'Edge Case',
      artist: { name: artist },
      publishTime: 1442188800000,
      picUrl: 'https://p1.music.net/cover.jpg',
    },
    songs: [],
  });
  const res = await h.mod.importAlbum(h.ctx, NETEASE_URL);
  assert.equal(res.ok, true, res.detail);
  const note = h.files.get('Vinyl Life/Vinyl Note/Edge Case.md');
  assert.ok(note, '应建立专辑笔记');
  assert.ok(
    note._content.includes('artist: ' + JSON.stringify(artist)),
    '艺人名必须按 YAML 双引号规则转义，否则整段 frontmatter 解析失败、专辑从墙上消失'
  );
  assert.doesNotMatch(note._content, /artist: "AC"DC/, '不得原样写入未转义的引号');
});

test('导入专辑：QQ 音乐链接 → 走 QQ，写出 qqId / qq 链接 / 封面（无 netease 字段）', async () => {
  const h = setup();
  const res = await h.mod.importAlbum(h.ctx, QQ_URL);
  assert.equal(res.ok, true, res.detail);
  assert.deepEqual(h.calls.qqAlbum, [QQ_MID]);
  assert.equal(h.calls.neteaseAlbum.length, 0, '不得误走网易云接口');
  const note = h.files.get('Vinyl Life/Vinyl Note/未完成.md');
  assert.ok(note, '应建立专辑笔记');
  assert.match(note._content, /tags: \[album\]/);
  assert.match(note._content, new RegExp(`qqId: ${QQ_MID}`));
  assert.match(note._content, new RegExp(`qq: "https://y\\.qq\\.com/n/ryqq/albumDetail/${QQ_MID}"`));
  assert.match(note._content, /artist: "孙燕姿"/);
  assert.match(note._content, /year: 2002/, 'QQ 的 aDate 应转成 4 位年份');
  assert.doesNotMatch(note._content, /neteaseId:/, 'QQ 导入不得写入 neteaseId');
  assert.ok(h.binaries.has('Vinyl Life/covers/未完成.jpg'), '封面应落盘');
  assert.match(res.detail, /11 曲/);
});

test('导入专辑：纯 mid / 旧版链接同样可导入', async () => {
  const h1 = setup();
  assert.equal((await h1.mod.importAlbum(h1.ctx, QQ_MID)).ok, true);
  const h2 = setup();
  assert.equal(
    (await h2.mod.importAlbum(h2.ctx, `https://y.qq.com/n/ryqq/album/${QQ_MID}.html`)).ok,
    true
  );
});

// ============ 封面图床回退（y.gtimg.cn 不可达的机器） ============

const QQ_COVER = `https://y.gtimg.cn/music/photo_new/T002R300x300M000${QQ_MID}.jpg`;
const QQ_COVER_MIRROR = `https://y.qq.com/music/photo_new/T002R300x300M000${QQ_MID}.jpg`;

test('导入专辑：主图床失败 → 自动换备用图床（y.qq.com），封面照常落库', async () => {
  const h = setup();
  h.ctx.client.fetchCover = async (url) => {
    h.calls.covers.push(url);
    if (String(url).includes('y.gtimg.cn')) throw new Error('封面地址连接失败或超时（y.gtimg.cn）');
    return new ArrayBuffer(8);
  };
  const res = await h.mod.importAlbum(h.ctx, QQ_URL);
  assert.equal(res.ok, true, res.detail);
  assert.deepEqual(
    Array.from(h.calls.covers),
    [QQ_COVER, QQ_COVER_MIRROR],
    '先试主图床，失败后再试备用图床'
  );
  const note = h.files.get('Vinyl Life/Vinyl Note/未完成.md');
  assert.match(note._content, /cover: "\[\[Vinyl Life\/covers\/未完成\.jpg\]\]"/);
  assert.ok(h.binaries.has('Vinyl Life/covers/未完成.jpg'), '备用图床取到的图应落库');
  assert.deepEqual(Array.from(h.calls.notices), [], '回退成功不该打扰用户');
});

test('导入专辑：两个图床都失败 → 专辑照建、不留 cover 字段、给出可见提示（不再静默）', async () => {
  const h = setup();
  h.ctx.client.fetchCover = async (url) => {
    h.calls.covers.push(url);
    throw new Error('封面地址连接失败或超时（y.gtimg.cn）');
  };
  const res = await h.mod.importAlbum(h.ctx, QQ_URL);
  assert.equal(res.ok, true, '封面失败不影响专辑建好：' + res.detail);
  const note = h.files.get('Vinyl Life/Vinyl Note/未完成.md');
  assert.ok(note, '应建立专辑笔记');
  assert.doesNotMatch(note._content, /^cover:/m, '拿不到图就不写 cover 字段');
  assert.equal(h.calls.covers.length, 2, '两个候选都试过才放弃');
  assert.equal(h.calls.notices.length, 1, '失败必须可见（一条 Notice）');
  assert.match(h.calls.notices[0], /封面下载失败/);
  assert.match(h.calls.notices[0], /连接失败或超时/, '提示里要带原因');
});

// ============ 查重 ============

test('导入专辑：已存在同 qqId 的笔记 → 指路而不新建', async () => {
  const h = setup();
  h.files.set(
    'Vinyl Life/Vinyl Note/未完成.md',
    new TFile('Vinyl Life/Vinyl Note/未完成.md', `---\ntags: [album]\nqqId: ${QQ_MID}\n---\n`)
  );
  const res = await h.mod.importAlbum(h.ctx, QQ_URL);
  assert.equal(res.ok, false);
  assert.match(res.detail, /已存在「未完成」/, '提示里应带既有笔记标题');
  assert.equal(res.file?.path, 'Vinyl Life/Vinyl Note/未完成.md');
  assert.equal(h.calls.qqAlbum.length, 0, '查重命中不应再打接口');
});

test('导入专辑：已存在同 neteaseId 的笔记 → 指路而不新建（回归）', async () => {
  const h = setup();
  h.files.set(
    'Vinyl Life/Vinyl Note/Abbey Road (Remastered).md',
    new TFile('Vinyl Life/Vinyl Note/Abbey Road (Remastered).md', '---\ntags: [album]\nneteaseId: 437968\n---\n')
  );
  const res = await h.mod.importAlbum(h.ctx, NETEASE_URL);
  assert.equal(res.ok, false);
  assert.match(res.detail, /已存在/);
});

// ============ 失败路径 ============

test('导入专辑：无法识别的链接 → 提示两种来源，不建笔记', async () => {
  const h = setup();
  const res = await h.mod.importAlbum(h.ctx, 'https://example.com/whatever');
  assert.equal(res.ok, false);
  assert.match(res.detail, /网易云/);
  assert.match(res.detail, /QQ 音乐/);
  assert.equal(h.files.size, 0);
  assert.equal(h.calls.qqAlbum.length + h.calls.neteaseAlbum.length, 0);
});

test('导入专辑：QQ 专辑无效（1101）→ 友好失败且不建笔记', async () => {
  const h = setup();
  h.ctx.qq.album = async () => ({ code: 1101, msg: '专辑不存在或 albummid 无效', data: { album: null, songs: [] } });
  const res = await h.mod.importAlbum(h.ctx, QQ_URL);
  assert.equal(res.ok, false);
  assert.match(res.detail, /专辑不存在/);
  assert.doesNotMatch(res.detail, /albummid index|TypeError/, '不得泄漏上游术语');
  assert.equal(h.files.size, 0);
});

test('导入专辑：接口抛错 → 中文失败信息，不建笔记', async () => {
  const h = setup();
  h.ctx.qq.album = async () => {
    throw new Error('网关未就绪');
  };
  const res = await h.mod.importAlbum(h.ctx, QQ_URL);
  assert.equal(res.ok, false);
  assert.match(res.detail, /获取专辑失败/);
  assert.equal(h.files.size, 0);
});
