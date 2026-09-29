// 网关日志的脱敏与轮转回归（规则走 server/redact.js 的纯函数，接线走真实网关进程内实例）：
//   日志的用途是用户报障时贴进 issue（CONTRIBUTING 与 bug_report 模板都这么引导），所以 QQ 号 / uin（长数字串、ptnick_<uin>）、绝对路径（含系统用户名）、URL 查询串（封面直链常带签名）都不进文件；凭据值本来就只写长度。
//   体积有上限：超了滚一份 .1，只留一代 —— 文件就在插件目录（库内），无上限的 append 会撑大跟着同步走。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const { redactLogText, MAX_LOG_BYTES } = require('../server/redact.js');

// ============ A. 脱敏规则（纯函数） ============

test('脱敏：账号数字串（uin / cookie 名里的账号）抹掉，端口与 URL 里的 id 留着', () => {
  assert.equal(
    redactLogText('[vinyl-server] qq qr/check code: 803（已校验并保存，uin 1149716682）'),
    '[vinyl-server] qq qr/check code: 803（已校验并保存，uin ***）'
  );
  assert.match(
    redactLogText('qq-login 取到 Cookie 键名: pt2gguin,ptnick_1149716682,uin,pt4_token'),
    /ptnick_\*\*\*/,
    'cookie 名里嵌着的 QQ 号也要抹掉'
  );
  assert.equal(
    redactLogText('[vinyl-server] cookie 已写入 .qq-cookie 1630 bytes'),
    '[vinyl-server] cookie 已写入 .qq-cookie 1630 bytes',
    '长度是 4 位以内：不受影响'
  );
  // 端口与 URL 路径里的 id 不是个人标识，而是报障时最需要的坐标：判据不是长度（bind(0) 的临时端口常 5 位），而是「前面紧挨着的是不是 `:` 或 `/`」。
  assert.match(redactLogText('出站网络: 经代理 127.0.0.1:7993'), /127\.0\.0\.1:7993/, '端口保留');
  assert.equal(
    redactLogText('[vinyl-server] listening on 127.0.0.1:10171'),
    '[vinyl-server] listening on 127.0.0.1:10171',
    '5 位临时端口也要留着：升级前它会被打码，日志里只剩 ***'
  );
  assert.equal(
    redactLogText('netease set-cookie 数量: 0 | url: https://music.163.com/weapi/v1/album/1967971'),
    'netease set-cookie 数量: 0 | url: https://music.163.com/weapi/v1/album/1967971',
    '专辑 / 曲目 id 是排查「这张专辑放不出来」的钥匙，同样留着'
  );
  assert.equal(redactLogText('曲目 id 1967971 也没了'), '曲目 id *** 也没了', '没有 : / 前缀的数字串照旧抹掉');
});

test('脱敏：代理串里的 user:pass 不写进日志（带 scheme 与裸形态都算）', () => {
  assert.equal(
    redactLogText('出站网络: 代理配置无法使用（user:pw@127.0.0.1:8080），按直连处理'),
    '出站网络: 代理配置无法使用（***@127.0.0.1:8080），按直连处理',
    '裸形态（HTTPS_PROXY 常这么写）：口令抹掉，host 留着'
  );
  assert.match(
    redactLogText('HTTPS_PROXY=http://alice:s3cret@proxy.corp:3128 不可用'),
    /\*\*\*@proxy\.corp:3128/,
    '带 scheme 的形态同理'
  );
  assert.doesNotMatch(redactLogText('联系 alice@example.com'), /\*\*\*/i, '邮箱没有冒号：不该被误伤');
});

test('脱敏：绝对路径只留最后一段（库名与系统用户名不进日志）', () => {
  const win = redactLogText(
    '[vinyl-server] cookie 已写入 D:\\Obsidian\\MyVault\\.obsidian\\plugins\\vinyl-life\\.qq-cookie 1630 bytes'
  );
  assert.match(win, /\.qq-cookie 1630 bytes/, '文件名留下：够定位是哪个文件');
  assert.doesNotMatch(win, /Obsidian|MyVault/, '库名与用户名不写进去');

  const mac = redactLogText('读取 /Users/zhangsan/Documents/MyVault/.cookie 失败');
  assert.doesNotMatch(mac, /zhangsan|Documents/, '类 Unix 路径同理');
  assert.match(mac, /\.cookie 失败/);
});

test('脱敏：URL 的查询串不写进日志（封面直链常带签名）', () => {
  const out = redactLogText(
    '[vinyl-server] 封面获取失败: https://cdn.example.com/a/b.jpg?sign=abc123def456&x=1 → socket hang up'
  );
  assert.doesNotMatch(out, /sign=/, '查询串整段不进日志');
  assert.match(out, /https:\/\/cdn\.example\.com\/a\/b\.jpg\?…/);
  assert.match(out, /socket hang up/, '报错原因留着：否则这条日志就没用了');
});

// ============ B. 接线（真实网关：进程内起一份，fs 只换掉盘面） ============

function gatewayWith(logSize = 0, opts = {}) {
  const filename = path.resolve(__dirname, '../server/gateway.js');
  const requireFromGateway = createRequire(filename);
  const appended = [];
  const renamed = [];
  const removed = [];
  const writes = [];
  let serverHandler = null;
  let logOnDisk = true; // 盘上已经有旧日志；滚动（rename）之后就没有了 —— statSync 照实报 ENOENT
  const files = new Map([['/test/.cookie', 'MUSIC_U=existing-account']]);
  // 盘上先放一份旧日志：启动时的「净化既有内容」是模块顶层跑的，只能这样喂给它
  if (opts.logContent !== undefined) {
    files.set('/test/gateway.log', opts.logContent);
    logOnDisk = true;
  }
  const context = {
    require(name) {
      if (name === 'fs') {
        return {
          readFileSync(file) {
            if (!files.has(file)) throw new Error('ENOENT');
            return files.get(file);
          },
          writeFileSync(file, value) {
            writes.push([file, value]);
            files.set(file, value);
          },
          appendFileSync(file, text) {
            appended.push(text);
          },
          statSync: () => {
            if (!logOnDisk || logSize === 0) throw new Error('ENOENT');
            return { size: logSize };
          },
          unlinkSync: (file) => removed.push(file),
          renameSync: (from, to) => {
            renamed.push([from, to]);
            logOnDisk = false;
          },
        };
      }
      if (name === 'dns') {
        return { lookup: (hostname, options, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]) };
      }
      if (name === 'http') {
        return { createServer: (handler) => { serverHandler = handler; return { listen() {}, on() {} }; } };
      }
      return requireFromGateway(name);
    },
    process: {
      env: {
        VINYL_COOKIE_FILE: '/test/.cookie',
        VINYL_TOKEN: 'fixture-token',
        VINYL_LOG_FILE: '/test/gateway.log',
      },
      pid: 1,
      uptime: () => 0,
    },
    __dirname: path.dirname(filename),
    console: { log() {}, error() {} },
    Buffer, URL, URLSearchParams, AbortSignal, setTimeout, clearTimeout,
    fetch: async () => {
      throw new Error('socket hang up');
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(filename, 'utf8') + '\nglobalThis.testRoutes = routes;', context);
  return {
    appended,
    renamed,
    removed,
    writes,
    files,
    call(method, url, query = {}) {
      const route = context.testRoutes.find((r) => r.method === method && r.pattern.test(url));
      assert.ok(route, `${method} ${url} exists`);
      return route.handler({ query, body: {}, cookie: '' });
    },
  };
}

test('接线：写进文件的是脱敏后的行（封面失败那条最典型）', async () => {
  const g = gatewayWith();
  await assert.rejects(
    () => g.call('GET', '/api/cover', { url: 'https://cdn.example.com/p.jpg?uin=1149716682&sign=x' }),
    /封面|cnd|连接/
  );
  const coverLine = g.appended.find((t) => t.includes('封面获取失败'));
  assert.ok(coverLine, '封面失败要落一条日志（用户报障时看的就是它）');
  assert.doesNotMatch(coverLine, /1149716682|sign=/, 'QQ 号与签名都不进文件');
  assert.match(coverLine, /p\.jpg\?…/);
  for (const line of g.appended) {
    assert.doesNotMatch(line, /uin \d|ptnick_\d|:\/\/[^@\s/]+@/, `日志里不该出现账号或口令：${line.trim()}`);
  }
});

test('接线：每行前面有时间戳（否则贴进 issue 的日志对不上时刻）', async () => {
  const g = gatewayWith();
  await assert.rejects(() =>
    g.call('GET', '/api/cover', { url: 'https://cdn.example.com/p.jpg' })
  );
  assert.ok(g.appended.length > 0);
  for (const line of g.appended) {
    assert.match(
      line,
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[vinyl-server\] /,
      `每行都要带本地时间戳：${line.trim()}`
    );
  }
});

test('接线：启动时净化已存在的日志（升级前那份里可能留着个人标识）', () => {
  // 脱敏只作用于新写入的行，而这份文件正是用户报障时要贴出去的那份 —— 所以每次启动先把既有内容过一遍
  const g = gatewayWith(0, {
    logContent: [
      '2026-09-01 10:00:00 [vinyl-server] qq qr/check code: 803（已校验并保存，uin 1149716682）',
      '2026-09-01 10:00:01 [vinyl-server] qq-login 取到 Cookie 键名: ptnick_1149716682',
    ].join('\n'),
  });
  const cleaned = g.files.get('/test/gateway.log');
  assert.doesNotMatch(cleaned, /1149716682/, '历史里的账号数字串要抹掉');
  assert.match(cleaned, /uin \*\*\*/);
  assert.match(cleaned, /ptnick_\*\*\*/);
  assert.match(cleaned, /2026-09-01 10:00:00/, '时间戳这些诊断信息原样留着');
});

test('接线：日志已经干净就不回写（别白动 mtime）', () => {
  const clean = '2026-09-01 10:00:00 [vinyl-server] listening on 127.0.0.1:10171\n';
  const g = gatewayWith(0, { logContent: clean });
  assert.equal(g.files.get('/test/gateway.log'), clean);
  assert.equal(g.writes.length, 0, '内容没变就不该有写盘动作');
});

test('接线：超过上限先滚成 .1 再写，只留一代', async () => {
  const g = gatewayWith(MAX_LOG_BYTES + 1);
  await assert.rejects(() =>
    g.call('GET', '/api/cover', { url: 'https://cdn.example.com/p.jpg' })
  );
  assert.deepEqual(g.renamed, [['/test/gateway.log', '/test/gateway.log.1']], '滚动一次');
  assert.deepEqual(g.removed, ['/test/gateway.log.1'], '先删旧的 .1：只留一代');
  assert.ok(
    g.appended.some((t) => t.includes('已滚到 gateway.log.1')),
    '滚动这件事本身要留痕（别静默换文件）'
  );
});

test('接线：没超上限就不动旧文件', async () => {
  const g = gatewayWith(MAX_LOG_BYTES - 1);
  await assert.rejects(() =>
    g.call('GET', '/api/cover', { url: 'https://cdn.example.com/p.jpg' })
  );
  assert.equal(g.renamed.length, 0, '没到上限：不滚动');
  assert.ok(g.appended.length > 0, '日志照常写');
});
