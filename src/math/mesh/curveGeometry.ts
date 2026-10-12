import { vec3 } from 'gl-matrix';
import type { SerializedMesh } from '../../types/contracts';
import { computeMeshBounds, computeVertexNormals, extractMeshEdges, mergeSerializedMeshes } from './geometry';

/** Finish sampled curves inside the meshing/export worker, retaining paths for pinning. */
export function buildCurveGeometry(mesh: SerializedMesh, style: { renderAsTube: boolean; tubeRadius: number }): SerializedMesh {
  const paths = mesh.curvePaths ?? (mesh.curvePath ? [mesh.curvePath] : []);
  const rendered = mergeSerializedMeshes(paths.filter((path) => path.length >= 6).map((path) =>
    style.renderAsTube ? buildTubeMeshFromCurvePath(path, style.tubeRadius, 12)
      : buildPolylineRibbonMesh(path, Math.max(0.02, style.tubeRadius * 0.35))));
  return { ...mesh, ...rendered, curvePath: mesh.curvePath, curvePaths: mesh.curvePaths };
}

function buildTubeMeshFromCurvePath(path: Float32Array, radius: number, radialSegments: number): SerializedMesh {
  const sourcePointCount = Math.max(2, Math.floor(path.length / 3));
  const closed = curvePathIsClosed(path, sourcePointCount);
  const pointCount = Math.max(2, closed ? sourcePointCount - 1 : sourcePointCount);
  const ringSize = Math.max(6, radialSegments);
  const positions: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];
  const previousNormal = vec3.fromValues(0, 0, 1);
  const tangent = vec3.create();
  const bitangent = vec3.create();
  const normal = vec3.create();

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    const point = readPathPoint(path, pointIndex);
    const prev = readPathPoint(path, closed ? (pointIndex - 1 + pointCount) % pointCount : Math.max(0, pointIndex - 1));
    const next = readPathPoint(path, closed ? (pointIndex + 1) % pointCount : Math.min(pointCount - 1, pointIndex + 1));
    vec3.sub(tangent, next, prev);
    if (vec3.length(tangent) < 1e-6) {
      vec3.set(tangent, 0, 0, 1);
    }
    vec3.normalize(tangent, tangent);
    if (Math.abs(vec3.dot(tangent, previousNormal)) > 0.94) {
      vec3.set(previousNormal, 0, 1, 0);
    }
    vec3.cross(bitangent, tangent, previousNormal);
    if (vec3.length(bitangent) < 1e-6) {
      vec3.set(previousNormal, 1, 0, 0);
      vec3.cross(bitangent, tangent, previousNormal);
    }
    vec3.normalize(bitangent, bitangent);
    vec3.cross(normal, bitangent, tangent);
    vec3.normalize(normal, normal);
    vec3.copy(previousNormal, normal);

    for (let ringIndex = 0; ringIndex < ringSize; ringIndex += 1) {
      const angle = (ringIndex / ringSize) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const nx = normal[0] * cos + bitangent[0] * sin;
      const ny = normal[1] * cos + bitangent[1] * sin;
      const nz = normal[2] * cos + bitangent[2] * sin;
      normals.push(nx, ny, nz);
      positions.push(
        point[0] + nx * radius,
        point[1] + ny * radius,
        point[2] + nz * radius,
      );
    }
  }

  const segmentCount = closed ? pointCount : pointCount - 1;
  for (let pointIndex = 0; pointIndex < segmentCount; pointIndex += 1) {
    const ringOffset = pointIndex * ringSize;
    const nextRingOffset = ((pointIndex + 1) % pointCount) * ringSize;
    for (let ringIndex = 0; ringIndex < ringSize; ringIndex += 1) {
      const nextRingIndex = (ringIndex + 1) % ringSize;
      const a = ringOffset + ringIndex;
      const b = nextRingOffset + ringIndex;
      const c = ringOffset + nextRingIndex;
      const d = nextRingOffset + nextRingIndex;
      indices.push(a, c, b, c, d, b);
    }
  }

  if (!closed) {
    appendTubeCap(positions, normals, indices, path, 0, radius, ringSize, -1);
    appendTubeCap(positions, normals, indices, path, pointCount - 1, radius, ringSize, 1);
  }
  const edgeData = extractMeshEdges(positions, indices);
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    bounds: computeMeshBounds(positions),
    boundaryEdges: edgeData.boundaryEdges,
    featureEdges: edgeData.featureEdges,
    topology: edgeData.topology,
  };
}

function buildPolylineRibbonMesh(path: Float32Array, width: number): SerializedMesh {
  const sourcePointCount = Math.max(2, Math.floor(path.length / 3));
  const closed = curvePathIsClosed(path, sourcePointCount);
  const pointCount = Math.max(2, closed ? sourcePointCount - 1 : sourcePointCount);
  const positions: number[] = [];
  const indices: number[] = [];
  const up = vec3.fromValues(0, 0, 1);
  for (let i = 0; i < pointCount; i += 1) {
    const point = readPathPoint(path, i);
    const prev = readPathPoint(path, closed ? (i - 1 + pointCount) % pointCount : Math.max(0, i - 1));
    const next = readPathPoint(path, closed ? (i + 1) % pointCount : Math.min(pointCount - 1, i + 1));
    const tangent = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), next, prev));
    const side = vec3.cross(vec3.create(), tangent, up);
    if (vec3.length(side) < 1e-6) {
      vec3.set(side, 1, 0, 0);
    }
    vec3.normalize(side, side);
    positions.push(
      point[0] + side[0] * width,
      point[1] + side[1] * width,
      point[2] + side[2] * width,
      point[0] - side[0] * width,
      point[1] - side[1] * width,
      point[2] - side[2] * width,
    );
  }
  const segmentCount = closed ? pointCount : pointCount - 1;
  for (let i = 0; i < segmentCount; i += 1) {
    const a = i * 2;
    const b = a + 1;
    const c = ((i + 1) % pointCount) * 2;
    const d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  const normals = computeVertexNormals(positions, indices);
  const edgeData = extractMeshEdges(positions, indices);
  return {
    positions: new Float32Array(positions),
    normals,
    indices: new Uint32Array(indices),
    bounds: computeMeshBounds(positions),
    boundaryEdges: edgeData.boundaryEdges,
    featureEdges: edgeData.featureEdges,
    topology: edgeData.topology,
  };
}

function curvePathIsClosed(path: Float32Array, pointCount: number): boolean {
  if (pointCount < 4) return false;
  const last = (pointCount - 1) * 3;
  const dx = path[0] - path[last];
  const dy = path[1] - path[last + 1];
  const dz = path[2] - path[last + 2];
  return Math.hypot(dx, dy, dz) <= 1e-5;
}

function appendTubeCap(
  positions: number[],
  normals: number[],
  indices: number[],
  path: Float32Array,
  pathIndex: number,
  _radius: number,
  ringSize: number,
  normalDirection: number,
): void {
  const point = readPathPoint(path, pathIndex);
  const prev = readPathPoint(path, Math.max(0, pathIndex - normalDirection));
  const next = readPathPoint(path, Math.min(Math.floor(path.length / 3) - 1, pathIndex + normalDirection));
  const tangent = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), next, prev));
  if (vec3.length(tangent) < 1e-6) {
    vec3.set(tangent, 0, 0, normalDirection);
  }
  const capNormal = vec3.scale(vec3.create(), tangent, normalDirection);
  const centerIndex = positions.length / 3;
  positions.push(point[0], point[1], point[2]);
  normals.push(capNormal[0], capNormal[1], capNormal[2]);
  const ringOffset = pathIndex * ringSize;
  for (let i = 0; i < ringSize; i += 1) {
    const nextIndex = (i + 1) % ringSize;
    indices.push(centerIndex, ringOffset + i, ringOffset + nextIndex);
  }
}

function readPathPoint(path: Float32Array, index: number): vec3 {
  const base = index * 3;
  return vec3.fromValues(path[base], path[base + 1], path[base + 2]);
}

