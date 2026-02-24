import { describe, expect, it } from 'vitest';
import { buildImplicitMeshFromScalarField } from '../mesh/implicitMarchingTetra';
import type { Bounds3D } from '../../types/contracts';

const bounds: Bounds3D = {
  min: { x: -4, y: -4, z: -4 },
  max: { x: 4, y: 4, z: 4 },
};

describe('implicit mesher', () => {
  it('builds a non-empty sphere mesh with approximate bounds', () => {
    const mesh = buildImplicitMeshFromScalarField(bounds, (x, y, z) => x * x + y * y + z * z, 'medium', 9);
    expect(mesh.positions.length).toBeGreaterThan(0);
    expect(mesh.indices.length).toBeGreaterThan(0);

    const bb = boundsOf(mesh.positions);
    expect(bb.max.x).toBeGreaterThan(2.4);
    expect(bb.min.x).toBeLessThan(-2.4);
    expect(Math.abs(bb.max.x - 3)).toBeLessThan(1.0);
    expect(Math.abs(bb.min.x + 3)).toBeLessThan(1.0);
  });

  it('quality presets increase mesh detail monotonically for a sphere', () => {
    const sphere = (x: number, y: number, z: number) => x * x + y * y + z * z;
    const draft = buildImplicitMeshFromScalarField(bounds, sphere, 'draft', 9);
    const medium = buildImplicitMeshFromScalarField(bounds, sphere, 'medium', 9);
    const high = buildImplicitMeshFromScalarField(bounds, sphere, 'high', 9);

    expect(draft.indices.length).toBeGreaterThan(0);
    expect(medium.indices.length).toBeGreaterThan(draft.indices.length);
    expect(high.indices.length).toBeGreaterThan(medium.indices.length);
  });

  it('builds a torus-like implicit mesh', () => {
    const torus = (x: number, y: number, z: number) => {
      const q = Math.sqrt(x * x + y * y) - 2;
      return q * q + z * z;
    };
    const mesh = buildImplicitMeshFromScalarField(bounds, torus, 'medium', 0.25);
    expect(mesh.indices.length).toBeGreaterThan(300);
    expect(mesh.normals?.length ?? 0).toBe(mesh.positions.length);
  });

  it('produces a watertight high-quality sphere mesh (no boundary or non-manifold edges)', () => {
    const mesh = buildImplicitMeshFromScalarField(bounds, (x, y, z) => x * x + y * y + z * z, 'high', 9);
    expectClosedWatertight(mesh);
  });

  it('produces watertight shifted-sphere meshes across quality presets', () => {
    const shiftedSphere = (x: number, y: number, z: number) =>
      (x - 0.2) ** 2 + (y + 0.35) ** 2 + (z - 0.15) ** 2 - 2.3 ** 2;
    for (const quality of ['draft', 'medium', 'high'] as const) {
      const mesh = buildImplicitMeshFromScalarField(bounds, shiftedSphere, quality, 0);
      expectClosedWatertight(mesh);
    }
  });

  it('produces watertight torus meshes across quality presets', () => {
    const torus = (x: number, y: number, z: number) => {
      const q = Math.sqrt(x * x + y * y) - 2;
      return q * q + z * z - 0.5 ** 2;
    };
    for (const quality of ['draft', 'medium', 'high'] as const) {
      const mesh = buildImplicitMeshFromScalarField(bounds, torus, quality, 0);
      expectClosedWatertight(mesh);
    }
  });

  it('produces a watertight high-quality ellipsoid mesh', () => {
    const ellipsoid = (x: number, y: number, z: number) => x * x / 9 + y * y / 4 + z * z / 2.25 - 1;
    const mesh = buildImplicitMeshFromScalarField(bounds, ellipsoid, 'high', 0);
    expectClosedWatertight(mesh);
  });

  it('emits outward-pointing normals for a sphere regardless of scalar sign', () => {
    const center = { x: 0, y: 0, z: 0 };
    const sphere = (x: number, y: number, z: number) => x * x + y * y + z * z - 4;
    const positive = buildImplicitMeshFromScalarField(bounds, sphere, 'high', 0);
    const negative = buildImplicitMeshFromScalarField(bounds, (x, y, z) => -sphere(x, y, z), 'high', 0);

    expect(averageRadialNormalDot(positive, center)).toBeGreaterThan(0.25);
    expect(averageRadialNormalDot(negative, center)).toBeGreaterThan(0.25);
  });

  it('does not introduce vertical seam cracks for a clipped cylinder', () => {
    const cylinderBounds: Bounds3D = {
      min: { x: -4, y: -4, z: -8 },
      max: { x: 4, y: 4, z: 8 },
    };
    const mesh = buildImplicitMeshFromScalarField(cylinderBounds, (x, y, _z) => x * x + y * y, 'high', 9);
    const topo = edgeTopology(mesh);
    expect(topo.nonManifoldEdges).toBe(0);

    // The infinite cylinder is clipped by bounds, so open boundary rings at z=min/max are expected.
    const boundaryMidZ = boundaryEdgeMidpointZ(mesh);
    expect(boundaryMidZ.length).toBeGreaterThan(0);
    for (const z of boundaryMidZ) {
      expect(Math.abs(Math.abs(z) - 8)).toBeLessThan(1e-6);
    }
  });

  it('meshes xyz=1 in all four XY quadrants without internal cracks', () => {
    const xyzBounds: Bounds3D = {
      min: { x: -5, y: -5, z: -5 },
      max: { x: 5, y: 5, z: 5 },
    };
    const mesh = buildImplicitMeshFromScalarField(xyzBounds, (x, y, z) => x * y * z, 'high', 1);
    const topo = edgeTopology(mesh);
    expect(topo.nonManifoldEdges).toBe(0);
    expect(internalBoundaryEdges(mesh, xyzBounds)).toBe(0);

    const quadrants = topProjectionQuadrantTriangleCounts(mesh);
    expect(quadrants['++'] ?? 0).toBeGreaterThan(0);
    expect(quadrants['+-'] ?? 0).toBeGreaterThan(0);
    expect(quadrants['-+'] ?? 0).toBeGreaterThan(0);
    expect(quadrants['--'] ?? 0).toBeGreaterThan(0);
  });

  it('returns empty mesh for invalid bounds', () => {
    const invalid: Bounds3D = {
      min: { x: 1, y: -1, z: -1 },
      max: { x: 1, y: 1, z: 1 },
    };
    const mesh = buildImplicitMeshFromScalarField(invalid, (x, y, z) => x + y + z, 'draft', 0);
    expect(mesh.positions.length).toBe(0);
    expect(mesh.indices.length).toBe(0);
  });
});

function boundsOf(positions: Float32Array) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]);
    minY = Math.min(minY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]);
    maxX = Math.max(maxX, positions[i]);
    maxY = Math.max(maxY, positions[i + 1]);
    maxZ = Math.max(maxZ, positions[i + 2]);
  }
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  };
}

function edgeTopology(mesh: { indices: Uint32Array }) {
  const edgeCounts = new Map<string, number>();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const tri = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    for (let e = 0; e < 3; e += 1) {
      let a = tri[e];
      let b = tri[(e + 1) % 3];
      if (a > b) [a, b] = [b, a];
      const key = `${a}|${b}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of edgeCounts.values()) {
    if (count === 1) boundaryEdges += 1;
    else if (count > 2) nonManifoldEdges += 1;
  }
  return { boundaryEdges, nonManifoldEdges };
}

function expectClosedWatertight(mesh: { positions: Float32Array; indices: Uint32Array }) {
  const topo = edgeTopology(mesh);
  expect(mesh.indices.length).toBeGreaterThan(0);
  expect(topo.boundaryEdges).toBe(0);
  expect(topo.nonManifoldEdges).toBe(0);
}

function averageRadialNormalDot(
  mesh: { positions: Float32Array; normals?: Float32Array },
  center: { x: number; y: number; z: number },
): number {
  const normals = mesh.normals;
  if (!normals || normals.length !== mesh.positions.length) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const px = mesh.positions[i] - center.x;
    const py = mesh.positions[i + 1] - center.y;
    const pz = mesh.positions[i + 2] - center.z;
    const plen = Math.hypot(px, py, pz);
    if (plen < 1e-6) continue;
    const rx = px / plen;
    const ry = py / plen;
    const rz = pz / plen;
    const nx = normals[i];
    const ny = normals[i + 1];
    const nz = normals[i + 2];
    sum += rx * nx + ry * ny + rz * nz;
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

function boundaryEdgeMidpointZ(mesh: { positions: Float32Array; indices: Uint32Array }): number[] {
  const edgeCounts = new Map<string, { count: number; a: number; b: number }>();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const tri = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    for (let e = 0; e < 3; e += 1) {
      let a = tri[e];
      let b = tri[(e + 1) % 3];
      if (a > b) [a, b] = [b, a];
      const key = `${a}|${b}`;
      const existing = edgeCounts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        edgeCounts.set(key, { count: 1, a, b });
      }
    }
  }

  const out: number[] = [];
  for (const edge of edgeCounts.values()) {
    if (edge.count !== 1) continue;
    const az = mesh.positions[edge.a * 3 + 2];
    const bz = mesh.positions[edge.b * 3 + 2];
    out.push((az + bz) * 0.5);
  }
  return out;
}

function internalBoundaryEdges(mesh: { positions: Float32Array; indices: Uint32Array }, bounds: Bounds3D): number {
  const edgeCounts = new Map<string, { count: number; a: number; b: number }>();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const tri = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    for (let e = 0; e < 3; e += 1) {
      let a = tri[e];
      let b = tri[(e + 1) % 3];
      if (a > b) [a, b] = [b, a];
      const key = `${a}|${b}`;
      const existing = edgeCounts.get(key);
      if (existing) existing.count += 1;
      else edgeCounts.set(key, { count: 1, a, b });
    }
  }

  const p = mesh.positions;
  const eps = 1e-6;
  let internal = 0;
  for (const edge of edgeCounts.values()) {
    if (edge.count !== 1) continue;
    const ax = p[edge.a * 3];
    const ay = p[edge.a * 3 + 1];
    const az = p[edge.a * 3 + 2];
    const bx = p[edge.b * 3];
    const by = p[edge.b * 3 + 1];
    const bz = p[edge.b * 3 + 2];
    const onBounds =
      (Math.abs(ax - bounds.min.x) < eps && Math.abs(bx - bounds.min.x) < eps) ||
      (Math.abs(ax - bounds.max.x) < eps && Math.abs(bx - bounds.max.x) < eps) ||
      (Math.abs(ay - bounds.min.y) < eps && Math.abs(by - bounds.min.y) < eps) ||
      (Math.abs(ay - bounds.max.y) < eps && Math.abs(by - bounds.max.y) < eps) ||
      (Math.abs(az - bounds.min.z) < eps && Math.abs(bz - bounds.min.z) < eps) ||
      (Math.abs(az - bounds.max.z) < eps && Math.abs(bz - bounds.max.z) < eps);
    if (!onBounds) internal += 1;
  }
  return internal;
}

function topProjectionQuadrantTriangleCounts(mesh: { positions: Float32Array; indices: Uint32Array }): Record<string, number> {
  const counts: Record<string, number> = {};
  const p = mesh.positions;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const ia = mesh.indices[i] * 3;
    const ib = mesh.indices[i + 1] * 3;
    const ic = mesh.indices[i + 2] * 3;
    const cx = (p[ia] + p[ib] + p[ic]) / 3;
    const cy = (p[ia + 1] + p[ib + 1] + p[ic + 1]) / 3;
    if (Math.abs(cx) < 1e-6 || Math.abs(cy) < 1e-6) continue;
    const key = `${cx > 0 ? '+' : '-'}${cy > 0 ? '+' : '-'}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
