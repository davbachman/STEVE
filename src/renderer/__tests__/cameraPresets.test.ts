import { describe, expect, it } from 'vitest';
import { resolveViewPresetOrientation } from '../SceneController';

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
});
