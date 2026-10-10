import * as THREE from 'three';
import { BreathSource, type BreathMode } from './breath';
import { Diver } from './diver';
import { Fish, FishSpec, RARITY, RARITY_ORDER, rollFish, ZONES, type Zone } from './fish';
import { Hud } from './hud';
import { Vault } from './vault';
import { HealthLog } from './health';
import { Report } from './report';
import { HALF_WIDTH, SEABED_Y, World } from './world';
import { GearPanel } from './gear-panel';
import { loadEquipment, nextRodTier, rodTier, saveEquipment, upgrade, type EquipmentState } from './equipment';

// ---- Tuning -------------------------------------------------------------
const SWIM_ACCEL = 24;
const DRAG = 2.4;
const MAX_SPEED = 7.5;
const SURFACE_DEPTH = 0.9; // shallower than this counts as "at the surface"
const EMERGENCY_SECONDS = 3.2; // air left after you breathe underwater
const EMERGENCY_LIFT = 18;
const FISH_PER_ZONE = [16, 16, 12];
const MAX_DEPTH = -SEABED_Y;

// ---- Setup --------------------------------------------------------------
const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const world = new World();
const scene = world.scene;
const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 400);
camera.position.set(0, 1.5, 24);

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const diver = new Diver(scene);
const hud = new Hud();
const breath = new BreathSource(document.getElementById('cam') as HTMLVideoElement);

const fishes: Fish[] = [];
let night = false;

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

function rollFor(zone: Zone, depth: number): FishSpec {
  const a = rollFish(randomSeed(), zone, depth);
  if (!night) return a;
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
}

ZONES.forEach((zone, i) => {
  for (let k = 0; k < FISH_PER_ZONE[i]; k++) spawnFish(zone);
});

// ---- Game state ---------------------------------------------------------
type Phase = 'menu' | 'calibrating' | 'play' | 'blackout';
let phase: Phase = 'menu';
let outOfAir = false;
let emergency = 1;
let net: FishSpec[] = [];
const bank: FishSpec[] = loadBank();
const equipment: EquipmentState = loadEquipment();
let lastHolding = false;

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
hud.setNet(net, currentTier().capacity);
hud.setBank(bank);
const vault = new Vault(bank, saveBank);
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

function buyNextRod() {
  const next = nextRodTier(equipment);
  if (!next) {
    gear.showNotice('The net is already at maximum level.');
    return;
  }
  const upgraded = upgrade(equipment);
  if (!upgraded) {
    gear.showNotice(`Need ${next.cost - equipment.pearls} more Pearls.`);
    hud.message(`Need ${next.cost - equipment.pearls} more Pearls`, 1500);
    return;
  }
  equipment.rodLevel = upgraded.rodLevel;
  equipment.pearls = upgraded.pearls;
  refreshEquipment();
  hud.message(`Rod upgraded: Level ${equipment.rodLevel}`, 1800);
}

// ---- Input --------------------------------------------------------------
const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  keys.add(e.key.toLowerCase());
  if (e.key.toLowerCase() === 'h' && phase !== 'calibrating') report.toggle();
  if (phase !== 'play') return;
  if (e.code === 'Space') {
    e.preventDefault();
    tryCatch();
  } else if (e.key.toLowerCase() === 'c') {
    vault.toggle();
  } else if (e.key.toLowerCase() === 'g') {
    gear.toggle();
  } else if (e.key.toLowerCase() === 'n') {
    night = !night;
    world.setNight(night);
    hud.message(night ? 'Night falls. Rarer fish rise.' : 'Sunrise.');
  } else if (e.key.toLowerCase() === 'k') {
    const order: BreathMode[] = breath.video.srcObject ? ['presage', 'sim', 'keyboard'] : ['sim', 'keyboard'];
    const next = order[(order.indexOf(breath.state.mode) + 1) % order.length];
    breath.setMode(next);
    hud.message(`Breath input: ${next}`);
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
document.getElementById('collection-close')!.addEventListener('click', () => vault.toggle(false));
document.getElementById('gear-open')!.addEventListener('click', () => gear.toggle(true));
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
  fishes.splice(fishes.indexOf(best), 1);
  scene.remove(best.mesh.group);
  const caught = { ...best.spec, depthM: Math.round(-best.pos.y) };
  net.push(caught);
  hud.setNet(net, tier.capacity);
  hud.toast(caught);
  const zone = best.zone;
  setTimeout(() => spawnFish(zone), 4000);
}

function bankNet() {
  if (!net.length) return;
  const reward = net.reduce((sum, f) => sum + RARITY[f.rarity].value, 0);
  bank.push(...net);
  saveBank();
  equipment.pearls += reward;
  refreshEquipment();
  const rarest = net.reduce((a, f) => (RARITY[f.rarity].value > RARITY[a.rarity].value ? f : a));
  hud.message(`Banked ${net.length} fish · +${reward} Pearls`);
  hud.toast(rarest, 'BANKED');
  net = [];
  hud.setNet(net, currentTier().capacity);
  hud.setBank(bank);
}

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

function startGame() {
  phase = 'play';
  overlay.classList.add('hidden');
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

function updateCalibration() {
  const s = breath.state;
  if (!s.connected) {
    calibStep.textContent = 'Connecting to breath sensor…';
    calibSub.textContent = 'Start it with: npm run sensor';
  } else if (!s.trace.length) {
    calibStep.textContent = 'Presage is warming up…';
    calibSub.textContent = s.hint || 'Sit still, face and chest in view';
  } else if (!s.calibrated) {
    calibStep.textContent = 'Breathe normally…';
    calibSub.textContent = s.hint || 'Learning your breathing rhythm';
  } else if (!sawHold) {
    calibStep.textContent = 'Now hold your breath!';
    calibSub.textContent = 'We will dive the moment we see it';
    if (s.holding) {
      sawHold = true;
      calibStep.textContent = 'Got it. Dive!';
      setTimeout(startGame, 900);
    }
  }
}

// ---- Main loop ----------------------------------------------------------
const clock = new THREE.Clock();
const camTarget = new THREE.Vector3();

function update(dt: number, time: number) {
  const s = breath.state;
  const depth = -diver.pos.y;
  const underwater = depth > SURFACE_DEPTH;
  const playing = phase === 'play';
  nowMs = time * 1000;
  health.tick(nowMs, s, depth, underwater && playing);

  if (playing) {
    // Breathing underwater = out of air. You must make it up before it runs out.
    if (underwater && !s.holding && !outOfAir) {
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

  // Water drag, speed cap, and gentle buoyancy at the surface.
  diver.vel.multiplyScalar(Math.exp(-DRAG * dt));
  const cap = outOfAir ? 10 : MAX_SPEED;
  if (diver.vel.length() > cap) diver.vel.setLength(cap);
  if (!s.holding && !outOfAir && depth < 3) diver.vel.y += 6 * dt;
  diver.pos.addScaledVector(diver.vel, dt);
  diver.pos.x = THREE.MathUtils.clamp(diver.pos.x, -HALF_WIDTH, HALF_WIDTH);
  diver.pos.y = THREE.MathUtils.clamp(diver.pos.y, SEABED_Y + 1.2, -0.05);

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
  world.update(time, camera.position.y);

  // Camera: side-on 2.5D follow with a little lead. Underwater it stays below
  // the surface so we never look at the diver through the translucent waves.
  const camY = diver.pos.y > -2.5 ? 2.2 : Math.min(diver.pos.y + 1.2, -1.2);
  camTarget.set(diver.pos.x + diver.vel.x * 0.35, Math.max(camY, SEABED_Y + 9), 22);
  camera.position.lerp(camTarget, Math.min(1, dt * 3));
  camera.lookAt(camera.position.x, camera.position.y - 1.6, 0);

  hud.setBreath(s, outOfAir);
  hud.setDepth(-diver.pos.y, MAX_DEPTH);
  hud.setEmergency(outOfAir ? emergency : null);
  if (phase === 'calibrating') updateCalibration();
}

let time = 0;
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  time += dt;
  update(dt, time);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();

// Exposed for quick debugging in the console: debugStep(2) simulates 2 s.
Object.assign(window, {
  breath,
  diver,
  fishes,
  keys,
  debugStep(seconds: number) {
    for (let t = 0; t < seconds; t += 1 / 30) {
      time += 1 / 30;
      update(1 / 30, time);
    }
    renderer.render(scene, camera);
  },
});
