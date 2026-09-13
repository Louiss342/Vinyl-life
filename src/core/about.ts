// 「关于」标签页的内容常量。
// 注意：ABOUT_TEXT 是作者手记的原文，**不属于 i18n 键、不要翻译、不要参与任何文案改写**
// （包括「润色」、改错别字、补标题——错别字也是原文的一部分）。
// 逐字照录：首行末尾有一个空格、段落之间是空行。这两处特殊空白用 \n 转义写死，
// 免得编辑器「保存时删除行尾空格」或 git 的 CRLF 换行转换把它悄悄改掉（值不受影响）。
export const ABOUT_TEXT =
  '一首歌值得被写下来。 \n' +
  '\n' +
  '把唱针轻轻搭上，那一秒爆豆子似的静电声。它出现在哪一年、哪个城市、哪一场雨；它陪过你熬过哪一夜；它让你想起谁。这些不该沉在记忆里，也不该变成一个社交平台上的动态。它应该是你自己的一页纸，私人，安静，可以一直放在那儿。\n' +
  '\n' +
  '音乐和笔记也许本身有着天然的亲和力。\n';

// 作者手记的英译（作者已授权）：与中文原文**并列展示**（中文在上、英文在下），
// 所以它同样不是 i18n 文案 —— 不建键、不进词典、不跟语言开关走（否则这页只剩一种语言，
// 并列对照就没了）。上面对中文原文的逐字约束同样适用于这份英译：不改写、不润色、不补标题。
// 逐字照录：段落之间是空行，末行行尾保留一个换行（与 ABOUT_TEXT 一致）。
// 同样用 \n 转义写死，免得编辑器「保存时删除行尾空格」或 git 的 CRLF 换行转换把它悄悄改掉。
export const ABOUT_TEXT_EN =
  'A song is worth writing down.\n' +
  '\n' +
  'Put the needle down, and for a second there is only that crackle — like beans popping. The year it came from, the city, the rain; the night it carried you through; the person it brings back. These things should not sink into memory, and should not become a post on a social platform. They should be a page of your own — private, quiet, somewhere it can stay.\n' +
  '\n' +
  'Music and notes may have a natural affinity for each other.\n';

/** 仓库地址（「关于」页底部的 GitHub 外链）。github.com 与产品名不翻译，故不进词典。 */
export const REPO_URL = 'https://github.com/Louiss342/Vinyl-life';
