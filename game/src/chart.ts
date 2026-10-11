import { MAPS, MAP_ORDER, isUnlocked, type MapId, type MapProgress } from './maps';
import { t as tr } from './i18n';
import { chartWeather, type ChartCloud, type ChartWind, type WeatherState } from './weather';

// The sea chart on the workbench: a hand-drawn parchment map with the three
// places, one per chapter. The same drawing is the folded map's texture on the
// table (with its pins painted on) and the big chart it opens into (where the
// pins are buttons, see workbench.ts).

export const CHART_W = 1000;
export const CHART_H = 640;

/** Where each place sits on the chart, as fractions of its width and height. */
export const PLACES: Record<MapId, { fx: number; fy: number }> = {
  fjord: { fx: 0.27, fy: 0.37 },
  tianchi: { fx: 0.785, fy: 0.37 },
  ocean: { fx: 0.5, fy: 0.75 },
};

export const ROMAN = ['I', 'II', 'III'];

const INK = '#5b3a1c';
const LAND = '#ead3a0';
const SEA = '#d9dfc8';
const WATER = '#7fb6b8';

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** A coastline: a wobbly ellipse, with narrow `dips` (angle, depth, width) cut in for inlets. */
function coast(c: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, seed: number, rough: number, dips: [number, number, number][] = []) {
  const rand = rng(seed);
  const k = [rand() * 6, rand() * 6, rand() * 6];
  const n = 160;
  c.beginPath();
  for (let i = 0; i <= n; i++) {
    const th = (i / n) * Math.PI * 2;
    let r = 1 + rough * (0.5 * Math.sin(3 * th + k[0]) + 0.3 * Math.sin(7 * th + k[1]) + 0.2 * Math.sin(15 * th + k[2]));
    for (const [a, d, w] of dips) {
      const dd = Math.atan2(Math.sin(th - a), Math.cos(th - a));
      r -= d * Math.exp(-((dd / w) ** 2));
    }
    const x = cx + Math.cos(th) * rx * r;
    const y = cy + Math.sin(th) * ry * r;
    if (i) c.lineTo(x, y);
    else c.moveTo(x, y);
  }
  c.closePath();
}

/** Land with a pale-blue shallows halo and an inked shore. */
function land(c: CanvasRenderingContext2D, path: () => void) {
  c.save();
  path();
  c.strokeStyle = WATER;
  for (const [w, a] of [[34, 0.12], [20, 0.18], [9, 0.25]] as const) {
    c.globalAlpha = a;
    c.lineWidth = w;
    c.stroke();
  }
  c.globalAlpha = 1;
  c.fillStyle = LAND;
  c.fill();
  c.strokeStyle = INK;
  c.lineWidth = 2.5;
  c.stroke();
  c.restore();
}

function mountains(c: CanvasRenderingContext2D, path: () => void, seed: number, count: number, box: [number, number, number, number]) {
  const rand = rng(seed);
  c.save();
  path();
  c.clip();
  c.strokeStyle = INK;
  c.lineWidth = 1.8;
  c.fillStyle = 'rgba(91, 58, 28, 0.18)';
  for (let i = 0; i < count; i++) {
    const x = box[0] + rand() * (box[2] - box[0]);
    const y = box[1] + rand() * (box[3] - box[1]);
    const s = 9 + rand() * 9;
    c.beginPath();
    c.moveTo(x - s, y + s * 0.7);
    c.lineTo(x, y - s * 0.7);
    c.lineTo(x + s, y + s * 0.7);
    c.fill();
    c.stroke();
  }
  c.restore();
}

function waves(c: CanvasRenderingContext2D, seed: number, count: number, avoid: (x: number, y: number) => boolean) {
  const rand = rng(seed);
  c.save();
  c.strokeStyle = 'rgba(64, 120, 128, 0.55)';
  c.lineWidth = 1.6;
  for (let i = 0; i < count; i++) {
    const x = 40 + rand() * (CHART_W - 80);
    const y = 60 + rand() * (CHART_H - 110);
    if (avoid(x, y)) continue;
    c.beginPath();
    c.moveTo(x - 10, y);
    c.quadraticCurveTo(x - 5, y - 5, x, y);
    c.quadraticCurveTo(x + 5, y + 5, x + 10, y);
    c.stroke();
  }
  c.restore();
}

function compass(c: CanvasRenderingContext2D, x: number, y: number, r: number) {
  c.save();
  c.translate(x, y);
  c.strokeStyle = INK;
  c.lineWidth = 1.5;
  c.beginPath();
  c.arc(0, 0, r * 0.62, 0, Math.PI * 2);
  c.stroke();
  for (let i = 0; i < 8; i++) {
    const long = i % 2 === 0;
    const a = (i / 8) * Math.PI * 2;
    const len = long ? r : r * 0.55;
    c.fillStyle = i % 4 === 0 ? '#9e2b25' : long ? INK : 'rgba(91, 58, 28, 0.55)';
    c.beginPath();
    c.moveTo(Math.sin(a) * len, -Math.cos(a) * len);
    c.lineTo(Math.sin(a + 0.35) * r * 0.16, -Math.cos(a + 0.35) * r * 0.16);
    c.lineTo(Math.sin(a - 0.35) * r * 0.16, -Math.cos(a - 0.35) * r * 0.16);
    c.fill();
  }
  c.fillStyle = INK;
  c.font = '700 16px Georgia, serif';
  c.textAlign = 'center';
  c.fillText('N', 0, -r - 6);
  c.restore();
}

/** One pin, as painted on the folded map's texture. */
function pin(c: CanvasRenderingContext2D, x: number, y: number, label: string, locked: boolean) {
  c.save();
  c.fillStyle = 'rgba(0, 0, 0, 0.25)';
  c.beginPath();
  c.ellipse(x + 3, y + 5, 22, 20, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = locked ? '#7d7466' : '#b8322a';
  c.strokeStyle = '#fff3d6';
  c.lineWidth = 4;
  c.beginPath();
  c.arc(x, y, 21, 0, Math.PI * 2);
  c.fill();
  c.stroke();
  c.fillStyle = '#fff7e6';
  c.font = '900 19px Georgia, serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(locked ? '×' : label, x, y + 1);
  c.restore();
}

const PENCIL = 'rgba(91, 58, 28, 0.78)';

/**
 * One cloud, in the same pencil as the coastlines: rain slanting under it when it rains,
 * a bolt when it thunders. Drawn about 75 units wide at size 1.
 */
function cloudMark(c: CanvasRenderingContext2D, m: ChartCloud) {
  const s = 0.5 * m.size;
  c.save();
  c.translate(m.x * CHART_W, m.y * CHART_H);
  c.scale(s, s);
  c.globalAlpha = m.ink;
  c.lineCap = 'round';
  c.lineJoin = 'round';

  // A strike lights the air under the cloud for a moment.
  if (m.flash) {
    c.fillStyle = 'rgba(244, 207, 92, 0.3)';
    c.beginPath();
    c.ellipse(6, 52, 46, 34, 0, 0, Math.PI * 2);
    c.fill();
  }
  if (m.rain > 0) {
    // Five strokes, every other one a step further down each quarter second: falling rain.
    c.strokeStyle = `rgba(83, 119, 133, ${0.4 + 0.45 * m.rain})`;
    c.lineWidth = 2.4 / s;
    for (let i = 0; i < 5; i++) {
      const dx = -50 + i * 25;
      const fall = ((i + m.step) % 2) * 9;
      const length = 13 + ((i + m.step) % 3) * 4;
      c.beginPath();
      c.moveTo(dx, 31 + fall);
      c.lineTo(dx - 7, 31 + fall + length);
      c.stroke();
    }
  }
  if (m.bolt > 0) {
    c.globalAlpha = m.ink * m.bolt;
    c.fillStyle = m.flash ? 'rgba(255, 226, 120, 0.98)' : 'rgba(244, 207, 92, 0.9)';
    c.strokeStyle = PENCIL;
    c.lineWidth = 1.6 / s;
    c.beginPath();
    c.moveTo(9, 33);
    c.lineTo(-6, 59);
    c.lineTo(7, 56);
    c.lineTo(-4, 86);
    c.lineTo(28, 48);
    c.lineTo(14, 51);
    c.closePath();
    c.fill();
    c.stroke();
    c.globalAlpha = m.ink;
  }

  const outline = () => {
    c.beginPath();
    c.moveTo(-74, 14);
    c.quadraticCurveTo(-68, -8, -46, -5);
    c.quadraticCurveTo(-34, -29, -9, -12);
    c.quadraticCurveTo(13, -43, 36, -12);
    c.quadraticCurveTo(65, -16, 72, 12);
    c.quadraticCurveTo(59, 31, 33, 25);
    c.quadraticCurveTo(7, 39, -15, 25);
    c.quadraticCurveTo(-39, 36, -56, 23);
    c.quadraticCurveTo(-72, 29, -74, 14);
  };
  outline();
  c.fillStyle = 'rgba(203, 211, 200, 0.92)';
  c.fill();
  // The heavier the cloud, the more of the chart's own ink is washed into it.
  c.fillStyle = `rgba(91, 58, 28, ${0.12 * m.rain + 0.2 * m.bolt})`;
  c.fill();
  c.strokeStyle = PENCIL;
  c.lineWidth = 1.7 / s;
  c.stroke();
  // A second, lighter pass gives the outline the uneven pressure of pencil.
  c.globalAlpha = m.ink * 0.4;
  c.lineWidth = 0.9 / s;
  c.beginPath();
  c.moveTo(-69, 17);
  c.quadraticCurveTo(-45, 8, -30, 15);
  c.quadraticCurveTo(-3, 24, 23, 13);
  c.quadraticCurveTo(50, 23, 67, 14);
  c.stroke();
  c.restore();
}

/** A gust: two or three streaks with a hooked end, pointing the way the weather drifts. */
function windMark(c: CanvasRenderingContext2D, m: ChartWind) {
  const s = 0.9 * m.size;
  c.save();
  c.translate(m.x * CHART_W, m.y * CHART_H);
  c.scale(s, s);
  c.globalAlpha = m.ink;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = PENCIL;
  c.lineWidth = 2.1 / s;
  for (let i = 0; i < m.lines; i++) {
    const y = (i - (m.lines - 1) / 2) * 14;
    const x = -30 + (i % 2) * 9;
    c.beginPath();
    c.moveTo(x, y);
    c.quadraticCurveTo(x + 19, y - 8, x + 39, y);
    c.quadraticCurveTo(x + 49, y + 4, x + 58, y - 4);
    c.stroke();
    c.beginPath();
    c.moveTo(x + 51, y - 8);
    c.lineTo(x + 59, y - 4);
    c.lineTo(x + 51, y + 1);
    c.stroke();
  }
  c.restore();
}

/** Everything under the weather: paper, land, sea and route. It is the slow part, so it is kept. */
let ground: { key: string; canvas: HTMLCanvasElement } | null = null;

function paintGround(cv: HTMLCanvasElement, scale: number) {
  cv.width = Math.round(CHART_W * scale);
  cv.height = Math.round(CHART_H * scale);
  const c = cv.getContext('2d')!;
  c.setTransform(scale, 0, 0, scale, 0, 0);

  // Parchment, darker toward the worn edges.
  c.fillStyle = SEA;
  c.fillRect(0, 0, CHART_W, CHART_H);
  const age = c.createRadialGradient(CHART_W / 2, CHART_H / 2, CHART_H * 0.3, CHART_W / 2, CHART_H / 2, CHART_W * 0.62);
  age.addColorStop(0, 'rgba(255, 250, 230, 0.35)');
  age.addColorStop(1, 'rgba(140, 96, 40, 0.42)');
  c.fillStyle = age;
  c.fillRect(0, 0, CHART_W, CHART_H);

  // Depth rings around the open ocean, and the routes between chapters.
  const o = PLACES.ocean;
  c.save();
  c.setLineDash([3, 7]);
  c.strokeStyle = 'rgba(64, 120, 128, 0.5)';
  c.lineWidth = 1.5;
  for (let r = 50; r < 200; r += 38) {
    c.beginPath();
    c.ellipse(o.fx * CHART_W, o.fy * CHART_H, r * 1.5, r * 0.75, 0, 0, Math.PI * 2);
    c.stroke();
  }
  c.restore();

  // North: fjord country, cut by long narrow inlets.
  const north = () => coast(c, 70, 40, 330, 250, 11, 0.06, [[0.55, 0.32, 0.05], [0.8, 0.36, 0.045], [1.05, 0.3, 0.05], [1.3, 0.22, 0.06]]);
  land(c, north);
  mountains(c, north, 5, 34, [0, 0, 330, 240]);
  // East: the mountains around Heaven Lake.
  const east = () => coast(c, 940, 250, 250, 300, 23, 0.07);
  land(c, east);
  mountains(c, east, 9, 40, [700, 0, 1000, 520]);
  const t = PLACES.tianchi;
  c.save();
  c.fillStyle = WATER;
  c.strokeStyle = INK;
  c.lineWidth = 2;
  coast(c, t.fx * CHART_W, t.fy * CHART_H, 52, 34, 31, 0.08);
  c.fill();
  c.stroke();
  // Stone pillars around the lake.
  c.fillStyle = '#b79c6e';
  for (const [dx, dy, h] of [[-70, -14, 26], [-62, 22, 20], [64, -24, 24], [72, 14, 30], [-10, -52, 22], [24, 50, 18]]) {
    const x = t.fx * CHART_W + dx;
    const y = t.fy * CHART_H + dy;
    c.beginPath();
    c.roundRect(x - 5, y - h, 10, h, [5, 5, 1, 1]);
    c.fill();
    c.stroke();
  }
  c.restore();
  // A few islands.
  for (const [x, y, r, s] of [[560, 170, 30, 41], [420, 290, 16, 43], [690, 560, 22, 47], [150, 470, 26, 53], [880, 590, 18, 59]]) {
    land(c, () => coast(c, x, y, r * 1.3, r, s, 0.18));
  }

  waves(c, 77, 70, (x, y) => {
    c.save();
    north();
    const hit = c.isPointInPath(x * scale, y * scale);
    east();
    const hit2 = c.isPointInPath(x * scale, y * scale);
    c.restore();
    return hit || hit2 || MAP_ORDER.some((id) => Math.hypot(x - PLACES[id].fx * CHART_W, y - PLACES[id].fy * CHART_H) < 70);
  });

  // The route, chapter to chapter.
  const at = (id: MapId) => [PLACES[id].fx * CHART_W, PLACES[id].fy * CHART_H] as const;
  const [ax, ay] = at('fjord');
  const [bx, by] = at('tianchi');
  const [cx2, cy2] = at('ocean');
  c.save();
  c.setLineDash([10, 9]);
  c.strokeStyle = 'rgba(158, 43, 37, 0.75)';
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(ax, ay);
  c.quadraticCurveTo((ax + bx) / 2, ay - 120, bx, by);
  c.quadraticCurveTo(bx - 40, cy2 + 40, cx2, cy2);
  c.stroke();
  c.restore();

}

/**
 * Draws the chart into `cv` at `scale` × (CHART_W × CHART_H) pixels.
 * pins: paint the three place markers (the texture); the open chart uses buttons instead.
 * The weather is where its clouds and gusts have drifted to at `second`; `seed` scatters them.
 */
export function drawChart(cv: HTMLCanvasElement, scale: number, progress: MapProgress, pins: boolean, weather?: WeatherState, second = 0, seed = 0) {
  const key = `${scale}`;
  if (ground?.key !== key) {
    ground = { key, canvas: ground?.canvas ?? document.createElement('canvas') };
    paintGround(ground.canvas, scale);
  }
  if (cv.width !== ground.canvas.width || cv.height !== ground.canvas.height) {
    cv.width = ground.canvas.width;
    cv.height = ground.canvas.height;
  }
  const c = cv.getContext('2d')!;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.drawImage(ground.canvas, 0, 0);
  c.setTransform(scale, 0, 0, scale, 0, 0);
  const at = (id: MapId) => [PLACES[id].fx * CHART_W, PLACES[id].fy * CHART_H] as const;

  // Weather is a live field note layered over the fixed geography. It is
  // intentionally drawn before the title, pins and frame so important map
  // controls stay crisp and the clouds read as ink on the chart.
  if (weather) {
    const marks = chartWeather(weather, second, seed);
    for (const wind of marks.winds) windMark(c, wind);
    for (const cloud of marks.clouds) cloudMark(c, cloud);
  }

  compass(c, 96, CHART_H - 96, 54);

  // Title cartouche.
  c.save();
  c.fillStyle = 'rgba(255, 246, 222, 0.85)';
  c.strokeStyle = INK;
  c.lineWidth = 2;
  c.beginPath();
  c.roundRect(CHART_W / 2 - 150, 22, 300, 58, 8);
  c.fill();
  c.stroke();
  c.fillStyle = INK;
  c.textAlign = 'center';
  c.font = 'italic 700 26px Georgia, serif';
  c.fillText(tr('Sea Chart', '海图'), CHART_W / 2, 59);
  c.restore();

  if (pins) {
    MAP_ORDER.forEach((id, i) => {
      const [x, y] = at(id);
      pin(c, x, y, ROMAN[i], !isUnlocked(MAPS[id], progress));
    });
  }

  // Double rule frame.
  c.strokeStyle = INK;
  c.lineWidth = 3;
  c.strokeRect(10, 10, CHART_W - 20, CHART_H - 20);
  c.lineWidth = 1;
  c.strokeRect(18, 18, CHART_W - 36, CHART_H - 36);
}
