// 凭据文件读取（网易云 / QQ 共用）。
// 写侧只剩网关了（扫码 803 由网关原子落盘），插件侧不再持有凭据写入逻辑。
// 为什么走 fs 而不用 vault API：凭据按约定落在插件目录（<vault>/.obsidian/plugins/vinyl-life/），
// 那是笔记库之外 —— 也是审核披露的 fs 能力之一（为什么需要，见 CONTRIBUTING）。
import * as fs from 'fs';

export function readCredentialFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return ''; // 文件不存在 / 无权限：按「没有凭据」处理
  }
}
