import { describe, expect, it } from 'vitest';
import { createDefaultCurve, createDefaultIntersection } from '../../state/defaults';
import type { SerializedMesh } from '../../types/contracts';
import { buildPlotGeometry, toPlotGeometry } from '../plotGeometry';

function intersectionCurveMesh(curvePaths: Float32Array[]): SerializedMesh {
  return {
    positions: new Float32Array(0),
    indices: new Uint32Array(0),
    curvePaths,
  };
}

describe('plotGeometry', () => {
  it('builds curve tubes with outward-facing winding', () => {
    const curve = createDefaultCurve('Tube Curve');
    const geometry = buildPlotGeometry(curve);

    let inwardTriangles = 0;
    for (let i = 0; i + 2 < geometry.indices.length; i += 3) {
      const ia = geometry.indices[i] * 3;
      const ib = geometry.indices[i + 1] * 3;
      const ic = geometry.indices[i + 2] * 3;
      const ax = geometry.positions[ia];
      const ay = geometry.positions[ia + 1];
      const az = geometry.positions[ia + 2];
      const bx = geometry.positions[ib];
      const by = geometry.positions[ib + 1];
      const bz = geometry.positions[ib + 2];
      const cx = geometry.positions[ic];
      const cy = geometry.positions[ic + 1];
      const cz = geometry.positions[ic + 2];
      const abx = bx - ax;
      const aby = by - ay;
      const abz = bz - az;
      const acx = cx - ax;
      const acy = cy - ay;
      const acz = cz - az;
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      const vnx = (geometry.normals[ia] + geometry.normals[ib] + geometry.normals[ic]) / 3;
      const vny = (geometry.normals[ia + 1] + geometry.normals[ib + 1] + geometry.normals[ic + 1]) / 3;
      const vnz = (geometry.normals[ia + 2] + geometry.normals[ib + 2] + geometry.normals[ic + 2]) / 3;
      if (nx * vnx + ny * vny + nz * vnz < 0) {
        inwardTriangles += 1;
      }
    }

    expect(inwardTriangles).toBe(0);
  });

  it('builds tube geometry for every intersection curve path', () => {
    const intersection = createDefaultIntersection('Multi-path Intersection');
    const firstPath = new Float32Array([
      0, 0, 0,
      1, 0, 0,
      2, 0.5, 0,
    ]);
    const secondPath = new Float32Array([
      0, 0, 1,
      0, 1, 1,
      0.5, 2, 1,
    ]);

    const geometry = toPlotGeometry(intersection, intersectionCurveMesh([firstPath, secondPath]));

    // Each three-point open path produces three 12-vertex rings, two cap
    // centers, and two ring-to-ring spans plus both cap fans.
    expect(geometry.positions).toHaveLength(2 * (3 * 12 + 2) * 3);
    expect(geometry.normals).toHaveLength(geometry.positions.length);
    expect(geometry.indices).toHaveLength(2 * ((2 * 12 * 6) + (2 * 12 * 3)));
    expect(geometry.curvePath).toBeNull();
    expect(geometry.bounds.radius).toBeGreaterThan(0);
  });

  it('closes a repeated-endpoint intersection path without caps or boundary seams', () => {
    const intersection = createDefaultIntersection('Closed Intersection');
    const closedSquare = new Float32Array([
      0, 0, 0,
      1, 0, 0,
      1, 1, 0,
      0, 1, 0,
      0, 0, 0,
    ]);

    const geometry = toPlotGeometry(intersection, intersectionCurveMesh([closedSquare]));

    // The repeated endpoint is removed. Four rings are joined cyclically;
    // there are no extra cap-center vertices and no open seam edges.
    expect(geometry.positions).toHaveLength(4 * 12 * 3);
    expect(geometry.indices).toHaveLength(4 * 12 * 6);
    expect(geometry.curvePath).toBe(closedSquare);
    expect(geometry.topology).toMatchObject({
      isClosedManifold: true,
      hasBoundaryEdges: false,
      boundaryEdgeCount: 0,
    });
    expect(geometry.boundaryEdges).toHaveLength(0);
  });
});
