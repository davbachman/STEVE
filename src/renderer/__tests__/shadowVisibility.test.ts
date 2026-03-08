import { describe, expect, it } from 'vitest';
import {
  combineShadowVisibility,
  resolveTransparentShadowDensity,
} from '../shadowVisibility';

describe('combineShadowVisibility', () => {
  it('keeps opaque blockers from being brightened by transparent casters', () => {
    expect(combineShadowVisibility(0, 0.82)).toBe(0);
  });

  it('preserves transparent attenuation when no opaque blocker is present', () => {
    expect(combineShadowVisibility(1, 0.68)).toBeCloseTo(0.68);
  });

  it('scales partial opaque visibility without adding light back in', () => {
    expect(combineShadowVisibility(0.45, 0.8)).toBeCloseTo(0.45);
  });

  it('keeps transparent shadows legible at common glass opacities', () => {
    expect(resolveTransparentShadowDensity(0)).toBeCloseTo(0.1);
    expect(resolveTransparentShadowDensity(0.42)).toBeCloseTo(0.4444);
    expect(resolveTransparentShadowDensity(1)).toBeCloseTo(0.92);
  });
});
