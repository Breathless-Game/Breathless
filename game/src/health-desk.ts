import * as THREE from 'three';
import { RARITY } from './fish';
import { TableScene, type TableHooks } from './table-scene';
import { drawTraces, healthLines, loadTrips, mapNames, rarityCounts, secs, tripDate, type TripRecord } from './trip';

// The health desk, from the title's HEALTH fish: a table comes up with the latest
// trip report laid out on it as a sheet of paper, and a bamboo jar of fortune
// sticks in the far right corner, one stick per earlier trip. Hovering a stick
// lifts it and shows that trip; clicking it lays that trip out on the paper.

const PAPER = { w: 5.9, d: 4.15, x: -1.1, z: 0.45, yaw: 0.04 };
const TEX_W = 1400;
const TEX_H = Math.round((TEX_W * PAPER.d) / PAPER.w);
const JAR = { x: 3.95, z: -0.35, r: 0.5, h: 1.15 };
const STICKS = 14; // the jar holds this many earlier trips
const STICK_H = 1.75;

const GRADE_COLOR: Record<string, string> = { S: '#d0359f', A: '#c8901c', B: '#2a9d6a', C: '#3a7fc0', D: '#8a8a8a' };

interface Stick {
  mesh: THREE.Group;
  record: TripRecord;
  base: THREE.Vector3;
  lift: number;
}

export class HealthDesk extends TableScene {
  private paperTex: THREE.CanvasTexture;
  private sticks: Stick[] = [];
  private jar = new THREE.Group();
  private hovered: Stick | null = null;
  private tip: HTMLElement;
  private hint: HTMLElement;
  private shown: TripRecord | null = null;

  constructor(hooks: TableHooks) {
    super('health-desk', hooks);
    const paperCanvas = document.createElement('canvas');
    paperCanvas.width = TEX_W;
    paperCanvas.height = TEX_H;
    this.paperTex = new THREE.CanvasTexture(paperCanvas);
    this.paperTex.colorSpace = THREE.SRGBColorSpace;
    this.paperTex.anisotropy = 8;
    const paper = new THREE.Mesh(new THREE.PlaneGeometry(PAPER.w, PAPER.d), new THREE.MeshStandardMaterial({ map: this.paperTex, roughness: 0.95 }));
    paper.rotation.set(-Math.PI / 2, 0, PAPER.yaw);
    paper.position.set(PAPER.x, 0.012, PAPER.z);
    paper.receiveShadow = true;
    this.scene.add(paper);
    this.buildJar();

    this.tip = document.createElement('div');
    this.tip.id = 'health-tip';
    this.tip.className = 'hidden';
    this.hint = document.createElement('div');
    this.hint.className = 'table-hint small';
    this.hint.textContent = 'Hover a stick in the jar for an earlier trip · click it to lay it out · Esc back';
    this.root.append(this.hint);
    document.body.append(this.tip); // over the title layer: the card mustn't hide behind a hanging fish

    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
  }

  /** Esc: back up to the title. */
  escape() {
    this.leave();
  }

  protected onShow() {
    const trips = loadTrips();
    this.layOut(trips[0] ?? null);
    this.fillJar(trips.slice(1, 1 + STICKS));
  }

  protected onHide() {
    this.hovered = null;
    this.tip.classList.add('hidden');
  }

  protected onFrame(dt: number) {
    const k = 1 - Math.exp(-dt * 10);
    for (const s of this.sticks) {
      s.lift += ((s === this.hovered ? 1 : 0) - s.lift) * k;
      s.mesh.position.set(s.base.x, s.base.y + s.lift * 0.45, s.base.z);
    }
  }

  // ---- The jar ----------------------------------------------------------------

  private buildJar() {
    const bamboo = new THREE.MeshStandardMaterial({ color: '#c79a52', roughness: 0.75 });
    const band = new THREE.MeshStandardMaterial({ color: '#7a4e22', roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(JAR.r, JAR.r * 0.92, JAR.h, 18, 1, true), bamboo);
    body.position.y = JAR.h / 2;
    body.castShadow = true;
    const inside = new THREE.Mesh(new THREE.CylinderGeometry(JAR.r * 0.94, JAR.r * 0.88, JAR.h * 0.98, 18, 1, true), new THREE.MeshStandardMaterial({ color: '#5c3b17', side: THREE.BackSide }));
    inside.position.y = JAR.h / 2;
    const floor = new THREE.Mesh(new THREE.CircleGeometry(JAR.r * 0.9, 18), band);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.06;
    this.jar.add(body, inside, floor);
    for (const y of [0.16, JAR.h * 0.55, JAR.h - 0.06]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(JAR.r * 1.005, 0.035, 6, 24), band);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      this.jar.add(ring);
    }
    this.jar.position.set(JAR.x, 0, JAR.z);
    this.scene.add(this.jar);
  }

  /** One stick per earlier trip, fanned out a little in the jar, its tip painted the trip's grade. */
  private fillJar(trips: TripRecord[]) {
    for (const s of this.sticks) this.jar.remove(s.mesh);
    this.sticks = trips.map((record, i) => {
      const n = trips.length;
      const a = (i / Math.max(1, n)) * Math.PI * 2 + 0.4;
      const rr = n > 1 ? JAR.r * 0.5 * (0.6 + 0.4 * ((i * 7) % 3) / 2) : 0;
      const mesh = new THREE.Group();
      const wood = new THREE.Mesh(new THREE.BoxGeometry(0.09, STICK_H, 0.03), new THREE.MeshStandardMaterial({ color: '#e2c48c', roughness: 0.8 }));
      wood.position.y = STICK_H / 2;
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.24, 0.035), new THREE.MeshStandardMaterial({ color: GRADE_COLOR[record.grade] ?? '#888', roughness: 0.6 }));
      tip.position.y = STICK_H - 0.12;
      wood.castShadow = tip.castShadow = true;
      mesh.add(wood, tip);
      // Leaning out from the middle, each at its own angle.
      mesh.rotation.set(Math.sin(a) * 0.16, a, -Math.cos(a) * 0.16);
      const base = new THREE.Vector3(Math.cos(a) * rr, 0.08 + ((i * 5) % 4) * 0.05, Math.sin(a) * rr);
      mesh.position.copy(base);
      mesh.userData.stick = i;
      this.jar.add(mesh);
      return { mesh, record, base, lift: 0 };
    });
  }

  // ---- The paper --------------------------------------------------------------

  private layOut(r: TripRecord | null) {
    this.shown = r;
    const canvas = this.paperTex.image as HTMLCanvasElement;
    const c = canvas.getContext('2d')!;
    const W = TEX_W;
    const H = TEX_H;
    // Cream paper, a ruled border.
    c.fillStyle = '#f3ead6';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(90, 60, 30, 0.35)';
    c.lineWidth = 4;
    c.strokeRect(24, 24, W - 48, H - 48);
    const ink = '#3a2210';
    const soft = 'rgba(58, 34, 16, 0.55)';
    c.textBaseline = 'alphabetic';
    if (!r) {
      c.fillStyle = ink;
      c.font = '800 64px Inter, system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText('No trips yet · 还没有记录', W / 2, H / 2 - 20);
      c.font = '500 36px Inter, system-ui, sans-serif';
      c.fillStyle = soft;
      c.fillText('Dive, then come back to the main menu: the trip report lands here.', W / 2, H / 2 + 50);
      this.paperTex.needsUpdate = true;
      return;
    }
    c.textAlign = 'left';
    const L = 70;
    c.fillStyle = soft;
    c.font = '700 30px Inter, system-ui, sans-serif';
    c.fillText(`TRIP REPORT · 本次报告 · ${tripDate(r)}`, L, 92);
    c.fillStyle = ink;
    c.font = '900 64px Inter, system-ui, sans-serif';
    c.fillText(mapNames(r), L, 160);
    // The grade, stamped in the corner.
    c.save();
    c.translate(W - 180, 130);
    c.rotate(-0.12);
    c.strokeStyle = GRADE_COLOR[r.grade];
    c.fillStyle = GRADE_COLOR[r.grade];
    c.lineWidth = 8;
    c.beginPath();
    c.arc(0, 0, 78, 0, Math.PI * 2);
    c.stroke();
    c.font = '900 92px Inter, system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(r.grade, 0, 4);
    c.restore();
    c.textAlign = 'right';
    c.fillStyle = ink;
    c.font = '800 44px Inter, system-ui, sans-serif';
    c.fillText(`${r.score.total} pts`, W - 290, 150);

    // Left column: the catch and the dives. Right column: health.
    const line = (x: number, y: number, w: number, k: string, v: string) => {
      c.textAlign = 'left';
      c.fillStyle = soft;
      c.font = '600 30px Inter, system-ui, sans-serif';
      c.fillText(k, x, y);
      c.textAlign = 'right';
      c.fillStyle = ink;
      c.font = '800 32px Inter, system-ui, sans-serif';
      c.fillText(v, x + w, y);
      c.strokeStyle = 'rgba(90, 60, 30, 0.15)';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x, y + 12);
      c.lineTo(x + w, y + 12);
      c.stroke();
    };
    const head = (x: number, y: number, t: string) => {
      c.textAlign = 'left';
      c.fillStyle = '#8a5a2a';
      c.font = '800 28px Inter, system-ui, sans-serif';
      c.fillText(t, x, y);
    };
    const colW = 560;
    let y = 240;
    head(L, y, 'CATCH · 渔获');
    y += 50;
    line(L, y, colW, 'Caught · 捕获', String(r.caught.length));
    y += 48;
    line(L, y, colW, 'Banked · 入库', String(r.banked));
    y += 48;
    const counts = rarityCounts(r);
    c.font = '700 26px Inter, system-ui, sans-serif';
    let cx = L;
    for (const [k, n] of counts) {
      const text = `${RARITY[k].label} ×${n}`;
      const w = c.measureText(text).width + 30;
      c.strokeStyle = RARITY[k].color;
      c.fillStyle = RARITY[k].color;
      c.lineWidth = 3;
      c.beginPath();
      c.roundRect(cx, y - 30, w, 42, 21);
      c.stroke();
      c.textAlign = 'left';
      c.fillText(text, cx + 15, y);
      cx += w + 12;
    }
    y += 64;
    head(L, y, 'DIVES · 下潜');
    y += 50;
    line(L, y, colW, 'Dives · 次数', String(r.dives));
    y += 48;
    line(L, y, colW, 'Deepest · 最深', `${Math.round(r.deepest)} m`);
    y += 48;
    line(L, y, colW, 'Longest hold · 最长屏息', secs(r.longestHoldMs));
    y += 48;
    line(L, y, colW, 'Blackouts · 昏厥', String(r.blackouts));

    const R = L + colW + 90;
    const rw = W - R - 70;
    let ry = 240;
    head(R, ry, 'HEALTH · 健康指标');
    ry += 50;
    for (const [k, v] of healthLines(r).slice(0, 6)) {
      line(R, ry, rw, k, v);
      ry += 48;
    }
    // Heart (red) and breathing (blue) over the trip.
    const gy = ry + 10;
    c.fillStyle = 'rgba(90, 60, 30, 0.06)';
    c.fillRect(R, gy, rw, H - gy - 70);
    if (r.pulse.length > 1 || r.breath.length > 1) drawTraces(c, r, R + 8, gy + 10, rw - 16, H - gy - 90);
    else {
      c.textAlign = 'center';
      c.fillStyle = soft;
      c.font = '600 26px Inter, system-ui, sans-serif';
      c.fillText('No sensor this trip · 无传感器数据', R + rw / 2, gy + (H - gy - 70) / 2);
    }
    this.paperTex.needsUpdate = true;
  }

  // ---- Pointer ----------------------------------------------------------------

  private stickAt(e: PointerEvent): Stick | null {
    if (!this.ours(e) || !this.sticks.length) return null;
    this.setRay(e);
    const hit = this.ray.intersectObjects(this.sticks.map((s) => s.mesh), true)[0];
    if (!hit) return null;
    let o: THREE.Object3D | null = hit.object;
    while (o && o.userData.stick == null) o = o.parent;
    return o ? this.sticks[o.userData.stick as number] : null;
  }

  private onMove(e: PointerEvent) {
    if (!this.visible) return;
    const s = this.stickAt(e);
    if (s !== this.hovered) {
      this.hovered = s;
      document.body.style.cursor = s ? 'pointer' : '';
    }
    if (!s) {
      this.tip.classList.add('hidden');
      return;
    }
    const r = s.record;
    this.tip.innerHTML = `
      <div class="small muted">${tripDate(r)} · ${mapNames(r)}</div>
      <div class="health-tip-score"><span class="trip-grade grade-${r.grade}">${r.grade}</span><b>${r.score.total}</b> pts</div>
      <div class="trip-line"><span>Fish · 渔获</span><b>${r.caught.length}</b></div>
      <div class="trip-line"><span>Deepest · 最深</span><b>${Math.round(r.deepest)} m</b></div>
      <div class="trip-line"><span>Longest hold · 屏息</span><b>${secs(r.longestHoldMs)}</b></div>
      <div class="trip-line"><span>Heart rate · 心率</span><b>${r.heart ? `${Math.round(r.heart.avg)} bpm` : '—'}</b></div>
      <div class="small muted">Click to lay it out · 点击展开</div>`;
    this.tip.style.transform = `translate(${Math.min(e.clientX + 18, window.innerWidth - 280)}px, ${Math.max(16, e.clientY - 200)}px)`;
    this.tip.classList.remove('hidden');
  }

  private onUp(e: PointerEvent) {
    const s = this.stickAt(e);
    if (!s || s.record === this.shown) return;
    // The paper on the table goes into the jar; the picked trip comes out onto the table.
    const all = [this.shown, ...this.sticks.map((x) => x.record)].filter((x): x is TripRecord => !!x && x !== s.record);
    all.sort((a, b) => b.at - a.at);
    this.layOut(s.record);
    this.fillJar(all.slice(0, STICKS));
    this.hovered = null;
    this.tip.classList.add('hidden');
  }
}
