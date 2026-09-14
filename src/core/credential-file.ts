// 凭据文件读写（网易云 / QQ 共用）：
// 原子写（tmp + rename）+ 0600 + 统一错误文案；绝不半途留下损坏文件。
import * as fs from 'fs';

export function writeCredentialFile(file: string, value: string): void {
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, String(value || '').trim(), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件可能本就没写成功：清不掉也无妨，直接报主错误
    }
    throw new Error('登录凭据写入失败，请检查插件目录权限');
  }
}

export function readCredentialFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return ''; // 文件不存在 / 无权限：按「没有凭据」处理
  }
}
