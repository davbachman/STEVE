import { mat3, mat4, vec3, vec4 } from 'gl-matrix';
import { curveParameterBounds, curveTraversalMode, pinnedCurveForLight } from '../math/curvePinning';
import { downloadBlobFile } from '../persistence/projectFile';
import type { AppState } from '../state/store';
import { useAppStore } from '../state/store';
import type {
  DirectionalLightObject,
  LightObject,
  PlotObject,
  PointLightObject,
  RenderableObject,
  SceneObject,
} from '../types/contracts';
import { isParametricCurvePlot, isRenderableObject, isSurfacePlot } from '../types/guards';
import {
  classifyInteractiveShadowMode,
  createRendererSceneSnapshot,
  resolveDirectionalShadowFrustumSize,
  type RendererCameraLike,
  type RendererSceneSnapshot,
} from './renderSnapshot';
import {
  shouldPointLightContribute,
  shouldRenderPointLightGizmo,
} from './pointLightVisibility';
import { shadowVisibilityGlsl } from './shadowVisibility';
import {
  buildPlotGeometry,
  intersectRayWithPlotGeometry,
  type PlotGeometry,
} from './plotGeometry';
import { GifSelectionGuard, setAnimationGifRecording } from './animationRecordingState';
import { GifEncoderWorkerClient } from './GifEncoderWorkerClient';
import {
  parameterValueForGifFrame,
  rangeValueForGifFrame,
  resolveParameterGifTiming,
  resolveRangeGifTiming,
} from './parameterGif';
import { resolveTurntableGifDimensions, resolveTurntableGifTiming } from './turntableGif';
import {
  farthestPositionFromCamera,
  sortTransparentSceneBackToFront,
  type ScenePosition,
} from './transparentSceneOrder';

export type ViewPreset = 'top' | 'front' | 'side' | 'default';

export interface ViewportApi {
  exportPng: (filename?: string, scale?: number) => Promise<void>;
  recordTurntableGif: (onProgress?: (progress: number) => void) => Promise<void>;
  recordParameterGif: (
    plotId: string,
    parameterName: string,
    onProgress?: (progress: number) => void,
  ) => Promise<void>;
  recordLightCurveGif: (
    lightId: string,
    onProgress?: (progress: number) => void,
  ) => Promise<void>;
  cancelGifRecording: () => boolean;
  setViewPreset: (preset: ViewPreset) => void;
  frameObject: (objectId?: string | null) => void;
}

interface GpuMeshBuffers {
  vao: WebGLVertexArrayObject | null;
  indexBuffer: WebGLBuffer | null;
  indexCount: number;
  boundaryLines: GpuLineBuffer | null;
  featureLines: GpuLineBuffer | null;
  wireLines: GpuLineBuffer[];
}

interface GpuLineBuffer {
  vao: WebGLVertexArrayObject | null;
  vertexBuffer: WebGLBuffer | null;
  vertexCount: number;
  primitive: number;
}

interface PlotVisual {
  plotId: string;
  geometry: PlotGeometry;
  buffers: GpuMeshBuffers;
  meshVersion: number;
  geometryStyleKey: string;
}

interface PointLightVisual {
  light: PointLightObject;
}

interface ShadowResources {
  directionalFramebuffer: WebGLFramebuffer | null;
  directionalDepthTexture: WebGLTexture | null;
  directionalTransFramebuffer: WebGLFramebuffer | null;
  directionalTransDepthTexture: WebGLTexture | null;
  directionalTransColorTexture: WebGLTexture | null;
  pointFramebuffer: WebGLFramebuffer | null;
  pointTransFramebuffer: WebGLFramebuffer | null;
  pointDepthCubemaps: Array<WebGLTexture | null>;
  pointTransDepthCubemaps: Array<WebGLTexture | null>;
  pointTransColorCubemaps: Array<WebGLTexture | null>;
  size: number;
}

interface ActivePointShadowLight {
  light: PointLightObject;
  lightIndex: number;
  shadowSlot: number;
}

interface ActiveDirectionalShadowLight {
  light: DirectionalLightObject;
  lightIndex: number;
}

type TransparentSceneRenderItem =
  | { kind: 'plot'; plotSnapshot: RendererSceneSnapshot['plots'][number] }
  | { kind: 'point-light-gizmo'; light: PointLightObject };

interface RenderTargets {
  width: number;
  height: number;
  sceneFramebuffer: WebGLFramebuffer | null;
  sceneColor: WebGLTexture | null;
  sceneDepth: WebGLTexture | null;
  pointGizmoFramebuffer: WebGLFramebuffer | null;
  pointGizmoColor: WebGLTexture | null;
  pointGizmoDepth: WebGLRenderbuffer | null;
  pointGizmoSourceFramebuffer: WebGLFramebuffer | null;
  pointGizmoSourceColor: WebGLTexture | null;
  pointGizmoSourceDepth: WebGLRenderbuffer | null;
  bloomWidth: number;
  bloomHeight: number;
  bloomFramebufferA: WebGLFramebuffer | null;
  bloomTextureA: WebGLTexture | null;
  bloomFramebufferB: WebGLFramebuffer | null;
  bloomTextureB: WebGLTexture | null;
  refractionFramebuffer: WebGLFramebuffer | null;
  refractionTexture: WebGLTexture | null;
  maskFramebuffer: WebGLFramebuffer | null;
  maskTexture: WebGLTexture | null;
  maskDepth: WebGLTexture | null;
}

interface PointGizmoRenderBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  radius: number;
}

interface ProbeRenderResources {
  framebuffer: WebGLFramebuffer | null;
  depthRenderbuffer: WebGLRenderbuffer | null;
  size: number;
}

interface PlanarReflectionTargets {
  framebuffer: WebGLFramebuffer | null;
  colorTexture: WebGLTexture | null;
  depthRenderbuffer: WebGLRenderbuffer | null;
  width: number;
  height: number;
}

interface ProbeInstance {
  cubemap: WebGLTexture | null;
  center: vec3;
  sceneKey: string;
  lastRefreshFrame: number;
  lastUsedFrame: number;
  refreshCount: number;
}

interface ProbeUsage {
  refreshed: boolean;
  useProbe: boolean;
  texture: WebGLTexture | null;
  center: vec3;
}

interface SimpleMeshBuffer {
  vao: WebGLVertexArrayObject | null;
  indexBuffer: WebGLBuffer | null;
  indexCount: number;
}

interface AxisLabelResources {
  key: string;
  texture: WebGLTexture | null;
  vao: WebGLVertexArrayObject | null;
  vertexBuffer: WebGLBuffer | null;
  indexBuffer: WebGLBuffer | null;
  indexCount: number;
}

interface RenderPrograms {
  mesh: ProgramBundle;
  contour: ProgramBundle;
  shadow: ProgramBundle;
  pointGizmoSourceMask: ProgramBundle;
  transShadow: ProgramBundle;
  pointShadow: ProgramBundle;
  pointTransShadow: ProgramBundle;
  line: ProgramBundle;
  gizmo: ProgramBundle;
  mask: ProgramBundle;
  bloomExtract: ProgramBundle;
  bloomBlur: ProgramBundle;
  composite: ProgramBundle;
  outline: ProgramBundle;
  label: ProgramBundle;
}

interface ProgramBundle {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

interface ContourUniformState {
  xEnabled: boolean;
  xSpacing: number;
  xColor: string;
  yEnabled: boolean;
  ySpacing: number;
  yColor: string;
  zEnabled: boolean;
  zSpacing: number;
  zColor: string;
}

type DragState =
  | {
      objectId: string;
      mode: 'xy';
      startPosition: vec3;
      planeZ: number;
      startPoint: vec3;
    }
  | {
      objectId: string;
      mode: 'z';
      startPosition: vec3;
      fixedX: number;
      fixedY: number;
      zOffset: number;
      fallbackScale: number;
      startClientY: number;
    };

const MAX_POINT_LIGHTS = 4;
const MAX_DIRECTIONAL_LIGHTS = 4;
const MAX_POINT_SHADOW_LIGHTS = 3;
const PROBE_REFRESH_INTERVAL = 18;
const DEFAULT_PROBE_SIZE = 96;
const MAX_REFLECTION_PROBES = 4;
const PROBE_REFRESHES_PER_FRAME = 1;
const ENVIRONMENT_CUBEMAP_SIZE = 48;
const FULLSCREEN_TRIANGLE_VERTICES = new Float32Array([-1, -1, 3, -1, -1, 3]);
// Units 0-2: directional shadow maps, 3: environment, 4: probe,
// 5: refraction source, 6: planar ground reflection; point shadows start at 7.
const BASE_FRAGMENT_TEXTURE_UNITS = 7;
const REFRACTION_TEXTURE_UNIT = 5;
const PLANAR_REFLECTION_TEXTURE_UNIT = 6;
const POINT_SHADOW_TEXTURE_UNIT_BASE = BASE_FRAGMENT_TEXTURE_UNITS;
const POINT_SHADOW_TEXTURE_UNIT_STRIDE = 3;
const POINT_SHADOW_NEAR = 0.05;
const POINT_GIZMO_TARGET_SIZE = 36;
const POINT_GIZMO_MASK_COLOR = new Float32Array([1, 1, 1]);
const MAX_POINT_GIZMO_OVERLAY_EXCLUSIONS = 8;
const ZERO_PROBE_CENTER = vec3.fromValues(0, 0, 0);
const MAX_EXPORT_DIMENSION = 8192;
const DEFAULT_CAMERA_ALPHA = -Math.PI / 3;
const DEFAULT_CAMERA_BETA = 1.1;
const DEFAULT_CAMERA_RADIUS = 20;
const DEFAULT_CAMERA_TARGET = vec3.fromValues(0, 0, 1.5);

export function resolveOrbitUpVector(alpha: number, beta: number): readonly [number, number, number] {
  return [
    -Math.cos(alpha) * Math.cos(beta),
    -Math.sin(alpha) * Math.cos(beta),
    Math.sin(beta),
  ];
}

export function advanceTurntableAlpha(alpha: number, speedDegreesPerSecond: number, elapsedMs: number): number {
  if (![alpha, speedDegreesPerSecond, elapsedMs].every(Number.isFinite)) return alpha;
  const elapsedSeconds = clamp(elapsedMs / 1000, 0, 0.1);
  const next = alpha + speedDegreesPerSecond * (Math.PI / 180) * elapsedSeconds;
  return ((next + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

function curveGeometryStyleKey(plot: RenderableObject): string {
  if (plot.type === 'intersection') {
    return `${plot.curveStyle.renderAsTube ? 'tube' : 'line'}:${plot.curveStyle.tubeRadius}`;
  }
  if (plot.equation.kind === 'parametric_curve') {
    return `${plot.equation.renderAsTube ? 'tube' : 'line'}:${plot.equation.tubeRadius}`;
  }
  return '';
}

export function resolveViewPresetOrientation(preset: ViewPreset): {
  alpha: number;
  beta: number;
  upVector: readonly [number, number, number];
} {
  switch (preset) {
    case 'top':
      return { alpha: -Math.PI / 2, beta: 0, upVector: [0, 1, 0] };
    case 'front':
      return { alpha: -Math.PI / 2, beta: Math.PI / 2, upVector: [0, 0, 1] };
    case 'side':
      return { alpha: 0, beta: Math.PI / 2, upVector: [0, 0, 1] };
    case 'default':
      return { alpha: DEFAULT_CAMERA_ALPHA, beta: DEFAULT_CAMERA_BETA, upVector: [0, 0, 1] };
  }
}
const POINT_SHADOW_FACE_VECTORS: Array<{ target: vec3; up: vec3 }> = [
  { target: vec3.fromValues(1, 0, 0), up: vec3.fromValues(0, -1, 0) },
  { target: vec3.fromValues(-1, 0, 0), up: vec3.fromValues(0, -1, 0) },
  { target: vec3.fromValues(0, 1, 0), up: vec3.fromValues(0, 0, 1) },
  { target: vec3.fromValues(0, -1, 0), up: vec3.fromValues(0, 0, -1) },
  { target: vec3.fromValues(0, 0, 1), up: vec3.fromValues(0, -1, 0) },
  { target: vec3.fromValues(0, 0, -1), up: vec3.fromValues(0, -1, 0) },
];

export class SceneController {
  private gl: WebGL2RenderingContext | null = null;
  private supportsFloatColorBuffers = false;
  private maxFragmentTextureUnits = 0;
  private renderPrograms: RenderPrograms | null = null;
  private renderTargets: RenderTargets = emptyRenderTargets();
  private shadowResources: ShadowResources = emptyShadowResources();
  private probeRenderResources: ProbeRenderResources = emptyProbeRenderResources();
  private probePool = new Map<string, ProbeInstance>();
  private probeRefreshTotal = 0;
  private probeRefreshesThisFrame = 0;
  private frameIndex = 0;
  private planarReflection: PlanarReflectionTargets = emptyPlanarReflectionTargets();
  private planarReflectionReady = false;
  private orthographicProjection = false;
  private fullscreenVao: WebGLVertexArrayObject | null = null;
  private fullscreenBuffer: WebGLBuffer | null = null;
  private groundMesh: SimpleMeshBuffer | null = null;
  private axesLineBuffer: { key: string; buffer: GpuLineBuffer } | null = null;
  private gridLineBuffer: { key: string; buffer: GpuLineBuffer } | null = null;
  private gizmoPointBuffer: GpuLineBuffer | null = null;
  private directionalGizmoLineBuffer: GpuLineBuffer | null = null;
  private axisLabels: AxisLabelResources | null = null;
  private environmentCubemap: WebGLTexture | null = null;
  private environmentKey = '';
  private plotVisuals = new Map<string, PlotVisual>();
  private pointLightVisuals = new Map<string, PointLightVisual>();
  private latestSnapshot: RendererSceneSnapshot | null = null;
  private disposed = false;
  private animationFrame = 0;
  private pointerDownListener?: (event: PointerEvent) => void;
  private pointerMoveListener?: (event: PointerEvent) => void;
  private pointerUpListener?: (event: PointerEvent) => void;
  private wheelListener?: (event: WheelEvent) => void;
  private resizeListener?: () => void;
  private dragState: DragState | null = null;
  private cameraDrag: { mode: 'orbit' | 'pan'; pointerId: number; lastX: number; lastY: number } | null = null;
  private turntableTarget: vec3 | null = null;
  private recordingGif = false;
  private gifAbortController: AbortController | null = null;
  private gifEncoder: GifEncoderWorkerClient | null = null;
  private readonly gifSelection = new GifSelectionGuard();
  private lastFrameTime = 0;
  private frameTimeMs = 16.67;
  private fps = 60;
  private readonly camera = {
    alpha: DEFAULT_CAMERA_ALPHA,
    beta: DEFAULT_CAMERA_BETA,
    radius: DEFAULT_CAMERA_RADIUS,
    target: vec3.clone(DEFAULT_CAMERA_TARGET),
    upVector: vec3.fromValues(0, 0, 1),
    minZ: 0.05,
    maxZ: 400,
    fov: Math.PI / 4,
    mode: 0,
    lowerRadiusLimit: 1,
    upperRadiusLimit: 200,
  };
  private readonly viewMatrix = mat4.create();
  private readonly projectionMatrix = mat4.create();
  private readonly lightViewProjection = mat4.create();
  private readonly shadowViewMatrix = mat4.create();
  private readonly shadowProjectionMatrix = mat4.create();
  private readonly pointShadowViewMatrix = mat4.create();
  private readonly pointShadowProjectionMatrix = mat4.create();
  private readonly pointShadowViewProjection = mat4.create();
  private readonly probeViewMatrix = mat4.create();
  private readonly probeProjectionMatrix = mat4.create();
  private readonly emptyProbeCenter = vec3.fromValues(0, 0, 0);
  private environmentFacePixelCache = new Map<string, Uint8Array[]>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onObjectDragChange?: (dragging: boolean) => void,
  ) {}

  async init(): Promise<void> {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      depth: true,
      stencil: false,
      premultipliedAlpha: false,
    });
    if (!gl) {
      throw new Error('WebGL2 is not available in this browser');
    }
    this.supportsFloatColorBuffers = Boolean(gl.getExtension('EXT_color_buffer_float'));
    this.maxFragmentTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
    this.gl = gl;
    this.canvas.tabIndex = 0;
    this.canvas.style.outline = 'none';
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.renderPrograms = createPrograms(gl);
    this.createFullscreenResources(gl);
    this.attachInputHandlers();
    this.resizeViewport();
    this.animationFrame = window.requestAnimationFrame(this.renderFrame);
    useAppStore.getState().setRenderDiagnostics({
      backend: 'webgl2',
      webglReady: true,
    });
    if (!this.supportsFloatColorBuffers) {
      console.warn('WebGL2 float color buffers unavailable; using compatibility fallback');
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.dragState) {
      this.dragState = null;
      this.onObjectDragChange?.(false);
    }
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }
    if (this.pointerDownListener) {
      this.canvas.removeEventListener('pointerdown', this.pointerDownListener);
    }
    if (this.pointerMoveListener) {
      window.removeEventListener('pointermove', this.pointerMoveListener);
    }
    if (this.pointerUpListener) {
      window.removeEventListener('pointerup', this.pointerUpListener);
      window.removeEventListener('pointercancel', this.pointerUpListener);
    }
    if (this.wheelListener) {
      this.canvas.removeEventListener('wheel', this.wheelListener);
    }
    if (this.resizeListener) {
      window.removeEventListener('resize', this.resizeListener);
    }
    const gl = this.gl;
    if (gl) {
      for (const visual of this.plotVisuals.values()) {
        this.disposePlotBuffers(visual.buffers);
      }
      this.deleteRenderTargets(gl);
      this.deleteShadowResources(gl);
      this.deleteProbeResources(gl);
      this.deletePlanarReflectionTargets(gl);
      deleteTexture(gl, this.environmentCubemap);
      if (this.groundMesh) {
        deleteVertexArray(gl, this.groundMesh.vao);
        deleteBuffer(gl, this.groundMesh.indexBuffer);
      }
      if (this.axesLineBuffer) {
        deleteLineBuffer(gl, this.axesLineBuffer.buffer);
        this.axesLineBuffer = null;
      }
      if (this.gridLineBuffer) {
        deleteLineBuffer(gl, this.gridLineBuffer.buffer);
        this.gridLineBuffer = null;
      }
      deleteLineBuffer(gl, this.gizmoPointBuffer);
      this.gizmoPointBuffer = null;
      deleteLineBuffer(gl, this.directionalGizmoLineBuffer);
      this.directionalGizmoLineBuffer = null;
      this.deleteAxisLabelResources(gl);
      deleteBuffer(gl, this.fullscreenBuffer);
      deleteVertexArray(gl, this.fullscreenVao);
      if (this.renderPrograms) {
        deleteProgramBundle(gl, this.renderPrograms.mesh);
        deleteProgramBundle(gl, this.renderPrograms.contour);
        deleteProgramBundle(gl, this.renderPrograms.shadow);
        deleteProgramBundle(gl, this.renderPrograms.pointGizmoSourceMask);
        deleteProgramBundle(gl, this.renderPrograms.transShadow);
        deleteProgramBundle(gl, this.renderPrograms.pointShadow);
        deleteProgramBundle(gl, this.renderPrograms.pointTransShadow);
        deleteProgramBundle(gl, this.renderPrograms.line);
        deleteProgramBundle(gl, this.renderPrograms.gizmo);
        deleteProgramBundle(gl, this.renderPrograms.mask);
        deleteProgramBundle(gl, this.renderPrograms.bloomExtract);
        deleteProgramBundle(gl, this.renderPrograms.bloomBlur);
        deleteProgramBundle(gl, this.renderPrograms.composite);
        deleteProgramBundle(gl, this.renderPrograms.outline);
        deleteProgramBundle(gl, this.renderPrograms.label);
      }
    }
    this.plotVisuals.clear();
    this.pointLightVisuals.clear();
    this.gl = null;
    this.renderPrograms = null;
  }

  getApi(): ViewportApi {
    return {
      exportPng: async (filename = buildPngFileName(), scale = 1) => {
        const gl = this.gl;
        if (!gl) {
          throw new Error('Viewport not ready');
        }
        this.resizeViewport();
        const baseWidth = this.canvas.width;
        const baseHeight = this.canvas.height;
        const safeScale = Math.max(1, Math.min(scale, MAX_EXPORT_DIMENSION / Math.max(baseWidth, baseHeight)));
        try {
          if (safeScale > 1) {
            this.canvas.width = Math.round(baseWidth * safeScale);
            this.canvas.height = Math.round(baseHeight * safeScale);
            gl.viewport(0, 0, this.canvas.width, this.canvas.height);
          }
          this.renderScene();
          await exportCanvasPng(gl, this.canvas, this.latestSnapshot?.scene ?? useAppStore.getState().scene, filename);
        } finally {
          if (this.canvas.width !== baseWidth || this.canvas.height !== baseHeight) {
            this.canvas.width = baseWidth;
            this.canvas.height = baseHeight;
            gl.viewport(0, 0, baseWidth, baseHeight);
            this.renderScene();
          }
        }
      },
      recordTurntableGif: (onProgress) => this.recordTurntableLoop(onProgress),
      recordParameterGif: (plotId, parameterName, onProgress) => (
        this.recordParameterLoop(plotId, parameterName, onProgress)
      ),
      recordLightCurveGif: (lightId, onProgress) => this.recordLightCurveLoop(lightId, onProgress),
      cancelGifRecording: () => this.cancelGifRecording(),
      setViewPreset: (preset) => this.setViewPreset(preset),
      frameObject: (objectId) => this.frameObject(objectId ?? null),
    };
  }

  private cancelGifRecording(): boolean {
    if (!this.recordingGif) return false;
    this.gifAbortController?.abort();
    this.gifEncoder?.terminate();
    return true;
  }

  private beginGifRecording(encoder: GifEncoderWorkerClient): AbortController {
    const abortController = new AbortController();
    const state = useAppStore.getState();
    this.gifSelection.begin(state.selectedId);
    this.recordingGif = true;
    this.gifAbortController = abortController;
    this.gifEncoder = encoder;
    setAnimationGifRecording(true);
    if (state.selectedId !== null) {
      state.selectObject(null);
    }
    if (this.latestSnapshot) {
      this.latestSnapshot = { ...this.latestSnapshot, selectedId: null };
    }
    return abortController;
  }

  private endGifRecording(abortController: AbortController): void {
    if (this.gifAbortController !== abortController) return;
    this.gifAbortController = null;
    this.gifEncoder = null;
    this.recordingGif = false;
    setAnimationGifRecording(false);
    const state = useAppStore.getState();
    const selectedId = this.gifSelection.finish(new Set(state.objects.map((object) => object.id)));
    if (state.selectedId !== selectedId) {
      state.selectObject(selectedId);
    }
    if (this.latestSnapshot) {
      this.latestSnapshot = { ...this.latestSnapshot, selectedId };
    }
  }

  private async recordTurntableLoop(onProgress?: (progress: number) => void): Promise<void> {
    if (this.recordingGif) {
      throw new Error('An animation loop is already being recorded');
    }
    const gl = this.gl;
    const snapshot = this.latestSnapshot;
    if (!gl || !snapshot) {
      throw new Error('Viewport not ready');
    }
    const { scene, render } = snapshot;
    if (!scene.turntableEnabled) {
      throw new Error('Start the turntable animation before recording a loop');
    }

    const baseWidth = this.canvas.width;
    const baseHeight = this.canvas.height;
    const dimensions = resolveTurntableGifDimensions(baseWidth, baseHeight, render.gifMaxDimension);
    const timing = resolveTurntableGifTiming(scene.turntableSpeed, render.gifFrameRate);
    const savedCamera = {
      alpha: this.camera.alpha,
      beta: this.camera.beta,
      radius: this.camera.radius,
      target: vec3.clone(this.camera.target),
      upVector: vec3.clone(this.camera.upVector),
    };
    const encoder = new GifEncoderWorkerClient();
    const abortController = this.beginGifRecording(encoder);
    const { signal } = abortController;

    try {
      onProgress?.(0);
      throwIfGifRecordingCancelled(signal);
      this.canvas.width = dimensions.width;
      this.canvas.height = dimensions.height;
      gl.viewport(0, 0, dimensions.width, dimensions.height);
      const captureSurface = createCanvasFrameCaptureSurface(dimensions.width, dimensions.height);
      await encoder.start(dimensions.width, dimensions.height, timing.frameDelayMs);

      for (let frame = 0; frame < timing.frameCount; frame += 1) {
        throwIfGifRecordingCancelled(signal);
        this.camera.alpha = savedCamera.alpha + timing.angleStepRadians * frame;
        this.camera.beta = savedCamera.beta;
        this.camera.radius = savedCamera.radius;
        vec3.copy(this.camera.target, savedCamera.target);
        vec3.set(this.camera.upVector, ...resolveOrbitUpVector(this.camera.alpha, this.camera.beta));
        this.updateCameraMatrices();
        this.renderScene();
        const pixels = captureCanvasRgba(gl, scene, captureSurface);
        await encoder.addFrame(pixels);
        throwIfGifRecordingCancelled(signal);
        onProgress?.(((frame + 1) / timing.frameCount) * 0.98);
      }

      const bytes = await encoder.finish();
      throwIfGifRecordingCancelled(signal);
      downloadBlobFile(new Blob([bytes], { type: 'image/gif' }), buildGifFileName());
      onProgress?.(1);
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      encoder.terminate();
      this.camera.alpha = savedCamera.alpha;
      this.camera.beta = savedCamera.beta;
      this.camera.radius = savedCamera.radius;
      vec3.copy(this.camera.target, savedCamera.target);
      vec3.copy(this.camera.upVector, savedCamera.upVector);
      this.canvas.width = baseWidth;
      this.canvas.height = baseHeight;
      gl.viewport(0, 0, baseWidth, baseHeight);
      this.endGifRecording(abortController);
      this.resizeViewport();
      this.updateCameraMatrices();
      this.renderScene();
    }
  }

  private async recordParameterLoop(
    plotId: string,
    parameterName: string,
    onProgress?: (progress: number) => void,
  ): Promise<void> {
    if (this.recordingGif) {
      throw new Error('An animation loop is already being recorded');
    }
    const gl = this.gl;
    const initialState = useAppStore.getState();
    const plot = initialState.objects.find(
      (object): object is PlotObject => object.id === plotId && object.type === 'plot',
    );
    const parameter = plot?.equation.parameters.find((candidate) => candidate.name === parameterName);
    if (!gl || !this.latestSnapshot) {
      throw new Error('Viewport not ready');
    }
    if (!plot || !parameter || parameter.samplingMode !== 'continuous' || !parameter.animating) {
      throw new Error('Start the continuous parameter animation before exporting its loop');
    }
    if (plot.equation.source.parseStatus !== 'ok') {
      throw new Error('The animated equation must be valid before exporting its loop');
    }
    if (!Number.isFinite(parameter.min) || !Number.isFinite(parameter.max) || parameter.max <= parameter.min) {
      throw new Error('The animated parameter needs a valid min and max range');
    }

    const baseWidth = this.canvas.width;
    const baseHeight = this.canvas.height;
    const dimensions = resolveTurntableGifDimensions(
      baseWidth,
      baseHeight,
      initialState.render.gifMaxDimension,
    );
    const timing = resolveParameterGifTiming(
      parameter.animationSpeed,
      initialState.render.gifFrameRate,
    );
    const savedValue = parameter.value;
    const animatedParameters = collectAnimatingContinuousParameters(initialState);
    const encoder = new GifEncoderWorkerClient();
    const abortController = this.beginGifRecording(encoder);
    const { signal } = abortController;

    try {
      onProgress?.(0);
      for (const entry of animatedParameters) {
        useAppStore.getState().setParameterAnimation(entry.plotId, entry.parameterName, { animating: false });
      }

      this.canvas.width = dimensions.width;
      this.canvas.height = dimensions.height;
      gl.viewport(0, 0, dimensions.width, dimensions.height);
      const captureSurface = createCanvasFrameCaptureSurface(dimensions.width, dimensions.height);
      await encoder.start(dimensions.width, dimensions.height, timing.frameDelayMs);
      await yieldForWorkerPipeline();
      throwIfGifRecordingCancelled(signal);
      await waitForFullDetailMeshes(new Map(), signal);

      for (let frame = 0; frame < timing.frameCount; frame += 1) {
        throwIfGifRecordingCancelled(signal);
        const stateBeforeUpdate = useAppStore.getState();
        const value = parameterValueForGifFrame(parameter.min, parameter.max, frame, timing.frameCount);
        const currentPlot = stateBeforeUpdate.objects.find(
          (object): object is PlotObject => object.id === plotId && object.type === 'plot',
        );
        const currentValue = currentPlot?.equation.parameters.find(
          (candidate) => candidate.name === parameterName,
        )?.value;
        if (currentValue !== value) {
          const affectedIds = affectedFullDetailIds(stateBeforeUpdate, new Set([plotId]));
          const baselines = captureMeshVersionBaselines(stateBeforeUpdate, affectedIds);
          stateBeforeUpdate.applyParameterAnimationValues([{ plotId, parameterName, value }]);
          await waitForFullDetailMeshScheduling(baselines, signal);
          await waitForFullDetailMeshes(baselines, signal);
        }
        throwIfGifRecordingCancelled(signal);
        if (this.disposed || !this.gl) {
          throw new Error('Viewport was closed while exporting the parameter loop');
        }

        const frameState = useAppStore.getState();
        this.sync({
          scene: frameState.scene,
          render: frameState.render,
          objects: frameState.objects,
          selectedId: frameState.selectedId,
          plotJobs: frameState.plotJobs,
        });
        this.updateCameraMatrices();
        this.renderScene();
        const pixels = captureCanvasRgba(gl, frameState.scene, captureSurface);
        await encoder.addFrame(pixels);
        throwIfGifRecordingCancelled(signal);
        onProgress?.(((frame + 1) / timing.frameCount) * 0.98);
      }

      const bytes = await encoder.finish();
      throwIfGifRecordingCancelled(signal);
      downloadBlobFile(
        new Blob([bytes], { type: 'image/gif' }),
        buildParameterGifFileName(parameterName),
      );
      onProgress?.(1);
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      encoder.terminate();
      useAppStore.getState().applyParameterAnimationValues([{ plotId, parameterName, value: savedValue }]);
      for (const entry of animatedParameters) {
        useAppStore.getState().setParameterAnimation(entry.plotId, entry.parameterName, { animating: true });
      }
      this.canvas.width = baseWidth;
      this.canvas.height = baseHeight;
      gl.viewport(0, 0, baseWidth, baseHeight);
      this.endGifRecording(abortController);
      this.resizeViewport();
      const restoredState = useAppStore.getState();
      this.sync({
        scene: restoredState.scene,
        render: restoredState.render,
        objects: restoredState.objects,
        selectedId: restoredState.selectedId,
        plotJobs: restoredState.plotJobs,
      });
      this.updateCameraMatrices();
      this.renderScene();
    }
  }

  private async recordLightCurveLoop(
    lightId: string,
    onProgress?: (progress: number) => void,
  ): Promise<void> {
    if (this.recordingGif) {
      throw new Error('An animation loop is already being recorded');
    }
    const gl = this.gl;
    const initialState = useAppStore.getState();
    const light = initialState.objects.find(
      (object): object is LightObject => object.id === lightId
        && (object.type === 'point_light' || object.type === 'directional_light'),
    );
    const curve = light ? pinnedCurveForLight(light, initialState.objects) : null;
    const bounds = curve ? curveParameterBounds(curve) : null;
    if (!gl || !this.latestSnapshot) {
      throw new Error('Viewport not ready');
    }
    if (!light || !curve || !bounds || !light.curvePin.animating) {
      throw new Error('Start the pinned light animation before exporting its loop');
    }
    if (curve.equation.source.parseStatus !== 'ok') {
      throw new Error('The pinned parameterized curve must be valid before exporting its loop');
    }

    const mode = curveTraversalMode(curve);
    const timing = resolveRangeGifTiming(
      light.curvePin.animationSpeed,
      mode,
      initialState.render.gifFrameRate,
    );
    const savedValue = light.curvePin.parameterValue;
    const baseWidth = this.canvas.width;
    const baseHeight = this.canvas.height;
    const dimensions = resolveTurntableGifDimensions(
      baseWidth,
      baseHeight,
      initialState.render.gifMaxDimension,
    );
    const encoder = new GifEncoderWorkerClient();
    const abortController = this.beginGifRecording(encoder);
    const { signal } = abortController;

    try {
      onProgress?.(0);
      this.canvas.width = dimensions.width;
      this.canvas.height = dimensions.height;
      gl.viewport(0, 0, dimensions.width, dimensions.height);
      const captureSurface = createCanvasFrameCaptureSurface(dimensions.width, dimensions.height);
      await encoder.start(dimensions.width, dimensions.height, timing.frameDelayMs);
      await yieldForWorkerPipeline();
      throwIfGifRecordingCancelled(signal);
      await waitForFullDetailMeshes(new Map(), signal);

      for (let frame = 0; frame < timing.frameCount; frame += 1) {
        throwIfGifRecordingCancelled(signal);
        const parameterValue = rangeValueForGifFrame(
          bounds.min,
          bounds.max,
          frame,
          timing.frameCount,
          mode,
        );
        useAppStore.getState().applyLightCurveAnimationValues([{ lightId, parameterValue }]);
        if (this.disposed || !this.gl) {
          throw new Error('Viewport was closed while exporting the light loop');
        }
        const frameState = useAppStore.getState();
        const currentLight = frameState.objects.find((object) => object.id === lightId);
        if (!currentLight || (currentLight.type !== 'point_light' && currentLight.type !== 'directional_light')) {
          throw new Error('The pinned light became unavailable while exporting its loop');
        }
        this.sync({
          scene: frameState.scene,
          render: frameState.render,
          objects: frameState.objects,
          selectedId: frameState.selectedId,
          plotJobs: frameState.plotJobs,
        });
        this.updateCameraMatrices();
        this.renderScene();
        const pixels = captureCanvasRgba(gl, frameState.scene, captureSurface);
        await encoder.addFrame(pixels);
        throwIfGifRecordingCancelled(signal);
        onProgress?.(((frame + 1) / timing.frameCount) * 0.98);
      }

      const bytes = await encoder.finish();
      throwIfGifRecordingCancelled(signal);
      downloadBlobFile(
        new Blob([bytes], { type: 'image/gif' }),
        buildLightCurveGifFileName(light.name),
      );
      onProgress?.(1);
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      encoder.terminate();
      useAppStore.getState().applyLightCurveAnimationValues([{ lightId, parameterValue: savedValue }]);
      this.canvas.width = baseWidth;
      this.canvas.height = baseHeight;
      gl.viewport(0, 0, baseWidth, baseHeight);
      this.endGifRecording(abortController);
      this.resizeViewport();
      const restoredState = useAppStore.getState();
      this.sync({
        scene: restoredState.scene,
        render: restoredState.render,
        objects: restoredState.objects,
        selectedId: restoredState.selectedId,
        plotJobs: restoredState.plotJobs,
      });
      this.updateCameraMatrices();
      this.renderScene();
    }
  }

  setViewPreset(preset: ViewPreset): void {
    const orientation = resolveViewPresetOrientation(preset);
    this.camera.alpha = orientation.alpha;
    this.camera.beta = orientation.beta;
    vec3.set(this.camera.upVector, ...orientation.upVector);
    if (preset === 'default') {
      this.camera.radius = DEFAULT_CAMERA_RADIUS;
      vec3.copy(this.camera.target, DEFAULT_CAMERA_TARGET);
    }
    // Axis views keep the current target and distance so the subject stays framed.
  }

  frameObject(objectId: string | null): void {
    const snapshot = this.latestSnapshot;
    if (!snapshot) {
      return;
    }
    const targetId = objectId ?? snapshot.selectedId;
    let framed = targetId ? this.computeObjectBounds(targetId) : null;
    framed ??= this.computeVisiblePlotsBounds();
    if (!framed) {
      return;
    }
    vec3.copy(this.camera.target, framed.center);
    const fitRadius = Math.max(0.75, framed.radius) * 1.35;
    this.camera.radius = clamp(
      fitRadius / Math.sin(this.camera.fov / 2),
      this.camera.lowerRadiusLimit,
      this.camera.upperRadiusLimit,
    );
  }

  private computeObjectBounds(objectId: string): { center: vec3; radius: number } | null {
    const object = this.latestSnapshot?.objects.find((candidate) => candidate.id === objectId);
    if (!object) {
      return null;
    }
    if (object.type === 'point_light') {
      return {
        center: vec3.fromValues(object.position.x, object.position.y, object.position.z),
        radius: 2,
      };
    }
    if (object.type === 'directional_light') {
      const { tail, tip, length } = directionalLightGizmoEndpoints(object, this.camera.radius);
      return {
        center: vec3.lerp(vec3.create(), tail, tip, 0.5),
        radius: Math.max(1, length * 0.65),
      };
    }
    const visual = this.plotVisuals.get(objectId);
    if (!visual) {
      return null;
    }
    const bounds = visual.geometry.bounds;
    return {
      center: vec3.fromValues(
        bounds.center.x + object.transform.position.x,
        bounds.center.y + object.transform.position.y,
        bounds.center.z + object.transform.position.z,
      ),
      radius: Math.max(0.001, bounds.radius),
    };
  }

  private computeVisiblePlotsBounds(): { center: vec3; radius: number } | null {
    const snapshot = this.latestSnapshot;
    if (!snapshot) {
      return null;
    }
    const min = vec3.fromValues(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    const max = vec3.fromValues(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
    let found = false;
    for (const plotSnapshot of snapshot.plots) {
      const plot = plotSnapshot.plot;
      if (!plot.visible) {
        continue;
      }
      const visual = this.plotVisuals.get(plot.id);
      if (!visual) {
        continue;
      }
      const bounds = visual.geometry.bounds;
      const offset = plot.transform.position;
      min[0] = Math.min(min[0], bounds.min.x + offset.x);
      min[1] = Math.min(min[1], bounds.min.y + offset.y);
      min[2] = Math.min(min[2], bounds.min.z + offset.z);
      max[0] = Math.max(max[0], bounds.max.x + offset.x);
      max[1] = Math.max(max[1], bounds.max.y + offset.y);
      max[2] = Math.max(max[2], bounds.max.z + offset.z);
      found = true;
    }
    if (!found) {
      return null;
    }
    const center = vec3.fromValues((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    const radius = vec3.distance(center, max);
    return { center, radius: Math.max(0.001, radius) };
  }

  resizeViewport(): void {
    const gl = this.gl;
    // Recording deliberately renders into a smaller backing store. Clearing the
    // selection can also change the surrounding layout and queue a resize, so
    // leave the capture dimensions untouched until the recording is complete.
    if (!gl || this.recordingGif) {
      return;
    }
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * window.devicePixelRatio));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * window.devicePixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    this.ensureRenderTargets(width, height);
  }

  sync(state: Pick<AppState, 'scene' | 'render' | 'objects' | 'selectedId' | 'plotJobs'>): void {
    if (!this.gl) {
      return;
    }
    this.orthographicProjection = state.scene.cameraProjection === 'orthographic';
    const snapshot = createRendererSceneSnapshot({
      ...state,
      selectedId: this.gifSelection.selectedIdForRender(state.selectedId),
    }, this.getCameraSnapshot());
    this.latestSnapshot = snapshot;
    this.syncBackground(snapshot);
    this.syncPointLights(snapshot.objects);
    this.syncPlots(snapshot);
  }

  private readonly renderFrame = (timestamp: number) => {
    if (this.disposed || !this.gl || !this.renderPrograms) {
      return;
    }
    const elapsedMs = this.lastFrameTime > 0 ? Math.max(1, timestamp - this.lastFrameTime) : 0;
    if (elapsedMs > 0) {
      this.frameTimeMs = this.frameTimeMs * 0.85 + elapsedMs * 0.15;
      this.fps = this.fps * 0.85 + (1000 / elapsedMs) * 0.15;
    }
    this.lastFrameTime = timestamp;

    this.updateTurntableCamera(elapsedMs);
    this.updateCameraMatrices();
    this.renderScene();
    this.animationFrame = window.requestAnimationFrame(this.renderFrame);
  };

  private updateTurntableCamera(elapsedMs: number): void {
    const scene = this.latestSnapshot?.scene;
    if (!scene?.turntableEnabled || this.recordingGif) {
      this.turntableTarget = null;
      return;
    }
    this.turntableTarget ??= vec3.clone(this.camera.target);
    vec3.copy(this.camera.target, this.turntableTarget);
    this.camera.alpha = advanceTurntableAlpha(this.camera.alpha, scene.turntableSpeed, elapsedMs);
    vec3.set(this.camera.upVector, ...resolveOrbitUpVector(this.camera.alpha, this.camera.beta));
  }

  private renderScene(): void {
    const gl = this.gl!;
    const snapshot = this.latestSnapshot;
    const programs = this.renderPrograms!;
    if (!snapshot) {
      clearDefaultFramebuffer(gl, [0, 0, 0, 0]);
      return;
    }
    this.ensureRenderTargets(this.canvas.width, this.canvas.height);
    this.ensureShadowResources(snapshot.scene.shadow.shadowMapResolution);
    this.ensureEnvironmentCubemap(snapshot);
    this.frameIndex += 1;
    this.probeRefreshesThisFrame = 0;
    this.pruneProbePool(snapshot);
    const pointLights = this.collectRenderablePointLights(snapshot);
    const pointShadowLights = this.collectActivePointShadowLights(snapshot, pointLights);
    this.renderDirectionalShadowMaps(snapshot);
    this.renderPointShadowMaps(snapshot, pointShadowLights);
    this.renderPlanarReflection(snapshot, pointLights);
    this.renderOpaqueScene(snapshot, pointLights, pointShadowLights);
    this.renderTransparentScene(snapshot, pointLights, pointShadowLights);
    this.renderSceneAxes(snapshot);
    this.renderAxisLabels(snapshot);
    this.renderBloom(snapshot);
    this.compositeScene(snapshot);
    this.renderTransparentContourOverlays(snapshot);
    this.renderSelectionMask(snapshot);
    this.renderSelectionOutline(snapshot);
    this.renderSelectedFeatureEdges(snapshot);
    this.renderOverlayLines(snapshot);
    this.renderDirectionalLightGizmos(snapshot, programs.gizmo);
    this.syncRenderDiagnostics(snapshot, pointShadowLights);
  }

  private renderAxisLabels(snapshot: RendererSceneSnapshot): void {
    const scene = snapshot.scene;
    if (!scene.axesVisible || !scene.axisLabelsVisible) {
      return;
    }
    const gl = this.gl!;
    this.ensureAxisLabelResources(scene.axesLength);
    const labels = this.axisLabels;
    if (!labels?.vao || !labels.texture || labels.indexCount === 0) {
      return;
    }
    const program = this.renderPrograms!.label;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.renderTargets.sceneFramebuffer);
    gl.viewport(0, 0, this.renderTargets.width, this.renderTargets.height);
    gl.useProgram(program.program);
    gl.uniformMatrix4fv(program.uniforms.u_view, false, this.viewMatrix);
    gl.uniformMatrix4fv(program.uniforms.u_projection, false, this.projectionMatrix);
    gl.uniform2f(program.uniforms.u_viewport, Math.max(1, this.canvas.width), Math.max(1, this.canvas.height));
    // Keep on-screen label size during high-resolution PNG exports, where the
    // backing store is temporarily larger than the CSS pixel size.
    const nativeWidth = Math.max(1, Math.floor(this.canvas.clientWidth * window.devicePixelRatio));
    gl.uniform1f(program.uniforms.u_labelScale, Math.max(1, this.canvas.width / nativeWidth));
    bindTexture(gl, labels.texture, 0, gl.TEXTURE_2D);
    gl.uniform1i(program.uniforms.u_atlas, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(labels.vao);
    gl.drawElements(gl.TRIANGLES, labels.indexCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
  }

  private ensureAxisLabelResources(axesLength: number): void {
    const gl = this.gl!;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const key = `${axesLength}|${Math.round(dpr * 100)}`;
    if (this.axisLabels?.key === key) {
      return;
    }
    this.deleteAxisLabelResources(gl);
    const built = buildAxisLabelAtlas(axesLength, dpr);
    if (!built) {
      return;
    }
    const texture = gl.createTexture();
    const vao = gl.createVertexArray();
    const vertexBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();
    if (!texture || !vao || !vertexBuffer || !indexBuffer) {
      deleteTexture(gl, texture);
      deleteVertexArray(gl, vao);
      deleteBuffer(gl, vertexBuffer);
      deleteBuffer(gl, indexBuffer);
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, built.atlas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, built.vertices, gl.STATIC_DRAW);
    const stride = 7 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 5 * 4);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, built.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.axisLabels = {
      key,
      texture,
      vao,
      vertexBuffer,
      indexBuffer,
      indexCount: built.indices.length,
    };
  }

  private deleteAxisLabelResources(gl: WebGL2RenderingContext): void {
    if (!this.axisLabels) {
      return;
    }
    deleteTexture(gl, this.axisLabels.texture);
    deleteVertexArray(gl, this.axisLabels.vao);
    deleteBuffer(gl, this.axisLabels.vertexBuffer);
    deleteBuffer(gl, this.axisLabels.indexBuffer);
    this.axisLabels = null;
  }

  private syncBackground(snapshot: RendererSceneSnapshot): void {
    const scene = snapshot.scene;
    this.canvas.style.background = scene.backgroundMode === 'solid'
      ? scene.backgroundColor
      : `linear-gradient(${scene.gradientTopColor}, ${scene.gradientBottomColor})`;
  }

  private syncPointLights(objects: ReadonlyArray<SceneObject>): void {
    this.pointLightVisuals.clear();
    for (const object of objects) {
      if (object.type === 'point_light') {
        this.pointLightVisuals.set(object.id, { light: object });
      }
    }
  }

  private collectRenderablePointLights(snapshot: RendererSceneSnapshot): PointLightObject[] {
    return snapshot.pointLights
      .map((entry) => entry.light)
      .filter((light) => shouldPointLightContribute(light))
      .slice(0, MAX_POINT_LIGHTS);
  }

  private collectRenderableDirectionalLights(snapshot: RendererSceneSnapshot): DirectionalLightObject[] {
    return snapshot.directionalLights
      .map(({ light }) => light)
      .filter((light) => Number.isFinite(light.intensity) && light.intensity > 0)
      .slice(0, MAX_DIRECTIONAL_LIGHTS);
  }

  private collectActivePointShadowLights(
    _snapshot: RendererSceneSnapshot,
    pointLights: ReadonlyArray<PointLightObject>,
  ): ActivePointShadowLight[] {
    const supportedShadowLights = Math.min(MAX_POINT_SHADOW_LIGHTS, this.supportedPointShadowLightCount());
    if (supportedShadowLights <= 0) {
      return [];
    }
    const activeLights: ActivePointShadowLight[] = [];
    for (let index = 0; index < pointLights.length; index += 1) {
      const light = pointLights[index];
      if (!light.castShadows) {
        continue;
      }
      activeLights.push({
        light,
        lightIndex: index,
        shadowSlot: activeLights.length,
      });
      if (activeLights.length >= supportedShadowLights) {
        break;
      }
    }
    return activeLights;
  }

  private supportedPointShadowLightCount(): number {
    const availableUnits = Math.max(0, this.maxFragmentTextureUnits - BASE_FRAGMENT_TEXTURE_UNITS);
    return Math.max(0, Math.min(MAX_POINT_SHADOW_LIGHTS, Math.floor(availableUnits / POINT_SHADOW_TEXTURE_UNIT_STRIDE)));
  }

  private activeDirectionalShadowLight(snapshot: RendererSceneSnapshot): ActiveDirectionalShadowLight | null {
    const lights = this.collectRenderableDirectionalLights(snapshot);
    const lightIndex = lights.findIndex((light) => light.castShadows);
    return lightIndex === -1 ? null : { light: lights[lightIndex], lightIndex };
  }

  private directionalShadowsEnabled(snapshot: RendererSceneSnapshot): boolean {
    return this.activeDirectionalShadowLight(snapshot) !== null;
  }

  private syncPlots(snapshot: RendererSceneSnapshot): void {
    const seen = new Set<string>();
    for (const plotSnapshot of snapshot.plots) {
      const { plot, meshVersion } = plotSnapshot;
      const geometryStyleKey = curveGeometryStyleKey(plot);
      seen.add(plot.id);
      const existing = this.plotVisuals.get(plot.id);
      if (!existing || existing.meshVersion !== meshVersion || existing.geometryStyleKey !== geometryStyleKey) {
        if (existing) {
          this.disposePlotBuffers(existing.buffers);
        }
        const geometry = buildPlotGeometry(plot);
        const buffers = this.createPlotBuffers(geometry);
        this.plotVisuals.set(plot.id, {
          plotId: plot.id,
          geometry,
          buffers,
          meshVersion,
          geometryStyleKey,
        });
      }
    }
    for (const [plotId, visual] of this.plotVisuals.entries()) {
      if (!seen.has(plotId)) {
        this.disposePlotBuffers(visual.buffers);
        this.plotVisuals.delete(plotId);
      }
    }
  }

  private createPlotBuffers(geometry: PlotGeometry): GpuMeshBuffers {
    const gl = this.gl!;
    const vao = gl.createVertexArray();
    const positionBuffer = gl.createBuffer();
    const normalBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();
    if (!vao || !positionBuffer || !normalBuffer || !indexBuffer) {
      throw new Error('Failed to allocate mesh buffers');
    }
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    gl.deleteBuffer(positionBuffer);
    gl.deleteBuffer(normalBuffer);
    return {
      vao,
      indexBuffer,
      indexCount: geometry.indices.length,
      boundaryLines: createLineBuffer(gl, geometry.boundaryEdges, gl.LINES),
      featureLines: createLineBuffer(gl, geometry.featureEdges, gl.LINES),
      wireLines: geometry.wireLines.map((line) => createLineBuffer(gl, line, gl.LINE_STRIP)).filter((line): line is GpuLineBuffer => !!line),
    };
  }

  private disposePlotBuffers(buffers: GpuMeshBuffers): void {
    const gl = this.gl;
    if (!gl) {
      return;
    }
    deleteVertexArray(gl, buffers.vao);
    deleteBuffer(gl, buffers.indexBuffer);
    deleteLineBuffer(gl, buffers.boundaryLines);
    deleteLineBuffer(gl, buffers.featureLines);
    buffers.wireLines.forEach((line) => deleteLineBuffer(gl, line));
  }

  private renderDirectionalShadowMaps(snapshot: RendererSceneSnapshot): void {
    const gl = this.gl!;
    const scene = snapshot.scene;
    const activeShadowLight = this.activeDirectionalShadowLight(snapshot);
    if (!activeShadowLight) {
      return;
    }
    const shadow = this.shadowResources;
    const shadowSize = shadow.size;
    const lightDirection = normalizeVec3(activeShadowLight.light.direction, { x: -0.6, y: -0.4, z: -1 });
    const cameraTarget = this.camera.target;
    const lightDistance = 24;
    const lightPosition = vec3.fromValues(
      cameraTarget[0] - lightDirection.x * lightDistance,
      cameraTarget[1] - lightDirection.y * lightDistance,
      cameraTarget[2] - lightDirection.z * lightDistance,
    );
    mat4.lookAt(this.shadowViewMatrix, lightPosition, cameraTarget, vec3.fromValues(0, 0, 1));
    const frustumSize = resolveDirectionalShadowFrustumSize(scene);
    mat4.ortho(
      this.shadowProjectionMatrix,
      -frustumSize,
      frustumSize,
      -frustumSize,
      frustumSize,
      0.1,
      Math.max(60, frustumSize * 4),
    );
    mat4.multiply(this.lightViewProjection, this.shadowProjectionMatrix, this.shadowViewMatrix);

    gl.viewport(0, 0, shadowSize, shadowSize);
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadow.directionalFramebuffer);
    gl.colorMask(false, false, false, false);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.renderPrograms!.shadow.program);
    for (const plotSnapshot of snapshot.plots) {
      if (classifyInteractiveShadowMode(plotSnapshot.plot) === 'none') {
        continue;
      }
      const opacity = clamp01(plotSnapshot.plot.material.opacity);
      if (opacity < 0.999) {
        continue;
      }
      this.drawShadowMeshWithMatrix(plotSnapshot.plot, this.renderPrograms!.shadow, this.lightViewProjection);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, shadow.directionalTransFramebuffer);
    gl.colorMask(true, true, true, true);
    gl.clearColor(1, 1, 1, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.renderPrograms!.transShadow.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ZERO, gl.SRC_COLOR);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.CULL_FACE);
    for (const plotSnapshot of snapshot.plots) {
      const opacity = clamp01(plotSnapshot.plot.material.opacity);
      if (opacity >= 0.999 || !plotSnapshot.plot.visible || !plotSnapshot.plot.castShadows) {
        continue;
      }
      this.drawTransparentShadowMeshWithMatrix(plotSnapshot.plot, this.renderPrograms!.transShadow, this.lightViewProjection);
    }
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  private renderPointShadowMaps(
    snapshot: RendererSceneSnapshot,
    pointShadowLights: ReadonlyArray<ActivePointShadowLight>,
  ): void {
    const gl = this.gl!;
    const shadow = this.shadowResources;
    if (pointShadowLights.length === 0 || !shadow.pointFramebuffer || !shadow.pointTransFramebuffer) {
      return;
    }

    gl.viewport(0, 0, shadow.size, shadow.size);
    gl.disable(gl.CULL_FACE);
    for (const activeLight of pointShadowLights) {
      const shadowRange = Math.max(activeLight.light.range, POINT_SHADOW_NEAR + 0.01);
      const lightPosition = vec3.fromValues(
        activeLight.light.position.x,
        activeLight.light.position.y,
        activeLight.light.position.z,
      );
      mat4.perspective(this.pointShadowProjectionMatrix, Math.PI / 2, 1, POINT_SHADOW_NEAR, shadowRange);

      gl.useProgram(this.renderPrograms!.pointShadow.program);
      gl.uniform3f(
        this.renderPrograms!.pointShadow.uniforms.u_lightPosition,
        activeLight.light.position.x,
        activeLight.light.position.y,
        activeLight.light.position.z,
      );
      gl.uniform1f(this.renderPrograms!.pointShadow.uniforms.u_lightFar, shadowRange);
      gl.colorMask(false, false, false, false);

      for (let face = 0; face < POINT_SHADOW_FACE_VECTORS.length; face += 1) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, shadow.pointFramebuffer);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.DEPTH_ATTACHMENT,
          gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
          shadow.pointDepthCubemaps[activeLight.shadowSlot],
          0,
        );
        gl.drawBuffers([gl.NONE]);
        gl.clearDepth(1);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        const faceTarget = vec3.add(vec3.create(), lightPosition, POINT_SHADOW_FACE_VECTORS[face].target);
        mat4.lookAt(this.pointShadowViewMatrix, lightPosition, faceTarget, POINT_SHADOW_FACE_VECTORS[face].up);
        mat4.multiply(this.pointShadowViewProjection, this.pointShadowProjectionMatrix, this.pointShadowViewMatrix);
        for (const plotSnapshot of snapshot.plots) {
          if (classifyInteractiveShadowMode(plotSnapshot.plot) !== 'solid') {
            continue;
          }
          this.drawPointShadowMesh(
            plotSnapshot.plot,
            this.renderPrograms!.pointShadow,
            this.pointShadowViewProjection,
            activeLight.light,
            shadowRange,
          );
        }
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, shadow.pointTransFramebuffer);
      gl.useProgram(this.renderPrograms!.pointTransShadow.program);
      gl.uniform3f(
        this.renderPrograms!.pointTransShadow.uniforms.u_lightPosition,
        activeLight.light.position.x,
        activeLight.light.position.y,
        activeLight.light.position.z,
      );
      gl.uniform1f(this.renderPrograms!.pointTransShadow.uniforms.u_lightFar, shadowRange);
      gl.colorMask(true, true, true, true);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ZERO, gl.SRC_COLOR);
      gl.blendEquation(gl.FUNC_ADD);

      for (let face = 0; face < POINT_SHADOW_FACE_VECTORS.length; face += 1) {
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
          shadow.pointTransColorCubemaps[activeLight.shadowSlot],
          0,
        );
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.DEPTH_ATTACHMENT,
          gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
          shadow.pointTransDepthCubemaps[activeLight.shadowSlot],
          0,
        );
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        gl.clearColor(1, 1, 1, 1);
        gl.clearDepth(1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        const faceTarget = vec3.add(vec3.create(), lightPosition, POINT_SHADOW_FACE_VECTORS[face].target);
        mat4.lookAt(this.pointShadowViewMatrix, lightPosition, faceTarget, POINT_SHADOW_FACE_VECTORS[face].up);
        mat4.multiply(this.pointShadowViewProjection, this.pointShadowProjectionMatrix, this.pointShadowViewMatrix);
        for (const plotSnapshot of snapshot.plots) {
          if (classifyInteractiveShadowMode(plotSnapshot.plot) !== 'attenuated') {
            continue;
          }
          this.drawPointTransparentShadowMesh(
            plotSnapshot.plot,
            this.renderPrograms!.pointTransShadow,
            this.pointShadowViewProjection,
            activeLight.light,
            shadowRange,
          );
        }
      }
      gl.disable(gl.BLEND);
    }

    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  private drawShadowMeshWithMatrix(plot: RenderableObject, program: ProgramBundle, lightMatrix: mat4): void {
    const gl = this.gl!;
    const visual = this.plotVisuals.get(plot.id);
    if (!visual || !visual.buffers.vao || visual.buffers.indexCount <= 0) {
      return;
    }
    const model = mat4.fromTranslation(mat4.create(), vec3.fromValues(
      plot.transform.position.x,
      plot.transform.position.y,
      plot.transform.position.z,
    ));
    gl.uniformMatrix4fv(program.uniforms.u_model, false, model);
    gl.uniformMatrix4fv(program.uniforms.u_lightMatrix, false, lightMatrix);
    gl.bindVertexArray(visual.buffers.vao);
    gl.drawElements(gl.TRIANGLES, visual.buffers.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  private drawTransparentShadowMeshWithMatrix(plot: RenderableObject, program: ProgramBundle, lightMatrix: mat4): void {
    const gl = this.gl!;
    const visual = this.plotVisuals.get(plot.id);
    if (!visual || !visual.buffers.vao || visual.buffers.indexCount <= 0) {
      return;
    }
    const model = mat4.fromTranslation(mat4.create(), vec3.fromValues(
      plot.transform.position.x,
      plot.transform.position.y,
      plot.transform.position.z,
    ));
    gl.uniformMatrix4fv(program.uniforms.u_model, false, model);
    gl.uniformMatrix4fv(program.uniforms.u_lightMatrix, false, lightMatrix);
    gl.uniform3fv(program.uniforms.u_baseColor, hexToRgb(plot.material.baseColor));
    gl.uniform1f(program.uniforms.u_opacity, clamp01(plot.material.opacity));
    gl.bindVertexArray(visual.buffers.vao);
    gl.drawElements(gl.TRIANGLES, visual.buffers.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  private drawPointShadowMesh(
    plot: RenderableObject,
    program: ProgramBundle,
    lightMatrix: mat4,
    light: PointLightObject,
    lightFar: number,
  ): void {
    const gl = this.gl!;
    const visual = this.plotVisuals.get(plot.id);
    if (!visual || !visual.buffers.vao || visual.buffers.indexCount <= 0) {
      return;
    }
    const model = mat4.fromTranslation(mat4.create(), vec3.fromValues(
      plot.transform.position.x,
      plot.transform.position.y,
      plot.transform.position.z,
    ));
    gl.uniformMatrix4fv(program.uniforms.u_model, false, model);
    gl.uniformMatrix4fv(program.uniforms.u_lightMatrix, false, lightMatrix);
    gl.uniform3f(program.uniforms.u_lightPosition, light.position.x, light.position.y, light.position.z);
    gl.uniform1f(program.uniforms.u_lightFar, lightFar);
    gl.bindVertexArray(visual.buffers.vao);
    gl.drawElements(gl.TRIANGLES, visual.buffers.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  private drawPointTransparentShadowMesh(
    plot: RenderableObject,
    program: ProgramBundle,
    lightMatrix: mat4,
    light: PointLightObject,
    lightFar: number,
  ): void {
    const gl = this.gl!;
    const visual = this.plotVisuals.get(plot.id);
    if (!visual || !visual.buffers.vao || visual.buffers.indexCount <= 0) {
      return;
    }
    const model = mat4.fromTranslation(mat4.create(), vec3.fromValues(
      plot.transform.position.x,
      plot.transform.position.y,
      plot.transform.position.z,
    ));
    gl.uniformMatrix4fv(program.uniforms.u_model, false, model);
    gl.uniformMatrix4fv(program.uniforms.u_lightMatrix, false, lightMatrix);
    gl.uniform3f(program.uniforms.u_lightPosition, light.position.x, light.position.y, light.position.z);
    gl.uniform1f(program.uniforms.u_lightFar, lightFar);
    gl.uniform3fv(program.uniforms.u_baseColor, hexToRgb(plot.material.baseColor));
    gl.uniform1f(program.uniforms.u_opacity, clamp01(plot.material.opacity));
    gl.bindVertexArray(visual.buffers.vao);
    gl.drawElements(gl.TRIANGLES, visual.buffers.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  private renderPlanarReflection(
    snapshot: RendererSceneSnapshot,
    pointLights: ReadonlyArray<PointLightObject>,
  ): void {
    const gl = this.gl!;
    const scene = snapshot.scene;
    const cameraAbovePlane = this.getCameraPosition()[2] > 0.05;
    this.planarReflectionReady = false;
    if (!scene.groundPlaneVisible || !scene.groundPlaneReflective || !cameraAbovePlane) {
      return;
    }
    this.ensurePlanarReflectionTargets(
      Math.max(1, Math.floor(this.renderTargets.width / 2)),
      Math.max(1, Math.floor(this.renderTargets.height / 2)),
    );
    const targets = this.planarReflection;
    if (!targets.framebuffer) {
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.framebuffer);
    gl.viewport(0, 0, targets.width, targets.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.useProgram(this.renderPrograms!.mesh.program);
    // Shadow lookups are wrong at mirrored positions, so shadows stay off;
    // lights are mirrored about z=0 so the reflected shading matches.
    this.bindSceneUniforms(this.renderPrograms!.mesh, snapshot, pointLights, [], false, true, true);
    // The planar texture is this pass's render target; point its sampler unit
    // at another 2D texture so no rendering feedback loop forms.
    bindTexture(gl, this.renderTargets.refractionTexture, PLANAR_REFLECTION_TEXTURE_UNIT, gl.TEXTURE_2D);
    gl.uniform1i(this.renderPrograms!.mesh.uniforms.u_clipWorldZAbove, 1);
    const mirror = mat4.fromScaling(mat4.create(), vec3.fromValues(1, 1, -1));
    for (const plotSnapshot of snapshot.plots) {
      const opacity = clamp01(plotSnapshot.plot.material.opacity);
      if (!plotSnapshot.plot.visible || opacity < 0.999) {
        continue;
      }
      this.drawShadedMesh(plotSnapshot.plot, this.renderPrograms!.mesh, false, noProbeUsage(), mirror);
    }
    gl.uniform1i(this.renderPrograms!.mesh.uniforms.u_clipWorldZAbove, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (targets.colorTexture) {
      gl.bindTexture(gl.TEXTURE_2D, targets.colorTexture);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.planarReflectionReady = true;
  }

  private ensurePlanarReflectionTargets(width: number, height: number): void {
    const gl = this.gl!;
    if (
      this.planarReflection.framebuffer
      && this.planarReflection.width === width
      && this.planarReflection.height === height
    ) {
      return;
    }
    this.deletePlanarReflectionTargets(gl);
    const hdrColorFormat = this.supportsFloatColorBuffers
      ? { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT }
      : { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
    const colorTexture = createColorTexture(gl, width, height, hdrColorFormat.internalFormat, hdrColorFormat.format, hdrColorFormat.type);
    gl.bindTexture(gl.TEXTURE_2D, colorTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const depthRenderbuffer = gl.createRenderbuffer();
    if (!depthRenderbuffer) {
      deleteTexture(gl, colorTexture);
      return;
    }
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRenderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) {
      deleteTexture(gl, colorTexture);
      gl.deleteRenderbuffer(depthRenderbuffer);
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTexture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRenderbuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.planarReflection = { framebuffer, colorTexture, depthRenderbuffer, width, height };
  }

  private deletePlanarReflectionTargets(gl: WebGL2RenderingContext): void {
    deleteFramebuffer(gl, this.planarReflection.framebuffer);
    deleteTexture(gl, this.planarReflection.colorTexture);
    if (this.planarReflection.depthRenderbuffer) {
      gl.deleteRenderbuffer(this.planarReflection.depthRenderbuffer);
    }
    this.planarReflection = emptyPlanarReflectionTargets();
    this.planarReflectionReady = false;
  }

  private renderOpaqueScene(
    snapshot: RendererSceneSnapshot,
    pointLights: ReadonlyArray<PointLightObject>,
    pointShadowLights: ReadonlyArray<ActivePointShadowLight>,
  ): void {
    const gl = this.gl!;
    const targets = this.renderTargets;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.sceneFramebuffer);
    gl.viewport(0, 0, targets.width, targets.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.bindOpaqueMeshPass(snapshot, pointLights, pointShadowLights);
    for (const plotSnapshot of snapshot.plots) {
      const opacity = clamp01(plotSnapshot.plot.material.opacity);
      if (!plotSnapshot.plot.visible || opacity < 0.999) {
        continue;
      }
      const probeUsage = this.prepareProbeForPlot(snapshot, plotSnapshot.plot);
      if (probeUsage.refreshed) {
        this.bindOpaqueMeshPass(snapshot, pointLights, pointShadowLights);
      }
      this.drawShadedMesh(plotSnapshot.plot, this.renderPrograms!.mesh, false, probeUsage);
    }
    if (snapshot.scene.groundPlaneVisible) {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      this.drawGroundPlane(snapshot.scene, this.renderPrograms!.mesh, false, false, this.planarReflectionReady);
    }
    if (snapshot.scene.gridVisible) {
      this.drawSceneGrid(snapshot.scene);
    }
    for (const plotSnapshot of snapshot.plots) {
      const opacity = clamp01(plotSnapshot.plot.material.opacity);
      if (!plotSnapshot.showsWireframe || opacity < 0.999) {
        continue;
      }
      this.drawPlotWireframe(plotSnapshot.plot, gl.LEQUAL);
    }
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
  }

  private renderTransparentScene(
    snapshot: RendererSceneSnapshot,
    pointLights: ReadonlyArray<PointLightObject>,
    pointShadowLights: ReadonlyArray<ActivePointShadowLight>,
  ): void {
    const gl = this.gl!;
    const cameraPosition = this.getCameraPosition();
    const renderItems = sortTransparentSceneBackToFront<TransparentSceneRenderItem>([
      ...snapshot.plots
        .filter(({ plot }) => {
          const opacity = clamp01(plot.material.opacity);
          return plot.visible && opacity > 0.001 && opacity < 0.999;
        })
        .map((plotSnapshot) => ({
          item: { kind: 'plot' as const, plotSnapshot },
          position: this.transparentPlotSortPosition(plotSnapshot.plot, snapshot.pointLights, cameraPosition),
        })),
      ...snapshot.pointLights
        .filter(({ light }) => shouldRenderPointLightGizmo(light))
        .map(({ light }) => ({
          item: { kind: 'point-light-gizmo' as const, light },
          position: light.position,
        })),
    ], {
      x: cameraPosition[0],
      y: cameraPosition[1],
      z: cameraPosition[2],
    });
    this.renderTransparentItems(snapshot, pointLights, pointShadowLights, renderItems);

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private transparentPlotSortPosition(
    plot: RenderableObject,
    pointLights: RendererSceneSnapshot['pointLights'],
    cameraPosition: vec3,
  ): ScenePosition {
    const pinnedLightPositions = pointLights
      .map(({ light }) => light)
      .filter((light) => (
        shouldRenderPointLightGizmo(light)
        && light.curvePin.enabled
        && light.curvePin.curveId === plot.id
      ))
      .map((light) => light.position);
    return farthestPositionFromCamera(pinnedLightPositions, {
      x: cameraPosition[0],
      y: cameraPosition[1],
      z: cameraPosition[2],
    }) ?? plot.transform.position;
  }

  private renderTransparentItems(
    snapshot: RendererSceneSnapshot,
    pointLights: ReadonlyArray<PointLightObject>,
    pointShadowLights: ReadonlyArray<ActivePointShadowLight>,
    renderItems: ReadonlyArray<TransparentSceneRenderItem>,
  ): void {
    const gl = this.gl!;
    let meshPassNeedsBinding = true;
    for (const renderItem of renderItems) {
      if (renderItem.kind === 'point-light-gizmo') {
        this.renderPointLightGizmo(
          snapshot,
          renderItem.light,
          this.renderPrograms!.gizmo,
          pointLights,
          pointShadowLights,
        );
        meshPassNeedsBinding = true;
        continue;
      }
      if (meshPassNeedsBinding) {
        this.bindTransparentMeshPass(snapshot, pointLights, pointShadowLights);
        meshPassNeedsBinding = false;
      }
      const plotSnapshot = renderItem.plotSnapshot;
      const probeUsage = this.prepareProbeForPlot(snapshot, plotSnapshot.plot);
      const usesRefraction = plotUsesRefraction(plotSnapshot.plot);
      if (usesRefraction) {
        // Snapshot everything rendered so far (opaque scene plus farther
        // transparent plots and point-light gizmos) so this surface can
        // refract what is behind it.
        this.updateRefractionSource();
      }
      if (probeUsage.refreshed || usesRefraction) {
        this.bindTransparentMeshPass(snapshot, pointLights, pointShadowLights);
      }
      // Transparent double-sided shells render more stably back-to-front when we split back and front faces.
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.FRONT);
      this.drawShadedMesh(plotSnapshot.plot, this.renderPrograms!.mesh, true, probeUsage);
      gl.cullFace(gl.BACK);
      this.drawShadedMesh(plotSnapshot.plot, this.renderPrograms!.mesh, true, probeUsage);
    }
    gl.disable(gl.CULL_FACE);
  }

  private updateRefractionSource(): void {
    const gl = this.gl!;
    const targets = this.renderTargets;
    if (!targets.sceneFramebuffer || !targets.refractionFramebuffer || !targets.refractionTexture) {
      return;
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, targets.sceneFramebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, targets.refractionFramebuffer);
    gl.blitFramebuffer(
      0,
      0,
      targets.width,
      targets.height,
      0,
      0,
      targets.width,
      targets.height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, targets.refractionTexture);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private renderTransparentContourOverlays(
    snapshot: RendererSceneSnapshot,
  ): void {
    const gl = this.gl!;
    const transparentPlots = snapshot.plots.filter(({ plot }) => {
      const opacity = clamp01(plot.material.opacity);
      return plot.visible && opacity > 0.001 && opacity < 0.999;
    });
    const contourPlots = transparentPlots.filter(({ plot }) => plotHasContours(plot));
    if (contourPlots.length === 0) {
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.renderTargets.width, this.renderTargets.height);
    gl.useProgram(this.renderPrograms!.contour.program);
    gl.uniformMatrix4fv(this.renderPrograms!.contour.uniforms.u_view, false, this.viewMatrix);
    gl.uniformMatrix4fv(this.renderPrograms!.contour.uniforms.u_projection, false, this.projectionMatrix);
    // The overlay draws after compositing, so occlusion against opaque
    // geometry is resolved manually against the scene depth texture.
    bindTexture(gl, this.renderTargets.sceneDepth, 0, gl.TEXTURE_2D);
    gl.uniform1i(this.renderPrograms!.contour.uniforms.u_sceneDepth, 0);
    gl.uniform2f(
      this.renderPrograms!.contour.uniforms.u_viewportSize,
      Math.max(1, this.renderTargets.width),
      Math.max(1, this.renderTargets.height),
    );
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.CULL_FACE);
    for (const plotSnapshot of contourPlots) {
      this.drawContourMesh(plotSnapshot.plot, this.renderPrograms!.contour);
    }
  }

  private renderBloom(snapshot: RendererSceneSnapshot): void {
    const enabled = snapshot.render.bloomEnabled ?? true;
    const strength = clamp(snapshot.render.bloomStrength ?? 0.65, 0, 2);
    const targets = this.renderTargets;
    if (
      !enabled
      || strength <= 0
      || !targets.sceneColor
      || !targets.bloomFramebufferA
      || !targets.bloomTextureA
      || !targets.bloomFramebufferB
      || !targets.bloomTextureB
    ) {
      return;
    }

    const gl = this.gl!;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.fullscreenVao);

    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.bloomFramebufferA);
    gl.viewport(0, 0, targets.bloomWidth, targets.bloomHeight);
    gl.useProgram(this.renderPrograms!.bloomExtract.program);
    bindTexture(gl, targets.sceneColor, 0, gl.TEXTURE_2D);
    gl.uniform1i(this.renderPrograms!.bloomExtract.uniforms.u_sceneColor, 0);
    gl.uniform1f(
      this.renderPrograms!.bloomExtract.uniforms.u_threshold,
      clamp(snapshot.render.bloomThreshold ?? 1, 0, 5),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const nativeWidth = Math.max(1, Math.floor(this.canvas.clientWidth * window.devicePixelRatio));
    const exportScale = Math.max(1, this.canvas.width / nativeWidth);
    const radius = clamp(snapshot.render.bloomRadius ?? 1.5, 0.25, 4) * exportScale;
    gl.useProgram(this.renderPrograms!.bloomBlur.program);
    gl.uniform1i(this.renderPrograms!.bloomBlur.uniforms.u_source, 0);
    gl.uniform2f(
      this.renderPrograms!.bloomBlur.uniforms.u_texelSize,
      1 / Math.max(1, targets.bloomWidth),
      1 / Math.max(1, targets.bloomHeight),
    );
    gl.uniform1f(this.renderPrograms!.bloomBlur.uniforms.u_radius, radius);

    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.bloomFramebufferB);
    bindTexture(gl, targets.bloomTextureA, 0, gl.TEXTURE_2D);
    gl.uniform2f(this.renderPrograms!.bloomBlur.uniforms.u_direction, 1, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.bloomFramebufferA);
    bindTexture(gl, targets.bloomTextureB, 0, gl.TEXTURE_2D);
    gl.uniform2f(this.renderPrograms!.bloomBlur.uniforms.u_direction, 0, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private compositeScene(snapshot: RendererSceneSnapshot): void {
    const gl = this.gl!;
    const targets = this.renderTargets;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, targets.width, targets.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.renderPrograms!.composite.program);
    gl.bindVertexArray(this.fullscreenVao);
    bindTexture(gl, targets.sceneColor, 0, gl.TEXTURE_2D);
    gl.uniform1i(this.renderPrograms!.composite.uniforms.u_sceneColor, 0);
    bindTexture(gl, targets.bloomTextureA, 1, gl.TEXTURE_2D);
    gl.uniform1i(this.renderPrograms!.composite.uniforms.u_bloomColor, 1);
    gl.uniform1i(
      this.renderPrograms!.composite.uniforms.u_bloomEnabled,
      (snapshot.render.bloomEnabled ?? true) && (snapshot.render.bloomStrength ?? 0.65) > 0 ? 1 : 0,
    );
    gl.uniform1f(
      this.renderPrograms!.composite.uniforms.u_bloomStrength,
      clamp(snapshot.render.bloomStrength ?? 0.65, 0, 2),
    );
    gl.uniform1i(
      this.renderPrograms!.composite.uniforms.u_backgroundMode,
      snapshot.scene.backgroundMode === 'gradient' ? 1 : 0,
    );
    gl.uniform3fv(
      this.renderPrograms!.composite.uniforms.u_backgroundColor,
      hexToRgb(snapshot.scene.backgroundColor),
    );
    gl.uniform3fv(
      this.renderPrograms!.composite.uniforms.u_gradientTop,
      hexToRgb(snapshot.scene.gradientTopColor),
    );
    gl.uniform3fv(
      this.renderPrograms!.composite.uniforms.u_gradientBottom,
      hexToRgb(snapshot.scene.gradientBottomColor),
    );
    gl.uniform1i(this.renderPrograms!.composite.uniforms.u_toneMapping, toneMappingMode(snapshot.render.toneMapping));
    gl.uniform1f(this.renderPrograms!.composite.uniforms.u_exposure, clamp(snapshot.render.exposure, 0.01, 5));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  private renderSelectionMask(snapshot: RendererSceneSnapshot): void {
    const gl = this.gl!;
    const selected = snapshot.selectedId ? snapshot.objects.find((object) => object.id === snapshot.selectedId) : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.renderTargets.maskFramebuffer);
    gl.viewport(0, 0, this.renderTargets.width, this.renderTargets.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!selected || !isRenderableObject(selected) || !selected.visible) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return;
    }
    const visual = this.plotVisuals.get(selected.id);
    if (!visual || !visual.buffers.vao) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return;
    }
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.useProgram(this.renderPrograms!.mask.program);
    const model = mat4.fromTranslation(mat4.create(), vec3.fromValues(
      selected.transform.position.x,
      selected.transform.position.y,
      selected.transform.position.z,
    ));
    gl.uniformMatrix4fv(this.renderPrograms!.mask.uniforms.u_model, false, model);
    gl.uniformMatrix4fv(this.renderPrograms!.mask.uniforms.u_view, false, this.viewMatrix);
    gl.uniformMatrix4fv(this.renderPrograms!.mask.uniforms.u_projection, false, this.projectionMatrix);
    gl.bindVertexArray(visual.buffers.vao);
    gl.drawElements(gl.TRIANGLES, visual.buffers.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private renderSelectionOutline(snapshot: RendererSceneSnapshot): void {
    const gl = this.gl!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.renderTargets.width, this.renderTargets.height);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.renderPrograms!.outline.program);
    gl.bindVertexArray(this.fullscreenVao);
    bindTexture(gl, this.renderTargets.maskTexture, 0, gl.TEXTURE_2D);
    bindTexture(gl, this.renderTargets.maskDepth, 1, gl.TEXTURE_2D);
    bindTexture(gl, this.renderTargets.sceneDepth, 2, gl.TEXTURE_2D);
    gl.uniform1i(this.renderPrograms!.outline.uniforms.u_mask, 0);
    gl.uniform1i(this.renderPrograms!.outline.uniforms.u_maskDepth, 1);
    gl.uniform1i(this.renderPrograms!.outline.uniforms.u_sceneDepth, 2);
    gl.uniform2f(this.renderPrograms!.outline.uniforms.u_texelSize, 1 / Math.max(1, this.renderTargets.width), 1 / Math.max(1, this.renderTargets.height));
    const selected = snapshot.selectedId
      ? snapshot.objects.find((object) => object.id === snapshot.selectedId)
      : null;
    const exclusions = selected && isRenderableObject(selected) && selected.visible
      ? this.pointGizmoOverlayExclusions(snapshot, selected.id)
      : { count: 0, values: new Float32Array(MAX_POINT_GIZMO_OVERLAY_EXCLUSIONS * 3) };
    gl.uniform1i(this.renderPrograms!.outline.uniforms.u_gizmoExclusionCount, exclusions.count);
    gl.uniform3fv(this.renderPrograms!.outline.uniforms['u_gizmoExclusions[0]'], exclusions.values);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  private renderSelectedFeatureEdges(snapshot: RendererSceneSnapshot): void {
    const selected = snapshot.selectedId ? snapshot.objects.find((object) => object.id === snapshot.selectedId) : null;
    if (!selected || !isRenderableObject(selected) || !selected.visible) {
      return;
    }
    const visual = this.plotVisuals.get(selected.id);
    if (!visual) {
      return;
    }
    const gl = this.gl!;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.renderPrograms!.line.program);
    this.setLineProgramFrameUniforms();
    const exclusions = this.pointGizmoOverlayExclusions(snapshot, selected.id);
    gl.uniform1i(this.renderPrograms!.line.uniforms.u_gizmoExclusionCount, exclusions.count);
    gl.uniform3fv(this.renderPrograms!.line.uniforms['u_gizmoExclusions[0]'], exclusions.values);
    const model = mat4.fromTranslation(mat4.create(), vec3.fromValues(
      selected.transform.position.x,
      selected.transform.position.y,
      selected.transform.position.z,
    ));
    gl.uniformMatrix4fv(this.renderPrograms!.line.uniforms.u_model, false, model);
    this.setLineScreenOffset(0, 0);
    gl.uniform4f(this.renderPrograms!.line.uniforms.u_color, 0.86, 0.93, 1.0, 0.72);
    if (visual.buffers.boundaryLines) {
      drawLineBuffer(gl, visual.buffers.boundaryLines);
    }
    gl.disable(gl.BLEND);
  }

  private renderSceneAxes(snapshot: RendererSceneSnapshot): void {
    if (!snapshot.scene.axesVisible) {
      return;
    }
    const gl = this.gl!;
    const key = String(snapshot.scene.axesLength);
    if (!this.axesLineBuffer || this.axesLineBuffer.key !== key) {
      if (this.axesLineBuffer) {
        deleteLineBuffer(gl, this.axesLineBuffer.buffer);
        this.axesLineBuffer = null;
      }
      const axes = buildAxesLines(snapshot.scene.axesLength);
      const created = createLineBuffer(gl, axes.positions, gl.LINES);
      if (created) {
        this.axesLineBuffer = { key, buffer: created };
      }
    }
    const buffer = this.axesLineBuffer?.buffer;
    if (!buffer) {
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.renderTargets.sceneFramebuffer);
    gl.viewport(0, 0, this.renderTargets.width, this.renderTargets.height);
    gl.useProgram(this.renderPrograms!.line.program);
    this.setLineProgramFrameUniforms();
    gl.uniformMatrix4fv(this.renderPrograms!.line.uniforms.u_model, false, mat4.create());
    this.setLineScreenOffset(0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    drawColoredAxes(gl, this.renderPrograms!.line, buffer);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.BLEND);
  }

  private renderOverlayLines(snapshot: RendererSceneSnapshot): void {
    const gl = this.gl!;
    gl.useProgram(this.renderPrograms!.line.program);
    this.setLineProgramFrameUniforms();
    this.setLineScreenOffset(0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    for (const plotSnapshot of snapshot.plots) {
      if (!plotSnapshot.showsWireframe) {
        continue;
      }
      const opacity = clamp01(plotSnapshot.plot.material.opacity);
      if (opacity >= 0.999) {
        continue;
      }
      this.drawPlotWireframe(plotSnapshot.plot, gl.LEQUAL);
    }
    gl.disable(gl.BLEND);
  }

  private setLineProgramFrameUniforms(): void {
    const gl = this.gl!;
    gl.uniformMatrix4fv(this.renderPrograms!.line.uniforms.u_view, false, this.viewMatrix);
    gl.uniformMatrix4fv(this.renderPrograms!.line.uniforms.u_projection, false, this.projectionMatrix);
    gl.uniform2f(
      this.renderPrograms!.line.uniforms.u_viewport,
      Math.max(1, this.canvas.width),
      Math.max(1, this.canvas.height),
    );
    gl.uniform1i(this.renderPrograms!.line.uniforms.u_gizmoExclusionCount, 0);
  }

  private setLineScreenOffset(x: number, y: number): void {
    this.gl!.uniform2f(this.renderPrograms!.line.uniforms.u_screenOffset, x, y);
  }

  private drawPlotWireframe(plot: RenderableObject, depthFunc: number): void {
    const gl = this.gl!;
    const visual = this.plotVisuals.get(plot.id);
    if (!visual || visual.buffers.wireLines.length === 0) {
      return;
    }
    gl.useProgram(this.renderPrograms!.line.program);
    this.setLineProgramFrameUniforms();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.depthFunc(depthFunc);
    gl.disable(gl.CULL_FACE);
    const model = mat4.fromTranslation(mat4.create(), vec3.fromValues(
      plot.transform.position.x,
      plot.transform.position.y,
      plot.transform.position.z,
    ));
    gl.uniformMatrix4fv(this.renderPrograms!.line.uniforms.u_model, false, model);
    const wireframeColor = hexToRgb(plot.material.wireframeColor ?? '#000000');
    gl.uniform4f(
      this.renderPrograms!.line.uniforms.u_color,
      wireframeColor[0],
      wireframeColor[1],
      wireframeColor[2],
      0.22,
    );
    for (const [offsetX, offsetY] of [[-0.9, 0], [0.9, 0], [0, -0.9], [0, 0.9]] as const) {
      this.setLineScreenOffset(offsetX, offsetY);
      visual.buffers.wireLines.forEach((line) => drawLineBuffer(gl, line));
    }
    this.setLineScreenOffset(0, 0);
    gl.uniform4f(
      this.renderPrograms!.line.uniforms.u_color,
      wireframeColor[0],
      wireframeColor[1],
      wireframeColor[2],
      0.84,
    );
    visual.buffers.wireLines.forEach((line) => drawLineBuffer(gl, line));
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
  }

  private drawSceneGrid(scene: RendererSceneSnapshot['scene']): void {
    const gl = this.gl!;
    const key = `${scene.gridExtent}|${scene.gridSpacing}`;
    if (!this.gridLineBuffer || this.gridLineBuffer.key !== key) {
      if (this.gridLineBuffer) {
        deleteLineBuffer(gl, this.gridLineBuffer.buffer);
        this.gridLineBuffer = null;
      }
      const grid = buildGridLines(scene.gridExtent, scene.gridSpacing);
      const created = createLineBuffer(gl, grid.positions, gl.LINES);
      if (created) {
        this.gridLineBuffer = { key, buffer: created };
      }
    }
    const buffer = this.gridLineBuffer?.buffer;
    if (!buffer) {
      return;
    }
    gl.useProgram(this.renderPrograms!.line.program);
    this.setLineProgramFrameUniforms();
    gl.uniformMatrix4fv(this.renderPrograms!.line.uniforms.u_model, false, mat4.create());
    this.setLineScreenOffset(0, 0);
    gl.uniform4f(this.renderPrograms!.line.uniforms.u_color, 0.72, 0.8, 0.95, clamp01(scene.gridLineOpacity));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    drawLineBuffer(gl, buffer);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
  }

  private renderPointLightGizmo(
    snapshot: RendererSceneSnapshot,
    light: PointLightObject,
    program: ProgramBundle,
    pointLights: ReadonlyArray<PointLightObject>,
    pointShadowLights: ReadonlyArray<ActivePointShadowLight>,
  ): void {
    const gl = this.gl!;
    this.gizmoPointBuffer ??= createPointBuffer(gl);
    const pointBuffer = this.gizmoPointBuffer;
    if (!pointBuffer) {
      return;
    }
    const position = vec3.fromValues(light.position.x, light.position.y, light.position.z);
    const selected = snapshot.selectedId === light.id;
    const size = selected ? 360 : 300;
    const pinnedCurve = pinnedCurveForLight(light, snapshot.objects);
    const usesSourceAwareDepth = Boolean(
      pinnedCurve?.visible
      && clamp01(pinnedCurve.material.opacity) >= 0.999,
    );
    const sourceAwareBounds = usesSourceAwareDepth
      ? this.pointLightGizmoRenderBounds(position, size)
      : null;
    if (sourceAwareBounds && pinnedCurve) {
      this.copySceneColorToPointGizmoTarget(sourceAwareBounds);
      this.markPointLightGizmoSourcePixels(
        pinnedCurve,
        position,
        size,
        selected,
        program,
        pointBuffer,
        sourceAwareBounds,
      );
      this.preparePointLightGizmoDepth(snapshot, pinnedCurve.id, sourceAwareBounds);
      this.copyPointLightGizmoStencil(sourceAwareBounds);
      this.writePointLightGizmoDepth(position, size, selected, program, pointBuffer, sourceAwareBounds);
      this.renderPointLightGizmoOpaqueOccluders(
        snapshot,
        pinnedCurve.id,
        pointLights,
        pointShadowLights,
        sourceAwareBounds,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.renderTargets.pointGizmoFramebuffer);
      gl.viewport(
        -sourceAwareBounds.x,
        -sourceAwareBounds.y,
        this.renderTargets.width,
        this.renderTargets.height,
      );
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.renderTargets.sceneFramebuffer);
      gl.viewport(0, 0, this.renderTargets.width, this.renderTargets.height);
    }
    this.bindPointGizmoPass(program);
    this.drawPointGizmoHandle(
      program,
      pointBuffer,
      position,
      pointLightGizmoColor(light.color, selected),
      size,
      selected,
    );
    this.finishPointGizmoPass();
    if (sourceAwareBounds && pinnedCurve) {
      this.renderPointLightGizmoTransparentOccluders(
        snapshot,
        pinnedCurve.id,
        pointLights,
        pointShadowLights,
        sourceAwareBounds,
      );
      this.copyPointGizmoTargetToSceneColor(sourceAwareBounds);
    }
  }

  private pointLightGizmoRenderBounds(position: vec3, size: number): PointGizmoRenderBounds | null {
    const viewPosition = vec4.transformMat4(
      vec4.create(),
      vec4.fromValues(position[0], position[1], position[2], 1),
      this.viewMatrix,
    );
    const clip = vec4.transformMat4(vec4.create(), viewPosition, this.projectionMatrix);
    if (
      clip[3] <= 0
      || clip[0] < -clip[3]
      || clip[0] > clip[3]
      || clip[1] < -clip[3]
      || clip[1] > clip[3]
      || clip[2] < -clip[3]
      || clip[2] > clip[3]
    ) {
      return null;
    }
    const centerX = (clip[0] / clip[3] * 0.5 + 0.5) * this.renderTargets.width;
    const centerY = (clip[1] / clip[3] * 0.5 + 0.5) * this.renderTargets.height;
    const pointSize = clamp(size / Math.max(clip[3], 0.001), 10, 30);
    const radius = pointSize / 2 + 2;
    const x = clamp(Math.floor(centerX - radius), 0, this.renderTargets.width);
    const y = clamp(Math.floor(centerY - radius), 0, this.renderTargets.height);
    const right = clamp(Math.ceil(centerX + radius), 0, this.renderTargets.width);
    const top = clamp(Math.ceil(centerY + radius), 0, this.renderTargets.height);
    const width = right - x;
    const height = top - y;
    return width > 0 && height > 0
      ? { x, y, width, height, centerX, centerY, radius }
      : null;
  }

  private pointGizmoOverlayExclusions(
    snapshot: RendererSceneSnapshot,
    sourceCurveId: string,
  ): { count: number; values: Float32Array } {
    const values = new Float32Array(MAX_POINT_GIZMO_OVERLAY_EXCLUSIONS * 3);
    let count = 0;
    for (const { light } of snapshot.pointLights) {
      if (
        count >= MAX_POINT_GIZMO_OVERLAY_EXCLUSIONS
        || !shouldRenderPointLightGizmo(light)
        || !light.curvePin.enabled
        || light.curvePin.curveId !== sourceCurveId
      ) {
        continue;
      }
      const position = vec3.fromValues(light.position.x, light.position.y, light.position.z);
      const bounds = this.pointLightGizmoRenderBounds(position, snapshot.selectedId === light.id ? 360 : 300);
      if (!bounds) {
        continue;
      }
      values[count * 3] = bounds.centerX;
      values[count * 3 + 1] = bounds.centerY;
      values[count * 3 + 2] = bounds.radius;
      count += 1;
    }
    return { count, values };
  }

  private plotMayOverlapPointGizmo(
    plot: RenderableObject,
    bounds: PointGizmoRenderBounds,
    viewProjection: mat4,
  ): boolean {
    const visual = this.plotVisuals.get(plot.id);
    if (!visual) {
      return false;
    }
    const geometryBounds = visual.geometry.bounds;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const x of [geometryBounds.min.x, geometryBounds.max.x]) {
      for (const y of [geometryBounds.min.y, geometryBounds.max.y]) {
        for (const z of [geometryBounds.min.z, geometryBounds.max.z]) {
          const clip = vec4.transformMat4(
            vec4.create(),
            vec4.fromValues(
              x + plot.transform.position.x,
              y + plot.transform.position.y,
              z + plot.transform.position.z,
              1,
            ),
            viewProjection,
          );
          if (clip[3] <= 0.0001) {
            return true;
          }
          const screenX = (clip[0] / clip[3] * 0.5 + 0.5) * this.renderTargets.width;
          const screenY = (clip[1] / clip[3] * 0.5 + 0.5) * this.renderTargets.height;
          minX = Math.min(minX, screenX);
          minY = Math.min(minY, screenY);
          maxX = Math.max(maxX, screenX);
          maxY = Math.max(maxY, screenY);
        }
      }
    }
    return maxX >= bounds.x - 1
      && minX <= bounds.x + bounds.width + 1
      && maxY >= bounds.y - 1
      && minY <= bounds.y + bounds.height + 1;
  }

  private copySceneColorToPointGizmoTarget(bounds: PointGizmoRenderBounds): void {
    const gl = this.gl!;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.renderTargets.sceneFramebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.renderTargets.pointGizmoFramebuffer);
    gl.blitFramebuffer(
      bounds.x,
      bounds.y,
      bounds.x + bounds.width,
      bounds.y + bounds.height,
      0,
      0,
      bounds.width,
      bounds.height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
  }

  private copyPointGizmoTargetToSceneColor(bounds: PointGizmoRenderBounds): void {
    const gl = this.gl!;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.renderTargets.pointGizmoFramebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.renderTargets.sceneFramebuffer);
    gl.blitFramebuffer(
      0,
      0,
      bounds.width,
      bounds.height,
      bounds.x,
      bounds.y,
      bounds.x + bounds.width,
      bounds.y + bounds.height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.renderTargets.sceneFramebuffer);
  }

  private markPointLightGizmoSourcePixels(
    sourceCurve: PlotObject,
    position: vec3,
    size: number,
    selected: boolean,
    pointProgram: ProgramBundle,
    pointBuffer: GpuLineBuffer,
    bounds: PointGizmoRenderBounds,
  ): void {
    const gl = this.gl!;
    const framebuffer = this.renderTargets.pointGizmoSourceFramebuffer;
    if (!framebuffer) {
      return;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(-bounds.x, -bounds.y, this.renderTargets.width, this.renderTargets.height);
    gl.colorMask(false, false, false, false);
    gl.depthMask(false);
    gl.stencilMask(0xff);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    const sourceMaskProgram = this.renderPrograms!.pointGizmoSourceMask;
    gl.useProgram(sourceMaskProgram.program);
    bindTexture(gl, this.renderTargets.sceneDepth, 0, gl.TEXTURE_2D);
    gl.uniform1i(sourceMaskProgram.uniforms.u_sceneDepth, 0);
    gl.uniform2f(
      sourceMaskProgram.uniforms.u_viewportSize,
      Math.max(1, this.renderTargets.width),
      Math.max(1, this.renderTargets.height),
    );
    gl.uniform2f(sourceMaskProgram.uniforms.u_viewportOrigin, bounds.x, bounds.y);
    const viewProjection = mat4.multiply(mat4.create(), this.projectionMatrix, this.viewMatrix);
    this.drawShadowMeshWithMatrix(sourceCurve, sourceMaskProgram, viewProjection);

    gl.disable(gl.DEPTH_TEST);
    gl.stencilFunc(gl.EQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
    gl.useProgram(pointProgram.program);
    gl.uniformMatrix4fv(pointProgram.uniforms.u_view, false, this.viewMatrix);
    gl.uniformMatrix4fv(pointProgram.uniforms.u_projection, false, this.projectionMatrix);
    this.drawPointGizmoHandle(
      pointProgram,
      pointBuffer,
      position,
      POINT_GIZMO_MASK_COLOR,
      size,
      selected,
    );

    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
  }

  private copyPointLightGizmoStencil(bounds: PointGizmoRenderBounds): void {
    const gl = this.gl!;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.renderTargets.pointGizmoSourceFramebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.renderTargets.pointGizmoFramebuffer);
    gl.blitFramebuffer(
      0,
      0,
      bounds.width,
      bounds.height,
      0,
      0,
      bounds.width,
      bounds.height,
      gl.STENCIL_BUFFER_BIT,
      gl.NEAREST,
    );
  }

  private writePointLightGizmoDepth(
    position: vec3,
    size: number,
    selected: boolean,
    program: ProgramBundle,
    pointBuffer: GpuLineBuffer,
    bounds: PointGizmoRenderBounds,
  ): void {
    const gl = this.gl!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.renderTargets.pointGizmoFramebuffer);
    gl.viewport(-bounds.x, -bounds.y, this.renderTargets.width, this.renderTargets.height);
    gl.colorMask(false, false, false, false);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.disable(gl.STENCIL_TEST);
    gl.useProgram(program.program);
    gl.uniformMatrix4fv(program.uniforms.u_view, false, this.viewMatrix);
    gl.uniformMatrix4fv(program.uniforms.u_projection, false, this.projectionMatrix);
    this.drawPointGizmoHandle(
      program,
      pointBuffer,
      position,
      POINT_GIZMO_MASK_COLOR,
      size,
      selected,
    );
    gl.colorMask(true, true, true, true);
    gl.depthMask(false);
  }

  private renderPointLightGizmoOpaqueOccluders(
    snapshot: RendererSceneSnapshot,
    sourceCurveId: string,
    pointLights: ReadonlyArray<PointLightObject>,
    pointShadowLights: ReadonlyArray<ActivePointShadowLight>,
    bounds: PointGizmoRenderBounds,
  ): void {
    const gl = this.gl!;
    const program = this.renderPrograms!.mesh;
    const viewProjection = mat4.multiply(mat4.create(), this.projectionMatrix, this.viewMatrix);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.renderTargets.pointGizmoFramebuffer);
    gl.viewport(-bounds.x, -bounds.y, this.renderTargets.width, this.renderTargets.height);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0x00);
    gl.stencilFunc(gl.EQUAL, 2, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.useProgram(program.program);
    this.bindSceneUniforms(program, snapshot, pointLights, pointShadowLights, true, true);
    gl.uniform2f(program.uniforms.u_pointGizmoCorrectionOrigin, bounds.x, bounds.y);
    for (const plotSnapshot of snapshot.plots) {
      const plot = plotSnapshot.plot;
      if (
        plot.id === sourceCurveId
        || !plot.visible
        || clamp01(plot.material.opacity) < 0.999
        || !this.plotMayOverlapPointGizmo(plot, bounds, viewProjection)
      ) {
        continue;
      }
      this.drawShadedMesh(plot, program, false, this.existingProbeUsageForPlot(plot));
    }
    if (snapshot.scene.groundPlaneVisible) {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      this.drawGroundPlane(snapshot.scene, program, false, false, this.planarReflectionReady);
    }
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
  }

  private renderPointLightGizmoTransparentOccluders(
    snapshot: RendererSceneSnapshot,
    sourceCurveId: string,
    pointLights: ReadonlyArray<PointLightObject>,
    pointShadowLights: ReadonlyArray<ActivePointShadowLight>,
    bounds: PointGizmoRenderBounds,
  ): void {
    const gl = this.gl!;
    const cameraPosition = this.getCameraPosition();
    const viewProjection = mat4.multiply(mat4.create(), this.projectionMatrix, this.viewMatrix);
    const plots = sortTransparentSceneBackToFront(
      snapshot.plots
        .filter(({ plot }) => (
          plot.id !== sourceCurveId
          && plot.visible
          && clamp01(plot.material.opacity) > 0.001
          && clamp01(plot.material.opacity) < 0.999
          && this.plotMayOverlapPointGizmo(plot, bounds, viewProjection)
        ))
        .map((plotSnapshot) => ({
          item: plotSnapshot,
          position: this.transparentPlotSortPosition(plotSnapshot.plot, snapshot.pointLights, cameraPosition),
        })),
      { x: cameraPosition[0], y: cameraPosition[1], z: cameraPosition[2] },
    );
    if (plots.length === 0) {
      return;
    }

    const program = this.renderPrograms!.mesh;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.renderTargets.pointGizmoFramebuffer);
    gl.viewport(-bounds.x, -bounds.y, this.renderTargets.width, this.renderTargets.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.blendEquation(gl.FUNC_ADD);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0x00);
    gl.stencilFunc(gl.EQUAL, 2, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.useProgram(program.program);
    this.bindSceneUniforms(program, snapshot, pointLights, pointShadowLights, true, true);
    bindTexture(gl, this.renderTargets.sceneDepth, REFRACTION_TEXTURE_UNIT, gl.TEXTURE_2D);
    gl.uniform1i(program.uniforms.u_pointGizmoCorrectionEnabled, 1);
    gl.uniform2f(program.uniforms.u_pointGizmoCorrectionOrigin, bounds.x, bounds.y);
    for (const plotSnapshot of plots) {
      const probeUsage = this.existingProbeUsageForPlot(plotSnapshot.plot);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.FRONT);
      this.drawShadedMesh(plotSnapshot.plot, program, true, probeUsage, undefined, false);
      gl.cullFace(gl.BACK);
      this.drawShadedMesh(plotSnapshot.plot, program, true, probeUsage, undefined, false);
    }
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
  }

  private preparePointLightGizmoDepth(
    snapshot: RendererSceneSnapshot,
    sourceCurveId: string,
    bounds: PointGizmoRenderBounds,
  ): void {
    const gl = this.gl!;
    const framebuffer = this.renderTargets.pointGizmoFramebuffer;
    if (!framebuffer) {
      return;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(-bounds.x, -bounds.y, this.renderTargets.width, this.renderTargets.height);
    gl.colorMask(false, false, false, false);
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    const program = this.renderPrograms!.shadow;
    const viewProjection = mat4.multiply(mat4.create(), this.projectionMatrix, this.viewMatrix);
    gl.useProgram(program.program);
    this.drawPointLightGizmoOpaqueDepth(snapshot, program, viewProjection, sourceCurveId, bounds);
    gl.colorMask(true, true, true, true);
  }

  private drawPointLightGizmoOpaqueDepth(
    snapshot: RendererSceneSnapshot,
    program: ProgramBundle,
    viewProjection: mat4,
    excludedPlotId?: string,
    bounds?: PointGizmoRenderBounds,
  ): void {
    const gl = this.gl!;
    for (const plotSnapshot of snapshot.plots) {
      const plot = plotSnapshot.plot;
      if (
        plot.id === excludedPlotId
        || !plot.visible
        || clamp01(plot.material.opacity) < 0.999
        || (bounds && !this.plotMayOverlapPointGizmo(plot, bounds, viewProjection))
      ) {
        continue;
      }
      this.drawShadowMeshWithMatrix(plot, program, viewProjection);
    }
    if (snapshot.scene.groundPlaneVisible && this.groundMesh?.vao && this.groundMesh.indexCount > 0) {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      const model = mat4.fromScaling(
        mat4.create(),
        vec3.fromValues(snapshot.scene.groundPlaneSize, snapshot.scene.groundPlaneSize, 1),
      );
      gl.uniformMatrix4fv(program.uniforms.u_model, false, model);
      gl.uniformMatrix4fv(program.uniforms.u_lightMatrix, false, viewProjection);
      gl.bindVertexArray(this.groundMesh.vao);
      gl.drawElements(gl.TRIANGLES, this.groundMesh.indexCount, gl.UNSIGNED_SHORT, 0);
      gl.bindVertexArray(null);
      gl.disable(gl.CULL_FACE);
    }
  }

  private renderDirectionalLightGizmos(snapshot: RendererSceneSnapshot, program: ProgramBundle): void {
    const visibleLights = snapshot.directionalLights.filter(({ light }) => light.visible);
    if (visibleLights.length === 0) {
      return;
    }
    const gl = this.gl!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.renderTargets.width, this.renderTargets.height);
    this.renderDirectionalLightArrows(snapshot);
    this.gizmoPointBuffer ??= createPointBuffer(gl);
    const pointBuffer = this.gizmoPointBuffer;
    if (!pointBuffer) {
      return;
    }
    this.bindPointGizmoPass(program);
    for (const { light } of visibleLights) {
      const selected = snapshot.selectedId === light.id;
      const { tail } = directionalLightGizmoEndpoints(light, this.camera.radius);
      this.drawPointGizmoHandle(
        program,
        pointBuffer,
        tail,
        directionalLightGizmoColor(light.color, selected),
        selected ? 345 : 300,
        selected,
      );
    }
    this.finishPointGizmoPass();
  }

  private bindPointGizmoPass(program: ProgramBundle): void {
    const gl = this.gl!;
    gl.useProgram(program.program);
    gl.uniformMatrix4fv(program.uniforms.u_view, false, this.viewMatrix);
    gl.uniformMatrix4fv(program.uniforms.u_projection, false, this.projectionMatrix);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  private drawPointGizmoHandle(
    program: ProgramBundle,
    pointBuffer: GpuLineBuffer,
    position: vec3,
    color: Float32Array,
    size: number,
    selected: boolean,
  ): void {
    const gl = this.gl!;
    const model = mat4.fromTranslation(mat4.create(), position);
    gl.uniformMatrix4fv(program.uniforms.u_model, false, model);
    gl.uniform1f(program.uniforms.u_size, size);
    gl.uniform3fv(program.uniforms.u_color, color);
    gl.uniform1f(program.uniforms.u_selected, selected ? 1 : 0);
    drawLineBuffer(gl, pointBuffer);
  }

  private finishPointGizmoPass(): void {
    const gl = this.gl!;
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.BLEND);
  }

  private renderDirectionalLightArrows(snapshot: RendererSceneSnapshot): void {
    const visibleLights = snapshot.directionalLights.filter(({ light }) => light.visible);
    if (visibleLights.length === 0) {
      return;
    }
    const gl = this.gl!;
    this.directionalGizmoLineBuffer ??= createDirectionalLightArrowBuffer(gl);
    const buffer = this.directionalGizmoLineBuffer;
    if (!buffer) {
      return;
    }
    const program = this.renderPrograms!.line;
    gl.useProgram(program.program);
    this.setLineProgramFrameUniforms();
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    for (const { light } of visibleLights) {
      const selected = snapshot.selectedId === light.id;
      const { tail, direction, length } = directionalLightGizmoEndpoints(light, this.camera.radius);
      const model = directionalLightGizmoModel(tail, direction, length);
      const color = directionalLightGizmoColor(light.color, selected);
      gl.uniformMatrix4fv(program.uniforms.u_model, false, model);
      gl.uniform4f(program.uniforms.u_color, color[0], color[1], color[2], selected ? 0.98 : 0.86);
      if (selected) {
        for (const [offsetX, offsetY] of [[-0.7, 0], [0.7, 0], [0, -0.7], [0, 0.7]] as const) {
          this.setLineScreenOffset(offsetX, offsetY);
          drawLineBuffer(gl, buffer);
        }
      }
      this.setLineScreenOffset(0, 0);
      drawLineBuffer(gl, buffer);
    }
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.BLEND);
  }

  private drawGroundPlane(
    scene: RendererSceneSnapshot['scene'],
    program: ProgramBundle,
    transparentPass: boolean,
    useProbe: boolean,
    usePlanarReflection = false,
  ): void {
    const gl = this.gl!;
    if (!this.groundMesh?.vao || this.groundMesh.indexCount <= 0) {
      return;
    }
    const size = scene.groundPlaneSize;
    const opacity = transparentPass ? 0.28 : 1;
    const model = mat4.fromScaling(mat4.create(), vec3.fromValues(size, size, 1));
    gl.uniformMatrix4fv(program.uniforms.u_model, false, model);
    gl.uniformMatrix3fv(program.uniforms.u_normalMatrix, false, mat3.normalFromMat4(mat3.create(), model) ?? mat3.create());
    gl.uniform3fv(program.uniforms.u_baseColor, hexToRgb(scene.groundPlaneColor));
    gl.uniform1f(program.uniforms.u_opacity, opacity);
    gl.uniform1f(program.uniforms.u_reflectiveness, scene.groundPlaneReflective ? 0.82 : 0.02);
    gl.uniform1f(program.uniforms.u_roughness, clamp(scene.groundPlaneRoughness, 0.04, 1));
    gl.uniform3f(program.uniforms.u_emissionColor, 0, 0, 0);
    gl.uniform1f(program.uniforms.u_emissionStrength, 0);
    gl.uniform1i(program.uniforms.u_usePlanarReflection, usePlanarReflection ? 1 : 0);
    this.bindContourUniforms(program, {
      xEnabled: false,
      xSpacing: 1,
      xColor: '#000000',
      yEnabled: false,
      ySpacing: 1,
      yColor: '#000000',
      zEnabled: false,
      zSpacing: 1,
      zColor: '#000000',
    });
    gl.uniform1i(program.uniforms.u_isTransparentPass, transparentPass ? 1 : 0);
    gl.uniform1i(program.uniforms.u_refractionEnabled, 0);
    gl.uniform1f(program.uniforms.u_ior, 1.45);
    gl.uniform1i(program.uniforms.u_useProbe, useProbe ? 1 : 0);
    gl.uniform3fv(program.uniforms.u_probeCenter, this.emptyProbeCenter);
    gl.bindVertexArray(this.groundMesh.vao);
    gl.drawElements(gl.TRIANGLES, this.groundMesh.indexCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    gl.uniform1i(program.uniforms.u_usePlanarReflection, 0);
  }

  private drawShadedMesh(
    plot: RenderableObject,
    program: ProgramBundle,
    transparentPass: boolean,
    probe: ProbeUsage,
    preTransform?: mat4,
    allowRefraction = true,
  ): void {
    const gl = this.gl!;
    const visual = this.plotVisuals.get(plot.id);
    if (!visual?.buffers.vao || visual.buffers.indexCount <= 0) {
      return;
    }
    const model = mat4.fromTranslation(mat4.create(), vec3.fromValues(
      plot.transform.position.x,
      plot.transform.position.y,
      plot.transform.position.z,
    ));
    if (preTransform) {
      mat4.multiply(model, preTransform, model);
    }
    const normalMatrix = mat3.normalFromMat4(mat3.create(), model) ?? mat3.create();
    gl.uniformMatrix4fv(program.uniforms.u_model, false, model);
    gl.uniformMatrix3fv(program.uniforms.u_normalMatrix, false, normalMatrix);
    gl.uniform3fv(program.uniforms.u_baseColor, hexToRgb(plot.material.baseColor));
    gl.uniform1f(program.uniforms.u_opacity, clamp01(plot.material.opacity));
    gl.uniform1f(program.uniforms.u_reflectiveness, clamp01(plot.material.reflectiveness));
    gl.uniform1f(program.uniforms.u_roughness, clamp(plot.material.roughness, 0.04, 1));
    gl.uniform3fv(program.uniforms.u_emissionColor, hexToRgb(plot.material.emissionColor ?? plot.material.baseColor));
    gl.uniform1f(
      program.uniforms.u_emissionStrength,
      materialEmissionEnabled(plot.material) ? clamp(plot.material.emissionStrength ?? 0, 0, 10) : 0,
    );
    this.bindContourUniforms(program, contourUniformState(plot));
    gl.uniform1i(program.uniforms.u_isTransparentPass, transparentPass ? 1 : 0);
    gl.uniform1i(
      program.uniforms.u_refractionEnabled,
      transparentPass && allowRefraction && plotUsesRefraction(plot) ? 1 : 0,
    );
    gl.uniform1f(program.uniforms.u_ior, clamp(plot.material.ior ?? 1.45, 1, 2.5));
    this.bindProbeUsage(program, probe);
    gl.bindVertexArray(visual.buffers.vao);
    gl.drawElements(gl.TRIANGLES, visual.buffers.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  private bindProbeUsage(program: ProgramBundle, probe: ProbeUsage): void {
    const gl = this.gl!;
    if (probe.useProbe && probe.texture) {
      bindTexture(gl, probe.texture, 4, gl.TEXTURE_CUBE_MAP);
      gl.uniform1i(program.uniforms.u_useProbe, 1);
      gl.uniform3fv(program.uniforms.u_probeCenter, probe.center);
      return;
    }
    gl.uniform1i(program.uniforms.u_useProbe, 0);
    gl.uniform3fv(program.uniforms.u_probeCenter, this.emptyProbeCenter);
  }

  private bindOpaqueMeshPass(
    snapshot: RendererSceneSnapshot,
    pointLights: ReadonlyArray<PointLightObject>,
    pointShadowLights: ReadonlyArray<ActivePointShadowLight>,
  ): void {
    const gl = this.gl!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.renderTargets.sceneFramebuffer);
    gl.viewport(0, 0, this.renderTargets.width, this.renderTargets.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.useProgram(this.renderPrograms!.mesh.program);
    this.bindSceneUniforms(this.renderPrograms!.mesh, snapshot, pointLights, pointShadowLights, true, true);
  }

  private bindTransparentMeshPass(
    snapshot: RendererSceneSnapshot,
    pointLights: ReadonlyArray<PointLightObject>,
    pointShadowLights: ReadonlyArray<ActivePointShadowLight>,
  ): void {
    const gl = this.gl!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.renderTargets.sceneFramebuffer);
    gl.viewport(0, 0, this.renderTargets.width, this.renderTargets.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.blendEquation(gl.FUNC_ADD);
    gl.useProgram(this.renderPrograms!.mesh.program);
    this.bindSceneUniforms(this.renderPrograms!.mesh, snapshot, pointLights, pointShadowLights, true, true);
  }

  private bindSceneUniforms(
    program: ProgramBundle,
    snapshot: RendererSceneSnapshot,
    pointLights: ReadonlyArray<PointLightObject>,
    pointShadowLights: ReadonlyArray<ActivePointShadowLight>,
    enableShadows: boolean,
    enableReflections: boolean,
    mirrorLightsZ = false,
  ): void {
    const gl = this.gl!;
    const cameraPosition = this.getCameraPosition();
    const scene = snapshot.scene;
    const lightZSign = mirrorLightsZ ? -1 : 1;

    gl.uniformMatrix4fv(program.uniforms.u_view, false, this.viewMatrix);
    gl.uniformMatrix4fv(program.uniforms.u_projection, false, this.projectionMatrix);
    gl.uniformMatrix4fv(program.uniforms.u_lightMatrix, false, this.lightViewProjection);
    gl.uniform3fv(program.uniforms.u_cameraPos, cameraPosition);
    gl.uniform3fv(
      program.uniforms.u_ambientColor,
      hexToRgb(scene.ambient.color).map((value) => value * (scene.ambient.enabled ? scene.ambient.intensity : 0)),
    );
    this.bindDirectionalLightUniforms(program, snapshot, lightZSign);
    gl.uniform1i(program.uniforms.u_pointCount, pointLights.length);
    const pointPositions = new Float32Array(MAX_POINT_LIGHTS * 3);
    const pointColors = new Float32Array(MAX_POINT_LIGHTS * 3);
    const pointIntensity = new Float32Array(MAX_POINT_LIGHTS);
    const pointRange = new Float32Array(MAX_POINT_LIGHTS);
    pointLights.forEach((light, index) => {
      pointPositions[index * 3] = light.position.x;
      pointPositions[index * 3 + 1] = light.position.y;
      pointPositions[index * 3 + 2] = light.position.z * lightZSign;
      const color = hexToRgb(light.color);
      pointColors[index * 3] = color[0];
      pointColors[index * 3 + 1] = color[1];
      pointColors[index * 3 + 2] = color[2];
      pointIntensity[index] = light.intensity;
      pointRange[index] = light.range;
    });
    gl.uniform3fv(program.uniforms.u_pointPositions, pointPositions);
    gl.uniform3fv(program.uniforms.u_pointColors, pointColors);
    gl.uniform1fv(program.uniforms.u_pointIntensity, pointIntensity);
    gl.uniform1fv(program.uniforms.u_pointRange, pointRange);
    const pointShadowSlots = new Int32Array(MAX_POINT_LIGHTS).fill(-1);
    pointShadowLights.forEach((activeLight) => {
      pointShadowSlots[activeLight.lightIndex] = activeLight.shadowSlot;
    });
    gl.uniform1iv(program.uniforms.u_pointShadowSlot, pointShadowSlots);
    gl.uniform1f(program.uniforms.u_shadowSoftness, clamp(scene.shadow.shadowSoftness, 0, 1));
    gl.uniform1i(program.uniforms.u_enableShadows, enableShadows && this.directionalShadowsEnabled(snapshot) ? 1 : 0);
    gl.uniform1i(program.uniforms.u_enableReflections, enableReflections ? 1 : 0);
    gl.uniform1f(program.uniforms.u_probeMaxLod, Math.max(0, Math.log2(this.probeRenderResources.size || DEFAULT_PROBE_SIZE) - 1));
    gl.uniform1f(program.uniforms.u_envMaxLod, Math.max(0, Math.log2(ENVIRONMENT_CUBEMAP_SIZE) - 1));
    gl.uniform2f(
      program.uniforms.u_viewportSize,
      Math.max(1, this.renderTargets.width),
      Math.max(1, this.renderTargets.height),
    );
    gl.uniform1f(
      program.uniforms.u_refractionMaxLod,
      Math.min(5, Math.max(0, Math.log2(Math.max(this.renderTargets.width, this.renderTargets.height, 1)))),
    );
    gl.uniform1i(program.uniforms.u_refractionEnabled, 0);
    gl.uniform1f(program.uniforms.u_ior, 1.45);
    gl.uniform1i(program.uniforms.u_pointGizmoCorrectionEnabled, 0);
    gl.uniform2f(program.uniforms.u_pointGizmoCorrectionOrigin, 0, 0);
    bindTexture(gl, this.shadowResources.directionalDepthTexture, 0, gl.TEXTURE_2D);
    bindTexture(gl, this.shadowResources.directionalTransDepthTexture, 1, gl.TEXTURE_2D);
    bindTexture(gl, this.shadowResources.directionalTransColorTexture, 2, gl.TEXTURE_2D);
    bindTexture(gl, this.environmentCubemap, 3, gl.TEXTURE_CUBE_MAP);
    // Unit 4 holds the per-plot probe; bind the environment as a safe default
    // so the sampler always sees a complete cube texture.
    bindTexture(gl, this.environmentCubemap, 4, gl.TEXTURE_CUBE_MAP);
    bindTexture(gl, this.renderTargets.refractionTexture, REFRACTION_TEXTURE_UNIT, gl.TEXTURE_2D);
    gl.uniform1i(program.uniforms.u_refractionSource, REFRACTION_TEXTURE_UNIT);
    bindTexture(gl, this.planarReflection.colorTexture, PLANAR_REFLECTION_TEXTURE_UNIT, gl.TEXTURE_2D);
    gl.uniform1i(program.uniforms.u_planarReflection, PLANAR_REFLECTION_TEXTURE_UNIT);
    gl.uniform1i(program.uniforms.u_usePlanarReflection, 0);
    gl.uniform1f(
      program.uniforms.u_planarMaxLod,
      Math.min(5, Math.max(0, Math.log2(Math.max(this.planarReflection.width, this.planarReflection.height, 1)))),
    );
    gl.uniform1i(program.uniforms.u_clipWorldZAbove, 0);
    const supportedPointShadowSlots = this.supportedPointShadowLightCount();
    for (let shadowSlot = 0; shadowSlot < supportedPointShadowSlots; shadowSlot += 1) {
      const unitBase = POINT_SHADOW_TEXTURE_UNIT_BASE + shadowSlot * POINT_SHADOW_TEXTURE_UNIT_STRIDE;
      bindTexture(gl, this.shadowResources.pointDepthCubemaps[shadowSlot], unitBase, gl.TEXTURE_CUBE_MAP);
      bindTexture(gl, this.shadowResources.pointTransDepthCubemaps[shadowSlot], unitBase + 1, gl.TEXTURE_CUBE_MAP);
      bindTexture(gl, this.shadowResources.pointTransColorCubemaps[shadowSlot], unitBase + 2, gl.TEXTURE_CUBE_MAP);
    }
    gl.uniform1i(program.uniforms.u_shadowDepth, 0);
    gl.uniform1i(program.uniforms.u_transShadowDepth, 1);
    gl.uniform1i(program.uniforms.u_transShadowColor, 2);
    gl.uniform1i(program.uniforms.u_environment, 3);
    gl.uniform1i(program.uniforms.u_probe, 4);
    const pointShadowUnit = (shadowSlot: number, channelOffset: number) =>
      shadowSlot < supportedPointShadowSlots
        ? POINT_SHADOW_TEXTURE_UNIT_BASE + shadowSlot * POINT_SHADOW_TEXTURE_UNIT_STRIDE + channelOffset
        : channelOffset;
    gl.uniform1i(program.uniforms.u_pointShadowDepth0, pointShadowUnit(0, 0));
    gl.uniform1i(program.uniforms.u_pointShadowTransDepth0, pointShadowUnit(0, 1));
    gl.uniform1i(program.uniforms.u_pointShadowTransColor0, pointShadowUnit(0, 2));
    gl.uniform1i(program.uniforms.u_pointShadowDepth1, pointShadowUnit(1, 0));
    gl.uniform1i(program.uniforms.u_pointShadowTransDepth1, pointShadowUnit(1, 1));
    gl.uniform1i(program.uniforms.u_pointShadowTransColor1, pointShadowUnit(1, 2));
    gl.uniform1i(program.uniforms.u_pointShadowDepth2, pointShadowUnit(2, 0));
    gl.uniform1i(program.uniforms.u_pointShadowTransDepth2, pointShadowUnit(2, 1));
    gl.uniform1i(program.uniforms.u_pointShadowTransColor2, pointShadowUnit(2, 2));
  }

  private bindDirectionalLightUniforms(
    program: ProgramBundle,
    snapshot: RendererSceneSnapshot,
    lightZSign = 1,
  ): void {
    const gl = this.gl!;
    const lights = this.collectRenderableDirectionalLights(snapshot);
    const colors = new Float32Array(MAX_DIRECTIONAL_LIGHTS * 3);
    const directions = new Float32Array(MAX_DIRECTIONAL_LIGHTS * 3);
    lights.forEach((light, index) => {
      const color = hexToRgb(light.color);
      colors[index * 3] = color[0] * light.intensity;
      colors[index * 3 + 1] = color[1] * light.intensity;
      colors[index * 3 + 2] = color[2] * light.intensity;
      directions[index * 3] = light.direction.x;
      directions[index * 3 + 1] = light.direction.y;
      directions[index * 3 + 2] = light.direction.z * lightZSign;
    });
    const shadowLight = this.activeDirectionalShadowLight(snapshot);
    gl.uniform1i(program.uniforms.u_dirCount, lights.length);
    gl.uniform3fv(program.uniforms.u_dirColors, colors);
    gl.uniform3fv(program.uniforms.u_dirDirections, directions);
    gl.uniform1i(program.uniforms.u_directionalShadowIndex, shadowLight?.lightIndex ?? -1);
    gl.uniform3f(
      program.uniforms.u_shadowDirDirection,
      shadowLight?.light.direction.x ?? -0.6,
      shadowLight?.light.direction.y ?? -0.4,
      (shadowLight?.light.direction.z ?? -1) * lightZSign,
    );
  }

  private prepareProbeForPlot(snapshot: RendererSceneSnapshot, plot: RenderableObject): ProbeUsage {
    if (!this.shouldUseProbeReflections(plot.material.reflectiveness)) {
      return noProbeUsage();
    }
    const probe = this.probePool.get(plot.id) ?? this.allocateProbeInstance(plot.id);
    if (!probe) {
      return noProbeUsage();
    }
    probe.lastUsedFrame = this.frameIndex;
    const nextSceneKey = this.buildProbeSceneKey(snapshot, plot.id);
    const nextCenter = vec3.fromValues(
      plot.transform.position.x,
      plot.transform.position.y,
      plot.transform.position.z,
    );
    const moved = vec3.distance(probe.center, nextCenter) > 0.05;
    const interval = probeRefreshInterval(snapshot.render.interactiveQuality);
    const stale = this.frameIndex - probe.lastRefreshFrame >= interval;
    const needsRefresh = probe.refreshCount === 0 || probe.sceneKey !== nextSceneKey || moved || stale;
    if (!needsRefresh) {
      return { useProbe: true, refreshed: false, texture: probe.cubemap, center: probe.center };
    }
    if (this.probeRefreshesThisFrame >= PROBE_REFRESHES_PER_FRAME) {
      // Out of refresh budget this frame; a previously rendered probe stays
      // usable while slightly stale, an empty one falls back to the environment.
      if (probe.refreshCount > 0) {
        return { useProbe: true, refreshed: false, texture: probe.cubemap, center: probe.center };
      }
      return noProbeUsage();
    }
    this.probeRefreshesThisFrame += 1;
    vec3.copy(probe.center, nextCenter);
    this.renderProbeCubemap(snapshot, probe, plot.id);
    probe.sceneKey = nextSceneKey;
    probe.lastRefreshFrame = this.frameIndex;
    probe.refreshCount += 1;
    this.probeRefreshTotal += 1;
    return { useProbe: true, refreshed: true, texture: probe.cubemap, center: probe.center };
  }

  private existingProbeUsageForPlot(plot: RenderableObject): ProbeUsage {
    if (!this.shouldUseProbeReflections(plot.material.reflectiveness)) {
      return noProbeUsage();
    }
    const probe = this.probePool.get(plot.id);
    if (!probe || probe.refreshCount <= 0) {
      return noProbeUsage();
    }
    probe.lastUsedFrame = this.frameIndex;
    return {
      useProbe: true,
      refreshed: false,
      texture: probe.cubemap,
      center: probe.center,
    };
  }

  private allocateProbeInstance(plotId: string): ProbeInstance | null {
    const gl = this.gl!;
    if (this.probePool.size >= MAX_REFLECTION_PROBES) {
      let lruId: string | null = null;
      let lruFrame = Number.POSITIVE_INFINITY;
      for (const [id, instance] of this.probePool.entries()) {
        if (instance.lastUsedFrame < lruFrame) {
          lruFrame = instance.lastUsedFrame;
          lruId = id;
        }
      }
      if (lruId === null || lruFrame >= this.frameIndex) {
        return null;
      }
      const evicted = this.probePool.get(lruId);
      deleteTexture(gl, evicted?.cubemap ?? null);
      this.probePool.delete(lruId);
    }
    const cubemap = createProbeCubemapTexture(gl, this.probeRenderResources.size);
    const instance: ProbeInstance = {
      cubemap,
      center: vec3.create(),
      sceneKey: '',
      lastRefreshFrame: -1,
      lastUsedFrame: this.frameIndex,
      refreshCount: 0,
    };
    this.probePool.set(plotId, instance);
    return instance;
  }

  private pruneProbePool(snapshot: RendererSceneSnapshot): void {
    if (this.probePool.size === 0) {
      return;
    }
    const gl = this.gl!;
    const reflectiveIds = new Set(
      snapshot.plots
        .filter(({ plot }) => plot.visible && this.shouldUseProbeReflections(plot.material.reflectiveness))
        .map(({ plot }) => plot.id),
    );
    for (const [plotId, instance] of this.probePool.entries()) {
      if (!reflectiveIds.has(plotId)) {
        deleteTexture(gl, instance.cubemap);
        this.probePool.delete(plotId);
      }
    }
  }

  private buildProbeSceneKey(snapshot: RendererSceneSnapshot, excludedPlotId: string): string {
    const { scene } = snapshot;
    const plotSignature = snapshot.plots
      .filter(({ plot }) => plot.id !== excludedPlotId)
      .map(({ plot, meshVersion }) => [
        plot.id,
        plot.visible ? 1 : 0,
        meshVersion,
        round3(plot.transform.position.x),
        round3(plot.transform.position.y),
        round3(plot.transform.position.z),
        round3(clamp01(plot.material.opacity)),
        round3(clamp01(plot.material.reflectiveness)),
        round3(clamp(plot.material.roughness, 0, 1)),
        plot.material.baseColor,
      ].join(':'))
      .join('|');
    return [
      scene.backgroundMode,
      scene.backgroundColor,
      scene.gradientTopColor,
      scene.gradientBottomColor,
      scene.groundPlaneVisible ? 1 : 0,
      round3(scene.groundPlaneSize),
      scene.groundPlaneColor,
      round3(clamp(scene.groundPlaneRoughness, 0, 1)),
      scene.groundPlaneReflective ? 1 : 0,
      scene.ambient.enabled ? 1 : 0,
      scene.ambient.color,
      round3(scene.ambient.intensity),
      snapshot.directionalLights.map(({ light }) => [
        light.id,
        light.color,
        round3(light.intensity),
        round3(light.direction.x),
        round3(light.direction.y),
        round3(light.direction.z),
      ].join(':')).join('|'),
      plotSignature,
    ].join('|');
  }

  private renderProbeCubemap(snapshot: RendererSceneSnapshot, probe: ProbeInstance, excludedPlotId: string | null): void {
    const gl = this.gl!;
    const size = this.probeRenderResources.size;
    const environmentFaces = this.getEnvironmentFacePixels(snapshot.scene, size);
    mat4.perspective(this.probeProjectionMatrix, Math.PI / 2, 1, 0.05, 120);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.probeRenderResources.framebuffer);
    gl.viewport(0, 0, size, size);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    for (let face = 0; face < POINT_SHADOW_FACE_VECTORS.length; face += 1) {
      uploadEnvironmentFaceToCubemap(
        gl,
        probe.cubemap,
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
        size,
        environmentFaces[face],
      );
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, probe.cubemap, 0);
      gl.clearDepth(1);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      const faceTarget = vec3.add(vec3.create(), probe.center, POINT_SHADOW_FACE_VECTORS[face].target);
      mat4.lookAt(this.probeViewMatrix, probe.center, faceTarget, POINT_SHADOW_FACE_VECTORS[face].up);
      gl.useProgram(this.renderPrograms!.mesh.program);
      this.bindProbeUniforms(snapshot, this.renderPrograms!.mesh, probe.center);
      if (snapshot.scene.groundPlaneVisible) {
        this.drawGroundPlane(snapshot.scene, this.renderPrograms!.mesh, false, false);
      }
      for (const plotSnapshot of snapshot.plots) {
        if (
          !plotSnapshot.plot.visible
          || plotSnapshot.plot.id === excludedPlotId
          || clamp01(plotSnapshot.plot.material.opacity) < 0.999
        ) {
          continue;
        }
        this.drawShadedMeshWithMatrices(
          plotSnapshot.plot,
          this.renderPrograms!.mesh,
          this.probeViewMatrix,
          this.probeProjectionMatrix,
          false,
          noProbeUsage(),
        );
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (probe.cubemap) {
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, probe.cubemap);
      gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  private getEnvironmentFacePixels(scene: RendererSceneSnapshot['scene'], size: number): Uint8Array[] {
    const key = `${buildEnvironmentSignature(scene)}|${size}`;
    const cached = this.environmentFacePixelCache.get(key);
    if (cached) {
      return cached;
    }
    const faces = Array.from({ length: 6 }, (_, face) => buildEnvironmentFacePixels(scene, size, face));
    if (this.environmentFacePixelCache.size >= 4) {
      this.environmentFacePixelCache.clear();
    }
    this.environmentFacePixelCache.set(key, faces);
    return faces;
  }

  private bindProbeUniforms(snapshot: RendererSceneSnapshot, program: ProgramBundle, probeCenter: vec3): void {
    const gl = this.gl!;
    const scene = snapshot.scene;
    gl.uniformMatrix4fv(program.uniforms.u_lightMatrix, false, this.lightViewProjection);
    gl.uniformMatrix4fv(program.uniforms.u_view, false, this.probeViewMatrix);
    gl.uniformMatrix4fv(program.uniforms.u_projection, false, this.probeProjectionMatrix);
    gl.uniform3fv(program.uniforms.u_cameraPos, probeCenter);
    gl.uniform3fv(
      program.uniforms.u_ambientColor,
      hexToRgb(scene.ambient.color).map((value) => value * (scene.ambient.enabled ? scene.ambient.intensity : 0)),
    );
    this.bindDirectionalLightUniforms(program, snapshot);
    gl.uniform1i(program.uniforms.u_pointCount, 0);
    gl.uniform1iv(program.uniforms.u_pointShadowSlot, new Int32Array(MAX_POINT_LIGHTS).fill(-1));
    gl.uniform1f(program.uniforms.u_shadowSoftness, 0);
    gl.uniform1i(program.uniforms.u_enableShadows, 0);
    gl.uniform1i(program.uniforms.u_enableReflections, 0);
    gl.uniform1i(program.uniforms.u_useProbe, 0);
    gl.uniform1i(program.uniforms.u_refractionEnabled, 0);
    gl.uniform1i(program.uniforms.u_usePlanarReflection, 0);
    gl.uniform1i(program.uniforms.u_clipWorldZAbove, 0);
    bindTexture(gl, this.environmentCubemap, 3, gl.TEXTURE_CUBE_MAP);
    bindTexture(gl, this.environmentCubemap, 4, gl.TEXTURE_CUBE_MAP);
    bindTexture(gl, this.renderTargets.refractionTexture, REFRACTION_TEXTURE_UNIT, gl.TEXTURE_2D);
    bindTexture(gl, this.planarReflection.colorTexture, PLANAR_REFLECTION_TEXTURE_UNIT, gl.TEXTURE_2D);
    gl.uniform1i(program.uniforms.u_environment, 3);
    gl.uniform1i(program.uniforms.u_probe, 4);
    gl.uniform1i(program.uniforms.u_refractionSource, REFRACTION_TEXTURE_UNIT);
    gl.uniform1i(program.uniforms.u_planarReflection, PLANAR_REFLECTION_TEXTURE_UNIT);
  }

  private drawShadedMeshWithMatrices(
    plot: RenderableObject,
    program: ProgramBundle,
    view: mat4,
    projection: mat4,
    transparentPass: boolean,
    probe: ProbeUsage,
  ): void {
    const gl = this.gl!;
    const visual = this.plotVisuals.get(plot.id);
    if (!visual?.buffers.vao || visual.buffers.indexCount <= 0) {
      return;
    }
    const model = mat4.fromTranslation(mat4.create(), vec3.fromValues(
      plot.transform.position.x,
      plot.transform.position.y,
      plot.transform.position.z,
    ));
    const normalMatrix = mat3.normalFromMat4(mat3.create(), model) ?? mat3.create();
    gl.uniformMatrix4fv(program.uniforms.u_view, false, view);
    gl.uniformMatrix4fv(program.uniforms.u_projection, false, projection);
    gl.uniformMatrix4fv(program.uniforms.u_model, false, model);
    gl.uniformMatrix3fv(program.uniforms.u_normalMatrix, false, normalMatrix);
    gl.uniform3fv(program.uniforms.u_baseColor, hexToRgb(plot.material.baseColor));
    gl.uniform1f(program.uniforms.u_opacity, clamp01(plot.material.opacity));
    gl.uniform1f(program.uniforms.u_reflectiveness, clamp01(plot.material.reflectiveness));
    gl.uniform1f(program.uniforms.u_roughness, clamp(plot.material.roughness, 0.04, 1));
    gl.uniform3fv(program.uniforms.u_emissionColor, hexToRgb(plot.material.emissionColor ?? plot.material.baseColor));
    gl.uniform1f(
      program.uniforms.u_emissionStrength,
      materialEmissionEnabled(plot.material) ? clamp(plot.material.emissionStrength ?? 0, 0, 10) : 0,
    );
    this.bindContourUniforms(program, contourUniformState(plot));
    gl.uniform1i(program.uniforms.u_isTransparentPass, transparentPass ? 1 : 0);
    gl.uniform1i(program.uniforms.u_refractionEnabled, 0);
    gl.uniform1f(program.uniforms.u_ior, clamp(plot.material.ior ?? 1.45, 1, 2.5));
    this.bindProbeUsage(program, probe);
    gl.bindVertexArray(visual.buffers.vao);
    gl.drawElements(gl.TRIANGLES, visual.buffers.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  private drawContourMesh(plot: RenderableObject, program: ProgramBundle): void {
    const gl = this.gl!;
    const visual = this.plotVisuals.get(plot.id);
    if (!visual?.buffers.vao || visual.buffers.indexCount <= 0 || !plotHasContours(plot)) {
      return;
    }
    const model = mat4.fromTranslation(mat4.create(), vec3.fromValues(
      plot.transform.position.x,
      plot.transform.position.y,
      plot.transform.position.z,
    ));
    const normalMatrix = mat3.normalFromMat4(mat3.create(), model) ?? mat3.create();
    gl.uniformMatrix4fv(program.uniforms.u_model, false, model);
    gl.uniformMatrix3fv(program.uniforms.u_normalMatrix, false, normalMatrix);
    gl.uniform3fv(program.uniforms.u_baseColor, hexToRgb(plot.material.baseColor));
    this.bindContourUniforms(program, contourUniformState(plot));
    gl.bindVertexArray(visual.buffers.vao);
    gl.drawElements(gl.TRIANGLES, visual.buffers.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  private bindContourUniforms(program: ProgramBundle, state: ContourUniformState): void {
    const gl = this.gl!;
    gl.uniform1i(program.uniforms.u_xContoursVisible, state.xEnabled ? 1 : 0);
    gl.uniform1f(program.uniforms.u_xContourSpacing, state.xSpacing);
    gl.uniform3fv(program.uniforms.u_xContourColor, hexToRgb(state.xColor));
    gl.uniform1i(program.uniforms.u_yContoursVisible, state.yEnabled ? 1 : 0);
    gl.uniform1f(program.uniforms.u_yContourSpacing, state.ySpacing);
    gl.uniform3fv(program.uniforms.u_yContourColor, hexToRgb(state.yColor));
    gl.uniform1i(program.uniforms.u_zContoursVisible, state.zEnabled ? 1 : 0);
    gl.uniform1f(program.uniforms.u_zContourSpacing, state.zSpacing);
    gl.uniform3fv(program.uniforms.u_zContourColor, hexToRgb(state.zColor));
  }

  private syncRenderDiagnostics(
    snapshot: RendererSceneSnapshot,
    pointShadowLights: ReadonlyArray<ActivePointShadowLight>,
  ): void {
    const reflectivePlots = snapshot.plots.filter(({ plot }) => plot.visible && plot.material.reflectiveness > 0.16).length;
    let readyProbeCount = 0;
    for (const instance of this.probePool.values()) {
      if (instance.refreshCount > 0) {
        readyProbeCount += 1;
      }
    }
    const probeReady = readyProbeCount > 0;
    const pointShadowCount = pointShadowLights.length;
    const opaqueShadowCasters = snapshot.plots.filter(({ plot }) => plot.visible && clamp01(plot.material.opacity) >= 0.999).length;
    const transmittanceShadowCasters = snapshot.plots.filter(({ plot }) => {
      const opacity = clamp01(plot.material.opacity);
      return plot.visible && opacity < 0.999;
    }).length;
    const directionalUsage = this.directionalShadowsEnabled(snapshot) ? 0.5 : 0;
    const pointCapacity = Math.max(1, this.supportedPointShadowLightCount());
    const pointUsage = pointShadowCount > 0 ? (pointShadowCount / pointCapacity) * 0.5 : 0;
    useAppStore.getState().setRenderDiagnostics({
      backend: 'webgl2',
      webglReady: Boolean(this.gl),
      plotCount: snapshot.plots.length,
      pointLightCount: snapshot.pointLights.length,
      transparentPlotCount: snapshot.plots.filter(({ plot }) => clamp01(plot.material.opacity) < 0.999).length,
      frameTimeMs: this.frameTimeMs,
      fps: this.fps,
      shadowMapResolution: snapshot.scene.shadow.shadowMapResolution,
      shadowAtlasUsage: clamp(directionalUsage + pointUsage, 0, 1),
      opaqueShadowCasters,
      transmittanceShadowCasters,
      pointShadowCount,
      activeProbeCount: readyProbeCount,
      outlineMode: snapshot.selectedId ? 'screen_space_edges' : 'disabled',
      reflectionSource: reflectivePlots > 0 && probeReady ? 'probe' : 'environment',
      reflectionProbeRefreshCount: this.probeRefreshTotal,
    });
  }

  private shouldUseProbeReflections(reflectiveness: number): boolean {
    return Boolean(this.probeRenderResources.framebuffer)
      && reflectiveness > 0.18;
  }

  private updateCameraMatrices(): void {
    const aspect = this.canvas.width > 0 ? this.canvas.width / Math.max(1, this.canvas.height) : 1;
    const position = this.getCameraPosition();
    mat4.lookAt(this.viewMatrix, position, this.camera.target, this.camera.upVector);
    if (this.orthographicProjection) {
      const { halfWidth, halfHeight } = this.getOrthoExtents();
      mat4.ortho(this.projectionMatrix, -halfWidth, halfWidth, -halfHeight, halfHeight, this.camera.minZ, this.camera.maxZ);
    } else {
      mat4.perspective(this.projectionMatrix, this.camera.fov, aspect, this.camera.minZ, this.camera.maxZ);
    }
  }

  private getOrthoExtents(): { halfWidth: number; halfHeight: number } {
    // Match the perspective frustum's height at the orbit target so toggling
    // projections keeps the subject at the same apparent size, and radius
    // (wheel zoom) keeps working as a zoom control.
    const aspect = this.canvas.width > 0 ? this.canvas.width / Math.max(1, this.canvas.height) : 1;
    const halfHeight = Math.max(0.01, this.camera.radius * Math.tan(this.camera.fov / 2));
    return { halfWidth: halfHeight * aspect, halfHeight };
  }

  private getCameraSnapshot(): RendererCameraLike {
    const position = this.getCameraPosition();
    const orthoExtents = this.orthographicProjection ? this.getOrthoExtents() : null;
    return {
      alpha: this.camera.alpha,
      beta: this.camera.beta,
      radius: this.camera.radius,
      position: { x: position[0], y: position[1], z: position[2] },
      target: { x: this.camera.target[0], y: this.camera.target[1], z: this.camera.target[2] },
      upVector: { x: this.camera.upVector[0], y: this.camera.upVector[1], z: this.camera.upVector[2] },
      fov: this.camera.fov,
      minZ: this.camera.minZ,
      maxZ: this.camera.maxZ,
      mode: this.orthographicProjection ? 1 : 0,
      orthoLeft: orthoExtents ? -orthoExtents.halfWidth : null,
      orthoRight: orthoExtents ? orthoExtents.halfWidth : null,
      orthoTop: orthoExtents ? orthoExtents.halfHeight : null,
      orthoBottom: orthoExtents ? -orthoExtents.halfHeight : null,
    };
  }

  private getCameraPosition(): vec3 {
    const x = this.camera.target[0] + this.camera.radius * Math.cos(this.camera.alpha) * Math.sin(this.camera.beta);
    const y = this.camera.target[1] + this.camera.radius * Math.sin(this.camera.alpha) * Math.sin(this.camera.beta);
    const z = this.camera.target[2] + this.camera.radius * Math.cos(this.camera.beta);
    return vec3.fromValues(x, y, z);
  }

  private computePickingRay(clientX: number, clientY: number): { origin: vec3; direction: vec3 } {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / Math.max(1, rect.height)) * 2;
    const invViewProj = mat4.invert(mat4.create(), mat4.multiply(mat4.create(), this.projectionMatrix, this.viewMatrix));
    if (!invViewProj) {
      return { origin: this.getCameraPosition(), direction: vec3.fromValues(0, 0, -1) };
    }
    const near = vec4.transformMat4(vec4.create(), vec4.fromValues(ndcX, ndcY, -1, 1), invViewProj);
    const far = vec4.transformMat4(vec4.create(), vec4.fromValues(ndcX, ndcY, 1, 1), invViewProj);
    const nearWorld = vec3.fromValues(near[0] / near[3], near[1] / near[3], near[2] / near[3]);
    const farWorld = vec3.fromValues(far[0] / far[3], far[1] / far[3], far[2] / far[3]);
    const direction = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), farWorld, nearWorld));
    return { origin: nearWorld, direction };
  }

  private attachInputHandlers(): void {
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    this.canvas.addEventListener('dblclick', (event) => {
      if (this.recordingGif) return;
      const hit = this.pickSceneObject(event.clientX, event.clientY);
      this.frameObject(hit?.id ?? null);
    });
    this.pointerDownListener = (event) => this.handlePointerDown(event);
    this.pointerMoveListener = (event) => this.handlePointerMove(event);
    this.pointerUpListener = (event) => this.handlePointerUp(event);
    this.wheelListener = (event) => {
      event.preventDefault();
      if (this.recordingGif) return;
      this.camera.radius *= Math.exp(event.deltaY * 0.0015);
      this.camera.radius = clamp(this.camera.radius, this.camera.lowerRadiusLimit, this.camera.upperRadiusLimit);
    };
    this.resizeListener = () => this.resizeViewport();
    this.canvas.addEventListener('pointerdown', this.pointerDownListener);
    window.addEventListener('pointermove', this.pointerMoveListener);
    window.addEventListener('pointerup', this.pointerUpListener);
    window.addEventListener('pointercancel', this.pointerUpListener);
    this.canvas.addEventListener('wheel', this.wheelListener, { passive: false });
    window.addEventListener('resize', this.resizeListener);
  }

  private capturePointer(pointerId: number): void {
    try {
      this.canvas.setPointerCapture(pointerId);
    } catch {
      // The pointer may already be released (e.g. pointercancel); capture is best-effort.
    }
  }

  private releasePointer(pointerId: number): void {
    try {
      this.canvas.releasePointerCapture(pointerId);
    } catch {
      // The pointer may already be released; releasing is best-effort.
    }
  }

  private handlePointerDown(event: PointerEvent): void {
    if (this.recordingGif) return;
    if (event.button === 2) {
      this.cameraDrag = {
        mode: event.shiftKey ? 'pan' : 'orbit',
        pointerId: event.pointerId,
        lastX: event.clientX,
        lastY: event.clientY,
      };
      this.capturePointer(event.pointerId);
      return;
    }
    if (event.button !== 0) {
      return;
    }
    const appState = useAppStore.getState();
    const lightCurvePick = appState.ui.lightCurveSourcePick;
    if (lightCurvePick) {
      const hit = this.pickParametricCurve(event.clientX, event.clientY);
      if (hit) {
        appState.setLightCurveSource(lightCurvePick.lightId, hit.id);
      }
      return;
    }
    const sourcePick = appState.ui.intersectionSourcePick;
    if (sourcePick) {
      const hit = this.pickSurfacePlot(event.clientX, event.clientY);
      if (hit) {
        appState.setIntersectionSource(sourcePick.intersectionId, sourcePick.slot, hit.id);
      }
      return;
    }
    const hit = this.pickSceneObject(event.clientX, event.clientY);
    useAppStore.getState().selectObject(hit?.id ?? null);
    if (!hit) {
      return;
    }
    const selected = useAppStore.getState().objects.find((obj) => obj.id === hit.id);
    if (!selected) {
      return;
    }
    if (selected.type === 'intersection') {
      return;
    }
    if (
      (selected.type === 'point_light' || selected.type === 'directional_light')
      && pinnedCurveForLight(selected, useAppStore.getState().objects)
    ) {
      return;
    }
    const startPosition = selected.type === 'plot'
      ? vec3.fromValues(selected.transform.position.x, selected.transform.position.y, selected.transform.position.z)
      : vec3.fromValues(selected.position.x, selected.position.y, selected.position.z);
    const ray = this.computePickingRay(event.clientX, event.clientY);
    if (event.shiftKey) {
      const axisZ = closestZOnVerticalAxisToRay(ray, startPosition[0], startPosition[1]);
      this.dragState = {
        objectId: hit.id,
        mode: 'z',
        startPosition,
        fixedX: startPosition[0],
        fixedY: startPosition[1],
        zOffset: axisZ === null ? 0 : startPosition[2] - axisZ,
        fallbackScale: this.camera.radius * 0.005,
        startClientY: event.clientY,
      };
      useAppStore.getState().beginObjectDragHistory(hit.id);
      this.capturePointer(event.pointerId);
      this.onObjectDragChange?.(true);
      return;
    }
    const planeHit = rayPlaneIntersectZ(ray, startPosition[2]);
    if (!planeHit) {
      return;
    }
    this.dragState = {
      objectId: hit.id,
      mode: 'xy',
      startPosition,
      planeZ: startPosition[2],
      startPoint: planeHit,
    };
    useAppStore.getState().beginObjectDragHistory(hit.id);
    this.capturePointer(event.pointerId);
    this.onObjectDragChange?.(true);
  }

  private handlePointerMove(event: PointerEvent): void {
    if (this.cameraDrag && this.cameraDrag.pointerId === event.pointerId) {
      const dx = event.clientX - this.cameraDrag.lastX;
      const dy = event.clientY - this.cameraDrag.lastY;
      this.cameraDrag.lastX = event.clientX;
      this.cameraDrag.lastY = event.clientY;
      if (this.cameraDrag.mode === 'orbit') {
        this.camera.alpha -= dx * 0.01;
        this.camera.beta = clamp(this.camera.beta - dy * 0.01, 0, Math.PI);
        vec3.set(this.camera.upVector, ...resolveOrbitUpVector(this.camera.alpha, this.camera.beta));
      } else {
        const scale = this.camera.radius * 0.002;
        const position = this.getCameraPosition();
        const forward = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), this.camera.target, position));
        const right = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), forward, this.camera.upVector));
        const up = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), right, forward));
        vec3.scaleAndAdd(this.camera.target, this.camera.target, right, -dx * scale);
        vec3.scaleAndAdd(this.camera.target, this.camera.target, up, dy * scale);
      }
      return;
    }
    if (!this.dragState) {
      return;
    }
    const current = useAppStore.getState().objects.find((obj) => obj.id === this.dragState?.objectId);
    if (!current) {
      return;
    }
    const ray = this.computePickingRay(event.clientX, event.clientY);
    if (this.dragState.mode === 'xy') {
      const hit = rayPlaneIntersectZ(ray, this.dragState.planeZ);
      if (!hit) {
        return;
      }
      const delta = vec3.sub(vec3.create(), hit, this.dragState.startPoint);
      const nextPosition = vec3.add(vec3.create(), this.dragState.startPosition, delta);
      useAppStore.getState().setObjectPosition(current.id, { x: nextPosition[0], y: nextPosition[1], z: nextPosition[2] });
      return;
    }
    const nextPosition = vec3.clone(this.dragState.startPosition);
    const axisZ = closestZOnVerticalAxisToRay(ray, this.dragState.fixedX, this.dragState.fixedY);
    if (axisZ === null) {
      const dy = event.clientY - this.dragState.startClientY;
      nextPosition[2] += -dy * this.dragState.fallbackScale;
    } else {
      nextPosition[2] = axisZ + this.dragState.zOffset;
    }
    useAppStore.getState().setObjectPosition(current.id, { x: nextPosition[0], y: nextPosition[1], z: nextPosition[2] });
  }

  private handlePointerUp(event: PointerEvent): void {
    if (this.cameraDrag && this.cameraDrag.pointerId === event.pointerId) {
      this.cameraDrag = null;
      this.releasePointer(event.pointerId);
    }
    if (this.dragState) {
      const dragObjectId = this.dragState.objectId;
      this.dragState = null;
      useAppStore.getState().commitObjectDragHistory(dragObjectId);
      this.releasePointer(event.pointerId);
      this.onObjectDragChange?.(false);
    }
  }

  private pickSceneObject(clientX: number, clientY: number): { id: string; distance: number } | null {
    const ray = this.computePickingRay(clientX, clientY);
    let bestId: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const light of this.pointLightVisuals.values()) {
      if (!shouldRenderPointLightGizmo(light.light)) {
        continue;
      }
      const distance = intersectSphere(ray.origin, ray.direction, light.light.position, Math.max(0.16, this.camera.radius * 0.02));
      if (distance !== null && distance < bestDistance) {
        bestId = light.light.id;
        bestDistance = distance;
      }
    }
    for (const { light } of this.latestSnapshot?.directionalLights ?? []) {
      if (!light.visible) {
        continue;
      }
      const { tail } = directionalLightGizmoEndpoints(light, this.camera.radius);
      const handleRadius = Math.max(0.16, this.camera.radius * 0.02);
      const distance = intersectSphere(ray.origin, ray.direction, tail, handleRadius);
      if (distance !== null && distance < bestDistance) {
        bestId = light.id;
        bestDistance = distance;
      }
    }
    for (const [plotId, visual] of this.plotVisuals.entries()) {
      const plot = this.latestSnapshot?.objects.find(
        (object): object is RenderableObject => isRenderableObject(object) && object.id === plotId,
      );
      if (!plot || !plot.visible) {
        continue;
      }
      const hit = intersectRayWithPlotGeometry(
        ray.origin,
        ray.direction,
        visual.geometry,
        plot.transform.position,
      );
      if (hit && hit.distance < bestDistance) {
        bestId = plotId;
        bestDistance = hit.distance;
      }
    }
    return bestId ? { id: bestId, distance: bestDistance } : null;
  }

  private pickSurfacePlot(clientX: number, clientY: number): { id: string; distance: number } | null {
    const ray = this.computePickingRay(clientX, clientY);
    let bestId: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [plotId, visual] of this.plotVisuals.entries()) {
      const plot = this.latestSnapshot?.objects.find(
        (object): object is Extract<SceneObject, { type: 'plot' }> => object.id === plotId && isSurfacePlot(object),
      );
      if (!plot?.visible) continue;
      const hit = intersectRayWithPlotGeometry(
        ray.origin,
        ray.direction,
        visual.geometry,
        plot.transform.position,
      );
      if (hit && hit.distance < bestDistance) {
        bestId = plotId;
        bestDistance = hit.distance;
      }
    }
    return bestId ? { id: bestId, distance: bestDistance } : null;
  }

  private pickParametricCurve(clientX: number, clientY: number): { id: string; distance: number } | null {
    const ray = this.computePickingRay(clientX, clientY);
    let bestId: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [plotId, visual] of this.plotVisuals.entries()) {
      const plot = this.latestSnapshot?.objects.find(
        (object): object is PlotObject => object.id === plotId && isParametricCurvePlot(object),
      );
      if (!plot?.visible) continue;
      const hit = intersectRayWithPlotGeometry(
        ray.origin,
        ray.direction,
        visual.geometry,
        plot.transform.position,
      );
      if (hit && hit.distance < bestDistance) {
        bestId = plotId;
        bestDistance = hit.distance;
      }
    }
    return bestId ? { id: bestId, distance: bestDistance } : null;
  }

  private ensureRenderTargets(width: number, height: number): void {
    const gl = this.gl!;
    if (this.renderTargets.width === width && this.renderTargets.height === height && this.renderTargets.sceneFramebuffer) {
      return;
    }
    this.deleteRenderTargets(gl);
    const hdrColorFormat = this.supportsFloatColorBuffers
      ? { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT }
      : { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
    const sceneColor = createColorTexture(gl, width, height, hdrColorFormat.internalFormat, hdrColorFormat.format, hdrColorFormat.type);
    const sceneDepth = createDepthTexture(gl, width, height);
    const sceneFramebuffer = createFramebuffer(gl, [
      { attachment: gl.COLOR_ATTACHMENT0, texture: sceneColor, target: gl.TEXTURE_2D },
      { attachment: gl.DEPTH_ATTACHMENT, texture: sceneDepth, target: gl.TEXTURE_2D },
    ]);
    const pointGizmoColor = createColorTexture(
      gl,
      POINT_GIZMO_TARGET_SIZE,
      POINT_GIZMO_TARGET_SIZE,
      hdrColorFormat.internalFormat,
      hdrColorFormat.format,
      hdrColorFormat.type,
      gl.NEAREST,
    );
    const pointGizmoDepth = createDepthStencilRenderbuffer(gl, POINT_GIZMO_TARGET_SIZE, POINT_GIZMO_TARGET_SIZE);
    const pointGizmoFramebuffer = createFramebuffer(gl, [
      { attachment: gl.COLOR_ATTACHMENT0, texture: pointGizmoColor, target: gl.TEXTURE_2D },
    ]);
    attachDepthStencilRenderbuffer(gl, pointGizmoFramebuffer, pointGizmoDepth);
    const pointGizmoSourceColor = createColorTexture(
      gl,
      POINT_GIZMO_TARGET_SIZE,
      POINT_GIZMO_TARGET_SIZE,
      gl.RGBA8,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      gl.NEAREST,
    );
    const pointGizmoSourceDepth = createDepthStencilRenderbuffer(
      gl,
      POINT_GIZMO_TARGET_SIZE,
      POINT_GIZMO_TARGET_SIZE,
    );
    const pointGizmoSourceFramebuffer = createFramebuffer(gl, [
      { attachment: gl.COLOR_ATTACHMENT0, texture: pointGizmoSourceColor, target: gl.TEXTURE_2D },
    ]);
    attachDepthStencilRenderbuffer(gl, pointGizmoSourceFramebuffer, pointGizmoSourceDepth);
    const bloomWidth = Math.max(1, Math.ceil(width / 2));
    const bloomHeight = Math.max(1, Math.ceil(height / 2));
    const bloomTextureA = createColorTexture(
      gl,
      bloomWidth,
      bloomHeight,
      hdrColorFormat.internalFormat,
      hdrColorFormat.format,
      hdrColorFormat.type,
    );
    const bloomFramebufferA = createFramebuffer(gl, [
      { attachment: gl.COLOR_ATTACHMENT0, texture: bloomTextureA, target: gl.TEXTURE_2D },
    ]);
    const bloomTextureB = createColorTexture(
      gl,
      bloomWidth,
      bloomHeight,
      hdrColorFormat.internalFormat,
      hdrColorFormat.format,
      hdrColorFormat.type,
    );
    const bloomFramebufferB = createFramebuffer(gl, [
      { attachment: gl.COLOR_ATTACHMENT0, texture: bloomTextureB, target: gl.TEXTURE_2D },
    ]);
    const refractionTexture = createColorTexture(gl, width, height, hdrColorFormat.internalFormat, hdrColorFormat.format, hdrColorFormat.type);
    gl.bindTexture(gl.TEXTURE_2D, refractionTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const refractionFramebuffer = createFramebuffer(gl, [
      { attachment: gl.COLOR_ATTACHMENT0, texture: refractionTexture, target: gl.TEXTURE_2D },
    ]);
    const maskTexture = createColorTexture(gl, width, height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    const maskDepth = createDepthTexture(gl, width, height);
    const maskFramebuffer = createFramebuffer(gl, [
      { attachment: gl.COLOR_ATTACHMENT0, texture: maskTexture, target: gl.TEXTURE_2D },
      { attachment: gl.DEPTH_ATTACHMENT, texture: maskDepth, target: gl.TEXTURE_2D },
    ]);
    this.renderTargets = {
      width,
      height,
      sceneFramebuffer,
      sceneColor,
      sceneDepth,
      pointGizmoFramebuffer,
      pointGizmoColor,
      pointGizmoDepth,
      pointGizmoSourceFramebuffer,
      pointGizmoSourceColor,
      pointGizmoSourceDepth,
      bloomWidth,
      bloomHeight,
      bloomFramebufferA,
      bloomTextureA,
      bloomFramebufferB,
      bloomTextureB,
      refractionFramebuffer,
      refractionTexture,
      maskFramebuffer,
      maskTexture,
      maskDepth,
    };
  }

  private deleteRenderTargets(gl: WebGL2RenderingContext): void {
    deleteFramebuffer(gl, this.renderTargets.sceneFramebuffer);
    deleteFramebuffer(gl, this.renderTargets.pointGizmoFramebuffer);
    deleteFramebuffer(gl, this.renderTargets.pointGizmoSourceFramebuffer);
    deleteFramebuffer(gl, this.renderTargets.bloomFramebufferA);
    deleteFramebuffer(gl, this.renderTargets.bloomFramebufferB);
    deleteFramebuffer(gl, this.renderTargets.refractionFramebuffer);
    deleteFramebuffer(gl, this.renderTargets.maskFramebuffer);
    deleteTexture(gl, this.renderTargets.sceneColor);
    deleteTexture(gl, this.renderTargets.sceneDepth);
    deleteTexture(gl, this.renderTargets.pointGizmoColor);
    deleteTexture(gl, this.renderTargets.pointGizmoSourceColor);
    if (this.renderTargets.pointGizmoDepth) gl.deleteRenderbuffer(this.renderTargets.pointGizmoDepth);
    if (this.renderTargets.pointGizmoSourceDepth) gl.deleteRenderbuffer(this.renderTargets.pointGizmoSourceDepth);
    deleteTexture(gl, this.renderTargets.bloomTextureA);
    deleteTexture(gl, this.renderTargets.bloomTextureB);
    deleteTexture(gl, this.renderTargets.refractionTexture);
    deleteTexture(gl, this.renderTargets.maskTexture);
    deleteTexture(gl, this.renderTargets.maskDepth);
    this.renderTargets = emptyRenderTargets();
  }

  private ensureShadowResources(size: number): void {
    const gl = this.gl!;
    const targetSize = clamp(Math.round(size), 256, 4096);
    if (this.shadowResources.size === targetSize && this.shadowResources.directionalFramebuffer) {
      return;
    }
    this.deleteShadowResources(gl);
    const directionalDepthTexture = createDepthTexture(gl, targetSize, targetSize);
    const directionalFramebuffer = createFramebuffer(gl, [
      { attachment: gl.DEPTH_ATTACHMENT, texture: directionalDepthTexture, target: gl.TEXTURE_2D },
    ]);
    const directionalTransDepthTexture = createDepthTexture(gl, targetSize, targetSize);
    const directionalTransColorTexture = createColorTexture(gl, targetSize, targetSize, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    const directionalTransFramebuffer = createFramebuffer(gl, [
      { attachment: gl.COLOR_ATTACHMENT0, texture: directionalTransColorTexture, target: gl.TEXTURE_2D },
      { attachment: gl.DEPTH_ATTACHMENT, texture: directionalTransDepthTexture, target: gl.TEXTURE_2D },
    ]);
    const pointFramebuffer = gl.createFramebuffer();
    const pointTransFramebuffer = gl.createFramebuffer();
    if (!pointFramebuffer || !pointTransFramebuffer) {
      throw new Error('Failed to create point shadow framebuffers');
    }
    this.shadowResources = {
      directionalFramebuffer,
      directionalDepthTexture,
      directionalTransFramebuffer,
      directionalTransDepthTexture,
      directionalTransColorTexture,
      pointFramebuffer,
      pointTransFramebuffer,
      pointDepthCubemaps: Array.from({ length: MAX_POINT_SHADOW_LIGHTS }, () => createDepthCubemap(gl, targetSize)),
      pointTransDepthCubemaps: Array.from({ length: MAX_POINT_SHADOW_LIGHTS }, () => createDepthCubemap(gl, targetSize)),
      pointTransColorCubemaps: Array.from({ length: MAX_POINT_SHADOW_LIGHTS }, () => createColorCubemap(gl, targetSize, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE)),
      size: targetSize,
    };
  }

  private deleteShadowResources(gl: WebGL2RenderingContext): void {
    deleteFramebuffer(gl, this.shadowResources.directionalFramebuffer);
    deleteFramebuffer(gl, this.shadowResources.directionalTransFramebuffer);
    deleteFramebuffer(gl, this.shadowResources.pointFramebuffer);
    deleteFramebuffer(gl, this.shadowResources.pointTransFramebuffer);
    deleteTexture(gl, this.shadowResources.directionalDepthTexture);
    deleteTexture(gl, this.shadowResources.directionalTransDepthTexture);
    deleteTexture(gl, this.shadowResources.directionalTransColorTexture);
    this.shadowResources.pointDepthCubemaps.forEach((texture) => deleteTexture(gl, texture));
    this.shadowResources.pointTransDepthCubemaps.forEach((texture) => deleteTexture(gl, texture));
    this.shadowResources.pointTransColorCubemaps.forEach((texture) => deleteTexture(gl, texture));
    this.shadowResources = emptyShadowResources();
  }

  private ensureEnvironmentCubemap(snapshot: RendererSceneSnapshot): void {
    const key = buildEnvironmentSignature(snapshot.scene);
    if (this.environmentCubemap && this.environmentKey === key) {
      return;
    }
    const gl = this.gl!;
    deleteTexture(gl, this.environmentCubemap);
    const faces = this.getEnvironmentFacePixels(snapshot.scene, ENVIRONMENT_CUBEMAP_SIZE);
    this.environmentCubemap = createEnvironmentCubemap(gl, faces, ENVIRONMENT_CUBEMAP_SIZE);
    this.environmentKey = key;
  }

  private deleteProbeResources(gl: WebGL2RenderingContext): void {
    for (const instance of this.probePool.values()) {
      deleteTexture(gl, instance.cubemap);
    }
    this.probePool.clear();
    deleteFramebuffer(gl, this.probeRenderResources.framebuffer);
    if (this.probeRenderResources.depthRenderbuffer) {
      gl.deleteRenderbuffer(this.probeRenderResources.depthRenderbuffer);
    }
    this.probeRenderResources = emptyProbeRenderResources();
    this.environmentFacePixelCache.clear();
  }

  private createFullscreenResources(gl: WebGL2RenderingContext): void {
    this.fullscreenVao = gl.createVertexArray();
    this.fullscreenBuffer = gl.createBuffer();
    gl.bindVertexArray(this.fullscreenVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fullscreenBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_TRIANGLE_VERTICES, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    const probeFramebuffer = gl.createFramebuffer();
    const probeDepth = gl.createRenderbuffer();
    if (!probeFramebuffer || !probeDepth) {
      throw new Error('Failed to create probe resources');
    }
    gl.bindRenderbuffer(gl.RENDERBUFFER, probeDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, DEFAULT_PROBE_SIZE, DEFAULT_PROBE_SIZE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, probeFramebuffer);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, probeDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.probeRenderResources = {
      framebuffer: probeFramebuffer,
      depthRenderbuffer: probeDepth,
      size: DEFAULT_PROBE_SIZE,
    };
    this.groundMesh = createGroundMesh(gl);
  }
}

function createPrograms(gl: WebGL2RenderingContext): RenderPrograms {
  const sharedMeshUniforms = [
    'u_model',
    'u_view',
    'u_projection',
    'u_normalMatrix',
    'u_lightMatrix',
    'u_cameraPos',
    'u_baseColor',
    'u_opacity',
    'u_reflectiveness',
    'u_roughness',
    'u_emissionColor',
    'u_emissionStrength',
    'u_xContoursVisible',
    'u_xContourSpacing',
    'u_xContourColor',
    'u_yContoursVisible',
    'u_yContourSpacing',
    'u_yContourColor',
    'u_zContoursVisible',
    'u_zContourSpacing',
    'u_zContourColor',
    'u_ambientColor',
    'u_dirCount',
    'u_dirColors',
    'u_dirDirections',
    'u_directionalShadowIndex',
    'u_shadowDirDirection',
    'u_pointCount',
    'u_pointPositions',
    'u_pointColors',
    'u_pointIntensity',
    'u_pointRange',
    'u_pointShadowSlot',
    'u_shadowSoftness',
    'u_shadowDepth',
    'u_transShadowDepth',
    'u_transShadowColor',
    'u_pointShadowDepth0',
    'u_pointShadowTransDepth0',
    'u_pointShadowTransColor0',
    'u_pointShadowDepth1',
    'u_pointShadowTransDepth1',
    'u_pointShadowTransColor1',
    'u_pointShadowDepth2',
    'u_pointShadowTransDepth2',
    'u_pointShadowTransColor2',
    'u_environment',
    'u_probe',
    'u_probeCenter',
    'u_useProbe',
    'u_probeMaxLod',
    'u_envMaxLod',
    'u_refractionSource',
    'u_refractionEnabled',
    'u_ior',
    'u_viewportSize',
    'u_refractionMaxLod',
    'u_planarReflection',
    'u_usePlanarReflection',
    'u_planarMaxLod',
    'u_clipWorldZAbove',
    'u_enableShadows',
    'u_enableReflections',
    'u_isTransparentPass',
    'u_pointGizmoCorrectionEnabled',
    'u_pointGizmoCorrectionOrigin',
  ];

  return {
    mesh: createProgramBundle(gl, meshVertexShaderSource, meshFragmentShaderSource, sharedMeshUniforms),
    contour: createProgramBundle(gl, contourVertexShaderSource, contourFragmentShaderSource, [
      'u_model',
      'u_view',
      'u_projection',
      'u_normalMatrix',
      'u_baseColor',
      'u_sceneDepth',
      'u_viewportSize',
      'u_xContoursVisible',
      'u_xContourSpacing',
      'u_xContourColor',
      'u_yContoursVisible',
      'u_yContourSpacing',
      'u_yContourColor',
      'u_zContoursVisible',
      'u_zContourSpacing',
      'u_zContourColor',
    ]),
    shadow: createProgramBundle(gl, shadowVertexShaderSource, shadowFragmentShaderSource, [
      'u_model',
      'u_lightMatrix',
    ]),
    pointGizmoSourceMask: createProgramBundle(
      gl,
      shadowVertexShaderSource,
      pointGizmoSourceMaskFragmentShaderSource,
      [
        'u_model',
        'u_lightMatrix',
        'u_sceneDepth',
        'u_viewportSize',
        'u_viewportOrigin',
      ],
    ),
    transShadow: createProgramBundle(gl, shadowVertexShaderSource, transparentShadowFragmentShaderSource, [
      'u_model',
      'u_lightMatrix',
      'u_baseColor',
      'u_opacity',
    ]),
    pointShadow: createProgramBundle(gl, pointShadowVertexShaderSource, pointShadowFragmentShaderSource, [
      'u_model',
      'u_lightMatrix',
      'u_lightPosition',
      'u_lightFar',
    ]),
    pointTransShadow: createProgramBundle(gl, pointShadowVertexShaderSource, pointTransparentShadowFragmentShaderSource, [
      'u_model',
      'u_lightMatrix',
      'u_lightPosition',
      'u_lightFar',
      'u_baseColor',
      'u_opacity',
    ]),
    line: createProgramBundle(gl, lineVertexShaderSource, lineFragmentShaderSource, [
      'u_model',
      'u_view',
      'u_projection',
      'u_viewport',
      'u_screenOffset',
      'u_color',
      'u_gizmoExclusionCount',
      'u_gizmoExclusions[0]',
    ]),
    gizmo: createProgramBundle(gl, pointGizmoVertexShaderSource, pointGizmoFragmentShaderSource, [
      'u_model',
      'u_view',
      'u_projection',
      'u_size',
      'u_color',
      'u_selected',
    ]),
    mask: createProgramBundle(gl, maskVertexShaderSource, maskFragmentShaderSource, [
      'u_model',
      'u_view',
      'u_projection',
    ]),
    bloomExtract: createProgramBundle(gl, fullscreenVertexShaderSource, bloomExtractFragmentShaderSource, [
      'u_sceneColor',
      'u_threshold',
    ]),
    bloomBlur: createProgramBundle(gl, fullscreenVertexShaderSource, bloomBlurFragmentShaderSource, [
      'u_source',
      'u_texelSize',
      'u_direction',
      'u_radius',
    ]),
    composite: createProgramBundle(gl, fullscreenVertexShaderSource, compositeFragmentShaderSource, [
      'u_sceneColor',
      'u_bloomColor',
      'u_bloomEnabled',
      'u_bloomStrength',
      'u_backgroundMode',
      'u_backgroundColor',
      'u_gradientTop',
      'u_gradientBottom',
      'u_toneMapping',
      'u_exposure',
    ]),
    outline: createProgramBundle(gl, fullscreenVertexShaderSource, outlineFragmentShaderSource, [
      'u_mask',
      'u_maskDepth',
      'u_sceneDepth',
      'u_texelSize',
      'u_gizmoExclusionCount',
      'u_gizmoExclusions[0]',
    ]),
    label: createProgramBundle(gl, axisLabelVertexShaderSource, axisLabelFragmentShaderSource, [
      'u_view',
      'u_projection',
      'u_viewport',
      'u_labelScale',
      'u_atlas',
    ]),
  };
}

const meshVertexShaderSource = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;

uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_projection;
uniform mat3 u_normalMatrix;
uniform mat4 u_lightMatrix;

out vec3 v_worldPosition;
out vec3 v_worldNormal;
out vec4 v_shadowPosition;

void main() {
  vec4 world = u_model * vec4(a_position, 1.0);
  v_worldPosition = world.xyz;
  v_worldNormal = normalize(u_normalMatrix * a_normal);
  v_shadowPosition = u_lightMatrix * world;
  gl_Position = u_projection * u_view * world;
}
`;

const contourVertexShaderSource = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;

uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_projection;
uniform mat3 u_normalMatrix;

out vec3 v_worldPosition;
out vec3 v_worldNormal;

void main() {
  vec4 world = u_model * vec4(a_position, 1.0);
  v_worldPosition = world.xyz;
  v_worldNormal = normalize(u_normalMatrix * a_normal);
  gl_Position = u_projection * u_view * world;
}
`;

const meshLightingPreamble = `
precision highp float;

uniform mat4 u_view;
uniform mat4 u_projection;
uniform vec3 u_cameraPos;
uniform vec3 u_baseColor;
uniform float u_opacity;
uniform float u_reflectiveness;
uniform float u_roughness;
uniform vec3 u_emissionColor;
uniform float u_emissionStrength;
uniform int u_xContoursVisible;
uniform float u_xContourSpacing;
uniform vec3 u_xContourColor;
uniform int u_yContoursVisible;
uniform float u_yContourSpacing;
uniform vec3 u_yContourColor;
uniform int u_zContoursVisible;
uniform float u_zContourSpacing;
uniform vec3 u_zContourColor;
uniform vec3 u_ambientColor;
uniform int u_dirCount;
uniform vec3 u_dirColors[${MAX_DIRECTIONAL_LIGHTS}];
uniform vec3 u_dirDirections[${MAX_DIRECTIONAL_LIGHTS}];
uniform int u_directionalShadowIndex;
uniform vec3 u_shadowDirDirection;
uniform int u_pointCount;
uniform vec3 u_pointPositions[${MAX_POINT_LIGHTS}];
uniform vec3 u_pointColors[${MAX_POINT_LIGHTS}];
uniform float u_pointIntensity[${MAX_POINT_LIGHTS}];
uniform float u_pointRange[${MAX_POINT_LIGHTS}];
uniform int u_pointShadowSlot[${MAX_POINT_LIGHTS}];
uniform float u_shadowSoftness;
uniform sampler2D u_shadowDepth;
uniform sampler2D u_transShadowDepth;
uniform sampler2D u_transShadowColor;
uniform samplerCube u_pointShadowDepth0;
uniform samplerCube u_pointShadowTransDepth0;
uniform samplerCube u_pointShadowTransColor0;
uniform samplerCube u_pointShadowDepth1;
uniform samplerCube u_pointShadowTransDepth1;
uniform samplerCube u_pointShadowTransColor1;
uniform samplerCube u_pointShadowDepth2;
uniform samplerCube u_pointShadowTransDepth2;
uniform samplerCube u_pointShadowTransColor2;
uniform samplerCube u_environment;
uniform samplerCube u_probe;
uniform vec3 u_probeCenter;
uniform int u_useProbe;
uniform float u_probeMaxLod;
uniform float u_envMaxLod;
uniform sampler2D u_refractionSource;
uniform int u_refractionEnabled;
uniform float u_ior;
uniform vec2 u_viewportSize;
uniform float u_refractionMaxLod;
uniform sampler2D u_planarReflection;
uniform int u_usePlanarReflection;
uniform float u_planarMaxLod;
uniform int u_clipWorldZAbove;
uniform int u_enableShadows;
uniform int u_enableReflections;
uniform int u_isTransparentPass;
uniform int u_pointGizmoCorrectionEnabled;
uniform vec2 u_pointGizmoCorrectionOrigin;

in vec3 v_worldPosition;
in vec3 v_worldNormal;
in vec4 v_shadowPosition;

float sampleShadow();

float sampleDepthTexture(sampler2D tex, vec2 uv) {
  return texture(tex, uv).r;
}

float samplePointShadowDepth(int shadowSlot, vec3 direction) {
  if (shadowSlot == 0) {
    return texture(u_pointShadowDepth0, direction).r;
  }
  if (shadowSlot == 1) {
    return texture(u_pointShadowDepth1, direction).r;
  }
  if (shadowSlot == 2) {
    return texture(u_pointShadowDepth2, direction).r;
  }
  return 1.0;
}

float samplePointTransShadowDepth(int shadowSlot, vec3 direction) {
  if (shadowSlot == 0) {
    return texture(u_pointShadowTransDepth0, direction).r;
  }
  if (shadowSlot == 1) {
    return texture(u_pointShadowTransDepth1, direction).r;
  }
  if (shadowSlot == 2) {
    return texture(u_pointShadowTransDepth2, direction).r;
  }
  return 1.0;
}

vec3 samplePointTransShadowColor(int shadowSlot, vec3 direction) {
  if (shadowSlot == 0) {
    return texture(u_pointShadowTransColor0, direction).rgb;
  }
  if (shadowSlot == 1) {
    return texture(u_pointShadowTransColor1, direction).rgb;
  }
  if (shadowSlot == 2) {
    return texture(u_pointShadowTransColor2, direction).rgb;
  }
  return vec3(1.0);
}

${shadowVisibilityGlsl}

float sampleShadow() {
  vec3 projected = v_shadowPosition.xyz / max(v_shadowPosition.w, 0.0001);
  projected = projected * 0.5 + 0.5;
  if (projected.x < 0.0 || projected.x > 1.0 || projected.y < 0.0 || projected.y > 1.0 || projected.z < 0.0 || projected.z > 1.0) {
    return 1.0;
  }
  float bias = 0.0018 + max(0.0, 1.0 - abs(dot(normalize(v_worldNormal), normalize(-u_shadowDirDirection)))) * 0.003;
  float softness = mix(0.65, 2.25, clamp(u_shadowSoftness, 0.0, 1.0));
  float visibility = 0.0;
  for (int y = -1; y <= 1; y += 1) {
    for (int x = -1; x <= 1; x += 1) {
      vec2 offset = vec2(float(x), float(y)) * softness / vec2(textureSize(u_shadowDepth, 0));
      float depth = sampleDepthTexture(u_shadowDepth, projected.xy + offset);
      visibility += projected.z - bias <= depth ? 1.0 : 0.0;
    }
  }
  visibility /= 9.0;
  float transDepth = sampleDepthTexture(u_transShadowDepth, projected.xy);
  vec3 transColor = texture(u_transShadowColor, projected.xy).rgb;
  if (projected.z - bias > transDepth && transDepth > 0.0 && transDepth < 1.0) {
    return combineShadowVisibility(visibility, dot(transColor, vec3(0.299, 0.587, 0.114)));
  }
  return visibility;
}

float samplePointShadow(int shadowSlot, vec3 N, vec3 pointDirection, vec3 lightVector, float distanceToLight, float lightRange) {
  if (shadowSlot < 0 || distanceToLight <= 0.0) {
    return 1.0;
  }
  float farPlane = max(lightRange, 0.001);
  if (distanceToLight >= farPlane) {
    return 1.0;
  }
  float bias = 0.0022 + (1.0 - max(dot(N, pointDirection), 0.0)) * 0.005;
  float currentDepth = distanceToLight / farPlane;
  vec3 sampleDirection = normalize(lightVector);
  vec3 referenceAxis = abs(sampleDirection.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  vec3 tangent = normalize(cross(referenceAxis, sampleDirection));
  vec3 bitangent = cross(sampleDirection, tangent);
  float cubeTexel = 1.0 / float(textureSize(u_pointShadowDepth0, 0).x);
  float angularRadius = cubeTexel * mix(0.0, 1.35, clamp(u_shadowSoftness, 0.0, 1.0));
  float visibility = 0.0;
  for (int sampleIndex = 0; sampleIndex < 5; sampleIndex += 1) {
    vec2 offset = vec2(0.0);
    if (sampleIndex == 1) {
      offset = vec2(angularRadius, 0.0);
    } else if (sampleIndex == 2) {
      offset = vec2(-angularRadius, 0.0);
    } else if (sampleIndex == 3) {
      offset = vec2(0.0, angularRadius);
    } else if (sampleIndex == 4) {
      offset = vec2(0.0, -angularRadius);
    }
    vec3 jitteredDirection = normalize(sampleDirection + tangent * offset.x + bitangent * offset.y);
    float depth = samplePointShadowDepth(shadowSlot, jitteredDirection);
    visibility += currentDepth - bias <= depth ? 1.0 : 0.0;
  }
  visibility /= 5.0;
  float transDepth = samplePointTransShadowDepth(shadowSlot, lightVector);
  vec3 transColor = samplePointTransShadowColor(shadowSlot, lightVector);
  if (currentDepth - bias > transDepth && transDepth > 0.0 && transDepth < 1.0) {
    return combineShadowVisibility(visibility, dot(transColor, vec3(0.299, 0.587, 0.114)));
  }
  return visibility;
}

vec3 applyLighting(vec3 N, vec3 V) {
  float roughness = clamp(u_roughness, 0.0, 1.0);
  float reflectiveness = clamp(u_reflectiveness, 0.0, 1.0);
  float diffuseScale = mix(1.0, 0.02, pow(reflectiveness, 1.2));
  float polished = pow(1.0 - roughness, 2.2);
  float specularCoreExponent = mix(220.0, 10.0, sqrt(roughness));
  float specularBloomExponent = mix(38.0, 2.8, sqrt(roughness));
  float viewFresnel = pow(1.0 - max(dot(N, V), 0.0), 5.0);
  float specularStrength = mix(0.14, 2.4, pow(reflectiveness, 0.92))
    * mix(1.85, 0.62, roughness)
    * mix(1.0, 2.4, polished);
  float bloomStrength = specularStrength * mix(0.9, 2.1, roughness);
  vec3 specularColor = vec3(mix(0.7, 1.45, reflectiveness));
  vec3 color = u_baseColor * u_ambientColor * diffuseScale;
  for (int i = 0; i < ${MAX_DIRECTIONAL_LIGHTS}; i += 1) {
    if (i >= u_dirCount) {
      break;
    }
    vec3 dir = normalize(-u_dirDirections[i]);
    float ndl = max(dot(N, dir), 0.0);
    float shadow = 1.0;
    if (u_enableShadows == 1 && i == u_directionalShadowIndex) {
      shadow = sampleShadow();
    }
    color += u_dirColors[i] * ndl * shadow * u_baseColor * diffuseScale;
    if (ndl > 0.0) {
      vec3 dirHalfVector = normalize(dir + V);
      float dirHalfDot = max(dot(N, dirHalfVector), 0.0);
      float dirSpecularCore = pow(dirHalfDot, specularCoreExponent);
      float dirSpecularBloom = pow(dirHalfDot, specularBloomExponent);
      color += u_dirColors[i] * shadow * specularColor
        * (dirSpecularCore * specularStrength + dirSpecularBloom * bloomStrength);
    }
  }
  for (int i = 0; i < ${MAX_POINT_LIGHTS}; i += 1) {
    if (i >= u_pointCount) {
      break;
    }
    vec3 lightVector = u_pointPositions[i] - v_worldPosition;
    float distanceToLight = length(lightVector);
    float lightRange = max(u_pointRange[i], 0.001);
    float attenuation = clamp(1.0 - distanceToLight / lightRange, 0.0, 1.0);
    vec3 pointDirection = distanceToLight > 0.0 ? lightVector / distanceToLight : vec3(0.0, 0.0, 1.0);
    float pointShadow = samplePointShadow(u_pointShadowSlot[i], N, pointDirection, -lightVector, distanceToLight, lightRange);
    float pointDiffuse = max(dot(N, pointDirection), 0.0);
    float lightEnergy = attenuation * (u_pointIntensity[i] * 0.025);
    color += u_pointColors[i] * pointDiffuse * lightEnergy * pointShadow * u_baseColor * diffuseScale;

    vec3 halfVector = normalize(pointDirection + V);
    float pointHalfDot = max(dot(N, halfVector), 0.0);
    float pointSpecularCore = pow(pointHalfDot, specularCoreExponent);
    float pointSpecularBloom = pow(pointHalfDot, specularBloomExponent);
    color += u_pointColors[i] * lightEnergy * pointShadow * specularColor
      * (pointSpecularCore * specularStrength + pointSpecularBloom * bloomStrength);
  }
  if (u_enableReflections == 1 && u_reflectiveness > 0.001) {
    vec3 reflected = reflect(-V, N);
    // Rougher surfaces sample blurrier mips for glossy rather than mirror reflections.
    float reflectionLod = pow(roughness, 0.8);
    vec3 reflectedColor;
    if (u_usePlanarReflection == 1) {
      // The planar texture holds the scene mirrored about z=0, rendered from
      // the main camera, so the fragment's own screen position looks up its
      // mirror image; empty texels fall back to the environment.
      vec2 screenUv = (gl_FragCoord.xy + u_pointGizmoCorrectionOrigin) / max(u_viewportSize, vec2(1.0));
      vec4 planarSample = textureLod(u_planarReflection, screenUv, reflectionLod * u_planarMaxLod);
      vec3 envReflected = textureLod(u_environment, reflected, reflectionLod * u_envMaxLod).rgb;
      reflectedColor = mix(envReflected, planarSample.rgb, clamp(planarSample.a, 0.0, 1.0));
    } else if (u_useProbe == 1) {
      reflectedColor = textureLod(u_probe, reflected, reflectionLod * u_probeMaxLod).rgb;
    } else {
      reflectedColor = textureLod(u_environment, reflected, reflectionLod * u_envMaxLod).rgb;
    }
    float baseReflectance = mix(0.02, 0.985, pow(reflectiveness, 1.2));
    float reflectionMix = clamp((baseReflectance + (1.0 - baseReflectance) * viewFresnel) * mix(1.0, 0.72, roughness), 0.0, 0.995);
    color = mix(color, reflectedColor, reflectionMix);
  }
  return color;
}

const float REFRACTION_THICKNESS = 0.75;

vec3 applyRefraction(vec3 N, vec3 V, vec3 litColor) {
  // Bend the eye ray entering the surface and sample the scene rendered so
  // far where the bent ray re-projects on screen; the surface itself then
  // writes an opaque pixel because the transmitted light is already baked in.
  float eta = 1.0 / max(u_ior, 1.0);
  vec3 refracted = refract(-V, N, eta);
  if (dot(refracted, refracted) < 1e-6) {
    refracted = reflect(-V, N);
  }
  vec2 screenUv = (gl_FragCoord.xy + u_pointGizmoCorrectionOrigin) / max(u_viewportSize, vec2(1.0));
  vec3 exitPoint = v_worldPosition + refracted * REFRACTION_THICKNESS;
  vec4 exitClip = u_projection * u_view * vec4(exitPoint, 1.0);
  vec2 refractedUv = exitClip.w > 0.0001 ? exitClip.xy / exitClip.w * 0.5 + 0.5 : screenUv;
  refractedUv = clamp(refractedUv, vec2(0.002), vec2(0.998));
  float roughness = clamp(u_roughness, 0.0, 1.0);
  float lod = pow(roughness, 0.9) * u_refractionMaxLod;
  vec4 refractedSample = textureLod(u_refractionSource, refractedUv, lod);
  // Pixels never rendered to have zero alpha; fall back to the environment
  // sampled along the bent ray so the backdrop still shows through.
  vec3 environmentBehind = textureLod(u_environment, refracted, pow(roughness, 0.9) * u_envMaxLod).rgb;
  vec3 background = mix(environmentBehind, refractedSample.rgb, clamp(refractedSample.a, 0.0, 1.0));
  float opacity = clamp(u_opacity, 0.0, 1.0);
  vec3 tint = mix(vec3(1.0), u_baseColor, opacity * 0.85);
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), 5.0);
  float surfaceMix = clamp(opacity + (1.0 - opacity) * max(fresnel, clamp(u_reflectiveness, 0.0, 1.0) * 0.22), 0.0, 1.0);
  return mix(background * tint, litColor, surfaceMix);
}

float contourAxisMask(float value, float spacing) {
  float safeSpacing = max(spacing, 0.1);
  float distanceToBand = abs(mod(value + safeSpacing * 0.5, safeSpacing) - safeSpacing * 0.5);
  float pixelSpan = max(fwidth(value), 0.0001);
  float halfWidth = pixelSpan * 0.7;
  return 1.0 - smoothstep(halfWidth, halfWidth + pixelSpan, distanceToBand);
}

vec4 resolveContourOverlay() {
  float xMask = u_xContoursVisible == 1 ? contourAxisMask(v_worldPosition.x, u_xContourSpacing) : 0.0;
  float yMask = u_yContoursVisible == 1 ? contourAxisMask(v_worldPosition.y, u_yContourSpacing) : 0.0;
  float zMask = u_zContoursVisible == 1 ? contourAxisMask(v_worldPosition.z, u_zContourSpacing) : 0.0;
  float weight = xMask + yMask + zMask;
  if (weight <= 0.0) {
    return vec4(0.0);
  }
  vec3 color = (
    u_xContourColor * xMask
    + u_yContourColor * yMask
    + u_zContourColor * zMask
  ) / weight;
  float mask = max(max(xMask, yMask), zMask);
  return vec4(color, mask);
}

vec3 applyContours(vec3 baseColor) {
  vec4 contour = resolveContourOverlay();
  if (contour.a <= 0.0) {
    return baseColor;
  }
  return mix(baseColor, contour.rgb, clamp(contour.a * 0.92, 0.0, 0.92));
}
`;

const meshFragmentShaderSource = `#version 300 es
${meshLightingPreamble}
out vec4 outColor;

void main() {
  if (u_pointGizmoCorrectionEnabled == 1) {
    vec2 sceneUv = (gl_FragCoord.xy + u_pointGizmoCorrectionOrigin) / max(u_viewportSize, vec2(1.0));
    if (gl_FragCoord.z < texture(u_refractionSource, sceneUv).r) {
      // The normal transparent pass already rendered this fragment; only
      // replay fragments that the pinned source curve incorrectly blocked.
      discard;
    }
  }
  if (u_clipWorldZAbove == 1 && v_worldPosition.z > 0.0005) {
    // Mirrored planar-reflection pass: fragments above the ground plane come
    // from geometry that was below it and must not appear in the mirror.
    discard;
  }
  vec3 N = normalize(gl_FrontFacing ? v_worldNormal : -v_worldNormal);
  vec3 V = normalize(u_cameraPos - v_worldPosition);
  vec3 litColor = applyLighting(N, V);
  vec3 emission = u_emissionColor * max(u_emissionStrength, 0.0);
  if (u_isTransparentPass == 1 && u_refractionEnabled == 1) {
    outColor = vec4(applyRefraction(N, V, litColor) + emission, 1.0);
    return;
  }
  vec3 emittedColor = litColor + emission;
  vec3 color = u_isTransparentPass == 1 ? emittedColor : applyContours(emittedColor);
  float alpha = u_isTransparentPass == 1 ? clamp(u_opacity, 0.0, 0.995) : 1.0;
  outColor = vec4(color, alpha);
}
`;

const contourFragmentShaderSource = `#version 300 es
precision highp float;

uniform vec3 u_baseColor;
uniform sampler2D u_sceneDepth;
uniform vec2 u_viewportSize;
uniform int u_xContoursVisible;
uniform float u_xContourSpacing;
uniform vec3 u_xContourColor;
uniform int u_yContoursVisible;
uniform float u_yContourSpacing;
uniform vec3 u_yContourColor;
uniform int u_zContoursVisible;
uniform float u_zContourSpacing;
uniform vec3 u_zContourColor;

in vec3 v_worldPosition;
in vec3 v_worldNormal;

out vec4 outColor;

float contourAxisMask(float value, float spacing) {
  float safeSpacing = max(spacing, 0.1);
  float distanceToBand = abs(mod(value + safeSpacing * 0.5, safeSpacing) - safeSpacing * 0.5);
  float pixelSpan = max(fwidth(value), 0.0001);
  float halfWidth = pixelSpan * 0.7;
  return 1.0 - smoothstep(halfWidth, halfWidth + pixelSpan, distanceToBand);
}

vec4 resolveContourOverlay() {
  float xMask = u_xContoursVisible == 1 ? contourAxisMask(v_worldPosition.x, u_xContourSpacing) : 0.0;
  float yMask = u_yContoursVisible == 1 ? contourAxisMask(v_worldPosition.y, u_yContourSpacing) : 0.0;
  float zMask = u_zContoursVisible == 1 ? contourAxisMask(v_worldPosition.z, u_zContourSpacing) : 0.0;
  float weight = xMask + yMask + zMask;
  if (weight <= 0.0) {
    return vec4(0.0);
  }
  vec3 color = (
    u_xContourColor * xMask
    + u_yContourColor * yMask
    + u_zContourColor * zMask
  ) / weight;
  float mask = max(max(xMask, yMask), zMask);
  return vec4(color, mask);
}

void main() {
  vec2 screenUv = gl_FragCoord.xy / max(u_viewportSize, vec2(1.0));
  float sceneDepth = texture(u_sceneDepth, screenUv).r;
  if (gl_FragCoord.z > sceneDepth + 0.0015) {
    // Occluded by opaque geometry (transparent surfaces do not write depth).
    discard;
  }
  vec4 contour = resolveContourOverlay();
  float alpha = clamp(contour.a * 0.84, 0.0, 0.84);
  if (alpha <= 0.001) {
    discard;
  }
  outColor = vec4(contour.rgb, alpha);
}
`;

const shadowVertexShaderSource = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
uniform mat4 u_model;
uniform mat4 u_lightMatrix;
void main() {
  gl_Position = u_lightMatrix * u_model * vec4(a_position, 1.0);
}
`;

const shadowFragmentShaderSource = `#version 300 es
precision highp float;
void main() {}
`;

const pointGizmoSourceMaskFragmentShaderSource = `#version 300 es
precision highp float;

uniform sampler2D u_sceneDepth;
uniform vec2 u_viewportSize;
uniform vec2 u_viewportOrigin;

void main() {
  vec2 sceneUv = (gl_FragCoord.xy + u_viewportOrigin) / max(u_viewportSize, vec2(1.0));
  if (gl_FragCoord.z > texture(u_sceneDepth, sceneUv).r + 0.000001) {
    discard;
  }
}
`;

const transparentShadowFragmentShaderSource = `#version 300 es
precision highp float;
${shadowVisibilityGlsl}
uniform vec3 u_baseColor;
uniform float u_opacity;
out vec4 outColor;
void main() {
  vec3 transmittance = resolveTransparentShadowTransmittance(u_baseColor, u_opacity);
  outColor = vec4(transmittance, 1.0);
}
`;

const pointShadowVertexShaderSource = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;

uniform mat4 u_model;
uniform mat4 u_lightMatrix;

out vec3 v_worldPosition;

void main() {
  vec4 world = u_model * vec4(a_position, 1.0);
  v_worldPosition = world.xyz;
  gl_Position = u_lightMatrix * world;
}
`;

const pointShadowFragmentShaderSource = `#version 300 es
precision highp float;

uniform vec3 u_lightPosition;
uniform float u_lightFar;

in vec3 v_worldPosition;

void main() {
  float lightDistance = length(v_worldPosition - u_lightPosition);
  gl_FragDepth = clamp(lightDistance / max(u_lightFar, 0.001), 0.0, 1.0);
}
`;

const pointTransparentShadowFragmentShaderSource = `#version 300 es
precision highp float;
${shadowVisibilityGlsl}

uniform vec3 u_lightPosition;
uniform float u_lightFar;
uniform vec3 u_baseColor;
uniform float u_opacity;

in vec3 v_worldPosition;

out vec4 outColor;

void main() {
  float lightDistance = length(v_worldPosition - u_lightPosition);
  gl_FragDepth = clamp(lightDistance / max(u_lightFar, 0.001), 0.0, 1.0);
  vec3 transmittance = resolveTransparentShadowTransmittance(u_baseColor, u_opacity);
  outColor = vec4(transmittance, 1.0);
}
`;

const lineVertexShaderSource = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_projection;
uniform vec2 u_viewport;
uniform vec2 u_screenOffset;
void main() {
  vec4 clip = u_projection * u_view * u_model * vec4(a_position, 1.0);
  vec2 safeViewport = max(u_viewport, vec2(1.0));
  clip.xy += (u_screenOffset / safeViewport) * 2.0 * clip.w;
  gl_Position = clip;
}
`;

const lineFragmentShaderSource = `#version 300 es
precision highp float;
uniform vec4 u_color;
uniform int u_gizmoExclusionCount;
uniform vec3 u_gizmoExclusions[${MAX_POINT_GIZMO_OVERLAY_EXCLUSIONS}];
out vec4 outColor;
void main() {
  for (int index = 0; index < ${MAX_POINT_GIZMO_OVERLAY_EXCLUSIONS}; index += 1) {
    if (index >= u_gizmoExclusionCount) {
      break;
    }
    if (distance(gl_FragCoord.xy, u_gizmoExclusions[index].xy) <= u_gizmoExclusions[index].z) {
      discard;
    }
  }
  outColor = u_color;
}
`;

const pointGizmoVertexShaderSource = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;

uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_projection;
uniform float u_size;

void main() {
  vec4 world = u_model * vec4(a_position, 1.0);
  vec4 clip = u_projection * u_view * world;
  gl_Position = clip;
  gl_PointSize = clamp(u_size / max(clip.w, 0.001), 10.0, 30.0);
}
`;

const pointGizmoFragmentShaderSource = `#version 300 es
precision highp float;

uniform vec3 u_color;
uniform float u_selected;

out vec4 outColor;

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float radius2 = dot(uv, uv);
  if (radius2 > 1.0) {
    discard;
  }

  float radius = sqrt(radius2);
  float z = sqrt(max(0.0, 1.0 - radius2));
  vec3 normal = normalize(vec3(uv.x, -uv.y, z));
  vec3 lightDir = normalize(vec3(-0.45, 0.65, 0.7));
  float diffuse = 0.38 + max(dot(normal, lightDir), 0.0) * 0.62;
  float rim = pow(1.0 - max(normal.z, 0.0), 1.8);
  float specular = pow(max(dot(reflect(-lightDir, normal), vec3(0.0, 0.0, 1.0)), 0.0), 28.0);
  float ring = smoothstep(0.72, 0.92, radius) * (1.0 - smoothstep(0.92, 1.0, radius));

  vec3 color = u_color * diffuse;
  color += vec3(1.0, 0.98, 0.9) * specular * 0.55;
  color = mix(color, vec3(1.0, 0.95, 0.62), rim * 0.12);
  color += vec3(1.0, 0.97, 0.82) * ring * mix(0.18, 0.5, u_selected);

  float alpha = 1.0 - smoothstep(0.84, 1.0, radius);
  alpha = max(alpha, ring * mix(0.2, 0.45, u_selected));
  outColor = vec4(color, alpha);
}
`;

const axisLabelVertexShaderSource = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_center;
layout(location = 1) in vec2 a_corner;
layout(location = 2) in vec2 a_uv;
uniform mat4 u_view;
uniform mat4 u_projection;
uniform vec2 u_viewport;
uniform float u_labelScale;
out vec2 v_uv;
void main() {
  vec4 clip = u_projection * u_view * vec4(a_center, 1.0);
  vec2 safeViewport = max(u_viewport, vec2(1.0));
  clip.xy += (a_corner * u_labelScale / safeViewport) * 2.0 * clip.w;
  v_uv = a_uv;
  gl_Position = clip;
}
`;

const axisLabelFragmentShaderSource = `#version 300 es
precision highp float;
uniform sampler2D u_atlas;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 texel = texture(u_atlas, v_uv);
  if (texel.a < 0.01) {
    discard;
  }
  outColor = texel;
}
`;

const maskVertexShaderSource = lineVertexShaderSource;

const maskFragmentShaderSource = `#version 300 es
precision highp float;
out vec4 outColor;
void main() {
  outColor = vec4(1.0);
}
`;

const fullscreenVertexShaderSource = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const bloomExtractFragmentShaderSource = `#version 300 es
precision highp float;
uniform sampler2D u_sceneColor;
uniform float u_threshold;
in vec2 v_uv;
out vec4 outColor;

void main() {
  vec3 color = texture(u_sceneColor, v_uv).rgb;
  float brightness = max(max(color.r, color.g), color.b);
  float knee = max(0.05, u_threshold * 0.25);
  float contribution = smoothstep(u_threshold - knee, u_threshold + knee, brightness);
  outColor = vec4(color * contribution, 1.0);
}
`;

const bloomBlurFragmentShaderSource = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform vec2 u_texelSize;
uniform vec2 u_direction;
uniform float u_radius;
in vec2 v_uv;
out vec4 outColor;

void main() {
  vec2 offset = u_texelSize * u_direction * max(u_radius, 0.01);
  vec3 color = texture(u_source, v_uv).rgb * 0.227027;
  color += texture(u_source, v_uv + offset * 1.384615).rgb * 0.316216;
  color += texture(u_source, v_uv - offset * 1.384615).rgb * 0.316216;
  color += texture(u_source, v_uv + offset * 3.230769).rgb * 0.070270;
  color += texture(u_source, v_uv - offset * 3.230769).rgb * 0.070270;
  outColor = vec4(color, 1.0);
}
`;

const compositeFragmentShaderSource = `#version 300 es
precision highp float;
uniform sampler2D u_sceneColor;
uniform sampler2D u_bloomColor;
uniform int u_bloomEnabled;
uniform float u_bloomStrength;
uniform int u_backgroundMode;
uniform vec3 u_backgroundColor;
uniform vec3 u_gradientTop;
uniform vec3 u_gradientBottom;
uniform int u_toneMapping;
uniform float u_exposure;
in vec2 v_uv;
out vec4 outColor;

vec3 toneMap(vec3 color) {
  color *= u_exposure;
  if (u_toneMapping == 1) {
    color = clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
  } else if (u_toneMapping == 2) {
    color = color / (color + vec3(1.0));
  }
  return color;
}

void main() {
  vec4 scene = texture(u_sceneColor, v_uv);
  vec3 bloom = u_bloomEnabled == 1 ? texture(u_bloomColor, v_uv).rgb * u_bloomStrength : vec3(0.0);
  vec3 background = u_backgroundMode == 1
    ? mix(u_gradientBottom, u_gradientTop, clamp(v_uv.y, 0.0, 1.0))
    : u_backgroundColor;
  vec3 mappedScene = toneMap(scene.rgb);
  vec3 mappedWithBloom = toneMap(scene.rgb + bloom);
  vec3 bloomContribution = max(mappedWithBloom - mappedScene, vec3(0.0));
  vec3 color = mix(background, mappedScene, clamp(scene.a, 0.0, 1.0)) + bloomContribution;
  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

const outlineFragmentShaderSource = `#version 300 es
precision highp float;
uniform sampler2D u_mask;
uniform sampler2D u_maskDepth;
uniform sampler2D u_sceneDepth;
uniform vec2 u_texelSize;
uniform int u_gizmoExclusionCount;
uniform vec3 u_gizmoExclusions[${MAX_POINT_GIZMO_OVERLAY_EXCLUSIONS}];
in vec2 v_uv;
out vec4 outColor;

float sampleMask(vec2 uv) {
  return step(0.5, texture(u_mask, uv).a);
}

void main() {
  for (int index = 0; index < ${MAX_POINT_GIZMO_OVERLAY_EXCLUSIONS}; index += 1) {
    if (index >= u_gizmoExclusionCount) {
      break;
    }
    if (distance(gl_FragCoord.xy, u_gizmoExclusions[index].xy) <= u_gizmoExclusions[index].z) {
      outColor = vec4(0.0);
      return;
    }
  }
  float center = sampleMask(v_uv);
  float selectedDepth = texture(u_maskDepth, v_uv).r;
  float sceneDepth = texture(u_sceneDepth, v_uv).r;
  if (center < 0.5 || selectedDepth >= 1.0 || selectedDepth > sceneDepth + 0.0005) {
    outColor = vec4(0.0);
    return;
  }
  float edge = 0.0;
  for (int y = -1; y <= 1; y += 1) {
    for (int x = -1; x <= 1; x += 1) {
      vec2 offset = vec2(float(x), float(y)) * u_texelSize;
      edge = max(edge, abs(center - sampleMask(v_uv + offset)));
    }
  }
  outColor = edge > 0.01 ? vec4(0.86, 0.93, 1.0, 0.9) : vec4(0.0);
}
`;

function createProgramBundle(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  uniformNames: string[],
): ProgramBundle {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) {
    throw new Error('Failed to create WebGL program');
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) ?? 'Unknown link error';
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    gl.deleteProgram(program);
    throw new Error(`WebGL program link failed: ${info}`);
  }
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  uniformNames.forEach((name) => {
    uniforms[name] = gl.getUniformLocation(program, name);
  });
  return { program, uniforms };
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('Failed to create shader');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) ?? 'Unknown shader compile error';
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${info}`);
  }
  return shader;
}

function createLineBuffer(gl: WebGL2RenderingContext, positions: Float32Array, primitive: number): GpuLineBuffer | null {
  if (positions.length < 6) {
    return null;
  }
  const vao = gl.createVertexArray();
  const vertexBuffer = gl.createBuffer();
  if (!vao || !vertexBuffer) {
    return null;
  }
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, vertexBuffer, vertexCount: positions.length / 3, primitive };
}

function createPointBuffer(gl: WebGL2RenderingContext): GpuLineBuffer | null {
  const vao = gl.createVertexArray();
  const vertexBuffer = gl.createBuffer();
  if (!vao || !vertexBuffer) {
    return null;
  }
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, vertexBuffer, vertexCount: 1, primitive: gl.POINTS };
}

function createDirectionalLightArrowBuffer(gl: WebGL2RenderingContext): GpuLineBuffer | null {
  return createLineBuffer(gl, new Float32Array([
    0, 0, 0, 1, 0, 0,
    1, 0, 0, 0.76, 0.13, 0,
    1, 0, 0, 0.76, -0.13, 0,
    1, 0, 0, 0.76, 0, 0.13,
    1, 0, 0, 0.76, 0, -0.13,
  ]), gl.LINES);
}

function drawLineBuffer(gl: WebGL2RenderingContext, buffer: GpuLineBuffer): void {
  gl.bindVertexArray(buffer.vao);
  gl.drawArrays(buffer.primitive, 0, buffer.vertexCount);
  gl.bindVertexArray(null);
}

function deleteLineBuffer(gl: WebGL2RenderingContext, buffer: GpuLineBuffer | null): void {
  if (!buffer) {
    return;
  }
  deleteVertexArray(gl, buffer.vao);
  deleteBuffer(gl, buffer.vertexBuffer);
}

function createFramebuffer(
  gl: WebGL2RenderingContext,
  attachments: Array<{ attachment: number; texture: WebGLTexture | null; target: number }>,
): WebGLFramebuffer {
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) {
    throw new Error('Failed to create framebuffer');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  attachments.forEach(({ attachment, texture, target }) => {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, target, texture, 0);
  });
  const colorAttachments = attachments
    .filter((attachment) => attachment.attachment >= gl.COLOR_ATTACHMENT0 && attachment.attachment <= gl.COLOR_ATTACHMENT15)
    .map((attachment) => attachment.attachment);
  if (colorAttachments.length > 0) {
    gl.drawBuffers(colorAttachments);
  }
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    throw new Error('Framebuffer is incomplete');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return framebuffer;
}

function createDepthStencilRenderbuffer(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): WebGLRenderbuffer {
  const renderbuffer = gl.createRenderbuffer();
  if (!renderbuffer) {
    throw new Error('Failed to create depth-stencil renderbuffer');
  }
  gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, width, height);
  gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  return renderbuffer;
}

function attachDepthStencilRenderbuffer(
  gl: WebGL2RenderingContext,
  framebuffer: WebGLFramebuffer,
  renderbuffer: WebGLRenderbuffer,
): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, renderbuffer);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    throw new Error('Framebuffer is incomplete after attaching depth-stencil');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function createColorTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  internalFormat: number,
  format: number,
  type: number,
  filter: number = gl.LINEAR,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error('Failed to create color texture');
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function createDepthTexture(gl: WebGL2RenderingContext, width: number, height: number): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error('Failed to create depth texture');
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, width, height, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function createColorCubemap(
  gl: WebGL2RenderingContext,
  size: number,
  internalFormat: number,
  format: number,
  type: number,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error('Failed to create color cubemap');
  }
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
  for (let face = 0; face < 6; face += 1) {
    gl.texImage2D(
      gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
      0,
      internalFormat,
      size,
      size,
      0,
      format,
      type,
      null,
    );
  }
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
  return texture;
}

function createDepthCubemap(gl: WebGL2RenderingContext, size: number): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error('Failed to create depth cubemap');
  }
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
  for (let face = 0; face < 6; face += 1) {
    gl.texImage2D(
      gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
      0,
      gl.DEPTH_COMPONENT24,
      size,
      size,
      0,
      gl.DEPTH_COMPONENT,
      gl.UNSIGNED_INT,
      null,
    );
  }
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
  return texture;
}

function createEnvironmentCubemap(gl: WebGL2RenderingContext, faces: Uint8Array[], size: number): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error('Failed to create environment cubemap');
  }
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
  for (let face = 0; face < 6; face += 1) {
    gl.texImage2D(
      gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
      0,
      gl.RGBA8,
      size,
      size,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      faces[face],
    );
  }
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
  return texture;
}

function createProbeCubemapTexture(gl: WebGL2RenderingContext, size: number): WebGLTexture | null {
  const texture = gl.createTexture();
  if (!texture) {
    return null;
  }
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
  for (let face = 0; face < 6; face += 1) {
    gl.texImage2D(
      gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
      0,
      gl.RGBA8,
      size,
      size,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
  }
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
  return texture;
}

function sampleSceneEnvironmentColor(
  scene: RendererSceneSnapshot['scene'],
  direction: ArrayLike<number>,
): [number, number, number] {
  const z = Number(direction[2]) || 0;
  const top = hexToRgb(scene.backgroundMode === 'gradient' ? scene.gradientTopColor : scene.backgroundColor);
  const bottom = hexToRgb(scene.backgroundMode === 'gradient' ? scene.gradientBottomColor : scene.backgroundColor);
  const backdrop = mixRgb(bottom, top, 0.5);
  if (scene.groundPlaneVisible && z < -0.08) {
    const ground = hexToRgb(scene.groundPlaneColor);
    return mixRgb(backdrop, ground, clamp01((-z - 0.08) / 0.92) * 0.35);
  }
  return backdrop;
}

function buildEnvironmentFacePixels(
  scene: RendererSceneSnapshot['scene'],
  size: number,
  face: number,
): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const direction = sampleEnvironmentDirectionForFace(face, size, x, y);
      const color = sampleSceneEnvironmentColor(scene, direction);
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(clamp01(color[0]) * 255);
      pixels[offset + 1] = Math.round(clamp01(color[1]) * 255);
      pixels[offset + 2] = Math.round(clamp01(color[2]) * 255);
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function sampleEnvironmentDirectionForFace(face: number, size: number, x: number, y: number): vec3 {
  const faceVector = POINT_SHADOW_FACE_VECTORS[face] ?? POINT_SHADOW_FACE_VECTORS[0];
  const forward = faceVector.target;
  const up = faceVector.up;
  const right = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), forward, up));
  const sx = ((x + 0.5) / size) * 2 - 1;
  const sy = 1 - ((y + 0.5) / size) * 2;
  const direction = vec3.clone(forward);
  vec3.scaleAndAdd(direction, direction, right, sx);
  vec3.scaleAndAdd(direction, direction, up, sy);
  return vec3.normalize(direction, direction);
}

function uploadEnvironmentFaceToCubemap(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture | null,
  targetFace: number,
  size: number,
  pixels: Uint8Array,
): void {
  if (!texture) {
    return;
  }
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
  gl.texSubImage2D(
    targetFace,
    0,
    0,
    0,
    size,
    size,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels,
  );
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
}

function buildEnvironmentSignature(scene: RendererSceneSnapshot['scene']): string {
  return [
    scene.backgroundMode,
    scene.backgroundColor,
    scene.gradientTopColor,
    scene.gradientBottomColor,
    scene.groundPlaneVisible ? 'ground:on' : 'ground:off',
    scene.groundPlaneColor,
    scene.ambient.color,
  ].join('|');
}

function deleteProgramBundle(gl: WebGL2RenderingContext, bundle: ProgramBundle | null): void {
  if (bundle) {
    gl.deleteProgram(bundle.program);
  }
}

function deleteTexture(gl: WebGL2RenderingContext, texture: WebGLTexture | null): void {
  if (texture) {
    gl.deleteTexture(texture);
  }
}

function deleteFramebuffer(gl: WebGL2RenderingContext, framebuffer: WebGLFramebuffer | null): void {
  if (framebuffer) {
    gl.deleteFramebuffer(framebuffer);
  }
}

function deleteVertexArray(gl: WebGL2RenderingContext, vao: WebGLVertexArrayObject | null): void {
  if (vao) {
    gl.deleteVertexArray(vao);
  }
}

function deleteBuffer(gl: WebGL2RenderingContext, buffer: WebGLBuffer | null): void {
  if (buffer) {
    gl.deleteBuffer(buffer);
  }
}

function bindTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture | null,
  unit: number,
  target: number,
): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(target, texture);
}

function buildGridLines(extent: number, spacing: number): { positions: Float32Array } {
  const safeExtent = Math.max(0.5, extent);
  const safeSpacing = Math.max(0.05, spacing);
  const positions: number[] = [];
  for (let value = -safeExtent; value <= safeExtent + 1e-6; value += safeSpacing) {
    positions.push(value, -safeExtent, 0.0025, value, safeExtent, 0.0025);
    positions.push(-safeExtent, value, 0.0025, safeExtent, value, 0.0025);
  }
  return { positions: new Float32Array(positions) };
}

function contourUniformState(plot: RenderableObject): ContourUniformState {
  if (plot.type === 'intersection' || plot.equation.kind === 'parametric_curve') {
    return {
      xEnabled: false,
      xSpacing: 1,
      xColor: '#000000',
      yEnabled: false,
      ySpacing: 1,
      yColor: '#000000',
      zEnabled: false,
      zSpacing: 1,
      zColor: '#000000',
    };
  }
  return {
    xEnabled: Boolean(plot.material.xContoursVisible),
    xSpacing: clamp(plot.material.xContourSpacing ?? 1, 0.1, 5),
    xColor: plot.material.xContourColor ?? '#000000',
    yEnabled: Boolean(plot.material.yContoursVisible),
    ySpacing: clamp(plot.material.yContourSpacing ?? 1, 0.1, 5),
    yColor: plot.material.yContourColor ?? '#000000',
    zEnabled: Boolean(plot.material.zContoursVisible),
    zSpacing: clamp(plot.material.zContourSpacing ?? 1, 0.1, 5),
    zColor: plot.material.zContourColor ?? '#000000',
  };
}

function plotHasContours(plot: RenderableObject): boolean {
  const state = contourUniformState(plot);
  return state.xEnabled || state.yEnabled || state.zEnabled;
}

function plotUsesRefraction(plot: RenderableObject): boolean {
  return Boolean(plot.material.refractionEnabled)
    && (plot.material.ior ?? 1.45) > 1.001
    && clamp01(plot.material.opacity) < 0.999;
}

function materialEmissionEnabled(material: RenderableObject['material']): boolean {
  return material.emissionEnabled ?? (material.emissionStrength ?? 0) > 0;
}

interface AxisLabelAtlas {
  atlas: HTMLCanvasElement;
  vertices: Float32Array;
  indices: Uint16Array;
}

function niceTickStep(length: number): number {
  const target = Math.max(0.001, length / 5);
  const power = 10 ** Math.floor(Math.log10(target));
  const normalized = target / power;
  const factor = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
  return factor * power;
}

function formatTickValue(value: number, step: number): string {
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return value.toFixed(decimals);
}

function buildAxisLabelAtlas(axesLength: number, dpr: number): AxisLabelAtlas | null {
  const step = niceTickStep(axesLength);
  const entries: Array<{ text: string; position: [number, number, number]; big: boolean }> = [];
  const axes: Array<{ unit: [number, number, number]; name: string }> = [
    { unit: [1, 0, 0], name: 'x' },
    { unit: [0, 1, 0], name: 'y' },
    { unit: [0, 0, 1], name: 'z' },
  ];
  for (const axis of axes) {
    for (let value = step; value <= axesLength + step * 1e-3; value += step) {
      entries.push({
        text: formatTickValue(value, step),
        position: [axis.unit[0] * value, axis.unit[1] * value, axis.unit[2] * value],
        big: false,
      });
    }
    const end = axesLength * 1.07 + 0.15;
    entries.push({
      text: axis.name,
      position: [axis.unit[0] * end, axis.unit[1] * end, axis.unit[2] * end],
      big: true,
    });
  }
  if (entries.length === 0) {
    return null;
  }

  const fontPx = Math.round(12 * dpr);
  const bigFontPx = Math.round(15 * dpr);
  const padding = Math.ceil(3 * dpr);
  const atlas = document.createElement('canvas');
  const measureCtx = atlas.getContext('2d');
  if (!measureCtx) {
    return null;
  }
  const fontFor = (big: boolean) => `${big ? 'italic ' : ''}${big ? bigFontPx : fontPx}px system-ui, -apple-system, sans-serif`;
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  const maxAtlasWidth = 1024;
  let cursorX = padding;
  let cursorY = padding;
  let shelfHeight = 0;
  let atlasWidth = 0;
  for (const entry of entries) {
    measureCtx.font = fontFor(entry.big);
    const textWidth = Math.ceil(measureCtx.measureText(entry.text).width);
    const w = textWidth + padding * 2;
    const h = Math.ceil((entry.big ? bigFontPx : fontPx) * 1.4) + padding * 2;
    if (cursorX + w > maxAtlasWidth) {
      cursorX = padding;
      cursorY += shelfHeight + padding;
      shelfHeight = 0;
    }
    placed.push({ x: cursorX, y: cursorY, w, h });
    cursorX += w + padding;
    shelfHeight = Math.max(shelfHeight, h);
    atlasWidth = Math.max(atlasWidth, cursorX);
  }
  atlas.width = Math.min(maxAtlasWidth, Math.max(64, atlasWidth));
  atlas.height = Math.max(32, cursorY + shelfHeight + padding);
  const ctx = atlas.getContext('2d');
  if (!ctx) {
    return null;
  }
  ctx.clearRect(0, 0, atlas.width, atlas.height);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const box = placed[i];
    ctx.font = fontFor(entry.big);
    const centerX = box.x + box.w / 2;
    const centerY = box.y + box.h / 2;
    ctx.lineWidth = Math.max(2, 2.5 * dpr);
    ctx.strokeStyle = 'rgba(6, 10, 18, 0.9)';
    ctx.strokeText(entry.text, centerX, centerY);
    ctx.fillStyle = entry.big ? '#f0d9a8' : '#d9e3f4';
    ctx.fillText(entry.text, centerX, centerY);
  }

  // Four vertices per label: world-space center plus a pixel-space corner
  // offset resolved in the vertex shader, so labels stay screen-sized.
  const vertices = new Float32Array(entries.length * 4 * 7);
  const indices = new Uint16Array(entries.length * 6);
  const dropPx = 11 * dpr;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const box = placed[i];
    const halfW = box.w / 2;
    const halfH = box.h / 2;
    const offsetY = entry.big ? 0 : -dropPx;
    const u0 = box.x / atlas.width;
    const u1 = (box.x + box.w) / atlas.width;
    const v0 = box.y / atlas.height;
    const v1 = (box.y + box.h) / atlas.height;
    const corners: Array<[number, number, number, number]> = [
      [-halfW, halfH + offsetY, u0, v0],
      [halfW, halfH + offsetY, u1, v0],
      [halfW, -halfH + offsetY, u1, v1],
      [-halfW, -halfH + offsetY, u0, v1],
    ];
    for (let c = 0; c < 4; c += 1) {
      const base = (i * 4 + c) * 7;
      vertices[base] = entry.position[0];
      vertices[base + 1] = entry.position[1];
      vertices[base + 2] = entry.position[2];
      vertices[base + 3] = corners[c][0];
      vertices[base + 4] = corners[c][1];
      vertices[base + 5] = corners[c][2];
      vertices[base + 6] = corners[c][3];
    }
    const quad = i * 4;
    indices.set([quad, quad + 1, quad + 2, quad, quad + 2, quad + 3], i * 6);
  }
  return { atlas, vertices, indices };
}

function buildAxesLines(length: number): { positions: Float32Array } {
  return {
    positions: new Float32Array([
      0, 0, 0, length, 0, 0,
      0, 0, 0, 0, length, 0,
      0, 0, 0, 0, 0, length,
    ]),
  };
}

function drawColoredAxes(gl: WebGL2RenderingContext, program: ProgramBundle, buffer: GpuLineBuffer): void {
  const axisColors = [
    [0.94, 0.27, 0.27, 0.95],
    [0.13, 0.77, 0.37, 0.95],
    [0.23, 0.51, 0.96, 0.95],
  ];
  for (let axis = 0; axis < 3; axis += 1) {
    gl.uniform4fv(program.uniforms.u_color, new Float32Array(axisColors[axis]));
    gl.bindVertexArray(buffer.vao);
    gl.drawArrays(gl.LINES, axis * 2, 2);
    gl.bindVertexArray(null);
  }
}

function pointLightGizmoColor(hex: string, selected: boolean): Float32Array {
  const warm = [1.0, 0.86, 0.28];
  const light = hexToRgb(hex);
  const mixAmount = selected ? 0.18 : 0.12;
  const color = mixRgb(warm, light, mixAmount);
  return new Float32Array([
    clamp01(color[0] + (selected ? 0.06 : 0.0)),
    clamp01(color[1] + (selected ? 0.04 : 0.0)),
    clamp01(color[2]),
  ]);
}

function directionalLightGizmoColor(hex: string, selected: boolean): Float32Array {
  const sunlight = [1.0, 0.68, 0.16];
  const light = hexToRgb(hex);
  const color = mixRgb(sunlight, light, selected ? 0.28 : 0.2);
  return new Float32Array([
    clamp01(color[0] + (selected ? 0.06 : 0)),
    clamp01(color[1] + (selected ? 0.04 : 0)),
    clamp01(color[2]),
  ]);
}

function directionalLightGizmoEndpoints(
  light: DirectionalLightObject,
  cameraRadius: number,
): { tail: vec3; tip: vec3; direction: vec3; length: number } {
  const normalized = normalizeVec3({
    x: -light.position.x,
    y: -light.position.y,
    z: -light.position.z,
  }, { x: 0, y: 0, z: -1 });
  const direction = vec3.fromValues(normalized.x, normalized.y, normalized.z);
  const tail = vec3.fromValues(light.position.x, light.position.y, light.position.z);
  const length = clamp(cameraRadius * 0.13, 1, 12);
  const tip = vec3.scaleAndAdd(vec3.create(), tail, direction, length);
  return { tail, tip, direction, length };
}

function directionalLightGizmoModel(tail: vec3, direction: vec3, length: number): mat4 {
  const reference = Math.abs(direction[2]) < 0.92
    ? vec3.fromValues(0, 0, 1)
    : vec3.fromValues(0, 1, 0);
  const side = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), reference, direction));
  const up = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), direction, side));
  return mat4.fromValues(
    direction[0] * length, direction[1] * length, direction[2] * length, 0,
    side[0] * length, side[1] * length, side[2] * length, 0,
    up[0] * length, up[1] * length, up[2] * length, 0,
    tail[0], tail[1], tail[2], 1,
  );
}

function createGroundMesh(gl: WebGL2RenderingContext): SimpleMeshBuffer {
  const vao = gl.createVertexArray();
  const vertexBuffer = gl.createBuffer();
  const normalBuffer = gl.createBuffer();
  const indexBuffer = gl.createBuffer();
  if (!vao || !vertexBuffer || !normalBuffer || !indexBuffer) {
    throw new Error('Failed to create ground mesh');
  }
  const positions = new Float32Array([
    -1, -1, 0,
    1, -1, 0,
    1, 1, 0,
    -1, 1, 0,
  ]);
  const normals = new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  gl.deleteBuffer(vertexBuffer);
  gl.deleteBuffer(normalBuffer);
  return {
    vao,
    indexBuffer,
    indexCount: indices.length,
  };
}

function normalizeVec3(input: { x: number; y: number; z: number }, fallback: { x: number; y: number; z: number }) {
  const length = Math.hypot(input.x, input.y, input.z);
  if (!Number.isFinite(length) || length < 1e-6) {
    return fallback;
  }
  return { x: input.x / length, y: input.y / length, z: input.z / length };
}

function mixRgb(a: ArrayLike<number>, b: ArrayLike<number>, t: number): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function hexToRgb(hex: string): Float32Array {
  const normalized = hex.trim().replace('#', '');
  const expanded = normalized.length === 3
    ? normalized.split('').map((char) => `${char}${char}`).join('')
    : normalized;
  const value = Number.parseInt(expanded, 16);
  if (!Number.isFinite(value)) {
    return new Float32Array([1, 1, 1]);
  }
  return new Float32Array([
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clearDefaultFramebuffer(gl: WebGL2RenderingContext, clearColor: [number, number, number, number]): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
}

function buildPngFileName(): string {
  return `plot-${buildExportTimestamp()}.png`;
}

function buildGifFileName(): string {
  return `turntable-${buildExportTimestamp()}.gif`;
}

function buildParameterGifFileName(parameterName: string): string {
  const safeName = parameterName.trim().replace(/[^a-zA-Z0-9_-]+/g, '-') || 'parameter';
  return `${safeName}-bounce-${buildExportTimestamp()}.gif`;
}

function buildLightCurveGifFileName(lightName: string): string {
  const safeName = lightName.trim().replace(/[^a-zA-Z0-9_-]+/g, '-') || 'light';
  return `${safeName}-loop-${buildExportTimestamp()}.gif`;
}

function buildExportTimestamp(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
}

const FULL_DETAIL_FRAME_TIMEOUT_MS = 120_000;

function collectAnimatingContinuousParameters(
  state: AppState,
): Array<{ plotId: string; parameterName: string }> {
  const result: Array<{ plotId: string; parameterName: string }> = [];
  for (const object of state.objects) {
    if (object.type !== 'plot') continue;
    for (const parameter of object.equation.parameters) {
      if (parameter.samplingMode === 'continuous' && parameter.animating) {
        result.push({ plotId: object.id, parameterName: parameter.name });
      }
    }
  }
  return result;
}

function fullDetailRenderableIds(state: AppState): Set<string> {
  const ids = new Set<string>();
  for (const object of state.objects) {
    if (object.type === 'plot') {
      if (object.equation.source.parseStatus === 'ok') ids.add(object.id);
      continue;
    }
    if (object.type !== 'intersection') continue;
    const sourceA = state.objects.find((candidate) => candidate.id === object.sourceSurfaceIds[0]);
    const sourceB = state.objects.find((candidate) => candidate.id === object.sourceSurfaceIds[1]);
    if (
      isSurfacePlot(sourceA)
      && isSurfacePlot(sourceB)
      && sourceA.id !== sourceB.id
      && sourceA.equation.source.parseStatus === 'ok'
      && sourceB.equation.source.parseStatus === 'ok'
    ) {
      ids.add(object.id);
    }
  }
  return ids;
}

function affectedFullDetailIds(state: AppState, changedPlotIds: Set<string>): Set<string> {
  const fullDetailIds = fullDetailRenderableIds(state);
  const affected = new Set<string>();
  for (const plotId of changedPlotIds) {
    if (fullDetailIds.has(plotId)) affected.add(plotId);
  }
  for (const object of state.objects) {
    if (
      object.type === 'intersection'
      && fullDetailIds.has(object.id)
      && object.sourceSurfaceIds.some((sourceId) => sourceId !== null && changedPlotIds.has(sourceId))
    ) {
      affected.add(object.id);
    }
  }
  return affected;
}

function captureMeshVersionBaselines(state: AppState, objectIds: Set<string>): Map<string, number> {
  const versions = new Map<string, number>();
  for (const objectId of objectIds) {
    versions.set(objectId, state.plotJobs[objectId]?.meshVersion ?? 0);
  }
  return versions;
}

function yieldForWorkerPipeline(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
}

function gifRecordingCancellationError(): Error {
  const error = new Error('GIF recording was cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfGifRecordingCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw gifRecordingCancellationError();
}

function waitForFullDetailMeshScheduling(
  requiredVersions: Map<string, number>,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    let timeout = 0;
    let abortListener: (() => void) | null = null;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      unsubscribe();
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      if (error) reject(error);
      else resolve();
    };

    timeout = window.setTimeout(() => {
      finish(new Error('Timed out scheduling full-detail meshes'));
    }, FULL_DETAIL_FRAME_TIMEOUT_MS);
    abortListener = () => finish(gifRecordingCancellationError());
    signal?.addEventListener('abort', abortListener, { once: true });
    if (signal?.aborted) {
      abortListener();
      return;
    }

    const check = () => {
      const state = useAppStore.getState();
      const fullDetailIds = fullDetailRenderableIds(state);
      for (const [objectId, baseline] of requiredVersions) {
        if (!fullDetailIds.has(objectId)) {
          finish(new Error('An animated object became unavailable during GIF export'));
          return;
        }
        const job = state.plotJobs[objectId];
        if (job?.meshPhase === 'error') {
          finish(new Error(job.lastError || `Failed to build full-detail mesh for ${objectId}`));
          return;
        }
        if (job?.meshPhase === 'ready' && job.meshVersion <= baseline) return;
      }
      finish();
    };

    unsubscribe = useAppStore.subscribe(check);
    queueMicrotask(check);
  });
}

function waitForFullDetailMeshes(
  requiredVersions: Map<string, number>,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    let timeout = 0;
    let abortListener: (() => void) | null = null;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      unsubscribe();
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      if (error) reject(error);
      else resolve();
    };

    timeout = window.setTimeout(() => {
      finish(new Error('Timed out waiting for full-detail meshes'));
    }, FULL_DETAIL_FRAME_TIMEOUT_MS);
    abortListener = () => finish(gifRecordingCancellationError());
    signal?.addEventListener('abort', abortListener, { once: true });
    if (signal?.aborted) {
      abortListener();
      return;
    }

    const check = () => {
      const state = useAppStore.getState();
      const fullDetailIds = fullDetailRenderableIds(state);
      for (const objectId of fullDetailIds) {
        const job = state.plotJobs[objectId];
        if (job?.meshPhase === 'error') {
          finish(new Error(job.lastError || `Failed to build full-detail mesh for ${objectId}`));
          return;
        }
        if (job?.meshPhase !== 'ready') return;
      }
      for (const [objectId, baseline] of requiredVersions) {
        if (!fullDetailIds.has(objectId)) {
          finish(new Error('An animated object became unavailable during GIF export'));
          return;
        }
        const job = state.plotJobs[objectId];
        if (!job || job.meshVersion <= baseline || job.meshPhase !== 'ready') return;
      }
      finish();
    };

    unsubscribe = useAppStore.subscribe(check);
    queueMicrotask(check);
  });
}

interface CanvasFrameCaptureSurface {
  width: number;
  height: number;
  readPixels: Uint8Array;
  imageData: ImageData;
  imageContext: CanvasRenderingContext2D;
  outputCanvas: HTMLCanvasElement;
  outputContext: CanvasRenderingContext2D;
}

function createCanvasFrameCaptureSurface(width: number, height: number): CanvasFrameCaptureSurface {
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = width;
  outputCanvas.height = height;
  const outputContext = outputCanvas.getContext('2d', { willReadFrequently: true });
  if (!outputContext) {
    throw new Error('Failed to create image export surface');
  }
  const imageCanvas = document.createElement('canvas');
  imageCanvas.width = width;
  imageCanvas.height = height;
  const imageContext = imageCanvas.getContext('2d');
  if (!imageContext) {
    throw new Error('Failed to create image export pixel surface');
  }
  return {
    width,
    height,
    readPixels: new Uint8Array(width * height * 4),
    imageData: imageContext.createImageData(width, height),
    imageContext,
    outputCanvas,
    outputContext,
  };
}

function captureCanvasRgba(
  gl: WebGL2RenderingContext,
  scene: AppState['scene'],
  surface: CanvasFrameCaptureSurface,
): Uint8ClampedArray {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.finish();
  gl.readPixels(0, 0, surface.width, surface.height, gl.RGBA, gl.UNSIGNED_BYTE, surface.readPixels);

  const rowSize = surface.width * 4;
  for (let y = 0; y < surface.height; y += 1) {
    const srcOffset = (surface.height - 1 - y) * rowSize;
    const dstOffset = y * rowSize;
    surface.imageData.data.set(surface.readPixels.subarray(srcOffset, srcOffset + rowSize), dstOffset);
  }
  surface.imageContext.putImageData(surface.imageData, 0, 0);
  paintExportBackground(surface.outputContext, scene, surface.width, surface.height);
  surface.outputContext.drawImage(surface.imageContext.canvas, 0, 0);
  return surface.outputContext.getImageData(0, 0, surface.width, surface.height).data;
}

async function exportCanvasPng(
  gl: WebGL2RenderingContext,
  canvas: HTMLCanvasElement,
  scene: AppState['scene'],
  filename: string,
): Promise<void> {
  const width = Math.max(1, canvas.width);
  const height = Math.max(1, canvas.height);
  const surface = createCanvasFrameCaptureSurface(width, height);
  captureCanvasRgba(gl, scene, surface);
  const blob = await new Promise<Blob | null>((resolve) => surface.outputCanvas.toBlob(resolve, 'image/png'));
  if (!blob) {
    throw new Error('Failed to export PNG');
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function paintExportBackground(
  ctx: CanvasRenderingContext2D,
  scene: AppState['scene'],
  width: number,
  height: number,
): void {
  if (scene.backgroundMode === 'solid') {
    ctx.fillStyle = scene.backgroundColor;
  } else {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, scene.gradientTopColor);
    gradient.addColorStop(1, scene.gradientBottomColor);
    ctx.fillStyle = gradient;
  }
  ctx.fillRect(0, 0, width, height);
}

function toneMappingMode(mode: AppState['render']['toneMapping']): number {
  return mode === 'aces' ? 1 : mode === 'filmic' ? 2 : 0;
}

function probeRefreshInterval(quality: AppState['render']['interactiveQuality']): number {
  return quality === 'quality' ? PROBE_REFRESH_INTERVAL : quality === 'balanced' ? PROBE_REFRESH_INTERVAL * 2 : PROBE_REFRESH_INTERVAL * 4;
}

function emptyRenderTargets(): RenderTargets {
  return {
    width: 0,
    height: 0,
    sceneFramebuffer: null,
    sceneColor: null,
    sceneDepth: null,
    pointGizmoFramebuffer: null,
    pointGizmoColor: null,
    pointGizmoDepth: null,
    pointGizmoSourceFramebuffer: null,
    pointGizmoSourceColor: null,
    pointGizmoSourceDepth: null,
    bloomWidth: 0,
    bloomHeight: 0,
    bloomFramebufferA: null,
    bloomTextureA: null,
    bloomFramebufferB: null,
    bloomTextureB: null,
    refractionFramebuffer: null,
    refractionTexture: null,
    maskFramebuffer: null,
    maskTexture: null,
    maskDepth: null,
  };
}

function emptyShadowResources(): ShadowResources {
  return {
    directionalFramebuffer: null,
    directionalDepthTexture: null,
    directionalTransFramebuffer: null,
    directionalTransDepthTexture: null,
    directionalTransColorTexture: null,
    pointFramebuffer: null,
    pointTransFramebuffer: null,
    pointDepthCubemaps: Array(MAX_POINT_SHADOW_LIGHTS).fill(null),
    pointTransDepthCubemaps: Array(MAX_POINT_SHADOW_LIGHTS).fill(null),
    pointTransColorCubemaps: Array(MAX_POINT_SHADOW_LIGHTS).fill(null),
    size: 0,
  };
}

function emptyProbeRenderResources(): ProbeRenderResources {
  return {
    framebuffer: null,
    depthRenderbuffer: null,
    size: 0,
  };
}

function noProbeUsage(): ProbeUsage {
  return { useProbe: false, refreshed: false, texture: null, center: ZERO_PROBE_CENTER };
}

function emptyPlanarReflectionTargets(): PlanarReflectionTargets {
  return {
    framebuffer: null,
    colorTexture: null,
    depthRenderbuffer: null,
    width: 0,
    height: 0,
  };
}

function rayPlaneIntersectZ(ray: { origin: vec3; direction: vec3 }, z: number): vec3 | null {
  const dz = ray.direction[2];
  if (Math.abs(dz) < 1e-6) {
    return null;
  }
  const t = (z - ray.origin[2]) / dz;
  if (t < 0) {
    return null;
  }
  return vec3.scaleAndAdd(vec3.create(), ray.origin, ray.direction, t);
}

function closestZOnVerticalAxisToRay(ray: { origin: vec3; direction: vec3 }, x: number, y: number): number | null {
  const ox = ray.origin[0];
  const oy = ray.origin[1];
  const oz = ray.origin[2];
  const dx = ray.direction[0];
  const dy = ray.direction[1];
  const dz = ray.direction[2];
  const dd = dx * dx + dy * dy + dz * dz;
  const dk = dz;
  const rhs1 = dx * (x - ox) + dy * (y - oy) - dz * oz;
  const rhs2 = -oz;
  const det = dd - dk * dk;
  if (Math.abs(det) < 1e-8) {
    return null;
  }
  let s = (rhs1 - rhs2 * dk) / det;
  if (!Number.isFinite(s)) {
    return null;
  }
  if (s < 0) {
    s = 0;
  }
  const t = rhs2 + dk * s;
  return Number.isFinite(t) ? t : null;
}

function intersectSphere(
  origin: vec3,
  direction: vec3,
  center: PointLightObject['position'] | vec3,
  radius: number,
): number | null {
  const centerX = 'x' in center ? center.x : center[0];
  const centerY = 'y' in center ? center.y : center[1];
  const centerZ = 'z' in center ? center.z : center[2];
  const oc = vec3.fromValues(origin[0] - centerX, origin[1] - centerY, origin[2] - centerZ);
  const a = vec3.dot(direction, direction);
  const b = 2 * vec3.dot(oc, direction);
  const c = vec3.dot(oc, oc) - radius * radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    return null;
  }
  const sqrt = Math.sqrt(discriminant);
  const t0 = (-b - sqrt) / (2 * a);
  const t1 = (-b + sqrt) / (2 * a);
  const hit = t0 > 0 ? t0 : t1 > 0 ? t1 : null;
  return hit;
}
