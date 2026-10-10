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
  /** How much shoreline scenery to build: 1 drops moving birds, beams and most particles. */
  detail: SceneryDetail;
}

export type SceneryDetail = 1 | 2 | 3;

export const RENDER_QUALITY: Record<QualityLevel, RenderQuality> = {
  low: {
    maxPixelRatio: 1, maxPixels: 1280 * 720, antialias: false,
    kelpCount: 16, rayCount: 4, snowCount: 300,
    surfaceSegments: [64, 32], decorationHz: 20, waterDetail: 0, skyDetail: 0, rainCount: 160, detail: 1,
  },
  medium: {
    maxPixelRatio: 1.5, maxPixels: 1920 * 1080, antialias: true,
    kelpCount: 40, rayCount: 8, snowCount: 700,
    surfaceSegments: [96, 48], decorationHz: 30, waterDetail: 1, skyDetail: 1, rainCount: 420, detail: 2,
  },
  high: {
    maxPixelRatio: 2, maxPixels: 3840 * 2160, antialias: true,
    kelpCount: 72, rayCount: 14, snowCount: 1400,
    surfaceSegments: [128, 72], decorationHz: 60, waterDetail: 2, skyDetail: 2, rainCount: 800, detail: 3,
  },
};

export function initialQuality({ cores, memoryGB }: DeviceHints): QualityLevel {
  if ((cores != null && cores > 0 && cores <= 4) || (memoryGB != null && memoryGB > 0 && memoryGB <= 4)) return 'low';
  if (cores != null && cores >= 8 && (memoryGB == null || memoryGB >= 8)) return 'high';
  return 'medium';
}

export function renderPixelRatio(quality: RenderQuality, width: number, height: number, deviceRatio: number): number {
  // A DPR cap alone still overloads integrated GPUs on large external displays.
  return Math.min(deviceRatio || 1, quality.maxPixelRatio, Math.sqrt(quality.maxPixels / (Math.max(1, width) * Math.max(1, height))));
}

export class AdaptiveQuality {
  level: QualityLevel;
  private graceSeconds = 3;
  private sampleSeconds = 0;
  private sampleFrames = 0;
  private slowWindows = 0;
  private longFrames = 0;

  constructor(private hints: DeviceHints, private selectedMode: QualityMode = 'auto') {
    this.level = selectedMode === 'auto' ? initialQuality(hints) : selectedMode;
  }

  get mode(): QualityMode {
    return this.selectedMode;
  }

  setMode(mode: QualityMode) {
    // Other preferences also call applySettings; keep any automatic downgrade.
    if (mode === this.selectedMode) return;
    this.selectedMode = mode;
    this.level = mode === 'auto' ? initialQuality(this.hints) : mode;
    this.resetSamples();
    this.longFrames = 0;
    this.graceSeconds = 3;
  }

  get settings(): RenderQuality {
    return RENDER_QUALITY[this.level];
  }

  observeFrame(seconds: number, visible = true): QualityLevel | null {
    if (this.selectedMode !== 'auto') return null;
    if (!visible || !Number.isFinite(seconds) || seconds <= 0) {
      this.resetSamples();
      this.longFrames = 0;
      this.graceSeconds = 3;
      return null;
    }
    // Ignore isolated blocking work, but still adapt when the GPU stays below 4 FPS.
    if (seconds > 0.25) {
      if (++this.longFrames < 3) {
        this.resetSamples();
        this.graceSeconds = 3;
        return null;
      }
      seconds = 0.25;
    } else {
      this.longFrames = 0;
    }
    if (this.level === 'low') return null;
    if (this.graceSeconds > 0) {
      this.graceSeconds -= seconds;
      return null;
    }
    this.sampleSeconds += seconds;
    this.sampleFrames++;
    if (this.sampleSeconds < 3) return null;

    const slow = this.sampleSeconds / this.sampleFrames > 1 / 45;
    this.slowWindows = slow ? this.slowWindows + 1 : 0;
    this.sampleSeconds = 0;
    this.sampleFrames = 0;
    if (this.slowWindows < 2) return null;

    // Only step down within a session; automatic upgrades can repeatedly stall it.
    this.level = this.level === 'high' ? 'medium' : 'low';
    this.resetSamples();
    this.graceSeconds = 6;
    return this.level;
  }

  private resetSamples() {
    this.sampleSeconds = 0;
    this.sampleFrames = 0;
    this.slowWindows = 0;
  }
}
