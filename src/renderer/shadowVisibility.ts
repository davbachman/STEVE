function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const MIN_TRANSPARENT_SHADOW_DENSITY = 0.1;
const MAX_TRANSPARENT_SHADOW_DENSITY = 0.92;

export function combineShadowVisibility(
  opaqueVisibility: number,
  transparentTransmittance: number,
): number {
  return Math.min(clampUnit(opaqueVisibility), clampUnit(transparentTransmittance));
}

export function resolveTransparentShadowDensity(opacity: number): number {
  const normalized = clampUnit(opacity);
  return Math.min(
    MIN_TRANSPARENT_SHADOW_DENSITY + normalized * (MAX_TRANSPARENT_SHADOW_DENSITY - MIN_TRANSPARENT_SHADOW_DENSITY),
    MAX_TRANSPARENT_SHADOW_DENSITY,
  );
}

export const shadowVisibilityGlsl = `
const float MIN_TRANSPARENT_SHADOW_DENSITY = ${MIN_TRANSPARENT_SHADOW_DENSITY.toFixed(2)};
const float MAX_TRANSPARENT_SHADOW_DENSITY = ${MAX_TRANSPARENT_SHADOW_DENSITY.toFixed(2)};

float combineShadowVisibility(float opaqueVisibility, float transparentVisibility) {
  return min(clamp(opaqueVisibility, 0.0, 1.0), clamp(transparentVisibility, 0.0, 1.0));
}

float resolveTransparentShadowDensity(float opacity) {
  float normalized = clamp(opacity, 0.0, 1.0);
  return min(
    MIN_TRANSPARENT_SHADOW_DENSITY + normalized * (MAX_TRANSPARENT_SHADOW_DENSITY - MIN_TRANSPARENT_SHADOW_DENSITY),
    MAX_TRANSPARENT_SHADOW_DENSITY
  );
}

vec3 resolveTransparentShadowTransmittance(vec3 baseColor, float opacity) {
  float density = resolveTransparentShadowDensity(opacity);
  return mix(vec3(1.0), clamp(baseColor, 0.08, 1.0), density);
}
`;
