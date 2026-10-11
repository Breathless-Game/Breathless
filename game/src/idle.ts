/** Run `fn` when the browser is idle (or soon, where requestIdleCallback is missing). */
export function idle(fn: () => void, timeout = 4000) {
  if ('requestIdleCallback' in window) requestIdleCallback(() => fn(), { timeout });
  else setTimeout(fn, 1500);
}
