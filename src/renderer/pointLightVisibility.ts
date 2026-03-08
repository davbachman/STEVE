import type { PointLightObject } from '../types/contracts';

export function shouldPointLightContribute(light: PointLightObject): boolean {
  return light.intensity > 0;
}

export function shouldRenderPointLightGizmo(light: PointLightObject): boolean {
  return light.visible;
}
