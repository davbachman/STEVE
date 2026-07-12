import { describe, expect, it } from 'vitest';
import {
  advanceTurntableAlpha,
  resolveOrbitUpVector,
  resolveViewPresetOrientation,
} from '../SceneController';

describe('camera view presets', () => {
  it('makes Top exactly vertical with a non-collinear screen-up vector', () => {
    const top = resolveViewPresetOrientation('top');
    const radialOffset = {
      x: Math.cos(top.alpha) * Math.sin(top.beta),
      y: Math.sin(top.alpha) * Math.sin(top.beta),
      z: Math.cos(top.beta),
    };
    const viewDirection = [-radialOffset.x, -radialOffset.y, -radialOffset.z];
    const upDotView = top.upVector.reduce(
      (sum, component, index) => sum + component * viewDirection[index],
      0,
    );

    expect(top.beta).toBe(0);
    expect(radialOffset.x).toBeCloseTo(0, 12);
    expect(radialOffset.y).toBeCloseTo(0, 12);
    expect(radialOffset.z).toBeCloseTo(1, 12);
    expect(top.upVector).toEqual([0, 1, 0]);
    expect(upDotView).toBeCloseTo(0, 12);
  });

  it('keeps the other presets aligned to the global z-up direction', () => {
    expect(resolveViewPresetOrientation('front').upVector).toEqual([0, 0, 1]);
    expect(resolveViewPresetOrientation('side').upVector).toEqual([0, 0, 1]);
    expect(resolveViewPresetOrientation('default').upVector).toEqual([0, 0, 1]);
  });

  it('keeps orbit orientation continuous as the camera leaves the vertical pole', () => {
    const top = resolveViewPresetOrientation('top');
    const atTop = resolveOrbitUpVector(top.alpha, 0);
    const justOffTop = resolveOrbitUpVector(top.alpha, 1e-6);

    expect(atTop[0]).toBeCloseTo(top.upVector[0], 12);
    expect(atTop[1]).toBeCloseTo(top.upVector[1], 12);
    expect(atTop[2]).toBeCloseTo(top.upVector[2], 12);
    expect(justOffTop[0]).toBeCloseTo(atTop[0], 11);
    expect(justOffTop[1]).toBeCloseTo(atTop[1], 11);
    expect(justOffTop[2]).toBeCloseTo(atTop[2], 5);
  });

  it('advances turntable rotation by elapsed time and caps long-frame jumps', () => {
    expect(advanceTurntableAlpha(0, 30, 100)).toBeCloseTo(Math.PI / 60, 12);
    expect(advanceTurntableAlpha(0, 30, 10_000)).toBeCloseTo(Math.PI / 60, 12);
    expect(advanceTurntableAlpha(Math.PI - 0.01, 90, 100)).toBeGreaterThan(-Math.PI);
    expect(advanceTurntableAlpha(Math.PI - 0.01, 90, 100)).toBeLessThan(Math.PI);
  });
});
