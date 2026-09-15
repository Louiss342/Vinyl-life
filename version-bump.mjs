// 版本发布脚本（对齐 Obsidian 官方 sample plugin 的做法）：
//   manifest.json 的 version 是唯一真源，本脚本把它同步到 versions.json 与 package.json。
//   用法：先改 manifest.json 的 version（必要时同步 minAppVersion），再执行
//     npm run version-bump
//   之后提交 manifest.json / versions.json / package.json，并打同名 tag 触发 release 工作流。
import { readFileSync, writeFileSync } from 'fs';

// 1) 读 manifest.json：拿目标版本与最低 Obsidian 版本
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const targetVersion = manifest.version;
const { minAppVersion } = manifest;

if (!targetVersion) {
	console.error('[version-bump] manifest.json 缺少 version 字段');
	process.exit(1);
}
// minAppVersion 缺失时 JSON.stringify 会把整条丢掉（{ '1.0.6': undefined } → {}），
// versions.json 就少了一个版本 —— 社区市场据此判断能不能装，缺条目会让更新对用户不可见。
if (!minAppVersion) {
	console.error('[version-bump] manifest.json 缺少 minAppVersion（versions.json 的兼容性依据）');
	process.exit(1);
}

// 2) 写 versions.json：插件版本 → 最低 Obsidian 版本（社区市场的兼容性依据）
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));

// 版本号只增不减：写错版本号时宁可报错，也不要悄悄把某一版从兼容表里抹掉
const semver = (v) => String(v).split('.').map((n) => Number(n) || 0);
const isNewer = (a, b) => {
	const [x, y] = [semver(a), semver(b)];
	for (let i = 0; i < 3; i++) {
		if (x[i] !== y[i]) return x[i] > y[i];
	}
	return false;
};
const latest = Object.keys(versions)
	.filter((k) => /^\d/.test(k))
	.sort((a, b) => (isNewer(a, b) ? 1 : -1))
	.pop();
if (latest && !isNewer(targetVersion, latest)) {
	console.error(`[version-bump] ${targetVersion} 不大于已发布的最大版本 ${latest}：版本号只增不减`);
	process.exit(1);
}
if (versions[targetVersion] !== undefined && versions[targetVersion] !== minAppVersion) {
	console.warn(
		`[version-bump] ${targetVersion} 已存在（minAppVersion ${versions[targetVersion]}），` +
			`将改写为 ${minAppVersion}`
	);
}
versions[targetVersion] = minAppVersion;
writeFileSync('versions.json', JSON.stringify(versions, null, '\t') + '\n');

// 3) 同步 package.json，避免构建产物与发布元数据版本不一致
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
pkg.version = targetVersion;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

// 4) styles.css 尾部的版本戳：插件启动时拿它核对样式表是否与代码同版本。
//    「升级只覆盖了 main.js」会留下新代码配旧样式（设置面板 1.0.10 起整块改版，
//    那时候会完全没样式），所以这一步必须跟着 version 一起走 —— 有测试在盯这一行。
const cssFile = 'styles.css';
const css = readFileSync(cssFile, 'utf8');
const stamp = `/*! vinyl-life styles v${targetVersion} — 由 npm run version-bump 维护，勿手改这一行：
   插件启动时核对版本（见 src/core/style-fallback.ts）；缺失或与 main.js 不符会自动挂上内置副本。 */`;
const STAMP_RE = /\/\*! vinyl-life styles v[0-9][0-9.]*[\s\S]*?\*\//;
if (STAMP_RE.test(css)) {
  writeFileSync(cssFile, css.replace(STAMP_RE, stamp));
} else {
  writeFileSync(cssFile, css.trimEnd() + '\n\n' + stamp + '\n');
}

console.log(`[version-bump] ${targetVersion} (minAppVersion ${minAppVersion})`);
