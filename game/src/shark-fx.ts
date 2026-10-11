import * as THREE from 'three';
import type { Shark } from './shark';

// How the sharks look and move (shark.ts has the rules). Each is a flat-shaded
// triangle soup with one colour per face, like the fish: a slate back, a pale
// belly, a tail that sweeps as it swims. One shared material, three models.

const LENGTH = 4.4;
const BACK = [new THREE.Color('#4b6170'), new THREE.Color('#3f5564'), new THREE.Color('#566d7b')];
const BELLY = [new THREE.Color('#dfe9ee'), new THREE.Color('#cfdde4')];
const FIN = new THREE.Color('#37495a');
// Calm sharks are a cold blue in the dark; in a frenzy they flush dull red.
const CALM_GLOW = new THREE.Color('#26404f');
const FRENZY_GLOW = new THREE.Color('#6a1414');
/** Each shark keeps to its own depth of field, so two of them never swim through each other. */
const LANES = [-1.3, 0.9, -0.3];

type P = [number, number, number];

class Soup {
  private pos: number[] = [];
  private col: number[] = [];

  tri(a: P, b: P, c: P, color: THREE.Color) {
    this.pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.col.push(color.r, color.g, color.b);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

/** The body and fixed fins, nose toward +x, and the tail on its own so it can sweep. */
function sharkGeometry(): { body: THREE.BufferGeometry; tail: THREE.BufferGeometry; tailAt: number } {
  // Six-sided rings from the tail root to the snout: [how far along, half height, half width, lift].
  const rings: [number, number, number, number][] = [
    [0, 0.11, 0.07, 0.04],
    [0.18, 0.27, 0.19, 0.02],
    [0.4, 0.46, 0.34, 0],
    [0.62, 0.52, 0.4, 0],
    [0.82, 0.4, 0.33, -0.02],
    [0.94, 0.22, 0.2, -0.05],
  ];
  const x0 = -LENGTH / 2 + 0.55;
  const span = LENGTH - 0.55;
  const ring = ([t, h, w, lift]: [number, number, number, number]): P[] =>
    Array.from({ length: 6 }, (_, j) => {
      const a = (j / 6) * Math.PI * 2 + Math.PI / 2;
      return [x0 + t * span, Math.sin(a) * h + lift, Math.cos(a) * w] as P;
    });
  const soup = new Soup();
  const shade = (pts: P[], n: number) => {
    const y = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
    return y > 0.02 ? BACK[n % BACK.length] : BELLY[n % BELLY.length];
  };
  const all = rings.map(ring);
  for (let i = 0; i < all.length - 1; i++) {
    for (let j = 0; j < 6; j++) {
      const k = (j + 1) % 6;
      const a = all[i][j], b = all[i + 1][j], c = all[i + 1][k], d = all[i][k];
      soup.tri(a, b, c, shade([a, b, c], i + j));
      soup.tri(a, c, d, shade([a, c, d], i + j + 1));
    }
  }
  // The snout closes to a blunt point, set a little low.
  const snout: P = [LENGTH / 2, -0.1, 0];
  const last = all[all.length - 1];
  for (let j = 0; j < 6; j++) {
    const k = (j + 1) % 6;
    soup.tri(last[j], snout, last[k], shade([last[j], snout, last[k]], j));
  }
  // Fins are single triangles, drawn from both sides.
  const fin = (a: P, b: P, c: P) => soup.tri(a, b, c, FIN);
  fin([0.55, 0.5, 0], [-0.5, 0.48, 0], [-0.35, 1.45, 0]); // dorsal
  fin([-1.15, 0.26, 0], [-1.55, 0.22, 0], [-1.5, 0.55, 0]); // second dorsal
  for (const side of [-1, 1]) fin([0.95, -0.22, side * 0.3], [0.2, -0.3, side * 0.34], [0.0, -0.75, side * 1.25]); // pectorals
  const body = soup.build();

  // The tail: a tall upper lobe and a shorter lower one, hinged at the root.
  const tail = new Soup();
  tail.tri([0, 0.1, 0], [-0.45, 0.06, 0], [-0.95, 1.15, 0], FIN);
  tail.tri([0, -0.08, 0], [-0.8, -0.72, 0], [-0.45, 0.06, 0], FIN);
  tail.tri([0, 0.1, 0], [0, -0.08, 0], [-0.45, 0.06, 0], BACK[1]);
  return { body, tail: tail.build(), tailAt: x0 };
}

interface View {
  root: THREE.Group;
  lean: THREE.Group;
  tail: THREE.Mesh;
  /** Which way it faces: 0 toward +x, PI toward -x, turning through the camera in between. */
  yaw: number;
  z: number;
  swim: number;
}

export class SharkFx {
  readonly group = new THREE.Group();
  private material = new THREE.MeshStandardMaterial({
    color: '#ffffff', vertexColors: true, flatShading: true, roughness: 0.75, side: THREE.DoubleSide,
    emissive: CALM_GLOW, emissiveIntensity: 0.9,
  });
  private views: View[] = [];
  private byShark = new Map<Shark, View>();

  constructor(scene: THREE.Scene) {
    const { body, tail, tailAt } = sharkGeometry();
    for (let i = 0; i < LANES.length; i++) {
      const root = new THREE.Group();
      const lean = new THREE.Group();
      const tailMesh = new THREE.Mesh(tail, this.material);
      tailMesh.position.x = tailAt;
      lean.add(new THREE.Mesh(body, this.material), tailMesh);
      root.add(lean);
      root.visible = false;
      this.group.add(root);
      this.views.push({ root, lean, tail: tailMesh, yaw: 0, z: LANES[i], swim: i * 2.1 });
    }
    scene.add(this.group);
  }

  /** Draw `sharks` as they are now. `intensity` (0..1) flushes them red and makes them a little bigger. */
  update(dt: number, sharks: readonly Shark[], intensity: number) {
    for (const [shark, view] of this.byShark) {
      if (sharks.includes(shark)) continue;
      view.root.visible = false;
      this.byShark.delete(shark);
    }
    this.material.emissive.copy(CALM_GLOW).lerp(FRENZY_GLOW, intensity);
    for (const shark of sharks) {
      let view = this.byShark.get(shark);
      if (!view) {
        view = this.views.find((v) => !v.root.visible);
        if (!view) continue;
        this.byShark.set(shark, view);
        view.root.visible = true;
        view.yaw = shark.vx < 0 ? Math.PI : 0;
      }
      const speed = Math.hypot(shark.vx, shark.vy);
      // A charging shark closes on the diver's own plane; the others keep their lane.
      const z = shark.mode === 'charge' ? 0 : view.z;
      view.root.position.set(shark.x, shark.y, view.root.position.z + (z - view.root.position.z) * Math.min(1, dt * 2.5));
      const facing = shark.vx < -0.2 ? Math.PI : shark.vx > 0.2 ? 0 : view.yaw > Math.PI / 2 ? Math.PI : 0;
      view.yaw += (facing - view.yaw) * Math.min(1, dt * 4);
      view.root.rotation.y = view.yaw;
      // Nose up or down along its course. The roll is local, so it holds whichever way it faces.
      const climb = Math.atan2(shark.vy, Math.abs(shark.vx) + 0.5);
      view.lean.rotation.z += (climb - view.lean.rotation.z) * Math.min(1, dt * 5);
      // The whole body snakes a little and the tail sweeps wide, faster the faster it swims.
      view.swim += dt * (2.2 + speed * 1.15);
      view.lean.rotation.y = Math.sin(view.swim) * 0.07;
      view.tail.rotation.y = Math.sin(view.swim - 0.9) * (0.32 + 0.03 * speed);
      view.root.scale.setScalar(1 + 0.22 * intensity);
    }
  }

  /** Empty water at once. */
  clear() {
    for (const view of this.views) view.root.visible = false;
    this.byShark.clear();
  }
}
