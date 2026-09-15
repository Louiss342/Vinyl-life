// 凭据文件读取（网易云 / QQ 共用）。
// 写侧只剩网关了（扫码 803 由网关原子落盘），插件侧不再持有凭据写入逻辑。
import * as fs from 'fs';

export function readCredentialFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return ''; // 文件不存在 / 无权限：按「没有凭据」处理
  }
}
