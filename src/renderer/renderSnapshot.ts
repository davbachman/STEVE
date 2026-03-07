import type { ArcRotateCamera } from '@babylonjs/core';
import type { AppState } from '../state/store';
import type {
  InteractiveReflectionSource,
  PlotJobStatus,
  PlotObject,
  PointLightObject,
  SceneObject,
  SerializedMesh,
} from '../types/contracts';

export const INTERACTIVE_RENDERABLE_OPACITY_EPSILON = 0.02;
export const INTERACTIVE_OPAQUE_OPACITY_EPSILON = 0.999;
export const INTERACTIVE_SHELL_RENDER_OPACITY_EPSILON = 0.96;

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
  plot: PlotObject;
  meshVersion: number;
  opacity: number;
  opacityClass: PlotOpacityClass;
  isRenderable: boolean;
  castsInteractiveShadows: boolean;
  interactiveShadowMode: InteractiveShadowMode;
  showsWireframe: boolean;
  usesTransparentShells: boolean;
}

export interface RendererPointLightSnapshot {
  light: PointLightObject;
}

export interface RendererSceneSnapshot {
  scene: AppState['scene'];
  render: AppState['render'];
  objects: ReadonlyArray<SceneObject>;
  selectedId: string | null;
  plotJobs: Record<string, PlotJobStatus>;
  plots: RendererPlotSnapshot[];
  pointLights: RendererPointLightSnapshot[];
  camera: RendererCameraSnapshot | null;
}

export interface ReflectionSourceOptions {
  externalEnvironmentUsable: boolean;
  fallbackEnvironmentUsable: boolean;
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

export function plotSupportsWireframe(plot: PlotObject): boolean {
  return plot.equation.kind === 'parametric_surface' || plot.equation.kind === 'explicit_surface';
}

export function shouldShowPlotWireframe(plot: PlotObject): boolean {
  return plot.visible && plotSupportsWireframe(plot) && Boolean(plot.material.wireframeVisible);
}

export function shouldUseShellSelectionHalo(
  plot: PlotObject,
  meshTopology?: SerializedMesh['topology'],
): boolean {
  return plot.equation.kind === 'implicit_surface' && meshTopology?.isClosedManifold === true;
}

export function classifyInteractiveShadowMode(plot: PlotObject): InteractiveShadowMode {
  if (!plot.visible) {
    return 'none';
  }
  const opacity = clamp01(plot.material.opacity);
  if (plot.equation.kind === 'parametric_curve' && opacity <= INTERACTIVE_RENDERABLE_OPACITY_EPSILON) {
    return 'none';
  }
  if (plot.equation.kind === 'implicit_surface') {
    return opacity < INTERACTIVE_SHELL_RENDER_OPACITY_EPSILON ? 'attenuated' : 'solid';
  }
  return plotUsesTransparentShells(plot) ? 'attenuated' : 'solid';
}

export function shouldPlotCastInteractiveShadows(plot: PlotObject): boolean {
  return classifyInteractiveShadowMode(plot) !== 'none';
}

export function plotUsesTransparentShells(plot: PlotObject): boolean {
  const opacity = clamp01(plot.material.opacity);
  return opacity < INTERACTIVE_SHELL_RENDER_OPACITY_EPSILON
    && (plot.equation.kind === 'parametric_surface' || plot.equation.kind === 'explicit_surface');
}

export function shouldUseTransparentBackShell(
  plot: PlotObject,
  meshTopology?: SerializedMesh['topology'],
): boolean {
  if (plotUsesTransparentShells(plot)) {
    return true;
  }
  return plot.equation.kind === 'implicit_surface'
    && clamp01(plot.material.opacity) < INTERACTIVE_SHELL_RENDER_OPACITY_EPSILON
    && meshTopology?.isClosedManifold !== true;
}

export function selectInteractiveReflectionSource(
  options: ReflectionSourceOptions,
): InteractiveReflectionSource {
  if (options.externalEnvironmentUsable) {
    return 'external_env';
  }
  if (options.fallbackEnvironmentUsable) {
    return 'fallback_ready';
  }
  return 'none';
}

export function createRendererSceneSnapshot(
  state: Pick<AppState, 'scene' | 'render' | 'objects' | 'selectedId' | 'plotJobs'>,
  camera: ArcRotateCamera | null,
): RendererSceneSnapshot {
  return {
    scene: state.scene,
    render: state.render,
    objects: state.objects,
    selectedId: state.selectedId,
    plotJobs: state.plotJobs,
    plots: state.objects
      .filter((object): object is PlotObject => object.type === 'plot')
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
          usesTransparentShells: plotUsesTransparentShells(plot),
        };
      }),
    pointLights: state.objects
      .filter((object): object is PointLightObject => object.type === 'point_light')
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
