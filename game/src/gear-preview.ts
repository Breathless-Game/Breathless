import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildFishingNetMesh } from './gear';

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
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#11232f', roughness: 0.95 }));
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.73;
floor.receiveShadow = true;
scene.add(floor);

const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 100);
camera.position.set(4.5, 1.9, 4.2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(1.55, -0.02, 0);
controls.enableDamping = true;
controls.minDistance = 1.5;
controls.maxDistance = 10;
controls.update();
new ResizeObserver(() => {
  const { width, height } = viewport.getBoundingClientRect();
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}).observe(viewport);
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

document.querySelectorAll<HTMLButtonElement>('[data-level]').forEach((button) => {
  button.addEventListener('click', () => {
    const level = Number(button.dataset.level);
    model.mouth.scale.setScalar([1, 1.15, 1.3][level - 1]);
    document.querySelector('#level')!.textContent = String(level);
    document.querySelectorAll('[data-level]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
  });
});
let sideView = false;
document.querySelector('#angle')!.addEventListener('click', () => {
  sideView = !sideView;
  camera.position.set(sideView ? 1.55 : 4.5, sideView ? 0.5 : 1.9, sideView ? 5.2 : 4.2);
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
    if (blob) download(blob, 'fishing-net-faceted-preview.png');
  }, 'image/png');
});
document.querySelector('#glb')!.addEventListener('click', async () => {
  const status = document.querySelector('#status')!;
  try {
    // Environment, lighting, floor and camera belong to the preview, not the asset.
    const exportModel = model.group.clone(true);
    exportModel.getObjectByName('Net_Mouth')!.scale.setScalar(1);
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
    download(new Blob([result], { type: 'model/gltf-binary' }), 'fishing-net-faceted.glb');
    status.textContent = 'Lv1 基础 3D 素材已导出';
  } catch (error) {
    status.textContent = `导出失败：${error instanceof Error ? error.message : String(error)}`;
  }
});
