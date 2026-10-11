// Key bindings: every dive action and the keys that do it, by physical key
// (KeyboardEvent.code, so they don't move with the keyboard layout). Saved per
// device. The Settings desk opens the list (openControls), where a key can be
// clicked and re-pressed to change it.

import { onLangChange, t } from './i18n';

export type Action =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'hold'
  | 'catch'
  | 'bag'
  | 'prevGear'
  | 'nextGear'
  | 'board'
  | 'sonar'
  | 'night'
  | 'breathInput'
  | 'collection'
  | 'upgrades'
  | 'fieldGuide'
  | 'report';

interface ActionDef {
  id: Action;
  en: string;
  zh: string;
  keys: string[];
}

/** In the order the list shows them. */
const ACTIONS: ActionDef[] = [
  { id: 'left', en: 'Swim left', zh: '向左游', keys: ['ArrowLeft', 'KeyA'] },
  { id: 'right', en: 'Swim right', zh: '向右游', keys: ['ArrowRight', 'KeyD'] },
  { id: 'up', en: 'Swim up', zh: '上浮', keys: ['ArrowUp', 'KeyW'] },
  { id: 'down', en: 'Dive down', zh: '下潜', keys: ['ArrowDown', 'KeyS'] },
  { id: 'hold', en: 'Hold breath (keyboard)', zh: '屏息（键盘模式）', keys: ['ShiftLeft', 'ShiftRight'] },
  { id: 'catch', en: 'Catch', zh: '捕捞', keys: ['Space'] },
  { id: 'bag', en: 'Gear / bag', zh: '装备 / 鱼篓', keys: ['Tab'] },
  { id: 'prevGear', en: 'Previous gear', zh: '上一件装备', keys: ['KeyQ'] },
  { id: 'nextGear', en: 'Next gear', zh: '下一件装备', keys: ['KeyE'] },
  { id: 'board', en: 'Climb aboard / right the boat', zh: '上船 / 扶正船', keys: ['KeyF'] },
  { id: 'sonar', en: 'Sonar', zh: '声呐', keys: ['KeyV'] },
  { id: 'night', en: 'Night / day', zh: '昼夜切换', keys: ['KeyN'] },
  { id: 'breathInput', en: 'Breath input', zh: '呼吸输入方式', keys: ['KeyK'] },
  { id: 'collection', en: 'Collection', zh: '收藏', keys: ['KeyC'] },
  { id: 'upgrades', en: 'Upgrades', zh: '升级', keys: ['KeyG'] },
  { id: 'fieldGuide', en: 'Field guide', zh: '手册', keys: ['KeyB'] },
  { id: 'report', en: 'Health report', zh: '健康报告', keys: ['KeyH'] },
];

/** Shown in the list but not changeable. */
const FIXED: [string, string, string][] = [
  ['1 – 6', 'Quick gear', '快速装备'],
  ['Esc', 'Aboard / back', '上船 / 返回'],
];

const STORE = 'deepbreath.controls';

function load(): Record<Action, string[]> {
  const out = Object.fromEntries(ACTIONS.map((a) => [a.id, [...a.keys]])) as Record<Action, string[]>;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Partial<Record<Action, string[]>>;
    for (const a of ACTIONS) {
      const keys = saved[a.id];
      if (Array.isArray(keys) && keys.every((k) => typeof k === 'string')) out[a.id] = keys;
    }
  } catch {}
  return out;
}

let bindings = load();

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(bindings));
  } catch {}
}

/** The keys (codes) for an action. */
export function keysFor(action: Action): readonly string[] {
  return bindings[action];
}

/** Whether this key event is one of the action's keys. */
export function isAction(action: Action, e: KeyboardEvent): boolean {
  return bindings[action].includes(e.code);
}

/** A key code as printed on the key: KeyA → A, ArrowLeft → ←, ShiftLeft → L-Shift. */
export function keyName(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  const named: Record<string, string> = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ShiftLeft: 'L-Shift',
    ShiftRight: 'R-Shift',
    ControlLeft: 'L-Ctrl',
    ControlRight: 'R-Ctrl',
    AltLeft: 'L-Alt',
    AltRight: 'R-Alt',
    Space: 'Space',
    Tab: 'Tab',
    Enter: 'Enter',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
  };
  return named[code] ?? code;
}

/** The action's keys as text, e.g. "← / A". */
export function keyLabel(action: Action): string {
  return bindings[action].map(keyName).join(' / ') || '—';
}

// ---- The list ---------------------------------------------------------------

let root: HTMLElement | null = null;
let listening: { action: Action; slot: number; btn: HTMLButtonElement } | null = null;

export function controlsOpen() {
  return !!root && !root.classList.contains('hidden');
}

/** Opens the controls list over whatever is showing (the Settings desk, or the pause menu). */
export function openControls() {
  if (!root) root = build();
  render();
  root.classList.remove('hidden');
}

function close() {
  listening = null;
  root?.classList.add('hidden');
}

function build(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'controls';
  el.className = 'hidden';
  // The words are filled in by renderText(), in the current language.
  el.innerHTML = `
    <div class="card">
      <div class="controls-head">
        <h2 id="controls-title"></h2>
        <button class="mini" id="controls-close">×</button>
      </div>
      <p class="small muted" id="controls-hint"></p>
      <div id="controls-list"></div>
      <div class="controls-foot">
        <button class="mini" id="controls-reset"></button>
        <button class="primary" id="controls-done"></button>
      </div>
    </div>`;
  onLangChange(() => controlsOpen() && render());
  document.body.append(el);
  el.querySelector('#controls-close')!.addEventListener('click', close);
  el.querySelector('#controls-done')!.addEventListener('click', close);
  el.querySelector('#controls-reset')!.addEventListener('click', () => {
    bindings = Object.fromEntries(ACTIONS.map((a) => [a.id, [...a.keys]])) as Record<Action, string[]>;
    save();
    render();
  });
  el.addEventListener('click', (e) => {
    if (e.target === el) close();
  });
  // While the list is open it takes every key first: rebinding, or Esc to close.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!controlsOpen()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!listening) {
        if (e.key === 'Escape') close();
        return;
      }
      const { action, slot } = listening;
      listening = null;
      if (e.key === 'Escape') return render();
      // Backspace / Delete clears a second slot.
      if ((e.code === 'Backspace' || e.code === 'Delete') && slot > 0) bindings[action].splice(slot, 1);
      else {
        // A key does one thing: take it off any other action first.
        for (const a of ACTIONS) if (a.id !== action) bindings[a.id] = bindings[a.id].filter((k) => k !== e.code);
        const keys = bindings[action].filter((k) => k !== e.code);
        keys.splice(Math.min(slot, keys.length), slot < keys.length ? 1 : 0, e.code);
        bindings[action] = keys;
      }
      save();
      render();
    },
    true,
  );
  return el;
}

/** The list's fixed words, in the current language. */
function renderText() {
  const q = (sel: string) => root!.querySelector<HTMLElement>(sel)!;
  q('#controls-title').textContent = t('Controls', '操作');
  q('#controls-close').title = t('Close (Esc)', '关闭 (Esc)');
  q('#controls-hint').textContent = t('Click a key, then press the new one. A second key slot is optional.', '点击按键后按下新键。第二个按键位可不填。');
  q('#controls-reset').textContent = t('Reset to defaults', '恢复默认');
  q('#controls-done').textContent = t('Done', '完成');
}

function render() {
  renderText();
  const list = root!.querySelector('#controls-list')!;
  const rows = ACTIONS.map((a) => {
    const row = document.createElement('div');
    row.className = 'controls-row';
    const name = document.createElement('span');
    name.textContent = t(a.en, a.zh);
    const keys = document.createElement('span');
    keys.className = 'controls-keys';
    for (let slot = 0; slot < 2; slot++) {
      const code = bindings[a.id][slot];
      const btn = document.createElement('button');
      btn.className = 'mini controls-key';
      btn.textContent = code ? keyName(code) : '+';
      btn.classList.toggle('empty', !code);
      btn.addEventListener('click', () => {
        listening = { action: a.id, slot, btn };
        render();
      });
      if (listening?.action === a.id && listening.slot === slot) {
        btn.textContent = t('Press a key…', '请按下新键…');
        btn.classList.add('listening');
      }
      keys.append(btn);
    }
    row.append(name, keys);
    return row;
  });
  const fixed = FIXED.map(([key, en, zh]) => {
    const row = document.createElement('div');
    row.className = 'controls-row fixed';
    row.innerHTML = `<span>${t(en, zh)}</span><span class="controls-keys"><span class="controls-fixed">${key}</span></span>`;
    return row;
  });
  list.replaceChildren(...rows, ...fixed);
}
