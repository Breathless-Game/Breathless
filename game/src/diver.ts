import * as THREE from 'three';

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
  private netArm: THREE.Group;
  private netSwing = 0;
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

    // Arm holding the net, pivoting at the shoulder.
    this.netArm = new THREE.Group();
    this.netArm.position.set(0.6, 0, 0.3);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.14, 0.14), suit);
    arm.position.x = 0.35;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.4, 4), mat('#c9c9c9'));
    pole.rotation.z = Math.PI / 2;
    pole.position.x = 1.3;
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.04, 4, 8), mat('#ffd166'));
    hoop.position.x = 2.4;
    hoop.rotation.y = Math.PI / 2;
    const mesh = new THREE.Mesh(
      new THREE.ConeGeometry(0.42, 0.7, 8, 1, true),
      mat('#f5f5f5', { transparent: true, opacity: 0.45, side: THREE.DoubleSide, wireframe: true }),
    );
    mesh.rotation.z = Math.PI / 2;
    mesh.position.x = 2.05;
    this.netArm.add(arm, pole, hoop, mesh);
    this.body.add(this.netArm);

    this.group.add(this.body);
    this.headlamp = new THREE.PointLight('#fff1c4', 0, 22, 1.6);
    this.headlamp.position.set(1.4, 0.2, 0.6);
    this.group.add(this.headlamp);
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
    return leg;
  }

  /** Point of the net hoop in world space: where catches happen. */
  netPoint(): THREE.Vector3 {
    return new THREE.Vector3(this.pos.x + this.facing * 2.6, this.pos.y, 0);
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
      this.netSwing = Math.max(0, this.netSwing - dt * 3.2);
      const s = Math.sin(this.netSwing * Math.PI);
      this.netArm.rotation.z = -0.9 + s * 1.6;
    } else {
      this.netArm.rotation.z = -0.35 + Math.sin(time * 1.5) * 0.05;
    }

    this.headlamp.intensity = THREE.MathUtils.clamp((depth - 18) / 30, 0, 1) * 60;

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
