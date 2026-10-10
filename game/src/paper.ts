import * as THREE from 'three';

// The sea chart as a soft sheet of paper. Its short ends curl up a little, like
// a map that wants to roll back up; it can stand a fold crease; it ripples; and
// it bends with inertia when it is carried: a damped spring per bending mode,
// driven by the sheet's own acceleration (lift it fast and the ends droop, stop
// it and they flap). Local frame: x across the page, z down it, y off its face.

const SEG_X = 28;
const SEG_Z = 18;
const CURL = 0.17; // how far the ends roll up, at curl 1
const CURL_FROM = 0.6; // |u| where the roll starts (u: -1 left edge .. 1 right edge)
const CREASE = 0.07; // how far the fold stands up, at fold 1
const RIPPLE = 0.006; // the idle ripple, always there
const STIFF = 140; // bending spring
const DAMP = 7;
const INERTIA = 0.6; // how strongly acceleration bends the sheet
const MAX_BEND = 0.32;
const MAX_ACCEL = 120; // ignore teleports (a jump between layouts)

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class SoftPaper {
  readonly mesh: THREE.Mesh;
  /** 1 = folded (crease standing up), 0 = flat. */
  fold = 1;
  /** 1 = ends curled as at rest, 0 = held flat. */
  curl = 1;
  /** Extra ripple, 0..1, e.g. while the pointer stirs it. */
  ruffle = 0;

  private flat: Float32Array; // x, y, z of the flat sheet
  private bendU = 0; // along x: + ends up, - ends down
  private bendV = 0; // along z
  private twist = 0;
  private velU = 0;
  private velV = 0;
  private velT = 0;
  private t = 0;
  private lastPos = new THREE.Vector3();
  private lastVel = new THREE.Vector3();
  private primed = 0; // frames of motion seen since reset; acceleration needs two
  private tmp = new THREE.Vector3();
  private q = new THREE.Quaternion();

  constructor(
    private w: number,
    private d: number,
    material: THREE.Material,
  ) {
    const geo = new THREE.PlaneGeometry(w, d, SEG_X, SEG_Z);
    geo.rotateX(-Math.PI / 2);
    this.flat = Float32Array.from(geo.attributes.position.array);
    this.mesh = new THREE.Mesh(geo, material);
  }

  /** Forget the motion so far (after a jump), and settle the bends. */
  reset() {
    this.primed = 0;
    this.bendU = this.bendV = this.twist = 0;
    this.velU = this.velV = this.velT = 0;
  }

  /** A flick, e.g. from a fast pointer: sets the sheet flapping. */
  kick(u: number, v: number, twist = 0) {
    this.velU += u;
    this.velV += v;
    this.velT += twist;
  }

  /** Where a point of the page (fractions across and down, 0..1) is now, in world space. */
  pointAt(fx: number, fy: number, out: THREE.Vector3) {
    this.shape((fx - 0.5) * this.w, (fy - 0.5) * this.d, out);
    return this.mesh.localToWorld(out);
  }

  /** Steps the bending and reshapes the sheet. Call once a frame, after placing it. */
  update(dt: number) {
    this.t += dt;
    this.drive(dt);
    const pos = this.mesh.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      this.shape(this.flat[i * 3], this.flat[i * 3 + 2], this.tmp);
      pos.setXYZ(i, this.tmp.x, this.tmp.y, this.tmp.z);
    }
    pos.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();
    this.mesh.geometry.computeBoundingBox();
  }

  /** The sheet's acceleration, in its own frame, pushes the bending springs. */
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
    // Into the sheet's frame: only the push across its face (local y) bends it.
    acc.applyQuaternion(this.mesh.getWorldQuaternion(this.q).invert());
    const spring = (b: number, v: number, force: number) => -STIFF * b - DAMP * v + force;
    this.velU += spring(this.bendU, this.velU, -acc.y * INERTIA) * dt;
    this.velV += spring(this.bendV, this.velV, -acc.y * INERTIA * 0.5) * dt;
    this.velT += spring(this.twist, this.velT, (acc.x - acc.z) * INERTIA * 0.15) * dt;
    this.bendU = THREE.MathUtils.clamp(this.bendU + this.velU * dt, -MAX_BEND, MAX_BEND);
    this.bendV = THREE.MathUtils.clamp(this.bendV + this.velV * dt, -MAX_BEND, MAX_BEND);
    this.twist = THREE.MathUtils.clamp(this.twist + this.velT * dt, -MAX_BEND, MAX_BEND);
  }

  /** The sheet's surface at a flat point (x across, z down): curl, crease, ripple and bends. */
  private shape(x: number, z: number, out: THREE.Vector3) {
    const u = x / (this.w / 2);
    const v = z / (this.d / 2);
    const au = Math.abs(u);
    // The ends roll up, pulling in a little as they do, the corners a touch more.
    const roll = smoothstep(CURL_FROM, 1, au);
    let y = CURL * this.curl * roll * roll * (1 + 0.35 * smoothstep(0.4, 1, Math.abs(v)));
    const pullIn = Math.sign(u) * y * 0.35;
    y += CREASE * this.fold * Math.max(0, 1 - au);
    const ripple = RIPPLE + this.ruffle * 0.03;
    y += ripple * Math.sin(u * 3.1 + this.t * 1.7) * Math.cos(v * 2.3 - this.t * 1.3);
    // Bending modes: centred so they flex the sheet around its middle, not lift it.
    y += this.bendU * (u * u - 1 / 3) + this.bendV * (v * v - 1 / 3) + this.twist * u * v;
    out.set(x - pullIn, y, z);
  }
}
