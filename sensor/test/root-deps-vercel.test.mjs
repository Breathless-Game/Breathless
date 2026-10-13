import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import test from 'node:test';

// Vercel installs only the ROOT package.json (`npm ci` in vercel.json), never sensor/package.json. A package
// that sensor/ imports on the /api path but that is missing from the root deps loads fine on the Dell and in
// these tests, and throws on Vercel. That is how the PEARL mint was created without an image: the dynamic
// import('@metaplex-foundation/umi-uploader-irys') failed, was caught, and the metadata uri was left empty.
// This follows every relative import (static and dynamic) from api/index.mjs and checks each package it reaches.

const ROOT = new URL('../../', import.meta.url);
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g;
const pkgName = (spec) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');

function vercelImports() {
  const seen = new Set();
  const packages = new Map(); // package -> first file that imports it
  const walk = (url) => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const file = url.href.slice(ROOT.href.length);
    for (const [, , spec] of readFileSync(url, 'utf8').matchAll(SPEC)) {
      if (spec.startsWith('.')) walk(new URL(spec, url));
      else if (!spec.startsWith('node:') && !builtinModules.includes(spec)) {
        if (!packages.has(pkgName(spec))) packages.set(pkgName(spec), file);
      }
    }
  };
  walk(new URL('api/index.mjs', ROOT));
  return { files: seen, packages };
}

test('every package the Vercel function imports is a root dependency, locked for npm ci', () => {
  const root = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', ROOT), 'utf8')).packages;
  const { files, packages } = vercelImports();
  assert.ok(files.size > 10, 'the walk reached sensor/vercel-handler.mjs and the market modules');
  assert.ok(packages.has('@metaplex-foundation/umi-uploader-irys'), 'the walk sees dynamic imports (the PEARL metadata uploader)');
  for (const [name, file] of packages) {
    assert.ok(root.dependencies?.[name], `${name} (imported by ${file}) must be in the root package.json dependencies`);
    assert.ok(lock[`node_modules/${name}`], `${name} must be in the root package-lock.json (run npm install at the root)`);
    assert.equal(lock[''].dependencies?.[name], root.dependencies[name], `the root lockfile is stale for ${name}`);
  }
});
