import { t } from './i18n';

type MatchMediaFn = (query: string) => { matches: boolean };

function defaultMatchMedia(): MatchMediaFn | undefined {
  return typeof matchMedia === 'function' ? (q) => matchMedia(q) : undefined;
}

/**
 * True on phones/tablets with no mouse or trackpad: the primary pointer is coarse
 * and no attached pointer is fine. Touchscreen laptops and narrow desktop windows
 * have a fine pointer, so they never match.
 */
export function isTouchOnly(mm: MatchMediaFn | undefined = defaultMatchMedia()): boolean {
  if (!mm) return false;
  try {
    return mm('(pointer: coarse)').matches && !mm('(any-pointer: fine)').matches;
  } catch {
    return false;
  }
}

/** Phone notice on the title screen; "Look around anyway" dismisses it until the page reloads. */
export function showTouchNotice(): void {
  if (!isTouchOnly()) return;
  document.documentElement.classList.add('touch-only');
  const root = document.createElement('div');
  root.className = 'link-wait touch-notice';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'touch-notice-title');
  const card = document.createElement('div');
  card.className = 'link-wait-card';
  const title = document.createElement('h3');
  title.id = 'touch-notice-title';
  title.className = 'link-wait-title';
  title.textContent = t('Best on a computer', '请用电脑打开');
  const lead = document.createElement('p');
  lead.className = 'link-wait-lead';
  lead.textContent = t(
    'Breathless is played with a keyboard (hold a key to hold your breath). Open this link on a computer.',
    '屏息需要用电脑键盘玩（按住按键来屏住呼吸）。请在电脑上打开这个链接。',
  );
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mini';
  btn.textContent = t('Look around anyway', '随便看看');
  btn.addEventListener('click', () => root.remove());
  card.append(title, lead, btn);
  root.append(card);
  document.body.append(root);
  btn.focus();
}
