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
