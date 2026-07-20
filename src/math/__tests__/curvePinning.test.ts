import { describe, expect, it } from 'vitest';
import { createDefaultCurve, createDirectionalLight, createPointLight } from '../../state/defaults';
import {
  clampCurveParameter,
  curveTraversalMode,
  evaluateCurveWorldPosition,
  resolvePinnedLight,
} from '../curvePinning';

describe('light curve pinning helpers', () => {
  it('evaluates a curve parameter in world space and clamps it to the source bounds', () => {
    const curve = createDefaultCurve('Path');
    if (curve.equation.kind !== 'parametric_curve') throw new Error('Expected a parametric curve');
    curve.equation.tDomain = { min: 0, max: Math.PI * 2, samples: 100 };
    curve.equation.source.rawText = '(cos(t), sin(t), 2*t)';
    curve.transform.position = { x: 3, y: -2, z: 1 };

    expect(clampCurveParameter(curve, -10)).toBe(0);
    expect(clampCurveParameter(curve, 99)).toBe(Math.PI * 2);
    expect(evaluateCurveWorldPosition(curve, Math.PI / 2)).toEqual({
      x: 3,
      y: -1,
      z: 1 + Math.PI,
    });
  });

  it('distinguishes endpoint-closed loops from open curves', () => {
    const curve = createDefaultCurve('Loop');
    if (curve.equation.kind !== 'parametric_curve') throw new Error('Expected a parametric curve');
    curve.equation.tDomain = { min: 0, max: Math.PI * 2, samples: 100 };
    curve.equation.source.rawText = '(cos(t), sin(t), 0)';
    expect(curveTraversalMode(curve)).toBe('wrap');

    curve.equation.source.rawText = '(cos(t), sin(t), t)';
    expect(curveTraversalMode(curve)).toBe('bounce');
  });

  it('resolves a pinned light without mutating its fallback position', () => {
    const curve = createDefaultCurve('Path');
    if (curve.equation.kind !== 'parametric_curve') throw new Error('Expected a parametric curve');
    curve.equation.tDomain = { min: 0, max: 2, samples: 20 };
    curve.equation.source.rawText = '(t, 2*t, 3*t)';
    const light = createPointLight('Pinned');
    light.curvePin = {
      ...light.curvePin,
      enabled: true,
      curveId: curve.id,
      parameterValue: 1.5,
    };

    const resolved = resolvePinnedLight(light, [curve, light]);
    expect(resolved.position).toEqual({ x: 1.5, y: 3, z: 4.5 });
    expect(light.position).toEqual({ x: 3, y: -3, z: 5 });
  });

  it('uses the same stable directional fallback as the arrow when a pinned curve reaches the origin', () => {
    const curve = createDefaultCurve('Origin');
    if (curve.equation.kind !== 'parametric_curve') throw new Error('Expected a parametric curve');
    curve.equation.tDomain = { min: 0, max: 1, samples: 20 };
    curve.equation.source.rawText = '(0, 0, 0)';
    const light = createDirectionalLight('Pinned');
    light.direction = { x: 1, y: 0, z: 0 };
    light.curvePin = { ...light.curvePin, enabled: true, curveId: curve.id, parameterValue: 0.5 };

    const resolved = resolvePinnedLight(light, [curve, light]);
    if (resolved.type !== 'directional_light') throw new Error('Expected directional light');
    expect(resolved.direction).toEqual({ x: 0, y: 0, z: -1 });
  });
});
