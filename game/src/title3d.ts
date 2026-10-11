import * as THREE from 'three';
import { engraveName } from './engrave';
import { buildFishMesh, type FishMesh, type FishSpec } from './fish';

// The title's hanging fish as real 3D models. title.ts still runs the rope and
// line physics in screen space; every frame each fish is placed from its tail
// and head particles, then turned in 3D: a three-quarter view of its flank that
// swings round and leans as it moves, its tail wagging (faster under the
// pointer). An orthographic camera maps one world unit to one CSS pixel, with y
// up, so screen positions carry straight over.

/** A smoother body for a carved fish: the name sits on a broad flank, not across sharp creases. */
const CARVED_BODY = { rings: 12, sides: 10 };
const BASE_YAW = -0.42; // three-quarter view: the carved +z flank toward us, nose a little away
const SWING_YAW = 0.0016; // radians of turn per px/s of sideways speed
const SWING_ROLL = 0.0012; // radians of lean per px/s of vertical speed
const MAX_TURN = 0.75;
const FOLLOW = 7; // how quickly the turn follows the motion, 1/s

export interface FishPose {
  /** Tail tip and mouth, in screen px. */
  tx: number;
  ty: number;
  hx: number;
  hy: number;
  /** Velocity of the fish, px/s. */
  vx: number;
  vy: number;
  /** 0..1: the pointer is over it. */
  hover: number;
}

interface Staged {
  pivot: THREE.Group; // at the tail tip; turned and scaled to the pose
  mesh: FishMesh;
  span: number; // tail tip to nose, model units
  yaw: number;
  roll: number;
  phase: number;
  carving: THREE.Mesh | null;
  tone: THREE.Color; // the body colour, which the carving is cut in
}

export class FishStage {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(0, 1, 0, -1, -4000, 4000);
  private fish: Staged[] = [];
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'ZYX');

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#33415c', 1.5));
    const key = new THREE.DirectionalLight('#ffffff', 2.4);
    key.position.set(-0.4, 1, 0.9);
    const rim = new THREE.DirectionalLight('#9fe8ff', 1.2);
    rim.position.set(0.8, -0.2, -0.6);
    this.scene.add(key, rim);
  }

  /** Adds a fish (label: carved into its flank); returns its index for render(). */
  add(spec: FishSpec, label?: string): number {
    const mesh = buildFishMesh(spec, label ? CARVED_BODY : undefined);
    mesh.group.scale.setScalar(1);
    const tone = new THREE.Color().setHSL(spec.hue / 360, spec.sat, spec.light);
    const carving = label ? engraveName(mesh, label, tone, mesh.material.metalness) : null;
    // Tail fin tip to nose along x; hang it from the tail tip.
    const box = new THREE.Box3().setFromObject(mesh.group);
    mesh.group.position.x = -box.min.x;
    const pivot = new THREE.Group();
    pivot.add(mesh.group);
    this.scene.add(pivot);
    this.fish.push({ pivot, mesh, span: box.max.x - box.min.x, yaw: BASE_YAW, roll: 0, phase: Math.random() * 6, carving, tone });
    return this.fish.length - 1;
  }

  /** Carves a different name into fish i (the body stays as it is). */
  setLabel(i: number, label: string) {
    const f = this.fish[i];
    if (f.carving) {
      f.carving.removeFromParent();
      f.carving.geometry.dispose();
      const m = f.carving.material as THREE.MeshStandardMaterial;
      m.map?.dispose();
      m.bumpMap?.dispose();
      m.dispose();
    }
    // The carving is cut in world space: do it with the fish back where add() had it,
    // at the origin (no pivot turn, no tail-tip offset).
    const { position, quaternion, scale } = f.pivot;
    const saved = { p: position.clone(), q: quaternion.clone(), s: scale.clone(), x: f.mesh.group.position.x };
    position.set(0, 0, 0);
    quaternion.identity();
    scale.setScalar(1);
    f.mesh.group.position.x = 0;
    f.pivot.updateMatrixWorld(true);
    f.carving = engraveName(f.mesh, label, f.tone, f.mesh.material.metalness);
    f.mesh.group.position.x = saved.x;
    position.copy(saved.p);
    quaternion.copy(saved.q);
    scale.copy(saved.s);
  }

  resize(w: number, h: number) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.camera.left = 0;
    this.camera.right = w;
    this.camera.top = 0;
    this.camera.bottom = -h;
    this.camera.updateProjectionMatrix();
  }

  /** Places every fish from its pose (null: not on the rope yet) and draws them. */
  render(poses: (FishPose | null)[], dt: number, time: number) {
    const k = 1 - Math.exp(-dt * FOLLOW);
    this.fish.forEach((f, i) => {
      const p = poses[i];
      f.pivot.visible = !!p;
      if (!p) return;
      const clamp = (v: number) => Math.max(-MAX_TURN, Math.min(MAX_TURN, v));
      f.yaw += (BASE_YAW + clamp(p.vx * SWING_YAW) - f.yaw) * k;
      f.roll += (clamp(p.vy * SWING_ROLL) - f.roll) * k;
      // Screen y runs down, world y up.
      const dx = p.hx - p.tx;
      const dy = p.ty - p.hy;
      const len = Math.hypot(dx, dy);
      f.pivot.position.set(p.tx, -p.ty, 0);
      this.e.set(f.roll, f.yaw, Math.atan2(dy, dx));
      f.pivot.quaternion.copy(this.q.setFromEuler(this.e));
      // The turn foreshortens the body; scale it back so the nose still meets the mouth particle.
      f.pivot.scale.setScalar(len / (f.span * Math.max(0.3, Math.cos(f.yaw))));
      // Tail wag: lazy at rest, livelier under the pointer.
      f.mesh.tail.rotation.y = Math.sin(time * (2.2 + p.hover * 5) + f.phase) * (0.12 + p.hover * 0.22);
    });
    this.renderer.render(this.scene, this.camera);
  }

  clear() {
    this.renderer.clear();
  }

  dispose() {
    for (const f of this.fish) {
      f.pivot.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      f.mesh.material.dispose();
      if (f.carving) {
        const m = f.carving.material as THREE.MeshStandardMaterial;
        m.map?.dispose();
        m.bumpMap?.dispose();
        m.dispose();
      }
    }
    this.renderer.dispose();
  }
}
