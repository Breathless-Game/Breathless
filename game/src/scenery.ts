import * as THREE from 'three';
import { Batch, flatMat, jitter, paintFaces, pyramid } from './lowpoly';
import type { MapDef, MapId } from './maps';
import { Rng } from './rng';

// What you see above the water on each map: the fjord's snow peaks and cabins,
// Heaven Lake's stone pillars and mist, the ocean's storm front and lighthouse.
// The camera sits at z = +22 looking toward -z, so everything lives behind the
// boat. Static pieces are batched; only a few animated meshes stay separate.

export interface Scenery {
  group: THREE.Group;
  /** Animate the living parts (aurora, mist, lamps, lightning). */
  update(time: number, night: boolean): void;
}

const BUILDERS: Record<MapId, () => Scenery> = { fjord: buildFjord, tianchi: buildTianchi, ocean: buildOcean };

export function buildScenery(map: MapDef): Scenery {
  return BUILDERS[map.id]();
}

const shades = (hexes: string[]) => hexes.map((h) => new THREE.Color(h));

/** A warm light source that only shines at night. */
function lampMat(color = '#ffd58a') {
  return new THREE.MeshStandardMaterial({ color: '#5b4a33', emissive: color, emissiveIntensity: 0, flatShading: true });
}

// ---- Fjord (Norway / Iceland) -------------------------------------------

function buildFjord(): Scenery {
  const rng = new Rng(0xf10d);
  const batch = new Batch();
  const group = new THREE.Group();

  const painted = flatMat('#ffffff', { vertexColors: true });
  const rock = shades(['#4d5d6b', '#3f4d59', '#5a6a77']);
  const snow = shades(['#f4fbff', '#dcecf5']);
  const peak = (x: number, z: number, r: number, h: number) => {
    const snowline = rng.range(0.42, 0.58);
    const geo = jitter(new THREE.ConeGeometry(r, h, 7, 4), rng, r * 0.09);
    paintFaces(geo, (t) => (t > snowline + rng.range(-0.1, 0.1) ? rng.pick(snow) : rng.pick(rock)));
    batch.add(geo, painted, x, h / 2 - 2, z, { ry: rng.range(0, 6) });
  };
  // Far range, then a nearer range that leaves the middle open like a channel.
  for (let x = -220; x <= 220; x += 55) peak(x + rng.range(-12, 12), rng.range(-130, -108), rng.range(30, 44), rng.range(48, 74));
  for (const x of [-168, -112, -60, 60, 112, 168]) {
    peak(x + rng.range(-8, 8), rng.range(-96, -82), rng.range(18, 28), rng.range(26, 42));
  }

  // Wooded shore at the foot of the near range.
  const shore = flatMat('#565c58');
  const pine = [flatMat('#1f4d3a'), flatMat('#2a6048')];
  for (let i = 0; i < 12; i++) {
    const side = i % 2 ? 1 : -1;
    const mx = side * rng.range(34, 180);
    const mz = rng.range(-76, -62);
    const mr = rng.range(7, 13);
    batch.add(jitter(new THREE.IcosahedronGeometry(mr, 0), rng, mr * 0.15), shore, mx, -0.8, mz, { sy: 0.3 });
    for (let t = 0; t < 4; t++) {
      const h = rng.range(3.2, 5.6);
      const x = mx + rng.range(-0.6, 0.6) * mr;
      const z = mz + rng.range(-0.4, 0.4) * mr;
      const y = -0.8 + mr * 0.2;
      const mat = rng.pick(pine);
      batch.add(new THREE.ConeGeometry(h * 0.34, h * 0.7, 6), mat, x, y + h * 0.35, z);
      batch.add(new THREE.ConeGeometry(h * 0.24, h * 0.55, 6), mat, x, y + h * 0.72, z);
    }
  }

  // Two fishing cabins and a pier on an islet off to the left.
  const islet = flatMat('#4f5a60');
  batch.add(jitter(new THREE.IcosahedronGeometry(8, 0), rng, 1), islet, -34, -0.4, -47, { sy: 0.2 });
  const roof = flatMat('#2b3138');
  const trim = flatMat('#f1eee6');
  const wood = flatMat('#7a5a3c');
  const cabin = (x: number, z: number, w: number, h: number, d: number, color: string) => {
    batch.add(new THREE.BoxGeometry(w, h, d), flatMat(color), x, 1.2 + h / 2, z);
    batch.add(pyramid(w + 1, h * 0.7, d + 1), roof, x, 1.2 + h, z);
    batch.add(new THREE.BoxGeometry(0.9, 1.7, 0.1), trim, x - w * 0.25, 1.2 + 0.85, z + d / 2 + 0.05);
  };
  cabin(-37, -46, 5, 3, 4, '#b5392f');
  cabin(-28.5, -49, 3.6, 2.4, 3, '#d9a441');
  batch.add(new THREE.BoxGeometry(8, 0.25, 1.3), wood, -31, 0.75, -42.6);
  for (const px of [-34.5, -31, -27.5]) batch.add(new THREE.CylinderGeometry(0.14, 0.14, 1.6, 5), wood, px, 0, -42.1);

  const ice = flatMat('#e9f7fb', { roughness: 0.5 });
  for (let i = 0; i < 9; i++) {
    const r = rng.range(1.6, 3.6);
    const x = (i % 2 ? 1 : -1) * rng.range(12, 90);
    batch.add(jitter(new THREE.IcosahedronGeometry(r, 0), rng, r * 0.18), ice, x, 0.1, rng.range(-55, -10), { sy: 0.12 });
  }
  group.add(batch.build());

  const windows = lampMat();
  const windowGeo = new THREE.BoxGeometry(1, 0.9, 0.1);
  for (const [x, y, z] of [[-35.8, 3.1, -43.95], [-28, 2.7, -47.45]]) {
    const w = new THREE.Mesh(windowGeo, windows);
    w.position.set(x, y, z);
    group.add(w);
  }

  // Aurora: ribbons that are bright along the bottom edge and fade upward.
  const ribbons: { mesh: THREE.Mesh; base: Float32Array; phase: number }[] = [];
  const tints = ['#4dffb0', '#58e6ff', '#9dff7a'];
  for (let i = 0; i < 3; i++) {
    const geo = new THREE.PlaneGeometry(300, 22, 48, 1);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const tint = new THREE.Color(tints[i]);
    for (let v = 0; v < pos.count; v++) if (pos.getY(v) < 0) tint.toArray(colors, v * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        side: THREE.DoubleSide,
      }),
    );
    mesh.position.set(rng.range(-30, 30), 44 + i * 9, -150 - i * 6);
    mesh.visible = false;
    ribbons.push({ mesh, base: (pos.array as Float32Array).slice(), phase: rng.range(0, 6) });
    group.add(mesh);
  }

  return {
    group,
    update(time, night) {
      windows.emissiveIntensity = night ? 1.8 : 0;
      for (const r of ribbons) {
        r.mesh.visible = night;
        if (!night) continue;
        (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.42 + Math.sin(time * 0.35 + r.phase) * 0.14;
        const pos = r.mesh.geometry.attributes.position;
        for (let v = 0; v < pos.count; v++) {
          const x = r.base[v * 3];
          pos.setY(v, r.base[v * 3 + 1] + Math.sin(x * 0.03 + time * 0.22 + r.phase) * 5);
          pos.setZ(v, Math.sin(x * 0.018 + time * 0.3 + r.phase) * 12);
        }
        pos.needsUpdate = true;
      }
    },
  };
}

// ---- Heaven Lake (Zhangjiajie / Changbai) -------------------------------

function buildTianchi(): Scenery {
  const rng = new Rng(0x71a2c1);
  const batch = new Batch();
  const group = new THREE.Group();

  const painted = flatMat('#ffffff', { vertexColors: true });
  const stone = shades(['#8a8672', '#77735f', '#9a957f', '#6c6855']);
  const moss = shades(['#3f6b3a', '#2f5a35']);
  const bush = [flatMat('#3f6b3a'), flatMat('#2f5a35')];

  // Sandstone pillars: tall, slightly tapered, green on top.
  const pillar = (x: number, z: number, top: number, h: number) => {
    const geo = jitter(new THREE.CylinderGeometry(top, top * rng.range(1.5, 1.9), h, 7, 5), rng, top * 0.22);
    paintFaces(geo, (t) => (t > 0.9 || (t > 0.3 && rng.next() < 0.07) ? rng.pick(moss) : rng.pick(stone)));
    batch.add(geo, painted, x, h / 2 - 3, z, { ry: rng.range(0, 6) });
    const crown = h - 3;
    batch.add(jitter(new THREE.IcosahedronGeometry(top * 1.2, 0), rng, top * 0.2), rng.pick(bush), x, crown, z, { sy: 0.5 });
    for (let t = 0; t < rng.int(1, 3); t++) {
      const th = rng.range(3, 5.5);
      batch.add(new THREE.ConeGeometry(th * 0.3, th, 6), rng.pick(bush), x + rng.range(-0.5, 0.5) * top, crown + th / 2, z + rng.range(-0.5, 0.5) * top);
    }
  };
  for (let i = 0; i < 16; i++) {
    pillar(-200 + i * 26.5 + rng.range(-9, 9), rng.range(-125, -75), rng.range(3, 6.5), rng.range(34, 78));
  }
  // A few close ones on each side frame the lake.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) pillar(side * rng.range(78, 125), rng.range(-62, -42), rng.range(3.5, 5.5), rng.range(42, 64));
  }

  // The crater rim behind everything, with a dusting of snow.
  const rim = shades(['#55655e', '#4a5952', '#60706a']);
  const frost = new THREE.Color('#e4efec');
  for (let x = -240; x <= 240; x += 60) {
    const r = rng.range(46, 64);
    const h = rng.range(20, 30);
    const geo = jitter(new THREE.ConeGeometry(r, h, 6, 2), rng, r * 0.06);
    paintFaces(geo, (t) => (t > 0.72 && rng.next() < 0.6 ? frost : rng.pick(rim)));
    batch.add(geo, painted, x + rng.range(-10, 10), h / 2 - 2, -140);
  }

  // A lakeside pavilion on a rock.
  batch.add(jitter(new THREE.IcosahedronGeometry(7, 0), rng, 0.9), flatMat('#5b5a4c'), 34, -0.3, -50, { sy: 0.24 });
  batch.add(new THREE.CylinderGeometry(3.5, 3.9, 0.6, 6), flatMat('#b9b3a1'), 34, 1.7, -50);
  const post = flatMat('#a8352a');
  for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
    batch.add(new THREE.CylinderGeometry(0.17, 0.17, 2.6, 5), post, 34 + dx, 3.3, -50 + dz);
  }
  batch.add(pyramid(6.6, 1.5, 6.6), flatMat('#2f4f48'), 34, 4.6, -50);
  batch.add(pyramid(2.2, 1.3, 2.2), flatMat('#c9a14a'), 34, 5.9, -50);
  group.add(batch.build());

  const lantern = lampMat('#ffb86b');
  const lamp = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), lantern);
  lamp.position.set(34, 3.9, -50);
  group.add(lamp);

  // Mist banks drifting over the water. Thicker at night.
  const mistMat = new THREE.MeshBasicMaterial({ color: '#f2f7f4', transparent: true, opacity: 0.18, depthWrite: false });
  const mist: { mesh: THREE.Mesh; speed: number }[] = [];
  for (let i = 0; i < 9; i++) {
    const r = rng.range(16, 30);
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), mistMat);
    mesh.scale.set(1, 0.1, 0.45);
    mesh.position.set(rng.range(-180, 180), rng.range(1.5, 7), rng.range(-95, -38));
    mist.push({ mesh, speed: rng.range(0.6, 1.6) * (i % 2 ? 1 : -1) });
    group.add(mesh);
  }

  let last = 0;
  return {
    group,
    update(time, night) {
      const dt = Math.min(Math.max(time - last, 0), 0.1);
      last = time;
      lantern.emissiveIntensity = night ? 2 : 0;
      mistMat.opacity = night ? 0.3 : 0.18;
      for (const m of mist) {
        m.mesh.position.x += m.speed * dt;
        if (m.mesh.position.x > 210) m.mesh.position.x = -210;
        if (m.mesh.position.x < -210) m.mesh.position.x = 210;
      }
    },
  };
}

// ---- Open Ocean ---------------------------------------------------------

function buildOcean(): Scenery {
  const rng = new Rng(0x0cea17);
  const batch = new Batch();
  const group = new THREE.Group();

  // Clouds sit beyond the fog range, so they opt out of fog to stay visible. They are
  // seen from below, where only the dim ground light reaches, so they glow slightly.
  const storm = [
    flatMat('#56616f', { fog: false, emissive: '#dfeaff', emissiveIntensity: 0 }),
    flatMat('#6c7888', { fog: false, emissive: '#dfeaff', emissiveIntensity: 0 }),
  ];
  const fair = flatMat('#f3f9fc', { fog: false, emissive: '#f3f9fc', emissiveIntensity: 0.5 });
  const cloud = (x: number, y: number, z: number, blobs: number, size: [number, number], mats: THREE.Material[]) => {
    for (let i = 0; i < blobs; i++) {
      const r = rng.range(size[0], size[1]);
      const geo = jitter(new THREE.IcosahedronGeometry(r, 1), rng, r * 0.14);
      batch.add(geo, rng.pick(mats), x + rng.range(-38, 38), y + rng.range(-5, 5), z + rng.range(-8, 8), { sy: 0.45 });
    }
  };
  // The storm front fills the left of the sky; the right is still clear.
  cloud(-160, 52, -168, 9, [16, 28], storm);
  cloud(-80, 60, -176, 9, [16, 28], storm);
  cloud(-10, 52, -170, 7, [14, 24], storm);
  cloud(110, 60, -172, 4, [9, 15], [fair]);
  cloud(190, 52, -168, 3, [8, 13], [fair]);

  const stack = flatMat('#3f4a55');
  for (const [x, z] of [[-118, -92], [-64, -98], [38, -106], [128, -88]]) {
    const r = rng.range(4, 7);
    const h = rng.range(9, 20);
    batch.add(jitter(new THREE.ConeGeometry(r, h, 6, 3), rng, r * 0.2), stack, x, h / 2 - 2, z);
  }

  // Lighthouse on a rock to the right.
  const [lx, lz] = [64, -88];
  batch.add(jitter(new THREE.IcosahedronGeometry(9, 0), rng, 1.2), stack, lx, 0.5, lz, { sy: 0.5 });
  const red = flatMat('#c0392b');
  batch.add(new THREE.CylinderGeometry(1.5, 2.3, 13, 8), flatMat('#f1eee6'), lx, 10.5, lz);
  batch.add(new THREE.CylinderGeometry(1.95, 2.08, 2.4, 8), red, lx, 9, lz);
  batch.add(new THREE.CylinderGeometry(2.4, 2.4, 0.3, 8), flatMat('#2b3138'), lx, 17.15, lz);
  batch.add(new THREE.ConeGeometry(1.7, 1.4, 6), red, lx, 19.75, lz);
  group.add(batch.build());

  const beacon = lampMat('#ffe9a8');
  const lampRoom = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 1.75, 6), beacon);
  lampRoom.position.set(lx, 18.2, lz);
  group.add(lampRoom);

  let flash = 0;
  return {
    group,
    update(time, night) {
      // Sheet lightning: a rare deterministic strike that decays over a few frames.
      const slot = Math.floor(time * 4);
      const roll = Math.abs(Math.sin(slot * 12.9898) * 43758.5453) % 1;
      flash = Math.max(flash * 0.85, roll > 0.965 ? 1 : 0);
      for (const m of storm) m.emissiveIntensity = 0.14 + flash * 0.9;
      // The lamp turns: bright when it sweeps past the viewer.
      beacon.emissiveIntensity = night ? 0.6 + Math.max(0, Math.sin(time * 1.6)) * 2.4 : 0;
    },
  };
}
