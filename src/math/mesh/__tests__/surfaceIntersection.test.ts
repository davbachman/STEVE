import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../types/contracts';
import {
  intersectSurfaceMeshes,
  type SurfaceMeshInput,
} from '../surfaceIntersection';

const ZERO = { x: 0, y: 0, z: 0 };

function surface(
  positions: number[],
  indices: number[],
  translation: Vec3 = ZERO,
): SurfaceMeshInput {
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    translation,
  };
}

function xyPlane(size = 1): SurfaceMeshInput {
  return surface(
    [
      -size, -size, 0,
      size, -size, 0,
      size, size, 0,
      -size, size, 0,
    ],
    [0, 1, 2, 0, 2, 3],
  );
}

function yzPlane(size = 1): SurfaceMeshInput {
  return surface(
    [
      0, -size, -size,
      0, size, -size,
      0, size, size,
      0, -size, size,
    ],
    [0, 1, 2, 0, 2, 3],
  );
}

function cube(centerX = 0, halfSize = 1): SurfaceMeshInput {
  const minX = centerX - halfSize;
  const maxX = centerX + halfSize;
  const low = -halfSize;
  const high = halfSize;
  return surface(
    [
      minX, low, low,
      maxX, low, low,
      maxX, high, low,
      minX, high, low,
      minX, low, high,
      maxX, low, high,
      maxX, high, high,
      minX, high, high,
    ],
    [
      0, 2, 1, 0, 3, 2,
      4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4,
      1, 2, 6, 1, 6, 5,
      2, 3, 7, 2, 7, 6,
      3, 0, 4, 3, 4, 7,
    ],
  );
}

function mergeSurfaces(...meshes: SurfaceMeshInput[]): SurfaceMeshInput {
  const positions: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;
  for (const mesh of meshes) {
    positions.push(...mesh.positions);
    indices.push(...Array.from(mesh.indices, (index) => index + vertexOffset));
    vertexOffset += mesh.positions.length / 3;
  }
  return surface(positions, indices);
}

function pathPoints(path: Float32Array): Vec3[] {
  const points: Vec3[] = [];
  for (let offset = 0; offset + 2 < path.length; offset += 3) {
    points.push({ x: path[offset], y: path[offset + 1], z: path[offset + 2] });
  }
  return points;
}

function expectPointClose(actual: Vec3, expected: Vec3): void {
  expect(actual.x).toBeCloseTo(expected.x, 5);
  expect(actual.y).toBeCloseTo(expected.y, 5);
  expect(actual.z).toBeCloseTo(expected.z, 5);
}

describe('surface mesh intersections', () => {
  it('stitches perpendicular planes into one open path', () => {
    const result = intersectSurfaceMeshes(xyPlane(), yzPlane());

    expect(result.positions).toHaveLength(0);
    expect(result.indices).toHaveLength(0);
    expect(result.curvePaths).toHaveLength(1);
    const points = pathPoints(result.curvePaths?.[0] ?? new Float32Array());
    expect(points.length).toBeGreaterThanOrEqual(2);
    expectPointClose(points[0], { x: 0, y: -1, z: 0 });
    expectPointClose(points[points.length - 1], { x: 0, y: 1, z: 0 });
    for (const point of points) {
      expect(point.x).toBeCloseTo(0, 6);
      expect(point.z).toBeCloseTo(0, 6);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });

  it('is geometrically stable when the two source meshes are reversed', () => {
    const forward = intersectSurfaceMeshes(xyPlane(), yzPlane());
    const reversed = intersectSurfaceMeshes(yzPlane(), xyPlane());
    const forwardPoints = pathPoints(forward.curvePaths?.[0] ?? new Float32Array());
    const reversedPoints = pathPoints(reversed.curvePaths?.[0] ?? new Float32Array());

    expect(reversedPoints).toHaveLength(forwardPoints.length);
    for (let i = 0; i < forwardPoints.length; i += 1) {
      expectPointClose(reversedPoints[i], forwardPoints[i]);
    }
  });

  it('returns a valid empty curve mesh for disjoint surfaces', () => {
    const separated = yzPlane();
    separated.translation = { x: 3, y: 0, z: 0 };
    const result = intersectSurfaceMeshes(xyPlane(), separated);

    expect(result.curvePaths).toEqual([]);
    expect(result.positions).toHaveLength(0);
    expect(result.indices).toHaveLength(0);
    expect(result.bounds?.radius).toBe(0);
    expect(result.topology?.hasBoundaryEdges).toBe(false);
  });

  it('applies both input translations and emits world-space points', () => {
    const horizontal = xyPlane();
    horizontal.translation = { x: 2, y: 3, z: 4 };
    const vertical = yzPlane();
    vertical.translation = { x: 2, y: 3, z: 4 };
    const result = intersectSurfaceMeshes(horizontal, vertical);
    const points = pathPoints(result.curvePaths?.[0] ?? new Float32Array());

    expect(result.curvePaths).toHaveLength(1);
    expectPointClose(points[0], { x: 2, y: 2, z: 4 });
    expectPointClose(points[points.length - 1], { x: 2, y: 4, z: 4 });
    expect(result.bounds?.min.x).toBeCloseTo(2, 6);
    expect(result.bounds?.max.z).toBeCloseTo(4, 6);
  });

  it('stitches a plane section of a cube into a closed path', () => {
    const result = intersectSurfaceMeshes(cube(), xyPlane(2));

    expect(result.curvePaths).toHaveLength(1);
    const points = pathPoints(result.curvePaths?.[0] ?? new Float32Array());
    expect(points.length).toBeGreaterThanOrEqual(5);
    expectPointClose(points[0], points[points.length - 1]);
    expect(Math.min(...points.map((point) => point.x))).toBeCloseTo(-1, 5);
    expect(Math.max(...points.map((point) => point.x))).toBeCloseTo(1, 5);
    expect(Math.min(...points.map((point) => point.y))).toBeCloseTo(-1, 5);
    expect(Math.max(...points.map((point) => point.y))).toBeCloseTo(1, 5);
    for (const point of points) expect(point.z).toBeCloseTo(0, 6);
  });

  it('keeps disconnected intersection loops as separate curve paths', () => {
    const twoCubes = mergeSurfaces(cube(-2, 0.5), cube(2, 0.5));
    const result = intersectSurfaceMeshes(twoCubes, xyPlane(4));

    expect(result.curvePaths).toHaveLength(2);
    for (const path of result.curvePaths ?? []) {
      const points = pathPoints(path);
      expect(points.length).toBeGreaterThanOrEqual(5);
      expectPointClose(points[0], points[points.length - 1]);
      expect(points.every((point) => Number.isFinite(point.x + point.y + point.z))).toBe(true);
    }
  });

  it('safely ignores coplanar overlap and point-only contact', () => {
    const coplanar = intersectSurfaceMeshes(xyPlane(), xyPlane());
    const touching = yzPlane();
    touching.translation = { x: 1, y: 2, z: 0 };
    const pointContact = intersectSurfaceMeshes(xyPlane(), touching);

    expect(coplanar.curvePaths).toEqual([]);
    expect(pointContact.curvePaths).toEqual([]);
    for (const result of [coplanar, pointContact]) {
      expect(Array.from(result.positions).every(Number.isFinite)).toBe(true);
      expect(result.bounds?.radius).toBe(0);
    }
  });
});
