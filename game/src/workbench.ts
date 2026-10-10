// Workbench: after START the camera pans down from the title rope (its fish
// stay hanging at the top of the screen) onto a table seen at an angle (2.5D).
// The gear drops onto it as 3D models and lands with a thud. Click a piece to get
// it ready: it is set down in the tray on the right (click it there, or drag it
// out, to put it back). The folded sea chart in the middle opens into a map with
// the three places, one per chapter; pick one and dive.
//
// Physics is hand-rolled for a handful of pieces: gravity, a bounce off the table
// top, and circle collisions in the table plane.

import * as THREE from 'three';
import { CHART_H, CHART_W, PLACES, ROMAN, drawChart } from './chart';
import { MAPS, MAP_ORDER, isUnlocked, mapDepth, type MapId, type MapProgress } from './maps';
import { UPGRADES, buildUpgradeModel, type UpgradeDef, type UpgradeId } from './upgrades';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface WorkbenchHooks {
  progress(): MapProgress;
  setUnlockAll(on: boolean): void;
  /** The camera pan between the title (0) and the table (1); tableY: screen y of the table's back, for shadows. */
  pan(u: number, tableY: number): void;
  /** Called at the end of the zoom into the chosen place. */
  dive(map: MapId, gear: UpgradeId[]): void;
}

const GEAR: UpgradeId[] = ['fins', 'tank', 'lamp', 'rod', 'net', 'bait'];
/** Where each piece lands, in table units (x right, z toward the camera). */
const SPOTS: [number, number][] = [
  [-3.9, -1.2],
  [-3.6, 1.35],
  [-1.4, -1.85],
  [1.45, -1.3],
  [1.5, 1.3],
  [-0.9, 1.95],
];

const TABLE = { x0: -5.2, x1: 5.2, z0: -2.7, z1: 2.7 };
const TRAY = { x0: 2.55, x1: 4.85, z0: -2.5, z1: 2.5 };
const SLOTS: [number, number][] = [
  [3.15, -1.15],
  [4.25, -1.15],
  [3.15, 0.3],
  [4.25, 0.3],
  [3.15, 1.75],
  [4.25, 1.75],
];
const MAP_AT = new THREE.Vector3(-1.05, 0, 0.1);
const MAP_W = 2.9;
const MAP_D = (MAP_W * CHART_H) / CHART_W;

const GEAR_SIZE = 1.05; // longest side of a piece, table units
const TRAY_SCALE = 0.8;
const GRAVITY = 26;
const RESTITUTION = 0.32;
const BOUNCE_MIN = 2.2; // slower than this and it just settles
const HOLD_Y = 0.85;
const MAP_REST = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.07);
const MAP_TOP = 0.03; // gear resting on the chart sits this much higher
const CREASE = 0.07; // how far the fold stands up off the table
const PICKUP_S = 0.75; // the chart's flight from the table to the middle of the screen
const SCATTER_S = 0.55; // gear on the chart hopping off before it is picked up
const SHADOW_Z = 0.7; // where the title fish's shadows fall, from the table's back edge
const STEP = 1 / 120;

// Camera: aimed above the table, so the table fills the lower half and the title
// rope keeps the top; the pan starts RISE units higher.
const CAM = new THREE.Vector3(0, 6.2, 9.5);
const LOOK = new THREE.Vector3(0, 0.85, 0);
const BASE_ASPECT = 1.6;
const RISE = 7.5;
const PAN_S = 1.15;
const DROP_START_S = 0.8;
const DROP_GAP_S = 0.15;

const CLICK_MOVE_PX = 6;
const CLICK_MS = 400;

type Mode = 'wait' | 'free' | 'held' | 'moving' | 'ready';
type State = 'closed' | 'idle' | 'opening' | 'chart' | 'closing' | 'leaving' | 'diving';

interface Piece {
  id: UpgradeId;
  def: UpgradeDef;
  obj: THREE.Group;
  hit: THREE.Mesh;
  r: number; // collision radius in the table plane
  restY: number; // centre height when lying on the table
  flat: THREE.Quaternion; // lying on its largest face
  yaw: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  q: THREE.Quaternion;
  mode: Mode;
  grounded: boolean;
  dropAt: number;
  slot: number;
  hover: number;
  tray: number; // display scale, shrinks in the tray
}

interface Tween {
  t: number;
  dur: number;
  fn: (u: number) => void;
  done?: () => void;
}

const easeOut = (u: number) => 1 - (1 - u) ** 3;
const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const UP = new THREE.Vector3(0, 1, 0);
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();

export class Workbench {
  private root = $('workbench');
  private canvas = $<HTMLCanvasElement>('wb-canvas');
  private tip = $('wb-tip');
  private toastEl = $('wb-toast');
  private ui = $('wb-ui');
  private chartEl = $('wb-chart');
  private paper = $('wb-paper');
  private chartCanvas = $<HTMLCanvasElement>('wb-chart-canvas');
  private pinsEl = $('wb-pins');
  private placeEl = $('wb-place');
  private demoBox = $<HTMLInputElement>('wb-demo-box');

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(34, 1, 0.1, 120);
  private ray = new THREE.Raycaster();
  private pieces: Piece[] = [];
  private map = new THREE.Group();
  private mapMesh: THREE.Mesh;
  private mapMat: THREE.MeshStandardMaterial;
  private mapTex: THREE.CanvasTexture;
  private mapHover = 0;
  private slotRings: THREE.Mesh[] = [];
  private dust: { mesh: THREE.Mesh; t: number }[] = [];

  private state: State = 'closed';
  private placed = false; // pieces have landed at least once
  private panU = 0;
  private shake = 0;
  private time = 0;
  private acc = 0;
  private last = 0;
  private raf = 0;
  private tweens: Tween[] = [];
  private press: { piece: Piece | null; map: boolean; x: number; y: number; t: number } | null = null;
  private held: Piece | null = null;
  private holdTarget = new THREE.Vector3();
  private hovered: Piece | 'map' | null = null;
  private picked: MapId | null = null;
  private toastTimer = 0;

  constructor(private hooks: WorkbenchHooks) {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x000000, 0);

    this.buildRoom();
    const chartTex = document.createElement('canvas');
    this.mapTex = new THREE.CanvasTexture(chartTex);
    this.mapTex.colorSpace = THREE.SRGBColorSpace;
    this.mapTex.anisotropy = 8;
    this.mapMat = new THREE.MeshStandardMaterial({ map: this.mapTex, roughness: 0.92, flatShading: true, emissive: '#ffcc4d', emissiveIntensity: 0 });
    this.mapMesh = this.buildMap();
    GEAR.forEach((id, i) => this.pieces.push(this.buildPiece(id, i)));

    window.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('keydown', (e) => {
      if (this.state === 'chart' && e.key === 'Enter' && this.picked) {
        e.preventDefault();
        this.dive();
      }
    });
    this.chartEl.addEventListener('click', (e) => {
      if (this.state === 'chart' && e.target === this.chartEl) this.closeChart();
    });
    $('wb-dive').addEventListener('click', () => this.state === 'chart' && this.picked && this.dive());
    this.demoBox.addEventListener('change', () => {
      this.hooks.setUnlockAll(this.demoBox.checked);
      if (this.picked && !isUnlocked(MAPS[this.picked], this.hooks.progress())) this.picked = null;
      this.paintMap();
      this.renderPins();
    });
    window.addEventListener('resize', () => this.visible && this.resize());
  }

  get visible() {
    return this.state !== 'closed';
  }

  /** Ready gear, in tray order. */
  get packed(): UpgradeId[] {
    return this.pieces
      .filter((p) => p.slot >= 0)
      .sort((a, b) => a.slot - b.slot)
      .map((p) => p.id);
  }

  /** intro: pan down from the title and drop the gear; otherwise come back to the table as it was. */
  show(intro: boolean) {
    this.root.classList.remove('hidden');
    this.lift(false);
    this.ui.classList.remove('hidden');
    this.chartEl.classList.add('hidden');
    this.chartEl.classList.remove('closing', 'pre');
    this.paper.classList.remove('zooming');
    this.tip.classList.add('hidden');
    this.map.visible = true;
    this.map.position.copy(MAP_AT);
    this.map.quaternion.copy(MAP_REST);
    this.setCrease(1);
    this.tweens = [];
    this.held = null;
    this.press = null;
    this.paintMap();
    this.resize();
    if (intro || !this.placed) this.scatter(intro);
    this.placed = true;
    this.time = 0;
    this.acc = 0;
    if (intro) {
      this.state = 'opening';
      this.panU = 0;
      this.tween(PAN_S, (u) => this.setPan(easeInOut(u)), () => (this.state = 'idle'));
    } else {
      this.state = 'idle';
      this.setPan(1);
    }
    this.placeCamera();
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
    this.ui.classList.add('hidden');
    this.lift(false);
    this.chartEl.classList.add('hidden');
    this.tip.classList.add('hidden');
    document.body.style.cursor = '';
  }

  /** The chart is held up toward the camera: the table goes over the title fish, which fade out (style.css). */
  private lift(on: boolean) {
    document.body.classList.toggle('wb-lifted', on);
  }

  /** Esc: fold the chart; from the bare table, pan back up to the title. */
  escape() {
    if (this.state === 'chart') this.closeChart();
    else if (this.state === 'idle') this.leave();
  }

  // ---- Scene ------------------------------------------------------------

  private buildRoom() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight('#e6f6ff', '#4a3420', 1.25));
    const sun = new THREE.DirectionalLight('#fff1dc', 2.4);
    sun.position.set(-4, 10, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -7;
    sc.right = 7;
    sc.top = 5;
    sc.bottom = -5;
    sc.near = 1;
    sc.far = 30;
    sun.shadow.bias = -0.0005;
    sun.shadow.radius = 4;
    s.add(sun);
    const fill = new THREE.DirectionalLight('#9fe8ff', 0.6);
    fill.position.set(5, 4, -3);
    s.add(fill);

    // Table top: planks on a thick slab, so the front edge reads when the camera tilts.
    const w = TABLE.x1 - TABLE.x0;
    const d = TABLE.z1 - TABLE.z0;
    const top = new THREE.CanvasTexture(drawPlanks(1024, Math.round((1024 * d) / w)));
    top.colorSpace = THREE.SRGBColorSpace;
    top.anisotropy = 8;
    const side = new THREE.MeshStandardMaterial({ color: '#4a2f18', roughness: 0.9 });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w, 0.45, d), [
      side,
      side,
      new THREE.MeshStandardMaterial({ map: top, roughness: 0.85 }),
      side,
      side,
      side,
    ]);
    slab.position.set((TABLE.x0 + TABLE.x1) / 2, -0.225, (TABLE.z0 + TABLE.z1) / 2);
    slab.receiveShadow = true;
    s.add(slab);
    // Legs reach down past the bottom of the screen.
    for (const [x, z] of [[TABLE.x0 + 0.5, TABLE.z0 + 0.4], [TABLE.x1 - 0.5, TABLE.z0 + 0.4]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.45, 6, 0.45), side);
      leg.position.set(x, -3.3, z);
      s.add(leg);
    }

    // The ready tray: a felt mat with a slot for each piece.
    const trayW = TRAY.x1 - TRAY.x0;
    const trayD = TRAY.z1 - TRAY.z0;
    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(trayW, 0.05, trayD),
      new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(drawTray(trayW, trayD)), roughness: 1 }),
    );
    (felt.material as THREE.MeshStandardMaterial).map!.colorSpace = THREE.SRGBColorSpace;
    felt.position.set((TRAY.x0 + TRAY.x1) / 2, 0.025, (TRAY.z0 + TRAY.z1) / 2);
    felt.receiveShadow = true;
    s.add(felt);
    for (const [x, z] of SLOTS) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.42, 0.5, 40),
        new THREE.MeshBasicMaterial({ color: '#fff0d2', transparent: true, opacity: 0.18, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.056, z);
      s.add(ring);
      this.slotRings.push(ring);
    }
  }

  /** The folded sea chart: a plane with a raised crease down the middle. */
  private buildMap() {
    const geo = new THREE.PlaneGeometry(MAP_W, MAP_D, 2, 1);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, this.mapMat);
    mesh.position.y = 0.012;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.map.add(mesh);
    this.scene.add(this.map);
    return mesh;
  }

  /** 1 = folded (the crease stands up), 0 = flattened out to hold up and read. */
  private setCrease(fold: number) {
    const geo = this.mapMesh.geometry;
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getX(i)) < 1e-3) pos.setY(i, CREASE * fold);
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  private paintMap() {
    drawChart(this.mapTex.image as HTMLCanvasElement, 1, this.hooks.progress(), true);
    this.mapTex.needsUpdate = true;
  }

  private buildPiece(id: UpgradeId, i: number): Piece {
    const model = buildUpgradeModel(id, 1);
    model.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = true;
    });
    // Centre it and size it, then find the face it would lie on (its thinnest axis down).
    const holder = new THREE.Group();
    holder.add(model);
    let box = new THREE.Box3().setFromObject(holder);
    const size = box.getSize(new THREE.Vector3());
    model.scale.multiplyScalar(GEAR_SIZE / Math.max(size.x, size.y, size.z));
    box = new THREE.Box3().setFromObject(holder);
    model.position.sub(box.getCenter(new THREE.Vector3()));
    size.copy(box.getSize(new THREE.Vector3()));
    const flat = new THREE.Quaternion();
    if (size.x <= size.y && size.x <= size.z) flat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    else if (size.z <= size.y && size.z <= size.x) flat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    const thin = Math.min(size.x, size.y, size.z);
    const wide = [size.x, size.y, size.z].sort((a, b) => b - a);

    const obj = new THREE.Group();
    obj.add(holder);
    // An invisible box to click, fitted to the model but never thinner than a
    // finger: thin parts like a rod are hard to hit otherwise.
    const hit = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(size.x * 1.1, 0.3), Math.max(size.y * 1.1, 0.3), Math.max(size.z * 1.1, 0.3)),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    obj.add(hit);
    obj.visible = false;
    this.scene.add(obj);
    return {
      id,
      def: UPGRADES.find((u) => u.id === id)!,
      obj,
      hit,
      r: (wide[0] + wide[1]) * 0.24,
      restY: thin / 2,
      flat,
      yaw: 0,
      pos: new THREE.Vector3(SPOTS[i][0], thin / 2, SPOTS[i][1]),
      vel: new THREE.Vector3(),
      spin: new THREE.Vector3(),
      q: new THREE.Quaternion(),
      mode: 'free',
      grounded: true,
      dropAt: 0,
      slot: -1,
      hover: 0,
      tray: 1,
    };
  }

  /** Back to the starting layout. intro: everything waits above the table to drop in. */
  private scatter(intro: boolean) {
    this.pieces.forEach((p, i) => {
      const [x, z] = SPOTS[i];
      p.slot = -1;
      p.hover = 0;
      p.yaw = (Math.random() - 0.5) * 1.6;
      p.vel.set(0, 0, 0);
      p.spin.set(0, 0, 0);
      if (intro) {
        p.mode = 'wait';
        p.obj.visible = false;
        p.dropAt = DROP_START_S + i * DROP_GAP_S;
        p.pos.set(x + (Math.random() - 0.5) * 0.4, 6 + Math.random() * 2, z + (Math.random() - 0.5) * 0.4);
        p.q.setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6));
        p.spin.set((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 9);
        p.vel.set((Math.random() - 0.5) * 1.5, -2, (Math.random() - 0.5) * 1.5);
        p.grounded = false;
      } else {
        p.mode = 'free';
        p.obj.visible = true;
        p.pos.set(x, p.restY, z);
        p.q.copy(this.restQ(p));
        p.grounded = true;
      }
    });
    for (const ring of this.slotRings) this.lightSlot(ring, false);
  }

  private restQ(p: Piece, yaw = p.yaw) {
    return tmpQ.setFromAxisAngle(UP, yaw).clone().multiply(p.flat);
  }

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private setPan(u: number) {
    this.panU = u;
  }

  /** Places the camera, then tells the title where the table's back is now, for the fish's shadows. */
  private placeCamera() {
    // A narrower window backs the camera off so the whole table still fits across.
    const fit = Math.max(1, BASE_ASPECT / this.camera.aspect);
    const lift = (1 - this.panU) * RISE;
    const jx = (Math.random() - 0.5) * this.shake;
    const jy = (Math.random() - 0.5) * this.shake;
    this.camera.position.set(CAM.x * fit + jx, CAM.y * fit + lift + jy, LOOK.z + (CAM.z - LOOK.z) * fit);
    this.camera.lookAt(LOOK.x + jx * 0.5, LOOK.y + lift + jy * 0.5, LOOK.z);
    this.camera.updateMatrixWorld();
    const back = tmpV.set(0, 0, TABLE.z0 + SHADOW_Z).project(this.camera);
    this.hooks.pan(this.panU, ((1 - back.y) / 2) * window.innerHeight);
  }

  // ---- Loop -------------------------------------------------------------

  private tween(dur: number, fn: (u: number) => void, done?: () => void) {
    this.tweens.push({ t: 0, dur, fn, done });
  }

  private frame(dt: number) {
    this.time += dt;
    this.acc += dt;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this.step(STEP);
    }
    for (const tw of [...this.tweens]) {
      tw.t = Math.min(tw.dur, tw.t + dt);
      tw.fn(tw.t / tw.dur);
      if (tw.t >= tw.dur) {
        this.tweens.splice(this.tweens.indexOf(tw), 1);
        tw.done?.();
      }
    }
    this.shake *= Math.exp(-dt * 9);

    for (const p of this.pieces) {
      p.hover = lerp(p.hover, this.hovered === p ? 1 : 0, 1 - Math.exp(-dt * 14));
      p.obj.position.copy(p.pos);
      p.obj.position.y += p.hover * 0.12;
      p.obj.quaternion.copy(p.q);
      // Set down a little smaller in the tray, so neighbours don't overlap.
      p.tray = lerp(p.tray, p.slot >= 0 ? TRAY_SCALE : 1, 1 - Math.exp(-dt * 8));
      p.obj.scale.setScalar(p.tray * (1 + p.hover * 0.08));
    }
    this.mapHover = lerp(this.mapHover, this.hovered === 'map' ? 1 : 0, 1 - Math.exp(-dt * 12));
    this.mapMat.emissiveIntensity = this.mapHover * (0.12 + 0.06 * Math.sin(this.time * 6));
    for (const d of [...this.dust]) {
      d.t += dt;
      const u = d.t / 0.45;
      d.mesh.scale.setScalar(d.mesh.userData.r * (0.5 + easeOut(Math.min(1, u)) * 0.9));
      (d.mesh.material as THREE.MeshBasicMaterial).opacity = 0.4 * (1 - u) ** 2;
      if (u >= 1) {
        this.scene.remove(d.mesh);
        d.mesh.geometry.dispose();
        this.dust.splice(this.dust.indexOf(d), 1);
      }
    }

    this.placeCamera();
    this.renderer.render(this.scene, this.camera);
  }

  // ---- Physics ----------------------------------------------------------

  private step(dt: number) {
    for (const p of this.pieces) {
      if (p.mode === 'wait') {
        if (this.time < p.dropAt) continue;
        p.mode = 'free';
        p.obj.visible = true;
      }
      if (p.mode === 'held') {
        const prev = tmpV.copy(p.pos);
        p.pos.lerp(this.holdTarget, 1 - Math.exp(-dt * 22));
        p.vel.subVectors(p.pos, prev).divideScalar(dt);
        p.q.slerp(this.restQ(p), 1 - Math.exp(-dt * 10));
        continue;
      }
      if (p.mode !== 'free') continue;

      p.vel.y -= GRAVITY * dt;
      p.pos.addScaledVector(p.vel, dt);
      const floor = p.restY + (this.onMap(p) ? MAP_TOP : 0);
      if (p.pos.y <= floor) {
        p.pos.y = floor;
        if (p.vel.y < -BOUNCE_MIN) {
          this.thud(p, -p.vel.y);
          p.vel.y *= -RESTITUTION;
          p.spin.multiplyScalar(0.45);
          p.grounded = false;
        } else {
          if (!p.grounded) p.yaw = new THREE.Euler().setFromQuaternion(p.q, 'YXZ').y;
          p.vel.y = 0;
          p.grounded = true;
        }
      } else if (p.pos.y > floor + 0.01) p.grounded = false;

      if (p.grounded) {
        const k = Math.exp(-dt * 6);
        p.vel.x *= k;
        p.vel.z *= k;
        p.q.slerp(this.restQ(p), 1 - Math.exp(-dt * 14));
        p.spin.multiplyScalar(Math.exp(-dt * 8));
      } else {
        const a = p.spin.length() * dt;
        if (a > 0) p.q.premultiply(tmpQ.setFromAxisAngle(tmpV.copy(p.spin).normalize(), a));
      }

      // Walls only near the table top: a piece tossed out of the tray flies over them.
      if (p.pos.y < floor + 0.5) {
        const xMax = TRAY.x0 - p.r - 0.05;
        if (p.pos.x < TABLE.x0 + p.r) ((p.pos.x = TABLE.x0 + p.r), (p.vel.x = Math.abs(p.vel.x) * 0.4));
        if (p.pos.x > xMax) ((p.pos.x = xMax), (p.vel.x = -Math.abs(p.vel.x) * 0.4));
        if (p.pos.z < TABLE.z0 + p.r) ((p.pos.z = TABLE.z0 + p.r), (p.vel.z = Math.abs(p.vel.z) * 0.4));
        if (p.pos.z > TABLE.z1 - p.r) ((p.pos.z = TABLE.z1 - p.r), (p.vel.z = -Math.abs(p.vel.z) * 0.4));
      }
    }
    this.collide();
  }

  /** Whether a piece lies over the chart while the chart is down on the table. */
  private onMap(p: Piece) {
    if (!this.map.visible || this.map.position.y > 0.05) return false;
    return Math.abs(p.pos.x - MAP_AT.x) < MAP_W / 2 && Math.abs(p.pos.z - MAP_AT.z) < MAP_D / 2;
  }

  /** Hops a piece off the chart, landing just past its nearest edge (straight out from the chart's middle). */
  private hopOff(p: Piece) {
    let dx = p.pos.x - MAP_AT.x;
    let dz = p.pos.z - MAP_AT.z;
    if (Math.hypot(dx, dz) < 0.05) [dx, dz] = [Math.random() - 0.5, Math.random() - 0.5];
    const n = Math.hypot(dx, dz);
    const nx = dx / n;
    const nz = dz / n;
    const reach = Math.min((MAP_W / 2 + p.r + 0.3) / (Math.abs(nx) || 1e-3), (MAP_D / 2 + p.r + 0.3) / (Math.abs(nz) || 1e-3));
    const tx = THREE.MathUtils.clamp(MAP_AT.x + nx * reach + (Math.random() - 0.5) * 0.3, TABLE.x0 + p.r, TRAY.x0 - p.r - 0.1);
    const tz = THREE.MathUtils.clamp(MAP_AT.z + nz * reach + (Math.random() - 0.5) * 0.3, TABLE.z0 + p.r, TABLE.z1 - p.r);
    const t = SCATTER_S * 0.9;
    p.vel.set((tx - p.pos.x) / t, 0.5 * GRAVITY * t, (tz - p.pos.z) / t);
    p.spin.set((Math.random() - 0.5) * 7, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 7);
    p.yaw += (Math.random() - 0.5) * 1.2;
    p.grounded = false;
  }

  /** Circles in the table plane, for pieces at about the same height. */
  private collide() {
    const live = this.pieces.filter((p) => p.mode === 'free' || p.mode === 'held');
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        if (Math.abs(a.pos.y - b.pos.y) > a.restY + b.restY + 0.15) continue;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d = Math.hypot(dx, dz) || 1e-4;
        const min = a.r + b.r;
        if (d >= min) continue;
        const wa = a.mode === 'held' ? 0 : 1;
        const wb = b.mode === 'held' ? 0 : 1;
        const w = wa + wb;
        if (!w) continue;
        const nx = dx / d;
        const nz = dz / d;
        const push = min - d;
        a.pos.x -= nx * push * (wa / w);
        a.pos.z -= nz * push * (wa / w);
        b.pos.x += nx * push * (wb / w);
        b.pos.z += nz * push * (wb / w);
        const rel = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
        if (rel >= 0) continue;
        const imp = (-(1 + 0.35) * rel) / w;
        a.vel.x -= nx * imp * wa;
        a.vel.z -= nz * imp * wa;
        b.vel.x += nx * imp * wb;
        b.vel.z += nz * imp * wb;
        // A knock turns a piece a little where it lies.
        if (wa) a.yaw += (Math.random() - 0.5) * imp * 0.15;
        if (wb) b.yaw += (Math.random() - 0.5) * imp * 0.15;
      }
    }
  }

  /** A piece hits the table: shake, a puff of dust, and whatever lies nearby jumps. */
  private thud(p: Piece, speed: number) {
    this.shake = Math.min(0.22, this.shake + speed * 0.01);
    this.puff(p.pos.x, p.pos.z, p.r * 1.3);
    for (const q of this.pieces) {
      if (q === p || q.mode !== 'free' || !q.grounded) continue;
      const d = Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z);
      if (d > 2.4) continue;
      q.vel.y += (1 - d / 2.4) * speed * 0.16;
      q.spin.set((Math.random() - 0.5) * 3, 0, (Math.random() - 0.5) * 3);
      q.grounded = false;
    }
  }

  private puff(x: number, z: number, r: number) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 1, 32),
      new THREE.MeshBasicMaterial({ color: '#f3e3c6', transparent: true, opacity: 0.55, depthWrite: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.03, z);
    mesh.userData.r = r;
    this.scene.add(mesh);
    this.dust.push({ mesh, t: 0 });
  }

  // ---- Ready tray -------------------------------------------------------

  private makeReady(p: Piece) {
    const used = new Set(this.pieces.map((q) => q.slot));
    const slot = SLOTS.findIndex((_, i) => !used.has(i));
    if (slot < 0) return;
    p.slot = slot;
    p.mode = 'moving';
    const [x, z] = SLOTS[slot];
    const from = p.pos.clone();
    const to = new THREE.Vector3(x, p.restY * TRAY_SCALE + 0.05, z);
    const q0 = p.q.clone();
    const q1 = this.restQ(p, 0);
    this.tween(
      0.5,
      (u) => {
        const e = easeInOut(u);
        p.pos.lerpVectors(from, to, e);
        p.pos.y += Math.sin(u * Math.PI) * 1.3;
        p.q.slerpQuaternions(q0, q1, e);
      },
      () => {
        p.mode = 'ready';
        p.yaw = 0;
        this.puff(x, z, 0.5);
        this.lightSlot(this.slotRings[slot], true);
      },
    );
  }

  /** Out of the tray: tossed back onto a free spot on the table. */
  private unready(p: Piece) {
    if (p.slot >= 0) this.lightSlot(this.slotRings[p.slot], false);
    p.slot = -1;
    p.mode = 'free';
    p.grounded = false;
    const tx = lerp(TABLE.x0 + 1, TRAY.x0 - 1.2, Math.random());
    const tz = lerp(TABLE.z0 + 0.8, TABLE.z1 - 0.8, Math.random());
    const t = 0.65;
    p.vel.set((tx - p.pos.x) / t, 0.5 * GRAVITY * t, (tz - p.pos.z) / t);
    p.spin.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 8);
    p.yaw = (Math.random() - 0.5) * 1.6;
  }

  private lightSlot(ring: THREE.Mesh, on: boolean) {
    const m = ring.material as THREE.MeshBasicMaterial;
    m.color.set(on ? '#3ef0a8' : '#fff0d2');
    m.opacity = on ? 0.85 : 0.18;
  }

  private inTray(v: THREE.Vector3) {
    return v.x > TRAY.x0 && v.x < TRAY.x1 && v.z > TRAY.z0 && v.z < TRAY.z1;
  }

  // ---- Pointer ----------------------------------------------------------

  private setRay(e: PointerEvent) {
    this.ray.setFromCamera(new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1), this.camera);
  }

  private pick(e: PointerEvent): Piece | 'map' | null {
    this.setRay(e);
    const targets: THREE.Object3D[] = this.pieces.filter((p) => p.obj.visible && p.mode !== 'moving').map((p) => p.hit);
    if (this.map.visible) targets.push(this.mapMesh);
    const hit = this.ray.intersectObjects(targets, false)[0];
    if (!hit) return null;
    return hit.object === this.mapMesh ? 'map' : (this.pieces.find((p) => p.hit === hit.object) ?? null);
  }

  /** Our clicks land on a bare canvas (the title's, which sits under ours); not on menus or buttons. */
  private ours(e: PointerEvent) {
    return e.target instanceof HTMLCanvasElement;
  }

  private onDown(e: PointerEvent) {
    if (this.state !== 'idle' || !this.ours(e)) return;
    const hit = this.pick(e);
    this.press = { piece: hit && hit !== 'map' ? hit : null, map: hit === 'map', x: e.clientX, y: e.clientY, t: performance.now() };
  }

  private onMove(e: PointerEvent) {
    if (!this.visible) return;
    if (this.held) {
      this.setRay(e);
      this.ray.ray.intersectPlane(new THREE.Plane(UP, -HOLD_Y), this.holdTarget);
      this.holdTarget.x = THREE.MathUtils.clamp(this.holdTarget.x, TABLE.x0 + 0.4, TABLE.x1 - 0.4);
      this.holdTarget.z = THREE.MathUtils.clamp(this.holdTarget.z, TABLE.z0 + 0.3, TABLE.z1 - 0.3);
      return;
    }
    const press = this.press;
    if (press?.piece && Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_MOVE_PX) {
      // Picked up: a ready piece leaves its slot while it's carried.
      const p = press.piece;
      if (p.slot >= 0) this.lightSlot(this.slotRings[p.slot], false);
      p.slot = -1;
      p.mode = 'held';
      this.held = p;
      this.press = null;
      this.hovered = null;
      this.tip.classList.add('hidden');
      document.body.style.cursor = 'grabbing';
      this.onMove(e);
      return;
    }
    if (this.state !== 'idle' || !this.ours(e)) {
      this.setHover(null, e);
      return;
    }
    this.setHover(this.pick(e), e);
  }

  private onUp(e: PointerEvent) {
    if (!this.visible) return;
    if (this.held) {
      const p = this.held;
      this.held = null;
      document.body.style.cursor = '';
      if (this.inTray(p.pos)) this.makeReady(p);
      else {
        p.mode = 'free';
        p.grounded = false;
        if (p.vel.length() > 14) p.vel.setLength(14);
        p.spin.set(p.vel.z * 0.6, 0, -p.vel.x * 0.6);
      }
      return;
    }
    const press = this.press;
    this.press = null;
    if (!press || this.state !== 'idle') return;
    const click = Math.hypot(e.clientX - press.x, e.clientY - press.y) < CLICK_MOVE_PX && performance.now() - press.t < CLICK_MS;
    if (!click) return;
    if (press.map) this.openChart();
    else if (press.piece) {
      if (press.piece.mode === 'ready') this.unready(press.piece);
      else if (press.piece.mode === 'free') this.makeReady(press.piece);
      this.setHover(null, e);
    }
  }

  private setHover(hit: Piece | 'map' | null, e: PointerEvent) {
    this.hovered = hit;
    document.body.style.cursor = hit ? 'pointer' : '';
    if (!hit) {
      this.tip.classList.add('hidden');
      return;
    }
    const lines =
      hit === 'map'
        ? ['Sea chart · 海图', 'Three places, one per chapter', 'Click to open']
        : [`${hit.def.name} · ${hit.def.nameZh}`, hit.def.effects[0], hit.mode === 'ready' ? 'Ready · click to put it back' : 'Click to get it ready'];
    this.tip.replaceChildren(
      ...lines.map((text, i) => {
        const el = document.createElement('div');
        el.className = ['wb-tip-title', 'wb-tip-sub', 'wb-tip-hint'][i];
        el.textContent = text;
        return el;
      }),
    );
    this.tip.style.transform = `translate(${Math.min(e.clientX + 16, window.innerWidth - 240)}px, ${e.clientY + 18}px)`;
    this.tip.classList.remove('hidden');
  }

  private toast(text: string) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2000);
  }

  // ---- Chart ------------------------------------------------------------

  /**
   * Gear lying on the chart hops off first; then the chart is picked up, flattened
   * out and held up in the middle of the screen, exactly where the big chart is
   * laid out, which then takes over.
   */
  private openChart() {
    this.state = 'opening';
    this.hovered = null;
    this.tip.classList.add('hidden');
    document.body.style.cursor = '';
    const on = this.pieces.filter((p) => p.mode === 'free' && this.onMap(p));
    on.forEach((p) => this.hopOff(p));
    if (on.length) this.tween(SCATTER_S, () => {}, () => this.pickUpChart());
    else this.pickUpChart();
  }

  private pickUpChart() {
    const progress = this.hooks.progress();
    this.picked = isUnlocked(MAPS[progress.selected], progress) ? progress.selected : null;
    this.demoBox.checked = progress.unlockAll;
    drawChart(this.chartCanvas, Math.min(window.devicePixelRatio, 2) * 1.2, progress, false);
    this.renderPins();
    // Laid out but invisible, so we know where the paper will be.
    this.chartEl.classList.remove('hidden', 'closing');
    this.chartEl.classList.add('pre');
    // Measured from a steady camera: a shake now would throw the hand-off off by pixels.
    this.shake = 0;
    this.placeCamera();
    const to = this.heldPose(this.paper.getBoundingClientRect());
    this.lift(true);
    const p0 = this.map.position.clone();
    const q0 = this.map.quaternion.clone();
    this.tween(
      PICKUP_S,
      (u) => {
        const e = easeInOut(u);
        this.map.position.lerpVectors(p0, to.pos, e);
        this.map.position.y += Math.sin(u * Math.PI) * 0.6; // up off the table first
        // It stays flat while it comes up, then turns to face us.
        this.map.quaternion.slerpQuaternions(q0, to.q, easeInOut(Math.max(0, (u - 0.15) / 0.85)));
        this.setCrease(1 - easeOut(Math.min(1, u / 0.6)));
      },
      () => {
        this.chartEl.classList.remove('pre');
        this.state = 'chart';
        // The paper fades in over the 3D chart, which sits exactly behind it.
        window.setTimeout(() => this.state === 'chart' && (this.map.visible = false), 300);
      },
    );
  }

  /**
   * Where the 3D chart has to be to cover `rect` on screen: square to the camera
   * (a plane parallel to the screen projects without distortion), at the depth
   * where its width matches the rect's.
   */
  private heldPose(rect: DOMRect) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const depth = (MAP_W * h) / (2 * tanHalf * rect.width);
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dir = new THREE.Vector3((cx / w) * 2 - 1, 1 - (cy / h) * 2, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const pos = this.camera.position.clone().addScaledVector(dir, depth / dir.dot(forward));
    // The chart lies in the table plane facing up; tip it up to face the camera.
    const q = this.camera.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
    return { pos, q };
  }

  /** The big chart fades back into the 3D one, which is carried back down and set on the table. */
  private closeChart() {
    this.state = 'closing';
    this.map.visible = true;
    this.chartEl.classList.add('closing');
    window.setTimeout(() => {
      this.chartEl.classList.add('hidden');
      const p0 = this.map.position.clone();
      const q0 = this.map.quaternion.clone();
      this.tween(
        PICKUP_S * 0.85,
        (u) => {
          const e = easeInOut(u);
          this.map.position.lerpVectors(p0, MAP_AT, e);
          this.map.position.y += Math.sin(u * Math.PI) * 0.5;
          this.map.quaternion.slerpQuaternions(q0, MAP_REST, easeInOut(Math.min(1, u / 0.85)));
          this.setCrease(easeInOut(Math.max(0, (u - 0.4) / 0.6)));
        },
        () => {
          // Set down: a little puff, and the gear nearby feels it.
          this.puff(MAP_AT.x, MAP_AT.z, 1.6);
          this.shake = Math.max(this.shake, 0.04);
          this.lift(false);
          this.state = 'idle';
        },
      );
    }, 300);
  }

  private renderPins() {
    const progress = this.hooks.progress();
    this.pinsEl.replaceChildren(
      ...MAP_ORDER.map((id, i) => {
        const map = MAPS[id];
        const open = isUnlocked(map, progress);
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = `wb-pin${open ? '' : ' locked'}${id === this.picked ? ' picked' : ''}`;
        pin.dataset.map = id;
        pin.style.left = `${PLACES[id].fx * 100}%`;
        pin.style.top = `${PLACES[id].fy * 100}%`;
        const dot = document.createElement('span');
        dot.className = 'wb-pin-dot';
        dot.textContent = open ? ROMAN[i] : '🔒';
        const label = document.createElement('span');
        label.className = 'wb-pin-label';
        const name = document.createElement('b');
        name.textContent = `${map.name} · ${map.nameZh}`;
        const sub = document.createElement('small');
        sub.textContent = open ? map.difficulty : `Bank ${map.unlockValue} value`;
        label.append(name, sub);
        pin.append(dot, label);
        pin.addEventListener('click', () => this.pickPlace(id, pin));
        return pin;
      }),
    );
    this.renderPlace();
  }

  private pickPlace(id: MapId, pin: HTMLElement) {
    if (this.state !== 'chart') return;
    const map = MAPS[id];
    const progress = this.hooks.progress();
    if (!isUnlocked(map, progress)) {
      pin.classList.remove('shake');
      void pin.offsetWidth;
      pin.classList.add('shake');
      this.toast(`🔒 ${map.name}: bank ${map.unlockValue} value to open (you have ${Math.floor(progress.bestValue)})`);
      return;
    }
    // A second click on the chosen place dives.
    if (this.picked === id) return this.dive();
    this.picked = id;
    for (const el of this.pinsEl.children) el.classList.toggle('picked', (el as HTMLElement).dataset.map === id);
    this.renderPlace();
  }

  private renderPlace() {
    const id = this.picked;
    this.placeEl.classList.toggle('empty', !id);
    if (!id) {
      $('wb-place-title').textContent = 'Where to? · 去哪儿？';
      $('wb-place-sub').textContent = 'Pick a place on the chart';
      $('wb-place-text').textContent = '';
    } else {
      const map = MAPS[id];
      $('wb-place-title').textContent = `${map.name} · ${map.nameZh}`;
      $('wb-place-sub').textContent = `Chapter ${ROMAN[MAP_ORDER.indexOf(id)]} · ${map.difficulty} · 0–${mapDepth(map) - 2} m · ${map.place}`;
      $('wb-place-text').textContent = `${map.blurb} Zones: ${map.zoneLabels.join(', ')}.`;
    }
    const ready = this.packed.map((g) => UPGRADES.find((u) => u.id === g)!.name);
    $('wb-place-gear').textContent = ready.length ? `Ready: ${ready.join(', ')}` : 'No gear ready: you dive with the basics';
    ($('wb-dive') as HTMLButtonElement).disabled = !id;
  }

  /** Zoom into the chosen place, then hand over to the dive. */
  private dive() {
    const id = this.picked;
    if (!id || this.state !== 'chart') return;
    this.state = 'diving';
    this.paper.style.transformOrigin = `${PLACES[id].fx * 100}% ${PLACES[id].fy * 100}%`;
    this.paper.classList.add('zooming');
    this.chartEl.classList.add('closing');
    window.setTimeout(() => {
      this.hooks.dive(id, this.packed);
      this.hide();
      this.paper.classList.remove('zooming');
    }, 650);
  }

  /** Esc from the table: the camera pans back up to the title. */
  private leave() {
    this.state = 'leaving';
    this.tip.classList.add('hidden');
    this.tween(0.9, (u) => this.setPan(1 - easeInOut(u)), () => this.hide());
  }
}

// ---- Textures -----------------------------------------------------------------

/** Planked tabletop, planks running left to right. */
function drawPlanks(w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const c = cv.getContext('2d')!;
  const plank = h / 7;
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 7; i++) {
    const y = i * plank;
    c.fillStyle = ['#8a5f38', '#7f5532', '#93683f'][i % 3];
    c.fillRect(0, y, w, plank);
    c.strokeStyle = 'rgba(255, 220, 170, 0.08)';
    c.lineWidth = 1.5;
    for (let g = 0; g < 7; g++) {
      const gy = y + rand() * plank;
      c.beginPath();
      c.moveTo(0, gy);
      for (let x = 0; x <= w; x += 32) c.lineTo(x, gy + Math.sin(x / 70 + g * 2 + i) * 2.5);
      c.stroke();
    }
    c.fillStyle = 'rgba(40, 22, 8, 0.6)';
    c.fillRect(0, y, w, 3);
    const joint = rand() * w;
    c.fillRect(joint, y, 3, plank);
    // Nail heads at the joint.
    c.fillStyle = 'rgba(30, 20, 12, 0.7)';
    for (const ny of [y + plank * 0.25, y + plank * 0.75]) {
      c.beginPath();
      c.arc(joint + 10, ny, 3, 0, Math.PI * 2);
      c.fill();
    }
  }
  return cv;
}

/** Felt for the ready tray, with its label. */
function drawTray(w: number, d: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = Math.round((256 * d) / w);
  const c = cv.getContext('2d')!;
  c.fillStyle = '#25483c';
  c.fillRect(0, 0, cv.width, cv.height);
  c.strokeStyle = 'rgba(255, 240, 210, 0.35)';
  c.setLineDash([8, 6]);
  c.lineWidth = 3;
  c.strokeRect(8, 8, cv.width - 16, cv.height - 16);
  c.setLineDash([]);
  c.fillStyle = 'rgba(255, 240, 210, 0.8)';
  c.textAlign = 'center';
  c.font = '800 22px Inter, system-ui, sans-serif';
  // Along the front edge: the title fish hang over the back of the table.
  c.fillText('READY · 准备区', cv.width / 2, cv.height - 26);
  return cv;
}
