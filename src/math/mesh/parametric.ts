import type { SerializedMesh } from '../../types/contracts';
import { computeMeshBounds, computeVertexNormals, extractMeshEdges } from './geometry';

export interface CurveSample {
  paths: Array<Array<{ x: number; y: number; z: number }>>;
}

type Point3 = [number, number, number];

function isRenderablePoint(point: Point3): boolean {
  // Geometry is ultimately stored as float32; finite doubles can still overflow it.
  return point.every((coordinate) => Number.isFinite(Math.fround(coordinate)));
}

/**
 * Test an edge in parameter space before connecting its endpoints. Intermediate
 * samples reveal poles even when both endpoints are finite. If the samples do
 * not approach a continuous path under subdivision, leave a gap in the mesh.
 *
 * The tolerance is relative to each coordinate's variation on the original
 * edge, not its slope or world-space height. A steep plane is exactly linear,
 * and ordinary curvature converges as the interval shrinks. Neither a jump nor
 * a pole converges. Bounds on refinement keep pathological inputs responsive.
 * Like every finite numerical sampler, this cannot prove continuity or detect
 * arbitrarily narrow singularities/oscillations between all sampled points.
 */
function edgeIsContinuous(start: Point3, end: Point3, evaluate: (fraction: number) => Point3): boolean {
  const quarter = evaluate(0.25);
  const middle = evaluate(0.5);
  const threeQuarter = evaluate(0.75);
  const probes = [start, quarter, middle, threeQuarter, end];
  if (!probes.every(isRenderablePoint)) return false;

  const tolerance = [0, 1, 2].map((axis) => {
    const values = probes.map((point) => point[axis]);
    const range = Math.max(...values) - Math.min(...values);
    const magnitude = Math.max(1, ...values.map(Math.abs));
    return Math.max(range * 0.05, magnitude * Number.EPSILON * 32);
  });
  let remainingSamples = 96;

  const converges = (
    a: number,
    b: number,
    left: Point3,
    right: Point3,
    midpoint: Point3,
    depth: number,
  ): boolean => {
    if (!isRenderablePoint(midpoint)) return false;
    const linearEnough = tolerance.every((limit, axis) => (
      Math.abs(midpoint[axis] - (left[axis] * 0.5 + right[axis] * 0.5)) <= limit
    ));
    if (linearEnough) return true;
    if (depth >= 12 || remainingSamples < 2) return false;
    remainingSamples -= 2;
    const mid = (a + b) * 0.5;
    return converges(a, mid, left, midpoint, evaluate((a + mid) * 0.5), depth + 1)
      && converges(mid, b, midpoint, right, evaluate((mid + b) * 0.5), depth + 1);
  };

  // Check both halves even if the central sample lies exactly on the chord;
  // symmetric jumps (and pairs of poles) can hide behind a linear midpoint.
  return converges(0, 0.5, start, middle, quarter, 0)
    && converges(0.5, 1, middle, end, threeQuarter, 0);
}

export function sampleCurve(
  tMin: number,
  tMax: number,
  samples: number,
  fn: (t: number) => [number, number, number],
): CurveSample {
  const count = Math.max(2, Math.floor(samples));
  const paths: CurveSample['paths'] = [];
  let path: CurveSample['paths'][number] = [];
  let previous: { t: number; point: Point3 } | null = null;
  const finishPath = () => {
    if (path.length >= 2) paths.push(path);
    path = [];
  };
  for (let i = 0; i < count; i += 1) {
    const t = tMin + ((tMax - tMin) * i) / (count - 1);
    const point = fn(t);
    if (!isRenderablePoint(point)) {
      finishPath();
      previous = null;
      continue;
    }
    const preceding = previous;
    if (preceding && !edgeIsContinuous(preceding.point, point, (fraction) => (
      fn(preceding.t + (t - preceding.t) * fraction)
    ))) finishPath();
    const [x, y, z] = point;
    path.push({ x, y, z });
    previous = { t, point };
  }
  finishPath();
  return { paths };
}

export function buildSurfaceMesh(
  domain: {
    uMin: number;
    uMax: number;
    vMin: number;
    vMax: number;
    uSamples: number;
    vSamples: number;
  },
  fn: (u: number, v: number) => [number, number, number],
  wireframeCellSize = 1,
  wireframeReferenceSamples?: { uSamples: number; vSamples: number },
): SerializedMesh {
  const targetUSamples = Math.max(2, Math.floor(domain.uSamples));
  const targetVSamples = Math.max(2, Math.floor(domain.vSamples));
  const step = Math.max(1, Math.floor(wireframeCellSize));
  const referenceUSamples = Math.max(2, Math.floor(wireframeReferenceSamples?.uSamples ?? targetUSamples));
  const referenceVSamples = Math.max(2, Math.floor(wireframeReferenceSamples?.vSamples ?? targetVSamples));
  const uSampling = buildAxisSampling(targetUSamples, referenceUSamples, step);
  const vSampling = buildAxisSampling(targetVSamples, referenceVSamples, step);
  const uSamples = uSampling.fractions.length;
  const vSamples = vSampling.fractions.length;

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const valid: boolean[] = [];
  const used = new Uint8Array(uSamples * vSamples);
  const uValues = uSampling.fractions.map((fraction) => domain.uMin + (domain.uMax - domain.uMin) * fraction);
  const vValues = vSampling.fractions.map((fraction) => domain.vMin + (domain.vMax - domain.vMin) * fraction);

  for (let j = 0; j < vSamples; j += 1) {
    const vFraction = vSampling.fractions[j];
    const v = vValues[j];
    for (let i = 0; i < uSamples; i += 1) {
      const uFraction = uSampling.fractions[i];
      const u = uValues[i];
      const [x, y, z] = fn(u, v);
      const ok = isRenderablePoint([x, y, z]);
      valid.push(ok);
      positions.push(ok ? x : 0, ok ? y : 0, ok ? z : 0);
      uvs.push(uFraction, vFraction);
    }
  }

  const idx = (i: number, j: number) => j * uSamples + i;
  const pointAt = (index: number): Point3 => positions.slice(index * 3, index * 3 + 3) as Point3;
  const edgeCache = new Map<number, boolean>();
  const continuous = (a: number, b: number): boolean => {
    if (!valid[a] || !valid[b]) return false;
    const key = Math.min(a, b) * valid.length + Math.max(a, b);
    const cached = edgeCache.get(key);
    if (cached !== undefined) return cached;
    const ua = uValues[a % uSamples];
    const ub = uValues[b % uSamples];
    const va = vValues[Math.floor(a / uSamples)];
    const vb = vValues[Math.floor(b / uSamples)];
    const result = edgeIsContinuous(pointAt(a), pointAt(b), (fraction) => (
      fn(ua + (ub - ua) * fraction, va + (vb - va) * fraction)
    ));
    edgeCache.set(key, result);
    return result;
  };
  const addTriangle = (a: number, b: number, c: number) => {
    if (!continuous(a, b) || !continuous(b, c) || !continuous(c, a)) return;
    indices.push(a, b, c);
    used[a] = used[b] = used[c] = 1;
  };
  for (let j = 0; j < vSamples - 1; j += 1) {
    for (let i = 0; i < uSamples - 1; i += 1) {
      const a = idx(i, j);
      const b = idx(i + 1, j);
      const c = idx(i, j + 1);
      const d = idx(i + 1, j + 1);
      addTriangle(a, c, b);
      addTriangle(b, c, d);
    }
  }

  const normals = computeVertexNormals(positions, indices);
  const edgeData = extractMeshEdges(positions, indices);

  const lines: Float32Array[] = [];
  const addLine = (vertices: number[]) => {
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 2) {
        lines.push(new Float32Array(run.flatMap((index) => pointAt(index))));
        for (const index of run) used[index] = 1;
      }
      run = [];
    };
    for (const vertex of vertices) {
      // A finite approximation of a pole (for example tan(pi/2)) can leave an
      // isolated row after its faces are removed. Wireframe follows the actual
      // surface, so do not retain such rows or let them inflate camera bounds.
      if (!valid[vertex] || !used[vertex]) {
        flush();
        continue;
      }
      if (run.length && !continuous(run[run.length - 1], vertex)) flush();
      run.push(vertex);
    }
    flush();
  };
  for (const j of vSampling.wireIndices) {
    addLine(Array.from({ length: uSamples }, (_, i) => idx(i, j)));
  }
  for (const i of uSampling.wireIndices) {
    addLine(Array.from({ length: vSamples }, (_, j) => idx(i, j)));
  }
  const boundPositions: number[] = [];
  for (let vertex = 0; vertex < used.length; vertex += 1) {
    if (used[vertex]) boundPositions.push(...pointAt(vertex));
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals,
    uvs: new Float32Array(uvs),
    lines,
    bounds: computeMeshBounds(boundPositions),
    boundaryEdges: edgeData.boundaryEdges,
    featureEdges: edgeData.featureEdges,
    topology: edgeData.topology,
  };
}

function buildAxisSampling(
  targetSamples: number,
  referenceSamples: number,
  wireframeStep: number,
): { fractions: number[]; wireIndices: number[] } {
  if (targetSamples === referenceSamples) {
    return {
      fractions: Array.from({ length: targetSamples }, (_, index) => index / (targetSamples - 1)),
      wireIndices: Array.from(
        { length: Math.ceil(referenceSamples / wireframeStep) },
        (_, index) => index * wireframeStep,
      ),
    };
  }

  // Anchor the lower-resolution mesh at every full-resolution wireframe
  // coordinate. This keeps both grid-line families on mesh rows/columns, so
  // depth testing cannot hide one family behind the coarser animated surface.
  const locations = new Map<number, boolean>();
  for (let index = 0; index < referenceSamples; index += wireframeStep) {
    locations.set(index / (referenceSamples - 1), true);
  }
  locations.set(0, locations.get(0) ?? false);
  locations.set(1, locations.get(1) ?? false);

  while (locations.size < targetSamples) {
    const sorted = [...locations.keys()].sort((a, b) => a - b);
    let widestStart = sorted[0];
    let widestGap = -1;
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const gap = sorted[index + 1] - sorted[index];
      if (gap > widestGap) {
        widestGap = gap;
        widestStart = sorted[index];
      }
    }
    if (widestGap <= 0) break;
    locations.set(widestStart + widestGap / 2, false);
  }

  const entries = [...locations.entries()].sort(([a], [b]) => a - b);
  return {
    fractions: entries.map(([fraction]) => fraction),
    wireIndices: entries.flatMap(([, isWire], index) => isWire ? [index] : []),
  };
}
