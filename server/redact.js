// 网关日志的脱敏规则（纯函数，零 require —— 与 qq.js / kugou.js 同一条纪律，
// 测试直接 require 本文件，不必起网关）。
//
// 为什么要有它：gateway.log 的用途是用户报障时贴进 issue（CONTRIBUTING 与
// .github/ISSUE_TEMPLATE/bug_report.md 都这么引导），所以个人标识一律不进文件。
// 凭据**值**本来就不写（只写长度），这里再挡住三类会被连带写出去的：
//   ① 长数字串（≥5 位）：QQ 号 / uin，以及 cookie 名里的 ptnick_<uin>。
//      长度（2-3 位）、状态码、端口（4 位）都不受影响。
//   ② 绝对路径：库内外的目录名（含系统用户名）只留最后一段，够定位是哪个文件就行。
//   ③ URL 的查询串：封面直链常带签名，贴出去等于把别人的图床凭据一起贴了。
const LONG_DIGITS = /\d{5,}/g;
const WINDOWS_PATH = /[A-Za-z]:\\[^\s"',;)\]]+/g;
const UNIX_PATH = /\/(?:Users|home|root|Volumes|mnt)\/[^\s"',;)\]]+/g;
const URL_WITH_QUERY = /(https?:\/\/[^\s"'?,;)\]]+)\?[^\s"',;)\]]*/g;

/** 路径的最后一段（文件名）：分隔符两种都认，末尾的引号 / 逗号已在正则里排掉 */
function lastSegment(p) {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function redactLogText(text) {
  return String(text)
    .replace(LONG_DIGITS, '***')
    .replace(WINDOWS_PATH, (m) => lastSegment(m))
    .replace(UNIX_PATH, (m) => lastSegment(m))
    .replace(URL_WITH_QUERY, '$1?…');
}

/** 单个日志文件的体积上限：超了就滚一份 .1（只留一代）。
 *  日志文件就在插件目录里（库内），无上限的 append 会把它撑成几十 MB 被一起同步。 */
const MAX_LOG_BYTES = 512 * 1024;

module.exports = { redactLogText, MAX_LOG_BYTES };
