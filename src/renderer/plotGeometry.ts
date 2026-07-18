import { vec3 } from 'gl-matrix';
import { computeMeshBounds, computeVertexNormals, extractMeshEdges, mergeSerializedMeshes } from '../math/mesh/geometry';
import { buildSerializedPlotMesh } from '../math/mesh/plotMesh';
import { getRuntimePlotMesh } from '../workers/runtimeMeshCache';
import type { RenderableObject, SerializedMesh, Vec3 } from '../types/contracts';

export interface PlotGeometry {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  bounds: NonNullable<SerializedMesh['bounds']>;
  boundaryEdges: Float32Array;
  featureEdges: Float32Array;
  wireLines: Float32Array[];
  topology: NonNullable<SerializedMesh['topology']>;
  curvePath: Float32Array | null;
}

export interface RayHit {
  distance: number;
  pickedPoint: Vec3;
}

export function buildPlotGeometry(plot: RenderableObject): PlotGeometry {
  const mesh = getRuntimePlotMesh(plot.id)
    ?? (plot.type === 'plot' ? buildSerializedPlotMesh(plot) : emptyCurveMesh());
  return toPlotGeometry(plot, mesh);
}

export function toPlotGeometry(plot: RenderableObject, meshData: SerializedMesh): PlotGeometry {
  const curvePaths = collectCurvePaths(meshData);
  if (curvePaths.length > 0) {
    const curveStyle = curveStyleFor(plot);
    const renderedCurveMesh = mergeSerializedMeshes(
      curvePaths
        .filter((curvePath) => curvePath.length >= 6)
        .map((curvePath) => (
          curveStyle.renderAsTube
            ? buildTubeMeshFromCurvePath(curvePath, curveStyle.tubeRadius, 12)
            : buildPolylineRibbonMesh(curvePath, Math.max(0.02, curveStyle.tubeRadius * 0.35))
        )),
    );
    if (renderedCurveMesh.positions.length === 0) {
      return {
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        indices: new Uint32Array(0),
        bounds: meshData.bounds ?? computeMeshBounds([]),
        boundaryEdges: new Float32Array(0),
        featureEdges: new Float32Array(0),
        wireLines: [],
        topology: meshData.topology ?? {
          isClosedManifold: false,
          hasBoundaryEdges: false,
          hasFeatureEdges: false,
          boundaryEdgeCount: 0,
          featureEdgeCount: 0,
        },
        curvePath: curvePaths.length === 1 ? curvePaths[0] : null,
      };
    }
    return {
      positions: renderedCurveMesh.positions,
      normals: renderedCurveMesh.normals ?? new Float32Array(0),
      indices: renderedCurveMesh.indices,
      bounds: renderedCurveMesh.bounds ?? computeMeshBounds(renderedCurveMesh.positions),
      boundaryEdges: renderedCurveMesh.boundaryEdges ?? new Float32Array(0),
      featureEdges: renderedCurveMesh.featureEdges ?? new Float32Array(0),
      wireLines: renderedCurveMesh.lines ?? [],
      topology: renderedCurveMesh.topology ?? {
        isClosedManifold: false,
        hasBoundaryEdges: false,
        hasFeatureEdges: false,
        boundaryEdgeCount: 0,
        featureEdgeCount: 0,
      },
      curvePath: curvePaths.length === 1 ? curvePaths[0] : null,
    };
  }

  const positions = meshData.positions;
  const indices = meshData.indices;
  const normals = meshData.normals ?? computeVertexNormals(positions, indices);
  const edgeData = (
    meshData.boundaryEdges
    && meshData.featureEdges
    && meshData.topology
  )
    ? {
        boundaryEdges: meshData.boundaryEdges,
        featureEdges: meshData.featureEdges,
        topology: meshData.topology,
      }
    : extractMeshEdges(positions, indices);
  return {
    positions,
    normals,
    indices,
    bounds: meshData.bounds ?? computeMeshBounds(positions),
    boundaryEdges: edgeData.boundaryEdges,
    featureEdges: edgeData.featureEdges,
    wireLines: meshData.lines ?? [],
    topology: meshData.topology ?? edgeData.topology,
    curvePath: meshData.curvePath ?? null,
  };
}

function collectCurvePaths(meshData: SerializedMesh): Float32Array[] {
  if (meshData.curvePaths && meshData.curvePaths.length > 0) {
    return meshData.curvePaths;
  }
  return meshData.curvePath ? [meshData.curvePath] : [];
}

function curveStyleFor(plot: RenderableObject): { tubeRadius: number; renderAsTube: boolean } {
  if (plot.type === 'intersection') {
    return plot.curveStyle;
  }
  if (plot.equation.kind === 'parametric_curve') {
    return {
      tubeRadius: plot.equation.tubeRadius,
      renderAsTube: plot.equation.renderAsTube,
    };
  }
  return { tubeRadius: 0.05, renderAsTube: false };
}

function emptyCurveMesh(): SerializedMesh {
  return {
    positions: new Float32Array(0),
    indices: new Uint32Array(0),
    curvePaths: [],
    bounds: computeMeshBounds([]),
    boundaryEdges: new Float32Array(0),
    featureEdges: new Float32Array(0),
    topology: {
      isClosedManifold: false,
      hasBoundaryEdges: false,
      hasFeatureEdges: false,
      boundaryEdgeCount: 0,
      featureEdgeCount: 0,
    },
  };
}

export function intersectRayWithPlotGeometry(
  origin: vec3,
  direction: vec3,
  geometry: PlotGeometry,
  translation: Vec3,
): RayHit | null {
  const translatedOrigin = vec3.fromValues(origin[0] - translation.x, origin[1] - translation.y, origin[2] - translation.z);
  const min = geometry.bounds.min;
  const max = geometry.bounds.max;
  if (!intersectsAabb(translatedOrigin, direction, min, max)) {
    return null;
  }
  let bestDistance = Number.POSITIVE_INFINITY;
  const hit = vec3.create();
  for (let i = 0; i + 2 < geometry.indices.length; i += 3) {
    const distance = intersectTriangle(
      translatedOrigin,
      direction,
      geometry.positions,
      geometry.indices[i],
      geometry.indices[i + 1],
      geometry.indices[i + 2],
      hit,
    );
    if (distance !== null && distance < bestDistance) {
      bestDistance = distance;
    }
  }
  if (!Number.isFinite(bestDistance)) {
    return null;
  }
  return {
    distance: bestDistance,
    pickedPoint: {
      x: origin[0] + direction[0] * bestDistance,
      y: origin[1] + direction[1] * bestDistance,
      z: origin[2] + direction[2] * bestDistance,
    },
  };
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

function intersectsAabb(origin: vec3, direction: vec3, min: Vec3, max: Vec3): boolean {
  let tMin = Number.NEGATIVE_INFINITY;
  let tMax = Number.POSITIVE_INFINITY;
  for (let axis = 0; axis < 3; axis += 1) {
    const o = origin[axis];
    const d = direction[axis];
    const minValue = axis === 0 ? min.x : axis === 1 ? min.y : min.z;
    const maxValue = axis === 0 ? max.x : axis === 1 ? max.y : max.z;
    if (Math.abs(d) < 1e-8) {
      if (o < minValue || o > maxValue) {
        return false;
      }
      continue;
    }
    const inv = 1 / d;
    let near = (minValue - o) * inv;
    let far = (maxValue - o) * inv;
    if (near > far) {
      const swap = near;
      near = far;
      far = swap;
    }
    tMin = Math.max(tMin, near);
    tMax = Math.min(tMax, far);
    if (tMin > tMax) {
      return false;
    }
  }
  return tMax >= 0;
}

function intersectTriangle(
  origin: vec3,
  direction: vec3,
  positions: Float32Array,
  ia: number,
  ib: number,
  ic: number,
  hitScratch: vec3,
): number | null {
  const aIndex = ia * 3;
  const bIndex = ib * 3;
  const cIndex = ic * 3;
  const ax = positions[aIndex];
  const ay = positions[aIndex + 1];
  const az = positions[aIndex + 2];
  const bx = positions[bIndex];
  const by = positions[bIndex + 1];
  const bz = positions[bIndex + 2];
  const cx = positions[cIndex];
  const cy = positions[cIndex + 1];
  const cz = positions[cIndex + 2];

  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;

  const px = direction[1] * acz - direction[2] * acy;
  const py = direction[2] * acx - direction[0] * acz;
  const pz = direction[0] * acy - direction[1] * acx;
  const det = abx * px + aby * py + abz * pz;
  if (Math.abs(det) < 1e-8) {
    return null;
  }
  const invDet = 1 / det;
  const tx = origin[0] - ax;
  const ty = origin[1] - ay;
  const tz = origin[2] - az;
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) {
    return null;
  }
  const qx = ty * abz - tz * aby;
  const qy = tz * abx - tx * abz;
  const qz = tx * aby - ty * abx;
  const v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) * invDet;
  if (v < 0 || u + v > 1) {
    return null;
  }
  const t = (acx * qx + acy * qy + acz * qz) * invDet;
  if (t <= 1e-5) {
    return null;
  }
  vec3.scaleAndAdd(hitScratch, origin, direction, t);
  return t;
}
