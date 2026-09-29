// 样式兜底：styles.css 缺失或与代码不同版本时，挂上构建期内联的副本，界面不至于裸奔。
//
// 两种要兜的情况：① 文件不在（手工安装漏了发布页三个文件之一）；② 文件在、版本不对 —— 升级时只覆盖了
// main.js、或同步/拷贝只到一半（截断会连尾部的版本戳一起丢）。设置面板 1.0.10 起整版改版，样式全在这份
// 文件里：旧样式配新代码会完全没样式、手绘虚线框还会飘到空白处（此前只看 existsSync，这种情况全漏掉）。
//
// 版本戳在 styles.css 末尾，由 `npm run version-bump` 与 manifest 同步写入。不用 <style>/<link> 的
// 原因：Obsidian 官方 lint（obsidianmd/no-forbidden-elements，市场审核同一套规则）禁止创建这两类
// 元素，document.adoptedStyleSheets 等效且不触线。正常安装（三个文件齐全）下什么都不做。
import * as fs from 'fs';
import { gunzipSync } from 'zlib';

/** styles.css 尾部的版本戳：`/*! vinyl-life styles v1.0.12 …` */
const STAMP = /\/\*! vinyl-life styles v([0-9][0-9.]*)/;

/** 样式表要不要兜底：返回简短原因（ASCII，接在下面的 [vinyl] 日志里），不需要时返回 null。 */
function styleProblem(stylesPath: string, version: string): string | null {
  let css: string;
  try {
    css = fs.readFileSync(stylesPath, 'utf8');
  } catch {
    return 'styles.css missing';
  }
  const found = STAMP.exec(css)?.[1];
  if (!found) return 'styles.css has no version stamp (truncated?)';
  if (found !== version) return `styles.css is v${found}, plugin is v${version}`;
  return null;
}

/** 返回清理函数（从 adoptedStyleSheets 摘掉）；无需兜底时返回 null。 */
export function installStyleFallback(
  stylesPath: string,
  gzBase64: string,
  version: string
): (() => void) | null {
  const problem = styleProblem(stylesPath, version);
  if (!problem) return null;
  try {
    if (typeof CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in document)) {
      return null; // 老宿主没有构造样式表：静默跳过（Obsidian 1.13+ 的 Electron 都有）
    }
    // 先解压再建表：载荷损坏（构建异常）时直接走 catch，不留下半成品
    const css = gunzipSync(Buffer.from(gzBase64, 'base64')).toString('utf8');
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    console.warn(`[vinyl] ${problem}：已挂上内置样式兜底（建议从社区市场重装或补齐 styles.css）`);
    return () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    };
  } catch (e) {
    console.error('[vinyl] 内置样式兜底失败', e);
    return null;
  }
}
