// Esc menu: resume, settings, back to the title screen.
// The game loop owns the actual pause; this only drives the DOM and asks main.ts
// (through PauseHooks) to change game state.

import type { BreathMode } from './breath';
import type { TimeOfDay } from './daylight';
import type { WeatherMode } from './weather';
import { type Quality, type Settings, saveSettings } from './settings';
import { closeDropdown, enhanceSelect } from './dropdown';
import { orbNfts } from './explorer-links';
import { onWalletChange, walletState } from './wallet';
import { lang, onLangChange, setLang, t, type Lang } from './i18n';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const RESUME_COUNTDOWN = 3;

const MODE_LABEL: Record<BreathMode, () => string> = {
  presage: () => t('Camera (Presage)', '摄像头 (Presage)'),
  sim: () => t('Simulator (hold Shift)', '模拟器 (按住 Shift)'),
  keyboard: () => t('Keyboard (hold Shift)', '键盘 (按住 Shift)'),
};

type View = 'main' | 'settings' | 'confirm' | 'countdown';

export interface PauseHooks {
  resume(): void;
  quitToMenu(): void;
  /** Underwater: the player surely breathed while paused, so give them time to hold again. */
  needsCountdown(): boolean;
  /** What leaving right now would cost, or null if nothing. */
  quitWarning(): string | null;
  breathModes(): BreathMode[];
  breathMode(): BreathMode;
  setBreathMode(mode: BreathMode): void;
  timeOfDay(): TimeOfDay;
  setTimeOfDay(mode: TimeOfDay): void;
  applySettings(s: Settings): void;
}

export class PauseMenu {
  private root = $('pause');
  private views: Record<View, HTMLElement> = {
    main: $('pause-main'),
    settings: $('settings'),
    confirm: $('pause-confirm'),
    countdown: $('pause-countdown'),
  };
  private view: View = 'main';
  private countTimer: number | undefined;
  // Settings opened from the title screen: Back closes the menu instead of showing "Paused".
  private standalone = false;

  private input = $<HTMLSelectElement>('set-input');
  private timeOfDay = $<HTMLSelectElement>('set-time');
  private lighting = $<HTMLInputElement>('set-lighting');
  private weather = $<HTMLSelectElement>('set-weather');
  private quality = $<HTMLSelectElement>('set-quality');
  private camera = $<HTMLInputElement>('set-camera');
  private help = $<HTMLInputElement>('set-help');
  private language = $<HTMLSelectElement>('set-lang');

  constructor(
    private settings: Settings,
    private hooks: PauseHooks,
  ) {
    // Themed dropdowns in place of the native popups; the selects below keep working as before.
    for (const select of [this.input, this.timeOfDay, this.weather, this.quality, this.language]) enhanceSelect(select);
    $('pause-resume').addEventListener('click', () => this.requestResume());
    $('pause-settings').addEventListener('click', () => this.showSettings());
    $('pause-menu').addEventListener('click', () => this.requestQuit());
    $('settings-back').addEventListener('click', () => this.back());
    $('confirm-leave').addEventListener('click', () => this.quit());
    $('confirm-stay').addEventListener('click', () => this.show('main'));

    this.input.addEventListener('change', () => hooks.setBreathMode(this.input.value as BreathMode));
    this.timeOfDay.addEventListener('change', () => hooks.setTimeOfDay(this.timeOfDay.value as TimeOfDay));
    this.lighting.addEventListener('change', () => this.change({ lightingEffects: this.lighting.checked }));
    this.weather.addEventListener('change', () => this.change({ weather: this.weather.value as WeatherMode }));
    this.quality.addEventListener('change', () => this.change({ quality: this.quality.value as Quality }));
    this.camera.addEventListener('change', () => this.change({ showCamera: this.camera.checked }));
    this.help.addEventListener('change', () => this.change({ showHelp: this.help.checked }));
    this.language.value = lang();
    this.language.addEventListener('change', () => setLang(this.language.value as Lang));
    onLangChange((l) => {
      this.language.value = l;
      for (const o of this.input.options) o.textContent = MODE_LABEL[o.value as BreathMode]?.() ?? o.textContent;
    });
    hooks.applySettings(settings);
    onWalletChange(() => this.refreshChainLink());
    this.refreshChainLink();
  }

  get open() {
    return !this.root.classList.contains('hidden');
  }

  /** The "View on chain" link follows the signed-in wallet; no wallet, no link. */
  private refreshChainLink() {
    const link = $<HTMLAnchorElement>('pause-chain');
    const owner = walletState().owner;
    link.href = owner ? orbNfts(owner) : '#';
    link.classList.toggle('hidden', !owner);
  }

  show(view: View = 'main') {
    this.refreshChainLink();
    clearInterval(this.countTimer);
    closeDropdown();
    if (view !== 'settings') this.standalone = false;
    this.view = view;
    this.root.classList.remove('hidden');
    for (const [name, el] of Object.entries(this.views)) el.classList.toggle('hidden', name !== view);
  }

  /** Esc inside the menu: step back one level, or resume from the top. */
  back() {
    if (this.standalone) this.close();
    else if (this.view === 'main') this.requestResume();
    else this.show('main');
  }

  /** Settings on their own, from the title screen. Breath input is picked when starting, so it's hidden. */
  openSettings() {
    this.showSettings();
    this.standalone = true;
    $('set-input-row').classList.add('hidden');
  }

  close() {
    clearInterval(this.countTimer);
    closeDropdown();
    this.root.classList.add('hidden');
  }

  private requestResume() {
    if (!this.hooks.needsCountdown()) return this.finishResume();
    this.show('countdown');
    let left = RESUME_COUNTDOWN;
    const num = $('countdown-num');
    num.textContent = String(left);
    this.countTimer = window.setInterval(() => {
      left--;
      if (left <= 0) this.finishResume();
      else num.textContent = String(left);
    }, 1000);
  }

  private finishResume() {
    this.close();
    this.hooks.resume();
  }

  private requestQuit() {
    const warning = this.hooks.quitWarning();
    if (!warning) return this.quit();
    $('confirm-text').textContent = warning;
    this.show('confirm');
  }

  private quit() {
    this.close();
    this.hooks.quitToMenu();
  }

  private showSettings() {
    this.input.replaceChildren(
      ...this.hooks.breathModes().map((m) => new Option(MODE_LABEL[m](), m, false, m === this.hooks.breathMode())),
    );
    this.timeOfDay.value = this.hooks.timeOfDay();
    this.lighting.checked = this.settings.lightingEffects;
    this.weather.value = this.settings.weather;
    this.quality.value = this.settings.quality;
    this.camera.checked = this.settings.showCamera;
    this.help.checked = this.settings.showHelp;
    this.language.value = lang();
    $('set-input-row').classList.remove('hidden');
    this.show('settings');
  }

  /** Changes, saves and applies settings; also what the title's settings table (settings-desk.ts) uses. */
  change(patch: Partial<Settings>) {
    Object.assign(this.settings, patch);
    saveSettings(this.settings);
    this.hooks.applySettings(this.settings);
  }
}
