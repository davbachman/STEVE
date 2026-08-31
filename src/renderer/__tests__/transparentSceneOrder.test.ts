import { describe, expect, it } from 'vitest';
import {
  farthestPositionFromCamera,
  sortTransparentSceneBackToFront,
} from '../transparentSceneOrder';

describe('transparent scene ordering', () => {
  it('interleaves plots and point-light gizmos from far to near', () => {
    const ordered = sortTransparentSceneBackToFront([
      { item: 'near plot', position: { x: 0, y: 2, z: 0 } },
      { item: 'middle light', position: { x: 0, y: 5, z: 0 } },
      { item: 'far plot', position: { x: 0, y: 9, z: 0 } },
      { item: 'farther light', position: { x: 0, y: 12, z: 0 } },
    ], { x: 0, y: 0, z: 0 });

    expect(ordered).toEqual(['farther light', 'far plot', 'middle light', 'near plot']);
  });

  it('preserves insertion order when entries are equally distant', () => {
    const ordered = sortTransparentSceneBackToFront([
      { item: 'first', position: { x: -4, y: 0, z: 0 } },
      { item: 'second', position: { x: 4, y: 0, z: 0 } },
    ], { x: 0, y: 0, z: 0 });

    expect(ordered).toEqual(['first', 'second']);
  });

  it('finds the farthest pinned-light position for a shared transparent curve', () => {
    const farthest = farthestPositionFromCamera([
      { x: 0, y: 3, z: 0 },
      { x: 0, y: 8, z: 0 },
      { x: 0, y: 5, z: 0 },
    ], { x: 0, y: 0, z: 0 });

    expect(farthest).toEqual({ x: 0, y: 8, z: 0 });
    expect(farthestPositionFromCamera([], { x: 0, y: 0, z: 0 })).toBeNull();
  });
});
