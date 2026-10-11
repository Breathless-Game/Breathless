import * as THREE from 'three';
import { buildFishingNetMesh } from './gear';
import type { RenderQuality } from './render-quality';

function mat(color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.7, ...extra });
}

/** Low-poly freediver, modelled lying along +x (head first). */
export class Diver {
  group = new THREE.Group();
  pos = new THREE.Vector3(0, -0.4, 0);
  vel = new THREE.Vector3();
  facing = 1;
  headlamp: THREE.PointLight;
  private body = new THREE.Group();
  private legL: THREE.Group;
  private legR: THREE.Group;
  private freeArm: THREE.Group;
  private netArm: THREE.Group;
  private netMouth: THREE.Group;
  private netTip: THREE.Object3D;
  private breathPoint: THREE.Object3D;
  private breathOrigin = new THREE.Vector3();
  private bubbleOffset = new THREE.Vector3();
  private netPointWorld = new THREE.Vector3();
  private netSwing = 0;
  private kickPhase = 0;
  private armPhase = 1.2;
  private bubbles: { mesh: THREE.Mesh; vel: THREE.Vector3; life: number; maxLife: number; size: number; phase: number }[] = [];
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
  private waterRing: THREE.Mesh;
  private waterRingMat: THREE.MeshStandardMaterial;
  private lastWaterDepth = 0.4;
  private waterPulse = 0;
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
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 0), skin);
    head.position.x = 1.0;
    const hood = new THREE.Mesh(new THREE.IcosahedronGeometry(0.36, 0), suit);
    hood.position.set(0.95, 0.06, 0);
    hood.scale.set(0.9, 0.85, 1.02);
    const mask = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, 0.44), mat('#5fe1ff', { metalness: 0.6, roughness: 0.15 }));
    mask.position.set(1.28, 0.05, 0);
    const snorkel = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.6, 4), accent);
    snorkel.position.set(1.0, 0.45, 0.25);
    this.body.add(torso, stripe, hood, head, mask, snorkel);
    this.breathPoint = new THREE.Object3D();
    this.breathPoint.position.set(1.23, 0.34, 0.16);
    this.body.add(this.breathPoint);

    this.legL = this.makeLeg(suit, accent, 0.16);
    this.legR = this.makeLeg(suit, accent, -0.16);
    this.body.add(this.legL, this.legR);
    this.freeArm = this.makeFreeArm(suit, skin, -0.28);
    this.body.add(this.freeArm);

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
    this.waterRingMat = new THREE.MeshStandardMaterial({
      color: '#b9f5ff',
      emissive: '#2d92a8',
      emissiveIntensity: 0.35,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      roughness: 0.2,
      side: THREE.DoubleSide,
    });
    this.waterRing = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.028, 6, 32), this.waterRingMat);
    this.waterRing.name = 'diver-water-contact-ripple';
    this.waterRing.position.y = this.lastWaterDepth + 0.03;
    this.waterRing.renderOrder = 2;
    this.waterRing.visible = false;
    this.group.add(this.waterRing);
    this.headlamp = new THREE.PointLight('#fff1c4', 0, 22, 1.6);
    this.headlamp.position.set(1.4, 0.2, 0.6);
    this.body.add(this.headlamp);
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

  /**
   * Show the diver's contact with the waterline. It is a single shared ring:
   * continuous ripples stay cheap near the surface and a short pulse marks
   * each entry or exit without spawning extra meshes.
   */
  private updateWaterContact(dt: number, time: number, depth: number): void {
    const safeDepth = THREE.MathUtils.clamp(Number.isFinite(depth) ? depth : 60, 0, 60);
    const nearSurface = THREE.MathUtils.clamp(1 - safeDepth / 1.8, 0, 1);
    if ((this.lastWaterDepth > 0.32 && safeDepth <= 0.32) || (this.lastWaterDepth <= 0.32 && safeDepth > 0.32)) {
      this.waterPulse = 1;
    }
    this.lastWaterDepth = safeDepth;
    this.waterPulse = Math.max(0, this.waterPulse - Math.max(0, dt) * 2.2);

    this.waterRing.position.set(0, safeDepth + 0.03, 0);
    this.waterRing.rotation.y = time * 0.22;
    const pulse = this.waterPulse;
    this.waterRing.visible = nearSurface > 0.01 || pulse > 0.01;
    if (!this.waterRing.visible) return;
    const spread = 0.82 + (1 - nearSurface) * 0.36 + pulse * 0.82;
    this.waterRing.scale.setScalar(spread);
    this.waterRingMat.opacity = THREE.MathUtils.clamp(nearSurface * 0.18 + pulse * 0.38, 0, 0.56);
    this.waterRingMat.emissiveIntensity = 0.18 + nearSurface * 0.28 + pulse * 0.72;
  }

  private makeLeg(suit: THREE.Material, accent: THREE.Material, z: number) {
    const leg = new THREE.Group();
    leg.position.set(-0.7, 0, z);
    const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.2, 0.2), suit);
    thigh.position.x = -0.45;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.04, 0.34), accent);
    fin.position.x = -1.3;
    leg.add(thigh, fin);
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
    const scale = 1 + THREE.MathUtils.clamp(level - 1, 0, 2) * 0.15;
    this.netMouth.scale.setScalar(scale);
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
      const b = new THREE.Mesh(this.bubbleGeo, this.bubbleMat);
      this.bubbleOffset.set(
        (Math.random() - 0.5) * 0.12,
        (Math.random() - 0.5) * 0.16,
        (Math.random() - 0.5) * 0.22,
      );
      b.position.copy(this.breathOrigin).add(this.bubbleOffset);
      b.position.y = Math.min(-0.02, b.position.y);
      const size = 0.5 + Math.random() * 1.4;
      b.scale.setScalar(size);
      this.scene.add(b);
      // Bubbles are created after the initial scene traversal. Apply the
      // shared day/night and underwater color-grade hook to their material.
      this.materialBinder?.(b);
      const maxLife = 2.4 + Math.random() * 1.2;
      this.bubbles.push({
        mesh: b,
        vel: new THREE.Vector3((Math.random() - 0.5) * 0.8, 1.7 + Math.random() * 2.1, (Math.random() - 0.5) * 0.8),
        life: maxLife,
        maxLife,
        size,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  update(dt: number, time: number, depth: number) {
    const speed = this.vel.length();
    if (Math.abs(this.vel.x) > 0.2) this.facing = this.vel.x > 0 ? 1 : -1;

    this.group.position.copy(this.pos);
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
      this.netSwing = Math.max(0, this.netSwing - dt * 3.2);
      const s = Math.sin(this.netSwing * Math.PI);
      this.netArm.rotation.z = -0.9 + s * 1.6;
    } else {
      this.netArm.rotation.z = -0.35 + Math.sin(time * 1.5) * 0.05;
    }

    this.headlamp.intensity = THREE.MathUtils.clamp((depth - 18) / 30, 0, 1) * 60;
    this.updateWaterContact(dt, time, depth);

    this.bubbleUpdateAccumulator += dt;
    const interval = 1 / this.bubbleHz;
    if (this.bubbleUpdateAccumulator + 1e-6 < interval) return;
    const bubbleDt = Math.min(this.bubbleUpdateAccumulator, 0.1);
    this.bubbleUpdateAccumulator = 0;
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.life -= bubbleDt;
      b.mesh.position.addScaledVector(b.vel, bubbleDt);
      b.vel.y = Math.min(4.8, b.vel.y + bubbleDt * 0.25);
      const drag = Math.exp(-bubbleDt * 0.85);
      b.vel.x *= drag;
      b.vel.z *= drag;
      b.vel.x += Math.sin(time * 5.5 + b.phase) * bubbleDt * 0.55;
      b.vel.z += Math.cos(time * 4.2 + b.phase) * bubbleDt * 0.35;
      const age = 1 - Math.max(0, b.life) / b.maxLife;
      const fade = age > 0.74 ? THREE.MathUtils.clamp((1 - age) / 0.26, 0, 1) : 1;
      b.mesh.scale.setScalar(b.size * (0.86 + age * 0.42) * fade);
      if (b.life <= 0 || b.mesh.position.y > 0) {
        this.scene.remove(b.mesh);
        this.bubbles.splice(i, 1);
      }
    }
  }
}
