import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Diver } from './diver';
import { buildFishMesh, RARITY, rollFish, type FishSpec, type Rarity } from './fish';
import { Rng } from './rng';

// The README hero loop (scripts/capture-showcase.mjs records it): the fjord map at night, cut
// open at the waterline. Aurora and the dive boat above; one breath-hold dive below, with the
// game's own diver and fish. Every motion runs a whole number of cycles per loop, so the last
// frame meets the first.

const TAU = Math.PI * 2;
const LOOP_SECONDS = 8;
const CAM_Y = 2.2;
const CAM_Z = 52;
const FRAME_H = 30; // world units the frame spans at z = 0
const HORIZON = 0.34; // how far down the frame the horizon sits
const FRONT = 3; // z of the cut face of the water
const SEABED = -16.6;
const HAZE_NEAR = 130;
const HAZE_FAR = 900;

const MINT = '#3ef0a8'; // the HUD's "holding" colour
const GOLD = '#ffcc4d';
const CORAL = ['#ff6f91', '#ff9671', '#ffc75f', '#c34a82', '#f9f871', '#7ee8fa'];
const STONE = ['#5d6f7a', '#4a5b68', '#6b7d85', '#3e4c59'];
const SKYLINE = new THREE.Color('#2a7884');

type Tick = (phase: number) => void;

const glsl = (c: THREE.ColorRepresentation, gain = 1) => {
  const { r, g, b } = new THREE.Color(c).multiplyScalar(gain);
  return `vec3(${r.toFixed(5)}, ${g.toFixed(5)}, ${b.toFixed(5)})`;
};

/** Sky colour by azimuth and elevation. The water samples the same function for its reflection. */
const SKY_GLSL = `
  vec3 aurora(float a, float e, float t) {
    vec3 sum = vec3(0.0);
    for (int i = 0; i < 3; i++) {
      float f = float(i);
      float way = i == 1 ? -1.0 : 1.0;
      float hem = 0.07 + 0.028 * f + 0.02 * sin(a * (3.2 + f * 1.9) + f * 2.3 + t * way);
      float h = e - hem;
      float curtain = smoothstep(-0.006, 0.003, h) * exp(-max(h, 0.0) / (0.03 + 0.012 * f));
      float rays = 0.68 + 0.32 * sin(a * (90.0 + f * 35.0) + 2.5 * sin(a * 8.0 + t * way) + f * 1.7 + t);
      float along = 0.5 + 0.5 * sin(a * (2.4 + f * 0.9) + f * 1.9 - t * way);
      sum += mix(${glsl(MINT)}, ${glsl('#8f6bff')}, smoothstep(0.0, 0.085, h)) * curtain * rays * (0.1 + 0.9 * along * along);
    }
    return sum;
  }
  vec3 skyAt(float a, float e, float t) {
    vec3 col = mix(${glsl(SKYLINE)}, ${glsl('#103a55')}, smoothstep(0.0, 0.06, e));
    col = mix(col, ${glsl('#060d20')}, smoothstep(0.04, 0.22, e));
    // The last of the daylight, strongest down the mouth of the fjord.
    col += ${glsl('#7fe0c0', 0.5)} * exp(-e * 34.0) * (0.35 + 0.65 * exp(-pow((a - 0.1) * 2.6, 2.0)));
    return col + aurora(a, e, t) * 1.3;
  }`;

/**
 * One fog chunk for both halves of the picture. The camera is level, so view-space height is
 * world height: above the surface things fade into the skyline; below it they lose light with
 * depth and dissolve into the water over the distance travelled behind the cut face.
 */
function patchFog() {
  const chunk = THREE.ShaderChunk;
  chunk.fog_pars_vertex = '#ifdef USE_FOG\n varying float vFogDepth;\n varying vec3 vFogView;\n#endif';
  chunk.fog_vertex = '#ifdef USE_FOG\n vFogDepth = - mvPosition.z;\n vFogView = mvPosition.xyz;\n#endif';
  chunk.fog_pars_fragment =
    '#ifdef USE_FOG\n uniform vec3 fogColor;\n uniform float fogNear;\n uniform float fogFar;\n varying float vFogDepth;\n varying vec3 vFogView;\n#endif';
  chunk.fog_fragment = `#ifdef USE_FOG
    float fogY = vFogView.y + ${CAM_Y.toFixed(2)};
    if ( fogY < 0.0 ) {
      float through = length( vFogView ) * max( 0.0, 1.0 - ${(CAM_Z - FRONT).toFixed(2)} / max( - vFogView.z, 0.001 ) );
      float deep = clamp( - fogY / 17.0, 0.0, 1.0 );
      gl_FragColor.rgb *= mix( vec3( 1.0 ), ${glsl('#5f9fb0')}, deep );
      gl_FragColor.rgb = mix( mix( ${glsl('#1b8394')}, ${glsl('#04142a')}, pow( deep, 0.75 ) ), gl_FragColor.rgb, exp( - through * 0.042 ) );
    } else {
      gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, smoothstep( fogNear, fogFar, vFogDepth ) );
    }
  #endif`;
}

function gradientTexture(stops: [number, string][], radial: boolean) {
  const c = document.createElement('canvas');
  c.width = radial ? 128 : 4;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  // Linear gradients run up the image, so stop 0 lands on v = 0.
  const g = radial ? ctx.createRadialGradient(64, 64, 0, 64, 64, 64) : ctx.createLinearGradient(0, 128, 0, 0);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  return new THREE.CanvasTexture(c);
}

const GLOW = gradientTexture([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.42)'], [0.6, 'rgba(255,255,255,0.1)'], [1, 'rgba(255,255,255,0)']], true);
const FADE = gradientTexture([[0, 'rgba(255,255,255,0.8)'], [0.4, 'rgba(255,255,255,0.25)'], [1, 'rgba(255,255,255,0)']], false);

const materials = new Map<string, THREE.Material>();

function flat(color: string): THREE.Material {
  let m = materials.get(color);
  if (!m) materials.set(color, (m = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9 })));
  return m;
}

/** Unlit, and brighter than white when gain > 1 so the bloom pass picks it up. */
function lit(color: string, gain = 1): THREE.Material {
  const key = `${color}*${gain}`;
  let m = materials.get(key);
  if (!m) materials.set(key, (m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(gain) })));
  return m;
}

/** A see-through, additive material for beams, shafts and pools of light. */
function light(color: string, gain: number, map: THREE.Texture) {
  return new THREE.MeshBasicMaterial({
    map,
    color: new THREE.Color(color).multiplyScalar(gain),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
}

function glow(parent: THREE.Object3D, x: number, y: number, z: number, size: number, color: string, gain = 1) {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: GLOW,
      color: new THREE.Color(color).multiplyScalar(gain),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    }),
  );
  sprite.scale.setScalar(size);
  sprite.renderOrder = 3;
  return put(parent, sprite, x, y, z);
}

function put<T extends THREE.Object3D>(parent: THREE.Object3D, obj: T, x = 0, y = 0, z = 0): T {
  obj.position.set(x, y, z);
  parent.add(obj);
  return obj;
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (top: number, bottom: number, h: number, sides = 8) => new THREE.CylinderGeometry(top, bottom, h, sides);
const UP = new THREE.Vector3(0, 1, 0);

function strut(parent: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material) {
  const m = new THREE.Mesh(cyl(r, r, a.distanceTo(b), 5), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
  parent.add(m);
  return m;
}

/** Ripples on the surface. Mirrored in the water shader, so anything floating can ride them. */
function swell(x: number, z: number, phase: number) {
  const t = phase * TAU;
  const h = 0.09 * Math.sin(0.5 * x + 0.2 * z + 3 * t) + 0.06 * Math.sin(-0.33 * x + 0.7 * z + 4 * t + 1.3) + 0.1 * Math.sin(0.13 * x + 0.15 * z + 2 * t);
  return h * (1 - THREE.MathUtils.smoothstep(-z, 60, 150));
}

/** The sea floor: rising toward the back and toward both walls of the fjord. */
function floorY(x: number, z: number) {
  return (
    SEABED +
    4.2 * THREE.MathUtils.smoothstep(-z, 0, 45) +
    2.6 * THREE.MathUtils.smoothstep(Math.abs(x), 15, 30) +
    0.5 * Math.sin(0.31 * x + 1) +
    0.35 * Math.cos(0.42 * z + 0.2 * x)
  );
}

// ---- Above the water ----------------------------------------------------

function buildSky(scene: THREE.Scene, ticks: Tick[], pixelScale: { value: number }) {
  const phase = { value: 0 };
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(3000, 48, 24),
    new THREE.ShaderMaterial({
      uniforms: { uPhase: phase },
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: 'varying vec3 vDir;\nvoid main() {\n vDir = position;\n gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n}',
      fragmentShader: `uniform float uPhase; varying vec3 vDir; ${SKY_GLSL}
        void main() {
          vec3 d = normalize(vDir);
          gl_FragColor = vec4(skyAt(atan(d.x, -d.z), max(asin(d.y), 0.0), uPhase * 6.2831853), 1.0);
        }`,
    }),
  );
  dome.renderOrder = -2;
  put(scene, dome, 0, CAM_Y, CAM_Z);

  // Only the strip of sky the frame can see gets stars.
  const rng = new Rng(99);
  const count = 150;
  const position = new Float32Array(count * 3);
  const seed = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = rng.range(-0.5, 0.5);
    const e = rng.range(0.035, 0.21);
    position.set([Math.sin(a) * Math.cos(e) * 2800, CAM_Y + Math.sin(e) * 2800, CAM_Z - Math.cos(a) * Math.cos(e) * 2800], i * 3);
    seed.set([rng.range(0, TAU), rng.int(1, 3), rng.range(0.9, 2.2)], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('seed', new THREE.BufferAttribute(seed, 3));
  const stars = new THREE.Points(
    geo,
    new THREE.ShaderMaterial({
      uniforms: { uPhase: phase, uScale: pixelScale },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `attribute vec3 seed; uniform float uPhase; uniform float uScale; varying float vA;
        void main() {
          vA = 0.55 + 0.45 * sin(6.2831853 * seed.y * uPhase + seed.x);
          gl_PointSize = seed.z * uScale;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `varying float vA;
        void main() {
          gl_FragColor = vec4(vec3(0.86, 0.95, 1.0) * vA * smoothstep(0.5, 0.1, length(gl_PointCoord - 0.5)), 1.0);
        }`,
    }),
  );
  stars.frustumCulled = false;
  stars.renderOrder = -1;
  scene.add(stars);
  ticks.push((p) => (phase.value = p));
  return phase;
}

/** A jagged peak: dark rock with snow from part-way up. */
function peak(scene: THREE.Scene, rng: Rng, x: number, z: number, h: number, r: number, snowFrom = 0.42) {
  const geo = new THREE.ConeGeometry(r, h, rng.int(5, 7), 3).toNonIndexed();
  const pos = geo.attributes.position;
  const moved = new Map<string, THREE.Vector3>();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > h * 0.49) continue; // leave the summit alone so it stays sharp
    const key = `${pos.getX(i).toFixed(2)},${y.toFixed(2)},${pos.getZ(i).toFixed(2)}`;
    let off = moved.get(key);
    if (!off) moved.set(key, (off = new THREE.Vector3(rng.range(-1, 1), rng.range(-0.5, 0.5), rng.range(-1, 1)).multiplyScalar(r * 0.16)));
    pos.setXYZ(i, pos.getX(i) + off.x, y + off.y, pos.getZ(i) + off.z);
  }
  const snow = new THREE.Color('#cfe2ee');
  const rockTone = new THREE.Color('#24394f');
  const colors: number[] = [];
  for (let i = 0; i < pos.count; i += 3) {
    const mid = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3 / h + 0.5;
    const c = (mid > snowFrom + rng.range(-0.08, 0.08) ? snow : rockTone).clone().multiplyScalar(rng.range(0.85, 1.05));
    for (let k = 0; k < 3; k++) colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 }));
  mesh.rotation.y = rng.range(0, TAU);
  return put(scene, mesh, x, h / 2 - 2, z);
}

function pine(scene: THREE.Object3D, rng: Rng, x: number, y: number, z: number, h: number) {
  const tree = put(scene, new THREE.Group(), x, y, z);
  put(tree, new THREE.Mesh(cyl(h * 0.03, h * 0.045, h * 0.25, 5), flat('#1a1f29')), 0, h * 0.12, 0);
  const mat = flat(rng.pick(['#12333c', '#0f2a34', '#184046']));
  for (let i = 0; i < 3; i++) {
    const tier = h * (0.42 - i * 0.05);
    put(tree, new THREE.Mesh(new THREE.ConeGeometry(h * (0.27 - i * 0.07), tier, 6), mat), 0, h * 0.2 + h * 0.24 * i + tier / 2, 0).rotation.y = rng.range(0, TAU);
  }
  return tree;
}

function buildFjord(scene: THREE.Scene) {
  const rng = new Rng(7);
  for (const [x, z, h, r] of [
    [-170, -300, 52, 70], [-112, -262, 40, 52], [-74, -335, 34, 58], [-225, -390, 66, 92], [-52, -430, 28, 60],
    [152, -285, 47, 68], [98, -335, 33, 54], [214, -345, 60, 90], [64, -445, 26, 56], [262, -265, 42, 60],
    [12, -640, 34, 90], [-46, -720, 44, 110], [74, -700, 40, 100], [150, -760, 52, 120], [-140, -780, 56, 130],
  ]) {
    peak(scene, rng, x, z, h, r);
  }
  // Low wooded shoulders at the water's edge, with a cabin or two.
  const shore = (x0: number, x1: number, z: number) => {
    for (let x = x0; x < x1; x += 13) {
      peak(scene, rng, x + rng.range(-4, 4), z + rng.range(-8, 8), rng.range(7, 13), rng.range(13, 19), 0.72);
    }
    for (let i = 0; i < 26; i++) {
      pine(scene, rng, rng.range(x0, x1), rng.range(1.5, 5.5), z + rng.range(-6, 12), rng.range(5.5, 9));
    }
  };
  shore(-120, -34, -128);
  shore(52, 135, -150);
  for (const [x, z, w] of [[-58, -108, 4.6], [-47, -110, 3.6], [84, -130, 4.4]]) {
    const cabin = put(scene, new THREE.Group(), x, 1.4, z);
    put(cabin, new THREE.Mesh(box(w, 2.6, 3.4), flat('#5a2e2a')), 0, 1.3, 0);
    put(cabin, new THREE.Mesh(new THREE.ConeGeometry(w * 0.8, 1.8, 4), flat('#dce9f0')), 0, 3.5, 0).rotation.y = Math.PI / 4;
    put(cabin, new THREE.Mesh(box(0.9, 0.9, 0.2), lit(GOLD, 2.6)), -w * 0.2, 1.4, 1.75);
    put(cabin, new THREE.Mesh(box(0.9, 0.9, 0.2), lit(GOLD, 2.6)), w * 0.22, 1.4, 1.75);
    glow(cabin, 0, 1.4, 2.2, 8, GOLD, 0.5);
  }
}

function buildSurface(scene: THREE.Scene, phase: { value: number }, ticks: Tick[]) {
  // Fine grid where the ripples show, then one flat sheet out to the horizon.
  const near = new THREE.PlaneGeometry(260, 156, 118, 31);
  near.rotateX(-Math.PI / 2);
  near.translate(0, 0, FRONT - 78);
  const rng = new Rng(3);
  const grid = near.attributes.position;
  for (let i = 0; i < grid.count; i++) {
    const x = grid.getX(i);
    const z = grid.getZ(i);
    // Nudge the grid so the facets do not line up; the rim stays put to meet its neighbours.
    if (Math.abs(x) > 128 || z > FRONT - 1 || z < FRONT - 155) continue;
    grid.setXYZ(i, x + rng.range(-0.8, 0.8), 0, z + rng.range(-1.6, 1.6));
  }
  const far = new THREE.PlaneGeometry(9000, 3000, 1, 1);
  far.rotateX(-Math.PI / 2);
  far.translate(0, 0, FRONT - 156 - 1500);

  const material = new THREE.ShaderMaterial({
    uniforms: { uPhase: phase },
    vertexShader: `uniform float uPhase; varying vec3 vWorld;
      void main() {
        vec3 p = position;
        float t = uPhase * 6.2831853;
        float h = 0.09 * sin(0.5 * p.x + 0.2 * p.z + 3.0 * t) + 0.06 * sin(-0.33 * p.x + 0.7 * p.z + 4.0 * t + 1.3) + 0.1 * sin(0.13 * p.x + 0.15 * p.z + 2.0 * t);
        p.y += h * (1.0 - smoothstep(60.0, 150.0, -p.z));
        vWorld = p;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `uniform float uPhase; varying vec3 vWorld; ${SKY_GLSL}
      void main() {
        vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
        if (n.y < 0.0) n = -n;
        vec3 toEye = cameraPosition - vWorld;
        vec3 r = reflect(-normalize(toEye), n);
        float a = atan(r.x, -r.z);
        // Lifted: at this glancing angle a true mirror would show nothing but the ridge line.
        float e = asin(clamp(r.y, 0.0, 1.0)) * 2.4 + 0.012;
        vec3 sky = skyAt(a, e, uPhase * 6.2831853);
        float ridge = 0.03 + 0.06 * smoothstep(0.08, 0.5, abs(a - 0.1));
        sky = mix(${glsl('#0e2c40')}, sky, smoothstep(ridge - 0.012, ridge + 0.012, e));
        vec3 col = mix(${glsl('#0b3346')}, sky, 0.82);
        col = mix(col, ${glsl(SKYLINE)}, smoothstep(40.0, 520.0, length(toEye)) * 0.92);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(near, material), new THREE.Mesh(far, material));

  // The cut edge: a bright meniscus, and the lit water just under it.
  const steps = 150;
  const span = 62;
  const edge = new THREE.BufferGeometry();
  edge.setAttribute('position', new THREE.BufferAttribute(new Float32Array((steps + 1) * 4 * 3), 3));
  const colors: number[] = [];
  const index: number[] = [];
  const line = new THREE.Color(MINT).lerp(new THREE.Color('#ffffff'), 0.55).multiplyScalar(1.5);
  const body = new THREE.Color('#2fb7b0').multiplyScalar(0.42);
  for (let i = 0; i <= steps; i++) {
    colors.push(line.r, line.g, line.b, line.r, line.g, line.b, body.r, body.g, body.b, 0, 0, 0);
    if (i === steps) break;
    const a = i * 4;
    const b = a + 4;
    index.push(a, a + 1, b, b, a + 1, b + 1, a + 2, a + 3, b + 2, b + 2, a + 3, b + 3);
  }
  edge.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  edge.setIndex(index);
  const rim = new THREE.Mesh(
    edge,
    new THREE.MeshBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false }),
  );
  rim.frustumCulled = false;
  rim.renderOrder = 2;
  scene.add(rim);
  ticks.push((p) => {
    const pos = edge.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i <= steps; i++) {
      const x = -span / 2 + (span * i) / steps;
      const y = swell(x, FRONT, p);
      pos.setXYZ(i * 4, x, y + 0.05, FRONT);
      pos.setXYZ(i * 4 + 1, x, y - 0.06, FRONT);
      pos.setXYZ(i * 4 + 2, x, y - 0.06, FRONT);
      pos.setXYZ(i * 4 + 3, x, y - 3.2, FRONT);
    }
    pos.needsUpdate = true;
  });
}

// ---- Boat, buoy and line ------------------------------------------------

const HULL: [number, number][] = [
  [-4, -1.3], [-4.15, 0], [-4, 1.3], [-1, 1.6], [2.2, 1.3], [3.7, 0.55], [4.4, 0], [3.7, -0.55], [2.2, -1.3], [-1, -1.6],
];
const sheer = (x: number) => 0.6 * THREE.MathUtils.smoothstep(x, 0.4, 4.4) ** 1.5 + 0.1 * THREE.MathUtils.smoothstep(-x, 2, 4);

/** One horizontal slice of the hull, wider or narrower at each end and bent up toward the bow. */
function hullLayer(y0: number, y1: number, s0: number, s1: number, rise: number) {
  const geo = new THREE.ExtrudeGeometry(new THREE.Shape(HULL.map(([x, z]) => new THREE.Vector2(x, z))), { depth: 1, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const k = pos.getY(i);
    const x = pos.getX(i) * THREE.MathUtils.lerp(Math.min(1, s0 + 0.25), 1, k);
    pos.setXYZ(i, x, THREE.MathUtils.lerp(y0, y1, k) + sheer(x) * rise, pos.getZ(i) * THREE.MathUtils.lerp(s0, s1, k));
  }
  geo.computeVertexNormals();
  return geo;
}

/** The game's dive boat (red hull, white cabin, blue roof), dressed for a night dive. */
function buildBoat(scene: THREE.Scene, ticks: Tick[]) {
  const home = new THREE.Vector3(-8.2, 0, 0);
  const boat = put(scene, new THREE.Group(), home.x, 0, home.z);
  boat.scale.setScalar(0.84);
  boat.rotation.y = 0.16;
  const iron = flat('#1a2230');
  boat.add(new THREE.Mesh(hullLayer(-0.95, 0.04, 0.5, 0.97, 0), flat('#7b2f27')));
  boat.add(new THREE.Mesh(hullLayer(0.04, 0.36, 0.97, 1, 0.4), flat('#f3efe6')));
  boat.add(new THREE.Mesh(hullLayer(0.36, 1.2, 1, 1.07, 1), flat('#c0573e')));
  boat.add(new THREE.Mesh(hullLayer(1.2, 1.3, 1.1, 1.1, 1), flat('#8d3b2b')));
  boat.add(new THREE.Mesh(hullLayer(1.17, 1.24, 0.95, 0.95, 1), flat('#e8d5b0')));

  const cabin = put(boat, new THREE.Group(), 1, 1.24, 0);
  put(cabin, new THREE.Mesh(box(2, 1.75, 1.7), flat('#f3efe6')), 0, 0.875, 0);
  put(cabin, new THREE.Mesh(box(2.65, 0.16, 2.25), flat('#2f6f8f')), -0.05, 1.83, 0);
  put(cabin, new THREE.Mesh(box(1.5, 0.14, 1.3), flat('#3d86a8')), -0.05, 1.98, 0);
  put(cabin, new THREE.Mesh(box(0.52, 0.6, 0.08), lit(GOLD, 2)), -0.46, 1.08, 0.86);
  put(cabin, new THREE.Mesh(box(0.52, 0.6, 0.08), lit(GOLD, 2)), 0.42, 1.08, 0.86);
  put(cabin, new THREE.Mesh(box(0.08, 0.6, 1.1), flat('#2c4252')), 1.01, 1.08, 0);

  // Lantern on the after corner of the roof.
  const lanternAt = new THREE.Vector3(-0.55, 2.85, 1.05);
  strut(boat, new THREE.Vector3(-0.2, 3.14, 0.8), new THREE.Vector3(lanternAt.x, 3.14, lanternAt.z), 0.035, iron);
  put(boat, new THREE.Mesh(box(0.2, 0.3, 0.2), lit(GOLD, 3.2)), lanternAt.x, lanternAt.y, lanternAt.z);
  const lantern = glow(boat, lanternAt.x, lanternAt.y, lanternAt.z, 4.4, GOLD, 1.1);
  const lanternLight = put(boat, new THREE.PointLight('#ffc060', 20, 11, 2), lanternAt.x - 0.4, lanternAt.y, lanternAt.z + 0.6);

  // Mast with the diver-down flag, and a ladder over the stern.
  const top = new THREE.Vector3(0.3, 6.5, 0);
  strut(boat, new THREE.Vector3(0.3, 3.2, 0), top, 0.06, flat('#6b4f3a'));
  strut(boat, top, new THREE.Vector3(4.2, 1.95, 0), 0.018, iron);
  strut(boat, top, new THREE.Vector3(-3.9, 1.45, 0), 0.018, iron);
  put(boat, new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0), lit('#eaf8ff', 2.4)), top.x, top.y + 0.1, 0);
  const art = document.createElement('canvas');
  art.width = 40;
  art.height = 28;
  const ctx = art.getContext('2d')!;
  ctx.fillStyle = '#e0453a';
  ctx.fillRect(0, 0, 40, 28);
  ctx.strokeStyle = '#f6f1e6';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(-2, -2);
  ctx.lineTo(42, 30);
  ctx.stroke();
  const flagArt = new THREE.CanvasTexture(art);
  flagArt.colorSpace = THREE.SRGBColorSpace;
  const cloth = new THREE.PlaneGeometry(1.05, 0.72);
  cloth.translate(-0.53, 0, 0); // hinge on the mast
  const flag = put(boat, new THREE.Mesh(cloth, new THREE.MeshStandardMaterial({ map: flagArt, side: THREE.DoubleSide, roughness: 1 })), 0.3, 6, 0);
  for (const z of [-0.36, 0.36]) strut(boat, new THREE.Vector3(-4, 1.75, z), new THREE.Vector3(-4.55, -1.5, z), 0.045, flat('#c9d2d7'));
  for (let i = 0; i < 4; i++) {
    strut(boat, new THREE.Vector3(-4.1 - i * 0.13, 1.1 - i * 0.75, -0.36), new THREE.Vector3(-4.1 - i * 0.13, 1.1 - i * 0.75, 0.36), 0.04, flat('#c9d2d7'));
  }
  put(boat, new THREE.Mesh(box(0.8, 0.5, 0.66), flat('#e8d5b0')), -1.7, 1.5, 0.5);
  put(boat, new THREE.Mesh(cyl(0.2, 0.2, 0.9, 6), flat('#ff7a3d')), -2.7, 1.72, -0.4); // spare float

  // The lantern's streak on the water in front of the hull.
  const streak = new THREE.Mesh(new THREE.CircleGeometry(1, 20), light(GOLD, 0.55, GLOW));
  streak.rotation.x = -Math.PI / 2;
  streak.scale.set(2.6, 1.5, 1);
  streak.renderOrder = 2;
  put(scene, streak, home.x - 0.4, 0.14, FRONT - 1.1);

  ticks.push((p) => {
    boat.position.y = swell(home.x, home.z, p) * 0.8 - 0.02;
    boat.rotation.z = Math.sin(TAU * 2 * p + 1.1) * 0.024;
    boat.rotation.x = Math.sin(TAU * p + 0.4) * 0.016;
    flag.rotation.y = Math.sin(TAU * 4 * p) * 0.4;
    const flicker = 1 + Math.sin(TAU * 5 * p) * 0.1 + Math.sin(TAU * 13 * p + 1) * 0.06;
    lantern.scale.setScalar(4.4 * flicker);
    lanternLight.intensity = 20 * flicker;
    streak.material.opacity = 0.7 + 0.3 * Math.sin(TAU * 6 * p + 2);
  });
}

/** A freediving buoy and its weighted line, tagged every five metres. */
function buildLine(scene: THREE.Scene, ticks: Tick[]) {
  const at = new THREE.Vector2(1.5, 0.4);
  const rig = put(scene, new THREE.Group(), at.x, 0, at.y);
  const ring = put(rig, new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.27, 6, 10), flat('#ff7a3d')), 0, 0.14, 0);
  ring.rotation.x = Math.PI / 2;
  put(rig, new THREE.Mesh(cyl(0.34, 0.34, 0.3, 8), flat('#f3efe6')), 0, 0.2, 0);
  put(rig, new THREE.Mesh(cyl(0.03, 0.03, 0.9, 4), flat('#1a2230')), 0, 0.75, 0);
  put(rig, new THREE.Mesh(new THREE.IcosahedronGeometry(0.13, 0), lit(MINT, 3)), 0, 1.25, 0);
  const strobe = glow(rig, 0, 1.25, 0, 2.6, MINT, 0.9);

  const bottom = floorY(at.x, at.y) + 1.5;
  strut(rig, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, bottom, 0), 0.04, flat('#e8e2d0'));
  for (const depth of [-5, -10]) {
    put(rig, new THREE.Mesh(cyl(0.13, 0.13, 0.34, 6), lit(MINT, 2.2)), 0, depth, 0);
    glow(rig, 0, depth, 0, 1.5, MINT, 0.5);
  }
  put(rig, new THREE.Mesh(cyl(0.5, 0.62, 0.55, 8), flat('#2a3440')), 0, bottom - 0.25, 0);
  put(rig, new THREE.Mesh(cyl(0.64, 0.64, 0.1, 8), lit(GOLD, 1.4)), 0, bottom + 0.06, 0);

  ticks.push((p) => {
    rig.position.y = swell(at.x, at.y, p);
    rig.rotation.z = Math.sin(TAU * p) * 0.012;
    strobe.scale.setScalar(2.6 * (0.7 + 0.3 * Math.sin(TAU * 4 * p)));
  });
}

// ---- Below the water ----------------------------------------------------

/** A faceted boulder with its base at y = 0. `taper` < 1 pulls the top in. */
function rockGeometry(rng: Rng, w: number, h: number, d: number, taper: number) {
  const pts: THREE.Vector3[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      pts.push(new THREE.Vector3(sx * w * rng.range(0.42, 0.55), 0, sz * d * rng.range(0.42, 0.55)));
      const t = taper * rng.range(0.8, 1.15);
      pts.push(new THREE.Vector3(sx * w * 0.5 * t, h * rng.range(0.74, 1), sz * d * 0.5 * t));
    }
  }
  // Extra points knock the corners off so it stops reading as a crate.
  for (let i = 0; i < 5; i++) {
    const a = rng.range(0, TAU);
    pts.push(new THREE.Vector3(Math.cos(a) * w * 0.57, h * rng.range(0.2, 0.7), Math.sin(a) * d * 0.57));
  }
  pts.push(new THREE.Vector3(rng.range(-0.2, 0.2) * w, h * rng.range(1, 1.07), rng.range(-0.2, 0.2) * d));
  return new ConvexGeometry(pts);
}

function rock(scene: THREE.Object3D, rng: Rng, x: number, z: number, w: number, h: number, d: number, taper = 0.8, tone?: string) {
  const mesh = new THREE.Mesh(rockGeometry(rng, w, h, d, taper), flat(tone ?? rng.pick(STONE)));
  mesh.rotation.y = rng.range(0, TAU);
  return put(scene, mesh, x, floorY(x, z) - 1, z);
}

function buildSeabed(scene: THREE.Scene) {
  const rng = new Rng(20261010);
  const plane = new THREE.PlaneGeometry(170, 110, 68, 44);
  plane.rotateX(-Math.PI / 2);
  plane.translate(0, 0, -45);
  const grid = plane.attributes.position;
  for (let i = 0; i < grid.count; i++) grid.setY(i, floorY(grid.getX(i), grid.getZ(i)) + rng.range(-0.22, 0.22));
  const geo = plane.toNonIndexed();
  geo.computeVertexNormals();
  const sand = new THREE.Color('#c2a874');
  const colors: number[] = [];
  for (let i = 0; i < geo.attributes.position.count; i += 3) {
    const c = sand.clone().multiplyScalar(rng.range(0.75, 1.05));
    for (let k = 0; k < 3; k++) colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 })));
  // Whatever lies beyond the fog.
  put(scene, new THREE.Mesh(new THREE.PlaneGeometry(420, 90), flat('#0a2236')), 0, -46, -98);

  // The walls of the fjord carry on down. One spire each side breaks the surface, snow on top.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 9; i++) {
      rock(scene, rng, side * rng.range(25, 48), rng.range(-34, -6), rng.range(9, 16), rng.range(8, 16.5), rng.range(8, 14), 0.7);
    }
    const x = side * (side < 0 ? 24.6 : 26.5);
    const z = side < 0 ? -5.5 : -9;
    const spire = rock(scene, rng, x, z, 7.5, -floorY(x, z) + 3.6 + side * 0.5, 7, 0.46, '#4a5b68');
    const capY = spire.position.y - floorY(x, z) + 0.6 + side * 0.5;
    const cap = new THREE.Mesh(rockGeometry(rng, 3.4, 1, 3.2, 0.7), flat('#dbe9f1'));
    put(scene, cap, x, floorY(x, z) + capY + 1.9, z);
  }
  for (let i = 0; i < 16; i++) rock(scene, rng, rng.range(-34, 34), rng.range(-46, -18), rng.range(5, 11), rng.range(3, 9), rng.range(5, 9));
  // Boulders along the bottom of the frame.
  for (const [x, z, w, h] of [
    [-19.5, 0.5, 6.5, 4.4], [-14.5, -1.5, 4.2, 3], [-23, -3, 5, 5.6], [-10.5, 1.4, 2.6, 1.9], [-4.5, -4, 3.4, 2.4],
    [8.5, 1.6, 3, 2], [15.5, -2.5, 4.4, 3.2], [20.5, 0.4, 6, 4.6], [23.5, -5, 5, 6],
  ]) {
    rock(scene, rng, x, z, w, h, w * 0.8);
  }
}

function buildCoral(scene: THREE.Scene) {
  const rng = new Rng(13);
  for (let i = 0; i < 40; i++) {
    const x = i < 30 ? rng.range(-9, 14) : rng.range(-24, 24);
    const z = rng.range(-10, 2.5);
    const piece = put(scene, new THREE.Group(), x, floorY(x, z) - 0.1, z);
    const mat = flat(rng.pick(CORAL));
    const kind = rng.int(0, 2);
    if (kind === 0) {
      // Branching: a handful of tilted cones.
      for (let b = rng.int(3, 6); b > 0; b--) {
        const h = rng.range(0.8, 2.3);
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.2, h, 5), mat);
        cone.rotation.set(rng.range(-0.6, 0.6), 0, rng.range(-0.6, 0.6));
        put(piece, cone, cone.rotation.z * -0.5, h / 2, cone.rotation.x * 0.5);
      }
    } else if (kind === 1) {
      const brain = new THREE.Mesh(rockGeometry(rng, rng.range(1.1, 2.1), rng.range(0.6, 1.1), rng.range(1, 1.8), 0.6), mat);
      piece.add(brain);
    } else {
      const fan = new THREE.Mesh(new THREE.CircleGeometry(rng.range(0.8, 1.5), 6, 0, Math.PI), new THREE.MeshStandardMaterial({ color: rng.pick(CORAL), flatShading: true, side: THREE.DoubleSide }));
      fan.rotation.y = rng.range(-0.7, 0.7);
      piece.add(fan);
    }
  }
}

function buildKelp(scene: THREE.Scene, ticks: Tick[]) {
  const rng = new Rng(23);
  const plant = (x: number, z: number, count: number) => {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(rng.range(0.24, 0.36), 0.55, rng.range(0.22, 0.34)),
      flatShading: true,
      side: THREE.DoubleSide,
      roughness: 0.9,
    });
    const length = rng.range(0.95, 1.2);
    const phase = rng.range(0, TAU);
    const segments: THREE.Object3D[] = [];
    let parent: THREE.Object3D = put(scene, new THREE.Group(), x, floorY(x, z), z);
    for (let s = 0; s < count; s++) {
      const seg = put(parent, new THREE.Group(), 0, s ? length : 0, 0);
      const blade = put(seg, new THREE.Mesh(new THREE.PlaneGeometry(0.5 * (1 - s / count) + 0.16, length), mat), 0, length / 2, 0);
      blade.rotation.y = rng.range(-0.8, 0.8);
      if (s % 3 === 1) put(seg, new THREE.Mesh(new THREE.CircleGeometry(0.46, 3), mat), 0.38, length * 0.6, 0).rotation.z = -0.6;
      segments.push(seg);
      parent = seg;
    }
    const lean = rng.range(-0.02, 0.05);
    ticks.push((p) =>
      segments.forEach((seg, i) => {
        seg.rotation.z = lean + Math.sin(TAU * p + phase + i * 0.35) * 0.07;
        seg.rotation.x = Math.cos(TAU * p + phase + i * 0.3) * 0.03;
      }),
    );
  };
  for (let i = 0; i < 17; i++) plant(rng.range(14, 26), rng.range(-9, 1.5), rng.int(7, 12));
  for (let i = 0; i < 6; i++) plant(rng.range(-27, -19), rng.range(-9, -3), rng.int(5, 8));
}

/** Shafts of surface light and drifting motes: what makes the water read as water. */
function buildWaterLight(scene: THREE.Scene, ticks: Tick[], phase: { value: number }, pixelScale: { value: number }) {
  const rng = new Rng(51);
  for (let i = 0; i < 9; i++) {
    const length = rng.range(10, 15);
    const geo = new THREE.PlaneGeometry(rng.range(1.2, 3.6), length);
    geo.rotateZ(Math.PI); // bright end up
    geo.translate(0, -length / 2, 0);
    const shaft = new THREE.Mesh(geo, light('#bff5e6', 1, FADE));
    shaft.rotation.z = rng.range(0.16, 0.3);
    shaft.renderOrder = 1;
    // One shaft is planted just behind the diver so the dark suit reads against it.
    put(scene, shaft, i === 0 ? 4.4 : rng.range(-22, 22), 0, i === 0 ? -1.6 : rng.range(-13, -2));
    const base = i === 0 ? 0.3 : rng.range(0.08, 0.22);
    const beat = rng.int(1, 2);
    const offset = rng.range(0, TAU);
    ticks.push((p) => (shaft.material.opacity = base * (0.65 + 0.35 * Math.sin(TAU * beat * p + offset))));
  }

  const count = 300;
  const position = new Float32Array(count * 3);
  const seed = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    position.set([rng.range(-30, 30), rng.range(SEABED, -0.6), rng.range(-16, 2.5)], i * 3);
    seed.set([rng.range(0, TAU), rng.range(0, TAU), rng.range(0.9, 2.2)], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('seed', new THREE.BufferAttribute(seed, 3));
  const motes = new THREE.Points(
    geo,
    new THREE.ShaderMaterial({
      uniforms: { uPhase: phase, uScale: pixelScale },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `attribute vec3 seed; uniform float uPhase; uniform float uScale; varying float vA;
        void main() {
          float t = uPhase * 6.2831853;
          vec3 p = position + vec3(sin(t + seed.x) * 0.4, cos(t + seed.y) * 0.3, 0.0);
          vA = 0.2 + 0.12 * (1.0 + p.y / 17.0);
          gl_PointSize = seed.z * uScale;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `varying float vA;
        void main() {
          gl_FragColor = vec4(vec3(0.75, 0.96, 0.94) * vA * smoothstep(0.5, 0.15, length(gl_PointCoord - 0.5)), 1.0);
        }`,
    }),
  );
  motes.frustumCulled = false;
  scene.add(motes);
}

function buildDiver(scene: THREE.Scene, ticks: Tick[]) {
  const diver = new Diver(scene);
  diver.group.scale.setScalar(1.65);
  // Diver.update kicks at (4 + 1.8 * speed) rad/s and sways the net arm at 1.5 rad/s. At this
  // speed that is 6 and 1.5, so feeding it time = 8 turns / 6 gives 8 kicks and 2 sways a loop.
  const heading = new THREE.Vector3(1, -0.44, 0).normalize().multiplyScalar(10 / 9);
  const pitch = Math.atan2(heading.y, Math.abs(heading.x) + 0.6);

  const lamp = put(diver.group, new THREE.Group());
  lamp.rotation.z = pitch;
  const cone = new THREE.CylinderGeometry(2.3, 0.12, 9, 14, 1, true);
  cone.rotateZ(-Math.PI / 2);
  cone.translate(5.85, 0.1, 0);
  const beam = new THREE.Mesh(cone, light('#fff1c4', 0.24, FADE));
  beam.renderOrder = 2;
  lamp.add(beam);
  glow(lamp, 1.36, 0.1, 0.3, 0.9, '#fff1c4', 0.7);
  const key = put(scene, new THREE.PointLight('#d6f0ff', 42, 14, 2));

  ticks.push((p) => {
    diver.pos.set(6.2 + Math.sin(TAU * p) * 0.45, -8.3 + Math.sin(TAU * p + 1.2) * 0.3, 0.2);
    key.position.set(diver.pos.x + 0.5, diver.pos.y + 2.4, 5);
    diver.vel.copy(heading);
    // dt = 1 snaps the model's smoothing straight to its targets. No exhale(): the breath is held.
    diver.update(1, (TAU * 8 * p) / 6, -diver.pos.y);
    diver.headlamp.intensity = 46;
  });
}

// The per-zone rarity odds the game used when the GIF was recorded, deepest zone
// first. Rarity now comes from depth (depth-odds.ts), but rolling with these
// tables finds the same seeds, so the showcase keeps the same fish.
const RECORDED_ODDS: [Rarity, number][][] = [
  [['uncommon', 10], ['rare', 30], ['epic', 35], ['legendary', 19], ['mythic', 6]],
  [['common', 20], ['uncommon', 35], ['rare', 30], ['epic', 13], ['legendary', 2]],
  [['common', 70], ['uncommon', 25], ['rare', 5]],
];

function buildFish(scene: THREE.Scene, ticks: Tick[]) {
  /** The nth fish of a species, found the way the game finds any fish: by rolling seeds. */
  const find = (rarity: Rarity, species: string, nth = 0): FishSpec => {
    const odds = RECORDED_ODDS.find((table) => table.some(([r]) => r === rarity))!;
    for (let seed = 1; ; seed++) {
      const spec = rollFish(seed, 12, odds);
      if (spec.rarity === rarity && spec.species === species && nth-- === 0) return spec;
    }
  };
  const hue = new THREE.Color();
  const swim = (spec: FishSpec, path: (u: number) => THREE.Vector3, laps: number, wag: number, halo = 0) => {
    const fish = buildFishMesh(spec);
    fish.group.scale.multiplyScalar(1.4);
    scene.add(fish.group);
    const aura = halo ? glow(fish.group, 0, 0, 0, halo, RARITY[spec.rarity].color, 0.85) : null;
    const flutter = (spec.seed % 100) / 16;
    ticks.push((p) => {
      const u = p * laps;
      const at = path(u);
      const ahead = path(u + 0.004 * Math.sign(laps)).sub(at);
      fish.group.position.copy(at);
      fish.group.rotation.y = Math.atan2(-ahead.z, ahead.x);
      fish.group.rotation.z = THREE.MathUtils.clamp(ahead.y / Math.hypot(ahead.x, ahead.z), -0.4, 0.4);
      fish.tail.rotation.y = Math.sin(TAU * wag * p + flutter) * 0.5;
      if (spec.rarity === 'mythic') {
        // Mythics cycle through the spectrum, once a loop.
        fish.material.emissive.copy(hue.setHSL((p + 0.82) % 1, 1, 0.5));
        aura?.material.color.copy(hue).multiplyScalar(1.1);
      }
    });
  };
  /** A flat racetrack: out along the frame, round, and back a little deeper into the scene. */
  const lap = (cx: number, cy: number, cz: number, rx: number, rz: number, bob = 0.3, start = 0) => (u: number) =>
    new THREE.Vector3(cx + rx * Math.cos(TAU * (u + start)), cy + bob * Math.sin(TAU * 2 * (u + start)), cz + rz * Math.sin(TAU * (u + start)));

  const rng = new Rng(77);
  for (let i = 0; i < 9; i++) {
    const spec = find('common', i % 3 ? 'Sand Minnow' : 'Grey Perch', i);
    swim(spec, lap(-9 + rng.range(-0.8, 0.8), -3.6 + rng.range(-0.9, 0.9), -3 + rng.range(-0.8, 0.8), 9, 3, 0.25, i * 0.022 + rng.range(-0.01, 0.01)), 1, 16);
  }
  for (let i = 0; i < 6; i++) {
    const spec = find('uncommon', i % 2 ? 'Coral Chromis' : 'Striped Wrasse', i);
    swim(spec, lap(11 + rng.range(-0.7, 0.7), -4.6 + rng.range(-0.8, 0.8), -5 + rng.range(-0.7, 0.7), 8, 2.6, 0.25, 0.4 + i * 0.03), -1, 14);
  }
  swim(find('rare', 'Azure Tang'), lap(-1.5, -6.2, -3, 3.2, 1.5, 0.3), 1, 10, 2.6);
  swim(find('rare', 'Neon Cardinal'), lap(8.5, -14, -1.5, 3, 1.3, 0.3, 0.5), 1, 12, 2.6);
  swim(find('epic', 'Violet Lionfish'), lap(17.4, -8.6, -2, 1.5, 0.8, 0.35, 0.3), -1, 6, 3.6);
  swim(find('legendary', 'Golden Koi Dragon'), lap(-10.5, -8, -5.5, 9.5, 3.6, 0.6, 0.62), 1, 8, 5);
  // The one the diver is after, turning circles just past the net.
  swim(find('mythic', 'Moonfin Leviathan'), lap(16, -12.2, 0.1, 2, 0.9, 0.3, 0.1), 1, 8, 6.5);
}

// ---- Stage --------------------------------------------------------------

const query = new URLSearchParams(location.search);
const capture = query.has('capture');
document.documentElement.classList.toggle('capture', capture);
document.documentElement.classList.toggle('clean', query.has('clean'));

patchFog();
const canvas = document.getElementById('showcase') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: capture });
renderer.outputColorSpace = THREE.SRGBColorSpace;

// A level camera with the frame slid down, so the horizon sits high without tilting the view.
const reach = 2 * (1 - HORIZON); // height of the full, centred frustum in frames
const camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2 * Math.atan((reach * FRAME_H) / 2 / CAM_Z)), 1, 1, 8000);
camera.position.set(0, CAM_Y, CAM_Z);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(SKYLINE, HAZE_NEAR, HAZE_FAR);
scene.add(new THREE.HemisphereLight('#4f9a9a', '#0c1c2c', 2.1));
const moon = new THREE.DirectionalLight('#bcd6ff', 1.7);
moon.position.set(-60, 80, -30);
scene.add(moon);

const ticks: Tick[] = [];
const pixelScale = { value: 1 };
const phase = buildSky(scene, ticks, pixelScale);
buildFjord(scene);
buildSurface(scene, phase, ticks);
buildBoat(scene, ticks);
buildLine(scene, ticks);
buildSeabed(scene);
buildCoral(scene);
buildKelp(scene, ticks);
buildWaterLight(scene, ticks, phase, pixelScale);
buildDiver(scene, ticks);
buildFish(scene, ticks);

const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.7, 0.9));
composer.addPass(new OutputPass());

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas;
  if (!w || !h) return;
  const dpr = capture ? 1 : Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  composer.setPixelRatio(dpr);
  composer.setSize(w, h);
  pixelScale.value = (h * dpr) / 500;
  camera.aspect = w / (h * reach);
  camera.setViewOffset(w, h * reach, 0, h * (reach / 2 - HORIZON), w, h);
}
new ResizeObserver(resize).observe(canvas);
resize();

// Depth gauge down the right edge, read off the cut face of the water.
const gauge = document.querySelector('.gauge');
for (const metres of [5, 10, 15]) {
  const tick = document.createElement('span');
  tick.textContent = `${metres} m`;
  tick.style.top = `${(HORIZON + ((CAM_Y + metres) / (CAM_Z - FRONT)) * (CAM_Z / FRAME_H)) * 100}%`;
  gauge?.append(tick);
}

// The breath trace under the title: a dot rides it from breathing into the held, flat line.
const trace = document.querySelector<SVGPathElement>('#trace-line');
const dot = document.querySelector<SVGCircleElement>('#trace-dot');
ticks.push((p) => {
  if (!trace || !dot) return;
  const at = trace.getPointAtLength(trace.getTotalLength() * p);
  dot.setAttribute('cx', String(at.x));
  dot.setAttribute('cy', String(at.y));
  dot.style.opacity = String(Math.sin(Math.PI * p) ** 0.4);
});

function draw(at: number) {
  for (const tick of ticks) tick(at);
  composer.render();
}

// The capture script steps the loop itself; a pinned phase stops the clock.
let pinned: number | null = null;
const started = performance.now();
function loop(now: number) {
  draw(pinned ?? (((now - started) / 1000 / LOOP_SECONDS) % 1));
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

Object.assign(window, {
  showcase: {
    loopSeconds: LOOP_SECONDS,
    /** Hold the loop at `at` (0..1) and draw it now; resolves once the frame has been presented. */
    seek(at: number) {
      pinned = at;
      draw(at);
      return new Promise<void>((done) => {
        // A hidden tab gets no animation frames, so do not wait on one forever.
        const giveUp = setTimeout(done, 150);
        requestAnimationFrame(() => requestAnimationFrame(() => (clearTimeout(giveUp), done())));
      });
    },
  },
});
