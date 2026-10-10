import * as THREE from 'three';
import { BreathSource, type BreathMode } from './breath';
import { Diver } from './diver';
import { Fish, FishSpec, RARITY_ORDER, fishValue, rollFish, ZONES, type Zone } from './fish';
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
import { HALF_WIDTH, World } from './world';
import { MAPS, MAP_ORDER, bankValue, isUnlocked, loadMapProgress, mapDepth, mapZones, saveMapProgress, type MapId } from './maps';
import { MapPicker } from './mappicker';
import { AdaptiveQuality, renderPixelRatio } from './render-quality';
import type { TimeOfDay } from './daylight';
import { GearPanel } from './gear-panel';
import { LoadoutWheel, QUICK_SLOTS } from './loadout-wheel';
import { deriveStats, loadEquipment, nextSlotTier, rodTier, saveEquipment, setEquipmentPath, upgradeSlot, type EquipmentPathId, type EquipmentState, type EquipmentSlot } from './equipment';

// ---- Tuning -------------------------------------------------------------
const DRAG = 2.4;
const SURFACE_DEPTH = 0.9; // shallower than this counts as "at the surface"
const EMERGENCY_LIFT = 18;
const RELEASE_DEBOUNCE_MS = 500; // breathing must last this long underwater to count
const FISH_PER_ZONE = [16, 16, 12];

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
let maxDepth = mapDepth(world.map);
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
world.colorGrade.apply(diver.group);
const hud = new Hud();
const breath = new BreathSource(document.getElementById('cam') as HTMLVideoElement);

const fishes: Fish[] = [];

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

function rollFor(zone: Zone, depth: number): FishSpec {
  const a = rollFish(randomSeed(), zone, depth);
  if (!world.night) return a;
  // Night: two rolls, keep the rarer. Better fish, but it's dark down there.
  const b = rollFish(randomSeed(), zone, depth);
  return RARITY_ORDER.indexOf(b.rarity) > RARITY_ORDER.indexOf(a.rarity) ? b : a;
}

function spawnFish(zone: Zone) {
  const depth = THREE.MathUtils.randFloat(zone.top + 1.5, zone.bottom - 0.5);
  const spec = rollFor(zone, depth);
  const fish = new Fish(spec, zone, THREE.MathUtils.randFloat(-HALF_WIDTH, HALF_WIDTH), -depth, HALF_WIDTH);
  fishes.push(fish);
  scene.add(fish.mesh.group);
  world.colorGrade.apply(fish.mesh.group);
}

/** Fill the zones the current map opens. Deeper zones stay empty: you cannot reach them here. */
function populate() {
  for (const f of fishes) scene.remove(f.mesh.group);
  fishes.length = 0;
  mapZones(world.map).forEach((zone) => {
    for (let k = 0; k < FISH_PER_ZONE[ZONES.indexOf(zone)]; k++) spawnFish(zone);
  });
}
populate();

// ---- Game state ---------------------------------------------------------
type Phase = 'menu' | 'calibrating' | 'play' | 'blackout';
let phase: Phase = 'menu';
let outOfAir = false;
let emergency = 1;
let net: FishSpec[] = [];
const bank: FishSpec[] = loadBank();
const equipment: EquipmentState = loadEquipment();
// The persistent inventory is filtered by the workbench for each dive. A null
// loadout means the debug/title state where all owned upgrades are available.
let activeLoadout: readonly UpgradeId[] | null = null;
let activeTool: EquipmentSlot = 'net';
const currentStats = () => deriveStats(equipment, activeLoadout ?? undefined);
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
let lastHolding = false;
let breathSince: number | null = null; // when the sensor last flipped to "breathing" underwater

function loadBank(): FishSpec[] {
  try {
    return JSON.parse(localStorage.getItem('deepbreath.bank') ?? '[]');
  } catch {
    return [];
  }
}

function saveBank() {
  try {
    localStorage.setItem('deepbreath.bank', JSON.stringify(bank));
  } catch {}
}

const currentTier = () => rodTier(equipment);
hud.setNet(net, currentStats().netCapacity);
hud.setBank(bank);
const vault = new Vault(bank, saveBank);
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
  hud.setEquipment(equipment, tier);
  hud.setNet(net, stats.netCapacity);
  gear.render(equipment);
  applyEquipmentVisuals();
}

function buyNextUpgrade(slot: EquipmentSlot = 'net') {
  if (phase === 'play') {
    gear.showNotice('Return to the workbench before upgrading gear.');
    return;
  }
  const next = nextSlotTier(equipment, slot);
  if (!next) {
    gear.showNotice(`${nextSlotLabel(slot)} is already at maximum level.`);
    return;
  }
  const upgraded = upgradeSlot(equipment, slot);
  if (!upgraded) {
    gear.showNotice(`Need ${next.cost - equipment.pearls} more Pearls.`);
    hud.message(`Need ${next.cost - equipment.pearls} more Pearls`, 1500);
    return;
  }
  Object.assign(equipment, upgraded);
  refreshEquipment();
  hud.message(`${nextSlotLabel(slot)} upgraded: Level ${next.level}`, 1800);
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

function nextSlotLabel(slot: EquipmentSlot) {
  return ({ net: 'Net', rod: 'Rod shaft', reel: 'Recovery reel', fins: 'Fins', tank: 'Emergency tank', lamp: 'Headlamp' } as const)[slot];
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
  if (e.key === 'Enter' && titleScreen.visible && !pauseMenu.open) {
    // Otherwise Enter also "clicks" whatever button still has focus (e.g. the card's Back).
    e.preventDefault();
    openWorkbench();
  }
  keys.add(e.key.toLowerCase());
  // On the workbench any key (H included) packs the inspected gear; don't also pop the report.
  if (e.key.toLowerCase() === 'h' && phase !== 'calibrating' && !workbench.visible) report.toggle();
  if (e.key.toLowerCase() === 'g' && phase !== 'play' && phase !== 'calibrating') {
    e.preventDefault();
    gear.toggle();
    return;
  }
  if (phase !== 'play') return;
  if (e.code === 'Space') {
    e.preventDefault();
    tryCatch();
  } else if (e.key.toLowerCase() === 'c') {
    vault.toggle();
  } else if (e.key.toLowerCase() === 'g') {
    gear.toggle();
  } else if (e.key.toLowerCase() === 'n') {
    const nightSelected = world.dayCycle.mode === 'night'
      || (world.dayCycle.mode === 'cycle' && world.night);
    setTimeOfDay(nightSelected ? 'morning' : 'night');
  } else if (e.key.toLowerCase() === 'k') {
    const order = breathModes();
    setBreathMode(order[(order.indexOf(breath.state.mode) + 1) % order.length]);
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
window.addEventListener('keyup', (e) => {
  if (loadoutWheel.handleKeyUp(e)) return;
  keys.delete(e.key.toLowerCase());
});
document.getElementById('collection-close')!.addEventListener('click', () => vault.toggle(false));
document.getElementById('gear-open')!.addEventListener('click', () => gear.toggle(true));
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
  fishes.splice(fishes.indexOf(best), 1);
  scene.remove(best.mesh.group);
  const caught = { ...best.spec, depthM: Math.round(-best.pos.y), map: world.map.id };
  net.push(caught);
  hud.setNet(net, stats.netCapacity);
  hud.toast(caught);
  const zone = best.zone;
  const map = world.map;
  // Skip the respawn if the player has moved to another map in the meantime.
  setTimeout(() => world.map === map && spawnFish(zone), 4000);
}

function bankNet() {
  if (!net.length) return;
  const reward = net.reduce((sum, f) => sum + fishValue(f), 0);
  bank.push(...net);
  saveBank();
  equipment.pearls += reward;
  refreshEquipment();
  const rarest = net.reduce((a, f) => (fishValue(f) > fishValue(a) ? f : a));
  hud.message(`Banked ${net.length} fish · +${reward} Pearls`);
  hud.toast(rarest, 'BANKED');
  net = [];
  hud.setNet(net, currentStats().netCapacity);
  hud.setBank(bank);
  noteBankValue(true);
}

// ---- Maps ---------------------------------------------------------------
/** Record progress toward the next map, and say so when a dive opens one. */
function noteBankValue(announce: boolean) {
  const value = bankValue(bank);
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
    maxDepth,
    map.water.filter(([d]) => d <= maxDepth).map(([, c]) => c),
  );
}

function selectMap(id: MapId) {
  if (phase !== 'menu' || id === world.map.id || !isUnlocked(MAPS[id], mapProgress)) return;
  mapProgress.selected = id;
  saveMapProgress(mapProgress);
  world.setMap(MAPS[id]);
  maxDepth = mapDepth(world.map);
  populate();
  showMapOnHud();
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
noteBankValue(false);

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
  phase = 'play';
  overlay.classList.add('hidden');
  // The workbench's dive transition may still be fading out if the player was quick.
  workbench.hide();
  hud.show();
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
  if (pauseMenu.open) pauseMenu.back();
  else if (report.open) report.toggle(false);
  else if (vault.open) vault.toggle(false);
  else if (gear.open) gear.toggle(false);
  else if (breathTest.open) breathTest.stop();
  else if (workbench.visible && phase === 'menu') workbench.escape();
  else if (phase === 'play') pause();
  else if (phase === 'calibrating') goToMenu();
  else if (!overlay.classList.contains('hidden')) backFromStartCard();
}

function goToMenu() {
  // Abandoning a dive loses the net, but the breath-hold itself still goes in the health log.
  health.end(nowMs, 'surfaced', 0);
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
  world.setLightingEffects(s.lightingEffects);
  world.setWeather(s.weather);
  world.setQuality(renderQuality.settings);
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
// START drops its fish onto the workbench (gear + map); the dive launches from the start card.
const titleScreen = new TitleScreen(document.getElementById('title-canvas') as HTMLCanvasElement, [
  { seed: 0x5eed01, rarity: 'legendary', hue: 40, sat: 0.95, light: 0.56, archetype: 'bulky', at: 0.32, label: 'START', onClick: openWorkbench },
  { seed: 0x5eed02, rarity: 'common', hue: 35, sat: 0.18, light: 0.55, at: 0.52 },
  { seed: 0x5eed03, rarity: 'epic', hue: 285, sat: 0.75, light: 0.56, archetype: 'bulky', at: 0.71, label: 'SETTINGS', onClick: () => pauseMenu.openSettings() },
]);

// Gear packed on the workbench for this dive. The selected slots are applied
// when the map transition starts, so an omitted accessory falls back to tier 1.
let loadout: UpgradeId[] = [];

const workbench = new Workbench({
  progress: () => mapProgress,
  setUnlockAll: setDemoUnlock,
  dive(id, gear) {
    loadout = gear;
    activeLoadout = [...gear];
    const firstPacked = QUICK_SLOTS.find((item) => gear.includes(item.slot));
    activeTool = firstPacked?.slot ?? 'net';
    loadoutWheel.setActive(activeTool);
    hud.setActiveGear(activeTool, activeLoadout.includes(activeTool));
    applyEquipmentVisuals();
    hud.setNet(net, currentStats().netCapacity);
    selectMap(id);
    openStartCard();
  },
  back: () => showTitle(false),
});

function showTitle(intro: boolean) {
  overlay.classList.add('hidden');
  workbench.hide();
  titleScreen.show(intro);
}

function openWorkbench() {
  titleScreen.dropAway('START', () => {
    titleScreen.hide();
    workbench.show(true);
  });
}

function openStartCard() {
  titleScreen.hide();
  overlay.classList.remove('hidden');
}

function backFromStartCard() {
  if (breathTest.open) breathTest.stop();
  // The camera may already be on (calibration or breath test): release it on the way out.
  if (phase === 'calibrating' || breath.video.srcObject) goToMenu();
  else {
    overlay.classList.add('hidden');
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
  // Fins improve ordinary swimming only. Emergency ascent keeps its own cap.
  const cap = outOfAir ? 10 : currentStats().swimSpeed;
  if (diver.vel.length() > cap) diver.vel.setLength(cap);
  if (!s.holding && !outOfAir && depth < 3) diver.vel.y += 6 * dt;
  diver.pos.addScaledVector(diver.vel, dt);
  diver.pos.x = THREE.MathUtils.clamp(diver.pos.x, -HALF_WIDTH, HALF_WIDTH);
  diver.pos.y = THREE.MathUtils.clamp(diver.pos.y, world.seabedY + 1.2, -0.05);

  if (-diver.pos.y <= SURFACE_DEPTH) {
    if (outOfAir) {
      outOfAir = false;
      hud.message(net.length ? 'Made it!' : 'Phew.', 900);
    }
    if (phase === 'play') {
      health.end(nowMs, net.length ? 'banked' : 'surfaced', net.length);
      bankNet();
    }
  }

  diver.update(dt, time, -diver.pos.y);
  for (const f of fishes) f.update(dt, time, diver.pos);
  world.update(time, camera.position.y, camera.position.x);

  // Camera: side-on 2.5D follow with a little lead. Underwater it stays below
  // the surface so we never look at the diver through the translucent waves.
  const camY = diver.pos.y > -2.5 ? 2.2 : Math.min(diver.pos.y + 1.2, -1.2);
  camTarget.set(diver.pos.x + diver.vel.x * 0.35, Math.max(camY, world.seabedY + 9), 22);
  camera.position.lerp(camTarget, Math.min(1, dt * 3));
  camera.lookAt(camera.position.x, camera.position.y - 1.6, 0);

  hud.setBreath(s, outOfAir);
  hud.setDepth(-diver.pos.y, maxDepth);
  hud.setEmergency(outOfAir ? emergency : null);
  if (phase === 'calibrating') updateCalibration();
}

let time = 0;
function frame() {
  const elapsed = clock.getDelta();
  if (renderQuality.observeFrame(elapsed, !document.hidden && !paused)) {
    world.setQuality(renderQuality.settings);
    resize();
  }
  const dt = Math.min(elapsed, 0.05);
  // Lighting uses elapsed time even on slow GPUs; only physics needs a capped step.
  world.advanceTime(resetDayClock || document.hidden ? 0 : elapsed, !paused && !document.hidden);
  resetDayClock = false;
  if (!paused) {
    time += dt;
    update(dt, time);
  } else {
    world.updateLighting(time, camera.position.y, camera.position.x);
  }
  updateTimeLabel();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();

// Exposed for quick debugging in the console: debugStep(2) simulates 2 s.
Object.assign(window, {
  workbench,
  loadout: () => loadout,
  breath,
  breathTest,
  titleScreen,
  world,
  selectMap,
  diver,
  fishes,
  keys,
  renderQuality,
  setTimeOfDay,
  debugStep(seconds: number) {
    for (let t = 0; t < seconds; t += 1 / 30) {
      time += 1 / 30;
      world.advanceTime(1 / 30);
      update(1 / 30, time);
    }
    renderer.render(scene, camera);
  },
});
