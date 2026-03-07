import type { Bounds3D, ImplicitSurfaceSpec, SerializedMesh } from '../../types/contracts';
import { MC_EDGE_TABLE, MC_TRI_TABLE } from './marchingCubesTables';

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

const cubeEdges: Array<[number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

const cubeFaces: Array<[number, number, number, number]> = [
  [0, 1, 2, 3], // bottom z-
  [4, 5, 6, 7], // top z+
  [0, 1, 5, 4], // y-
  [3, 2, 6, 7], // y+
  [0, 4, 7, 3], // x-
  [1, 2, 6, 5], // x+
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
  zeroSnapEps: number;
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
    zeroSnapEps: Math.max(
      Math.hypot(
        bounds.max.x - bounds.min.x,
        bounds.max.y - bounds.min.y,
        bounds.max.z - bounds.min.z,
      ) * 1e-12,
      1e-12,
    ),
  };

  // Use a uniform leaf-resolution grid for the final mesh to avoid crack
  // formation from mixed-resolution seams.
  polygonizeUniformLeafGrid(ctx);

  return finalizeImplicitMesh(ctx);
}

function qualityConfig(quality: ImplicitSurfaceSpec['quality']): QualityConfig {
  switch (quality) {
    case 'draft':
      return { rootDivisions: 4, maxDepth: 2 };
    case 'medium':
      return { rootDivisions: 4, maxDepth: 3 };
    case 'high':
      return { rootDivisions: 6, maxDepth: 3 };
  }
}

function polygonizeUniformLeafGrid(ctx: MeshBuildContext): void {
  const div = ctx.quality.rootDivisions * 2 ** ctx.quality.maxDepth;
  const xSpan = ctx.bounds.max.x - ctx.bounds.min.x;
  const ySpan = ctx.bounds.max.y - ctx.bounds.min.y;
  const zSpan = ctx.bounds.max.z - ctx.bounds.min.z;

  for (let k = 0; k < div; k += 1) {
    const z0 = ctx.bounds.min.z + (zSpan * k) / div;
    const z1 = ctx.bounds.min.z + (zSpan * (k + 1)) / div;
    for (let j = 0; j < div; j += 1) {
      const y0 = ctx.bounds.min.y + (ySpan * j) / div;
      const y1 = ctx.bounds.min.y + (ySpan * (j + 1)) / div;
      for (let i = 0; i < div; i += 1) {
        const x0 = ctx.bounds.min.x + (xSpan * i) / div;
        const x1 = ctx.bounds.min.x + (xSpan * (i + 1)) / div;
        const cell = sampleCell(ctx, { x: x0, y: y0, z: z0 }, { x: x1, y: y1, z: z1 });
        if (!cellMightContainSurface(ctx, cell)) {
          continue;
        }
        polygonizeCube(ctx.rawTriangles, cell.corners, cell.values);
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
    value = resolveNearZeroSample(ctx);
  }
  ctx.sampleCache.set(key, value);
  return value;
}

function sampleKey(x: number, y: number, z: number): string {
  return `${x.toFixed(10)}|${y.toFixed(10)}|${z.toFixed(10)}`;
}

function resolveNearZeroSample(ctx: MeshBuildContext): number {
  // Preserve exact hits and let tetra polygonization/final cleanup handle them.
  // This avoids sign-biased asymmetry on surfaces like xyz=1.
  void ctx;
  return 0;
}

function polygonizeCube(target: number[], cubePos: V3[], cubeVal: number[]): void {
  if (cubeHasAmbiguousFace(cubeVal)) {
    // Face-ambiguous cubes can choose different diagonals across neighboring cells
    // in classic marching cubes. Reuse the existing tetra path for deterministic
    // shared-face triangulation on these cases.
    polygonizeCubeAsTetra(target, cubePos, cubeVal);
    return;
  }

  let cubeIndex = 0;
  for (let i = 0; i < 8; i += 1) {
    const v = cubeVal[i];
    if (!Number.isFinite(v)) {
      return;
    }
    if (v <= 0) {
      cubeIndex |= 1 << i;
    }
  }

  const edgeMask = MC_EDGE_TABLE[cubeIndex];
  if (!edgeMask) {
    return;
  }

  const edgePoints: Array<V3 | null> = new Array(12).fill(null);
  for (let edge = 0; edge < 12; edge += 1) {
    if ((edgeMask & (1 << edge)) === 0) continue;
    const [a, b] = cubeEdges[edge];
    edgePoints[edge] = interpolateIsoPoint(cubePos[a], cubePos[b], cubeVal[a], cubeVal[b]);
  }

  const triBase = cubeIndex * 16;
  for (let i = 0; i < 16; i += 3) {
    const ea = MC_TRI_TABLE[triBase + i];
    if (ea < 0) break;
    const eb = MC_TRI_TABLE[triBase + i + 1];
    const ec = MC_TRI_TABLE[triBase + i + 2];
    if (eb < 0 || ec < 0) break;
    const a = edgePoints[ea];
    const b = edgePoints[eb];
    const c = edgePoints[ec];
    if (!a || !b || !c) continue;
    addTriangle(a, b, c, target);
  }
}

function cubeHasAmbiguousFace(values: number[]): boolean {
  for (const face of cubeFaces) {
    const faceValues = face.map((idx) => values[idx]);
    if (faceValues.some((v) => !Number.isFinite(v))) {
      return true;
    }
    const signs = faceValues.map((v) => (v <= 0 ? 1 : 0));
    const insideCount = signs[0] + signs[1] + signs[2] + signs[3];
    if (insideCount !== 2) {
      continue;
    }
    // Marching-squares face ambiguity: checkerboard occupancy (0101 / 1010).
    if (signs[0] === signs[2] && signs[1] === signs[3] && signs[0] !== signs[1]) {
      return true;
    }
  }
  return false;
}

function interpolateIsoPoint(pa: V3, pb: V3, va: number, vb: number): V3 | null {
  if (!(Number.isFinite(va) && Number.isFinite(vb))) {
    return null;
  }
  const denom = va - vb;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-20) {
    return null;
  }
  const t = clamp01(va / denom);
  return lerp(pa, pb, t);
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
  if (values.some((v) => !Number.isFinite(v))) {
    return;
  }

  const inside = values.map((v) => v <= zeroTol);
  const insideCount = inside.reduce((sum, v) => sum + (v ? 1 : 0), 0);
  if (insideCount === 0 || insideCount === 4) {
    return;
  }

  const insideIdx: number[] = [];
  const outsideIdx: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    (inside[i] ? insideIdx : outsideIdx).push(i);
  }

  const edgePointCache = new Map<string, V3>();
  const interpolate = (a: number, b: number): V3 | null => {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const cached = edgePointCache.get(key);
    if (cached) return cached;

    const va = values[a];
    const vb = values[b];
    const denom = va - vb;
    if (!Number.isFinite(denom) || Math.abs(denom) < 1e-20) {
      return null;
    }
    const t = clamp01(va / denom);
    const p = lerp(points[a], points[b], t);
    edgePointCache.set(key, p);
    return p;
  };

  if (insideCount === 1) {
    const i = insideIdx[0];
    const a = outsideIdx[0];
    const b = outsideIdx[1];
    const c = outsideIdx[2];
    const p0 = interpolate(i, a);
    const p1 = interpolate(i, b);
    const p2 = interpolate(i, c);
    if (p0 && p1 && p2) addTriangle(p0, p1, p2, rawTriangles);
    return;
  }

  if (insideCount === 3) {
    const o = outsideIdx[0];
    const a = insideIdx[0];
    const b = insideIdx[1];
    const c = insideIdx[2];
    const p0 = interpolate(o, a);
    const p1 = interpolate(o, b);
    const p2 = interpolate(o, c);
    if (p0 && p1 && p2) addTriangle(p0, p1, p2, rawTriangles);
    return;
  }

  // 2-in / 2-out: emit a quad split with combinatorially stable ordering.
  const i0 = insideIdx[0];
  const i1 = insideIdx[1];
  const o0 = outsideIdx[0];
  const o1 = outsideIdx[1];
  const p00 = interpolate(i0, o0);
  const p01 = interpolate(i0, o1);
  const p10 = interpolate(i1, o0);
  const p11 = interpolate(i1, o1);
  if (!p00 || !p01 || !p10 || !p11) {
    return;
  }
  addTriangle(p00, p01, p11, rawTriangles);
  addTriangle(p00, p11, p10, rawTriangles);
}

function addTriangle(a: V3, b: V3, c: V3, rawTriangles: number[]): void {
  rawTriangles.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
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
  const mergeEpsilon = Math.max(leafMinSize * 1e-5, 1e-8);
  const areaEpsilon = Math.max(mergeEpsilon * mergeEpsilon * 0.02, 1e-12);
  const latticeSnapTolFactor = 8e-3;

  const positions: number[] = [];
  const indices: number[] = [];
  const dedupe = new Map<string, number[]>();
  const triangleKeys = new Set<string>();

  for (let i = 0; i < ctx.rawTriangles.length; i += 9) {
    const ax = snapToLeafLattice(ctx.rawTriangles[i], ctx.bounds.min.x, spanX, leafDiv, latticeSnapTolFactor);
    const ay = snapToLeafLattice(ctx.rawTriangles[i + 1], ctx.bounds.min.y, spanY, leafDiv, latticeSnapTolFactor);
    const az = snapToLeafLattice(ctx.rawTriangles[i + 2], ctx.bounds.min.z, spanZ, leafDiv, latticeSnapTolFactor);
    const bx = snapToLeafLattice(ctx.rawTriangles[i + 3], ctx.bounds.min.x, spanX, leafDiv, latticeSnapTolFactor);
    const by = snapToLeafLattice(ctx.rawTriangles[i + 4], ctx.bounds.min.y, spanY, leafDiv, latticeSnapTolFactor);
    const bz = snapToLeafLattice(ctx.rawTriangles[i + 5], ctx.bounds.min.z, spanZ, leafDiv, latticeSnapTolFactor);
    const cx = snapToLeafLattice(ctx.rawTriangles[i + 6], ctx.bounds.min.x, spanX, leafDiv, latticeSnapTolFactor);
    const cy = snapToLeafLattice(ctx.rawTriangles[i + 7], ctx.bounds.min.y, spanY, leafDiv, latticeSnapTolFactor);
    const cz = snapToLeafLattice(ctx.rawTriangles[i + 8], ctx.bounds.min.z, spanZ, leafDiv, latticeSnapTolFactor);
    const ia = getOrCreateVertexIndex(dedupe, positions, ax, ay, az, mergeEpsilon);
    const ib = getOrCreateVertexIndex(dedupe, positions, bx, by, bz, mergeEpsilon);
    const ic = getOrCreateVertexIndex(dedupe, positions, cx, cy, cz, mergeEpsilon);
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
  const isClosedManifold = hasClosedManifoldTopology(indices);
  canonicalizeClosedMeshOrientation(indices, positions, normals, isClosedManifold);

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals: new Float32Array(normals),
    topology: {
      isClosedManifold,
    },
  };
}

function snapToLeafLattice(value: number, min: number, span: number, div: number, tolFactor: number): number {
  if (!(Number.isFinite(value) && Number.isFinite(min) && Number.isFinite(span) && Number.isFinite(div))) {
    return value;
  }
  if (div <= 0 || span <= 0) {
    return value;
  }
  const step = span / div;
  if (!(step > 0)) {
    return value;
  }
  const k = Math.round((value - min) / step);
  const snapped = min + k * step;
  const tol = Math.max(step * tolFactor, 1e-10);
  return Math.abs(value - snapped) <= tol ? snapped : value;
}

function getOrCreateVertexIndex(
  dedupe: Map<string, number[]>,
  positions: number[],
  x: number,
  y: number,
  z: number,
  epsilon: number,
): number {
  if (!(epsilon > 0) || !Number.isFinite(epsilon)) {
    const index = positions.length / 3;
    positions.push(x, y, z);
    return index;
  }

  const gx = Math.floor(x / epsilon);
  const gy = Math.floor(y / epsilon);
  const gz = Math.floor(z / epsilon);
  const epsSq = epsilon * epsilon;
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const bucket = dedupe.get(vertexBucketKey(gx + dx, gy + dy, gz + dz));
        if (!bucket) continue;
        for (const existing of bucket) {
          const base = existing * 3;
          const ddx = positions[base] - x;
          const ddy = positions[base + 1] - y;
          const ddz = positions[base + 2] - z;
          if (ddx * ddx + ddy * ddy + ddz * ddz <= epsSq) {
            return existing;
          }
        }
      }
    }
  }

  const index = positions.length / 3;
  positions.push(x, y, z);
  const key = vertexBucketKey(gx, gy, gz);
  const bucket = dedupe.get(key);
  if (bucket) {
    bucket.push(index);
  } else {
    dedupe.set(key, [index]);
  }
  return index;
}

function vertexBucketKey(x: number, y: number, z: number): string {
  return `${x}|${y}|${z}`;
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

function canonicalizeClosedMeshOrientation(
  indices: number[],
  positions: number[],
  normals: number[],
  isClosedManifold: boolean,
): void {
  if (!isClosedManifold) {
    return;
  }

  const volume6 = signedVolumeTimesSix(indices, positions);
  if (!Number.isFinite(volume6) || Math.abs(volume6) < 1e-10) {
    return;
  }

  // Canonicalize watertight meshes to outward winding so lighting/shadows
  // do not depend on the arbitrary sign of the implicit scalar function.
  if (volume6 < 0) {
    for (let i = 0; i < indices.length; i += 3) {
      const t = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = t;
    }
    for (let i = 0; i < normals.length; i += 1) {
      normals[i] = -normals[i];
    }
  }
}

function hasClosedManifoldTopology(indices: number[]): boolean {
  const edges = new Map<string, number>();
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [indices[i], indices[i + 1], indices[i + 2]];
    for (let e = 0; e < 3; e += 1) {
      let a = tri[e];
      let b = tri[(e + 1) % 3];
      if (a > b) [a, b] = [b, a];
      const key = `${a}|${b}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const count of edges.values()) {
    if (count !== 2) {
      return false;
    }
  }
  return true;
}

function signedVolumeTimesSix(indices: number[], positions: number[]): number {
  let volume6 = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    if (c + 2 >= positions.length) continue;
    const ax = positions[a];
    const ay = positions[a + 1];
    const az = positions[a + 2];
    const bx = positions[b];
    const by = positions[b + 1];
    const bz = positions[b + 2];
    const cx = positions[c];
    const cy = positions[c + 1];
    const cz = positions[c + 2];
    volume6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return volume6;
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
    topology: {
      isClosedManifold: false,
    },
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
