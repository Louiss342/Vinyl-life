// 三产物构建：
//   1) server.js —— 独立网关产物，供 CLI 联调 / 本地排查（发布不携带）
//   2) src/core/gateway-bundle.ts —— 把网关源码内联成 TS 模块，随 main.js 一起分发
//      （社区市场只安装 main.js / manifest.json / styles.css，运行时再把源码落盘到临时目录 spawn）
//   3) src/core/style-bundle.ts —— 把 styles.css 内联成 TS 模块：手工安装漏掉样式文件时，
//      插件把它挂成构造样式表兜底（见 src/core/style-fallback.ts），界面不至于完全无样式
import esbuild from 'esbuild';
import fs from 'fs';
import crypto from 'crypto';
import zlib from 'zlib';

const NODE_BUILTINS = [
  'fs', 'path', 'net', 'http', 'https', 'child_process', 'os', 'crypto',
  'url', 'events', 'stream', 'buffer', 'util', 'zlib', 'querystring',
  'string_decoder', 'tty', 'dns', 'tls', 'assert', 'timers', 'constants',
];

// sourcemap 用外部文件（main.js.map / server.js.map），不占产物本体体积
const common = {
  bundle: true,
  minify: true,
  sourcemap: true,
  charset: 'utf8', // 保留中文文案原文（可读性 + 便于排查）
  logLevel: 'info',
};

const GATEWAY_BUNDLE = 'src/core/gateway-bundle.ts';
const STYLE_BUNDLE = 'src/core/style-bundle.ts';

async function build() {
  // 1) 网关产物（内联用到的网易云子模块与 server/qq.js、server/kugou.js，可独立运行）
  await esbuild.build({
    ...common,
    entryPoints: ['server/gateway.js'],
    outfile: 'server.js',
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    external: NODE_BUILTINS,
  });

  // 2) 网关源码 → TS 模块（构建中间产物，不提交）。
  //    gzip + base64 后内联：88 KB 明文字符串会吃掉 main.js 三分之一体积，压缩后仅 ~20 KB；
  //    运行时用 zlib.gunzipSync 还原（渲染进程可直接 require node 内建模块）。
  //    hash 用于临时文件名，升级即换新文件。
  const src = fs.readFileSync('server.js', 'utf8');
  const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 10);
  const gz = zlib.gzipSync(Buffer.from(src, 'utf8'), { level: 9 }).toString('base64');
  // 与 styles.css 同一条保证：当场解压回验，坏字节 / 版本错位在构建时就失败。
  // 这份载荷是运行时 gunzipSync 还原的：坏了插件照常启动，只有在线音源整块不可用 ——
  // 那种故障不该留到用户那里才发现（测试侧另有一条「产物与 server.js 逐字节一致」，
  // 见 scripts/gateway-bundle.test.cjs）。
  if (!zlib.gunzipSync(Buffer.from(gz, 'base64')).equals(Buffer.from(src, 'utf8'))) {
    throw new Error('网关内联校验失败：解压结果与 server.js 不一致');
  }
  fs.writeFileSync(
    GATEWAY_BUNDLE,
    '// 由 esbuild.config.mjs 构建时生成，请勿手改、勿提交（见 .gitignore）。\n' +
      `export const GATEWAY_HASH = ${JSON.stringify(hash)};\n` +
      `export const GATEWAY_GZIP = ${JSON.stringify(gz)};\n`
  );

  // 2.5) styles.css → TS 模块（构建中间产物，不提交）：
  //      手工安装漏掉 styles.css 时，插件用它挂一张构造样式表兜底（见 src/core/style-fallback.ts）。
  //      先压缩再 gzip：源文件保持带注释的可读形态，进产物的只有压缩结果 ——
  //      实测 199.6 → 132.6 KB（gz 91.7 → 63.0），载荷 122.2 → 82.9 KB，占 main.js 8%。
  //      省下的几乎全是注释：中文散文在 gzip 下压不动，是这份载荷里唯一一块纯浪费；
  //      两个字体子集的 base64 本身是 woff2（已压过一遍），gzip 与压缩都动不了它。
  //      压缩只动记号（空白 / 注释 / 颜色等价写法 / ::after 别名 / 同体相邻规则合并），不改规则 ——
  //      字体与版本戳逐字节保留，scripts/style-bundle.test.cjs 钉着这一点。
  //      与网关同一保证：构建期当场校验「解压结果与压缩后的源逐字节一致」，坏了直接构建失败。
  const cssSrc = fs.readFileSync('styles.css', 'utf8');
  const cssMin = esbuild.transformSync(cssSrc, { loader: 'css', minify: true }).code;
  const cssGz = zlib.gzipSync(Buffer.from(cssMin, 'utf8'), { level: 9 }).toString('base64');
  if (!zlib.gunzipSync(Buffer.from(cssGz, 'base64')).equals(Buffer.from(cssMin, 'utf8'))) {
    throw new Error('styles.css 内联校验失败：解压结果与压缩后的样式不一致');
  }
  fs.writeFileSync(
    STYLE_BUNDLE,
    '// 由 esbuild.config.mjs 构建时生成，请勿手改、勿提交（见 .gitignore）。\n' +
      `export const STYLE_GZIP = ${JSON.stringify(cssGz)};\n`
  );

  // 3) 前端插件产物（minify；体积预算见 build 末尾的 MAIN_JS_BUDGET，超了直接失败）
  await esbuild.build({
    ...common,
    entryPoints: ['src/main.ts'],
    outfile: 'main.js',
    format: 'cjs',
    platform: 'browser',
    target: 'es2021',
    external: ['obsidian', 'electron', '@electron/remote', ...NODE_BUILTINS],
  });

  const sizes = {};
  for (const f of ['main.js', 'server.js', GATEWAY_BUNDLE, STYLE_BUNDLE]) {
    const s = fs.statSync(f).size;
    sizes[f] = s;
    console.log(`[vinyl-build] ${f}: ${(s / 1024).toFixed(1)} KB`);
  }

  // 体积预算：main.js 是社区市场分发的下载主体（server.js / gateway-bundle / styles.css 都会内联进去）。
  // 超了就构建失败而不是只打日志 —— 悄悄涨到几 MB 是没人会注意的那种退化。改预算时同步 README。
  // 260 → 318：空态教程的两处开销 —— 手写体（拉丁 Excalifont + 中文霞鹜文楷两个子集，内联在
  // styles.css 尾部，见 assets/fonts/）约 41 KB，手绘笔触引擎 roughjs（与 Excalidraw 同款）约 26 KB。
  // 318 → 348：设置面板「关于」页也走手写体，同一对字体按两处文案重做子集（中文多收 160 多字）
  // —— 字体从 31 KB 涨到 47 KB。两处都是为了把设计稿 1:1 搬到插件里；哪天不要了，把预算调回 260。
  // 348 → 384：播放器改成「立方体两面」（Drawing 2026-09-16 10.26.32）—— 新增唱片区（三行唱片架：
  // 视差 / 悬停平放展开 / 多选排队，src/views/album-picker.ts）与唱臂几何换算
  // （src/core/arm-geometry.ts，余弦定理把专辑进度换算成落针距离），styles.css 也多了这一套样式。
  // 都是设计稿要求的功能代码，没有新依赖；哪天不要唱片区了，把预算调回 348。
  // （常数此前忘了跟着注释一起改，实际卡在 368；这次改到 384，同时补上这一轮的面板按键样式。）
  // 384 → 400：导入搜索重做 —— 本地模糊重排（归一化 / 编辑距离近似）、结果池与上游翻页，
  // 加上弹窗的展开 / 翻页状态机，共约 6 KB。没有新依赖，全是搜索质量本身的代码。
  // 400 → 420：独立统计页 —— 近一年热力日历、当日唱片墙、专辑快照恢复、
  // 自定义属性汇总和 Markdown 导出。新增为功能代码与样式，没有引入依赖。
  // （累计播放行另走手写体：文案进了两个字体子集，中文面 +0.7 KB，仍在这条预算之内。）
  // 420 → 440：工具栏交互重做（方案 2026-09-18）—— 单行工具栏 + 原位搜索 + 陈列 / 添加两个浮层 +
  // 选择模式改挂工具栏（去掉底部动作条）。导入搜索抽成 views/album-search（弹窗与添加浮层共用）、
  // 新增 views/add-panel，styles.css 多出工具栏 / 浮层样式 —— 净增约 9 KB，全是这次交互的代码。
  // 440 → 460：第三路在线音源「酷狗音乐」—— 网关模块（server/kugou.js：设备指纹注册 + 扫码登录 +
  // 匿名曲库 + 取流双链）、前端客户端与登录态、来源筛选 / 搜索来源 / 设置「源」页的第三分区，
  // 以及对应的 i18n 文案与 is-kugou 角标样式。没有新依赖，全是这一路音源自己的代码。
  // 460 → 480：搓碟（方案 2026-09-24）—— 手势换算与指针接管（core/scratch）、解码搓碟台
  // （core/scratch-deck：内存预算挑采样率、负速率探测、倒放副本）、播放引擎的搓碟通道
  // （虚拟时间 + 轻量倍速）、转盘接管与逐帧驱动、设置两个新行与四条文案、styles.css 的接管样式。
  // 没有新依赖，全是这一套交互自己的代码。
  // 480 → 500：收藏健康检查、备份恢复、音源关联与队列笔记；无新增运行时依赖。
  // 500 → 520：评审意见落实 —— 健康检查分档 + 仅收藏标记 + 试播范围 / 限速 / 中止、
  // 裁剪前自动归档（main.ts 的 archivePrunedEvents）、关联弹窗并排比对与模糊搜索
  // （core/album-discovery 的库内候选排序）、队列笔记改成「列表即队列」。净增约 11 KB，
  // 全是功能与文案代码，没有新依赖。
  // 520 → 540：历史页收拢成「数据管理」（备份位置 / 最近成功备份 / 每周自动备份与保留份数 /
  // 恢复与清空的范围说明）、自动备份与保留份数清理、健康检查的三个修复入口
  // （重新定位音频 / 设置封面 / 重试并清除）、播放明细保留改成低水位裁剪。
  // 净增约 10 KB，仍是功能与文案代码，没有新依赖。
  // （2026-09 审计瘦身：内联样式改成「先压缩再 gzip」，同一份 styles.css 的载荷 122.2 → 83.0 KB，
  //   main.js 实测 524.8 → 485.5 KB —— 预算不动，余量从 19 KB 回到约 54 KB。省下的全是注释，
  //   字体子集与版本戳逐字节保留，见上面 2.5) 那一段与 scripts/style-bundle.test.cjs。）
  // 540 → 600：这里有一段**注释与实测脱节**的教训 —— 上面「余量约 54 KB」是 2026-09 瘦身当天的数，
  //   之后歌词面 / 马达斜坡 / 逐曲评分 / 本地标签几波功能进来，实测余量只剩 15.7 KB，而注释还写着 54。
  //   维护者按注释做取舍判断，等于拿着错的地图。所以这次除了改预算，还把余量打进构建日志（见下面那行），
  //   让数字再也漂不动。
  //   预算 540 → 600 是明说的取舍（用户 2026-09-26 决定）：这一波功能是真实功能，不该为了省 60 KB
  //   去砍设计稿。若哪天又要瘦身，最大的一根杠杆是**兜底副本里的字体**：内联样式载荷 64.5 KB 里
  //   有 48.6 KB（base64 后约 64.8 KB）是两个手写体子集，而它只在「手工安装漏了 styles.css」时用得上
  //   —— 剥掉它界面仍有完整样式、只退回系统字体。真要动它，需同步 scripts/style-bundle.test.cjs
  //   那条「载荷逐字节等于 styles.css 压缩后」的契约。
  const MAIN_JS_BUDGET = 600 * 1024;
  console.log(
    `[vinyl-build] main.js 余量: ${((MAIN_JS_BUDGET - sizes['main.js']) / 1024).toFixed(1)} KB` +
      `（预算 ${MAIN_JS_BUDGET / 1024} KB）`
  );
  if (sizes['main.js'] > MAIN_JS_BUDGET) {
    throw new Error(
      `main.js 体积 ${(sizes['main.js'] / 1024).toFixed(1)} KB 超出预算 ${MAIN_JS_BUDGET / 1024} KB：` +
        '看看是不是误引入了大依赖（能内联的小实现优先），确有必要再调 esbuild.config.mjs 里的预算'
    );
  }
}

build().catch((e) => {
  console.error('[vinyl-build] failed', e);
  process.exit(1);
});
