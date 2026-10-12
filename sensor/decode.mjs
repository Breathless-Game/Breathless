// JPEG -> RGBA for compressed camera frames. The Presage SDK only takes raw pixels
// (sendFrame with RGB / RGBA / NV12 ...), so the sensor decodes.
//
// sharp (libvips + libjpeg-turbo) decodes a 640x480 frame in ~1.5 ms on a libuv worker
// thread; pure-JS jpeg-js took ~11 ms on the event loop (Apple M4). sharp is loaded
// lazily, so a checkout that hasn't reinstalled sensor/ still runs raw frames and the
// simulator.

import { isJpeg } from './frames.mjs';

/**
 * Resolves to `{ decodeJpeg }`, or `{ error }` when sharp can't load.
 * decodeJpeg(jpeg, width, height) resolves to an RGBA Buffer of width x height x 4, and
 * rejects anything that isn't a JPEG of exactly that size.
 */
export async function loadJpegDecoder() {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch (e) {
    return { error: String(e?.message ?? e).split('\n')[0] };
  }
  // A shared, low-RAM box: no libvips operation cache (frames never repeat) and one
  // libvips worker thread per image.
  sharp.cache(false);
  sharp.concurrency(1);
  async function decodeJpeg(jpeg, width, height) {
    // libvips sniffs the format; only ever hand it JPEGs.
    if (!isJpeg(jpeg)) throw new Error('not a JPEG');
    const { data, info } = await sharp(jpeg, {
      // Refuses a JPEG bigger than its header claims before decoding it.
      limitInputPixels: width * height,
      sequentialRead: true,
    })
      // The SDK also takes PixelFormat.kRGB (no ensureAlpha), but that is untested on the real SDK.
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== width || info.height !== height || info.channels !== 4) {
      throw new Error(`decoded ${info.width}x${info.height}x${info.channels}, header says ${width}x${height}`);
    }
    return data;
  }
  return { decodeJpeg };
}
