import { describe, expect, it } from 'vitest';
import { defaultRenderSettings } from '../defaults';
import { coerceRenderSettingsForInteractiveOnly } from '../renderCompat';

describe('render compatibility coercion', () => {
  it('preserves interactive render settings unchanged', () => {
    const render = defaultRenderSettings();
    render.interactiveQuality = 'quality';
    const result = coerceRenderSettingsForInteractiveOnly(render);
    expect(result.coercedLegacyQualityMode).toBe(false);
    expect(result.render).toBe(render);
    expect(result.render.mode).toBe('interactive');
  });

  it('coerces legacy quality mode to interactive and resets transient quality progress', () => {
    const render = defaultRenderSettings();
    render.mode = 'quality';
    render.qualityRenderer = 'path';
    render.qualityCurrentSamples = 17;
    render.qualityRunning = true;

    const result = coerceRenderSettingsForInteractiveOnly(render);

    expect(result.coercedLegacyQualityMode).toBe(true);
    expect(result.render).not.toBe(render);
    expect(result.render.mode).toBe('interactive');
    expect(result.render.qualityRenderer).toBe('path');
    expect(result.render.qualityCurrentSamples).toBe(0);
    expect(result.render.qualityRunning).toBe(false);
  });
});
