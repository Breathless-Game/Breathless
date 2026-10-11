import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

// The UI shows one language at a time (src/i18n.ts). These guard against the old
// side-by-side "English · 中文" text creeping back into player-facing strings.
// "·" on its own is fine: it is also a plain separator ("Chapter III · Hard", "6 条鱼 · 2.4 m").

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

const HAN_RE = /[\u4e00-\u9fff]/u;
// Names, keys and units that read the same in both languages.
const NEUTRAL = /\b(Presage|SmartSpectra|PEARL|Pearls?|Phantom|Solana|NFTs?|Shift|Tab|Esc|Enter|Space|WASD|HOLDING|Lv\d*|MAX|PNG|devnet)\b/g;
const isEnglish = (seg) => !HAN_RE.test(seg) && /[A-Za-z]{3,}/.test(seg.replace(NEUTRAL, ''));
/**
 * True for side-by-side text: one " · " (or " / ") part in English next to one in Chinese
 * ("Dive · 下潜", "FIELD NOTES / 入场记录"). Interpolations and tags are dropped first.
 */
function isPair(text) {
  return text
    .replace(/\$\{[^}]*\}/g, ' ')
    .split(/<[^>]*>/)
    .some((piece) => {
      const segs = piece.split(/\s[·/]\s/);
      for (let i = 1; i < segs.length; i++) {
        const [a, b] = [segs[i - 1], segs[i]];
        if ((isEnglish(a) && HAN_RE.test(b)) || (HAN_RE.test(a) && isEnglish(b))) return true;
      }
      return false;
    });
}

// Dev-only pages and previews keep their mixed labels.
const DEV = /(^showcase|-preview|^asset-library|^events-lab|^title-fish-legacy|^i18n)\.ts$/;

test('the guard regex tells pairs from plain separators', () => {
  for (const s of ['Dive · 下潜', 'FIELD NOTES · 入场记录', '合成箱 · Upgrades', 'Aquarium ambience / 鱼缸氛围灯']) assert.ok(isPair(s), s);
  for (const s of ['Chapter III · Hard · Shelf 62 m', '6 条鱼 · 2.4 m 捕捞范围', 'Morning · 09:00', '松开 Tab 确认 · 方向键 / Q E 选择', 'Presage · 传感器离线', '${stats.netCapacity} 条容量 · ${r} m 捕捞范围'])
    assert.ok(!isPair(s), s);
});

test('index.html: no bilingual text, and Chinese only in data-zh attributes', async () => {
  const html = await read('index.html');
  // The brand logo (屏息 / BREATHLESS), the tab title, and the language picker's own 中文 option stay.
  const allowed = new Set(['屏息', '屏息 Breathless', '中文']);
  const body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s[\w-]+="[^"]*"/g, '') // attributes (data-zh*, aria-label, title…) checked below
    .replace(/<[^>]+>/g, '\n');
  for (const line of body.split('\n').map((l) => l.trim()).filter(Boolean)) {
    assert.ok(!isPair(line), `bilingual text in index.html: ${line}`);
    if (HAN_RE.test(line)) assert.ok(allowed.has(line), `Chinese outside data-zh in index.html: ${line}`);
  }
  for (const m of html.matchAll(/\s(aria-label|title|placeholder)="([^"]*)"/g)) {
    assert.ok(!isPair(m[2]) && !HAN_RE.test(m[2]) || m[2] === '屏息 Breathless', `bilingual ${m[1]}: ${m[2]}`);
  }
});

test('index.html: data-zh elements hold no id-ed children (their content is replaced)', async () => {
  const html = await read('index.html');
  for (const m of html.matchAll(/<(\w+)[^>]*\sdata-zh(?:-html)?="[^"]*"[^>]*>([\s\S]*?)<\/\1>/g)) {
    assert.ok(!/\sid="/.test(m[2]), `data-zh element wraps an id: ${m[0].slice(0, 120)}`);
  }
});

test('src: no "English · 中文" pairs inside one string literal', async () => {
  const dir = new URL('src/', root);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.ts') && !DEV.test(f));
  const hits = [];
  for (const file of files) {
    const lines = (await readFile(new URL(file, dir), 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments
      const code = line.replace(/\/\/ .*$/, '');
      for (const m of code.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
        const lit = m[1] ?? m[2] ?? m[3] ?? '';
        // Code between two template literals (a `${t('…', '…')}` call), not a literal itself.
        if (/\bt\(['`]/.test(lit)) continue;
        if (isPair(lit)) hits.push(`${file}:${i + 1}: ${lit}`);
      }
    });
  }
  assert.deepEqual(hits, []);
});
