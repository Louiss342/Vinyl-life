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

// 2) 写 versions.json：插件版本 → 最低 Obsidian 版本（社区市场的兼容性依据）
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
versions[targetVersion] = minAppVersion;
writeFileSync('versions.json', JSON.stringify(versions, null, '\t') + '\n');

// 3) 同步 package.json，避免构建产物与发布元数据版本不一致
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
pkg.version = targetVersion;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

console.log(`[version-bump] ${targetVersion} (minAppVersion ${minAppVersion})`);
