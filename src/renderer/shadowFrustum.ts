import { mat4, vec3 } from 'gl-matrix';
import type { Vec3 } from '../types/contracts';
import { resolveShadowUpVector } from './renderBudget';

export interface ShadowBounds {
  min: Vec3;
  max: Vec3;
}

/** Fit in light space, independent of the camera. Ground extends depth only:
 * outside the objects' projected footprint there is nothing to cast a shadow.
 */
export function fitDirectionalShadow(
  bounds: ReadonlyArray<ShadowBounds>,
  direction: Vec3,
  resolution: number,
  groundSize?: number,
): { matrix: mat4; texelDepth: number } {
  const view = mat4.lookAt(mat4.create(), [0, 0, 0],
    [direction.x, direction.y, direction.z], resolveShadowUpVector(direction));
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const include = (box: ShadowBounds, depthOnly = false) => {
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const p = vec3.transformMat4(vec3.create(), [x, y, z], view);
          for (let axis = depthOnly ? 2 : 0; axis < 3; axis += 1) {
            min[axis] = Math.min(min[axis], p[axis]);
            max[axis] = Math.max(max[axis], p[axis]);
          }
        }
      }
    }
  };
  const finiteBounds = bounds.filter((box) => [...Object.values(box.min), ...Object.values(box.max)].every(Number.isFinite));
  for (const box of finiteBounds) include(box);
  if (finiteBounds.length === 0) include({ min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } });
  if (groundSize !== undefined) {
    const half = groundSize;
    include({ min: { x: -half, y: -half, z: 0 }, max: { x: half, y: half, z: 0 } }, true);
  }
  const size = Math.max(16, resolution);
  const spanX = Math.max(0.1, max[0] - min[0]);
  const spanY = Math.max(0.1, max[1] - min[1]);
  // Padding covers the PCF footprint and the half-texel shift from snapping.
  const width = spanX * (1.04 + 8 / size);
  const height = spanY * (1.04 + 8 / size);
  const texelX = width / size;
  const texelY = height / size;
  const centerX = Math.round((min[0] + max[0]) / 2 / texelX) * texelX;
  const centerY = Math.round((min[1] + max[1]) / 2 / texelY) * texelY;
  const depthPadding = Math.max(0.1, (max[2] - min[2]) * 0.02);
  const near = -max[2] - depthPadding;
  const far = -min[2] + depthPadding;
  const projection = mat4.ortho(mat4.create(), centerX - width / 2, centerX + width / 2,
    centerY - height / 2, centerY + height / 2, near, far);
  return {
    matrix: mat4.multiply(mat4.create(), projection, view),
    texelDepth: Math.max(texelX, texelY) / (far - near),
  };
}
