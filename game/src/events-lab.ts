import * as THREE from 'three';
import { EVENT_DEFS, SURFACE_VIEW_DEPTH, UNDERWATER_DEPTH } from './event-schedule';
import { enhanceSelect } from './dropdown';
import { WorldEvents, type Detail, type EventContext } from './events';
import { MAPS, MAP_ORDER, mapDepth, type MapId } from './maps';
import { RENDER_QUALITY } from './render-quality';
import type { WeatherMode } from './weather';
import { World } from './world';

// Dev-only page (http://localhost:5173/events-lab.html): the real World for
// each map's sky, fog and water, with buttons to fire every world event, a
// detail selector, a depth slider and an FPS / draw-call readout.
// Console helpers live on `window.lab` (trigger, step, snapshot...).

const QUALITY = { 1: RENDER_QUALITY.low, 2: RENDER_QUALITY.medium, 3: RENDER_QUALITY.high } as const;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('scene');
const params = new URLSearchParams(location.search);

let mapId: MapId = (MAP_ORDER as readonly string[]).includes(params.get('map') ?? '') ? (params.get('map') as MapId) : 'fjord';
let detail = (Number(params.get('detail')) || 3) as Detail;
let depth = 0;
let camX = 0;
let night = false;
let paused = false;

// preserveDrawingBuffer lets snapshot() read the last frame.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
const world = new World(QUALITY[detail], MAPS[mapId]);
const scene = world.scene;
const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 400);
const events = new WorldEvents(scene, MAPS[mapId], detail);
events.auto = false;

function resize() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---- Controls -----------------------------------------------------------

const mapSelect = $<HTMLSelectElement>('map');
for (const id of MAP_ORDER) mapSelect.add(new Option(`${MAPS[id].name} · ${MAPS[id].nameZh}`, id));
mapSelect.value = mapId;
const detailSelect = $<HTMLSelectElement>('detail');
detailSelect.value = String(detail);
const depthInput = $<HTMLInputElement>('depth');
const camxInput = $<HTMLInputElement>('camx');
const nightInput = $<HTMLInputElement>('night');
const weatherSelect = $<HTMLSelectElement>('weather');
const lightingInput = $<HTMLInputElement>('lighting');
const autoInput = $<HTMLInputElement>('auto');
for (const select of [mapSelect, detailSelect, weatherSelect]) enhanceSelect(select);

function setMap(id: MapId) {
  mapId = id;
  mapSelect.value = id;
  world.setMap(MAPS[id]);
  events.setMap(MAPS[id]);
  depthInput.max = String(mapDepth(MAPS[id]) - 1);
  setDepth(Math.min(depth, mapDepth(MAPS[id]) - 1));
  buildButtons();
}

function setDetail(d: Detail) {
  detail = d;
  detailSelect.value = String(d);
  world.setQuality(QUALITY[d]);
  events.setDetail(d);
}

function setDepth(m: number) {
  depth = m;
  depthInput.value = String(m);
  $('depthOut').textContent = `${m.toFixed(1)} m`;
}

function setCameraX(x: number) {
  camX = x;
  camxInput.value = String(x);
  $('camxOut').textContent = String(x);
}

function setNight(on: boolean) {
  night = on;
  nightInput.checked = on;
  world.setTimeOfDay(on ? 'night' : 'morning');
  // Settle the transition now instead of over the next two seconds.
  world.advanceTime(5, false);
}

function setWeather(mode: WeatherMode) {
  weatherSelect.value = mode;
  world.setWeather(mode);
  world.advanceTime(6, false);
}

function setLighting(on: boolean) {
  lightingInput.checked = on;
  world.setLightingEffects(on);
}

/** Fire an event, first moving the camera to where it can be seen. */
function trigger(id: string) {
  const def = EVENT_DEFS.find((d) => d.id === id);
  if (def) {
    if (def.underwater && depth <= UNDERWATER_DEPTH) setDepth(Math.min(14, mapDepth(MAPS[mapId]) - 4));
    if (!def.underwater && depth > (def.maxDepth ?? SURFACE_VIEW_DEPTH)) setDepth(0);
    if (def.when === 'night' && !night) setNight(true);
    if (def.when === 'day' && night) setNight(false);
    if (def.minStorm !== undefined && world.weather.state.storm < def.minStorm) setWeather('storm');
    if (def.maxCloud !== undefined && world.weather.state.cloud > def.maxCloud) setWeather('clear');
  }
  // trigger() places the event with the context from the latest update(), so pass
  // the new depth and clock along first (a zero-length step).
  simulate(0);
  return events.trigger(id);
}

function buildButtons() {
  for (const box of ['surface', 'under']) $(box).replaceChildren();
  for (const info of events.events) {
    const button = document.createElement('button');
    button.textContent = info.id;
    button.title = info.label;
    button.dataset.id = info.id;
    button.onclick = () => trigger(info.id);
    $(info.underwater ? 'under' : 'surface').append(button);
  }
}

mapSelect.onchange = () => setMap(mapSelect.value as MapId);
detailSelect.onchange = () => setDetail(Number(detailSelect.value) as Detail);
depthInput.oninput = () => setDepth(Number(depthInput.value));
camxInput.oninput = () => setCameraX(Number(camxInput.value));
nightInput.onchange = () => setNight(nightInput.checked);
weatherSelect.onchange = () => setWeather(weatherSelect.value as WeatherMode);
lightingInput.onchange = () => setLighting(lightingInput.checked);
autoInput.onchange = () => (events.auto = autoInput.checked);
$('hide').onclick = () => $('panel').classList.toggle('hidden');

let toastTimer = 0;
events.onEvent = (e) => {
  const toast = $('toast');
  toast.textContent = e.label;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 3500);
};

// ---- Loop ---------------------------------------------------------------

const ctx: EventContext = { cameraY: 2.2, depth: 0, night: false, shelfDepth: 30, cameraX: 0, aspect: 1.6 };
let time = 0;

function cameraY() {
  // Same framing as main.ts: above the water near the surface, else just above the diver.
  const y = depth < SURFACE_VIEW_DEPTH ? 2.2 : Math.min(-depth + 1.2, -1.2);
  return Math.max(y, world.seabedY + 9);
}

function updateContext() {
  ctx.cameraY = cameraY();
  ctx.depth = depth;
  ctx.night = night;
  ctx.cameraX = camX;
  ctx.aspect = camera.aspect;
  const weather = world.weather.state;
  ctx.storm = weather.storm;
  ctx.cloud = weather.cloud;
  ctx.lightingEffects = world.lightingEffectsEnabled;
  ctx.shelfDepth = Math.min(38, mapDepth(MAPS[mapId]) * 0.6);
}

function simulate(dt: number) {
  time += dt;
  updateContext();
  world.advanceTime(dt);
  world.update(time, ctx.cameraY, camX);
  events.update(time, dt, ctx);
  world.quietWeatherLightning = events.activeId === 'lightning';
  const shake = events.shake;
  camera.position.set(
    camX + shake * Math.sin(time * 47.3) * Math.cos(time * 13.1),
    ctx.cameraY + shake * Math.sin(time * 53.7 + 1.3) * Math.cos(time * 9.7),
    22,
  );
  camera.lookAt(camX, ctx.cameraY - 1.6, 0);
}

// Event draw calls: visible renderables under the events root (frustum culling may skip some).
function eventDrawables() {
  const root = scene.getObjectByName('world-events');
  let n = 0;
  const walk = (o: THREE.Object3D) => {
    if (!o.visible) return;
    if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) n++;
    o.children.forEach(walk);
  };
  if (root) walk(root);
  return n;
}

const clock = new THREE.Clock();
let fpsFrames = 0;
let fpsTime = 0;
let fps = 0;
let frameMs = 0;
let added = 0;
let peak = 0;
let lastRunning: string | null = null;
let sampleAt = 0;

function render() {
  renderer.render(scene, camera);
}

/** Exact draw calls the events add: render once without them and compare. */
function eventCalls() {
  const root = scene.getObjectByName('world-events');
  render();
  const withEvents = renderer.info.render.calls;
  if (!root) return 0;
  root.visible = false;
  render();
  const without = renderer.info.render.calls;
  root.visible = true;
  render();
  return withEvents - without;
}

function frame() {
  const elapsed = clock.getDelta();
  if (!paused) simulate(Math.min(elapsed, 0.05));
  render();

  fpsFrames++;
  fpsTime += elapsed;
  if (fpsTime >= 0.5) {
    fps = fpsFrames / fpsTime;
    frameMs = (fpsTime / fpsFrames) * 1000;
    fpsFrames = 0;
    fpsTime = 0;
  }
  const status = events.status;
  const calls = renderer.info.render.calls;
  const running = status.running?.id ?? null;
  if (running !== lastRunning) peak = 0;
  lastRunning = running;
  if (performance.now() > sampleAt) {
    sampleAt = performance.now() + 500;
    added = eventCalls();
    peak = Math.max(peak, added);
  }
  const drawables = eventDrawables();
  for (const b of document.querySelectorAll<HTMLButtonElement>('.buttons button')) b.classList.toggle('on', b.dataset.id === running);
  $('stats').textContent = [
    `fps        ${fps.toFixed(0)}  (${frameMs.toFixed(1)} ms)`,
    `draw calls ${calls}  (events +${added}, peak +${peak})`,
    `event objs ${drawables} visible`,
    `triangles  ${renderer.info.render.triangles}`,
    `running    ${running ? `${running} ${status.elapsed.toFixed(1)} / ${status.duration.toFixed(1)} s` : '-'}`,
    `shake      ${events.shake.toFixed(3)}`,
    `next       ${status.nextIn === null ? '-' : `${status.nextIn.toFixed(0)} s`}${events.auto ? '' : ' (schedule off)'}`,
  ].join('\n');
  requestAnimationFrame(frame);
}

setMap(mapId);
setDetail(detail);
// Fixed light and weather unless the panel changes them.
setNight(false);
setWeather('clear');
frame();

Object.assign(window, {
  lab: {
    world,
    events,
    renderer,
    trigger,
    setMap,
    setDetail,
    setDepth,
    setNight,
    setWeather,
    setLighting,
    setCameraX,
    /** Freeze the clock (step() still advances it). */
    pause(on = true) {
      paused = on;
    },
    /** Advance the simulation by `seconds` in 1/60 s steps, then draw. */
    step(seconds: number) {
      for (let t = 0; t < seconds - 1e-6; t += 1 / 60) simulate(1 / 60);
      render();
    },
    snapshot(quality = 0.88) {
      render();
      return canvas.toDataURL('image/jpeg', quality);
    },
    drawables: eventDrawables,
    eventCalls,
    /**
     * Fire `id`, step through the whole event in 0.25 s steps and return the peak
     * extra draw calls. `onShot(t)` runs at each time in `shots` (e.g. to save a frame).
     */
    async measure(id: string, shots: number[] = [], onShot?: (t: number) => unknown) {
      const lab = (window as unknown as { lab: { step(s: number): void } }).lab;
      if (!trigger(id)) return null;
      const duration = events.status.duration;
      const times = [...shots].sort((a, b) => a - b);
      let t = 0;
      let peak = 0;
      const gl = renderer.getContext();
      const px = new Uint8Array(4);
      while (events.status.running?.id === id) {
        // Let the GPU finish and the page breathe, so long runs don't stall the tab.
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const shot = times.length && times[0] <= t + 0.25 ? times.shift()! : null;
        const dt = shot !== null ? Math.max(0, shot - t) : 0.25;
        lab.step(dt);
        t += dt;
        if (!events.status.running) break;
        peak = Math.max(peak, eventCalls());
        if (shot !== null && onShot) await onShot(shot);
      }
      return { id, detail, duration, peakCalls: peak, idleCalls: eventCalls() };
    },
    /**
     * Average ms per simulated + rendered frame, forcing the GPU to finish each
     * one. Works while the tab is in the background, where rAF FPS is throttled.
     */
    bench(frames = 120) {
      const gl = renderer.getContext();
      const px = new Uint8Array(4);
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        simulate(1 / 60);
        render();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      return (performance.now() - t0) / frames;
    },
    status: () => ({ ...events.status, calls: renderer.info.render.calls, fps }),
  },
});
