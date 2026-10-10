// Records game/showcase.html into docs/showcase.gif (the README hero). Steps the loop one
// frame at a time in headless Chrome, so the GIF is the same on any machine and loops cleanly.
// Needs the game dev server running (npm run game), Chrome, and ffmpeg on PATH.
//
//   node scripts/capture-showcase.mjs [--url=http://localhost:5173/showcase.html]
//                                     [--width=800] [--fps=12.5] [--out=docs/showcase.gif]
//                                     [--frames=<dir to keep the PNGs in>]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const url = new URL(args.url ?? 'http://localhost:5173/showcase.html');
url.searchParams.set('capture', '1');
const width = Number(args.width ?? 800);
const height = Math.round(width / 1.6);
const fps = Number(args.fps ?? 12.5); // GIF delays are whole centiseconds: 12.5 fps is exactly 8
const out = resolve(args.out ?? join(root, 'docs/showcase.gif'));

const chrome =
  process.env.CHROME_PATH ??
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find(existsSync);
if (!chrome) throw new Error('Chrome not found. Set CHROME_PATH to its executable.');

const work = mkdtempSync(join(tmpdir(), 'showcase-'));
const frameDir = args.frames ? resolve(args.frames) : join(work, 'frames');
mkdirSync(frameDir, { recursive: true });
mkdirSync(dirname(out), { recursive: true });

const browser = spawn(chrome, [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${join(work, 'profile')}`,
  `--window-size=${width},${height}`,
  '--force-device-scale-factor=1',
  '--hide-scrollbars',
  '--no-first-run',
  '--ignore-gpu-blocklist',
  'about:blank',
]);

try {
  // Chrome prints the port it picked on stderr.
  const port = await new Promise((ok, fail) => {
    let log = '';
    browser.stderr.on('data', (chunk) => {
      log += chunk;
      const found = log.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (found) ok(found[1]);
    });
    browser.on('exit', (code) => fail(new Error(`Chrome exited (${code}) before it was ready:\n${log}`)));
  });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');

  // Node 22+ has WebSocket built in; on Node 20 borrow the sensor's copy of `ws`.
  const WS = globalThis.WebSocket ?? createRequire(join(root, 'sensor/package.json'))('ws');
  const socket = new WS(page.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    socket.addEventListener('open', ok);
    socket.addEventListener('error', () => fail(new Error('Could not reach Chrome DevTools')));
  });
  const pending = new Map();
  let lastId = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.fail(new Error(message.error.message));
    else waiter.ok(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      pending.set(++lastId, { ok, fail });
      socket.send(JSON.stringify({ id: lastId, method, params }));
    });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  };

  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: String(url) });
  const deadline = Date.now() + 30_000;
  while ((await evaluate('typeof window.showcase').catch(() => '')) !== 'object') {
    if (Date.now() > deadline) throw new Error(`${url} did not load the showcase. Is the game dev server running?`);
    await new Promise((ok) => setTimeout(ok, 200));
  }
  await evaluate('document.fonts.ready.then(() => true)');

  const frames = Math.round((await evaluate('window.showcase.loopSeconds')) * fps);
  for (let i = 0; i < frames; i++) {
    await evaluate(`window.showcase.seek(${i / frames})`);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(frameDir, `${String(i).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
    process.stdout.write(`\rframe ${i + 1}/${frames}`);
  }
  process.stdout.write('\n');
  socket.close();

  // One palette for the whole clip, built from what changes between frames.
  const filter = 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';
  const encode = spawnSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(frameDir, '%04d.png'), '-vf', filter, '-loop', '0', out],
    { stdio: 'inherit' },
  );
  if (encode.error) throw new Error(`Could not run ffmpeg: ${encode.error.message}`);
  if (encode.status !== 0) throw new Error(`ffmpeg failed (${encode.status})`);
  console.log(`wrote ${out}`);
} finally {
  browser.kill();
  // Chrome can still be flushing its profile for a moment after it is killed.
  await new Promise((ok) => setTimeout(ok, 300));
  rmSync(work, { recursive: true, force: true, maxRetries: 3 });
}
