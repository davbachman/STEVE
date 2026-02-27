import type { RenderSettings } from '../types/contracts';

export const LEGACY_QUALITY_MODE_PARKED_MESSAGE =
  'Legacy quality mode is parked; using Interactive mode (quality settings preserved for compatibility)';

export interface RenderCompatibilityCoercion {
  render: RenderSettings;
  coercedLegacyQualityMode: boolean;
}

export function coerceRenderSettingsForInteractiveOnly(render: RenderSettings): RenderCompatibilityCoercion {
  if (render.mode !== 'quality') {
    return { render, coercedLegacyQualityMode: false };
  }

  return {
    render: {
      ...render,
      mode: 'interactive',
      qualityRunning: false,
      qualityCurrentSamples: 0,
    },
    coercedLegacyQualityMode: true,
  };
}
