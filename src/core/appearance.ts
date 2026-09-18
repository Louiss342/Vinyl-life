// 外观选项（播放器面板配色 / 黑胶唱片配色）：值 → CSS 类名 + 设置面板文案。
// 单独成模块的原因与 disc-motion 相同：视图与设置面板都要用，而设置面板不能反向依赖
// settings.ts（那会拉起登录弹窗整条依赖链，脚本测试也不该为此 bundle 整个设置面板）。

/** 播放器面板配色（.vinyl-deck 的材质）。显示名不放这里：设置面板按当前语言查词典
 *  （settings.ts 的 DECK_LABEL_KEYS），这里只留值，免得出现「表里有中文但没人读」的幽灵文案。
 *  coral = 珊瑚红参考（哑光漆面 + 帆布织纹 + 奶白盘，见 styles.css 的 .is-deck-coral）。 */
export type DeckStyle = 'walnut' | 'shell' | 'black' | 'coral';
export const DECK_STYLES: readonly DeckStyle[] = ['walnut', 'shell', 'black', 'coral'];

/** 黑胶唱片配色（专辑墙卡片与播放器转盘同时生效） */
export type RecordColor = 'black' | 'yellow' | 'blue' | 'white';
export const RECORD_COLORS: readonly RecordColor[] = ['black', 'yellow', 'blue', 'white'];

export const DEFAULT_DECK_STYLE: DeckStyle = 'walnut';
export const DEFAULT_RECORD_COLOR: RecordColor = 'black';

export function deckClass(v: DeckStyle): string {
  return `is-deck-${v}`;
}

export function recordClass(v: RecordColor): string {
  return `is-record-${v}`;
}

/** data.json → 面板配色（脏值回落默认） */
export function normalizeDeckStyle(raw: unknown): DeckStyle {
  return DECK_STYLES.includes(raw as DeckStyle) ? (raw as DeckStyle) : DEFAULT_DECK_STYLE;
}

/** data.json → 唱片配色（脏值回落默认） */
export function normalizeRecordColor(raw: unknown): RecordColor {
  return RECORD_COLORS.includes(raw as RecordColor) ? (raw as RecordColor) : DEFAULT_RECORD_COLOR;
}

/** 每行专辑数量的手动档位（设置面板与专辑墙「陈列」面板共用一套）：自动之外的可选列数 */
export const SHELF_COLUMN_CHOICES: readonly number[] = [2, 3, 4, 5, 6, 7];

/** 专辑墙工具栏的位置（外观页）：顶部 / 底部 × 左 / 中 / 右 六档；默认 = 现在这套「顶部居中」 */
export type ToolbarPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export const TOOLBAR_POSITIONS: readonly ToolbarPosition[] = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

export const DEFAULT_TOOLBAR_POSITION: ToolbarPosition = 'top-center';

/** 是否钉在窗格底部（教程布局要据此把整块收在工具栏上方） */
export function isToolbarAtBottom(v: ToolbarPosition): boolean {
  return v.startsWith('bottom');
}

/** data.json → 工具栏位置（脏值回落默认） */
export function normalizeToolbarPosition(raw: unknown): ToolbarPosition {
  return TOOLBAR_POSITIONS.includes(raw as ToolbarPosition)
    ? (raw as ToolbarPosition)
    : DEFAULT_TOOLBAR_POSITION;
}

/** 值 → 专辑墙上的类名（CSS 按这六个类摆位） */
export function toolbarPositionClass(v: ToolbarPosition): string {
  return `is-toolbar-${v}`;
}
