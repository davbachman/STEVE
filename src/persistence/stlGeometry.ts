import { buildSerializedPlotMesh } from '../math/mesh/plotMesh';
import { intersectSurfaceMeshes } from '../math/mesh/surfaceIntersection';
import { toPlotGeometry, type PlotGeometry } from '../renderer/plotGeometry';
import type { PlotObject, RenderableObject, SceneObject } from '../types/contracts';
import { isSurfacePlot } from '../types/guards';

function validatePlot(plot: PlotObject): void {
  if (plot.equation.source.parseStatus !== 'ok') {
    throw new Error(`Fix the equation for “${plot.name}” before exporting.`);
  }
}

/** Build the captured equations at their requested resolution, without the
 * viewport cache (which may still contain an older or interactive preview).
 */
export function buildStlExportGeometry(plot: RenderableObject, objects: SceneObject[]): PlotGeometry {
  if (plot.type === 'plot') {
    validatePlot(plot);
    return toPlotGeometry(plot, buildSerializedPlotMesh(plot));
  }
  const sources = plot.sourceSurfaceIds.map((id) => objects.find((object) => object.id === id));
  const [a, b] = sources;
  if (!isSurfacePlot(a) || !isSurfacePlot(b) || a.id === b.id) {
    throw new Error('Choose two valid source surfaces before exporting this intersection.');
  }
  validatePlot(a);
  validatePlot(b);
  const meshA = buildSerializedPlotMesh(a);
  const meshB = buildSerializedPlotMesh(b);
  const mesh = intersectSurfaceMeshes(
    { positions: meshA.positions, indices: meshA.indices, translation: a.transform.position },
    { positions: meshB.positions, indices: meshB.indices, translation: b.transform.position },
  );
  return toPlotGeometry(plot, mesh);
}
