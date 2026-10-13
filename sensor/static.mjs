// Serves the built game (game/dist) for `node index.mjs --serve <dir>`.
// Vite hashes everything under /assets/, so those are cached for a year;
// index.html is never cached, so a new deploy is picked up on the next load.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const NO_CACHE = 'no-cache';
/**
 * The desktop app's wallet link page (game/link.html) signs for the player: never inside a frame,
 * and its URL (a session id) never goes out as a referrer. Its <meta> CSP can't say frame-ancestors.
 */
export const LINK_PAGE_HEADERS = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Returns an http request handler serving `dir`, with an index.html fallback for app routes. */
export function staticHandler(dir) {
  const root = resolve(dir);
  const index = resolve(root, 'index.html');

  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(404).end();
      return;
    }
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = resolve(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) {
      // A missing file with an extension (or under /assets/) is a real 404;
      // anything else is an app route and gets the game.
      if (extname(pathname) || pathname.startsWith('/assets/')) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': NO_CACHE }).end('Not found\n');
        return;
      }
      file = index;
      info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Game not built: run `npm run build`\n');
        return;
      }
    }
    const hashed = file.startsWith(resolve(root, 'assets') + sep);
    const headers = {
      'Cache-Control': hashed ? IMMUTABLE : NO_CACHE,
      'Last-Modified': info.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff',
      ...(file === resolve(root, 'link.html') ? LINK_PAGE_HEADERS : {}),
    };
    // no-cache means "revalidate": answer that cheaply when nothing changed.
    const since = Date.parse(req.headers['if-modified-since'] ?? '');
    if (since >= Math.floor(info.mtimeMs / 1000) * 1000) {
      res.writeHead(304, headers).end();
      return;
    }
    res.writeHead(200, {
      ...headers,
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  };
}
