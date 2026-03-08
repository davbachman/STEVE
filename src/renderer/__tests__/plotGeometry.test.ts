import { describe, expect, it } from 'vitest';
import { createDefaultCurve } from '../../state/defaults';
import { buildPlotGeometry } from '../plotGeometry';

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
});
