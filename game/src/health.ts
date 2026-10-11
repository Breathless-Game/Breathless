import type { BreathMode, BreathState } from './breath';
import { storageKey } from './wallet';
import { clearAllHealthData } from './wallet-storage';

// Quietly records every dive: how long you held your breath, how your heart
// rate moved while you did, and how fast it came back afterwards. Nothing is
// shown until the player asks for a report. Data stays in this browser, per wallet.

export type DiveOutcome = 'banked' | 'surfaced' | 'blackout';

export interface DiveRecord {
  at: number; // epoch ms when the dive started
  holdMs: number; // longest continuous breath hold during the dive
  durationMs: number; // time spent underwater
  maxDepth: number;
  outcome: DiveOutcome;
  fish: number;
  source: BreathMode;
  restPulse: number | null; // median bpm in the 30 s before the dive
  restRate: number | null; // breaths/min before the dive
  minPulse: number | null;
  peakPulse: number | null;
  pulse: [number, number][]; // [seconds since dive start, bpm], ~1 Hz
  recoveryS: number | null; // seconds after surfacing until bpm is back near rest
  /** Sharks were in the water: the chase drives the pulse, so the report leaves this dive out of its heart-rate figures. */
  shark?: true;
}

const KEY = 'deepbreath.health';
const MAX_RECORDS = 300;
const PRE_WINDOW_MS = 30_000;
const RECOVERY_TIMEOUT_MS = 90_000;
const RECOVERY_MARGIN_BPM = 6;
const RECOVERY_STABLE_MS = 5000;

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export class HealthLog {
  readonly dives: DiveRecord[] = load();
  private recent: { t: number; bpm: number | null; rate: number | null }[] = [];
  private lastSample = 0;
  private current: (DiveRecord & { t0: number }) | null = null;
  private recovering: { rec: DiveRecord; t0: number; inBandSince: number | null } | null = null;
  /** Set while sharks hunt the diver (main.ts): any dive it is set during is marked. */
  sharks = false;

  /** Call every frame. `diving` is true while the diver is underwater in play. */
  tick(now: number, s: BreathState, depth: number, diving: boolean) {
    if (diving && !this.current) this.begin(now, s.mode);
    const cur = this.current;
    if (cur) {
      cur.maxDepth = Math.max(cur.maxDepth, Math.round(depth));
      cur.holdMs = Math.max(cur.holdMs, s.holdMs);
      if (this.sharks) cur.shark = true;
    }
    if (now - this.lastSample < 1000) return;
    this.lastSample = now;

    this.recent.push({ t: now, bpm: s.pulse, rate: s.holding ? null : s.rate });
    while (this.recent.length && now - this.recent[0].t > PRE_WINDOW_MS) this.recent.shift();

    if (cur && s.pulse != null) cur.pulse.push([Math.round((now - cur.t0) / 100) / 10, Math.round(s.pulse)]);

    const r = this.recovering;
    if (r && !cur) {
      const rest = r.rec.restPulse;
      if (rest == null || now - r.t0 > RECOVERY_TIMEOUT_MS) {
        this.recovering = null;
      } else if (s.pulse != null) {
        // Recovered once the pulse settles back near rest and stays there.
        if (Math.abs(s.pulse - rest) > RECOVERY_MARGIN_BPM) r.inBandSince = null;
        else if (r.inBandSince == null) r.inBandSince = now;
        else if (now - r.inBandSince >= RECOVERY_STABLE_MS) {
          r.rec.recoveryS = Math.round((r.inBandSince - r.t0) / 1000);
          this.recovering = null;
          this.save();
        }
      }
    }
  }

  private begin(now: number, source: BreathMode) {
    const bpms = this.recent.map((r) => r.bpm).filter((v): v is number => v != null);
    const rates = this.recent.map((r) => r.rate).filter((v): v is number => v != null && v > 0);
    this.recovering = null;
    this.current = {
      t0: now,
      at: Date.now(),
      holdMs: 0,
      durationMs: 0,
      maxDepth: 0,
      outcome: 'surfaced',
      fish: 0,
      source,
      restPulse: median(bpms),
      restRate: median(rates),
      minPulse: null,
      peakPulse: null,
      pulse: [],
      recoveryS: null,
    };
  }

  /** Close the open dive, if any. Safe to call every frame at the surface. */
  end(now: number, outcome: DiveOutcome, fish: number) {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    const { t0, ...rec } = cur;
    rec.durationMs = now - t0;
    rec.outcome = outcome;
    rec.fish = fish;
    const bpms = rec.pulse.map(([, b]) => b);
    rec.minPulse = bpms.length ? Math.min(...bpms) : null;
    rec.peakPulse = bpms.length ? Math.max(...bpms) : null;
    // Ignore accidental dips below the surface line.
    if (rec.durationMs < 1500) return;
    this.dives.push(rec);
    if (this.dives.length > MAX_RECORDS) this.dives.splice(0, this.dives.length - MAX_RECORDS);
    this.recovering = { rec, t0: now, inBandSince: null };
    this.save();
  }

  clear() {
    this.dives.length = 0;
    this.current = null;
    this.recovering = null;
    try {
      localStorage.removeItem(storageKey(KEY));
    } catch {}
    clearAllHealthData(); // every wallet's records on this device, and the legacy unscoped ones
  }

  /** Swap in the connected wallet's records. */
  reload() {
    this.dives.splice(0, this.dives.length, ...load());
    this.current = null;
    this.recovering = null;
  }

  private save() {
    try {
      localStorage.setItem(storageKey(KEY), JSON.stringify(this.dives));
    } catch {}
  }
}

function load(): DiveRecord[] {
  try {
    return JSON.parse(localStorage.getItem(storageKey(KEY)) ?? '[]');
  } catch {
    return [];
  }
}
