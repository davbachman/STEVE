const BAYER_8X8 = new Uint8Array([
  0, 48, 12, 60, 3, 51, 15, 63,
  32, 16, 44, 28, 35, 19, 47, 31,
  8, 56, 4, 52, 11, 59, 7, 55,
  40, 24, 36, 20, 43, 27, 39, 23,
  2, 50, 14, 62, 1, 49, 13, 61,
  34, 18, 46, 30, 33, 17, 45, 29,
  10, 58, 6, 54, 9, 57, 5, 53,
  42, 26, 38, 22, 41, 25, 37, 21,
]);

export const GIF_DITHER_STRENGTH = 16;

/**
 * Applies a subtle ordered luminance dither before pixels are mapped to the
 * GIF palette. The alpha channel is preserved and the operation is in-place
 * to avoid allocating another full-resolution frame inside the worker.
 */
export function ditherRgbaInPlace(
  pixels: Uint8ClampedArray,
  width: number,
  strength = GIF_DITHER_STRENGTH,
): void {
  const safeWidth = Math.max(1, Math.floor(width));
  const pixelCount = Math.floor(pixels.length / 4);
  const safeStrength = Number.isFinite(strength) ? Math.max(0, strength) : GIF_DITHER_STRENGTH;
  if (safeStrength === 0 || pixelCount === 0) return;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const x = pixel % safeWidth;
    const y = Math.floor(pixel / safeWidth);
    const threshold = BAYER_8X8[(y & 7) * 8 + (x & 7)];
    const adjustment = (((threshold + 0.5) / 64) - 0.5) * safeStrength;
    const offset = pixel * 4;
    pixels[offset] += adjustment;
    pixels[offset + 1] += adjustment;
    pixels[offset + 2] += adjustment;
  }
}
