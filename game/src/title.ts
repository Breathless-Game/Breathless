// Title screen: a rope (anchored off-screen) swings in from the left and catches
// on the right, then fish drop onto it on fishing lines. The labeled fish are the
// menu buttons, with their name carved into the body; a long name hangs its fish
// level on two lines (head and tail) so the name reads straight.
// Plain 2D Verlet physics on a canvas overlay (rope, lines, glow); the fish
// themselves are real 3D models on a layer above it (title3d.ts), placed from
// the physics every frame. The 3D sea keeps rendering behind.

import { RARITY, rollFish, speciesProfile, type Archetype, type Rarity } from './fish';
import { FishStage, type FishPose } from './title3d';

// The title fish were picked by look under the old Abyss drop table. Keep rolling
// them with it so retuning the in-game odds (depth-odds.ts) doesn't reshape them.
export const TITLE_ODDS: [Rarity, number][] = [['uncommon', 10], ['rare', 30], ['epic', 35], ['legendary', 19], ['mythic', 6]];

/** A rope other than the main one (the second, further back): where it hangs and how. */
export interface RopeOptions {
  /** Anchor height, fraction of the screen. */
  ropeY?: number;
  /** Rope length over its span: closer to 1 is tighter. */
  slack?: number;
  /** Pulled nearly straight all the time (like the main rope over a table). */
  taut?: boolean;
  /** Fishing line length, and fish size, as fractions of the main rope's. */
  lineScale?: number;
  sizeScale?: number;
  /**
   * Its canvas sits under another rope's, which takes the pointer: listen on the
   * window and take only what that one let through (not defaultPrevented). The
   * cursor is shown on `cursorOn` (that canvas).
   */
  underneath?: { cursorOn: HTMLElement };
}

export interface TitleFish {
  seed: number;
  rarity: Rarity;
  hue: number;
  sat: number;
  light: number;
  /**
   * One of the game's species (fish.ts): its own body, fins and pattern. Pick a
   * deep-bodied one for a labelled fish, to leave room for the carved name.
   */
  species?: string;
  /** Body shape override, for a fish without a species. */
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

interface Line {
  attach: number; // rope particle
  pts: number[];
  end: number; // head or tail particle
  links: Link[];
}

interface Hanging {
  def: TitleFish;
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
// While a menu fish is picked (hovered or held), everything swings much less: the
// bounce dies away about three times as fast. CALM_RATE: how quickly it eases in and out.
const CALM_DAMPING = 0.985;
const CALM_RATE = 8;
const ROPE_SEGS = 36;
const SIDEWAYS_CHARS = 4; // names this long hang their fish level, on two lines
const LEVEL_RATE = 0.006; // how fast a sideways fish's lines even out its tilt
const MIN_LINE_SEG = 2;
const ROPE_SLACK = 1.015; // rope length over its span: a shallow, fairly taut sag
const ROPE_Y = 0.045;// anchor height, fraction of the screen
const LINE_SEGS = 5;
const SWING_S = 1.15;
const FIRST_DROP_S = 1.35;
const DROP_GAP_S = 0.28;
const PAN_FRAC = 0.03; // how far the rope rides up when the camera pans down to the workbench
const LIFT_FRAC = 0.75; // how far it rides up for the aquarium: the lowest fish clears the top of the screen
// Over the workbench the rope is pulled taut, its ends lowered to this height (fraction of the screen).
// Shortening the links alone can't do it: the fish stretch a long rope into a deep sag. So each rope
// particle is also pulled toward a nearly straight line (a shallow BENCH_SAG in the middle).
const BENCH_ROPE_Y = 0.19; // high enough that the fish hang clear of the table's back edge
const BENCH_SAG = 0.025;
const BENCH_TAUT = 0.991; // rope length factor: ROPE_SLACK × this ≈ the span
const BENCH_PULL = 0.35; // per step, how far a rope particle moves toward the taut line
const BENCH_LINES = 0.4; // fishing line length over the workbench, as a fraction of the title's
const CLICK_MOVE_PX = 8;
const CLICK_MS = 450;

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
  private liftU = 0;
  private hovered: Hanging | null = null; // the menu fish under the pointer
  private calm = 0; // 0..1, eases toward 1 while a menu fish is picked
  private tableY: number | null = null; // screen y where the fish's shadows fall on the workbench table
  private name: HTMLElement;
  private cursorEl: HTMLElement;
  private cursorOurs = false;
  private stage: FishStage; // the fish as 3D models, over the rope canvas
  private hover: number[] = []; // per fish, 0..1: eased toward 1 under the pointer

  private pointer = { x: -1e4, y: -1e4, vx: 0, vy: 0, t: 0 };
  private held: { i: number; inv: number } | null = null;
  private press: { fish: Hanging | null; x: number; y: number; t: number } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    defs: TitleFish[],
    private opts: RopeOptions = {},
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.name = canvas.parentElement!.querySelector(':scope > #title-name, :scope > .title-name')!;
    this.stage = new FishStage(canvas.parentElement!.querySelector(':scope > #title-fish3d, :scope > .title-fish3d')!);
    this.cursorEl = opts.underneath?.cursorOn ?? canvas;
    this.fish = defs.map((def, i) => {
      const base = rollFish(def.seed, 40, TITLE_ODDS);
      const species = def.species ?? base.species;
      // A species brings its own body; without one, an archetype override still applies.
      const archetype = def.species ? speciesProfile({ species, archetype: base.archetype }).archetype : (def.archetype ?? base.archetype);
      this.stage.add({ ...base, species, archetype, rarity: def.rarity, hue: def.hue, sat: def.sat, light: def.light }, def.label);
      const f: Hanging = {
        def,
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
      return f;
    });
    if (opts.underneath) {
      // Whatever the rope in front let through (it runs first: it's on its canvas, we're on the window).
      window.addEventListener('pointerdown', (e) => {
        if (this.running && !e.defaultPrevented && e.target instanceof HTMLCanvasElement) this.onDown(e);
      });
    } else canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('resize', () => this.running && this.build(false));
  }

  /** A modal (the Aquarium) is up over the scene: the pointer is not ours. */
  blocked: () => boolean = () => false;

  get visible() {
    return this.running;
  }

  /**
   * The camera pans down to the workbench: 0 = the title, 1 = the rope and its
   * fish ride up to the top of the screen and the name scrolls away.
   */
  setPan(u: number, tableY: number | null = null) {
    this.panU = u;
    this.tableY = tableY;
    this.canvas.parentElement!.style.setProperty('--pan', String(u));
    this.scrollName();
  }

  /** The aquarium rises: 0 = the title, 1 = the rope and its fish lifted straight up off the screen. */
  setLift(u: number) {
    this.liftU = u;
    this.scrollName();
  }

  private scrollName() {
    const u = Math.max(this.panU, this.liftU);
    this.name.style.transform = u ? `translateY(${-u * 40}vh)` : '';
    this.name.style.opacity = u ? String(Math.max(0, 1 - u * 2.2)) : '';
  }

  /** How far the drawing is shifted up: a little for the workbench, off the screen for the aquarium. */
  private get pan() {
    return this.panU * this.h * PAN_FRAC + this.liftU * this.h * LIFT_FRAC;
  }

  /** Over the workbench the fishing lines are reeled in, so the fish hang clear of the table's gear and tray. */
  private get lineScale() {
    return 1 + (BENCH_LINES - 1) * this.panU;
  }

  /** Pointer position in rope space (the drawing is shifted up by the pan). */
  private at(e: PointerEvent) {
    return { x: e.clientX, y: e.clientY + this.pan };
  }

  /** Where menu fish i is on screen (its middle), or null while it isn't hanging there. */
  fishCenter(i: number): { x: number; y: number } | null {
    const f = this.fish[i];
    if (!this.running || !f) return null;
    if (!f.dropped) {
      // Not on its line yet (still to drop in): where it will hang, under its spot on the rope.
      const a = this.ps[Math.round(f.def.at * ROPE_SEGS)];
      return a ? { x: a.x, y: a.y + f.lineLen - this.pan } : null;
    }
    const h = this.ps[f.head];
    const t = this.ps[f.tail];
    return { x: (h.x + t.x) / 2, y: (h.y + t.y) / 2 - this.pan };
  }

  /** Something dropped into menu fish i: it bobs down on its lines and swings back. */
  bump(i: number, px = 40) {
    const f = this.fish[i];
    if (!f?.dropped) return;
    for (const n of [f.head, f.tail]) this.ps[n].py -= px * STEP * 60;
  }

  /** Renames a menu fish (index as given to the constructor): its carved name changes in place. */
  setLabel(i: number, label: string) {
    const f = this.fish[i];
    if (f.def.label === label) return;
    f.def.label = label;
    this.stage.setLabel(i, label);
  }

  /**
   * intro: replay the rope swing and the fish drop; 'drop': the rope is already up
   * and only the fish fall onto it, straight away; otherwise start settled.
   */
  show(intro: boolean | 'drop') {
    this.canvas.parentElement!.classList.remove('hidden', 'boot');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.build(reduced ? false : intro);
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
    this.hovered = null;
    this.calm = 0;
    this.stage.clear();
    this.canvas.parentElement!.classList.add('hidden');
  }

  // ---- Setup ------------------------------------------------------------

  private build(mode: boolean | 'drop') {
    const intro = mode === true; // the rope swings in
    const drop = mode !== false; // the fish fall onto it
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.stage.resize(this.w, this.h);

    // Both anchors sit off-screen: the rope just runs in from one edge and out the other.
    this.ax = -this.w * 0.08;
    this.bx = this.w * 1.08;
    this.ay = this.by = Math.max(this.opts.ropeY != null ? 12 : 40, this.h * (this.opts.ropeY ?? ROPE_Y));
    const span = this.bx - this.ax;
    const seg = (span * (this.opts.slack ?? ROPE_SLACK)) / ROPE_SEGS;
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
      const y = this.ay + (endY - this.ay) * u + (intro ? 0 : Math.sin(u * Math.PI) * span * 0.07);
      this.ps.push({ x, y, px: x, py: y, inv: i === 0 || i === ROPE_SEGS ? 0 : 1 });
      if (i) this.ropeLinks.push({ a: i - 1, b: i, len: seg, slack: false });
    }
    this.swinging = intro;
    // No swing to wait for: start the clock just before the first fish falls.
    this.t = intro ? 0 : FIRST_DROP_S - 0.05;
    this.acc = 0;

    const unit = Math.min(this.w, this.h);
    this.fish.forEach((f, k) => {
      f.len = f.sideways ? Math.max(150, Math.min(260, unit * 0.3)) : Math.max(70, Math.min(155, unit * 0.16));
      // Sideways fish are deep-bodied: hang them low enough that their fins clear the rope.
      f.lineLen = f.sideways ? Math.max(this.h * 0.12, f.len * 0.42) : this.h * (0.05 + 0.03 * ((k * 7) % 3));
      f.len *= this.opts.sizeScale ?? 1;
      f.lineLen *= this.opts.lineScale ?? 1;
      f.dropped = false;
      f.links = [];
      f.lines = [];
      if (!drop) this.drop(f, true);
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

  /**
   * Follows the workbench pan: the anchors come down to BENCH_ROPE_Y on screen
   * and the rope shortens until it runs nearly straight across. At pan 0 this is
   * exactly the title's own slack rope.
   */
  private tighten() {
    const u = this.panU;
    const y = this.ay + (this.h * BENCH_ROPE_Y + this.pan - this.ay) * u;
    this.ps[0].y = y;
    // The free end is still being swung in during the intro; leave it to the swing.
    if (!this.swinging) {
      const end = this.ps[ROPE_SEGS];
      end.x = this.bx;
      end.y = y;
    }
    const len = this.seg * (1 + (BENCH_TAUT - 1) * u);
    for (const l of this.ropeLinks) l.len = len;
  }

  // ---- Physics ----------------------------------------------------------

  private frame(dt: number) {
    this.acc += dt;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this.step();
    }
    this.draw();
    this.drawFish3d(dt);
  }

  /** The fish themselves: 3D models placed from their tail and head particles (title3d.ts). */
  private drawFish3d(dt: number) {
    const poses: (FishPose | null)[] = this.fish.map((f, i) => {
      const under = f.def.onClick && (this.hovered === f || this.held != null && this.press?.fish === f) ? 1 : 0;
      this.hover[i] = (this.hover[i] ?? 0) + (under - (this.hover[i] ?? 0)) * Math.min(1, dt * 6);
      if (!f.dropped) return null;
      const h = this.ps[f.head];
      const t = this.ps[f.tail];
      // Verlet keeps last step's position: their difference is the velocity.
      return {
        tx: t.x,
        ty: t.y - this.pan,
        hx: h.x,
        hy: h.y - this.pan,
        vx: ((h.x - h.px + t.x - t.px) / 2) / STEP,
        vy: ((h.y - h.py + t.y - t.py) / 2) / STEP,
        hover: this.hover[i],
      };
    });
    this.stage.render(poses, dt, performance.now() / 1000);
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
    this.tighten();

    if (this.held) {
      const p = this.ps[this.held.i];
      p.px = p.x;
      p.py = p.y;
      p.x = this.pointer.x;
      p.y = this.pointer.y;
    }

    const picked = this.hovered || (this.held && this.press?.fish?.def.onClick);
    this.calm += ((picked ? 1 : 0) - this.calm) * Math.min(1, CALM_RATE * STEP);
    const damping = DAMPING + (CALM_DAMPING - DAMPING) * this.calm;

    const g = GRAVITY * STEP * STEP;
    for (const p of this.ps) {
      if (!p.inv) continue;
      const vx = (p.x - p.px) * damping;
      const vy = (p.y - p.py) * damping;
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
    this.pullTaut();
  }

  /** Over the workbench: draws the rope toward a nearly straight line between its anchors. */
  private pullTaut() {
    const k = BENCH_PULL * (this.opts.taut ? 1 : this.panU); // a taut rope (the back one) is always pulled straight
    if (!k || this.swinging) return;
    const a = this.ps[0];
    const b = this.ps[ROPE_SEGS];
    for (let i = 1; i < ROPE_SEGS; i++) {
      const p = this.ps[i];
      if (!p.inv) continue; // held by the pointer
      const s = i / ROPE_SEGS;
      const y = a.y + (b.y - a.y) * s + Math.sin(s * Math.PI) * this.h * BENCH_SAG;
      p.y += (y - p.y) * k;
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
    // Fishing lines are reeled in over the workbench (see lineScale).
    const len = l.slack ? l.len * this.lineScale : l.len;
    if (l.slack && d <= len) return;
    const k = (d - len) / d;
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
    if (this.blocked()) return;
    this.trackPointer(e);
    const { x, y } = this.at(e);
    const hit = this.fishAt(x, y);
    const i = hit ? (hit.u < 0.5 ? hit.f.head : hit.f.tail) : this.ropeAt(x, y);
    this.press = { fish: hit?.f ?? null, x, y, t: performance.now() };
    if (i == null) return;
    // The fish and rope hang in front of the workbench table: claim the press so the table ignores it.
    e.preventDefault();
    if (this.swinging) return;
    this.held = { i, inv: this.ps[i].inv };
    this.ps[i].inv = 0;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {} // underneath another rope its canvas takes no pointer; the window still sees the moves
    this.setCursor('grabbing');
  }

  /** The cursor: on our canvas, or (underneath) on the front rope's, clearing it only if we set it. */
  private setCursor(c: string) {
    if (!this.opts.underneath) {
      this.canvas.style.cursor = c;
      return;
    }
    if (!c && !this.cursorOurs) return;
    this.cursorEl.style.cursor = c;
    this.cursorOurs = !!c;
  }

  private onMove(e: PointerEvent) {
    if (!this.running) return;
    if (this.blocked()) {
      if (!this.held) this.hovered = null;
      return;
    }
    this.trackPointer(e);
    if (this.held) {
      e.preventDefault(); // carrying a fish: no table tips underneath
      return;
    }
    // Underneath: the rope in front has this one (it's over its fish or rope).
    if (this.opts.underneath && e.defaultPrevented) {
      this.hovered = null;
      this.cursorOurs = false;
      return;
    }
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
    this.hovered = hit?.f.def.onClick ? hit.f : null;
    const rope = !hit && this.ropeAt(x, y) != null;
    this.setCursor(hit?.f.def.onClick ? 'pointer' : hit || rope ? 'grab' : '');
    // Hovering a fish or the rope: the workbench table behind shouldn't show its tip too.
    if (hit || rope) e.preventDefault();
  }

  private onUp(e: PointerEvent) {
    if (!this.running) return;
    if (this.blocked() && !this.held) {
      this.press = null;
      return;
    }
    this.trackPointer(e);
    if (this.held) {
      // Let go with the pointer's velocity, so fish can be thrown.
      const p = this.ps[this.held.i];
      p.inv = this.held.inv;
      p.px = p.x - this.pointer.vx * STEP;
      p.py = p.y - this.pointer.vy * STEP;
      this.held = null;
      this.setCursor('');
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
    this.drawShadows();
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

  /**
   * Over the workbench, each fish casts a soft shadow onto the table below it
   * (screen space), so it reads as hanging above the table, not just in front.
   */
  private drawShadows() {
    if (this.tableY == null || !this.panU) return;
    const c = this.ctx;
    for (const f of this.fish) {
      if (!f.dropped) continue;
      const h = this.ps[f.head];
      const t = this.ps[f.tail];
      // Just under the fish where it hangs over the table, else on the table's back.
      const bottom = Math.max(h.y, t.y) - this.pan;
      const y = Math.max(this.tableY, bottom + 18);
      // Lower fish hang nearer the table: darker, tighter shadows.
      const lift = Math.max(0, this.tableY - bottom);
      const near = Math.max(0.25, 1 - lift / (this.h * 0.4));
      const r = Math.max(Math.abs(h.x - t.x), f.len * 0.35) * (0.45 + 0.25 / near);
      const g = c.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, `rgba(20, 10, 2, ${0.55 * near * this.panU})`);
      g.addColorStop(1, 'rgba(20, 10, 2, 0)');
      c.save();
      c.translate((h.x + t.x) / 2, y);
      c.scale(1, 0.22); // flattened onto the tabletop
      c.fillStyle = g;
      c.beginPath();
      c.arc(0, 0, r, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
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

  /**
   * On the rope canvas, under the 3D fish: a menu fish's glow in its rarity's
   * colour, and a hook wherever a line meets a fish (mouth, and tail on sideways fish).
   */
  private drawFish(f: Hanging) {
    const c = this.ctx;
    const h = this.ps[f.head];
    const t = this.ps[f.tail];
    if (f.def.label) {
      const i = this.fish.indexOf(f);
      const r = f.len * 0.55;
      const g = c.createRadialGradient(0, 0, 0, 0, 0, r);
      const glow = RARITY[f.def.rarity].color;
      g.addColorStop(0, glow);
      g.addColorStop(1, 'transparent');
      c.save();
      c.translate((h.x + t.x) / 2, (h.y + t.y) / 2);
      c.rotate(Math.atan2(h.y - t.y, h.x - t.x));
      c.scale(1, 0.55);
      c.globalAlpha = 0.32 + 0.25 * (this.hover[i] ?? 0);
      c.fillStyle = g;
      c.beginPath();
      c.arc(0, 0, r, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
    c.strokeStyle = '#cfd8dc';
    c.lineWidth = 1.6;
    for (const line of f.lines) {
      const p = this.ps[line.end];
      c.beginPath();
      c.arc(p.x, p.y + 3, 3.5, Math.PI * 1.1, Math.PI * 0.1, true);
      c.stroke();
    }
  }
}