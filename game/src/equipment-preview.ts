import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { UPGRADES, buildUpgradeModel, type UpgradeId, type UpgradeLevel } from './upgrades';
import { ModelStudio, addEquipmentLights, blobDataUrl, disposeModel, modelGlb } from './model-assets';

const viewport = document.querySelector<HTMLDivElement>('#viewport')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
viewport.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#8f948b');
const room = new RoomEnvironment();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(room).texture;
room.dispose();
pmrem.dispose();
addEquipmentLights(scene);
const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 50);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 0.45;
controls.maxDistance = 10;
let current: THREE.Group;
let currentId: UpgradeId = 'rod';
let currentLevel: UpgradeLevel = 1;
const select = document.querySelector<HTMLSelectElement>('#equipment')!;
UPGRADES.forEach((definition) => select.add(new Option(definition.nameZh, definition.id)));

function resetView() {
  const bounds = new THREE.Box3().setFromObject(current);
  const centre = bounds.getCenter(new THREE.Vector3());
  const direction = new THREE.Vector3(3, 2.4, 5).normalize();
  camera.position.copy(centre).addScaledVector(direction, 8);
  camera.lookAt(centre);
  const inverseRotation = camera.quaternion.clone().invert();
  const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  let distance = 0.6;
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        const point = new THREE.Vector3(x, y, z).sub(centre).applyQuaternion(inverseRotation);
        distance = Math.max(distance, point.z + 1.25 * Math.max(Math.abs(point.x) / (tangent * camera.aspect), Math.abs(point.y) / tangent));
      }
    }
  }
  controls.target.copy(centre);
  camera.position.copy(centre).addScaledVector(direction, distance);
  controls.update();
}
function show(id: UpgradeId, level: UpgradeLevel) {
  const changedType = !current || currentId !== id;
  if (current) { scene.remove(current); disposeModel(current); }
  currentId = id;
  currentLevel = level;
  current = buildUpgradeModel(id, level);
  scene.add(current);
  select.value = id;
  document.querySelectorAll<HTMLButtonElement>('[data-level]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.level) === level)));
  const definition = UPGRADES.find((item) => item.id === id)!;
  document.querySelector('#effect')!.textContent = `${definition.nameZh} · Lv${level} · ${definition.effects[level - 1]}`;
  if (changedType) resetView();
}
select.addEventListener('change', () => show(select.value as UpgradeId, currentLevel));
document.querySelectorAll<HTMLButtonElement>('[data-level]').forEach((button) => button.addEventListener('click', () => show(currentId, Number(button.dataset.level) as UpgradeLevel)));
document.querySelector('#reset-view')!.addEventListener('click', resetView);
let fitted = false;
new ResizeObserver(() => {
  const { width, height } = viewport.getBoundingClientRect();
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  if (!fitted) { resetView(); fitted = true; }
}).observe(viewport);
show('rod', 1);
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

const studio = new ModelStudio();
const entries: { id: UpgradeId; level: UpgradeLevel; png: string; image: HTMLImageElement; glbLink: HTMLAnchorElement }[] = [];
const catalog = document.querySelector('#catalog')!;
const exports = document.querySelector('#exports')!;
function fileLink(file: string, data: string, text: string) {
  const link = document.createElement('a');
  link.href = data;
  link.download = file;
  link.dataset.file = file;
  link.textContent = text;
  return link;
}

function sheet(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 1620;
  canvas.height = 130 + UPGRADES.length * 340;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#252725'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#eeeee6'; ctx.font = 'bold 32px system-ui';
  ctx.fillText('HACKRU · 多面体装备 / 哑光材质', 32, 48);
  ctx.fillStyle = '#b5b5a7'; ctx.font = '18px system-ui';
  ctx.fillText('现实装备结构参考 · 大切面 / 硬轮廓 · 9 类 × 3 档', 32, 82);
  UPGRADES.forEach((definition, row) => {
    const y = 130 + row * 340;
    ctx.fillStyle = '#eeeee6'; ctx.font = 'bold 22px system-ui';
    ctx.fillText(`${definition.nameZh} / ${definition.name}`, 32, y + 28);
    for (const level of [1, 2, 3] as UpgradeLevel[]) {
      const entry = entries.find((item) => item.id === definition.id && item.level === level)!;
      const x = (level - 1) * 540;
      ctx.fillStyle = '#8f948b'; ctx.fillRect(x + 12, y + 40, 516, 260);
      ctx.drawImage(entry.image, x + 81, y + 40, 378, 252);
      ctx.fillStyle = '#c5c5b5'; ctx.font = '16px system-ui';
      ctx.fillText(`Lv${level} · ${definition.effects[level - 1]}`, x + 24, y + 322);
    }
  });
  return canvas.toDataURL('image/png');
}

async function previews() {
  for (const definition of UPGRADES) {
    for (const level of [1, 2, 3] as UpgradeLevel[]) {
      const model = buildUpgradeModel(definition.id, level);
      const png = studio.render(model);
      disposeModel(model);
      const figure = document.createElement('figure');
      const image = new Image();
      image.src = png;
      image.alt = `${definition.nameZh} Lv${level}`;
      await image.decode();
      image.addEventListener('click', () => show(definition.id, level));
      const caption = document.createElement('figcaption');
      const name = document.createElement('b'); name.textContent = image.alt;
      const effect = document.createElement('p'); effect.textContent = definition.effects[level - 1];
      const pngLink = fileLink(`${definition.id}-lv${level}.png`, png, 'PNG');
      const glbLink = document.createElement('a'); glbLink.textContent = 'GLB 待生成';
      caption.append(name, effect, pngLink, glbLink);
      figure.append(image, caption);
      catalog.append(figure);
      entries.push({ id: definition.id, level, png, image, glbLink });
    }
  }
  studio.dispose();
  const link = fileLink('equipment-contact-sheet.png', sheet(), '下载全部装备对照 PNG');
  link.className = 'download'; exports.append(link);
  document.querySelector('#status')!.textContent = '27 / 27 模型预览完成';
}
const ready = previews();
document.querySelector<HTMLButtonElement>('#export-all')!.addEventListener('click', async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  button.disabled = true;
  const status = document.querySelector('#status')!;
  try {
    await ready;
    const manifest = [];
    const loader = new GLTFLoader();
    for (const [index, entry] of entries.entries()) {
      status.textContent = `正在生成 GLB：${index + 1} / ${entries.length}`;
      const model = buildUpgradeModel(entry.id, entry.level);
      try {
        const glb = await modelGlb(model);
        const imported = await loader.parseAsync(glb, '');
        try {
          const expected = new THREE.Box3().setFromObject(model);
          const actual = new THREE.Box3().setFromObject(imported.scene);
          if (expected.min.distanceTo(actual.min) > 1e-4 || expected.max.distanceTo(actual.max) > 1e-4) throw new Error(`${entry.id} Lv${entry.level}: exported model bounds changed`);
        } finally { disposeModel(imported.scene); }
        const url = await blobDataUrl(new Blob([glb], { type: 'model/gltf-binary' }));
        const file = `${entry.id}-lv${entry.level}.glb`;
        entry.glbLink.href = url; entry.glbLink.download = file; entry.glbLink.dataset.file = file; entry.glbLink.textContent = 'GLB';
        const definition = UPGRADES.find((item) => item.id === entry.id)!;
        manifest.push({ id: entry.id, level: entry.level, name: definition.name, nameZh: definition.nameZh, group: definition.group, effect: definition.effects[entry.level - 1], png: `${entry.id}-lv${entry.level}.png`, glb: file, bytes: glb.byteLength });
      } finally { disposeModel(model); }
    }
    const data = await blobDataUrl(new Blob([JSON.stringify({ format: 'HackRU-equipment-v1', style: 'faceted-matte', displayUnits: 'longest-axis-2', assets: manifest }, null, 2)], { type: 'application/json' }));
    const old = document.querySelector('#manifest-link'); old?.remove();
    const link = fileLink('manifest.json', data, '下载素材索引'); link.id = 'manifest-link'; link.style.display = 'inline-block'; link.className = 'download'; exports.append(link);
    status.textContent = '27 / 27 PNG + GLB 素材生成完成';
    button.textContent = '重新生成全部素材';
  } catch (error) {
    status.textContent = `素材导出失败：${error instanceof Error ? error.message : String(error)}`;
  } finally { button.disabled = false; }
});
