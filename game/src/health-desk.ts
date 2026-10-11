import * as THREE from 'three';
import { onLangChange, t } from './i18n';
import { SoftPaper } from './paper';
import { wellnessDisclaimer } from './report';
import { TableScene, type TableHooks } from './table-scene';
import { drawTripSheet, GRADE_COLOR, loadTrips, mapNames, secs, tripDate, type TripRecord } from './trip';

// The health desk, from the title's HEALTH fish: a table comes up with the latest
// trip report laid out on it as a sheet of paper, and a bamboo jar of fortune
// sticks in the far right corner, one stick per earlier trip. Hovering a stick
// lifts it and shows that trip; clicking it lays that trip out on the paper.
// The report is the same soft paper as the workbench's sea chart (paper.ts): it
// wrinkles under the pointer, and clicking it picks it up, carried to the middle
// of the screen over the blurred table, leaning toward the pointer; a click
// anywhere (or Esc) puts it down again.

const PAPER = { w: 5.9, d: 4.15, x: -1.1, z: 0.45, yaw: 0.04 };
const REST_POS = new THREE.Vector3(PAPER.x, 0.005, PAPER.z);
const REST_Q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -PAPER.yaw);
const PICKUP_S = 0.7;
const HELD_CURL = 0.45; // held up, the ends curl a little: it's paper (on the table they lie flat)
const HELD_FILL = 0.76; // of the screen's width (or height), whichever is tighter, the held sheet fills
const TILT = { x: 0.14, y: 0.2 }; // how far the held sheet leans toward the pointer, radians edge to edge
const TEX_W = 1400;
const TEX_H = Math.round((TEX_W * PAPER.d) / PAPER.w);
const JAR = { x: 3.95, z: -0.35, r: 0.5, h: 1.15 };
const STICKS = 14; // the jar holds this many earlier trips
const SCROLL_L = 1.5; // a rolled report, end to end
const SCROLL_R = 0.085;
const SWAP_S = 1.6; // rolled up, crossed over, unrolled


interface Stick {
  mesh: THREE.Group;
  record: TripRecord;
  base: THREE.Vector3;
  lift: number;
}

const clamp01 = (u: number) => Math.min(1, Math.max(0, u));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

const SCROLL_PAPER = new THREE.MeshStandardMaterial({ color: '#efe3c4', roughness: 0.9 });
const SCROLL_END = new THREE.MeshStandardMaterial({ color: '#d8c9a4', roughness: 0.9 });

/**
 * A rolled-up report, its pivot in the middle and its length along y: the paper
 * roll, its spiralled ends a shade darker, and a ribbon tied round it in the
 * trip's grade colour.
 */
function scrollMesh(grade: string): THREE.Group {
  const g = new THREE.Group();
  const roll = new THREE.Mesh(new THREE.CylinderGeometry(SCROLL_R, SCROLL_R, 1, 16, 1, true), SCROLL_PAPER);
  const ends = [0.5, -0.5].map((y) => {
    const end = new THREE.Mesh(new THREE.CircleGeometry(SCROLL_R, 16), SCROLL_END);
    end.rotation.x = y > 0 ? -Math.PI / 2 : Math.PI / 2;
    end.position.y = y;
    return end;
  });
  const length = new THREE.Group(); // scaled for the scroll's length; the ribbon stays its size
  length.add(roll, ...ends);
  const ribbon = new THREE.Mesh(new THREE.CylinderGeometry(SCROLL_R * 1.08, SCROLL_R * 1.08, 0.13, 16), new THREE.MeshStandardMaterial({ color: GRADE_COLOR[grade] ?? '#888', roughness: 0.6 }));
  roll.castShadow = ribbon.castShadow = true;
  g.add(length, ribbon);
  g.userData.length = length;
  g.userData.scroll = true;
  setScrollLength(g, SCROLL_L);
  return g;
}

function setScrollLength(g: THREE.Object3D, l: number) {
  (g.userData.length as THREE.Group).scale.y = l;
}

function disposeScroll(g: THREE.Object3D) {
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      if (o.material !== SCROLL_PAPER && o.material !== SCROLL_END) (o.material as THREE.Material).dispose();
    }
  });
}

const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
const easeOut = (u: number) => 1 - (1 - u) ** 3;

export class HealthDesk extends TableScene {
  private paperTex: THREE.CanvasTexture;
  private sheet: SoftPaper;
  private paper = new THREE.Group(); // the sheet's pose: on the table, carried, or held up
  private paperState: 'table' | 'lifting' | 'held' | 'dropping' | 'swapping' = 'table';
  private paperTween: { t: number; dur: number; fn: (u: number) => void; done: () => void } | null = null;
  // Held up, the sheet is drawn on its own layer over the blurred table (like the workbench's chart).
  private heldEl: HTMLElement;
  // Made on the first pick-up (heldGl()), not at startup: one WebGL context fewer until a report is held.
  private heldRenderer: THREE.WebGLRenderer | null = null;
  private heldCanvas: HTMLCanvasElement;
  private heldScene = new THREE.Scene();
  private heldQ = new THREE.Quaternion();
  private tilt = { x: 0, y: 0 };
  private pointer = { x: 0.5, y: 0.5 };
  private stirFrom: { x: number; z: number; t: number } | null = null;
  private sticks: Stick[] = [];
  private jar = new THREE.Group();
  private hovered: Stick | null = null;
  private tip: HTMLElement;
  private hint: HTMLElement;
  private shown: TripRecord | null = null;

  constructor(hooks: TableHooks) {
    super('health-desk', hooks);
    const paperCanvas = document.createElement('canvas');
    paperCanvas.width = TEX_W;
    paperCanvas.height = TEX_H;
    this.paperTex = new THREE.CanvasTexture(paperCanvas);
    this.paperTex.colorSpace = THREE.SRGBColorSpace;
    this.paperTex.anisotropy = 8;
    // Soft paper, lying flat (no fold: a report, not a folded chart).
    this.sheet = new SoftPaper(PAPER.w, PAPER.d, new THREE.MeshStandardMaterial({ map: this.paperTex, roughness: 0.95, side: THREE.DoubleSide }));
    this.sheet.fold = 0;
    this.sheet.curl = 0;
    this.sheet.reset();
    this.sheet.mesh.castShadow = this.sheet.mesh.receiveShadow = true;
    this.paper.add(this.sheet.mesh);
    this.paper.position.copy(REST_POS);
    this.paper.quaternion.copy(REST_Q);
    this.scene.add(this.paper);
    this.buildJar();

    this.heldEl = document.createElement('div');
    this.heldEl.id = 'hd-held';
    this.heldEl.className = 'hidden';
    const heldBg = document.createElement('div');
    heldBg.className = 'hd-held-bg';
    const heldCanvas = document.createElement('canvas');
    const heldHint = document.createElement('div');
    heldHint.className = 'table-hint small';
    const heldText = () => (heldHint.textContent = t('Click anywhere or press Esc to put it down', '点击任意处或按 Esc 放下'));
    heldText();
    onLangChange(heldText);
    this.heldEl.append(heldBg, heldCanvas, heldHint);
    document.body.append(this.heldEl);
    this.heldCanvas = heldCanvas;
    this.heldScene.add(new THREE.HemisphereLight('#e6f6ff', '#4a3420', 1.35));
    const key = new THREE.DirectionalLight('#fff1dc', 2.2);
    key.position.set(-4, 10, 5);
    this.heldScene.add(key);
    this.heldEl.addEventListener('click', () => this.paperState === 'held' && this.putDown());

    this.tip = document.createElement('div');
    this.tip.id = 'health-tip';
    this.tip.className = 'hidden';
    this.hint = document.createElement('div');
    this.hint.className = 'table-hint small';
    const hintText = () => (this.hint.textContent = t('Click the report to pick it up, hover a rolled report in the jar and click to swap it in, Esc back', '点击报告拿起，悬停筒里的卷轴查看、点击换出，Esc 返回'));
    hintText();
    onLangChange(hintText);
    this.root.append(this.hint);
    document.body.append(this.tip); // over the title layer: the card mustn't hide behind a hanging fish

    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
  }

  /** Esc: put the held report down; from the bare table, back up to the title. */
  escape() {
    if (this.paperState === 'held') this.putDown();
    else if (this.paperState === 'table') this.leave();
  }

  /** Settled, and the report lying on the table (not held up or on its way). */
  get atRest() {
    return super.atRest && this.paperState === 'table';
  }

  /** The held-up sheet's renderer, made the first time a report is picked up and kept after. */
  private heldGl(): THREE.WebGLRenderer {
    if (!this.heldRenderer) {
      this.heldRenderer = new THREE.WebGLRenderer({ canvas: this.heldCanvas, antialias: true, alpha: true });
      this.heldRenderer.outputColorSpace = THREE.SRGBColorSpace;
      this.heldRenderer.setClearColor(0x000000, 0);
    }
    return this.heldRenderer;
  }

  /** The saved trips were deleted: if the desk is up, the old report and the jar's scrolls go too. */
  forget() {
    if (!this.visible) return; // onShow() reads the trips afresh
    if (this.paperState === 'held') this.putDown();
    this.hovered = null;
    this.tip.classList.add('hidden');
    this.layOut(null);
    this.fillJar([]);
  }

  protected onShow() {
    const trips = loadTrips();
    this.layOut(trips[0] ?? null);
    this.fillJar(trips.slice(1, 1 + STICKS));
  }

  protected onHide() {
    this.hovered = null;
    this.tip.classList.add('hidden');
    // Gone mid-pickup or mid-swap: the report goes straight back onto the table.
    this.paperTween = null;
    this.paperState = 'table';
    for (const o of this.scene.children.filter((c) => c.userData.scroll)) {
      this.scene.remove(o);
      disposeScroll(o);
    }
    this.paper.scale.z = 1;
    this.paper.visible = true;
    this.scene.add(this.paper);
    this.paper.position.copy(REST_POS);
    this.paper.quaternion.copy(REST_Q);
    this.sheet.curl = 0;
    this.sheet.onTable = true;
    this.sheet.reset();
    this.heldEl.classList.add('hidden');
    this.heldEl.classList.remove('open');
  }

  protected onFrame(dt: number) {
    const k = 1 - Math.exp(-dt * 10);
    for (const s of this.sticks) {
      s.lift += ((s === this.hovered ? 1 : 0) - s.lift) * k;
      s.mesh.position.set(s.base.x, s.base.y + s.lift * 0.45, s.base.z);
    }
    const tw = this.paperTween;
    if (tw) {
      tw.t = Math.min(tw.dur, tw.t + dt);
      tw.fn(tw.t / tw.dur);
      if (tw.t >= tw.dur) {
        this.paperTween = null;
        tw.done();
      }
    }
    if (this.paperState === 'held') {
      // Held up, it leans a little toward the pointer.
      const e = 1 - Math.exp(-dt * 4);
      this.tilt.x += ((this.pointer.y - 0.5) * TILT.x - this.tilt.x) * e;
      this.tilt.y += ((this.pointer.x - 0.5) * TILT.y - this.tilt.y) * e;
      const lean = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.tilt.x, this.tilt.y, 0));
      const cam = this.camera.quaternion;
      this.paper.quaternion.copy(cam).multiply(lean).multiply(cam.clone().invert().multiply(this.heldQ));
    }
    this.sheet.update(dt);
    if (!this.heldEl.classList.contains('hidden')) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const gl = this.heldGl();
      const size = gl.getSize(new THREE.Vector2());
      if (size.x !== w || size.y !== h) {
        gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        gl.setSize(w, h, false);
      }
      this.camera.updateMatrixWorld();
      gl.render(this.heldScene, this.camera);
    }
  }

  // ---- Picking the report up ---------------------------------------------

  /**
   * Picked up: lifted off the table, its ends curling a little, and carried to the
   * middle of the screen square to the camera, onto the held layer over the blurred
   * table (like the workbench's sea chart).
   */
  private pickUp() {
    if (this.paperState !== 'table' || this.state !== 'idle') return;
    this.paperState = 'lifting';
    this.hovered = null;
    this.tip.classList.add('hidden');
    document.body.style.cursor = '';
    const to = this.heldPose();
    this.heldQ.copy(to.q);
    this.tilt = { x: 0, y: 0 };
    this.heldScene.add(this.paper); // over the blurred table from here on
    this.heldEl.classList.remove('hidden');
    void this.heldEl.offsetWidth; // let the backdrop fade in from nothing
    this.heldEl.classList.add('open');
    this.sheet.onTable = false;
    const p0 = this.paper.position.clone();
    const q0 = this.paper.quaternion.clone();
    this.paperTween = {
      t: 0,
      dur: PICKUP_S,
      fn: (u) => {
        const e = easeInOut(u);
        this.paper.position.lerpVectors(p0, to.pos, e);
        this.paper.position.y += Math.sin(u * Math.PI) * 0.6; // up off the table first
        // It stays flat while it comes up, then turns to face us.
        this.paper.quaternion.slerpQuaternions(q0, to.q, easeInOut(Math.max(0, (u - 0.15) / 0.85)));
        this.sheet.curl = HELD_CURL * easeOut(u);
      },
      done: () => (this.paperState = 'held'),
    };
  }

  /** Put down again: carried back and set on the table, where the air under it lifts the edges. */
  private putDown() {
    if (this.paperState !== 'held') return;
    this.paperState = 'dropping';
    this.heldEl.classList.remove('open');
    const p0 = this.paper.position.clone();
    const q0 = this.paper.quaternion.clone();
    this.paperTween = {
      t: 0,
      dur: PICKUP_S * 0.85,
      fn: (u) => {
        const e = easeInOut(u);
        this.paper.position.lerpVectors(p0, REST_POS, e);
        this.paper.position.y += Math.sin(u * Math.PI) * 0.5;
        this.paper.quaternion.slerpQuaternions(q0, REST_Q, easeInOut(Math.min(1, u / 0.85)));
        this.sheet.curl = HELD_CURL * (1 - e);
      },
      done: () => {
        this.scene.add(this.paper); // back on the table, in its light and shadows
        this.heldEl.classList.add('hidden');
        this.sheet.onTable = true;
        this.sheet.knock(0, 0, 1.2, 2.5);
        this.jolt(0.04);
        this.paperState = 'table';
      },
    };
  }

  /**
   * Where the sheet has to be to fill most of the screen: square to the camera (a
   * plane parallel to the screen projects without distortion), centred, at the
   * depth where its width is HELD_FILL of the screen's (or its height of the height's).
   */
  private heldPose() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const width = Math.min(w * HELD_FILL, h * HELD_FILL * (PAPER.w / PAPER.d));
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const depth = (PAPER.w * h) / (2 * tanHalf * width);
    this.camera.updateMatrixWorld();
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const pos = this.camera.position.clone().addScaledVector(forward, depth);
    // The sheet lies in the table plane facing up; tip it up to face the camera.
    const q = this.camera.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
    return { pos, q };
  }

  // ---- The jar ----------------------------------------------------------------

  private buildJar() {
    const bamboo = new THREE.MeshStandardMaterial({ color: '#c79a52', roughness: 0.75 });
    const band = new THREE.MeshStandardMaterial({ color: '#7a4e22', roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(JAR.r, JAR.r * 0.92, JAR.h, 18, 1, true), bamboo);
    body.position.y = JAR.h / 2;
    body.castShadow = true;
    const inside = new THREE.Mesh(new THREE.CylinderGeometry(JAR.r * 0.94, JAR.r * 0.88, JAR.h * 0.98, 18, 1, true), new THREE.MeshStandardMaterial({ color: '#5c3b17', side: THREE.BackSide }));
    inside.position.y = JAR.h / 2;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(JAR.r * 0.9, 18), band);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.06;
    this.jar.add(body, inside, floor);
    for (const y of [0.16, JAR.h * 0.55, JAR.h - 0.06]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(JAR.r * 1.005, 0.035, 6, 24), band);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      this.jar.add(ring);
    }
    this.jar.position.set(JAR.x, 0, JAR.z);
    this.scene.add(this.jar);
  }

  /** One rolled-up report per earlier trip, standing in the jar at its own lean, tied with its grade's colour. */
  private fillJar(trips: TripRecord[]) {
    for (const s of this.sticks) {
      this.jar.remove(s.mesh);
      disposeScroll(s.mesh);
    }
    this.sticks = trips.map((record, i) => {
      const n = trips.length;
      const a = (i / Math.max(1, n)) * Math.PI * 2 + 0.4;
      const rr = n > 1 ? JAR.r * 0.5 * (0.6 + 0.4 * ((i * 7) % 3) / 2) : 0;
      const mesh = scrollMesh(record.grade);
      mesh.rotation.set(Math.sin(a) * 0.16, a, -Math.cos(a) * 0.16);
      // The scroll's pivot is its middle: stand its foot on the jar's floor.
      const foot = new THREE.Vector3(Math.cos(a) * rr, 0.08 + ((i * 5) % 4) * 0.05, Math.sin(a) * rr);
      const base = foot.add(new THREE.Vector3(0, SCROLL_L / 2, 0).applyEuler(mesh.rotation));
      mesh.position.copy(base);
      mesh.userData.stick = i;
      this.jar.add(mesh);
      return { mesh, record, base, lift: 0 };
    });
  }

  /**
   * A rolled report taken from the jar: the sheet on the table rolls up and flies
   * into the jar while the picked one flies out onto the table and unrolls there.
   */
  private swapTo(s: Stick) {
    this.paperState = 'swapping';
    this.hovered = null;
    this.tip.classList.add('hidden');
    document.body.style.cursor = '';
    const outgoing = this.shown;
    const incoming = s.record;
    const rest = this.sticks.filter((x) => x !== s).map((x) => x.record);
    // The picked scroll leaves the jar (keeping where it is in the world).
    this.scene.attach(s.mesh);
    this.sticks = this.sticks.filter((x) => x !== s);
    const inFrom = s.mesh.position.clone();
    const inQ0 = s.mesh.quaternion.clone();
    // The table's sheet rolls up into a scroll as long as it is wide.
    const long = PAPER.w * 0.92;
    const out = outgoing ? scrollMesh(outgoing.grade) : null;
    const onTable = REST_POS.clone().add(new THREE.Vector3(0, 0.1, 0));
    const lying = REST_Q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2));
    const jarTop = new THREE.Vector3(JAR.x, JAR.h + SCROLL_L * 0.55, JAR.z);
    const upright = new THREE.Quaternion();
    if (out) {
      out.position.copy(onTable);
      out.quaternion.copy(lying);
      setScrollLength(out, long);
      out.scale.setScalar(0.001);
      this.scene.add(out);
    }
    const arc = (a: THREE.Vector3, b: THREE.Vector3, u: number, into: THREE.Vector3) => into.lerpVectors(a, b, u).setY(lerp(a.y, b.y, u) + Math.sin(u * Math.PI) * 1.4);
    let laidOut = false;
    this.paperTween = {
      t: 0,
      dur: SWAP_S,
      fn: (u) => {
        // 1) The sheet rolls up into a scroll on the table; the picked one rises out of the jar.
        const roll = easeInOut(clamp01(u / 0.3));
        this.paper.scale.z = 1 - roll * 0.97;
        this.paper.visible = u < 0.33 || u > 0.68;
        if (out) out.scale.set(1, roll > 0.15 ? 1 : 0.001, 1);
        s.mesh.position.copy(inFrom).setY(inFrom.y + easeOut(clamp01(u / 0.3)) * 1.2);
        // 2) They cross: the rolled sheet to the jar (standing up, shortening), the picked one to the table.
        const fly = easeInOut(clamp01((u - 0.3) / 0.38));
        if (fly > 0) {
          if (out) {
            arc(onTable, jarTop, fly, out.position);
            out.quaternion.slerpQuaternions(lying, upright, fly);
            setScrollLength(out, lerp(long, SCROLL_L, fly));
          }
          const from = inFrom.clone().setY(inFrom.y + 1.2);
          arc(from, onTable, fly, s.mesh.position);
          s.mesh.quaternion.slerpQuaternions(inQ0, lying, fly);
          setScrollLength(s.mesh, lerp(SCROLL_L, long, fly));
        }
        // 3) The rolled sheet drops into the jar; the picked one unrolls into the sheet on the table.
        const open = easeOut(clamp01((u - 0.68) / 0.32));
        if (open > 0) {
          if (!laidOut) {
            laidOut = true;
            this.layOut(incoming);
          }
          if (out) out.position.y = jarTop.y - open * SCROLL_L * 0.6;
          this.paper.scale.z = 0.03 + open * 0.97;
          s.mesh.scale.set(1 - open, 1, 1 - open);
        }
      },
      done: () => {
        this.scene.remove(s.mesh);
        disposeScroll(s.mesh);
        if (out) {
          this.scene.remove(out);
          disposeScroll(out);
        }
        this.paper.scale.z = 1;
        this.paper.visible = true;
        const all = (outgoing ? [outgoing, ...rest] : rest).sort((a, b) => b.at - a.at);
        this.fillJar(all.slice(0, STICKS));
        this.sheet.knock(0, 0, 1.0, 2.5); // unrolled flat, its edges still lift and settle
        this.jolt(0.03);
        this.paperState = 'table';
      },
    };
  }

  // ---- The paper --------------------------------------------------------------

  private layOut(r: TripRecord | null) {
    this.shown = r;
    drawTripSheet((this.paperTex.image as HTMLCanvasElement).getContext('2d')!, r, TEX_W, TEX_H);
    this.paperTex.needsUpdate = true;
  }

  // ---- Pointer ----------------------------------------------------------------

  private stickAt(e: PointerEvent): Stick | null {
    if (this.paperState !== 'table' || !this.ours(e) || !this.sticks.length) return null;
    this.setRay(e);
    const hit = this.ray.intersectObjects(this.sticks.map((s) => s.mesh), true)[0];
    if (!hit) return null;
    let o: THREE.Object3D | null = hit.object;
    while (o && o.userData.stick == null) o = o.parent;
    return o ? this.sticks[o.userData.stick as number] : null;
  }

  /** Where the pointer is on the report (its local x / z), on the table or held up; null if off it. */
  private paperAt(e: PointerEvent): THREE.Vector3 | null {
    const onTable = this.paperState === 'table' && this.ours(e);
    if (!onTable && this.paperState !== 'held') return null;
    this.setRay(e);
    const hit = this.ray.intersectObject(this.sheet.mesh, false)[0];
    return hit ? this.sheet.mesh.worldToLocal(hit.point.clone()) : null;
  }

  private onMove(e: PointerEvent) {
    if (!this.visible) return;
    this.pointer = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight };
    // Moving over the paper wrinkles it there (paper.ts), not as a whole.
    const at = this.paperAt(e);
    const now = performance.now();
    const last = this.stirFrom;
    if (at && last && now - last.t < 100) {
      const dt = Math.max(1, now - last.t) / 1000;
      this.sheet.stir(at.x, at.z, (at.x - last.x) / dt, (at.z - last.z) / dt);
    }
    this.stirFrom = at ? { x: at.x, z: at.z, t: now } : null;
    const s = this.stickAt(e);
    if (s !== this.hovered) this.hovered = s;
    document.body.style.cursor = s || (at && this.paperState === 'table') ? 'pointer' : '';
    if (!s) {
      this.tip.classList.add('hidden');
      return;
    }
    const r = s.record;
    this.tip.innerHTML = `
      <div class="small muted">${tripDate(r)} · ${mapNames(r)}</div>
      <div class="health-tip-score"><span class="trip-grade grade-${r.grade}">${r.grade}</span><b>${r.score.total}</b> ${t('pts', '分')}</div>
      <div class="trip-line"><span>${t('Fish', '渔获')}</span><b>${r.caught.length}</b></div>
      <div class="trip-line"><span>${t('Deepest', '最深')}</span><b>${Math.round(r.deepest)} m</b></div>
      <div class="trip-line"><span>${t('Longest hold', '最长屏息')}</span><b>${secs(r.longestHoldMs)}</b></div>
      <div class="trip-line"><span>${t('Heart rate', '心率')}</span><b>${r.heart ? `${Math.round(r.heart.avg)} bpm` : '—'}</b></div>
      <div class="small muted">${t('Click to lay it out', '点击展开')}</div>
      <div class="health-tip-disclaimer">${wellnessDisclaimer()}</div>`;
    this.tip.style.transform = `translate(${Math.min(e.clientX + 18, window.innerWidth - 280)}px, ${Math.max(16, e.clientY - 200)}px)`;
    this.tip.classList.remove('hidden');
  }

  private onUp(e: PointerEvent) {
    const s = this.stickAt(e);
    if (!s) {
      // A click on the report picks it up.
      if (this.paperState === 'table' && this.paperAt(e)) this.pickUp();
      return;
    }
    // The sheet on the table rolls up into the jar; the picked trip comes out and unrolls.
    if (s.record !== this.shown) this.swapTo(s);
  }
}
