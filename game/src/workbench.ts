// Workbench: the screen between the title and a dive. A top-down table where the
// START fish (top left), the three map cards (top right), dive accessories
// (bottom left) and catching gear (bottom right) drop in from above and land.
//
// Click a piece to inspect it: it flies to the centre, the rest blurs, and its
// description shows on the left. Click or press any key to set it in the middle
// of the table (packed); do it again to put it back in its corner.
// Click a map: it drops into the middle, sucks in the packed gear and flips face
// up. Click the map itself to dive: it sucks in everything, then we cut to that
// map. Click anywhere else and it spits the gear back out.
//
// matter-js resolves collisions in the table plane with no gravity (we look down
// on the table); "falling" is a drop toward the camera, drawn as scale + shadow.

import Matter from 'matter-js';
import { buildFishMesh, rollFish, ZONES } from './fish';
import { MAPS, MAP_ORDER, isUnlocked, mapDepth, type MapDef, type MapId, type MapProgress } from './maps';
import { objectSprite } from './portrait';
import { UPGRADES, buildUpgradeModel, type UpgradeId } from './upgrades';

const { Bodies, Body, Composite, Constraint, Engine, Query } = Matter;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface WorkbenchHooks {
  progress(): MapProgress;
  setUnlockAll(on: boolean): void;
  /** Called mid-transition, while the map card covers the screen. */
  dive(map: MapId, gear: UpgradeId[]): void;
  back(): void;
}

const ACCESSORIES: UpgradeId[] = ['fins', 'tank', 'lamp'];
// The catching side is intentionally separate from boat equipment: the rod
// carries the net, the reel changes recovery, and bait remains a future hook
// quality branch. Boat upgrades are not shown on this workbench.
const CATCHERS: UpgradeId[] = ['rod', 'reel', 'net'];
const PLACEHOLDER = 'Description coming soon. 描述待补充。';
const ROMAN = ['I', 'II', 'III'];
const DIFFICULTY_COLOR: Record<MapDef['difficulty'], string> = { Casual: '#3ef0a8', Normal: '#ffcc4d', Hard: '#ff4d5e' };

const SPRITE = 256; // sprite render size, px
const CARD_W = 300; // map card art size, px
const CARD_H = 420;
const STEP_MS = 1000 / 60;
const FALL_S = 0.55;
const MAP_FOCUS_SCALE = 2.3;
const SUCK_FORCE = 0.0009;
const SUCK_TIMEOUT_S = 1.6;
const CLICK_MOVE_PX = 6;
const CLICK_MS = 350;
const ZOOM_MS = 450;

type State = 'closed' | 'idle' | 'inspect' | 'placing' | 'mapDrop' | 'mapSuck' | 'mapOpen' | 'diving' | 'spitting';

interface Pose {
  x: number;
  y: number;
  a: number;
  s: number;
}

interface Piece {
  kind: 'fish' | 'gear' | 'map';
  key: string;
  info: { title: string; sub: string; text: string };
  /** Home position as a fraction of the table, and its resting tilt. */
  home: { fx: number; fy: number; a: number };
  /** Draw size as a fraction of the table's short side (sprite square, or card width). */
  frac: number;
  sprite: HTMLCanvasElement;
  back: HTMLCanvasElement | null; // map cards only
  url: string;
  box: { x0: number; y0: number; x1: number; y1: number }; // opaque area in sprite px
  // Layout (CSS px), recomputed on show.
  size: number;
  bw: number;
  bh: number;
  ox: number; // sprite offset so its opaque area is centred on the body
  oy: number;
  // Runtime.
  body: Matter.Body | null;
  pose: Pose; // drawn from here when the piece is not in the physics world
  hidden: boolean;
  packed: boolean;
  dropAt: number; // seconds; -1 once landed
  alpha: number;
  flip: number; // map: 0 back up, 1 face up
}

interface Tween {
  t: number;
  dur: number;
  fn: (u: number) => void;
  done?: () => void;
}

const easeOut = (u: number) => 1 - (1 - u) ** 3;
const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

export class Workbench {
  private root = $('workbench');
  private canvas = $<HTMLCanvasElement>('wb-canvas');
  private ctx = this.canvas.getContext('2d')!;
  private inspectLayer = $('wb-inspect');
  private zoom = $<HTMLImageElement>('wb-zoom');
  private infoPanel = $('wb-info');
  private toastEl = $('wb-toast');
  private demoBox = $<HTMLInputElement>('wb-demo-box');

  private engine = Engine.create({ gravity: { x: 0, y: 0, scale: 0 } });
  private pieces: Piece[] = [];
  private byBody = new Map<number, Piece>();
  private walls: Matter.Body[] = [];
  private table = { x: 0, y: 0, w: 0, h: 0 };
  private wood: HTMLCanvasElement | null = null;
  private w = 0;
  private h = 0;
  private state: State = 'closed';
  private time = 0;
  private last = 0;
  private acc = 0;
  private raf = 0;
  private tweens: Tween[] = [];
  private drag: { c: Matter.Constraint; piece: Piece } | null = null;
  private press: { piece: Piece | null; x: number; y: number; t: number } | null = null;
  private focus: Piece | null = null;
  private returnPose: Pose | null = null;
  private suck: { set: Piece[]; t: number; force: number; next: () => void } | null = null;
  private swallowed: Piece[] = [];
  private vanishing = 0; // pieces mid-way into the map
  private tableAlpha = 1;
  private toastTimer = 0;

  constructor(private hooks: WorkbenchHooks) {
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    this.inspectLayer.addEventListener('click', () => this.state === 'inspect' && this.place());
    window.addEventListener('keydown', (e) => {
      // Esc is routed through main.ts (escape()); any other key packs the inspected piece.
      if (this.state === 'inspect' && e.key !== 'Escape' && e.key.toLowerCase() !== 'g') {
        e.preventDefault();
        this.place();
      }
    });
    this.demoBox.addEventListener('change', () => {
      this.hooks.setUnlockAll(this.demoBox.checked);
      this.renderCards();
    });
    window.addEventListener('resize', () => this.visible && this.layout(true));
  }

  get visible() {
    return this.state !== 'closed';
  }

  /** packed gear, in table order */
  get packed(): UpgradeId[] {
    return this.pieces.filter((p) => p.kind === 'gear' && p.packed).map((p) => p.key as UpgradeId);
  }

  show(intro: boolean) {
    if (!this.pieces.length) this.buildPieces();
    // Re-opening the table (for example after backing out of the start card)
    // must not silently unpack the player's chosen dive kit.
    const previousPacked = new Set(
      this.pieces.filter((piece) => piece.kind === 'gear' && piece.packed).map((piece) => piece.key),
    );
    this.root.classList.remove('hidden');
    this.demoBox.checked = this.hooks.progress().unlockAll;
    this.renderCards();
    this.reset();
    this.layout(false);
    const order = this.pieces.map((p, i) => ({ p, i }));
    for (const { p, i } of order) {
      p.packed = !intro && previousPacked.has(p.key);
      if (intro) {
        // START fish first, then the maps, then the gear.
        p.dropAt = p.kind === 'fish' ? 0.05 : p.kind === 'map' ? 0.35 + i * 0.08 : 0.6 + i * 0.07;
      } else {
        const home = this.homePose(p);
        const packedIndex = this.pieces.filter((piece) => piece.kind === 'gear' && piece.packed).indexOf(p);
        const packedCount = previousPacked.size;
        const pose = p.packed && packedCount
          ? {
            x: this.centre.x + Math.cos((packedIndex / Math.max(1, packedCount)) * Math.PI * 2) * this.packRadius * 0.38,
            y: this.centre.y + Math.sin((packedIndex / Math.max(1, packedCount)) * Math.PI * 2) * this.packRadius * 0.38,
            a: (packedIndex - packedCount / 2) * 0.18,
            s: 1,
          }
          : home;
        this.addBody(p, pose);
        p.dropAt = -1;
      }
    }
    this.state = 'idle';
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    const loop = (now: number) => {
      if (this.state === 'closed') return;
      this.frame(Math.min((now - this.last) / 1000, 0.05));
      this.last = now;
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  hide() {
    this.state = 'closed';
    cancelAnimationFrame(this.raf);
    this.root.classList.add('hidden');
    this.inspectLayer.classList.add('hidden');
    this.infoPanel.classList.add('hidden');
  }

  /** Esc: step back out of whatever is open; from the bare table, back to the title. */
  escape() {
    if (this.state === 'inspect') this.place(true);
    else if (this.state === 'mapOpen') this.spit();
    else if (this.state === 'idle') this.hooks.back();
  }

  // ---- Setup ------------------------------------------------------------

  private buildPieces() {
    const spec = rollFish(0x5eed01, ZONES[2], 40);
    const fish = buildFishMesh({ ...spec, archetype: 'bulky', rarity: 'legendary', hue: 40, sat: 0.95, light: 0.56 });
    this.addSpritePiece('fish', 'start', objectSprite(fish.group, SPRITE, -0.55, 0.1), { fx: 0.19, fy: 0.27, a: -0.25 }, 0.36, {
      title: 'START',
      sub: 'Your first catch · 第一条鱼',
      text: PLACEHOLDER,
    });

    MAP_ORDER.forEach((id, i) => {
      this.pieces.push({
        ...this.blankPiece(),
        kind: 'map',
        key: id,
        info: { title: '', sub: '', text: '' },
        home: { fx: 0.63 + i * 0.12, fy: 0.27, a: (i - 1) * 0.09 },
        frac: 0.15,
        sprite: document.createElement('canvas'),
        back: document.createElement('canvas'),
      });
    });

    const gear = (ids: UpgradeId[], x0: number) =>
      ids.forEach((id, i) => {
        const def = UPGRADES.find((u) => u.id === id)!;
        this.addSpritePiece(
          'gear',
          id,
          objectSprite(buildUpgradeModel(id, 1), SPRITE),
          { fx: x0 + i * 0.12, fy: 0.72 + (i % 2 ? -0.05 : 0.03), a: (i - 1) * 0.35 },
          0.24,
          { title: `${def.name} · ${def.nameZh}`, sub: `Level 1 · ${def.effects[0]}`, text: PLACEHOLDER },
        );
      });
    gear(ACCESSORIES, 0.13);
    gear(CATCHERS, 0.63);
  }

  private blankPiece(): Omit<Piece, 'kind' | 'key' | 'info' | 'home' | 'frac' | 'sprite' | 'back'> {
    return {
      url: '',
      box: { x0: 0, y0: 0, x1: SPRITE, y1: SPRITE },
      size: 0,
      bw: 0,
      bh: 0,
      ox: 0,
      oy: 0,
      body: null,
      pose: { x: 0, y: 0, a: 0, s: 1 },
      hidden: false,
      packed: false,
      dropAt: -1,
      alpha: 1,
      flip: 0,
    };
  }

  private addSpritePiece(kind: 'fish' | 'gear', key: string, sprite: HTMLCanvasElement, home: Piece['home'], frac: number, info: Piece['info']) {
    this.pieces.push({ ...this.blankPiece(), kind, key, info, home, frac, sprite, back: null, url: sprite.toDataURL(), box: opaqueBox(sprite) });
  }

  private renderCards() {
    const progress = this.hooks.progress();
    this.pieces.forEach((p) => {
      if (p.kind !== 'map') return;
      const map = MAPS[p.key as MapId];
      const i = MAP_ORDER.indexOf(map.id);
      const locked = !isUnlocked(map, progress);
      drawCardFront(p.sprite, map, i);
      drawCardBack(p.back!, map, i, locked);
      p.info = {
        title: `${map.name} · ${map.nameZh}`,
        sub: `Chapter ${ROMAN[i]} · ${map.difficulty} · 0–${mapDepth(map) - 2} m`,
        text: `${map.blurb} Zones: ${map.zoneLabels.join(', ')}.`,
      };
    });
  }

  private reset() {
    Composite.clear(this.engine.world, false);
    this.byBody.clear();
    this.tweens = [];
    this.drag = null;
    this.press = null;
    this.focus = null;
    this.suck = null;
    this.swallowed = [];
    this.vanishing = 0;
    this.tableAlpha = 1;
    this.time = 0;
    this.acc = 0;
    this.inspectLayer.classList.add('hidden');
    this.infoPanel.classList.add('hidden');
    for (const p of this.pieces) {
      p.body = null;
      p.hidden = false;
      p.packed = false;
      p.alpha = 1;
      p.flip = 0;
      p.pose.s = 1;
    }
  }

  /** Sizes the canvas, table, walls and pieces. keep: rescale pieces already on the table. */
  private layout(keep: boolean) {
    const old = { ...this.table };
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const m = Math.max(14, Math.min(this.w, this.h) * 0.035);
    this.table = { x: m, y: m, w: this.w - 2 * m, h: this.h - 2 * m };
    this.wood = drawWood(this.table.w, this.table.h, dpr);

    Composite.remove(this.engine.world, this.walls);
    const t = this.table;
    const k = 400;
    this.walls = [
      Bodies.rectangle(t.x + t.w / 2, t.y - k / 2, t.w + 2 * k, k, { isStatic: true }),
      Bodies.rectangle(t.x + t.w / 2, t.y + t.h + k / 2, t.w + 2 * k, k, { isStatic: true }),
      Bodies.rectangle(t.x - k / 2, t.y + t.h / 2, k, t.h + 2 * k, { isStatic: true }),
      Bodies.rectangle(t.x + t.w + k / 2, t.y + t.h / 2, k, t.h + 2 * k, { isStatic: true }),
    ];
    Composite.add(this.engine.world, this.walls);

    const base = Math.min(t.w, t.h);
    for (const p of this.pieces) {
      if (p.kind === 'map') {
        p.size = base * p.frac;
        p.bw = p.size;
        p.bh = p.size * (CARD_H / CARD_W);
        p.ox = p.oy = 0;
      } else {
        p.size = base * p.frac;
        const k2 = p.size / SPRITE;
        p.bw = Math.max(18, (p.box.x1 - p.box.x0) * k2 * 0.9);
        p.bh = Math.max(18, (p.box.y1 - p.box.y0) * k2 * 0.9);
        p.ox = ((p.box.x0 + p.box.x1) / 2 - SPRITE / 2) * k2;
        p.oy = ((p.box.y0 + p.box.y1) / 2 - SPRITE / 2) * k2;
      }
      if (keep && p.body && old.w) {
        // Window resized: keep each piece at the same spot relative to the table.
        const pose = this.poseOf(p);
        pose.x = t.x + ((pose.x - old.x) / old.w) * t.w;
        pose.y = t.y + ((pose.y - old.y) / old.h) * t.h;
        this.addBody(p, pose);
      }
    }
  }

  private homePose(p: Piece): Pose {
    return { x: this.table.x + p.home.fx * this.table.w, y: this.table.y + p.home.fy * this.table.h, a: p.home.a, s: 1 };
  }

  private get centre() {
    return { x: this.table.x + this.table.w / 2, y: this.table.y + this.table.h * 0.52 };
  }

  private get packRadius() {
    return Math.min(this.table.w, this.table.h) * 0.16;
  }

  // ---- Physics ----------------------------------------------------------

  private addBody(p: Piece, pose: Pose) {
    this.removeBody(p);
    const body = Bodies.rectangle(pose.x, pose.y, p.bw, p.bh, {
      chamfer: { radius: Math.min(p.bw, p.bh) * (p.kind === 'map' ? 0.06 : 0.25) },
      frictionAir: 0.09,
      friction: 0.05,
      restitution: 0.35,
      density: p.kind === 'map' ? 0.004 : 0.002,
    });
    Body.setAngle(body, pose.a);
    Composite.add(this.engine.world, body);
    this.byBody.set(body.id, p);
    p.body = body;
    p.pose = { ...pose, s: 1 };
  }

  private removeBody(p: Piece) {
    if (!p.body) return;
    if (this.drag?.piece === p) this.release();
    Composite.remove(this.engine.world, p.body);
    this.byBody.delete(p.body.id);
    p.body = null;
  }

  private poseOf(p: Piece): Pose {
    return p.body ? { x: p.body.position.x, y: p.body.position.y, a: p.body.angle, s: p.pose.s } : { ...p.pose };
  }

  private frame(dt: number) {
    this.time += dt;
    for (const p of this.pieces) if (p.dropAt >= 0 && this.time >= p.dropAt + FALL_S) this.land(p);
    if (this.suck) this.pull(dt);

    this.acc += dt * 1000;
    while (this.acc >= STEP_MS) {
      this.acc -= STEP_MS;
      Engine.update(this.engine, STEP_MS);
    }

    for (const tw of [...this.tweens]) {
      tw.t = Math.min(tw.dur, tw.t + dt);
      tw.fn(tw.t / tw.dur);
      if (tw.t >= tw.dur) {
        this.tweens.splice(this.tweens.indexOf(tw), 1);
        tw.done?.();
      }
    }
    this.draw();
  }

  private tween(dur: number, fn: (u: number) => void, done?: () => void) {
    this.tweens.push({ t: 0, dur, fn, done });
  }

  /** A dropped piece touches down: it joins the physics and shoves whatever it landed near. */
  private land(p: Piece) {
    p.dropAt = -1;
    this.addBody(p, this.homePose(p));
    const b = p.body!;
    Body.setVelocity(b, { x: (Math.random() - 0.5) * 3, y: (Math.random() - 0.5) * 3 });
    Body.setAngularVelocity(b, (Math.random() - 0.5) * 0.08);
    for (const q of this.pieces) {
      if (q === p || !q.body) continue;
      const dx = q.body.position.x - b.position.x;
      const dy = q.body.position.y - b.position.y;
      const d = Math.hypot(dx, dy) || 1;
      const reach = (p.size + q.size) * 0.7;
      if (d < reach) Body.setVelocity(q.body, { x: q.body.velocity.x + (dx / d) * 4 * (1 - d / reach), y: q.body.velocity.y + (dy / d) * 4 * (1 - d / reach) });
    }
  }

  /** Suction toward the table centre; pieces that get close vanish into the map. */
  private pull(dt: number) {
    const s = this.suck!;
    s.t += dt;
    const c = this.centre;
    const capture = (this.focus?.bw ?? 100) * MAP_FOCUS_SCALE * 0.3;
    for (const p of s.set) {
      if (!p.body) continue;
      const dx = c.x - p.body.position.x;
      const dy = c.y - p.body.position.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < capture || s.t > SUCK_TIMEOUT_S) {
        this.vanish(p);
        continue;
      }
      const f = s.force * p.body.mass * (1 + s.t * 2);
      Body.applyForce(p.body, p.body.position, { x: (dx / d) * f, y: (dy / d) * f });
      Body.setAngularVelocity(p.body, p.body.angularVelocity * 0.98 + 0.004);
    }
    if (s.set.every((p) => !p.body) && !this.vanishing) {
      this.suck = null;
      s.next();
    }
  }

  private vanish(p: Piece) {
    const from = this.poseOf(p);
    this.removeBody(p);
    const c = this.centre;
    p.pose = from;
    this.swallowed.push(p);
    this.vanishing++;
    this.tween(
      0.28,
      (u) => {
        const e = easeOut(u);
        p.pose = { x: lerp(from.x, c.x, e), y: lerp(from.y, c.y, e), a: from.a + e * 4, s: lerp(1, 0.05, e) };
        p.alpha = 1 - e;
      },
      () => {
        p.hidden = true;
        this.vanishing--;
      },
    );
  }

  // ---- Pointer ----------------------------------------------------------

  private pieceAt(x: number, y: number): Piece | null {
    const bodies = this.pieces.filter((p) => p.body).map((p) => p.body!);
    const hit = Query.point(bodies, { x, y });
    return hit.length ? (this.byBody.get(hit[hit.length - 1].id) ?? null) : null;
  }

  private onDown(e: PointerEvent) {
    if (this.state !== 'idle' && this.state !== 'mapOpen') return;
    const piece = this.state === 'idle' ? this.pieceAt(e.clientX, e.clientY) : null;
    this.press = { piece, x: e.clientX, y: e.clientY, t: performance.now() };
    if (!piece?.body) return;
    const b = piece.body;
    const c = Constraint.create({
      pointA: { x: e.clientX, y: e.clientY },
      bodyB: b,
      pointB: { x: e.clientX - b.position.x, y: e.clientY - b.position.y },
      stiffness: 0.12,
      damping: 0.1,
      length: 0,
    });
    Composite.add(this.engine.world, c);
    this.drag = { c, piece };
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = 'grabbing';
  }

  private onMove(e: PointerEvent) {
    if (!this.visible) return;
    if (this.drag) {
      this.drag.c.pointA = { x: e.clientX, y: e.clientY };
      return;
    }
    const over = this.state === 'idle' && this.pieceAt(e.clientX, e.clientY);
    this.canvas.style.cursor = over ? 'pointer' : this.state === 'mapOpen' ? 'pointer' : '';
  }

  private onUp(e: PointerEvent) {
    if (!this.visible) return;
    this.release();
    const press = this.press;
    this.press = null;
    if (!press) return;
    const click = Math.hypot(e.clientX - press.x, e.clientY - press.y) < CLICK_MOVE_PX && performance.now() - press.t < CLICK_MS;
    if (!click) return;
    if (this.state === 'mapOpen') {
      if (this.onFocusedCard(e.clientX, e.clientY)) this.dive();
      else this.spit();
    } else if (this.state === 'idle' && press.piece?.body) {
      if (press.piece.kind === 'map') this.openMap(press.piece);
      else this.inspect(press.piece);
    }
  }

  private release() {
    if (!this.drag) return;
    Composite.remove(this.engine.world, this.drag.c);
    this.drag = null;
    this.canvas.style.cursor = '';
  }

  private onFocusedCard(x: number, y: number) {
    const p = this.focus!;
    return Math.abs(x - p.pose.x) < (p.bw * p.pose.s) / 2 && Math.abs(y - p.pose.y) < (p.bh * p.pose.s) / 2;
  }

  // ---- Inspect ----------------------------------------------------------

  private inspect(p: Piece) {
    this.state = 'inspect';
    this.focus = p;
    const from = this.poseOf(p);
    this.returnPose = from;
    this.removeBody(p);
    p.pose = from;
    p.hidden = true;
    this.zoom.src = p.url;
    this.setZoom(p, from, false);
    this.inspectLayer.classList.remove('hidden', 'fading');
    void this.zoom.offsetWidth; // start the transition from the piece's spot
    const big = (Math.min(this.w, this.h) * 0.7) / p.size;
    this.setZoom(p, { x: this.w * 0.6, y: this.h * 0.5, a: 0, s: big }, true);
    this.showInfo(p, p.packed ? 'Click or press any key to put it back' : 'Click or press any key to pack it');
  }

  /** Puts the inspected piece down: into the middle (packing it), back to its corner, or (cancel) where it was. */
  private place(cancel = false) {
    const p = this.focus!;
    this.state = 'placing';
    let to: Pose;
    if (cancel) to = this.returnPose!;
    else if (p.packed) to = this.homePose(p);
    else {
      const c = this.centre;
      const r = this.packRadius * 0.6 * Math.sqrt(Math.random());
      const th = Math.random() * Math.PI * 2;
      to = { x: c.x + Math.cos(th) * r, y: c.y + Math.sin(th) * r, a: (Math.random() - 0.5) * 1.2, s: 1 };
    }
    this.setZoom(p, to, true);
    this.inspectLayer.classList.add('fading');
    this.infoPanel.classList.add('hidden');
    window.setTimeout(() => {
      this.inspectLayer.classList.add('hidden');
      if (!cancel) p.packed = !p.packed;
      p.hidden = false;
      this.addBody(p, to);
      this.focus = null;
      this.state = 'idle';
    }, ZOOM_MS);
  }

  /** Positions the zoom image over a pose (pose = where the body would be). */
  private setZoom(p: Piece, pose: Pose, animate: boolean) {
    const cos = Math.cos(pose.a);
    const sin = Math.sin(pose.a);
    // The sprite's centre is offset from the body by its padding.
    const cx = pose.x - (cos * p.ox - sin * p.oy) * pose.s;
    const cy = pose.y - (sin * p.ox + cos * p.oy) * pose.s;
    const z = this.zoom.style;
    z.transition = animate ? `transform ${ZOOM_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)` : 'none';
    z.width = z.height = `${p.size}px`;
    z.transform = `translate(${cx - p.size / 2}px, ${cy - p.size / 2}px) rotate(${pose.a}rad) scale(${pose.s})`;
  }

  private showInfo(p: Piece, hint: string) {
    $('wb-info-title').textContent = p.info.title;
    $('wb-info-sub').textContent = p.info.sub;
    $('wb-info-text').textContent = p.info.text;
    $('wb-info-hint').textContent = hint;
    this.infoPanel.classList.remove('hidden');
  }

  private toast(text: string) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 1800);
  }

  // ---- Maps -------------------------------------------------------------

  private openMap(p: Piece) {
    const map = MAPS[p.key as MapId];
    if (!isUnlocked(map, this.hooks.progress())) {
      // A small rattle, not a spin: the card should stay readable where it lies.
      Body.setAngularVelocity(p.body!, 0.03 * (Math.random() < 0.5 ? -1 : 1));
      Body.setVelocity(p.body!, { x: (Math.random() - 0.5) * 2, y: -1.5 });
      this.toast(`🔒 ${map.name}: bank ${map.unlockValue} value to open (you have ${Math.floor(this.hooks.progress().bestValue)})`);
      return;
    }
    this.state = 'mapDrop';
    this.focus = p;
    const from = this.poseOf(p);
    this.removeBody(p);
    const c = this.centre;
    this.swallowed = [];
    // Lifted off the table, carried to the middle, dropped face down.
    this.tween(
      0.65,
      (u) => {
        const e = easeInOut(u);
        p.pose = { x: lerp(from.x, c.x, e), y: lerp(from.y, c.y, e), a: lerp(from.a, 0, e), s: lerp(1, MAP_FOCUS_SCALE, e) + Math.sin(u * Math.PI) * 0.5 };
      },
      () => {
        this.state = 'mapSuck';
        const packed = this.pieces.filter((q) => q.packed && q.body);
        this.suck = { set: packed, t: 0, force: SUCK_FORCE, next: () => this.flipFocus(1, () => this.mapOpened()) };
      },
    );
  }

  private flipFocus(to: 0 | 1, done: () => void) {
    const p = this.focus!;
    const from = p.flip;
    this.tween(0.55, (u) => (p.flip = lerp(from, to, easeInOut(u))), done);
  }

  private mapOpened() {
    this.state = 'mapOpen';
    this.showInfo(this.focus!, 'Click the map to dive · click outside to go back');
  }

  private dive() {
    const p = this.focus!;
    this.state = 'diving';
    this.infoPanel.classList.add('hidden');
    const rest = this.pieces.filter((q) => q.body);
    this.suck = {
      set: rest,
      t: 0,
      force: SUCK_FORCE * 2.5,
      next: () => {
        // Into the map: the card grows past the screen edges, then the table fades.
        const s0 = p.pose.s;
        const cover = Math.max(this.w / p.bw, this.h / p.bh) * 1.15;
        let fired = false;
        this.tween(
          0.8,
          (u) => {
            const e = easeInOut(u);
            p.pose = { ...p.pose, s: lerp(s0, cover, e) };
            this.tableAlpha = 1 - e;
            if (u > 0.6 && !fired) {
              fired = true;
              this.hooks.dive(p.key as MapId, this.packed);
            }
          },
          () => {
            this.tween(0.35, (u) => (p.alpha = 1 - u), () => this.hide());
          },
        );
      },
    };
  }

  /** Back out of a face-up map: it spits the gear out, flips over and returns to its spot. */
  private spit() {
    const p = this.focus!;
    this.state = 'spitting';
    this.infoPanel.classList.add('hidden');
    const c = this.centre;
    for (const q of this.swallowed) {
      const th = Math.random() * Math.PI * 2;
      q.hidden = false;
      q.alpha = 1;
      this.addBody(q, { x: c.x + Math.cos(th) * 10, y: c.y + Math.sin(th) * 10, a: Math.random() * 6, s: 1 });
      const speed = 9 + Math.random() * 6;
      Body.setVelocity(q.body!, { x: Math.cos(th) * speed, y: Math.sin(th) * speed });
      Body.setAngularVelocity(q.body!, (Math.random() - 0.5) * 0.4);
      q.pose.s = 0.2;
      this.tween(0.3, (u) => (q.pose.s = lerp(0.2, 1, easeOut(u))));
    }
    this.swallowed = [];
    this.flipFocus(0, () => {
      const from = { ...p.pose };
      const home = this.homePose(p);
      this.tween(
        0.55,
        (u) => {
          const e = easeInOut(u);
          p.pose = { x: lerp(from.x, home.x, e), y: lerp(from.y, home.y, e), a: lerp(from.a, home.a, e), s: lerp(from.s, 1, e) };
        },
        () => {
          this.addBody(p, home);
          this.focus = null;
          this.state = 'idle';
        },
      );
    });
  }

  // ---- Drawing ----------------------------------------------------------

  private draw() {
    const c = this.ctx;
    const t = this.table;
    c.clearRect(0, 0, this.w, this.h);
    c.globalAlpha = this.tableAlpha;
    c.save();
    c.shadowColor = 'rgba(0, 0, 0, 0.5)';
    c.shadowBlur = 30;
    c.drawImage(this.wood!, t.x, t.y, t.w, t.h);
    c.restore();

    // The packing spot in the middle.
    const m = this.centre;
    c.save();
    c.setLineDash([8, 8]);
    c.strokeStyle = 'rgba(255, 240, 210, 0.35)';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(m.x, m.y, this.packRadius, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = 'rgba(255, 240, 210, 0.4)';
    c.font = '800 12px Inter, system-ui, sans-serif';
    c.textAlign = 'center';
    c.letterSpacing = '0.3em';
    c.fillText('PACK', m.x, m.y + this.packRadius + 18);
    c.restore();
    c.globalAlpha = 1;

    // On the table first, then pieces in the air, then the focused map on top.
    const air: Piece[] = [];
    for (const p of this.pieces) {
      if (p.hidden || p === this.focus) continue;
      if (p.dropAt >= 0) air.push(p);
      else this.drawPiece(p, this.poseOf(p), 0);
    }
    for (const p of air) {
      const u = (this.time - p.dropAt) / FALL_S;
      if (u < 0) continue;
      this.drawPiece(p, this.homePose(p), 1 - u * u);
    }
    if (this.focus && !this.focus.hidden) this.drawPiece(this.focus, this.focus.pose, this.state === 'mapDrop' ? 0.4 : 0);
  }

  /** height: 0 on the table .. 1 high above it (bigger, fainter, shadow further off). */
  private drawPiece(p: Piece, pose: Pose, height: number) {
    const c = this.ctx;
    c.save();
    c.globalAlpha = p.alpha * Math.min(1, (1 - height) * 2.5 + 0.05);
    c.translate(pose.x, pose.y);
    c.rotate(pose.a);
    const s = pose.s * (1 + height * 1.3);
    c.scale(s, s);
    if (p.packed && p.kind === 'gear' && height === 0) {
      c.shadowColor = 'rgba(62, 240, 168, 0.95)';
      c.shadowBlur = 22;
    } else {
      c.shadowColor = 'rgba(0, 0, 0, 0.45)';
      c.shadowBlur = 6 + height * 30;
      c.shadowOffsetX = 4 + height * 40;
      c.shadowOffsetY = 6 + height * 50;
    }
    if (p.kind === 'map') {
      const sx = Math.abs(Math.cos(p.flip * Math.PI)) || 0.001;
      const face = p.flip < 0.5 ? p.back! : p.sprite;
      c.scale(sx, 1);
      c.drawImage(face, -p.bw / 2, -p.bh / 2, p.bw, p.bh);
    } else {
      c.drawImage(p.sprite, -p.ox - p.size / 2, -p.oy - p.size / 2, p.size, p.size);
    }
    c.restore();
  }
}

// ---- Helpers ----------------------------------------------------------------

function opaqueBox(cv: HTMLCanvasElement) {
  const a = cv.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, cv.width, cv.height).data;
  let x0 = cv.width;
  let y0 = cv.height;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < cv.height; y += 2)
    for (let x = 0; x < cv.width; x += 2)
      if (a[(y * cv.width + x) * 4 + 3] > 40) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  return x1 > x0 ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: cv.width, y1: cv.height };
}

/** Planked workbench top. */
function drawWood(w: number, h: number, dpr: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w * dpr));
  cv.height = Math.max(1, Math.round(h * dpr));
  const c = cv.getContext('2d')!;
  c.scale(dpr, dpr);
  const r = 18;
  c.beginPath();
  c.roundRect(0, 0, w, h, r);
  c.clip();
  const plank = Math.max(48, h / 9);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0, i = 0; y < h; y += plank, i++) {
    c.fillStyle = i % 2 ? '#7c5634' : '#86603b';
    c.fillRect(0, y, w, plank);
    c.strokeStyle = 'rgba(40, 22, 8, 0.55)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(w, y);
    c.stroke();
    // Grain and the odd plank joint.
    c.strokeStyle = 'rgba(255, 220, 170, 0.07)';
    c.lineWidth = 1;
    for (let g = 0; g < 5; g++) {
      const gy = y + rand() * plank;
      c.beginPath();
      c.moveTo(0, gy);
      for (let x = 0; x <= w; x += 40) c.lineTo(x, gy + Math.sin(x / 90 + g) * 3);
      c.stroke();
    }
    const joint = rand() * w;
    c.strokeStyle = 'rgba(40, 22, 8, 0.45)';
    c.beginPath();
    c.moveTo(joint, y);
    c.lineTo(joint, y + plank);
    c.stroke();
  }
  // Worn edge.
  const g = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
  g.addColorStop(0, 'rgba(0, 0, 0, 0)');
  g.addColorStop(1, 'rgba(20, 10, 2, 0.5)');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  c.strokeStyle = '#3a2412';
  c.lineWidth = 6;
  c.strokeRect(0, 0, w, h);
  return cv;
}

function cardCanvas(cv: HTMLCanvasElement) {
  cv.width = CARD_W;
  cv.height = CARD_H;
  const c = cv.getContext('2d')!;
  c.clearRect(0, 0, CARD_W, CARD_H);
  c.save();
  c.beginPath();
  c.roundRect(0, 0, CARD_W, CARD_H, 18);
  c.clip();
  return c;
}

/** Face side: the place itself, sky to seabed, with its name and difficulty. */
function drawCardFront(cv: HTMLCanvasElement, map: MapDef, i: number) {
  const c = cardCanvas(cv);
  const horizon = CARD_H * 0.42;
  const sky = c.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#ffffff');
  sky.addColorStop(1, map.sky);
  c.fillStyle = sky;
  c.fillRect(0, 0, CARD_W, horizon);

  // Skyline per map: fjord peaks, stone pillars, or storm clouds.
  c.fillStyle = map.rocks[0];
  if (map.id === 'fjord') {
    c.beginPath();
    c.moveTo(0, horizon);
    [[0, 150], [70, 60], [120, 120], [190, 40], [260, 110], [300, 80], [300, horizon]].forEach(([x, y]) => c.lineTo(x, y));
    c.fill();
    c.fillStyle = '#f4fbff';
    [[70, 60], [190, 40]].forEach(([x, y]) => {
      c.beginPath();
      c.moveTo(x - 22, y + 28);
      c.lineTo(x, y);
      c.lineTo(x + 24, y + 30);
      c.fill();
    });
  } else if (map.id === 'tianchi') {
    [[30, 70, 34], [85, 40, 30], [150, 90, 40], [215, 55, 28], [262, 100, 34]].forEach(([x, y, w]) => {
      c.beginPath();
      c.roundRect(x, y, w, horizon - y, [14, 14, 0, 0]);
      c.fill();
    });
    c.fillStyle = 'rgba(255, 255, 255, 0.55)';
    c.fillRect(0, horizon - 40, CARD_W, 22);
  } else {
    c.fillStyle = '#5b6f80';
    [[60, 50, 70], [160, 35, 85], [250, 60, 65]].forEach(([x, y, r]) => {
      c.beginPath();
      c.ellipse(x, y, r, r * 0.45, 0, 0, Math.PI * 2);
      c.fill();
    });
    c.strokeStyle = '#fff6b0';
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(180, 60);
    c.lineTo(165, 100);
    c.lineTo(182, 100);
    c.lineTo(168, 140);
    c.stroke();
  }

  const water = c.createLinearGradient(0, horizon, 0, CARD_H);
  map.water.forEach(([d, col]) => water.addColorStop(Math.min(1, d / 60), col));
  c.fillStyle = water;
  c.fillRect(0, horizon, CARD_W, CARD_H - horizon);
  c.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  c.lineWidth = 2;
  c.beginPath();
  for (let x = 0; x <= CARD_W; x += 10) c.lineTo(x, horizon + Math.sin(x / 18) * 3 * map.waves);
  c.stroke();

  c.fillStyle = 'rgba(4, 18, 34, 0.78)';
  c.fillRect(0, CARD_H * 0.66, CARD_W, CARD_H * 0.34);
  c.textAlign = 'left';
  c.fillStyle = '#ffcc4d';
  c.font = '800 13px Inter, system-ui, sans-serif';
  c.letterSpacing = '0.2em';
  c.fillText(`CHAPTER ${ROMAN[i]}`, 20, CARD_H * 0.66 + 26);
  c.letterSpacing = '0px';
  c.fillStyle = '#ffffff';
  c.font = '900 28px Inter, system-ui, sans-serif';
  c.fillText(map.name, 20, CARD_H * 0.66 + 60);
  c.font = '800 22px system-ui, sans-serif';
  c.fillText(map.nameZh, 20, CARD_H * 0.66 + 90);
  pill(c, map.difficulty, CARD_W - 20, CARD_H * 0.66 + 22, DIFFICULTY_COLOR[map.difficulty]);
  c.fillStyle = 'rgba(234, 248, 255, 0.7)';
  c.font = '600 13px Inter, system-ui, sans-serif';
  c.fillText(`0–${mapDepth(map) - 2} m · ${map.place}`, 20, CARD_H * 0.66 + 118);
  c.restore();
  border(c, DIFFICULTY_COLOR[map.difficulty]);
}

/** Back side: chapter number on a sea-chart pattern; locked maps say what they need. */
function drawCardBack(cv: HTMLCanvasElement, map: MapDef, i: number, locked: boolean) {
  const c = cardCanvas(cv);
  const bg = c.createLinearGradient(0, 0, 0, CARD_H);
  bg.addColorStop(0, '#12304a');
  bg.addColorStop(1, '#071423');
  c.fillStyle = bg;
  c.fillRect(0, 0, CARD_W, CARD_H);
  c.strokeStyle = 'rgba(217, 180, 124, 0.14)';
  c.lineWidth = 2;
  for (let r = 30; r < 300; r += 26) {
    c.beginPath();
    c.arc(CARD_W / 2, CARD_H / 2, r, 0, Math.PI * 2);
    c.stroke();
  }
  c.textAlign = 'center';
  c.fillStyle = '#d9b47c';
  c.font = '900 96px Georgia, serif';
  c.fillText(ROMAN[i], CARD_W / 2, CARD_H / 2 + 20);
  c.font = '800 13px Inter, system-ui, sans-serif';
  c.letterSpacing = '0.3em';
  c.fillText('CHAPTER', CARD_W / 2, CARD_H / 2 - 70);
  c.letterSpacing = '0px';
  c.font = '800 22px system-ui, sans-serif';
  c.fillStyle = '#eaf8ff';
  c.fillText(map.nameZh, CARD_W / 2, CARD_H / 2 + 70);
  c.fillStyle = DIFFICULTY_COLOR[map.difficulty];
  c.font = '800 14px Inter, system-ui, sans-serif';
  c.fillText(map.difficulty.toUpperCase(), CARD_W / 2, CARD_H / 2 + 98);
  if (locked) {
    c.fillStyle = 'rgba(2, 8, 18, 0.62)';
    c.fillRect(0, 0, CARD_W, CARD_H);
    c.font = '64px system-ui, sans-serif';
    c.fillText('🔒', CARD_W / 2, CARD_H / 2 - 4);
    c.fillStyle = '#eaf8ff';
    c.font = '700 15px Inter, system-ui, sans-serif';
    c.fillText(`Bank ${map.unlockValue} value`, CARD_W / 2, CARD_H / 2 + 40);
  }
  c.restore();
  border(c, '#d9b47c');
}

function pill(c: CanvasRenderingContext2D, text: string, right: number, y: number, color: string) {
  c.font = '800 12px Inter, system-ui, sans-serif';
  const w = c.measureText(text).width + 18;
  c.fillStyle = color;
  c.beginPath();
  c.roundRect(right - w, y - 15, w, 22, 11);
  c.fill();
  c.fillStyle = '#04121f';
  c.textAlign = 'center';
  c.fillText(text, right - w / 2, y);
  c.textAlign = 'left';
}

function border(c: CanvasRenderingContext2D, color: string) {
  c.strokeStyle = color;
  c.lineWidth = 6;
  c.beginPath();
  c.roundRect(3, 3, CARD_W - 6, CARD_H - 6, 16);
  c.stroke();
}
