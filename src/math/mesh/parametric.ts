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
  const uSamples = Math.max(2, Math.floor(domain.uSamples));
  const vSamples = Math.max(2, Math.floor(domain.vSamples));

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const valid: boolean[] = [];

  for (let j = 0; j < vSamples; j += 1) {
    const v = domain.vMin + ((domain.vMax - domain.vMin) * j) / (vSamples - 1);
    for (let i = 0; i < uSamples; i += 1) {
      const u = domain.uMin + ((domain.uMax - domain.uMin) * i) / (uSamples - 1);
      const [x, y, z] = fn(u, v);
      const ok = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
      valid.push(ok);
      positions.push(ok ? x : 0, ok ? y : 0, ok ? z : 0);
      uvs.push(i / (uSamples - 1), j / (vSamples - 1));
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
  const step = Math.max(1, Math.floor(wireframeCellSize));
  const referenceUSamples = Math.max(2, Math.floor(wireframeReferenceSamples?.uSamples ?? uSamples));
  const referenceVSamples = Math.max(2, Math.floor(wireframeReferenceSamples?.vSamples ?? vSamples));
  if (referenceUSamples === uSamples && referenceVSamples === vSamples) {
    for (let j = 0; j < vSamples; j += step) {
      const line: number[] = [];
      for (let i = 0; i < uSamples; i += 1) {
        const k = idx(i, j) * 3;
        line.push(positions[k], positions[k + 1], positions[k + 2]);
      }
      lines.push(new Float32Array(line));
    }
    for (let i = 0; i < uSamples; i += step) {
      const line: number[] = [];
      for (let j = 0; j < vSamples; j += 1) {
        const k = idx(i, j) * 3;
        line.push(positions[k], positions[k + 1], positions[k + 2]);
      }
      lines.push(new Float32Array(line));
    }
  } else {
    // Interactive/preview meshes use fewer surface samples. Keep the grid at
    // the full-resolution parameter values so its cells do not grow or shrink
    // while a parameter is dragged or animated; only line smoothness changes.
    for (let j = 0; j < referenceVSamples; j += step) {
      const v = domain.vMin + ((domain.vMax - domain.vMin) * j) / (referenceVSamples - 1);
      const line: number[] = [];
      for (let i = 0; i < uSamples; i += 1) {
        const u = domain.uMin + ((domain.uMax - domain.uMin) * i) / (uSamples - 1);
        pushFinitePoint(line, fn(u, v));
      }
      lines.push(new Float32Array(line));
    }
    for (let i = 0; i < referenceUSamples; i += step) {
      const u = domain.uMin + ((domain.uMax - domain.uMin) * i) / (referenceUSamples - 1);
      const line: number[] = [];
      for (let j = 0; j < vSamples; j += 1) {
        const v = domain.vMin + ((domain.vMax - domain.vMin) * j) / (vSamples - 1);
        pushFinitePoint(line, fn(u, v));
      }
      lines.push(new Float32Array(line));
    }
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

function pushFinitePoint(target: number[], point: [number, number, number]): void {
  const [x, y, z] = point;
  if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
    target.push(x, y, z);
  } else {
    target.push(0, 0, 0);
  }
}
