// Writes a live Presage session to sensor/recordings/<time>.jsonl so the
// breath detector can be tuned offline against real data (see analyze.mjs).
// Recordings are physiological data: they are gitignored and stay local.

import { createWriteStream, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('./recordings/', import.meta.url));

export class Recorder {
  constructor(onOpen) {
    this.out = null;
    this.path = null;
    this.onOpen = onOpen;
  }

  write(obj) {
    if (!this.out) {
      mkdirSync(DIR, { recursive: true });
      this.path = `${DIR}${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
      this.out = createWriteStream(this.path, { flags: 'a' });
      this.onOpen?.(this.path);
    }
    this.out.write(`${JSON.stringify({ at: Date.now(), ...obj })}\n`);
  }

  close() {
    this.out?.end();
    this.out = null;
  }
}

const round = (v) => Math.round(v * 1e5) / 1e5;

/** Presage Measurement[] -> [[timestampUs, value, stable 0|1], ...] */
export const points = (arr) =>
  arr?.length ? arr.map((p) => [Number(p.timestamp ?? 0), round(p.value ?? NaN), p.stable ? 1 : 0]) : undefined;

/** Presage DetectionStatus[] -> [[timestampUs, 0|1], ...] */
export const flags = (arr) => (arr?.length ? arr.map((d) => [Number(d.timestamp ?? 0), d.detected ? 1 : 0]) : undefined);
