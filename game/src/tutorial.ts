/** Each lesson has Chinese (title/body/action) and English (...En) text; field-guide.ts picks by language. Import-free for the standalone test. */
/** Action milestones survive reloads; opening/closing help never fabricates gameplay progress. */
export const LESSONS = [
  { id: 'book', title: '先翻开你的潜水手册', body: '按 B 打开书。彩色书签是目录，插画把每个操作拆成小步骤。', action: '按 B 翻开手册', titleEn: 'Open your dive handbook first', bodyEn: 'Press B to open the book. The colored tabs are the contents, and the drawings break each action into small steps.', actionEn: 'Press B to open the handbook', chapter: 'prepare' },
  { id: 'bench', title: '来到装备工作台', body: '点击 START 鱼或按 Enter。连接钱包后进入工作台；连接本身不需要付费。', action: 'START → 工作台', titleEn: 'Head to the gear workbench', bodyEn: 'Click START or press Enter. Connect a wallet to enter the workbench; connecting costs nothing.', actionEn: 'START → Workbench', chapter: 'prepare' },
  { id: 'pack', title: '把捕捞网装进准备区', body: '桌后军绿色工作台升起后，从左右物资箱拖入中央灰色工作垫；潜水装备仍可拖到右侧托盘。', action: '把捕捞网放入准备区托盘', titleEn: 'Put the net in the ready area', bodyEn: 'Click the net on the desk to inspect it, then choose "Add to ready area"; you can also drag it onto the tray on the right.', actionEn: 'Place the net on the READY tray', chapter: 'assembly' },
  { id: 'chart', title: '展开海图，选择水域', body: '点击桌上的折叠海图。初次推荐平静的峡湾；确认装备后点击「下潜」。', action: '打开海图', titleEn: 'Unfold the chart and pick a water', bodyEn: 'Click the folded chart on the desk. The calm fjord is best for a first dive; once your gear is set, click "Dive".', actionEn: 'Open the chart', chapter: 'prepare' },
  { id: 'launch', title: '选择你的呼吸输入', body: '初次推荐「用键盘游玩」。摄像头模式需要传感器和校准；键盘模式无需摄像头。', action: '选择键盘或摄像头，开始下潜', titleEn: 'Choose how you breathe', bodyEn: '"Play with keyboard" is recommended for the first dive. Camera mode needs a sensor and calibration; keyboard mode needs no camera.', actionEn: 'Pick keyboard or camera, then start diving', chapter: 'dive' },
  { id: 'descend', title: '练习向下游', body: '键盘 / 模拟模式按住 Shift，再按 S 或 ↓ 游到 3 米。摄像头模式以实际检测信号为准。', action: '保持 HOLDING，游到 3 m', titleEn: 'Practice swimming down', bodyEn: 'In keyboard / simulated mode, hold Shift, then press S or ↓ to reach 3 m. In camera mode, the detected signal decides.', actionEn: 'Keep HOLDING and reach 3 m', chapter: 'dive' },
  { id: 'catch', title: '用网捕到第一条鱼', body: 'WASD / 方向键靠近鱼，让鱼进入网口，再按 Space 挥网。没捕到时，稍微靠近再试。', action: '靠近鱼 → Space 捕捞', titleEn: 'Catch your first fish with the net', bodyEn: 'Use WASD / arrow keys to approach a fish, get it into the net mouth, then press Space to swing. If you miss, move a bit closer and try again.', actionEn: 'Approach a fish → Space to catch', chapter: 'assembly' },
  { id: 'bank', title: '带着收获回到水面', body: '保持游戏中的 HOLDING，按 W 或 ↑ 上浮。到水面后自动存鱼；水下变成 BREATHING 会触发紧急返航。', action: '上浮到水面，存入至少一条鱼', titleEn: 'Bring your catch back to the surface', bodyEn: 'Keep HOLDING in the game and press W or ↑ to rise. Fish are stored automatically at the surface; switching to BREATHING underwater triggers an emergency return.', actionEn: 'Rise to the surface and bank at least one fish', chapter: 'return' },
  { id: 'collection', title: '看看你的收藏', body: '按 C 打开收藏。鱼已保存在本地；NFT 铸造和交易另外需要网络及链上费用。', action: '按 C 查看收藏', titleEn: 'Look at your collection', bodyEn: 'Press C to open your collection. Fish are saved locally; minting and trading NFTs additionally needs a network connection and on-chain fees.', actionEn: 'Press C to view the collection', chapter: 'return' },
  { id: 'upgrade', title: '认识装备升级', body: '关闭收藏后按 G 查看各配件效果。下潜时只能查看；回工作台后才可升级。无需购买就能完成教程。', action: '按 G 打开改装工作台', titleEn: 'Get to know gear upgrades', bodyEn: 'After closing the collection, press G to see what each part does. While diving you can only view; upgrades are available back at the workbench. You can finish the tutorial without buying anything.', actionEn: 'Press G to open the upgrade workbench', chapter: 'assembly' },
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
