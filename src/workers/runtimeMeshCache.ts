import type { SerializedMesh, UUID } from '../types/contracts';

const meshKeys = new WeakMap<SerializedMesh, string>();
let meshSequence = 0;

export function runtimeMeshKey(mesh: SerializedMesh): string {
  let key = meshKeys.get(mesh);
  if (!key) { key = String(++meshSequence); meshKeys.set(mesh, key); }
  return key;
}

const plotMeshCache = new Map<UUID, SerializedMesh>();

export function getRuntimePlotMesh(objectId: UUID): SerializedMesh | undefined {
  return plotMeshCache.get(objectId);
}

export function setRuntimePlotMesh(objectId: UUID, mesh: SerializedMesh): void {
  plotMeshCache.set(objectId, mesh);
}

export function clearRuntimePlotMesh(objectId: UUID): void {
  plotMeshCache.delete(objectId);
}

export function clearAllRuntimePlotMeshes(): void {
  plotMeshCache.clear();
}
