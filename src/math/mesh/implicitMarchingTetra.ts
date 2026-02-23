import type { Bounds3D, ImplicitSurfaceSpec, SerializedMesh } from '../../types/contracts';

const tetrahedra: Array<[number, number, number, number]> = [
  [0, 5, 1, 6],
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
];

const cubeCorners: Array<[number, number, number]> = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

const tetraEdges: Array<[number, number]> = [
  [0, 1],
  [1, 2],
  [2, 0],
  [0, 3],
  [1, 3],
  [2, 3],
];

function qualityResolution(quality: ImplicitSurfaceSpec['quality']): number {
  switch (quality) {
    case 'draft':
      return 14;
    case 'medium':
      return 22;
    case 'high':
      return 30;
  }
}

interface ScalarFieldFn {
  (x: number, y: number, z: number): number;
}

interface V3 {
  x: number;
  y: number;
  z: number;
}

export function buildImplicitMeshFromScalarField(
  bounds: Bounds3D,
  scalarField: ScalarFieldFn,
  quality: ImplicitSurfaceSpec['quality'],
  isoValue = 0,
): SerializedMesh {
  const n = qualityResolution(quality);
  const nx = n;
  const ny = n;
  const nz = n;

  const dx = (bounds.max.x - bounds.min.x) / nx;
  const dy = (bounds.max.y - bounds.min.y) / ny;
  const dz = (bounds.max.z - bounds.min.z) / nz;

  const values = new Float32Array((nx + 1) * (ny + 1) * (nz + 1));
  const gridIndex = (i: number, j: number, k: number) => (k * (ny + 1) + j) * (nx + 1) + i;

  for (let k = 0; k <= nz; k += 1) {
    const z = bounds.min.z + dz * k;
    for (let j = 0; j <= ny; j += 1) {
      const y = bounds.min.y + dy * j;
      for (let i = 0; i <= nx; i += 1) {
        const x = bounds.min.x + dx * i;
        values[gridIndex(i, j, k)] = scalarField(x, y, z) - isoValue;
      }
    }
  }

  const positions: number[] = [];
  const indices: number[] = [];

  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const cubePos: V3[] = cubeCorners.map(([cx, cy, cz]) => ({
          x: bounds.min.x + (i + cx) * dx,
          y: bounds.min.y + (j + cy) * dy,
          z: bounds.min.z + (k + cz) * dz,
        }));
        const cubeVal = cubeCorners.map(([cx, cy, cz]) => values[gridIndex(i + cx, j + cy, k + cz)]);

        for (const tet of tetrahedra) {
          polygonizeTetra(tet.map((idx) => cubePos[idx]), tet.map((idx) => cubeVal[idx]), positions, indices);
        }
      }
    }
  }

  const normals = computeVertexNormals(positions, indices);

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals: new Float32Array(normals),
  };
}

function polygonizeTetra(points: V3[], values: number[], positions: number[], indices: number[]): void {
  const inside = values.map((v) => v <= 0);
  const insideCount = inside.reduce((sum, v) => sum + (v ? 1 : 0), 0);
  if (insideCount === 0 || insideCount === 4) {
    return;
  }

  const intersections: V3[] = [];
  for (const [a, b] of tetraEdges) {
    const va = values[a];
    const vb = values[b];
    const crosses = (va <= 0 && vb > 0) || (va > 0 && vb <= 0);
    if (!crosses) {
      continue;
    }
    const t = va / (va - vb);
    intersections.push(lerp(points[a], points[b], clamp01(t)));
  }

  if (intersections.length < 3) {
    return;
  }

  if (intersections.length === 3) {
    addTriangle(intersections[0], intersections[1], intersections[2], positions, indices);
    return;
  }

  if (intersections.length === 4) {
    const ordered = sortPolygon4(intersections);
    addTriangle(ordered[0], ordered[1], ordered[2], positions, indices);
    addTriangle(ordered[0], ordered[2], ordered[3], positions, indices);
    return;
  }

  // Rare degeneracy: fan triangulate.
  for (let i = 1; i < intersections.length - 1; i += 1) {
    addTriangle(intersections[0], intersections[i], intersections[i + 1], positions, indices);
  }
}

function sortPolygon4(points: V3[]): V3[] {
  const centroid = points.reduce(
    (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }),
    { x: 0, y: 0, z: 0 },
  );
  centroid.x /= points.length;
  centroid.y /= points.length;
  centroid.z /= points.length;

  // Project around dominant axis-free plane using simple angle in XY after centering.
  return [...points].sort((a, b) => {
    const aa = Math.atan2(a.y - centroid.y, a.x - centroid.x);
    const bb = Math.atan2(b.y - centroid.y, b.x - centroid.x);
    return aa - bb;
  });
}

function addTriangle(a: V3, b: V3, c: V3, positions: number[], indices: number[]): void {
  const base = positions.length / 3;
  positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  indices.push(base, base + 1, base + 2);
}

function lerp(a: V3, b: V3, t: number): V3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.5));
}

function computeVertexNormals(positions: number[], indices: number[]): number[] {
  const normals = new Array<number>(positions.length).fill(0);
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3;
    const ib = indices[i + 1] * 3;
    const ic = indices[i + 2] * 3;

    const ax = positions[ia];
    const ay = positions[ia + 1];
    const az = positions[ia + 2];
    const bx = positions[ib];
    const by = positions[ib + 1];
    const bz = positions[ib + 2];
    const cx = positions[ic];
    const cy = positions[ic + 1];
    const cz = positions[ic + 2];

    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;

    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    normals[ia] += nx;
    normals[ia + 1] += ny;
    normals[ia + 2] += nz;
    normals[ib] += nx;
    normals[ib + 1] += ny;
    normals[ib + 2] += nz;
    normals[ic] += nx;
    normals[ic + 1] += ny;
    normals[ic + 2] += nz;
  }

  for (let i = 0; i < normals.length; i += 3) {
    const nx = normals[i];
    const ny = normals[i + 1];
    const nz = normals[i + 2];
    const len = Math.hypot(nx, ny, nz) || 1;
    normals[i] = nx / len;
    normals[i + 1] = ny / len;
    normals[i + 2] = nz / len;
  }
  return normals;
}
