// Runs before the game or the sensor starts (predev / prestart in their
// package.json). A pull can bring in a new dependency; without this the dev
// server still starts and the page dies on a missing import.
//
//   node scripts/ensure-deps.mjs game sensor
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const name of process.argv.slice(2)) {
  const dir = join(root, name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const missing = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(
    (dep) => !existsSync(join(dir, 'node_modules', dep, 'package.json')),
  );
  if (!missing.length) continue;
  // `npm ci` installs exactly what the lockfile says and never rewrites it.
  const command = existsSync(join(dir, 'package-lock.json')) ? 'npm ci' : 'npm install';
  console.log(`[setup] ${name}/ is missing ${missing.join(', ')}. Running ${command}…`);
  // npm is npm.cmd on Windows, which Node only spawns through a shell.
  const result = spawnSync(command, { cwd: dir, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`[setup] ${command} failed in ${name}/. Run it by hand: npm --prefix ${name} install`);
    process.exit(result.status ?? 1);
  }
}
