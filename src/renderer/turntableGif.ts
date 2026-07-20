export const TURNTABLE_GIF_FPS = 20;
export const TURNTABLE_GIF_MAX_DIMENSION = 720;
export const TURNTABLE_GIF_MAX_FRAMES = 360;

export interface TurntableGifTiming {
  durationSeconds: number;
  frameCount: number;
  frameDelayMs: number;
  angleStepRadians: number;
}

export function resolveTurntableGifTiming(
  speedDegreesPerSecond: number,
  framesPerSecond = TURNTABLE_GIF_FPS,
): TurntableGifTiming {
  const safeSpeed = Number.isFinite(speedDegreesPerSecond) && speedDegreesPerSecond > 0
    ? speedDegreesPerSecond
    : 1;
  const safeFramesPerSecond = Number.isFinite(framesPerSecond) && framesPerSecond > 0
    ? framesPerSecond
    : TURNTABLE_GIF_FPS;
  const durationSeconds = 360 / safeSpeed;
  const frameCount = Math.min(
    TURNTABLE_GIF_MAX_FRAMES,
    Math.max(1, Math.round(durationSeconds * safeFramesPerSecond)),
  );
  return {
    durationSeconds,
    frameCount,
    frameDelayMs: durationSeconds * 1000 / frameCount,
    angleStepRadians: Math.PI * 2 / frameCount,
  };
}

export function resolveTurntableGifDimensions(
  width: number,
  height: number,
  maxDimension = TURNTABLE_GIF_MAX_DIMENSION,
): { width: number; height: number } {
  const safeWidth = Math.max(1, Math.round(Number.isFinite(width) ? width : 1));
  const safeHeight = Math.max(1, Math.round(Number.isFinite(height) ? height : 1));
  const safeMaxDimension = Math.max(1, Math.round(Number.isFinite(maxDimension) ? maxDimension : 1));
  const scale = Math.min(1, safeMaxDimension / Math.max(safeWidth, safeHeight));
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}
