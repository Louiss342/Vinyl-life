// 轻量 i18n：模块级当前语言 + 字典查表（插件设置里切换，默认中文）。
// 覆盖面：专辑墙（工具栏 / 排序筛选 / 空态 / 卡片菜单）。其余视图（播放器、弹窗、设置）
// 暂以中文为主，后续按同一张表逐条补齐即可。
export type Lang = 'zh' | 'en';

export const LANGUAGES: Array<{ value: Lang; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
];

const DICT: Record<string, { zh: string; en: string }> = {
  // —— 专辑墙：排序 / 筛选 ——
  'sort.titleAsc': { zh: '标题 A → Z', en: 'Title A → Z' },
  'sort.titleDesc': { zh: '标题 Z → A', en: 'Title Z → A' },
  'sort.yearDesc': { zh: '年份：新 → 旧', en: 'Year: new → old' },
  'sort.yearAsc': { zh: '年份：旧 → 新', en: 'Year: old → new' },
  'sort.ratingDesc': { zh: '评分：高 → 低', en: 'Rating: high → low' },
  'sort.playsDesc': { zh: '播放次数：多 → 少', en: 'Plays: most → least' },
  'sort.recent': { zh: '最近播放', en: 'Recently played' },
  'filter.all': { zh: '全部', en: 'All' },
  'filter.local': { zh: '本地音源', en: 'Local audio' },
  'filter.netease': { zh: '网易云', en: 'NetEase' },
  'filter.qq': { zh: 'QQ 音乐', en: 'QQ Music' },
  'filter.collect': { zh: '仅收藏（无音源）', en: 'Collection only (no source)' },

  // —— 专辑墙：视图标题 / 工具栏 ——
  'shelf.title': { zh: '专辑墙', en: 'Album shelf' },
  'shelf.search': { zh: '搜索专辑 / 艺术家 / 流派…', en: 'Search album / artist / genre…' },
  'shelf.refresh': { zh: '刷新', en: 'Refresh' },
  'shelf.sort': { zh: '排序', en: 'Sort' },
  'shelf.filter': { zh: '音源筛选', en: 'Filter by source' },
  'shelf.props': { zh: '卡片属性', en: 'Card properties' },
  'shelf.importAlbum': { zh: '导入专辑', en: 'Import album' },
  'shelf.importAudio': { zh: '导入本地音频', en: 'Import local audio' },
  'shelf.empty.title': { zh: '还没有专辑笔记', en: 'No album notes yet' },
  'shelf.empty.hint': {
    zh: '新建笔记并写入 frontmatter：tags: [album] + cover / artist / year… 即可上墙；也可用工具栏「导入」从网易云或本地音频起步。',
    en: 'Create a note with frontmatter tags: [album] plus cover / artist / year… to put it on the shelf, or start with Import in the toolbar.',
  },
  'shelf.filtered.title': { zh: '没有符合条件的专辑', en: 'No albums match' },
  'shelf.filtered.hint': { zh: '调整搜索词或筛选条件试试', en: 'Try a different search or filter.' },

  // —— 卡片属性弹层 ——
  'props.shown': { zh: '已显示（拖拽调整顺序）', en: 'Shown (drag to reorder)' },
  'props.nonePicked': { zh: '未选择任何属性：卡片只显示标题。', en: 'No properties picked: cards show the title only.' },
  'props.available': { zh: '可添加（来自笔记 frontmatter）', en: 'Available (from note frontmatter)' },
  'props.noAlbums': { zh: '还没有专辑笔记。先用工具栏「导入」建一张。', en: 'No album notes yet — create one with Import first.' },
  'props.allAdded': { zh: '已全部添加。', en: 'Everything is already shown.' },
  'props.footer': {
    zh: '属性来自专辑笔记，部分省略；在笔记中添加属性后回到这里即可添加勾选。',
    en: 'Properties come from album notes (some hidden). Add one to a note, then come back to pick it here.',
  },

  // —— 卡片 / 角标 / 菜单 ——
  'card.collect': { zh: '收藏 ·', en: 'Collect ·' },
  'card.noSource': {
    zh: '该专辑暂无音源（本地音频、neteaseId 或 QQ 音乐），已打开笔记',
    en: 'This album has no source (local audio, neteaseId or QQ Music) — opened the note instead',
  },
  'menu.play': { zh: '播放', en: 'Play' },
  'menu.openNote': { zh: '打开笔记', en: 'Open note' },
  'menu.importAudio': { zh: '导入本地音频…', en: 'Import local audio…' },
  'menu.setCover': { zh: '设置封面…', en: 'Set cover…' },
  'menu.openNetease': { zh: '在网易云打开', en: 'Open in NetEase' },
  'menu.openQq': { zh: '在 QQ 音乐打开', en: 'Open in QQ Music' },
  'menu.deleteAlbum': { zh: '删除专辑…', en: 'Delete album…' },
};

let current: Lang = 'zh';

export function setLanguage(lang: string | undefined): void {
  current = lang === 'en' ? 'en' : 'zh';
}

export function getLanguage(): Lang {
  return current;
}

/** 查表；缺键时回退中文，再缺则返回 key 本身（便于发现漏翻） */
export function t(key: string): string {
  const entry = DICT[key];
  if (!entry) return key;
  return entry[current] || entry.zh;
}
