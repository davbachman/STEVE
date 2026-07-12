import type { SerializedMesh } from '../../types/contracts';
import { computeMeshBounds, computeVertexNormals, extractMeshEdges } from './geometry';

export interface CurveSample {
  points: Array<{ x: number; y: number; z: number }>;
}

export function sampleCurve(
  tMin: number,
  tMax: number,
  samples: number,
  fn: (t: number) => [number, number, number],
): CurveSample {
  const count = Math.max(2, Math.floor(samples));
  const points: CurveSample['points'] = [];
  for (let i = 0; i < count; i += 1) {
    const t = tMin + ((tMax - tMin) * i) / (count - 1);
    const [x, y, z] = fn(t);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      points.push({ x, y, z });
    }
  }
  return { points };
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

  for (let j = 0; j < vSamples; j += 1) {
    const vFraction = vSampling.fractions[j];
    const v = domain.vMin + (domain.vMax - domain.vMin) * vFraction;
    for (let i = 0; i < uSamples; i += 1) {
      const uFraction = uSampling.fractions[i];
      const u = domain.uMin + (domain.uMax - domain.uMin) * uFraction;
      const [x, y, z] = fn(u, v);
      const ok = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
      valid.push(ok);
      positions.push(ok ? x : 0, ok ? y : 0, ok ? z : 0);
      uvs.push(uFraction, vFraction);
    }
  }

  const idx = (i: number, j: number) => j * uSamples + i;
  for (let j = 0; j < vSamples - 1; j += 1) {
    for (let i = 0; i < uSamples - 1; i += 1) {
      const a = idx(i, j);
      const b = idx(i + 1, j);
      const c = idx(i, j + 1);
      const d = idx(i + 1, j + 1);
      if (valid[a] && valid[b] && valid[c]) {
        indices.push(a, c, b);
      }
      if (valid[b] && valid[c] && valid[d]) {
        indices.push(b, c, d);
      }
    }
  }

  const normals = computeVertexNormals(positions, indices);
  const edgeData = extractMeshEdges(positions, indices);

  const lines: Float32Array[] = [];
  for (const j of vSampling.wireIndices) {
    const line: number[] = [];
    for (let i = 0; i < uSamples; i += 1) {
      const k = idx(i, j) * 3;
      line.push(positions[k], positions[k + 1], positions[k + 2]);
    }
    lines.push(new Float32Array(line));
  }
  for (const i of uSampling.wireIndices) {
    const line: number[] = [];
    for (let j = 0; j < vSamples; j += 1) {
      const k = idx(i, j) * 3;
      line.push(positions[k], positions[k + 1], positions[k + 2]);
    }
    lines.push(new Float32Array(line));
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals,
    uvs: new Float32Array(uvs),
    lines,
    bounds: computeMeshBounds(positions),
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
