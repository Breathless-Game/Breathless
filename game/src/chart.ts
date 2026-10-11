import { MAPS, MAP_ORDER, isUnlocked, type MapId, type MapProgress } from './maps';
import { weatherArtProfile, type WeatherState } from './weather';

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

/** A weather stamp in the same pencil language as the coastlines and route. */
function weatherGlyphs(c: CanvasRenderingContext2D, weather: WeatherState) {
  const art = weatherArtProfile(weather);
  if (art.cloudInk <= 0 && art.windMarks === 0 && art.rainMarks === 0 && art.lightning === 0) return;

  // Keep the mark in open water below the cartouche. Its fixed seed makes it
  // feel drawn on paper instead of jittering as the live front advances.
  const x = 555;
  const y = 124;
  const ink = 'rgba(91, 58, 28, 0.78)';
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';

  if (art.cloudInk > 0) {
    const opacity = 0.26 + art.cloudInk * 0.30;
    c.fillStyle = `rgba(191, 202, 194, ${opacity})`;
    c.strokeStyle = ink;
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(x - 74, y + 14);
    c.quadraticCurveTo(x - 68, y - 8, x - 46, y - 5);
    c.quadraticCurveTo(x - 34, y - 29, x - 9, y - 12);
    c.quadraticCurveTo(x + 13, y - 43, x + 36, y - 12);
    c.quadraticCurveTo(x + 65, y - 16, x + 72, y + 12);
    c.quadraticCurveTo(x + 59, y + 31, x + 33, y + 25);
    c.quadraticCurveTo(x + 7, y + 39, x - 15, y + 25);
    c.quadraticCurveTo(x - 39, y + 36, x - 56, y + 23);
    c.quadraticCurveTo(x - 72, y + 29, x - 74, y + 14);
    c.fill();
    c.stroke();
    // A second, lighter pass gives the outline the uneven pressure of pencil.
    c.globalAlpha = 0.34 * art.cloudInk;
    c.lineWidth = 1.2;
    c.beginPath();
    c.moveTo(x - 69, y + 17);
    c.quadraticCurveTo(x - 45, y + 8, x - 30, y + 15);
    c.quadraticCurveTo(x - 3, y + 24, x + 23, y + 13);
    c.quadraticCurveTo(x + 50, y + 23, x + 67, y + 14);
    c.stroke();
    c.globalAlpha = 1;
  }

  if (art.rainMarks > 0) {
    c.strokeStyle = 'rgba(83, 119, 133, 0.78)';
    c.lineWidth = 2;
    const count = Math.max(4, art.rainMarks);
    for (let i = 0; i < count; i++) {
      const dx = -58 + i * (116 / Math.max(1, count - 1));
      const length = 15 + (i % 3) * 4;
      c.beginPath();
      c.moveTo(x + dx, y + 31);
      c.lineTo(x + dx - 7, y + 31 + length);
      c.stroke();
    }
  }

  if (art.windMarks > 0) {
    c.strokeStyle = 'rgba(91, 58, 28, 0.64)';
    c.lineWidth = 2;
    const count = Math.max(2, art.windMarks);
    for (let i = 0; i < count; i++) {
      const yy = y - 36 + i * 15;
      const start = x + 88 + (i % 2) * 8;
      c.beginPath();
      c.moveTo(start, yy);
      c.quadraticCurveTo(start + 19, yy - 8, start + 39, yy);
      c.quadraticCurveTo(start + 49, yy + 4, start + 58, yy - 4);
      c.stroke();
      c.beginPath();
      c.moveTo(start + 51, yy - 8);
      c.lineTo(start + 59, yy - 4);
      c.lineTo(start + 51, yy + 1);
      c.stroke();
    }
  }

  if (art.lightning > 0) {
    c.fillStyle = 'rgba(244, 207, 92, 0.85)';
    c.strokeStyle = ink;
    c.lineWidth = 2.5;
    c.beginPath();
    c.moveTo(x + 9, y + 35);
    c.lineTo(x - 4, y + 59);
    c.lineTo(x + 8, y + 56);
    c.lineTo(x - 3, y + 83);
    c.lineTo(x + 27, y + 49);
    c.lineTo(x + 14, y + 51);
    c.closePath();
    c.fill();
    c.stroke();
  }

  c.fillStyle = ink;
  c.globalAlpha = 0.82;
  c.font = '700 13px Georgia, serif';
  c.textAlign = 'center';
  const label = weather.kind === 'storm' ? 'STORM FRONT · 暴风前线' : weather.kind === 'rain' ? 'RAIN · 雨幕' : 'CLOUD BANK · 云层';
  c.fillText(label, x, y + 105);
  c.restore();
}

/**
 * Draws the chart into `cv` at `scale` × (CHART_W × CHART_H) pixels.
 * pins: paint the three place markers (the texture); the open chart uses buttons instead.
 */
export function drawChart(cv: HTMLCanvasElement, scale: number, progress: MapProgress, pins: boolean, weather?: WeatherState) {
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

  // Weather is a live field note layered over the fixed geography. It is
  // intentionally drawn before the title, pins and frame so important map
  // controls stay crisp and the stamp reads as ink on the chart.
  if (weather) weatherGlyphs(c, weather);

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
  c.fillText('Sea Chart · 海图', CHART_W / 2, 59);
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
