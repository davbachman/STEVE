import { describe, expect, it } from 'vitest';
import { vec3 } from 'gl-matrix';
import { fitDirectionalShadow, type ShadowBounds } from '../shadowFrustum';

const knot: ShadowBounds = { min: { x: -3.3, y: -3.3, z: 0.5 }, max: { x: 3.3, y: 3.3, z: 3 } };
const direction = { x: -0.6, y: -0.4, z: -1 };

describe('directional shadow coverage', () => {
  it('covers every corner of separated, translated meshes, including tall geometry', () => {
    const boxes = [knot, { min: { x: 20, y: -14, z: -4 }, max: { x: 24, y: -10, z: 80 } }];
    const { matrix } = fitDirectionalShadow(boxes, direction, 1024);
    for (const box of boxes) {
      for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            const p = vec3.transformMat4(vec3.create(), [x, y, z], matrix);
            for (const component of p) expect(Math.abs(component)).toBeLessThan(1);
          }
        }
      }
    }
  });

  it('keeps compact geometry large in the map even with a large ground plane', () => {
    const fit = fitDirectionalShadow([knot], direction, 1024);
    const groundFit = fitDirectionalShadow([knot], direction, 1024, 100);
    const point = [knot.max.x, knot.max.y, knot.max.z];
    const a = vec3.transformMat4(vec3.create(), point, fit.matrix);
    const b = vec3.transformMat4(vec3.create(), point, groundFit.matrix);
    expect(b[0]).toBeCloseTo(a[0]);
    expect(b[1]).toBeCloseTo(a[1]);
    const left = vec3.transformMat4(vec3.create(), [-3.3, 3.3, 1], groundFit.matrix);
    const right = vec3.transformMat4(vec3.create(), [3.3, -3.3, 1], groundFit.matrix);
    expect(Math.abs(left[0] - right[0])).toBeGreaterThan(1.5);
  });

  it('includes the ground shadow footprint without expanding the lateral coverage', () => {
    const { matrix } = fitDirectionalShadow([knot], direction, 1024, 16);
    const caster = [3, 3, 3];
    const ground = caster.map((value, axis) => value + 3 * [direction.x, direction.y, direction.z][axis]);
    const a = vec3.transformMat4(vec3.create(), caster, matrix);
    const b = vec3.transformMat4(vec3.create(), ground, matrix);
    expect(b[0]).toBeCloseTo(a[0]);
    expect(b[1]).toBeCloseTo(a[1]);
    for (const component of b) expect(Math.abs(component)).toBeLessThan(1);
  });

  it('handles vertical lights, flat surfaces, and an empty scene without singular matrices', () => {
    for (const bounds of [[], [{ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }]]) {
      for (const z of [-1, 1]) {
        const fit = fitDirectionalShadow(bounds, { x: 0, y: 0, z }, 1024);
        expect(Array.from(fit.matrix).every(Number.isFinite)).toBe(true);
        expect(fit.texelDepth).toBeGreaterThan(0);
      }
    }
  });
});
