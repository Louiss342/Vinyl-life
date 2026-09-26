// 登录判定回归（本轮审计点名的零覆盖安全面）：src/core/auth.ts / qq-auth.ts / kugou-auth.ts。
//
// 这三个类决定「界面说不说已登录」，而登录与否又决定会不会拿用户的凭据去访问平台。
// 此前 620 条用例一条都没碰过它们：同名的 qq-auth.test.cjs / kugou-auth.test.cjs 跑的是**网关侧**
// （vm 执行 server/gateway.js），插件侧这套判定全程无人守。
//
// 钉住四条：
//   ① 凭据判定的边界 —— 只认自己的键名，前缀相同的别的键不能算凭据（否则会拿着空凭据去登录）；
//   ② 没有本地凭据时不启动网关（不要为一个必然失败的登录把子进程拉起来）；
//   ③ cookie 在位 ≠ 已登录：只有网关回的 profile 才作数，接口失败一律按未登录报；
//   ④ 803 之外的状态一律不带 state（802 只是「等手机确认」，UI 不能据此说已登录）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

function load(entry, cls) {
  const source = esbuild.buildSync({
    stdin: { contents: `export { ${cls} } from '../${entry}';`, resolveDir: __dirname, loader: 'ts' },
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
    require: (name) => (name === 'obsidian' ? { Plugin: class {}, Notice: class {} } : require(name)),
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
  });
  return mod.exports[cls];
}

// 三个来源的差异只有三处：凭据文件名、认哪个键、客户端类型（方法名一致）
const PROVIDERS = [
  {
    name: '网易云 Auth',
    entry: 'src/core/auth.ts',
    cls: 'Auth',
    file: '.cookie',
    good: 'MUSIC_U=abc123',
    // 前缀相同 / 键名相近的都不能算凭据
    bad: ['XMUSIC_U=abc123', 'MUSIC_U=', 'x=1', 'MUSIC_U', 'MUSICU=1', ''],
    inline: 'a=1; MUSIC_U=abc123', // 分号后带空格也要认（浏览器的 Set-Cookie 形态）
  },
  {
    name: 'QQ QqAuth',
    entry: 'src/core/qq-auth.ts',
    cls: 'QqAuth',
    file: '.qq-cookie',
    good: 'qm_keyst=abc123',
    bad: ['xqm_keyst=abc123', 'qm_keyst=', 'qqmusickey=1', ''],
    inline: 'a=1; qqmusic_key=abc123',
    good2: 'qqmusic_key=abc123', // 两个键名认其一
  },
  {
    name: '酷狗 KugouAuth',
    entry: 'src/core/kugou-auth.ts',
    cls: 'KugouAuth',
    file: '.kugou-cookie',
    good: 'token=abc123',
    bad: ['xtoken=abc123', 'token=', 'access_token=1', ''],
    inline: 'userid=9; token=abc123',
  },
];

/** 一个来源一套隔离环境：临时插件目录 + 假网关 + 假客户端。
 *  sharedTmp 传同一个目录时，三个来源的凭据文件同处一个插件目录（与线上一致）。 */
function makeEnv(spec, sharedTmp) {
  const tmp = sharedTmp || fs.mkdtempSync(path.join(os.tmpdir(), 'vinyl-login-'));
  fs.mkdirSync(path.join(tmp, 'plugins/vinyl-life'), { recursive: true });
  const plugin = {
    app: { vault: { adapter: { getBasePath: () => tmp } } },
    manifest: { dir: 'plugins/vinyl-life' },
  };
  const server = {
    ensureCalls: 0,
    ensureValue: true,
    ensureThrows: false,
    lastError: '网关没起来（端口占用）',
    async ensure() {
      this.ensureCalls++;
      if (this.ensureThrows) throw new Error('spawn failed');
      return this.ensureValue;
    },
  };
  const client = {
    log: [],
    statusBody: {},
    statusThrows: false,
    clearThrows: false,
    checkBody: {},
    async loginStatus() {
      this.log.push('loginStatus');
      if (this.statusThrows) throw new Error('HTTP 500');
      return this.statusBody;
    },
    async clearCookie() {
      this.log.push('clearCookie');
      if (this.clearThrows) throw new Error('HTTP 500');
    },
    // 形态按来源分：网易云的 qrKey 给字符串（再拿它换二维码），QQ / 酷狗一次给全
    async qrKey() {
      this.log.push('qrKey');
      return spec.cls === 'Auth' ? 'k1' : { key: 'k1', qrimg: QRIMG };
    },
    async qrCreate(key) {
      this.log.push('qrCreate:' + key);
      return { qrimg: QRIMG };
    },
    async qrCheck(key) {
      this.log.push('qrCheck:' + key);
      return this.checkBody;
    },
  };
  const C = load(spec.entry, spec.cls);
  return {
    tmp,
    server,
    client,
    auth: new C(plugin, server, client),
    file: path.join(tmp, 'plugins/vinyl-life', spec.file),
  };
}

const QRIMG = 'data:image/png;base64,AA';

const write = (env, text) => fs.writeFileSync(env.file, text);
const read = (env) => (fs.existsSync(env.file) ? fs.readFileSync(env.file, 'utf8') : null);
const cleanup = (t, env) => t.after(() => fs.rmSync(env.tmp, { recursive: true, force: true }));

// —— ① 凭据判定的边界 ——

for (const spec of PROVIDERS) {
  test(`${spec.name}：只认自己的凭据键，前缀相同的别的键不算`, (t) => {
    const env = makeEnv(spec);
    cleanup(t, env);

    assert.equal(env.auth.hasLocalCookie(), false, '文件不存在 → 未登录');
    assert.equal(env.auth.cookieBytes(), 0, '文件不存在 → 0 字节');

    write(env, spec.good);
    assert.equal(env.auth.hasLocalCookie(), true, `${spec.good} 应被认作凭据`);
    assert.equal(env.auth.cookieBytes(), spec.good.length, 'cookieBytes 要如实报文件长度');

    for (const bad of spec.bad) {
      write(env, bad);
      assert.equal(env.auth.hasLocalCookie(), false, `"${bad}" 不是凭据，不能算已登录`);
    }

    write(env, spec.inline);
    assert.equal(env.auth.hasLocalCookie(), true, `"${spec.inline}" 里的凭据要认得出来`);
    if (spec.good2) {
      write(env, spec.good2);
      assert.equal(env.auth.hasLocalCookie(), true, `${spec.good2} 是同一凭据的另一个键名`);
    }
  });

  test(`${spec.name}：凭据文件落在插件目录（不进笔记库、不进 git）`, (t) => {
    const env = makeEnv(spec);
    cleanup(t, env);
    assert.equal(
      env.auth.cookieFile(),
      path.join(env.tmp, 'plugins/vinyl-life', spec.file),
      '凭据路径必须在插件目录里（CONTRIBUTING 的凭据约定）'
    );
  });

  test(`${spec.name}：没有本地凭据时不启动网关`, async (t) => {
    const env = makeEnv(spec);
    cleanup(t, env);
    const st = await env.auth.getStatus();
    assert.equal(st.loggedIn, false);
    assert.equal(st.serverOk, false);
    assert.equal(env.server.ensureCalls, 0, '没有任何凭据就别把网关子进程拉起来');
    assert.deepEqual(env.client.log, [], '更不该去问网关的登录态');
  });

  test(`${spec.name}：有凭据但网关起不来 → 如实报未登录（serverOk=false）`, async (t) => {
    const env = makeEnv(spec);
    cleanup(t, env);
    write(env, spec.good);
    env.server.ensureValue = false;
    const st = await env.auth.getStatus();
    assert.equal(st.loggedIn, false);
    assert.equal(st.serverOk, false, '网关没起来时，本地有凭据也不算登录');
    assert.equal(st.cookieBytes, spec.good.length, 'cookieBytes 仍要如实');
    assert.deepEqual(env.client.log, [], '网关没起来就别发请求');
  });

  test(`${spec.name}：网关回了 profile 才算登录（cookie 在位不算数）`, async (t) => {
    const env = makeEnv(spec);
    cleanup(t, env);
    write(env, spec.good);

    // 接口成功但 profile 是空的：凭据文件在，但会话已失效
    env.client.statusBody = { data: {} };
    let st = await env.auth.getStatus();
    assert.equal(st.loggedIn, false, '空 profile 不能算已登录');
    assert.equal(st.serverOk, true, '网关是好的，只是没登录');

    env.client.statusBody = { data: { profile: { nickname: '听歌的人', userId: 42, vipType: 11 }, account: { id: 7 } } };
    st = await env.auth.getStatus();
    assert.equal(st.loggedIn, true);
    assert.equal(st.nick, '听歌的人');
    assert.equal(st.userId, 7, 'account.id 优先于 profile.userId');
    assert.equal(st.serverOk, true);
    assert.equal(st.cookieBytes, spec.good.length);
  });

  test(`${spec.name}：状态接口报错 → 按未登录处理，不谎报`, async (t) => {
    const env = makeEnv(spec);
    cleanup(t, env);
    write(env, spec.good);
    env.client.statusThrows = true;
    const st = await env.auth.getStatus();
    assert.equal(st.loggedIn, false, '接口失败时宁可报未登录，也不要让界面显示一个假的已登录');
    assert.equal(st.serverOk, true, '网关本身是活的');
    assert.equal(st.cookieBytes, spec.good.length);
  });

  test(`${spec.name}：退出登录清掉本地凭据（网关不可用也要清）`, async (t) => {
    const env = makeEnv(spec);
    cleanup(t, env);

    // 网关可用：先让网关清、再删本地文件
    write(env, spec.good);
    await env.auth.clear();
    assert.deepEqual(env.client.log, ['clearCookie'], '网关可用时先走网关');
    assert.equal(read(env), null, '本地凭据必须删掉');

    // 网关不可用：本地文件仍然要删（网关按请求从磁盘读，两路等价）
    write(env, spec.good);
    env.client.log.length = 0;
    env.server.ensureValue = false;
    await env.auth.clear();
    assert.deepEqual(env.client.log, [], '网关没起来就别发请求');
    assert.equal(read(env), null, '网关不可用时本地凭据也要删');

    // 文件本就不存在 / ensure 直接抛：都不能把异常漏给调用方
    env.server.ensureThrows = true;
    await env.auth.clear();
    env.server.ensureThrows = false;
    assert.equal(read(env), null);
  });

  test(`${spec.name}：网关不可用时点扫码要报明确原因，不静默`, async (t) => {
    const env = makeEnv(spec);
    cleanup(t, env);
    env.server.ensureValue = false;
    await assert.rejects(
      () => env.auth.beginQr(),
      /端口占用/,
      '要把网关的失败原因透出来（lastError），而不是只说「登录失败」'
    );
    assert.deepEqual(env.client.log, []);
  });

  test(`${spec.name}：803 之外的状态不带 state（802 只是等确认）`, async (t) => {
    const env = makeEnv(spec);
    cleanup(t, env);
    env.client.checkBody = { code: 802 };
    let r = await env.auth.checkQr('k1');
    assert.equal(r.code, 802);
    assert.equal(r.state, undefined, '802 时不能给出登录态 —— 界面不能据此说已登录');

    env.client.checkBody = {}; // 网关没给 code
    r = await env.auth.checkQr('k1');
    assert.equal(r.code, -1, '缺 code 按 -1 处理（不是 803，就不带 state）');
    assert.equal(r.state, undefined);

    env.client.checkBody = { code: 803, data: {} }; // 803 但 profile 空
    r = await env.auth.checkQr('k1');
    assert.equal(r.code, 803);
    assert.equal(r.state.loggedIn, false, '803 也要有 profile 才算登录');

    write(env, spec.good);
    env.client.checkBody = { code: 803, data: { profile: { nickname: 'n' }, account: { id: 5 } } };
    r = await env.auth.checkQr('k1');
    assert.equal(r.state.loggedIn, true);
    assert.equal(r.state.userId, 5);
    assert.equal(r.state.cookieBytes, spec.good.length, '803 时网关已落盘，要读到刚落下的凭据');
    assert.ok(env.client.log.includes('qrCheck:k1'), 'key 要原样带给网关');
  });
}

// —— 三个来源各自的差异 ——

test('扫码：网易云两步（拿 key 再取二维码），QQ / 酷狗一步（网关直接给）', async (t) => {
  for (const spec of PROVIDERS) {
    const env = makeEnv(spec);
    cleanup(t, env);
    const r = await env.auth.beginQr();
    if (spec.cls === 'Auth') {
      assert.deepEqual(env.client.log, ['qrKey', 'qrCreate:k1'], '网易云要先取 key 再换二维码');
    } else {
      assert.deepEqual(env.client.log, ['qrKey'], `${spec.name}：网关一次给全 key + 二维码`);
    }
    assert.equal(r.key, 'k1');
    assert.equal(r.qrimg, 'data:image/png;base64,AA');
  }
});

test('vipType 只有网易云报（QQ / 酷狗的会员信息在网关侧，不在状态接口里）', async (t) => {
  for (const spec of PROVIDERS) {
    const env = makeEnv(spec);
    cleanup(t, env);
    write(env, spec.good);
    env.client.statusBody = { data: { profile: { nickname: 'n', vipType: 11 }, account: { id: 1 } } };
    const st = await env.auth.getStatus();
    if (spec.cls === 'Auth') assert.equal(st.vipType, 11, '网易云的 vipType 要映射出来（设置页显示会员）');
    else assert.equal(st.vipType, undefined, `${spec.name} 不该凭空报 vipType`);
    assert.equal(st.loggedIn, true);
  }
});

test('三个来源的凭据互不相认（同一个插件目录里各读各的）', (t) => {
  // 线上三份凭据同处一个插件目录：.cookie / .qq-cookie / .kugou-cookie。
  // 这里逐个只放一份，另外两个来源必须视为未登录 —— 拿别的源的凭据去登录，
  // 网关那边只会得到一个必然失败的请求，而界面会先显示「已登录」。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinyl-login-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const envs = PROVIDERS.map((spec) => makeEnv(spec, tmp));

  for (let i = 0; i < PROVIDERS.length; i++) {
    for (const env of envs) if (fs.existsSync(env.file)) fs.unlinkSync(env.file);
    write(envs[i], PROVIDERS[i].good);
    envs.forEach((env, j) => {
      assert.equal(
        env.auth.hasLocalCookie(),
        i === j,
        i === j
          ? `${PROVIDERS[i].name} 要认出自己那份凭据`
          : `${PROVIDERS[j].name} 不能把 ${PROVIDERS[i].name} 的凭据当成自己的`
      );
    });
  }
});
