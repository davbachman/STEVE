import { describe, expect, it } from 'vitest';
import { buildImplicitMeshFromScalarField } from '../mesh/implicitMarchingTetra';
import type { Bounds3D } from '../../types/contracts';

const bounds: Bounds3D = {
  min: { x: -4, y: -4, z: -4 },
  max: { x: 4, y: 4, z: 4 },
};

describe('implicit mesher (adaptive sparse octree)', () => {
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
