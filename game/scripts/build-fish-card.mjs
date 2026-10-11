// Bundles game/src/fish-card-geometry.ts (with fish.ts, marine.ts and three.js) into
// sensor/fish-card.gen.mjs, so the server draws NFT images from the game's own fish code. The Dell
// only receives sensor/ and game/dist/, so the bundle is committed; game/tests/fish-card.test.mjs
// fails (and blocks the deploy) when it is stale.
//
//   npm --prefix game run build:fish-card
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
export const OUTFILE = new URL('../../sensor/fish-card.gen.mjs', import.meta.url);

const BANNER = `// GENERATED from game/src/fish-card-geometry.ts by game/scripts/build-fish-card.mjs. Do not edit:
// change the game's fish code and run \`npm --prefix game run build:fish-card\`.`;

/** The bundle's text. Deterministic for a given source tree and esbuild version (game's lockfile). */
export async function bundleFishCard() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['game/src/fish-card-geometry.ts'],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    banner: { js: BANNER },
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = await bundleFishCard();
  await writeFile(OUTFILE, text);
  console.log(`wrote sensor/fish-card.gen.mjs (${(text.length / 1024).toFixed(0)} KiB)`);
}
