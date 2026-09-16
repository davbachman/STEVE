import type { RenderSettings, Vec3 } from '../types/contracts';

/** Quality changes GPU work without changing the mathematical sampling grid. */
export function resolveInteractiveRenderBudget(
  quality: RenderSettings['interactiveQuality'],
  devicePixelRatio = 1,
): { pixelRatio: number; maxShadowSize: number; probeSize: number; planarScale: number } {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  if (quality === 'performance') {
    return { pixelRatio: Math.min(dpr, 1), maxShadowSize: 512, probeSize: 64, planarScale: 0.25 };
  }
  if (quality === 'balanced') {
    return { pixelRatio: Math.min(dpr, 1.5), maxShadowSize: 1024, probeSize: 96, planarScale: 0.5 };
  }
  return { pixelRatio: Math.min(dpr, 3), maxShadowSize: 4096, probeSize: 128, planarScale: 0.75 };
}

/** A vertical light needs a horizontal up axis for a nonsingular lookAt matrix. */
export function resolveShadowUpVector(direction: Vec3): [number, number, number] {
  return Math.abs(direction.z) > 0.99 ? [0, 1, 0] : [0, 0, 1];
}
