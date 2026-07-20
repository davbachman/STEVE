export const PARAMETER_GIF_FPS = 12;
export const PARAMETER_GIF_MAX_FRAMES = 180;

export interface ParameterGifTiming {
  durationSeconds: number;
  frameCount: number;
  frameDelayMs: number;
}

export function resolveParameterGifTiming(
  animationSpeed: number | undefined,
  framesPerSecond = PARAMETER_GIF_FPS,
): ParameterGifTiming {
  return resolveRangeGifTiming(animationSpeed, 'bounce', framesPerSecond);
}

export function resolveRangeGifTiming(
  animationSpeed: number | undefined,
  mode: 'bounce' | 'wrap',
  framesPerSecond = PARAMETER_GIF_FPS,
): ParameterGifTiming {
  const safeSpeed = Number.isFinite(animationSpeed) && (animationSpeed ?? 0) > 0
    ? animationSpeed as number
    : 0.25;
  const safeFramesPerSecond = Number.isFinite(framesPerSecond) && framesPerSecond > 0
    ? framesPerSecond
    : PARAMETER_GIF_FPS;
  const durationSeconds = (mode === 'bounce' ? 2 : 1) / safeSpeed;
  const uncappedFrameCount = Math.max(2, Math.round(durationSeconds * safeFramesPerSecond));
  const normalizedFrameCount = mode === 'bounce'
    ? Math.max(2, Math.round(uncappedFrameCount / 2) * 2)
    : uncappedFrameCount;
  const frameCount = Math.min(PARAMETER_GIF_MAX_FRAMES, normalizedFrameCount);
  return {
    durationSeconds,
    frameCount,
    frameDelayMs: durationSeconds * 1000 / frameCount,
  };
}

export function parameterValueForGifFrame(
  min: number,
  max: number,
  frame: number,
  frameCount: number,
): number {
  const safeFrameCount = Math.max(2, Math.floor(frameCount));
  const wrappedFrame = ((Math.floor(frame) % safeFrameCount) + safeFrameCount) % safeFrameCount;
  const phase = wrappedFrame / safeFrameCount;
  const bounce = phase <= 0.5 ? phase * 2 : (1 - phase) * 2;
  return min + (max - min) * bounce;
}

export function rangeValueForGifFrame(
  min: number,
  max: number,
  frame: number,
  frameCount: number,
  mode: 'bounce' | 'wrap',
): number {
  if (mode === 'bounce') return parameterValueForGifFrame(min, max, frame, frameCount);
  const safeFrameCount = Math.max(2, Math.floor(frameCount));
  const wrappedFrame = ((Math.floor(frame) % safeFrameCount) + safeFrameCount) % safeFrameCount;
  return min + (max - min) * (wrappedFrame / safeFrameCount);
}
