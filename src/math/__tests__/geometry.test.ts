import { describe, expect, it } from 'vitest';
import { computeMeshBounds, computeVertexNormals, extractMeshEdges } from '../mesh/geometry';

describe('geometry helpers', () => {
  it('computes mesh bounds and radius', () => {
    const bounds = computeMeshBounds([
      -2, 1, 0,
      4, -3, 2,
      1, 2, -5,
    ]);

    expect(bounds.min).toEqual({ x: -2, y: -3, z: -5 });
    expect(bounds.max).toEqual({ x: 4, y: 2, z: 2 });
    expect(bounds.center).toEqual({ x: 1, y: -0.5, z: -1.5 });
    expect(bounds.radius).toBeGreaterThan(0);
  });

  it('computes smooth vertex normals for a planar quad', () => {
    const normals = computeVertexNormals(
      [
        -1, -1, 0,
        1, -1, 0,
        1, 1, 0,
        -1, 1, 0,
      ],
      [0, 1, 2, 0, 2, 3],
    );

    for (let i = 0; i < normals.length; i += 3) {
      expect(normals[i]).toBeCloseTo(0, 6);
      expect(normals[i + 1]).toBeCloseTo(0, 6);
      expect(normals[i + 2]).toBeCloseTo(1, 6);
    }
  });

  it('extracts boundary edges from open surfaces', () => {
    const edgeData = extractMeshEdges(
      [
        -1, -1, 0,
        1, -1, 0,
        1, 1, 0,
        -1, 1, 0,
      ],
      [0, 1, 2, 0, 2, 3],
    );

    expect(edgeData.topology.isClosedManifold).toBe(false);
    expect(edgeData.topology.hasBoundaryEdges).toBe(true);
    expect(edgeData.topology.boundaryEdgeCount).toBe(4);
    expect(edgeData.boundaryEdges.length).toBe(24);
  });

  it('extracts feature edges from sharp folds', () => {
    const edgeData = extractMeshEdges(
      [
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
      ],
      [0, 1, 2, 0, 3, 1],
      20,
    );

    expect(edgeData.topology.hasFeatureEdges).toBe(true);
    expect(edgeData.topology.featureEdgeCount).toBeGreaterThan(0);
    expect(edgeData.featureEdges.length).toBeGreaterThanOrEqual(6);
  });
});
