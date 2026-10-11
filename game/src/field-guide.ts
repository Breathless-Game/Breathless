import './field-guide.css';
import { guideArt, type GuideArt } from './guide-art';
import { currentLesson, LESSONS, loadTutorial, recordLesson, saveTutorial, type LessonId } from './tutorial';
import { lang, onLangChange, t } from './i18n';
import { SYNTHESIS_ENABLED } from './synthesis';
import { clampPosition, exceedsDragThreshold, fromFraction, LAUNCHER_POS_KEY, parseSavedPos, placePanel, toFraction } from './launcher-drag';

type ChapterId = 'prepare' | 'assembly' | 'gear' | 'synthesis' | 'dive' | 'return' | 'sonar';
interface Chapter {
  id: ChapterId; tab: string; title: string; subtitle: string; art: GuideArt;
  caption: string; steps: readonly [string, string][]; note: string;
}
export const CHAPTERS: readonly Chapter[] = [
  { id: 'prepare', tab: '准备', title: '出发前，先收拾好桌面', subtitle: '01 / BEFORE THE DIVE', art: 'bench', caption: '看装备 → 放入托盘 → 展开海图',
    steps: [['打开工作台', '点击 START 鱼或按 Enter，连接钱包后进入。'], ['准备装备', '点击装备查看效果，放入右侧 READY 托盘；也可以直接拖过去。'], ['选好水域', '展开桌上的海图，第一次推荐峡湾。点击「下潜」，再选呼吸输入。']],
    note: '漏装配件时会使用基础属性。准备区里的装备，才会带上这次下潜。' },
  { id: 'assembly', tab: '组装', title: '一把捕捞网，三个配件', subtitle: '02 / CATCHING TOOL', art: 'net', caption: '杆身 + 线轮 + 网圈 / 网片',
    steps: [['网圈 / 网片', '决定容量和捕捞范围。鱼游进网口后，按 Space 挥网。'], ['杆身 + 线轮', '杆身增加射程；线轮加快挥网后的恢复。将它们各自放入准备区。'], ['改装与打包', '按 G 对比等级与分支效果；在工作台升级后，重新检查这次带上的配件。']],
    note: '这是配件组合示意，不需要额外收集木材。升级使用 Pearls，Lv2 才能选择专精分支。' },
  { id: 'gear', tab: '装备', title: '按任务，带合适的装备', subtitle: '03 / PACK LIGHT', art: 'gear', caption: '游得顺 · 返航有余地 · 看得清',
    steps: [['脚蹼', '改善普通游速与加速度；不会提高紧急上浮速度。'], ['应急气瓶', '只延长游戏里水下换气后的返航窗口。它不改变真实憋气能力。'], ['探照灯', '改善黑暗中的光距和亮度。1–6 快切装备，按住 Tab 打开轮盘，松开确认。']],
    note: '快捷键顺序：1 网 · 2 杆 · 3 线轮 · 4 脚蹼 · 5 气瓶 · 6 灯。未打包的装备不能切换。' },
  { id: 'synthesis', tab: '合成', title: '先做材料，再升级模块', subtitle: '04 / SYNTHESIS STATION', art: 'bench', caption: '鱼鳞片 + 纤维 → 鱼饵 · 铁屑 + 晶体 → 护板',
    steps: [['打开合成台', '在工作台点击半隐藏的绿色合成台；点击材料或拖进中央区域，配方刚好齐全时自动合成。'], ['合成两种成品', '潮汐鱼饵 = 鱼鳞片 ×2 + 珊瑚纤维 ×1 + 38 Pearl；复合护板 = 铁屑 ×3 + 深度晶体 ×1 + 珊瑚纤维 ×2 + 128 Pearl。'], ['升级模块', '先准备 1 个复合护板，再支付对应 Pearl：灯具 58/299、杆身 68/329、线轮 78/389、网具 89/499、脚蹼 99/549、气瓶 119/699、声纳 149/899（Lv2/Lv3）。']],
    note: '物资库存按钱包保存；支付或链上扣款失败时材料、护板和等级都保持原样。鱼饵与护板是合成台产物，合成台设置不影响装配箱。' },
  { id: 'dive', tab: '下潜', title: '慢慢下潜，先去浅水练习', subtitle: '05 / YOUR FIRST FISH', art: 'dive', caption: 'HOLDING → 方向键 → Space',
    steps: [['选择输入', '键盘 / 模拟模式：按住 Shift 表示 HOLDING。摄像头模式：以呼吸检测信号为准。'], ['向下游', 'WASD / 方向键移动；只有 HOLDING 才能从水面向下游。先在 3 米附近练习。'], ['找一条鱼', '靠近鱼，让鱼进入网口，再按 Space。错过时等网恢复后再试。']],
    note: '键盘模式无需真实憋气。打开这本书时游戏暂停；关闭后恢复，先确认呼吸状态再行动。' },
  { id: 'return', tab: '返航', title: '到水面，才算带回收获', subtitle: '06 / COME HOME', art: 'return', caption: 'W / ↑ 上浮 → 自动存鱼 → C 收藏',
    steps: [['及时回头', '保持游戏中的 HOLDING，按 W / ↑ 上浮；到水面自动存鱼。不要等到网满才返航。'], ['紧急返航', '水下变成 BREATHING 会触发倒计时和自动上浮。错过窗口会 BLACKOUT，失去这次网里的鱼。'], ['收藏与升级', '按 C 查看存下的鱼。NFT 与交易需要额外网络和链上费用；卖鱼所得 Pearls 可用于工作台升级。']],
    note: '靠近船、到水面且本次曾潜到 3 米以下时，按 F 上船。Esc 也可回工作台。' },
  { id: 'sonar', tab: '声纳', title: '沿着脉冲，找到返航路线', subtitle: '07 / FOLLOW THE SIGNAL', art: 'sonar', caption: '打包声纳 → 海图设颜色 → V 投放',
    steps: [['准备信标', '把声纳放入托盘，出发前在海图旁设置颜色。'], ['投放声纳', '下潜中按 V 投放。缆绳与脉冲节点提供微光和路线提示。'], ['循光返航', '声纳不是空气补给，也不会延长憋气。结合深度和网内收获判断何时回头。']],
    note: '声纳可升级缆绳长度：10 / 17 / 26 米。它不占用 1–6 的快捷装备位。' },
];
// The same chapters in English (ids, art and order match CHAPTERS).
export const CHAPTERS_EN: readonly Chapter[] = [
  { id: 'prepare', tab: 'Prepare', title: 'Before you go, set out the desk', subtitle: '01 / BEFORE THE DIVE', art: 'bench', caption: 'Inspect gear → put it on the tray → unfold the chart',
    steps: [['Open the workbench', 'Click the START fish or press Enter, and connect a wallet to enter.'], ['Get your gear ready', 'Click a piece of gear to see what it does, and put it on the READY tray on the right; you can also drag it there.'], ['Pick a water', 'Unfold the chart on the desk; the Fjord is best for a first dive. Click "Dive", then pick your breath input.']],
    note: 'Missing parts fall back to basic stats. Only the gear in the ready area comes along on this dive.' },
  { id: 'assembly', tab: 'Assemble', title: 'One net, three parts', subtitle: '02 / CATCHING TOOL', art: 'net', caption: 'Rod + reel + net hoop / mesh',
    steps: [['Net hoop / mesh', 'Sets capacity and catch range. Once a fish is in the net mouth, press Space to swing.'], ['Rod + reel', 'The rod adds reach; the reel speeds recovery after a swing. Put each of them in the ready area.'], ['Upgrade and pack', 'Press G to compare levels and branches; after upgrading at the workbench, check again what you are taking.']],
    note: 'This shows how the parts combine; no wood to collect. Upgrades cost Pearls, and a specialisation branch opens at Lv2.' },
  { id: 'gear', tab: 'Gear', title: 'Pack the right gear for the job', subtitle: '03 / PACK LIGHT', art: 'gear', caption: 'Swim smooth · room to get home · see clearly',
    steps: [['Fins', 'Improve normal swim speed and acceleration; they do not speed up an emergency ascent.'], ['Emergency tank', 'Only lengthens the in-game return window after you breathe underwater. It does not change your real breath hold.'], ['Lamp', 'Improves range and brightness in the dark. 1–6 switch gear quickly; hold Tab for the wheel and release to confirm.']],
    note: 'Quick keys: 1 net · 2 rod · 3 reel · 4 fins · 5 tank · 6 lamp. Gear you did not pack cannot be switched to.' },
  { id: 'synthesis', tab: 'Craft', title: 'Make materials first, then upgrade modules', subtitle: '04 / SYNTHESIS STATION', art: 'bench', caption: 'Fish scales + fibre → bait · scrap iron + crystal → plating',
    steps: [['Open the synthesis station', 'Click the half-hidden green station on the workbench; click materials or drag them into the centre, and it crafts automatically once the recipe is complete.'], ['Craft two products', 'Tide bait = fish scales ×2 + coral fibre ×1 + 38 Pearl; composite plating = scrap iron ×3 + deep crystal ×1 + coral fibre ×2 + 128 Pearl.'], ['Upgrade modules', 'Prepare 1 composite plating first, then pay the Pearl cost: lamp 58/299, rod 68/329, reel 78/389, net 89/499, fins 99/549, tank 119/699, sonar 149/899 (Lv2/Lv3).']],
    note: 'Supplies are stored per wallet; if payment or the on-chain charge fails, materials, plating and levels stay as they were. Bait and plating are synthesis station products, and station settings do not affect the loadout case.' },
  { id: 'dive', tab: 'Dive', title: 'Go down slowly; practise in the shallows', subtitle: '05 / YOUR FIRST FISH', art: 'dive', caption: 'HOLDING → arrow keys → Space',
    steps: [['Pick an input', 'Keyboard / simulator: hold Shift for HOLDING. Camera: the detected breathing decides.'], ['Swim down', 'WASD / arrow keys move; only while HOLDING can you swim down from the surface. Practise around 3 m first.'], ['Find a fish', 'Get close so the fish is in the net mouth, then press Space. If you miss, wait for the net to recover and try again.']],
    note: 'Keyboard mode needs no real breath hold. The game pauses while this book is open; when you close it, check your breathing before you move.' },
  { id: 'return', tab: 'Return', title: 'Your catch only counts at the surface', subtitle: '06 / COME HOME', art: 'return', caption: 'W / ↑ to rise → fish bank on their own → C collection',
    steps: [['Turn back in time', 'Keep HOLDING in the game and press W / ↑ to rise; fish bank on their own at the surface. Do not wait for a full net.'], ['Emergency return', 'BREATHING underwater starts a countdown and an automatic ascent. Miss the window and you BLACKOUT, losing the fish in your net.'], ['Collection and upgrades', 'Press C to see the fish you banked. NFTs and trading need a network connection and on-chain fees; Pearls from selling fish pay for workbench upgrades.']],
    note: 'Near the boat, at the surface, after going below 3 m this dive: press F to climb aboard. Esc also takes you back to the workbench.' },
  { id: 'sonar', tab: 'Sonar', title: 'Follow the pulses home', subtitle: '07 / FOLLOW THE SIGNAL', art: 'sonar', caption: 'Pack the sonar → set a colour on the chart → V to drop',
    steps: [['Ready the beacon', 'Put the sonar on the tray and set its colour by the chart before you leave.'], ['Drop the sonar', 'Press V during a dive to drop it. The cable and pulse nodes give off a glow and show the way.'], ['Follow the light home', 'The sonar is not an air supply and does not lengthen your hold. Use depth and your net to judge when to turn back.']],
    note: 'Sonar upgrades lengthen the cable: 10 / 17 / 26 m. It does not take one of the 1–6 quick gear slots.' },
];
/** Current-language chapters, one per CHAPTERS entry; falls back to the other language if an entry is ever missing. */
const chapters = (): readonly Chapter[] => {
  const primary = lang() === 'zh' ? CHAPTERS : CHAPTERS_EN;
  const other = lang() === 'zh' ? CHAPTERS_EN : CHAPTERS;
  return shownChapters().map((c, i) => {
    const ch = primary.find(x => x.id === c.id) ?? other.find(x => x.id === c.id) ?? primary[i] ?? c;
    // The subtitle numbers are renumbered by position so hiding a chapter leaves no gap.
    return { ...ch, subtitle: ch.subtitle.replace(/^\d+/, String(i + 1).padStart(2, '0')) };
  });
};
/** Chapters players can see: the synthesis chapter is dropped while the station is hidden. */
const shownChapters = (): readonly Chapter[] => CHAPTERS.filter(c => SYNTHESIS_ENABLED || c.id !== 'synthesis');
interface GuideHooks {
  canOpen(): boolean;
  toggled(open: boolean): void;
  syncTutorial(): void;
  packed(): readonly string[];
}

export class FieldGuide {
  private root = document.createElement('div');
  private launcher = document.createElement('div');
  private tour = document.createElement('aside');
  private state = loadTutorial();
  private chapter = 0;
  private previousFocus: HTMLElement | null = null;
  private inertElements = new Map<HTMLElement, boolean>();
  private collapsed = false;
  private closingTimer = 0;

  constructor(private hooks: GuideHooks) {
    this.root.id = 'field-guide';
    this.root.className = 'field-guide hidden';
    this.root.innerHTML = `<section class="guide-book" role="dialog" aria-modal="true" aria-labelledby="guide-title">
      <div class="guide-binding" aria-hidden="true">${'<i></i>'.repeat(12)}</div>
      <header class="guide-cover"><span data-cover></span><button type="button" id="guide-close"></button></header>
      <nav class="guide-tabs">${shownChapters().map((_, i) => `<button type="button" data-chapter="${i}" aria-controls="guide-pages"></button>`).join('')}</nav>
      <div id="guide-pages" class="guide-pages"></div>
      <footer class="guide-footer"><button type="button" id="guide-prev"></button><span id="guide-page-number"></span><button type="button" id="guide-next"></button></footer>
    </section>`;
    this.launcher.className = 'guide-launcher';
    this.launcher.innerHTML = `<button type="button" id="guide-open" aria-controls="field-guide" aria-expanded="false"></button><button type="button" id="tour-toggle" aria-controls="dive-tutorial">新手引导</button>`;
    this.tour.id = 'dive-tutorial';
    this.tour.className = 'dive-tutorial';
    this.tour.setAttribute('aria-label', '新手教程');
    // The guide itself is the 3D book on the workbench. The tutorial remains a
    // normal bottom-right utility panel, rather than a fish.
    document.body.append(this.launcher, this.tour, this.root);
    this.root.querySelector('#guide-close')!.addEventListener('click', () => this.close());
    this.launcher.querySelector('#guide-open')!.addEventListener('click', () => this.toggle());
    this.launcher.querySelector('#tour-toggle')!.addEventListener('click', () => this.setEnabled(!this.state.enabled));
    this.root.querySelector('#guide-prev')!.addEventListener('click', () => this.turn(-1));
    this.root.querySelector('#guide-next')!.addEventListener('click', () => this.turn(1));
    this.root.querySelectorAll<HTMLButtonElement>('[data-chapter]').forEach(button => button.addEventListener('click', () => {
      const next = Number(button.dataset.chapter);
      const direction = next === this.chapter ? 0 : next > this.chapter ? 1 : -1;
      this.chapter = next; this.renderBook(direction);
    }));
    this.root.addEventListener('click', event => { if (event.target === this.root) this.close(); });
    window.addEventListener('keydown', event => this.handleKey(event), true);
    this.initDrag();
    this.renderChrome();
    this.renderTutorial();
    onLangChange(() => {
      this.renderChrome();
      this.renderTutorial();
      if (this.open) this.renderBook();
    });
  }
  private placeTour: () => void = () => {};
  /** Make the launcher draggable (mouse/touch). Position is stored as viewport fractions. */
  private initDrag() {
    const el = this.launcher;
    const sides = ['left', 'top', 'right', 'bottom'] as const;
    let custom = parseSavedPos((() => { try { return localStorage.getItem(LAUNCHER_POS_KEY); } catch { return null; } })());
    const apply = () => {
      if (!custom) {
        for (const k of sides) { el.style[k] = ''; this.tour.style[k] = ''; }
        el.classList.remove('moved');
        return;
      }
      const w = el.offsetWidth, h = el.offsetHeight;
      const p = fromFraction(custom, w, h, window.innerWidth, window.innerHeight);
      el.classList.add('moved');
      el.style.left = `${p.left}px`; el.style.top = `${p.top}px`; el.style.right = 'auto'; el.style.bottom = 'auto';
      this.placeTour();
    };
    this.placeTour = () => {
      if (!custom) return;
      const r = el.getBoundingClientRect();
      const pos = placePanel({ left: r.left, top: r.top, width: r.width, height: r.height },
        this.tour.offsetWidth || 350, this.tour.offsetHeight || 220, window.innerWidth, window.innerHeight);
      this.tour.style.left = `${pos.left}px`; this.tour.style.right = 'auto';
      this.tour.style.top = pos.top === undefined ? 'auto' : `${pos.top}px`;
      this.tour.style.bottom = pos.bottom === undefined ? 'auto' : `${pos.bottom}px`;
    };
    const save = () => {
      try { if (custom) localStorage.setItem(LAUNCHER_POS_KEY, JSON.stringify(custom)); else localStorage.removeItem(LAUNCHER_POS_KEY); } catch { /* storage unavailable */ }
    };
    let start: { id: number; x: number; y: number; left: number; top: number } | null = null;
    let dragging = false, suppress = false;
    el.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.stopPropagation();
      const r = el.getBoundingClientRect();
      start = { id: event.pointerId, x: event.clientX, y: event.clientY, left: r.left, top: r.top };
      dragging = false; suppress = false;
      try { el.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    });
    el.addEventListener('pointermove', event => {
      if (!start || event.pointerId !== start.id) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (!dragging) {
        if (!exceedsDragThreshold(dx, dy)) return;
        dragging = true; el.classList.add('dragging');
      }
      const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
      const p = clampPosition(start.left + dx, start.top + dy, w, h, vw, vh);
      custom = toFraction(p.left, p.top, w, h, vw, vh);
      apply();
      event.preventDefault();
    });
    const end = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id) return;
      try { el.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
      if (dragging) { suppress = true; save(); setTimeout(() => { suppress = false; }, 300); }
      el.classList.remove('dragging');
      start = null; dragging = false;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    // A drag finishes with a click on a button; swallow exactly that one.
    el.addEventListener('click', event => { if (suppress) { suppress = false; event.stopPropagation(); event.preventDefault(); } }, true);
    el.addEventListener('dblclick', () => { custom = null; save(); apply(); });
    window.addEventListener('resize', () => { if (custom) apply(); });
    apply();
  }
  /** The book's fixed text (cover, tabs, page buttons) and the launcher, in the current language. */
  private renderChrome() {
    const q = <T extends Element = HTMLElement>(sel: string, root: ParentNode = this.root) => root.querySelector<T>(sel)!;
    q('[data-cover]').textContent = t('BREATHLESS · Diver field manual', '屏息 · 潜水员随身手册');
    const close = q('#guide-close');
    close.setAttribute('aria-label', t('Close the manual (B / Esc)', '合上手册 (B / Esc)'));
    close.innerHTML = `${t('Close', '合上')} <kbd>B</kbd> ×`;
    q('.guide-tabs').setAttribute('aria-label', t('Manual chapters', '手册章节'));
    this.root.querySelectorAll<HTMLButtonElement>('[data-chapter]').forEach((button, i) => {
      button.innerHTML = `<span>${String(i + 1).padStart(2, '0')}</span>${chapters()[i].tab}`;
    });
    q('#guide-prev').setAttribute('aria-label', t('Previous chapter', '上一章'));
    q('#guide-prev').textContent = t('← Previous', '← 上一页');
    q('#guide-next').setAttribute('aria-label', t('Next chapter', '下一章'));
    q('#guide-next').textContent = t('Next →', '下一页 →');
    const open = q('#guide-open', this.launcher);
    open.setAttribute('aria-label', t('Open the dive manual (B)', '打开潜水手册 (B)'));
    open.innerHTML = `<span aria-hidden="true">▤</span> ${t('Manual', '手册')} <kbd>B</kbd>`;
    this.tour.setAttribute('aria-label', t('Tutorial', '新手教程'));
  }
  get open() { return !this.root.classList.contains('hidden'); }
  mark(id: LessonId) {
    const next = recordLesson(this.state, id);
    if (next === this.state) return;
    this.state = next;
    saveTutorial(this.state);
    this.renderTutorial();
  }
  toggle() {
    if (this.open) this.close();
    else {
      if (this.closingTimer) return;
      if (!this.hooks.canOpen()) return;
      this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.hooks.toggled(true);
      this.root.classList.remove('hidden');
      for (const child of document.body.children) {
        if (child === this.root || !(child instanceof HTMLElement)) continue;
        this.inertElements.set(child, child.inert); child.inert = true;
      }
      this.launcher.querySelector<HTMLButtonElement>('#guide-open')!.setAttribute('aria-expanded', 'true');
      this.mark('book');
      this.renderBook(0);
      this.root.querySelector<HTMLButtonElement>('#guide-close')!.focus();
    }
  }
  /** Called by the 3D workbench after its book pickup animation finishes. */
  openFromWorkbench(): boolean {
    if (!this.open && !this.closingTimer) this.toggle();
    return this.open;
  }
  close() {
    if (!this.open || this.closingTimer) return;
    this.root.classList.add('closing');
    this.closingTimer = window.setTimeout(() => {
      this.closingTimer = 0;
      this.root.classList.add('hidden');
      this.root.classList.remove('closing');
      this.inertElements.forEach((inert, element) => { element.inert = inert; });
      this.inertElements.clear();
      this.launcher.querySelector<HTMLButtonElement>('#guide-open')!.setAttribute('aria-expanded', 'false');
      this.hooks.toggled(false);
      if (this.previousFocus?.isConnected && !this.previousFocus.closest('.hidden')) this.previousFocus.focus();
      else this.launcher.querySelector<HTMLButtonElement>('#tour-toggle')!.focus();
    }, 240);
  }
  /** Switches the step-by-step tutorial on or off from the bottom-right panel. */
  toggleTutorial() {
    this.setEnabled(!this.state.enabled);
  }
  private setEnabled(enabled: boolean) {
    this.state = { ...this.state, enabled, chosen: true };
    this.collapsed = false;
    saveTutorial(this.state);
    if (enabled) {
      this.hooks.syncTutorial();
      if (this.open) this.mark('book');
    }
    this.renderTutorial();
    if (this.open) this.renderBook(0);
  }
  private restart() {
    this.state = { enabled: true, chosen: true, completed: [] };
    saveTutorial(this.state);
    this.setEnabled(true);
  }
  private openLesson() {
    const lesson = currentLesson(this.state);
    this.chapter = Math.max(0, chapters().findIndex(c => c.id === lesson?.chapter));
    if (!this.open) this.toggle(); else this.renderBook(0);
  }
  private turn(delta: number) {
    this.chapter = Math.max(0, Math.min(chapters().length - 1, this.chapter + delta));
    this.renderBook(delta < 0 ? -1 : 1);
  }
  private renderBook(direction: -1 | 0 | 1 = 0) {
    const chapter = chapters()[this.chapter];
    const packed = new Set(this.hooks.packed());
    this.root.querySelector('#guide-pages')!.innerHTML = `<article class="guide-page guide-picture">
      <p class="guide-eyebrow">${chapter.subtitle}</p><h1 id="guide-title">${chapter.title}</h1>
      <div class="guide-illustration">${guideArt(chapter.art)}</div><p class="guide-caption">${chapter.caption}</p>
      <div class="guide-pencil-note"><span>${t('FIELD NOTE', '随手记')}</span><p>${chapter.note}</p></div>
    </article><article class="guide-page guide-instructions"><p class="guide-eyebrow">${t('STEP BY STEP', '小步骤，大收获')}</p>
      <ol>${chapter.steps.map(([title, body], i) => `<li><b class="guide-step-number">${i + 1}</b><div><h2>${title}</h2><p>${body}</p></div></li>`).join('')}</ol>
      ${chapter.id === 'assembly' || chapter.id === 'gear' ? `<div class="guide-pack-list" aria-label="${t('Ready area now', '当前准备区')}">${(chapter.id === 'assembly' ? [['rod', t('Rod', '杆身')], ['reel', t('Reel', '线轮')], ['net', t('Net hoop', '网圈')]] : [['fins', t('Fins', '脚蹼')], ['tank', t('Tank', '气瓶')], ['lamp', t('Lamp', '灯')]]).map(([id, label]) => `<span class="${packed.has(id) ? 'packed' : ''}">${packed.has(id) ? '✓' : '○'} ${label} <small>${packed.has(id) ? t('packed', '已打包') : t('not packed', '未打包')}</small></span>`).join('')}</div>` : ''}
      <div class="guide-tour-control"><div><strong>${t('Full beginner tutorial', '新手全程引导')}</strong><small>${t(`${this.state.completed.length} / ${LESSONS.length} done · turn off any time`, `${this.state.completed.length} / ${LESSONS.length} 项已完成 · 可随时关闭`)}</small></div><button type="button" id="guide-tour-switch" role="switch" aria-checked="${this.state.enabled}">${this.state.enabled ? t('On ✓', '开启中 ✓') : t('Off', '已关闭')}</button><button type="button" id="guide-tour-restart">${t('Start over ↺', '重新学习 ↺')}</button></div>
    </article>`;
    this.root.querySelector('#guide-tour-switch')!.addEventListener('click', () => {
      this.setEnabled(!this.state.enabled);
      this.root.querySelector<HTMLButtonElement>('#guide-tour-switch')!.focus();
    });
    this.root.querySelector('#guide-tour-restart')!.addEventListener('click', () => {
      this.restart(); this.root.querySelector<HTMLButtonElement>('#guide-tour-restart')!.focus();
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-chapter]').forEach((button, i) => {
      button.classList.toggle('selected', i === this.chapter);
      if (i === this.chapter) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    this.root.querySelector('#guide-page-number')!.textContent = `${String(this.chapter + 1).padStart(2, '0')} / ${String(chapters().length).padStart(2, '0')}`;
    this.root.querySelector<HTMLButtonElement>('#guide-prev')!.disabled = this.chapter === 0;
    this.root.querySelector<HTMLButtonElement>('#guide-next')!.disabled = this.chapter === chapters().length - 1;
    const pages = this.root.querySelector<HTMLElement>('#guide-pages')!;
    pages.scrollTop = 0;
    pages.classList.remove('page-turn-forward', 'page-turn-back');
    if (direction) {
      // Force a reflow so consecutive clicks still replay the page-turn animation.
      void pages.offsetWidth;
      pages.classList.add(direction > 0 ? 'page-turn-forward' : 'page-turn-back');
    }
  }
  private renderTutorial() { this.renderTutorialInner(); this.placeTour(); }
  private renderTutorialInner() {
    const toggle = this.launcher.querySelector<HTMLButtonElement>('#tour-toggle')!;
    toggle.setAttribute('aria-pressed', String(this.state.enabled));
    toggle.textContent = this.state.enabled ? t('Tutorial: on', '引导：开启') : t('Tutorial', '新手引导');
    const hint = t('Drag to move · double-click to reset', '可拖动 · 双击复位');
    toggle.title = hint;
    toggle.setAttribute('aria-description', hint);
    this.launcher.querySelector('#guide-open')!.setAttribute('title', hint);
    this.tour.classList.toggle('hidden', this.state.chosen && !this.state.enabled);
    if (!this.state.chosen) {
      this.tour.innerHTML = `<p class="guide-eyebrow">${t('FIRST DIVE', '初次下潜')}</p><h2>${t('First time out? Let’s practise together.', '第一次出海？一起练习吧。')}</h2><p>${t('From packing your gear to bringing home your first fish, one step at a time. Turn it off any time.', '从准备装备到带回第一条鱼，一步一步来。随时可以关闭。')}</p><div class="tour-actions"><button type="button" id="tour-start">${t('Start tutorial →', '开始引导 →')}</button><button type="button" id="tour-dismiss">${t('Explore freely', '自由探索')}</button></div>`;
      this.tour.querySelector('#tour-start')!.addEventListener('click', () => {
        this.setEnabled(true);
        this.toggle();
      });
      this.tour.querySelector('#tour-dismiss')!.addEventListener('click', () => this.setEnabled(false));
      return;
    }
    if (!this.state.enabled) return;
    const lesson = currentLesson(this.state);
    this.tour.innerHTML = `<div class="tour-heading"><span>${t('Dive practice', '潜水练习')} · ${lesson ? LESSONS.indexOf(lesson) + 1 : LESSONS.length} / ${LESSONS.length}</span><button type="button" id="tour-collapse" aria-label="${this.collapsed ? t('Expand tutorial', '展开引导') : t('Collapse tutorial', '收起引导')}" aria-expanded="${!this.collapsed}">${this.collapsed ? '+' : '−'}</button><button type="button" id="tour-off" aria-label="${t('Turn off the tutorial', '关闭新手引导')}">×</button></div>
      <div class="tour-body${this.collapsed ? ' hidden' : ''}"><div class="tour-progress" role="progressbar" aria-label="${t('Tutorial progress', '教程进度')}" aria-valuenow="${this.state.completed.length}" aria-valuemin="0" aria-valuemax="${LESSONS.length}"><i style="width:${this.state.completed.length / LESSONS.length * 100}%"></i></div>
      <div class="tour-copy" aria-live="polite"><h2>${lesson ? t(lesson.titleEn, lesson.title) : t('First practice run, done!', '第一趟练习，完成！')}</h2><p>${lesson ? t(lesson.bodyEn, lesson.body) : t('Explore freely now. Press B for the manual, or restart the practice from the book.', '现在可以自由探索。按 B 查阅手册，或从书里重新开始练习。')}</p><strong>${lesson ? t(lesson.actionEn, lesson.action) : t('Remember to turn back in time and bring your catch home.', '记得及时返航，带回你的收获。')}</strong></div>
      <button type="button" id="tour-read">${lesson ? t('Read this page', '查看这一页') : t('Open the manual', '翻开手册')} <kbd>B</kbd> ↗</button></div>`;
    this.tour.querySelector('#tour-off')!.addEventListener('click', () => this.setEnabled(false));
    this.tour.querySelector('#tour-collapse')!.addEventListener('click', () => { this.collapsed = !this.collapsed; this.renderTutorial(); this.tour.querySelector<HTMLButtonElement>('#tour-collapse')!.focus(); });
    this.tour.querySelector('#tour-read')!.addEventListener('click', () => this.openLesson());
  }
  private handleKey(event: KeyboardEvent) {
    const target = event.target;
    const editing = target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    if (!this.open && (editing || event.ctrlKey || event.metaKey || event.altKey)) return;
    const bookKey = event.code === 'KeyB' || event.key.toLowerCase() === 'b';
    if (!this.open && (!bookKey || !this.hooks.canOpen())) return;
    event.stopImmediatePropagation();
    if (bookKey || event.key === 'Escape') {
      event.preventDefault(); if (!event.repeat) this.toggle(); return;
    }
    if (event.key === 'Tab') {
      const buttons = [...this.root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); this.turn(event.key === 'ArrowLeft' ? -1 : 1);
    } else if (!['Enter', ' '].includes(event.key)) event.preventDefault();
  }
}
