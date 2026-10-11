/** Action milestones survive reloads; opening/closing help never fabricates gameplay progress. */
export const LESSONS = [
  { id: 'book', title: '先翻开你的潜水手册', body: '按 B 打开书。彩色书签是目录，插画把每个操作拆成小步骤。', action: '按 B 翻开手册', chapter: 'prepare' },
  { id: 'bench', title: '来到装备工作台', body: '点击 START 鱼或按 Enter。连接钱包后进入工作台；连接本身不需要付费。', action: 'START → 工作台', chapter: 'prepare' },
  { id: 'pack', title: '把捕捞网装进准备区', body: '点击桌上的网查看，再选「放入准备区」；也可以直接拖到右侧托盘。', action: '把捕捞网放入 READY 托盘', chapter: 'assembly' },
  { id: 'chart', title: '展开海图，选择水域', body: '点击桌上的折叠海图。初次推荐平静的峡湾；确认装备后点击「下潜」。', action: '打开海图', chapter: 'prepare' },
  { id: 'launch', title: '选择你的呼吸输入', body: '初次推荐「Play with keyboard」。摄像头模式需要传感器和校准；键盘模式无需摄像头。', action: '选择键盘或摄像头，开始下潜', chapter: 'dive' },
  { id: 'descend', title: '练习向下游', body: '键盘 / 模拟模式按住 Shift，再按 S 或 ↓ 游到 3 米。摄像头模式以实际检测信号为准。', action: '保持 HOLDING，游到 3 m', chapter: 'dive' },
  { id: 'catch', title: '用网捕到第一条鱼', body: 'WASD / 方向键靠近鱼，让鱼进入网口，再按 Space 挥网。没捕到时，稍微靠近再试。', action: '靠近鱼 → Space 捕捞', chapter: 'assembly' },
  { id: 'bank', title: '带着收获回到水面', body: '保持游戏中的 HOLDING，按 W 或 ↑ 上浮。到水面后自动存鱼；水下变成 BREATHING 会触发紧急返航。', action: '上浮到水面，存入至少一条鱼', chapter: 'return' },
  { id: 'collection', title: '看看你的收藏', body: '按 C 打开收藏。鱼已保存在本地；NFT 铸造和交易另外需要网络及链上费用。', action: '按 C 查看收藏', chapter: 'return' },
  { id: 'upgrade', title: '认识装备升级', body: '关闭收藏后按 G 查看各配件效果。下潜时只能查看；回工作台后才可升级。无需购买就能完成教程。', action: '按 G 打开改装工作台', chapter: 'assembly' },
] as const;

export type LessonId = (typeof LESSONS)[number]['id'];
export interface TutorialState {
  enabled: boolean;
  chosen: boolean;
  completed: LessonId[];
}
const KEY = 'deepbreath.tutorial.v1';
export const freshTutorial = (): TutorialState => ({ enabled: false, chosen: false, completed: [] });

export function normalizeTutorial(value: unknown): TutorialState {
  if (!value || typeof value !== 'object') return freshTutorial();
  const v = value as Partial<TutorialState>;
  const completed = Array.isArray(v.completed)
    ? LESSONS.filter((lesson) => v.completed!.includes(lesson.id)).map((lesson) => lesson.id) : [];
  return { enabled: v.enabled === true, chosen: v.chosen === true, completed };
}
export function loadTutorial(): TutorialState {
  try { return normalizeTutorial(JSON.parse(localStorage.getItem(KEY) ?? 'null')); }
  catch { return freshTutorial(); }
}
export function saveTutorial(state: TutorialState) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* Help still works without storage. */ }
}
export function recordLesson(state: TutorialState, id: LessonId): TutorialState {
  if (!state.enabled || state.completed.includes(id)) return state;
  return { ...state, completed: [...state.completed, id] };
}
export function currentLesson(state: TutorialState) {
  return LESSONS.find((lesson) => !state.completed.includes(lesson.id)) ?? null;
}
