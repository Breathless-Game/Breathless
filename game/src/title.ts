// Title screen: a rope (anchored off-screen) swings in from the left and catches
// on the right, then fish drop onto it on fishing lines. The labeled fish are the
// menu buttons, with their name printed on the body; a long name hangs its fish
// level on two lines (head and tail) so the name reads straight.
// Plain 2D Verlet physics on a canvas overlay; the 3D sea keeps rendering behind.

import { RARITY, rollFish, ZONES, type Archetype, type Rarity } from './fish';
import { fishSprite } from './portrait';

export interface TitleFish {
  seed: number;
  rarity: Rarity;
  hue: number;
  sat: number;
  light: number;
  /** Body shape override; a deep body leaves room for a printed name. */
  archetype?: Archetype;
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

// Nose and tail ends of the body axis in sprite pixels, so the drawn fish lines
// up with its particles; `c` is where the body's centre of mass sits along it (0..1).
interface SpriteFit {
  nx: number;
  ny: number;
  tx: number;
  ty: number;
  c: number;
}

interface Line {
  attach: number; // rope particle
  pts: number[];
  end: number; // head or tail particle
  links: Link[];
}

interface Hanging {
  def: TitleFish;
  img: HTMLImageElement;
  fit: SpriteFit | null;
  sideways: boolean;
  lines: Line[];
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
const ROPE_SEGS = 36;
const SIDEWAYS_CHARS = 4; // names this long hang their fish level, on two lines
const BODY_CENTRE = 0.56; // along tail->nose, where the printed name goes (until the sprite is measured)
const LEVEL_RATE = 0.006; // how fast a sideways fish's lines even out its tilt
const MIN_LINE_SEG = 2;
const ROPE_SLACK = 1.035;
const LINE_SEGS = 5;
const SWING_S = 1.15;
const FIRST_DROP_S = 1.35;
const DROP_GAP_S = 0.28;
const PAN_FRAC = 0.09; // how far the rope rides up when the camera pans down to the workbench
const CLICK_MOVE_PX = 8;
const CLICK_MS = 450;

const SPRITE_PX = 256;

/**
 * The render is a tilted 3/4 view with padding. Take the body axis as the principal
 * axis of the opaque pixels (tip-to-tip would follow the tail fin and tilt the fish),
 * nose toward +x, and its ends at the extreme projections.
 */
function fitSprite(img: HTMLImageElement): SpriteFit {
  const cv = document.createElement('canvas');
  cv.width = cv.height = SPRITE_PX;
  const cx = cv.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(img, 0, 0, SPRITE_PX, SPRITE_PX);
  const a = cx.getImageData(0, 0, SPRITE_PX, SPRITE_PX).data;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < SPRITE_PX; y += 2)
    for (let x = 0; x < SPRITE_PX; x += 2)
      if (a[(y * SPRITE_PX + x) * 4 + 3] > 60) {
        xs.push(x);
        ys.push(y);
      }
  const n = xs.length || 1;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let dx = Math.cos(th);
  let dy = Math.sin(th);
  if (dx < 0) {
    dx = -dx;
    dy = -dy;
  }
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < xs.length; i++) {
    const p = (xs[i] - mx) * dx + (ys[i] - my) * dy;
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  }
  return { nx: mx + dx * hi, ny: my + dy * hi, tx: mx + dx * lo, ty: my + dy * lo, c: -lo / (hi - lo || 1) };
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
  private seg = 0;
  private t = 0;
  private swinging = false;
  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  private panU = 0;
  private name: HTMLElement;

  private pointer = { x: -1e4, y: -1e4, vx: 0, vy: 0, t: 0 };
  private held: { i: number; inv: number } | null = null;
  private press: { fish: Hanging | null; x: number; y: number; t: number } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    defs: TitleFish[],
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.name = canvas.parentElement!.querySelector('#title-name')!;
    this.fish = defs.map((def, i) => {
      const img = new Image();
      const base = rollFish(def.seed, ZONES[2], 40);
      const f: Hanging = {
        def,
        img,
        fit: null,
        sideways: (def.label?.length ?? 0) >= SIDEWAYS_CHARS,
        lines: [],
        head: 0,
        tail: 0,
        len: 0,
        lineLen: 0,
        dropAt: FIRST_DROP_S + i * DROP_GAP_S,
        links: [],
        dropped: false,
      };
      img.onload = () => (f.fit = fitSprite(img));
      const archetype = def.archetype ?? base.archetype;
      img.src = fishSprite({ ...base, archetype, rarity: def.rarity, hue: def.hue, sat: def.sat, light: def.light }, SPRITE_PX);
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

  /**
   * The camera pans down to the workbench: 0 = the title, 1 = the rope and its
   * fish ride up to the top of the screen and the name scrolls away.
   */
  setPan(u: number) {
    this.panU = u;
    this.name.style.transform = u ? `translateY(${-u * 40}vh)` : '';
    this.name.style.opacity = u ? String(Math.max(0, 1 - u * 2.2)) : '';
  }

  private get pan() {
    return this.panU * this.h * PAN_FRAC;
  }

  /** Pointer position in rope space (the drawing is shifted up by the pan). */
  private at(e: PointerEvent) {
    return { x: e.clientX, y: e.clientY + this.pan };
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

    // Both anchors sit off-screen: the rope just runs in from one edge and out the other.
    this.ax = -this.w * 0.08;
    this.bx = this.w * 1.08;
    this.ay = this.by = Math.max(50, this.h * 0.1);
    const span = this.bx - this.ax;
    const seg = (span * ROPE_SLACK) / ROPE_SEGS;
    this.seg = seg;
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
      f.len = f.sideways ? Math.max(150, Math.min(260, unit * 0.3)) : Math.max(70, Math.min(155, unit * 0.16));
      // Sideways fish are deep-bodied: hang them low enough that their fins clear the rope.
      f.lineLen = f.sideways ? Math.max(this.h * 0.12, f.len * 0.42) : this.h * (0.05 + 0.03 * ((k * 7) % 3));
      f.dropped = false;
      f.links = [];
      f.lines = [];
      if (!intro) this.drop(f, true);
    });
  }

  /** Adds the fish's body + line particles. settled: already hanging; else falls from above. */
  private drop(f: Hanging, settled: boolean) {
    const jitter = settled ? 0 : 6;
    const centre = Math.round(f.def.at * ROPE_SEGS);
    const fallY = -f.len - 40;
    if (f.sideways) {
      // Head right, tail left, each on its own line, so the body and its name hang level.
      const half = Math.max(1, Math.round(f.len / this.seg / 2));
      const right = Math.min(ROPE_SEGS - 1, centre + half);
      const left = Math.max(1, centre - half);
      const r = this.ps[right];
      const l = this.ps[left];
      f.head = this.add(r.x, settled ? r.y + f.lineLen : fallY, jitter);
      f.tail = this.add(l.x, settled ? l.y + f.lineLen : fallY, jitter);
      this.line(f, right, f.head, settled);
      this.line(f, left, f.tail, settled);
    } else {
      const a = this.ps[centre];
      const x = a.x + (settled ? 0 : (Math.random() - 0.5) * 60);
      const headY = settled ? a.y + f.lineLen : fallY;
      f.head = this.add(x, headY, jitter);
      // Unsettled: tail above the head, so the fish flips over as the line catches it.
      f.tail = this.add(x + 4, settled ? headY + f.len : headY - f.len * 0.9, jitter);
      this.line(f, centre, f.head, settled);
    }
    f.links.push({ a: f.head, b: f.tail, len: f.len, slack: false });
    f.dropped = true;
  }

  private add(x: number, y: number, jitter: number) {
    this.ps.push({ x, y, px: x - (Math.random() - 0.5) * jitter, py: y, inv: 1 });
    return this.ps.length - 1;
  }

  /** Fishing line from rope particle `attach` down to particle `end`. Slack links: it can go limp. */
  private line(f: Hanging, attach: number, end: number, settled: boolean) {
    const a = this.ps[attach];
    const e = this.ps[end];
    const len = f.lineLen / LINE_SEGS;
    const pts: number[] = [];
    const links: Link[] = [];
    let prev = attach;
    for (let i = 1; i <= LINE_SEGS; i++) {
      const u = i / LINE_SEGS;
      // Unsettled lines start bunched at the falling fish and pay out as it drops.
      const idx = i === LINE_SEGS ? end : settled ? this.add(a.x + (e.x - a.x) * u, a.y + (e.y - a.y) * u, 0) : this.add(e.x, e.y, 0);
      links.push({ a: prev, b: idx, len, slack: true });
      if (idx !== end) pts.push(idx);
      prev = idx;
    }
    f.links.push(...links);
    f.lines.push({ attach, pts, end, links });
  }

  /**
   * Sideways fish: the two lines behave like one line over a pulley (fixed total
   * length), paying out on the high side, so the body and its name settle level
   * even where the rope slopes.
   */
  private level(f: Hanging) {
    if (f.lines.length !== 2 || this.held) return;
    const [headLine, tailLine] = f.lines;
    const err = this.ps[f.head].y - this.ps[f.tail].y; // > 0: head hangs lower
    const d = Math.max(-0.5, Math.min(0.5, err * LEVEL_RATE)) / LINE_SEGS;
    if (headLine.links[0].len - d < MIN_LINE_SEG || tailLine.links[0].len + d < MIN_LINE_SEG) return;
    for (const l of headLine.links) l.len -= d;
    for (const l of tailLine.links) l.len += d;
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

    for (const f of this.fish) if (f.dropped) this.level(f);
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
    const { x, y } = this.at(e);
    const hit = this.fishAt(x, y);
    const i = hit ? (hit.u < 0.5 ? hit.f.head : hit.f.tail) : this.ropeAt(x, y);
    this.press = { fish: hit?.f ?? null, x, y, t: performance.now() };
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
    const { x, y } = this.at(e);
    const moved = Math.hypot(x - press.x, y - press.y);
    if (moved < CLICK_MOVE_PX && performance.now() - press.t < CLICK_MS && this.fishAt(x, y)?.f === press.fish) {
      press.fish.def.onClick();
    }
  }

  private trackPointer(e: PointerEvent) {
    const now = performance.now();
    const dt = Math.max(1, now - this.pointer.t) / 1000;
    const { x, y } = this.at(e);
    if (this.pointer.t && dt < 0.1) {
      // Smoothed so a single jittery event doesn't fling things.
      this.pointer.vx = this.pointer.vx * 0.5 + ((x - this.pointer.x) / dt) * 0.5;
      this.pointer.vy = this.pointer.vy * 0.5 + ((y - this.pointer.y) / dt) * 0.5;
    } else {
      this.pointer.vx = this.pointer.vy = 0;
    }
    this.pointer.x = x;
    this.pointer.y = y;
    this.pointer.t = now;
  }

  // ---- Drawing ----------------------------------------------------------

  private draw() {
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);
    c.save();
    c.translate(0, -this.pan);

    // Fishing lines behind everything.
    c.strokeStyle = 'rgba(234, 248, 255, 0.6)';
    c.lineWidth = 1.4;
    for (const f of this.fish) {
      for (const line of f.lines) {
        c.beginPath();
        c.moveTo(this.ps[line.attach].x, this.ps[line.attach].y);
        for (const i of [...line.pts, line.end]) c.lineTo(this.ps[i].x, this.ps[i].y);
        c.stroke();
      }
    }

    this.drawRope();
    for (const f of this.fish) if (f.dropped) this.drawFish(f);
    c.restore();
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
  }

  private drawFish(f: Hanging) {
    const c = this.ctx;
    const h = this.ps[f.head];
    const t = this.ps[f.tail];
    const angle = Math.atan2(h.y - t.y, h.x - t.x);
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

    // A hook wherever a line meets the fish (mouth, and tail on sideways fish).
    c.strokeStyle = '#cfd8dc';
    c.lineWidth = 1.6;
    for (const line of f.lines) {
      const p = this.ps[line.end];
      c.beginPath();
      c.arc(p.x, p.y + 3, 3.5, Math.PI * 1.1, Math.PI * 0.1, true);
      c.stroke();
    }

    if (f.def.label) this.drawName(f, h, t, angle);
  }

  /** The name printed on the body, kept upright whichever way the fish swings. */
  private drawName(f: Hanging, h: P, t: P, angle: number) {
    const c = this.ctx;
    const label = f.def.label!;
    // At the body's centre of mass: a little toward the nose, since the tail fin is thin.
    const u = f.fit?.c ?? BODY_CENTRE;
    const x = t.x + (h.x - t.x) * u;
    const y = t.y + (h.y - t.y) * u;
    const upright = Math.cos(angle) < 0 ? angle + Math.PI : angle;
    c.save();
    c.translate(x, y);
    c.rotate(upright);
    let size = Math.min(30, f.len * 0.13);
    const font = () => `900 ${size.toFixed(1)}px Inter, system-ui, sans-serif`;
    c.font = font();
    c.letterSpacing = '0.08em';
    const fit = (f.len * 0.5) / c.measureText(label).width;
    if (fit < 1) {
      size *= fit;
      c.font = font();
    }
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineJoin = 'round';
    c.lineWidth = Math.max(2, size * 0.2);
    c.strokeStyle = 'rgba(8, 14, 30, 0.8)';
    c.strokeText(label, 0, 1);
    c.fillStyle = '#ffffff';
    c.fillText(label, 0, 1);
    c.restore();
  }
}
