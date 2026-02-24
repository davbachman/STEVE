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

interface ScalarFieldFn {
  (x: number, y: number, z: number): number;
}

interface V3 {
  x: number;
  y: number;
  z: number;
}

interface QualityConfig {
  rootDivisions: number;
  maxDepth: number;
  maxLeafCells: number;
}

interface CubeCell {
  min: V3;
  max: V3;
  corners: V3[];
  values: number[];
}

interface MeshBuildContext {
  bounds: Bounds3D;
  isoValue: number;
  scalarField: ScalarFieldFn;
  sampleCache: Map<string, number>;
  quality: QualityConfig;
  rawTriangles: number[];
  leafCount: number;
  zeroSnapEps: number;
  zeroResolveNudge: number;
}

export function buildImplicitMeshFromScalarField(
  bounds: Bounds3D,
  scalarField: ScalarFieldFn,
  quality: ImplicitSurfaceSpec['quality'],
  isoValue = 0,
): SerializedMesh {
  if (!isValidBounds(bounds) || !Number.isFinite(isoValue)) {
    return emptyMesh();
  }

  const config = qualityConfig(quality);
  const ctx: MeshBuildContext = {
    bounds,
    isoValue,
    scalarField,
    sampleCache: new Map(),
    quality: config,
    rawTriangles: [],
    leafCount: 0,
    zeroSnapEps: Math.max(
      Math.hypot(
        bounds.max.x - bounds.min.x,
        bounds.max.y - bounds.min.y,
        bounds.max.z - bounds.min.z,
      ) * 1e-12,
      1e-12,
    ),
    zeroResolveNudge: Math.max(
      Math.hypot(
        bounds.max.x - bounds.min.x,
        bounds.max.y - bounds.min.y,
        bounds.max.z - bounds.min.z,
      ) * 1e-9,
      1e-9,
    ),
  };

  const rootDiv = config.rootDivisions;
  const xSpan = bounds.max.x - bounds.min.x;
  const ySpan = bounds.max.y - bounds.min.y;
  const zSpan = bounds.max.z - bounds.min.z;

  for (let k = 0; k < rootDiv; k += 1) {
    const z0 = bounds.min.z + (zSpan * k) / rootDiv;
    const z1 = bounds.min.z + (zSpan * (k + 1)) / rootDiv;
    for (let j = 0; j < rootDiv; j += 1) {
      const y0 = bounds.min.y + (ySpan * j) / rootDiv;
      const y1 = bounds.min.y + (ySpan * (j + 1)) / rootDiv;
      for (let i = 0; i < rootDiv; i += 1) {
        const x0 = bounds.min.x + (xSpan * i) / rootDiv;
        const x1 = bounds.min.x + (xSpan * (i + 1)) / rootDiv;
        const cell = sampleCell(ctx, { x: x0, y: y0, z: z0 }, { x: x1, y: y1, z: z1 });
        subdivideAdaptive(ctx, cell, 0);
      }
    }
  }

  return finalizeImplicitMesh(ctx);
}

function qualityConfig(quality: ImplicitSurfaceSpec['quality']): QualityConfig {
  switch (quality) {
    case 'draft':
      return { rootDivisions: 4, maxDepth: 2, maxLeafCells: 90_000 };
    case 'medium':
      return { rootDivisions: 4, maxDepth: 3, maxLeafCells: 260_000 };
    case 'high':
      return { rootDivisions: 6, maxDepth: 3, maxLeafCells: 520_000 };
  }
}

function subdivideAdaptive(ctx: MeshBuildContext, cell: CubeCell, depth: number): void {
  if (!cellMightContainSurface(ctx, cell)) {
    return;
  }

  if (depth >= ctx.quality.maxDepth || ctx.leafCount >= ctx.quality.maxLeafCells) {
    polygonizeCubeAsTetra(ctx.rawTriangles, cell.corners, cell.values);
    ctx.leafCount += 1;
    return;
  }

  const mx = (cell.min.x + cell.max.x) * 0.5;
  const my = (cell.min.y + cell.max.y) * 0.5;
  const mz = (cell.min.z + cell.max.z) * 0.5;

  for (let bz = 0; bz < 2; bz += 1) {
    for (let by = 0; by < 2; by += 1) {
      for (let bx = 0; bx < 2; bx += 1) {
        const childMin = {
          x: bx === 0 ? cell.min.x : mx,
          y: by === 0 ? cell.min.y : my,
          z: bz === 0 ? cell.min.z : mz,
        };
        const childMax = {
          x: bx === 0 ? mx : cell.max.x,
          y: by === 0 ? my : cell.max.y,
          z: bz === 0 ? mz : cell.max.z,
        };
        const child = sampleCell(ctx, childMin, childMax);
        subdivideAdaptive(ctx, child, depth + 1);
      }
    }
  }
}

function sampleCell(ctx: MeshBuildContext, min: V3, max: V3): CubeCell {
  const corners = cubeCorners.map(([cx, cy, cz]) => ({
    x: cx ? max.x : min.x,
    y: cy ? max.y : min.y,
    z: cz ? max.z : min.z,
  }));
  const values = corners.map((p) => sampleScalar(ctx, p.x, p.y, p.z));
  return { min, max, corners, values };
}

function cellMightContainSurface(ctx: MeshBuildContext, cell: CubeCell): boolean {
  const finiteCornerValues = cell.values.filter(Number.isFinite);
  if (finiteCornerValues.length < 2) {
    return false;
  }

  let hasPositive = false;
  let hasNegative = false;
  for (const v of finiteCornerValues) {
    if (v > 0) hasPositive = true;
    if (v < 0) hasNegative = true;
    if (hasPositive && hasNegative) {
      return true;
    }
    if (Math.abs(v) < 1e-12) {
      return true;
    }
  }

  // Heuristic probe pass to catch surfaces that pass through the cell interior
  // without flipping any corner sign (small centered features / tangencies).
  const cx = (cell.min.x + cell.max.x) * 0.5;
  const cy = (cell.min.y + cell.max.y) * 0.5;
  const cz = (cell.min.z + cell.max.z) * 0.5;
  const probes: V3[] = [
    { x: cx, y: cy, z: cz },
    { x: cx, y: cell.min.y, z: cz },
    { x: cx, y: cell.max.y, z: cz },
    { x: cell.min.x, y: cy, z: cz },
    { x: cell.max.x, y: cy, z: cz },
    { x: cx, y: cy, z: cell.min.z },
    { x: cx, y: cy, z: cell.max.z },
  ];
  for (const p of probes) {
    const v = sampleScalar(ctx, p.x, p.y, p.z);
    if (!Number.isFinite(v)) continue;
    if (Math.abs(v) < 1e-12) return true;
    if ((v > 0 && hasNegative) || (v < 0 && hasPositive)) {
      return true;
    }
  }

  return false;
}

function sampleScalar(ctx: MeshBuildContext, x: number, y: number, z: number): number {
  const key = sampleKey(x, y, z);
  const cached = ctx.sampleCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let value = ctx.scalarField(x, y, z) - ctx.isoValue;
  if (!Number.isFinite(value)) {
    value = Number.NaN;
  } else if (Math.abs(value) <= ctx.zeroSnapEps) {
    value = resolveNearZeroSample(ctx, x, y, z);
  }
  ctx.sampleCache.set(key, value);
  return value;
}

function sampleKey(x: number, y: number, z: number): string {
  return `${x.toFixed(10)}|${y.toFixed(10)}|${z.toFixed(10)}`;
}

function resolveNearZeroSample(ctx: MeshBuildContext, x: number, y: number, z: number): number {
  const n = ctx.zeroResolveNudge;
  const px = clamp(x + n * 0.754877666, ctx.bounds.min.x, ctx.bounds.max.x);
  const py = clamp(y - n * 0.569840291, ctx.bounds.min.y, ctx.bounds.max.y);
  const pz = clamp(z + n * 0.327512431, ctx.bounds.min.z, ctx.bounds.max.z);
  const alt = ctx.scalarField(px, py, pz) - ctx.isoValue;
  if (Number.isFinite(alt) && Math.abs(alt) > ctx.zeroSnapEps) {
    return alt;
  }
  // Fallback: bias slightly positive rather than returning exact zero.
  return ctx.zeroSnapEps;
}

function polygonizeCubeAsTetra(target: number[], cubePos: V3[], cubeVal: number[]): void {
  for (const tet of tetrahedra) {
    polygonizeTetra(
      tet.map((idx) => cubePos[idx]),
      tet.map((idx) => cubeVal[idx]),
      target,
    );
  }
}

function polygonizeTetra(points: V3[], values: number[], rawTriangles: number[]): void {
  const zeroTol = 0;
  const inside = values.map((v) => Number.isFinite(v) && v <= zeroTol);
  const insideCount = inside.reduce((sum, v) => sum + (v ? 1 : 0), 0);
  if (insideCount === 0 || insideCount === 4) {
    return;
  }

  const intersections: V3[] = [];
  for (const [a, b] of tetraEdges) {
    const vaRaw = values[a];
    const vbRaw = values[b];
    const va = Math.abs(vaRaw) <= zeroTol ? 0 : vaRaw;
    const vb = Math.abs(vbRaw) <= zeroTol ? 0 : vbRaw;
    if (!Number.isFinite(va) || !Number.isFinite(vb)) {
      continue;
    }
    if (va === 0 && vb === 0) {
      continue;
    }
    if (va === 0) {
      intersections.push(points[a]);
      continue;
    }
    if (vb === 0) {
      intersections.push(points[b]);
      continue;
    }
    const crosses = (va < 0 && vb > 0) || (va > 0 && vb < 0);
    if (!crosses) continue;
    const t = va / (va - vb);
    intersections.push(lerp(points[a], points[b], clamp01(t)));
  }

  const uniqueIntersections = dedupePoints(intersections, 1e-7);

  if (uniqueIntersections.length < 3) {
    return;
  }

  if (uniqueIntersections.length === 3) {
    addTriangle(uniqueIntersections[0], uniqueIntersections[1], uniqueIntersections[2], rawTriangles);
    return;
  }

  if (uniqueIntersections.length === 4) {
    const ordered = sortPolygon4(uniqueIntersections);
    addTriangle(ordered[0], ordered[1], ordered[2], rawTriangles);
    addTriangle(ordered[0], ordered[2], ordered[3], rawTriangles);
    return;
  }

  for (let i = 1; i < uniqueIntersections.length - 1; i += 1) {
    addTriangle(uniqueIntersections[0], uniqueIntersections[i], uniqueIntersections[i + 1], rawTriangles);
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

  return [...points].sort((a, b) => {
    const aa = Math.atan2(a.y - centroid.y, a.x - centroid.x);
    const bb = Math.atan2(b.y - centroid.y, b.x - centroid.x);
    return aa - bb;
  });
}

function addTriangle(a: V3, b: V3, c: V3, rawTriangles: number[]): void {
  rawTriangles.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
}

function dedupePoints(points: V3[], epsilon: number): V3[] {
  if (points.length <= 1) return points;
  const out: V3[] = [];
  for (const p of points) {
    let duplicate = false;
    for (const q of out) {
      if (Math.abs(p.x - q.x) <= epsilon && Math.abs(p.y - q.y) <= epsilon && Math.abs(p.z - q.z) <= epsilon) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) out.push(p);
  }
  return out;
}

function finalizeImplicitMesh(ctx: MeshBuildContext): SerializedMesh {
  if (ctx.rawTriangles.length === 0) {
    return emptyMesh();
  }

  const cfg = ctx.quality;
  const spanX = ctx.bounds.max.x - ctx.bounds.min.x;
  const spanY = ctx.bounds.max.y - ctx.bounds.min.y;
  const spanZ = ctx.bounds.max.z - ctx.bounds.min.z;
  const leafDiv = cfg.rootDivisions * 2 ** cfg.maxDepth;
  const leafMinSize = Math.min(spanX, spanY, spanZ) / Math.max(1, leafDiv);
  const mergeEpsilon = Math.max(leafMinSize * 0.01, 1e-6);
  const areaEpsilon = Math.max(mergeEpsilon * mergeEpsilon * 0.02, 1e-12);

  const positions: number[] = [];
  const indices: number[] = [];
  const dedupe = new Map<string, number>();
  const triangleKeys = new Set<string>();

  for (let i = 0; i < ctx.rawTriangles.length; i += 9) {
    const ia = getOrCreateVertexIndex(dedupe, positions, ctx.rawTriangles[i], ctx.rawTriangles[i + 1], ctx.rawTriangles[i + 2], mergeEpsilon);
    const ib = getOrCreateVertexIndex(dedupe, positions, ctx.rawTriangles[i + 3], ctx.rawTriangles[i + 4], ctx.rawTriangles[i + 5], mergeEpsilon);
    const ic = getOrCreateVertexIndex(dedupe, positions, ctx.rawTriangles[i + 6], ctx.rawTriangles[i + 7], ctx.rawTriangles[i + 8], mergeEpsilon);
    if (ia === ib || ib === ic || ia === ic) {
      continue;
    }
    if (triangleAreaSquared(positions, ia, ib, ic) <= areaEpsilon) {
      continue;
    }
    const key = canonicalTriangleKey(ia, ib, ic);
    if (triangleKeys.has(key)) {
      continue;
    }
    triangleKeys.add(key);
    indices.push(ia, ib, ic);
  }

  if (indices.length === 0) {
    return emptyMesh();
  }

  const normals = computeNumericGradientNormals(ctx, positions, leafMinSize);
  orientTrianglesByNormals(indices, positions, normals);

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals: new Float32Array(normals),
  };
}

function getOrCreateVertexIndex(
  dedupe: Map<string, number>,
  positions: number[],
  x: number,
  y: number,
  z: number,
  epsilon: number,
): number {
  const key = `${Math.round(x / epsilon)}|${Math.round(y / epsilon)}|${Math.round(z / epsilon)}`;
  const existing = dedupe.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const index = positions.length / 3;
  positions.push(x, y, z);
  dedupe.set(key, index);
  return index;
}

function canonicalTriangleKey(a: number, b: number, c: number): string {
  if (a > b) [a, b] = [b, a];
  if (b > c) [b, c] = [c, b];
  if (a > b) [a, b] = [b, a];
  return `${a}|${b}|${c}`;
}

function triangleAreaSquared(positions: number[], ia: number, ib: number, ic: number): number {
  const a = ia * 3;
  const b = ib * 3;
  const c = ic * 3;
  const abx = positions[b] - positions[a];
  const aby = positions[b + 1] - positions[a + 1];
  const abz = positions[b + 2] - positions[a + 2];
  const acx = positions[c] - positions[a];
  const acy = positions[c + 1] - positions[a + 1];
  const acz = positions[c + 2] - positions[a + 2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  return nx * nx + ny * ny + nz * nz;
}

function computeNumericGradientNormals(ctx: MeshBuildContext, positions: number[], leafMinSize: number): number[] {
  const normals = new Array<number>(positions.length).fill(0);
  const fallback = computeFaceNormals(positions, undefined);
  const diag = Math.hypot(
    ctx.bounds.max.x - ctx.bounds.min.x,
    ctx.bounds.max.y - ctx.bounds.min.y,
    ctx.bounds.max.z - ctx.bounds.min.z,
  );
  const eps = clamp(
    Number.isFinite(leafMinSize) && leafMinSize > 0 ? leafMinSize * 0.65 : diag * 1e-3,
    diag * 1e-5,
    Math.max(diag * 0.01, 1e-4),
  );

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    const gx = finiteDiff(ctx, x, y, z, 'x', eps);
    const gy = finiteDiff(ctx, x, y, z, 'y', eps);
    const gz = finiteDiff(ctx, x, y, z, 'z', eps);
    const len = Math.hypot(gx, gy, gz);
    if (Number.isFinite(len) && len > 1e-10) {
      normals[i] = gx / len;
      normals[i + 1] = gy / len;
      normals[i + 2] = gz / len;
    } else {
      normals[i] = fallback[i];
      normals[i + 1] = fallback[i + 1];
      normals[i + 2] = fallback[i + 2];
    }
  }

  return normals;
}

function finiteDiff(ctx: MeshBuildContext, x: number, y: number, z: number, axis: 'x' | 'y' | 'z', eps: number): number {
  let x0 = x;
  let y0 = y;
  let z0 = z;
  let x1 = x;
  let y1 = y;
  let z1 = z;

  if (axis === 'x') {
    x0 = clamp(x - eps, ctx.bounds.min.x, ctx.bounds.max.x);
    x1 = clamp(x + eps, ctx.bounds.min.x, ctx.bounds.max.x);
  } else if (axis === 'y') {
    y0 = clamp(y - eps, ctx.bounds.min.y, ctx.bounds.max.y);
    y1 = clamp(y + eps, ctx.bounds.min.y, ctx.bounds.max.y);
  } else {
    z0 = clamp(z - eps, ctx.bounds.min.z, ctx.bounds.max.z);
    z1 = clamp(z + eps, ctx.bounds.min.z, ctx.bounds.max.z);
  }

  const v0 = sampleScalar(ctx, x0, y0, z0);
  const v1 = sampleScalar(ctx, x1, y1, z1);
  if (!Number.isFinite(v0) || !Number.isFinite(v1)) {
    return 0;
  }

  const d = axis === 'x' ? x1 - x0 : axis === 'y' ? y1 - y0 : z1 - z0;
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) {
    return 0;
  }
  return (v1 - v0) / d;
}

function orientTrianglesByNormals(indices: number[], positions: number[], normals: number[]): void {
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i];
    const ib = indices[i + 1];
    const ic = indices[i + 2];
    const a = ia * 3;
    const b = ib * 3;
    const c = ic * 3;

    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const fnx = aby * acz - abz * acy;
    const fny = abz * acx - abx * acz;
    const fnz = abx * acy - aby * acx;

    const anx = normals[a] + normals[b] + normals[c];
    const any = normals[a + 1] + normals[b + 1] + normals[c + 1];
    const anz = normals[a + 2] + normals[b + 2] + normals[c + 2];
    const dot = fnx * anx + fny * any + fnz * anz;
    if (dot < 0) {
      indices[i + 1] = ic;
      indices[i + 2] = ib;
    }
  }
}

function computeFaceNormals(positions: number[], indices?: number[]): number[] {
  const normals = new Array<number>(positions.length).fill(0);
  if (indices) {
    for (let i = 0; i < indices.length; i += 3) {
      accumulateFaceNormal(normals, positions, indices[i], indices[i + 1], indices[i + 2]);
    }
  } else {
    for (let i = 0; i < positions.length / 3; i += 3) {
      accumulateFaceNormal(normals, positions, i, i + 1, i + 2);
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len;
    normals[i + 1] /= len;
    normals[i + 2] /= len;
  }
  return normals;
}

function accumulateFaceNormal(normals: number[], positions: number[], ia: number, ib: number, ic: number): void {
  const a = ia * 3;
  const b = ib * 3;
  const c = ic * 3;
  if (c + 2 >= positions.length) return;

  const abx = positions[b] - positions[a];
  const aby = positions[b + 1] - positions[a + 1];
  const abz = positions[b + 2] - positions[a + 2];
  const acx = positions[c] - positions[a];
  const acy = positions[c + 1] - positions[a + 1];
  const acz = positions[c + 2] - positions[a + 2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;

  normals[a] += nx;
  normals[a + 1] += ny;
  normals[a + 2] += nz;
  normals[b] += nx;
  normals[b + 1] += ny;
  normals[b + 2] += nz;
  normals[c] += nx;
  normals[c + 1] += ny;
  normals[c + 2] += nz;
}

function lerp(a: V3, b: V3, t: number): V3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

function emptyMesh(): SerializedMesh {
  return {
    positions: new Float32Array(0),
    indices: new Uint32Array(0),
    normals: new Float32Array(0),
  };
}

function isValidBounds(bounds: Bounds3D): boolean {
  const spans = [
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  ];
  return spans.every((s) => Number.isFinite(s) && s > 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(Number.isFinite(value) ? value : 0.5, 0, 1);
}
