import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildFishingNetMesh, buildMountedNetHead } from './gear';
import { disposeMeshes } from './headlamp-model';

// Inspection page only: reuse the exact runtime model for previews and export.
const viewport = document.querySelector<HTMLDivElement>('#viewport')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.setAttribute('aria-label', '多边体渔具模型');
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#11232f');
const environment = new RoomEnvironment();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(environment).texture;
environment.dispose();
pmrem.dispose();
scene.add(new THREE.HemisphereLight('#e0f3ff', '#344957', 2));
const key = new THREE.DirectionalLight('#fff2de', 4);
key.position.set(0, 4, 3);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -4;
key.shadow.camera.right = 4;
key.shadow.camera.top = 4;
key.shadow.camera.bottom = -4;
key.shadow.normalBias = 0.025;
scene.add(key);
const rim = new THREE.DirectionalLight('#67d8e4', 2.5);
rim.position.set(3, 2, -3);
scene.add(rim);

const model = buildFishingNetMesh();
model.group.name = 'HackRU_Faceted_Fishing_Net';
model.group.traverse((object) => {
  if (object instanceof THREE.Mesh) {
    object.castShadow = true;
    object.receiveShadow = true;
  }
});
scene.add(model.group);
const familyBounds = new THREE.Box3();
for (const level of [1, 2, 3] as const) {
  const reference = buildFishingNetMesh(level);
  familyBounds.union(new THREE.Box3().setFromObject(reference.group));
  disposeMeshes(reference.group);
}
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#11232f', roughness: 0.95 }));
floor.rotation.x = -Math.PI / 2;
floor.position.y = familyBounds.min.y - 0.08;
floor.receiveShadow = true;
scene.add(floor);

const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 100);
camera.position.set(4.5, 1.9, 4.2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(familyBounds.getCenter(new THREE.Vector3()));
controls.enableDamping = true;
controls.minDistance = 1.5;
controls.maxDistance = 10;
controls.update();
function fitView() {
  const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
  const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
  const radius = familyBounds.getBoundingSphere(new THREE.Sphere()).radius;
  const distance = radius * 1.12 / Math.sin(Math.min(vertical, horizontal));
  camera.position.copy(controls.target).addScaledVector(new THREE.Vector3(3, 1.5, 4).normalize(), distance);
  controls.maxDistance = Math.max(10, distance * 1.5);
  controls.update();
}
new ResizeObserver(() => {
  const { width, height } = viewport.getBoundingClientRect();
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  fitView();
}).observe(viewport);
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

let selectedLevel: 1 | 2 | 3 = 1;
document.querySelectorAll<HTMLButtonElement>('[data-level]').forEach((button) => {
  button.addEventListener('click', () => {
    const level = Number(button.dataset.level) as 1 | 2 | 3;
    if (level !== selectedLevel) {
      disposeMeshes(model.mouth);
      model.mouth.clear();
      const head = buildMountedNetHead(level);
      model.mouth.add(head);
      model.tip = head.getObjectByName('Catch_Centre')!;
      model.group.userData.level = level;
      selectedLevel = level;
    }
    document.querySelector('#level')!.textContent = String(level);
    document.querySelectorAll('[data-level]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
  });
});
let sideView = false;
document.querySelector('#angle')!.addEventListener('click', () => {
  sideView = !sideView;
  const distance = camera.position.distanceTo(controls.target);
  camera.position.copy(controls.target).addScaledVector(sideView ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(3, 1.5, 4).normalize(), distance);
  controls.update();
  document.querySelector('#angle')!.textContent = sideView ? '切换立体视角' : '切换侧视角';
});

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.querySelector('#png')!.addEventListener('click', () => {
  renderer.render(scene, camera);
  renderer.domElement.toBlob((blob) => {
    if (blob) download(blob, `fishing-net-lv${selectedLevel}.png`);
  }, 'image/png');
});
document.querySelector('#glb')!.addEventListener('click', async () => {
  const status = document.querySelector('#status')!;
  try {
    // Environment, lighting, floor and camera belong to the preview, not the asset.
    const exportModel = model.group.clone(true);
    const geometries: THREE.BufferGeometry[] = [];
    exportModel.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        // glTF has no flatShading flag: bake per-face normals into the asset.
        object.geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
        object.geometry.computeVertexNormals();
        geometries.push(object.geometry);
      }
    });
    let result: ArrayBuffer | Record<string, unknown>;
    try {
      result = await new GLTFExporter().parseAsync(exportModel, { binary: true });
    } finally {
      geometries.forEach((geometry) => geometry.dispose());
    }
    if (!(result instanceof ArrayBuffer)) throw new Error('Expected binary GLB output');
    download(new Blob([result], { type: 'model/gltf-binary' }), `fishing-net-lv${selectedLevel}.glb`);
    status.textContent = `Lv${selectedLevel} 3D 素材已导出`;
  } catch (error) {
    status.textContent = `导出失败：${error instanceof Error ? error.message : String(error)}`;
  }
});
