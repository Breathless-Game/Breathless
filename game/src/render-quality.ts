export type QualityLevel = 'low' | 'medium' | 'high';
export type QualityMode = 'auto' | QualityLevel;

export interface DeviceHints {
  cores?: number;
  memoryGB?: number;
}

export interface RenderQuality {
  maxPixelRatio: number;
  maxPixels: number;
  antialias: boolean;
  kelpCount: number;
  rayCount: number;
  snowCount: number;
  surfaceSegments: readonly [number, number];
  decorationHz: number;
  waterDetail: 0 | 1 | 2;
  skyDetail: 0 | 1 | 2;
  rainCount: number;
  /** Maximum active diver exhalation bubbles. */
  bubbleLimit: number;
  /** Multiplier applied to requested bubble bursts. */
  bubbleEmitScale: number;
  /** Icosahedron subdivision used by bubble meshes. */
  bubbleSegments: 0 | 1;
  /** Maximum bubble simulation updates per second. */
  bubbleHz: number;
  /** How much shoreline scenery to build: 1 drops moving birds, beams and most particles. */
  detail: SceneryDetail;
}

export type SceneryDetail = 1 | 2 | 3;

export const RENDER_QUALITY: Record<QualityLevel, RenderQuality> = {
  low: {
    maxPixelRatio: 1, maxPixels: 1280 * 720, antialias: false,
    kelpCount: 12, rayCount: 4, snowCount: 300,
    surfaceSegments: [44, 8], decorationHz: 20, waterDetail: 0, skyDetail: 0, rainCount: 160, detail: 1,
    bubbleLimit: 12, bubbleEmitScale: 0.5, bubbleSegments: 0, bubbleHz: 20,
  },
  medium: {
    maxPixelRatio: 1.5, maxPixels: 1920 * 1080, antialias: true,
    kelpCount: 30, rayCount: 8, snowCount: 700,
    surfaceSegments: [88, 16], decorationHz: 30, waterDetail: 1, skyDetail: 1, rainCount: 420, detail: 2,
    bubbleLimit: 32, bubbleEmitScale: 0.75, bubbleSegments: 0, bubbleHz: 30,
  },
  high: {
    maxPixelRatio: 2, maxPixels: 2560 * 1440, antialias: true,
    kelpCount: 55, rayCount: 14, snowCount: 1400,
    surfaceSegments: [132, 24], decorationHz: 60, waterDetail: 2, skyDetail: 2, rainCount: 800, detail: 3,
    bubbleLimit: 72, bubbleEmitScale: 1, bubbleSegments: 1, bubbleHz: 60,
  },
};

export function initialQuality({ cores, memoryGB }: DeviceHints): QualityLevel {
  if ((cores != null && cores > 0 && cores <= 4) || (memoryGB != null && memoryGB > 0 && memoryGB <= 4)) return 'low';
  if (cores != null && cores >= 8 && (memoryGB == null || memoryGB >= 8)) return 'high';
  return 'medium';
}

// Software rasterizers (VMs, blocklisted drivers): anything above low is a slideshow.
const SOFTWARE_GPU = /SwiftShader|llvmpipe|lavapipe|softpipe|Basic Render|Software Renderer/i;
// Intel's discrete Arc cards share the vendor name with its integrated GPUs.
const DISCRETE_INTEL = /\bArc(?:\(TM\))? [AB]\d{3}/i;
// Laptop and phone integrated GPUs, including AMD APUs ("Radeon(TM) Graphics", "Radeon 780M").
const INTEGRATED_GPU = /Intel|Iris|UHD|HD Graphics|Mali|Adreno|PowerVR|Vivante|VideoCore|Radeon(?:\(TM\))? (?:R[2-7] |Vega \d+ )?Graphics|Radeon \d{3}M\b/i;

/**
 * The highest tier a GPU should start on, from its WebGL renderer string (the whole string,
 * e.g. "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)"), or null
 * when it tells us nothing: "Apple GPU" (Safari, even on Intel Macs), Firefox's buckets for
 * other vendors, an empty string. Never vouches for a strong GPU; null keeps the CPU heuristic.
 */
export function gpuQualityCap(renderer: string | null | undefined): QualityLevel | null {
  if (!renderer) return null;
  if (SOFTWARE_GPU.test(renderer)) return 'low';
  if (DISCRETE_INTEL.test(renderer)) return null;
  return INTEGRATED_GPU.test(renderer) ? 'medium' : null;
}

/** The renderer name of an existing context (unmasked where the browser allows), or ''. */
export function gpuRendererName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  } catch {
    return '';
  }
}

export function renderPixelRatio(quality: RenderQuality, width: number, height: number, deviceRatio: number): number {
  // A DPR cap alone still overloads integrated GPUs on large external displays.
  return Math.min(deviceRatio || 1, quality.maxPixelRatio, Math.sqrt(quality.maxPixels / (Math.max(1, width) * Math.max(1, height))));
}

/** Device-wide: the tier auto quality last had to drop to, so the next page load starts there. */
export const AUTO_QUALITY_KEY = 'deepbreath.renderQuality';
/** A remembered drop expires, so one bad session can't hold a good machine down for good. */
export const AUTO_QUALITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type QualityStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface AdaptiveOptions {
  /** Where the automatic drop is remembered; defaults to localStorage, null keeps it in memory. */
  store?: QualityStore | null;
  now?: () => number;
}

const LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high'];
const rank = (level: QualityLevel) => LEVELS.indexOf(level);
const lowest = (level: QualityLevel, cap: QualityLevel | null) => (cap && rank(cap) < rank(level) ? cap : level);

// Settle time after a page load, a long pause or a tier change, before frames count.
const GRACE_SECONDS = 1.25;
// One window decides, so a steadily slow GPU drops a tier about 4 s in.
const WINDOW_SECONDS = 2.75;
const SLOW_FRAME = 1 / 45;
const SMOOTH_FRAME = 1 / 58;
// A tier change rebuilds scenery and compiles shaders in the next couple of frames.
const SWITCH_SKIP_FRAMES = 2;
const UPGRADE_AFTER_SECONDS = 60;
const LONG_PAUSE_SECONDS = 3;

function browserStore(): QualityStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class AdaptiveQuality {
  level: QualityLevel;
  /** The renderer string from applyGpu, '' until then or when the browser hides it. */
  gpu = '';
  private gpuCap: QualityLevel | null = null;
  private remembered: QualityLevel | null = null;
  private rememberedGpu = '';
  private fromMemory = false;
  private downgraded = false;
  private upgradeTried = false;
  private graceSeconds = GRACE_SECONDS;
  private skipFrames = 0;
  private pausedSeconds = 0;
  private sampleSeconds = 0;
  private sampleFrames = 0;
  private smoothSeconds = 0;
  private longFrames = 0;
  private store: QualityStore | null;
  private now: () => number;

  constructor(private hints: DeviceHints, private selectedMode: QualityMode = 'auto', options: AdaptiveOptions = {}) {
    this.store = options.store === undefined ? browserStore() : options.store;
    this.now = options.now ?? Date.now;
    this.remembered = this.recall();
    this.level = selectedMode === 'auto' ? this.autoStart() : selectedMode;
  }

  get mode(): QualityMode {
    return this.selectedMode;
  }

  setMode(mode: QualityMode) {
    // Other preferences also call applySettings; keep any automatic downgrade.
    if (mode === this.selectedMode) return;
    this.selectedMode = mode;
    // A manual tier wins outright; the remembered automatic one only applies to auto.
    this.level = mode === 'auto' ? this.autoStart() : mode;
    this.resetSamples();
    this.longFrames = 0;
    this.skipFrames = 0;
    this.graceSeconds = GRACE_SECONDS;
  }

  /**
   * Cap the starting tier by the GPU. Call once the renderer's context exists and before
   * anything is built from `settings`; only antialiasing is fixed by then, which differs
   * just for low (a software renderer capped to low keeps the antialiasing it started with).
   */
  applyGpu(renderer: string) {
    this.gpu = renderer;
    this.gpuCap = gpuQualityCap(renderer);
    // A remembered drop belongs to the GPU it was measured on.
    if (this.remembered && this.rememberedGpu && renderer && this.rememberedGpu !== renderer) this.remember(null);
    if (this.selectedMode === 'auto' && !this.downgraded) this.level = this.autoStart();
  }

  get settings(): RenderQuality {
    return RENDER_QUALITY[this.level];
  }

  observeFrame(seconds: number, visible = true): QualityLevel | null {
    if (this.selectedMode !== 'auto' || !Number.isFinite(seconds) || seconds <= 0) return null;
    if (!visible) {
      // Menus and hidden tabs aren't the dive: hold the window and settle again on return.
      this.pausedSeconds += seconds;
      this.graceSeconds = Math.max(this.graceSeconds, this.pausedSeconds > LONG_PAUSE_SECONDS ? GRACE_SECONDS : 0.5);
      return null;
    }
    this.pausedSeconds = 0;
    if (this.skipFrames > 0) {
      this.skipFrames--;
      return null;
    }
    // Skip isolated blocking work without restarting the measurement, but still adapt
    // when the GPU stays below 4 FPS.
    if (seconds > 0.25) {
      if (++this.longFrames < 3) return null;
      seconds = 0.25;
    } else {
      this.longFrames = 0;
    }
    if (this.graceSeconds > 0) {
      this.graceSeconds -= seconds;
      return null;
    }
    this.sampleSeconds += seconds;
    this.sampleFrames++;
    if (this.sampleSeconds < WINDOW_SECONDS) return null;

    const elapsed = this.sampleSeconds;
    const frame = elapsed / this.sampleFrames;
    this.sampleSeconds = 0;
    this.sampleFrames = 0;
    if (frame > SLOW_FRAME) {
      this.smoothSeconds = 0;
      if (this.level === 'low') return null;
      this.downgraded = true;
      return this.switchTo(this.level === 'high' ? 'medium' : 'low');
    }
    this.smoothSeconds = frame <= SMOOTH_FRAME ? this.smoothSeconds + elapsed : 0;
    // Upgrades only undo a remembered drop, once per session: a drop measured in this
    // session would just repeat, and repeated switches stall the game.
    if (this.smoothSeconds < UPGRADE_AFTER_SECONDS || !this.fromMemory || this.downgraded || this.upgradeTried) return null;
    if (rank(this.level) >= rank(this.ceiling())) return null;
    this.upgradeTried = true;
    return this.switchTo(this.level === 'low' ? 'medium' : 'high');
  }

  private switchTo(level: QualityLevel): QualityLevel {
    this.level = level;
    this.resetSamples();
    this.skipFrames = SWITCH_SKIP_FRAMES;
    this.graceSeconds = GRACE_SECONDS;
    this.remember(rank(level) < rank(this.ceiling()) ? level : null);
    return level;
  }

  /** The best tier the hardware gets on auto, before anything was measured. */
  private ceiling(): QualityLevel {
    return lowest(initialQuality(this.hints), this.gpuCap);
  }

  private autoStart(): QualityLevel {
    const ceiling = this.ceiling();
    const level = lowest(ceiling, this.remembered);
    this.fromMemory = level !== ceiling;
    return level;
  }

  private recall(): QualityLevel | null {
    let saved: { level?: unknown; gpu?: unknown; at?: unknown } | null = null;
    try {
      saved = JSON.parse(this.store?.getItem(AUTO_QUALITY_KEY) ?? 'null');
    } catch { /* unreadable: start from the hardware */ }
    if (!saved || typeof saved !== 'object') return null;
    const { level, gpu, at } = saved;
    const age = typeof at === 'number' ? this.now() - at : NaN;
    if ((level !== 'low' && level !== 'medium') || !(age >= 0 && age < AUTO_QUALITY_TTL_MS)) {
      this.remember(null);
      return null;
    }
    this.rememberedGpu = typeof gpu === 'string' ? gpu : '';
    return level;
  }

  private remember(level: QualityLevel | null) {
    this.remembered = level;
    this.rememberedGpu = this.gpu;
    try {
      if (level) this.store?.setItem(AUTO_QUALITY_KEY, JSON.stringify({ level, gpu: this.gpu, at: this.now() }));
      else this.store?.removeItem(AUTO_QUALITY_KEY);
    } catch { /* storage full or blocked: this session still adapts */ }
  }

  private resetSamples() {
    this.sampleSeconds = 0;
    this.sampleFrames = 0;
    this.smoothSeconds = 0;
  }
}
