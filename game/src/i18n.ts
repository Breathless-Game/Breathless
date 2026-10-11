// The game's language: English or 中文. Its text is written bilingual, "English · 中文",
// and this shows one side of it. pick() takes a string apart at its " · " separators
// and, wherever a Latin segment is followed by a Chinese one (the pair), keeps the
// side for the language; anything else (numbers, names, one language only) stays.
//   - The page: every text node is shown picked, now and as it changes (a
//     MutationObserver), and back again in full if the language changes.
//   - Canvases: fillText / strokeText / measureText pick their text too, so painted
//     labels (the chart, the report paper, the plaques) follow; they show the new
//     language when they're next painted (onLang lets a painter repaint at once).

export type Lang = 'en' | 'zh';

const CJK = /[　-〿㐀-鿿＀-￯]/;
const LATIN = /[A-Za-z]/;
const SEP = ' · ';

let current: Lang = 'en';
const listeners: ((l: Lang) => void)[] = [];

export const lang = () => current;

export function onLang(fn: (l: Lang) => void) {
  listeners.push(fn);
}

/** The text in the current language (see the top of the file). */
export function pick(s: string): string {
  if (!s.includes(SEP) || !CJK.test(s)) return s;
  const parts = s.split(SEP);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i];
    const b = parts[i + 1];
    // A pair: Latin words, then their Chinese.
    if (b != null && LATIN.test(a) && !CJK.test(a) && CJK.test(b)) {
      // Keep any leading punctuation the English side had (← Back · 返回 → ← 返回).
      const lead = a.match(/^[^A-Za-z0-9]*/)![0];
      out.push(current === 'en' ? a : lead && !b.startsWith(lead.trim()) ? lead + b : b);
      i++;
    } else out.push(a);
  }
  return out.join(SEP);
}

/** Both languages of a label, from a pair. */
export function pair(en: string, zh: string) {
  return current === 'en' ? en : zh;
}

// ---- The page ---------------------------------------------------------------

const original = new WeakMap<Text, string>(); // a text node's bilingual text
const shown = new WeakMap<Text, string>(); // what we set it to

function apply(node: Text) {
  const now = node.nodeValue ?? '';
  // Changed by the game since we last set it: that's its new bilingual text.
  if (shown.get(node) !== now) original.set(node, now);
  const src = original.get(node) ?? now;
  const out = pick(src);
  shown.set(node, out);
  if (out !== now) node.nodeValue = out;
}

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) return apply(root as Text);
  const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = it.nextNode(); n; n = it.nextNode()) apply(n as Text);
}

let observer: MutationObserver | null = null;

function watch() {
  if (observer) return;
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') apply(r.target as Text);
      else r.addedNodes.forEach(walk);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
}

// ---- Canvases -----------------------------------------------------------------

function patchCanvas() {
  const proto = CanvasRenderingContext2D.prototype;
  for (const name of ['fillText', 'strokeText', 'measureText'] as const) {
    const orig = proto[name] as (this: CanvasRenderingContext2D, text: string, ...rest: unknown[]) => unknown;
    (proto as unknown as Record<string, unknown>)[name] = function (this: CanvasRenderingContext2D, text: string, ...rest: unknown[]) {
      return orig.call(this, typeof text === 'string' ? pick(text) : text, ...rest);
    };
  }
}

let started = false;
let applied = false;

/** Shows the game in `l` (from Settings). */
export function setLang(l: Lang) {
  if (!started) {
    started = true;
    patchCanvas();
    watch();
  }
  if (l === current && applied) return;
  applied = true;
  current = l;
  document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
  walk(document.body);
  for (const fn of listeners) fn(l);
}
