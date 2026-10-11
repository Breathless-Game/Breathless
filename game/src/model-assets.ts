import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

export function disposeModel(group: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  group.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
      geometries.add(object.geometry);
      (Array.isArray(object.material) ? object.material : [object.material]).forEach((surface) => materials.add(surface));
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((surface) => surface.dispose());
}

/** glTF has no flatShading flag; use explicit face normals in portable assets. */
export async function modelGlb(group: THREE.Group): Promise<ArrayBuffer> {
  const copy = group.clone(true);
  const ownedGeometries: THREE.BufferGeometry[] = [];
  const ownedMaterials: THREE.Material[] = [];
  copy.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      const surfaces = Array.isArray(object.material) ? object.material : [object.material];
      if (surfaces.some((surface) => surface instanceof THREE.MeshStandardMaterial && surface.flatShading)) {
        object.geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
        object.geometry.computeVertexNormals();
        ownedGeometries.push(object.geometry);
      }
    } else if (object instanceof THREE.LineSegments && object.material instanceof THREE.LineBasicMaterial) {
      const source = object.material;
      // glTF lines use the same PBR/basic surface schema as triangle primitives.
      const surface = new THREE.MeshBasicMaterial({ color: source.color, transparent: source.transparent, opacity: source.opacity });
      object.material = surface;
      ownedMaterials.push(surface);
    }
  });
  try {
    const result = await new GLTFExporter().parseAsync(copy, { binary: true });
    if (!(result instanceof ArrayBuffer)) throw new Error('Expected a binary GLB');
    return result;
  } finally {
    ownedGeometries.forEach((geometry) => geometry.dispose());
    ownedMaterials.forEach((surface) => surface.dispose());
  }
}

export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Neutral lighting preserves material colours and makes the broad facets readable. */
export function addEquipmentLights(scene: THREE.Scene) {
  scene.environmentIntensity = 0.32;
  scene.add(new THREE.HemisphereLight('#efefeb', '#63615c', 1.15));
  const key = new THREE.DirectionalLight('#fff9ef', 2.3);
  key.position.set(-3, 5, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 0.5, far: 15 });
  key.shadow.normalBias = 0.015;
  key.shadow.bias = -0.0001;
  scene.add(key);
  const fill = new THREE.DirectionalLight('#e8eaeb', 0.7);
  fill.position.set(4, 1, -3);
  scene.add(fill);
}

/** One renderer shared by all catalog images; no live model is modified. */
export class ModelStudio {
  private renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.01, 50);
  private environment: THREE.WebGLRenderTarget;

  constructor() {
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(room);
    this.scene.environment = this.environment.texture;
    room.dispose();
    pmrem.dispose();
    addEquipmentLights(this.scene);
  }

  render(group: THREE.Group, width = 768, height = 512): string {
    this.renderer.setSize(width, height, false);
    this.scene.add(group);
    const bounds = new THREE.Box3().setFromObject(group);
    const centre = bounds.getCenter(new THREE.Vector3());
    this.camera.position.copy(centre).add(new THREE.Vector3(3, 2.4, 5).normalize().multiplyScalar(8));
    this.camera.lookAt(centre);
    this.camera.updateMatrixWorld();
    const projectionBounds = new THREE.Box3();
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          projectionBounds.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(this.camera.matrixWorldInverse));
        }
      }
    }
    const aspect = width / height;
    const size = projectionBounds.getSize(new THREE.Vector3());
    const halfH = Math.max(size.y / 2, size.x / (2 * aspect)) * 1.12;
    this.camera.left = -halfH * aspect;
    this.camera.right = halfH * aspect;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.render(this.scene, this.camera);
    const png = this.renderer.domElement.toDataURL('image/png');
    this.scene.remove(group);
    return png;
  }

  dispose() {
    this.environment.dispose();
    this.renderer.dispose();
  }
}
