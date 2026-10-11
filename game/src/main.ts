import * as THREE from 'three';
import { BreathSource, type BreathMode, type BreathState } from './breath';
import { Diver } from './diver';
import { type Band, Fish, FishSpec, RARITY_ORDER, fishValue, recordedDepth, rollFish, ZONES } from './fish';
import { Hud } from './hud';
import { Vault } from './vault';
import { HealthLog } from './health';
import { Report } from './report';
import { BreathTest } from './breathtest';
import { PauseMenu } from './pause';
import { SettingsDesk } from './settings-desk';
import { TitleScreen } from './title';
import { Aquarium } from './aquarium';
import { Workbench } from './workbench';
import type { UpgradeId } from './upgrades';
import { loadSettings, type Settings } from './settings';
import { HALF_WIDTH, TRENCH_HALF_WIDTH, World } from './world';
import { MAPS, MAP_ORDER, bankValue, isUnlocked, loadMapProgress, mapDepth, mapZones, saveMapProgress, type MapId } from './maps';
import { MapPicker } from './mappicker';
import { AdaptiveQuality, renderPixelRatio } from './render-quality';
import type { TimeOfDay } from './daylight';
import { GearPanel } from './gear-panel';
import { loadEquipment, nextRodTier, planUpgrade, rodTier, saveEquipment, totalPearls, type EquipmentState } from './equipment';
import { addBankedValue, bankEntry, migrateBank, migrateUnlockProgress, type BankedFish } from './market';
import { NftQueue } from './nft-queue';
import { onWalletChange, restoreWallet, storageKey, walletState } from './wallet';
import { LoginGate, mountWalletRow } from './login';

// ---- Tuning -------------------------------------------------------------
const SWIM_ACCEL = 24;
const DRAG = 2.4;
const MAX_SPEED = 7.5;
const SURFACE_DEPTH = 0.9; // shallower than this counts as "at the surface"
const EMERGENCY_SECONDS = 3.2; // air left after you breathe underwater
const EMERGENCY_LIFT = 18;
const RELEASE_DEBOUNCE_MS = 500; // breathing must last this long underwater to count
const FISH_PER_ZONE = [16, 16, 12];
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
// The title's backdrop is a random place at a random hour each visit. It isn't saved:
// the workbench's chart (or a wallet's last map) decides where you actually dive.
const backdropMap = MAP_ORDER[Math.floor(Math.random() * MAP_ORDER.length)];
const world = new World(renderQuality.settings, MAPS[backdropMap]);
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
// Between dives the diver sits on the bow (it rocks with the boat); a dive starts with a jump off it.
const bowSeat = new THREE.Object3D();
bowSeat.position.set(3.38, 0.66, 0);
world.boat.add(bowSeat);
diver.sit(bowSeat);
const JUMP_OUT = 2.6; // where the jump lands: this far past the bow, and this deep
const JUMP_DEPTH = 1.4;
// Floating at the surface this close to the boat, F climbs aboard and goes back to the workbench.
// Only once you've actually been down (BOARD_AFTER_M) on this dive, not straight after the jump.
const BOARD_REACH = 6.5;
const BOARD_AFTER_M = 3;
let wentDown = false;
const hud = new Hud();
const breath = new BreathSource(document.getElementById('cam') as HTMLVideoElement);

const fishes: Fish[] = [];

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

function addFish(band: Band, depth: number, halfWidth: number) {
  const fish = new Fish(rollFor(depth), band, THREE.MathUtils.randFloat(-halfWidth, halfWidth), -depth, halfWidth);
  fishes.push(fish);
  scene.add(fish.mesh.group);
  world.colorGrade.apply(fish.mesh.group);
  return fish;
}

function removeFish(fish: Fish) {
  fishes.splice(fishes.indexOf(fish), 1);
  scene.remove(fish.mesh.group);
  trenchFish.delete(fish);
}

function spawnFish(band: Band) {
  addFish(band, THREE.MathUtils.randFloat(band.top + 1.5, band.bottom - 0.5), HALF_WIDTH);
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
function headToward(f: Fish, diverDepth: number): boolean {
  const depth = THREE.MathUtils.clamp(diverDepth, f.band.top + 1.5, f.band.bottom - 0.5);
  if (Math.abs(depth - diverDepth) >= NEAR_M) return false;
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

  // Keep a few fish on screen (or on their way) for a diver who stops: send in
  // the closest ones that can reach, else swap the farthest for a fresh fish
  // just out of view above or below. Nothing spawns within VIEW_M.
  const gap = (f: Fish) => Math.abs(-f.pos.y - diverDepth);
  const coming = (f: Fish) => gap(f) < NEAR_M || Math.abs(-f.target.y - diverDepth) < NEAR_M;
  const others = [...trenchFish].filter((f) => !coming(f)).sort((a, b) => gap(a) - gap(b));
  let seen = trenchFish.size - others.length;
  for (const f of others) {
    if (seen >= NEAR_WANT) return;
    if (headToward(f, diverDepth)) seen++;
  }
  while (seen < NEAR_WANT && others.length && gap(others[others.length - 1]) >= VIEW_M) {
    removeFish(others.pop()!);
    const above = diverDepth - VIEW_M - 2 > trenchTop() && Math.random() < 0.5;
    const depth = diverDepth + (above ? -1 : 1) * THREE.MathUtils.randFloat(VIEW_M + 0.5, VIEW_M + 2);
    headToward(addTrenchFish(depth), diverDepth);
    seen++;
  }
}

/**
 * Stock the current map: the zones it opens across the whole width, and a fresh
 * trench school under its shelf. Deeper zones are only reachable down the
 * trench, where that school covers them.
 */
function populate() {
  for (const f of [...trenchFish]) removeFish(f);
  for (const f of fishes) scene.remove(f.mesh.group);
  fishes.length = 0;
  mapZones(world.map).forEach((zone) => {
    for (let k = 0; k < FISH_PER_ZONE[ZONES.indexOf(zone)]; k++) spawnFish(zone);
  });
  for (let k = 0; k < TRENCH_FISH; k++) spawnTrenchFish(0);
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
let lastHolding = false;
let breathSince: number | null = null; // when the sensor last flipped to "breathing" underwater

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

const currentTier = () => rodTier(equipment);
hud.setNet(net, currentTier().capacity);
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
const aquarium = new Aquarium(bank, {
  pan(u) {
    aquariumPan = u;
    titleScreen.setLift(u);
  },
});
// The queue starts once a wallet's bank is loaded (see loadWalletProgress).
const health = new HealthLog();
const report = new Report(health);
const gear = new GearPanel(() => buyNextRod());
gear.render(equipment);
hud.setEquipment(equipment, currentTier());
diver.setNetLevel(currentTier().level);
let nowMs = 0;

function refreshEquipment() {
  const tier = currentTier();
  saveEquipment(equipment);
  hud.setEquipment(equipment, tier);
  hud.setNet(net, tier.capacity);
  gear.render(equipment);
  diver.setNetLevel(tier.level);
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
async function buyNextRod() {
  if (buying) return;
  const next = nextRodTier(equipment);
  if (!next) {
    gear.showNotice('The net is already at maximum level.');
    return;
  }
  const plan = planUpgrade(equipment);
  if (!plan) {
    gear.showNotice(`Need ${next.cost - totalPearls(equipment)} more Pearls.`);
    hud.message(`Need ${next.cost - totalPearls(equipment)} more Pearls`, 1500);
    return;
  }
  // Legacy local Pearls go first; the rest is burned on-chain, and the tier applies only once that lands.
  buying = true;
  gear.setBusy(true);
  try {
    if (plan.fromChain > 0) {
      await (await nftQueue.loadPearl()).spendPearls(plan.fromChain);
      equipment.pearls = Math.max(0, equipment.pearls - plan.fromChain);
    }
    equipment.legacyPearls -= plan.fromLegacy;
    equipment.rodLevel = plan.tier.level;
    hud.message(`Rod upgraded: Level ${equipment.rodLevel}`, 1800);
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

// ---- Input --------------------------------------------------------------
const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    onEscape();
    return;
  }
  if (paused) return;
  if (e.key === 'Enter' && titleScreen.visible && !workbench.visible && !settingsDesk.visible && !loginGate.visible && !pauseMenu.open && !aquarium.open) {
    // Otherwise Enter also "clicks" whatever button still has focus (e.g. the card's Back).
    e.preventDefault();
    openWorkbench();
  }
  keys.add(e.key.toLowerCase());
  // Not on the workbench: the report would pop up over the table and the chart.
  if (e.key.toLowerCase() === 'h' && phase !== 'calibrating' && !workbench.visible && !aquarium.open) report.toggle();
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
  } else if (e.key.toLowerCase() === 'f' && canBoard()) {
    climbAboard();
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
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
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
  diver.swing();
  if (diver.pos.y > -SURFACE_DEPTH) return;
  const tier = currentTier();
  if (net.length >= tier.capacity) {
    hud.message('Net full! Surface to bank it.');
    return;
  }
  const p = diver.netPoint();
  let best: Fish | null = null;
  let bestD = tier.catchRadius;
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
  hud.setNet(net, tier.capacity);
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
  hud.setNet(net, currentTier().capacity);
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
  world.setMap(MAPS[id]);
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
  hud.setNet(net, currentTier().capacity);
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
  const bow = bowSeat.getWorldPosition(new THREE.Vector3());
  diver.jumpTo(new THREE.Vector3(bow.x + JUMP_OUT, -JUMP_DEPTH, 0));
  wentDown = false;
}

/** Beside the boat at the surface, not in trouble: close enough to climb aboard. */
function canBoard() {
  return (
    phase === 'play' &&
    wentDown &&
    !paused &&
    !diver.jumping &&
    !outOfAir &&
    -diver.pos.y <= SURFACE_DEPTH &&
    Math.abs(diver.pos.x - world.boat.position.x) < BOARD_REACH
  );
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
  vault.toggle(false);
  gear.toggle(false);
  report.toggle(false);
  pauseMenu.show();
}

// ---- Back aboard ---------------------------------------------------------
// F beside the boat, or Esc anywhere in a dive, takes you to the workbench to
// upgrade gear: the diver sits on the bow, the fish drop onto the rope from above
// and the table rises. Aboard, the START fish reads MAIN MENU and ends the trip.
// Esc on the table plays it backwards (the fish rise away, the table sinks) and the
// dive carries on exactly where it was. Diving from the chart starts a fresh dive
// off the bow.
const START_FISH = 0; // its index in the title's fish
const titleName = document.getElementById('title-name')!;
let aboard: { pos: THREE.Vector3; vel: THREE.Vector3 } | null = null;
let leavingBoat = false;

function climbAboard() {
  if (aboard) return;
  aboard = { pos: diver.pos.clone(), vel: diver.vel.clone() };
  phase = 'menu';
  keys.clear();
  vault.toggle(false);
  gear.toggle(false);
  report.toggle(false);
  hud.setBoardPrompt(false);
  hud.hide();
  diver.pos.set(0, -0.4, 0); // the camera goes back up to the boat
  diver.vel.set(0, 0, 0);
  diver.sit(bowSeat);
  titleScreen.setLabel(START_FISH, 'MAIN MENU');
  titleName.style.visibility = 'hidden'; // just the fish and the table, no title
  benchPan = 0;
  titleScreen.setPan(0);
  titleScreen.setLift(0);
  titleScreen.show('drop');
  workbench.show(true);
}

/** Not aboard any more: START reads START again and the title comes back. */
function leaveBoat() {
  aboard = null;
  leavingBoat = false;
  titleScreen.setLabel(START_FISH, 'START');
  titleScreen.setLift(0);
  titleName.style.visibility = '';
}

/** Esc from the table: the fish rise away and the table sinks, then the dive resumes. */
function backToWater() {
  if (!aboard || leavingBoat) return;
  leavingBoat = true;
  workbench.leave(() => {
    const at = aboard!;
    leaveBoat();
    titleScreen.hide();
    titleScreen.setPan(0);
    benchPan = 0;
    diver.stand();
    diver.pos.copy(at.pos);
    diver.vel.copy(at.vel);
    phase = 'play';
    keys.clear();
    breathSince = null; // time on the boat doesn't count as breathing underwater
    hud.show();
  });
}

/** MAIN MENU: the trip's over (an unbanked net is lost), back to the title. */
function aboardToTitle() {
  leaveBoat();
  goToMenu();
}

/** The START fish: on the title it opens the workbench; as MAIN MENU (over a table, or aboard) it goes back to the title. */
function startFish() {
  if (aboard) aboardToTitle();
  else if (workbench.visible) {
    if (workbench.atRest) workbench.escape(); // pans back up to the title
  } else if (settingsDesk.visible) settingsDesk.escape();
  else openWorkbench();
}

/**
 * The START fish reads START on the title only: as soon as the camera pans down
 * to a table (the workbench, the settings desk, or aboard) it reads MAIN MENU,
 * and back at the title it reads START again.
 */
function labelStartFish(pan: number) {
  titleScreen.setLabel(START_FISH, pan > 0 || aboard ? 'MAIN MENU' : 'START');
}

function onEscape() {
  if (pauseMenu.open) pauseMenu.back();
  else if (aquarium.open) aquarium.close();
  else if (report.open) report.toggle(false);
  else if (vault.open) vault.toggle(false);
  else if (gear.open) gear.toggle(false);
  else if (breathTest.open) breathTest.stop();
  else if (loginGate.visible) showTitle(false);
  else if (settingsDesk.visible) settingsDesk.escape();
  // Aboard, Esc from the bare table goes back into the water, not to the title.
  else if (aboard && phase === 'menu' && workbench.atRest) backToWater();
  else if (workbench.visible && phase === 'menu') workbench.escape();
  // In a dive, Esc goes aboard to the workbench (the pause menu is for a hidden tab).
  else if (phase === 'play') climbAboard();
  else if (phase === 'calibrating') goToMenu();
  else if (!overlay.classList.contains('hidden')) backFromStartCard();
}

/** Ends the dive: back to the title, with the diver sitting back on the bow. */
function goToMenu() {
  // Abandoning a dive loses the net, but the breath-hold itself still goes in the health log.
  health.end(nowMs, 'surfaced', 0);
  diver.sit(bowSeat);
  hud.setBoardPrompt(false);
  net = [];
  hud.setNet(net, currentTier().capacity);
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
// START pans the camera down to the workbench (gear + sea chart); the dive launches from the start card.
const titleScreen = new TitleScreen(document.getElementById('title-canvas') as HTMLCanvasElement, [
  { seed: 0x5eed01, rarity: 'legendary', species: 'Abyssal Sunfish', hue: 40, sat: 0.95, light: 0.56, at: 0.32, label: 'START', onClick: startFish }, // MAIN MENU while aboard
  { seed: 0x5eed02, rarity: 'rare', species: 'Azure Tang', hue: 195, sat: 0.7, light: 0.55, at: 0.52, label: 'AQUARIUM', onClick: () => aquarium.show() },
  { seed: 0x5eed03, rarity: 'epic', species: 'Violet Lionfish', hue: 285, sat: 0.75, light: 0.56, at: 0.71, label: 'SETTINGS', onClick: openSettingsDesk },
]);

// Gear set in the workbench's READY tray for this dive. Not used by the dive yet: upgrades aren't wired in.
let loadout: UpgradeId[] = [];

// How far the sea camera sinks while the workbench is up, so the pan reads behind the table too.
const BENCH_CAMERA_DROP = 1.4;
let benchPan = 0;
let aquariumPan = 0; // the aquarium pans the same way

const workbench = new Workbench({
  progress: () => mapProgress,
  pan(u, tableY) {
    benchPan = u;
    titleScreen.setPan(u, tableY);
    labelStartFish(u);
    // Leaving the boat, the fish rise away off the top while the table sinks.
    if (leavingBoat) titleScreen.setLift(1 - u);
  },
  preview: mapPreview,
  dive(id, gear) {
    loadout = gear;
    selectMap(id, true);
    // The preview frame expanding over the screen was taken from exactly here.
    benchPan = 0;
    snapToDiveCamera();
    if (aboard) {
      // Mid-trip: the breath input is already set up, so straight back in off the bow.
      leaveBoat();
      titleScreen.hide();
      startGame();
    } else openStartCard();
  },
  // Only the net (equipment.ts's rod tiers) can be upgraded so far; the rest is starting gear.
  owned: (id) => (id === 'net' ? equipment.rodLevel : 1),
});

function showTitle(intro: boolean) {
  overlay.classList.add('hidden');
  loginGate.hide();
  workbench.hide();
  settingsDesk.hide();
  benchPan = 0;
  titleScreen.setPan(0);
  labelStartFish(0);
  titleScreen.show(intro);
}

// With REQUIRE_PHANTOM, START goes through the login gate unless a wallet is connected.
// Off for now: START goes straight to the workbench. Without a connected wallet,
// progress isn't saved and caught fish wait to be minted.
const REQUIRE_PHANTOM = false;
const loginGate = new LoginGate(() => showTitle(false));
mountWalletRow(document.getElementById('set-wallet')!);

// SETTINGS pans down to a table like START's, with the settings as plaques on it (settings-desk.ts).
const settingsDesk = new SettingsDesk({
  settings: () => settings,
  change: (patch) => pauseMenu.change(patch),
  timeOfDay: () => world.dayCycle.mode,
  setTimeOfDay,
  pan(u, tableY) {
    benchPan = u;
    titleScreen.setPan(u, tableY);
    labelStartFish(u);
  },
});

function openSettingsDesk() {
  if (!workbench.visible && !settingsDesk.visible && !loginGate.visible) settingsDesk.show();
}

function openWorkbench() {
  if (workbench.visible || settingsDesk.visible || loginGate.visible) return;
  if (!REQUIRE_PHANTOM) {
    workbench.show(true);
    return;
  }
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
  // Still on the title: keep its random backdrop; the workbench sets the dive's map.
  if (!titleScreen.visible) applyMap(mapProgress.selected); // the same switch the map picker makes
  hud.setBank(bank);
  refreshEquipment();
  mapPicker.render();
  noteBankValue(false, migrateUnlockProgress(mapProgress.bestValue, bankValue(bank)));
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

  // Mid-jump off the bow, the jump moves the diver: no swimming, no water physics yet.
  const flying = diver.jumping || diver.seated;
  if (playing && !flying) {
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
    diver.vel.x += ax * SWIM_ACCEL * dt;
    diver.vel.y += ay * SWIM_ACCEL * dt;
  }

  if (outOfAir) {
    diver.vel.y += EMERGENCY_LIFT * dt;
    emergency -= dt / EMERGENCY_SECONDS;
    if (Math.random() < dt * 8) diver.exhale(1);
    if (emergency <= 0 && phase === 'play') blackout();
  }

  if (!flying) swimPhysics(dt, s);
  if (playing && -diver.pos.y > BOARD_AFTER_M) wentDown = true;
  hud.setBoardPrompt(canBoard());

  diver.update(dt, time, -diver.pos.y);
  tendTrench(-diver.pos.y);
  for (const f of fishes) f.update(dt, time, diver.pos);
  world.update(time, camera.position.y, camera.position.x);

  // On the menu the camera sinks a little as the workbench (or the aquarium) pans in.
  cameraTarget(camTarget, phase === 'menu' ? Math.max(benchPan, aquariumPan) * BENCH_CAMERA_DROP : 0);
  camera.position.lerp(camTarget, Math.min(1, dt * 3));
  camera.lookAt(camera.position.x, camera.position.y - 1.6, 0);

  hud.setBreath(s, outOfAir);
  hud.setDepth(-diver.pos.y);
  // outOfAir stays set through the 2 s blackout; blackout() already hid the bar.
  hud.setEmergency(outOfAir && phase === 'play' ? emergency : null);
  if (phase === 'calibrating') updateCalibration();
}

/** Water drag, speed cap, buoyancy, the trench walls, and banking at the surface. */
function swimPhysics(dt: number, s: BreathState) {
  diver.vel.multiplyScalar(Math.exp(-DRAG * dt));
  const cap = outOfAir ? 10 : MAX_SPEED;
  if (diver.vel.length() > cap) diver.vel.setLength(cap);
  if (!s.holding && !outOfAir && -diver.pos.y < 3) diver.vel.y += 6 * dt;
  // Below the shelf you're inside the trench; above it, the shelf is the floor
  // everywhere except over the trench mouth. The shelf depth is per map.
  const shelfY = world.seabedY + 1.2; // lowest the diver can go outside the trench
  // The trench walls follow where the diver was before this step: otherwise
  // pressing down on the shelf would pull the diver sideways into the trench.
  const wall = diver.pos.y < shelfY ? TRENCH_X : HALF_WIDTH;
  diver.pos.addScaledVector(diver.vel, dt);
  diver.pos.x = THREE.MathUtils.clamp(diver.pos.x, -wall, wall);
  const floor = Math.abs(diver.pos.x) > TRENCH_X ? shelfY : -DEPTH_LIMIT;
  diver.pos.y = THREE.MathUtils.clamp(diver.pos.y, floor, -0.05);

  if (-diver.pos.y <= SURFACE_DEPTH) {
    // Only in play: during the blackout the lift can still carry you up, and that's no rescue.
    if (outOfAir && phase === 'play') {
      outOfAir = false;
      hud.message(net.length ? 'Made it!' : 'Phew.', 900);
    }
    if (phase === 'play') {
      health.end(nowMs, net.length ? 'banked' : 'surfaced', net.length);
      bankNet();
    }
  }
}

/**
 * Camera: side-on 2.5D follow with a little lead. Underwater it stays below the
 * surface so we never look at the diver through the translucent waves. `drop`
 * sinks it (the workbench pan).
 */
function cameraTarget(out: THREE.Vector3, drop: number) {
  const camY = diver.pos.y > -2.5 ? 2.2 : Math.min(diver.pos.y + 1.2, -1.2);
  // Over the shelf the camera stays above the seabed; in the trench it follows you down.
  const shelfY = world.seabedY + 1.2; // as in update(): lowest the diver can go outside the trench
  const inTrench = Math.abs(diver.pos.x) <= TRENCH_X && diver.pos.y < shelfY;
  const camFloor = inTrench ? -Infinity : world.seabedY + 9;
  return out.set(diver.pos.x + diver.vel.x * 0.35, Math.max(camY, camFloor) - drop, 22);
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
  if (previewOn) renderPreview(); // before the main view, which is what the canvas then shows
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();

// Exposed for quick debugging in the console: debugStep(2) simulates 2 s.
Object.assign(window, {
  workbench,
  settingsDesk,
  loadout: () => loadout,
  /** How far the camera is from where a dive starts (0 right after the workbench hands over). */
  diveCameraOffset: () => camera.position.distanceTo(cameraTarget(new THREE.Vector3(), 0)),
  breath,
  breathTest,
  titleScreen,
  world,
  selectMap,
  diver,
  fishes,
  keys,
  renderQuality,
  nftQueue,
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
