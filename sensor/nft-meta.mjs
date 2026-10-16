// NFT metadata host: the Metaplex JSON and the card art for fish NFTs, generated from the URL
// alone. No storage, so the URIs minted on chain resolve as long as this server runs, across
// restarts and redeploys. Serve mode (index.mjs) and the dev market (market-server.mjs) mount it.
//
//   GET /api/nft/meta/v2/<serial>/<id>/<rarity>/<stats>/<look>/<zone>/<name>.json   Metaplex JSON
//   GET /api/nft/img/v2/<serial>/<id>/<rarity>/<look>/<species>.png                 512x512 PNG
//
//   serial = the fish's number (nft-serial.mjs), 1-9 digits; the JSON name is "<name> #0042"
//   stats  = <depthM>-<value>-<lengthCm>-<weightKg>
//   look   = <archetype>-<hue>-<sat%>-<light%>-<accentHue>-<stripes>[-<gene>]
//   gene   = the fish's shape gene (game/src/fish.ts geneOf), exactly 16 lowercase hex digits. Fish
//            minted before random shapes have six fields: no gene, the species' standard shape.
//   zone, name, species: encodeURIComponent'd
//
// v1 is the same without <serial>: fish minted before numbering. Those URIs are on chain, so v1
// must keep resolving.
//
// game/src/nft-uri.ts builds these paths; keep the two in step (game/tests/nft-uri.test.mjs checks).
// The JSON's image URL uses PUBLIC_ORIGIN when set, else the request's Host (a tunnel or proxy
// passes the public hostname through), else DEFAULT_ORIGIN.

import { ARCHETYPES, CARD_RENDER_VERSION, RARITIES, renderFishPng } from './fish-png.mjs';

export const DEFAULT_ORIGIN = 'https://breathless.gotclass.xyz';
const SYMBOL = 'DIVE';
const META = '/api/nft/meta/';
const IMG = '/api/nft/img/';
const MAX_TEXT = 64;
const PNG_CACHE = 256;
// Each new image is ~0.1 s of CPU on the box that also runs the breath sensor. Cached images (here
// and at Cloudflare, which caches .png) don't count, so this only bites a flood of unique URLs.
const RENDERS_PER_MINUTE = 40;

const int = (s, max) => (/^\d{1,7}$/.test(s) && Number(s) <= max ? Number(s) : null);
/** A shape gene: canonical only (16 lowercase hex digits), returned as the same string. */
const gene = (s) => (/^[0-9a-f]{16}$/.test(s) ? s : null);
const num = (s, max) => (/^\d{1,7}(\.\d{1,3})?$/.test(s) && Number(s) <= max ? Number(s) : null);

function text(s) {
  try {
    const t = decodeURIComponent(s).trim();
    // Printable only: no control characters, nothing that could pass for markup.
    return t && t.length <= MAX_TEXT && !/[\u0000-\u001f\u007f<>]/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/** The look segment: six fields, or seven with a gene (then, and only then, a `gene` key). */
function parseLook(s) {
  const p = s.split('-');
  if ((p.length !== 6 && p.length !== 7) || !Object.hasOwn(ARCHETYPES, p[0])) return null;
  const [hue, sat, light, accentHue, stripes] = [int(p[1], 360), int(p[2], 100), int(p[3], 100), int(p[4], 360), int(p[5], 9)];
  if ([hue, sat, light, accentHue, stripes].includes(null)) return null;
  const look = { archetype: p[0], hue, sat: sat / 100, light: light / 100, accentHue, stripes };
  if (p.length === 7) {
    const g = gene(p[6]);
    if (g === null) return null;
    look.gene = g;
  }
  return look;
}

const parseId = (s) => (/^[0-9a-f]{1,16}$/.test(s) ? s : null);
const parseRarity = (s) => (Object.hasOwn(RARITIES, s) ? s : null);

/** Species from a fish name: names are "<Epithet> <Species>" (fish.ts rollFish). */
export const speciesOf = (name) => name.split(' ').slice(1).join(' ') || name;

/** A fish number: 1 to 999999999, no leading zeros in the path. */
const parseSerial = (s) => (/^[1-9]\d{0,8}$/.test(s) ? Number(s) : null);
/** "#0042": at least four digits, more when the number needs them (#10000, #1234567). game/src/nft-uri.ts formatSerial agrees. */
export const formatSerial = (serial) => `#${String(serial).padStart(4, '0')}`;

/** The path after `<prefix>v1/` or `<prefix>v2/<serial>/`, split on '/'; null for anything else. */
function versioned(pathname, prefix, ext) {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(ext)) return null;
  const parts = pathname.slice(prefix.length, -ext.length).split('/');
  const version = parts.shift();
  if (version === 'v1') return { serial: undefined, parts };
  if (version !== 'v2') return null;
  const serial = parseSerial(parts.shift() ?? '');
  return serial === null ? null : { serial, parts };
}

/** Parse a metadata path (v1, or v2 with a serial); null unless every field is well formed. */
export function parseMetaPath(pathname) {
  const v = versioned(pathname, META, '.json');
  if (!v || v.parts.length !== 6) return null;
  const [idS, rarityS, statsS, lookS, zoneS, nameS] = v.parts;
  const stats = statsS.split('-');
  if (stats.length !== 4) return null;
  const fish = {
    id: parseId(idS),
    rarity: parseRarity(rarityS),
    depthM: int(stats[0], 1000),
    value: int(stats[1], 1_000_000),
    lengthCm: int(stats[2], 100_000),
    weightKg: num(stats[3], 1_000_000),
    look: parseLook(lookS),
    lookPath: lookS,
    zone: text(zoneS),
    name: text(nameS),
  };
  if (Object.values(fish).includes(null)) return null;
  return v.serial === undefined ? fish : { ...fish, serial: v.serial };
}

/** Parse an image path (v1, or v2 with a serial); null unless every field is well formed. */
export function parseImagePath(pathname) {
  const v = versioned(pathname, IMG, '.png');
  if (!v || v.parts.length !== 4) return null;
  const { parts } = v;
  const fish = { id: parseId(parts[0]), rarity: parseRarity(parts[1]), look: parseLook(parts[2]), species: text(parts[3]) };
  if (Object.values(fish).includes(null)) return null;
  return v.serial === undefined ? fish : { ...fish, serial: v.serial };
}

const versionOf = (fish) => (fish.serial === undefined ? 'v1/' : `v2/${fish.serial}/`);

/** The image path for a parsed metadata path (game/src/nft-uri.ts fishImagePath builds the same). */
export const imagePath = (fish) =>
  `${IMG}${versionOf(fish)}${fish.id}/${fish.rarity}/${fish.lookPath}/${encodeURIComponent(speciesOf(fish.name))}.png`;

/** The origin to put in the JSON's image URL. Never a loopback address unless the request was local. */
export function originFor(req, configured = process.env.PUBLIC_ORIGIN) {
  if (configured) return configured.trim().replace(/\/+$/, '');
  const host = String(req.headers?.host ?? '').trim();
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) return DEFAULT_ORIGIN;
  const local = /^(localhost|127\.\d+\.\d+\.\d+)(:\d+)?$/i.test(host);
  return `${local ? 'http' : 'https'}://${host}`;
}

/** Standard Metaplex JSON for a parsed metadata path. */
export function metadataJson(fish, origin) {
  const species = speciesOf(fish.name);
  const label = RARITIES[fish.rarity].label;
  // ?r=<renderer version>: images are cached for a week (here, at Cloudflare, in wallets), so a
  // change to the card art moves the URL. The server ignores the query; the path alone draws it.
  const image = `${origin}${imagePath(fish)}?r=${CARD_RENDER_VERSION}`;
  const article = /^[aeiou]/i.test(label) ? 'An' : 'A';
  const numbered = fish.serial !== undefined;
  return {
    name: numbered ? `${fish.name} ${formatSerial(fish.serial)}` : fish.name,
    symbol: SYMBOL,
    description: `${article} ${label.toLowerCase()} ${species} caught ${fish.depthM} m down on a single held breath in Breathless.${numbered ? ` Fish ${formatSerial(fish.serial)}.` : ''} The art is a pure function of seed ${fish.id}.`,
    image,
    external_url: origin,
    attributes: [
      ['Rarity', label],
      ['Species', species],
      ['Zone', fish.zone],
      ['Depth (m)', String(fish.depthM)],
      ['Length (cm)', String(fish.lengthCm)],
      ['Weight (kg)', String(fish.weightKg)],
      ['Catch value', String(fish.value)],
      ['Seed', fish.id],
      ...(numbered ? [['Number', formatSerial(fish.serial)]] : []),
    ].map(([trait_type, value]) => ({ trait_type, value })),
    properties: { category: 'image', files: [{ uri: image, type: 'image/png' }] },
  };
}

/**
 * Mount on an http server: `if (await nft(req, res)) return;`. Answers everything under /api/nft/
 * (unknown paths get a JSON 404), and returns false for anything else.
 * `cdnCache`: a Vercel-CDN-Cache-Control value for the 200s (Vercel only: api/index.mjs). Vercel's
 * CDN keeps them that long and never passes the header on, so browsers and wallets see the same
 * Cache-Control as from the Dell; a new deployment starts a fresh cache (its key has the deployment).
 */
export function createNftHandler({ publicOrigin = process.env.PUBLIC_ORIGIN, log = console.log, cdnCache = null } = {}) {
  const pngs = new Map(); // path -> PNG, least recently used first
  let windowStart = 0;
  let renders = 0;

  function send(req, res, status, type, body, cache) {
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': cache,
      // Solana Explorer and other web viewers fetch the JSON and image from the browser.
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      ...(cdnCache && status === 200 ? { 'Vercel-CDN-Cache-Control': cdnCache } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }
  const json = (req, res, status, obj, cache = 'no-store') =>
    send(req, res, status, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(obj)), cache);

  function png(pathname, fish) {
    const hit = pngs.get(pathname);
    if (hit) {
      pngs.delete(pathname);
      pngs.set(pathname, hit);
      return hit;
    }
    const now = Date.now();
    if (now - windowStart > 60_000) {
      windowStart = now;
      renders = 0;
    }
    if (++renders > RENDERS_PER_MINUTE) {
      if (renders === RENDERS_PER_MINUTE + 1) log(`[nft] render limit reached (${RENDERS_PER_MINUTE}/min), answering 503 for new images`);
      return null;
    }
    const out = renderFishPng({ id: fish.id, rarity: fish.rarity, species: fish.species, look: fish.look, serial: fish.serial });
    pngs.set(pathname, out);
    if (pngs.size > PNG_CACHE) pngs.delete(pngs.keys().next().value);
    return out;
  }

  return async function handle(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      return false;
    }
    if (!pathname.startsWith('/api/nft/')) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      json(req, res, 405, { error: 'Method not allowed' });
      return true;
    }
    if (pathname.startsWith(META)) {
      const fish = parseMetaPath(pathname);
      if (!fish) json(req, res, 400, { error: 'Bad NFT metadata path' });
      else json(req, res, 200, metadataJson(fish, originFor(req, publicOrigin)), 'public, max-age=86400');
      return true;
    }
    if (pathname.startsWith(IMG)) {
      const fish = parseImagePath(pathname);
      if (!fish) {
        json(req, res, 400, { error: 'Bad NFT image path' });
        return true;
      }
      const body = png(pathname, fish);
      if (!body) {
        res.setHeader('Retry-After', '30');
        json(req, res, 503, { error: 'Busy, try again shortly' });
      } else send(req, res, 200, 'image/png', body, 'public, max-age=604800');
      return true;
    }
    json(req, res, 404, { error: 'Not found' });
    return true;
  };
}
