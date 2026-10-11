// One UI language at a time: English or 中文, picked in Settings (the title desk's
// LANGUAGE plaque, or the pause menu's Language row). No library: call sites write
// both strings, `t('Dive', '下潜')`, at render time, and re-render on onLangChange.
// Static markup in index.html carries its Chinese in attributes and applyStaticText()
// swaps it in:
//   <span data-zh="下潜">Dive</span>            text (the markup's own text is the English)
//   <p data-zh-html="按 <b>F</b> 上船">…</p>   inner HTML, for text with inline tags
//   data-zh-aria-label / data-zh-title / data-zh-placeholder   attributes
// An element with one of these must not hold children that code looks up by id: its
// content is replaced wholesale.

export type Lang = 'zh' | 'en';

/** The stored choice (shared with the old gear-panel toggle, so it carries over). */
export const LANGUAGE_KEY = 'deepbreath.language';

/** The stored choice wins; otherwise the browser's language (zh* → 中文, else English). */
export function resolveLang(stored: string | null | undefined, navLang: string | null | undefined): Lang {
  if (stored === 'zh' || stored === 'en') return stored;
  return (navLang ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let current: Lang | null = null;
const listeners = new Set<(l: Lang) => void>();

function readStored(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(LANGUAGE_KEY);
  } catch {
    return null;
  }
}

function browserLang(): string | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.language;
}

export function lang(): Lang {
  if (current === null) current = resolveLang(readStored(), browserLang());
  return current;
}

export function setLang(l: Lang) {
  const next: Lang = l === 'zh' ? 'zh' : 'en';
  const prev = lang();
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LANGUAGE_KEY, next);
  } catch {}
  if (next === prev) return;
  current = next;
  syncDocumentLang();
  for (const fn of [...listeners]) {
    try {
      fn(next);
    } catch (e) {
      console.error(e);
    }
  }
}

/** Calls fn after every language change; returns the unsubscribe. */
export function onLangChange(fn: (l: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The string for the current language. */
export function t(en: string, zh: string): string {
  return lang() === 'zh' ? zh : en;
}

/** For data with `name` / `nameZh`: the Chinese one in 中文 (falling back to `name`). */
export function pickName(o: { name: string; nameZh?: string }): string {
  return lang() === 'zh' && o.nameZh ? o.nameZh : o.name;
}

function syncDocumentLang() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang() === 'zh' ? 'zh-CN' : 'en';
}

const ATTRS = ['aria-label', 'title', 'placeholder'] as const;

/** Swaps every data-zh* element under root to the current language. */
export function applyStaticText(root: ParentNode = document) {
  const zh = lang() === 'zh';
  root.querySelectorAll<HTMLElement>('[data-zh]').forEach((el) => {
    if (el.dataset.en === undefined) el.dataset.en = el.textContent ?? '';
    el.textContent = zh ? el.dataset.zh! : el.dataset.en;
  });
  root.querySelectorAll<HTMLElement>('[data-zh-html]').forEach((el) => {
    if (el.dataset.enHtml === undefined) el.dataset.enHtml = el.innerHTML;
    el.innerHTML = zh ? el.dataset.zhHtml! : el.dataset.enHtml;
  });
  for (const attr of ATTRS) {
    root.querySelectorAll<HTMLElement>(`[data-zh-${attr}]`).forEach((el) => {
      const enKey = `data-en-${attr}`;
      if (!el.hasAttribute(enKey)) el.setAttribute(enKey, el.getAttribute(attr) ?? '');
      el.setAttribute(attr, zh ? el.getAttribute(`data-zh-${attr}`)! : el.getAttribute(enKey)!);
    });
  }
}

let started = false;

/** Once, at startup: sets <html lang>, swaps the static text, and keeps both in step. */
export function initI18n() {
  if (started) return;
  started = true;
  syncDocumentLang();
  applyStaticText();
  onLangChange(() => applyStaticText());
}
