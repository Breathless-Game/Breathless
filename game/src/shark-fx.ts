import * as THREE from 'three';
import type { Shark } from './shark';

// How the sharks look and move (shark.ts has the rules). Each is a flat-shaded
// triangle soup with one colour per face, like the fish: a slate back, a pale
// belly, a tail that sweeps as it swims. Geometry is shared; each shark's
// material and face respond independently to its own attack state.

const LENGTH = 4.4;
const BACK = [new THREE.Color('#4b6170'), new THREE.Color('#3f5564'), new THREE.Color('#566d7b')];
const BELLY = [new THREE.Color('#dfe9ee'), new THREE.Color('#cfdde4')];
const FIN = new THREE.Color('#37495a');
// Calm sharks are a cold blue in the dark; in a frenzy they flush dull red.
const CALM_GLOW = new THREE.Color('#122430');
const FRENZY_GLOW = new THREE.Color('#711f19');
const CALM_EYE = new THREE.Color('#987647');
const HUNT_EYE = new THREE.Color('#ff632b');
/** Each shark keeps to its own depth of field, so four of them never swim through each other. */
const LANES = [-1.5, 1.15, -0.25, 2.0];

/** Add water caustics and a grazing highlight to the existing lit shader.
 * Both use reflected light, so darkness stays dark and the headlamp reveals
 * the facets. World coordinates keep the moving pattern attached to water.
 */
function waterLight(material: THREE.MeshStandardMaterial, uniforms: SharkFx['uniforms']) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
      varying vec3 vSharkWorld;
    `).replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      vSharkWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vSharkWorld;
      uniform float uSharkTime;
      uniform float uSharkNight;
      uniform float uSharkEffects;
    `).replace('#include <opaque_fragment>', `
      vec3 sharkWorldNormal = inverseTransformDirection(normal, viewMatrix);
      float sharkDepth = max(0.0, -vSharkWorld.y);
      float sharkWaveA = sin(vSharkWorld.x * 3.7 + vSharkWorld.z * 4.3 + uSharkTime * 1.35);
      float sharkWaveB = sin(vSharkWorld.x * -2.1 + vSharkWorld.z * 5.1 - uSharkTime * 1.1);
      float sharkCaustic = pow(max(0.0, 1.0 - abs(sharkWaveA + sharkWaveB) * 0.5), 12.0);
      float sharkTop = smoothstep(-0.15, 0.8, sharkWorldNormal.y);
      vec3 sharkLit = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
      float sharkRim = pow(1.0 - max(0.0, dot(normal, normalize(vViewPosition))), 3.0);
      outgoingLight += uSharkEffects * (
        reflectedLight.directDiffuse * sharkCaustic * sharkTop * exp(-sharkDepth / 32.0)
          * mix(0.75, 0.16, uSharkNight)
        + sharkLit * sharkRim * mix(0.18, 0.38, uSharkNight)
      );
      #include <opaque_fragment>
    `);
  };
  material.customProgramCacheKey = () => 'shark-water-light-v1';
}

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
  jaw: THREE.Group;
  mouth: THREE.Group;
  teeth: THREE.Group;
  material: THREE.MeshStandardMaterial;
  eye: THREE.MeshStandardMaterial;
  threat: number;
  /** Which way it faces: 0 toward +x, PI toward -x, turning through the camera in between. */
  yaw: number;
  z: number;
  swim: number;
}

export class SharkFx {
  readonly group = new THREE.Group();
  readonly uniforms = {
    uSharkTime: { value: 0 },
    uSharkNight: { value: 0 },
    uSharkEffects: { value: 1 },
  };
  private views: View[] = [];
  private byShark = new Map<Shark, View>();

  constructor(scene: THREE.Scene) {
    const { body, tail, tailAt } = sharkGeometry();
    const socketGeometry = new THREE.SphereGeometry(0.085, 8, 6);
    const eyeGeometry = new THREE.SphereGeometry(0.042, 8, 6);
    const toothGeometry = new THREE.ConeGeometry(0.038, 0.14, 3);
    const mouth = new THREE.MeshStandardMaterial({ color: '#10151b', roughness: 0.85, side: THREE.DoubleSide });
    const teeth = new THREE.MeshStandardMaterial({ color: '#e6dfc9', roughness: 0.42 });
    for (let i = 0; i < LANES.length; i++) {
      const material = new THREE.MeshStandardMaterial({
        color: '#ffffff', vertexColors: true, flatShading: true,
        roughness: 0.38, metalness: 0.08, side: THREE.DoubleSide,
        emissive: CALM_GLOW, emissiveIntensity: 0.025,
      });
      waterLight(material, this.uniforms);
      const eye = new THREE.MeshStandardMaterial({ color: CALM_EYE, emissive: CALM_EYE, emissiveIntensity: 0.08, roughness: 0.22 });
      const root = new THREE.Group();
      const lean = new THREE.Group();
      const jaw = new THREE.Group();
      jaw.position.set(1.35, -0.12, 0);
      const mouthGroup = new THREE.Group();
      mouthGroup.position.copy(jaw.position);
      const teethGroup = new THREE.Group();
      teethGroup.position.y = -0.12;
      const tailMesh = new THREE.Mesh(tail, material);
      tailMesh.position.x = tailAt;
      lean.add(new THREE.Mesh(body, material), tailMesh, jaw, mouthGroup, teethGroup);
      const jawSoup = new Soup();
      for (const side of [-1, 1]) {
        const socket = new THREE.Mesh(socketGeometry, mouth);
        socket.position.set(1.72, 0.08, side * 0.225);
        socket.scale.set(1, 0.5, 0.45);
        socket.rotation.z = -0.18;
        const iris = new THREE.Mesh(eyeGeometry, eye);
        iris.position.set(1.735, 0.083, side * 0.26);
        iris.scale.set(1, 0.42, 0.35);
        iris.rotation.z = -0.18;
        lean.add(socket, iris);
        // A dark mouth seam on each flank. The lower lip hinges down on a charge.
        const seam = new Soup();
        seam.tri([0.05, -0.01, side * 0.325], [0.77, 0.01, side * 0.095], [0.25, -0.14, side * 0.305], FIN);
        mouthGroup.add(new THREE.Mesh(seam.build(), mouth));
        jawSoup.tri([0, -0.09, side * 0.315], [0.77, 0, side * 0.095], [0.35, -0.18, side * 0.24], BELLY[1]);
        for (let t = 0; t < 3; t++) {
          const tooth = new THREE.Mesh(toothGeometry, teeth);
          tooth.position.set(1.53 + t * 0.2, -0.075, side * (0.31 - t * 0.055));
          tooth.rotation.z = Math.PI;
          teethGroup.add(tooth);
        }
      }
      jaw.add(new THREE.Mesh(jawSoup.build(), material));
      root.add(lean);
      root.visible = false;
      this.group.add(root);
      this.views.push({ root, lean, tail: tailMesh, jaw, mouth: mouthGroup, teeth: teethGroup, material, eye, threat: 0, yaw: 0, z: LANES[i], swim: i * 2.1 });
    }
    scene.add(this.group);
  }

  /** Pulse and a shark's own charge drive a gradual, readable attack cue. */
  update(dt: number, sharks: readonly Shark[], intensity: number, nightMix: number, effects: boolean) {
    this.uniforms.uSharkTime.value += dt;
    this.uniforms.uSharkNight.value = nightMix;
    this.uniforms.uSharkEffects.value = effects ? 1 : 0;
    for (const [shark, view] of this.byShark) {
      if (sharks.includes(shark)) continue;
      view.root.visible = false;
      this.byShark.delete(shark);
    }
    for (const shark of sharks) {
      let view = this.byShark.get(shark);
      if (!view) {
        view = this.views.find((v) => !v.root.visible);
        if (!view) continue;
        this.byShark.set(shark, view);
        view.root.visible = true;
        view.yaw = shark.vx < 0 ? Math.PI : 0;
        view.threat = 0;
        view.root.position.set(shark.x, shark.y, view.z);
        view.lean.rotation.set(0, 0, 0);
      }
      const speed = Math.hypot(shark.vx, shark.vy);
      const charging = shark.mode === 'charge';
      const targetThreat = shark.mode === 'leave' ? 0 : charging ? 1 : intensity * 0.55;
      view.threat += (targetThreat - view.threat) * (1 - Math.exp(-dt * (charging ? 6 : 2.5)));
      const threat = view.threat;
      view.material.emissive.copy(CALM_GLOW).lerp(FRENZY_GLOW, threat);
      // A restrained warm undertone, rather than a uniformly glowing body.
      view.material.emissiveIntensity = 0.025 + threat * 0.065;
      view.material.roughness = 0.38 - threat * 0.1;
      view.eye.color.copy(CALM_EYE).lerp(HUNT_EYE, threat);
      view.eye.emissive.copy(view.eye.color);
      view.eye.emissiveIntensity = 0.08 + nightMix * 0.12 + threat * 0.55;
      view.jaw.rotation.z = -0.04 - threat * 0.24;
      view.mouth.scale.y = 0.4 + threat * 1.4;
      view.teeth.scale.y = 0.2 + threat * 0.8;
      // A charging shark closes on the diver's own plane; the others keep their lane.
      const z = charging ? 0 : view.z;
      view.root.position.set(shark.x, shark.y, view.root.position.z + (z - view.root.position.z) * Math.min(1, dt * 2.5));
      const facing = shark.vx < -0.2 ? Math.PI : shark.vx > 0.2 ? 0 : view.yaw > Math.PI / 2 ? Math.PI : 0;
      view.yaw += (facing - view.yaw) * Math.min(1, dt * 4);
      view.root.rotation.y = view.yaw;
      // Nose up or down along its course. The roll is local, so it holds whichever way it faces.
      const climb = Math.atan2(shark.vy, Math.abs(shark.vx) + 0.5);
      view.lean.rotation.z += (climb - view.lean.rotation.z) * Math.min(1, dt * 5);
      // The whole body snakes a little and the tail sweeps wide, faster the faster it swims.
      view.swim += dt * (2.2 + speed * 1.15);
      view.lean.rotation.y = Math.sin(view.swim) * (0.07 + threat * 0.035);
      view.tail.rotation.y = Math.sin(view.swim - 0.9) * (0.32 + 0.03 * speed + threat * 0.12);
      view.root.scale.setScalar(1 + 0.12 * threat);
    }
  }

  /** Empty water at once. */
  clear() {
    for (const view of this.views) view.root.visible = false;
    this.byShark.clear();
  }
}
