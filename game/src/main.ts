import * as THREE from 'three';
import { Shipyard, SHIPS } from './ships';
import { BreathSource, type BreathMode } from './breath';
import { Diver } from './diver';
import { type Band, Fish, FishSpec, RARITY_ORDER, fishValue, recordedDepth, rollFish, ZONES } from './fish';
import { Hud } from './hud';
import { Vault } from './vault';
import { HealthLog } from './health';
import { Report } from './report';
import { BreathTest } from './breathtest';
import { PauseMenu } from './pause';
import { TitleScreen } from './title';
import { Workbench } from './workbench';
import type { UpgradeId } from './upgrades';
import { loadSettings, type Settings } from './settings';
import { HALF_WIDTH, MAX_HALF_WIDTH, TRENCH_HALF_WIDTH, World } from './world';
import {
  advanceWorldBounds,
  cameraTargetXToBounds,
  clampWorldXToBounds,
  createWorldBounds,
} from './bounds';
import { MAPS, MAP_ORDER, bankValue, isUnlocked, loadMapProgress, mapDepth, mapZones, saveMapProgress, type MapId } from './maps';
import { MapPicker } from './mappicker';
import { AdaptiveQuality, renderPixelRatio } from './render-quality';
import type { TimeOfDay } from './daylight';
import { GearPanel } from './gear-panel';
import { LoadoutWheel, QUICK_SLOTS } from './loadout-wheel';
import { applySlotUpgrade, deriveStats, loadEquipment, nextSlotTier, planSlotUpgrade, rodTier, saveEquipment, setEquipmentPath, totalPearls, type EquipmentPathId, type EquipmentState, type EquipmentSlot, type UpgradeSlot } from './equipment';
import { addBankedValue, bankEntry, migrateBank, migrateUnlockProgress, type BankedFish } from './market';
import { NftQueue } from './nft-queue';
import { onWalletChange, restoreWallet, storageKey, walletState } from './wallet';
import { LoginGate, mountWalletRow } from './login';
import { WorldEvents, type EventContext } from './events';
import { ROGUE, RogueWaves, canRight, capsizeLoss } from './storm';
import { StormFx } from './storm-fx';
import { disposeTree } from './lowpoly';
import { DeepSonar } from './deep-sonar';
import { loadSonarConfig, saveSonarConfig } from './sonar-config';

// ---- Tuning -------------------------------------------------------------
const DRAG = 2.4;
const SURFACE_DEPTH = 0.9; // shallower than this counts as "at the surface"
const EMERGENCY_LIFT = 18;
const RELEASE_DEBOUNCE_MS = 500; // breathing must last this long underwater to count
// Keep encounter density stable as the playable width doubles.
const FISH_PER_ZONE = [32, 32, 24];
// Every map's seabed is a shelf; under the boat a trench drops away with no
// bottom. The map only sets how deep the shelf is (world.seabedY).
const DEPTH_LIMIT = Infinity;
const TRENCH_X = TRENCH_HALF_WIDTH - 1.2; // how far left/right the diver can go inside it
// The trench is too deep to stock up front: a school of fish follows the
// diver down, each one rolled for the depth it's spawned at.
const TRENCH_FISH = 12;

// ---- Setup --------------------------------------------------------------
const canvas = document.getElementById('scene') as HTMLCanvasElement;
const settings = loadSettings();
const renderQuality = new AdaptiveQuality({
  cores: navigator.hardwareConcurrency,
  memoryGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
}, settings.quality);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: renderQuality.settings.antialias });
renderer.outputColorSpace = THREE.SRGBColorSpace;

// The map you last played, unless it is no longer open (e.g. the demo switch was turned off).
const mapProgress = loadMapProgress();
if (!isUnlocked(MAPS[mapProgress.selected], mapProgress)) mapProgress.selected = 'fjord';
const world = new World(renderQuality.settings, MAPS[mapProgress.selected]);
// The generated terrain supports the full ±200 m safety corridor. Edges open
// only when the diver is moving toward them, then ease back toward ±140 m.
const worldBounds = createWorldBounds(HALF_WIDTH, MAX_HALF_WIDTH);
const scene = world.scene;
const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 400);
camera.position.set(0, 1.5, 24);

function resize() {
  renderer.setPixelRatio(renderPixelRatio(renderQuality.settings, window.innerWidth, window.innerHeight, window.devicePixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const diver = new Diver(scene);
diver.setQuality(renderQuality.settings);
world.colorGrade.apply(diver.group);
diver.setMaterialBinder((root) => world.colorGrade.apply(root));
const hud = new Hud();

// Random world events (avalanches, whales, a leviathan...). They play only during a
// dive (see update()); menus show none and cost nothing.
const events = new WorldEvents(scene, world.map, renderQuality.settings.detail);
world.colorGrade.apply(scene);
const eventCtx: EventContext = { cameraY: 2.2, depth: 0, night: false, shelfDepth: 30 };
let eventsLive = false;
const shakeOffset = new THREE.Vector3();
// Fish near the diver bolt for a moment when the ground shakes or something huge passes.
const SCATTER: Record<string, number> = { avalanche: 5, rockfall: 1.5, leviathan: 2 }; // seconds until it hits
const scatterAt = new THREE.Vector3();
const scatterThreat = new THREE.Vector3();
let scatterFrom = Infinity;
let scatterUntil = -Infinity;
let scatterFresh = false;
events.onEvent = (e) => {
  hud.message(e.label, 2600);
  const delay = SCATTER[e.id];
  if (delay !== undefined) {
    scatterFrom = time + delay;
    scatterUntil = scatterFrom + 2.5;
    scatterFresh = true;
  }
};

let eventDetail = renderQuality.settings.detail;
/** Keep the events' detail level in step with the render quality. */
function syncEventDetail() {
  const detail = renderQuality.settings.detail;
  if (detail === eventDetail) return;
  eventDetail = detail;
  events.setDetail(detail);
  // The rebuild made new materials: give them the scene's colour grade too.
  world.colorGrade.apply(scene);
}
const breath = new BreathSource(document.getElementById('cam') as HTMLVideoElement);

const fishes: Fish[] = [];
let fishCoverageLeft = worldBounds.left;
let fishCoverageRight = worldBounds.right;
const FISH_EDGE_BAND = 8;

function resetWorldBounds() {
  worldBounds.left = -worldBounds.baseHalfWidth;
  worldBounds.right = worldBounds.baseHalfWidth;
  fishCoverageLeft = worldBounds.left;
  fishCoverageRight = worldBounds.right;
}

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

function rollFor(depth: number): FishSpec {
  const a = rollFish(randomSeed(), depth);
  if (!world.night) return a;
  // Night: two rolls, keep the rarer. Better fish, but it's dark down there.
  const b = rollFish(randomSeed(), depth);
  return RARITY_ORDER.indexOf(b.rarity) > RARITY_ORDER.indexOf(a.rarity) ? b : a;
}

function addFish(band: Band, depth: number, halfWidth: number, minX = -halfWidth, maxX = halfWidth) {
  const left = Math.min(minX, maxX);
  const right = Math.max(minX, maxX);
  const fish = new Fish(rollFor(depth), band, THREE.MathUtils.randFloat(left, right), -depth, halfWidth);
  fishes.push(fish);
  scene.add(fish.mesh.group);
  world.colorGrade.apply(fish.mesh.group);
  return fish;
}

function removeFish(fish: Fish) {
  fishes.splice(fishes.indexOf(fish), 1);
  scene.remove(fish.mesh.group);
  trenchFish.delete(fish);
  // Each fish owns its geometry and materials: free them with the mesh.
  disposeTree(fish.mesh.group);
}

function spawnFish(band: Band, minX = worldBounds.left, maxX = worldBounds.right) {
  const depth = THREE.MathUtils.randFloat(band.top + 1.5, band.bottom - 0.5);
  const fish = addFish(band, depth, worldBounds.maxHalfWidth, minX, maxX);
  fish.setWorldBounds(worldBounds.left, worldBounds.right);
}

// Trench fish live in a window around the diver's depth. New ones appear
// out of view (not within VIEW_M of the diver) so they never pop in on screen.
const trenchFish = new Set<Fish>();
const VIEW_M = 14;
// Each trench fish roams this far above and below the depth it was rolled at:
// wide enough to swim from out of view into view, close enough that its rarity
// still fits where it's caught.
const TRENCH_ROAM_M = 9;
// A diver who stops in the trench should have this many fish within NEAR_M
// (on screen) or swimming there.
const NEAR_WANT = 3;
const NEAR_M = 10;

/** Shallowest depth a trench fish may spawn at: the current map's shelf. */
function trenchTop(): number {
  return mapDepth(world.map);
}

function trenchWindow(diverDepth: number): [number, number] {
  const top = Math.max(trenchTop(), diverDepth - 25);
  return [top, Math.max(top + 45, diverDepth + 45)];
}

function spawnTrenchFish(diverDepth: number) {
  const [top, bottom] = trenchWindow(diverDepth);
  let depth = THREE.MathUtils.randFloat(top, bottom);
  for (let tries = 0; tries < 8 && Math.abs(depth - diverDepth) < VIEW_M; tries++) {
    depth = THREE.MathUtils.randFloat(top, bottom);
  }
  return addTrenchFish(depth);
}

function addTrenchFish(depth: number): Fish {
  const band = { top: Math.max(trenchTop() - 1, depth - TRENCH_ROAM_M), bottom: depth + TRENCH_ROAM_M };
  const fish = addFish(band, depth, TRENCH_X - 0.8);
  trenchFish.add(fish);
  return fish;
}

/** Point a trench fish at the depth in its band closest to the diver; true if that's on screen. */
function headToward(f: Fish, diverDepth: number, radius = NEAR_M): boolean {
  const depth = THREE.MathUtils.clamp(diverDepth, f.band.top + 1.5, f.band.bottom - 0.5);
  if (Math.abs(depth - diverDepth) >= radius) return false;
  f.target.y = -depth;
  return true;
}

function tendTrench(diverDepth: number) {
  const [top, bottom] = trenchWindow(diverDepth);
  for (const f of [...trenchFish]) {
    const d = -f.pos.y;
    if (d < top - 15 || d > bottom + 15) removeFish(f);
  }
  while (trenchFish.size < TRENCH_FISH) spawnTrenchFish(diverDepth);
  if (diverDepth <= trenchTop()) return;

  const guidanceRadius = sonarGuiding && sonar ? Math.max(NEAR_M, sonar.benefits.guidanceRadius + 4) : NEAR_M;
  const guidanceWant = sonarGuiding ? NEAR_WANT + 1 : NEAR_WANT;

  // Keep a few fish on screen (or on their way) for a diver who stops: send in
  // the closest ones that can reach, else swap the farthest for a fresh fish
  // just out of view above or below. Nothing spawns within VIEW_M.
  const gap = (f: Fish) => Math.abs(-f.pos.y - diverDepth);
  const coming = (f: Fish) => gap(f) < guidanceRadius || Math.abs(-f.target.y - diverDepth) < guidanceRadius;
  const others = [...trenchFish].filter((f) => !coming(f)).sort((a, b) => gap(a) - gap(b));
  let seen = trenchFish.size - others.length;
  for (const f of others) {
    if (seen >= guidanceWant) return;
    if (headToward(f, diverDepth, guidanceRadius)) seen++;
  }
  while (seen < guidanceWant && others.length && gap(others[others.length - 1]) >= VIEW_M) {
    removeFish(others.pop()!);
    const above = diverDepth - VIEW_M - 2 > trenchTop() && Math.random() < 0.5;
    const depth = diverDepth + (above ? -1 : 1) * THREE.MathUtils.randFloat(VIEW_M + 0.5, VIEW_M + 2);
    headToward(addTrenchFish(depth), diverDepth, guidanceRadius);
    seen++;
  }
}

/**
 * Stock the current map: the zones it opens across the whole width, and a fresh
 * trench school under its shelf. Deeper zones are only reachable down the
 * trench, where that school covers them.
 */
function populate() {
  for (const f of [...fishes]) removeFish(f);
  fishes.length = 0;
  fishCoverageLeft = worldBounds.left;
  fishCoverageRight = worldBounds.right;
  mapZones(world.map).forEach((zone) => {
    for (let k = 0; k < FISH_PER_ZONE[ZONES.indexOf(zone)]; k++) spawnFish(zone);
  });
  for (let k = 0; k < TRENCH_FISH; k++) spawnTrenchFish(0);
}

/** Keep encounter density continuous when a newly opened edge becomes reachable. */
function extendFishCoverage() {
  if (worldBounds.right - fishCoverageRight >= FISH_EDGE_BAND) {
    const start = fishCoverageRight;
    const end = worldBounds.right;
    for (const zone of mapZones(world.map)) spawnFish(zone, start, end);
    fishCoverageRight = end;
  }
  if (fishCoverageLeft - worldBounds.left >= FISH_EDGE_BAND) {
    const start = worldBounds.left;
    const end = fishCoverageLeft;
    for (const zone of mapZones(world.map)) spawnFish(zone, start, end);
    fishCoverageLeft = start;
  }
}
populate();

// ---- Game state ---------------------------------------------------------
type Phase = 'menu' | 'calibrating' | 'play' | 'blackout';
let phase: Phase = 'menu';
let outOfAir = false;
let emergency = 1;
let net: FishSpec[] = [];
const bank: BankedFish[] = loadBank();
const equipment: EquipmentState = loadEquipment();
// The persistent inventory is filtered by the workbench for each dive. A null
// loadout means the debug/title state where all owned upgrades are available.
let activeLoadout: readonly UpgradeId[] | null = null;
let activeTool: EquipmentSlot = 'net';
let shipBonus: (typeof SHIPS)[number] = SHIPS[0];
// The ship's bonus goes on top of the packed gear: extra net slots, a wider catch, a faster swim.
const currentStats = () => {
  const stats = deriveStats(equipment, activeLoadout ?? undefined);
  return {
    ...stats,
    netCapacity: stats.netCapacity + shipBonus.capacity,
    catchRadius: stats.catchRadius * (1 + shipBonus.range),
    swimSpeed: stats.swimSpeed * (1 + shipBonus.speed),
  };
};
const activeLevel = (slot: EquipmentSlot): number => {
  const packed = activeLoadout;
  if (packed && !packed.includes(slot)) return 1;
  if (slot === 'net') return equipment.netLevel;
  if (slot === 'rod') return equipment.rodGearLevel;
  if (slot === 'reel') return equipment.reelLevel;
  if (slot === 'fins') return equipment.finsLevel;
  if (slot === 'tank') return equipment.tankLevel;
  return equipment.lampLevel;
};
function applyEquipmentVisuals() {
  const stats = currentStats();
  diver.setNetLevel(activeLevel('net'));
  diver.setRodLevel(activeLevel('rod'));
  diver.setRodRange(stats.rodRange);
  diver.setFinsLevel(activeLevel('fins'));
  diver.setTankLevel(activeLevel('tank'));
  diver.setLampLevel(activeLevel('lamp'));
  diver.setLampStats(stats.lampDistance, stats.lampIntensity, stats.lampAngle);
  diver.setReelLevel(activeLevel('reel'));
  diver.setReelRecovery(stats.reelRecovery);
}
const sonar = new DeepSonar({ color: loadSonarConfig().color, lengthLevel: equipment.sonarLevel, detail: renderQuality.settings.detail, startsCarried: false });
scene.add(sonar.group);
sonar.group.visible = false;
let sonarCarried = false;
let sonarGuiding = false;
let lastHolding = false;
let breathSince: number | null = null; // when the sensor last flipped to "breathing" underwater

// ---- Rough seas ---------------------------------------------------------
// On a map with storm swell (the Open Ocean), a storm sends rogue waves at the boat (storm.ts).
const stormSea = new RogueWaves();
const stormFx = new StormFx(scene);
world.colorGrade.apply(stormFx.group);
const seaSurface = (x: number, z: number) => world.surfaceAt(x, z);
const GEAR_SLOTS: readonly EquipmentSlot[] = ['net', 'rod', 'reel', 'fins', 'tank', 'lamp'];
let stormShake = 0;
let capsizeHintAt = 0;

/** The boat goes over: part of the catch and one piece of packed gear are lost, and nothing can be banked until it is righted. */
function capsize() {
  const packed = (activeLoadout ?? GEAR_SLOTS).filter((slot): slot is EquipmentSlot => GEAR_SLOTS.includes(slot as EquipmentSlot));
  const loss = capsizeLoss(net.length, packed);
  const spilled = loss.fish.map((i) => net.splice(i, 1)[0]);
  // The wave breaks over the boat: spray, the deck cargo and the lost fish go into the sea.
  stormFx.capsize(0, stormSea.dir, spilled, seaSurface);
  if (loss.gear) {
    // Gone for the rest of this dive: that slot works at its basic level, as if never packed.
    activeLoadout = (activeLoadout ?? GEAR_SLOTS).filter((slot) => slot !== loss.gear);
    if (activeTool === loss.gear) {
      activeTool = 'net';
      loadoutWheel.setActive(activeTool);
    }
    hud.setActiveGear(activeTool, true);
    applyEquipmentVisuals();
  }
  hud.setNet(net, currentStats().netCapacity);
  const lost = [
    loss.fish.length ? `${loss.fish.length} fish` : '',
    loss.gear ? `your ${nextSlotLabel(loss.gear).toLowerCase()}` : '',
  ].filter(Boolean).join(' and ');
  hud.message(lost ? `CAPSIZED · lost ${lost}` : 'CAPSIZED', 3200);
  hud.setAlert('Boat capsized · swim to it and right it', 'F');
  stormShake = 0.7;
  capsizeHintAt = time + 5;
}

/** F: heave the boat back over, from the surface beside it. */
function rightBoat() {
  if (!stormSea.capsized) return;
  if (!canRight(diver.pos.x - stormSea.boatX, -diver.pos.y)) {
    hud.message('Surface beside the boat to right it', 1600);
    return;
  }
  if (stormSea.right()) hud.message('Heave! Righting the boat…', ROGUE.rightSeconds * 1000);
}

/** Calm water and an upright boat: a new dive, or back on the menu. */
function calmSea() {
  stormSea.reset();
  stormFx.clear();
  stormShake = 0;
  world.boatPose = null;
  world.setRogueWave(null, 1, 0);
  hud.setAlert(null);
}

function loadBank(): BankedFish[] {
  try {
    // Fish banked under the old rule were paid on surfacing: migrateBank marks them legacy.
    const key = storageKey('bank');
    const { bank, changed } = migrateBank(JSON.parse(localStorage.getItem(key) ?? '[]'));
    if (changed) {
      try {
        localStorage.setItem(key, JSON.stringify(bank));
      } catch {}
    }
    return bank;
  } catch {
    return [];
  }
}

function saveBank() {
  try {
    localStorage.setItem(storageKey('bank'), JSON.stringify(bank));
  } catch {}
}

const currentTier = () => { const tier = rodTier(equipment); return { ...tier, capacity: tier.capacity + shipBonus.capacity, catchRadius: tier.catchRadius * (1 + shipBonus.range) }; };
hud.setNet(net, currentStats().netCapacity);
hud.setBank(bank);
const nftQueue = new NftQueue(bank, saveBank, {
  changed: () => vault.refresh(),
  sold(fish, result) {
    hud.setBank(bank);
    hud.toast(fish, `SOLD · +${result.pearls} PEARLS`);
    void syncPearls(result.pearls);
  },
});
const vault = new Vault(bank, nftQueue);
// The queue starts once a wallet's bank is loaded (see loadWalletProgress).
const health = new HealthLog();
const report = new Report(health);
const gear = new GearPanel((slot) => buyNextUpgrade(slot), (slot, path) => selectEquipmentPath(slot, path));
gear.render(equipment);
hud.setEquipment(equipment, currentTier());
diver.setNetLevel(currentTier().level);
applyEquipmentVisuals();
const loadoutWheel = new LoadoutWheel({
  isAvailable: (slot) => activeLoadout == null || activeLoadout.includes(slot),
  onSelect: (slot) => {
    activeTool = slot;
    hud.setActiveGear(slot, activeLoadout == null || activeLoadout.includes(slot));
    const label = QUICK_SLOTS.find((item) => item.slot === slot)?.label ?? slot;
    hud.message(`${label} 已装备`, 900);
  },
  onUnavailable: (slot) => {
    const label = QUICK_SLOTS.find((item) => item.slot === slot)?.label ?? slot;
    hud.message(`${label} 未装配 · 下次下潜前在工作台打包`, 1800);
  },
});
hud.setActiveGear(activeTool, true);
let nowMs = 0;

function refreshEquipment() {
  const tier = currentTier();
  const stats = currentStats();
  saveEquipment(equipment);
  const sonarConfig = saveSonarConfig({ ...loadSonarConfig(), lengthLevel: equipment.sonarLevel });
  sonar.setLengthLevel(equipment.sonarLevel);
  sonar.setColor(sonarConfig.color);
  hud.setEquipment(equipment, tier);
  hud.setNet(net, stats.netCapacity);
  gear.render(equipment);
  applyEquipmentVisuals();
}

/** Re-read the on-chain PEARL balance into the cache. `earned` shows a sale's Pearls before the read lands. */
async function syncPearls(earned = 0) {
  if (earned) {
    equipment.pearls += earned;
    refreshEquipment();
  }
  try {
    equipment.pearls = await (await nftQueue.loadPearl()).pearlBalance();
    refreshEquipment();
  } catch (e) {
    console.warn('PEARL balance unavailable', e);
  }
}

let buying = false;
async function buyNextUpgrade(slot: UpgradeSlot = 'net') {
  if (buying) return;
  if (phase === 'play') {
    gear.showNotice('Return to the workbench before upgrading gear.');
    return;
  }
  const next = nextSlotTier(equipment, slot);
  if (!next) {
    gear.showNotice(`${nextSlotLabel(slot)} is already at maximum level.`);
    return;
  }
  const plan = planSlotUpgrade(equipment, slot);
  if (!plan) {
    gear.showNotice(`Need ${next.cost - totalPearls(equipment)} more Pearls.`);
    hud.message(`Need ${next.cost - totalPearls(equipment)} more Pearls`, 1500);
    return;
  }
  // Legacy local Pearls go first; the rest is burned on-chain, and the tier applies only once that lands.
  buying = true;
  gear.setBusy(true);
  try {
    if (plan.fromChain > 0) await (await nftQueue.loadPearl()).spendPearls(plan.fromChain);
    Object.assign(equipment, applySlotUpgrade(equipment, plan));
    hud.message(`${nextSlotLabel(slot)} upgraded: Level ${plan.tier.level}`, 1800);
  } catch (e) {
    console.error('upgrade failed', e);
    gear.showNotice(`Upgrade failed: ${(e as Error).message ?? e}`);
  } finally {
    buying = false;
    gear.setBusy(false);
    refreshEquipment();
    if (plan.fromChain > 0) void syncPearls();
  }
}

function selectEquipmentPath(slot: EquipmentSlot, path: EquipmentPathId) {
  if (phase === 'play') {
    gear.showNotice('Return to the workbench before changing a module.');
    return;
  }
  const next = setEquipmentPath(equipment, slot, path);
  if (!next) {
    gear.showNotice('Upgrade this slot to Lv2 before selecting a branch.');
    return;
  }
  Object.assign(equipment, next);
  refreshEquipment();
  hud.message(`${nextSlotLabel(slot)} module changed`, 1200);
}

function nextSlotLabel(slot: UpgradeSlot) {
  return ({ net: 'Net', rod: 'Rod shaft', reel: 'Recovery reel', fins: 'Fins', tank: 'Emergency tank', lamp: 'Headlamp', sonar: 'Deep sonar' } as const)[slot];
}

// ---- Input --------------------------------------------------------------
const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (loadoutWheel.open) {
      loadoutWheel.closeWheel(false);
      return;
    }
    onEscape();
    return;
  }
  // Tab is a hold-to-open radial wheel. Number keys and Q/E are instant
  // quick-slot shortcuts; consume them before movement/catch handling.
  if (loadoutWheel.handleKeyDown(e, phase === 'play' && !paused && !gear.open && !vault.open && !report.open)) return;
  if (paused) return;
  if (e.key === 'Enter' && titleScreen.visible && !workbench.visible && !loginGate.visible && !pauseMenu.open) {
    // Otherwise Enter also "clicks" whatever button still has focus (e.g. the card's Back).
    e.preventDefault();
    openWorkbench();
  }
  keys.add(e.key.toLowerCase());
  // Not on the workbench: the report would pop up over the table and the chart.
  if (e.key.toLowerCase() === 'h' && phase !== 'calibrating' && !workbench.visible) report.toggle();
  if (e.key.toLowerCase() === 'g' && phase !== 'play' && phase !== 'calibrating') {
    e.preventDefault();
    gear.toggle();
    if (gear.open) void syncPearls();
    return;
  }
  if (phase !== 'play') return;
  if (e.code === 'Space') {
    e.preventDefault();
    tryCatch();
  } else if (e.key.toLowerCase() === 'c') {
    vault.toggle();
    if (vault.open) void syncPearls();
  } else if (e.key.toLowerCase() === 'g') {
    gear.toggle();
    if (gear.open) void syncPearls();
  } else if (e.key.toLowerCase() === 'n') {
    const nightSelected = world.dayCycle.mode === 'night'
      || (world.dayCycle.mode === 'cycle' && world.night);
    setTimeOfDay(nightSelected ? 'morning' : 'night');
  } else if (e.key.toLowerCase() === 'v') {
    deploySonar();
  } else if (e.key.toLowerCase() === 'k') {
    const order = breathModes();
    setBreathMode(order[(order.indexOf(breath.state.mode) + 1) % order.length]);
  } else if (e.key.toLowerCase() === 'f') {
    rightBoat();
  }
});

function breathModes(): BreathMode[] {
  return breath.video.srcObject ? ['presage', 'sim', 'keyboard'] : ['sim', 'keyboard'];
}

function setBreathMode(mode: BreathMode) {
  breath.setMode(mode);
  hud.message(`Breath input: ${mode}`);
}

function setTimeOfDay(mode: TimeOfDay) {
  world.setTimeOfDay(mode);
  const labels: Record<TimeOfDay, string> = { cycle: 'Natural day cycle', morning: 'Morning light', afternoon: 'Afternoon light', night: 'Moonlight. Rarer fish rise.' };
  hud.message(labels[mode]);
}

function carrySonarForDive() {
  if (!loadout.includes('sonar')) {
    sonar.group.visible = false;
    sonarCarried = false;
    sonarGuiding = false;
    return;
  }
  sonar.setLengthLevel(equipment.sonarLevel);
  sonar.setColor(loadSonarConfig().color);
  sonar.setCarried();
  diver.group.add(sonar.group);
  sonar.group.visible = true;
  sonar.group.scale.setScalar(0.2);
  sonar.group.position.set(-0.25, -0.4, 0.45);
  sonar.group.rotation.set(0, 0, 0);
  sonarCarried = true;
  sonarGuiding = false;
}

/** How far the transducer weight hangs below the cable's rated length. */
const SONAR_ANCHOR_DROP = 0.9;

function deploySonar() {
  if (phase !== 'play' || !sonarCarried || sonar.mode !== 'carried') return;
  const top = new THREE.Vector3();
  sonar.group.getWorldPosition(top);
  scene.attach(sonar.group);
  sonar.group.visible = true;
  sonar.group.scale.setScalar(1);
  sonar.group.rotation.set(0, 0, 0);
  const target = top.clone();
  top.z = 0;
  target.y -= 1;
  target.z = 0;
  // Same floor rule as update(): the trench under the boat has no floor, the
  // shelf does. Over the shelf, stop the weighted end on the seabed instead of
  // lowering it through the ground (it still stays under the surface).
  const floorY = Math.abs(target.x) <= TRENCH_X ? -Infinity : world.seabedY;
  target.y = Math.min(-0.6, Math.max(target.y, floorY + sonar.length + SONAR_ANCHOR_DROP));
  sonar.group.position.copy(top);
  sonar.deploy(target);
  sonarCarried = false;
  hud.message('Deep sonar lowering…', 1400);
}

function resetSonar() {
  if (sonar.group.parent !== scene) scene.attach(sonar.group);
  sonar.group.visible = false;
  sonar.group.scale.setScalar(1);
  sonar.group.position.set(0, 0, 0);
  sonar.group.rotation.set(0, 0, 0);
  sonar.anchor(new THREE.Vector3(0, 0, 0));
  sonarCarried = false;
  sonarGuiding = false;
}
window.addEventListener('keyup', (e) => {
  if (loadoutWheel.handleKeyUp(e)) return;
  keys.delete(e.key.toLowerCase());
});
document.getElementById('collection-close')!.addEventListener('click', () => vault.toggle(false));
document.getElementById('gear-open')!.addEventListener('click', () => {
  gear.toggle(true);
  void syncPearls();
});
for (const id of ['report-btn', 'open-report']) document.getElementById(id)!.addEventListener('click', () => report.toggle(true));

function axis(neg: string[], pos: string[]) {
  return (pos.some((k) => keys.has(k)) ? 1 : 0) - (neg.some((k) => keys.has(k)) ? 1 : 0);
}

// ---- Catching -----------------------------------------------------------
function tryCatch() {
  // The net must finish its visible recovery before another throw. The reel
  // upgrade shortens that recovery without changing breath input or rarity.
  if (diver.swinging) return;
  diver.swing();
  if (diver.pos.y > -SURFACE_DEPTH) return;
  const stats = currentStats();
  if (net.length >= stats.netCapacity) {
    hud.message('Net full! Surface to bank it.');
    return;
  }
  const p = diver.netPoint();
  let best: Fish | null = null;
  let bestD = stats.catchRadius;
  for (const f of fishes) {
    const d = Math.hypot(f.pos.x - p.x, f.pos.y - p.y);
    if (d < bestD) {
      best = f;
      bestD = d;
    }
  }
  if (!best) return;
  const inTrench = trenchFish.has(best);
  removeFish(best);
  // The record stops at MAX_RECORDED_DEPTH_M (the market's limit); the HUD shows the real depth.
  const caught = { ...best.spec, depthM: recordedDepth(-best.pos.y), map: world.map.id };
  net.push(caught);
  hud.setNet(net, stats.netCapacity);
  hud.toast(caught);
  // Trench fish are topped up by tendTrench(); shallow ones come back to their band.
  if (!inTrench) {
    const band = best.band;
    const map = world.map;
    // Skip the respawn if the player has moved to another map in the meantime.
    setTimeout(() => world.map === map && spawnFish(band), 4000);
  }
}

// Banking pays nothing: every fish is queued to become an NFT, and Pearls come only from selling one.
function bankNet() {
  if (!net.length) return;
  bank.push(...net.map(bankEntry));
  saveBank();
  const rarest = net.reduce((a, f) => (fishValue(f) > fishValue(a) ? f : a));
  hud.message(`Banked ${net.length} fish · minting NFTs…`);
  hud.toast(rarest, 'BANKED');
  noteBankValue(true, addBankedValue(mapProgress.bestValue, bankValue(net)));
  net = [];
  hud.setNet(net, currentStats().netCapacity);
  hud.setBank(bank);
  nftQueue.kick();
}

// ---- Maps ---------------------------------------------------------------
/** Record progress toward the next map (the lifetime banked value), and say so when a dive opens one. */
function noteBankValue(announce: boolean, value: number) {
  if (value <= mapProgress.bestValue) return;
  const opened = MAP_ORDER.map((id) => MAPS[id]).filter(
    (m) => !mapProgress.unlockAll && mapProgress.bestValue < m.unlockValue && value >= m.unlockValue,
  );
  mapProgress.bestValue = value;
  saveMapProgress(mapProgress);
  mapPicker.render();
  const last = opened.at(-1);
  if (announce && last) setTimeout(() => hud.message(`New waters open: ${last.name} · ${last.nameZh}`, 3200), 2000);
}

function showMapOnHud() {
  const map = world.map;
  hud.setZones(
    mapZones(map).map((z, i) => ({ label: map.zoneLabels[i], top: z.top, bottom: z.bottom })),
    mapDepth(map),
    map.water,
  );
}

/** Put the world on a map: scenery, its fish and trench school, and the HUD's zones and shelf. */
function applyMap(id: MapId) {
  if (id === world.map.id) return;
  resetWorldBounds();
  world.setMap(MAPS[id]);
  // The event pool follows the map, whether the picker or a restored wallet chose it.
  events.setMap(world.map);
  world.colorGrade.apply(scene);
  populate(); // also swaps the old trench school for one under the new shelf
  showMapOnHud();
}

/** anyMap: the workbench's chart lets you pick any place, locked or not. */
function selectMap(id: MapId, anyMap = false) {
  if (phase !== 'menu' || id === world.map.id || (!anyMap && !isUnlocked(MAPS[id], mapProgress))) return;
  mapProgress.selected = id;
  saveMapProgress(mapProgress);
  applyMap(id);
  mapPicker.render();
}

function setDemoUnlock(on: boolean) {
  mapProgress.unlockAll = on;
  // Turning the demo switch off while standing on a locked map sends you back to the first one.
  if (!isUnlocked(world.map, mapProgress)) selectMap('fjord');
  saveMapProgress(mapProgress);
  mapPicker.render();
}

const mapPicker = new MapPicker(mapProgress, selectMap, setDemoUnlock);
showMapOnHud();
noteBankValue(false, migrateUnlockProgress(mapProgress.bestValue, bankValue(bank)));

function blackout() {
  phase = 'blackout';
  const lost = net.length;
  health.end(nowMs, 'blackout', lost);
  net = [];
  hud.setNet(net, currentStats().netCapacity);
  hud.message(lost ? `BLACKOUT · ${lost} fish lost` : 'BLACKOUT', 2200);
  hud.setEmergency(null);
  setTimeout(() => {
    diver.pos.set(0, -0.4, 0);
    diver.vel.set(0, 0, 0);
    outOfAir = false;
    phase = 'play';
  }, 2000);
}

// ---- Calibration flow ---------------------------------------------------
const overlay = document.getElementById('overlay')!;
const calib = document.getElementById('calib')!;
const calibStep = document.getElementById('calib-step')!;
const calibSub = document.getElementById('calib-sub')!;
let sawHold = false;
let calibPhase = '';
let calibFallback: ReturnType<typeof setTimeout> | null = null;

function markCalib(phase: string) {
  if (phase === calibPhase) return;
  calibPhase = phase;
  breath.sendCalib(phase);
}

function startGame() {
  shipyard.reload(); shipBonus = shipyard.bonus; hud.setNet(net, currentStats().netCapacity);
  calmSea();
  phase = 'play';
  resetWorldBounds();
  overlay.classList.add('hidden');
  // The workbench's dive transition may still be fading out if the player was quick.
  workbench.hide();
  hud.show();
  carrySonarForDive();
  hud.message('Hold your breath and dive!', 2400);
}

document.getElementById('start-live')!.addEventListener('click', async () => {
  try {
    await breath.startLive();
    document.getElementById('cam-wrap')!.style.visibility = 'visible';
    phase = 'calibrating';
    calib.classList.remove('hidden');
  } catch (err) {
    console.error(err);
    calib.classList.remove('hidden');
    calibStep.textContent = 'Camera unavailable: using keyboard';
    breath.setMode('keyboard');
    setTimeout(startGame, 1200);
  }
});
document.getElementById('start-keys')!.addEventListener('click', () => {
  breath.setMode('keyboard');
  startGame();
});
document.getElementById('calib-skip')!.addEventListener('click', startGame);

// Guided breath test: labeled data for tuning the detector (see sensor/analyze.mjs).
const breathTest = new BreathTest(breath);
async function startBreathTest() {
  try {
    if (!breath.video.srcObject) await breath.startLive();
    document.getElementById('cam-wrap')!.style.visibility = 'visible';
    hud.show();
    breathTest.start();
  } catch (err) {
    console.error(err);
    document.getElementById('start-test')!.textContent = 'Camera blocked: allow camera access, then retry · 请允许摄像头';
  }
}
document.getElementById('start-test')!.addEventListener('click', startBreathTest);
document.getElementById('test-again')!.addEventListener('click', () => breathTest.start());
document.getElementById('test-stop')!.addEventListener('click', () => breathTest.stop());
document.getElementById('test-play')!.addEventListener('click', () => {
  breathTest.stop();
  startGame();
});

function updateCalibration() {
  const s = breath.state;
  if (s.mode === 'keyboard' && s.error) {
    // breath.ts dropped to keyboard, e.g. the server's live Presage slots are all taken.
    calibStep.textContent = 'Playing with keyboard: hold Shift to dive';
    calibSub.textContent = s.error;
    camWrap.style.visibility = 'hidden';
    if (!calibFallback) calibFallback = setTimeout(() => phase === 'calibrating' && startGame(), 3000);
  } else if (!s.connected) {
    calibStep.textContent = 'Connecting to breath sensor…';
    calibSub.textContent = import.meta.env.DEV ? 'Start it with: npm run sensor' : 'Reconnecting…';
  } else if (!s.trace.length) {
    calibStep.textContent = 'Presage is warming up…';
    calibSub.textContent = s.hint || 'Sit still, face and chest in view';
  } else if (!s.calibrated) {
    calibStep.textContent = 'Breathe normally…';
    markCalib('breathe');
    calibSub.textContent = s.hint || 'Learning your breathing rhythm';
  } else if (!sawHold) {
    calibStep.textContent = 'Now hold your breath!';
    markCalib('hold');
    calibSub.textContent = 'We will dive the moment we see it';
    if (s.holding) {
      sawHold = true;
      markCalib('done');
      calibStep.textContent = 'Got it. Dive!';
      setTimeout(() => phase === 'calibrating' && startGame(), 900);
    }
  }
}

// ---- Pause menu ---------------------------------------------------------
const camWrap = document.getElementById('cam-wrap')!;
let paused = false;
let resetDayClock = false;

function pause() {
  if (phase !== 'play' || paused) return;
  paused = true;
  keys.clear();
  loadoutWheel.closeWheel(false);
  vault.toggle(false);
  gear.toggle(false);
  report.toggle(false);
  pauseMenu.show();
}

function onEscape() {
  if (shipyard.open) shipyard.close();
  else if (pauseMenu.open) pauseMenu.back();
  else if (report.open) report.toggle(false);
  else if (vault.open) vault.toggle(false);
  else if (gear.open) gear.toggle(false);
  else if (breathTest.open) breathTest.stop();
  else if (loginGate.visible) showTitle(false);
  else if (workbench.visible && phase === 'menu') workbench.escape();
  else if (phase === 'play') pause();
  else if (phase === 'calibrating') goToMenu();
  else if (!overlay.classList.contains('hidden')) backFromStartCard();
}

function goToMenu() {
  // Abandoning a dive loses the net, but the breath-hold itself still goes in the health log.
  health.end(nowMs, 'surfaced', 0);
  calmSea();
  net = [];
  activeLoadout = null;
  loadout = [];
  activeTool = 'net';
  loadoutWheel.setActive(activeTool);
  hud.setActiveGear(activeTool, true);
  applyEquipmentVisuals();
  hud.setNet(net, currentStats().netCapacity);
  hud.setEmergency(null);
  outOfAir = false;
  breathSince = null;
  lastHolding = false;
  diver.pos.set(0, -0.4, 0);
  diver.vel.set(0, 0, 0);
  resetSonar();
  resetWorldBounds();
  paused = false;
  phase = 'menu';
  pauseMenu.close();
  vault.toggle(false);
  gear.toggle(false);
  report.toggle(false);
  breath.stopLive();
  sawHold = false;
  calibPhase = '';
  if (calibFallback) clearTimeout(calibFallback);
  calibFallback = null;
  calib.classList.add('hidden');
  camWrap.style.visibility = 'hidden';
  hud.hide();
  showTitle(true);
}

function applySettings(s: Settings) {
  renderQuality.setMode(s.quality);
  diver.setQuality(renderQuality.settings);
  world.setLightingEffects(s.lightingEffects);
  world.setWeather(s.weather);
  world.setQuality(renderQuality.settings);
  sonar.setDetail(renderQuality.settings.detail);
  syncEventDetail();
  resize();
  camWrap.classList.toggle('off', !s.showCamera);
  document.getElementById('help')!.classList.toggle('hidden', !s.showHelp);
}

const pauseMenu = new PauseMenu(settings, {
  resume() {
    paused = false;
    keys.clear();
    // Whatever the player did while paused doesn't count toward "breathed underwater".
    breathSince = null;
  },
  quitToMenu: goToMenu,
  needsCountdown: () => -diver.pos.y > SURFACE_DEPTH,
  quitWarning: () => (net.length ? `Your net (${net.length} fish) will be lost.` : null),
  breathModes,
  breathMode: () => breath.state.mode,
  setBreathMode,
  timeOfDay: () => world.dayCycle.mode,
  setTimeOfDay,
  applySettings,
});

// ---- Title screen -------------------------------------------------------
const shipyard = new Shipyard(world.boat, () => mapProgress.bestValue, (open) => {
  paused = open;
  keys.clear();
  if (!open) breathSince = null;
}, () => { shipBonus = shipyard.bonus; hud.setNet(net, currentStats().netCapacity); }, scene, root => world.colorGrade.apply(root));
const boatRay = new THREE.Raycaster();
document.addEventListener('click', (e) => {
  if (phase !== 'menu' || !titleScreen.visible || paused || workbench.visible || loginGate.visible || pauseMenu.open || vault.open || gear.open || report.open) return;
  if (e.target !== canvas && e.target !== document.getElementById('title-canvas')) return;
  const rect = canvas.getBoundingClientRect();
  boatRay.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1, -(e.clientY-rect.top)/rect.height*2+1), camera);
  if (boatRay.intersectObject(world.boat, true).length) { e.preventDefault(); e.stopPropagation(); shipyard.show(); }
}, true);
document.addEventListener('pointermove', (e) => {
  if (e.target !== canvas && e.target !== document.getElementById('title-canvas')) return;
  const target = e.target as HTMLCanvasElement;
  if (phase !== 'menu' || !titleScreen.visible || paused || workbench.visible || loginGate.visible || pauseMenu.open) { target.style.cursor = ''; return; }
  const rect = canvas.getBoundingClientRect();
  boatRay.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1, -(e.clientY-rect.top)/rect.height*2+1), camera);
  if (boatRay.intersectObject(world.boat,true).length) target.style.cursor = 'pointer';
});
// START pans the camera down to the workbench (gear + sea chart); the dive launches from the start card.
const titleScreen = new TitleScreen(document.getElementById('title-canvas') as HTMLCanvasElement, [
  { seed: 0x5eed01, rarity: 'legendary', hue: 40, sat: 0.95, light: 0.56, archetype: 'bulky', at: 0.32, label: 'START', onClick: openWorkbench },
  { seed: 0x5eed02, rarity: 'common', hue: 35, sat: 0.18, light: 0.55, at: 0.52 },
  { seed: 0x5eed03, rarity: 'epic', hue: 285, sat: 0.75, light: 0.56, archetype: 'bulky', at: 0.71, label: 'SETTINGS', onClick: () => pauseMenu.openSettings() },
]);

// Gear set in the workbench's READY tray for this dive. The selected slots are
// applied when the dive starts, so an omitted accessory falls back to tier 1.
let loadout: UpgradeId[] = [];

// How far the sea camera sinks while the workbench is up, so the pan reads behind the table too.
const BENCH_CAMERA_DROP = 1.4;
let benchPan = 0;

const workbench = new Workbench({
  progress: () => mapProgress,
  pan(u, tableY) {
    benchPan = u;
    titleScreen.setPan(u, tableY);
  },
  preview: mapPreview,
  dive(id, gear) {
    loadout = gear;
    activeLoadout = [...gear];
    const firstPacked = QUICK_SLOTS.find((item) => gear.includes(item.slot));
    activeTool = firstPacked?.slot ?? 'net';
    loadoutWheel.setActive(activeTool);
    hud.setActiveGear(activeTool, activeLoadout.includes(activeTool));
    applyEquipmentVisuals();
    hud.setNet(net, currentStats().netCapacity);
    selectMap(id, true);
    // The preview frame expanding over the screen was taken from exactly here.
    benchPan = 0;
    snapToDiveCamera();
    openStartCard();
  },
  sonarColor(color) {
    sonar.setColor(color);
  },
});

function showTitle(intro: boolean) {
  overlay.classList.add('hidden');
  loginGate.hide();
  workbench.hide();
  benchPan = 0;
  titleScreen.setPan(0);
  titleScreen.show(intro);
}

// Phantom is required: START goes through the login gate unless a wallet is connected.
const loginGate = new LoginGate(() => showTitle(false));
mountWalletRow(document.getElementById('set-wallet')!);

function openWorkbench() {
  if (workbench.visible || loginGate.visible) return;
  // A silent reconnect may still be in flight.
  void walletRestored.then(() => {
    if (workbench.visible || loginGate.visible) return;
    if (walletState().connected) workbench.show(true);
    else loginGate.show();
  });
}

// ---- Wallet -------------------------------------------------------------
// Progress above starts as defaults: storage is per wallet, and saves are
// no-ops until Phantom connects. The first connect loads that wallet's
// progress in place; switching accounts or disconnecting reloads the page,
// so nothing in memory from one wallet can be saved under another.
let walletOwner: string | null = null;

function loadWalletProgress() {
  bank.splice(0, bank.length, ...loadBank());
  Object.assign(equipment, loadEquipment());
  Object.assign(mapProgress, loadMapProgress());
  if (!isUnlocked(MAPS[mapProgress.selected], mapProgress)) mapProgress.selected = 'fjord';
  health.reload();
  applyMap(mapProgress.selected); // the same switch the map picker makes
  hud.setBank(bank);
  refreshEquipment();
  mapPicker.render();
  noteBankValue(false, migrateUnlockProgress(mapProgress.bestValue, bankValue(bank)));
  shipyard.reload(); shipBonus = shipyard.bonus; refreshEquipment();
  // Resume fish this wallet left queued to mint or sell.
  nftQueue.start();
}

onWalletChange((s) => {
  if (s.owner === walletOwner) return;
  if (walletOwner) {
    location.reload();
    return;
  }
  walletOwner = s.owner;
  loadWalletProgress();
  if (loginGate.visible) {
    loginGate.hide();
    workbench.show(true);
  }
});
const walletRestored = restoreWallet();

function openStartCard() {
  titleScreen.hide();
  benchPan = 0;
  overlay.classList.remove('hidden');
}

function backFromStartCard() {
  if (breathTest.open) breathTest.stop();
  // The camera may already be on (calibration or breath test): release it on the way out.
  if (phase === 'calibrating' || breath.video.srcObject) goToMenu();
  else {
    overlay.classList.add('hidden');
    titleScreen.show(false);
    workbench.show(false);
  }
}

document.getElementById('card-back')!.addEventListener('click', backFromStartCard);
showTitle(true);

// A hidden tab throttles the game loop to ~2 fps; don't let the dive run on unattended.
document.addEventListener('visibilitychange', () => {
  resetDayClock = true;
  if (document.hidden) pause();
});

// ---- Main loop ----------------------------------------------------------
const clock = new THREE.Clock();
const camTarget = new THREE.Vector3();
const timeLabel = document.getElementById('time-of-day')!;
let displayedMinute = -1;
let displayedWeather = '';

function updateTimeLabel() {
  const minute = Math.round(world.dayCycle.hour * 60) % (24 * 60);
  const weather = world.weather.state.kind;
  if (minute === displayedMinute && weather === displayedWeather) return;
  displayedMinute = minute;
  displayedWeather = weather;
  const hour = Math.floor(minute / 60);
  const period = world.night ? 'Night' : hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Dusk';
  const weatherLabels = { clear: 'Clear', cloudy: 'Cloudy', rain: 'Rain', storm: 'Storm' };
  timeLabel.textContent = `${period} · ${String(hour).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')} · ${weatherLabels[weather]}`;
}

function update(dt: number, time: number) {
  const s = breath.state;
  const depth = -diver.pos.y;
  const underwater = depth > SURFACE_DEPTH;
  const playing = phase === 'play';
  nowMs = time * 1000;
  health.tick(nowMs, s, depth, underwater && playing);

  if (playing) {
    // Breathing underwater = out of air. You must make it up before it runs out.
    // A single noisy "breathing" frame shouldn't cost the net: it must persist.
    breathSince = underwater && !s.holding ? (breathSince ?? nowMs) : null;
    if (breathSince != null && nowMs - breathSince >= RELEASE_DEBOUNCE_MS && !outOfAir) {
      outOfAir = true;
      emergency = 1;
      diver.exhale(22);
      hud.message('You breathed! SURFACE NOW!', 1500);
    }
    if (s.holding && !lastHolding && !underwater) hud.message('Diving…', 800);
    lastHolding = s.holding;

    let ax = axis(['arrowleft', 'a'], ['arrowright', 'd']);
    let ay = axis(['arrowdown', 's'], ['arrowup', 'w']);
    if (!underwater && !s.holding && ay < 0) {
      ay = 0;
      if (Math.random() < 0.02) hud.message('Hold your breath to dive', 900);
    }
    if (outOfAir && ay < 0) ay = 0;
    const stats = currentStats();
    diver.vel.x += ax * stats.swimAcceleration * dt;
    diver.vel.y += ay * stats.swimAcceleration * dt;
  }

  if (outOfAir) {
    diver.vel.y += EMERGENCY_LIFT * dt;
    emergency -= dt / currentStats().emergencySeconds;
    if (Math.random() < dt * 8) diver.exhale(1);
    if (emergency <= 0 && phase === 'play') blackout();
  }

  // Water drag, speed cap, and gentle buoyancy at the surface.
  diver.vel.multiplyScalar(Math.exp(-DRAG * dt));
  // Fins (and the ship's bonus) improve ordinary swimming only. Emergency ascent keeps its own cap.
  const cap = outOfAir ? 10 : currentStats().swimSpeed;
  if (diver.vel.length() > cap) diver.vel.setLength(cap);
  if (!s.holding && !outOfAir && depth < 3) diver.vel.y += 6 * dt;
  // Below the shelf you're inside the trench; above it, the shelf is the floor
  // everywhere except over the trench mouth. The shelf depth is per map.
  const shelfY = world.seabedY + 1.2; // lowest the diver can go outside the trench
  // The trench walls follow where the diver was before this step: otherwise
  // pressing down on the shelf would pull the diver sideways into the trench.
  const wall = diver.pos.y < shelfY ? TRENCH_X : HALF_WIDTH;
  diver.pos.addScaledVector(diver.vel, dt);
  advanceWorldBounds(worldBounds, diver.pos.x, diver.vel.x, dt);
  extendFishCoverage();
  // Inside the trench its walls hold the diver; over the shelf the map edges do.
  diver.pos.x = wall === TRENCH_X
    ? THREE.MathUtils.clamp(diver.pos.x, -TRENCH_X, TRENCH_X)
    : clampWorldXToBounds(diver.pos.x, worldBounds);
  const floor = Math.abs(diver.pos.x) > TRENCH_X ? shelfY : -DEPTH_LIMIT;
  diver.pos.y = THREE.MathUtils.clamp(diver.pos.y, floor, -0.05);

  if (-diver.pos.y <= SURFACE_DEPTH) {
    // Only in play: during the blackout the lift can still carry you up, and that's no rescue.
    if (outOfAir && phase === 'play') {
      outOfAir = false;
      hud.message(net.length ? 'Made it!' : 'Phew.', 900);
    }
    if (phase === 'play') {
      if (stormSea.capsized) {
        // Nowhere to land the catch while the boat is keel up: it stays in the net.
        health.end(nowMs, 'surfaced', 0);
        if (net.length && time > capsizeHintAt) {
          hud.message('The boat is capsized: right it to bank your catch', 2000);
          capsizeHintAt = time + 8;
        }
      } else {
        health.end(nowMs, net.length ? 'banked' : 'surfaced', net.length);
        bankNet();
      }
    }
  }

  // Rough seas: only during a dive, and only where a storm piles up the swell.
  const stormEvent = stormSea.tick(dt, world.weather.state.storm, phase === 'play' && world.map.stormSwell > 0);
  world.setRogueWave(stormSea.x, stormSea.dir, stormSea.height);
  world.boatPose = stormSea.capsized ? stormSea.pose : null;
  stormFx.update(dt, time, stormSea.x, stormSea.dir, stormSea.height, seaSurface);
  if (stormEvent === 'wave') hud.message('A rogue wave is bearing down on the boat!', 2600);
  else if (stormEvent === 'capsize') capsize();
  else if (stormEvent === 'righted') {
    hud.setAlert(null);
    hud.message('Boat righted', 1600);
  }
  // The sea shudders as the wave closes in, and jolts when it hits.
  if (stormSea.x !== null && !stormSea.capsized) stormShake = Math.max(stormShake, 0.12 * (stormSea.height / ROGUE.height) * Math.exp(-Math.abs(stormSea.x - diver.pos.x) / 25));
  stormShake = Math.max(0, stormShake - dt * 0.55);

  diver.update(dt, time, -diver.pos.y);
  // In heavy seas a swimmer near the surface rises and falls with the swell (the picture only:
  // depth, air and banking still count from the mean waterline).
  diver.group.position.y += world.heaveAt(diver.pos.x) * (1 - THREE.MathUtils.smoothstep(-diver.pos.y, 0.5, 6));
  sonar.update(time, dt);
  if (!sonarCarried && sonar.mode === 'anchored' && !sonarGuiding && sonar.group.visible) {
    sonarGuiding = true;
    hud.message('Sonar guidance online · follow the pulses', 2200);
  }
  tendTrench(-diver.pos.y);
  const scattering = time >= scatterFrom && time < scatterUntil;
  if (scattering && scatterFresh) {
    scatterAt.copy(diver.pos);
    scatterFresh = false;
  }
  for (const f of fishes) {
    // The trench school keeps to the trench; only shelf fish follow the opening map edges.
    if (!trenchFish.has(f)) f.setWorldBounds(worldBounds.left, worldBounds.right);
    const near = scattering && Math.abs(f.pos.x - scatterAt.x) < 16 && Math.abs(f.pos.y - scatterAt.y) < 12;
    // A threat just behind each nearby fish, on the diver's side: it darts away.
    f.update(dt, time, near ? scatterThreat.copy(f.pos).sub(scatterAt).setZ(0).setLength(0.6).negate().add(f.pos) : diver.pos);
  }
  world.setDiver(diver.pos, diver.vel);
  world.update(time, camera.position.y, camera.position.x);

  // On the menu the camera sinks a little as the workbench pans in.
  cameraTarget(camTarget, phase === 'menu' ? benchPan * BENCH_CAMERA_DROP : 0);
  camera.position.sub(shakeOffset);
  camera.position.lerp(camTarget, Math.min(1, dt * 3));
  camera.lookAt(camera.position.x, camera.position.y - 1.6, 0);

  // World events, after World.update (the lightning flash tints what it wrote).
  // Only during a dive: leaving or starting one clears them and restarts the clock.
  const diving = phase === 'play' || phase === 'blackout';
  if (diving !== eventsLive) {
    eventsLive = diving;
    events.stop();
    scatterFrom = Infinity;
    scatterUntil = -Infinity;
  }
  if (diving) {
    const weather = world.weather.state;
    eventCtx.cameraY = camera.position.y;
    eventCtx.cameraX = camera.position.x;
    eventCtx.aspect = camera.aspect;
    eventCtx.depth = -diver.pos.y;
    eventCtx.night = world.night;
    eventCtx.shelfDepth = mapDepth(world.map); // below it is the trench
    const inTrench = Math.abs(diver.pos.x) <= TRENCH_X && diver.pos.y < shelfY; // as in cameraTarget()
    eventCtx.floorY = inTrench ? -Infinity : world.seabedY; // the trench has no floor
    eventCtx.lightingEffects = world.lightingEffectsEnabled;
    eventCtx.storm = weather.storm;
    eventCtx.cloud = weather.cloud;
    events.update(time, dt, eventCtx);
  }
  // The storm's own sheet lightning holds off while an event bolt strikes.
  world.quietWeatherLightning = events.activeId === 'lightning';
  // A subtle shake (a few cm) on top of the follow, taken off again next frame.
  const shake = events.shake + stormShake;
  shakeOffset.set(shake * Math.sin(time * 47.3) * Math.cos(time * 13.1), shake * Math.sin(time * 53.7 + 1.3) * Math.cos(time * 9.7), 0);
  camera.position.add(shakeOffset);

  hud.setBreath(s, outOfAir);
  hud.setDepth(-diver.pos.y);
  // outOfAir stays set through the 2 s blackout; blackout() already hid the bar.
  hud.setEmergency(outOfAir && phase === 'play' ? emergency : null);
  if (phase === 'calibrating') updateCalibration();
}

/**
 * Camera: side-on 2.5D follow with a little lead. Underwater it stays below the
 * surface so we never look at the diver through the translucent waves. `drop`
 * sinks it (the workbench pan).
 */
function cameraTarget(out: THREE.Vector3, drop: number) {
  // At the surface it rides above the swell, higher in a storm on the open ocean.
  const camY = diver.pos.y > -2.5 ? 2.2 + world.surfaceLift : Math.min(diver.pos.y + 1.2, -1.2);
  // Over the shelf the camera stays above the seabed; in the trench it follows you down.
  const shelfY = world.seabedY + 1.2; // as in update(): lowest the diver can go outside the trench
  const inTrench = Math.abs(diver.pos.x) <= TRENCH_X && diver.pos.y < shelfY;
  const camFloor = inTrench ? -Infinity : world.seabedY + 9;
  return out.set(cameraTargetXToBounds(diver.pos.x, diver.vel.x, worldBounds), Math.max(camY, camFloor) - drop, 22);
}

/** Puts the camera exactly where a dive starts (no workbench drop, no easing). */
function snapToDiveCamera() {
  cameraTarget(camera.position, 0);
  camera.lookAt(camera.position.x, camera.position.y - 1.6, 0);
}

// The workbench's live place preview: while it is on, every frame also renders the
// scene from where the dive starts and copies it here. Diving grows this canvas to
// the full screen over the live scene, which is then in exactly that view.
const previewCanvas = document.createElement('canvas');
const previewCamera = new THREE.PerspectiveCamera();
let previewOn = false;

/** Switches the world to that place and starts the live preview of it (null: stops it). */
function mapPreview(id: MapId | null): HTMLCanvasElement | null {
  previewOn = id != null;
  if (!id) return null;
  selectMap(id, true);
  renderPreview(); // a first frame right away, so it never shows empty
  return previewCanvas;
}

function renderPreview() {
  previewCamera.copy(camera); // same lens and aspect
  cameraTarget(previewCamera.position, 0);
  previewCamera.lookAt(previewCamera.position.x, previewCamera.position.y - 1.6, 0);
  renderer.render(scene, previewCamera);
  if (previewCanvas.width !== canvas.width || previewCanvas.height !== canvas.height) {
    previewCanvas.width = canvas.width;
    previewCanvas.height = canvas.height;
  }
  // Copied in the same task as the render, so the drawing buffer is still there.
  previewCanvas.getContext('2d')!.drawImage(canvas, 0, 0);
}

let time = 0;
function frame() {
  const elapsed = clock.getDelta();
  if (renderQuality.observeFrame(elapsed, !document.hidden && !paused)) {
    diver.setQuality(renderQuality.settings);
    world.setQuality(renderQuality.settings);
    sonar.setDetail(renderQuality.settings.detail);
    syncEventDetail();
    resize();
  }
  const dt = Math.min(elapsed, 0.05);
  // Lighting uses elapsed time even on slow GPUs; only physics needs a capped step.
  world.advanceTime(resetDayClock || document.hidden ? 0 : elapsed, (!paused || shipyard.open) && !document.hidden);
  resetDayClock = false;
  if (!paused) {
    time += dt;
    update(dt, time);
  } else {
    world.updateLighting(time, camera.position.y, camera.position.x);
  }
  updateTimeLabel();
  if (previewOn) renderPreview(); // before the main view, which is what the canvas then shows
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();

// Exposed for quick debugging in the console: debugStep(2) simulates 2 s.
Object.assign(window, {
  workbench,
  loadout: () => loadout,
  /** How far the camera is from where a dive starts (0 right after the workbench hands over). */
  diveCameraOffset: () => camera.position.distanceTo(cameraTarget(new THREE.Vector3(), 0)),
  breath,
  breathTest,
  titleScreen,
  world,
  events,
  renderer,
  /** Fire a world event now, e.g. trigger('whale'). Only during a dive, like the schedule. */
  trigger: (id: string) => eventsLive && events.trigger(id),
  selectMap,
  diver,
  fishes,
  keys,
  renderQuality,
  stormSea,
  nftQueue,
  /** The deep sonar mesh; deploySonar() is what V does during a dive with the sonar packed. */
  sonar,
  deploySonar,
  setTimeOfDay,
  walletState,
  debugStep(seconds: number) {
    for (let t = 0; t < seconds; t += 1 / 30) {
      time += 1 / 30;
      world.advanceTime(1 / 30);
      update(1 / 30, time);
    }
    renderer.render(scene, camera);
  },
});
