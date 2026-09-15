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

function makeUtilityProcessStub({ failFork = false } = {}) {
  const calls = { env: null, serviceName: '' };
  return {
    calls,
    fork(modulePath, _args, options) {
      if (failFork) throw new Error('fork boom');
      calls.env = (options && options.env) || null;
      calls.serviceName = (options && options.serviceName) || '';
      // 测试环境没有 Electron：用真 Node 起同一个网关文件，模拟 utility fork 的进程语义
      const child = spawn(process.execPath, [modulePath], { env: options && options.env, stdio: 'ignore' });
      return {
        pid: child.pid,
        kill: () => child.kill(),
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
      if (name.endsWith('gateway-bundle')) return { GATEWAY_GZIP, GATEWAY_HASH: 'testhash' };
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
  const { manager } = loadManager();
  let pid = 0;
  try {
    const ok = await manager.ensure();
    assert.equal(ok, true, '应通过应用内网关就绪');
    assert.equal(manager.state, 'running');
    pid = manager.utility && manager.utility.pid;
    assert.ok(pid > 0, '应拿到网关进程 pid');

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
