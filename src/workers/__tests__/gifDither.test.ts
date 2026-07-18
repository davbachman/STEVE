import { describe, expect, it } from 'vitest';
import { ditherRgbaInPlace } from '../gifDither';

describe('GIF ordered dithering', () => {
  it('breaks a flat tone into a deterministic light/dark pattern while preserving alpha', () => {
    const pixels = new Uint8ClampedArray(64 * 4).fill(128);
    for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 173;

    ditherRgbaInPlace(pixels, 8);

    const redValues = new Set<number>();
    for (let offset = 0; offset < pixels.length; offset += 4) {
      redValues.add(pixels[offset]);
      expect(pixels[offset]).toBe(pixels[offset + 1]);
      expect(pixels[offset]).toBe(pixels[offset + 2]);
      expect(pixels[offset + 3]).toBe(173);
    }
    expect(Math.min(...redValues)).toBeLessThan(128);
    expect(Math.max(...redValues)).toBeGreaterThan(128);
  });

  it('clamps channel adjustments and can be disabled', () => {
    const extremes = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    ditherRgbaInPlace(extremes, 2, 64);
    expect(Array.from(extremes)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);

    const unchanged = new Uint8ClampedArray([12, 34, 56, 78]);
    ditherRgbaInPlace(unchanged, 1, 0);
    expect(Array.from(unchanged)).toEqual([12, 34, 56, 78]);
  });
});
