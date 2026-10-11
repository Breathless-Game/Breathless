// Stand-ins for panels and scene parts that are only needed once something opens.
// Each one keeps the real class's API, loads its module with a dynamic import (so it
// is not in the first download), and builds the real object in idle time after boot,
// so the first open is usually instant. Until then it answers with what the closed
// panel would say and remembers whether it was asked to open.
import type * as THREE from 'three';
import type { Aquarium } from './aquarium';
import type { Detail, EventContext, WorldEvents, WorldEventInfo } from './events';
import { idle } from './idle';
import type { GearInspector, InspectHooks } from './inspect';
import type { MapDef } from './maps';
import type { Report } from './report';
import type { SettingsDesk } from './settings-desk';
import type { UpgradeDef } from './upgrades';
import type { Vault } from './vault';

/** Build `T` once its module is in; idle time starts it, and so does the first use. */
class Lazy<T> {
  real: T | null = null;
  private pending: Promise<T> | null = null;
  constructor(private build: () => Promise<T>) {
    idle(() => void this.load());
  }
  load(): Promise<T> {
    this.pending ??= this.build().then(
      (real) => (this.real = real),
      (err) => {
        this.pending = null; // try again on the next use
        throw err;
      },
    );
    return this.pending;
  }
  /** Run `fn` with the real object now, or once it has loaded. */
  with(fn: (real: T) => void) {
    if (this.real) fn(this.real);
    else this.load().then(fn, (err) => console.error(err));
  }
}

export class LazyAquarium {
  private lazy: Lazy<Aquarium>;
  private want = false;
  constructor(...args: ConstructorParameters<typeof Aquarium>) {
    this.lazy = new Lazy(() => import('./aquarium').then((m) => new m.Aquarium(...args)));
  }
  get open() {
    return this.lazy.real ? this.lazy.real.open : this.want;
  }
  show() {
    if (this.lazy.real) return this.lazy.real.show();
    this.want = true;
    this.lazy.with((a) => {
      if (this.want) a.show();
      this.want = false;
    });
  }
  close() {
    this.want = false;
    this.lazy.real?.close();
  }
}

export class LazySettingsDesk {
  private lazy: Lazy<SettingsDesk>;
  private want = false;
  private isBlocked: () => boolean = () => false;
  constructor(...args: ConstructorParameters<typeof SettingsDesk>) {
    this.lazy = new Lazy(() =>
      import('./settings-desk').then((m) => {
        const desk = new m.SettingsDesk(...args);
        desk.blocked = this.isBlocked;
        return desk;
      }),
    );
  }
  get blocked() {
    return this.isBlocked;
  }
  set blocked(fn: () => boolean) {
    this.isBlocked = fn;
    if (this.lazy.real) this.lazy.real.blocked = fn;
  }
  get visible() {
    return this.lazy.real ? this.lazy.real.visible : this.want;
  }
  show() {
    if (this.lazy.real) return this.lazy.real.show();
    this.want = true;
    this.lazy.with((d) => {
      if (this.want) d.show();
      this.want = false;
    });
  }
  hide() {
    this.want = false;
    this.lazy.real?.hide();
  }
  escape() {
    this.want = false;
    this.lazy.real?.escape();
  }
}

/** The collection and the report are DOM panels: show the panel at once and fill it on load. */
class LazyPanel<T extends { toggle(show?: boolean): void }> {
  private panel: HTMLElement;
  protected lazy: Lazy<T>;
  constructor(id: string, build: () => Promise<T>) {
    this.panel = document.getElementById(id)!;
    this.lazy = new Lazy(build);
  }
  get open() {
    return !this.panel.classList.contains('hidden');
  }
  toggle(show = !this.open) {
    if (this.lazy.real) return this.lazy.real.toggle(show);
    this.panel.classList.toggle('hidden', !show);
    if (show) this.lazy.with((p) => this.open && p.toggle(true));
  }
}

export class LazyVault extends LazyPanel<Vault> {
  constructor(...args: ConstructorParameters<typeof Vault>) {
    super('collection', () => import('./vault').then((m) => new m.Vault(...args)));
  }
  refresh() {
    this.lazy.real?.refresh();
  }
}

export class LazyReport extends LazyPanel<Report> {
  constructor(...args: ConstructorParameters<typeof Report>) {
    super('report', () => import('./report').then((m) => new m.Report(...args)));
  }
}

/** The workbench's close-up viewer (it builds its own WebGL renderer). */
export class LazyGearInspector {
  private lazy: Lazy<GearInspector>;
  private ask = 0; // bumped by each show and close, so a late load opens only the latest
  private waiting = false;
  constructor(private hooks: InspectHooks) {
    this.lazy = new Lazy(() => import('./inspect').then((m) => new m.GearInspector(hooks)));
  }
  private open(fn: (i: GearInspector) => void) {
    if (this.lazy.real) return fn(this.lazy.real);
    const ask = ++this.ask;
    this.waiting = true;
    this.lazy.with((i) => {
      if (ask !== this.ask || !this.waiting) return;
      this.waiting = false;
      fn(i);
    });
  }
  show(def: UpgradeDef, from: { x: number; y: number }) {
    this.open((i) => i.show(def, from));
  }
  showShips(from: { x: number; y: number }) {
    this.open((i) => i.showShips(from));
  }
  showDiver(from: { x: number; y: number }) {
    this.open((i) => i.showDiver(from));
  }
  close() {
    if (this.lazy.real) return this.lazy.real.close();
    if (!this.waiting) return;
    // Closed while still loading: the workbench is told, as the real one would.
    this.waiting = false;
    this.hooks.closed();
  }
}

/**
 * The world events only play during a dive. They load in idle time, or when a dive
 * starts; until then there are none. `built` runs on the real object's scene content
 * (e.g. to colour-grade its materials).
 */
export class LazyWorldEvents {
  private lazy: Lazy<WorldEvents>;
  private handler: ((e: WorldEventInfo) => void) | null = null;
  constructor(scene: THREE.Scene, private map: MapDef, private detail: Detail, built?: () => void) {
    this.lazy = new Lazy(() =>
      import('./events').then((m) => {
        const events = new m.WorldEvents(scene, this.map, this.detail);
        events.onEvent = this.handler;
        built?.();
        return events;
      }),
    );
  }
  get onEvent() {
    return this.handler;
  }
  set onEvent(fn: ((e: WorldEventInfo) => void) | null) {
    this.handler = fn;
    if (this.lazy.real) this.lazy.real.onEvent = fn;
  }
  get activeId(): string | null {
    return this.lazy.real?.activeId ?? null;
  }
  get shake(): number {
    return this.lazy.real?.shake ?? 0;
  }
  setMap(map: MapDef) {
    this.map = map;
    this.lazy.real?.setMap(map);
  }
  setDetail(detail: Detail) {
    this.detail = detail;
    this.lazy.real?.setDetail(detail);
  }
  update(time: number, dt: number, ctx: EventContext) {
    if (this.lazy.real) this.lazy.real.update(time, dt, ctx);
    else void this.lazy.load().catch(() => {});
  }
  stop() {
    this.lazy.real?.stop();
  }
  trigger(id: string): boolean {
    if (this.lazy.real) return this.lazy.real.trigger(id);
    void this.lazy.load().catch(() => {});
    return false;
  }
}
