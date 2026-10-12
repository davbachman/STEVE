import { vec3 } from 'gl-matrix';
import { computeMeshBounds, computeVertexNormals, extractMeshEdges } from '../math/mesh/geometry';
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
    ?? emptyCurveMesh();
  return toPlotGeometry(plot, mesh);
}

export function toPlotGeometry(_plot: RenderableObject, meshData: SerializedMesh): PlotGeometry {
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
    curvePath: meshData.curvePath ?? (meshData.curvePaths?.length === 1 ? meshData.curvePaths[0] : null),
  };
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
