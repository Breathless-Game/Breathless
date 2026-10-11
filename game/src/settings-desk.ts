import * as THREE from 'three';
import type { TimeOfDay } from './daylight';
import type { Settings } from './settings';
import { onWalletChange, walletState } from './wallet';
import { shortAddress } from './wallet-storage';
import { drawPlanks } from './workbench';

// Settings from the title screen, on a table like the workbench's: the SETTINGS
// fish pans the camera down onto it, and wooden plaques drop onto the tabletop.
// Selector plaques print their options in a row; click one and a brass slider
// slides to it. Switch plaques carry a lever and a lamp; click to flip it. A
// wallet plaque connects or disconnects Phantom, and the title plaque (or Esc)
// pans back up. Changes go through the same path as the pause menu's settings.

export interface DeskHooks {
  settings(): Settings;
  change(patch: Partial<Settings>): void;
  timeOfDay(): TimeOfDay;
  setTimeOfDay(mode: TimeOfDay): void;
  /** Not connected: pick a wallet (the login gate). Connected: log out (with its warnings). */
  connectWallet(): void;
  logOut(): void;
  /** The camera pan between the title (0) and the table (1); tableY: screen y of the table's back. */
  pan(u: number, tableY: number): void;
  /** It has started panning away (Esc, or the title plaque). */
  leaving?(): void;
  /**
   * How far the camera has moved (table units) and turned (radians; yaw: + right,
   * pitch: + up) from the overview to lean in over a plaque, so the scene behind
   * can move with it.
   */
  view?(move: THREE.Vector3, yaw: number, pitch: number): void;
}

type Option = [value: string, en: string, zh: string];

interface Selector {
  kind: 'select';
  title: [string, string];
  options: Option[];
  get(): string;
  set(v: string): void;
}

interface Toggle {
  kind: 'toggle';
  title: [string, string];
  get(): boolean;
  set(v: boolean): void;
}

interface Action {
  kind: 'action';
  title: [string, string];
  line(): string;
  act(): void;
}

type Spec = Selector | Toggle | Action;

interface Plaque {
  spec: Spec;
  group: THREE.Group;
  board: THREE.Mesh;
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
  w: number;
  d: number;
  home: THREE.Vector3;
  yaw: number;
  dropAt: number;
  landed: boolean;
  hover: number;
  // Selector: the brass slider; toggle: the lever and its lamp.
  slider?: THREE.Mesh;
  sliderX: number;
  lever?: THREE.Group;
  leverA: number;
  lamp?: THREE.Mesh;
}

// The same table and camera as the workbench (workbench.ts), so the two read as one place.
const TABLE = { x0: -5.2, x1: 5.2, z0: -2.7, z1: 2.7 };
const CAM = new THREE.Vector3(0, 6.2, 9.5);
const LOOK = new THREE.Vector3(0, 0.85, 0);
const BASE_ASPECT = 1.6;
const RISE = 7.5;
const PAN_S = 1.15;
const SHADOW_Z = 0.7;

const BOARD_H = 0.12; // plaque thickness
const DROP_START_S = 0.75;
const DROP_GAP_S = 0.09;
const DROP_S = 0.7;
const TEX_PX = 256; // texture px per table unit of plaque
const INK = '#3a2210';
const INK_SOFT = 'rgba(58, 34, 16, 0.5)';
const LEVER_ON = -0.6; // radians: thrown right
const LEVER_OFF = 0.6;
const CLICK_MOVE_PX = 6;
const CLICK_MS = 400;
// Hovering a plaque, the camera leans in over it: closer, and looking down more
// steeply, so its options read clearly. FOCUS_CAM is the camera's offset from the
// plaque then (the overview's is CAM - LOOK). It eases in and out at FOCUS_RATE, and
// lingers FOCUS_HOLD_S after the pointer leaves, so crossing a gap between plaques
// doesn't swing it back.
const FOCUS_CAM = new THREE.Vector3(0, 5.6, 6.0);
// Only part of the way: the camera moves this far toward that, and the view's centre
// this far toward the plaque, so the table stays in frame (a front plaque centred
// would show the water past the table's edge).
const FOCUS_POS = 0.6;
const FOCUS_LOOK = 0.5;
const FOCUS_RATE = 3;
const FOCUS_HOLD_S = 0.5;

const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
const easeOutBounce = (u: number) => {
  const n = 7.5625;
  const d = 2.75;
  if (u < 1 / d) return n * u * u;
  if (u < 2 / d) return n * (u -= 1.5 / d) * u + 0.75;
  if (u < 2.5 / d) return n * (u -= 2.25 / d) * u + 0.9375;
  return n * (u -= 2.625 / d) * u + 0.984375;
};

export class SettingsDesk {
  private root: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(34, 1, 0.1, 120);
  private ray = new THREE.Raycaster();
  private plaques: Plaque[] = [];
  private state: 'closed' | 'opening' | 'idle' | 'leaving' = 'closed';
  private panU = 0;
  private time = 0;
  private last = 0;
  private raf = 0;
  private panTween: { from: number; to: number; t0: number; done?: () => void } | null = null;
  private hovered: Plaque | null = null;
  private focus = new THREE.Vector3(); // the plaque the camera leans in over, eased
  private focusU = 0; // 0 = the overview, 1 = leaning in
  private lastHover = -Infinity; // this.time when a plaque was last hovered
  private press: { plaque: Plaque | null; x: number; y: number; t: number; uv: THREE.Vector2 | null } | null = null;

  constructor(private hooks: DeskHooks) {
    this.root = document.createElement('div');
    this.root.id = 'settings-desk';
    this.root.className = 'hidden';
    const canvas = document.createElement('canvas');
    const hint = document.createElement('div');
    hint.id = 'desk-hint';
    hint.className = 'small';
    hint.textContent = 'Click an option or a switch · Esc back';
    this.root.append(canvas, hint);
    document.body.append(this.root);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x000000, 0);
    this.buildRoom();
    this.buildPlaques();

    window.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('resize', () => this.visible && this.resize());
    onWalletChange(() => this.paintAll());
  }

  get visible() {
    return this.state !== 'closed';
  }

  /** Pans down from the title onto the table; the plaques drop in. */
  show() {
    this.root.classList.remove('hidden');
    this.resize();
    this.paintAll();
    this.time = 0;
    this.plaques.forEach((p, i) => {
      p.dropAt = DROP_START_S + i * DROP_GAP_S;
      p.landed = false;
      p.group.visible = false;
      p.hover = 0;
      this.syncControls(p, true);
    });
    this.state = 'opening';
    this.panU = 0;
    this.focusU = 0;
    this.lastHover = -Infinity;
    this.panTween = { from: 0, to: 1, t0: 0, done: () => (this.state = 'idle') };
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    const loop = (now: number) => {
      if (this.state === 'closed') return;
      this.frame(Math.min((now - this.last) / 1000, 0.05));
      this.last = now;
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  hide() {
    this.state = 'closed';
    cancelAnimationFrame(this.raf);
    this.root.classList.add('hidden');
    document.body.style.cursor = '';
  }

  /** Esc: pan back up to the title. */
  escape() {
    if (this.state === 'idle' || this.state === 'opening') this.leave();
  }

  private leave() {
    this.state = 'leaving';
    this.hovered = null;
    document.body.style.cursor = '';
    this.panTween = {
      from: this.panU,
      to: 0,
      t0: this.time,
      done: () => {
        // Tell the title the pan is fully back (0) before closing: it relabels its fish on it.
        this.panU = 0;
        this.placeCamera();
        this.hide();
      },
    };
    this.hooks.leaving?.();
  }

  // ---- Scene ------------------------------------------------------------

  private buildRoom() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight('#e6f6ff', '#4a3420', 1.25));
    const sun = new THREE.DirectionalLight('#fff1dc', 2.4);
    sun.position.set(-4, 10, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 5, bottom: -5, near: 1, far: 30 });
    sun.shadow.bias = -0.0005;
    s.add(sun);
    const w = TABLE.x1 - TABLE.x0;
    const d = TABLE.z1 - TABLE.z0;
    const top = new THREE.CanvasTexture(drawPlanks(1024, Math.round((1024 * d) / w)));
    top.colorSpace = THREE.SRGBColorSpace;
    top.anisotropy = 8;
    const side = new THREE.MeshStandardMaterial({ color: '#4a2f18', roughness: 0.9 });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w, 0.45, d), [side, side, new THREE.MeshStandardMaterial({ map: top, roughness: 0.85 }), side, side, side]);
    slab.position.set(0, -0.225, 0);
    slab.receiveShadow = true;
    s.add(slab);
    for (const x of [TABLE.x0 + 0.5, TABLE.x1 - 0.5]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.45, 6, 0.45), side);
      leg.position.set(x, -3.3, TABLE.z0 + 0.4);
      s.add(leg);
    }
  }

  private buildPlaques() {
    const h = this.hooks;
    const s = () => h.settings();
    const specs: [Spec, number, number, number, number][] = [
      // [spec, x, z, width, depth]
      [
        {
          kind: 'select',
          title: ['TIME OF DAY', '时间'],
          options: [['cycle', 'Cycle', '昼夜'], ['morning', 'Morning', '清晨'], ['afternoon', 'Afternoon', '午后'], ['night', 'Night', '夜晚']],
          get: () => h.timeOfDay(),
          set: (v) => h.setTimeOfDay(v as TimeOfDay),
        },
        -3.4, -1.15, 3.1, 1.45,
      ],
      [
        {
          kind: 'select',
          title: ['WEATHER', '天气'],
          options: [['auto', 'Natural', '自然'], ['clear', 'Clear', '晴'], ['cloudy', 'Cloudy', '多云'], ['rain', 'Rain', '雨'], ['storm', 'Storm', '暴风']],
          get: () => s().weather,
          set: (v) => h.change({ weather: v as Settings['weather'] }),
        },
        0, -1.15, 3.1, 1.45,
      ],
      [
        {
          kind: 'select',
          title: ['RENDER QUALITY', '画质'],
          options: [['auto', 'Auto', '自动'], ['high', 'High', '高'], ['medium', 'Medium', '中'], ['low', 'Low', '低']],
          get: () => s().quality,
          set: (v) => h.change({ quality: v as Settings['quality'] }),
        },
        3.4, -1.15, 3.1, 1.45,
      ],
      [{ kind: 'toggle', title: ['LIGHTING EFFECTS', '光影特效'], get: () => s().lightingEffects, set: (v) => h.change({ lightingEffects: v }) }, -3.4, 0.55, 3.1, 1.1],
      [{ kind: 'toggle', title: ['CAMERA PREVIEW', '摄像头画面'], get: () => s().showCamera, set: (v) => h.change({ showCamera: v }) }, 0, 0.55, 3.1, 1.1],
      [{ kind: 'toggle', title: ['CONTROLS HINT', '操作提示'], get: () => s().showHelp, set: (v) => h.change({ showHelp: v }) }, 3.4, 0.55, 3.1, 1.1],
      [
        {
          kind: 'action',
          title: ['SETTINGS', '设置'],
          line: () => '← Back · 返回',
          act: () => this.leave(),
        },
        -2.3, 1.95, 3.3, 0.85,
      ],
      [
        {
          kind: 'action',
          title: ['PHANTOM WALLET', '钱包'],
          line: () => {
            const w = walletState();
            return w.owner ? `${shortAddress(w.owner)} · click to disconnect` : 'Not connected · click to connect';
          },
          act: () => (walletState().owner ? h.logOut() : h.connectWallet()),
        },
        2.3, 1.95, 3.3, 0.85,
      ],
    ];
    specs.forEach(([spec, x, z, w, d], i) => this.plaques.push(this.buildPlaque(spec, new THREE.Vector3(x, BOARD_H / 2, z), w, d, ((i * 37) % 7 - 3) * 0.012)));
  }

  private buildPlaque(spec: Spec, home: THREE.Vector3, w: number, d: number, yaw: number): Plaque {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * TEX_PX);
    canvas.height = Math.round(d * TEX_PX);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const edge = new THREE.MeshStandardMaterial({ color: '#7a5230', roughness: 0.85 });
    const board = new THREE.Mesh(new THREE.BoxGeometry(w, BOARD_H, d), [edge, edge, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }), edge, edge, edge]);
    board.castShadow = board.receiveShadow = true;
    const group = new THREE.Group();
    group.add(board);
    const p: Plaque = { spec, group, board, canvas, tex, w, d, home, yaw, dropAt: 0, landed: false, hover: 0, sliderX: 0, leverA: LEVER_OFF };
    const brass = new THREE.MeshStandardMaterial({ color: '#c9a24a', metalness: 0.85, roughness: 0.3 });
    if (spec.kind === 'select') {
      // A brass slider riding in a groove under the options.
      const groove = new THREE.Mesh(new THREE.BoxGeometry(w - 0.3, 0.02, 0.07), new THREE.MeshStandardMaterial({ color: '#2a170a', roughness: 1 }));
      groove.position.set(0, BOARD_H / 2 + 0.005, d * 0.4);
      const slider = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.09, 0.16), brass);
      slider.position.set(0, BOARD_H / 2 + 0.045, d * 0.4);
      slider.castShadow = true;
      group.add(groove, slider);
      p.slider = slider;
    } else if (spec.kind === 'toggle') {
      // A lever switch on a metal base, and a lamp beside it.
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.34), new THREE.MeshStandardMaterial({ color: '#2b3238', metalness: 0.6, roughness: 0.4 }));
      base.position.set(w / 2 - 0.55, BOARD_H / 2 + 0.05, 0.05);
      const lever = new THREE.Group();
      lever.position.set(w / 2 - 0.55, BOARD_H / 2 + 0.1, 0.05);
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.42, 8), new THREE.MeshStandardMaterial({ color: '#cfd8dc', metalness: 0.8, roughness: 0.25 }));
      stick.position.y = 0.21;
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), new THREE.MeshStandardMaterial({ color: '#b8322a', roughness: 0.4 }));
      knob.position.y = 0.43;
      stick.castShadow = knob.castShadow = true;
      lever.add(stick, knob);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.08, 14, 10), new THREE.MeshStandardMaterial({ color: '#333', emissive: '#000', roughness: 0.3 }));
      lamp.position.set(w / 2 - 1.05, BOARD_H / 2 + 0.06, 0.05);
      group.add(base, lever, lamp);
      p.lever = lever;
      p.lamp = lamp;
    }
    group.visible = false;
    this.scene.add(group);
    return p;
  }

  /** Where the brass slider sits for option i. */
  private slotX(p: Plaque, i: number) {
    const n = (p.spec as Selector).options.length;
    const inner = p.w - 0.5;
    return -inner / 2 + ((i + 0.5) * inner) / n;
  }

  /** Puts the slider, lever and lamp where the current values say (instant: no tween). */
  private syncControls(p: Plaque, instant = false) {
    const spec = p.spec;
    if (spec.kind === 'select') {
      const i = Math.max(0, spec.options.findIndex(([v]) => v === spec.get()));
      p.sliderX = this.slotX(p, i);
      if (instant) p.slider!.position.x = p.sliderX;
    } else if (spec.kind === 'toggle') {
      const on = spec.get();
      p.leverA = on ? LEVER_ON : LEVER_OFF;
      if (instant) p.lever!.rotation.z = p.leverA;
      const lamp = p.lamp!.material as THREE.MeshStandardMaterial;
      lamp.color.set(on ? '#3ef0a8' : '#5a2a26');
      lamp.emissive.set(on ? '#3ef0a8' : '#000000');
      lamp.emissiveIntensity = on ? 1.6 : 0;
    }
  }

  private paintAll() {
    for (const p of this.plaques) this.paint(p);
  }

  /** The plaque's face: light wood, burnt-in lettering. */
  private paint(p: Plaque) {
    const c = p.canvas.getContext('2d')!;
    const W = p.canvas.width;
    const H = p.canvas.height;
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#d9b483');
    g.addColorStop(1, '#c79e6b');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
    // Grain.
    c.strokeStyle = 'rgba(110, 70, 30, 0.13)';
    c.lineWidth = 2;
    for (let i = 0; i < 9; i++) {
      const y = ((i + 0.5) / 9) * H + Math.sin(i * 7.1) * 6;
      c.beginPath();
      c.moveTo(0, y);
      for (let x = 0; x <= W; x += 24) c.lineTo(x, y + Math.sin(x / 60 + i) * 3);
      c.stroke();
    }
    // Bevelled border.
    c.strokeStyle = 'rgba(90, 55, 25, 0.55)';
    c.lineWidth = 8;
    c.strokeRect(10, 10, W - 20, H - 20);
    c.strokeStyle = 'rgba(255, 235, 200, 0.35)';
    c.lineWidth = 2;
    c.strokeRect(16, 16, W - 32, H - 32);

    const spec = p.spec;
    const pad = 44;
    c.textBaseline = 'alphabetic';
    c.textAlign = 'left';
    if (spec.kind === 'toggle') {
      // Stacked so the name can stay big beside the lever: English, Chinese, then the state.
      const room = W - pad * 2 - 0.95 * TEX_PX;
      let size = H * 0.21;
      c.font = `900 ${size}px Inter, system-ui, sans-serif`;
      c.letterSpacing = '0.08em';
      const w = c.measureText(spec.title[0]).width;
      if (w > room) size *= room / w;
      c.font = `900 ${size.toFixed(1)}px Inter, system-ui, sans-serif`;
      c.fillStyle = INK;
      c.fillText(spec.title[0], pad, H * 0.34);
      c.letterSpacing = '0px';
      c.font = `700 ${Math.round(H * 0.15)}px system-ui, sans-serif`;
      c.fillStyle = INK_SOFT;
      c.fillText(spec.title[1], pad, H * 0.56);
      const on = spec.get();
      c.fillStyle = on ? '#1f7a52' : '#8a3a2a';
      c.font = `900 ${Math.round(H * 0.22)}px Inter, system-ui, sans-serif`;
      c.fillText(on ? 'ON · 开' : 'OFF · 关', pad, H * 0.85);
      p.tex.needsUpdate = true;
      return;
    }
    // The title (English, then Chinese) shrinks to the room it has.
    const room = W - pad * 2;
    const titleY = spec.kind === 'action' ? H * 0.46 : H * 0.32;
    let size = H * (spec.kind === 'action' ? 0.3 : 0.2);
    const titleFonts = () => [`900 ${size.toFixed(1)}px Inter, system-ui, sans-serif`, `700 ${(size * 0.75).toFixed(1)}px system-ui, sans-serif`];
    const titleWidth = () => {
      const [en, zh] = titleFonts();
      c.font = en;
      c.letterSpacing = '0.08em';
      const a = c.measureText(spec.title[0]).width;
      c.font = zh;
      c.letterSpacing = '0px';
      return a + size * 0.3 + c.measureText(spec.title[1]).width;
    };
    const tw0 = titleWidth();
    if (tw0 > room) size *= room / tw0;
    const [enFont, zhFont] = titleFonts();
    c.fillStyle = INK;
    c.font = enFont;
    c.letterSpacing = '0.08em';
    c.fillText(spec.title[0], pad, titleY);
    const tw = c.measureText(spec.title[0]).width;
    c.letterSpacing = '0px';
    c.font = zhFont;
    c.fillStyle = INK_SOFT;
    c.fillText(spec.title[1], pad + tw + size * 0.3, titleY);

    if (spec.kind === 'select') {
      const cur = spec.get();
      const n = spec.options.length;
      // Every option word fits its own slot (the slider's stops), never its neighbour's.
      const slot = ((p.w - 0.5) / n) * TEX_PX * 0.9;
      let optSize = H * 0.13;
      c.font = `900 ${optSize}px Inter, system-ui, sans-serif`;
      const widest = Math.max(...spec.options.map(([, en]) => c.measureText(en).width));
      if (widest > slot) optSize *= slot / widest;
      spec.options.forEach(([v, en, zh], i) => {
        const x = ((this.slotX(p, i) + p.w / 2) / p.w) * W;
        const on = v === cur;
        c.textAlign = 'center';
        c.fillStyle = on ? INK : INK_SOFT;
        c.font = `${on ? 900 : 600} ${optSize.toFixed(1)}px Inter, system-ui, sans-serif`;
        c.fillText(en, x, H * 0.55);
        c.font = `${on ? 800 : 500} ${Math.round(H * 0.1)}px system-ui, sans-serif`;
        c.fillText(zh, x, H * 0.68);
      });
    } else {
      c.textAlign = 'left';
      c.fillStyle = INK_SOFT;
      c.font = `700 ${Math.round(H * 0.17)}px Inter, system-ui, sans-serif`;
      c.fillText(spec.line(), pad, H * 0.78);
    }
    p.tex.needsUpdate = true;
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private placeCamera() {
    const fit = Math.max(1, BASE_ASPECT / this.camera.aspect);
    const lift = (1 - this.panU) * RISE;
    this.camera.position.set(CAM.x * fit, CAM.y * fit + lift, LOOK.z + (CAM.z - LOOK.z) * fit);
    const look = new THREE.Vector3(LOOK.x, LOOK.y + lift, LOOK.z);
    let yaw = 0;
    let pitch = 0;
    const from = this.camera.position.clone();
    if (this.focusU > 0) {
      // Lean in over the hovered plaque.
      const base = look.clone().sub(this.camera.position).normalize();
      const e = easeInOut(this.focusU);
      const at = new THREE.Vector3(this.focus.x, this.focus.y + lift, this.focus.z);
      this.camera.position.lerp(at.clone().addScaledVector(FOCUS_CAM, fit), e * FOCUS_POS);
      look.lerp(at, e * FOCUS_LOOK);
      const dir = look.clone().sub(this.camera.position).normalize();
      yaw = Math.atan2(dir.x, -dir.z) - Math.atan2(base.x, -base.z);
      pitch = Math.asin(dir.y) - Math.asin(base.y);
    }
    this.hooks.view?.(this.camera.position.clone().sub(from), yaw, pitch);
    this.camera.lookAt(look);
    this.camera.updateMatrixWorld();
    const back = new THREE.Vector3(0, 0, TABLE.z0 + SHADOW_Z).project(this.camera);
    this.hooks.pan(this.panU, ((1 - back.y) / 2) * window.innerHeight);
  }

  // ---- Loop -------------------------------------------------------------

  private frame(dt: number) {
    this.time += dt;
    const pt = this.panTween;
    if (pt) {
      const u = Math.min(1, (this.time - pt.t0) / (pt.to > pt.from ? PAN_S : 0.9));
      this.panU = pt.from + (pt.to - pt.from) * easeInOut(u);
      if (u >= 1) {
        this.panTween = null;
        pt.done?.();
        if (this.state === 'closed') return;
      }
    }
    const k = 1 - Math.exp(-dt * 12);
    for (const p of this.plaques) {
      // Drop in: from above, landing with a couple of bounces.
      const u = (this.time - p.dropAt) / DROP_S;
      if (u < 0) continue;
      p.group.visible = true;
      p.landed = u >= 1;
      const fall = p.landed ? 1 : easeOutBounce(u);
      p.hover += ((this.hovered === p ? 1 : 0) - p.hover) * k;
      p.group.position.set(p.home.x, p.home.y + (1 - fall) * 6 + p.hover * 0.08, p.home.z);
      p.group.rotation.set(0, p.yaw, (1 - fall) * 0.3 * (p.yaw > 0 ? 1 : -1));
      if (p.slider) p.slider.position.x += (p.sliderX - p.slider.position.x) * k;
      if (p.lever) p.lever.rotation.z += (p.leverA - p.lever.rotation.z) * k;
    }
    this.updateFocus(dt);
    this.placeCamera();
    this.renderer.render(this.scene, this.camera);
  }

  /** Eases the camera's lean toward the hovered plaque (only on the settled table), and back out. */
  private updateFocus(dt: number) {
    const idle = this.state === 'idle';
    if (idle && this.hovered) {
      this.lastHover = this.time;
      const h = this.hovered.home;
      // Straight there from the overview; sliding across when moving between plaques.
      if (this.focusU < 0.01) this.focus.copy(h);
      else this.focus.lerp(h, 1 - Math.exp(-dt * FOCUS_RATE * 1.5));
    }
    const want = idle && this.time - this.lastHover < FOCUS_HOLD_S ? 1 : 0;
    this.focusU += (want - this.focusU) * (1 - Math.exp(-dt * FOCUS_RATE));
    if (this.focusU < 0.001) this.focusU = 0;
  }

  // ---- Pointer ----------------------------------------------------------

  private pick(e: PointerEvent): { plaque: Plaque; uv: THREE.Vector2 | null } | null {
    this.ray.setFromCamera(new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, 1 - (e.clientY / window.innerHeight) * 2), this.camera);
    const targets = this.plaques.filter((p) => p.landed).map((p) => p.group);
    const hit = this.ray.intersectObjects(targets, true)[0];
    if (!hit) return null;
    const plaque = this.plaques.find((p) => p.group === hit.object || p.group.children.includes(hit.object) || p.lever?.children.includes(hit.object))!;
    return { plaque, uv: hit.object === plaque.board ? (hit.uv ?? null) : null };
  }

  /** Our clicks land on a bare canvas (the title's, over ours); the title fish claim theirs (defaultPrevented). */
  /** A modal (the Aquarium) is up over the scene: ignore the pointer. */
  blocked: () => boolean = () => false;

  private ours(e: PointerEvent) {
    return this.state === 'idle' && e.target instanceof HTMLCanvasElement && !e.defaultPrevented;
  }

  private onDown(e: PointerEvent) {
    if (this.blocked() || !this.ours(e)) return;
    const hit = this.pick(e);
    this.press = { plaque: hit?.plaque ?? null, uv: hit?.uv ?? null, x: e.clientX, y: e.clientY, t: performance.now() };
  }

  private onMove(e: PointerEvent) {
    if (!this.visible) return;
    if (this.blocked()) {
      if (this.hovered) {
        this.hovered = null;
        document.body.style.cursor = '';
      }
      return;
    }
    this.hovered = this.ours(e) ? (this.pick(e)?.plaque ?? null) : null;
    document.body.style.cursor = this.hovered ? 'pointer' : '';
  }

  private onUp(e: PointerEvent) {
    const press = this.press;
    this.press = null;
    if (this.blocked()) return;
    if (!press?.plaque || this.state !== 'idle') return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_MOVE_PX || performance.now() - press.t > CLICK_MS) return;
    const p = press.plaque;
    const spec = p.spec;
    if (spec.kind === 'select') {
      // The option under the click (anywhere along the plaque's width); off the options, the next one.
      const options = spec.options;
      let i: number;
      if (press.uv) {
        const x = press.uv.x * p.w - p.w / 2;
        i = options.reduce((best, _, j) => (Math.abs(this.slotX(p, j) - x) < Math.abs(this.slotX(p, best) - x) ? j : best), 0);
      } else {
        i = (options.findIndex(([v]) => v === spec.get()) + 1) % options.length;
      }
      spec.set(options[i][0]);
    } else if (spec.kind === 'toggle') {
      spec.set(!spec.get());
    } else {
      spec.act();
    }
    this.syncControls(p);
    this.paint(p);
  }
}
