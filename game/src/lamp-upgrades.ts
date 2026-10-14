import { lampProfile, type LampPath } from './lamp-lighting';

export function lampPath(level: number, path: string | null | undefined): LampPath {
  return level >= 2 && path === 'wideLamp' ? 'wideLamp' : 'focus';
}

/** Quotes are previews; only the next tier can be bought, using the live prices. */
export function lampUpgradeSteps(owned: number, pearls: number, prices: readonly number[], path: LampPath) {
  const current = Number.isFinite(owned) ? Math.max(1, Math.min(3, Math.floor(owned))) : 1;
  const balance = Number.isFinite(pearls) ? Math.max(0, pearls) : 0;
  const before = lampProfile(current, path);
  return ([1, 2, 3] as const).map(level => {
    const optics = lampProfile(level, path);
    const price = Number.isFinite(prices[level - 1]) ? Math.max(0, prices[level - 1]) : null;
    const status = level <= current ? 'owned' : level === current + 1 ? 'next' : 'locked';
    return {
      level, status, price, optics,
      shortfall: price === null ? null : Math.max(0, price - balance),
      affordable: status === 'next' && price !== null && balance >= price,
      rangeGain: optics.distance - before.distance,
      intensityGain: optics.intensity - before.intensity,
      coverage: 2 * Math.tan(optics.angle) * 5,
    };
  });
}

export function lampEffect(level: number, path: LampPath, chinese: boolean): string {
  const profile = lampProfile(level, path);
  const angle = Math.round(profile.angle * 360 / Math.PI);
  return chinese
    ? `光距 ${profile.distance} m · 亮度 ${profile.intensity} cd · 照射角 ${angle}°`
    : `Range ${profile.distance} m · ${profile.intensity} cd · coverage ${angle}°`;
}
