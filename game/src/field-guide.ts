import './field-guide.css';
import { guideArt, type GuideArt } from './guide-art';
import { currentLesson, LESSONS, loadTutorial, recordLesson, saveTutorial, type LessonId } from './tutorial';

type ChapterId = 'prepare' | 'assembly' | 'gear' | 'dive' | 'return' | 'sonar';
interface Chapter {
  id: ChapterId; tab: string; title: string; subtitle: string; art: GuideArt;
  caption: string; steps: readonly [string, string][]; note: string;
}
const CHAPTERS: readonly Chapter[] = [
  { id: 'prepare', tab: '准备', title: '出发前，先收拾好桌面', subtitle: '01 / BEFORE THE DIVE', art: 'bench', caption: '看装备 → 放入托盘 → 展开海图',
    steps: [['打开工作台', '点击 START 鱼或按 Enter，连接钱包后进入。'], ['准备装备', '点击装备查看效果，放入右侧 READY 托盘；也可以直接拖过去。'], ['选好水域', '展开桌上的海图，第一次推荐峡湾。点击「下潜」，再选呼吸输入。']],
    note: '漏装配件时会使用基础属性。准备区里的装备，才会带上这次下潜。' },
  { id: 'assembly', tab: '组装', title: '一把捕捞网，三个配件', subtitle: '02 / CATCHING TOOL', art: 'net', caption: '杆身 + 线轮 + 网圈 / 网片',
    steps: [['网圈 / 网片', '决定容量和捕捞范围。鱼游进网口后，按 Space 挥网。'], ['杆身 + 线轮', '杆身增加射程；线轮加快挥网后的恢复。将它们各自放入准备区。'], ['改装与打包', '按 G 对比等级与分支效果；在工作台升级后，重新检查这次带上的配件。']],
    note: '这是配件组合示意，不需要额外收集木材。升级使用 Pearls，Lv2 才能选择专精分支。' },
  { id: 'gear', tab: '装备', title: '按任务，带合适的装备', subtitle: '03 / PACK LIGHT', art: 'gear', caption: '游得顺 · 返航有余地 · 看得清',
    steps: [['脚蹼', '改善普通游速与加速度；不会提高紧急上浮速度。'], ['应急气瓶', '只延长游戏里水下换气后的返航窗口。它不改变真实憋气能力。'], ['探照灯', '改善黑暗中的光距和亮度。1–6 快切装备，按住 Tab 打开轮盘，松开确认。']],
    note: '快捷键顺序：1 网 · 2 杆 · 3 线轮 · 4 脚蹼 · 5 气瓶 · 6 灯。未打包的装备不能切换。' },
  { id: 'dive', tab: '下潜', title: '慢慢下潜，先去浅水练习', subtitle: '04 / YOUR FIRST FISH', art: 'dive', caption: 'HOLDING → 方向键 → Space',
    steps: [['选择输入', '键盘 / 模拟模式：按住 Shift 表示 HOLDING。摄像头模式：以呼吸检测信号为准。'], ['向下游', 'WASD / 方向键移动；只有 HOLDING 才能从水面向下游。先在 3 米附近练习。'], ['找一条鱼', '靠近鱼，让鱼进入网口，再按 Space。错过时等网恢复后再试。']],
    note: '键盘模式无需真实憋气。打开这本书时游戏暂停；关闭后恢复，先确认呼吸状态再行动。' },
  { id: 'return', tab: '返航', title: '到水面，才算带回收获', subtitle: '05 / COME HOME', art: 'return', caption: 'W / ↑ 上浮 → 自动存鱼 → C 收藏',
    steps: [['及时回头', '保持游戏中的 HOLDING，按 W / ↑ 上浮；到水面自动存鱼。不要等到网满才返航。'], ['紧急返航', '水下变成 BREATHING 会触发倒计时和自动上浮。错过窗口会 BLACKOUT，失去这次网里的鱼。'], ['收藏与升级', '按 C 查看存下的鱼。NFT 与交易需要额外网络和链上费用；卖鱼所得 Pearls 可用于工作台升级。']],
    note: '靠近船、到水面且本次曾潜到 3 米以下时，按 F 上船。Esc 也可回工作台。' },
  { id: 'sonar', tab: '声纳', title: '沿着脉冲，找到返航路线', subtitle: '06 / FOLLOW THE SIGNAL', art: 'sonar', caption: '打包声纳 → 海图设颜色 → V 投放',
    steps: [['准备信标', '把声纳放入托盘，出发前在海图旁设置颜色。'], ['投放声纳', '下潜中按 V 投放。缆绳与脉冲节点提供微光和路线提示。'], ['循光返航', '声纳不是空气补给，也不会延长憋气。结合深度和网内收获判断何时回头。']],
    note: '声纳可升级缆绳长度：10 / 17 / 26 米。它不占用 1–6 的快捷装备位。' },
];
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

  constructor(private hooks: GuideHooks) {
    this.root.id = 'field-guide';
    this.root.className = 'field-guide hidden';
    this.root.innerHTML = `<section class="guide-book" role="dialog" aria-modal="true" aria-labelledby="guide-title">
      <div class="guide-binding" aria-hidden="true">${'<i></i>'.repeat(12)}</div>
      <header class="guide-cover"><span>BREATHLESS · 潜水员随身手册</span><button type="button" id="guide-close" aria-label="合上手册 (B / Esc)">合上 <kbd>B</kbd> ×</button></header>
      <nav class="guide-tabs" aria-label="手册章节">${CHAPTERS.map((c, i) => `<button type="button" data-chapter="${i}" aria-controls="guide-pages"><span>${String(i + 1).padStart(2, '0')}</span>${c.tab}</button>`).join('')}</nav>
      <div id="guide-pages" class="guide-pages"></div>
      <footer class="guide-footer"><button type="button" id="guide-prev" aria-label="上一章">← 上一页</button><span id="guide-page-number"></span><button type="button" id="guide-next" aria-label="下一章">下一页 →</button></footer>
    </section>`;
    this.launcher.className = 'guide-launcher';
    this.launcher.innerHTML = `<button type="button" id="guide-open" aria-label="打开潜水手册 (B)" aria-controls="field-guide" aria-expanded="false"><span aria-hidden="true">▤</span> 手册 <kbd>B</kbd></button><button type="button" id="tour-toggle" aria-controls="dive-tutorial">新手引导</button>`;
    this.tour.id = 'dive-tutorial';
    this.tour.className = 'dive-tutorial';
    this.tour.setAttribute('aria-label', '新手教程');
    // The launcher's buttons aren't shown: the GUIDE and TUTORIAL fish on the title rope
    // open the book and switch the tutorial (main.ts). It's kept off-page for its state.
    document.body.append(this.tour, this.root);
    this.root.querySelector('#guide-close')!.addEventListener('click', () => this.close());
    this.launcher.querySelector('#guide-open')!.addEventListener('click', () => this.toggle());
    this.launcher.querySelector('#tour-toggle')!.addEventListener('click', () => this.setEnabled(!this.state.enabled));
    this.root.querySelector('#guide-prev')!.addEventListener('click', () => this.turn(-1));
    this.root.querySelector('#guide-next')!.addEventListener('click', () => this.turn(1));
    this.root.querySelectorAll<HTMLButtonElement>('[data-chapter]').forEach(button => button.addEventListener('click', () => {
      this.chapter = Number(button.dataset.chapter); this.renderBook();
    }));
    this.root.addEventListener('click', event => { if (event.target === this.root) this.close(); });
    window.addEventListener('keydown', event => this.handleKey(event), true);
    this.renderTutorial();
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
      if (!this.hooks.canOpen()) return;
      this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.hooks.toggled(true);
      this.root.classList.remove('hidden');
      for (const child of document.body.children) {
        if (child === this.root || !(child instanceof HTMLElement)) continue;
        this.inertElements.set(child, child.inert); child.inert = true;
      }
      this.launcher.querySelector('#guide-open')!.setAttribute('aria-expanded', 'true');
      this.mark('book');
      this.renderBook();
      this.root.querySelector<HTMLButtonElement>('#guide-close')!.focus();
    }
  }
  close() {
    if (!this.open) return;
    this.root.classList.add('hidden');
    this.inertElements.forEach((inert, element) => { element.inert = inert; });
    this.inertElements.clear();
    this.launcher.querySelector('#guide-open')!.setAttribute('aria-expanded', 'false');
    this.hooks.toggled(false);
    if (this.previousFocus?.isConnected && !this.previousFocus.closest('.hidden')) this.previousFocus.focus();
    else this.launcher.querySelector<HTMLButtonElement>('#guide-open')!.focus();
  }
  /** The TUTORIAL fish: switches the step-by-step tutorial on or off. */
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
    if (this.open) this.renderBook();
  }
  private restart() {
    this.state = { enabled: true, chosen: true, completed: [] };
    saveTutorial(this.state);
    this.setEnabled(true);
  }
  private openLesson() {
    const lesson = currentLesson(this.state);
    this.chapter = Math.max(0, CHAPTERS.findIndex(c => c.id === lesson?.chapter));
    if (!this.open) this.toggle(); else this.renderBook();
  }
  private turn(delta: number) {
    this.chapter = Math.max(0, Math.min(CHAPTERS.length - 1, this.chapter + delta));
    this.renderBook();
  }
  private renderBook() {
    const chapter = CHAPTERS[this.chapter];
    const packed = new Set(this.hooks.packed());
    this.root.querySelector('#guide-pages')!.innerHTML = `<article class="guide-page guide-picture">
      <p class="guide-eyebrow">${chapter.subtitle}</p><h1 id="guide-title">${chapter.title}</h1>
      <div class="guide-illustration">${guideArt(chapter.art)}</div><p class="guide-caption">${chapter.caption}</p>
      <div class="guide-pencil-note"><span>随手记 / FIELD NOTE</span><p>${chapter.note}</p></div>
    </article><article class="guide-page guide-instructions"><p class="guide-eyebrow">小步骤，大收获 / STEP BY STEP</p>
      <ol>${chapter.steps.map(([title, body], i) => `<li><b class="guide-step-number">${i + 1}</b><div><h2>${title}</h2><p>${body}</p></div></li>`).join('')}</ol>
      ${chapter.id === 'assembly' || chapter.id === 'gear' ? `<div class="guide-pack-list" aria-label="当前准备区">${(chapter.id === 'assembly' ? [['rod', '杆身'], ['reel', '线轮'], ['net', '网圈']] : [['fins', '脚蹼'], ['tank', '气瓶'], ['lamp', '灯']]).map(([id, label]) => `<span class="${packed.has(id) ? 'packed' : ''}">${packed.has(id) ? '✓' : '○'} ${label} <small>${packed.has(id) ? '已打包' : '未打包'}</small></span>`).join('')}</div>` : ''}
      <div class="guide-tour-control"><div><strong>新手全程引导</strong><small>${this.state.completed.length} / ${LESSONS.length} 项已完成 · 可随时关闭</small></div><button type="button" id="guide-tour-switch" role="switch" aria-checked="${this.state.enabled}">${this.state.enabled ? '开启中 ✓' : '已关闭'}</button><button type="button" id="guide-tour-restart">重新学习 ↺</button></div>
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
    this.root.querySelector('#guide-page-number')!.textContent = `${String(this.chapter + 1).padStart(2, '0')} / ${String(CHAPTERS.length).padStart(2, '0')}`;
    this.root.querySelector<HTMLButtonElement>('#guide-prev')!.disabled = this.chapter === 0;
    this.root.querySelector<HTMLButtonElement>('#guide-next')!.disabled = this.chapter === CHAPTERS.length - 1;
    this.root.querySelector('#guide-pages')!.scrollTop = 0;
  }
  private renderTutorial() {
    const toggle = this.launcher.querySelector<HTMLButtonElement>('#tour-toggle')!;
    toggle.setAttribute('aria-pressed', String(this.state.enabled));
    toggle.textContent = this.state.enabled ? '引导：开启' : '新手引导';
    this.tour.classList.toggle('hidden', this.state.chosen && !this.state.enabled);
    if (!this.state.chosen) {
      this.tour.innerHTML = `<p class="guide-eyebrow">FIRST DIVE / 初次下潜</p><h2>第一次出海？一起练习吧。</h2><p>从准备装备到带回第一条鱼，一步一步来。随时可以关闭。</p><div class="tour-actions"><button type="button" id="tour-start">开始引导 →</button><button type="button" id="tour-dismiss">自由探索</button></div>`;
      this.tour.querySelector('#tour-start')!.addEventListener('click', () => {
        this.setEnabled(true);
        this.toggle();
      });
      this.tour.querySelector('#tour-dismiss')!.addEventListener('click', () => this.setEnabled(false));
      return;
    }
    if (!this.state.enabled) return;
    const lesson = currentLesson(this.state);
    this.tour.innerHTML = `<div class="tour-heading"><span>潜水练习 · ${lesson ? LESSONS.indexOf(lesson) + 1 : LESSONS.length} / ${LESSONS.length}</span><button type="button" id="tour-collapse" aria-label="${this.collapsed ? '展开' : '收起'}引导" aria-expanded="${!this.collapsed}">${this.collapsed ? '+' : '−'}</button><button type="button" id="tour-off" aria-label="关闭新手引导">×</button></div>
      <div class="tour-body${this.collapsed ? ' hidden' : ''}"><div class="tour-progress" role="progressbar" aria-label="教程进度" aria-valuenow="${this.state.completed.length}" aria-valuemin="0" aria-valuemax="${LESSONS.length}"><i style="width:${this.state.completed.length / LESSONS.length * 100}%"></i></div>
      <div class="tour-copy" aria-live="polite"><h2>${lesson?.title ?? '第一趟练习，完成！'}</h2><p>${lesson?.body ?? '现在可以自由探索。按 B 查阅手册，或从书里重新开始练习。'}</p><strong>${lesson?.action ?? '记得及时返航，带回你的收获。'}</strong></div>
      <button type="button" id="tour-read">${lesson ? '查看这一页' : '翻开手册'} <kbd>B</kbd> ↗</button></div>`;
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
