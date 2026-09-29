// 设置面板的「分区」外壳：标题栏（圆角图标徽章 + 分区名）+ 内容区。
// 抽成独立模块是为了让统计页复用同一套视觉：通用 / 外观 / 源 / 统计 四个页面的卡片必须长得一样
// （同样的标题栏、圆角、阴影、悬停），否则改一处就会漂。
import { Setting, getIconIds, setIcon } from 'obsidian';
import { BRAND_ICON_IDS } from './brand-icons';

/** 图标名 → 文本符号：宿主没有对应 Lucide 图标时的回落。字形由系统字体逐字回落决定，换机器会变样
 *  （粗细/大小不一致，缺字形时是豆腐块），只当兜底用，别当主路径。 */
const SECTION_ICONS: Record<string, string> = {
  'sliders-horizontal': '⌁',
  'folder-tree': '⌂',
  'notebook-pen': '✎',
  'audio-lines': '≋',
  'panel-right-open': '▣',
  'chart-no-axes-column': '▥',
  'layout-grid': '⊞',
  'disc-3': '◉',
  'radio-tower': '⌁',
  cloud: '☁',
  'message-circle-more': '◌',
  headphones: '♪',
  'hard-drive': '▱',
  // —— 统计页 ——
  'calendar-days': '▦',
  history: '↺',
  'trending-up': '↗',
  'chart-pie': '◔',
};

/** 本插件自己注册的图标（见 views/brand-icons）：它们必然在表里，不走「宿主有没有这个名字」那道判断 ——
 *  knownIcons 是一次性缓存，万一在注册之前就被填上，这几个名字会被永远判成没有、回落成文本符号。 */
const OWN_ICONS = new Set<string>(Object.values(BRAND_ICON_IDS));

/** 分区图标：优先用 Obsidian 自带的 Lucide（内联 SVG，形状与线条跨平台一致），
 *  本插件自注册的品牌图标同一套取用方式（也是内联 SVG）。 */
export function mountSectionIcon(el: HTMLElement, name: string): void {
  if (OWN_ICONS.has(name) || hasIcon(name)) {
    setIcon(el, name);
    return;
  }
  el.setText(SECTION_ICONS[name] ?? '·');
}

// 宿主装了哪些图标：取一次就够（图标集在会话内不变）；老 Obsidian 没有 getIconIds 或图标太新 → 回落文本符号。
let knownIcons: Set<string> | null = null;
function hasIcon(name: string): boolean {
  if (!knownIcons) {
    try {
      knownIcons = new Set(getIconIds());
    } catch {
      knownIcons = new Set();
    }
  }
  return knownIcons.has(name);
}

export interface SettingsSection {
  /** 卡片本体（分区容器） */
  root: HTMLElement;
  /** 标题行：要往标题栏右侧挂控件就用它（如 heading.addDropdown） */
  heading: Setting;
  /** 内容区（无内边距）：设置行 / 统计页自己的内容都往这里放 */
  body: HTMLElement;
}

/** 一个分区：标题栏走 Obsidian 原生 Setting 标题行，外观由 styles.css 的 .vinyl-settings-section 负责 */
export function settingsSection(
  parent: HTMLElement,
  text: string,
  kind: string,
  icon: string,
  build?: (body: HTMLElement) => void
): SettingsSection {
  const root = parent.createDiv({ cls: `vinyl-settings-section is-${kind}` });
  const heading = new Setting(root).setName(text).setHeading();
  heading.settingEl.addClass('vinyl-settings-section-heading');
  const iconEl = heading.settingEl.createSpan({ cls: 'vinyl-settings-section-icon' });
  mountSectionIcon(iconEl, icon);
  const body = root.createDiv({ cls: 'vinyl-settings-section-body' });
  build?.(body);
  return { root, heading, body };
}
