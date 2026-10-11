import * as THREE from 'three';

/** A dive sonar starts as carried gear and becomes a fixed vertical marker once deployed. */
export type DeepSonarMode = 'carried' | 'deploying' | 'anchored';
export type DeepSonarLengthLevel = 1 | 2 | 3;

export interface DeepSonarLengthTier {
  readonly level: DeepSonarLengthLevel;
  readonly length: number;
  readonly nodes: number;
  readonly upgradeCost: number;
}

/** Length is deliberately a progression value: the cable never grows from a UI slider. */
export const DEEP_SONAR_LENGTH_TIERS: readonly DeepSonarLengthTier[] = Object.freeze([
  Object.freeze({ level: 1 as const, length: 10, nodes: 3, upgradeCost: 0 }),
  Object.freeze({ level: 2 as const, length: 17, nodes: 4, upgradeCost: 300 }),
  Object.freeze({ level: 3 as const, length: 26, nodes: 5, upgradeCost: 1200 }),
]);

export interface DeepSonarCustomization {
  /** Accent colour chosen on the preparation screen. */
  readonly color: THREE.ColorRepresentation;
  /** The purchased cable tier. */
  readonly lengthLevel: DeepSonarLengthLevel;
  /** Weak node glow can be disabled for a no-light dive. */
  readonly lighting: boolean;
}

export interface DeepSonarBenefits {
  /** 0..1 visual illumination contribution, intentionally subtle. */
  readonly illumination: number;
  /** Multiplier for the game's quick guidance route hints. */
  readonly guidanceSpeed: number;
  /** Radius in world units for the first route hint around the deployed sonar. */
  readonly guidanceRadius: number;
}

export interface DeepSonarOptions extends Partial<DeepSonarCustomization> {
  /** Detail tier controls cable/node facets, not the purchased reach. */
  readonly detail?: 1 | 2 | 3;
  /** Seconds spent lowering from the diver's hand to its final vertical position. */
  readonly deploySeconds?: number;
  /** Start already attached to a carrier. Defaults to true. */
  readonly startsCarried?: boolean;
}

export interface DeepSonarMesh {
  readonly group: THREE.Group;
  readonly mode: DeepSonarMode;
  readonly length: number;
  /** Number of visible marker nodes after the selected render-quality tier. */
  readonly nodeCount: number;
  readonly customization: DeepSonarCustomization;
  readonly benefits: DeepSonarBenefits;
  /** Set the mode before a world update; carried mode is the initial state. */
  setCarried(position?: THREE.Vector3): void;
  /** Lower the sonar and make it vertical. The supplied position is the top float's world position. */
  deploy(position?: THREE.Vector3): void;
  /** Snap to a fixed vertical marker, useful when loading a saved dive. */
  anchor(position: THREE.Vector3): void;
  /** Change the preparation-screen colour and rebuild only the small visual palette. */
  setColor(color: THREE.ColorRepresentation): void;
  /** Switch the purchased cable tier; the caller is responsible for charging the upgrade. */
  setLengthLevel(level: DeepSonarLengthLevel): void;
  /** Follow the render-quality detail tier (facets and, on low, one fewer node). */
  setDetail(detail: 1 | 2 | 3): void;
  setLightingEnabled(enabled: boolean): void;
  /** Advances lowering and the soft node pulse. Does not move an anchored x/z position. */
  update(time: number, dt: number): void;
  dispose(): void;
}

const DEFAULT_COLOR = '#42e8d2';
const DEFAULT_LEVEL: DeepSonarLengthLevel = 1;
const DEFAULT_BENEFITS: DeepSonarBenefits = Object.freeze({ illumination: 0.23, guidanceSpeed: 1.28, guidanceRadius: 7 });

const tierFor = (level: DeepSonarLengthLevel) => DEEP_SONAR_LENGTH_TIERS[level - 1] ?? DEEP_SONAR_LENGTH_TIERS[0];

function safeColor(value: THREE.ColorRepresentation | undefined): THREE.Color {
  try {
    if (typeof value === 'string') {
      const source = value.trim();
      // Preparation colours are hex inputs in the gear panel. Accept the
      // standard CSS functional forms as well, while avoiding Three's
      // forgiving-but-surprising white fallback for an unknown name.
      if (!/^#[0-9a-f]{3,8}$/i.test(source) && !/^(rgb|hsl)a?\(/i.test(source)) return new THREE.Color(DEFAULT_COLOR);
    }
    const color = new THREE.Color(value ?? DEFAULT_COLOR);
    // Invalid strings produce NaNs in Three's Color parser. Keep the prep page safe.
    return color.isColor && Number.isFinite(color.r + color.g + color.b) ? color : new THREE.Color(DEFAULT_COLOR);
  } catch {
    return new THREE.Color(DEFAULT_COLOR);
  }
}

function normalizeLevel(value: unknown): DeepSonarLengthLevel {
  const level = typeof value === 'number' ? Math.floor(value) : Number(value);
  if (!Number.isFinite(level)) return DEFAULT_LEVEL;
  return Math.min(3, Math.max(1, level)) as DeepSonarLengthLevel;
}

/** Keep customisation serialisable and bounded before saving the preparation form. */
export function normalizeDeepSonarCustomization(input: Partial<DeepSonarCustomization> = {}): DeepSonarCustomization {
  return {
    color: `#${safeColor(input.color).getHexString()}`,
    lengthLevel: normalizeLevel(input.lengthLevel),
    lighting: input.lighting !== false,
  };
}

export function deepSonarBenefits(_level: DeepSonarLengthLevel = DEFAULT_LEVEL): DeepSonarBenefits {
  // Reach is the progression; the buff stays modest at every tier so the tool
  // helps navigation without replacing the diver's depth and map decisions.
  return { ...DEFAULT_BENEFITS };
}

function flatMaterial(color: THREE.Color, extra: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.72, ...extra });
}

function glowMaterial(color: THREE.Color, opacity: number) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
}

function makeBuoy(accent: THREE.Color, detail: 1 | 2 | 3): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.44, detail >= 3 ? 1 : 0), flatMaterial(accent, { roughness: 0.66 }));
  body.scale.set(1.25, 0.62, 0.9);
  body.position.y = 0.02;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.31, 0.12, detail >= 2 ? 8 : 6), flatMaterial(new THREE.Color('#8b6b4a')));
  cap.position.y = 0.28;
  const aerial = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.34, 5), flatMaterial(new THREE.Color('#c7d7d4'), { metalness: 0.35, roughness: 0.45 }));
  aerial.position.y = 0.5;
  const marker = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.045, 6), flatMaterial(accent, { emissive: accent, emissiveIntensity: 0.18 }));
  marker.position.y = 0.69;
  group.add(body, cap, aerial, marker);
  return group;
}

function makeCable(length: number, detail: 1 | 2 | 3) {
  const radius = detail === 1 ? 0.035 : 0.027;
  const cable = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius * 1.1, length, detail >= 2 ? 6 : 5),
    flatMaterial(new THREE.Color('#586e72'), { roughness: 0.88 }),
  );
  cable.position.y = -length * 0.5 - 0.08;
  return cable;
}

function makeAnchor(length: number, accent: THREE.Color, detail: 1 | 2 | 3): THREE.Group {
  const group = new THREE.Group();
  const y = -length - 0.18;
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.31, 0.38, detail >= 2 ? 7 : 6), flatMaterial(new THREE.Color('#344c53'), { metalness: 0.25, roughness: 0.74 }));
  head.position.y = y;
  const weight = new THREE.Mesh(new THREE.DodecahedronGeometry(0.46, 0), flatMaterial(new THREE.Color('#273940'), { roughness: 0.94 }));
  weight.scale.set(1.1, 0.62, 0.88);
  weight.position.y = y - 0.37;
  // Three small fins make the bottom read as a weighted sonar transducer from the side.
  const finMaterial = flatMaterial(accent, { roughness: 0.8 });
  for (let i = 0; i < 3; i++) {
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 4), finMaterial);
    fin.position.set(Math.cos(i * Math.PI * 2 / 3) * 0.26, y - 0.3, Math.sin(i * Math.PI * 2 / 3) * 0.26);
    fin.rotation.z = Math.PI * 0.5;
    fin.rotation.y = i * Math.PI * 2 / 3;
    group.add(fin);
  }
  group.add(head, weight);
  return group;
}

function clearChildren(root: THREE.Group) {
  // Pulse nodes share one geometry and the anchor fins share one material:
  // collect everything first so each GPU resource is disposed exactly once.
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  while (root.children.length) {
    const child = root.children.pop()!;
    child.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.geometry) return;
      geometries.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
    });
  }
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

/**
 * Low-poly deep dive sonar. The top float remains with the diver until
 * `deploy()` is called; the cable and transducer then stay in a fixed vertical
 * column. Nodes glow by material only, so this adds no real lights or shadows.
 */
export class DeepSonar implements DeepSonarMesh {
  readonly group = new THREE.Group();
  private _mode: DeepSonarMode;
  private _customization: DeepSonarCustomization;
  private _detail: 1 | 2 | 3;
  private _deploySeconds: number;
  private _deployProgress = 1;
  private _from = new THREE.Vector3();
  private _to = new THREE.Vector3();
  private nodes: THREE.Mesh[] = [];
  private nodeGlows: THREE.Mesh[] = [];
  private pulseMats: THREE.MeshStandardMaterial[] = [];
  private buoyMarker: THREE.Mesh | null = null;

  constructor(options: DeepSonarOptions = {}) {
    this._customization = normalizeDeepSonarCustomization(options);
    this._detail = options.detail ?? 2;
    this._deploySeconds = Math.max(0.05, options.deploySeconds ?? 1.8);
    this._mode = options.startsCarried === false ? 'anchored' : 'carried';
    this.rebuild();
  }

  get mode() { return this._mode; }
  get length() { return tierFor(this._customization.lengthLevel).length; }
  get nodeCount() { return this.nodes.length; }
  get customization() { return this._customization; }
  get benefits() { return deepSonarBenefits(this._customization.lengthLevel); }

  private rebuild() {
    clearChildren(this.group);
    this.nodes = [];
    this.nodeGlows = [];
    this.pulseMats = [];
    this.buoyMarker = null;
    const tier = tierFor(this._customization.lengthLevel);
    const accent = safeColor(this._customization.color);
    const buoy = makeBuoy(accent, this._detail);
    this.buoyMarker = buoy.children[3] as THREE.Mesh;
    this.group.add(buoy, makeCable(tier.length, this._detail));

    const nodeRoot = new THREE.Group();
    const nodeShape = new THREE.IcosahedronGeometry(this._detail === 1 ? 0.1 : 0.12, 0);
    const glowShape = new THREE.SphereGeometry(this._detail === 3 ? 0.3 : 0.24, this._detail >= 2 ? 8 : 6, 4);
    // A low-end device keeps the silhouette and the guidance signal but saves
    // one glow/node on the longer tiers. Medium/high preserve every purchased
    // marker so the upgrade remains visible.
    const nodeCount = this._detail === 1 ? Math.max(2, tier.nodes - 1) : tier.nodes;
    for (let i = 0; i < nodeCount; i++) {
      const t = (i + 1) / (nodeCount + 1);
      const y = -0.08 - tier.length * t;
      const pulse = flatMaterial(accent, { emissive: accent, emissiveIntensity: 0.22 });
      const node = new THREE.Mesh(nodeShape.clone(), pulse);
      node.position.y = y;
      const glow = new THREE.Mesh(glowShape.clone(), glowMaterial(accent, 0.055));
      glow.position.y = y;
      glow.scale.setScalar(0.85);
      nodeRoot.add(node, glow);
      this.nodes.push(node);
      this.nodeGlows.push(glow);
      this.pulseMats.push(pulse);
    }
    nodeShape.dispose();
    glowShape.dispose();
    this.group.add(nodeRoot, makeAnchor(tier.length, accent, this._detail));
    this.applyLighting();
  }

  private applyLighting() {
    const enabled = this._customization.lighting;
    for (const mat of this.pulseMats) mat.emissiveIntensity = enabled ? 0.22 : 0;
    for (const glow of this.nodeGlows) glow.visible = enabled;
    if (this.buoyMarker) {
      const material = this.buoyMarker.material as THREE.MeshStandardMaterial;
      material.emissiveIntensity = enabled ? 0.16 : 0;
    }
  }

  setCarried(position?: THREE.Vector3) {
    this._mode = 'carried';
    this._deployProgress = 1;
    if (position) this.group.position.copy(position);
  }

  deploy(position?: THREE.Vector3) {
    this._from.copy(this.group.position);
    this._to.copy(position ?? this.group.position);
    this._mode = 'deploying';
    this._deployProgress = 0;
  }

  anchor(position: THREE.Vector3) {
    this.group.position.copy(position);
    this._from.copy(position);
    this._to.copy(position);
    this._deployProgress = 1;
    this._mode = 'anchored';
  }

  setColor(color: THREE.ColorRepresentation) {
    const next = `#${safeColor(color).getHexString()}`;
    if (next === this._customization.color) return;
    this._customization = { ...this._customization, color: next };
    this.rebuild();
  }

  setLengthLevel(level: DeepSonarLengthLevel) {
    const next = normalizeLevel(level);
    if (next === this._customization.lengthLevel) return;
    this._customization = { ...this._customization, lengthLevel: next };
    this.rebuild();
  }

  setDetail(detail: 1 | 2 | 3) {
    const next = Math.min(3, Math.max(1, Math.round(detail))) as 1 | 2 | 3;
    if (next === this._detail) return;
    this._detail = next;
    this.rebuild();
  }

  setLightingEnabled(enabled: boolean) {
    this._customization = { ...this._customization, lighting: enabled };
    this.applyLighting();
  }

  update(time: number, dt: number) {
    if (!this.group.visible) return;
    if (this._mode === 'deploying') {
      this._deployProgress = Math.min(1, this._deployProgress + Math.max(0, dt) / this._deploySeconds);
      const smooth = this._deployProgress * this._deployProgress * (3 - 2 * this._deployProgress);
      this.group.position.lerpVectors(this._from, this._to, smooth);
      if (this._deployProgress >= 1) this._mode = 'anchored';
    }
    const phase = time * 2.15;
    for (let i = 0; i < this.nodes.length; i++) {
      const wave = 0.5 + 0.5 * Math.sin(phase + i * 1.7);
      this.pulseMats[i].emissiveIntensity = this._customization.lighting ? 0.12 + wave * 0.2 : 0;
      this.nodeGlows[i].scale.setScalar(0.72 + wave * 0.28);
    }
    if (this.buoyMarker) {
      const material = this.buoyMarker.material as THREE.MeshStandardMaterial;
      material.emissiveIntensity = this._customization.lighting ? 0.1 + 0.1 * (0.5 + 0.5 * Math.sin(phase + 0.4)) : 0;
    }
  }

  dispose() {
    clearChildren(this.group);
    this.nodes = [];
    this.nodeGlows = [];
    this.pulseMats = [];
    this.buoyMarker = null;
  }
}

export function buildDeepSonar(options: DeepSonarOptions = {}): DeepSonarMesh {
  return new DeepSonar(options);
}
