// 会话级专辑曲目表缓存（2026-09-27，起播预热的一环）：
//   ① 同一张专辑问两次只下去一次请求 —— 悬停预热拨的正是这一份，点下去时命中；
//   ② 不同 id 各算各的（缓存按 id 键控）；
//   ③ 失败不进缓存：这一趟没问到，下一趟照样去问（别把「网络抖了一下」记成「这专辑没有曲目」）；
//   ④ 容量上限按 LRU 淘汰（浏览一面墙会挨张扫过很多专辑，最久没用过的先走），
//      get 命中要续命 —— 否则退化成 FIFO，刚看过的那张会被后来者挤掉。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const esbuild = require('esbuild');

/** 打包一串 TS 入口（跨 bundle 的类身份不通用，三个服务 + 缓存一起进同一个 bundle） */
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
      if (name === 'path') return require('node:path');
      return require(name);
    },
    console,
    window: { setTimeout, clearTimeout },
    Buffer,
    URL,
    URLSearchParams,
    ...globals.context,
  });
  return mod.exports;
}

test('SessionCache：命中续命（LRU 而不是 FIFO），超容量丢最久没用过的', () => {
  const { SessionCache } = bundle(`export { SessionCache } from '../src/core/session-cache';`);
  const cache = new SessionCache(2);
  cache.set('a', { n: 1 });
  cache.set('b', { n: 2 });
  assert.equal(cache.get('a').n, 1, '命中');
  cache.set('c', { n: 3 }); // 容量 2：该丢的是 b（a 刚被用过）
  assert.equal(cache.get('b'), undefined, '最久没用过的先走');
  assert.equal(cache.get('a').n, 1, '刚用过的那张留着');
  assert.equal(cache.get('c').n, 3);
});

test('SessionCache：同一个键重复 set 不占两份（换 id 之外不会重键）', () => {
  const { SessionCache } = bundle(`export { SessionCache } from '../src/core/session-cache';`);
  const cache = new SessionCache(2);
  cache.set('a', { n: 1 });
  cache.set('a', { n: 2 });
  cache.set('b', { n: 3 });
  assert.equal(cache.get('a').n, 2, '后来的值覆盖先前的');
  assert.equal(cache.get('b').n, 3, '只占一格：b 没被挤掉');
});

test('网易云：同一张专辑问两次只下去一次（悬停预热 → 点击命中）', async () => {
  const routing = bundle(`export { NeteaseService } from '../src/core/netease';`);
  const calls = { gateway: 0 };
  const svc = new routing.NeteaseService(
    { isLoggedIn: async () => false },
    {
      album: async (id) => {
        calls.gateway++;
        return { songs: [{ id: 1, name: `S${id}` }] };
      },
    },
    async () => true,
    () => '网关没起来'
  );
  const warm = await svc.album(428476);
  const clicked = await svc.album(428476);
  assert.equal(calls.gateway, 1, '第二次是缓存命中');
  assert.equal(clicked, warm, '拿到的是同一份响应');
  await svc.album(999);
  assert.equal(calls.gateway, 2, '换了 id 才重新问');
});

test('网易云：问到空响应也缓存（那就是这张专辑的答案），失败不缓存（下次还会问）', async () => {
  const routing = bundle(`export { NeteaseService } from '../src/core/netease';`);
  const calls = { gateway: 0, fail: false };
  const svc = new routing.NeteaseService(
    { isLoggedIn: async () => false },
    {
      album: async () => {
        calls.gateway++;
        if (calls.fail) throw new Error('网络抖了一下');
        return { songs: [] };
      },
    },
    async () => true,
    () => '网关没起来'
  );
  await svc.album(1);
  await svc.album(1);
  assert.equal(calls.gateway, 1, '空响应也是答案，别反复问');
  calls.fail = true;
  await assert.rejects(() => svc.album(2), /网络抖了一下/);
  await assert.rejects(() => svc.album(2), /网络抖了一下/);
  assert.equal(calls.gateway, 3, '失败的那张没进缓存：下一趟照样去问');
});

test('QQ / 酷狗：与网易云同一条口径（同一张专辑只下去一次）', async () => {
  const qqCalls = [];
  const mod = bundle(
    `export { QqService } from '../src/core/qq';\nexport { KugouService } from '../src/core/kugou';\n`,
    {
      obsidian: {
        requestUrl: async (opts) => {
          qqCalls.push(String(opts.url));
          return { status: 200, json: { data: { songs: [] } } };
        },
      },
    }
  );
  const qq = new mod.QqService(() => 'http://127.0.0.1:1', () => 'tok');
  await qq.album('mid-1');
  await qq.album('mid-1');
  assert.equal(qqCalls.filter((u) => u.includes('/api/qq/album')).length, 1, 'QQ：第二次命中缓存');

  const kugou = new mod.KugouService(() => 'http://127.0.0.1:1', () => 'tok');
  await kugou.album('kg-1');
  await kugou.album('kg-1');
  await kugou.album('kg-2');
  const albumCalls = qqCalls.filter((u) => u.includes('/api/kugou/album'));
  assert.equal(albumCalls.length, 2, '酷狗：同 id 命中，换 id 再去问');
});
