import type { AppState } from '../state/store';
import { resolvePinnedLight } from '../math/curvePinning';
import type {
  DirectionalLightObject,
  PlotJobStatus,
  PointLightObject,
  RenderableObject,
  SceneObject,
} from '../types/contracts';
import { isRenderableObject } from '../types/guards';

export const INTERACTIVE_RENDERABLE_OPACITY_EPSILON = 0.02;
export const INTERACTIVE_OPAQUE_OPACITY_EPSILON = 0.999;

export type PlotOpacityClass = 'hidden' | 'opaque' | 'transparent';
export type InteractiveShadowMode = 'none' | 'solid' | 'attenuated';

export interface RendererCameraSnapshot {
  alpha: number;
  beta: number;
  radius: number;
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  upVector: { x: number; y: number; z: number };
  fov: number;
  minZ: number;
  maxZ: number;
  mode: number;
  orthoLeft: number | null;
  orthoRight: number | null;
  orthoTop: number | null;
  orthoBottom: number | null;
}

export interface RendererPlotSnapshot {
  plot: RenderableObject;
  meshVersion: number;
  opacity: number;
  opacityClass: PlotOpacityClass;
  isRenderable: boolean;
  castsInteractiveShadows: boolean;
  interactiveShadowMode: InteractiveShadowMode;
  showsWireframe: boolean;
}

export interface RendererPointLightSnapshot {
  light: PointLightObject;
}

export interface RendererDirectionalLightSnapshot {
  light: DirectionalLightObject;
}

export interface RendererSceneSnapshot {
  scene: AppState['scene'];
  render: AppState['render'];
  objects: ReadonlyArray<SceneObject>;
  selectedId: string | null;
  plotJobs: Record<string, PlotJobStatus>;
  plots: RendererPlotSnapshot[];
  pointLights: RendererPointLightSnapshot[];
  directionalLights: RendererDirectionalLightSnapshot[];
  camera: RendererCameraSnapshot | null;
}

export interface RendererCameraLike {
  alpha: number;
  beta: number;
  radius: number;
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  upVector: { x: number; y: number; z: number };
  fov: number;
  minZ: number;
  maxZ: number;
  mode: number;
  orthoLeft?: number | null;
  orthoRight?: number | null;
  orthoTop?: number | null;
  orthoBottom?: number | null;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function classifyPlotOpacity(opacity: number): PlotOpacityClass {
  const normalized = clamp01(opacity);
  if (normalized <= INTERACTIVE_RENDERABLE_OPACITY_EPSILON) {
    return 'hidden';
  }
  if (normalized >= INTERACTIVE_OPAQUE_OPACITY_EPSILON) {
    return 'opaque';
  }
  return 'transparent';
}

export function plotSupportsWireframe(plot: RenderableObject): boolean {
  return plot.type === 'plot'
    && (plot.equation.kind === 'parametric_surface' || plot.equation.kind === 'explicit_surface');
}

export function shouldShowPlotWireframe(plot: RenderableObject): boolean {
  return plot.visible && plotSupportsWireframe(plot) && Boolean(plot.material.wireframeVisible);
}

export function classifyInteractiveShadowMode(plot: RenderableObject): InteractiveShadowMode {
  if (!plot.visible) {
    return 'none';
  }
  const opacity = clamp01(plot.material.opacity);
  if (opacity >= INTERACTIVE_OPAQUE_OPACITY_EPSILON) {
    return 'solid';
  }
  return 'attenuated';
}

export function shouldPlotCastInteractiveShadows(plot: RenderableObject): boolean {
  return classifyInteractiveShadowMode(plot) !== 'none';
}

export function resolveDirectionalShadowFrustumSize(scene: AppState['scene']): number {
  const graphBounds = scene.defaultGraphBounds;
  const graphSpanX = Math.abs(graphBounds.max.x - graphBounds.min.x);
  const graphSpanY = Math.abs(graphBounds.max.y - graphBounds.min.y);
  return Math.max(
    12,
    graphSpanX * 1.8,
    graphSpanY * 1.8,
    scene.groundPlaneVisible ? scene.groundPlaneSize * 2.4 : 0,
  );
}

export function createRendererSceneSnapshot(
  state: Pick<AppState, 'scene' | 'render' | 'objects' | 'selectedId' | 'plotJobs'>,
  camera: RendererCameraLike | null,
): RendererSceneSnapshot {
  const resolvedObjects = state.objects.map((object) => (
    object.type === 'point_light' || object.type === 'directional_light'
      ? resolvePinnedLight(object, state.objects)
      : object
  ));
  return {
    scene: state.scene,
    render: state.render,
    objects: resolvedObjects,
    selectedId: state.selectedId,
    plotJobs: state.plotJobs,
    plots: state.objects
      .filter(isRenderableObject)
      .map((plot) => {
        const opacity = clamp01(plot.material.opacity);
        const opacityClass = classifyPlotOpacity(opacity);
        const interactiveShadowMode = classifyInteractiveShadowMode(plot);
        return {
          plot,
          meshVersion: state.plotJobs[plot.id]?.meshVersion ?? 0,
          opacity,
          opacityClass,
          isRenderable: opacityClass !== 'hidden',
          castsInteractiveShadows: interactiveShadowMode !== 'none',
          interactiveShadowMode,
          showsWireframe: shouldShowPlotWireframe(plot),
        };
      }),
    pointLights: resolvedObjects
      .filter((object): object is PointLightObject => object.type === 'point_light')
      .map((light) => ({ light })),
    directionalLights: resolvedObjects
      .filter((object): object is DirectionalLightObject => object.type === 'directional_light')
      .map((light) => ({ light })),
    camera: camera
      ? {
          alpha: camera.alpha,
          beta: camera.beta,
          radius: camera.radius,
          position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
          target: { x: camera.target.x, y: camera.target.y, z: camera.target.z },
          upVector: { x: camera.upVector.x, y: camera.upVector.y, z: camera.upVector.z },
          fov: camera.fov,
          minZ: camera.minZ,
          maxZ: camera.maxZ,
          mode: camera.mode,
          orthoLeft: camera.orthoLeft ?? null,
          orthoRight: camera.orthoRight ?? null,
          orthoTop: camera.orthoTop ?? null,
          orthoBottom: camera.orthoBottom ?? null,
        }
      : null,
  };
}
