import type { FishSpec } from './fish';

// Where a fish NFT's metadata lives: our own server (sensor/nft-meta.mjs) generates the Metaplex
// JSON and the card art from the URL path alone, so nothing is uploaded and the URI keeps
// resolving across restarts. This module only builds paths; keep the grammar in step with
// sensor/nft-meta.mjs (game/tests/nft-uri.test.mjs checks the round trip).
//
//   /api/nft/meta/v1/<id>/<rarity>/<depth>-<value>-<lengthCm>-<weightKg>/<look>/<zone>/<name>.json
//   /api/nft/img/v1/<id>/<rarity>/<look>/<species>.png
//   look = <archetype>-<hue>-<sat%>-<light%>-<accentHue>-<stripes>

/** The deployed game, which serves /api/nft. Minted URIs point here unless the game runs on another public https origin. */
export const DEFAULT_NFT_ORIGIN = 'https://breathless.gotclass.xyz';

const LOCAL_HOST =
  /^(localhost|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[[0-9a-f:]+\])$|\.(localhost|local|test)$/i;

/**
 * The origin minted URIs use: an explicit setting (VITE_NFT_ORIGIN, not a secret), else the page's
 * own origin when it is public https, else the deployed game. Never localhost or a LAN address,
 * since wallets and explorers must be able to fetch it.
 */
export function nftOrigin(configured?: string, page?: Pick<Location, 'protocol' | 'hostname' | 'origin'>): string {
  const set = configured?.trim().replace(/\/+$/, '');
  if (set) return set;
  if (page && page.protocol === 'https:' && !LOCAL_HOST.test(page.hostname)) return page.origin;
  return DEFAULT_NFT_ORIGIN;
}

/** What the chain records for a fish, so the JSON agrees with its on-chain Attributes. */
export interface NftFacts {
  depthM: number;
  value: number;
  zone: string;
}

type LookFields = Pick<FishSpec, 'archetype' | 'hue' | 'sat' | 'light' | 'accentHue' | 'stripes'>;

const deg = (x: number) => Math.round(((x % 360) + 360) % 360) % 360;
const pct = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 100);
const nat = (x: number, max: number) => Math.min(max, Math.max(0, Math.round(Number(x) || 0)));
const clip = (s: string) => s.trim().slice(0, 64).trim();
const text = (s: string) => encodeURIComponent(clip(s));

/** The fish's colours and shape, enough for the server to redraw its mesh. */
export function fishLook(spec: LookFields): string {
  return [spec.archetype, deg(spec.hue), pct(spec.sat), pct(spec.light), deg(spec.accentHue), nat(spec.stripes, 9)].join('-');
}

export function fishMetaPath(spec: FishSpec, facts: NftFacts): string {
  const weight = String(Math.max(0, +Number(spec.weightKg || 0).toFixed(2)));
  const stats = [nat(facts.depthM, 1000), nat(facts.value, 1_000_000), nat(spec.lengthCm, 100_000), weight].join('-');
  return `/api/nft/meta/v1/${spec.id}/${spec.rarity}/${stats}/${fishLook(spec)}/${text(facts.zone)}/${text(spec.name)}.json`;
}

/** Species from a fish name: names are "<Epithet> <Species>" (fish.ts rollFish). */
const speciesOf = (name: string) => clip(name).split(' ').slice(1).join(' ') || clip(name);

export function fishImagePath(spec: FishSpec): string {
  return `/api/nft/img/v1/${spec.id}/${spec.rarity}/${fishLook(spec)}/${encodeURIComponent(speciesOf(spec.name))}.png`;
}

/** True if a URI is already served by an NFT metadata host like ours (any origin). */
export const isHostedMetaUri = (uri: string) => uri.includes('/api/nft/meta/');
