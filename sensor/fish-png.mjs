// The NFT art for a fish, rendered on the server for /api/nft (nft-meta.mjs). Node has no WebGL,
// so this is a small software rasteriser. The fish itself is not a copy: its triangles, pose,
// camera and lighting come from the game's own code (game/src/fish-card-geometry.ts, bundled into
// fish-card.gen.mjs), the same code portrait.ts fishCard draws in the game. Around it: the rarity
// gradient, the seeded shards, the rarity border. No font rasteriser here, so the only text is the
// fish's number (#0042), drawn from a tiny bitmap font; the wallet shows the name anyway.
import { encodePng } from './pearl-png.mjs';
import { CARD_FISH, CARD_RENDER_VERSION, cardGeometry, cardSpec } from './fish-card.gen.mjs';

export { CARD_RENDER_VERSION };

// ---- Mirrors of game/src/fish.ts (labels, colours and archetype names only).

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

// ---- Colour and vector helpers

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
/** Linear light to sRGB, as the game's WebGL renderer writes its output. */
const srgb = (c) => (c <= 0.0031308 ? 12.92 * Math.max(0, c) : 1.055 * Math.pow(Math.min(1, c), 1 / 2.4) - 0.055);

// ---- A supersampled RGB raster with alpha-blended fills

class Raster {
  constructor(size, ss) {
    this.size = size;
    this.ss = ss;
    this.n = size * ss;
    this.px = new Float32Array(this.n * this.n * 3);
    this.z = null;
  }

  /** An opaque triangle, depth tested: `a`, `b`, `c` are [x, y, ndcDepth]; nearer wins. */
  triZ(a, b, c, color) {
    if (!this.z) this.z = new Float32Array(this.n * this.n).fill(Infinity);
    const k = this.ss;
    const [ax, ay, bx, by, cx, cy] = [a[0] * k, a[1] * k, b[0] * k, b[1] * k, c[0] * k, c[1] * k];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) return;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(this.n - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(this.n - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const w0 = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) / area;
        const w1 = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const depth = w0 * a[2] + w1 * b[2] + w2 * c[2];
        const i = y * this.n + x;
        if (depth >= this.z[i]) continue;
        this.z[i] = depth;
        this.px[i * 3] = color[0];
        this.px[i * 3 + 1] = color[1];
        this.px[i * 3 + 2] = color[2];
      }
    }
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

/** The spec the card's fish is built from, from the image URL's facts (the game rounds the same way). */
export const cardSpecFor = ({ id, rarity, species, look }) => cardSpec({ id, rarity, species, ...look });

/**
 * 512x512 PNG card for a fish. `id` is the fish id (its seed in hex: the shards and the fish's
 * grain), `look` is { archetype, hue, sat, light, accentHue, stripes } as in FishSpec (sat and light
 * 0..1); `serial`, when set, is the fish's number, drawn small in the bottom-right corner.
 */
export function renderFishPng({ id, rarity, species, look, serial }, size = 512) {
  const spec = cardSpecFor({ id, rarity, species, look });
  const seed = spec.seed;
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

  // The fish, where the game's card draws its 420px render: the game's triangles, depth tested.
  const box = CARD_FISH.size * k;
  const at = (f, i) => [CARD_FISH.x * k + f.p[i] * box, CARD_FISH.y * k + f.p[i + 1] * box, f.p[i + 2]];
  for (const f of cardGeometry(spec)) r.triZ(at(f, 0), at(f, 3), at(f, 6), f.rgb.map(srgb));

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
