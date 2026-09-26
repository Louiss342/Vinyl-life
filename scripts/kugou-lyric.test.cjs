// 酷狗歌词链路回归：vm 执行真实 server/gateway.js（连带真实 server/kugou.js），只替换 I/O。
// 与 kugou-auth.test.cjs 同一套 harness 约定：fetch 桩按 URL 分派、未识别 URL 直接 throw
//（防止实现偷偷换了端点而测试还绿着）。
//
// 这一条链路上最值得锁住的是**候选挑选**：上游按 score 排序，而 score 排的是歌词本身的热度、
// 不是与这首歌的匹配度 —— 实测同一个查询里排第一的是 UGC 上传（歌手字段是上传者昵称、
// 正文头部写着别人的名字）。取第一条就会拿错词，所以用例的夹具刻意把「对的」那条排在后面。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const { createRequire } = require('node:module');

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const LRC_TEXT = '[offset:0]\n[00:29.22]故事的小黄花\n[00:32.65]从出生那年就飘着';

function res({ status = 200, text = '' } = {}) {
  return {
    status,
    headers: { get: () => null, getSetCookie: () => [] },
    text: async () => text,
    arrayBuffer: async () => Buffer.from(text, 'utf8'),
    body: { cancel() {} },
  };
}
const json = (obj) => res({ text: JSON.stringify(obj) });

/** 上游候选：真实形态的一条（UGC 排在前、歌手对不上；对得上的那条在中间） */
function candidates() {
  return [
    { id: 'ugc-1', accesskey: 'KEY-UGC', song: '周杰伦 - 晴天', singer: 'hjt', duration: 269944, score: 60 },
    { id: 'good-2', accesskey: 'KEY-GOOD', song: '晴天', singer: '周杰伦', duration: 269818, score: 50 },
    { id: 'other-3', accesskey: 'KEY-OTHER', song: '晴天', singer: 'Hua满楼', duration: 269792, score: 40 },
  ];
}

function gateway(opts = {}) {
  const filename = path.resolve(__dirname, '../server/gateway.js');
  const requireFromGateway = createRequire(filename);
  const requests = [];
  const logs = [];

  const fetchStub = async (url, init = {}) => {
    const u = String(url);
    requests.push({ url: u, method: init.method || 'GET', headers: init.headers || {} });
    if (u.includes('krcs.kugou.com/search')) {
      if (opts.searchFails) throw new Error('network down');
      if (opts.searchEmpty) return json({ status: 200, candidates: [] });
      if (opts.searchRaw) return res({ text: '<html>not json</html>' });
      return json({ status: 200, candidates: opts.candidates || candidates() });
    }
    if (u.includes('lyrics.kugou.com/download')) {
      if (opts.downloadEmpty) return json({ status: 200, content: '' });
      if (opts.downloadRaw) return res({ text: 'not json either' });
      const text = opts.lyricText === undefined ? LRC_TEXT : opts.lyricText;
      return json({ status: 200, fmt: 'lrc', content: Buffer.from(text, 'utf8').toString('base64') });
    }
    throw new Error('unexpected fetch: ' + u);
  };

  const context = {
    require(name) {
      if (name === 'fs')
        return {
          readFileSync() {
            throw new Error('ENOENT');
          },
          writeFileSync() {},
          renameSync() {},
          unlinkSync() {},
          appendFileSync() {},
        };
      if (name === 'http') return { createServer: () => ({ listen() {}, on() {} }) };
      if (name === 'crypto') return nodeCrypto;
      return requireFromGateway(name);
    },
    process: {
      env: {
        VINYL_COOKIE_FILE: '/test/.cookie',
        VINYL_KUGOU_COOKIE_FILE: '/test/.kugou-cookie',
        VINYL_KUGOU_DEVICE_FILE: '/test/.kugou-device',
      },
      pid: 1,
    },
    __dirname: path.dirname(filename),
    console: {
      log: (...args) => logs.push(args.map((a) => String(a)).join(' ')),
      error: (...args) => logs.push(args.map((a) => String(a)).join(' ')),
    },
    Buffer,
    URL,
    URLSearchParams,
    AbortSignal: { timeout: () => ({}) }, // 避免真实计时器
    setTimeout,
    clearTimeout,
    fetch: fetchStub,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(filename, 'utf8') + '\nglobalThis.testRoutes = routes;', context);
  return {
    requests,
    logs,
    context,
    call(method, url, data = {}) {
      const [pathname, qs = ''] = url.split('?');
      const route = context.testRoutes.find((r) => r.method === method && r.pattern.test(pathname));
      assert.ok(route, `${method} ${url} exists`);
      const query = Object.fromEntries(new URLSearchParams(qs));
      return route.handler({ query, body: data, cookie: '' });
    },
  };
}

const lyricUrl = (extra = '') =>
  `/api/kugou/lyric?id=${HASH}&title=${encodeURIComponent('晴天')}&artist=${encodeURIComponent('周杰伦')}&duration=269${extra}`;

const urlOf = (r) => new URL(r.url);

// ============ 路由与契约 ============

test('kugou 歌词：路由已注册，且走 deps 注入的 fetch（vm 才替换得掉 I/O）', async () => {
  const g = gateway();
  const routes = g.context.testRoutes.map((r) => `${r.method} ${r.pattern.source}`);
  assert.ok(
    routes.includes('GET ^\\/api\\/kugou\\/lyric$'),
    'GET /api/kugou/lyric 已注册（新增音源能力必须挂在同一套鉴权路由上）'
  );
  await g.call('GET', lyricUrl());
  assert.ok(
    g.requests.every((r) => r.headers['User-Agent']),
    '两个上游都带 UA（krcs 不带 UA 会回空）'
  );
});

test('kugou 歌词：搜索请求带上 hash、时长（毫秒）、album_audio_id 与「歌手 曲名」关键词', async () => {
  const g = gateway();
  await g.call('GET', lyricUrl('&albumAudioId=456789'));
  const search = urlOf(g.requests[0]);
  assert.equal(search.host, 'krcs.kugou.com');
  assert.equal(search.pathname, '/search');
  assert.equal(search.searchParams.get('hash'), HASH, 'hash 是候选池的锚');
  assert.equal(
    search.searchParams.get('duration'),
    '269000',
    '曲库给的是整秒，上游要毫秒 —— 差 1000 倍会直接搜不到候选'
  );
  assert.equal(search.searchParams.get('album_audio_id'), '456789');
  assert.equal(search.searchParams.get('keyword'), '周杰伦 晴天');
});

test('kugou 歌词：下载请求用挑中的那条的 id + accesskey，fmt=lrc、charset=utf8', async () => {
  const g = gateway();
  await g.call('GET', lyricUrl());
  const dl = urlOf(g.requests[1]);
  assert.equal(dl.host, 'lyrics.kugou.com');
  assert.equal(dl.pathname, '/download');
  assert.equal(dl.searchParams.get('fmt'), 'lrc', 'krc 是加密格式，要 lrc');
  assert.equal(dl.searchParams.get('charset'), 'utf8');
  assert.ok(dl.searchParams.get('accesskey'), 'accesskey 必须带上（缺了上游拒绝）');
});

// ============ 候选挑选（这条链路最容易出错的一步） ============

test('kugou 歌词：不取 score 最高的那条，取曲名与歌手都对得上的', async () => {
  const g = gateway();
  await g.call('GET', lyricUrl());
  const dl = urlOf(g.requests[1]);
  assert.equal(
    dl.searchParams.get('id'),
    'good-2',
    'score 60 的那条是 UGC 上传（歌手对不上），选它会拿到别人的歌词'
  );
  assert.equal(dl.searchParams.get('accesskey'), 'KEY-GOOD');
});

test('kugou 歌词：曲名对不上的一律不选（结构不同的候选不硬认）', async () => {
  const g = gateway({
    candidates: [
      { id: 'wrong', accesskey: 'K1', song: '七里香', singer: '周杰伦', duration: 299000, score: 90 },
      { id: 'right', accesskey: 'K2', song: '晴天', singer: '周杰伦', duration: 269818, score: 10 },
    ],
  });
  await g.call('GET', lyricUrl());
  assert.equal(
    urlOf(g.requests[1]).searchParams.get('id'),
    'right',
    '上游 score 高但曲名不是这首：只能是别的歌'
  );
});

test('kugou 歌词：曲名相同时，歌手对得上的压过时长更接近的', async () => {
  const g = gateway({
    candidates: [
      // 时长几乎完全一致（|269500-269000| < |269990-269000|），但歌手是别人
      { id: 'near', accesskey: 'K1', song: '晴天', singer: '某人', duration: 269500, score: 30 },
      { id: 'singer-ok', accesskey: 'K2', song: '晴天', singer: '周杰伦', duration: 269990, score: 30 },
    ],
  });
  await g.call('GET', lyricUrl());
  assert.equal(
    urlOf(g.requests[1]).searchParams.get('id'),
    'singer-ok',
    '时长只是辅助判据（曲库整秒 vs 候选毫秒本就有系统误差），不该压过歌手'
  );
});

// ============ 返回与失败 ============

test('kugou 歌词：base64 正文解出来就是 LRC，trans 是空串（酷狗没有翻译轨）', async () => {
  const g = gateway();
  const r = await g.call('GET', lyricUrl());
  assert.equal(r.code, 0);
  assert.equal(r.lyric, LRC_TEXT);
  assert.equal(r.trans, '');
});

test('kugou 歌词：hash 非法 → 报歌曲 ID 无效（不发上游请求）', async () => {
  const g = gateway();
  await assert.rejects(() => g.call('GET', '/api/kugou/lyric?id=notahash&title=x'), /ID/);
  assert.equal(g.requests.length, 0, '参数不合法就不该打上游');
});

test('kugou 歌词：没有候选 / 正文为空 / 上游乱回 → 统一报「歌词获取失败」', async () => {
  const cases = [
    { searchEmpty: true },
    { downloadEmpty: true },
    { searchRaw: true },
    { downloadRaw: true },
  ];
  for (const opts of cases) {
    const g = gateway(opts);
    await assert.rejects(
      () => g.call('GET', lyricUrl()),
      /歌词/,
      `夹具 ${JSON.stringify(opts)} 应报歌词失败而不是把空串当歌词返回`
    );
  }
});

test('kugou 歌词：上游网络异常要如实抛出，不能被吞成「没有歌词」', async () => {
  const g = gateway({ searchFails: true });
  await assert.rejects(() => g.call('GET', lyricUrl()), /network down/);
});
