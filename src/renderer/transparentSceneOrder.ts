export interface ScenePosition {
  x: number;
  y: number;
  z: number;
}

export interface TransparentSceneOrderEntry<T> {
  item: T;
  position: ScenePosition;
}

/**
 * Returns transparent scene entries in painter's order while preserving the
 * input order of entries at the same distance.
 */
export function sortTransparentSceneBackToFront<T>(
  entries: ReadonlyArray<TransparentSceneOrderEntry<T>>,
  cameraPosition: ScenePosition,
): T[] {
  return entries
    .map((entry, index) => ({
      ...entry,
      index,
      distanceSquared: squaredDistance(entry.position, cameraPosition),
    }))
    .sort((a, b) => b.distanceSquared - a.distanceSquared || a.index - b.index)
    .map(({ item }) => item);
}

export function farthestPositionFromCamera(
  positions: ReadonlyArray<ScenePosition>,
  cameraPosition: ScenePosition,
): ScenePosition | null {
  let farthest: ScenePosition | null = null;
  let farthestDistance = Number.NEGATIVE_INFINITY;
  for (const position of positions) {
    const distance = squaredDistance(position, cameraPosition);
    if (distance > farthestDistance) {
      farthest = position;
      farthestDistance = distance;
    }
  }
  return farthest;
}

function squaredDistance(a: ScenePosition, b: ScenePosition): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
