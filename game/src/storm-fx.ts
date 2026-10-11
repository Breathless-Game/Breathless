import * as THREE from 'three';
import { buildFishMesh, type FishSpec } from './fish';
import { disposeAll } from './fx';
import { flatMat } from './lowpoly';
import { ROGUE } from './storm';

// What a rogue wave looks like beyond the water itself (storm.ts has the rules,
// water.ts the wave): foam tumbling along its crest, spray torn off it, the
// burst when it hits the boat, and what goes overboard when the boat turns over.
// Everything is flat-shaded chunks like the rest of the scene: three instanced
// draws and a dozen small meshes, all hidden while the sea is quiet.

/** World height of the water at (x, z), swell and rogue wave included. */
export type Surface = (x: number, z: number) => number;

const FOAM = 30;
const DROPS = 320;
const PATCHES = 10;
const GRAVITY = 9.8;

// Scratch objects for the per-frame path.
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

interface Floater {
  mesh: THREE.Object3D;
  /** Metres per second, and radians per second about each axis while it tumbles. */
  vx: number;
  vy: number;
  vz: number;
  spin: THREE.Vector3;
  afloat: boolean;
  /** How high its middle rides above the water once it floats, and how it lies. */
  ride: number;
  flat: THREE.Euler;
  age: number;
  life: number;
  phase: number;
  /** A fish: it swims off instead of floating, and is thrown away afterwards. */
  fish: boolean;
}

export class StormFx {
  readonly group = new THREE.Group();
  private foam: THREE.InstancedMesh;
  private drops: THREE.InstancedMesh;
  private patches: THREE.InstancedMesh;
  // Droplets: position, velocity, age, life, size.
  private drop = new Float32Array(DROPS * 9);
  private nextDrop = 0;
  private liveDrops = 0;
  // Foam patches left on the water: x, z, age, life, size, turn.
  private patch = new Float32Array(PATCHES * 6);
  private nextPatch = 0;
  private floaters: Floater[] = [];
  private cargo: THREE.Object3D[] = [];
  private emit = 0;
  // The boat's ordinary wake is deliberately a small, throttled effect. The
  // wave crest has its own spray path below; keeping this state separate lets
  // a calm sea leave just a few soft chips while a steep swell hits the hull
  // with a short burst.
  private wakeCooldown = 0;
  private lastBoatX = Number.NaN;
  private lastBoatY = Number.NaN;
  // Each clump of foam keeps its own place along the crest, size and tumble.
  private clump = new Float32Array(FOAM * 4);

  constructor(scene: THREE.Scene) {
    // White water carries its own light: under a storm sky plain white facets would read as grey stones.
    const white = flatMat('#ffffff', { emissive: '#dcecf2', emissiveIntensity: 0.85, roughness: 0.7 });
    this.foam = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), white, FOAM);
    this.drops = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(1, 0), white, DROPS);
    const disc = new THREE.CircleGeometry(1, 7);
    disc.rotateX(-Math.PI / 2);
    this.patches = new THREE.InstancedMesh(disc, flatMat('#f1f8fa', { emissive: '#c4dae2', emissiveIntensity: 0.6 }), PATCHES);
    for (const mesh of [this.foam, this.drops, this.patches]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.visible = false;
      for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, HIDDEN);
      this.group.add(mesh);
    }
    for (let i = 0; i < FOAM; i++) {
      // Spread along the crest from the far water to just short of the camera.
      this.clump.set([-58 + i * 2.1 + Math.sin(i * 12.9898) * 0.8, 0.5 + 0.5 * Math.abs(Math.sin(i * 78.233)), Math.sin(i * 39.3) * 0.9, i * 2.399], i * 4);
    }

    // What lies on a fishing boat's deck: crates, planks, a barrel, a life ring.
    const wood = flatMat('#c79a62');
    const dark = flatMat('#8a6a48');
    const barrel = flatMat('#4c6570', { metalness: 0.5, roughness: 0.4 });
    const ring = flatMat('#f2714b');
    const piece = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      this.cargo.push(mesh);
      this.group.add(mesh);
    };
    piece(new THREE.BoxGeometry(0.7, 0.5, 0.6), dark);
    piece(new THREE.BoxGeometry(0.55, 0.45, 0.5), wood);
    piece(new THREE.BoxGeometry(0.45, 0.4, 0.45), dark);
    for (let i = 0; i < 4; i++) piece(new THREE.BoxGeometry(1.5 - i * 0.2, 0.07, 0.26), i % 2 ? wood : dark);
    piece(new THREE.CylinderGeometry(0.3, 0.3, 0.72, 8), barrel);
    piece(new THREE.CylinderGeometry(0.24, 0.24, 0.6, 8), barrel);
    piece(new THREE.TorusGeometry(0.32, 0.08, 5, 10), ring);
    scene.add(this.group);
  }

  /** One droplet of spray. Reuses the oldest when the pool is full. */
  private spray(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number) {
    const i = this.nextDrop * 9;
    this.nextDrop = (this.nextDrop + 1) % DROPS;
    this.drop.set([x, y, z, vx, vy, vz, 0, life, size], i);
  }

  /** A patch of foam left lying on the water at (x, z). */
  private leaveFoam(x: number, z: number, size: number, life: number) {
    this.patch.set([x, z, 0, life, size, Math.random() * 6], this.nextPatch * 6);
    this.nextPatch = (this.nextPatch + 1) % PATCHES;
  }

  /** A burst of white water thrown up around (x, z): `count` droplets, flung `throwX` m/s along x. */
  burst(x: number, y: number, z: number, count: number, throwX: number, power: number) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const out = Math.random() * power * 0.55;
      this.spray(
        x + Math.cos(a) * 1.4, y + Math.random() * 0.6, z + Math.sin(a) * 1.1,
        throwX * (0.3 + Math.random() * 0.9) + Math.cos(a) * out, power * (0.45 + Math.random() * 0.75), Math.sin(a) * out,
        0.9 + Math.random() * 1.1, 0.12 + Math.random() * 0.3,
      );
    }
  }

  /**
   * The wave strikes the boat at `x`, travelling `dir`: a wall of spray, foam left on the water,
   * the deck cargo thrown clear, and the lost fish flung out to swim away.
   */
  capsize(x: number, dir: 1 | -1, lostFish: readonly FishSpec[], surface: Surface) {
    const y = surface(x, 0);
    this.burst(x - dir * 2, y + 0.4, 0, 150, dir * 9, 11);
    this.burst(x + dir * 1.5, y, 0.6, 70, dir * 5, 7);
    for (let i = 0; i < 5; i++) this.leaveFoam(x + (Math.random() - 0.3) * dir * 7, (Math.random() - 0.5) * 5, 1.4 + Math.random() * 1.6, 5 + Math.random() * 4);
    for (const old of this.floaters) if (old.fish) this.discard(old);
    this.floaters.length = 0;
    this.cargo.forEach((mesh, i) => {
      mesh.visible = true;
      mesh.scale.setScalar(1);
      mesh.position.set(x + (Math.random() - 0.5) * 4.5, y + 0.9 + Math.random() * 0.8, (Math.random() - 0.5) * 1.2);
      mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      // The life ring floats on its side; planks and crates lie flat, barrels on their side.
      const lying = i >= 9 ? new THREE.Euler(Math.PI / 2, 0, 0) : i >= 7 ? new THREE.Euler(0, Math.random() * 6, Math.PI / 2) : new THREE.Euler(0, Math.random() * 6, 0);
      this.floaters.push({
        mesh, vx: dir * (2 + Math.random() * 6) + (Math.random() - 0.5) * 2, vy: 3.5 + Math.random() * 4.5, vz: (Math.random() - 0.35) * 3.4,
        spin: new THREE.Vector3((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9),
        afloat: false, ride: i >= 3 && i < 7 ? 0.02 : 0.1, flat: lying, age: 0, life: 16 + Math.random() * 8, phase: Math.random() * 6, fish: false,
      });
    });
    for (const spec of lostFish.slice(0, 4)) {
      const { group } = buildFishMesh(spec);
      group.position.set(x + (Math.random() - 0.5) * 3, y + 1 + Math.random() * 0.6, (Math.random() - 0.5));
      this.group.add(group);
      this.floaters.push({
        mesh: group, vx: dir * (1.5 + Math.random() * 4), vy: 4 + Math.random() * 3.5, vz: (Math.random() - 0.5) * 2,
        spin: new THREE.Vector3(0, 0, (Math.random() - 0.5) * 12), afloat: false, ride: 0, flat: new THREE.Euler(), age: 0, life: 3.2, phase: Math.random() * 6, fish: true,
      });
    }
  }

  /**
   * Add the small white-water interaction at the hull. `surface` is the same
   * function used by the boat and the rogue wave, so the wake follows the
   * actual crest instead of a fixed waterline. A steep local slope, a fast
   * vertical heave, and a boat that is rolling all make the bow slap harder.
   * A capsizing hull is left to `capsize`, which already produces the large
   * throw of spray and floating debris.
   */
  boatWake(dt: number, _time: number, x: number, y: number, roll: number, pitch: number, surface: Surface) {
    if (!Number.isFinite(dt) || dt <= 0 || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const previousX = this.lastBoatX;
    const previousY = this.lastBoatY;
    this.lastBoatX = x;
    this.lastBoatY = y;
    // During a capsize the dedicated event effect is more legible than a
    // continuous wake fighting the deck cargo and righting spray.
    if (Math.abs(roll) > 0.55) {
      this.wakeCooldown = Math.max(this.wakeCooldown, 0.18);
      return;
    }

    const water = surface(x, 0);
    const slope = (surface(x + 2, 0) - surface(x - 2, 0)) * 0.25;
    const verticalSpeed = Number.isFinite(previousY) ? (y - previousY) / dt : 0;
    const horizontalSpeed = Number.isFinite(previousX) ? (x - previousX) / dt : 0;
    // All terms are metres or radians scaled to a comparable 0..1 visual
    // intensity. The small floor keeps even calm fjord water alive.
    const intensity = THREE.MathUtils.clamp(
      0.1 + Math.abs(slope) * 1.7 + Math.abs(verticalSpeed) * 0.18
        + Math.abs(y - water) * 0.28 + Math.abs(roll) * 0.16 + Math.abs(pitch) * 0.2
        + Math.min(1, Math.abs(horizontalSpeed) * 0.025) * 0.12,
      0,
      1,
    );
    this.wakeCooldown -= dt;
    if (this.wakeCooldown > 0) return;
    // Higher, faster waves strike more often. Keeping a minimum interval
    // prevents particle churn when the render loop is running quickly.
    this.wakeCooldown = THREE.MathUtils.lerp(0.48, 0.14, intensity);
    const size = THREE.MathUtils.lerp(0.22, 0.72, intensity);
    const power = THREE.MathUtils.lerp(1.4, 4.8, intensity);
    const count = Math.round(2 + intensity * 10);
    const waveSide = slope >= 0 ? 1 : -1;
    const bowX = x + 2.85;
    const bowZ = waveSide * THREE.MathUtils.lerp(0.58, 0.82, intensity);
    const bowY = surface(bowX, bowZ) + 0.04;
    this.burst(bowX, bowY, bowZ, count, horizontalSpeed * 0.25 + waveSide * power * 0.15, power);
    // The stern leaves a flatter, longer chip instead of a second wall of
    // spray. This remains visible as the hull rises off a passing trough.
    const trailX = x - 2.3;
    const trailZ = -waveSide * 0.62;
    this.leaveFoam(trailX, trailZ, size, THREE.MathUtils.lerp(1.5, 3.6, intensity));
    if (intensity > 0.42) {
      this.leaveFoam(x - 0.7, waveSide * 0.9, size * 0.72, 1.5 + intensity * 1.8);
    }
  }

  private discard(f: Floater) {
    this.group.remove(f.mesh);
    disposeAll(f.mesh);
  }

  /**
   * Advance by `dt`. `waveX` is the crest (null: no wave), travelling `dir`, `height` m tall
   * right now; `surface` is the water everything rides on.
   */
  update(dt: number, time: number, waveX: number | null, dir: 1 | -1, height: number, surface: Surface) {
    // ---- Foam along the crest, and spray torn off it by the wind.
    const crest = waveX !== null && height > 0.4;
    this.foam.visible = crest;
    if (crest) {
      const share = height / ROGUE.height;
      for (let i = 0; i < FOAM; i++) {
        const [z, size, lead, turn] = this.clump.subarray(i * 4, i * 4 + 4);
        // Just over the top, tipping down the steep face.
        const x = waveX + dir * (0.5 + lead * 0.9 + 0.5 * Math.sin(time * 3.1 + turn));
        const s = size * share * (0.95 + 0.3 * Math.sin(time * 5.3 + turn * 2));
        // The crest flattens out before the camera (see water.ts): no foam there.
        const fade = z > 2 ? Math.max(0, 1 - (z - 2) / 5) : 1;
        _q.setFromEuler(_e.set(time * 2.2 + turn, turn, -dir * time * 3.4 + turn));
        this.foam.setMatrixAt(i, _m.compose(_p.set(x, surface(x, z) + 0.12 * s, z), _q, _s.set(s * 1.25 * fade, s * 0.62 * fade, s * 1.05 * fade)));
      }
      this.foam.instanceMatrix.needsUpdate = true;
      this.emit += dt * 46 * share;
      while (this.emit >= 1) {
        this.emit -= 1;
        const z = -52 + Math.random() * 55;
        this.spray(waveX, surface(waveX, z) + 0.25, z, dir * (ROGUE.speed + 1 + Math.random() * 5), 1.6 + Math.random() * 3.6, (Math.random() - 0.5) * 2.4, 0.6 + Math.random() * 0.7, 0.09 + Math.random() * 0.2);
      }
      // The broken water it leaves behind.
      if (Math.random() < dt * 5 * share) this.leaveFoam(waveX - dir * (4 + Math.random() * 5), -30 + Math.random() * 30, 1 + Math.random() * 1.6, 3 + Math.random() * 3);
    }

    // ---- Droplets: thrown, pulled down, gone when they fall back into the sea.
    let alive = 0;
    const d = this.drop;
    for (let i = 0; i < DROPS; i++) {
      const o = i * 9;
      if (d[o + 7] <= 0) continue;
      d[o + 6] += dt;
      d[o + 4] -= GRAVITY * dt;
      d[o] += d[o + 3] * dt;
      d[o + 1] += d[o + 4] * dt;
      d[o + 2] += d[o + 5] * dt;
      const t = d[o + 6] / d[o + 7];
      if (t >= 1 || (d[o + 4] < 0 && d[o + 1] < surface(d[o], d[o + 2]) - 0.1)) {
        d[o + 7] = 0;
        this.drops.setMatrixAt(i, HIDDEN);
        continue;
      }
      alive++;
      const s = d[o + 8] * (1 - t * t);
      _q.setFromEuler(_e.set(d[o + 6] * 7 + i, i, d[o + 6] * 5));
      this.drops.setMatrixAt(i, _m.compose(_p.set(d[o], d[o + 1], d[o + 2]), _q, _s.set(s, s, s)));
    }
    if (alive || this.liveDrops) this.drops.instanceMatrix.needsUpdate = true;
    this.liveDrops = alive;
    this.drops.visible = alive > 0;

    // ---- Foam patches spread, ride the swell and shrink away.
    let lying = 0;
    for (let i = 0; i < PATCHES; i++) {
      const o = i * 6;
      if (this.patch[o + 3] <= 0) continue;
      this.patch[o + 2] += dt;
      const t = this.patch[o + 2] / this.patch[o + 3];
      if (t >= 1) {
        this.patch[o + 3] = 0;
        this.patches.setMatrixAt(i, HIDDEN);
        continue;
      }
      lying++;
      const s = this.patch[o + 4] * Math.min(1, t * 6) * (1 - t * t);
      const [x, z] = [this.patch[o], this.patch[o + 1]];
      _q.setFromEuler(_e.set(0, this.patch[o + 5] + t, 0));
      this.patches.setMatrixAt(i, _m.compose(_p.set(x, surface(x, z) + 0.06, z), _q, _s.set(s * 1.3, 1, s)));
    }
    this.patches.visible = lying > 0;
    if (lying || this.patches.visible) this.patches.instanceMatrix.needsUpdate = true;

    // ---- Cargo and fish gone overboard.
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.age += dt;
      const p = f.mesh.position;
      const water = surface(p.x, p.z);
      if (!f.afloat) {
        f.vy -= GRAVITY * dt;
        p.x += f.vx * dt;
        p.y += f.vy * dt;
        p.z += f.vz * dt;
        f.mesh.rotation.x += f.spin.x * dt;
        f.mesh.rotation.y += f.spin.y * dt;
        f.mesh.rotation.z += f.spin.z * dt;
        if (f.vy < 0 && p.y <= water + f.ride) {
          f.afloat = true;
          f.age = 0;
          this.burst(p.x, water, p.z, f.fish ? 6 : 10, f.vx * 0.3, 3.2);
          this.leaveFoam(p.x, p.z, 0.7 + Math.random() * 0.5, 2.2);
        }
        continue;
      }
      if (f.fish) {
        // Free again: it darts down and away, and is gone.
        p.x += (f.vx > 0 ? 1 : -1) * 5 * dt;
        p.y -= 3.2 * dt;
        f.mesh.rotation.set(0, f.vx > 0 ? 0 : Math.PI, -0.5);
        f.mesh.scale.setScalar(Math.max(0.01, 1 - f.age / f.life));
        if (f.age >= f.life) {
          this.discard(f);
          this.floaters.splice(i, 1);
        }
        continue;
      }
      // Wreckage drifts downwind, settles flat and rocks on the swell; in the end it goes under.
      f.vx *= Math.exp(-1.3 * dt);
      f.vz *= Math.exp(-1.3 * dt);
      p.x += (f.vx + Math.sign(f.vx || 1) * 0.35) * dt;
      p.z += f.vz * dt;
      const going = Math.max(0, f.age - (f.life - 3)) / 3;
      p.y = water + f.ride + 0.05 * Math.sin(time * 2.1 + f.phase) - going * 1.6;
      const ease = 1 - Math.exp(-3 * dt);
      f.mesh.rotation.x += (f.flat.x + 0.12 * Math.sin(time * 1.7 + f.phase) - f.mesh.rotation.x) * ease;
      f.mesh.rotation.z += (f.flat.z + 0.1 * Math.sin(time * 1.3 + f.phase * 2) - f.mesh.rotation.z) * ease;
      f.mesh.scale.setScalar(1 - going * going);
      if (going >= 1) {
        f.mesh.visible = false;
        this.floaters.splice(i, 1);
      }
    }
  }

  /** Calm water: everything gone at once (a new dive, or back to the menu). */
  clear() {
    for (const f of this.floaters) {
      if (f.fish) this.discard(f);
      else f.mesh.visible = false;
    }
    this.floaters.length = 0;
    this.drop.fill(0);
    this.patch.fill(0);
    this.liveDrops = 0;
    this.wakeCooldown = 0;
    this.lastBoatX = Number.NaN;
    this.lastBoatY = Number.NaN;
    for (const mesh of [this.foam, this.drops, this.patches]) {
      for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, HIDDEN);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = false;
    }
  }
}
