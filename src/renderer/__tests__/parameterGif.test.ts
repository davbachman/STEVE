import { describe, expect, it } from 'vitest';
import {
  PARAMETER_GIF_MAX_FRAMES,
  parameterValueForGifFrame,
  rangeValueForGifFrame,
  resolveParameterGifTiming,
  resolveRangeGifTiming,
} from '../parameterGif';

describe('parameter GIF loop', () => {
  it('preserves a full configured bounce duration with an even frame count', () => {
    const timing = resolveParameterGifTiming(0.25);
    expect(timing.durationSeconds).toBe(8);
    expect(timing.frameCount).toBe(96);
    expect(timing.frameDelayMs * timing.frameCount).toBeCloseTo(8000, 8);

    const smooth = resolveParameterGifTiming(0.25, 20);
    expect(smooth.frameCount).toBe(160);
    expect(smooth.frameDelayMs).toBe(50);

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

  it('uses one traversal for a wrapped curve and omits the duplicate endpoint', () => {
    const timing = resolveRangeGifTiming(0.25, 'wrap');
    expect(timing.durationSeconds).toBe(4);
    expect(timing.frameCount).toBe(48);
    expect(timing.frameDelayMs * timing.frameCount).toBeCloseTo(4000, 8);

    const compact = resolveRangeGifTiming(0.25, 'wrap', 10);
    expect(compact.frameCount).toBe(40);
    expect(compact.frameDelayMs).toBe(100);

    expect(rangeValueForGifFrame(0, 8, 0, 8, 'wrap')).toBe(0);
    expect(rangeValueForGifFrame(0, 8, 7, 8, 'wrap')).toBe(7);
    expect(rangeValueForGifFrame(0, 8, 8, 8, 'wrap')).toBe(0);
  });
});
