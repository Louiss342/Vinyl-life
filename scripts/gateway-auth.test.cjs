const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Execute the real gateway and upstream endpoint modules. Only I/O is replaced;
// account cookies here are synthetic and never touch the installed plugin.
function gateway(qrCode, qrCookies = [], valid = true) {
  const filename = path.resolve(__dirname, '../server/gateway.js');
  const requireFromGateway = createRequire(filename);
  const files = new Map([
    ['/test/.cookie', 'MUSIC_U=existing-account'],
    ['/test/.anon-token', JSON.stringify({ token: 'fixture-anon', deviceId: 'fixture-device' })],
  ]);
  const requests = [];
  const context = {
    require(name) {
      if (name === 'fs') return {
        readFileSync(file) { if (!files.has(file)) throw new Error('ENOENT'); return files.get(file); },
        writeFileSync(file, value) { files.set(file, value); },
        renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
        unlinkSync(file) { files.delete(file); },
        appendFileSync() {},
      };
      if (name === 'http') return { createServer: () => ({ listen() {} }) };
      return requireFromGateway(name);
    },
    process: { env: { VINYL_COOKIE_FILE: '/test/.cookie', VINYL_ANON_FILE: '/test/.anon-token' }, pid: 1 },
    __dirname: path.dirname(filename),
    console: { log() {}, error() {} },
    Buffer, URL, URLSearchParams, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url) => {
      requests.push(url);
      const isQr = url.includes('qrcode/client/login');
      const body = isQr ? { code: qrCode } : {
        code: 200,
        account: valid ? { id: 123 } : null,
        profile: valid ? { userId: 123, nickname: 'Fixture user' } : null,
      };
      return { status: 200, text: async () => JSON.stringify(body), headers: {
        getSetCookie: () => isQr ? qrCookies : [],
      } };
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(filename, 'utf8') + '\nglobalThis.testRoutes = routes;', context);
  return {
    files, requests,
    call(method, url, data = {}) {
      const route = context.testRoutes.find(r => r.method === method && r.pattern.test(url));
      assert.ok(route, `${method} ${url} exists`);
      return route.handler({ query: { key: 'fixture-qr' }, body: data, cookie: '' });
    },
  };
}

test('QR 803 saves a verified login session and does not expose the cookie', async () => {
  const g = gateway(803, ['MUSIC_U=new-account; HttpOnly; Path=/', '__csrf=fixture; Path=/']);
  const result = await g.call('GET', '/api/login/qr/check');
  assert.equal(result.code, 803);
  assert.match(g.files.get('/test/.cookie'), /MUSIC_U=new-account/);
  assert.equal(Object.hasOwn(result, 'cookie'), false);
});

test('QR 802 waits for confirmation and preserves the existing account', async () => {
  const g = gateway(802, ['NMTID=visitor; Path=/']);
  const result = await g.call('GET', '/api/login/qr/check');
  assert.equal(result.code, 802);
  assert.equal(g.requests.length, 1, 'no second authorization request while waiting');
  assert.equal(g.files.get('/test/.cookie'), 'MUSIC_U=existing-account');
});

test('QR 803 without MUSIC_U fails clearly and preserves the existing account', async () => {
  const g = gateway(803, ['NMTID=visitor; Path=/']);
  await assert.rejects(g.call('GET', '/api/login/qr/check'), /MUSIC_U|会话/);
  assert.equal(g.files.get('/test/.cookie'), 'MUSIC_U=existing-account');
});

test('invalid imported cookie cannot overwrite an existing account', async () => {
  const g = gateway(801, [], false);
  await assert.rejects(g.call('POST', '/api/cookie', { cookie: 'MUSIC_U=expired' }), /登录|Cookie|cookie/);
  assert.equal(g.files.get('/test/.cookie'), 'MUSIC_U=existing-account');
});

test('cookie validation is read-only and returns the verified account', async () => {
  const g = gateway(801);
  const result = await g.call('POST', '/api/cookie/validate', { cookie: 'MUSIC_U=new-account' });
  assert.equal(result.data.account.id, 123);
  assert.equal(g.files.get('/test/.cookie'), 'MUSIC_U=existing-account');
});
