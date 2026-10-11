import * as T from 'three';
import { storageKey } from './wallet';
import './ships.css';
const SHIP_INTROS_EN = [
  'A red-hulled starter with a blue roof, basic fishing gear and safety equipment for your first voyage.',
  'A light, open fishing boat. Bring your gear and begin exploring with your first deep breath.',
  'A canopy and twin-rod setup support longer fishing trips and coastal collecting.',
  'Sonar, observation instruments and a sampling boom help you explore farther waters.',
  'A reinforced hull, protective plating and a two-level wheelhouse support demanding offshore expeditions.',
  'A fully equipped dive platform, equipment workspace and gantry crane: the ultimate deep-sea support vessel.',
];

export const SHIPS = [
  { file: '00-starter', cn: '初始渔船', en: 'Homeward', intro: '红色船体与蓝色顶棚的起始渔船，配备基础渔具与安全设施，陪伴你的第一次出海。', threshold: 0, speed: 0, range: 0, capacity: 0 },
  { file: '01-basic', cn: '启航渔艇', en: 'First Tide', intro: '轻巧的开放式渔艇。带上渔具，从第一口深呼吸开始探索。', threshold: 50, speed: .02, range: .05, capacity: 0 },
  { file: '02-twin-rod', cn: '双竿作业船', en: 'Twin Cast', intro: '遮阳棚与双竿装备支持更长的作业时间，适合沿岸采集。', threshold: 150, speed: .04, range: .1, capacity: 1 },
  { file: '04-sonar', cn: '声呐探索船', en: 'Echo Scout', intro: '搭载声呐、观测设备与采样吊杆，向更远的海域探索。', threshold: 500, speed: .08, range: .2, capacity: 2 },
  { file: '03-offshore', cn: '加固远海船', en: 'Ocean Vanguard', intro: '宽厚船体、强化护板与双层驾驶舱，支撑高强度远海作业。', threshold: 1200, speed: .12, range: .3, capacity: 3 },
  { file: '05-dive-support', cn: '深海支援旗舰', en: 'Abyss Atlas', intro: '完整潜水平台、装备工作区与门架吊机，满级深海探索支援船。', threshold: 2500, speed: .18, range: .45, capacity: 4 },
] as const;

export class Shipyard {
  private root = document.createElement('section');
  private models: T.Group[] = [];
  private index = 0;
  private selected = 0;
  private thumbnails: string[] = [];
  private closed = false;
  private previousFocus: HTMLElement | null = null;
  private waterRenderer?: T.WebGLRenderer;
  private shipRenderer?: T.WebGLRenderer;
  private waterCamera = new T.PerspectiveCamera(48, 1, .1, 400);
  private waterFrame = 0;
  get open() { return !this.root.hidden; }
  get bonus() { return SHIPS[this.index]; }
  constructor(private boat: T.Group, private progress: () => number, private onToggle: (open: boolean) => void, private onEquip: () => void, private gameScene: T.Scene, private applyColorGrade: (root: T.Object3D) => void) {
    this.root.className = 'shipyard'; this.root.hidden = true;
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'true'); this.root.setAttribute('aria-label', '船只升级 Shipyard');
    document.body.append(this.root);
    this.root.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!button) return;
      if (button.dataset.close !== undefined) this.close();
      if (button.dataset.ship !== undefined) { this.selected = Number(button.dataset.ship); this.draw(); this.root.querySelector<HTMLButtonElement>(`[data-ship="${this.selected}"]`)?.focus(); }
      if (button.dataset.equip !== undefined && this.progress() >= SHIPS[this.selected].threshold) {
        this.index = this.selected; try { localStorage.setItem(storageKey('ship-v2'), String(this.index)); } catch {}
        this.apply(); this.onEquip(); this.draw();
      }
    });
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.close(); return; }
      if (e.key !== 'Tab') return;
      const buttons = [...this.root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    });
    void this.load();
  }
  private async load() {
    try {
      const loader = new T.ObjectLoader();
      this.models = await Promise.all(SHIPS.map(async s => {
        const r = await fetch(`${import.meta.env.BASE_URL}boats/${s.file}.json`); if (!r.ok) throw new Error('boat load');
        return loader.parse(await r.json()) as T.Group;
      }));
      // Preserve each design's proportions while making level progression unambiguous.
      this.models.forEach((model, level) => {
        const length = new T.Box3().setFromObject(model).getSize(new T.Vector3()).x;
        model.scale.multiplyScalar((6 + level * .8) / length);
        this.applyColorGrade(model);
      });
      this.makeThumbnails(); this.reload();
    } catch { this.closed = true; if (this.open) this.draw(); }
  }
  reload() {
    let saved = 0; try {
      const current = localStorage.getItem(storageKey('ship-v2'));
      const legacy = localStorage.getItem(storageKey('ship'));
      saved = current !== null ? Number(current) : legacy !== null ? Number(legacy) + 1 : 0;
    } catch {}
    this.index = Number.isInteger(saved) && saved >= 0 && saved < SHIPS.length && this.progress() >= SHIPS[saved].threshold ? saved : 0;
    this.selected = this.index; this.apply(); if (this.open) this.draw();
  }
  private apply() {
    if (!this.models.length) return;
    this.boat.clear(); const model = this.models[this.index].clone();
    const bounds = new T.Box3().setFromObject(model); const centre = bounds.getCenter(new T.Vector3());
    // Preserve actual progression in vessel sizes and the world's wave animation.
    model.position.x -= centre.x; model.position.z -= centre.z;
    this.boat.add(model);
  }
  show() { this.previousFocus = document.activeElement as HTMLElement; this.selected = this.index; this.root.hidden = false; this.onToggle(true); this.draw(); this.root.querySelector<HTMLButtonElement>('[data-close]')?.focus(); }
  close() { this.root.hidden = true; cancelAnimationFrame(this.waterFrame); this.onToggle(false); this.previousFocus?.focus(); }
  private animateWater() {
    cancelAnimationFrame(this.waterFrame);
    const feature = this.root.querySelector<HTMLElement>('.shipyard-feature');
    if (!feature || !this.open) return;
    if (!this.waterRenderer) {
      this.waterRenderer = new T.WebGLRenderer({ antialias: true });
      this.waterRenderer.outputColorSpace = T.SRGBColorSpace;
      this.waterRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      this.waterRenderer.domElement.className = 'shipyard-water';
      this.waterRenderer.domElement.setAttribute('aria-hidden', 'true');
      // Reuse the active game's shoreline, houses, mountains, sky and animated sea.
      this.waterCamera.position.set(0, 3.5, 22); this.waterCamera.lookAt(0, 2, 0);
    }
    feature.prepend(this.waterRenderer.domElement);
    const shipImage = feature.querySelector<HTMLImageElement>('img');
    let shipScene: T.Scene | undefined;
    let shipCamera: T.OrthographicCamera | undefined;
    const lights: Array<{ source: T.Light; copy: T.Light }> = [];
    if (this.models[this.selected]) {
      if (shipImage) shipImage.style.display = 'none';
      if (!this.shipRenderer) {
        this.shipRenderer = new T.WebGLRenderer({ antialias: true, alpha: true });
        this.shipRenderer.outputColorSpace = T.SRGBColorSpace;
        this.shipRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        this.shipRenderer.domElement.className = 'shipyard-lit-boat';
        this.shipRenderer.domElement.setAttribute('aria-hidden', 'true');
      }
      feature.append(this.shipRenderer.domElement);
      shipScene = new T.Scene();
      const model = this.models[this.selected].clone(); shipScene.add(model);
      this.gameScene.traverse(object => {
        if (object instanceof T.Light) {
          const copy = object.clone(); shipScene!.add(copy); lights.push({ source: object, copy });
        }
      });
      const halfHeight = Math.max(...this.models.map(model => {
        const size = new T.Box3().setFromObject(model).getSize(new T.Vector3());
        return Math.max(size.y / 2, size.x / 3.2);
      })) * 1.04;
      const bounds = new T.Box3().setFromObject(model), centre = bounds.getCenter(new T.Vector3());
      shipCamera = new T.OrthographicCamera(-halfHeight*1.6, halfHeight*1.6, halfHeight, -halfHeight, .1, 100);
      shipCamera.position.copy(centre).add(new T.Vector3(0,0,22)); shipCamera.lookAt(centre);
    }
    const render = () => {
      if (!this.open) return;
      const width = feature.clientWidth, height = feature.clientHeight;
      if (width && height) {
        if (this.shipRenderer && shipScene && shipCamera) {
          shipScene.fog = this.gameScene.fog?.clone() ?? null;
          this.shipRenderer.toneMapping = this.waterRenderer!.toneMapping;
          this.shipRenderer.toneMappingExposure = this.waterRenderer!.toneMappingExposure;
          for (const { source, copy } of lights) {
            copy.copy(source, false);
            copy.position.copy(source.getWorldPosition(new T.Vector3()));
          }
          const previewScale = [1, 1, 1, .90, .86, .82][this.selected];
          const viewHeight = Math.max(1, Math.min(height - 38, (width - 32) / 1.6) * previewScale);
          this.shipRenderer.setSize(viewHeight*1.6, viewHeight, false);
          // CSS dimensions must not inherit the DPR-scaled drawing-buffer dimensions.
          this.shipRenderer.domElement.style.width = `${viewHeight * 1.6}px`;
          this.shipRenderer.domElement.style.height = `${viewHeight}px`;
          const lift = height * 0.055 - (this.boat.position.y - 0.25) * height * 0.16;
          this.shipRenderer.domElement.style.transform = `translate(-50%, calc(-50% - 11px + ${lift}px)) rotate(${-this.boat.rotation.z}rad)`;
          this.shipRenderer.render(shipScene, shipCamera);
        }
        this.waterRenderer!.setSize(width, height, false);
        this.waterCamera.aspect = width / height; this.waterCamera.updateProjectionMatrix();
        const visible = this.boat.visible;
        this.boat.visible = false;
        try { this.waterRenderer!.render(this.gameScene, this.waterCamera); }
        finally { this.boat.visible = visible; }
      }
      this.waterFrame = requestAnimationFrame(render);
    };
    this.waterFrame = requestAnimationFrame(render);
  }
  private makeThumbnails() {
    const renderer = new T.WebGLRenderer({ antialias: true, alpha: true }); renderer.setSize(480, 300); renderer.outputColorSpace = T.SRGBColorSpace;
    // One shared camera scale: do not auto-enlarge small boats to match the flagship.
    const halfHeight = Math.max(...this.models.map(model => {
      const size = new T.Box3().setFromObject(model).getSize(new T.Vector3());
      return Math.max(size.y / 2, size.x / (2 * 1.6));
    })) * 1.04;
    for (const model of this.models) {
      const scene = new T.Scene(); const copy = model.clone(); scene.add(copy);
      this.gameScene.traverse(object => { if (object instanceof T.Light) scene.add(object.clone()); });
      const b = new T.Box3().setFromObject(copy), c = b.getCenter(new T.Vector3()), size = b.getSize(new T.Vector3());
      // Flat side elevation, fitted to the full silhouette rather than a distant perspective.
      const camera = new T.OrthographicCamera(-halfHeight * 1.6, halfHeight * 1.6, halfHeight, -halfHeight, .1, 100);
      camera.position.copy(c).add(new T.Vector3(0, 0, size.z + 20)); camera.lookAt(c); renderer.render(scene,camera);
      this.thumbnails.push(renderer.domElement.toDataURL());
    }
    renderer.dispose();
  }
  private draw() {
    queueMicrotask(() => this.animateWater());
    const s = SHIPS[this.selected], unlocked = this.progress() >= s.threshold;
    this.root.innerHTML = `<div class="shipyard-shell"><header><div><small>DRY DOCK / 船坞</small><h1>船只升级 <span>SHIP UPGRADES</span></h1></div><button data-close aria-label="关闭船坞 / Close shipyard">✕</button></header><div class="shipyard-layout"><aside><small>等级 / LEVEL 0${this.selected}</small><h2>${s.cn}</h2><h3>${s.en}</h3><p>${s.intro}<span class="shipyard-translation">${SHIP_INTROS_EN[this.selected]}</span></p><h4>船只加成 / BONUSES</h4><dl><div><dt>潜水游速<span class="shipyard-translation">Swim speed</span></dt><dd>+${Math.round(s.speed*100)}%</dd></div><div><dt>捕获范围<span class="shipyard-translation">Catch radius</span></dt><dd>+${Math.round(s.range*100)}%</dd></div><div><dt>鱼网容量<span class="shipyard-translation">Net capacity</span></dt><dd>+${s.capacity} 格 / slots</dd></div></dl><p class="shipyard-progress">累计入库价值 / Total banked value ${Math.floor(this.progress())} / ${s.threshold || '初始船 / Starter'}<br>达到目标即可解锁，无需消耗鱼。<span class="shipyard-translation">Reach the target to unlock. No fish are spent.</span></p><button data-equip ${!unlocked || !this.models.length ? 'disabled' : ''}>${this.closed ? '模型加载失败，请刷新 / Loading failed. Refresh.' : !this.models.length ? '模型加载中… / Loading…' : this.index===this.selected ? '当前使用 / EQUIPPED' : unlocked ? '装备船只 / EQUIP' : '尚未解锁 / LOCKED'}</button></aside><main><div class="shipyard-feature">${this.thumbnails[this.selected] ? `<img src="${this.thumbnails[this.selected]}" alt="${s.cn} / ${s.en}">` : '<p>正在准备船只预览… / Preparing preview…</p>'}<span>${s.en} · LV.0${this.selected}</span></div><div class="shipyard-slots">${SHIPS.map((ship,i)=>`<button data-ship="${i}" class="${i===this.selected?'selected':''}" aria-pressed="${i===this.selected}"><small>0${i} ${this.progress()<ship.threshold?'🔒':''}</small>${this.thumbnails[i]?`<img src="${this.thumbnails[i]}" alt="">`:''}<b>${ship.cn}</b><span>${ship.en}${i===this.index?'<br>已装备 / Equipped':''}</span></button>`).join('')}${Array.from({length:4},()=>'<div class="shipyard-empty"><span>？</span><small>未来船位<br>COMING SOON</small></div>').join('')}</div><p class="shipyard-caption">选择船位查看详情 · 点击初始页面船只进入船坞 · Esc 返回<span class="shipyard-translation">Select a slot for details · Click the boat on the title screen to open the shipyard · Esc to return</span></p></main></div></div>`;
  }
}
