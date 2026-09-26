// 应用内网关（插件唯一的网关形态）：用 Electron 自带的 Node 跑网关，不依赖系统 Node.js。
//   1) loadUtilityProcess 的三条加载路径：@electron/remote / electron.remote 回退 / 都拿不到；
//   2) loadProxyResolver：系统代理解析器可用性（session.resolveProxy）；
//   3) ServerManager 端到端：fork（测试里用真 Node 模拟 utility fork）→ 就绪 →
//      系统代理注入 env → 带 token 放行 / 无 token 401 → stop 回收进程；
//   4) utilityProcess 不可用 / fork 抛错：明确失败态，不静默。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const esbuild = require('esbuild');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 真实网关产物（与构建同入口同参数）：main.js 里内联的就是它
const GATEWAY_SOURCE = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../server/gateway.js')],
  bundle: true,
  minify: true,
  charset: 'utf8',
  format: 'cjs',
  platform: 'node',
  write: false,
}).outputFiles[0].text;
const GATEWAY_GZIP = zlib.gzipSync(Buffer.from(GATEWAY_SOURCE, 'utf8'), { level: 9 }).toString('base64');
// 与构建同口径（esbuild.config.mjs:47）：源码 sha1 前 10 位就是临时文件名里的 hash。
// 用真 hash 而不是桩值 —— 「内容比对」那条防线只有在 hash 真实时才有意义（见下面两条用例）。
const GATEWAY_HASH = require('node:crypto').createHash('sha1').update(GATEWAY_SOURCE).digest('hex').slice(0, 10);

function bundle(entry) {
  return esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', entry)],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    // gateway-bundle.ts 是构建产物：测试里用桩替代（GATEWAY_GZIP 用上面真实网关现算）
    external: ['obsidian', './gateway-bundle', '*/gateway-bundle'],
  }).outputFiles[0].text;
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, text: body }));
    });
    req.on('error', reject);
  });
}

// ---- 1) loadUtilityProcess：三条加载路径 ----

function loadInAppModule(remote) {
  const mod = { exports: {} };
  vm.runInNewContext(bundle('src/core/in-app-gateway.ts'), {
    module: mod,
    exports: mod.exports,
    console,
    require: (name) => {
      if (name === '@electron/remote') {
        if (!remote.package) throw new Error('not installed');
        return remote.package;
      }
      if (name === 'electron') return { remote: remote.legacy };
      throw new Error('Unexpected runtime import: ' + name);
    },
  });
  return mod.exports;
}

const fakeUtility = { fork: () => ({ kill: () => true }) };

test('loadUtilityProcess：@electron/remote 路径', () => {
  const mod = loadInAppModule({ package: { require: (id) => (id === 'electron' ? { utilityProcess: fakeUtility } : {}) } });
  assert.equal(mod.loadUtilityProcess(), fakeUtility);
});

test('loadUtilityProcess：electron.remote 回退路径', () => {
  const mod = loadInAppModule({ package: null, legacy: { require: (id) => (id === 'electron' ? { utilityProcess: fakeUtility } : {}) } });
  assert.equal(mod.loadUtilityProcess(), fakeUtility);
});

test('loadUtilityProcess：两条路都拿不到 → null（调用方报明确失败态）', () => {
  assert.equal(loadInAppModule({ package: null, legacy: null }).loadUtilityProcess(), null);
  assert.equal(
    loadInAppModule({ package: { require: () => ({}) }, legacy: null }).loadUtilityProcess(),
    null,
    '有 remote 但没有 utilityProcess 也按不可用处理'
  );
});

// ---- 2) ServerManager 内嵌分支端到端 ----

function makeUtilityProcessStub({ failFork = false, withStdout = true } = {}) {
  const calls = { env: null, serviceName: '', stdio: null, forks: 0 };
  return {
    calls,
    fork(modulePath, _args, options) {
      if (failFork) throw new Error('fork boom');
      calls.forks++;
      calls.env = (options && options.env) || null;
      calls.serviceName = (options && options.serviceName) || '';
      calls.stdio = (options && options.stdio) || 'ignore';
      // 测试环境没有 Electron：用真 Node 起同一个网关文件，模拟 utility fork 的进程语义。
      // withStdout = true 按 stdio:'pipe' 起并把子进程 stdout 透出去 —— 端口交接
      //（网关 bind(0) → 回报真实端口 → 父进程读它）因此被真实跑到，而不是只走退回路径。
      const child = spawn(process.execPath, [modulePath], {
        env: options && options.env,
        stdio: withStdout ? ['ignore', 'pipe', 'ignore'] : 'ignore',
      });
      return {
        pid: child.pid,
        kill: () => child.kill(),
        stdout: withStdout ? child.stdout : undefined,
        on: (event, cb) => {
          if (event === 'exit') child.on('exit', (code) => cb(code));
        },
      };
    },
  };
}

function loadManager({ utility = makeUtilityProcessStub(), session = null } = {}) {
  const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinyl-plugin-'));
  // server-manager 的 requestUrl 来自 obsidian：测试里用真 HTTP（它就是拿它 ping 网关的）
  const requestUrl = ({ url, headers, throw: thr = true }) =>
    new Promise((resolve, reject) => {
      const req = http.get(url, { headers: headers || {}, agent: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            // 非 JSON 响应：留 null
          }
          resolve({ status: res.statusCode, text: body, json, headers: res.headers });
        });
      });
      req.on('error', (e) => (thr === false ? resolve({ status: 0, json: null }) : reject(e)));
    });
  const mod = { exports: {} };
  vm.runInNewContext(bundle('src/core/server-manager.ts'), {
    module: mod,
    exports: mod.exports,
    console,
    Buffer,
    process,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    window: { setTimeout, clearTimeout, setInterval, clearInterval },
    require: (name) => {
      if (name === 'obsidian') return { Plugin: class {}, requestUrl };
      if (name.endsWith('gateway-bundle')) return { GATEWAY_GZIP, GATEWAY_HASH };
      if (name === '@electron/remote') {
        return { require: (id) => (id === 'electron' ? { utilityProcess: utility, session } : {}) };
      }
      if (name === 'electron') return { remote: null };
      return require(name);
    },
  });
  const plugin = { app: { vault: { adapter: { getBasePath: () => pluginDir } } }, manifest: { dir: 'plugins/vinyl-life' } };
  const manager = new mod.exports.ServerManager(plugin);
  return { manager, pluginDir };
}

test('应用内网关：fork 就绪 → token 放行 / 无 token 401 → stop 回收', async () => {
  const utility = makeUtilityProcessStub();
  const { manager } = loadManager({ utility });
  let pid = 0;
  try {
    const ok = await manager.ensure();
    assert.equal(ok, true, '应通过应用内网关就绪');
    assert.equal(manager.state, 'running');
    pid = manager.utility && manager.utility.pid;
    assert.ok(pid > 0, '应拿到网关进程 pid');

    // 端口交接：网关自己 bind(0)，真实端口从 stdout 回报 —— 父进程没有预先探测
    assert.equal(utility.calls.stdio, 'pipe', '走交接时要读 stdout');
    assert.equal(utility.calls.env.VINYL_PORT, '0', '交接时由网关自己挑端口（0 = 系统分配）');
    assert.equal(utility.calls.forks, 1, '交接成功就不该再 fork 第二次');
    assert.ok(manager.port > 0, '端口来自网关的回报');

    const good = await httpGet(`http://127.0.0.1:${manager.port}/api/ping`, { 'x-vinyl-token': manager.token });
    assert.equal(good.status, 200, '带 token 的探测应放行');
    const bad = await httpGet(`http://127.0.0.1:${manager.port}/api/ping`, {});
    assert.equal(bad.status, 401, '没有 token 的请求必须被拒（与独立进程同一套鉴权）');
  } finally {
    manager.stop();
  }
  assert.equal(manager.state, 'stopped');
  assert.equal(manager.utility, null);
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) {
    await sleep(100);
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'stop 后内嵌网关进程应已退出');
});

test('应用内网关：拿不到 stdout 的通道退回「预探测端口」，显式传给网关', async () => {
  const utility = makeUtilityProcessStub({ withStdout: false });
  const { manager } = loadManager({ utility });
  try {
    const ok = await manager.ensure();
    assert.equal(ok, true, '旧通道也要能起来');
    assert.equal(utility.calls.forks, 2, '第一次交接拿不到流 → 第二次带端口重来');
    assert.equal(utility.calls.stdio, 'ignore', '退回路径不读 stdout');
    assert.ok(Number(utility.calls.env.VINYL_PORT) > 0, '退回路径把探测到的端口显式传进去');
    assert.equal(manager.port, Number(utility.calls.env.VINYL_PORT));
    const good = await httpGet(`http://127.0.0.1:${manager.port}/api/ping`, { 'x-vinyl-token': manager.token });
    assert.equal(good.status, 200);
  } finally {
    manager.stop();
  }
});

test('网关临时文件：预置同名假网关会被真源码覆盖（文件名里的 hash 是公开可复算的）', async () => {
  const dir = path.join(os.tmpdir(), 'vinyl-life');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `gateway-${GATEWAY_HASH}.js`);
  // 模拟共享 /tmp 上的攻击：文件名对得上（hash 可从公开的 main.js 复算），内容是别人的代码
  fs.writeFileSync(file, 'process.exit(0); // 冒充的网关\n', 'utf8');
  const { manager } = loadManager({ utility: makeUtilityProcessStub() });
  try {
    await manager.ensure();
    assert.equal(fs.readFileSync(file, 'utf8'), GATEWAY_SOURCE, '内容对不上就必须覆盖，不能直接拿来 fork');
  } finally {
    manager.stop();
  }
});

test('网关临时文件：内容一致就复用、不重写（另一个窗口可能正跑着这一份）', async () => {
  const dir = path.join(os.tmpdir(), 'vinyl-life');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `gateway-${GATEWAY_HASH}.js`);
  fs.writeFileSync(file, GATEWAY_SOURCE, 'utf8');
  const past = new Date(Date.now() - 86_400_000);
  fs.utimesSync(file, past, past); // 改写会把 mtime 刷新成现在 —— 用旧时间戳当「没被动过」的证据
  const { manager } = loadManager({ utility: makeUtilityProcessStub() });
  try {
    await manager.ensure();
    assert.equal(fs.readFileSync(file, 'utf8'), GATEWAY_SOURCE);
    assert.equal(
      Math.round(fs.statSync(file).mtimeMs),
      Math.round(past.getTime()),
      '内容一致时不该重写临时文件'
    );
  } finally {
    manager.stop();
  }
});

test('网关自己处理监听失败：端口被占时写清原因并以 1 退出（不再抛未捕获异常）', async () => {
  // 先占住一个端口，再让真网关去监听同一个号 —— 模拟 TOCTOU 里「号被抢走」的那一刻
  const squatter = http.createServer(() => {});
  await new Promise((r) => squatter.listen(0, '127.0.0.1', r));
  const taken = squatter.address().port;
  const logFile = path.join(os.tmpdir(), `vinyl-gw-eaddr-${process.pid}.log`);
  // 网关源码不能走 node -e：产物 100+ KB，Windows 命令行上限 32 KB（spawn 会直接失败）。
  // 落成临时文件再跑，与插件里 materializeGateway 的做法一致。
  const gwFile = path.join(os.tmpdir(), `vinyl-gw-eaddr-${process.pid}.js`);
  fs.writeFileSync(gwFile, GATEWAY_SOURCE, 'utf8');
  const child = spawn(process.execPath, [gwFile], {
    env: { ...process.env, VINYL_PORT: String(taken), VINYL_LOG_FILE: logFile, VINYL_TOKEN: 'x' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise((r) => child.on('exit', (c) => r(c)));
  squatter.close();
  assert.equal(code, 1, '监听失败要干净退出（未捕获异常会带一段堆栈、退出码也不稳定）');
  assert.match(out, /监听失败/, '原因要写出来：父进程与用户才能在 gateway.log 里查到');
  for (const f of [logFile, gwFile]) {
    try {
      fs.unlinkSync(f);
    } catch {
      // 没写成也无妨：这条断言只看进程行为
    }
  }
});

test('系统代理：resolveProxy 结果经 VINYL_PROXY 注入网关 env；DIRECT / 取不到则不注入', async () => {
  const utility = makeUtilityProcessStub();
  const { manager } = loadManager({
    utility,
    session: { defaultSession: { resolveProxy: async (url) => {
      assert.equal(url, 'https://music.163.com', '按代表性子集解析一次');
      return 'PROXY 127.0.0.1:7890';
    } } },
  });
  try {
    const ok = await manager.ensure();
    assert.equal(ok, true);
    assert.equal(utility.calls.env.VINYL_PROXY, 'PROXY 127.0.0.1:7890', '系统代理要交给网关');
    assert.equal(utility.calls.env.VINYL_TOKEN, manager.token, '其余注入不受影响');
  } finally {
    manager.stop();
  }
});

test('系统代理：DIRECT / 解析不到时留空（网关自己回落读环境变量）', async () => {
  const direct = makeUtilityProcessStub();
  const a = loadManager({ utility: direct, session: { defaultSession: { resolveProxy: async () => 'DIRECT' } } });
  try {
    assert.equal(await a.manager.ensure(), true);
    assert.equal(direct.calls.env.VINYL_PROXY, '', 'DIRECT 不注入');
  } finally {
    a.manager.stop();
  }

  const none = makeUtilityProcessStub();
  const b = loadManager({ utility: none }); // 没有 session（remote 拿不到）
  try {
    assert.equal(await b.manager.ensure(), true);
    assert.equal(none.calls.env.VINYL_PROXY, '');
  } finally {
    b.manager.stop();
  }
});

test('loadProxyResolver：有 session.resolveProxy 就用，缺 session / 抛错都按不可用处理', () => {
  const withSession = loadInAppModule({
    package: {
      require: (id) =>
        id === 'electron' ? { session: { defaultSession: { resolveProxy: async () => 'DIRECT' } } } : {},
    },
  });
  assert.ok(withSession.loadProxyResolver(), '应拿到 session');

  const noSession = loadInAppModule({ package: { require: () => ({}) }, legacy: null });
  assert.equal(noSession.loadProxyResolver(), null, '没有 session → null（按直连）');
});

test('拿不到 utilityProcess：明确失败态（不静默）', async () => {
  const { manager } = loadManager({ utility: null });
  const ok = await manager.ensure();
  assert.equal(ok, false);
  assert.equal(manager.state, 'error');
  assert.ok(manager.lastError.length > 0, '失败要带文案');
  assert.equal(manager.utility, null);
});

test('fork 抛错：失败态带原因', async () => {
  const { manager } = loadManager({ utility: makeUtilityProcessStub({ failFork: true }) });
  const ok = await manager.ensure();
  assert.equal(ok, false);
  assert.equal(manager.state, 'error');
  assert.ok(manager.lastError.includes('fork boom'), '错误原因要透出：' + manager.lastError);
});
