// One game tab per wallet. Each tab keeps this wallet's whole bank in memory and saves all of it
// (main.ts saveBank), so two tabs on one wallet overwrite each other's fish. The first tab to log in
// holds a Web Lock named for the wallet for the page's life; another tab on the same wallet waits
// behind a notice until the player picks it ("Play here"), which steals the lock and reloads.
// No imports, so tests/tab-lock.test.mjs can load it on its own.

/** The slice of `navigator.locks` (Web Locks API) used here; tests pass a fake. */
export interface TabLocks {
  request(
    name: string,
    options: { ifAvailable?: boolean; steal?: boolean },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>;
}

/**
 * granted: this tab plays the wallet. busy: another tab already does. unsupported: no Web Locks
 * (old browser, or the request failed outright), so play as before, unguarded.
 */
export type TabClaim = 'granted' | 'busy' | 'unsupported';

/** The lock name, in the same `deepbreath.<owner>.<name>` shape as the wallet's storage keys. */
export function tabLockName(owner: string): string {
  return `deepbreath.${owner}.tab`;
}

/** The browser's lock manager, or undefined when it has none. */
export function browserLocks(): TabLocks | undefined {
  return typeof navigator !== 'undefined' ? (navigator as { locks?: TabLocks }).locks : undefined;
}

const forever = () => new Promise<never>(() => {});

/** How long a reloaded page waits for its previous document's lock to be released, per retry. */
export const TAB_RETRY_MS = 750;
export const TAB_RETRIES = 2;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Take this wallet's tab lock if no other tab holds it, and hold it until the page unloads. When
 * another tab steals it later, the held request rejects (AbortError) and `stolen` runs once.
 * On a plain reload the old document's lock is released asynchronously, so a busy answer is asked
 * again TAB_RETRIES times, TAB_RETRY_MS apart (~1.5 s), before this tab gives way.
 */
export async function claimTab(
  owner: string,
  locks: TabLocks | undefined,
  stolen: () => void,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<TabClaim> {
  if (!locks || typeof locks.request !== 'function') return 'unsupported';
  for (let attempt = 0; ; attempt++) {
    const claim = await tryClaim(owner, locks, stolen);
    if (claim !== 'busy' || attempt >= TAB_RETRIES) return claim;
    await sleep(TAB_RETRY_MS);
  }
}

/** One ifAvailable request: granted (and held), busy, or unsupported when the request fails. */
function tryClaim(owner: string, locks: TabLocks, stolen: () => void): Promise<TabClaim> {
  return new Promise<TabClaim>((resolve) => {
    let held = false;
    let heldRequest: Promise<unknown>;
    try {
      heldRequest = locks.request(tabLockName(owner), { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve('busy'); // ifAvailable: called with null when another tab holds it
          return undefined;
        }
        held = true;
        resolve('granted');
        return forever(); // released only when the page goes away (or the lock is stolen)
      });
    } catch {
      resolve('unsupported');
      return;
    }
    Promise.resolve(heldRequest).then(
      () => {},
      () => {
        if (held) stolen();
        else resolve('unsupported');
      },
    );
  });
}

/**
 * "Play here": take the lock from whichever tab holds it (that tab's held request rejects and it
 * stops saving), then run `then` — the page reloads into a normal login, which gets the lock.
 * `steal` cannot be combined with `ifAvailable`.
 */
export function takeOverTab(owner: string, locks: TabLocks, then: () => void): Promise<unknown> {
  return locks.request(tabLockName(owner), { steal: true }, () => {
    then();
    return forever();
  });
}

/**
 * The notice over a tab that may not play this wallet: `stolen` when another tab just took it over.
 * `t` is i18n's (passed in to keep this module import-free).
 */
export function showTabNotice(t: (en: string, zh: string) => string, stolen: boolean, playHere: () => void): void {
  document.querySelector('.tab-notice')?.remove();
  const root = document.createElement('div');
  root.className = 'link-wait tab-notice';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'tab-notice-title');
  const card = document.createElement('div');
  card.className = 'link-wait-card';
  const title = document.createElement('h3');
  title.id = 'tab-notice-title';
  title.className = 'link-wait-title';
  title.textContent = stolen
    ? t('This wallet is now open in another tab', '这个钱包已在另一个标签页打开')
    : t('Already open in another tab', '已在另一个标签页打开');
  const lead = document.createElement('p');
  lead.className = 'link-wait-lead';
  lead.textContent = t(
    'Only one tab can play per wallet, so your fish stay safe. Close the other tab, or play here instead.',
    '每个钱包只能在一个标签页里玩，这样你的鱼才不会丢。请关掉另一个标签页，或者改在这里玩。',
  );
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mini';
  btn.textContent = t('Play here', '在这里玩');
  btn.addEventListener('click', () => {
    btn.disabled = true;
    playHere();
  });
  card.append(title, lead, btn);
  root.append(card);
  document.body.append(root);
  btn.focus();
  // The game listens for keys on the window (Enter starts a dive, any key holds breath): none of
  // them may reach it under the notice, which stays until the page reloads. Stopping propagation
  // keeps default actions, so Enter or Space on the focused button still presses it.
  const block = (e: Event) => e.stopImmediatePropagation();
  window.addEventListener('keydown', block, true);
  window.addEventListener('keyup', block, true);
}
