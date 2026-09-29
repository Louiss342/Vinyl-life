// 已移除功能留在 data.json 里的旧键（死键）。
//
// 为什么需要它：loadSettings 是 `{ ...DEFAULT_SETTINGS, ...data }` —— 存档里的未知键会被一并带进
// 设置对象，再由 saveData 原样写回。于是每删一个功能就多留一个死键，越滚越久，后来人再也无从判断
// 「这个键还有没有人读」。集中在这里删一次，读进来就干净，写回去也就不再带上。
//
// 删功能时往这个数组加一行，上面写清它是哪个版本 / 哪个功能的遗物。
// 清单只放键名、说明放注释：字面量里的中文会被 i18n 门禁拦下（那条通道留给用户可见文案）。
export const REMOVED_SETTINGS: readonly string[] = [
  // 1.0.10 之前的调试命令开关
  'debugCommands',
  // 队列顺序记忆（拖拽顺序只影响本次会话，已不再落盘）
  'queueOrder',
  // 更早版本的「跟随主题」开关（外观页改档后无人再读）
  'theme',
];

/** 就地删掉设置对象里的历史死键；main.ts 的 loadSettings 在合并默认值之后调一次 */
export function pruneRemovedSettings(settings: object): void {
  const bag = settings as Record<string, unknown>;
  for (const key of REMOVED_SETTINGS) delete bag[key];
}
