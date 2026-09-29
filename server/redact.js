// 网关日志的脱敏规则（纯函数，零 require —— 与 qq.js / kugou.js 同一条纪律，测试直接 require 本文件，不必起网关）。
//
// 为什么要有它：gateway.log 的用途是用户报障时贴进 issue（CONTRIBUTING 与 .github/ISSUE_TEMPLATE/bug_report.md
// 都这么引导），个人标识一律不进文件。凭据**值**本来就不写（只写长度），这里再挡住四类会被连带写出去的：
//   ① 账号数字串（≥5 位：QQ 号 / uin、cookie 名里的 ptnick_<uin>）—— 但**端口与 URL 路径里的 id 要留着**：
//      127.0.0.1:10171 的临时端口正好也是 5 位，/weapi/v1/album/1967971 同样是长数字，它们是排查坐标而非
//      个人标识。故判据不是长度而是「前面紧挨着的字符」：跟在 `:`（端口）或 `/`（URL 路径段）后面的数字留着，
//      其余照样抹掉（`uin 123…`、`ptnick_123…`）。
//   ② 绝对路径只留最后一段（库内外目录名含系统用户名，够定位是哪个文件就行）。
//   ③ URL 的查询串：封面直链常带签名，贴出去等于把别人的图床凭据一起贴了。
//   ④ URL 与代理串里的 user:pass：网关会把「无法使用的代理配置」原样写进日志，那种串常带代理口令。
const LONG_DIGITS = /(^|[^:/\d])(\d{5,})/g;
const WINDOWS_PATH = /[A-Za-z]:\\[^\s"',;)\]]+/g;
const UNIX_PATH = /\/(?:Users|home|root|Volumes|mnt)\/[^\s"',;)\]]+/g;
const URL_WITH_QUERY = /(https?:\/\/[^\s"'?,;)\]]+)\?[^\s"',;)\]]*/g;
// 带 scheme（http://user:pass@host）与裸形态（HTTPS_PROXY=user:pass@host）各一条：裸形态要求冒号两侧都
// 不含分隔符 —— 免得把 `HTTPS_PROXY=` 这种前缀一起吃进去，也不误伤邮箱（邮箱没有冒号）。host 原样留着：报障要知道连的是哪个代理。
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi;
const BARE_USERINFO = /([^\s@:/\\=,;()（）\[\]<>"']+:[^\s@/\\=,;()（）\[\]<>"']+)@/g;

/** 路径的最后一段（文件名）：分隔符两种都认，末尾的引号 / 逗号已在正则里排掉 */
function lastSegment(p) {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function redactLogText(text) {
  return String(text)
    .replace(LONG_DIGITS, '$1***')
    .replace(WINDOWS_PATH, (m) => lastSegment(m))
    .replace(UNIX_PATH, (m) => lastSegment(m))
    .replace(URL_WITH_QUERY, '$1?…')
    // 口令放最后：前面几条会把 URL 的查询串先摘掉，剩下的 user:pass@ 才看得清
    .replace(URL_USERINFO, '$1***@')
    .replace(BARE_USERINFO, '***@');
}

/** 单个日志文件的体积上限：超了就滚一份 .1（只留一代）——日志就在插件目录里（库内），
 *  无上限的 append 会把它撑成几十 MB 被一起同步。 */
const MAX_LOG_BYTES = 512 * 1024;

module.exports = { redactLogText, MAX_LOG_BYTES };
