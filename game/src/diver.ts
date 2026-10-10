import * as THREE from 'three';
import { buildFishingNetMesh } from './gear';

function mat(color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.7, ...extra });
}

/** Low-poly freediver, modelled lying along +x (head first). */
export class Diver {
  group = new THREE.Group();
  pos = new THREE.Vector3(0, -0.4, 0);
  vel = new THREE.Vector3();
  facing = 1;
  headlamp: THREE.SpotLight;
  private body = new THREE.Group();
  private legL: THREE.Group;
  private legR: THREE.Group;
  private finL!: THREE.Mesh;
  private finR!: THREE.Mesh;
  private netArm: THREE.Group;
  private netTip: THREE.Object3D;
  /** Visible emergency-tank model; level one deliberately has no cylinder. */
  private tankGroup = new THREE.Group();
  private tankBody: THREE.Mesh | null = null;
  /** Small head-mounted lamp housing, separate from the actual PointLight. */
  private lampGroup = new THREE.Group();
  private lampLens: THREE.Mesh | null = null;
  private lampLevel = 1;
  private netPointWorld = new THREE.Vector3();
  private netSwing = 0;
  private netScale = 1;
  private rodReachScale = 1;
  private reelRecovery = 1;
  private bubbles: { mesh: THREE.Mesh; vel: THREE.Vector3; life: number }[] = [];
  private bubbleGeo = new THREE.IcosahedronGeometry(0.12, 0);
  private bubbleMat = new THREE.MeshStandardMaterial({
    color: '#e9fbff',
    transparent: true,
    opacity: 0.7,
    flatShading: true,
    roughness: 0.1,
  });

  constructor(private scene: THREE.Scene) {
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

    this.legL = this.makeLeg(suit, accent, 0.16);
    this.legR = this.makeLeg(suit, accent, -0.16);
    this.body.add(this.legL, this.legR);

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

    this.lampGroup.position.set(1.42, 0.18, 0.28);
    this.lampGroup.rotation.x = Math.PI / 2;
    this.lampLens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.12, 0.18, 6),
      mat('#7ff7ff', { emissive: '#43e9e1', emissiveIntensity: 2.4, metalness: 0.1, roughness: 0.25 }),
    );
    this.lampGroup.add(this.lampLens);
    this.body.add(this.lampGroup);

    // The old design called this item a fishing rod; the fused game design
    // uses its shaft and hoop as an underwater net. Keep the model pivot at
    // the shoulder so the whole tool follows the swing animation.
    const net = buildFishingNetMesh();
    this.netArm = net.group;
    this.netArm.position.set(0.6, 0, 0.3);
    this.netTip = net.tip;
    this.body.add(this.netArm);

    this.group.add(this.body);
    // A spotlight gives the diver a readable forward beam at depth. Its
    // target is parented to the body, so yaw/pitch animation carries the beam
    // with the diver instead of leaving a world-space light behind.
    this.headlamp = new THREE.SpotLight('#fff1c4', 0, 22, 0.65, 0.55, 1.6);
    this.headlamp.position.set(1.4, 0.2, 0.6);
    this.headlamp.target.position.set(4.5, 0.05, 0.6);
    this.body.add(this.headlamp, this.headlamp.target);
    scene.add(this.group);
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

  /** Point of the net hoop in world space: where catches happen. */
  netPoint(): THREE.Vector3 {
    this.netTip.getWorldPosition(this.netPointWorld);
    return this.netPointWorld.clone();
  }

  /** Make the visible hoop grow with the equipped net tier. */
  setNetLevel(level: number) {
    this.netScale = 1 + THREE.MathUtils.clamp(level - 1, 0, 2) * 0.12;
    this.updateNetScale();
  }

  /** Extend the visible shaft/hoop for the separate rod-body upgrade slot. */
  setRodLevel(level: number) {
    this.rodReachScale = 1 + THREE.MathUtils.clamp(level - 1, 0, 2) * 0.12;
    this.updateNetScale();
  }

  private updateNetScale() {
    this.netArm.scale.set(this.netScale * this.rodReachScale, this.netScale, this.netScale);
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
    this.headlamp.distance = [18, 28, 38][this.lampLevel - 1];
    this.headlamp.angle = [0.65, 0.85, 1.05][this.lampLevel - 1];
    this.lampGroup.scale.setScalar(this.lampLevel === 3 ? 1.18 : this.lampLevel === 2 ? 1.08 : 1);
  }

  /** Configure how quickly the net can be swung again after a catch attempt. */
  setReelLevel(level: number) {
    const tier = THREE.MathUtils.clamp(Math.floor(level), 1, 3);
    this.reelRecovery = 1 + (tier - 1) * 0.2;
  }

  swing() {
    if (this.netSwing <= 0) this.netSwing = 1;
  }

  get swinging() {
    return this.netSwing > 0.45;
  }

  exhale(count = 8) {
    for (let i = 0; i < count; i++) {
      const b = new THREE.Mesh(this.bubbleGeo, this.bubbleMat);
      b.position.set(this.pos.x + this.facing * 1.1, this.pos.y + 0.3, this.pos.z);
      b.scale.setScalar(0.5 + Math.random() * 1.4);
      this.scene.add(b);
      this.bubbles.push({
        mesh: b,
        vel: new THREE.Vector3((Math.random() - 0.5) * 0.8, 2 + Math.random() * 2.5, (Math.random() - 0.5) * 0.8),
        life: 3,
      });
    }
  }

  update(dt: number, time: number, depth: number) {
    const speed = this.vel.length();
    if (Math.abs(this.vel.x) > 0.2) this.facing = this.vel.x > 0 ? 1 : -1;

    this.group.position.copy(this.pos);
    const targetYaw = this.facing > 0 ? 0 : Math.PI;
    this.group.rotation.y += (targetYaw - this.group.rotation.y) * Math.min(1, dt * 8);
    // Pitch toward travel direction; float upright-ish at the surface.
    const pitch = depth < 0.8 ? 0.25 : THREE.MathUtils.clamp(Math.atan2(this.vel.y, Math.abs(this.vel.x) + 0.6), -1.1, 1.1);
    this.body.rotation.z += (pitch - this.body.rotation.z) * Math.min(1, dt * 5);

    const kick = Math.sin(time * (4 + speed * 1.8)) * (0.25 + Math.min(speed, 6) * 0.06);
    this.legL.rotation.z = kick;
    this.legR.rotation.z = -kick;

    if (this.netSwing > 0) {
      this.netSwing = Math.max(0, this.netSwing - dt * 3.2 * this.reelRecovery);
      const s = Math.sin(this.netSwing * Math.PI);
      this.netArm.rotation.z = -0.9 + s * 1.6;
    } else {
      this.netArm.rotation.z = -0.35 + Math.sin(time * 1.5) * 0.05;
    }

    this.headlamp.intensity = THREE.MathUtils.clamp((depth - 18) / 30, 0, 1) * [48, 64, 82][this.lampLevel - 1];

    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.life -= dt;
      b.mesh.position.addScaledVector(b.vel, dt);
      b.vel.x += Math.sin(time * 6 + i) * dt * 0.6;
      if (b.life <= 0 || b.mesh.position.y > 0) {
        this.scene.remove(b.mesh);
        this.bubbles.splice(i, 1);
      }
    }
  }
}
