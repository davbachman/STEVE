import { describe, expect, it } from 'vitest';
import { createPointLight } from '../../state/defaults';
import {
  shouldPointLightContribute,
  shouldRenderPointLightGizmo,
} from '../pointLightVisibility';

describe('point light visibility helpers', () => {
  it('keeps hidden gizmos contributing light when intensity is non-zero', () => {
    const light = createPointLight('Hidden Gizmo');
    light.visible = false;
    light.intensity = 18;

    expect(shouldPointLightContribute(light)).toBe(true);
    expect(shouldRenderPointLightGizmo(light)).toBe(false);
  });

  it('drops zero-intensity lights from scene contribution without affecting gizmo state', () => {
    const light = createPointLight('Zero Intensity');
    light.visible = true;
    light.intensity = 0;

    expect(shouldPointLightContribute(light)).toBe(false);
    expect(shouldRenderPointLightGizmo(light)).toBe(true);
  });
});
