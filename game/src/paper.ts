import * as THREE from 'three';

// The sea chart as a soft sheet of paper, simulated as a height field: every
// grid point moves up and down off the page under
//   - memory: a spring back to the paper's rest shape (its ends curl up, it
//     keeps a fold crease), so the curl is physical, not drawn on;
//   - stiffness: a smoothing term, so a kink spreads and relaxes like paper;
//   - the table: on it the sheet can't go below the tabletop, and gear lying on
//     it presses that patch flat (the curl nearby gives way with it);
//   - knocks: a thud nearby lifts the edges, which flap and settle;
//   - the pointer: moving over the sheet pushes small wrinkles into it right
//     around the pointer, across the way it moves; they smooth out once it stops.
// On top of that, the sheet as a whole sags with inertia when it is carried
// (two heavily damped bending modes: it bends and comes back, no wobble).
// Local frame: x across the page, z down it, y off its face.

const SEG_X = 48;
const SEG_Z = 32;
const CURL = 0.17; // how far the ends curl up at rest, at curl 1
const CURL_FROM = 0.6; // |u| where the curl starts (u: -1 left edge .. 1 right edge)
const CREASE = 0.07; // how far the fold stands up, at fold 1
const STEP = 1 / 120;
const MEMORY = 110; // spring back to the rest shape (strong enough to hold the curl against STIFFNESS)
const STIFFNESS = 700; // smoothing between neighbours (keeps STEP² · 8 · this < 2)
const FRICTION = 3; // damping of the height field as a whole
// Damping between neighbours: kills fine shimmer (it grows with how sharp the motion is)
// but leaves broad motion, like an edge flapping, its bounce. Keeps STEP · 8 · this < 2.
const VISCOSITY = 15;
const WRINKLE_R = 0.28; // how far around the pointer it wrinkles
const WRINKLE_WAVE = 0.2; // wrinkle spacing
const WRINKLE_PUSH = 1.6; // how hard a moving pointer wrinkles it
const MAX_STIR = 6; // pointer speed cap, sheet units/s
// Whole-sheet bending while carried: overdamped, so it sags and recovers without jiggling.
const BEND_STIFF = 140;
const BEND_DAMP = 30;
const INERTIA = 0.6;
const MAX_BEND = 0.3;
const MAX_ACCEL = 120;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface Press {
  x: number;
  z: number;
  r: number;
}

export class SoftPaper {
  readonly mesh: THREE.Mesh;
  /** 1 = folded (crease standing up), 0 = flat. Changes the rest shape; the sheet follows. */
  fold = 1;
  /** 1 = ends curled as at rest, 0 = flat. */
  curl = 1;
  /** Lying on the table: it can't sink below it. */
  onTable = true;

  private nx = SEG_X + 1;
  private nz = SEG_Z + 1;
  private px: Float32Array; // flat x of each grid point
  private pz: Float32Array;
  private h: Float32Array; // height off the page
  private v: Float32Array;
  private v0: Float32Array; // velocities at the start of the step
  private rest: Float32Array;
  private presses: Press[] = [];
  private stirAt = { x: 0, z: 0, dx: 0, dz: 0, speed: 0 };
  private acc = 0;

  private bendU = 0;
  private bendV = 0;
  private velU = 0;
  private velV = 0;
  private lastPos = new THREE.Vector3();
  private lastVel = new THREE.Vector3();
  private primed = 0;
  private tmp = new THREE.Vector3();
  private q = new THREE.Quaternion();

  constructor(
    private w: number,
    private d: number,
    material: THREE.Material,
  ) {
    const geo = new THREE.PlaneGeometry(w, d, SEG_X, SEG_Z);
    geo.rotateX(-Math.PI / 2); // rows run from z = -d/2 down to +d/2, left to right
    const n = this.nx * this.nz;
    const pos = geo.attributes.position;
    this.px = new Float32Array(n);
    this.pz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.px[i] = pos.getX(i);
      this.pz[i] = pos.getZ(i);
    }
    this.h = new Float32Array(n);
    this.v = new Float32Array(n);
    this.v0 = new Float32Array(n);
    this.rest = new Float32Array(n);
    this.mesh = new THREE.Mesh(geo, material);
    this.reset();
  }

  /** Settles the sheet into its rest shape and forgets its motion (after a jump). */
  reset() {
    this.computeRest();
    this.h.set(this.rest);
    this.v.fill(0);
    this.primed = 0;
    this.bendU = this.bendV = this.velU = this.velV = 0;
  }

  /** Gear lying on the sheet this frame, in its local x/z: those patches are held flat. */
  press(presses: Press[]) {
    this.presses = presses;
  }

  /** A knock at (x, z): the paper around it jumps, more nearby. */
  knock(x: number, z: number, strength: number, radius = 0.9) {
    for (let i = 0; i < this.h.length; i++) {
      const dist = Math.hypot(this.px[i] - x, this.pz[i] - z);
      this.v[i] += strength * Math.exp(-((dist / radius) ** 2));
    }
  }

  /** The pointer is over the sheet at (x, z), moving (vx, vz) in sheet units/s. */
  stir(x: number, z: number, vx: number, vz: number) {
    const speed = Math.min(Math.hypot(vx, vz), MAX_STIR);
    if (speed < 1e-3) return;
    this.stirAt = { x, z, dx: vx / Math.hypot(vx, vz), dz: vz / Math.hypot(vx, vz), speed };
  }

  /** Where a point of the page (fractions across and down, 0..1) is now, in world space. */
  pointAt(fx: number, fy: number, out: THREE.Vector3) {
    this.shape((fx - 0.5) * this.w, (fy - 0.5) * this.d, this.heightAt(fx, fy), out);
    return this.mesh.localToWorld(out);
  }

  /** Steps the sheet and reshapes the mesh. Call once a frame, after placing it. */
  update(dt: number) {
    this.drive(dt);
    this.acc = Math.min(this.acc + dt, STEP * 6);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this.simulate(STEP);
    }
    const pos = this.mesh.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < this.h.length; i++) {
      this.shape(this.px[i], this.pz[i], this.h[i], this.tmp);
      pos.setXYZ(i, this.tmp.x, this.tmp.y, this.tmp.z);
    }
    pos.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();
    this.mesh.geometry.computeBoundingBox();
  }

  // ---- Height field -------------------------------------------------------

  /** The shape the paper wants to be in: ends curled up (corners a touch more), plus the fold. */
  private computeRest() {
    for (let i = 0; i < this.rest.length; i++) {
      const u = this.px[i] / (this.w / 2);
      const v = this.pz[i] / (this.d / 2);
      const roll = smoothstep(CURL_FROM, 1, Math.abs(u));
      this.rest[i] =
        CURL * this.curl * roll * roll * (1 + 0.35 * smoothstep(0.4, 1, Math.abs(v))) + CREASE * this.fold * Math.max(0, 1 - Math.abs(u));
    }
  }

  private simulate(dt: number) {
    this.computeRest();
    const { nx, nz, h, v, rest } = this;
    const v0 = this.v0;
    v0.set(v);
    const s = this.stirAt;
    const k = (2 * Math.PI) / WRINKLE_WAVE;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const n = j * nx + i;
        // Neighbours, mirrored at the edges (a free edge).
        const nl = n + (i > 0 ? -1 : 1);
        const nr = n + (i < nx - 1 ? 1 : -1);
        const nu = n + (j > 0 ? -nx : nx);
        const nd = n + (j < nz - 1 ? nx : -nx);
        const lapH = h[nl] + h[nr] + h[nu] + h[nd] - 4 * h[n];
        const lapV = v0[nl] + v0[nr] + v0[nu] + v0[nd] - 4 * v0[n];
        let a = MEMORY * (rest[n] - h[n]) + STIFFNESS * lapH + VISCOSITY * lapV - FRICTION * v0[n];
        if (s.speed) {
          // Ridges across the way the pointer moves, only close to it.
          const ox = this.px[n] - s.x;
          const oz = this.pz[n] - s.z;
          const fall = Math.exp(-((ox * ox + oz * oz) / (WRINKLE_R * WRINKLE_R)));
          if (fall > 0.01) a += WRINKLE_PUSH * 60 * s.speed * fall * Math.sin(k * (ox * s.dx + oz * s.dz));
        }
        v[n] += a * dt;
      }
    }
    // The pointer only wrinkles while it moves.
    s.speed *= Math.exp(-dt * 14);
    if (s.speed < 0.02) s.speed = 0;

    for (let n = 0; n < h.length; n++) h[n] += v[n] * dt;
    if (this.onTable) {
      for (let n = 0; n < h.length; n++)
        if (h[n] < 0) {
          h[n] = 0;
          if (v[n] < 0) v[n] = 0;
        }
      // Gear lying on it holds its patch down.
      for (const p of this.presses)
        for (let n = 0; n < h.length; n++)
          if (Math.hypot(this.px[n] - p.x, this.pz[n] - p.z) < p.r) {
            h[n] = 0;
            v[n] = 0;
          }
    }
  }

  /** Bilinear height at page fractions (0..1). */
  private heightAt(fx: number, fy: number) {
    const gx = Math.min(Math.max(fx, 0), 1) * SEG_X;
    const gz = Math.min(Math.max(fy, 0), 1) * SEG_Z;
    const i = Math.min(Math.floor(gx), SEG_X - 1);
    const j = Math.min(Math.floor(gz), SEG_Z - 1);
    const tx = gx - i;
    const tz = gz - j;
    const n = j * this.nx + i;
    const top = this.h[n] * (1 - tx) + this.h[n + 1] * tx;
    const bottom = this.h[n + this.nx] * (1 - tx) + this.h[n + this.nx + 1] * tx;
    return top * (1 - tz) + bottom * tz;
  }

  // ---- Whole-sheet sag ----------------------------------------------------

  /** The sheet's acceleration, in its own frame, bends it (heavily damped: no jelly). */
  private drive(dt: number) {
    const p = this.mesh.getWorldPosition(this.tmp);
    const vel = p.clone().sub(this.lastPos).divideScalar(Math.max(dt, 1e-3));
    const acc = vel.clone().sub(this.lastVel).divideScalar(Math.max(dt, 1e-3));
    this.lastPos.copy(p);
    this.lastVel.copy(vel);
    if (this.primed < 2 || acc.length() > MAX_ACCEL * 20) {
      this.primed++;
      acc.set(0, 0, 0);
    }
    acc.clampLength(0, MAX_ACCEL);
    acc.applyQuaternion(this.mesh.getWorldQuaternion(this.q).invert());
    this.velU += (-BEND_STIFF * this.bendU - BEND_DAMP * this.velU - acc.y * INERTIA) * dt;
    this.velV += (-BEND_STIFF * this.bendV - BEND_DAMP * this.velV - acc.y * INERTIA * 0.5) * dt;
    this.bendU = THREE.MathUtils.clamp(this.bendU + this.velU * dt, -MAX_BEND, MAX_BEND);
    this.bendV = THREE.MathUtils.clamp(this.bendV + this.velV * dt, -MAX_BEND, MAX_BEND);
  }

  /** A grid point's position: its height, the whole-sheet sag, and the curled ends pulling in. */
  private shape(x: number, z: number, height: number, out: THREE.Vector3) {
    const u = x / (this.w / 2);
    const v = z / (this.d / 2);
    const roll = smoothstep(CURL_FROM, 1, Math.abs(u));
    const pullIn = Math.sign(u) * Math.max(0, height) * 0.35 * roll;
    const y = height + this.bendU * (u * u - 1 / 3) + this.bendV * (v * v - 1 / 3);
    out.set(x - pullIn, y, z);
  }
}
