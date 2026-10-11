// Themed stand-in for <select>, whose native popup can't be styled.
//
//   enhanceSelect(select);
//
// The select stays in the DOM, hidden, as the source of truth: its options,
// `.value` (reads and writes), `change` / `onchange` and `.add()` /
// `replaceChildren()` all keep working, and a glass button + listbox takes its
// place on screen. The list is moved to <body> and placed `fixed` off the
// button, because panels with transform, backdrop-filter or overflow would clip
// or offset it.
//
// While a list is open it has the keyboard: arrows, Space, Esc and letters never
// reach the game's window listeners (arrows swim, Space throws the net, Esc
// pauses). main.ts also checks dropdownOpen() as a backstop.

import './dropdown.css';

const LIST_MAX = 280; // px, then the list scrolls (matches .dd-list max-height)
const EDGE = 8; // px kept clear of the viewport edges
const GAP = 6; // px between the button and the list
const TYPE_AHEAD_MS = 600;

const valueProp = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!;
const indexProp = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex')!;

let current: Dropdown | null = null;
let nextId = 0;

/** True while a dropdown's list is open. */
export function dropdownOpen() {
  return current !== null;
}

/** Close whichever list is open, without changing its value (e.g. when its menu goes away). */
export function closeDropdown() {
  current?.close();
}

/** Replace a <select> on screen with a themed dropdown; the select keeps working as before. */
export function enhanceSelect(select: HTMLSelectElement) {
  return new Dropdown(select);
}

export class Dropdown {
  readonly button = document.createElement('button');
  private list = document.createElement('div');
  private shown = document.createElement('span');
  private items: HTMLElement[] = [];
  private active = -1;
  private typed = '';
  private typedAt = 0;
  // Keys whose keydown was ours: their keyup is too. Others pass, so the game never sees a key stick.
  private swallowed = new Set<string>();

  constructor(readonly select: HTMLSelectElement) {
    const id = `dd-${select.id || nextId++}`;
    this.list.id = `${id}-list`;
    this.list.className = 'dd-list';
    this.list.setAttribute('role', 'listbox');

    const b = this.button;
    b.type = 'button';
    b.className = 'dd';
    b.setAttribute('role', 'combobox');
    b.setAttribute('aria-haspopup', 'listbox');
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-controls', this.list.id);
    const label = select.getAttribute('aria-label');
    if (label) b.setAttribute('aria-label', label);
    this.shown.className = 'dd-value';
    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.setAttribute('class', 'dd-chevron');
    chevron.setAttribute('viewBox', '0 0 12 12');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = '<path d="M2.5 4.5 6 8l3.5-3.5" />';
    b.append(this.shown, chevron);

    // Before the select, so a wrapping <label> activates the button rather than the hidden select.
    select.before(b);
    select.classList.add('dd-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    // Writing .value / .selectedIndex fires nothing on a select: hook them so the button follows.
    const sync = () => this.sync();
    Object.defineProperty(select, 'value', {
      configurable: true,
      get: () => valueProp.get!.call(select),
      set: (v: string) => {
        valueProp.set!.call(select, v);
        sync();
      },
    });
    Object.defineProperty(select, 'selectedIndex', {
      configurable: true,
      get: () => indexProp.get!.call(select),
      set: (i: number) => {
        indexProp.set!.call(select, i);
        sync();
      },
    });
    new MutationObserver(() => this.rebuild()).observe(select, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['disabled', 'label', 'selected'],
    });

    b.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
    b.addEventListener('keydown', (e) => this.onKeyDown(e));
    b.addEventListener('keyup', (e) => {
      if (this.swallowed.delete(e.key)) e.stopPropagation();
    });
    b.addEventListener('blur', () => this.close());
    // The row's <label> would take the focus (blur: close) and then click the button (open again).
    b.closest('label')?.addEventListener('mousedown', (e) => {
      if (this.isOpen && !b.contains(e.target as Node)) e.preventDefault();
    });
    // Keep the focus on the button while the list is clicked, so it doesn't blur shut.
    this.list.addEventListener('pointerdown', (e) => e.preventDefault());
    this.list.addEventListener('mousedown', (e) => e.preventDefault());
    this.list.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('.dd-option');
      if (item) this.pick(Number(item.dataset.index));
    });
    this.list.addEventListener('pointermove', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('.dd-option');
      delete this.list.dataset.keys;
      if (item) this.setActive(Number(item.dataset.index), false);
    });

    this.rebuild();
  }

  get isOpen() {
    return current === this;
  }

  open() {
    if (this.isOpen || this.select.disabled || !this.items.length) return;
    current?.close();
    current = this;
    this.button.setAttribute('aria-expanded', 'true');
    // Same type as the button: the list sits in <body>, outside the panel's font rules.
    const font = getComputedStyle(this.button);
    this.list.style.fontFamily = font.fontFamily;
    this.list.style.fontSize = font.fontSize;
    delete this.list.dataset.keys;
    document.body.append(this.list);
    this.place();
    this.setActive(Math.max(0, this.select.selectedIndex));
    // Safari doesn't focus a clicked button; the keys must come here, not to the game.
    this.button.focus({ preventScroll: true });
    document.addEventListener('pointerdown', this.onOutside, true);
    window.addEventListener('scroll', this.onScroll, true);
    window.addEventListener('resize', this.onResize);
  }

  close() {
    if (!this.isOpen) return;
    current = null;
    this.button.setAttribute('aria-expanded', 'false');
    this.button.removeAttribute('aria-activedescendant');
    this.list.remove();
    document.removeEventListener('pointerdown', this.onOutside, true);
    window.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onResize);
  }

  private onOutside = (e: PointerEvent) => {
    const t = e.target as Node;
    // A click on the row's <label> reaches the button as a click, which toggles the list itself.
    if (this.list.contains(t) || this.button.closest('label')?.contains(t) || this.button.contains(t)) return;
    this.close();
  };

  /** A panel scrolled under the list: it would float off its button, so close it like a select. */
  private onScroll = (e: Event) => {
    if (e.target !== this.list) this.close();
  };

  private onResize = () => this.close();

  /** Under the button, or over it when there is more room above; always inside the viewport. */
  private place() {
    const r = this.button.getBoundingClientRect();
    const s = this.list.style;
    s.minWidth = `${r.width}px`;
    s.maxWidth = `${innerWidth - EDGE * 2}px`;
    s.maxHeight = '';
    const below = innerHeight - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const up = Math.min(this.list.scrollHeight, LIST_MAX) > below && above > below;
    s.maxHeight = `${Math.max(0, Math.min(LIST_MAX, up ? above : below))}px`;
    s.top = up ? '' : `${r.bottom + GAP}px`;
    s.bottom = up ? `${innerHeight - r.top + GAP}px` : '';
    s.left = `${Math.max(EDGE, Math.min(r.left, innerWidth - EDGE - this.list.offsetWidth))}px`;
    this.list.dataset.side = up ? 'up' : 'down';
  }

  private rebuild() {
    const options = [...this.select.options];
    this.items = options.map((o, i) => {
      const item = document.createElement('div');
      item.id = `${this.list.id}-${i}`;
      item.className = 'dd-option';
      item.setAttribute('role', 'option');
      item.dataset.index = String(i);
      item.textContent = o.label;
      if (o.disabled) item.setAttribute('aria-disabled', 'true');
      return item;
    });
    this.list.replaceChildren(...this.items);
    this.shown.replaceChildren(
      ...options.map((o) => {
        const span = document.createElement('span');
        span.textContent = o.label;
        return span;
      }),
    );
    this.active = Math.min(this.active, this.items.length - 1);
    this.sync();
    if (this.isOpen) this.place();
  }

  /** Show the select's current value. */
  private sync() {
    const index = indexProp.get!.call(this.select) as number;
    this.items.forEach((item, i) => item.setAttribute('aria-selected', String(i === index)));
    [...this.shown.children].forEach((span, i) => span.classList.toggle('on', i === index));
    this.button.disabled = this.select.disabled;
  }

  private setActive(i: number, reveal = true) {
    const item = this.items[i];
    if (!item) return;
    this.items[this.active]?.classList.remove('active');
    this.active = i;
    item.classList.add('active');
    this.button.setAttribute('aria-activedescendant', item.id);
    if (!reveal) return;
    // By hand: scrollIntoView would also scroll the page's overflow:hidden ancestors.
    const l = this.list;
    if (item.offsetTop < l.scrollTop) l.scrollTop = item.offsetTop - 5;
    else if (item.offsetTop + item.offsetHeight > l.scrollTop + l.clientHeight) {
      l.scrollTop = item.offsetTop + item.offsetHeight - l.clientHeight + 5;
    }
  }

  private pick(i: number) {
    const option = this.select.options[i];
    if (!option || option.disabled) return;
    this.close();
    if (i === this.select.selectedIndex) return;
    indexProp.set!.call(this.select, i);
    this.sync();
    this.select.dispatchEvent(new Event('input', { bubbles: true }));
    this.select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey) return; // browser shortcuts
    const last = this.items.length - 1;
    const printable = e.key.length === 1;
    if (!this.isOpen) {
      // Closed, the button only claims the keys that open it. Esc and Tab keep their usual jobs.
      if (!['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Home', 'End'].includes(e.key) && !printable) return;
      this.open();
      if (e.key === 'Home') this.setActive(0);
      else if (e.key === 'End') this.setActive(last);
      else if (printable && e.key !== ' ') this.typeAhead(e.key);
    } else {
      this.list.dataset.keys = '';
      switch (e.key) {
        case 'ArrowDown':
          this.setActive(Math.min(last, this.active + 1));
          break;
        case 'ArrowUp':
          if (e.altKey) this.pick(this.active);
          else this.setActive(Math.max(0, this.active - 1));
          break;
        case 'Home':
        case 'PageUp':
          this.setActive(0);
          break;
        case 'End':
        case 'PageDown':
          this.setActive(last);
          break;
        case 'Enter':
        case ' ':
          this.pick(this.active);
          break;
        case 'Escape':
          this.close();
          break;
        case 'Tab':
          // Keeps the highlighted option and lets the focus move on as usual.
          this.pick(this.active);
          e.stopPropagation();
          this.swallowed.add(e.key);
          return;
        default:
          if (printable) this.typeAhead(e.key);
      }
    }
    e.preventDefault();
    e.stopPropagation();
    this.swallowed.add(e.key);
  }

  /** Jump to the next option starting with what was just typed; one letter again and again cycles. */
  private typeAhead(key: string) {
    const now = performance.now();
    this.typed = now - this.typedAt > TYPE_AHEAD_MS ? key : this.typed + key;
    this.typedAt = now;
    const typed = this.typed.toLowerCase();
    const repeat = [...typed].every((c) => c === typed[0]);
    const needle = repeat ? typed[0] : typed;
    const start = repeat ? this.active + 1 : this.active;
    const labels = [...this.select.options].map((o) => o.label.toLowerCase());
    for (let k = 0; k < labels.length; k++) {
      const i = (start + k + labels.length) % labels.length;
      if (labels[i].startsWith(needle)) return this.setActive(i);
    }
  }
}
