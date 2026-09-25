// 酷狗网关回归：vm 执行真实 server/gateway.js（连带真实 server/kugou.js），
// 仅替换 I/O（fs / http / fetch / AbortSignal）。设备与账号数据为合成 fixture。
//
// 与 qq-auth.test.cjs 同一套 harness 约定：fetch 桩按 URL 分派、未识别 URL 直接 throw
//（防止实现偷偷换了端点而测试还绿着）；crypto 用真的（md5 / AES / RSA 都靠它）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const { createRequire } = require('node:module');

const FIXTURE_GUID = 'fixture-guid-0123456789abcdef'; // 32 位 hex（md5 形态）
const FIXTURE_MID = '123456789012345678901234567890123456789'; // 十进制串（BigInt(md5) 形态）
const FIXTURE_DFID = 'FIXTUREdfid0123456789';
const QR_KEY = 'fixtureqrcodekey0123456789';
const TOKEN = 'fixture-kugou-token';
const USERID = '88880001';
const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function res({ status = 200, text = '', bytes = null } = {}) {
  return {
    status,
    headers: { get: () => null, getSetCookie: () => [] },
    text: async () => text,
    arrayBuffer: async () => bytes || Buffer.from(text, 'utf8'),
    body: { cancel() {} },
  };
}

const json = (obj) => res({ text: JSON.stringify(obj) });

// 上游响应场景：全部有默认值，按用例覆盖
function gateway(opts = {}) {
  const filename = path.resolve(__dirname, '../server/gateway.js');
  const requireFromGateway = createRequire(filename);
  const files = new Map([['/test/.cookie', 'MUSIC_U=existing-account']]);
  if (opts.device !== undefined) files.set('/test/.kugou-device', opts.device);
  if (opts.cookie !== undefined) files.set('/test/.kugou-cookie', opts.cookie);
  const requests = [];
  const logs = [];

  const fetchStub = async (url, init = {}) => {
    const u = String(url);
    requests.push({
      url: u,
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body || '',
    });
    if (u.includes('/risk/v2/r_register_dev')) {
      if (opts.deviceRegisterFails) return json({ data: {} });
      if (opts.deviceRegisterEncrypted) return opts.deviceRegisterEncrypted(u, init);
      return json({ data: { dfid: FIXTURE_DFID } });
    }
    if (u.includes('/v2/qrcode?')) {
      if (opts.qrKeyFails) return json({ data: {} });
      return json({ data: { qrcode: QR_KEY, qrcode_img: 'data:image/png;base64,AAAA' } });
    }
    if (u.includes('/v2/get_userinfo_qrcode')) {
      const status = opts.qrStatus === undefined ? 1 : opts.qrStatus;
      if (status === 4) {
        return json({
          data: {
            status: 4,
            token: opts.missingUserid ? TOKEN : opts.token || TOKEN,
            userid: opts.missingToken ? undefined : opts.missingUserid ? '' : USERID,
            nickname: '测试酷狗用户',
            vip_type: 0,
          },
        });
      }
      return json({ data: { status } });
    }
    if (u.includes('/api/v3/search/album')) {
      const page = new URL(u).searchParams.get('page');
      requests[requests.length - 1].page = page;
      return json({
        data: {
          info: [
            {
              albumid: 900123,
              albumname: '测试专辑',
              singername: '测试歌手',
              songcount: 12,
              publishtime: '2020-01-01',
              imgurl: 'http://imge.kugou.com/{size}/album.jpg',
            },
          ],
        },
      });
    }
    if (u.includes('/api/v3/search/song')) {
      return json({
        data: {
          info: [
            {
              hash: HASH.toUpperCase(),
              songname: '测试单曲',
              singername: '测试歌手',
              album_name: '测试专辑',
              album_id: 900123,
              album_audio_id: 456789,
              duration: 253,
              pay_type: 1,
              fail_process: 1,
              trans_param: { union_cover: 'http://imge.kugou.com/{size}/song.jpg' },
            },
          ],
        },
      });
    }
    if (u.includes('/api/v3/album/info')) {
      if (opts.albumNoData) return json({ data: {} });
      return json({
        data: {
          albumid: 900123,
          albumname: '测试专辑',
          singername: '测试歌手',
          songcount: 2,
          publishtime: '2020-01-01',
          imgurl: 'http://imge.kugou.com/{size}/album.jpg',
        },
      });
    }
    if (u.includes('/api/v3/album/song')) {
      return json({
        data: {
          info: [
            // 实况：album/song 行没有 songname / singername / album_name，只有 filename（「歌手 - 歌名」）
            { hash: HASH, filename: '歌手A - 曲目一', album_id: 900123, album_audio_id: 456789, duration: 253,
              trans_param: { union_cover: 'http://imge.kugou.com/{size}/song.jpg' } },
            // 拆不出「A - B」的行：整串当歌名（宁可不拆，也别把歌名切坏）
            { hash: 'b'.repeat(32), filename: '一段没有分隔符的文件名', album_id: 900123, album_audio_id: 456790, duration: 180, pay_type: 1, fail_process: 2 },
          ],
        },
      });
    }
    if (u.includes('gateway.kugou.com/v5/url')) {
      const quality = new URL(u).searchParams.get('quality');
      if (opts.v5Empty) return json({ status: 0, url: [] });
      if (opts.v5LowQuality) {
        return json({ status: 1, url: ['http://fsandroid.kugou.com/low.mp3'], bitRate: 128000, extName: 'mp3' });
      }
      if (quality === 'flac') {
        return json({ status: 1, url: ['http://fsandroid.kugou.com/hi.flac'], bitRate: 595000, extName: 'flac' });
      }
      if (quality === '320') {
        return json({ status: 1, url: ['http://fsandroid.kugou.com/mid.mp3'], bitRate: 320000, extName: 'mp3' });
      }
      return json({ status: 1, url: ['http://fsandroid.kugou.com/low.mp3'], bitRate: 128000, extName: 'mp3' });
    }
    if (u.includes('trackercdn.kugou.com/i/v2/')) {
      if (opts.legacyEmpty) return json({ url: [] });
      return json({ url: ['http://tracker.kugou.com/legacy.mp3'], bitRate: 128000, extName: 'mp3' });
    }
    throw new Error('unexpected fetch: ' + u);
  };

  // crypto：默认全真；密文设备响应用例需要替换 publicEncrypt（用测试自己持私钥的夹具公钥）
  const cryptoStub = opts.cryptoStub || nodeCrypto;

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
      if (name === 'crypto') return cryptoStub;
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
    files,
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

/** 设备文件（cookie 形态）→ 对象，便于断言 */
const deviceOf = (raw) =>
  Object.fromEntries(
    String(raw || '')
      .split(/;\s*/)
      .filter((p) => p.includes('='))
      .map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
      })
  );

const SEARCH_ALBUM = '/api/v3/search/album';
const searchUrl = (page) => `/api/kugou/search?keywords=${encodeURIComponent('测试')}&page=${page}`;

// ============ 路由与纪律 ============

test('kugou：七条路由齐全（方法 + 路径）', async () => {
  const g = gateway();
  const routes = g.context.testRoutes
    .map((r) => `${r.method} ${r.pattern.source}`)
    .filter((s) => s.includes('kugou'));
  for (const want of [
    'GET ^\\/api\\/kugou\\/login\\/qr\\/key$',
    'GET ^\\/api\\/kugou\\/login\\/qr\\/check$',
    'GET ^\\/api\\/kugou\\/login\\/status$',
    'DELETE ^\\/api\\/kugou\\/cookie$',
    'GET ^\\/api\\/kugou\\/search$',
    'GET ^\\/api\\/kugou\\/album$',
    'GET ^\\/api\\/kugou\\/song\\/url$',
  ]) {
    assert.ok(routes.includes(want), `${want} 已注册`);
  }
});

test('kugou：模块纪律 —— 零 require、fetch 只从 deps 拿（vm harness 才替换得掉 I/O）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server/kugou.js'), 'utf8');
  assert.doesNotMatch(src, /\brequire\s*\(/, '不得 require（拿到的是真实全局，vm 替换不到）');
  assert.match(src, /const \{[\s\S]{0,120}?\bfetch\b[\s\S]{0,120}?\} = deps;/, 'fetch 必须从 deps 解构');
  assert.doesNotMatch(src, /(?:globalThis|window|global)\s*\.\s*fetch/, '不得碰宿主全局 fetch');
  const gatewaySrc = fs.readFileSync(path.join(__dirname, '../server/gateway.js'), 'utf8');
  assert.match(
    gatewaySrc,
    /registerKugouRoutes\(\{[\s\S]{0,400}?deviceFile:\s*KUGOU_DEVICE_FILE/,
    '注册块必须注入 deviceFile（取流强依赖设备指纹）'
  );
  assert.match(gatewaySrc, /cookieFile:\s*KUGOU_COOKIE_FILE/, '注册块必须注入 cookieFile');
});

// ============ 设备指纹 ============

test('kugou：首次取流先注册设备，dfid/guid/mid 落盘且第二次不再注册', async () => {
  const g = gateway();
  const r = await g.call('GET', `/api/kugou/song/url?id=${HASH}&level=standard`);
  assert.equal(r.data[0].url, 'https://fsandroid.kugou.com/low.mp3');
  const device = deviceOf(g.files.get('/test/.kugou-device'));
  assert.equal(device.dfid, FIXTURE_DFID);
  assert.match(device.guid, /^[0-9a-f]{32}$/, 'guid 是 32 位 hex');
  assert.match(device.mid, /^\d+$/, 'mid 是十进制串');
  assert.ok(device.dev, 'dev 也要落盘');
  assert.equal(g.requests.filter((x) => x.url.includes('r_register_dev')).length, 1, '只注册一次');
  assert.match(g.logs.join('\n'), /酷狗设备已注册/, '注册成功要留一行日志');

  // 第二轮：设备文件已在 → 不得再打注册接口
  await g.call('GET', `/api/kugou/song/url?id=${HASH}&level=standard`);
  assert.equal(g.requests.filter((x) => x.url.includes('r_register_dev')).length, 1, '复用已落盘的设备身份');
});

/** PKCS#1 v1.5 私钥解密：走 RSA_NO_PADDING + 手工剥填充。
 *  不能直接 privateDecrypt + RSA_PKCS1_PADDING —— Node 20.11 起为 CVE-2023-46809（Marvin 攻击）
 *  把它禁掉了（ERR_INVALID_ARG_VALUE 抛错），Node 24 又放开。直接调会让这条用例的结论随 Node 版本变：
 *  本地 Node 24 绿、CI 的 Node 20 红。无填充解密各版本一致，剥填充这几行照 RFC 8017 §7.2.2 写。
 *  实现侧的 publicEncrypt(RSA_PKCS1_PADDING) 不受影响 —— 那次修复禁的只是私钥解密。 */
const rsaPkcs1Decrypt = (crypto, key, data) => {
  const em = crypto.privateDecrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, data);
  if (em[0] !== 0x00 || em[1] !== 0x02) throw new Error('不是 PKCS#1 v1.5 加密块');
  let i = 2;
  while (i < em.length && em[i] !== 0x00) i++;
  if (i >= em.length) throw new Error('PKCS#1 v1.5 块里没有 0x00 分隔符');
  return em.subarray(i + 1);
};

test('kugou：设备注册返回加密体（同一会话 key）时也能解出 dfid', async () => {
  const { privateKey, publicKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const cryptoStub = Object.create(nodeCrypto);
  // 实现侧写死了酷狗公钥，测试换成自己的夹具公钥 —— 这样测试才拿得到私钥去解 p
  cryptoStub.publicEncrypt = (options, buf) =>
    nodeCrypto.publicEncrypt({ key: publicPem, padding: options.padding }, buf);

  const g = gateway({
    cryptoStub,
    deviceRegisterEncrypted: (url, init) => {
      const p = new URL(url).searchParams.get('p');
      const info = JSON.parse(
        rsaPkcs1Decrypt(nodeCrypto, privateKey, Buffer.from(p, 'hex')).toString('utf8')
      );
      const key = nodeCrypto.createHash('md5').update(info.aes).digest('hex').slice(0, 16);
      const iv = nodeCrypto.createHash('md5').update(info.aes).digest('hex').slice(16, 32);
      const cipher = nodeCrypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
      const enc = Buffer.concat([cipher.update(JSON.stringify({ data: { dfid: FIXTURE_DFID } }), 'utf8'), cipher.final()]);
      // 必须给真 ArrayBuffer：实现按「原始字节的 base64」解，给 Buffer 会被二次编码
      const ab = enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength);
      return res({ bytes: ab }); // 非 '{' 开头 → 实现必须走解密分支
    },
  });
  await g.call('GET', `/api/kugou/song/url?id=${HASH}&level=standard`);
  assert.equal(deviceOf(g.files.get('/test/.kugou-device')).dfid, FIXTURE_DFID, '密文响应也要解出 dfid');
});

test('kugou：拿不到 dfid 时如实报错，不落盘半份设备', async () => {
  const g = gateway({ deviceRegisterFails: true });
  await assert.rejects(
    () => g.call('GET', `/api/kugou/song/url?id=${HASH}&level=standard`),
    /酷狗设备注册失败/
  );
  assert.equal(g.files.has('/test/.kugou-device'), false, '失败不落盘');
});

// ============ 扫码登录 ============

test('kugou：qr/key 返回 unikey 与二维码图，不写凭据', async () => {
  const g = gateway();
  const r = await g.call('GET', '/api/kugou/login/qr/key');
  assert.equal(r.code, 200);
  assert.equal(r.data.unikey, QR_KEY);
  assert.match(r.data.qrimg, /^data:image\/png;base64,/);
  assert.equal(g.files.has('/test/.kugou-cookie'), false, '取码阶段不得写凭据');
});

test('kugou：qr/check 801/802 只报状态，不落盘', async () => {
  for (const status of [1, 2]) {
    const g = gateway({ qrStatus: status });
    const r = await g.call('GET', `/api/kugou/login/qr/check?key=${QR_KEY}`);
    assert.equal(r.code, status === 1 ? 801 : 802);
    assert.equal(g.files.has('/test/.kugou-cookie'), false, `status=${status} 不得写凭据`);
  }
});

test('kugou：qr/check 803 落盘 token/userid，响应不外泄 token', async () => {
  const g = gateway({ qrStatus: 4 });
  const r = await g.call('GET', `/api/kugou/login/qr/check?key=${QR_KEY}`);
  assert.equal(r.code, 803);
  assert.equal(r.data.profile.nickname, '测试酷狗用户');
  assert.equal(String(r.data.account.id), USERID);
  const jar = g.files.get('/test/.kugou-cookie');
  assert.match(jar, new RegExp(`token=${TOKEN}`));
  assert.match(jar, new RegExp(`userid=${USERID}`));
  assert.doesNotMatch(JSON.stringify(r), new RegExp(TOKEN), '响应里不得回带 token');
});

test('kugou：803 但凭据不完整 → 报错且不落盘', async () => {
  const g = gateway({ qrStatus: 4, missingUserid: true });
  await assert.rejects(
    () => g.call('GET', `/api/kugou/login/qr/check?key=${QR_KEY}`),
    /凭据不完整/
  );
  assert.equal(g.files.has('/test/.kugou-cookie'), false);
});

test('kugou：登录 key 形状不对时给干净的提示（不透传上游）', async () => {
  const g = gateway();
  await assert.rejects(() => g.call('GET', '/api/kugou/login/qr/check?key=bad'), /缺少有效的登录 key/);
});

test('kugou：login/status 未登录回空对象，已登录归一化账号', async () => {
  const anon = gateway();
  const empty = await anon.call('GET', '/api/kugou/login/status');
  assert.deepEqual(empty, { code: 200, data: {} });

  const g = gateway({ cookie: `token=${TOKEN}; userid=${USERID}; nickname=测试酷狗用户` });
  const r = await g.call('GET', '/api/kugou/login/status');
  assert.equal(r.data.profile.nickname, '测试酷狗用户');
  assert.equal(String(r.data.profile.userId), USERID);
});

test('kugou：DELETE /api/kugou/cookie 清空凭据', async () => {
  const g = gateway({ cookie: `token=${TOKEN}; userid=${USERID}` });
  const r = await g.call('DELETE', '/api/kugou/cookie');
  assert.deepEqual(r, { ok: true });
  assert.equal(g.files.get('/test/.kugou-cookie'), '');
});

// ============ 曲库 ============

test('kugou：搜索双端点归一化（专辑 + 单曲），页码透传', async () => {
  const g = gateway();
  const r = await g.call('GET', searchUrl(3));
  const album = r.albums[0];
  assert.equal(album.id, '900123');
  assert.equal(album.name, '测试专辑');
  assert.equal(album.artist, '测试歌手');
  assert.equal(album.songCount, 12);
  assert.equal(album.cover, 'https://imge.kugou.com/480/album.jpg', '封面 {size} 替换为 480 并 https 化');
  const song = r.songs[0];
  assert.equal(song.hash, HASH, 'hash 一律小写');
  assert.equal(song.albumId, '900123');
  assert.equal(song.albumAudioId, '456789');
  assert.equal(song.duration, 253);
  assert.equal(song.pay, 1);
  assert.equal(song.trial, true);
  assert.equal(song.cover, 'https://imge.kugou.com/480/song.jpg', '单曲封面取 union_cover');
  const albumPage = g.requests.find((x) => x.url.includes(SEARCH_ALBUM));
  assert.match(albumPage.url, /page=3/, '页码要透传给上游（插件按页码翻页）');
  assert.match(albumPage.url, /pagesize=30/, '页大小与 album-discovery 的 SEARCH_PAGE_SIZE 对齐');
});

test('kugou：专辑接口按 id 取信息与全量曲目；id 非法给干净报错', async () => {
  const g = gateway();
  const r = await g.call('GET', '/api/kugou/album?id=900123');
  assert.equal(r.data.album.name, '测试专辑');
  assert.equal(r.data.songs.length, 2);
  assert.equal(r.data.songs[1].trial, true, 'fail_process>0 视为试听');
  const songReq = g.requests.find((x) => x.url.includes('/api/v3/album/song'));
  assert.match(songReq.url, /pagesize=-1/, '整张专辑一次取全');

  await assert.rejects(() => g.call('GET', '/api/kugou/album?id=abc'), /专辑 ID 无效/);
});

test('kugou：专辑曲目缺字段时用专辑信息与 filename 补齐（队列不该出现光秃秃的拼接名）', async () => {
  const g = gateway();
  const r = await g.call('GET', '/api/kugou/album?id=900123');
  const first = r.data.songs[0];
  assert.equal(first.name, '曲目一', 'filename 里的「歌手 - 歌名」要拆开');
  assert.equal(first.artist, '歌手A', '拆出来的歌手要填进 artist');
  assert.equal(first.albumName, '测试专辑', '专辑名用专辑级信息补齐');
  assert.equal(first.cover, 'https://imge.kugou.com/480/song.jpg', '单曲封面仍取 union_cover');
  const second = r.data.songs[1];
  assert.equal(second.name, '一段没有分隔符的文件名', '拆不出就整串当歌名');
  assert.equal(second.artist, '测试歌手', 'artist 缺失时回落专辑艺人');
  assert.equal(second.albumId, '900123', '缺 album_id 时回落专辑 id');
});

test('kugou：专辑查无数据时报错而不是静默空专辑', async () => {
  const g = gateway({ albumNoData: true });
  await assert.rejects(() => g.call('GET', '/api/kugou/album?id=900123'), /酷狗专辑信息获取失败/);
});

// ============ 取流 ============

test('kugou：song/url 走 v5 链，地址 https 化，并按实际到手档位回报', async () => {
  const g = gateway();
  const r = await g.call(
    'GET',
    `/api/kugou/song/url?id=${HASH}&level=lossless&albumId=900123&albumAudioId=456789`
  );
  const d = r.data[0];
  assert.equal(d.url, 'https://fsandroid.kugou.com/hi.flac', '媒体地址统一 https');
  assert.equal(d.type, 'flac');
  assert.equal(d.level, 'lossless', 'flac 无法再分档：按请求档位回报');
  const v5 = g.requests.find((x) => x.url.includes('gateway.kugou.com/v5/url'));
  assert.match(v5.url, /quality=flac/);
  assert.match(v5.url, /album_audio_id=456789/, 'mixsongid 必须带上（决定能否拿到完整音源）');
  assert.ok(v5.headers.dfid || v5.url.includes('dfid='), '取流要带设备指纹');
});

test('kugou：请求无损但只回 128k → 如实报 standard（播放器读数不冒充）', async () => {
  const g = gateway({ v5LowQuality: true });
  const r = await g.call('GET', `/api/kugou/song/url?id=${HASH}&level=lossless`);
  assert.equal(r.data[0].level, 'standard');
  assert.equal(r.data[0].br, 128000);
});

test('kugou：v5 取不到时退 trackercdn 旧链（同样 https）', async () => {
  const g = gateway({ v5Empty: true });
  const r = await g.call('GET', `/api/kugou/song/url?id=${HASH}&level=higher`);
  assert.equal(r.data[0].url, 'https://tracker.kugou.com/legacy.mp3');
  assert.ok(
    g.requests.some((x) => x.url.startsWith('https://trackercdn.kugou.com/i/v2/')),
    '兜底链必须走 https'
  );
});

test('kugou：两条链都拿不到 → 回可读的中文限制文案（不是空错误）', async () => {
  const g = gateway({ v5Empty: true, legacyEmpty: true });
  const r = await g.call('GET', `/api/kugou/song/url?id=${HASH}&level=standard`);
  assert.equal(r.data[0].url, '');
  assert.match(r.data[0].msg, /拿不到播放地址/);
});

test('kugou：hash 形状不对直接报错（不进上游）', async () => {
  const g = gateway();
  await assert.rejects(() => g.call('GET', '/api/kugou/song/url?id=not-a-hash'), /歌曲 ID 无效/);
  assert.equal(g.requests.filter((x) => x.url.includes('r_register_dev')).length, 0, '参数错误不该先注册设备');
});
