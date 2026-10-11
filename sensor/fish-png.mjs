// The NFT art for a fish, rendered on the server for /api/nft (nft-meta.mjs). Node has no WebGL,
// so this is a tiny software renderer of the same low-poly mesh game/src/fish.ts builds, posed and
// lit roughly like the card in game/src/portrait.ts: rarity gradient, seeded shards, the fish, a
// rarity border. No font rasteriser here, so the only text is the fish's number (#0042), drawn
// from a tiny bitmap font; the wallet shows the name anyway.
import { encodePng } from './pearl-png.mjs';

// ---- Mirrors of game/src/fish.ts. Keep in sync when species or shapes change.

export const RARITIES = {
  common: { label: 'Common', color: '#b8c4cc', emissive: 0 },
  uncommon: { label: 'Uncommon', color: '#5fd38d', emissive: 0 },
  rare: { label: 'Rare', color: '#4aa8ff', emissive: 0.05 },
  epic: { label: 'Epic', color: '#b46cff', emissive: 0.15 },
  legendary: { label: 'Legendary', color: '#ffb340', emissive: 0.45 },
  mythic: { label: 'Mythic', color: '#ff5fd2', emissive: 0.7 },
};

export const ARCHETYPES = {
  slim: { len: 1.5, height: 0.42, width: 0.28, tail: 0.45, dorsal: 0.25 },
  perch: { len: 1.3, height: 0.62, width: 0.34, tail: 0.5, dorsal: 0.35 },
  disc: { len: 1.0, height: 1.05, width: 0.24, tail: 0.45, dorsal: 0.45 },
  long: { len: 2.3, height: 0.4, width: 0.3, tail: 0.6, dorsal: 0.5 },
  bulky: { len: 1.8, height: 1.1, width: 0.6, tail: 0.75, dorsal: 0.4 },
};

// species: [tailTaper, headVolume, bodyWidth, dorsal, pectoral, tailSpread, pattern]
const SPECIES = {
  'Sand Minnow': [0.58, 0.82, 0.82, 0.7, 0.75, 0.9, 'solid'],
  'Grey Perch': [0.72, 1.08, 1.0, 1.1, 1.0, 1.0, 'stripes'],
  'Mud Goby': [0.8, 1.2, 1.15, 0.5, 1.3, 0.8, 'spots'],
  'Striped Wrasse': [0.62, 0.98, 0.9, 1.2, 0.9, 1.05, 'stripes'],
  'Coral Chromis': [0.7, 0.92, 0.86, 1.0, 0.85, 1.1, 'glow'],
  'Silver Snapper': [0.65, 1.14, 1.05, 0.85, 1.05, 0.95, 'mask'],
  'Azure Tang': [0.7, 0.9, 1.0, 1.2, 0.85, 1.2, 'mask'],
  'Neon Cardinal': [0.56, 0.85, 0.78, 0.8, 0.8, 1.25, 'stripes'],
  'Spotted Grouper': [0.82, 1.22, 1.08, 0.8, 1.1, 0.85, 'spots'],
  'Violet Lionfish': [0.72, 0.96, 0.95, 1.9, 1.45, 1.0, 'stripes'],
  'Ember Triggerfish': [0.74, 1.18, 1.12, 1.0, 0.9, 0.9, 'mask'],
  'Ghost Angelfish': [0.64, 0.88, 0.92, 1.45, 1.25, 1.08, 'glow'],
  'Golden Koi Dragon': [0.5, 1.14, 0.9, 0.7, 1.1, 1.35, 'stripes'],
  'Abyssal Sunfish': [0.9, 1.28, 1.2, 0.65, 0.8, 0.72, 'glow'],
  'Crowned Sailfish': [0.46, 0.82, 0.72, 2.1, 0.85, 1.5, 'mask'],
  'Moonfin Leviathan': [0.42, 1.2, 0.88, 1.35, 1.2, 1.55, 'glow'],
  'Prism Coelacanth': [0.78, 1.12, 1.08, 1.15, 1.35, 1.05, 'spots'],
};
const DEFAULT_PROFILE = [0.7, 1, 1, 1, 1, 1, 'solid'];

function profileOf(species) {
  const [tailTaper, headVolume, bodyWidth, dorsal, pectoral, tailSpread, pattern] = SPECIES[species] ?? DEFAULT_PROFILE;
  return { tailTaper, headVolume, bodyWidth, dorsal, pectoral, tailSpread, pattern };
}

// ---- Colour and vector helpers

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;

function hsl(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  s = clamp01(s);
  l = clamp01(l);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

// ---- A supersampled RGB raster with alpha-blended fills

class Raster {
  constructor(size, ss) {
    this.size = size;
    this.ss = ss;
    this.n = size * ss;
    this.px = new Float32Array(this.n * this.n * 3);
  }

  blend(i, c, a) {
    const p = this.px;
    p[i] += (c[0] - p[i]) * a;
    p[i + 1] += (c[1] - p[i + 1]) * a;
    p[i + 2] += (c[2] - p[i + 2]) * a;
  }

  /** Fill with a per-pixel colour function of output-space coordinates. */
  shade(fn) {
    for (let y = 0; y < this.n; y++) {
      for (let x = 0; x < this.n; x++) {
        const c = fn((x + 0.5) / this.ss, (y + 0.5) / this.ss);
        const i = (y * this.n + x) * 3;
        this.px[i] = c[0];
        this.px[i + 1] = c[1];
        this.px[i + 2] = c[2];
      }
    }
  }

  tri(a, b, c, color, alpha = 1) {
    const k = this.ss;
    const [ax, ay, bx, by, cx, cy] = [a[0] * k, a[1] * k, b[0] * k, b[1] * k, c[0] * k, c[1] * k];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) return;
    const s = area > 0 ? 1 : -1;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(this.n - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(this.n - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const w0 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
        const w1 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
        const w2 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        if (s * w0 >= 0 && s * w1 >= 0 && s * w2 >= 0) this.blend((y * this.n + x) * 3, color, alpha);
      }
    }
  }

  rect(x0, y0, x1, y1, color, alpha = 1) {
    this.tri([x0, y0], [x1, y0], [x1, y1], color, alpha);
    this.tri([x0, y0], [x1, y1], [x0, y1], color, alpha);
  }

  circle(cx, cy, r, color, alpha = 1) {
    const k = this.ss;
    for (let y = Math.max(0, Math.floor((cy - r) * k)); y <= Math.min(this.n - 1, Math.ceil((cy + r) * k)); y++) {
      for (let x = Math.max(0, Math.floor((cx - r) * k)); x <= Math.min(this.n - 1, Math.ceil((cx + r) * k)); x++) {
        if (Math.hypot((x + 0.5) / k - cx, (y + 0.5) / k - cy) <= r) this.blend((y * this.n + x) * 3, color, alpha);
      }
    }
  }

  /** Box-filter down to the output size and encode an RGB PNG. */
  png() {
    const { size, ss, n, px } = this;
    const raw = Buffer.alloc(size * (size * 3 + 1));
    const norm = 255 / (ss * ss);
    for (let y = 0; y < size; y++) {
      const row = y * (size * 3 + 1);
      for (let x = 0; x < size; x++) {
        for (let ch = 0; ch < 3; ch++) {
          let sum = 0;
          for (let sy = 0; sy < ss; sy++) {
            for (let sx = 0; sx < ss; sx++) sum += clamp01(px[((y * ss + sy) * n + x * ss + sx) * 3 + ch]);
          }
          raw[row + 1 + x * 3 + ch] = Math.round(sum * norm);
        }
      }
    }
    return encodePng(size, size, raw, 2);
  }
}

// ---- The fish number: a 5x7 bitmap font, '#' and digits only

const GLYPHS = {
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
};

/** "#0042": at least four digits, more when needed (nft-meta.mjs formatSerial). */
const serialText = (serial) => `#${String(serial).padStart(4, '0')}`;

/** Draw `str` (digits and '#') right-aligned at `right`, glyph tops at `top`, `cell` px per font pixel. */
function bitmapText(r, str, right, top, cell, color, alpha) {
  const advance = 6 * cell;
  let x = right - (str.length * advance - cell);
  for (const ch of str) {
    const rows = GLYPHS[ch];
    if (rows) {
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (rows[gy][gx] === '#') r.rect(x + gx * cell, top + gy * cell, x + (gx + 1) * cell, top + (gy + 1) * cell, color, alpha);
        }
      }
    }
    x += advance;
  }
}

// ---- The fish mesh (fish.ts buildFishMesh), as coloured triangles in model space

function fishMesh(look, profile) {
  const shape = ARCHETYPES[look.archetype] ?? ARCHETYPES.perch;
  const L = shape.len;
  const { hue, sat, light, accentHue, stripes } = look;
  const body = hsl(hue, sat, light);
  const back = hsl(hue, sat, light * 0.7);
  const belly = hsl(hue, sat * 0.5, Math.min(0.92, light * 1.45));
  const accent = hsl(accentHue, Math.min(1, sat + 0.2), 0.55);
  const fin = hsl(hue + 15, sat, light * 0.85);
  const tris = [];
  const tri = (a, b, c, color) => tris.push({ v: [a, b, c], color });

  const RINGS = 6;
  const SIDES = 6;
  const rings = [];
  for (let i = 0; i <= RINGS; i++) {
    const t = i / RINGS;
    const x = -L / 2 + t * L;
    const base = Math.sin(Math.PI * Math.pow(t, 0.75)) * 0.92 + 0.08;
    const taper = lerp(profile.tailTaper, 1, Math.min(1, t / 0.35));
    const head = t < 0.58 ? 1 : lerp(1, profile.headVolume, (t - 0.58) / 0.42);
    const ring = [];
    for (let j = 0; j < SIDES; j++) {
      const a = (j / SIDES) * Math.PI * 2 + Math.PI / 2;
      ring.push([
        x,
        Math.sin(a) * shape.height * 0.5 * base * taper * head,
        Math.cos(a) * shape.width * profile.bodyWidth * 0.5 * base * taper * head,
      ]);
    }
    rings.push(ring);
  }
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SIDES; j++) {
      const a = rings[i][j];
      const b = rings[i][(j + 1) % SIDES];
      const c = rings[i + 1][(j + 1) % SIDES];
      const d = rings[i + 1][j];
      const midY = (a[1] + b[1] + c[1] + d[1]) / 4;
      let color = midY > shape.height * 0.12 ? back : midY < -shape.height * 0.12 ? belly : body;
      const t = (i + 0.5) / RINGS;
      const upper = midY > -shape.height * 0.2;
      const patterned =
        profile.pattern === 'stripes'
          ? stripes > 0 && i > 0 && i < RINGS - 1 && i % 2 === stripes % 2
          : profile.pattern === 'spots'
            ? upper && (i * 7 + j * 3 + Math.floor(hue)) % 11 < 3
            : profile.pattern === 'mask'
              ? upper && t > 0.64
              : profile.pattern === 'glow'
                ? upper && (i + j) % 3 === 0
                : false;
      if (patterned) color = accent;
      tri(a, c, b, color);
      tri(a, d, c, color);
    }
  }
  const nose = [L / 2 + 0.06, 0, 0];
  const root = [-L / 2, 0, 0];
  for (let j = 0; j < SIDES; j++) {
    tri(rings[RINGS][j], rings[RINGS][(j + 1) % SIDES], nose, body);
    tri(rings[0][(j + 1) % SIDES], rings[0][j], root, back);
  }
  const dorsalBase = rings[3][0][1];
  const dorsalColor = profile.pattern === 'stripes' ? accent : fin;
  tri([-L * 0.15, dorsalBase - 0.02, 0], [L * 0.2, dorsalBase - 0.02, 0], [-L * 0.12, dorsalBase + shape.dorsal * profile.dorsal, 0], dorsalColor);
  for (const side of [1, -1]) {
    const w = shape.width * 0.45;
    tri([L * 0.15, -shape.height * 0.1, side * w], [0, -shape.height * 0.25, side * (w + 0.22 * profile.pectoral)], [-L * 0.05, -shape.height * 0.05, side * w], fin);
  }
  // Tail: its own pivot at the tail root, wagged 0.25 rad as on the card.
  const tl = shape.tail * profile.tailSpread;
  const spread = tl * (0.7 + profile.tailSpread * 0.08);
  const wag = (p) => [-L / 2 + 0.02 + p[0] * Math.cos(0.25) + p[2] * Math.sin(0.25), p[1], -p[0] * Math.sin(0.25) + p[2] * Math.cos(0.25)];
  const tailColor = profile.pattern === 'stripes' || profile.pattern === 'mask' ? accent : fin;
  const [t0, tUp, tMid, tDown] = [[0, 0, 0], [-tl, spread, 0], [-tl * 0.6, 0, 0], [-tl, -spread, 0]].map(wag);
  tri(t0, tMid, tUp, tailColor);
  tri(t0, tDown, tMid, tailColor);
  const eye = { at: [L * 0.33, shape.height * 0.1, shape.width * 0.33], r: Math.max(0.05, shape.height * 0.09) };
  return { tris, eye };
}

// Pose (portrait.ts: rotation (0, -0.55, 0.08), Euler XYZ) and a camera up and to the right.
function pose(p) {
  const [cz, sz, cy, sy] = [Math.cos(0.08), Math.sin(0.08), Math.cos(-0.55), Math.sin(-0.55)];
  const x1 = p[0] * cz - p[1] * sz;
  const y1 = p[0] * sz + p[1] * cz;
  return [x1 * cy + p[2] * sy, y1, -x1 * sy + p[2] * cy];
}
const VIEW_Z = norm([0.25, 0.18, 1]); // towards the camera
const VIEW_X = norm(cross([0, 1, 0], VIEW_Z));
const VIEW_Y = cross(VIEW_Z, VIEW_X);
const KEY = norm([2, 3, 4]);
const RIM = norm([-3, 1, -2]);
const RIM_COLOR = hex('#9fe8ff');
const SKY = [1, 1, 1];
const GROUND = hex('#33415c');

/**
 * 512x512 PNG card for a fish. `look` is { archetype, hue, sat, light, accentHue, stripes } as in
 * FishSpec (sat and light 0..1); `seed` is the fish seed (the shards on the in-game card); `serial`,
 * when set, is the fish's number, drawn small in the bottom-right corner.
 */
export function renderFishPng({ rarity, species, seed, look, serial }, size = 512) {
  const S = 512; // design space; the raster scales it to `size`
  const k = size / S;
  const r = new Raster(size, 2);
  const rc = hex((RARITIES[rarity] ?? RARITIES.common).color);
  const mid = hex('#0d2a44');
  const deep = hex('#050d1c');
  // Rarity glow fading to the deep sea, as portrait.ts's radial gradient.
  r.shade((x, y) => {
    const t = clamp01((Math.hypot(x / k - S / 2, y / k - S * 0.42) - 20) / (S * 0.75 - 20));
    return t < 0.55 ? rc.map((c, i) => lerp(c, mid[i], t / 0.55)) : mid.map((c, i) => lerp(c, deep[i], (t - 0.55) / 0.45));
  });
  // Shards, from the same LCG and seed as the in-game card.
  let s = seed >>> 0;
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 26; i++) {
    const alpha = 0.02 + rand() * 0.05;
    const cx = rand() * S;
    const cy = rand() * S;
    const rr = 30 + rand() * 90;
    const pts = [0, 1, 2].map(() => {
      const a = rand() * Math.PI * 2;
      return [(cx + Math.cos(a) * rr) * k, (cy + Math.sin(a) * rr) * k];
    });
    r.tri(...pts, [1, 1, 1], alpha);
  }

  // The fish: posed, projected, painted back to front with flat shading.
  const profile = profileOf(species);
  const { tris, eye } = fishMesh(look, profile);
  const emissive = Math.max((RARITIES[rarity] ?? RARITIES.common).emissive, profile.pattern === 'glow' ? 0.18 : 0);
  const glow = hsl(look.hue, 1, 0.5).map((c) => c * emissive * 0.6);
  const faces = tris.map(({ v, color }) => {
    const w = v.map(pose);
    let n = norm(cross(sub(w[1], w[0]), sub(w[2], w[0])));
    if (dot(n, VIEW_Z) < 0) n = n.map((c) => -c); // double-sided, lit from the side we see
    const hemi = SKY.map((c, i) => lerp(GROUND[i], c, n[1] * 0.5 + 0.5));
    const key = Math.max(0, dot(n, KEY));
    const rim = Math.max(0, dot(n, RIM));
    const lit = color.map((c, i) => c * (hemi[i] * 0.55 + key * 0.75) + RIM_COLOR[i] * rim * 0.12 + glow[i]);
    return { w, lit, depth: (dot(w[0], VIEW_Z) + dot(w[1], VIEW_Z) + dot(w[2], VIEW_Z)) / 3 };
  });
  const project = (p) => [dot(p, VIEW_X), -dot(p, VIEW_Y)];
  const flat = faces.flatMap((f) => f.w.map(project));
  const xs = flat.map((p) => p[0]);
  const ys = flat.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = (360 / Math.max(maxX - minX, (maxY - minY) * 1.15)) * k;
  const ox = (S / 2) * k - ((minX + maxX) / 2) * scale;
  const oy = 246 * k - ((minY + maxY) / 2) * scale;
  const screen = (p) => {
    const [x, y] = project(p);
    return [ox + x * scale, oy + y * scale];
  };
  faces.sort((a, b) => a.depth - b.depth);
  for (const f of faces) r.tri(...f.w.map(screen), f.lit);
  const [ex, ey] = screen(pose(eye.at));
  r.circle(ex, ey, eye.r * scale * 0.9, hex('#0b0b12'));
  r.circle(ex - eye.r * scale * 0.3, ey - eye.r * scale * 0.3, eye.r * scale * 0.28, [1, 1, 1], 0.8);

  // Rarity pips along the bottom, then the border.
  const pips = Math.max(1, Object.keys(RARITIES).indexOf(rarity) + 1);
  for (let i = 0; i < pips; i++) {
    const cx = (S / 2 + (i - (pips - 1) / 2) * 26) * k;
    const cy = (S - 34) * k;
    const d = 8 * k;
    r.tri([cx, cy - d], [cx + d, cy], [cx, cy + d], rc);
    r.tri([cx, cy - d], [cx, cy + d], [cx - d, cy], rc);
  }
  // The number, level with the pips. Nine digits (#999999999) still clear six pips.
  if (serial !== undefined) {
    const cell = 2.5 * k;
    const text = serialText(serial);
    const right = (S - 22) * k;
    const top = (S - 34) * k - 3.5 * cell;
    bitmapText(r, text, right + cell * 0.6, top + cell * 0.6, cell, [0, 0, 0], 0.45); // drop shadow
    bitmapText(r, text, right, top, cell, [1, 1, 1], 0.82);
  }
  const b = 6 * k;
  r.rect(0, 0, size, b, rc);
  r.rect(0, size - b, size, size, rc);
  r.rect(0, 0, b, size, rc);
  r.rect(size - b, 0, size, size, rc);
  return r.png();
}
