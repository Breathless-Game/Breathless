// Title screen: a rope swings in from the left and catches on the right, then
// fish drop onto it on fishing lines. The labeled fish are the menu buttons.
// Plain 2D Verlet physics on a canvas overlay; the 3D sea keeps rendering behind.

import { RARITY, rollFish, type Rarity } from './fish';

// The title fish were picked by look under the old Abyss drop table. Keep rolling
// them with it so retuning the in-game odds (depth-odds.ts) doesn't reshape them.
const TITLE_ODDS: [Rarity, number][] = [['uncommon', 10], ['rare', 30], ['epic', 35], ['legendary', 19], ['mythic', 6]];
import { fishSprite } from './portrait';

export interface TitleFish {
  seed: number;
  rarity: Rarity;
  hue: number;
  sat: number;
  light: number;
  /** Where it hangs along the rope, 0..1. */
  at: number;
  label?: string;
  onClick?: () => void;
}

interface P {
  x: number;
  y: number;
  px: number;
  py: number;
  inv: number; // 0 = pinned or held
}

// `slack` links only resist stretching (fishing line); the rest are rigid.
interface Link {
  a: number;
  b: number;
  len: number;
  slack: boolean;
}

// Nose and tail tip in sprite pixels, so the drawn fish lines up with its particles.
interface SpriteFit {
  nx: number;
  ny: number;
  tx: number;
  ty: number;
}

interface Hanging {
  def: TitleFish;
  img: HTMLImageElement;
  fit: SpriteFit | null;
  attach: number;
  head: number;
  tail: number;
  len: number;
  lineLen: number;
  dropAt: number;
  links: Link[];
  dropped: boolean;
}

const GRAVITY = 2200; // px/s²
const STEP = 1 / 120;
const ITERATIONS = 14;
const DAMPING = 0.995;
const ROPE_SEGS = 30;
const ROPE_SLACK = 1.035;
const LINE_SEGS = 5;
const SWING_S = 1.15;
const FIRST_DROP_S = 1.35;
const DROP_GAP_S = 0.28;
const CLICK_MOVE_PX = 8;
const CLICK_MS = 450;

const SPRITE_PX = 256;

/** The render is a 3/4 view with padding: find the rightmost (nose) and leftmost (tail) opaque pixels. */
function fitSprite(img: HTMLImageElement): SpriteFit {
  const cv = document.createElement('canvas');
  cv.width = cv.height = SPRITE_PX;
  const cx = cv.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(img, 0, 0, SPRITE_PX, SPRITE_PX);
  const a = cx.getImageData(0, 0, SPRITE_PX, SPRITE_PX).data;
  const rowsAt = (x: number) => {
    const ys: number[] = [];
    for (let y = 0; y < SPRITE_PX; y++) if (a[(y * SPRITE_PX + x) * 4 + 3] > 60) ys.push(y);
    return ys;
  };
  let minX = 0;
  let maxX = SPRITE_PX - 1;
  while (minX < maxX && !rowsAt(minX).length) minX++;
  while (maxX > minX && !rowsAt(maxX).length) maxX--;
  const mid = (ys: number[]) => (ys.length ? (ys[0] + ys[ys.length - 1]) / 2 : SPRITE_PX / 2);
  return { nx: maxX, ny: mid(rowsAt(maxX)), tx: minX, ty: mid(rowsAt(minX)) };
}

const easeOutBack = (u: number) => {
  const c1 = 1.4;
  return 1 + (c1 + 1) * (u - 1) ** 3 + c1 * (u - 1) ** 2;
};

export class TitleScreen {
  private ctx: CanvasRenderingContext2D;
  private ps: P[] = [];
  private ropeLinks: Link[] = [];
  private fish: Hanging[] = [];
  private w = 0;
  private h = 0;
  private ax = 0;
  private ay = 0;
  private bx = 0;
  private by = 0;
  private t = 0;
  private swinging = false;
  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = false;

  private pointer = { x: -1e4, y: -1e4, vx: 0, vy: 0, t: 0 };
  private held: { i: number; inv: number } | null = null;
  private press: { fish: Hanging | null; x: number; y: number; t: number } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    defs: TitleFish[],
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.fish = defs.map((def, i) => {
      const img = new Image();
      const base = rollFish(def.seed, 40, TITLE_ODDS);
      const f: Hanging = {
        def,
        img,
        fit: null,
        attach: 0,
        head: 0,
        tail: 0,
        len: 0,
        lineLen: 0,
        dropAt: FIRST_DROP_S + i * DROP_GAP_S,
        links: [],
        dropped: false,
      };
      img.onload = () => (f.fit = fitSprite(img));
      img.src = fishSprite({ ...base, rarity: def.rarity, hue: def.hue, sat: def.sat, light: def.light }, SPRITE_PX);
      return f;
    });
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('resize', () => this.running && this.build(false));
  }

  get visible() {
    return this.running;
  }

  /** intro: replay the rope swing and the fish drop; otherwise start settled. */
  show(intro: boolean) {
    this.canvas.parentElement!.classList.remove('hidden');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.build(intro && !reduced);
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.frame(Math.min((now - this.last) / 1000, 0.05));
      this.last = now;
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  hide() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.held = null;
    this.press = null;
    this.canvas.parentElement!.classList.add('hidden');
  }

  // ---- Setup ------------------------------------------------------------

  private build(intro: boolean) {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.ax = this.w * 0.05;
    this.bx = this.w * 0.95;
    this.ay = this.by = Math.max(56, this.h * 0.1);
    const span = this.bx - this.ax;
    const seg = (span * ROPE_SLACK) / ROPE_SEGS;
    this.ps = [];
    this.ropeLinks = [];
    this.held = null;

    // Intro: the free end starts hanging down-left of the anchor, then swings over.
    const endX = intro ? this.ax + span * Math.sin(-0.35) : this.bx;
    const endY = intro ? this.ay + span * Math.cos(-0.35) : this.by;
    for (let i = 0; i <= ROPE_SEGS; i++) {
      const u = i / ROPE_SEGS;
      const x = this.ax + (endX - this.ax) * u;
      const y = this.ay + (endY - this.ay) * u + (intro ? 0 : Math.sin(u * Math.PI) * span * 0.12);
      this.ps.push({ x, y, px: x, py: y, inv: i === 0 || i === ROPE_SEGS ? 0 : 1 });
      if (i) this.ropeLinks.push({ a: i - 1, b: i, len: seg, slack: false });
    }
    this.swinging = intro;
    this.t = 0;
    this.acc = 0;

    const unit = Math.min(this.w, this.h);
    this.fish.forEach((f, k) => {
      f.len = Math.max(80, Math.min(180, unit * 0.19)) * (f.def.label ? 1.1 : 0.85);
      f.lineLen = this.h * (0.05 + 0.03 * ((k * 7) % 3));
      f.attach = Math.round(f.def.at * ROPE_SEGS);
      f.dropped = false;
      f.links = [];
      if (!intro) this.drop(f, true);
    });
  }

  /** Adds the fish's line + body particles. settled: already hanging; else falls from above. */
  private drop(f: Hanging, settled: boolean) {
    const anchor = this.ps[f.attach];
    const x = anchor.x + (settled ? 0 : (Math.random() - 0.5) * 60);
    const headY = settled ? anchor.y + f.lineLen : -f.len - 40;
    // Unsettled: tail above the head, so the fish flips over as the line catches it.
    const tailY = settled ? headY + f.len : headY - f.len * 0.9;
    const add = (px: number, py: number) => {
      this.ps.push({ x: px, y: py, px: px - (settled ? 0 : (Math.random() - 0.5) * 6), py, inv: 1 });
      return this.ps.length - 1;
    };
    let prev = f.attach;
    for (let i = 1; i <= LINE_SEGS; i++) {
      const y = settled ? anchor.y + (f.lineLen * i) / LINE_SEGS : headY;
      const idx = add(x, y);
      f.links.push({ a: prev, b: idx, len: f.lineLen / LINE_SEGS, slack: true });
      prev = idx;
    }
    f.head = prev;
    f.tail = add(x + 4, tailY);
    f.links.push({ a: f.head, b: f.tail, len: f.len, slack: false });
    f.dropped = true;
  }

  // ---- Physics ----------------------------------------------------------

  private frame(dt: number) {
    this.acc += dt;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this.step();
    }
    this.draw();
  }

  private step() {
    this.t += STEP;
    if (this.swinging) {
      const end = this.ps[ROPE_SEGS];
      const u = Math.min(1, this.t / SWING_S);
      const th = -0.35 + (Math.PI / 2 + 0.35) * easeOutBack(u);
      const span = this.bx - this.ax;
      end.px = end.x;
      end.py = end.y;
      end.x = this.ax + span * Math.sin(th);
      end.y = this.ay + span * Math.cos(th);
      if (u >= 1) this.swinging = false;
    }
    for (const f of this.fish) if (!f.dropped && this.t >= f.dropAt) this.drop(f, false);

    if (this.held) {
      const p = this.ps[this.held.i];
      p.px = p.x;
      p.py = p.y;
      p.x = this.pointer.x;
      p.y = this.pointer.y;
    }

    const g = GRAVITY * STEP * STEP;
    for (const p of this.ps) {
      if (!p.inv) continue;
      const vx = (p.x - p.px) * DAMPING;
      const vy = (p.y - p.py) * DAMPING;
      p.px = p.x;
      p.py = p.y;
      p.x += vx;
      p.y += vy + g;
    }

    for (let k = 0; k < ITERATIONS; k++) {
      for (const l of this.ropeLinks) this.solve(l);
      for (const f of this.fish) for (const l of f.links) this.solve(l);
    }
  }

  private solve(l: Link) {
    const a = this.ps[l.a];
    const b = this.ps[l.b];
    const w = a.inv + b.inv;
    if (!w) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    if (l.slack && d <= l.len) return;
    const k = (d - l.len) / d;
    a.x += dx * k * (a.inv / w);
    a.y += dy * k * (a.inv / w);
    b.x -= dx * k * (b.inv / w);
    b.y -= dy * k * (b.inv / w);
  }

  // ---- Pointer ----------------------------------------------------------

  /** Fish under the pointer (distance to its body axis), nearest first. */
  private fishAt(x: number, y: number): { f: Hanging; u: number } | null {
    let best: { f: Hanging; u: number } | null = null;
    let bestD = Infinity;
    for (const f of this.fish) {
      if (!f.dropped) continue;
      const h = this.ps[f.head];
      const t = this.ps[f.tail];
      const dx = t.x - h.x;
      const dy = t.y - h.y;
      const u = Math.max(0, Math.min(1, ((x - h.x) * dx + (y - h.y) * dy) / (dx * dx + dy * dy)));
      const d = Math.hypot(x - (h.x + dx * u), y - (h.y + dy * u));
      if (d < f.len * 0.3 && d < bestD) {
        bestD = d;
        best = { f, u };
      }
    }
    return best;
  }

  private ropeAt(x: number, y: number): number | null {
    let best: number | null = null;
    let bestD = 22;
    for (let i = 1; i < ROPE_SEGS; i++) {
      const d = Math.hypot(this.ps[i].x - x, this.ps[i].y - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private onDown(e: PointerEvent) {
    this.trackPointer(e);
    const hit = this.fishAt(e.clientX, e.clientY);
    const i = hit ? (hit.u < 0.5 ? hit.f.head : hit.f.tail) : this.ropeAt(e.clientX, e.clientY);
    this.press = { fish: hit?.f ?? null, x: e.clientX, y: e.clientY, t: performance.now() };
    if (i == null || this.swinging) return;
    this.held = { i, inv: this.ps[i].inv };
    this.ps[i].inv = 0;
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = 'grabbing';
  }

  private onMove(e: PointerEvent) {
    if (!this.running) return;
    this.trackPointer(e);
    if (this.held) return;
    // A passing cursor shoves whatever it brushes past.
    const { x, y, vx, vy } = this.pointer;
    const push = (p: P) => {
      if (!p.inv) return;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d > 70) return;
      const s = (1 - d / 70) * 0.35 * STEP;
      p.px -= Math.max(-3000, Math.min(3000, vx)) * s;
      p.py -= Math.max(-3000, Math.min(3000, vy)) * s;
    };
    for (const f of this.fish) if (f.dropped) [f.head, f.tail].forEach((i) => push(this.ps[i]));
    for (let i = 1; i < ROPE_SEGS; i++) push(this.ps[i]);
    const hit = this.fishAt(x, y);
    this.canvas.style.cursor = hit?.f.def.onClick ? 'pointer' : hit || this.ropeAt(x, y) != null ? 'grab' : '';
  }

  private onUp(e: PointerEvent) {
    if (!this.running) return;
    this.trackPointer(e);
    if (this.held) {
      // Let go with the pointer's velocity, so fish can be thrown.
      const p = this.ps[this.held.i];
      p.inv = this.held.inv;
      p.px = p.x - this.pointer.vx * STEP;
      p.py = p.y - this.pointer.vy * STEP;
      this.held = null;
      this.canvas.style.cursor = '';
    }
    const press = this.press;
    this.press = null;
    if (!press?.fish?.def.onClick) return;
    const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
    if (moved < CLICK_MOVE_PX && performance.now() - press.t < CLICK_MS && this.fishAt(e.clientX, e.clientY)?.f === press.fish) {
      press.fish.def.onClick();
    }
  }

  private trackPointer(e: PointerEvent) {
    const now = performance.now();
    const dt = Math.max(1, now - this.pointer.t) / 1000;
    if (this.pointer.t && dt < 0.1) {
      // Smoothed so a single jittery event doesn't fling things.
      this.pointer.vx = this.pointer.vx * 0.5 + ((e.clientX - this.pointer.x) / dt) * 0.5;
      this.pointer.vy = this.pointer.vy * 0.5 + ((e.clientY - this.pointer.y) / dt) * 0.5;
    } else {
      this.pointer.vx = this.pointer.vy = 0;
    }
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.pointer.t = now;
  }

  // ---- Drawing ----------------------------------------------------------

  private draw() {
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);

    // Fishing lines behind everything.
    c.strokeStyle = 'rgba(234, 248, 255, 0.6)';
    c.lineWidth = 1.4;
    for (const f of this.fish) {
      if (!f.dropped) continue;
      c.beginPath();
      c.moveTo(this.ps[f.attach].x, this.ps[f.attach].y);
      for (const l of f.links) if (l.slack) c.lineTo(this.ps[l.b].x, this.ps[l.b].y);
      c.stroke();
    }

    this.drawRope();
    for (const f of this.fish) if (f.dropped) this.drawFish(f);
  }

  private drawRope() {
    const c = this.ctx;
    const path = () => {
      c.beginPath();
      c.moveTo(this.ps[0].x, this.ps[0].y);
      for (let i = 1; i < ROPE_SEGS; i++) {
        const p = this.ps[i];
        const n = this.ps[i + 1];
        c.quadraticCurveTo(p.x, p.y, (p.x + n.x) / 2, (p.y + n.y) / 2);
      }
      c.lineTo(this.ps[ROPE_SEGS].x, this.ps[ROPE_SEGS].y);
    };
    c.lineCap = 'round';
    path();
    c.strokeStyle = 'rgba(30, 18, 6, 0.55)';
    c.lineWidth = 8;
    c.stroke();
    c.strokeStyle = '#d9b47c';
    c.lineWidth = 5;
    c.stroke();
    // Twist: a dashed highlight reads as braided rope.
    c.setLineDash([7, 7]);
    c.strokeStyle = 'rgba(255, 240, 210, 0.7)';
    c.lineWidth = 2;
    c.stroke();
    c.setLineDash([]);

    const peg = (x: number, y: number) => {
      c.beginPath();
      c.arc(x, y, 8, 0, Math.PI * 2);
      c.fillStyle = '#8a6a3e';
      c.fill();
      c.strokeStyle = '#2b1d0c';
      c.lineWidth = 2;
      c.stroke();
    };
    peg(this.ax, this.ay);
    if (!this.swinging) peg(this.bx, this.by);
  }

  private drawFish(f: Hanging) {
    const c = this.ctx;
    const h = this.ps[f.head];
    const t = this.ps[f.tail];
    const angle = Math.atan2(h.y - t.y, h.x - t.x);
    const mx = (h.x + t.x) / 2;
    const my = (h.y + t.y) / 2;
    const color = RARITY[f.def.rarity].color;

    const fit = f.fit;
    if (fit) {
      // Map the sprite's tail->nose vector onto the tail->head particles.
      const sv = Math.atan2(fit.ny - fit.ty, fit.nx - fit.tx);
      const scale = f.len / Math.hypot(fit.nx - fit.tx, fit.ny - fit.ty);
      c.save();
      c.translate(t.x, t.y);
      c.rotate(angle - sv);
      c.scale(scale, scale);
      if (f.def.label) {
        c.shadowColor = color;
        c.shadowBlur = 26 / scale;
      }
      c.drawImage(f.img, -fit.tx, -fit.ty);
      c.restore();
    }

    // Hook in the fish's mouth.
    c.beginPath();
    c.arc(h.x, h.y + 3, 3.5, Math.PI * 1.1, Math.PI * 0.1, true);
    c.strokeStyle = '#cfd8dc';
    c.lineWidth = 1.6;
    c.stroke();

    if (!f.def.label) return;
    // Label stays nearly upright, tilting with the swing.
    c.save();
    c.translate(mx, my);
    c.rotate(angle + Math.PI / 2);
    c.font = '900 17px Inter, system-ui, sans-serif';
    c.letterSpacing = '0.12em';
    const tw = c.measureText(f.def.label).width;
    const pw = tw + 26;
    const ph = 32;
    c.beginPath();
    c.roundRect(-pw / 2, -ph / 2, pw, ph, 16);
    c.fillStyle = 'rgba(4, 18, 34, 0.82)';
    c.fill();
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.stroke();
    c.fillStyle = color;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(f.def.label, 0, 1);
    c.restore();
  }
}
