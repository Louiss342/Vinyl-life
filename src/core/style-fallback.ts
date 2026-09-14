// 样式兜底：手工安装漏掉 styles.css（发布页三个文件之一）会让界面完全无样式 ——
// 看起来「坏了 / 没法用」，其实功能正常、只是没皮。
// 构建期已把 styles.css 内联进 main.js（见 esbuild.config.mjs 的 style-bundle 段），
// 这里在插件目录找不到 styles.css 时，把内联副本挂成一张构造样式表。
// 为什么不用 <style>/<link> 元素：Obsidian 官方 lint（obsidianmd/no-forbidden-elements，
// 市场审核同一套规则）明确禁止创建这两类元素；document.adoptedStyleSheets 等效且不触线。
// 正常安装（社区市场 / 三个文件齐全）下什么都不做：Obsidian 自己会加载 styles.css。
import * as fs from 'fs';
import { gunzipSync } from 'zlib';

/** 返回清理函数（从 adoptedStyleSheets 摘掉）；无需兜底时返回 null。 */
export function installStyleFallback(stylesPath: string, gzBase64: string): (() => void) | null {
  try {
    if (fs.existsSync(stylesPath)) return null;
  } catch {
    return null; // 判断不了就按「已安装」处理：宁可不挂，也不重复叠加
  }
  try {
    if (typeof CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in document)) {
      return null; // 老宿主没有构造样式表：静默跳过（Obsidian 1.13+ 的 Electron 都有）
    }
    // 先解压再建表：载荷损坏（构建异常）时直接走 catch，不留下半成品
    const css = gunzipSync(Buffer.from(gzBase64, 'base64')).toString('utf8');
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    console.warn('[vinyl] styles.css 缺失：已挂上内置样式兜底（建议从社区市场重装补齐文件）');
    return () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    };
  } catch (e) {
    console.error('[vinyl] 内置样式兜底失败', e);
    return null;
  }
}
