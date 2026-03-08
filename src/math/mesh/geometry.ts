import type { MeshBounds, SerializedMeshTopology, Vec3 } from '../../types/contracts';

interface EdgeFace {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  normal: Vec3;
}

interface EdgeBucket {
  faces: EdgeFace[];
}

const DEFAULT_FEATURE_ANGLE_DEGREES = 32;

export function computeVertexNormals(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const ia = indices[i] * 3;
    const ib = indices[i + 1] * 3;
    const ic = indices[i + 2] * 3;
    if (ic + 2 >= positions.length) {
      continue;
    }
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
  for (let i = 0; i + 2 < normals.length; i += 3) {
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

export function computeMeshBounds(positions: ArrayLike<number>): MeshBounds {
  if (positions.length < 3) {
    return {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 0, y: 0, z: 0 },
      center: { x: 0, y: 0, z: 0 },
      radius: 0,
    };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  if (!Number.isFinite(minX)) {
    minX = minY = minZ = 0;
    maxX = maxY = maxZ = 0;
  }
  const center = {
    x: (minX + maxX) * 0.5,
    y: (minY + maxY) * 0.5,
    z: (minZ + maxZ) * 0.5,
  };
  let radius = 0;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const dx = positions[i] - center.x;
    const dy = positions[i + 1] - center.y;
    const dz = positions[i + 2] - center.z;
    radius = Math.max(radius, Math.hypot(dx, dy, dz));
  }
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    center,
    radius,
  };
}

export function extractMeshEdges(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  featureAngleDegrees = DEFAULT_FEATURE_ANGLE_DEGREES,
): {
  boundaryEdges: Float32Array;
  featureEdges: Float32Array;
  topology: SerializedMeshTopology;
} {
  const cosineThreshold = Math.cos((featureAngleDegrees * Math.PI) / 180);
  const edgeMap = new Map<string, EdgeBucket>();
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const ia = indices[i];
    const ib = indices[i + 1];
    const ic = indices[i + 2];
    const faceNormal = readFaceNormal(positions, ia, ib, ic);
    pushEdge(edgeMap, positions, ia, ib, faceNormal);
    pushEdge(edgeMap, positions, ib, ic, faceNormal);
    pushEdge(edgeMap, positions, ic, ia, faceNormal);
  }
  const boundarySegments: number[] = [];
  const featureSegments: number[] = [];
  let boundaryEdgeCount = 0;
  let featureEdgeCount = 0;
  for (const bucket of edgeMap.values()) {
    if (bucket.faces.length <= 0) {
      continue;
    }
    const face = bucket.faces[0];
    if (bucket.faces.length === 1) {
      boundaryEdgeCount += 1;
      boundarySegments.push(face.ax, face.ay, face.az, face.bx, face.by, face.bz);
      continue;
    }
    if (bucket.faces.length !== 2) {
      featureEdgeCount += 1;
      featureSegments.push(face.ax, face.ay, face.az, face.bx, face.by, face.bz);
      continue;
    }
    const dot =
      bucket.faces[0].normal.x * bucket.faces[1].normal.x
      + bucket.faces[0].normal.y * bucket.faces[1].normal.y
      + bucket.faces[0].normal.z * bucket.faces[1].normal.z;
    if (dot < cosineThreshold) {
      featureEdgeCount += 1;
      featureSegments.push(face.ax, face.ay, face.az, face.bx, face.by, face.bz);
    }
  }
  return {
    boundaryEdges: new Float32Array(boundarySegments),
    featureEdges: new Float32Array(featureSegments),
    topology: {
      isClosedManifold: boundaryEdgeCount === 0,
      hasBoundaryEdges: boundaryEdgeCount > 0,
      hasFeatureEdges: featureEdgeCount > 0,
      boundaryEdgeCount,
      featureEdgeCount,
    },
  };
}

function pushEdge(
  edgeMap: Map<string, EdgeBucket>,
  positions: ArrayLike<number>,
  ia: number,
  ib: number,
  normal: Vec3,
): void {
  const key = ia < ib ? `${ia}|${ib}` : `${ib}|${ia}`;
  const bucket = edgeMap.get(key) ?? { faces: [] };
  const a = ia * 3;
  const b = ib * 3;
  bucket.faces.push({
    ax: positions[a],
    ay: positions[a + 1],
    az: positions[a + 2],
    bx: positions[b],
    by: positions[b + 1],
    bz: positions[b + 2],
    normal,
  });
  edgeMap.set(key, bucket);
}

function readFaceNormal(
  positions: ArrayLike<number>,
  ia: number,
  ib: number,
  ic: number,
): Vec3 {
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
  const len = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / len, y: ny / len, z: nz / len };
}
