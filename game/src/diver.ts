import * as THREE from 'three';
import { Splash } from './fx';
import { buildFishingNetMesh } from './gear';
import { lampActivation, lampDistanceAttenuation, lampProfile, type LampProfile } from './lamp-lighting';
import type { RenderQuality } from './render-quality';

function mat(color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.7, ...extra });
}

/** Where the head sits along the body: the point that breaks the surface first. */
const HEAD_X = 0.9;
/**
 * How far under the water (m) the head is when a dive splashes and when a climb
 * does (its crown touches the surface), and where it counts as under or out
 * with no splash at all: sunk well below, or clear of the water.
 */
const HEAD_DIPPED = 0.05;
const HEAD_BREACHING = 0.3;
const HEAD_SUNK = 1;
const HEAD_CLEAR = -0.1;

// Sitting on the bow: the body upright (hips at the seat), legs hanging forward
// over the edge, hands empty (the net is put away). The jump off arcs out and down
// into the water, turning head first on the way; the net comes out mid-jump.
const SIT_TORSO = Math.PI / 2;
const SIT_HIPS = 0.75; // torso centre above the hips, so the hips rest on the seat
const SIT_LEGS = 0.7; // from straight down toward forward
const SIT_ARM = Math.PI + 0.3; // hanging at the side, a little forward, empty-handed
const SIT_HEAD = -1.1; // tipped forward from the spine, so the mask looks out to sea
const NECK = 0.75; // along the body, where the head pivots
const JUMP_S = 1.1;
const JUMP_HEIGHT = 1.4;
const DIVE_PITCH = -1.25; // head down as it enters the water

const easeInOut = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

/** Low-poly freediver, modelled lying along +x (head first). */
export class Diver {
  group = new THREE.Group();
  pos = new THREE.Vector3(0, -0.4, 0);
  vel = new THREE.Vector3();
  facing = 1;
  headlamp: THREE.SpotLight;
  private body = new THREE.Group();
  private head = new THREE.Group();
  private legL: THREE.Group;
  private legR: THREE.Group;
  private finL!: THREE.Mesh;
  private finR!: THREE.Mesh;
  private freeArm: THREE.Group;
  private netArm: THREE.Group;
  private netMouth: THREE.Group;
  private netTip: THREE.Object3D;
  /** Visible emergency-tank model; level one deliberately has no cylinder. */
  private tankGroup = new THREE.Group();
  private tankBody: THREE.Mesh | null = null;
  /** Small head-mounted lamp housing, separate from the actual PointLight. */
  private lampGroup = new THREE.Group();
  private lampLens: THREE.Mesh | null = null;
  private lampBeam: THREE.Mesh;
  private lampBeamMaterial: THREE.MeshBasicMaterial;
  private lampOptics: LampProfile = lampProfile(1);
  private lampLevel = 1;
  private lampNight = 0;
  private lampEffects = true;
  private breathPoint: THREE.Object3D;
  private breathOrigin = new THREE.Vector3();
  private bubbleOffset = new THREE.Vector3();
  private netPointWorld = new THREE.Vector3();
  private netSwing = 0;
  /** While set, the diver sits here (it rides along with the boat), not at `pos`. */
  private seat: THREE.Object3D | null = null;
  private jump: { t: number; from: THREE.Vector3; to: THREE.Vector3 } | null = null;
  private netScale = 1;
  private rodReachScale = 1;
  private reelRecovery = 1;
  private lampMaxIntensity = 48;
  private kickPhase = 0;
  private armPhase = 1.2;
  private bubbles: { mesh: THREE.Mesh; vel: THREE.Vector3; life: number; maxLife: number; size: number; phase: number; lift: number }[] = [];
  private bubbleGeo = new THREE.IcosahedronGeometry(0.12, 1);
  private bubbleMat = new THREE.MeshStandardMaterial({
    color: '#e9fbff',
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    flatShading: true,
    roughness: 0.1,
  });
  private bubbleLimit = 72;
  private bubbleEmitScale = 1;
  private bubbleHz = 60;
  private bubbleUpdateAccumulator = 0;
  private splash = new Splash();
  private waterAt: (x: number, z: number) => number = () => 0;
  /** Whether the head was under water at the last update; null before the first one. */
  private headUnder: boolean | null = null;
  private lastY = 0;
  /** Seconds left of the air a dive drags under, and how hard that dive was. */
  private wake = 0;
  private wakeStrength = 0;
  private wakeDebt = 0;
  private wakePoint = new THREE.Vector3();
  private materialBinder: ((root: THREE.Object3D) => void) | null = null;

  constructor(private scene: THREE.Scene) {
    // A shared shell shader gives bubbles a bright rim and transparent centre
    // without adding a refraction pass or one outline mesh per particle.
    this.bubbleMat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        float bubbleRim = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.0);
        float bubbleGlint = pow(max(dot(normal, normalize(vec3(-0.4, 0.7, 0.6))), 0.0), 22.0);
        diffuseColor.a *= 0.14 + bubbleRim * 0.86;
        totalEmissiveRadiance += vec3(0.22, 0.47, 0.58) * bubbleRim * 0.35
          + vec3(0.7, 0.85, 0.9) * bubbleGlint * 0.22;`,
      );
    };
    this.bubbleMat.customProgramCacheKey = () => 'deepbreath-bubble-shell-v1';
    const suit = mat('#1d2b3a');
    const skin = mat('#e0b48f');
    const accent = mat('#ff7a3d');

    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.32, 1.5, 6), suit);
    torso.rotation.z = Math.PI / 2;
    const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.18, 6), accent);
    stripe.rotation.z = Math.PI / 2;
    stripe.position.x = 0.2;
    // The head pivots at the neck: lying flat it looks ahead along the body; sitting up it tips forward.
    this.head.position.x = NECK;
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 0), skin);
    head.position.x = 1.0 - NECK;
    const hood = new THREE.Mesh(new THREE.IcosahedronGeometry(0.36, 0), suit);
    hood.position.set(0.95 - NECK, 0.06, 0);
    hood.scale.set(0.9, 0.85, 1.02);
    const mask = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, 0.44), mat('#5fe1ff', { metalness: 0.6, roughness: 0.15 }));
    mask.position.set(1.28 - NECK, 0.05, 0);
    const snorkel = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.6, 4), accent);
    snorkel.position.set(1.0 - NECK, 0.45, 0.25);
    this.head.add(hood, head, mask, snorkel);
    this.body.add(torso, stripe, this.head);
    // Bubbles leave from the mouth, so the breath point turns with the head.
    this.breathPoint = new THREE.Object3D();
    this.breathPoint.position.set(1.23 - NECK, 0.34, 0.16);
    this.head.add(this.breathPoint);

    this.legL = this.makeLeg(suit, accent, 0.16);
    this.legR = this.makeLeg(suit, accent, -0.16);
    this.body.add(this.legL, this.legR);
    this.freeArm = this.makeFreeArm(suit, skin, -0.28);
    this.body.add(this.freeArm);

    // Optional dive accessories are attached to the diver body so they follow
    // the same pitch/yaw animation as the suit.  Keep the tank hidden until a
    // reserve-air tier is selected by the loadout.
    this.tankGroup.position.set(-0.25, 0, -0.34);
    this.tankGroup.rotation.z = Math.PI / 2;
    this.tankBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.18, 0.82, 8),
      mat('#287ea6', { metalness: 0.25, roughness: 0.45 }),
    );
    this.tankGroup.add(this.tankBody);
    this.tankGroup.visible = false;
    this.body.add(this.tankGroup);

    this.lampGroup.position.set(1.42 - NECK, 0.18, 0.28); // on the head group (it tips when seated)
    this.lampGroup.rotation.x = Math.PI / 2;
    this.lampLens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.12, 0.18, 6),
      mat('#7ff7ff', { emissive: '#43e9e1', emissiveIntensity: 0, metalness: 0.1, roughness: 0.25 }),
    );
    this.lampGroup.add(this.lampLens);
    this.head.add(this.lampGroup);

    // A single low-poly cone makes suspended particles visible in the beam.
    // The real SpotLight still provides direct illumination; this mesh only
    // represents the volume between the lens and the water.
    this.lampBeamMaterial = new THREE.MeshBasicMaterial({
      color: '#bcecff', transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.lampBeam = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 8, 1, true), this.lampBeamMaterial);
    this.lampBeam.name = 'diver-lamp-scatter';
    this.lampBeam.rotation.z = -Math.PI / 2;
    this.lampBeam.renderOrder = 1;
    this.body.add(this.lampBeam);

    // The old design called this item a fishing rod; the fused game design
    // uses its shaft and hoop as an underwater net. Keep the model pivot at
    // the shoulder so the whole tool follows the swing animation.
    const net = buildFishingNetMesh();
    this.netArm = net.group;
    this.netMouth = net.mouth;
    this.netArm.position.set(0.6, 0, 0.3);
    this.netTip = net.tip;
    this.body.add(this.netArm);

    this.group.add(this.body);
    // White water stays where it was thrown, so it lives in the scene, not on the diver.
    this.splash.mesh.name = 'diver-water-splash';
    scene.add(this.splash.mesh);
    // A spotlight gives the diver a readable forward beam at depth. Its
    // target is parented to the body, so yaw/pitch animation carries the beam
    // with the diver instead of leaving a world-space light behind.
    this.headlamp = new THREE.SpotLight('#fff1c4', 0, 22, 0.65, 0.55, 1.6);
    this.headlamp.position.set(1.4, 0.2, 0.6);
    this.headlamp.target.position.set(4.5, 0.05, 0.6);
    this.body.add(this.headlamp, this.headlamp.target);
    this.headlamp.decay = this.lampOptics.decay;
    scene.add(this.group);
  }

  /** Apply the active render budget to bubble geometry and simulation work. */
  setQuality(quality: RenderQuality) {
    this.bubbleLimit = Math.max(0, quality.bubbleLimit);
    this.bubbleEmitScale = Math.max(0, quality.bubbleEmitScale);
    this.bubbleHz = Math.max(1, quality.bubbleHz);
    if (this.bubbleGeo.parameters.detail !== quality.bubbleSegments) {
      const oldGeo = this.bubbleGeo;
      this.bubbleGeo = new THREE.IcosahedronGeometry(0.12, quality.bubbleSegments);
      for (const bubble of this.bubbles) bubble.mesh.geometry = this.bubbleGeo;
      oldGeo.dispose();
    }
    while (this.bubbles.length > this.bubbleLimit) {
      const bubble = this.bubbles.shift();
      if (bubble) this.scene.remove(bubble.mesh);
    }
  }

  /** Register a scene material pass for particles created after scene setup. */
  setMaterialBinder(binder: (root: THREE.Object3D) => void): void {
    this.materialBinder = binder;
  }

  /** Tell the diver where the waves are, so white water starts on the surface as drawn. */
  setWaterSurface(heightAt: (x: number, z: number) => number): void {
    this.waterAt = heightAt;
    this.splash.waterAt = heightAt;
  }

  /**
   * White water where the head breaks the surface, going in or coming out.
   * Nothing shows while the diver floats or swims: only a crossing does, and
   * a faster one throws more.
   */
  private updateWaterContact(dt: number, heave: number): void {
    const yaw = this.group.rotation.y;
    const pitch = this.body.rotation.z;
    const reach = HEAD_X * Math.cos(pitch);
    const headX = this.pos.x + Math.cos(yaw) * reach;
    const headZ = this.pos.z - Math.sin(yaw) * reach;
    // How far under the head is as drawn, against the waves rather than y = 0.
    const under = this.waterAt(headX, headZ) - (this.pos.y + heave + HEAD_X * Math.sin(pitch));
    // The diver's own climb: it has to be swimming that way and actually moving
    // (at the surface the buoyancy still pushes up, a respawn moves without swimming,
    // and the swell that heaves a swimmer is not a climb at all).
    const moved = dt > 0 ? (this.pos.y - this.lastY) / dt : 0;
    const climb = Math.sign(moved) === Math.sign(this.vel.y) ? Math.sign(moved) * Math.min(Math.abs(moved), Math.abs(this.vel.y)) : 0;
    this.lastY = this.pos.y;
    if (this.headUnder === null) {
      this.headUnder = under > HEAD_DIPPED;
    } else if (!this.headUnder) {
      // A swell rolling over a floating diver is not a dive: the splash waits for
      // the plunge, and is skipped once the head has sunk well under without one.
      if (under > HEAD_DIPPED && climb < -1.2) {
        this.headUnder = true;
        this.splashIn(THREE.MathUtils.clamp(-climb / 4.5, 0.3, 1.2));
      } else if (under > HEAD_SUNK) {
        this.headUnder = true;
      }
    } else if (under < HEAD_BREACHING && climb > 1.8) {
      // Faster than the buoyancy alone lifts a diver who respawned just under the surface.
      this.headUnder = false;
      this.wake = 0;
      this.splashOut(headX, headZ, THREE.MathUtils.clamp(climb / 6.5, 0.3, 1.2));
    } else if (under < HEAD_CLEAR) {
      // Drifted up, or the swell dropped away: out of the water without a splash.
      this.headUnder = false;
      this.wake = 0;
    }
    if (this.wake > 0 && dt > 0) {
      this.wake -= dt;
      this.wakeDebt += dt * 44 * this.wakeStrength * this.bubbleEmitScale;
      if (this.wakeDebt >= 1) this.trailAir();
    }
    this.splash.update(dt);
  }

  /** Diving in: a low crown off the length of the body, a short jet up the middle, air dragged under. */
  private splashIn(strength: number): void {
    const yaw = this.group.rotation.y;
    const alongX = Math.cos(yaw);
    const alongZ = -Math.sin(yaw);
    const power = 0.55 + 0.45 * strength;
    const droplets = Math.round((8 + 14 * strength) * this.bubbleEmitScale);
    for (let i = 0; i < droplets; i++) {
      const along = (Math.random() - 0.5) * 1.8;
      const around = Math.random() * Math.PI * 2;
      const lean = 0.25 + Math.random() * 0.45;
      const speed = (2.6 + Math.random() * 2.2) * power;
      const x = this.pos.x + alongX * along + Math.cos(around) * 0.15;
      const z = this.pos.z + alongZ * along + Math.sin(around) * 0.15;
      this.splash.droplet(
        x, this.waterAt(x, z) + 0.04, z,
        Math.cos(around) * Math.sin(lean) * speed + this.vel.x * 0.2, Math.cos(lean) * speed, Math.sin(around) * Math.sin(lean) * speed,
        (0.06 + Math.random() * 0.08) * (0.8 + 0.3 * strength), Math.random() * 0.07,
      );
    }
    // The water closes over the diver and jumps back up.
    const top = this.waterAt(this.pos.x, this.pos.z) + 0.04;
    for (let i = 0; i < 2 + Math.round(strength); i++) {
      this.splash.droplet(
        this.pos.x + (Math.random() - 0.5) * 0.2, top, this.pos.z + (Math.random() - 0.5) * 0.2,
        (Math.random() - 0.5) * 0.8, (4.6 + Math.random() * 1.6) * power, (Math.random() - 0.5) * 0.8,
        0.09 + Math.random() * 0.06, 0.08 + Math.random() * 0.1,
      );
    }
    const chips = Math.round((4 + 4 * strength) * this.bubbleEmitScale);
    for (let i = 0; i < chips; i++) {
      const along = (Math.random() - 0.5) * 1.6;
      const around = Math.random() * Math.PI * 2;
      const out = 0.2 + Math.random() * 0.5;
      const drift = (0.6 + Math.random() * 1.2) * strength;
      this.splash.chip(
        this.pos.x + alongX * along + Math.cos(around) * out, this.pos.z + alongZ * along + Math.sin(around) * out,
        Math.cos(around) * drift, Math.sin(around) * drift,
        0.16 + Math.random() * 0.14, 0.9 + Math.random() * 0.6,
      );
    }
    this.wake = 0.45;
    this.wakeStrength = strength;
  }

  /** Surfacing: a narrower, taller burst the head punches up, and the water running off after it. */
  private splashOut(x: number, z: number, strength: number): void {
    const power = 0.55 + 0.45 * strength;
    const top = this.waterAt(x, z) + 0.04;
    const droplets = Math.round((6 + 10 * strength) * this.bubbleEmitScale);
    for (let i = 0; i < droplets; i++) {
      const around = Math.random() * Math.PI * 2;
      const lean = 0.08 + Math.random() * 0.37;
      const speed = (2.8 + Math.random() * 2.6) * power;
      this.splash.droplet(
        x + Math.cos(around) * 0.4, top, z + Math.sin(around) * 0.4,
        Math.cos(around) * Math.sin(lean) * speed + this.vel.x * 0.25, Math.cos(lean) * speed, Math.sin(around) * Math.sin(lean) * speed,
        (0.06 + Math.random() * 0.08) * (0.8 + 0.3 * strength), Math.random() * 0.07,
      );
    }
    for (let i = 0; i < 2 + Math.round(2 * strength); i++) {
      this.splash.droplet(
        x + (Math.random() - 0.5) * 0.5, top + 0.25, z + (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 1.2, 0.8 + Math.random(), (Math.random() - 0.5) * 1.2,
        0.05 + Math.random() * 0.04, 0.1 + Math.random() * 0.25,
      );
    }
    const chips = Math.round((3 + 3 * strength) * this.bubbleEmitScale);
    for (let i = 0; i < chips; i++) {
      const around = Math.random() * Math.PI * 2;
      const out = 0.15 + Math.random() * 0.35;
      const drift = (0.5 + Math.random() * 0.9) * strength;
      this.splash.chip(
        x + Math.cos(around) * out, z + Math.sin(around) * out,
        Math.cos(around) * drift, Math.sin(around) * drift,
        0.14 + Math.random() * 0.12, 0.8 + Math.random() * 0.5,
      );
    }
  }

  /** Air pulled under with a dive: small bubbles off the body that turn and rise back to the surface. */
  private trailAir(): void {
    this.group.updateMatrixWorld(true);
    for (; this.wakeDebt >= 1; this.wakeDebt--) {
      if (this.bubbles.length >= this.bubbleLimit) continue;
      const point = this.wakePoint.set(-1.7 + Math.random() * 2.7, Math.random() * 0.35, (Math.random() - 0.5) * 0.6);
      point.applyMatrix4(this.body.matrixWorld);
      if (point.y > this.waterAt(point.x, point.z) - 0.06) continue;
      this.addBubble(
        point,
        this.vel.x * 0.3 + (Math.random() - 0.5), this.vel.y * 0.3 - 0.2 + Math.random() * 0.8, (Math.random() - 0.5) * 0.8,
        0.25 + Math.random() * 0.55, 0.8 + Math.random() * 0.6, 5,
      );
    }
  }

  private addBubble(position: THREE.Vector3, vx: number, vy: number, vz: number, size: number, maxLife: number, lift: number): void {
    const b = new THREE.Mesh(this.bubbleGeo, this.bubbleMat);
    b.position.copy(position);
    b.scale.setScalar(size);
    this.scene.add(b);
    // Bubbles are created after the initial scene traversal. Apply the
    // shared day/night and underwater color-grade hook to their material.
    this.materialBinder?.(b);
    this.bubbles.push({ mesh: b, vel: new THREE.Vector3(vx, vy, vz), life: maxLife, maxLife, size, phase: Math.random() * Math.PI * 2, lift });
  }

  private makeLeg(suit: THREE.Material, accent: THREE.Material, z: number) {
    const leg = new THREE.Group();
    leg.position.set(-0.7, 0, z);
    const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.2, 0.2), suit);
    thigh.position.x = -0.45;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.04, 0.34), accent);
    fin.position.x = -1.3;
    leg.add(thigh, fin);
    if (z > 0) this.finL = fin;
    else this.finR = fin;
    return leg;
  }

  private makeFreeArm(suit: THREE.Material, skin: THREE.Material, z: number) {
    const arm = new THREE.Group();
    arm.position.set(0.2, -0.22, z);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.14, 0.14), suit);
    upper.position.set(0.12, -0.12, 0);
    upper.rotation.z = -0.35;
    const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.11, 0.12), suit);
    forearm.position.set(0.42, -0.27, 0);
    forearm.rotation.z = -0.48;
    const glove = new THREE.Mesh(new THREE.IcosahedronGeometry(0.11, 0), skin);
    glove.position.set(0.62, -0.39, 0);
    arm.add(upper, forearm, glove);
    return arm;
  }

  /** Point of the net hoop in world space: where catches happen. */
  netPoint(): THREE.Vector3 {
    this.netTip.getWorldPosition(this.netPointWorld);
    return this.netPointWorld.clone();
  }

  /** Make the visible hoop grow with the equipped net tier. */
  setNetLevel(level: number) {
    this.netScale = 1 + THREE.MathUtils.clamp(level - 1, 0, 2) * 0.15;
    this.updateNetScale();
  }

  /** Extend the visible shaft/hoop for the separate rod-body upgrade slot. */
  setRodLevel(level: number) {
    this.rodReachScale = 1 + THREE.MathUtils.clamp(level - 1, 0, 2) * 0.12;
    this.updateNetScale();
  }

  /** Apply the derived shaft reach, including the selected specialization path. */
  setRodRange(range: number) {
    this.rodReachScale = THREE.MathUtils.clamp(range / 1.2, 0.6, 2);
    this.updateNetScale();
  }

  // The shaft slot stretches the whole tool along its length; the net tier
  // grows only the hoop, kept round by undoing the shaft's stretch on it.
  private updateNetScale() {
    this.netArm.scale.set(this.rodReachScale, 1, 1);
    this.netMouth.scale.set(this.netScale / this.rodReachScale, this.netScale, this.netScale);
  }

  /** Update the visible fin size for the selected diver upgrade tier. */
  setFinsLevel(level: number) {
    const tier = THREE.MathUtils.clamp(Math.floor(level), 1, 3);
    const length = 0.84 + tier * 0.16;
    const width = 0.9 + tier * 0.05;
    this.finL.scale.set(length, 1, width);
    this.finR.scale.set(length, 1, width);
  }

  /** Toggle and size the emergency tank model. Level one is the no-tank tier. */
  setTankLevel(level: number) {
    const tier = THREE.MathUtils.clamp(Math.floor(level), 1, 3);
    this.tankGroup.visible = tier >= 2;
    this.tankGroup.scale.setScalar(tier === 3 ? 1.18 : 1);
  }

  /** Set lamp visual tier and its light reach; intensity still follows depth. */
  setLampLevel(level: number) {
    this.lampLevel = THREE.MathUtils.clamp(Math.floor(level), 1, 3);
    this.lampOptics = lampProfile(this.lampLevel);
    this.headlamp.distance = this.lampOptics.distance;
    this.headlamp.angle = this.lampOptics.angle;
    this.headlamp.penumbra = this.lampOptics.penumbra;
    this.headlamp.decay = this.lampOptics.decay;
    this.lampMaxIntensity = this.lampOptics.intensity;
    this.lampGroup.scale.setScalar(this.lampLevel === 3 ? 1.18 : this.lampLevel === 2 ? 1.08 : 1);
  }

  /** Apply branch-adjusted beam values while retaining the visible lamp tier. */
  setLampStats(distance: number, intensity: number, angle: number, scatter = this.lampOptics.scatter, decay = this.lampOptics.decay, penumbra = this.lampOptics.penumbra, extinction = this.lampOptics.extinction) {
    this.lampOptics = {
      distance: THREE.MathUtils.clamp(Number.isFinite(distance) ? distance : 18, 1, 100),
      intensity: Math.max(1, Number.isFinite(intensity) ? intensity : 48),
      angle: THREE.MathUtils.clamp(Number.isFinite(angle) ? angle : 0.65, 0.2, 1.5),
      scatter: THREE.MathUtils.clamp(Number.isFinite(scatter) ? scatter : 0.12, 0, 1),
      decay: THREE.MathUtils.clamp(Number.isFinite(decay) ? decay : 2, 0, 4),
      penumbra: THREE.MathUtils.clamp(Number.isFinite(penumbra) ? penumbra : 0.55, 0, 1),
      extinction: Math.max(0, Number.isFinite(extinction) ? extinction : 0.03),
    };
    this.headlamp.distance = this.lampOptics.distance;
    this.headlamp.angle = this.lampOptics.angle;
    this.headlamp.penumbra = this.lampOptics.penumbra;
    this.headlamp.decay = this.lampOptics.decay;
    this.lampMaxIntensity = this.lampOptics.intensity;
  }

  /** Set the environmental mix used by the beam's depth transmission. */
  setLampEnvironment(nightMix: number, effectsEnabled = true) {
    this.lampNight = THREE.MathUtils.clamp(Number.isFinite(nightMix) ? nightMix : 0, 0, 1);
    this.lampEffects = effectsEnabled;
  }

  /**
   * Drive the direct spotlight and its low-poly suspended-particle volume.
   * Three.js applies the inverse-square falloff to the SpotLight itself; the
   * shared attenuation curve keeps the visible scatter beam in step with it.
   */
  private updateLamp(depth: number) {
    const activation = this.lampEffects ? lampActivation(depth, this.lampNight) : 0;
    this.headlamp.intensity = this.lampMaxIntensity * activation;

    const beamLength = Math.max(0.5, this.lampOptics.distance * 0.48);
    const beamRadius = Math.max(0.045, Math.tan(Math.min(this.lampOptics.angle, 1.3)) * beamLength * 0.1);
    this.lampBeam.position.set(1.4 + beamLength * 0.5, 0.2, 0.6);
    this.lampBeam.scale.set(beamRadius, beamLength, beamRadius);

    const transmission = lampDistanceAttenuation(beamLength * 0.55, this.lampOptics);
    const scatter = activation * this.lampOptics.scatter * (0.55 + transmission * 0.45);
    this.lampBeamMaterial.opacity = THREE.MathUtils.clamp(scatter * 0.68, 0, 0.22);
    this.lampBeam.visible = this.lampBeamMaterial.opacity > 0.001;

    if (this.lampLens) {
      const material = this.lampLens.material as THREE.MeshStandardMaterial;
      material.emissiveIntensity = activation > 0 ? 0.35 + activation * 1.7 : 0;
    }
  }

  private setLampOff() {
    this.headlamp.intensity = 0;
    this.lampBeamMaterial.opacity = 0;
    this.lampBeam.visible = false;
    if (this.lampLens) (this.lampLens.material as THREE.MeshStandardMaterial).emissiveIntensity = 0;
  }

  /** Configure how quickly the net can be swung again after a catch attempt. */
  setReelLevel(level: number) {
    const tier = THREE.MathUtils.clamp(Math.floor(level), 1, 3);
    this.setReelRecovery(1 + (tier - 1) * 0.2);
  }

  /** Apply branch-adjusted recovery to the visible swing animation. */
  setReelRecovery(recovery: number) {
    this.reelRecovery = THREE.MathUtils.clamp(recovery, 0.25, 3);
  }

  /** Sit on `seat` (an object on the boat) until jumpTo(). */
  sit(seat: THREE.Object3D) {
    this.seat = seat;
    this.jump = null;
    this.netSwing = 0;
  }

  get seated() {
    return this.seat !== null;
  }

  /** Off the seat and into the water at `to`. `pos` follows the arc, so the camera does too. */
  jumpTo(to: THREE.Vector3) {
    if (!this.seat) return;
    const from = this.seat.getWorldPosition(new THREE.Vector3());
    this.seat = null;
    this.jump = { t: 0, from, to: to.clone() };
    this.pos.copy(from);
    this.vel.set(0, 0, 0);
    this.facing = 1;
    this.group.rotation.set(0, 0, 0);
  }

  /** Off the seat without a jump: back to swimming at `pos`, wherever that is. */
  stand() {
    this.seat = null;
    this.jump = null;
    this.group.rotation.set(0, 0, 0);
    this.head.rotation.z = 0;
    this.showNet(true);
  }

  get jumping() {
    return this.jump !== null;
  }

  swing() {
    if (this.netSwing <= 0) this.netSwing = 1;
  }

  get swinging() {
    return this.netSwing > 0.45;
  }

  exhale(count = 8) {
    const amount = Math.min(Math.max(0, Math.round(count * this.bubbleEmitScale)), this.bubbleLimit - this.bubbles.length);
    this.group.position.copy(this.pos);
    this.group.updateMatrixWorld(true);
    this.breathPoint.getWorldPosition(this.breathOrigin);
    // Bubbles should not be emitted into the air when a noisy breath event
    // arrives just after the diver reaches the surface.
    if (this.breathOrigin.y >= -0.02) return;
    for (let i = 0; i < amount; i++) {
      this.bubbleOffset.set(
        (Math.random() - 0.5) * 0.12,
        (Math.random() - 0.5) * 0.16,
        (Math.random() - 0.5) * 0.22,
      ).add(this.breathOrigin);
      this.bubbleOffset.y = Math.min(-0.02, this.bubbleOffset.y);
      this.addBubble(
        this.bubbleOffset,
        (Math.random() - 0.5) * 0.8, 1.7 + Math.random() * 2.1, (Math.random() - 0.5) * 0.8,
        0.5 + Math.random() * 1.4, 2.4 + Math.random() * 1.2, 0.25,
      );
    }
  }

  /** `heave` lifts the drawn diver (m) without moving `pos`: a swimmer riding heavy seas. */
  update(dt: number, time: number, depth: number, heave = 0) {
    if (this.seat) {
      this.updateSeated(time);
      return;
    }
    if (this.jump) {
      this.updateJump(dt);
      return;
    }
    this.body.position.y += (0 - this.body.position.y) * Math.min(1, dt * 8);
    this.head.rotation.z += (0 - this.head.rotation.z) * Math.min(1, dt * 8);
    const speed = this.vel.length();
    if (Math.abs(this.vel.x) > 0.2) this.facing = this.vel.x > 0 ? 1 : -1;

    this.group.position.copy(this.pos);
    this.group.position.y += heave;
    const targetYaw = this.facing > 0 ? 0 : Math.PI;
    const yawDelta = THREE.MathUtils.euclideanModulo(targetYaw - this.group.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
    this.group.rotation.y += yawDelta * Math.min(1, dt * 8);
    // Pitch toward travel direction; float upright-ish at the surface.
    const pitch = depth < 0.8 ? 0.25 : THREE.MathUtils.clamp(Math.atan2(this.vel.y, Math.abs(this.vel.x) + 0.6), -1.1, 1.1);
    this.body.rotation.z += (pitch - this.body.rotation.z) * Math.min(1, dt * 5);
    const roll = THREE.MathUtils.clamp(-this.vel.z * 0.18, -0.22, 0.22);
    this.body.rotation.x += (roll - this.body.rotation.x) * Math.min(1, dt * 4);

    // Integrate the stroke phase so changing speed never jumps to a new pose.
    this.kickPhase = (this.kickPhase + dt * (4 + speed * 1.8)) % (Math.PI * 2);
    this.armPhase = (this.armPhase + dt * (2.2 + speed * 0.45)) % (Math.PI * 2);
    const kick = Math.sin(this.kickPhase) * (0.18 + Math.min(speed, 6) * 0.075);
    this.legL.rotation.z = kick;
    this.legR.rotation.z = -kick * 0.92;
    this.freeArm.rotation.z = -0.1 + Math.sin(this.armPhase) * (0.08 + Math.min(speed, 5) * 0.018);

    if (this.netSwing > 0) {
      this.netSwing = Math.max(0, this.netSwing - dt * 3.2 * this.reelRecovery);
      const s = Math.sin(this.netSwing * Math.PI);
      this.netArm.rotation.z = -0.9 + s * 1.6;
    } else {
      this.netArm.rotation.z = -0.35 + Math.sin(time * 1.5) * 0.05;
    }

    this.updateLamp(depth);
    this.updateWaterContact(dt, heave);

    this.bubbleUpdateAccumulator += dt;
    const interval = 1 / this.bubbleHz;
    if (this.bubbleUpdateAccumulator + 1e-6 < interval) return;
    const bubbleDt = Math.min(this.bubbleUpdateAccumulator, 0.1);
    this.bubbleUpdateAccumulator = 0;
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.life -= bubbleDt;
      b.mesh.position.addScaledVector(b.vel, bubbleDt);
      b.vel.y = Math.min(4.8, b.vel.y + bubbleDt * b.lift);
      const drag = Math.exp(-bubbleDt * 0.85);
      b.vel.x *= drag;
      b.vel.z *= drag;
      b.vel.x += Math.sin(time * 5.5 + b.phase) * bubbleDt * 0.55;
      b.vel.z += Math.cos(time * 4.2 + b.phase) * bubbleDt * 0.35;
      const age = 1 - Math.max(0, b.life) / b.maxLife;
      const fade = age > 0.74 ? THREE.MathUtils.clamp((1 - age) / 0.26, 0, 1) : 1;
      b.mesh.scale.setScalar(b.size * (0.86 + age * 0.42) * fade);
      if (b.life <= 0 || b.mesh.position.y > this.waterAt(b.mesh.position.x, b.mesh.position.z)) {
        this.scene.remove(b.mesh);
        this.bubbles.splice(i, 1);
      }
    }
  }

  /** On the bow, rocking with the boat; the legs swing idly over the edge. */
  private updateSeated(time: number) {
    const seat = this.seat!;
    seat.getWorldPosition(this.group.position);
    seat.getWorldQuaternion(this.group.quaternion);
    this.body.rotation.z = SIT_TORSO;
    this.body.position.y = SIT_HIPS;
    this.legL.rotation.z = SIT_LEGS + Math.sin(time * 1.3) * 0.12;
    this.legR.rotation.z = SIT_LEGS + Math.sin(time * 1.3 + 1.9) * 0.12;
    this.netArm.rotation.z = SIT_ARM + Math.sin(time * 0.9) * 0.04;
    this.showNet(false);
    this.head.rotation.z = SIT_HEAD + Math.sin(time * 0.5) * 0.06;
    this.setLampOff();
  }

  /** The arc off the bow: up and out, then down into the water, rolling head first. */
  private updateJump(dt: number) {
    this.setLampOff();
    const j = this.jump!;
    j.t = Math.min(1, j.t + dt / JUMP_S);
    const u = j.t;
    this.pos.lerpVectors(j.from, j.to, u);
    this.pos.y += Math.sin(Math.PI * u) * JUMP_HEIGHT;
    this.group.position.copy(this.pos);
    const e = easeInOut(u);
    this.body.rotation.z = SIT_TORSO + (DIVE_PITCH - SIT_TORSO) * e;
    this.body.position.y = SIT_HIPS * (1 - e);
    // Legs straighten out behind, net tucks in.
    this.legL.rotation.z = this.legR.rotation.z = SIT_LEGS * (1 - e);
    this.netArm.rotation.z = SIT_ARM + (-0.35 - SIT_ARM) * e;
    this.showNet(u > 0.5);
    this.head.rotation.z = SIT_HEAD * (1 - e);
    if (u < 1) return;
    this.jump = null;
    // Carry the dive on into the water, with a splash of bubbles.
    this.vel.set(2.5, -3.5, 0);
    this.exhale(14);
  }

  /** The net in hand or put away; the arm it hangs from (the group's first part) always shows. */
  private showNet(on: boolean) {
    this.netArm.children.forEach((part, i) => {
      if (i > 0) part.visible = on;
    });
  }
}
