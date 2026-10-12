// Module hooks for presage-off.test.mjs (node --import ./smartspectra-register.mjs).
// SMARTSPECTRA_HOOK=block: importing @smartspectra/* throws, so a sensor that so much as
// loads the SDK dies at start-up. SMARTSPECTRA_HOOK=fake: it gets fake-smartspectra.mjs.

const FAKE = new URL('./fake-smartspectra.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@smartspectra/')) {
    if (process.env.SMARTSPECTRA_HOOK === 'fake') return { url: FAKE, shortCircuit: true };
    throw new Error(`blocked import of ${specifier} (Presage is off)`);
  }
  return next(specifier, context);
}
