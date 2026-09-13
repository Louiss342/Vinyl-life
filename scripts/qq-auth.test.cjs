// QQ 音乐网关回归：vm 执行真实 server/gateway.js（连带真实 server/qq.js），
// 仅替换 I/O（fs / http / fetch / AbortSignal）。账号数据为合成 fixture。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// 独立复刻的关键算法（黄金值，避免与实现同源）
const hash33 = (str) => {
  let e = 0;
  for (let i = 0; i < str.length; i++) e += (e << 5) + str.charCodeAt(i);
  return 2147483647 & e;
};
const gtkOf = (skey) => {
  let h = 5381;
  for (let i = 0; i < skey.length; i++) h += (h << 5) + skey.charCodeAt(i);
  return h & 0x7fffffff;
};

const QRSIG = 'fixture-qrsig-0123456789abcdef';
const LOGIN_SIG = 'fixture-login-sig';
const PT_GUID_SIG = 'fixture-guid-sig';
const PTUI_VERSION = '26090116';
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;
const MID = '001n4C3p1yv0FU';
const MEDIA_MID = '002ExFMX2Jt6gv';
const ALBUM_MID = '000MkMni19ClKG';

const ALBUM_FIXTURE = {
  code: 0,
  data: {
    mid: ALBUM_MID,
    name: '测试专辑',
    singername: '测试歌手',
    singermid: '001singer',
    aDate: '2020-01-01',
    genre: '流行',
    desc: 'd',
    company: 'c',
    total: 2,
    list: [
      {
        songmid: MID,
        strMediaMid: MEDIA_MID,
        songname: '曲目一',
        singer: [{ name: '歌手A' }, { name: '歌手B' }],
        interval: 253,
        albummid: ALBUM_MID,
        albumname: '测试专辑',
        pay: { payplay: 1 },
        preview: { trybegin: 0, tryend: 0, trysize: 0 },
      },
      {
        songmid: '003xyzabcdefgh',
        strMediaMid: '004xyzabcdefgh',
        songname: '曲目二',
        singer: [{ name: '歌手A' }],
        interval: 180,
        albummid: ALBUM_MID,
        albumname: '测试专辑',
        preview: { trybegin: 1, tryend: 30, trysize: 0 },
      },
    ],
  },
};

function res({ status = 200, text = '', setCookies = [], location = null, bytes = null } = {}) {
  return {
    status,
    headers: {
      get: (name) => (String(name).toLowerCase() === 'location' ? location : null),
      getSetCookie: () => setCookies,
    },
    text: async () => text,
    arrayBuffer: async () => bytes || new ArrayBuffer(0),
    body: { cancel() {} },
  };
}

const json = (obj) => res({ text: JSON.stringify(obj) });

// 上游响应场景：全部有默认值，按用例覆盖
function gateway(opts = {}) {
  const filename = path.resolve(__dirname, '../server/gateway.js');
  const requireFromGateway = createRequire(filename);
  const files = new Map([
    ['/test/.cookie', 'MUSIC_U=existing-account'],
    ['/test/.anon-token', JSON.stringify({ token: 'fixture-anon', deviceId: 'fixture-device' })],
  ]);
  if (opts.cookie !== undefined) files.set('/test/.qq-cookie', opts.cookie);
  const requests = [];
  const logs = [];

  const fetchStub = async (url, init = {}) => {
    const u = String(url);
    requests.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body || '' });
    if (u.includes('cgi-bin/xlogin')) {
      return res({
        status: 200,
        text: `<script>window.ptui={ptui_version:encodeURIComponent("${PTUI_VERSION}")}</script>`,
        setCookies: [
          `pt_login_sig=${LOGIN_SIG};Path=/;Domain=qq.com`,
          `pt_guid_sig=${PT_GUID_SIG};Path=/;Domain=qq.com`,
        ],
      });
    }
    if (u.includes('ptqrshow')) {
      return res({
        bytes: PNG_BYTES,
        setCookies: [
          `qrsig=${QRSIG};Path=/;Domain=ptlogin2.qq.com;Secure;`,
          'ptvfsession=fixture-vf-session;Path=/;Domain=qq.com',
        ],
      });
    }
    // check_sig 必须先于 ptqrlogin 判定：真实 check_sig URL 自带 service=ptqrlogin 参数，
    // 若按 includes('ptqrlogin') 先匹配会把它错当成轮询请求（曾导致链路在夹具里断掉）。
    if (u.includes('/check_sig?')) {
      return res({
        status: 302,
        location: opts.checkSigLocation || 'https://y.qq.com/portal/login.html',
        setCookies:
          opts.checkSigCookies ||
          ['p_skey=fixture-skey;Path=/;Domain=qq.com', 'p_uin=o1234567890;Path=/;Domain=qq.com'],
      });
    }
    if (u.includes('/ptqrlogin?')) {
      if (opts.pollError) throw opts.pollError;
      return res({ text: opts.ptuiCB !== undefined ? opts.ptuiCB : "ptuiCB('66','0','','0','','')" });
    }
    if (u.includes('y.qq.com/portal/login.html')) {
      return res({ setCookies: ['pt4_token=fixture-pt4;Path=/;Domain=qq.com'] });
    }
    if (u.includes('oauth2.0/authorize')) {
      if (opts.authorize) return opts.authorize();
      return res({
        status: 302,
        location: 'https://y.qq.com/portal/wx_redirect.html?code=fixture-code&state=vinyl',
      });
    }
    if (u.includes('oauth2.0/login_jump')) {
      if (opts.loginJump) return opts.loginJump();
      return res({ status: 302, location: 'https://y.qq.com/portal/wx_redirect.html?code=jump-code&state=vinyl' });
    }
    if (u.includes('cgi-bin/musicu.fcg')) {
      let payload = {};
      try {
        payload = JSON.parse(init.body || '{}');
      } catch (_) {}
      const mod = (payload.req && payload.req.module) || (payload.req_0 && payload.req_0.module) || '';
      if (mod === 'QQConnectLogin.LoginServer') {
        if (opts.qqLogin) return opts.qqLogin(payload);
        return json({ req: { code: 0, data: {} } });
      }
      if (mod === 'music.UserInfo.userInfoServer') {
        const code = opts.userInfoCode !== undefined ? opts.userInfoCode : 0;
        const data =
          opts.userInfoData !== undefined
            ? opts.userInfoData
            : code === 0
              ? { nick: '测试QQ', uin: 1234567890 }
              : {};
        return json({ req_0: { code, data } });
      }
      if (mod === 'vkey.GetVkeyServer') {
        if (opts.vkey) return opts.vkey(payload);
        return json({
          code: 0,
          req_0: { code: 0, data: { sip: ['http://sip1.example/'], midurlinfo: [{ purl: 'M800abc.mp3?vkey=v1' }] } },
        });
      }
      return json({});
    }
    if (u.includes('fcg_v8_album_info_cp')) {
      return opts.album ? opts.album() : json(ALBUM_FIXTURE);
    }
    if (u.includes('fcg_query_lyric_new')) {
      return json({ retcode: 0, code: 0, lyric: '[00:00.00]测试歌词', trans: '' });
    }
    if (u.includes('sip1.example') || u.includes('sip2.example') || u.includes('aqqmusic.tc.qq.com')) {
      return res({ status: opts.cdn ? opts.cdn(u) : 206 });
    }
    throw new Error('unexpected fetch: ' + u);
  };

  const context = {
    require(name) {
      if (name === 'fs')
        return {
          readFileSync(file) {
            if (!files.has(file)) throw new Error('ENOENT');
            return files.get(file);
          },
          writeFileSync(file, value) {
            files.set(file, value);
          },
          renameSync(from, to) {
            files.set(to, files.get(from));
            files.delete(from);
          },
          unlinkSync(file) {
            files.delete(file);
          },
          appendFileSync() {},
        };
      if (name === 'http') return { createServer: () => ({ listen() {} }) };
      return requireFromGateway(name);
    },
    process: {
      env: {
        VINYL_COOKIE_FILE: '/test/.cookie',
        VINYL_ANON_FILE: '/test/.anon-token',
        VINYL_QQ_COOKIE_FILE: '/test/.qq-cookie',
        VINYL_QQ_GUID_FILE: '/test/.qq-guid',
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
    files,
    requests,
    logs,
    call(method, url, data = {}) {
      const [pathname, qs = ''] = url.split('?');
      const route = context.testRoutes.find((r) => r.method === method && r.pattern.test(pathname));
      assert.ok(route, `${method} ${url} exists`);
      const query = Object.fromEntries(new URLSearchParams(qs));
      return route.handler({ query, body: data, cookie: '' });
    },
  };
}

test('qq qr/key returns a PNG data URL and qrsig as unikey', async () => {
  const g = gateway();
  const r = await g.call('GET', '/api/qq/login/qr/key');
  assert.equal(r.code, 200);
  assert.equal(r.data.unikey, QRSIG);
  assert.match(r.data.qrimg, /^data:image\/png;base64,/);
  const bytes = Buffer.from(r.data.qrimg.split(',')[1], 'base64');
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(g.files.has('/test/.qq-cookie'), false, 'key fetch must not write a credential');
  assert.equal(g.requests.length, 2, '取码 = xlogin（拿 login_sig）+ ptqrshow');
});

test('扫码会话绑定：复用官方完整 Cookie 会话、动态版本与回跳地址', async () => {
  const g = gateway();
  await g.call('GET', '/api/qq/login/qr/key');
  const idx = (frag) => g.requests.findIndex((x) => x.url.includes(frag));
  assert.ok(idx('cgi-bin/xlogin') >= 0, '必须先访问 xlogin 页');
  assert.ok(idx('cgi-bin/xlogin') < idx('ptqrshow'), 'xlogin 应在取二维码之前');
  const r = await g.call('GET', `/api/qq/login/qr/check?key=${QRSIG}`);
  assert.equal(r.code, 801);
  const poll = g.requests.filter((x) => x.url.includes('ptqrlogin')).pop();
  assert.ok(
    poll.url.includes(`login_sig=${LOGIN_SIG}`),
    '缺 login_sig 时手机会停在"二维码认证中"，确认无法落回本会话'
  );
  assert.ok(!poll.url.includes('login_sig=&'), 'login_sig 不能为空');
  assert.ok(poll.url.includes(`js_ver=${PTUI_VERSION}`), '轮询版本必须跟随 xlogin 页面，不能长期硬编码旧值');
  assert.ok(String(poll.headers.Cookie).includes(`qrsig=${QRSIG}`), '必须回传二维码 qrsig');
  assert.ok(String(poll.headers.Cookie).includes(`pt_login_sig=${LOGIN_SIG}`), '必须复用 xlogin Cookie 会话');
  assert.ok(String(poll.headers.Cookie).includes(`pt_guid_sig=${PT_GUID_SIG}`), '不得丢弃会话绑定 Cookie');
  assert.ok(String(poll.headers.Cookie).includes('ptvfsession=fixture-vf-session'), '必须合并取码响应 Cookie');
  const qrShow = g.requests.find((x) => x.url.includes('ptqrshow'));
  assert.ok(qrShow.url.includes('u1='), '官方取码请求必须带登录完成后的回跳地址');
  assert.ok(String(qrShow.headers.Cookie).includes(`pt_login_sig=${LOGIN_SIG}`), '取码也必须复用 xlogin 会话');
});

test('未取码（无 login_sig 记录）时轮询仍可用，login_sig 退化为空', async () => {
  const g = gateway();
  const r = await g.call('GET', `/api/qq/login/qr/check?key=${QRSIG}`);
  assert.equal(r.code, 801);
  const poll = g.requests.filter((x) => x.url.includes('ptqrlogin')).pop();
  assert.ok(poll.url.includes('login_sig=&'), '无记录时不得崩溃');
});

test('昵称取自 data.info.nick（真实响应形态，顶层 nick 不返回）', async () => {
  const g = gateway({
    cookie: 'qm_keyst=fixture; uin=1149716682',
    userInfoData: { identify: {}, info: { nick: 'MADAO' } },
  });
  const r = await g.call('GET', '/api/qq/login/status');
  assert.equal(r.data.profile.nickname, 'MADAO');
  assert.equal(r.data.profile.userId, 1149716682);
});

test('ptuiCB 66 → 801 with correct ptqrtoken and qrsig cookie', async () => {
  const g = gateway();
  const r = await g.call('GET', `/api/qq/login/qr/check?key=${QRSIG}`);
  assert.equal(r.code, 801);
  const call = g.requests.find((x) => x.url.includes('ptqrlogin'));
  assert.ok(call.url.includes(`ptqrtoken=${hash33(QRSIG)}`), 'ptqrtoken = hash33(qrsig)');
  assert.ok(String(call.headers.Cookie).includes(`qrsig=${QRSIG}`), 'qrsig forwarded');
  assert.equal(g.files.has('/test/.qq-cookie'), false);
});

test('ptuiCB 67 → 802, 65 → 800', async () => {
  const g1 = gateway({ ptuiCB: "ptuiCB('67','0','','0','','')" });
  assert.equal((await g1.call('GET', `/api/qq/login/qr/check?key=${QRSIG}`)).code, 802);
  const g2 = gateway({ ptuiCB: "ptuiCB('65','0','','0','','')" });
  assert.equal((await g2.call('GET', `/api/qq/login/qr/check?key=${QRSIG}`)).code, 800);
});

test('ptuiCB 0 → full chain, double-channel cookie merge, writes only after validation', async () => {
  const g = gateway({
    ptuiCB: `ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?uin=1234567890&ptsigx=abc','0','登录成功！','')`,
    qqLogin: () =>
      res({
        setCookies: ['uin=1234567890;Path=/;Domain=qq.com'],
        text: JSON.stringify({ req: { code: 0, data: { cookie: 'qm_keyst=fixture-keyst; __csrf=body-csrf' } } }),
      }),
  });
  await g.call('GET', '/api/qq/login/qr/key');
  const r = await g.call('GET', `/api/qq/login/qr/check?key=${QRSIG}`);
  assert.equal(r.code, 803);
  assert.equal(Object.hasOwn(r, 'cookie'), false, 'cookie must not be exposed to the client');
  const stored = g.files.get('/test/.qq-cookie');
  assert.match(stored, /qm_keyst=fixture-keyst/, 'body-channel qm_keyst merged');
  assert.match(stored, /uin=1234567890/, 'set-cookie uin merged');
  assert.match(g.files.get('/test/.qq-guid'), /^\d{8,12}$/, 'guid persisted');
  // 链路顺序
  const idx = (frag) => g.requests.findIndex((x) => x.url.includes(frag));
  assert.ok(idx('ptqrlogin') < idx('check_sig'));
  assert.ok(idx('check_sig') < idx('oauth2.0/authorize'));
  assert.ok(idx('oauth2.0/authorize') < idx('cgi-bin/musicu.fcg'));
  assert.ok(g.requests.some((x) => String(x.body).includes('QQConnectLogin')), 'QQLogin requested');
  const checkSig = g.requests.find((x) => x.url.includes('check_sig'));
  assert.ok(String(checkSig.headers.Cookie).includes(`qrsig=${QRSIG}`), '成功回跳必须延续扫码会话');
  assert.ok(String(checkSig.headers.Cookie).includes(`pt_login_sig=${LOGIN_SIG}`), '成功回跳不得新建空会话');
  // 授权请求携带 g_tk 与 p_skey/p_uin
  const auth = g.requests.find((x) => x.url.includes('oauth2.0/authorize'));
  assert.ok(String(auth.headers.Cookie).includes('p_skey=fixture-skey'));
  assert.ok(String(auth.headers.Cookie).includes('p_uin=o1234567890'));
  assert.ok(String(auth.body).includes(`g_tk=${gtkOf('fixture-skey')}`), 'g_tk computed from p_skey');
  assert.match(String(auth.body), /ui=\d{8,12}/);
});

test('真实 7 字段 ptuiCB 0（成功响应尾部多一个空字段）必须完成全链路', async () => {
  // 手机确认后腾讯返回 7 字段成功响应（尾部多一个空字段）。
  // 按 ≤6 字段整体匹配会解析失败 → 网关抛“服务异常”，表现为「手机成功、电脑失败」。
  const realSuccess =
    "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?pttype=1&uin=1234567890" +
    '&service=ptqrlogin&nodirect=0&ptsigx=fixture-ptsigx-ticket' +
    '&s_url=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump&f_url=&ptlang=2052&ptredirect=100' +
    "&aid=716027609&daid=383&j_later=0&low_login_hour=0&regmaster=0&pt_login_type=3&pt_aid=0&pt_aaid=16" +
    "&pt_light=0&pt_3rd_aid=100497308','0','登录成功！', 'fixture-nick', '')";
  const g = gateway({
    ptuiCB: realSuccess,
    qqLogin: () =>
      res({
        setCookies: ['uin=1234567890;Path=/;Domain=qq.com'],
        text: JSON.stringify({ req: { code: 0, data: { cookie: 'qm_keyst=fixture-keyst' } } }),
      }),
  });
  await g.call('GET', '/api/qq/login/qr/key');
  const r = await g.call('GET', `/api/qq/login/qr/check?key=${QRSIG}`);
  assert.equal(r.code, 803, '7 字段成功响应必须被解析并完成登录');
  assert.match(g.files.get('/test/.qq-cookie'), /qm_keyst=fixture-keyst/);
  assert.doesNotMatch(g.logs.join('\n'), /parse failed/, '不得再落入解析失败分支');
});

test('check_sig 的删除型空 Cookie 不得覆盖先前的有效票据', async () => {
  // check_sig 对 p_uin / p_skey 同名多次下发（不同 Domain/Path），其中含删除型空值。
  // 按“最后一条覆盖”会冲掉有效值 → 报「未取得 p_skey/p_uin」，登录止步于最后一跳。
  const g = gateway({
    ptuiCB: `ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?uin=1234567890&ptsigx=abc','0','登录成功！','')`,
    checkSigCookies: [
      'p_skey=fixture-skey;Path=/;Domain=qq.com',
      'p_uin=o1234567890;Path=/;Domain=qq.com',
      'p_skey=;Path=/;Domain=qq.com;Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'p_uin=;Path=/;Domain=qq.com;Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ],
    qqLogin: () =>
      res({ text: JSON.stringify({ req: { code: 0, data: { cookie: 'qm_keyst=fixture-keyst' } } }) }),
  });
  await g.call('GET', '/api/qq/login/qr/key');
  const r = await g.call('GET', `/api/qq/login/qr/check?key=${QRSIG}`);
  assert.equal(r.code, 803, '删除型空值不得冲掉有效票据');
  const auth = g.requests.find((x) => x.url.includes('oauth2.0/authorize'));
  assert.ok(String(auth.headers.Cookie).includes('p_skey=fixture-skey'), '授权请求必须携带有效 p_skey');
  assert.ok(String(auth.headers.Cookie).includes('p_uin=o1234567890'), '授权请求必须携带有效 p_uin');
});

test('扫码轮询输出原始 ptuiCB 诊断（code/sub/msg），且不含任何凭据', async () => {
  const g = gateway({ ptuiCB: "ptuiCB('67','0','','0','已扫描，等待您确认。','')" });
  const r = await g.call('GET', `/api/qq/login/qr/check?key=${QRSIG}`);
  assert.equal(r.code, 802);
  const line = g.logs.find((l) => l.includes('qr/check raw'));
  assert.ok(line, '必须输出原始 ptuiCB 诊断行（排查扫码链路用）');
  assert.match(line, /code: 67/);
  assert.match(line, /已扫描/);
  assert.ok(!line.includes(QRSIG), '诊断日志不得包含 qrsig');
});

test('authorize 未回 code 时，回退 check_sig 链路的 code（R4 兜底）', async () => {
  let sentCode = '';
  const g = gateway({
    ptuiCB: `ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?uin=1234567890&ptsigx=abc','0','登录成功！','')`,
    checkSigLocation: 'https://y.qq.com/portal/login.html?code=chain-code-1',
    authorize: () => res({ status: 200, text: '<html>请重新登录</html>' }),
    qqLogin: (payload) => {
      sentCode = payload.req.param.code;
      return res({ setCookies: ['qm_keyst=fixture-keyst;Path=/;Domain=qq.com'], text: '{"req":{"code":0}}' });
    },
  });
  const r = await g.call('GET', `/api/qq/login/qr/check?key=${QRSIG}`);
  assert.equal(r.code, 803);
  assert.equal(sentCode, 'chain-code-1', '授权码应取自 check_sig 链路');
  assert.match(g.files.get('/test/.qq-cookie'), /qm_keyst=fixture-keyst/);
});

test('authorize 与链路均无 code 时，回退 login_jump（参考实现落点）', async () => {
  let sentCode = '';
  const g = gateway({
    ptuiCB: `ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?uin=1234567890&ptsigx=abc','0','登录成功！','')`,
    checkSigLocation: 'https://y.qq.com/portal/login.html',
    authorize: () => res({ status: 200, text: '<html>无 code</html>' }),
    loginJump: () =>
      res({ status: 302, location: 'https://y.qq.com/portal/wx_redirect.html?code=jump-code-9' }),
    qqLogin: (payload) => {
      sentCode = payload.req.param.code;
      return res({ setCookies: ['qm_keyst=fixture-keyst;Path=/;Domain=qq.com'], text: '{"req":{"code":0}}' });
    },
  });
  const r = await g.call('GET', `/api/qq/login/qr/check?key=${QRSIG}`);
  assert.equal(r.code, 803);
  assert.equal(sentCode, 'jump-code-9');
  assert.ok(g.requests.some((x) => x.url.includes('oauth2.0/login_jump')), '必须请求 login_jump');
  assert.match(g.files.get('/test/.qq-cookie'), /qm_keyst=fixture-keyst/);
});

test('三条路都拿不到 code 时明确报错，绝不落盘', async () => {
  const g = gateway({
    ptuiCB: `ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?uin=1234567890','0','登录成功！','')`,
    checkSigLocation: 'https://y.qq.com/portal/login.html',
    authorize: () => res({ status: 200, text: '<html>无 code</html>' }),
    loginJump: () => res({ status: 200, text: '<html>无跳转</html>' }),
    cookie: 'qm_keyst=old-account',
  });
  await assert.rejects(g.call('GET', `/api/qq/login/qr/check?key=${QRSIG}`), /授权失败|重新扫码/);
  assert.equal(g.files.get('/test/.qq-cookie'), 'qm_keyst=old-account', '失败必须保留原账号');
});

test('success without qm_keyst rejects and preserves the existing account', async () => {
  const g = gateway({
    ptuiCB: `ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?uin=1234567890','0','登录成功！','')`,
    qqLogin: () => json({ req: { code: 0, data: {} } }),
    cookie: 'qm_keyst=old-account; uin=1111111111',
  });
  await assert.rejects(g.call('GET', `/api/qq/login/qr/check?key=${QRSIG}`), /qm_keyst|登录/);
  assert.equal(g.files.get('/test/.qq-cookie'), 'qm_keyst=old-account; uin=1111111111');
});

test('success but login-gated userinfo rejects and preserves the existing account', async () => {
  const g = gateway({
    ptuiCB: `ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?uin=1234567890','0','登录成功！','')`,
    qqLogin: () =>
      res({ setCookies: ['uin=1234567890;Path=/;Domain=qq.com', 'qm_keyst=fixture-keyst;Path=/;Domain=qq.com'], text: '{"req":{"code":0}}' }),
    userInfoCode: 1000,
    cookie: 'qm_keyst=old-account',
  });
  await assert.rejects(g.call('GET', `/api/qq/login/qr/check?key=${QRSIG}`), /验证失败|重新登录/);
  assert.equal(g.files.get('/test/.qq-cookie'), 'qm_keyst=old-account');
});

test('imported cookie without qm_keyst cannot overwrite an existing account', async () => {
  const g = gateway({ cookie: 'qm_keyst=old-account; uin=1111111111' });
  await assert.rejects(
    g.call('POST', '/api/qq/cookie', { cookie: 'uin=1234567890; __csrf=x' }),
    /qm_keyst/
  );
  assert.equal(g.files.get('/test/.qq-cookie'), 'qm_keyst=old-account; uin=1111111111');
});

test('valid imported cookie is validated then written', async () => {
  const g = gateway({ cookie: 'qm_keyst=old-account' });
  const r = await g.call('POST', '/api/qq/cookie', { cookie: 'qm_keyst=new-keyst; uin=1234567890' });
  assert.equal(r.ok, true);
  assert.equal(g.files.get('/test/.qq-cookie'), 'qm_keyst=new-keyst; uin=1234567890');
  const info = g.requests.find((x) => String(x.body).includes('GetLoginUserInfo'));
  assert.ok(String(info.headers.Cookie).includes('qm_keyst=new-keyst'), 'validation used the new cookie');
});

test('cookie validation is read-only and returns the verified account', async () => {
  const g = gateway({ cookie: 'qm_keyst=old-account' });
  const r = await g.call('POST', '/api/qq/cookie/validate', { cookie: 'qm_keyst=probe; uin=1234567890' });
  assert.equal(r.data.account.id, 1234567890);
  assert.equal(g.files.get('/test/.qq-cookie'), 'qm_keyst=old-account');
});

test('DELETE /api/qq/cookie clears the credential', async () => {
  const g = gateway({ cookie: 'qm_keyst=old-account' });
  await g.call('DELETE', '/api/qq/cookie');
  assert.equal(g.files.get('/test/.qq-cookie'), '');
});

test('login status: empty when logged out, normalized account when valid', async () => {
  const g1 = gateway();
  assert.deepEqual(await g1.call('GET', '/api/qq/login/status'), { code: 200, data: {} });
  const g2 = gateway({ cookie: 'qm_keyst=fixture-keyst; uin=1234567890' });
  const r = await g2.call('GET', '/api/qq/login/status');
  assert.equal(r.data.account.id, 1234567890);
  assert.equal(r.data.profile.nickname, '测试QQ');
});

test('album normalizes the V3 shape (list/strMediaMid/interval seconds/pay/trial/cover)', async () => {
  const g = gateway();
  const r = await g.call('GET', `/api/qq/album?id=${ALBUM_MID}`);
  assert.equal(r.code, 0);
  assert.equal(r.data.album.mid, ALBUM_MID);
  assert.equal(r.data.album.name, '测试专辑');
  assert.equal(r.data.album.artist, '测试歌手');
  assert.equal(
    r.data.album.coverUrl,
    `https://y.gtimg.cn/music/photo_new/T002R300x300M000${ALBUM_MID}.jpg`
  );
  const s0 = r.data.songs[0];
  assert.equal(s0.mid, MID);
  assert.equal(s0.mediaMid, MEDIA_MID);
  assert.equal(s0.artist, '歌手A / 歌手B');
  assert.equal(s0.interval, 253);
  assert.equal(s0.pay, 1);
  assert.equal(s0.trial, false);
  assert.equal(r.data.songs[1].trial, true);
});

test('invalid albummid gives a clean 1101 without upstream jargon', async () => {
  const g = gateway({ album: () => json({ code: 1101, message: 'para error!' }) });
  const r = await g.call('GET', '/api/qq/album?id=doesnotexist1234');
  assert.equal(r.code, 1101);
  assert.deepEqual(r.data.songs, []);
  assert.equal(JSON.stringify(r).includes('para error'), false);
});

test('song url rewrites http sip to https and probes with Range', async () => {
  const g = gateway();
  const r = await g.call('GET', `/api/qq/song/url?id=${MID}&level=higher`);
  assert.equal(r.data[0].url, 'https://sip1.example/M800abc.mp3?vkey=v1');
  assert.equal(r.data[0].level, 'higher');
  const probe = g.requests.find((x) => x.url.includes('sip1.example'));
  assert.equal(probe.headers.Range, 'bytes=0-1');
});

test('song url falls back to the next sip entry when the first CDN probe fails', async () => {
  const g = gateway({
    vkey: () =>
      json({
        code: 0,
        req_0: {
          code: 0,
          data: {
            sip: ['http://sip1.example/', 'https://sip2.example/'],
            midurlinfo: [{ purl: 'M800abc.mp3?vkey=v2' }],
          },
        },
      }),
    cdn: (u) => (u.includes('sip1') ? 403 : 206),
  });
  const r = await g.call('GET', `/api/qq/song/url?id=${MID}&level=higher`);
  assert.equal(r.data[0].url, 'https://sip2.example/M800abc.mp3?vkey=v2');
});

test('quality ladder degrades on empty purl, reports the successful rung', async () => {
  const vkey = (payload) => {
    const fn = payload.req_0.param.filename[0];
    const purl = fn.startsWith('F000') ? '' : fn.startsWith('M800') ? 'M800abc.mp3?vkey=v3' : '';
    return json({ code: 0, req_0: { code: 0, data: { sip: ['http://sip1.example/'], midurlinfo: [{ purl }] } } });
  };
  const g1 = gateway({ vkey });
  const r1 = await g1.call('GET', `/api/qq/song/url?id=${MID}&level=lossless`);
  assert.equal(r1.data[0].level, 'exhigh');
  assert.match(r1.data[0].url, /M800abc\.mp3/);
  const g2 = gateway({
    vkey: () =>
      json({ code: 0, req_0: { code: 0, data: { sip: ['http://sip1.example/'], midurlinfo: [{ purl: '' }] } } }),
  });
  const r2 = await g2.call('GET', `/api/qq/song/url?id=${MID}&level=lossless`);
  assert.equal(r2.data[0].url, '');
  assert.match(r2.data[0].msg, /未返回可播放地址/);
});

test('vkey filename prefers mediaMid and retries songmid on empty purl', async () => {
  const seen = [];
  const g = gateway({
    vkey: (payload) => {
      const fn = payload.req_0.param.filename[0];
      seen.push(fn);
      const purl = fn.includes(MEDIA_MID) ? '' : `M800${MID}.mp3?vkey=v4`;
      return json({ code: 0, req_0: { code: 0, data: { sip: ['http://sip1.example/'], midurlinfo: [{ purl }] } } });
    },
  });
  const r = await g.call('GET', `/api/qq/song/url?id=${MID}&mediaMid=${MEDIA_MID}&level=higher`);
  assert.match(r.data[0].url, /vkey=v4/);
  assert.deepEqual(seen.slice(0, 2), [`M800${MEDIA_MID}.mp3`, `M800${MID}.mp3`]);
});

test('lyric route returns the normalized payload', async () => {
  const g = gateway();
  const r = await g.call('GET', `/api/qq/lyric?songmid=${MID}`);
  assert.equal(r.code, 0);
  assert.match(r.lyric, /测试歌词/);
});

test('a non-ptuiCB body is a retryable error, never a cookie write', async () => {
  const g = gateway({ ptuiCB: '<html>bad gateway</html>' });
  await assert.rejects(g.call('GET', `/api/qq/login/qr/check?key=${QRSIG}`), /扫码服务返回异常/);
  assert.equal(g.files.has('/test/.qq-cookie'), false);
  assert.match(g.logs.join('\n'), /qq qr\/check parse failed.*http: 200/);
  assert.doesNotMatch(g.logs.join('\n'), /<html>/);
});

test('QR transport failures retain a safe diagnostic without credentials', async () => {
  const error = new Error('fetch failed https://example.test/?key=secret-fixture');
  error.cause = { code: 'ECONNRESET' };
  const g = gateway({ pollError: error });
  await assert.rejects(g.call('GET', `/api/qq/login/qr/check?key=${QRSIG}`), /ECONNRESET/);
  assert.match(g.logs.join('\n'), /qq qr\/check transport failed.*ECONNRESET/);
  assert.doesNotMatch(g.logs.join('\n'), /secret-fixture|fixture-qrsig/);
  assert.equal(g.files.has('/test/.qq-cookie'), false);
});
