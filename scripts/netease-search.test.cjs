// 网易云搜索链路回归：
//   ① NeteaseService 的路由 —— 网页会话优先、网关兜底（搜索曾经只有网关单通道）
//   ② WebClient 的搜索端点 —— 必须走 cloudsearch，不能退回 /api/search/get
//      （旧端点在已登录/带 MUSIC_U 时稳定 405「操作频繁」，实测见 README 的排查记录）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

/** 打包一串 TS 入口，返回同 bundle 内的导出（跨 bundle 的类身份不通用） */
function bundle(contents, globals = {}) {
  const source = esbuild.buildSync({
    stdin: { contents, resolveDir: __dirname },
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
    require: (name) => {
      if (name === 'obsidian') return globals.obsidian || { requestUrl: async () => ({ json: {} }) };
      if (name === 'fs') return globals.fs || require('node:fs');
      if (name === 'crypto') return require('node:crypto');
      if (name === 'path') return require('node:path');
      return require(name);
    },
    console,
    window: { setTimeout, clearTimeout },
    Buffer,
    URL,
    URLSearchParams,
    Date,
    JSON,
    Math,
    Promise,
  });
  return mod.exports;
}

const routing = bundle(
  `export { NeteaseService } from '../src/core/netease';\n`
);

/** WebClient 打包 + requestUrl 捕获；files 模拟插件目录里的凭据文件 */
function webBundle(files = {}) {
  const calls = [];
  const mod = bundle(`export { WebClient } from '../src/core/web-client';\n`, {
    obsidian: {
      requestUrl: async (opts) => {
        calls.push(opts);
        return { json: { result: { albums: [], songCount: 0 } } };
      },
    },
    fs: {
      readFileSync(p) {
        if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
        throw new Error('ENOENT'); // 没有匿名身份 / 没有凭据 → 走 .device-id 分支
      },
      writeFileSync() {},
    },
  });
  return { mod, calls };
}
const ANON = '/plugin/.anon-token';
const DEVICE = '/plugin/.device-id';
const COOKIE = '/plugin/.cookie';
const web = webBundle();

function routingCase({ loggedIn, webFails, gatewayFails }) {
  const calls = { web: 0, gateway: 0, ensure: 0 };
  const webStub = {
    isLoggedIn: async () => loggedIn,
    searchAlbums: async () => {
      calls.web++;
      if (webFails) throw new Error('web session down');
      return { result: { albums: [] } };
    },
    searchSongs: async () => {
      calls.web++;
      if (webFails) throw new Error('web session down');
      return { result: { songs: [] } };
    },
  };
  const gatewayStub = {
    searchAlbums: async () => {
      calls.gateway++;
      if (gatewayFails) throw new Error('gateway down');
      return { result: { albums: [] } };
    },
    searchSongs: async () => {
      calls.gateway++;
      if (gatewayFails) throw new Error('gateway down');
      return { result: { songs: [] } };
    },
  };
  const svc = new routing.NeteaseService(
    webStub,
    gatewayStub,
    async () => {
      calls.ensure++;
      return true;
    },
    () => 'gateway not ready'
  );
  return { svc, calls };
}

test('搜索路由：已登录走网页会话，网关一次都不碰', async () => {
  const { svc, calls } = routingCase({ loggedIn: true, webFails: false, gatewayFails: false });
  await svc.searchAlbums('叶惠美');
  assert.equal(calls.web, 1);
  assert.equal(calls.gateway, 0, '网页会话能用时不该再打网关');
});

test('搜索路由：网页会话失败 → 静默落到网关兜底', async () => {
  const { svc, calls } = routingCase({ loggedIn: true, webFails: true, gatewayFails: false });
  const result = await svc.searchSongs('晴天');
  assert.equal(calls.web, 1);
  assert.equal(calls.gateway, 1, '网页会话失败必须回落到网关');
  assert.equal(result.result.songs.length, 0);
});

test('搜索路由：未登录 → 直接走网关', async () => {
  const { svc, calls } = routingCase({ loggedIn: false, webFails: false, gatewayFails: false });
  await svc.searchAlbums('叶惠美');
  assert.equal(calls.web, 0);
  assert.equal(calls.gateway, 1);
});

test('搜索路由：网关未就绪时报出给定原因，不吞错', async () => {
  const broken = new routing.NeteaseService(
    { isLoggedIn: async () => false },
    {},
    async () => false,
    () => '网关还没起来'
  );
  await assert.rejects(broken.searchAlbums('x'), /网关还没起来/);
});

test('WebClient 搜索：走 cloudsearch/get/web，绝不回退旧端点', async () => {
  const client = new web.mod.WebClient(ANON, DEVICE, COOKIE);
  web.calls.length = 0;
  await client.searchAlbums('叶惠美');
  await client.searchSongs('晴天');
  assert.equal(web.calls.length, 2);
  for (const opts of web.calls) {
    assert.match(opts.url, /\/weapi\/cloudsearch\/get\/web$/);
    assert.doesNotMatch(opts.url, /\/search\/get/);
    assert.equal(opts.method, 'POST');
    assert.equal(opts.contentType, 'application/x-www-form-urlencoded');
  }
  assert.ok(web.calls[0].body.includes('params='), 'weapi 载荷必须加密成 params');
});

test('WebClient 凭据：读到 .cookie 就带 MUSIC_U，没登录就不带', async () => {
  const anonymous = webBundle();
  const anonClient = new anonymous.mod.WebClient(ANON, DEVICE, COOKIE);
  await anonClient.searchAlbums('x');
  assert.equal(anonymous.calls[0].headers.Cookie, undefined, '未登录不得凭空造 Cookie 头');

  const loggedIn = webBundle({ [COOKIE]: 'MUSIC_U=fixture-music-u; __csrf=fixture-csrf' });
  const client = new loggedIn.mod.WebClient(ANON, DEVICE, COOKIE);
  await client.searchAlbums('x');
  assert.equal(loggedIn.calls[0].headers.Cookie, 'MUSIC_U=fixture-music-u');
});

test('WebClient 凭据：eapi 指纹里优先 MUSIC_U，未登录才用匿名 MUSIC_A', async () => {
  const anonToken = JSON.stringify({ token: 'fixture-anon', deviceId: 'A'.repeat(52) });
  const loggedIn = webBundle({
    [ANON]: anonToken,
    [COOKIE]: 'MUSIC_U=fixture-music-u',
  });
  const client = new loggedIn.mod.WebClient(ANON, DEVICE, COOKIE);
  await client.songUrl(1, 'higher');
  const body = String(loggedIn.calls[0].body);
  assert.ok(body.includes('params='), 'eapi 载荷也是加密的');
  // 指纹头在加密载荷里，只能断言请求本身带上了登录 Cookie
  assert.equal(loggedIn.calls[0].headers.Cookie, 'MUSIC_U=fixture-music-u');

  const anonymous = webBundle({ [ANON]: anonToken });
  const anonClient = new anonymous.mod.WebClient(ANON, DEVICE, COOKIE);
  await anonClient.songUrl(1, 'higher');
  assert.equal(anonymous.calls[0].headers.Cookie, undefined);
});
