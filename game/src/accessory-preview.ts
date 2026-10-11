import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import {
  ACCESSORIES,
  buildAccessoryModel,
  type AccessoryDef,
  type AccessoryId,
} from './accessories';

const viewport = document.getElementById('viewport') as HTMLDivElement;
let currentId: AccessoryId = 'streamlined-fins';
let currentLevel = 1;
let wireframe = false;
let autoRotate = true;
let currentGroup: THREE.Group | null = null;

// Renderer setup with ACESFilmicToneMapping and soft shadows
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.appendChild(renderer.domElement);

// Scene & Environment
const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment()).texture;
pmrem.dispose();

// Studio Lighting
const hemiLight = new THREE.HemisphereLight('#daf2ff', '#182b36', 1.8);
scene.add(hemiLight);

const keyLight = new THREE.DirectionalLight('#fff5e6', 3.8);
keyLight.position.set(4, 6, 5);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.left = -3;
keyLight.shadow.camera.right = 3;
keyLight.shadow.camera.top = 3;
keyLight.shadow.camera.bottom = -3;
keyLight.shadow.bias = -0.0005;
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight('#27c4b8', 2.6);
rimLight.position.set(-5, 3, -4);
scene.add(rimLight);

const fillLight = new THREE.DirectionalLight('#86b4cc', 1.2);
fillLight.position.set(-2, -3, 3);
scene.add(fillLight);

// Studio pedestal floor
const floor = new THREE.Mesh(
  new THREE.CylinderGeometry(2.4, 2.5, 0.12, 32),
  new THREE.MeshStandardMaterial({ color: '#0d1a24', roughness: 0.85, metalness: 0.1 }),
);
floor.position.y = -1.06;
floor.receiveShadow = true;
scene.add(floor);

// Camera and OrbitControls
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
camera.position.set(3.2, 1.8, 3.8);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.autoRotate = autoRotate;
controls.autoRotateSpeed = 2.0;
controls.minDistance = 1.2;
controls.maxDistance = 8.0;
controls.target.set(0, 0, 0);

function resize() {
  const { width, height } = viewport.getBoundingClientRect();
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();

function calculateStats(group: THREE.Group) {
  let triangles = 0;
  let vertices = 0;
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      const geo = obj.geometry;
      if (geo.index) {
        triangles += geo.index.count / 3;
      } else if (geo.attributes.position) {
        triangles += geo.attributes.position.count / 3;
      }
      if (geo.attributes.position) {
        vertices += geo.attributes.position.count;
      }
    }
  });
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  return {
    triangles: Math.round(triangles),
    vertices,
    dimensions: `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m`,
  };
}

function updateStatsUI(stats: { triangles: number; vertices: number; dimensions: string }) {
  document.getElementById('stat-triangles')!.textContent = stats.triangles.toLocaleString();
  document.getElementById('stat-vertices')!.textContent = stats.vertices.toLocaleString();
  document.getElementById('stat-dimensions')!.textContent = stats.dimensions;
}

function applyWireframe(group: THREE.Group, enabled: boolean) {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      if (Array.isArray(obj.material)) {
        obj.material.forEach((m) => (m.wireframe = enabled));
      } else if (obj.material) {
        obj.material.wireframe = enabled;
      }
    }
  });
}

function loadModel(id: AccessoryId, level: number) {
  if (currentGroup) {
    scene.remove(currentGroup);
  }

  const model = buildAccessoryModel(id, level, 1.8);
  applyWireframe(model, wireframe);
  currentGroup = model;
  scene.add(model);

  const stats = calculateStats(model);
  updateStatsUI(stats);
}

function renderSidebarList(filter: 'all' | 'stage1' | 'stage2' = 'all') {
  const container = document.getElementById('accessory-list')!;
  container.innerHTML = '';

  const filtered = ACCESSORIES.filter((item) => {
    if (filter === 'stage1') return item.stage === 1;
    if (filter === 'stage2') return item.stage === 2;
    return true;
  });

  filtered.forEach((item) => {
    const card = document.createElement('div');
    card.className = `item-card ${item.id === currentId ? 'active' : ''}`;
    card.innerHTML = `
      <div class="item-header">
        <span class="slot-tag">${item.slotZh}</span>
        <span class="stage-tag">${item.stage === 1 ? '一阶段' : '二阶段'}</span>
      </div>
      <div class="item-name">${item.nameZh}</div>
      <div class="item-en">${item.name}</div>
    `;
    card.addEventListener('click', () => {
      currentId = item.id;
      updateActiveInfo(item);
      loadModel(currentId, currentLevel);
      document.querySelectorAll('.item-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
    });
    container.appendChild(card);
  });
}

function updateActiveInfo(item: AccessoryDef) {
  document.getElementById('active-slot-tag')!.textContent = item.slotZh;
  document.getElementById('active-title')!.textContent = item.nameZh;
  document.getElementById('active-effect')!.textContent = `效果: ${item.effectZh}`;
  document.getElementById('active-desc')!.textContent = item.descriptionZh;
  document.getElementById('active-status-badge')!.textContent = item.statusZh;
}

// Filter tabs
document.querySelectorAll('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const filter = btn.getAttribute('data-filter') as 'all' | 'stage1' | 'stage2';
    renderSidebarList(filter);
  });
});

// Level selector buttons
document.querySelectorAll('.tool-btn[data-level]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn[data-level]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentLevel = Number(btn.getAttribute('data-level'));
    loadModel(currentId, currentLevel);
  });
});

// Wireframe toggle
const wireframeBtn = document.getElementById('btn-wireframe')!;
wireframeBtn.addEventListener('click', () => {
  wireframe = !wireframe;
  wireframeBtn.classList.toggle('active', wireframe);
  if (currentGroup) applyWireframe(currentGroup, wireframe);
});

// Auto-rotate toggle
const autoRotateBtn = document.getElementById('btn-autorotate')!;
autoRotateBtn.addEventListener('click', () => {
  autoRotate = !autoRotate;
  controls.autoRotate = autoRotate;
  autoRotateBtn.classList.toggle('active', autoRotate);
});

// Reset camera
document.getElementById('btn-reset')!.addEventListener('click', () => {
  controls.reset();
  camera.position.set(3.2, 1.8, 3.8);
  controls.target.set(0, 0, 0);
  controls.update();
});

// Export Transparent PNG
document.getElementById('btn-export-png')!.addEventListener('click', () => {
  floor.visible = false;
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  floor.visible = true;

  const link = document.createElement('a');
  link.download = `${currentId}-lv${currentLevel}.png`;
  link.href = url;
  link.click();
});

// Export GLB 3D asset
document.getElementById('btn-export-glb')!.addEventListener('click', () => {
  if (!currentGroup) return;
  const exporter = new GLTFExporter();
  exporter.parse(
    currentGroup,
    (gltf) => {
      const blob = new Blob([gltf as ArrayBuffer], { type: 'model/gltf-binary' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${currentId}-lv${currentLevel}.glb`;
      link.click();
    },
    (err) => console.error('Export GLB error:', err),
    { binary: true },
  );
});

// Hotkeys
window.addEventListener('keydown', (e) => {
  if (e.key === 'w' || e.key === 'W') {
    wireframe = !wireframe;
    wireframeBtn.classList.toggle('active', wireframe);
    if (currentGroup) applyWireframe(currentGroup, wireframe);
  } else if (e.key === 'r' || e.key === 'R') {
    autoRotate = !autoRotate;
    controls.autoRotate = autoRotate;
    autoRotateBtn.classList.toggle('active', autoRotate);
  }
});

// Main animation loop
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// Initialize
const initialDef = ACCESSORIES[0];
updateActiveInfo(initialDef);
renderSidebarList('all');
loadModel(currentId, currentLevel);
