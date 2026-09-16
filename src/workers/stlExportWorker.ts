/// <reference lib="webworker" />
import { buildStlExportGeometry } from '../persistence/stlGeometry';
import { serializePlotGeometryAsAsciiStl } from '../persistence/stlSerialization';
import type { RenderableObject, SceneObject } from '../types/contracts';

self.onmessage = (event: MessageEvent<{ plot: RenderableObject; objects: SceneObject[] }>) => {
  try {
    const { plot, objects } = event.data;
    const geometry = buildStlExportGeometry(plot, objects);
    if (geometry.indices.length < 3) throw new Error('Selected plot has no exportable triangle mesh.');
    const stl = serializePlotGeometryAsAsciiStl(plot.name, geometry, plot.transform.position);
    self.postMessage({ blob: new Blob([stl], { type: 'model/stl' }) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Unable to prepare this STL.' });
  }
};
