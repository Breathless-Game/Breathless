import * as THREE from 'three';
import { drawPlanks } from './workbench';

// A bare table that comes up the way the workbench does: the camera pans down
// from the title (whose rope and fish ride up to hang over the table) and the
// table rises into view; leaving, it sinks again. The health desk puts records on
// it, the aquarium sets its tank down on it. Same table and camera as the
// workbench and the settings desk, so all of them read as one place.

export const TABLE = { x0: -5.2, x1: 5.2, z0: -2.7, z1: 2.7 };
const CAM = new THREE.Vector3(0, 6.2, 9.5);
const LOOK = new THREE.Vector3(0, 0.85, 0);
const BASE_ASPECT = 1.6;
const RISE = 7.5;
const PAN_S = 1.15;
const LEAVE_S = 0.9;
const SHADOW_Z = 0.7; // where the title fish's shadows fall, from the table's back edge

const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);

export interface TableHooks {
  /** The camera pan between the title (0) and the table (1); tableY: screen y of the table's back. */
  pan(u: number, tableY: number): void;
}

export class TableScene {
  protected root: HTMLElement;
  protected canvas: HTMLCanvasElement;
  // Made on the first show(), not at startup: a table that is never opened holds no WebGL context.
  private gl: THREE.WebGLRenderer | null = null;
  protected get renderer(): THREE.WebGLRenderer {
    if (!this.gl) {
      this.gl = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
      this.gl.outputColorSpace = THREE.SRGBColorSpace;
      this.gl.shadowMap.enabled = true;
      this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
      this.gl.setClearColor(0x000000, 0);
    }
    return this.gl;
  }
  protected scene = new THREE.Scene();
  protected camera = new THREE.PerspectiveCamera(34, 1, 0.1, 120);
  protected ray = new THREE.Raycaster();
  protected state: 'closed' | 'opening' | 'idle' | 'leaving' = 'closed';
  protected panU = 0;
  protected time = 0;
  /** A short jolt (table units), easing away: something heavy landed. */
  protected shake = 0;
  /** Where the camera stands and looks once the table is up (a table can move it, e.g. lower to face a tank). */
  protected camAt = CAM.clone();
  protected lookAt = LOOK.clone();
  private tween: { from: number; to: number; t: number; dur: number; done?: () => void } | null = null;
  private raf = 0;
  private last = 0;

  constructor(
    id: string,
    protected hooks: TableHooks,
  ) {
    this.root = document.createElement('div');
    this.root.id = id;
    this.root.className = 'table-scene hidden';
    this.canvas = document.createElement('canvas');
    this.root.append(this.canvas);
    document.body.append(this.root);
    this.buildRoom();
    window.addEventListener('resize', () => this.visible && this.resize());
  }

  get visible() {
    return this.state !== 'closed';
  }

  /** Settled on the table, nothing moving in or out. */
  get atRest() {
    return this.state === 'idle';
  }

  /** Pans down from the title; the table rises. `arrived` once it's in place. */
  show(arrived?: () => void) {
    this.root.classList.remove('hidden');
    this.resize();
    this.time = 0;
    this.state = 'opening';
    this.panU = 0;
    this.tween = {
      from: 0,
      to: 1,
      t: 0,
      dur: PAN_S,
      done: () => {
        this.state = 'idle';
        arrived?.();
      },
    };
    this.onShow();
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
    this.onHide();
  }

  /** The table sinks away as the camera pans back up; then `done`. */
  leave(done?: () => void) {
    if (this.state === 'closed' || this.state === 'leaving') return;
    this.state = 'leaving';
    this.onLeave?.();
    document.body.style.cursor = '';
    this.tween = {
      from: this.panU,
      to: 0,
      t: 0,
      dur: LEAVE_S,
      done: () => {
        this.panU = 0;
        this.placeCamera();
        this.hide();
        done?.();
      },
    };
  }

  // ---- For the tables built on this ----------------------------------------

  protected onShow() {}
  protected onHide() {}
  /** Every frame, before the scene is drawn. */
  protected onFrame(_dt: number) {}

  /** Our pointer events land on a bare canvas (the title's, over ours), not one a title fish took. */
  protected ours(e: PointerEvent) {
    return this.state === 'idle' && e.target instanceof HTMLCanvasElement && !e.defaultPrevented;
  }

  protected setRay(e: PointerEvent) {
    this.ray.setFromCamera(new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, 1 - (e.clientY / window.innerHeight) * 2), this.camera);
  }

  /** Called as it starts to sink away (main.ts: bring back the table it was opened over). */
  onLeave?: () => void;

  /** Something heavy landed: the table jolts (the camera shakes, easing off). */
  jolt(amount: number) {
    this.shake = Math.max(this.shake, amount);
  }

  /** Screen y of the table top, front middle, once it's up: where something set down rests. */
  surfaceY() {
    return this.screenAt(new THREE.Vector3(0, 0, 0.9)).y;
  }

  /** Where a point on the table is on screen, with the camera all the way down (the settled view). */
  screenAt(p: THREE.Vector3): { x: number; y: number } {
    const pan = this.panU;
    this.panU = 1;
    this.placeCamera(false);
    const v = p.clone().project(this.camera);
    this.panU = pan;
    this.placeCamera(false);
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
  }

  // ---- Scene ----------------------------------------------------------------

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

  private resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  protected placeCamera(report = true) {
    const fit = Math.max(1, BASE_ASPECT / this.camera.aspect);
    const lift = (1 - this.panU) * RISE;
    const jx = (Math.random() - 0.5) * this.shake;
    const jy = (Math.random() - 0.5) * this.shake;
    const cam = this.camAt;
    const look = this.lookAt;
    this.camera.position.set(cam.x * fit + jx, cam.y * fit + lift + jy, look.z + (cam.z - look.z) * fit);
    this.camera.lookAt(look.x + jx * 0.5, look.y + lift + jy * 0.5, look.z);
    this.camera.updateMatrixWorld();
    if (!report) return;
    const back = new THREE.Vector3(0, 0, TABLE.z0 + SHADOW_Z).project(this.camera);
    this.hooks.pan(this.panU, ((1 - back.y) / 2) * window.innerHeight);
  }

  private frame(dt: number) {
    this.time += dt;
    const tw = this.tween;
    if (tw) {
      tw.t = Math.min(tw.dur, tw.t + dt);
      this.panU = tw.from + (tw.to - tw.from) * easeInOut(tw.t / tw.dur);
      if (tw.t >= tw.dur) {
        this.tween = null;
        tw.done?.();
        if (this.state === 'closed') return;
      }
    }
    this.shake = Math.max(0, this.shake - dt * 0.9);
    this.onFrame(dt);
    this.placeCamera();
    this.renderer.render(this.scene, this.camera);
  }
}
