import type { SerializedMesh, Vec3 } from '../../types/contracts';
import { computeMeshBounds } from './geometry';

/** A triangulated surface and the translation that places it in world space. */
export interface SurfaceMeshInput {
  positions: Float32Array;
  indices: Uint32Array;
  translation: Vec3;
}

interface Bounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

interface Triangle {
  vertices: [Vec3, Vec3, Vec3];
  normal: Vec3;
  bounds: Bounds;
  centroid: Vec3;
}

interface BvhNode {
  bounds: Bounds;
  count: number;
  triangles?: Triangle[];
  left?: BvhNode;
  right?: BvhNode;
}

interface Segment {
  start: Vec3;
  end: Vec3;
}

interface WeldNode {
  representative: Vec3;
  sumX: number;
  sumY: number;
  sumZ: number;
  count: number;
}

interface GraphEdge {
  a: number;
  b: number;
  used: boolean;
}

const BVH_LEAF_SIZE = 8;
const PARALLEL_SINE_TOLERANCE = 1e-9;

/**
 * Finds the polyline intersection of two triangulated surfaces.
 *
 * Coplanar overlap has no unique one-dimensional answer and is deliberately
 * omitted. A closed path repeats its first point as its final point.
 */
export function intersectSurfaceMeshes(
  a: SurfaceMeshInput,
  b: SurfaceMeshInput,
): SerializedMesh {
  const trianglesA = buildTriangles(a);
  const trianglesB = buildTriangles(b);
  if (trianglesA.length === 0 || trianglesB.length === 0) {
    return emptyIntersectionMesh();
  }

  const bvhA = buildBvh(trianglesA);
  const bvhB = buildBvh(trianglesB);
  const combinedBounds = unionBounds(bvhA.bounds, bvhB.bounds);
  const scale = Math.max(
    combinedBounds.maxX - combinedBounds.minX,
    combinedBounds.maxY - combinedBounds.minY,
    combinedBounds.maxZ - combinedBounds.minZ,
    1e-6,
  );
  const weldTolerance = Math.max(scale * 2e-7, 1e-9);
  const planeTolerance = Math.max(scale * 1e-9, 1e-11);

  if (!boundsOverlap(bvhA.bounds, bvhB.bounds, weldTolerance)) {
    return emptyIntersectionMesh();
  }

  const segments: Segment[] = [];
  const pending: Array<[BvhNode, BvhNode]> = [[bvhA, bvhB]];
  while (pending.length > 0) {
    const pair = pending.pop();
    if (!pair) break;
    const [nodeA, nodeB] = pair;
    if (!boundsOverlap(nodeA.bounds, nodeB.bounds, weldTolerance)) {
      continue;
    }

    if (nodeA.triangles && nodeB.triangles) {
      for (const triangleA of nodeA.triangles) {
        for (const triangleB of nodeB.triangles) {
          if (!boundsOverlap(triangleA.bounds, triangleB.bounds, weldTolerance)) {
            continue;
          }
          const segment = intersectTriangles(
            triangleA,
            triangleB,
            planeTolerance,
            weldTolerance,
          );
          if (segment) segments.push(segment);
        }
      }
      continue;
    }

    if (nodeA.triangles) {
      if (nodeB.left) pending.push([nodeA, nodeB.left]);
      if (nodeB.right) pending.push([nodeA, nodeB.right]);
      continue;
    }
    if (nodeB.triangles) {
      if (nodeA.left) pending.push([nodeA.left, nodeB]);
      if (nodeA.right) pending.push([nodeA.right, nodeB]);
      continue;
    }
    if (nodeA.left && nodeB.left) pending.push([nodeA.left, nodeB.left]);
    if (nodeA.left && nodeB.right) pending.push([nodeA.left, nodeB.right]);
    if (nodeA.right && nodeB.left) pending.push([nodeA.right, nodeB.left]);
    if (nodeA.right && nodeB.right) pending.push([nodeA.right, nodeB.right]);
  }

  if (segments.length === 0) {
    return emptyIntersectionMesh();
  }

  const curvePaths = stitchSegments(
    segments,
    weldTolerance,
    {
      x: combinedBounds.minX,
      y: combinedBounds.minY,
      z: combinedBounds.minZ,
    },
  );
  if (curvePaths.length === 0) {
    return emptyIntersectionMesh();
  }

  const boundsPositions = new Float32Array(
    curvePaths.reduce((length, path) => length + path.length, 0),
  );
  let boundsOffset = 0;
  for (const path of curvePaths) {
    boundsPositions.set(path, boundsOffset);
    boundsOffset += path.length;
  }

  return {
    positions: new Float32Array(0),
    indices: new Uint32Array(0),
    curvePaths,
    bounds: computeMeshBounds(boundsPositions),
    boundaryEdges: new Float32Array(0),
    featureEdges: new Float32Array(0),
    topology: emptyCurveTopology(),
  };
}

function buildTriangles(input: SurfaceMeshInput): Triangle[] {
  const triangles: Triangle[] = [];
  const tx = finiteOrZero(input.translation.x);
  const ty = finiteOrZero(input.translation.y);
  const tz = finiteOrZero(input.translation.z);
  const vertexCount = Math.floor(input.positions.length / 3);

  for (let offset = 0; offset + 2 < input.indices.length; offset += 3) {
    const ia = input.indices[offset];
    const ib = input.indices[offset + 1];
    const ic = input.indices[offset + 2];
    if (ia >= vertexCount || ib >= vertexCount || ic >= vertexCount) continue;

    const va = readTranslatedVertex(input.positions, ia, tx, ty, tz);
    const vb = readTranslatedVertex(input.positions, ib, tx, ty, tz);
    const vc = readTranslatedVertex(input.positions, ic, tx, ty, tz);
    if (!va || !vb || !vc) continue;

    const ab = subtract(vb, va);
    const ac = subtract(vc, va);
    const rawNormal = cross(ab, ac);
    const normalLength = length(rawNormal);
    if (!(normalLength > 0) || !Number.isFinite(normalLength)) continue;

    const normal = scaleVector(rawNormal, 1 / normalLength);
    const bounds = boundsFromVertices(va, vb, vc);
    triangles.push({
      vertices: [va, vb, vc],
      normal,
      bounds,
      centroid: {
        x: (va.x + vb.x + vc.x) / 3,
        y: (va.y + vb.y + vc.y) / 3,
        z: (va.z + vb.z + vc.z) / 3,
      },
    });
  }
  return triangles;
}

function buildBvh(triangles: Triangle[]): BvhNode {
  const bounds = boundsForTriangles(triangles);
  if (triangles.length <= BVH_LEAF_SIZE) {
    return { bounds, count: triangles.length, triangles };
  }

  const extentX = bounds.maxX - bounds.minX;
  const extentY = bounds.maxY - bounds.minY;
  const extentZ = bounds.maxZ - bounds.minZ;
  const axis: keyof Vec3 = extentX >= extentY && extentX >= extentZ
    ? 'x'
    : extentY >= extentZ ? 'y' : 'z';
  const sorted = [...triangles].sort((first, second) => (
    first.centroid[axis] - second.centroid[axis]
  ));
  const midpoint = Math.floor(sorted.length / 2);
  const left = buildBvh(sorted.slice(0, midpoint));
  const right = buildBvh(sorted.slice(midpoint));
  return {
    bounds,
    count: triangles.length,
    left,
    right,
  };
}

function intersectTriangles(
  a: Triangle,
  b: Triangle,
  planeTolerance: number,
  weldTolerance: number,
): Segment | null {
  const line = cross(a.normal, b.normal);
  const lineLengthSquared = dot(line, line);
  if (
    !Number.isFinite(lineLengthSquared)
    || lineLengthSquared <= PARALLEL_SINE_TOLERANCE * PARALLEL_SINE_TOLERANCE
  ) {
    // Parallel triangles are either disjoint or coplanar. Coplanar overlap is
    // two-dimensional, so neither case contributes a unique curve segment.
    return null;
  }

  const distancesAToB = signedDistances(a.vertices, b.vertices[0], b.normal);
  const distancesBToA = signedDistances(b.vertices, a.vertices[0], a.normal);
  if (
    liesStrictlyOnOneSide(distancesAToB, planeTolerance)
    || liesStrictlyOnOneSide(distancesBToA, planeTolerance)
  ) {
    return null;
  }

  const lineLength = Math.sqrt(lineLengthSquared);
  const lineDirection = scaleVector(line, 1 / lineLength);
  const sliceA = sliceTriangleByPlane(
    a.vertices,
    distancesAToB,
    lineDirection,
    planeTolerance,
  );
  const sliceB = sliceTriangleByPlane(
    b.vertices,
    distancesBToA,
    lineDirection,
    planeTolerance,
  );
  if (!sliceA || !sliceB) return null;

  const origin = averageVertices(a.vertices, b.vertices);
  const intervalA = projectedInterval(sliceA, origin, lineDirection);
  const intervalB = projectedInterval(sliceB, origin, lineDirection);
  const overlapStart = Math.max(intervalA[0], intervalB[0]);
  const overlapEnd = Math.min(intervalA[1], intervalB[1]);
  if (
    !Number.isFinite(overlapStart)
    || !Number.isFinite(overlapEnd)
    || overlapEnd - overlapStart <= weldTolerance
  ) {
    // A point contact is not a one-dimensional intersection.
    return null;
  }

  // Construct both endpoints on the exact common line. Keeping the plane
  // equations relative to a nearby origin avoids precision loss after large
  // world-space translations.
  const planeConstantA = dot(a.normal, subtract(a.vertices[0], origin));
  const planeConstantB = dot(b.normal, subtract(b.vertices[0], origin));
  const firstBasis = cross(b.normal, line);
  const secondBasis = cross(line, a.normal);
  const lineOffset = scaleVector(
    add(
      scaleVector(firstBasis, planeConstantA),
      scaleVector(secondBasis, planeConstantB),
    ),
    1 / lineLengthSquared,
  );
  const linePoint = add(origin, lineOffset);
  const start = add(linePoint, scaleVector(lineDirection, overlapStart));
  const end = add(linePoint, scaleVector(lineDirection, overlapEnd));
  if (!isFiniteVector(start) || !isFiniteVector(end)) return null;
  return { start, end };
}

function sliceTriangleByPlane(
  vertices: readonly [Vec3, Vec3, Vec3],
  distances: readonly [number, number, number],
  lineDirection: Vec3,
  tolerance: number,
): [Vec3, Vec3] | null {
  const candidates: Vec3[] = [];
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(distances[i]) <= tolerance) {
      addUniquePoint(candidates, vertices[i], tolerance);
    }
  }

  for (let i = 0; i < 3; i += 1) {
    const j = (i + 1) % 3;
    const firstDistance = distances[i];
    const secondDistance = distances[j];
    if (
      (firstDistance < -tolerance && secondDistance > tolerance)
      || (firstDistance > tolerance && secondDistance < -tolerance)
    ) {
      const denominator = firstDistance - secondDistance;
      if (denominator === 0 || !Number.isFinite(denominator)) continue;
      const amount = firstDistance / denominator;
      const point = interpolate(vertices[i], vertices[j], amount);
      if (isFiniteVector(point)) addUniquePoint(candidates, point, tolerance);
    }
  }

  if (candidates.length < 2) return null;
  let minimum = candidates[0];
  let maximum = candidates[0];
  let minimumProjection = dot(candidates[0], lineDirection);
  let maximumProjection = minimumProjection;
  for (let i = 1; i < candidates.length; i += 1) {
    const projection = dot(candidates[i], lineDirection);
    if (projection < minimumProjection) {
      minimumProjection = projection;
      minimum = candidates[i];
    }
    if (projection > maximumProjection) {
      maximumProjection = projection;
      maximum = candidates[i];
    }
  }
  return maximumProjection - minimumProjection > tolerance
    ? [minimum, maximum]
    : null;
}

function stitchSegments(
  segments: readonly Segment[],
  tolerance: number,
  gridOrigin: Vec3,
): Float32Array[] {
  const nodes: WeldNode[] = [];
  const buckets = new Map<string, number[]>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const adjacency: number[][] = [];

  const findOrCreateNode = (point: Vec3): number => {
    const gridX = Math.floor((point.x - gridOrigin.x) / tolerance);
    const gridY = Math.floor((point.y - gridOrigin.y) / tolerance);
    const gridZ = Math.floor((point.z - gridOrigin.z) / tolerance);
    let bestNode = -1;
    let bestDistanceSquared = tolerance * tolerance;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const bucket = buckets.get(gridKey(gridX + dx, gridY + dy, gridZ + dz));
          if (!bucket) continue;
          for (const nodeId of bucket) {
            const distanceSquared = squaredDistance(nodes[nodeId].representative, point);
            if (distanceSquared <= bestDistanceSquared) {
              bestDistanceSquared = distanceSquared;
              bestNode = nodeId;
            }
          }
        }
      }
    }

    if (bestNode >= 0) {
      const node = nodes[bestNode];
      node.sumX += point.x;
      node.sumY += point.y;
      node.sumZ += point.z;
      node.count += 1;
      return bestNode;
    }

    const nodeId = nodes.length;
    nodes.push({
      representative: point,
      sumX: point.x,
      sumY: point.y,
      sumZ: point.z,
      count: 1,
    });
    adjacency.push([]);
    const key = gridKey(gridX, gridY, gridZ);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(nodeId);
    else buckets.set(key, [nodeId]);
    return nodeId;
  };

  for (const segment of segments) {
    const a = findOrCreateNode(segment.start);
    const b = findOrCreateNode(segment.end);
    if (a === b) continue;
    const edgeKey = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (edgeKeys.has(edgeKey)) continue;
    edgeKeys.add(edgeKey);
    const edgeId = edges.length;
    edges.push({ a, b, used: false });
    adjacency[a].push(edgeId);
    adjacency[b].push(edgeId);
  }

  const nodePositions = nodes.map((node) => ({
    x: node.sumX / node.count,
    y: node.sumY / node.count,
    z: node.sumZ / node.count,
  }));
  const paths: number[][] = [];

  for (let nodeId = 0; nodeId < nodes.length; nodeId += 1) {
    if (adjacency[nodeId].length === 2) continue;
    for (const edgeId of adjacency[nodeId]) {
      if (!edges[edgeId].used) {
        paths.push(tracePath(nodeId, edgeId, edges, adjacency));
      }
    }
  }
  for (let edgeId = 0; edgeId < edges.length; edgeId += 1) {
    if (!edges[edgeId].used) {
      paths.push(tracePath(edges[edgeId].a, edgeId, edges, adjacency));
    }
  }

  const canonicalPaths = paths
    .filter((path) => path.length >= 2)
    .map((path) => canonicalizePath(path, nodePositions))
    .sort((first, second) => compareNodePaths(first, second, nodePositions));

  return canonicalPaths.map((path) => {
    const serialized = new Float32Array(path.length * 3);
    for (let i = 0; i < path.length; i += 1) {
      const point = nodePositions[path[i]];
      serialized[i * 3] = point.x;
      serialized[i * 3 + 1] = point.y;
      serialized[i * 3 + 2] = point.z;
    }
    return serialized;
  });
}

function tracePath(
  startNode: number,
  firstEdge: number,
  edges: GraphEdge[],
  adjacency: readonly number[][],
): number[] {
  const path = [startNode];
  let currentNode = startNode;
  let edgeId = firstEdge;

  while (!edges[edgeId].used) {
    const edge = edges[edgeId];
    edge.used = true;
    const nextNode = edge.a === currentNode ? edge.b : edge.a;
    path.push(nextNode);
    if (nextNode === startNode || adjacency[nextNode].length !== 2) break;
    const nextEdge = adjacency[nextNode].find((candidate) => !edges[candidate].used);
    if (nextEdge === undefined) break;
    currentNode = nextNode;
    edgeId = nextEdge;
  }
  return path;
}

function canonicalizePath(path: number[], positions: readonly Vec3[]): number[] {
  const closed = path.length > 2 && path[0] === path[path.length - 1];
  if (!closed) {
    return comparePoints(positions[path[0]], positions[path[path.length - 1]]) <= 0
      ? path
      : [...path].reverse();
  }

  const ring = path.slice(0, -1);
  let smallestIndex = 0;
  for (let i = 1; i < ring.length; i += 1) {
    const comparison = comparePoints(positions[ring[i]], positions[ring[smallestIndex]]);
    if (comparison < 0 || (comparison === 0 && ring[i] < ring[smallestIndex])) {
      smallestIndex = i;
    }
  }

  const forward = rotateRing(ring, smallestIndex, 1);
  const backward = rotateRing(ring, smallestIndex, -1);
  const canonical = compareNodePaths(forward, backward, positions) <= 0 ? forward : backward;
  return [...canonical, canonical[0]];
}

function rotateRing(ring: readonly number[], start: number, direction: 1 | -1): number[] {
  return Array.from({ length: ring.length }, (_, offset) => {
    const index = (start + direction * offset + ring.length) % ring.length;
    return ring[index];
  });
}

function compareNodePaths(
  first: readonly number[],
  second: readonly number[],
  positions: readonly Vec3[],
): number {
  const sharedLength = Math.min(first.length, second.length);
  for (let i = 0; i < sharedLength; i += 1) {
    const comparison = comparePoints(positions[first[i]], positions[second[i]]);
    if (comparison !== 0) return comparison;
  }
  return first.length - second.length;
}

function comparePoints(a: Vec3, b: Vec3): number {
  return a.x - b.x || a.y - b.y || a.z - b.z;
}

function projectedInterval(
  segment: readonly [Vec3, Vec3],
  origin: Vec3,
  direction: Vec3,
): [number, number] {
  const first = dot(subtract(segment[0], origin), direction);
  const second = dot(subtract(segment[1], origin), direction);
  return first <= second ? [first, second] : [second, first];
}

function signedDistances(
  vertices: readonly [Vec3, Vec3, Vec3],
  planePoint: Vec3,
  planeNormal: Vec3,
): [number, number, number] {
  return [
    dot(subtract(vertices[0], planePoint), planeNormal),
    dot(subtract(vertices[1], planePoint), planeNormal),
    dot(subtract(vertices[2], planePoint), planeNormal),
  ];
}

function liesStrictlyOnOneSide(
  distances: readonly [number, number, number],
  tolerance: number,
): boolean {
  return distances.every((distance) => distance > tolerance)
    || distances.every((distance) => distance < -tolerance);
}

function addUniquePoint(points: Vec3[], point: Vec3, tolerance: number): void {
  const toleranceSquared = tolerance * tolerance;
  if (!points.some((existing) => squaredDistance(existing, point) <= toleranceSquared)) {
    points.push(point);
  }
}

function averageVertices(
  a: readonly [Vec3, Vec3, Vec3],
  b: readonly [Vec3, Vec3, Vec3],
): Vec3 {
  return {
    x: (a[0].x + a[1].x + a[2].x + b[0].x + b[1].x + b[2].x) / 6,
    y: (a[0].y + a[1].y + a[2].y + b[0].y + b[1].y + b[2].y) / 6,
    z: (a[0].z + a[1].z + a[2].z + b[0].z + b[1].z + b[2].z) / 6,
  };
}

function boundsFromVertices(a: Vec3, b: Vec3, c: Vec3): Bounds {
  return {
    minX: Math.min(a.x, b.x, c.x),
    minY: Math.min(a.y, b.y, c.y),
    minZ: Math.min(a.z, b.z, c.z),
    maxX: Math.max(a.x, b.x, c.x),
    maxY: Math.max(a.y, b.y, c.y),
    maxZ: Math.max(a.z, b.z, c.z),
  };
}

function boundsForTriangles(triangles: readonly Triangle[]): Bounds {
  let bounds = triangles[0].bounds;
  for (let i = 1; i < triangles.length; i += 1) {
    bounds = unionBounds(bounds, triangles[i].bounds);
  }
  return bounds;
}

function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
    maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

function boundsOverlap(a: Bounds, b: Bounds, tolerance: number): boolean {
  return a.minX <= b.maxX + tolerance
    && a.maxX + tolerance >= b.minX
    && a.minY <= b.maxY + tolerance
    && a.maxY + tolerance >= b.minY
    && a.minZ <= b.maxZ + tolerance
    && a.maxZ + tolerance >= b.minZ;
}

function readTranslatedVertex(
  positions: Float32Array,
  vertexIndex: number,
  tx: number,
  ty: number,
  tz: number,
): Vec3 | null {
  const offset = vertexIndex * 3;
  const point = {
    x: positions[offset] + tx,
    y: positions[offset + 1] + ty,
    z: positions[offset + 2] + tz,
  };
  return isFiniteVector(point) ? point : null;
}

function gridKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function interpolate(a: Vec3, b: Vec3, amount: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * amount,
    y: a.y + (b.y - a.y) * amount,
    z: a.z + (b.z - a.z) * amount,
  };
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scaleVector(vector: Vec3, scalar: number): Vec3 {
  return { x: vector.x * scalar, y: vector.y * scalar, z: vector.z * scalar };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function length(vector: Vec3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function squaredDistance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function isFiniteVector(vector: Vec3): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function emptyCurveTopology() {
  return {
    isClosedManifold: false,
    hasBoundaryEdges: false,
    hasFeatureEdges: false,
    boundaryEdgeCount: 0,
    featureEdgeCount: 0,
  } as const;
}

function emptyIntersectionMesh(): SerializedMesh {
  return {
    positions: new Float32Array(0),
    indices: new Uint32Array(0),
    curvePaths: [],
    bounds: computeMeshBounds([]),
    boundaryEdges: new Float32Array(0),
    featureEdges: new Float32Array(0),
    topology: emptyCurveTopology(),
  };
}
