// Metadata host for the player's gear NFTs: the Boat and the Dive Kit (game/src/gear-nft.ts). Like
// the fish (nft-meta.mjs), everything is generated from the URL path, which encodes every level, so
// nothing is stored and a URI on chain keeps resolving. The game updates the asset's URI whenever
// its levels change, so explorers that read the JSON always show the current levels.
//
//   GET /api/nft/gear/v1/boat/<ship>/<bait>-<boat>-<boatSpeed>-<boatHull>-<boatDeck>.json   Metaplex JSON
//   GET /api/nft/gear/v1/boat/<ship>/<...same...>.svg                                       512x512 card
//   GET /api/nft/gear/v1/kit/<rod>-<reel>-<net>-<fins>-<tank>-<lamp>-<sonar>/<branches>.json
//   GET /api/nft/gear/v1/kit/<...same...>.svg
//
//   ship     0-5 (the shipyard's ships)
//   levels   1-3 each
//   branches <rod>-<net>-<fins>-<tank>-<lamp>-<reel>, each one of that piece's two branch ids
//
// Every segment is checked against an allowlist; anything else is a 400. Mount it BEFORE
// createNftHandler, which answers every other /api/nft/ path with a 404:
//   `if (await gear(req, res)) return;`
// game/tests/gear-nft.test.mjs checks the game's path builder against this parser.

import { originFor } from './nft-meta.mjs';

const PREFIX = '/api/nft/gear/v1/';
const SYMBOL = 'DIVE';

export const SHIP_NAMES = ['Homeward', 'First Tide', 'Twin Cast', 'Echo Scout', 'Ocean Vanguard', 'Abyss Atlas'];
export const BOAT_IDS = ['bait', 'boat', 'boatSpeed', 'boatHull', 'boatDeck'];
export const KIT_IDS = ['rod', 'reel', 'net', 'fins', 'tank', 'lamp', 'sonar'];
export const BRANCH_SLOTS = ['rod', 'net', 'fins', 'tank', 'lamp', 'reel'];
export const BRANCHES = {
  rod: ['far', 'fast'],
  net: ['wide', 'fine'],
  fins: ['sprint', 'silent'],
  tank: ['long', 'light'],
  lamp: ['focus', 'wideLamp'],
  reel: ['fastReel', 'silentReel'],
};

const LABELS = {
  bait: 'Bait',
  boat: 'Boat',
  boatSpeed: 'Engine',
  boatHull: 'Hull',
  boatDeck: 'Fishing deck',
  rod: 'Net shaft',
  reel: 'Recovery reel',
  net: 'Net',
  fins: 'Fins',
  tank: 'Emergency tank',
  lamp: 'Headlamp',
  sonar: 'Deep sonar',
};
const BRANCH_LABELS = {
  far: 'Long reach',
  fast: 'Quick handling',
  wide: 'Wide mouth',
  fine: 'Fine mesh',
  sprint: 'Sprint fins',
  silent: 'Steady fins',
  long: 'Long reserve',
  light: 'Light rig',
  focus: 'Long focus',
  wideLamp: 'Wide diffuser',
  fastReel: 'Fast reel',
  silentReel: 'Measured reel',
};

const level = (s) => (/^[1-3]$/.test(s) ? Number(s) : null);

/** Levels joined by '-', exactly `ids.length` of them, each 1-3; null otherwise. */
function levels(segment, ids) {
  const parts = segment.split('-');
  if (parts.length !== ids.length) return null;
  const out = {};
  for (let i = 0; i < ids.length; i++) {
    const n = level(parts[i]);
    if (n === null) return null;
    out[ids[i]] = n;
  }
  return out;
}

/**
 * Parse a gear path (without the query). Returns { kind, ext, ...levels } or null unless every
 * segment is exactly one of the allowed values.
 */
export function parseGearPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(PREFIX)) return null;
  const m = /^(.*)\.(json|svg)$/.exec(pathname.slice(PREFIX.length));
  if (!m) return null;
  const [, rest, ext] = m;
  const parts = rest.split('/');
  if (parts[0] === 'boat' && parts.length === 3) {
    if (!/^[0-5]$/.test(parts[1])) return null;
    const lv = levels(parts[2], BOAT_IDS);
    return lv && { kind: 'boat', ext, ship: Number(parts[1]), ...lv };
  }
  if (parts[0] === 'kit' && parts.length === 3) {
    const lv = levels(parts[1], KIT_IDS);
    const names = parts[2].split('-');
    if (!lv || names.length !== BRANCH_SLOTS.length) return null;
    const branches = {};
    for (let i = 0; i < BRANCH_SLOTS.length; i++) {
      const slot = BRANCH_SLOTS[i];
      if (!BRANCHES[slot].includes(names[i])) return null;
      // Below Lv2 a piece runs its default branch; the game never writes anything else there.
      if (lv[slot] < 2 && names[i] !== BRANCHES[slot][0]) return null;
      branches[slot] = names[i];
    }
    return { kind: 'kit', ext, ...lv, branches };
  }
  return null;
}

/** The path stem (no extension) for parsed gear: the same one the game builds. */
export function gearStem(g) {
  if (g.kind === 'boat') return `${PREFIX}boat/${g.ship}/${BOAT_IDS.map((id) => g[id]).join('-')}`;
  return `${PREFIX}kit/${KIT_IDS.map((id) => g[id]).join('-')}/${BRANCH_SLOTS.map((s) => g.branches[s]).join('-')}`;
}

const NAMES = { boat: 'Breathless Boat', kit: 'Breathless Dive Kit' };

/** The rows a card and the JSON show: [label, value]. */
function rows(g) {
  if (g.kind === 'boat') return [['Ship', SHIP_NAMES[g.ship]], ...BOAT_IDS.map((id) => [LABELS[id], `Lv ${g[id]}`])];
  return KIT_IDS.map((id) => {
    const slot = BRANCH_SLOTS.includes(id) && g[id] >= 2 ? ` · ${BRANCH_LABELS[g.branches[id]]}` : '';
    return [LABELS[id], `Lv ${g[id]}${slot}`];
  });
}

/** Standard Metaplex JSON for parsed gear. */
export function gearMetadataJson(g, origin) {
  const image = `${origin}${gearStem(g)}.svg`;
  const attributes =
    g.kind === 'boat'
      ? [{ trait_type: 'Ship', value: SHIP_NAMES[g.ship] }, ...BOAT_IDS.map((id) => ({ trait_type: LABELS[id], value: g[id] }))]
      : [
          ...KIT_IDS.map((id) => ({ trait_type: LABELS[id], value: g[id] })),
          ...BRANCH_SLOTS.map((s) => ({ trait_type: `${LABELS[s]} branch`, value: BRANCH_LABELS[g.branches[s]] })),
        ];
  return {
    name: NAMES[g.kind],
    symbol: SYMBOL,
    description:
      g.kind === 'boat'
        ? `The player's boat in Breathless: the ${SHIP_NAMES[g.ship]} and its upgrades. The game keeps these levels in step as the player upgrades.`
        : "The player's dive kit in Breathless: every piece of dive gear and its level. The game keeps these levels in step as the player upgrades.",
    image,
    external_url: origin,
    attributes,
    properties: { category: 'image', files: [{ uri: image, type: 'image/svg+xml' }] },
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A 512x512 SVG card listing the levels as pips. Every string in it comes from the tables above. */
export function gearSvg(g) {
  const list = rows(g);
  const accent = g.kind === 'boat' ? '#ffcc4d' : '#3ef0a8';
  const top = 160;
  const step = 46;
  const body = list
    .map(([label, value], i) => {
      const y = top + i * step;
      const n = /^Lv (\d)/.exec(value)?.[1];
      const pips = n
        ? [1, 2, 3].map((k) => `<rect x="${380 + (k - 1) * 30}" y="${y - 14}" width="22" height="14" rx="4" fill="${k <= Number(n) ? accent : 'rgba(255,255,255,0.14)'}"/>`).join('')
        : '';
      const sub = n ? value.replace(/^Lv \d( · )?/, '') : value;
      return (
        `<text x="40" y="${y}" class="l">${esc(label)}</text>` +
        (sub ? `<text x="${n ? 200 : 372}" y="${y}" class="v"${n ? '' : ' text-anchor="end"'}>${esc(sub)}</text>` : '') +
        pips
      );
    })
    .join('');
  const ship = g.kind === 'boat' ? `<text x="472" y="${top}" class="v" text-anchor="end">${g.ship + 1} / 6</text>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b3350"/><stop offset="1" stop-color="#04121f"/></linearGradient></defs>` +
    `<style>text{font-family:Inter,Helvetica,Arial,sans-serif;fill:#eaf8ff}.t{font-size:34px;font-weight:800}.s{font-size:15px;fill:rgba(234,248,255,0.6);letter-spacing:2px}.l{font-size:19px;font-weight:700}.v{font-size:15px;fill:rgba(234,248,255,0.75)}</style>` +
    `<rect width="512" height="512" fill="url(#bg)"/>` +
    `<rect x="10" y="10" width="492" height="492" rx="26" fill="none" stroke="${accent}" stroke-opacity="0.7" stroke-width="3"/>` +
    `<text x="40" y="66" class="s">BREATHLESS · ${g.kind === 'boat' ? 'BOAT' : 'DIVE KIT'}</text>` +
    `<text x="40" y="104" class="t">${g.kind === 'boat' ? esc(SHIP_NAMES[g.ship]) : 'Dive Kit'}</text>` +
    ship +
    body +
    `<text x="40" y="482" class="s">LEVELS ON CHAIN · DEVNET</text>` +
    `</svg>`
  );
}

/**
 * Mount on an http server before createNftHandler: `if (await gear(req, res)) return;`. Answers
 * everything under /api/nft/gear/ and returns false for anything else.
 */
export function createGearHandler({ publicOrigin = process.env.PUBLIC_ORIGIN, cdnCache = null } = {}) {
  function send(req, res, status, type, body, cache) {
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': cache,
      // Explorers fetch the JSON and the image from the browser.
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      // The SVG is an image: no scripts, nothing loaded from elsewhere, even if opened directly.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      // Vercel only, as in nft-meta.mjs: its CDN's own lifetime, never sent on to the browser.
      ...(cdnCache && status === 200 ? { 'Vercel-CDN-Cache-Control': cdnCache } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }
  const json = (req, res, status, obj, cache = 'no-store') =>
    send(req, res, status, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(obj)), cache);

  return async function handle(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      return false;
    }
    if (!pathname.startsWith('/api/nft/gear/')) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      json(req, res, 405, { error: 'Method not allowed' });
      return true;
    }
    const g = parseGearPath(pathname);
    if (!g) json(req, res, 400, { error: 'Bad gear NFT path' });
    // A path names one exact set of levels, so its answer never changes: cache it like the fish.
    else if (g.ext === 'json') json(req, res, 200, gearMetadataJson(g, originFor(req, publicOrigin)), 'public, max-age=86400');
    else send(req, res, 200, 'image/svg+xml; charset=utf-8', Buffer.from(gearSvg(g)), 'public, max-age=604800');
    return true;
  };
}
