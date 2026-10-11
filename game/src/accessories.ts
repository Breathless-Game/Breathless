import * as THREE from 'three';

/**
 * 13 Diving Equipment & Accessory Models for Breathless (HackRU26).
 *
 * Designed in the project's procedural low-poly faceted 3D aesthetic:
 * - Pure procedural Three.js polyhedrons and BufferGeometries (flatShading: true)
 * - Tailored PBR materials (matte vulcanized rubber, aerospace metals, iridescent lenses, glowing emitters)
 * - Cohesive color palette matching the diver, underwater environment, and UI
 * - Full support for 3 upgrade tiers per model, complete bounding-box normalization,
 *   and interactive inspection/export.
 */

export type AccessorySlot =
  | 'fins'
  | 'finPlugin'
  | 'lampCore'
  | 'lampAttachment'
  | 'tank'
  | 'suit'
  | 'belt'
  | 'gloves'
  | 'mask'
  | 'chestPlugin';

export type AccessoryId =
  | 'streamlined-fins'
  | 'split-flow-vanes'
  | 'silent-fins'
  | 'searchlight-core'
  | 'telephoto-reflector'
  | 'wide-angle-diffuser'
  | 'red-light-filter'
  | 'emergency-tank'
  | 'streamlined-wetsuit'
  | 'weight-balance-belt'
  | 'anti-slip-gloves'
  | 'polarized-mask'
  | 'echo-sonar';

export interface AccessoryDef {
  readonly id: AccessoryId;
  readonly slot: AccessorySlot;
  readonly slotZh: string;
  readonly name: string;
  readonly nameZh: string;
  readonly stage: 1 | 2;
  readonly effect: string;
  readonly effectZh: string;
  readonly status: string;
  readonly statusZh: string;
  readonly descriptionZh: string;
  readonly build: (level?: number) => THREE.Group;
}

/* ---------------- Palette & Material Helpers ---------------- */

function standard(
  color: THREE.ColorRepresentation,
  extra: THREE.MeshStandardMaterialParameters = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    flatShading: true,
    roughness: 0.6,
    ...extra,
  });
}

function physical(
  color: THREE.ColorRepresentation,
  extra: THREE.MeshPhysicalMaterialParameters = {},
): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    flatShading: true,
    roughness: 0.35,
    ...extra,
  });
}

// Materials adhering to the Breathless color system
const rubberDark = standard('#16222b', { roughness: 0.95 });
const rubberMat = standard('#202d38', { roughness: 0.9 });
const suitBase = standard('#1d2b3a', { roughness: 0.75 });
const suitGlideskin = standard('#142433', { roughness: 0.45, metalness: 0.2 });
const accentOrange = standard('#ff7a3d', { roughness: 0.45 });
const safetyYellow = standard('#f5c531', { roughness: 0.45 });
const marineCyan = standard('#27c4b8', { roughness: 0.35, metalness: 0.3 });
const deepTeal = standard('#195663', { roughness: 0.55, metalness: 0.25 });
const steel = standard('#9aaeb5', { metalness: 0.82, roughness: 0.28 });
const gunmetal = standard('#344956', { metalness: 0.75, roughness: 0.35 });
const darkMetal = standard('#1c2830', { metalness: 0.85, roughness: 0.3 });
const chrome = standard('#dce8ec', { metalness: 0.95, roughness: 0.1 });
const gold = standard('#e5b642', { metalness: 0.85, roughness: 0.22 });
const leadMat = standard('#4a5560', { metalness: 0.55, roughness: 0.75 });
const skinTone = standard('#e0b48f', { roughness: 0.85 });

const lensGlow = standard('#e9fbff', {
  emissive: '#67d8e4',
  emissiveIntensity: 1.8,
  roughness: 0.15,
  metalness: 0.1,
});

const redLens = physical('#c91c28', {
  emissive: '#770b13',
  emissiveIntensity: 0.6,
  transparent: true,
  opacity: 0.78,
  roughness: 0.15,
  metalness: 0.1,
});

const diffuserLens = physical('#daf4f7', {
  transparent: true,
  opacity: 0.68,
  roughness: 0.4,
  metalness: 0.05,
});

const polarizedLens = physical('#48cfbe', {
  metalness: 0.45,
  roughness: 0.12,
  transparent: true,
  opacity: 0.82,
});

const sonarGlow = standard('#40ffcc', {
  emissive: '#2ee6a8',
  emissiveIntensity: 2.2,
  roughness: 0.2,
});

/* ---------------- Primitive Construction Helpers ---------------- */

function addMesh(
  group: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  pos?: THREE.Vector3,
  rot?: THREE.Euler,
  scale?: THREE.Vector3,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  if (pos) mesh.position.copy(pos);
  if (rot) mesh.rotation.copy(rot);
  if (scale) mesh.scale.copy(scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function cylinderBetween(
  group: THREE.Group,
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  segments = 8,
): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, segments), material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

/** Scale and center a model into standard icon/workbench display units. */
export function normalizeModel(group: THREE.Group, targetSize = 2.0): THREE.Group {
  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(group);
  const center = bounds.getCenter(new THREE.Vector3());
  group.position.sub(center);
  const size = bounds.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 0) {
    const scale = targetSize / maxDim;
    group.scale.multiplyScalar(scale);
  }
  return group;
}

/* =========================================================================
   1. 脚蹼: 流线脚蹼 / 竞速脚蹼 (Streamlined Fins / Racing Fins)
   最高游速和游泳加速度。双色长刀锋碳纤导流片、侧翼加强导轨、翼梢小翼与足袋弹簧扣。
   ========================================================================= */
export function buildStreamlinedFins(level = 1): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Accessory_StreamlinedFins';
  const bladeLen = 1.35 + level * 0.22;
  const bladeMat = level >= 2 ? darkMetal : rubberDark;
  const accent = level === 3 ? gold : accentOrange;

  for (const side of [-1, 1]) {
    const fin = new THREE.Group();
    fin.position.set(side * 0.36, 0, 0);

    // Foot pocket (ergonomic low-poly cavity)
    const pocket = addMesh(
      fin,
      new THREE.CylinderGeometry(0.16, 0.19, 0.52, 8),
      rubberDark,
      new THREE.Vector3(0, 0, -0.42),
      new THREE.Euler(Math.PI / 2, 0, 0),
    );
    pocket.scale.set(0.9, 0.72, 1);

    // Heel strap with stainless spring loop
    const heelStrap = addMesh(
      fin,
      new THREE.TorusGeometry(0.17, 0.035, 5, 8),
      steel,
      new THREE.Vector3(0, 0, -0.66),
      new THREE.Euler(0, 0, 0),
    );
    heelStrap.scale.set(0.85, 0.6, 1);

    // Main hydrodynamic blade (angled downward for natural kick dynamics)
    const bladeGeo = new THREE.BoxGeometry(0.34, 0.038, bladeLen);
    addMesh(
      fin,
      bladeGeo,
      bladeMat,
      new THREE.Vector3(0, -0.06, bladeLen * 0.44),
      new THREE.Euler(0.12, 0, side * 0.04),
    );

    // Dual lateral water-channeling rails (vibrant accent)
    for (const rx of [-0.16, 0.16]) {
      addMesh(
        fin,
        new THREE.BoxGeometry(0.045, 0.065, bladeLen * 0.95),
        accent,
        new THREE.Vector3(rx, -0.04, bladeLen * 0.44),
        new THREE.Euler(0.12, 0, side * 0.04),
      );
    }

    // Central longitudinal hydrodynamic spine
    addMesh(
      fin,
      new THREE.BoxGeometry(0.06, 0.05, bladeLen * 0.78),
      marineCyan,
      new THREE.Vector3(0, -0.04, bladeLen * 0.38),
      new THREE.Euler(0.12, 0, side * 0.04),
    );

    // Hydrodynamic tip winglets (reducing vortex induced drag)
    for (const wx of [-0.17, 0.17]) {
      addMesh(
        fin,
        new THREE.BoxGeometry(0.032, 0.12, 0.18),
        accent,
        new THREE.Vector3(wx, 0.01, bladeLen * 0.9),
        new THREE.Euler(0.12, 0, (wx > 0 ? 0.3 : -0.3)),
      );
    }

    // High-tier titanium ribs and flex badge
    if (level >= 2) {
      for (const ribZ of [0.2, 0.55, 0.9]) {
        addMesh(
          fin,
          new THREE.BoxGeometry(0.3, 0.042, 0.035),
          steel,
          new THREE.Vector3(0, -0.03, ribZ),
          new THREE.Euler(0.12, 0, side * 0.04),
        );
      }
    }
    if (level === 3) {
      addMesh(
        fin,
        new THREE.CylinderGeometry(0.06, 0.06, 0.04, 6),
        gold,
        new THREE.Vector3(0, -0.03, 0.35),
        new THREE.Euler(Math.PI / 2, 0, 0),
      );
    }

    group.add(fin);
  }

  return group;
}

/* =========================================================================
   2. 脚蹼插件: 分叉导流片 (Split Flow Vanes)
   更快的冲刺，但垂直转向略笨重。双分叉水翼翼板、中央导流槽与快拆安装夹。
   ========================================================================= */
export function buildSplitFlowVanes(level = 1): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Accessory_SplitFlowVanes';
  const len = 0.92 + level * 0.15;
  const accent = level === 3 ? gold : marineCyan;

  // Heavy-duty mounting collar with hex bolt fasteners
  addMesh(
    group,
    new THREE.BoxGeometry(0.55, 0.12, 0.28),
    gunmetal,
    new THREE.Vector3(0, 0, -0.15),
  );
  addMesh(group, new THREE.CylinderGeometry(0.035, 0.035, 0.16, 6), steel, new THREE.Vector3(-0.2, 0, -0.15));
  addMesh(group, new THREE.CylinderGeometry(0.035, 0.035, 0.16, 6), steel, new THREE.Vector3(0.2, 0, -0.15));

  // Bifurcated split vanes (angled outwards at 14 degrees)
  for (const side of [-1, 1]) {
    const vane = new THREE.Group();
    vane.position.set(side * 0.12, 0, 0);
    vane.rotation.y = side * 0.16;

    // Vane hydrofoil surface
    addMesh(
      vane,
      new THREE.BoxGeometry(0.18, 0.035, len),
      darkMetal,
      new THREE.Vector3(side * 0.08, 0, len * 0.48),
    );

    // Inner flow-director blade
    addMesh(
      vane,
      new THREE.BoxGeometry(0.035, 0.06, len * 0.9),
      accent,
      new THREE.Vector3(side * 0.01, 0.01, len * 0.46),
    );

    // Outer vortex stiffener
    addMesh(
      vane,
      new THREE.BoxGeometry(0.035, 0.08, len * 0.95),
      gunmetal,
      new THREE.Vector3(side * 0.16, 0.015, len * 0.5),
    );

    // Tip jet ejector nozzle
    addMesh(
      vane,
      new THREE.ConeGeometry(0.05, 0.14, 5),
      steel,
      new THREE.Vector3(side * 0.08, 0, len * 0.98),
      new THREE.Euler(Math.PI / 2, 0, 0),
    );

    group.add(vane);
  }

  // Central V-shaped expansion flow gap
  addMesh(group, new THREE.BoxGeometry(0.08, 0.04, 0.35), accentOrange, new THREE.Vector3(0, 0, 0.2));

  return group;
}

/* =========================================================================
   3. 脚蹼插件: 静音鳍片 (Silent Fins / Acoustic Dampening Blades)
   降低鱼的惊逃半径，速度不变。锯齿消音边缘、吸音微孔层与哑光防震外壳。
   ========================================================================= */
export function buildSilentFins(level = 1): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Accessory_SilentFins';
  const len = 0.85 + level * 0.12;

  // Vibration-absorbing matte mounting bracket
  addMesh(group, new THREE.BoxGeometry(0.58, 0.1, 0.25), rubberDark, new THREE.Vector3(0, 0, -0.12));
  addMesh(group, new THREE.TorusGeometry(0.18, 0.03, 5, 8), darkMetal, new THREE.Vector3(0, 0, -0.12));

  // Multi-segment serrated trailing edge blades
  for (const side of [-1, 1]) {
    const bladeGroup = new THREE.Group();
    bladeGroup.position.set(side * 0.16, 0, 0);

    // Core acoustic dampener slab
    addMesh(
      bladeGroup,
      new THREE.BoxGeometry(0.24, 0.032, len),
      rubberMat,
      new THREE.Vector3(0, 0, len * 0.46),
    );

    // Biomimetic chevron serrations along the perimeter
    const toothCount = 5 + level;
    for (let t = 0; t < toothCount; t++) {
      const z = 0.15 + (t / toothCount) * (len * 0.8);
      addMesh(
        bladeGroup,
        new THREE.ConeGeometry(0.04, 0.1, 4),
        darkMetal,
        new THREE.Vector3(side * 0.12, 0, z),
        new THREE.Euler(0, 0, side * (Math.PI / 2)),
      );
    }

    // Sound-damping micro-cavities (represented by contrasting low-poly inserts)
    for (const z of [0.25, 0.5, 0.75]) {
      addMesh(
        bladeGroup,
        new THREE.CylinderGeometry(0.025, 0.025, 0.04, 6),
        marineCyan,
        new THREE.Vector3(0, 0, z),
      );
    }

    // Flexible silicone boundary crest
    addMesh(
      bladeGroup,
      new THREE.BoxGeometry(0.035, 0.048, len * 0.88),
      deepTeal,
      new THREE.Vector3(-side * 0.08, 0.01, len * 0.44),
    );

    group.add(bladeGroup);
  }

  return group;
}

/* =========================================================================
   4. 头灯核心: 高亮探照灯 (High-Beam Searchlight Core)
   提高基础亮度和有效距离。多边形深筒灯体、双/三联大功率透镜、后置散热鳍片与头带底座。
   ========================================================================= */
export function buildSearchlightCore(level = 1): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Accessory_SearchlightCore';

  // Forehead curved mounting plate
  const basePlate = addMesh(
    group,
    new THREE.BoxGeometry(0.68, 0.38, 0.1),
    rubberDark,
    new THREE.Vector3(0, 0, -0.28),
  );
  basePlate.scale.set(1, 0.9, 1);

  // Broad nylon head strap with adjustment slider
  addMesh(group, new THREE.TorusGeometry(0.42, 0.045, 5, 8), darkMetal, new THREE.Vector3(0, 0, -0.32));
  addMesh(group, new THREE.BoxGeometry(0.12, 0.08, 0.05), accentOrange, new THREE.Vector3(0.38, 0, -0.32));

  // Anodized aluminum barrel housing
  const barrelLen = 0.52 + level * 0.08;
  addMesh(
    group,
    new THREE.CylinderGeometry(0.24, 0.28, barrelLen, 8),
    gunmetal,
    new THREE.Vector3(0, 0, 0.05),
    new THREE.Euler(Math.PI / 2, 0, 0),
  );

  // Radial cooling heatsink fins on rear barrel
  const finCount = 3 + level;
  for (let f = 0; f < finCount; f++) {
    const fz = -0.12 + (f / finCount) * 0.24;
    addMesh(
      group,
      new THREE.TorusGeometry(0.28, 0.022, 4, 8),
      steel,
      new THREE.Vector3(0, 0, fz),
    );
  }

  // Heavy-duty bezel ring (gold on max tier)
  const bezelMat = level === 3 ? gold : steel;
  addMesh(
    group,
    new THREE.TorusGeometry(0.26, 0.04, 6, 8),
    bezelMat,
    new THREE.Vector3(0, 0, 0.05 + barrelLen * 0.5),
  );

  // Emitter optics (1 emitter at Lv1, 2 at Lv2, 3 at Lv3)
  const emitterCount = level === 1 ? 1 : level === 2 ? 2 : 3;
  for (let i = 0; i < emitterCount; i++) {
    const ox = emitterCount === 1 ? 0 : (i - (emitterCount - 1) / 2) * 0.16;
    const oy = emitterCount === 3 && i === 1 ? 0.08 : 0;

    // Deep reflector cone
    addMesh(
      group,
      new THREE.CylinderGeometry(0.09, 0.04, 0.14, 6),
      chrome,
      new THREE.Vector3(ox, oy, 0.26),
      new THREE.Euler(Math.PI / 2, 0, 0),
    );
    // Emissive glowing lens element
    addMesh(
      group,
      new THREE.SphereGeometry(0.08, 6, 5),
      lensGlow,
      new THREE.Vector3(ox, oy, 0.31),
    );
  }

  // Top toggle switch / tactile click button
  addMesh(group, new THREE.BoxGeometry(0.09, 0.07, 0.12), accentOrange, new THREE.Vector3(0, 0.28, 0.02));

  // Coiled power cable running down to battery
  cylinderBetween(
    group,
    new THREE.Vector3(0, -0.22, -0.05),
    new THREE.Vector3(0.2, -0.35, -0.25),
    0.025,
    rubberDark,
    6,
  );

  return group;
}

/* =========================================================================
   5. 灯光配件: 长焦反射杯 (Telephoto Reflector / Deep Projector Cone)
   远距离、窄角光束；增加照明范围首选。深凹内抛物面反射筒、阶梯消光环、聚光透镜。
   ========================================================================= */
export function buildTelephotoReflector(level = 1): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Accessory_TelephotoReflector';
  const cowlLen = 0.65 + level * 0.15;

  // Rear bayonet locking collar
  addMesh(
    group,
    new THREE.CylinderGeometry(0.28, 0.28, 0.14, 8),
    gunmetal,
    new THREE.Vector3(0, 0, -0.28),
    new THREE.Euler(Math.PI / 2, 0, 0),
  );
  addMesh(group, new THREE.TorusGeometry(0.29, 0.03, 5, 8), steel, new THREE.Vector3(0, 0, -0.28));

  // Outer tapered collimator barrel
  addMesh(
    group,
    new THREE.CylinderGeometry(0.18, 0.28, cowlLen, 8, 1, true),
    darkMetal,
    new THREE.Vector3(0, 0, cowlLen * 0.35),
    new THREE.Euler(Math.PI / 2, 0, 0),
  );

  // Highly-reflective chrome inner cone
  addMesh(
    group,
    new THREE.CylinderGeometry(0.16, 0.25, cowlLen * 0.88, 8, 1, true),
    chrome,
    new THREE.Vector3(0, 0, cowlLen * 0.35),
    new THREE.Euler(Math.PI / 2, 0, 0),
  );

  // Internal anti-glare baffle rings
  for (const bz of [0.0, 0.2, 0.4]) {
    addMesh(
      group,
      new THREE.TorusGeometry(0.21 - bz * 0.1, 0.02, 4, 8),
      gunmetal,
      new THREE.Vector3(0, 0, bz),
    );
  }

  // Front bezel and collimating condenser optic
  const frontZ = cowlLen * 0.82;
  addMesh(group, new THREE.TorusGeometry(0.19, 0.035, 5, 8), steel, new THREE.Vector3(0, 0, frontZ));
  addMesh(
    group,
    new THREE.SphereGeometry(0.16, 8, 6),
    lensGlow,
    new THREE.Vector3(0, 0, frontZ - 0.04),
  );

  // Twin lock pins
  addMesh(group, new THREE.BoxGeometry(0.06, 0.04, 0.08), accentOrange, new THREE.Vector3(0.29, 0, -0.28));
  addMesh(group, new THREE.BoxGeometry(0.06, 0.04, 0.08), accentOrange, new THREE.Vector3(-0.29, 0, -0.28));

  return group;
}

/* =========================================================================
   6. 灯光配件: 广角扩散罩 (Wide-Angle Diffuser)
   照射角更大、远距离略短；适合找鱼群。多面体半球形扩散透镜、蜂窝散射面与外扩柔光环。
   ========================================================================= */
export function buildWideAngleDiffuser(level = 1): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Accessory_WideAngleDiffuser';

  // Base mounting sleeve
  addMesh(
    group,
    new THREE.CylinderGeometry(0.28, 0.28, 0.16, 8),
    gunmetal,
    new THREE.Vector3(0, 0, -0.16),
    new THREE.Euler(Math.PI / 2, 0, 0),
  );

  // Flared softbox outer reflector ring (high-visibility silicone bumper)
  const flareZ = 0.12 + level * 0.04;
  addMesh(
    group,
    new THREE.CylinderGeometry(0.44, 0.28, flareZ, 8, 1, true),
    accentOrange,
    new THREE.Vector3(0, 0, flareZ * 0.4),
    new THREE.Euler(Math.PI / 2, 0, 0),
  );

  // Outer protective rubber rim
  addMesh(
    group,
    new THREE.TorusGeometry(0.44, 0.045, 5, 8),
    rubberDark,
    new THREE.Vector3(0, 0, flareZ * 0.88),
  );

  // Translucent multi-faceted dome diffuser lens
  const dome = addMesh(
    group,
    new THREE.IcosahedronGeometry(0.34, 1),
    diffuserLens,
    new THREE.Vector3(0, 0, 0.18),
  );
  dome.scale.set(1, 1, 0.55);

  // Honeycomb faceted internal beam splitter
  addMesh(
    group,
    new THREE.CylinderGeometry(0.24, 0.24, 0.035, 6),
    chrome,
    new THREE.Vector3(0, 0, 0.04),
    new THREE.Euler(Math.PI / 2, 0, 0),
  );

  // Silicone lanyard retention tab
  addMesh(group, new THREE.BoxGeometry(0.06, 0.14, 0.04), marineCyan, new THREE.Vector3(0, -0.42, 0.1));

  return group;
}

/* =========================================================================
   7. 灯光配件: 红光滤镜 (Red Light Filter)
   夜间更不容易惊鱼，但亮度和距离较低。深红高透滤光片、翻折机械铰链与快锁把手。
   ========================================================================= */
export function buildRedLightFilter(level = 1): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Accessory_RedLightFilter';

  // Base clamping ring attached to headlamp bezel
  addMesh(
    group,
    new THREE.TorusGeometry(0.28, 0.04, 5, 8),
    gunmetal,
    new THREE.Vector3(0, 0, -0.1),
  );

  // Top hinge bracket
  addMesh(group, new THREE.BoxGeometry(0.16, 0.09, 0.14), steel, new THREE.Vector3(0, 0.31, -0.05));
  addMesh(
    group,
    new THREE.CylinderGeometry(0.04, 0.04, 0.22, 6),
    steel,
    new THREE.Vector3(0, 0.31, -0.05),
    new THREE.Euler(0, 0, Math.PI / 2),
  );

  // Filter carrier swing frame (angled slightly open or flush)
  const swingAngle = level === 1 ? 0 : 0.22;
  const swing = new THREE.Group();
  swing.position.set(0, 0.31, -0.05);
  swing.rotation.x = swingAngle;

  const swingOffset = new THREE.Vector3(0, -0.31, 0.12);

  // Lens bezel ring
  addMesh(
    swing,
    new THREE.TorusGeometry(0.26, 0.035, 5, 8),
    darkMetal,
    swingOffset,
  );

  // Ruby optical filter element
  addMesh(
    swing,
    new THREE.CylinderGeometry(0.24, 0.24, 0.03, 8),
    redLens,
    swingOffset,
    new THREE.Euler(Math.PI / 2, 0, 0),
  );

  // Side thumb lever for easy glove operation
  addMesh(
    swing,
    new THREE.BoxGeometry(0.09, 0.06, 0.14),
    accentOrange,
    new THREE.Vector3(0.29, -0.31, 0.12),
  );

  group.add(swing);

  // Lower magnetic retention latch
  addMesh(group, new THREE.BoxGeometry(0.12, 0.06, 0.08), steel, new THREE.Vector3(0, -0.31, -0.05));

  return group;
}

/* =========================================================================
   8. 应急装备: 应急气瓶 (Emergency Air Tank / Spare Air)
   只延长水下换气后的紧急上浮窗口。紧凑型微型高压瓶、集成一二级呼吸咬嘴、微型压力表与快拆胸背带。
   ========================================================================= */
export function buildEmergencyAirTank(level = 1): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Accessory_EmergencyAirTank';
  const tankHeight = 0.95 + level * 0.2;
  const cylinderMat = level >= 2 ? marineCyan : safetyYellow;

  // Main high-pressure pony bottle cylinder
  addMesh(
    group,
    new THREE.CylinderGeometry(0.2, 0.2, tankHeight, 8),
    cylinderMat,
    new THREE.Vector3(0, 0, 0),
  );

  // Rounded bottom bumper boot
  addMesh(
    group,
    new THREE.CylinderGeometry(0.21, 0.18, 0.14, 8),
    rubberDark,
    new THREE.Vector3(0, -tankHeight * 0.46, 0),
  );

  // Dome cylinder shoulder
  addMesh(
    group,
    new THREE.SphereGeometry(0.198, 8, 4),
    cylinderMat,
    new THREE.Vector3(0, tankHeight * 0.48, 0),
  );

  // Integrated valve & 1st stage regulator block
  const regY = tankHeight * 0.54;
  addMesh(group, new THREE.BoxGeometry(0.16, 0.15, 0.16), steel, new THREE.Vector3(0, regY + 0.08, 0));
  addMesh(
    group,
    new THREE.CylinderGeometry(0.08, 0.08, 0.12, 6),
    gunmetal,
    new THREE.Vector3(0, regY + 0.18, 0),
  );

  // Demand breathing mouthpiece (ergonomic bite tabs)
  addMesh(
    group,
    new THREE.BoxGeometry(0.16, 0.07, 0.18),
    rubberMat,
    new THREE.Vector3(0, regY + 0.08, 0.18),
  );
  addMesh(group, new THREE.BoxGeometry(0.08, 0.04, 0.08), skinTone, new THREE.Vector3(0, regY + 0.08, 0.26));

  // Large yellow emergency purge button
  addMesh(
    group,
    new THREE.CylinderGeometry(0.07, 0.07, 0.04, 6),
    safetyYellow,
    new THREE.Vector3(0, regY + 0.08, 0.09),
    new THREE.Euler(Math.PI / 2, 0, 0),
  );

  // Miniature dial pressure gauge with luminescent dial face
  addMesh(
    group,
    new THREE.CylinderGeometry(0.08, 0.08, 0.06, 6),
    steel,
    new THREE.Vector3(0.18, regY + 0.06, 0),
    new THREE.Euler(0, 0, Math.PI / 2),
  );
  addMesh(
    group,
    new THREE.CylinderGeometry(0.065, 0.065, 0.02, 6),
    lensGlow,
    new THREE.Vector3(0.22, regY + 0.06, 0),
    new THREE.Euler(0, 0, Math.PI / 2),
  );

  // High-tensile nylon retention harness straps
  for (const sy of [-tankHeight * 0.25, tankHeight * 0.15]) {
    addMesh(group, new THREE.TorusGeometry(0.24, 0.04, 5, 8), darkMetal, new THREE.Vector3(0, sy, 0));
    addMesh(group, new THREE.BoxGeometry(0.08, 0.09, 0.06), accentOrange, new THREE.Vector3(0, sy, -0.23));
  }

  // Braided emergency safety lanyard
  cylinderBetween(
    group,
    new THREE.Vector3(0, -tankHeight * 0.35, -0.15),
    new THREE.Vector3(0, -tankHeight * 0.6, -0.1),
    0.022,
    accentOrange,
    6,
  );

  return group;
}

/* =========================================================================
   9. 身体: 流线潜水服 (Streamlined Wetsuit)
   降低水阻，提升移动效率。低阻氯丁橡胶流线躯干装甲模块、双色导流脊线、背负贴合板。
   ========================================================================= */
export function buildStreamlinedWetsuit(level = 1): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Accessory_StreamlinedWetsuit';
  const accent = level >= 2 ? marineCyan : accentOrange;

  // Main anatomical torso vest
  const torso = addMesh(
    group,
    new THREE.CylinderGeometry(0.42, 0.36, 1.35, 8),
    suitGlideskin,
    new THREE.Vector3(0, 0, 0),
  );
  torso.scale.set(1.18, 1, 0.76);

  // Ergonomic shoulder pads (articulated low-poly armor)
  for (const side of [-1, 1]) {
    const shoulder = addMesh(
      group,
      new THREE.SphereGeometry(0.22, 6, 5),
      suitBase,
      new THREE.Vector3(side * 0.52, 0.52, 0),
    );
    shoulder.scale.set(1.1, 0.8, 1);

    // Lateral chest speed-stream stripes
    addMesh(
      group,
      new THREE.BoxGeometry(0.06, 0.85, 0.05),
      accent,
      new THREE.Vector3(side * 0.42, 0.04, 0.24),
      new THREE.Euler(0, 0, -side * 0.15),
    );
  }

  // Central hydrodynamic chest loading & flex shield
  addMesh(
    group,
    new THREE.BoxGeometry(0.38, 0.72, 0.08),
    darkMetal,
    new THREE.Vector3(0, 0.12, 0.26),
  );

  // Aerodynamic spinal dorsal ridge (channels water straight backward)
  addMesh(
    group,
    new THREE.BoxGeometry(0.08, 1.1, 0.12),
    accent,
    new THREE.Vector3(0, 0.02, -0.27),
  );

  // Neck seal gasket
  addMesh(
    group,
    new THREE.CylinderGeometry(0.26, 0.28, 0.18, 8),
    rubberDark,
    new THREE.Vector3(0, 0.74, 0),
  );

  // Lower beaver-tail closure strap with dual studs
  addMesh(
    group,
    new THREE.BoxGeometry(0.24, 0.34, 0.1),
    rubberDark,
    new THREE.Vector3(0, -0.74, 0.06),
  );
  addMesh(group, new THREE.CylinderGeometry(0.04, 0.04, 0.06, 6), steel, new THREE.Vector3(-0.06, -0.78, 0.12), new THREE.Euler(Math.PI / 2, 0, 0));
  addMesh(group, new THREE.CylinderGeometry(0.04, 0.04, 0.06, 6), steel, new THREE.Vector3(0.06, -0.78, 0.12), new THREE.Euler(Math.PI / 2, 0, 0));

  if (level === 3) {
    // Monocoque carbon weave accents on flanks
    for (const side of [-1, 1]) {
      addMesh(group, new THREE.BoxGeometry(0.08, 0.65, 0.06), gold, new THREE.Vector3(side * 0.48, 0.1, 0));
    }
  }

  return group;
}

/* =========================================================================
   10. 身体: 配重平衡带 (Weight Balance Belt)
   改善下沉/上浮控制，减少垂直过冲。高弹性快速脱卸橡胶腰带、4 块切角配重铅块、马赛快脱扣。
   ========================================================================= */
export function buildWeightBalanceBelt(level = 1): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Accessory_WeightBalanceBelt';
  const weightMat = level === 3 ? darkMetal : leadMat;

  // Heavy-duty flexible rubber belt loop
  const belt = addMesh(
    group,
    new THREE.TorusGeometry(0.56, 0.058, 6, 12),
    rubberDark,
    new THREE.Vector3(0, 0, 0),
    new THREE.Euler(Math.PI / 2, 0, 0),
  );
  belt.scale.set(1.12, 0.85, 1);

  // Marseillaise quick-release stainless steel roller buckle
  const buckleGroup = new THREE.Group();
  buckleGroup.position.set(0, 0, 0.52);

  addMesh(buckleGroup, new THREE.BoxGeometry(0.24, 0.14, 0.06), steel, new THREE.Vector3(0, 0, 0));
  addMesh(
    buckleGroup,
    new THREE.CylinderGeometry(0.02, 0.02, 0.18, 6),
    chrome,
    new THREE.Vector3(0, 0.04, 0.02),
    new THREE.Euler(0, 0, Math.PI / 2),
  );
  // Quick-release prong
  addMesh(buckleGroup, new THREE.BoxGeometry(0.025, 0.12, 0.04), steel, new THREE.Vector3(0, 0, 0.04));
  // High-visibility pull tab
  addMesh(buckleGroup, new THREE.BoxGeometry(0.14, 0.08, 0.04), accentOrange, new THREE.Vector3(0.16, -0.02, 0.01));

  group.add(buckleGroup);

  // 4 Hydrodynamic block weights arranged symmetrically
  const angles = [-2.1, -1.2, 1.2, 2.1];
  for (const ang of angles) {
    const wx = Math.sin(ang) * 0.58;
    const wz = Math.cos(ang) * 0.44;

    const weightGroup = new THREE.Group();
    weightGroup.position.set(wx, 0, wz);
    weightGroup.rotation.y = -ang + Math.PI / 2;

    // Beveled lead weight block
    addMesh(
      weightGroup,
      new THREE.BoxGeometry(0.26, 0.18, 0.14),
      weightMat,
    );
    // Center pass-through belt slots
    addMesh(weightGroup, new THREE.BoxGeometry(0.18, 0.08, 0.16), darkMetal);

    if (level >= 2) {
      // Weight retainer slide stop clips
      addMesh(weightGroup, new THREE.BoxGeometry(0.04, 0.14, 0.16), steel, new THREE.Vector3(-0.14, 0, 0));
      addMesh(weightGroup, new THREE.BoxGeometry(0.04, 0.14, 0.16), steel, new THREE.Vector3(0.14, 0, 0));
    }

    group.add(weightGroup);
  }

  // Side stainless D-ring gear attachment
  addMesh(
    group,
    new THREE.TorusGeometry(0.09, 0.018, 4, 8),
    steel,
    new THREE.Vector3(-0.62, 0, 0.05),
    new THREE.Euler(0, Math.PI / 2, 0),
  );

  return group;
}

/* =========================================================================
   11. 手部: 防滑捕捞手套 (Anti-Slip Grip Gloves)
   提高挥网动作稳定性，可与线轮二选一。成对低多边形手套、凯夫拉高摩擦掌垫与腕部快扣。
   ========================================================================= */
export function buildAntiSlipGloves(level = 1): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Accessory_AntiSlipGloves';
  const palmMat = level >= 2 ? darkMetal : rubberMat;
  const accent = level === 3 ? gold : accentOrange;

  for (const side of [-1, 1]) {
    const glove = new THREE.Group();
    glove.position.set(side * 0.35, 0, 0);

    // Palm / Hand core body
    const palm = addMesh(
      glove,
      new THREE.BoxGeometry(0.32, 0.16, 0.42),
      suitGlideskin,
      new THREE.Vector3(0, 0, 0),
    );
    palm.scale.set(0.9, 0.85, 1);

    // Extended wrist cuff with Velcro cinch strap
    addMesh(
      glove,
      new THREE.CylinderGeometry(0.17, 0.19, 0.28, 8),
      rubberDark,
      new THREE.Vector3(0, 0, -0.32),
      new THREE.Euler(Math.PI / 2, 0, 0),
    );
    addMesh(
      glove,
      new THREE.TorusGeometry(0.19, 0.035, 5, 8),
      accent,
      new THREE.Vector3(0, 0, -0.32),
    );

    // Kevlar reinforced friction palm armor slab
    addMesh(
      glove,
      new THREE.BoxGeometry(0.28, 0.035, 0.38),
      palmMat,
      new THREE.Vector3(0, -0.08, 0),
    );

    // 4 Articulated fingers in natural curved ready stance
    for (let f = 0; f < 4; f++) {
      const fx = (f - 1.5) * 0.07;
      const finger = new THREE.Group();
      finger.position.set(fx, 0, 0.21);

      // Proximal knuckle phalanx
      addMesh(
        finger,
        new THREE.CylinderGeometry(0.032, 0.035, 0.18, 6),
        suitGlideskin,
        new THREE.Vector3(0, 0, 0.09),
        new THREE.Euler(0.25, 0, 0),
      );
      // Distal grip tip
      addMesh(
        finger,
        new THREE.CylinderGeometry(0.028, 0.032, 0.14, 6),
        palmMat,
        new THREE.Vector3(0, -0.04, 0.22),
        new THREE.Euler(0.55, 0, 0),
      );

      glove.add(finger);
    }

    // Opposing thumb
    const thumb = new THREE.Group();
    thumb.position.set(side * 0.18, -0.02, 0.05);
    thumb.rotation.y = side * 0.45;
    addMesh(
      thumb,
      new THREE.CylinderGeometry(0.035, 0.038, 0.22, 6),
      palmMat,
      new THREE.Vector3(side * 0.06, 0, 0.08),
      new THREE.Euler(0.35, 0, side * 0.3),
    );
    glove.add(thumb);

    // Knuckle protective armor ridges
    for (let k = 0; k < 4; k++) {
      const kx = (k - 1.5) * 0.07;
      addMesh(
        glove,
        new THREE.BoxGeometry(0.05, 0.045, 0.08),
        accent,
        new THREE.Vector3(kx, 0.08, 0.18),
      );
    }

    group.add(glove);
  }

  return group;
}

/* =========================================================================
   12. 面镜: 防雾偏光面镜 (Anti-Fog Polarized Mask)
   雾天和夜间减少视觉干扰；轻度辅助与外观。双泪滴低容积面镜、偏光镀膜镜片、防滑头带。
   ========================================================================= */
export function buildPolarizedMask(level = 1): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Accessory_PolarizedMask';
  const rimMat = level === 3 ? gold : steel;

  // Low-volume facial silicone skirt
  const skirt = addMesh(
    group,
    new THREE.CylinderGeometry(0.38, 0.44, 0.28, 8, 1, true),
    rubberDark,
    new THREE.Vector3(0, 0, -0.12),
    new THREE.Euler(Math.PI / 2, 0, 0),
  );
  skirt.scale.set(1.25, 0.82, 1);

  // Rigid structural frame
  const frame = addMesh(
    group,
    new THREE.BoxGeometry(0.88, 0.48, 0.12),
    darkMetal,
    new THREE.Vector3(0, 0, 0.02),
  );
  frame.scale.set(1, 0.88, 1);

  // Twin teardrop lens apertures
  for (const side of [-1, 1]) {
    const lensGroup = new THREE.Group();
    lensGroup.position.set(side * 0.22, 0, 0.04);

    // Bezel retaining ring
    addMesh(
      lensGroup,
      new THREE.CylinderGeometry(0.18, 0.18, 0.08, 6),
      rimMat,
      new THREE.Vector3(0, 0, 0),
      new THREE.Euler(Math.PI / 2, 0, 0),
    );

    // Multi-coated polarized optical glass element
    addMesh(
      lensGroup,
      new THREE.CylinderGeometry(0.165, 0.165, 0.04, 6),
      polarizedLens,
      new THREE.Vector3(0, 0, 0.035),
      new THREE.Euler(Math.PI / 2, 0, 0),
    );

    // Teardrop lower extension (maximizes downward seabed view)
    addMesh(
      lensGroup,
      new THREE.ConeGeometry(0.12, 0.16, 5),
      polarizedLens,
      new THREE.Vector3(0, -0.14, 0.035),
      new THREE.Euler(0, 0, Math.PI),
    );

    group.add(lensGroup);
  }

  // Easy-pinch equalization nose pocket
  addMesh(
    group,
    new THREE.ConeGeometry(0.12, 0.26, 5),
    rubberMat,
    new THREE.Vector3(0, -0.18, 0.08),
    new THREE.Euler(0.25, 0, 0),
  );

  // Dual wide split silicone strap with micro-ratchet buckles
  for (const side of [-1, 1]) {
    addMesh(
      group,
      new THREE.BoxGeometry(0.08, 0.12, 0.06),
      accentOrange,
      new THREE.Vector3(side * 0.48, 0, 0),
    );
  }
  const strap = addMesh(
    group,
    new THREE.TorusGeometry(0.48, 0.035, 5, 8),
    rubberDark,
    new THREE.Vector3(0, 0, -0.32),
  );
  strap.scale.set(1.05, 0.72, 1);

  return group;
}

/* =========================================================================
   13. 胸口插件: 回声声呐 (Echo Sonar Unit)
   短时间显示附近鱼的位置/稀有度，有冷却时间。钛合金防水舱体、相控阵换能器、发光脉冲环与胸背架。
   ========================================================================= */
export function buildEchoSonar(level = 1): THREE.Group {
  const group = new THREE.Group();
  group.name = 'Accessory_EchoSonar';

  // Ergonomic curved chest bracket plate
  const base = addMesh(
    group,
    new THREE.BoxGeometry(0.64, 0.52, 0.08),
    rubberDark,
    new THREE.Vector3(0, 0, -0.18),
  );
  base.scale.set(1, 0.9, 1);

  // 4-point webbing harness loops
  for (const x of [-0.28, 0.28]) {
    for (const y of [-0.2, 0.2]) {
      addMesh(group, new THREE.BoxGeometry(0.06, 0.08, 0.05), steel, new THREE.Vector3(x, y, -0.18));
    }
  }

  // Watertight octagonal titanium pressure hull
  addMesh(
    group,
    new THREE.CylinderGeometry(0.28, 0.32, 0.28, 8),
    gunmetal,
    new THREE.Vector3(0, 0, 0),
    new THREE.Euler(Math.PI / 2, 0, 0),
  );

  // Outer protective rubber armor bumper
  addMesh(
    group,
    new THREE.TorusGeometry(0.32, 0.045, 6, 8),
    rubberDark,
    new THREE.Vector3(0, 0, 0.02),
  );

  // Active phased-array acoustic transducer dish
  addMesh(
    group,
    new THREE.CylinderGeometry(0.22, 0.26, 0.08, 8),
    darkMetal,
    new THREE.Vector3(0, 0, 0.12),
    new THREE.Euler(Math.PI / 2, 0, 0),
  );

  // Emissive acoustic pulse ring indicator (pulses when sonar is ready / pinging)
  addMesh(
    group,
    new THREE.TorusGeometry(0.22, 0.028, 6, 12),
    sonarGlow,
    new THREE.Vector3(0, 0, 0.16),
  );

  // Central piezoelectric transceiver elements (concentric array)
  addMesh(
    group,
    new THREE.SphereGeometry(0.12, 6, 5),
    deepTeal,
    new THREE.Vector3(0, 0, 0.17),
  );
  addMesh(
    group,
    new THREE.TorusGeometry(0.08, 0.018, 5, 8),
    marineCyan,
    new THREE.Vector3(0, 0, 0.18),
  );

  // Glove-friendly tactile ping button on top
  addMesh(
    group,
    new THREE.CylinderGeometry(0.06, 0.06, 0.08, 6),
    accentOrange,
    new THREE.Vector3(0, 0.32, 0),
  );

  // Pressure equalization valve & battery status LED cluster
  addMesh(group, new THREE.CylinderGeometry(0.04, 0.04, 0.06, 6), steel, new THREE.Vector3(-0.25, -0.22, 0.06), new THREE.Euler(Math.PI / 2, 0, 0));
  for (let led = 0; led < 3; led++) {
    addMesh(
      group,
      new THREE.SphereGeometry(0.025, 4, 4),
      led === 0 ? marineCyan : led === 1 ? safetyYellow : accentOrange,
      new THREE.Vector3(0.15 + led * 0.06, -0.22, 0.08),
    );
  }

  if (level >= 2) {
    // Additional peripheral sensor waveguides
    for (const side of [-1, 1]) {
      addMesh(group, new THREE.BoxGeometry(0.08, 0.22, 0.12), steel, new THREE.Vector3(side * 0.35, 0, 0.05));
    }
  }

  return group;
}

/* =========================================================================
   Unified Registry of All 13 Equipment / Accessories
   ========================================================================= */

export const ACCESSORIES: readonly AccessoryDef[] = Object.freeze([
  // 1. 脚蹼
  Object.freeze({
    id: 'streamlined-fins',
    slot: 'fins',
    slotZh: '脚蹼',
    name: 'Streamlined / Racing Fins',
    nameZh: '流线脚蹼 / 竞速脚蹼',
    stage: 1,
    effect: 'Increases maximum swimming speed and sprint acceleration',
    effectZh: '最高游速和游泳加速度',
    status: 'Ready (Model complete, effects pending)',
    statusZh: '有模型，效果待接入',
    descriptionZh: '专为竞速下潜设计的长刀锋流线脚蹼，配备碳纤导流片、双侧水流导轨与翼梢小翼。',
    build: buildStreamlinedFins,
  }),
  // 2. 脚蹼插件 - 分叉导流片
  Object.freeze({
    id: 'split-flow-vanes',
    slot: 'finPlugin',
    slotZh: '脚蹼插件',
    name: 'Split Flow Vanes',
    nameZh: '分叉导流片',
    stage: 1,
    effect: 'Faster sprint speed, slightly heavier vertical pitch turning',
    effectZh: '更快的冲刺，但垂直转向略笨重',
    status: 'Newly added (Complete 3D model)',
    statusZh: '建议新增（已完成建模）',
    descriptionZh: '安装于脚蹼侧轨的双分叉水翼翼板，大幅提升直线冲刺推进力，转向惯性增加。',
    build: buildSplitFlowVanes,
  }),
  // 3. 脚蹼插件 - 静音鳍片
  Object.freeze({
    id: 'silent-fins',
    slot: 'finPlugin',
    slotZh: '脚蹼插件',
    name: 'Silent Fins',
    nameZh: '静音鳍片',
    stage: 1,
    effect: 'Reduces fish alarm radius while maintaining baseline swimming speed',
    effectZh: '降低鱼的惊逃半径，速度不变',
    status: 'Newly added (Complete 3D model)',
    statusZh: '建议新增（已完成建模）',
    descriptionZh: '仿生锯齿消音边缘与减振弹性体结构，消除水下踩水涡流噪声，不易惊扰鱼群。',
    build: buildSilentFins,
  }),
  // 4. 头灯核心
  Object.freeze({
    id: 'searchlight-core',
    slot: 'lampCore',
    slotZh: '头灯核心',
    name: 'High-Beam Searchlight Core',
    nameZh: '高亮探照灯',
    stage: 1,
    effect: 'Increases base luminosity and beam penetration distance in deep water',
    effectZh: '提高基础亮度和有效距离',
    status: 'Ready (Model complete, effects pending)',
    statusZh: '有模型，效果待接入',
    descriptionZh: '航天铝制深筒多联光学探照灯，配备后置散热鳍片与大功率广谱发射器。',
    build: buildSearchlightCore,
  }),
  // 5. 灯光配件 - 长焦反射杯
  Object.freeze({
    id: 'telephoto-reflector',
    slot: 'lampAttachment',
    slotZh: '灯光配件',
    name: 'Telephoto Reflector',
    nameZh: '长焦反射杯',
    stage: 1,
    effect: 'Long-distance, narrow-angle spotlight for piercing into deep abyss',
    effectZh: '远距离、窄角光束；增加照明范围首选',
    status: 'Newly added (Complete 3D model)',
    statusZh: '建议新增（已完成建模）',
    descriptionZh: '加长型高反射抛物面聚光筒，阶梯式消光防眩环，将光线高度会聚为远距光柱。',
    build: buildTelephotoReflector,
  }),
  // 6. 灯光配件 - 广角扩散罩
  Object.freeze({
    id: 'wide-angle-diffuser',
    slot: 'lampAttachment',
    slotZh: '灯光配件',
    name: 'Wide-Angle Diffuser',
    nameZh: '广角扩散罩',
    stage: 1,
    effect: 'Wider illumination angle, shorter distance, ideal for spotting schools of fish',
    effectZh: '照射角更大、远距离略短；适合找鱼群',
    status: 'Newly added (Complete 3D model)',
    statusZh: '建议新增（已完成建模）',
    descriptionZh: '多面体半球形扩散透镜与外扩柔光环，将光束扩散至120度角，便于广域搜鱼。',
    build: buildWideAngleDiffuser,
  }),
  // 7. 灯光配件 - 红光滤镜
  Object.freeze({
    id: 'red-light-filter',
    slot: 'lampAttachment',
    slotZh: '灯光配件',
    name: 'Red Light Filter',
    nameZh: '红光滤镜',
    stage: 1,
    effect: 'Far less likely to spook fish at night, with reduced brightness and distance',
    effectZh: '夜间更不容易惊鱼，但亮度和距离较低',
    status: 'Newly added (Complete 3D model)',
    statusZh: '建议新增（已完成建模）',
    descriptionZh: '深红高透光学滤光片与快速翻折铰链，夜潜时过滤刺激性蓝绿波段，减少鱼类警觉。',
    build: buildRedLightFilter,
  }),
  // 8. 应急装备 - 应急气瓶
  Object.freeze({
    id: 'emergency-tank',
    slot: 'tank',
    slotZh: '应急装备',
    name: 'Emergency Air Tank',
    nameZh: '应急气瓶',
    stage: 1,
    effect: 'Extends emergency surface window after breathing underwater',
    effectZh: '只延长水下换气后的紧急上浮窗口',
    status: 'Ready (Model complete, effects pending)',
    statusZh: '有模型，效果待接入',
    descriptionZh: '便携式 0.4L 微型潜水应急呼吸气瓶，集成一二级呼吸咬嘴、自发光压力表与快拆胸挂。',
    build: buildEmergencyAirTank,
  }),
  // 9. 身体 - 流线潜水服
  Object.freeze({
    id: 'streamlined-wetsuit',
    slot: 'suit',
    slotZh: '身体',
    name: 'Streamlined Wetsuit',
    nameZh: '流线潜水服',
    stage: 2,
    effect: 'Reduces hydrodynamic drag and increases movement efficiency',
    effectZh: '降低水阻，提升移动效率',
    status: 'Stage 2 (Complete 3D model)',
    statusZh: '建议第二阶段（已完成建模）',
    descriptionZh: '低水阻光面氯丁橡胶湿衣，带有导流背脊与双侧流体减阻贴片，降低滑行阻力。',
    build: buildStreamlinedWetsuit,
  }),
  // 10. 身体 - 配重平衡带
  Object.freeze({
    id: 'weight-balance-belt',
    slot: 'belt',
    slotZh: '身体',
    name: 'Weight Balance Belt',
    nameZh: '配重平衡带',
    stage: 2,
    effect: 'Improves descent and ascent control, reducing vertical overshoot',
    effectZh: '改善下沉/上浮控制，减少垂直过冲',
    status: 'Stage 2 (Complete 3D model)',
    statusZh: '建议第二阶段（已完成建模）',
    descriptionZh: '高弹性马赛扣潜水腰带，挂载4块对称流线切角铅块，平衡潜水员下潜姿态与浮力。',
    build: buildWeightBalanceBelt,
  }),
  // 11. 手部 - 防滑捕捞手套
  Object.freeze({
    id: 'anti-slip-gloves',
    slot: 'gloves',
    slotZh: '手部',
    name: 'Anti-Slip Grip Gloves',
    nameZh: '防滑捕捞手套',
    stage: 2,
    effect: 'Improves net swing stability and grip',
    effectZh: '提高挥网动作稳定性，可与线轮二选一',
    status: 'Stage 2 (Complete 3D model)',
    statusZh: '建议第二阶段（已完成建模）',
    descriptionZh: '耐磨凯夫拉加强手心摩擦纹理，指关节防冲击保护块，提供坚固的抄网握持稳定性。',
    build: buildAntiSlipGloves,
  }),
  // 12. 面镜 - 防雾偏光面镜
  Object.freeze({
    id: 'polarized-mask',
    slot: 'mask',
    slotZh: '面镜',
    name: 'Anti-Fog Polarized Mask',
    nameZh: '防雾偏光面镜',
    stage: 2,
    effect: 'Reduces visual interference in foggy or night conditions',
    effectZh: '雾天和夜间减少视觉干扰；先做轻度辅助或外观',
    status: 'Stage 2 (Complete 3D model)',
    statusZh: '建议第二阶段（已完成建模）',
    descriptionZh: '双水滴型低容积面镜，偏光镀膜多层镜片消除水面反光与暗部杂光，提供通透水下视野。',
    build: buildPolarizedMask,
  }),
  // 13. 胸口插件 - 回声声呐
  Object.freeze({
    id: 'echo-sonar',
    slot: 'chestPlugin',
    slotZh: '胸口插件',
    name: 'Echo Sonar Unit',
    nameZh: '回声声呐',
    stage: 2,
    effect: 'Briefly displays nearby fish locations and rarities, with cooldown',
    effectZh: '短时间显示附近鱼的位置/稀有度，有冷却时间',
    status: 'Stage 2 (Complete 3D model)',
    statusZh: '建议第二阶段（已完成建模）',
    descriptionZh: '胸挂式相控阵声学探头，带有主动发光脉冲环，可在漆黑深渊中主动探测鱼群位置。',
    build: buildEchoSonar,
  }),
]);

/** Find an accessory definition by ID. */
export function getAccessoryDef(id: AccessoryId): AccessoryDef | undefined {
  return ACCESSORIES.find((a) => a.id === id);
}

/** Build any accessory model with automatic normalization. */
export function buildAccessoryModel(id: AccessoryId, level = 1, targetSize = 2.0): THREE.Group {
  const def = getAccessoryDef(id);
  if (!def) {
    const fallback = new THREE.Group();
    fallback.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), standard('#ffffff')));
    return normalizeModel(fallback, targetSize);
  }
  const model = def.build(level);
  return normalizeModel(model, targetSize);
}
