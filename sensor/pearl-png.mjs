// A small shaded pearl as a PNG, for the PEARL token's metadata image (server mode).
// No canvas in Node, so this rasterises a lit sphere and encodes the PNG by hand.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function renderPearlPng(size = 256) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const r = size * 0.42;
  const c = size / 2;
  const light = [-0.45, -0.55, 0.7];
  const ll = Math.hypot(...light);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - c) / r;
      const dy = (y + 0.5 - c) / r;
      const d = Math.hypot(dx, dy);
      const alpha = Math.max(0, Math.min(1, (1 - d) * r)); // ~1px anti-aliased rim
      if (alpha <= 0) continue;
      const nz = Math.sqrt(Math.max(0, 1 - d * d));
      const diffuse = Math.max(0, (dx * light[0] + dy * light[1] + nz * light[2]) / ll);
      const spec = Math.pow(diffuse, 40);
      // Nacre: a faint pink-to-blue sheen that shifts towards the rim.
      const sheen = Math.sin(d * 5.5 + dx * 2) * 0.5 + 0.5;
      const base = 0.62 + 0.38 * diffuse;
      const rgb = [
        base * (0.96 + 0.04 * sheen),
        base * (0.93 + 0.02 * (1 - sheen)),
        base * (0.95 + 0.05 * (1 - sheen)),
      ].map((v) => Math.round(255 * Math.min(1, v * (1 - 0.18 * d * d) + spec * 0.6)));
      const i = row + 1 + x * 4;
      raw[i] = rgb[0];
      raw[i + 1] = rgb[1];
      raw[i + 2] = rgb[2];
      raw[i + 3] = Math.round(255 * alpha);
    }
  }
  return encodePng(size, size, raw, 6);
}

/**
 * PNG from raw scanlines: each row is a filter byte (0) followed by the pixels.
 * colorType 6 is RGBA (4 bytes per pixel), 2 is RGB (3 bytes per pixel). Also used by fish-png.mjs.
 */
export function encodePng(width, height, raw, colorType = 6) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
