import { describe, expect, it } from 'vitest';
import {
  TURNTABLE_GIF_MAX_FRAMES,
  resolveTurntableGifDimensions,
  resolveTurntableGifTiming,
} from '../turntableGif';

describe('turntable GIF recording', () => {
  it('preserves the requested revolution duration while capping long recordings', () => {
    const defaultTiming = resolveTurntableGifTiming(20);
    expect(defaultTiming.durationSeconds).toBe(18);
    expect(defaultTiming.frameCount).toBe(360);
    expect(defaultTiming.frameDelayMs).toBe(50);
    expect(defaultTiming.angleStepRadians * defaultTiming.frameCount).toBeCloseTo(Math.PI * 2, 12);

    const slowTiming = resolveTurntableGifTiming(1);
    expect(slowTiming.frameCount).toBe(TURNTABLE_GIF_MAX_FRAMES);
    expect(slowTiming.frameDelayMs * slowTiming.frameCount).toBeCloseTo(360_000, 8);
  });

  it('keeps aspect ratio and caps the longest output dimension at 720px', () => {
    expect(resolveTurntableGifDimensions(1440, 900)).toEqual({ width: 720, height: 450 });
    expect(resolveTurntableGifDimensions(500, 300)).toEqual({ width: 500, height: 300 });
    expect(resolveTurntableGifDimensions(0, Number.NaN)).toEqual({ width: 1, height: 1 });
  });
});
