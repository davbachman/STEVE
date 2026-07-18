import type { PlotObject, RenderableObject, SceneObject } from './contracts';

export function isRenderableObject(object: SceneObject): object is RenderableObject {
  return object.type === 'plot' || object.type === 'intersection';
}

export function isSurfacePlot(object: SceneObject | undefined | null): object is PlotObject {
  if (!object || object.type !== 'plot') return false;
  return object.equation.kind === 'parametric_surface'
    || object.equation.kind === 'explicit_surface'
    || object.equation.kind === 'implicit_surface';
}
