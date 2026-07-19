import { describe, expect, it } from 'vitest';
import {
  PARAMETER_GIF_MAX_FRAMES,
  parameterValueForGifFrame,
  resolveParameterGifTiming,
} from '../parameterGif';

describe('parameter GIF loop', () => {
  it('preserves a full configured bounce duration with an even frame count', () => {
    const timing = resolveParameterGifTiming(0.25);
    expect(timing.durationSeconds).toBe(8);
    expect(timing.frameCount).toBe(96);
    expect(timing.frameDelayMs * timing.frameCount).toBeCloseTo(8000, 8);

    const slow = resolveParameterGifTiming(0.02);
    expect(slow.frameCount).toBe(PARAMETER_GIF_MAX_FRAMES);
    expect(slow.frameDelayMs * slow.frameCount).toBeCloseTo(100_000, 8);
  });

  it('steps min to max to min without duplicating the first frame', () => {
    const frameCount = 8;
    expect(parameterValueForGifFrame(-2, 6, 0, frameCount)).toBe(-2);
    expect(parameterValueForGifFrame(-2, 6, 2, frameCount)).toBe(2);
    expect(parameterValueForGifFrame(-2, 6, 4, frameCount)).toBe(6);
    expect(parameterValueForGifFrame(-2, 6, 6, frameCount)).toBe(2);
    expect(parameterValueForGifFrame(-2, 6, 7, frameCount)).toBe(0);
    expect(parameterValueForGifFrame(-2, 6, 8, frameCount)).toBe(-2);
  });
});
