// 发布元数据：manifest.json 是版本真源，versions.json 与 package.json 必须跟着它走。
//
// 为什么要有这一条（2026-09 审计）：release.yml 此前只比对 tag 与 manifest.version，
// 另外两份文件全程无人校验 —— 改了 manifest、打 tag、发布成功，但 versions.json 少一条目时，
// 社区市场（据 versions.json 判断「这个版本的最低 Obsidian 版本」）不会给任何用户推更新，
// 而且从头到尾没有任何报错。正是 version-bump.mjs 第 18 行警告的那种静默失败。
//
// release.yml 的「Check versions.json / package.json match manifest」直接跑这个文件
// （同一份实现，不另写一套 YAML 断言），本地 `npm test` 与 CI 每次推送也都会跑到。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

const manifest = read('manifest.json');
const versions = read('versions.json');
const pkg = read('package.json');

const SEMVER = /^\d+\.\d+\.\d+$/;
const rank = (v) => String(v).split('.').map((n) => Number(n) || 0);
const newer = (a, b) => {
  const [x, y] = [rank(a), rank(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

test('manifest.version 是合法三段版本号（tag 会与它逐字比对）', () => {
  assert.match(manifest.version, SEMVER, `manifest.version=${manifest.version} 不是 x.y.z`);
});

test('manifest.minAppVersion 是合法三段版本号（缺了会让 versions.json 丢条目）', () => {
  // version-bump.mjs 第 18 行：minAppVersion 缺失时 JSON.stringify 会把整条丢掉，
  // versions.json 就少一个版本 —— 社区市场据此判断能不能装，缺条目 = 更新对用户不可见
  assert.match(
    manifest.minAppVersion,
    SEMVER,
    `manifest.minAppVersion=${manifest.minAppVersion} 不是 x.y.z：versions.json 的兼容性依据，不能缺`
  );
});

test('versions.json 有当前版本的条目，且 minAppVersion 与 manifest 一致', () => {
  assert.equal(
    versions[manifest.version],
    manifest.minAppVersion,
    `versions.json 缺少（或写错）${manifest.version} 的条目：跑 npm run version-bump，` +
      '社区市场据此给用户推更新 —— 缺条目时不会报错，只是更新永远不出现'
  );
});

test('versions.json 里最大的版本就是 manifest.version（改了 manifest 没跑 version-bump 会红）', () => {
  const keys = Object.keys(versions).filter((k) => SEMVER.test(k));
  assert.ok(keys.length > 0, 'versions.json 里一条版本都没有');
  const latest = keys.reduce((a, b) => (newer(b, a) ? b : a));
  assert.equal(
    latest,
    manifest.version,
    `versions.json 最新版本是 ${latest}，manifest 是 ${manifest.version}：` +
      '先改 manifest.version，再 npm run version-bump，然后一起提交'
  );
});

test('package.json 的 version 与 manifest 一致（构建产物与发布元数据不能对不上）', () => {
  assert.equal(
    pkg.version,
    manifest.version,
    `package.json 是 ${pkg.version}、manifest 是 ${manifest.version}：跑 npm run version-bump 同步`
  );
});
