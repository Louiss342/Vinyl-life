// 网关客户端回归（本轮审计点名的零覆盖安全面）：src/core/server-client.ts / qq.ts / kugou.ts。
//
// 三个 Service 是同一套写法的三份拷贝 —— 网关会话 token（ServerManager 生成，网关据此放行，
// 见 server/gateway.js 的鉴权）由它们的 authHeaders() 注入，这是插件里唯一持有该 token 的地方。
// 此前 620 条用例没有一条碰过它们（同名测试 netease-search / qq-auth / kugou-auth 跑的都是网关侧）。
//
// 钉住四件事：
//   ① 每一个出站请求都带头 —— 含 DELETE 与封面下载这两条最容易漏的路径；
//   ② token 只进 header，不进 URL（URL 会进日志、进错误文案、进用户的复制粘贴）；
//   ③ base / token 都是回调，每次现取 —— 网关重启换端口、token 轮换之后仍要跟着走；
//   ④ 失败如实报错（带上 HTTP 状态与网关给的原因），不把错误当空结果吞掉；
//   ⑤ 出站请求有超时护栏（requestUrl 没有超时参数）：网关卡住时按超时拒绝，
//      而不是让界面一直转圈（见 core/request-error 的 withRequestTimeout）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const SOURCE = `export { ServerClient, songsToTracks } from '../src/core/server-client';
export { QqService, qqSongsToTracks } from '../src/core/qq';
export { KugouService, kugouSongsToTracks } from '../src/core/kugou';
export { setLanguage } from '../src/core/i18n';
export { GatewayError, isRateLimited } from '../src/core/request-error';`;

/** 一次加载三个客户端 + i18n（同一份 bundle：类身份与语言状态都通用） */
function load() {
  const source = esbuild.buildSync({
    stdin: { contents: SOURCE, resolveDir: __dirname, loader: 'ts' },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['obsidian'],
  }).outputFiles[0].text;

  const calls = [];
  // 超时护栏的定时器只在用例要求时触发：登记下来，由 fireTimers() 决定何时到点
  const timers = [];
  let respond = () => ({ status: 200, json: {} });
  const mod = { exports: {} };
  vm.runInNewContext(source, {
    module: mod,
    exports: mod.exports,
    require: (name) => {
      if (name === 'obsidian') {
        return {
          requestUrl: async (opts) => {
            calls.push(opts);
            const r = await respond(opts); // 允许挂住：超时护栏的用例就靠它模拟没应答的网关
            return {
              status: r.status,
              json: r.json ?? {},
              arrayBuffer: r.arrayBuffer ?? new ArrayBuffer(8),
            };
          },
        };
      }
      return require(name);
    },
    // 插件纪律：定时器走 window.*（弹出窗口场景下才指得对）。这里给一个可控的 window ——
    // 超时用例自己决定何时到点，其余用例的定时器永不触发
    window: {
      setTimeout: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimeout: (id) => {
        if (id > 0) timers[id - 1] = null;
      },
    },
    console,
    Buffer,
    process,
    Date,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    JSON,
    Math,
    Promise,
    ArrayBuffer,
    Uint8Array,
    TextDecoder,
    TextEncoder,
  });
  const fireTimers = () => {
    for (let i = 0; i < timers.length; i++) {
      const t = timers[i];
      if (!t) continue;
      timers[i] = null;
      t.fn();
    }
  };
  return { ...mod.exports, calls, timers, fireTimers, setRespond: (fn) => (respond = fn) };
}

const BASE = 'http://127.0.0.1:41234';
const TOKEN = 'tok-8f3a1c';
const base = () => BASE;
const token = () => TOKEN;

// —— ① + ④：三个客户端的「每个请求都带头 / token 不进 URL / 失败如实报错」——

const CLIENTS = [
  {
    name: '网易云 ServerClient',
    cls: 'ServerClient',
    calls: [
      { label: '专辑', path: '/api/album', query: 'id=12', run: (c) => c.album(12) },
      { label: '搜索', path: '/api/search', query: 'keywords=', run: (c) => c.searchAlbums('radio head') },
      { label: '登录态', path: '/api/login/status', run: (c) => c.loginStatus() },
      { label: '探活', path: '/api/ping', run: (c) => c.ping() },
      { label: '退出登录', path: '/api/cookie', method: 'DELETE', run: (c) => c.clearCookie() },
      { label: '封面下载', path: '/api/cover', run: (c) => c.fetchCover('http://img.example/a.jpg') },
    ],
  },
  {
    name: 'QQ QqService',
    cls: 'QqService',
    calls: [
      { label: '专辑', path: '/api/qq/album', query: 'id=mid1', run: (c) => c.album('mid1') },
      { label: '搜索', path: '/api/qq/search', run: (c) => c.search('jay') },
      { label: '登录态', path: '/api/qq/login/status', run: (c) => c.loginStatus() },
      { label: '退出登录', path: '/api/qq/cookie', method: 'DELETE', run: (c) => c.clearCookie() },
      { label: '取流', path: '/api/qq/song/url', run: (c) => c.songUrl('mid1', 'standard', 'media1') },
      { label: '歌词', path: '/api/qq/lyric', run: (c) => c.lyric('mid1') },
    ],
  },
  {
    name: '酷狗 KugouService',
    cls: 'KugouService',
    calls: [
      { label: '专辑', path: '/api/kugou/album', query: 'id=99', run: (c) => c.album('99') },
      { label: '搜索', path: '/api/kugou/search', run: (c) => c.search('老歌') },
      { label: '登录态', path: '/api/kugou/login/status', run: (c) => c.loginStatus() },
      { label: '退出登录', path: '/api/kugou/cookie', method: 'DELETE', run: (c) => c.clearCookie() },
      { label: '取流', path: '/api/kugou/song/url', run: (c) => c.songUrl('HASH', 'standard', '9', '77') },
      {
        label: '歌词',
        path: '/api/kugou/lyric',
        query: 'id=HASH',
        run: (c) => c.lyric('HASH', { title: '晴天', artist: '周杰伦', duration: 269, albumAudioId: '77' }),
      },
      {
        label: '扫码',
        path: '/api/kugou/login/qr/key',
        json: { data: { unikey: 'k1', qrimg: 'data:image/png;base64,AA' } },
        run: (c) => c.qrKey(),
      },
    ],
  },
];

for (const spec of CLIENTS) {
  test(`${spec.name}：每条出站请求都带 x-vinyl-token（token 不进 URL）`, async () => {
    const m = load();
    const client = new m[spec.cls](base, token);
    m.setRespond(() => ({ status: 200, json: { data: [{ url: 'http://cdn/x.mp3' }] } }));

    for (const c of spec.calls) {
      m.calls.length = 0;
      m.setRespond(() => ({ status: 200, json: c.json ?? { data: [{ url: 'http://cdn/x.mp3' }] } }));
      await c.run(client);
      assert.equal(m.calls.length, 1, `${c.label}：应发一个请求`);
      const sent = m.calls[0];
      assert.equal(
        sent.headers['x-vinyl-token'],
        TOKEN,
        `${c.label}：漏了 x-vinyl-token —— 网关会 401（token 是唯一凭据）`
      );
      assert.equal(sent.headers['x-vinyl-lang'], 'zh', `${c.label}：语言头要跟着 i18n 走`);
      assert.ok(sent.headers['x-vinyl-token'], `${c.label}：token 不能是空串`);
      assert.ok(sent.url.startsWith(BASE), `${c.label}：URL 要以网关 base 开头，实际 ${sent.url}`);
      assert.ok(sent.url.includes(c.path), `${c.label}：URL 要落到 ${c.path}，实际 ${sent.url}`);
      assert.ok(
        !sent.url.includes(TOKEN),
        `${c.label}：token 只能进 header —— URL 会进日志与错误文案，实际 ${sent.url}`
      );
      if (c.query) assert.ok(sent.url.includes(c.query), `${c.label}：查询串丢了，实际 ${sent.url}`);
      assert.equal(sent.method, c.method, `${c.label}：HTTP 方法不对`);
    }
  });

  test(`${spec.name}：网关给的原因原样透出，带上 HTTP 状态`, async () => {
    const m = load();
    const client = new m[spec.cls](base, token);
    m.setRespond(() => ({ status: 429, json: { error: '上游限流，请稍后再试' } }));
    await assert.rejects(
      () => spec.calls[0].run(client),
      (e) => {
        assert.ok(e instanceof m.GatewayError, `${spec.name}：应是 GatewayError`);
        assert.equal(e.status, 429, '状态码要带上（429 会让来源进冷却，见 request-error）');
        assert.equal(e.message, '上游限流，请稍后再试', '网关给的文案要原样透出');
        assert.equal(m.isRateLimited(e), true, '429 必须能被识别成限流');
        return true;
      }
    );
  });

  test(`${spec.name}：网关没给原因时，兜底文案含状态与路径（可排查）`, async () => {
    const m = load();
    const client = new m[spec.cls](base, token);
    m.setRespond(() => ({ status: 500, json: null }));
    await assert.rejects(
      () => spec.calls[0].run(client),
      (e) => {
        assert.equal(e.status, 500);
        assert.match(e.message, /500/, '兜底文案要含状态码');
        assert.match(e.message, new RegExp(spec.calls[0].path.replace(/\//g, '\\/')), '兜底文案要含路径');
        return true;
      }
    );
  });
}

// —— ③：base 与 token 是回调，每次现取 ——

test('base / token 每次请求现取：网关换端口、token 轮换后不用重建客户端', async () => {
  const m = load();
  let port = 41234;
  let tok = 'first';
  const client = new m.ServerClient(() => `http://127.0.0.1:${port}`, () => tok);
  m.setRespond(() => ({ status: 200, json: {} }));

  await client.loginStatus();
  assert.equal(m.calls[0].url, 'http://127.0.0.1:41234/api/login/status');
  assert.equal(m.calls[0].headers['x-vinyl-token'], 'first');

  port = 45000; // 网关重启换了端口
  tok = 'second'; // 会话 token 轮换
  await client.loginStatus();
  assert.equal(m.calls[1].url, 'http://127.0.0.1:45000/api/login/status', '端口要跟着回调变');
  assert.equal(m.calls[1].headers['x-vinyl-token'], 'second', 'token 要跟着回调变');
});

test('语言头跟着 i18n 设置走（中英各一次）', async () => {
  const m = load();
  const client = new m.ServerClient(base, token);
  m.setRespond(() => ({ status: 200, json: {} }));

  m.setLanguage('en');
  await client.loginStatus();
  assert.equal(m.calls[0].headers['x-vinyl-lang'], 'en');
  m.setLanguage('zh');
  await client.loginStatus();
  assert.equal(m.calls[1].headers['x-vinyl-lang'], 'zh');
});

// —— ④：音质阶梯（网易云专用；QQ / 酷狗的降级在网关侧）——

test('网易云取流：无损请求落空时逐级降档，返回实际到手的那一档', async () => {
  const m = load();
  const client = new m.ServerClient(base, token);
  const levels = [];
  m.setRespond((opts) => {
    const level = new URL(opts.url).searchParams.get('level');
    levels.push(level);
    // lossless 空（无 VIP）、exhigh 空、higher 有地址
    return level === 'higher'
      ? { status: 200, json: { data: [{ url: 'http://cdn/h.mp3', br: 320000, type: 'mp3' }] } }
      : { status: 200, json: { data: [{ url: null, code: 200 }] } };
  });

  const r = await client.songUrl(7, 'lossless');
  assert.deepEqual(levels, ['lossless', 'exhigh', 'higher'], '要从请求的档位逐级往下试');
  assert.equal(r.url, 'http://cdn/h.mp3');
  assert.equal(r.level, 'higher', '要如实报出实际到手的档位（不能冒充无损）');
  assert.equal(r.br, 320000);
});

test('网易云取流：明确的限制码直接返回文案，不再往下试（省请求）', async () => {
  const m = load();
  const client = new m.ServerClient(base, token);
  let n = 0;
  m.setRespond(() => {
    n++;
    return { status: 200, json: { data: [{ url: null, code: 403 }] } };
  });

  const r = await client.songUrl(7, 'lossless');
  assert.equal(n, 1, '有明确限制码时只发一个请求');
  assert.ok(r.restriction && r.restriction.length > 0, '要给出限制文案');
  assert.equal(r.url, undefined);
});

test('网易云取流：全部档位都空且无限制码 → 报音源不可用', async () => {
  const m = load();
  const client = new m.ServerClient(base, token);
  m.setRespond(() => ({ status: 200, json: { data: [{ url: null, code: 200 }] } }));
  const r = await client.songUrl(7, 'lossless');
  assert.equal(r.url, undefined);
  assert.ok(r.restriction, '不能返回一个没有原因的空结果');
});

test('网易云取流：未知档位从 higher 起（不静默按最高档请求）', async () => {
  const m = load();
  const client = new m.ServerClient(base, token);
  const levels = [];
  m.setRespond((opts) => {
    levels.push(new URL(opts.url).searchParams.get('level'));
    return { status: 200, json: { data: [{ url: 'http://cdn/x.mp3' }] } };
  });
  await client.songUrl(7, '不存在的档位');
  assert.equal(levels[0], 'higher');
});

// —— ④：封面下载要透出网关给的原因（图床超时 / 404 / 被拦要能分流）——

test('封面下载：失败时透出网关的原因，不带回半截数据', async () => {
  const m = load();
  const client = new m.ServerClient(base, token);
  m.setRespond(() => ({ status: 502, json: { error: '图床超时' } }));
  await assert.rejects(() => client.fetchCover('http://img.example/a.jpg'), /图床超时/);

  m.setRespond(() => ({ status: 200, json: {} }));
  const buf = await client.fetchCover('http://img.example/a.jpg');
  assert.ok(buf instanceof ArrayBuffer, '成功时要给回 ArrayBuffer');
});

// —— ④：二维码链路的失败不该静默（拿不到 key / 图就报错）——

test('网易云扫码：拿不到 unikey / 二维码图时报错，不返回半成品', async () => {
  const m = load();
  const client = new m.ServerClient(base, token);
  m.setRespond(() => ({ status: 200, json: { data: {} } }));
  await assert.rejects(() => client.qrKey(), /unikey/);
  await assert.rejects(() => client.qrCreate('k'), /二维码/);
});

test('QQ / 酷狗扫码：同样在缺件时报错（文案分来源）', async () => {
  const m = load();
  m.setRespond(() => ({ status: 200, json: { data: {} } }));
  await assert.rejects(() => new m.QqService(base, token).qrKey(), /QQ/);
  await assert.rejects(() => new m.KugouService(base, token).qrKey(), /酷狗/);
});

test('QQ 搜索：requiresLogin 要抛错（未登录时不能静默返回空列表）', async () => {
  const m = load();
  const client = new m.QqService(base, token);
  m.setRespond(() => ({ status: 200, json: { requiresLogin: true, data: [] } }));
  await assert.rejects(() => client.search('jay'), /登录/);
});

// —— 曲目归一化（三个来源各一套）——

test('songsToTracks：网易云曲目 → 统一 Track', () => {
  const m = load();
  const [t] = m.songsToTracks(
    [{ id: 5, name: '歌', ar: [{ name: 'A' }, { name: 'B' }], al: { name: '专辑', picUrl: 'http://c/x.jpg' }, dt: 245000 }],
    'notes/x.md'
  );
  assert.equal(t.source, 'netease');
  assert.equal(t.id, 5);
  assert.equal(t.artist, 'A / B', '多艺人按 / 拼接');
  assert.equal(t.album, '专辑');
  assert.equal(t.duration, 245, '毫秒 → 秒');
  assert.equal(t.albumNotePath, 'notes/x.md');
  assert.equal(m.songsToTracks(undefined).length, 0, '缺字段时返回空数组而不是崩');
});

test('qqSongsToTracks / kugouSongsToTracks：字段归一 + hash 归一化', () => {
  const m = load();
  const [q] = m.qqSongsToTracks([{ mid: 'm1', mediaMid: 'mm', name: 'q', interval: 200, pay: 1, trial: true }]);
  assert.equal(q.id, 'm1');
  assert.equal(q.mediaMid, 'mm');
  assert.equal(q.duration, 200, 'QQ 的 interval 已是秒');
  assert.equal(q.pay, 1);
  assert.equal(q.trial, true);

  const [k] = m.kugouSongsToTracks([{ hash: 'AB12CD', albumId: 9, albumAudioId: 77, name: 'k', duration: 180 }]);
  assert.equal(k.id, 'ab12cd', '酷狗 hash 一律小写（网关与笔记里的写法要对齐）');
  assert.equal(k.albumId, '9');
  assert.equal(k.albumAudioId, '77');
  assert.equal(k.duration, 180);
});

// —— ⑤：出站请求的超时护栏 ——
// requestUrl 没有超时参数：网关卡住时（进程僵住 / 端口被占却没人应答）这个 Promise 永远
// 不落地，界面就跟着一直转圈，而错误处理链一次都不会触发。三条用例钉住：会拒绝、
// 拒绝时的话说得清（状态码 0，与 429 / 404 那几条分开）、响应回来时把定时器清掉。

test('请求超时：网关卡住时按超时拒绝（界面不再一直转圈）', async () => {
  const { ServerClient, calls, fireTimers, setRespond } = load();
  setRespond(() => new Promise(() => {})); // 永远不落地 = 网关卡死
  const c = new ServerClient(base, token);
  let failed = null;
  const p = c.album(1).catch((e) => (failed = e));
  await Promise.resolve(); // 请求已经发出去，挂在网上
  fireTimers(); // 到点
  await p;
  assert.equal(calls.length, 1, '请求确实发出去了（不是没发就报错）');
  assert.ok(failed, '必须拒绝，而不是永远挂着');
  assert.equal(failed.status, 0, '不是 HTTP 错误：状态码 0 让它与限流 429 / 未找到 404 分得开');
  assert.match(String(failed.message), /超时|timed out/);
});

test('就绪探测走短超时：本地端口上问一句「你在吗」，不该等 30 秒', async () => {
  const { ServerClient, timers, fireTimers, setRespond } = load();
  setRespond(() => new Promise(() => {}));
  const c = new ServerClient(base, token);
  const p = c.ping().catch(() => {});
  await Promise.resolve();
  assert.equal(timers.length, 1, '登记了超时定时器');
  assert.equal(timers[0].ms, 2000, 'ping 用 PING_TIMEOUT_MS（2s），不是默认的 30s');
  fireTimers();
  await p;
});

test('正常响应：超时定时器被清掉（不留悬挂的计时器）', async () => {
  const { ServerClient, timers, setRespond } = load();
  setRespond(() => ({ status: 200, json: { ok: 1 } }));
  const c = new ServerClient(base, token);
  await c.album(1);
  assert.equal(timers.length, 1, '登记过一个超时定时器');
  assert.equal(timers[0], null, '响应回来后必须清掉');
});
