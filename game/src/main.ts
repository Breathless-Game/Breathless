import * as THREE from 'three';
import { pathEffect, pathSummary } from './equipment-i18n';
import { setShipThresholds, Shipyard, shipThreshold, SHIPS, SHIP_INTROS_EN } from './ships';
import { BreathSource, type BreathMode, type BreathState } from './breath';
import { Diver } from './diver';
import { SkinPicker } from './skins';
import { skinUnlocked,visitSkinMap } from './skin-access';
import { type Band, Fish, FishSpec, RARITY_ORDER, fishValue, recordedDepth, rollFish, ZONES } from './fish';
import { Hud } from './hud';
import { LazyVault as Vault } from './lazy-panels';
import { HealthLog } from './health';
import { LazyReport as Report } from './lazy-panels';
import { PauseMenu } from './pause';
import { LazySettingsDesk as SettingsDesk } from './lazy-panels';
import { dropdownOpen } from './dropdown';
import { TitleScreen } from './title';
import { LazyAquarium as Aquarium } from './lazy-panels';
import { setFoodPrices, type FishFoodDef } from './fish-food';
import { Workbench, type WorkbenchConditions } from './workbench';
import { syncBoatPrices, syncUpgradePrices, UPGRADES, type UpgradeId } from './upgrades';
import { loadSettings, type Settings } from './settings';
import { HALF_WIDTH, MAX_HALF_WIDTH, TRENCH_HALF_WIDTH, World } from './world';
import {
  advanceWorldBounds,
  cameraTargetXToBounds,
  clampWorldXToBounds,
  createWorldBounds,
} from './bounds';
import { MAPS, MAP_ORDER, SHARK_WARNING, isUnlocked, loadMapProgress, mapDepth, mapZones, markSharkWarningSeen, saveMapProgress, setMapThresholds, sharkWarningSeen, type MapId } from './maps';
import { MapPicker } from './mappicker';
import { AdaptiveQuality, renderPixelRatio } from './render-quality';
import type { TimeOfDay } from './daylight';
import { GearPanel } from './gear-panel';
import { LoadoutWheel, QUICK_SLOTS } from './loadout-wheel';
import { activePath, deriveStats, EQUIPMENT_PATHS, EQUIPMENT_TIERS, loadEquipment, nextSlotTier, ownedLevel, planPearlSpend, planSlotUpgrade, resetDiveGear, rodTier, saveEquipment, setEquipmentPath, setUpgradeCosts, spendablePearls, type DiveGearReset, type EquipmentPathId, type EquipmentState, type EquipmentSlot, type UpgradeSlot } from './equipment';
import { bankEntry, biteForfeit, isFundsError, migrateBank, pearls, type BankedFish } from './market';
import { GearSync } from './gear-sync';
import { gearLevelsChanged, onGearLevelsChanged } from './gear-levels';
import { BOAT_IDS, normalizeBoat, normalizeKit, type BoatId, type GearLevels } from './gear-nft';
import { NftQueue } from './nft-queue';
import { ChainFishSync } from './chain-fish-sync';
import { bumpPearlEpoch, nudgePearlBalance, pearlBalance, readGuard, setPearlBalance, setPearlsUnavailable } from './pearl-balance';
import { disconnectWallet, onWalletChange, restoreWallet, storageKey, walletState } from './wallet';
import { LoginGate, mountWalletRow } from './login';
import { LazyWorldEvents as WorldEvents } from './lazy-panels';
import type { EventContext } from './events';
import { ROGUE, RogueWaves, canRight, capsizeLoss } from './storm';
import { StormFx } from './storm-fx';
import { PulseEstimate, RestingPulse, SHARK, SharkPack, sharkIntensity, type SharkEvent } from './shark';
import { SharkFx } from './shark-fx';
import { disposeTree } from './lowpoly';
import { DeepSonar } from './deep-sonar';
import { loadSonarConfig, saveSonarConfig } from './sonar-config';
import { SynthesisPanel } from './synthesis-panel';
import { canCraft, loadSynthesis, saveSynthesis, setSynthesisCosts, SYNTHESIS_RECIPE_COSTS, SYNTHESIS_UPGRADE_COSTS, type RecipeDef, type SynthesisState } from './synthesis';
import { FieldGuide } from './field-guide';
import { isAction, keysFor, openControls } from './controls';
import { clearTrips, Trip, TripReport } from './trip';
import { TankTable } from './aquarium-tank';
import { HealthDesk } from './health-desk';
import type { LessonId } from './tutorial';
import { initI18n, onLangChange, pickName, t } from './i18n';
import { PaymentInProgressError, PaymentPendingError } from './payment-safety';
import {
  biteUnsettled,
  onPlayerChainChange,
  pendingPlayerPurchases,
  playerChain,
  playerChainStatus,
  PreviousPaymentSettledError,
  reconcilePlayerPurchases,
  recordSharkBite,
  refreshPlayerChain,
  rereadAfterCatch,
  sendPlayerPurchase,
  sendSetPath,
  settleOwedBite,
  type OwnerTxContext,
  type PurchasePlan,
} from './player-chain';
import { boatQuote, craftQuote, equipmentFromChain, gameProgressRules, gamePrices, growthByFishId, planFeed, progressView, shipOpen, synthesisFromChain, synthQuote, upgradeQuote, type FeedBlock, type ProgressView } from './player-sync';
import { buyBoat as buyBoatIx, buyUpgrade as buyUpgradeIx, craft as craftIx, feed as feedIx, MAX_FISH_PER_CALL, setPath as setPathIx, setShip as setShipIx, synthUpgrade as synthUpgradeIx } from './player-state';
import { playerStateErrorName, type PlayerStateErrorName } from './player-state-errors';
import { explorerTx } from './wallet-storage';

// One UI language (Settings → Language): <html lang> and index.html's static text.
initI18n();

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

// The map you last played. Maps open on the lifetime banked value read from the chain
// (applyPlayerChain); until then only the free one is, and the saved choice waits for that read.
const mapProgress = loadMapProgress();
// The title's backdrop is a random place at a random hour each visit. It isn't saved:
// the workbench's chart (or a wallet's last map) decides where you actually dive.
const backdropMap = MAP_ORDER[Math.floor(Math.random() * MAP_ORDER.length)];
const world = new World(renderQuality.settings, MAPS[backdropMap]);
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
diver.setWaterSurface((x, z) => world.surfaceAt(x, z));
// Between dives the diver sits on the bow (it rocks with the boat); a dive starts with a jump off it.
const bowSeat = new THREE.Object3D();
bowSeat.position.set(3.02, 0.66, 0);
world.boat.add(bowSeat);
diver.sit(bowSeat);
// Not on the title or the menus: the workbench has its own diver figure. It shows from the jump in (startGame).
diver.group.visible = false;
const JUMP_OUT = 2.6; // where the jump lands: this far past the bow, and this deep
const JUMP_DEPTH = 1.4;
// Floating at the surface this close to the boat, F climbs aboard and goes back to the workbench.
// Only once you've actually been down (BOARD_AFTER_M) on this dive, not straight after the jump.
const BOARD_REACH = 6.5;
const BOARD_AFTER_M = 3;
let wentDown = false;
let guideWasPaused = false;
let tutorialDescended = false;
let fieldGuide: FieldGuide | null = null;
const hud = new Hud();

// Random world events (avalanches, whales, a leviathan...). They play only during a
// dive (see update()); menus show none and cost nothing.
const events = new WorldEvents(scene, world.map, renderQuality.settings.detail, () => world.colorGrade.apply(scene));
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
  hud.message(t(e.label, e.labelZh), 2600);
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

// Declared up here, before the first populate(), because sharksOut() reads it
// while the title backdrop's fish are rolled. Keep it above every top-level call.
type Phase = 'menu' | 'calibrating' | 'play' | 'blackout';
let phase: Phase = 'menu';
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
  if (!world.night && !sharksOut()) return a;
  // Night: two rolls, keep the rarer. Better fish, but it's dark down there.
  // With sharks out it is three: the price of swimming with them.
  const rarer = (x: FishSpec, y: FishSpec) => (RARITY_ORDER.indexOf(y.rarity) > RARITY_ORDER.indexOf(x.rarity) ? y : x);
  const b = rarer(a, rollFish(randomSeed(), depth));
  return sharksOut() ? rarer(b, rollFish(randomSeed(), depth)) : b;
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
// `phase` (declared above) must stay above this call: populate() -> rollFor()
// -> sharksOut() reads it, and a later `let` would throw a TDZ error at boot.
populate();

// ---- Game state ---------------------------------------------------------
let outOfAir = false;
let emergency = 1;
let net: FishSpec[] = [];
const bank: BankedFish[] = loadBank();
const equipment: EquipmentState = loadEquipment();
let synthesisState: SynthesisState = loadSynthesis();
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
    catchRadius: stats.catchRadius * (1 + shipBonus.range) * (diver.skinIndex===1&&world.map.id==='tianchi'?1.1:1),
    swimSpeed: stats.swimSpeed * (1 + shipBonus.speed) * (diver.skinIndex===0&&world.map.id==='fjord'?1.1:1),
    lampDistance: stats.lampDistance * (diver.skinIndex===2&&world.map.id==='ocean'?1.15:1),
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
  diver.setLampStats(
    stats.lampDistance,
    stats.lampIntensity,
    stats.lampAngle,
    stats.lampScatter,
    stats.lampDecay,
    stats.lampPenumbra,
    stats.lampExtinction,
  );
  diver.setReelLevel(activeLevel('reel'));
  diver.setReelRecovery(stats.reelRecovery);
}
const sonar = new DeepSonar({ color: loadSonarConfig().color, lengthLevel: equipment.sonarLevel, detail: renderQuality.settings.detail, startsCarried: false });
scene.add(sonar.group);
world.colorGrade.apply(sonar.group);
sonar.group.visible = false;
let sonarCarried = false;
let sonarGuiding = false;
let lastHolding = false;
let breathSince: number | null = null; // when the sensor last flipped to "breathing" underwater

// ---- Sharks -------------------------------------------------------------
// Always on the Open Ocean (the only map with sharks): one to two by day, two to
// four at night. A bite there ends the dive: this dive's unsettled catch is lost
// and the dive gear drops back to level 1 (see sharkBite).
const sharkPack = new SharkPack();
const sharkFx = new SharkFx(scene);
world.colorGrade.apply(sharkFx.group);
const restingPulse = new RestingPulse();
const pulseEstimate = new PulseEstimate();
const sharkEvents: SharkEvent[] = [];
const sharkWarn = document.getElementById('shark-warn')!;
const sharkBitten = document.getElementById('shark-bitten')!;
/** The one-time shark warning, in the UI language: one line in #shark-warn-en (#shark-warn-zh and its <br> stay hidden). */
function paintSharkWarning() {
  document.getElementById('shark-warn-en')!.textContent = t(SHARK_WARNING.en, SHARK_WARNING.zh);
  const zh = document.getElementById('shark-warn-zh')!;
  zh.textContent = '';
  zh.hidden = true;
  const br = zh.previousElementSibling as HTMLElement | null;
  if (br?.tagName === 'BR') br.hidden = true;
}
paintSharkWarning();
onLangChange(paintSharkWarning);
/** How long the bite's knockback and shake play before the dive ends. */
const BITE_END_MS = 1400;
/**
 * Fish banked during this dive (since startGame), by identity: the only bank
 * entries a bite may take back. Fish from earlier dives are never in it.
 */
const diveBanked = new Set<BankedFish>();
/** What a bite cost, shown once the dive has ended. */
interface BiteLoss {
  net: number;
  banked: number;
  /** This dive's banked fish that were already minting, minted or for sale, and stay. */
  safe: number;
  dropped: DiveGearReset['dropped'];
}
let bitten = false; // the first bite of a dive settles it: nothing bites twice
let biteLoss: BiteLoss | null = null;
let biteTimer = 0;

/** Do sharks hunt right now? On shark waters, during a dive: there is no opting out. */
function sharksOut() {
  return world.map.sharks && phase === 'play';
}

/** Before the first dive on shark waters, one warning per wallet; the chart's place card repeats it every time. */
function warnAboutSharks() {
  if (!world.map.sharks || sharkWarningSeen()) return;
  paused = true;
  keys.clear();
  sharkWarn.classList.remove('hidden');
}

function closeSharkWarning(dive: boolean) {
  sharkWarn.classList.add('hidden');
  paused = false;
  if (dive) {
    markSharkWarningSeen();
    // The pause was not a breath taken underwater.
    breathSince = null;
    hud.message(t('One to two sharks by day, two to four at night. Keep your heart rate down.', '白天一到两条鲨鱼，夜里两到四条。保持心率平稳。'), 2600);
    return;
  }
  // Not diving after all: the dive that just began ends, back at the workbench.
  goToMenu();
  workbench.show(true);
}
document.getElementById('shark-warn-dive')!.addEventListener('click', () => closeSharkWarning(true));
document.getElementById('shark-warn-back')!.addEventListener('click', () => closeSharkWarning(false));
document.getElementById('shark-bitten-ok')!.addEventListener('click', () => sharkBitten.classList.add('hidden'));

/**
 * The one place a shark bite takes the dive gear back. It goes through the same
 * path as buying an upgrade (refreshEquipment: saveEquipment, the sonar config,
 * the workbench's onGearChange, the gear panel and the HUD), so anything that
 * follows upgrade levels sees a reset exactly as it sees a purchase.
 */
function resetDiveGearAfterBite(): DiveGearReset['dropped'] {
  // On chain it is shark_bite, signed by the session key (no wallet prompt mid-dive). It never
  // blocks the dive: if it cannot go now it is owed and retried at the next login or purchase.
  void recordSharkBite();
  const { state, dropped } = resetDiveGear(equipment);
  Object.assign(equipment, state);
  refreshEquipment();
  return dropped;
}

/**
 * A shark reached the diver. Once per dive: the net and this dive's unsettled
 * banked fish are lost, the dive gear resets to level 1, the diver is knocked
 * aside, and a moment later the dive ends the normal way, back at the workbench.
 */
function sharkBite() {
  if (bitten || phase !== 'play') return;
  bitten = true;
  // Out of play at once: no second bite, no catching, banking or boarding while the dive ends.
  phase = 'blackout';
  keys.clear();
  // Thrown away from the nearest shark: the one that bit.
  let nearest = Infinity, from = 0;
  for (const shark of sharkPack.sharks) {
    const d = Math.hypot(shark.x - diver.pos.x, shark.y - diver.pos.y);
    if (d < nearest) [nearest, from] = [d, shark.x];
  }
  diver.vel.x += (diver.pos.x >= from ? 1 : -1) * 7;
  diver.vel.y += 2;
  stormShake = Math.max(stormShake, 0.4);

  const fromNet = net.length;
  net = [];
  // Only fish the NFT queue has not started on (market.ts unsettled) and does not hold right now.
  const lost = nftQueue.forfeit(biteForfeit(bank, diveBanked, (f) => nftQueue.holds(f)));
  const safe = [...diveBanked].filter((f) => bank.includes(f)).length;
  hud.setBank(bank);
  const dropped = resetDiveGearAfterBite(); // also redraws the (now empty) net at the new capacity
  biteLoss = { net: fromNet, banked: lost.length, safe, dropped };
  hud.message(t(`SHARK BITE · ${fromNet + lost.length} fish lost · dive gear reset`, `被鲨鱼咬了 · 损失 ${fromNet + lost.length} 条鱼 · 潜水装备已重置`), BITE_END_MS + 400);
  biteTimer = window.setTimeout(() => {
    biteTimer = 0;
    if (phase !== 'blackout') return; // the dive was already left another way (logout)
    goToMenu(); // the normal end of a dive: health log, sea, sharks, net, loadout, sonar, camera
    workbench.show(true); // and back aboard at the workbench
  }, BITE_END_MS);
}

/** The bite report last shown, repainted if the language changes while it is up. */
let shownBiteLoss: BiteLoss | null = null;
onLangChange(() => {
  if (shownBiteLoss && !sharkBitten.classList.contains('hidden')) showBiteReport(shownBiteLoss);
});

/** What the bite cost, over the workbench once the dive has ended. */
function showBiteReport(loss: BiteLoss) {
  shownBiteLoss = loss;
  const total = loss.net + loss.banked;
  const fish = (n: number) => t(`${n} fish`, `${n} 条鱼`);
  const summary = document.createElement('b');
  summary.textContent = t(
    `Bitten by a shark: lost ${fish(total)}, dive gear reset to level 1.`,
    `被鲨鱼咬了：损失 ${total} 条鱼，潜水装备升级重置为 1 级。`,
  );
  document.getElementById('shark-bitten-summary')!.replaceChildren(summary);
  const gearName = (slot: string) => {
    const def = UPGRADES.find((u) => u.id === slot);
    return def ? pickName(def) : slot;
  };
  const items = [
    t(`From your net: ${fish(loss.net)}`, `网中损失：${loss.net} 条`),
    t(`Banked this dive, not yet minting: ${fish(loss.banked)}`, `本次入库、尚未铸造：${loss.banked} 条`),
    ...(loss.safe ? [t(`Kept: ${fish(loss.safe)} from this dive already minting, minted or for sale`, `保留：本次已开始铸造、已铸造或在售的 ${loss.safe} 条`)] : []),
    loss.dropped.length
      ? `${t('Reset to level 1', '重置为 1 级')}: ${loss.dropped.map((d) => `${gearName(d.slot)} Lv${d.from} → 1`).join(t(', ', '、'))}`
      : t('Your dive gear was already at level 1', '潜水装备本已是 1 级'),
    t('Kept: your boat and boat upgrades, Pearls, and fish from earlier dives', '保留：船与船只升级、珍珠、以往渔获'),
  ];
  document.getElementById('shark-bitten-list')!.replaceChildren(
    ...items.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );
  sharkBitten.classList.remove('hidden');
}

/** Runs every frame of a dive: learns the pulse, moves the sharks and shows what they are doing. */
function tendSharks(dt: number, pulse: number | null, holding: boolean, floorY: number) {
  const depth = -diver.pos.y;
  restingPulse.tick(dt, pulse, depth < 1.2 && !holding);
  // Without a sensor the pulse is estimated from how hard the diver swims.
  const estimated = pulse == null;
  const bpm = pulse ?? pulseEstimate.tick(dt, diver.vel.length() / Math.max(1, currentStats().swimSpeed));
  const out = sharksOut();
  const intensity = out ? sharkIntensity(bpm, estimated ? SHARK.rest : restingPulse.bpm) : 0;
  sharkPack.tick(dt, diver.pos, intensity, out, floorY, sharkEvents, world.night);
  for (const event of sharkEvents) {
    if (event === 'arrive') hud.message(t('Sharks are circling. Keep your heart rate down.', '鲨鱼在附近盘旋。保持心率平稳。'), 3000);
    else if (event === 'bite') sharkBite();
  }
  sharkFx.update(dt, sharkPack.sharks, intensity, world.dayCycle.state.nightMix, settings.lightingEffects);
  health.sharks = out;
  hud.setSharks(out ? { count: sharkPack.sharks.filter(s => s.mode !== 'leave').length, bpm, estimated, intensity } : null);
}

function noSharks() {
  sharkPack.reset();
  sharkFx.clear();
  health.sharks = false;
  hud.setSharks(null);
}

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
    loss.fish.length ? t(`${loss.fish.length} fish`, `${loss.fish.length} 条鱼`) : '',
    loss.gear ? t(`your ${nextSlotLabel(loss.gear).toLowerCase()}`, nextSlotLabel(loss.gear)) : '',
  ].filter(Boolean).join(t(' and ', '和'));
  hud.message(lost ? t(`CAPSIZED · lost ${lost}`, `翻船了 · 损失 ${lost}`) : t('CAPSIZED', '翻船了'), 3200);
  stormShake = 0.7;
  capsizeHintAt = time + 5;
}

/** Can the diver get a hand on the capsized boat? */
const atBoat = () => stormSea.capsized && canRight(diver.pos.x - stormSea.boatX, -diver.pos.y);
/** What the HUD last showed about the capsized boat: nothing, "swim to it", or the key to mash. */
let boatPrompt: 'none' | 'far' | 'mash' = 'none';

/** One press of F: one heave on the boat, from the surface beside it. It takes many, quickly. */
function heaveBoat() {
  if (!stormSea.capsized) return;
  if (!atBoat()) {
    hud.message(t('Surface beside the boat to right it', '在船边浮出水面才能把船翻正'), 1600);
    return;
  }
  if (!stormSea.heave()) return;
  hud.punchMash();
  // Water slaps off the hull with every heave.
  stormFx.burst(stormSea.boatX, world.surfaceAt(stormSea.boatX, 0), 0.5, 9, 0, 3.4);
  stormShake = Math.max(stormShake, 0.09);
}

/** Show what to do about the boat: swim to it while far, mash F in the middle of the screen once beside it. */
function promptForBoat() {
  const prompt = !stormSea.capsized ? 'none' : atBoat() ? 'mash' : 'far';
  if (prompt !== boatPrompt) {
    boatPrompt = prompt;
    hud.setAlert(prompt === 'far' ? t('Boat capsized · surface beside it to right it', '船翻了 · 在船边浮出水面把它翻正') : null);
    if (prompt !== 'mash') hud.setMash(null);
  }
  if (prompt === 'mash') hud.setMash(stormSea.effort);
}

/** Calm water and an upright boat: a new dive, or back on the menu. */
function calmSea() {
  noSharks();
  stormSea.reset();
  stormFx.clear();
  stormShake = 0;
  world.boatPose = null;
  world.setRogueWave(null, 1, 0);
  promptForBoat();
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
  // A co-signed mint also recorded the catch (record_catch): read Progress again, so maps and ships
  // the new lifetime value opens unlock without a reload.
  minted(_fish, trusted) {
    if (!trusted || !walletState().owner) return;
    void rereadAfterCatch(playerChain()?.progress?.lifetimeValue ?? 0n);
  },
  sold(sales) {
    chainFish.departed(sales.map((s) => s.fish.assetId));
    hud.setBank(bank);
    const total = sales.reduce((s, x) => s + x.result.pearls, 0);
    // One toast and one balance read per batch: the most valuable fish stands for the rest.
    const top = sales.reduce((a, b) => (b.result.pearls > a.result.pearls ? b : a));
    hud.toast(top.fish, `${sales.length > 1 ? t(`SOLD ${sales.length} FISH`, `已售出 ${sales.length} 条鱼`) : t('SOLD', '已售出')} · +${t(pearls(total).toUpperCase(), `${total} 珍珠`)}`);
    void syncPearls(total);
  },
});
const vault = new Vault(bank, nftQueue);
// The wallet's fish NFTs on chain fill in whatever the local save lacks (a cleared browser, another device).
const chainFish = new ChainFishSync({
  bank,
  owner: () => walletState().owner,
  busy: () => nftQueue.busy,
  holds: (f) => nftQueue.holds(f),
  changed() {
    saveBank();
    hud.setBank(bank);
    vault.refresh();
    nftQueue.kick(); // newly listed older fish still get their collection check
  },
});
// The aquarium and the health desk each come up on a table like the workbench's (table-scene.ts).
// Over the aquarium the title's rope and fish ride all the way up off the screen (lift), out of the tank's way.
const aquariumTable = new TankTable({
  pan: (u, y) => {
    setTablePan('aquarium', u, y);
    titleScreen.setLift(u);
  },
});
const aquarium = new Aquarium(bank, {
  table: aquariumTable,
  buyFood: buyAquariumFood,
  chainGrowth() {
    const snap = playerChain();
    return snap ? growthByFishId(snap.aquarium, bank.map((f) => f.id)) : null;
  },
  feedLocked: () => chainBlocked(),
  onChainChange: (cb) => void onPlayerChainChange(cb),
  pearls: () => spendablePearls(equipment),
  message(text) {
    hud.message(text, 1600);
  },
  openCollection() {
    vault.toggle(true);
    fieldGuide?.mark('collection');
    void syncPearls();
  },
  closeCollection() {
    vault.toggle(false);
  },
});
const healthDesk = new HealthDesk({ pan: (u, y) => setTablePan('health', u, y) });
// The queue starts once a wallet's bank is loaded (see loadWalletProgress).
const health = new HealthLog();
// One trip: the first dive off the title to the main menu again (trip.ts); its report at the end.
const trip = new Trip();
const tripReport = new TripReport();
// Deleting health data takes the trip reports too (their pulse and breathing traces), stored and in progress.
const report = new Report(health, () => {
  clearTrips();
  trip.reset();
  if (tripReport.open) tripReport.close();
  healthDesk.forget();
});
const gear = new GearPanel((slot) => buyNextUpgrade(slot), (slot, path) => void selectEquipmentPath(slot, path));
gear.setLock(() => chainBlocked());
gear.render(equipment);
hud.setEquipment(equipment, currentTier());
diver.setNetLevel(currentTier().level);
applyEquipmentVisuals();
const loadoutWheel = new LoadoutWheel({
  isAvailable: (slot) => activeLoadout == null || activeLoadout.includes(slot),
  onSelect: (slot) => {
    activeTool = slot;
    hud.setActiveGear(slot, activeLoadout == null || activeLoadout.includes(slot));
    hud.message(t(`${nextSlotLabel(slot)} equipped`, `${nextSlotLabel(slot)} 已装备`), 900);
  },
  onUnavailable: (slot) => {
    hud.message(
      t(`${nextSlotLabel(slot)} not packed: pack it at the workbench before your next dive`, `${nextSlotLabel(slot)} 未装配：下次下潜前在工作台打包`),
      1800,
    );
  },
});
hud.setActiveGear(activeTool, true);
let nowMs = 0;

/** Set once the workbench exists: its pieces follow levels bought and ships picked. */
let onGearChange = () => {};

function refreshEquipment() {
  onGearChange();
  // Every level change passes through here (bought, branch switched, a shark bite's reset): the
  // on-chain Boat / Dive Kit sync observes it (gear-levels.ts) and compares levels itself.
  gearLevelsChanged();
  const tier = currentTier();
  const stats = currentStats();
  saveEquipment(equipment);
  nudgePearlBalance(equipment.pearls);
  const sonarConfig = saveSonarConfig({ ...loadSonarConfig(), lengthLevel: equipment.sonarLevel });
  sonar.setLengthLevel(equipment.sonarLevel);
  sonar.setColor(sonarConfig.color);
  hud.setEquipment(equipment, tier);
  hud.setNet(net, stats.netCapacity);
  gear.render(equipment);
  applyEquipmentVisuals();
}

const PEARL_READ_TIMEOUT_MS = 20_000;
/** Re-read the on-chain PEARL balance into the cache. `earned` shows a sale's Pearls before the read lands. */
async function syncPearls(earned = 0) {
  if (earned) {
    bumpPearlEpoch();
    equipment.pearls += earned;
    refreshEquipment();
  }
  const current = readGuard(); // a spend or sale while this read is out makes its answer old
  try {
    // A read that never settles must not leave the badge on "…" forever (a known balance stays shown).
    const read = (await nftQueue.loadPearl()).pearlBalance();
    const value = await Promise.race([
      read,
      new Promise<never>((_, fail) => setTimeout(() => fail(new Error('PEARL balance read timed out')), PEARL_READ_TIMEOUT_MS)),
    ]);
    if (!current()) return; // the newer read that change started will land instead
    equipment.pearls = value;
    setPearlBalance(equipment.pearls);
    refreshEquipment();
  } catch (e) {
    console.warn('PEARL balance unavailable', e);
    setPearlsUnavailable(e);
  }
}

// ---- On-chain player state (player-chain.ts) -------------------------------------------
// Gear levels, module paths, synthesis materials and aquarium growth live in the player_state
// program; the local saves are only a cache of its last read. Nothing here bumps a level: each
// purchase is one player_state instruction (it burns the PEARL itself), and once it landed the
// accounts are read again and the game renders from them (applyPlayerChain).

let chainRetryTimer = 0;
/**
 * Login: read the player's accounts (retrying later on failure; purchases stay locked meanwhile),
 * then settle payments whose confirmation was lost and a shark bite owed from an earlier dive.
 */
async function startPlayerChain(retryMs = 15_000) {
  window.clearTimeout(chainRetryTimer);
  if (!walletState().owner) return;
  try {
    await refreshPlayerChain();
  } catch (e) {
    console.warn('player_state read failed', e);
    chainRetryTimer = window.setTimeout(() => void startPlayerChain(Math.min(retryMs * 2, 120_000)), retryMs);
    return;
  }
  // Lost confirmations first: a purchase among them may carry the owed bite (or have raised a
  // level after it), and a bite re-sent before it settles could take that level back.
  await reconcilePurchases();
  await settleOwedBite();
}

/** Set once this wallet's gear cache came from a chain read (older saves are test data). */
const CHAIN_CACHE = 'player-state.cached';
function chainCached(): boolean {
  try {
    return localStorage.getItem(storageKey(CHAIN_CACHE)) === '1';
  } catch {
    return false;
  }
}

/** Take over the latest on-chain read: the Config's prices, then levels, paths, materials and growth. */
function applyPlayerChain() {
  const snap = playerChain();
  if (snap) {
    try {
      localStorage.setItem(storageKey(CHAIN_CACHE), '1');
    } catch {
      // only a cache marker
    }
    try {
      const prices = gamePrices(snap.config.prices);
      setUpgradeCosts(prices.upgrade);
      syncUpgradePrices();
      setSynthesisCosts(prices.synthUpgrade, prices.recipe);
      setFoodPrices(prices.food);
    } catch (e) {
      console.error('player_state Config prices out of range', e);
    }
    // A shark bite the chain does not show yet already took the dive gear back here.
    Object.assign(equipment, equipmentFromChain(equipment, snap.player, biteUnsettled()));
    synthesisState = synthesisFromChain(snap.player, snap.config.prices);
    saveSynthesis(synthesisState);
    // v2: boat-part prices and ship thresholds from ProgressConfig (map thresholds: applyMapProgress).
    try {
      const rules = gameProgressRules(snap.progressRules);
      syncBoatPrices(rules.boatPrices);
      setShipThresholds(rules.shipThresholds);
    } catch (e) {
      console.error('player_state ProgressConfig out of range', e);
    }
  }
  // Maps open and the ship sailed follow the chain's Progress (lifetime value, ship); without a
  // read for this wallet nothing from the local cache opens a map or grants a ship.
  applyMapProgress(snap, true);
  shipyard.reload();
  shipBonus = shipyard.bonus;
  hud.setNet(net, currentStats().netCapacity);
  refreshEquipment(); // saves the equipment cache; repaints the gear panel, HUD and workbench (the aquarium listens itself)
}
onPlayerChainChange(applyPlayerChain);

/** The connected wallet's Progress as last read from the chain (null until read). */
function chainProgress(): ProgressView | null {
  const snap = playerChain();
  return snap ? progressView(snap.progress) : null;
}

const isBoatId = (id: string): id is BoatId => (BOAT_IDS as readonly string[]).includes(id);

/** Why nothing can be bought or changed yet: the on-chain player state has not been read. */
function chainBlocked(): string | null {
  if (!walletState().owner) return t('Connect a wallet first', '请先连接钱包');
  const { status, error } = playerChainStatus();
  if (status === 'ready') return null;
  if (status === 'error') return `${t('Could not read your gear from the chain · purchases unavailable', '无法读取链上装备 · 暂时无法购买')}${error ? ` · ${error}` : ''}`;
  return t('Reading your gear from the chain…', '正在读取链上装备…');
}

/** chainBlocked(), then the PEARL balance (pearlPurchaseBlocked). */
function purchaseBlocked(): string | null {
  return chainBlocked() ?? pearlPurchaseBlocked();
}

const PROGRAM_ERRORS: Partial<Record<PlayerStateErrorName, readonly [string, string]>> = {
  InsufficientPearl: ['Not enough PEARL', 'PEARL 不足'],
  MaxLevel: ['Already at the top level', '已是最高等级'],
  MissingMaterials: ['Materials missing', '材料不足'],
  NoComposite: ['Craft one composite plate first', '先合成复合护板'],
  PathLocked: ['Upgrade this slot to Lv2 first', '先把这件装备升到 Lv2'],
  FullyGrown: ['Every fish here is fully grown', '这里的鱼都长到最大了'],
  FeedCooldown: ['The school is still full', '鱼群还在饱腹冷却'],
  Unauthorized: ['This wallet may not change that player', '此钱包无权修改该玩家'],
  NotNextLevel: ['Only the next level can be bought', '只能购买下一级'],
  ShipLocked: ['This ship needs more lifetime banked value', '这艘船需要更多累计入库价值'],
  InvalidShip: ['Unknown ship', '未知船只'],
  InvalidBoatSlot: ['Unknown boat part', '未知船只部件'],
};

const feedBlockText = (why: FeedBlock | null) =>
  why === 'max' ? t('Every fish here is fully grown', '这里的鱼都长到最大了') : t('The school is still full', '鱼群还在饱腹冷却');

/** Show a payment error as the player should read it (with an explorer link while it is still confirming). Returns the text. */
function showPaymentError(e: unknown, failure: string): string {
  if (e instanceof PaymentInProgressError) {
    const text = t('Another payment is in progress', '另一笔付款正在进行');
    hud.message(text, 1800);
    return text;
  }
  if (e instanceof PaymentPendingError) {
    scheduleReconcile();
    const text = t('Payment still confirming · it applies once it lands', '付款仍在确认中 · 到账后自动生效');
    hud.message(text, 9000, { href: explorerTx(e.signature), label: t('View on explorer', '在区块浏览器中查看') });
    return text;
  }
  if (e instanceof PreviousPaymentSettledError) {
    const text = t('A previous payment just settled · try again', '上一笔付款刚刚结算 · 请重试');
    hud.message(text, 2400);
    return text;
  }
  const code = playerStateErrorName(e);
  const known = code ? PROGRAM_ERRORS[code] : undefined;
  const reason = known ? t(known[0], known[1]) : code ?? (e as Error)?.message ?? String(e);
  const text = `${failure} · ${reason}`;
  hud.message(text, 1800);
  return text;
}

let reconcileTimer = 0;
/** Settle this wallet's payments whose confirmation was lost: by re-reading the accounts first, then by signature. Never re-sends. */
async function reconcilePurchases() {
  window.clearTimeout(reconcileTimer);
  if (!walletState().owner || !pendingPlayerPurchases().length) return;
  try {
    const report = await reconcilePlayerPurchases();
    if (report.delivered.length) {
      hud.message(t('A payment that was still confirming went through · purchase applied', '之前确认中的付款已到账 · 购买已生效'), 2400);
      void syncPearls();
    }
    if (report.dropped.length) console.info('player_state payments that never landed (nothing was burned):', report.dropped);
    if (report.kept.length) scheduleReconcile();
  } catch (e) {
    console.warn('could not settle pending payments yet', e);
    scheduleReconcile();
  }
}
function scheduleReconcile(ms = 60_000) {
  window.clearTimeout(reconcileTimer);
  reconcileTimer = window.setTimeout(() => void reconcilePurchases(), ms);
}

/**
 * Why no PEARL purchase can go through right now, or null when the on-chain balance is known.
 * Every purchase is paid in on-chain PEARL only, so an unread balance (still loading, market
 * offline, RPC down) blocks it instead of letting a stale cache through.
 */
function pearlPurchaseBlocked(): string | null {
  const balance = pearlBalance();
  if (balance.status === 'ok') return null;
  return balance.status === 'loading'
    ? t('PEARL balance is still loading · purchases unavailable', 'PEARL 余额读取中 · 暂时无法购买')
    : `${t('Purchases unavailable', '暂时无法购买')} · ${balance.reason}`;
}

/** Not enough cached PEARL for `cost`: say how much is missing. True when short. */
function pearlShort(cost: number, what = ''): boolean {
  if (planPearlSpend(equipment, cost) != null) return false;
  const short = Math.max(0, cost - spendablePearls(equipment));
  hud.message(t(`Need ${short} more PEARL${what ? ` ${what}` : ''}`, `还差 ${short} PEARL${what}`), 1600);
  return true;
}

/**
 * Send one player_state purchase (sendPlayerPurchase). True once it landed and the accounts were
 * read again; false when nothing was bought (refused, failed on chain, or still confirming: then
 * it applies by itself once it lands, see reconcilePurchases).
 */
async function payOnChain(plan: (ctx: OwnerTxContext) => PurchasePlan, label: string, failure: string): Promise<boolean> {
  try {
    await sendPlayerPurchase(plan, label);
    return true;
  } catch (e) {
    console.warn(`${label} not bought`, e);
    showPaymentError(e, failure);
    return false;
  } finally {
    void syncPearls();
  }
}

let foodBuying = false;
/**
 * Pour one aquarium food over these fish with the program's feed instruction: the PEARL burn and
 * the growth land together, and only fish that are neither fully grown nor still full eat (the
 * chain's rule). Resolves with how many ate and the PEARL burned, or null when nothing was spent.
 */
async function buyAquariumFood(food: FishFoodDef, fishIds: readonly string[]): Promise<{ fed: number; paid: number } | null> {
  if (foodBuying) return null;
  const blocked = purchaseBlocked();
  if (blocked) {
    hud.message(blocked, 1800);
    return null;
  }
  const first = playerChain();
  const check = first && planFeed(first.aquarium, fishIds, Date.now() / 1000, first.config.prices, MAX_FISH_PER_CALL);
  if (check && !check.ids.length) {
    hud.message(feedBlockText(check.blocked), 1600);
    return null;
  }
  if (pearlShort(food.price, t(`for ${food.name}`, `才能买${food.nameZh}`))) return null;
  foodBuying = true;
  let fed = 0;
  let paid = 0;
  try {
    const ok = await payOnChain(({ u, owner, pearl, snap }) => {
      const plan = planFeed(snap.aquarium, fishIds, Date.now() / 1000, snap.config.prices, MAX_FISH_PER_CALL);
      if (!plan.ids.length) throw new Error(feedBlockText(plan.blocked));
      fed = plan.ids.length;
      paid = Number(snap.config.prices.foodPrice[food.id]);
      return {
        builder: feedIx(u, { owner, ...pearl, food: food.id, fish: plan.keys }),
        what: { v: 1, kind: 'food', food: food.id, keys: plan.keysHex, feeds: plan.feedsBefore },
        cost: paid,
      };
    }, 'Feed', t('Food purchase failed', '饲料购买失败'));
    return ok ? { fed, paid } : null;
  } finally {
    foodBuying = false;
  }
}

let synthesisBusy = false;
async function synthCraft(id: RecipeDef['id']) {
  if (synthesisBusy) return;
  // Everything that could stop the craft is checked before anything is sent; the program checks again.
  const blocked = purchaseBlocked();
  if (blocked) {
    hud.message(blocked, 1800);
    return;
  }
  if (!canCraft(synthesisState, id)) {
    hud.message(t('Materials missing', '材料不足'), 1400);
    return;
  }
  if (pearlShort(SYNTHESIS_RECIPE_COSTS[id])) return;
  synthesisBusy = true;
  try {
    const ok = await payOnChain(({ u, owner, pearl, snap }) => {
      const state = synthesisFromChain(snap.player, snap.config.prices);
      const quote = craftQuote(snap.config.prices, state.materials, id, 0);
      if (!quote) throw new Error(t('Materials missing', '材料不足'));
      return {
        builder: craftIx(u, { owner, ...pearl, recipe: id }),
        what: { v: 1, kind: 'craft', recipe: id, crafted: state.crafted[id] },
        cost: quote.cost,
      };
    }, 'Craft', t('Synthesis payment failed', '合成付款失败'));
    if (ok) hud.message(id === 'bait' ? t('Tide bait crafted', '鱼饵已合成') : t('Composite plate crafted', '护板已合成'), 1600);
  } finally {
    synthesisBusy = false;
  }
}

async function synthUpgrade(slot: UpgradeSlot) {
  if (synthesisBusy) return;
  const level = ownedLevel(equipment, slot);
  if (level >= 3) return;
  const blocked = purchaseBlocked();
  if (blocked) {
    hud.message(blocked, 1800);
    return;
  }
  if (synthesisState.crafted.composite < 1) {
    hud.message(t('Craft one composite plate first', '先合成复合护板'), 1800);
    return;
  }
  if (pearlShort(SYNTHESIS_UPGRADE_COSTS[slot][level - 1])) return;
  synthesisBusy = true;
  try {
    const ok = await payOnChain(({ u, owner, pearl, snap, levels }) => {
      const { crafted } = synthesisFromChain(snap.player, snap.config.prices);
      const quote = synthQuote(snap.config.prices, levels, crafted, slot, 0);
      if ('blocked' in quote) throw new Error(quote.blocked === 'max' ? t('Already at the top level', '已是最高等级') : t('Craft one composite plate first', '先合成复合护板'));
      return {
        builder: synthUpgradeIx(u, { owner, ...pearl, slot }),
        what: { v: 1, kind: 'synth-upgrade', slot, level: quote.level, composite: crafted.composite },
        cost: quote.cost,
      };
    }, 'Synthesis upgrade', t('Synthesis payment failed', '合成付款失败'));
    if (ok) hud.message(t(`${nextSlotLabel(slot)} upgraded in synthesis station`, `${nextSlotLabel(slot)} 已在合成台升级`), 1800);
  } finally {
    synthesisBusy = false;
  }
}

let buying = false;
/** Buys the next level of a slot. Resolves with why it didn't happen (also shown in the gear panel), or null. */
async function buyNextUpgrade(slot: UpgradeSlot = 'net'): Promise<string | null> {
  if (buying) return t('Already upgrading…', '正在升级…');
  if (phase === 'play') {
    const back = t('Return to the workbench before upgrading gear.', '先回到工作台再升级装备。');
    gear.showNotice(back);
    return back;
  }
  const next = nextSlotTier(equipment, slot);
  if (!next) {
    gear.showNotice(t(`${nextSlotLabel(slot)} is already at maximum level.`, `${nextSlotLabel(slot)} 已是最高等级。`));
    return t('Already at the top level.', '已是最高等级。');
  }
  const blocked = purchaseBlocked();
  if (blocked) {
    gear.showNotice(blocked);
    hud.message(blocked, 1800);
    return blocked;
  }
  if (!planSlotUpgrade(equipment, slot)) {
    const short = next.cost - spendablePearls(equipment);
    const need = t(`Need ${short} more PEARL`, `还差 ${short} PEARL`);
    gear.showNotice(t(`${need}.`, `${need}。`));
    hud.message(need, 1500);
    return need;
  }
  // buy_upgrade burns the Config price and raises the level in one transaction; the panel shows
  // the new level once the re-read accounts have it.
  buying = true;
  gear.setBusy(true);
  let failed: string | null = null;
  let bought: number = next.level;
  try {
    await sendPlayerPurchase(({ u, owner, pearl, snap, levels }) => {
      const quote = upgradeQuote(snap.config.prices, levels, slot, 0);
      if (!quote) throw new Error(t('Already at the top level', '已是最高等级'));
      bought = quote.level;
      return { builder: buyUpgradeIx(u, { owner, ...pearl, slot }), what: { v: 1, kind: 'upgrade', slot, level: quote.level }, cost: quote.cost };
    }, 'Upgrade');
    hud.message(t(`${nextSlotLabel(slot)} upgraded: Level ${bought}`, `${nextSlotLabel(slot)} 已升级：${bought} 级`), 1800);
  } catch (e) {
    console.error('upgrade failed', e);
    failed = showPaymentError(e, t('Upgrade failed', '升级失败'));
    gear.showNotice(failed);
  } finally {
    buying = false;
    gear.setBusy(false);
    refreshEquipment();
    void syncPearls();
  }
  return failed;
}

let boatBuying = false;
/**
 * Buy the next level of a boat part with player_state buy_boat: it burns the ProgressConfig price
 * and raises Progress.boat_levels in one instruction (creating Progress on first use). Same
 * journal and settle rules as buy_upgrade. Resolves with why it didn't happen, or null.
 */
async function buyNextBoat(id: BoatId): Promise<string | null> {
  if (boatBuying || buying) return t('Already upgrading…', '正在升级…');
  if (phase === 'play') return t('Return to the workbench before upgrading the boat.', '先回到工作台再升级船只。');
  const blocked = purchaseBlocked();
  if (blocked) {
    hud.message(blocked, 1800);
    return blocked;
  }
  const first = playerChain();
  if (!first) return chainBlocked();
  const def = UPGRADES.find((u) => u.id === id)!;
  const quote = boatQuote(first.progressRules, progressView(first.progress).boatLevels, id, spendablePearls(equipment));
  if (!quote) return t('Already at the top level.', '已是最高等级。');
  if (quote.short > 0) {
    const need = t(`Need ${quote.short} more PEARL`, `还差 ${quote.short} PEARL`);
    hud.message(need, 1500);
    return need;
  }
  boatBuying = true;
  let bought: number = quote.level;
  try {
    await sendPlayerPurchase(({ u, owner, pearl, snap }) => {
      // Priced and levelled from the accounts just read, never from the cache.
      const q = boatQuote(snap.progressRules, progressView(snap.progress).boatLevels, id, 0);
      if (!q) throw new Error(t('Already at the top level', '已是最高等级'));
      bought = q.level;
      return {
        builder: buyBoatIx(u, { owner, ...pearl, boat: id, level: q.level, createsProgress: !snap.progress }),
        what: { v: 1, kind: 'boat', boat: id, level: q.level },
        cost: q.cost,
      };
    }, 'Boat upgrade');
    hud.message(t(`${def.name} upgraded: Level ${bought}`, `${def.nameZh} 已升级：${bought} 级`), 1800);
    return null;
  } catch (e) {
    console.error('boat upgrade failed', e);
    return showPaymentError(e, t('Upgrade failed', '升级失败'));
  } finally {
    boatBuying = false;
    refreshEquipment();
    void syncPearls();
  }
}

let shipBusy = false;
/**
 * Sail ship i: free, owner-signed player_state set_ship (the program checks the lifetime value
 * against ProgressConfig). The boat follows once the re-read Progress shows it (applyPlayerChain).
 */
async function sailShip(i: number): Promise<string | null> {
  if (shipBusy) return t('Already switching ships…', '正在切换船只…');
  if (phase === 'play') return t('Return to the workbench before switching ships.', '先回到工作台再切换船只。');
  const blocked = chainBlocked();
  if (blocked) {
    hud.message(blocked, 1800);
    return blocked;
  }
  const first = playerChain();
  if (!first || !SHIPS[i]) return chainBlocked();
  const view = progressView(first.progress);
  if (view.ship === i) {
    shipyard.reload();
    return null;
  }
  if (!first.progress || !shipOpen(view.lifetime, gameProgressRules(first.progressRules), i)) {
    const more = Math.max(0, Math.ceil(shipThreshold(i) - view.lifetime));
    return t(`Still locked: bank ${more} more value first.`, `尚未解锁：还差 ${more} 入库价值。`);
  }
  shipBusy = true;
  try {
    await sendPlayerPurchase(({ u, owner, snap }) => {
      const v = progressView(snap.progress);
      if (!snap.progress || !shipOpen(v.lifetime, gameProgressRules(snap.progressRules), i)) throw new Error(t('This ship is still locked', '这艘船尚未解锁'));
      return { builder: setShipIx(u, { owner, ship: i }), what: { v: 1, kind: 'ship', ship: i }, cost: 0 };
    }, 'Ship switch');
    hud.message(t(`Now sailing ${SHIPS[i].en}`, `已换乘${SHIPS[i].cn}`), 1800);
    return null;
  } catch (e) {
    console.error('ship switch failed', e);
    return showPaymentError(e, t('Ship switch failed', '切换船只失败'));
  } finally {
    shipBusy = false;
  }
}

let pathBusy = false;
/** Switch a module path with set_path (free; the session key signs it when registered). */
async function selectEquipmentPath(slot: EquipmentSlot, path: EquipmentPathId) {
  if (phase === 'play') {
    gear.showNotice(t('Return to the workbench before changing a module.', '先回到工作台再更换模块。'));
    return;
  }
  if (!setEquipmentPath(equipment, slot, path)) {
    gear.showNotice(t('Upgrade this slot to Lv2 before selecting a branch.', '先把这件装备升到 Lv2 再选择分支。'));
    return;
  }
  if (activePath(equipment, slot) === path) return;
  const blocked = chainBlocked();
  if (blocked) {
    gear.showNotice(blocked);
    return;
  }
  if (pathBusy) return;
  pathBusy = true;
  try {
    await sendSetPath((authority, owner, u) => setPathIx(u, { authority, owner, slot, path: path as never }), { v: 1, kind: 'path', slot, path });
    hud.message(t(`${nextSlotLabel(slot)} module changed`, `${nextSlotLabel(slot)} 模块已更换`), 1200);
  } catch (e) {
    console.warn('set_path failed', e);
    gear.showNotice(showPaymentError(e, t('Module change failed', '模块更换失败')));
  } finally {
    pathBusy = false;
    refreshEquipment();
  }
}

const SLOT_LABELS: Record<UpgradeSlot, readonly [string, string]> = {
  net: ['Net', '捕捞网'],
  rod: ['Rod shaft', '杆身'],
  reel: ['Recovery reel', '线轮'],
  fins: ['Fins', '脚蹼'],
  tank: ['Emergency tank', '应急气瓶'],
  lamp: ['Headlamp', '探照灯'],
  sonar: ['Deep sonar', '深海声纳'],
};

/** A gear slot's name, in the UI language. */
function nextSlotLabel(slot: UpgradeSlot) {
  const [en, zh] = SLOT_LABELS[slot];
  return t(en, zh);
}

// ---- Input --------------------------------------------------------------
// Keys are looked up by action (controls.ts), so they can be changed in Settings.
// `keys` holds the physical keys (codes) held down, for swimming.
const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  if(skinPicker.open)return;
  // An open settings dropdown has the keyboard. It stops its own keys; this is the backstop.
  if (dropdownOpen()) return;
  if (e.key === 'Escape') {
    if (loadoutWheel.open) {
      loadoutWheel.closeWheel(false);
      return;
    }
    onEscape();
    return;
  }
  // The bag key flips the hotbar between your gear and your bag of fish (it no longer
  // opens the wheel). Number keys and prev/next gear are instant quick-slot shortcuts;
  // the wheel consumes them before movement/catch handling.
  if (isAction('bag', e) && phase === 'play' && !paused) {
    e.preventDefault();
    if (!e.repeat) hud.toggleBag();
    return;
  }
  if (loadoutWheel.handleKeyDown(e, phase === 'play' && !paused && !gear.open && !vault.open && !report.open)) return;
  if (paused) return;
  if (e.key === 'Enter' && titleScreen.visible && !workbench.visible && !settingsDesk.visible && !healthDesk.visible && !loginGate.visible && !pauseMenu.open && !aquarium.open) {
    // Otherwise Enter also "clicks" whatever button still has focus (e.g. the card's Back).
    e.preventDefault();
    openWorkbench();
  }
  keys.add(e.code);
  // Not on the workbench: the report would pop up over the table and the chart.
  if (isAction('report', e) && phase !== 'calibrating' && !workbench.visible && !aquarium.open && !healthDesk.visible) report.toggle();
  if (isAction('upgrades', e) && phase !== 'play' && phase !== 'calibrating') {
    e.preventDefault();
    gear.toggle();
    if (gear.open) void syncPearls();
    if (gear.open) fieldGuide?.mark('upgrade');
    return;
  }
  if (phase !== 'play') return;
  if (isAction('catch', e)) {
    e.preventDefault();
    tryCatch();
  } else if (isAction('collection', e)) {
    vault.toggle();
    if (vault.open) fieldGuide?.mark('collection');
    if (vault.open) void syncPearls();
  } else if (isAction('upgrades', e)) {
    gear.toggle();
    if (gear.open) void syncPearls();
  } else if (isAction('board', e) && canBoard()) {
    climbAboard();
  } else if (isAction('night', e)) {
    const nightSelected = world.dayCycle.mode === 'night'
      || (world.dayCycle.mode === 'cycle' && world.night);
    setTimeOfDay(nightSelected ? 'morning' : 'night');
  } else if (isAction('sonar', e)) {
    deploySonar();
  } else if (isAction('breathInput', e)) {
    const order = breathModes();
    setBreathMode(order[(order.indexOf(breath.state.mode) + 1) % order.length]);
  } else if (isAction('board', e) && !e.repeat) {
    // Every heave is a press of its own: holding the key down does nothing.
    heaveBoat();
  }
});

function breathModes(): BreathMode[] {
  return breath.video.srcObject ? ['presage', 'sim', 'keyboard'] : ['sim', 'keyboard'];
}

function setBreathMode(mode: BreathMode) {
  breath.setMode(mode);
  const names: Record<BreathMode, readonly [string, string]> = { presage: ['presage', '摄像头'], sim: ['sim', '模拟'], keyboard: ['keyboard', '键盘'] };
  const [en, zh] = names[mode] ?? [mode, mode];
  hud.message(t(`Breath input: ${en}`, `呼吸输入：${zh}`));
}

function setTimeOfDay(mode: TimeOfDay) {
  world.setTimeOfDay(mode);
  const labels: Record<TimeOfDay, readonly [string, string]> = {
    cycle: ['Natural day cycle', '自然昼夜'],
    morning: ['Morning light', '晨光'],
    afternoon: ['Afternoon light', '午后阳光'],
    night: ['Moonlight. Rarer fish rise.', '月光下，稀有鱼浮上来了。'],
  };
  hud.message(t(...labels[mode]));
}

const WEATHER_LABELS = {
  clear: ['Clear', '晴朗'],
  cloudy: ['Cloudy', '多云'],
  rain: ['Rain', '降雨'],
  storm: ['Storm', '暴风雨'],
} satisfies Record<string, readonly [string, string]>;

/** The live field note shown while a map is being prepared on the workbench. */
function workbenchConditions(id: MapId): WorkbenchConditions {
  const map = MAPS[id];
  const lighting = world.dayCycle.state;
  const weather = world.weather.state;
  const minute = Math.round(lighting.hour * 60) % (24 * 60);
  const windKmh = Math.round(4 + weather.wind * 30);
  const rainMmh = weather.rain * 18;
  const fishing: WorkbenchConditions['fishing'] = weather.kind === 'storm' || windKmh >= 28 || rainMmh >= 12
    ? { level: 'poor', label: t('Fishing Not Advised', '不建议捕鱼'), reason: t('Rough conditions; wait for calmer weather.', '风雨较强，建议等待天气转好') }
    : weather.kind === 'rain' || windKmh >= 18 || rainMmh >= 4
      ? { level: 'caution', label: t('Fish with Caution', '谨慎捕鱼'), reason: t('Wind or rain; watch the water conditions.', '有风浪或降雨，留意水面变化') }
      : { level: 'good', label: t('Good for Fishing', '推荐捕鱼'), reason: t('Calm conditions for a fishing trip.', '风雨较弱，适合出航探索') };
  const temperatureC = map.surfaceTempC
    + (lighting.daylight - 1) * 3
    - weather.cloud * 1.2
    - weather.rain * 0.8
    - weather.wind * 0.4;
  return {
    time: `${Math.floor(minute / 60) % 12 || 12} ${minute < 720 ? 'a.m.' : 'p.m.'}`,
    temperatureC: Math.round(temperatureC * 10) / 10,
    fishing,
    weather: t(...WEATHER_LABELS[weather.kind]),
    wind: `${Math.round(4 + weather.wind * 30)} km/h`,
    rain: weather.rain < 0.05 ? t('Dry', '无雨') : `${Math.round(weather.rain * 18 * 10) / 10} mm/h`,
    weatherState: weather,
  };
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
  hud.message(t('Deep sonar lowering…', '深海声纳下放中…'), 1400);
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
  keys.delete(e.code);
});
document.getElementById('collection-close')!.addEventListener('click', () => vault.toggle(false));
document.getElementById('gear-open')!.addEventListener('click', () => {
  gear.toggle(true);
  void syncPearls();
});
document.getElementById('report-btn')!.addEventListener('click', () => report.toggle(true));
document.getElementById('set-controls')!.addEventListener('click', openControls);

function axis(neg: readonly string[], pos: readonly string[]) {
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
    hud.message(t('Net full! Surface to bank it.', '网满了！浮上水面入库。'));
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
  trip.catch(caught);
  fieldGuide?.mark('catch');
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
  const entries = net.map(bankEntry);
  bank.push(...entries);
  trip.bank(entries.length);
  // Into the Collection now, minted in the background; until minting starts a shark bite can still take it back.
  for (const entry of entries) diveBanked.add(entry);
  saveBank();
  const rarest = net.reduce((a, f) => (fishValue(f) > fishValue(a) ? f : a));
  hud.message(t(`Banked ${net.length} fish · minting NFTs…`, `已入库 ${net.length} 条鱼 · 正在铸造 NFT…`));
  hud.toast(rarest, t('BANKED', '已入库'));
  // The lifetime value (maps, ships) moves when each fish's co-signed mint records it on chain.
  net = [];
  fieldGuide?.mark('bank');
  hud.setNet(net, currentStats().netCapacity);
  hud.setBank(bank);
  nftQueue.kick();
}

// ---- Maps ---------------------------------------------------------------
/**
 * The lifetime banked value and the unlock thresholds come from the chain (player_state Progress
 * and ProgressConfig, applyPlayerChain); the saved value is only shown while it loads. A dive that
 * opened a map says so once the chain shows it.
 */
function applyMapProgress(snap: ReturnType<typeof playerChain>, announce: boolean) {
  if (!snap) {
    mapProgress.verified = false;
    mapPicker.render();
    workbench.progressChanged();
    return;
  }
  // A ProgressConfig value out of range keeps the thresholds already in place; the rest of the
  // chain listener (the lifetime value below, shipyard.reload, refreshEquipment) still runs.
  try {
    setMapThresholds(gameProgressRules(snap.progressRules).mapThresholds);
  } catch (e) {
    console.error('player_state ProgressConfig map thresholds out of range', e);
  }
  const wasOpen = new Set(MAP_ORDER.filter((id) => isUnlocked(MAPS[id], mapProgress)));
  const hadRead = mapProgress.verified;
  mapProgress.bestValue = progressView(snap.progress).lifetime;
  mapProgress.verified = true;
  if (!isUnlocked(MAPS[mapProgress.selected], mapProgress)) mapProgress.selected = 'fjord';
  saveMapProgress(mapProgress);
  mapPicker.render();
  workbench.progressChanged();
  const opened = MAP_ORDER.filter((id) => !wasOpen.has(id) && isUnlocked(MAPS[id], mapProgress));
  const last = opened.at(-1);
  if (announce && hadRead && last) hud.message(t(`New waters open: ${MAPS[last].name}`, `新水域开放：${MAPS[last].nameZh}`), 3200);
}

/** The maps' zone names (maps.ts keeps them in English) in the UI language. */
const ZONE_ZH: Record<string, string> = { Shallows: '浅水区', 'Sunken Forest': '沉林', Reef: '珊瑚礁', Abyss: '深渊' };
const zoneLabel = (label: string) => t(label, ZONE_ZH[label] ?? label);

function showMapOnHud() {
  const map = world.map;
  hud.setZones(
    mapZones(map).map((z, i) => ({ label: zoneLabel(map.zoneLabels[i]), top: z.top, bottom: z.bottom })),
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

/**
 * preview: the workbench's chart shows any place, locked or not, without choosing it. Only an open
 * map (the chain's lifetime value reached its threshold) is chosen and remembered.
 */
function selectMap(id: MapId, preview = false) {
  if (phase !== 'menu' || id === world.map.id) return;
  const open = isUnlocked(MAPS[id], mapProgress);
  if (!open && !preview) return;
  if (open) {
    mapProgress.selected = id;
    saveMapProgress(mapProgress);
  }
  applyMap(id);
  mapPicker.render();
}

const mapPicker = new MapPicker(mapProgress, selectMap);
showMapOnHud();
onLangChange(showMapOnHud); // the zone names

function blackout() {
  phase = 'blackout';
  const lost = net.length;
  health.end(nowMs, 'blackout', lost);
  net = [];
  hud.setNet(net, currentStats().netCapacity);
  hud.message(lost ? t(`BLACKOUT · ${lost} fish lost`, `昏厥 · 损失 ${lost} 条鱼`) : t('BLACKOUT', '昏厥'), 2200);
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
  trip.start(world.map.id); // the first dive starts a trip; later ones (another map) join it
  diver.group.visible = true;
  shipyard.reload(); shipBonus = shipyard.bonus; hud.setNet(net, currentStats().netCapacity);
  calmSea();
  phase = 'play';
  fieldGuide?.mark('launch');
  // A fresh dive: nothing banked on it yet, and no bite taken.
  diveBanked.clear();
  bitten = false;
  warnAboutSharks();
  resetWorldBounds();
  overlay.classList.add('hidden');
  // The workbench's dive transition may still be fading out if the player was quick.
  workbench.hide();
  hud.show();
  carrySonarForDive();
  hud.message(t('Hold your breath and dive!', '屏住呼吸，下潜！'), 2400);
  const bow = bowSeat.getWorldPosition(new THREE.Vector3());
  diver.jumpTo(new THREE.Vector3(bow.x + JUMP_OUT, -JUMP_DEPTH, 0));
  visitSkinMap(world.map.id);
  wentDown = false;
  tutorialDescended = false;
}

/** Beside the boat at the surface, not in trouble: close enough to climb aboard. */
function canBoard() {
  return (
    phase === 'play' &&
    wentDown &&
    !paused &&
    !diver.jumping &&
    !outOfAir &&
    !stormSea.capsized && // keel up, F is for righting it (heaveBoat)
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
    calibStep.textContent = t('Camera unavailable: using keyboard', '摄像头不可用：改用键盘');
    breath.setMode('keyboard');
    setTimeout(startGame, 1200);
  }
});
document.getElementById('start-keys')!.addEventListener('click', () => {
  breath.setMode('keyboard');
  startGame();
});
document.getElementById('calib-skip')!.addEventListener('click', startGame);

function updateCalibration() {
  const s = breath.state;
  if (s.mode === 'keyboard' && s.error) {
    // breath.ts dropped to keyboard, e.g. the server's live Presage slots are all taken.
    calibStep.textContent = t('Playing with keyboard: hold Shift to dive', '使用键盘游玩：按住 Shift 下潜');
    calibSub.textContent = s.error;
    camWrap.style.visibility = 'hidden';
    if (!calibFallback) calibFallback = setTimeout(() => phase === 'calibrating' && startGame(), 3000);
  } else if (!s.connected) {
    calibStep.textContent = t('Connecting to breath sensor…', '正在连接呼吸传感器…');
    calibSub.textContent = import.meta.env.DEV ? t('Start it with: npm run sensor', '启动方式：npm run sensor') : t('Reconnecting…', '重新连接中…');
  } else if (!s.trace.length) {
    calibStep.textContent = t('Presage is warming up…', 'Presage 预热中…');
    calibSub.textContent = s.hint || t('Sit still, face and chest in view', '坐稳，让脸和胸口留在画面里');
  } else if (!s.calibrated) {
    calibStep.textContent = t('Breathe normally…', '正常呼吸…');
    markCalib('breathe');
    calibSub.textContent = s.hint || t('Learning your breathing rhythm', '正在学习你的呼吸节奏');
  } else if (!sawHold) {
    calibStep.textContent = t('Now hold your breath!', '现在屏住呼吸！');
    markCalib('hold');
    calibSub.textContent = t('We will dive the moment we see it', '一检测到就立刻下潜');
    if (s.holding) {
      sawHold = true;
      markCalib('done');
      calibStep.textContent = t('Got it. Dive!', '好了，下潜！');
      setTimeout(() => phase === 'calibrating' && startGame(), 900);
    }
  }
}

// ---- Pause menu ---------------------------------------------------------
const camWrap = document.getElementById('cam-wrap')!;
let paused = false;
let trialSkinActive=false;
const skinPicker=new SkinPicker(index=>{trialSkinActive=!skinUnlocked(index);diver.setSkin(index);applyEquipmentVisuals();},open=>{paused=open;keys.clear();},()=>world.map.id);
const endSkinTrial=()=>{if(!trialSkinActive)return;trialSkinActive=false;diver.setSkin(0);skinPicker.resetChoice();applyEquipmentVisuals();};
const skinHint=document.createElement('div');skinHint.className='skin-hint';const paintSkinHint=()=>{skinHint.textContent=t('Hold the diver or E to change outfit','长按角色或 E 换装');};paintSkinHint();onLangChange(paintSkinHint);skinHint.hidden=true;document.body.append(skinHint);
setInterval(()=>{skinHint.hidden=phase!=='play'||diver.seated||diver.jumping||paused||-diver.pos.y>SURFACE_DEPTH;},400);
let skinHold:ReturnType<typeof setTimeout>|null=null;
const skinRing=document.createElement('div');skinRing.style.cssText='position:fixed;width:30px;height:30px;transform:translate(-50%,-50%);pointer-events:none;z-index:9999;filter:drop-shadow(0 0 2px #7aead9);display:none';
skinRing.innerHTML='<svg viewBox="0 0 64 64" width="30" height="30"><circle cx="32" cy="32" r="26" fill="#0b273850" stroke="#ffffff40" stroke-width="3"/><circle data-progress cx="32" cy="32" r="26" fill="none" stroke="#b6fff0" stroke-width="3" stroke-linecap="round" stroke-dasharray="163.363" stroke-dashoffset="163.363" transform="rotate(-90 32 32)"/></svg>';document.body.append(skinRing);
let skinProgressFrame=0;
let skinPointer:number|null=null,skinX=0,skinY=0,skinOpened=false;
let skinHoldMode:'pointer'|'keyboard'|null=null;
const clearSkinHold=()=>{if(skinHold!==null)clearTimeout(skinHold);skinHold=null;skinPointer=null;skinHoldMode=null;cancelAnimationFrame(skinProgressFrame);skinRing.style.display='none';};
const canHoldSkin=()=>phase==='play'&&!paused&&!diver.seated&&!diver.jumping&&-diver.pos.y<=SURFACE_DEPTH;
const startSkinProgress=(mode:'pointer'|'keyboard')=>{
  skinHoldMode=mode;
  const rect=canvas.getBoundingClientRect();
  const holdStarted=performance.now();skinRing.style.display='block';
  const drawProgress=()=>{
    if(!canHoldSkin()){clearSkinHold();return;}
    const center=diver.group.getWorldPosition(new THREE.Vector3()).project(camera);
    skinRing.style.left=`${rect.left+(center.x+1)*rect.width/2}px`;skinRing.style.top=`${rect.top+(1-center.y)*rect.height/2}px`;
    skinRing.querySelector('[data-progress]')!.setAttribute('stroke-dashoffset',String(163.363*(1-Math.min(1,(performance.now()-holdStarted)/500))));
    skinProgressFrame=requestAnimationFrame(drawProgress);
  };drawProgress();
  skinHold=setTimeout(()=>{const pointer=skinHoldMode==='pointer';clearSkinHold();if(!canHoldSkin())return;skinOpened=pointer;skinPicker.show();},500);
};
canvas.addEventListener('pointerdown',e=>{
  if(!canHoldSkin()||e.button!==0||skinHoldMode==='keyboard')return;
  const rect=canvas.getBoundingClientRect();
  const screen=diver.group.getWorldPosition(new THREE.Vector3()).project(camera);
  const x=rect.left+(screen.x+1)*rect.width/2,y=rect.top+(1-screen.y)*rect.height/2;
  if(screen.z>1||Math.hypot(e.clientX-x,e.clientY-y)>55)return;
  clearSkinHold();skinPointer=e.pointerId;skinX=e.clientX;skinY=e.clientY;skinOpened=false;
  startSkinProgress('pointer');
},true);
window.addEventListener('keydown',e=>{
  if(e.code!=='KeyE'||!canHoldSkin())return;
  const target=e.target as HTMLElement;
  if(target.closest('input,textarea,select,[contenteditable="true"]'))return;
  e.preventDefault();e.stopImmediatePropagation();
  if(e.repeat)return;
  clearSkinHold();startSkinProgress('keyboard');
},true);
window.addEventListener('keyup',e=>{if(e.code==='KeyE'&&skinHoldMode==='keyboard'){clearSkinHold();keys.delete('KeyE');}},true);
window.addEventListener('pointermove',e=>{if(e.pointerId===skinPointer&&Math.hypot(e.clientX-skinX,e.clientY-skinY)>14)clearSkinHold();},true);
window.addEventListener('pointerup',()=>{if(skinHoldMode==='pointer')clearSkinHold();},true);
window.addEventListener('pointercancel',()=>{if(skinHoldMode==='pointer')clearSkinHold();},true);
window.addEventListener('blur',()=>clearSkinHold());
let catchClickStart=-Infinity,catchClickX=0,catchClickY=0,catchClickReady=false;
canvas.addEventListener('pointerdown',e=>{
  catchClickReady=e.button===0&&phase==='play'&&!paused&&!diver.seated&&!diver.jumping;
  catchClickStart=performance.now();catchClickX=e.clientX;catchClickY=e.clientY;
},true);
window.addEventListener('pointermove',e=>{if(Math.hypot(e.clientX-catchClickX,e.clientY-catchClickY)>14)catchClickReady=false;},true);
window.addEventListener('pointercancel',()=>{catchClickReady=false;},true);
window.addEventListener('blur',()=>{catchClickReady=false;});
canvas.addEventListener('click',e=>{
  if(skinOpened){e.preventDefault();e.stopImmediatePropagation();skinOpened=false;catchClickReady=false;return;}
  const catchNow=catchClickReady&&e.button===0&&performance.now()-catchClickStart<350&&phase==='play'&&!paused&&!diver.seated&&!diver.jumping;
  catchClickReady=false;
  if(catchNow){e.preventDefault();e.stopImmediatePropagation();tryCatch();}
},true);
let resetDayClock = false;

/**
 * The tab was hidden mid-dive: rather than a pause menu, the same as Esc — up to
 * the rope's fish and the workbench, the dive held where it was (Esc on the table
 * carries it on from there; MAIN MENU ends the trip).
 */
function pause() {
  if (phase !== 'play' || paused) return;
  keys.clear();
  loadoutWheel.closeWheel(false);
  climbAboard();
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
  endSkinTrial();
  if (aboard) return;
  aboard = { pos: diver.pos.clone(), vel: diver.vel.clone() };
  phase = 'menu';
  // The boat is a safe zone: clear live colliders before the workbench opens.
  noSharks();
  // The workbench camera is a clean boat view; keep the seated character out of it.
  diver.group.visible = false;
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
  diver.group.visible = true;
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
    diver.group.visible = true;
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
  } else if (settingsDesk.visible) {
    tableFromBench = false; // MAIN MENU goes all the way up, not back to the workbench
    settingsDesk.escape();
  } else if (healthDesk.visible) {
    if (!healthDesk.atRest) return;
    tableFromBench = false;
    healthDesk.escape();
  } else openWorkbench();
}

// Switching tables. AQUARIUM, HEALTH and SETTINGS work from any table: the one up sinks
// while the next rises. A table opened over the workbench (on the title's or aboard
// mid-dive) brings the workbench back when it's left, so Esc then still dives on.
let tableFromBench = false;
let skipReturn = false; // the table sinking now is being swapped for another, not left

/** Sinks whatever table is up (false: one is busy moving, or held). True if there was none, too. */
function swapFrom(): boolean {
  if (loginGate.visible) return false;
  if (workbench.visible) {
    if (!workbench.atRest) return false;
    tableFromBench = true;
    workbench.leave();
  } else if (healthDesk.visible) {
    if (!healthDesk.atRest) return false;
    skipReturn = true;
    healthDesk.leave();
  } else if (settingsDesk.visible) {
    skipReturn = true;
    settingsDesk.escape();
  }
  return true;
}

/** A table opened over the workbench is left: the workbench comes back up as it sinks. */
function backToBench() {
  if (skipReturn) {
    skipReturn = false;
    return;
  }
  if (!tableFromBench) return;
  tableFromBench = false;
  workbench.show(false, true);
}

/** HEALTH: a table comes up with the latest trip report on it, and the jar of earlier ones. */
function openHealthDesk() {
  if (healthDesk.visible || aquarium.open) return;
  if (swapFrom()) healthDesk.show();
}

/** AQUARIUM: a table comes up and the tank drops onto it. */
function openAquarium() {
  if (aquarium.open) return;
  if (!swapFrom()) return;
  aquarium.show();
  void syncPearls(); // the feeder's PEARL balance
  void chainFish.run(); // fish from the wallet's NFTs this browser hasn't seen
}

/**
 * The START fish reads START on the title only: as soon as the camera pans down
 * to a table (the workbench, the settings desk, or aboard) it reads MAIN MENU,
 * and back at the title it reads START again.
 */
function labelStartFish(pan: number) {
  titleScreen.setLabel(START_FISH, pan > 0 || aboard ? t('MAIN MENU', '主菜单') : t('START', '开始'));
}

function onEscape() {
  if (tripReport.open) tripReport.close();
  // The shark cards first: Esc on the warning is its Back, on the bite report its OK.
  else if (!sharkWarn.classList.contains('hidden')) closeSharkWarning(false);
  else if (!sharkBitten.classList.contains('hidden')) sharkBitten.classList.add('hidden');
  else if (shipyard.open) shipyard.close();
  else if (pauseMenu.open) pauseMenu.back();
  else if (vault.open) vault.toggle(false); // the Collection can sit on top of the aquarium
  else if (aquarium.open) aquarium.close();
  else if (report.open) report.toggle(false);
  else if (gear.open) gear.toggle(false);
  else if (loginGate.visible) showTitle(false);
  else if (settingsDesk.visible) settingsDesk.escape();
  else if (healthDesk.visible) healthDesk.escape();
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
  endSkinTrial();
  // Abandoning a dive loses the net, but the breath-hold itself still goes in the health log.
  health.end(nowMs, 'surfaced', 0);
  diver.sit(bowSeat);
  diver.group.visible = false; // back on the title: no diver on the bow
  hud.setBoardPrompt(false);
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
  // A shark bite's dive ends here too (or was left another way during its knockback): say what it cost.
  window.clearTimeout(biteTimer);
  biteTimer = 0;
  diveBanked.clear();
  sharkWarn.classList.add('hidden');
  if (biteLoss) {
    showBiteReport(biteLoss);
    biteLoss = null;
  }
  // Back at the main menu: the trip's over. Its report comes up over the title.
  const record = trip.end(health.dives);
  if (record) tripReport.show(record);
}

function applySettings(s: Settings) {
  renderQuality.setMode(s.quality);
  diver.setQuality(renderQuality.settings);
  world.setLightingEffects(s.lightingEffects);
  world.setWeather(s.weather);
  world.setQuality(renderQuality.settings);
  sonar.setDetail(renderQuality.settings.detail);
  sonar.setLightingEnabled(s.lightingEffects);
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
  quitWarning: () => (net.length ? t(`Your net (${net.length} fish) will be lost.`, `网中的 ${net.length} 条鱼将会丢失。`) : null),
  breathModes,
  breathMode: () => breath.state.mode,
  setBreathMode,
  timeOfDay: () => world.dayCycle.mode,
  setTimeOfDay,
  applySettings,
});

// ---- Title screen -------------------------------------------------------
const shipyard = new Shipyard(world.boat, () => chainProgress()?.lifetime ?? 0, (open) => {
  paused = open;
  keys.clear();
  if (!open) breathSince = null;
}, () => { shipBonus = shipyard.bonus; hud.setNet(net, currentStats().netCapacity); onGearChange(); }, scene, root => world.colorGrade.apply(root),
  () => chainProgress()?.ship ?? null, (i) => void sailShip(i));
// START pans the camera down to the workbench (gear + sea chart); the dive launches from the start card.
const titleScreen = new TitleScreen(document.getElementById('title-canvas') as HTMLCanvasElement, [
  { seed: 0x5eed01, rarity: 'legendary', species: 'Abyssal Sunfish', hue: 40, sat: 0.95, light: 0.56, at: 0.25, label: 'START', onClick: startFish }, // MAIN MENU while aboard
  { seed: 0x5eed02, rarity: 'rare', species: 'Azure Tang', hue: 195, sat: 0.7, light: 0.55, at: 0.42, label: 'AQUARIUM', onClick: openAquarium },
  { seed: 0x5eed04, rarity: 'rare', species: 'Ember Triggerfish', hue: 352, sat: 0.72, light: 0.55, at: 0.59, label: 'HEALTH', onClick: openHealthDesk },
  { seed: 0x5eed03, rarity: 'epic', species: 'Violet Lionfish', hue: 285, sat: 0.75, light: 0.56, at: 0.76, label: 'SETTINGS', onClick: openSettingsDesk },
]);
// The second rope, behind the main one and higher, pulled tighter: the field guide and
// the tutorial. Its fish hang in the gaps between the main rope's, clear of them. It
// follows the main rope's show / hide, and on its way to any table (or the aquarium)
// it rides straight up off the screen.
const backRope = new TitleScreen(
  document.querySelector('#title-back .title-rope') as HTMLCanvasElement,
  [
    { seed: 0x5eed05, rarity: 'uncommon', species: 'Silver Snapper', hue: 150, sat: 0.55, light: 0.55, at: 0.335, label: 'GUIDE', onClick: () => fieldGuide?.toggle() },
    { seed: 0x5eed06, rarity: 'rare', species: 'Ghost Angelfish', hue: 42, sat: 0.35, light: 0.7, at: 0.675, label: 'TUTORIAL', onClick: () => fieldGuide?.toggleTour() },
  ],
  { ropeY: 0.04, slack: 1.01, taut: true, sag: 0.05, lineScale: 0.25, sizeScale: 0.62, underneath: { cursorOn: document.getElementById('title-canvas')! } },
);
{
  const front = { show: titleScreen.show.bind(titleScreen), hide: titleScreen.hide.bind(titleScreen), setPan: titleScreen.setPan.bind(titleScreen), setLift: titleScreen.setLift.bind(titleScreen) };
  let pan = 0;
  let lift = 0;
  const away = () => backRope.setLift(Math.max(pan, lift));
  titleScreen.show = (mode) => {
    front.show(mode);
    backRope.show(mode);
    away();
  };
  titleScreen.hide = () => {
    front.hide();
    backRope.hide();
  };
  titleScreen.setPan = (u, tableY) => {
    front.setPan(u, tableY);
    pan = u;
    away();
  };
  titleScreen.setLift = (u) => {
    front.setLift(u);
    lift = u;
    away();
  };
}
// The trip report, put away, flies into the HEALTH fish (that's where the reports are kept).
const HEALTH_FISH = 2;
tripReport.target = () => titleScreen.fishCenter(HEALTH_FISH);
tripReport.swallowed = () => titleScreen.bump(HEALTH_FISH, 60);
// The fish are built with their English names (which also fixes how each one hangs); the carved names follow the UI language.
const TITLE_LABELS: readonly (readonly [number, string, string])[] = [
  [1, 'AQUARIUM', '鱼缸'],
  [2, 'HEALTH', '健康'],
  [3, 'SETTINGS', '设置'],
];
/** The back rope's fish. */
const BACK_LABELS: readonly (readonly [number, string, string])[] = [
  [0, 'GUIDE', '手册'],
  [1, 'TUTORIAL', '新手引导'],
];
function labelTitleFish() {
  for (const [i, en, zh] of TITLE_LABELS) titleScreen.setLabel(i, t(en, zh));
  for (const [i, en, zh] of BACK_LABELS) backRope.setLabel(i, t(en, zh));
}
labelTitleFish();
onLangChange(() => {
  labelTitleFish();
  labelStartFish(benchPan);
});

// Gear set in the workbench's READY tray for this dive. The selected slots are
// applied when the dive starts, so an omitted accessory falls back to tier 1.
let loadout: UpgradeId[] = [];

// How far the sea camera sinks while the workbench is up, so the pan reads behind the table too.
const BENCH_CAMERA_DROP = 1.4;
let benchPan = 0;

// Each table (the workbench, the settings desk, the health desk, the aquarium's)
// reports its own pan. Switching from one to another, one sinks while the other
// rises: the camera, the title's rope and the START fish follow whichever is
// further in, and mid-swap (two tables up) they hold still.
type TableId = 'bench' | 'desk' | 'health' | 'aquarium';
const tablePan: Record<TableId, number> = { bench: 0, desk: 0, health: 0, aquarium: 0 };
const tableY: Record<TableId, number> = { bench: 0, desk: 0, health: 0, aquarium: 0 };

function tableUp(which: TableId) {
  return which === 'bench' ? workbench.visible : which === 'desk' ? settingsDesk.visible : which === 'health' ? healthDesk.visible : aquariumTable.visible;
}

function setTablePan(which: TableId, u: number, y: number) {
  tablePan[which] = u;
  tableY[which] = y;
  const up = (Object.keys(tablePan) as TableId[]).filter(tableUp);
  const top = up.reduce<TableId>((a, b) => (tablePan[b] > tablePan[a] ? b : a), which);
  // The sea camera sinks for any table.
  benchPan = up.length > 1 ? 1 : up.length ? tablePan[up[0]] : 0;
  // The title's rope hangs over the table, except the aquarium's: there it's lifted off the
  // screen instead (titleScreen.setLift), and a table pan would pull its ends back down.
  const hung: TableId[] = up.filter((t) => t !== 'aquarium');
  const titlePan = hung.length > 1 ? 1 : hung.length ? tablePan[hung[0]] : 0;
  titleScreen.setPan(titlePan, tableY[hung.includes(top) ? top : (hung[0] ?? top)]);
  labelStartFish(titlePan);
}

const synthPanel = new SynthesisPanel({
  state: () => synthesisState,
  equipment: () => equipment,
  pearls: () => spendablePearls(equipment),
  craft: synthCraft,
  upgrade: synthUpgrade,
  close: () => workbench.escape(),
});

const workbench = new Workbench({
  progress: () => mapProgress,
  // Aboard mid-trip, the chart can sail home: the trip ends (its report), then the title.
  canReturn: () => aboard != null,
  returnHome: () => aboardToTitle(),
  pan(u, tableY) {
    setTablePan('bench', u, tableY);
    // Leaving the boat, the fish rise away off the top while the table sinks.
    if (leavingBoat) titleScreen.setLift(1 - u);
  },
  preview: mapPreview,
  dive(id, gear) {
    // The net shaft isn't on the workbench: it always goes down with the diver, at the level owned.
    loadout = gear.includes('rod') ? gear : [...gear, 'rod'];
    activeLoadout = [...loadout];
    const firstPacked = QUICK_SLOTS.find((item) => gear.includes(item.slot));
    activeTool = firstPacked?.slot ?? 'net';
    loadoutWheel.setActive(activeTool);
    hud.setActiveGear(activeTool, activeLoadout.includes(activeTool));
    applyEquipmentVisuals();
    hud.setNet(net, currentStats().netCapacity);
    // The chart only dives open places (the chain's lifetime value); never a locked one regardless.
    selectMap(isUnlocked(MAPS[id], mapProgress) ? id : 'fjord');
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
  conditions: workbenchConditions,
  // The levels and branches are equipment.ts's (the same the gear panel buys); the boat is the shipyard's ship.
  owned: ownedGearLevel,
  buy: (id) => (isUpgradeSlot(id) ? buyNextUpgrade(id) : isBoatId(id) ? buyNextBoat(id) : Promise.resolve(t('Not upgradable here', '这里无法升级'))),
  pearls: () => spendablePearls(equipment),
  paths: (id) =>
    isEquipmentSlot(id)
      ? EQUIPMENT_PATHS[id].map((p) => ({ id: p.id, name: p.name, nameZh: p.nameZh, summary: pathSummary(p), effects: [1, 2, 3].map((lv) => pathEffect(p, lv)) }))
      : null,
  activePath: (id) => (isEquipmentSlot(id) ? activePath(equipment, id) : null),
  selectPath: (id, path) => isEquipmentSlot(id) && selectEquipmentPath(id, path as EquipmentPathId),
  ship: () => ({ key: shipyard.shipIndex, model: shipyard.shipModel() }),
  // The boat opens the ships in the inspector (the same as gear): the shipyard's ships, unlocks and equip.
  ships: {
    list: () =>
      SHIPS.map((s, i) => ({
        name: s.en,
        nameZh: s.cn,
        intro: SHIP_INTROS_EN[i],
        introZh: s.intro,
        threshold: shipThreshold(i),
        bonuses: [
          s.speed ? t(`+${Math.round(s.speed * 100)}% swim speed`, `游速 +${Math.round(s.speed * 100)}%`) : '',
          s.range ? t(`+${Math.round(s.range * 100)}% catch radius`, `捕捞范围 +${Math.round(s.range * 100)}%`) : '',
          s.capacity ? t(`+${s.capacity} net slot${s.capacity > 1 ? 's' : ''}`, `网容量 +${s.capacity}`) : '',
        ].filter(Boolean),
      })),
    current: () => shipyard.shipIndex,
    progress: () => chainProgress()?.lifetime ?? 0,
    model: (i) => shipyard.modelAt(i),
    equip: (i) => sailShip(i),
    parts: () => UPGRADES.filter((u) => u.group === 'boat'),
  },
  // The ready tray is saved per wallet whenever it changes, and comes back packed the same.
  savedLoadout() {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey('loadout')) ?? 'null');
      return Array.isArray(saved) ? saved.filter((id): id is UpgradeId => typeof id === 'string') : null;
    } catch {
      return null;
    }
  },
  saveLoadout(gear) {
    try {
      localStorage.setItem(storageKey('loadout'), JSON.stringify(gear));
    } catch {
      // Private mode or full storage: it just isn't remembered.
    }
  },
  sonarColor(color) {
    sonar.setColor(color);
    world.colorGrade.apply(sonar.group);
  },
  tutorial(id: LessonId) {
    fieldGuide?.mark(id);
  },
  guide() {
    // Workbench has finished lifting the physical book; now reveal the pages.
    return fieldGuide?.openFromWorkbench() ?? false;
  },
  synthesisOpen() {
    synthPanel.show();
    void syncPearls();
  },
  synthesisClose() {
    synthPanel.hide();
  },
});

fieldGuide = new FieldGuide({
  canOpen: () => phase !== 'calibrating' && !pauseMenu.open && !shipyard.open && !settingsDesk.visible && !loginGate.visible && !aquarium.open && !vault.open && !gear.open && !report.open,
  toggled(open) {
    if (open) {
      guideWasPaused = paused;
      paused = true;
      keys.clear();
    } else {
      workbench.guideClosed();
      paused = guideWasPaused;
      keys.clear();
      breathSince = null;
    }
  },
  syncTutorial() {
    if (workbench.packed.includes('net')) fieldGuide?.mark('pack');
  },
  packed: () => workbench.packed,
});
// The gear panel (G) buys too: whatever buys or picks a ship, the pieces on the table follow.
onGearChange = () => workbench.visible && workbench.refreshGear();

function isUpgradeSlot(id: UpgradeId): id is UpgradeSlot {
  return id in EQUIPMENT_TIERS;
}

/**
 * The highest level owned of a piece (1 = the starting gear): dive gear from the PlayerState,
 * boat parts from the chain's Progress.boat_levels (Lv1 until it is read; no cache grants one).
 */
function ownedGearLevel(id: UpgradeId): number {
  if (isUpgradeSlot(id)) return ownedLevel(equipment, id);
  if (isBoatId(id)) return chainProgress()?.boatLevels[id] ?? 1;
  return 1;
}

function isEquipmentSlot(id: UpgradeId): id is EquipmentSlot {
  return id in EQUIPMENT_PATHS;
}

function showTitle(intro: boolean) {
  overlay.classList.add('hidden');
  loginGate.hide();
  workbench.hide();
  settingsDesk.hide();
  healthDesk.hide();
  tableFromBench = false;
  skipReturn = false;
  benchPan = 0;
  titleScreen.setPan(0);
  labelStartFish(0);
  titleScreen.show(intro);
}

// A wallet is required, so START goes through the login gate unless a wallet is connected,
// matching main since #68 (per-wallet saves, and NFT minting needs an owner).
const REQUIRE_PHANTOM = true;
const loginGate = new LoginGate(() => showTitle(false));
// Log out from Settings, the pause menu, the collection, and a chip over the title and workbench.
const logoutHooks = { warning: logoutWarning, logOut };
mountWalletRow(document.getElementById('set-wallet')!, logoutHooks, { empty: () => t('Not connected', '未连接') });
mountWalletRow(document.getElementById('pause-wallet')!, logoutHooks);
mountWalletRow(document.getElementById('collection-wallet')!, logoutHooks, { empty: () => t('Not connected', '未连接'), explorer: true });
mountWalletRow(document.getElementById('wallet-chip')!, logoutHooks, { menu: true });

// SETTINGS pans down to a table like START's, with the settings as plaques on it (settings-desk.ts).
const settingsDesk = new SettingsDesk({
  settings: () => settings,
  change: (patch) => pauseMenu.change(patch),
  timeOfDay: () => world.dayCycle.mode,
  setTimeOfDay,
  connectWallet: () => loginGate.show(),
  logOut: () => void logOut(),
  pan(u, tableY) {
    setTablePan('desk', u, tableY);
  },
  view(move, yaw, pitch) {
    deskView.move.copy(move);
    deskView.yaw = yaw;
    deskView.pitch = pitch;
  },
  openControls,
  // Opened from the workbench: that table comes back up as this one sinks.
  leaving: () => backToBench(),
});
// The Aquarium covers the whole viewport: the scene behind it (title fish, workbench, desk) ignores the pointer and keys meanwhile.
titleScreen.blocked = backRope.blocked = workbench.blocked = settingsDesk.blocked = () => aquarium.open;

/** SETTINGS: from the title, pan down to the settings desk; from the workbench, swap tables. */
function openSettingsDesk() {
  if (settingsDesk.visible || aquarium.open) return;
  if (swapFrom()) settingsDesk.show(); // the table up sinks while this one rises
}

healthDesk.onLeave = aquariumTable.onLeave = () => backToBench();

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
// no-ops until a wallet connects. The first connect loads that wallet's
// progress in place; switching accounts or logging out reloads the page,
// so nothing in memory from one wallet can be saved under another, and no
// timer, poll or mint keeps running for it.
let walletOwner: string | null = null;

// ---- On-chain gear --------------------------------------------------------
// The player's Boat and Dive Kit NFTs follow their levels in the background (gear-sync.ts): minted
// once to the owner by the game wallet, then updated after each settled batch of changes. The
// game never waits on it. VITE_GEAR_NFT=0 (not a secret) turns it off; local levels are the truth.
const GEAR_NFT_ON = (import.meta.env.VITE_GEAR_NFT as string | undefined) !== '0';

/**
 * The levels the NFTs should show now, or null before a wallet's progress has loaded from the
 * chain (boat parts and the ship come only from Progress; the local cache never stands in).
 */
function gearSnapshot(): GearLevels | null {
  if (!walletOwner || !playerChain()) return null;
  const branches = Object.fromEntries((Object.keys(EQUIPMENT_PATHS) as EquipmentSlot[]).map((slot) => [slot, activePath(equipment, slot)]));
  return {
    boat: normalizeBoat({ ship: shipyard.shipIndex, ...Object.fromEntries(BOAT_IDS.map((id) => [id, ownedGearLevel(id)])) }),
    kit: normalizeKit({
      rod: ownedLevel(equipment, 'rod'),
      reel: ownedLevel(equipment, 'reel'),
      net: ownedLevel(equipment, 'net'),
      fins: ownedLevel(equipment, 'fins'),
      tank: ownedLevel(equipment, 'tank'),
      lamp: ownedLevel(equipment, 'lamp'),
      sonar: ownedLevel(equipment, 'sonar'),
      branches,
    }),
  };
}

const gearSync = new GearSync({
  key: () => (walletState().owner ? storageKey('gear-nft') : null),
  store: localStorage,
  session: () => walletState().session,
  snapshot: gearSnapshot,
  loadChain: () => import('./chain'),
  isFundsError,
  timers: { now: () => Date.now(), setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: (id) => window.clearTimeout(id) },
  changed: () => {}, // status is no longer shown anywhere; the sync runs in the background
  hidden: () => document.hidden,
});
// Every level change (bought, branch switched, ship equipped, a penalty's reset) reaches the sync.
onGearLevelsChanged(() => gearSync.levelsChanged());

const diving = () => phase !== 'menu';

/** What logging out right now would cost, or null when nothing. */
function logoutWarning(): string | null {
  const parts: string[] = [];
  if (diving()) parts.push(net.length ? t(`This dive ends and your net (${net.length} fish) is lost.`, `本次下潜结束，网中的 ${net.length} 条鱼将会丢失。`) : t('This dive ends.', '本次下潜结束。'));
  if (nftQueue.busy) parts.push(t('A fish still minting or selling picks up again at your next login.', '仍在铸造或出售中的鱼会在你下次登录时继续。'));
  return parts.length ? parts.join(t(' ', '')) : null;
}

let loggingOut = false;
/** Log out: progress and the session key stay saved for this wallet; the page reloads to the title. */
async function logOut() {
  if (loggingOut) return;
  loggingOut = true;
  try {
    // End a dive the way Main menu does: the hold still goes in this wallet's health log.
    if (diving()) goToMenu();
    nftQueue.stop();
    gearSync.stop();
    chainFish.stop();
    await disconnectWallet(); // drops the owner: the listener below reloads
  } finally {
    loggingOut = false;
  }
}

function loadWalletProgress() {
  bank.splice(0, bank.length, ...loadBank());
  Object.assign(equipment, loadEquipment());
  synthesisState = loadSynthesis();
  // A save from before on-chain player state is test data: show the start until the chain is read.
  if (!chainCached()) Object.assign(equipment, equipmentFromChain(equipment, null));
  // The saved lifetime value is only shown until this wallet's chain read (applyPlayerChain) says.
  Object.assign(mapProgress, loadMapProgress());
  health.reload();
  // Still on the title: keep its random backdrop; the workbench sets the dive's map.
  if (!titleScreen.visible) applyMap(isUnlocked(MAPS[mapProgress.selected], mapProgress) ? mapProgress.selected : 'fjord');
  hud.setBank(bank);
  refreshEquipment();
  applyMapProgress(playerChain(), false);
  shipyard.reload(); shipBonus = shipyard.bonus; refreshEquipment();
  // Resume fish this wallet left queued to mint or sell.
  nftQueue.start();
  // And bring its Boat and Dive Kit NFTs up to date (minting them the first time).
  if (GEAR_NFT_ON) gearSync.start();
  // Gear, paths, materials and aquarium growth come from the player_state accounts (the local
  // saves above are only their cache); then an owed shark bite and lost confirmations settle.
  void startPlayerChain();
  // And add the fish NFTs it owns on chain that this browser's save does not have.
  chainFish.start();
}

onWalletChange((s) => {
  if (s.owner === walletOwner) return;
  if (walletOwner) {
    location.reload();
    return;
  }
  walletOwner = s.owner;
  loadWalletProgress();
  void syncPearls(); // first read after login feeds the title badge
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
  // The camera may already be on (calibration or breath test): release it on the way out.
  if (phase === 'calibrating' || breath.video.srcObject) goToMenu();
  else {
    overlay.classList.add('hidden');
    titleScreen.show(false);
    workbench.show(false);
  }
}

showTitle(true);

// A hidden tab throttles the game loop to ~2 fps; don't let the dive run on unattended.
document.addEventListener('visibilitychange', () => {
  resetDayClock = true;
  if (document.hidden) pause();
});

// ---- Main loop ----------------------------------------------------------
const clock = new THREE.Clock();
const camTarget = new THREE.Vector3();
const camLook = new THREE.Vector3();
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
// How far the settings desk's camera has moved and turned to lean in over a plaque (settings-desk.ts).
const deskView = { move: new THREE.Vector3(), yaw: 0, pitch: 0 };
const timeLabel = document.getElementById('time-of-day')!;
let displayedMinute = -1;
let displayedWeather = '';
// A language switch repaints the clock at once.
onLangChange(() => {
  displayedMinute = -1;
  updateTimeLabel();
});

function updateTimeLabel() {
  const minute = Math.round(world.dayCycle.hour * 60) % (24 * 60);
  const weather = world.weather.state.kind;
  if (minute === displayedMinute && weather === displayedWeather) return;
  displayedMinute = minute;
  displayedWeather = weather;
  const hour = Math.floor(minute / 60);
  const period = world.night ? t('Night', '夜晚') : hour < 12 ? t('Morning', '上午') : hour < 18 ? t('Afternoon', '下午') : t('Dusk', '黄昏');
  timeLabel.textContent = `${period} · ${String(hour).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')} · ${t(...WEATHER_LABELS[weather])}`;
}

function update(dt: number, time: number) {
  const s = breath.state;
  const depth = -diver.pos.y;
  const underwater = depth > SURFACE_DEPTH;
  const playing = phase === 'play';
  nowMs = time * 1000;
  health.tick(nowMs, s, depth, underwater && playing);
  trip.sample(s);

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
      hud.message(t('You breathed! SURFACE NOW!', '你换气了！立刻上浮！'), 1500);
    }
    if (s.holding && !lastHolding && !underwater) hud.message(t('Diving…', '下潜中…'), 800);
    lastHolding = s.holding;

    let ax = axis(keysFor('left'), keysFor('right'));
    let ay = axis(keysFor('down'), keysFor('up'));
    if (!underwater && !s.holding && ay < 0) {
      ay = 0;
      if (Math.random() < 0.02) hud.message(t('Hold your breath to dive', '屏住呼吸即可下潜'), 900);
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

  if (!flying) swimPhysics(dt, s);
  if (playing && -diver.pos.y > BOARD_AFTER_M) {
    wentDown = true;
    if (!tutorialDescended) {
      tutorialDescended = true;
      fieldGuide?.mark('descend');
    }
  }
  hud.setBoardPrompt(canBoard());
  const shelfY = world.seabedY + 1.2; // lowest the diver can go outside the trench (as in swimPhysics)

  // Over the shelf the seabed is the sharks' floor; down the trench there is none.
  tendSharks(dt, s.pulse, s.holding, Math.abs(diver.pos.x) <= TRENCH_X && diver.pos.y < shelfY ? -Infinity : world.seabedY);

  // Rough seas: only during a dive, and only where a storm piles up the swell.
  const stormEvent = stormSea.tick(dt, world.weather.state.storm, phase === 'play' && world.map.stormSwell > 0);
  world.setRogueWave(stormSea.x, stormSea.dir, stormSea.height);
  world.boatPose = stormSea.capsized ? stormSea.pose : null;
  stormFx.update(dt, time, stormSea.x, stormSea.dir, stormSea.height, seaSurface);
  if (stormEvent === 'wave') hud.message(t('A rogue wave is bearing down on the boat!', '一道巨浪正朝船扑来！'), 2600);
  else if (stormEvent === 'capsize') capsize();
  else if (stormEvent === 'righted') {
    // It comes down on its keel with a crash.
    stormFx.burst(stormSea.boatX, world.surfaceAt(0, 0), 0, 90, 0, 8);
    stormShake = Math.max(stormShake, 0.35);
    hud.message(t('Boat righted', '船已翻正'), 1600);
  }
  promptForBoat();
  // The sea shudders as the wave closes in, and jolts when it hits.
  if (stormSea.x !== null && !stormSea.capsized) stormShake = Math.max(stormShake, 0.12 * (stormSea.height / ROGUE.height) * Math.exp(-Math.abs(stormSea.x - diver.pos.x) / 25));
  stormShake = Math.max(0, stormShake - dt * 0.55);

  // In heavy seas a swimmer near the surface rises and falls with the swell (the picture only:
  // depth, air and banking still count from the mean waterline).
  diver.setLampEnvironment(world.dayCycle.state.nightMix, world.lightingEffectsEnabled);
  diver.update(dt, time, -diver.pos.y, world.heaveAt(diver.pos.x) * (1 - THREE.MathUtils.smoothstep(-diver.pos.y, 0.5, 6)));
  sonar.update(time, dt);
  if (!sonarCarried && sonar.mode === 'anchored' && !sonarGuiding && sonar.group.visible) {
    sonarGuiding = true;
    hud.message(t('Sonar guidance online · follow the pulses', '声纳引导已开启 · 跟着脉冲走'), 2200);
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
  // Read the post-swell hull pose so the wake follows the same crest that is
  // visible in this frame, including the rogue-wave pitch and roll.
  if (phase === 'play') {
    stormFx.boatWake(
      dt,
      time,
      world.boat.position.x,
      world.boat.position.y,
      world.boat.rotation.x,
      world.boat.rotation.z,
      seaSurface,
    );
  }

  // On the menu the camera sinks a little as the workbench (or the aquarium) pans in.
  cameraTarget(camTarget, phase === 'menu' ? benchPan * BENCH_CAMERA_DROP : 0);
  camera.position.sub(shakeOffset);
  // The settings desk's camera leans in over a plaque: the sea camera moves and turns
  // with it, so it reads as the camera moving rather than the table sliding over a
  // still view. (The sea is in metres, the desk in table units: near enough the same.)
  const leaning = settingsDesk.visible;
  if (leaning) camTarget.add(deskView.move);
  camera.position.lerp(camTarget, Math.min(1, dt * 3));
  const look = camLook.set(0, -1.6, -camera.position.z);
  if (leaning) look.applyAxisAngle(AXIS_X, deskView.pitch).applyAxisAngle(AXIS_Y, -deskView.yaw);
  camera.lookAt(look.add(camera.position));

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
  hud.placeBreath(overDiversHead());
  hud.setHotbar(QUICK_SLOTS, activeTool, (slot) => activeLoadout == null || activeLoadout.includes(slot));
  hud.setDepth(-diver.pos.y);
  // outOfAir stays set through the 2 s blackout; blackout() already hid the bar.
  hud.setEmergency(outOfAir && phase === 'play' ? emergency : null);
  if (phase === 'calibrating') updateCalibration();
}

/** Water drag, speed cap, buoyancy, the trench walls, and banking at the surface. */
function swimPhysics(dt: number, s: BreathState) {
  diver.vel.multiplyScalar(Math.exp(-DRAG * dt));
  // Fins (and the ship's bonus) improve ordinary swimming only. Emergency ascent keeps its own cap.
  const cap = outOfAir ? 10 : currentStats().swimSpeed;
  if (diver.vel.length() > cap) diver.vel.setLength(cap);
  if (!s.holding && !outOfAir && -diver.pos.y < 3) diver.vel.y += 6 * dt;
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
      hud.message(net.length ? t('Made it!', '成功了！') : t('Phew.', '呼——'), 900);
    }
    if (phase === 'play') {
      if (stormSea.capsized) {
        // Nowhere to land the catch while the boat is keel up: it stays in the net.
        health.end(nowMs, 'surfaced', 0);
        if (net.length && time > capsizeHintAt) {
          hud.message(t('The boat is capsized: right it to bank your catch', '船翻了：先把船翻正才能入库渔获'), 2000);
          capsizeHintAt = time + 8;
        }
      } else {
        health.end(nowMs, net.length ? 'banked' : 'surfaced', net.length);
        bankNet();
      }
    }
  }
}

const HEAD_TAG_Y = 1.3; // the breath tag floats this far above the diver's middle
const headTag = new THREE.Vector3();

/** Where the breath tag goes: just above the diver's head on screen, or null if that's off screen. */
function overDiversHead(): { x: number; y: number } | null {
  camera.updateMatrixWorld();
  headTag.copy(diver.pos).setY(diver.pos.y + HEAD_TAG_Y).project(camera);
  if (headTag.z > 1 || Math.abs(headTag.x) > 1.1 || Math.abs(headTag.y) > 1.1) return null;
  const r = renderer.domElement.getBoundingClientRect();
  return { x: r.left + ((headTag.x + 1) / 2) * r.width, y: r.top + ((1 - headTag.y) / 2) * r.height };
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
  // The corner 手册 / 新手引导 buttons: on the title the rope's GUIDE and TUTORIAL fish stand in for them.
  // Outside update() so a pause does not leave them stale; showLauncher only touches the DOM on a change.
  fieldGuide?.showLauncher(!titleScreen.visible);
  if (previewOn) renderPreview(); // before the main view, which is what the canvas then shows
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();

// Exposed for quick debugging in the console: debugStep(2) simulates 2 s.
Object.assign(window, {
  backRope,
  healthDesk,
  aquarium,
  aquariumTable,
  workbench,
  equipment,
  shipyard,
  settingsDesk,
  loadout: () => loadout,
  /** How far the camera is from where a dive starts (0 right after the workbench hands over). */
  diveCameraOffset: () => camera.position.distanceTo(cameraTarget(new THREE.Vector3(), 0)),
  breath,
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
  sharkPack,
  nftQueue,
  /** The on-chain Boat and Dive Kit sync: gearSync.status('kit'), gearSync.log. */
  gearSync,
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
