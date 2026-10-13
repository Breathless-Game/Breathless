import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Vercel runs Node 24 without require(esm). @solana/web3.js -> rpc-websockets (CommonJS) requires uuid,
// so the uuid rpc-websockets resolves must still ship a CommonJS build. uuid >= 12 is ESM-only and made
// every /api/market/* call answer 503 (ERR_REQUIRE_ESM). The root package.json pins it with "overrides".
// This reads the ROOT lockfile (what Vercel's `npm ci` installs), so it is offline and deterministic.

test('root lockfile: the uuid that rpc-websockets requires is not ESM-only', () => {
  const root = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')).packages;
  assert.deepEqual(root.overrides?.['rpc-websockets'], { uuid: '11.1.1' }, 'the uuid override is in the root package.json');
  const uuid = lock['node_modules/rpc-websockets/node_modules/uuid'] ?? lock['node_modules/uuid'];
  assert.ok(uuid, 'a uuid is installed for rpc-websockets');
  const major = Number(uuid.version.split('.')[0]);
  assert.ok(major <= 11, `uuid ${uuid.version} must still have a CommonJS build (ESM-only from 12)`);
});
