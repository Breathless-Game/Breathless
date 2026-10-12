#!/usr/bin/env node
// The installers are public downloads: make sure the packed app holds the desktop app's own
// files and nothing else (no sensor/, contracts/, game/, .env, keys, recordings...).
//
//   node scripts/check-package.mjs [dist]      (npm run check-package)
//
// Looks at every app.asar under the folder (mac-arm64/, mac/, win-unpacked/, linux-unpacked/)
// and fails if one has a file outside the whitelist, or if anything in the unpacked app,
// asar or not, has a secret-looking name. Exit code 1 on any problem.
import { getRawHeader, listPackage } from '@electron/asar';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Keep in step with "build.files" in package.json.
const ALLOWED = [
  /^package\.json$/,
  /^src\/[\w.-]+\.(js|html)$/,
];
// Names that must never ship, wherever they are.
const SECRET = [
  /(^|\/)\.env($|[.\/])/i,
  /keypair/i,
  /(^|\/)\.keys?(\/|$)/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)/i,
  /(^|\/)\.market-/i,
  /(^|\/)recordings(\/|$)/i,
  /(^|\/)(sensor|contracts|game)\//,
  /secret/i,
];

const root = path.resolve(process.argv[2] || 'dist');
if (!existsSync(root)) {
  console.error(`check-package: ${root} does not exist; build first (npm run pack).`);
  process.exit(1);
}

const problems = [];
const asars = [];
let scanned = 0;

// Walk everything once: collect app.asar files and flag secret-looking names on disk
// (app.asar.unpacked, a stray app/ folder, extra resources).
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      // Electron's own framework bundles: nothing of ours lives there.
      if (entry.name.endsWith('.framework') || entry.name === 'locales') continue;
      if (entry.name === 'app' && path.basename(dir) === 'resources') problems.push(`unpacked app folder (asar is off?): ${rel}`);
      walk(full);
      continue;
    }
    scanned++;
    if (entry.name === 'app.asar') asars.push(full);
    if (SECRET.some((re) => re.test(rel))) problems.push(`secret-looking file: ${rel}`);
  }
}
walk(root);

if (asars.length === 0) problems.push(`no app.asar under ${root}; build with electron-builder --dir first`);

// listPackage returns directories too: tell them apart through the archive header.
function isDirectory(header, rel) {
  let node = header;
  for (const part of rel.split('/').filter(Boolean)) node = node && node.files ? node.files[part] : undefined;
  return !!(node && node.files);
}

for (const asar of asars) {
  const label = path.relative(root, asar);
  const { header } = getRawHeader(asar);
  const files = listPackage(asar, { isPack: false })
    .map((p) => p.replace(/\\/g, '/').replace(/^\//, ''))
    .filter((p) => !isDirectory(header, p));
  console.log(`${label}: ${files.length} files`);
  for (const file of files) {
    console.log(`  ${file}`);
    if (!ALLOWED.some((re) => re.test(file))) problems.push(`${label}: not in whitelist: ${file}`);
    if (SECRET.some((re) => re.test(file))) problems.push(`${label}: secret-looking file: ${file}`);
  }
  if (!files.includes('src/main.js')) problems.push(`${label}: src/main.js missing`);
  // Anything unpacked next to the archive must be checked too.
  const unpacked = `${asar}.unpacked`;
  if (existsSync(unpacked) && statSync(unpacked).isDirectory()) problems.push(`${label}.unpacked exists; nothing should be unpacked`);
}

console.log(`check-package: scanned ${scanned} files, ${asars.length} app.asar`);
if (problems.length) {
  console.error('check-package: FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('check-package: OK');
