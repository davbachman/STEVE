import {
  ArcRotateCamera,
  BaseTexture,
  Color3,
  Color4,
  DirectionalLight,
  HemisphericLight,
  ImageProcessingConfiguration,
  LinesMesh,
  Matrix,
  Material,
  Mesh,
  MeshBuilder,
  MirrorTexture,
  PBRMaterial,
  PointLight,
  PointerEventTypes,
  ReflectionProbe,
  RawTexture,
  RenderTargetTexture,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  VertexData,
  WebGPUEngine,
  type Nullable,
  type Observer,
  type PointerInfo,
} from '@babylonjs/core';
import { GridMaterial } from '@babylonjs/materials/grid';
import { CreateScreenshotUsingRenderTargetAsync } from '@babylonjs/core/Misc/screenshotTools';
import type { AppState } from '../state/store';
import { useAppStore } from '../state/store';
import type {
  InteractiveReflectionSource,
  PlotJobStatus,
  PlotObject,
  PointLightObject,
  RenderDiagnostics,
  RenderSettings,
  SceneObject,
  SerializedMesh,
} from '../types/contracts';
import { compilePlotObject } from '../math/compile';
import { buildImplicitMeshFromScalarField } from '../math/mesh/implicitMarchingTetra';
import { buildSurfaceMesh, sampleCurve } from '../math/mesh/parametric';
import { getRuntimePlotMesh } from '../workers/runtimeMeshCache';
import { QualityBackendRouter } from './qualityBackends';

export interface ViewportApi {
  exportPng: (filename?: string) => Promise<void>;
}

interface PlotVisual {
  root: Mesh;
  wireframeLines: LinesMesh[];
  geometryKey: string;
  curveTube?: {
    path: Vector3[];
    baseRadius: number;
    referenceCameraRadius: number;
    currentRadius: number;
  };
}

interface PointLightVisual {
  light: PointLight;
  gizmo: Mesh;
  pickShell: Mesh;
  halo: Mesh;
  starLines: LinesMesh[];
  shadow: ShadowGenerator | null;
  shadowEnabled: boolean;
}

type DragState =
  | {
      objectId: string;
      mode: 'xy';
      startPosition: Vector3;
      planeZ: number;
      startPoint: Vector3;
    }
  | {
      objectId: string;
      mode: 'z';
      startPosition: Vector3;
      fixedX: number;
      fixedY: number;
      zOffset: number;
      fallbackScale: number;
      startClientY: number;
    };

const FIXED_INTERACTIVE_IOR = 1.45;
const INTERACTIVE_REFLECTION_PROBE_MAX_ERROR_STREAK = 3;
const INTERACTIVE_REFLECTION_PROBE_RETRY_BASE_BACKOFF_FRAMES = 45;
const INTERACTIVE_REFLECTION_PROBE_BLOCKED_COOLDOWN_FRAMES = 600;

export class SceneController {
  private engine: WebGPUEngine | null = null;
  private scene: Scene | null = null;
  private camera: ArcRotateCamera | null = null;
  private ambientLight: HemisphericLight | null = null;
  private directionalLight: DirectionalLight | null = null;
  private directionalShadow: ShadowGenerator | null = null;
  private plotRoot: TransformNode | null = null;
  private lightRoot: TransformNode | null = null;
  private groundMesh: Mesh | null = null;
  private gridMesh: Mesh | null = null;
  private xyGridLines: LinesMesh[] = [];
  private xyGridKey = '';
  private axesMeshes: LinesMesh[] = [];
  private groundMirror: MirrorTexture | null = null;
  private sceneReflectionProbe: ReflectionProbe | null = null;
  private sceneReflectionProbeSize = 0;
  private environmentFallbackTexture: BaseTexture | null = null;
  private environmentFallbackTextureWasReady = false;
  private environmentFallbackPendingFrames = 0;
  private interactiveReflectionFallbackKind: RenderDiagnostics['interactiveReflectionFallbackKind'] = 'none';
  private interactiveReflectionFallbackEverUsable = false;
  private interactiveReflectionPath: RenderDiagnostics['interactiveReflectionPath'] = 'none';
  private interactiveReflectionFallbackReason: string | null = null;
  private interactiveReflectionLastRefreshReason: string | null = null;
  private interactiveReflectionProbeRefreshCount = 0;
  private interactiveReflectionProbeWarmupFrames = 0;
  private interactiveReflectionProbeUsable = false;
  private interactiveReflectionProbeHasCapture = false;
  private interactiveReflectionProbeManualKickRemaining = 0;
  private interactiveReflectionProbeRetryCooldownFrames = 0;
  private interactiveReflectionProbeErrorStreak = 0;
  private interactiveReflectionProbeBackoffFrames = 0;
  private interactiveReflectionProbeBlocked = false;
  private interactiveReflectionSource: InteractiveReflectionSource = 'none';
  private interactiveReflectionTexture: Nullable<BaseTexture> = null;
  private probeCaptureMaterialOverrides: Array<{
    material: PBRMaterial;
    reflectionTexture: Nullable<BaseTexture>;
  }> = [];
  private lastInteractiveReflectionSignature = '';
  private plotVisuals = new Map<string, PlotVisual>();
  private pointLightVisuals = new Map<string, PointLightVisual>();
  private pointerObserver: Nullable<Observer<PointerInfo>> = null;
  private dragState: DragState | null = null;
  private cameraDrag: { mode: 'orbit' | 'pan'; pointerId: number; lastX: number; lastY: number } | null = null;
  private lastQualitySignature = '';
  private lastQualityCameraSignature = '';
  private qualityBackends: QualityBackendRouter | null = null;
  private qualityActiveRenderer: RenderDiagnostics['qualityActiveRenderer'] = 'none';
  private qualityFallbackReason: string | null = null;
  private qualityLastResetReason: string | null = null;
  private qualitySamplesPerSecond = 0;
  private qualityPerfWindowStartMs = 0;
  private qualityPerfWindowStartSamples = 0;
  private lastQualityStatusMessageKey = '';
  private qualityPreviewOverlayCanvas: HTMLCanvasElement | null = null;
  private qualityPreviewOverlayCtx: CanvasRenderingContext2D | null = null;
  private baseHardwareScalingLevel = 1;
  private lastAppliedHardwareScalingLevel = Number.NaN;
  private meshHashCache = new Map<string, string>();
  private disposed = false;
  private renderLoopFailed = false;
  private engineInitialized = false;
  private pointShadowCapability: 'unknown' | 'available' | 'unavailable' = 'unknown';
  private lastCurveTubeCameraRadius = Number.NaN;
  private readonly debugInstanceId = Math.random().toString(36).slice(2, 10);

  constructor(private readonly canvas: HTMLCanvasElement) {}

  async init(): Promise<void> {
    this.disposed = false;
    if (!(navigator as Navigator & { gpu?: GPU }).gpu) {
      throw new Error('WebGPU is not available in this browser');
    }

    this.engine = new WebGPUEngine(this.canvas, {
      antialias: true,
      adaptToDeviceRatio: true,
      stencil: true,
    });
    await this.engine.initAsync();
    this.engineInitialized = true;
    this.baseHardwareScalingLevel = this.engine.getHardwareScalingLevel();
    this.lastAppliedHardwareScalingLevel = this.baseHardwareScalingLevel;
    if (this.disposed) {
      this.safeDisposeEngine();
      throw new Error('Viewport initialization was canceled');
    }

    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0, 0, 0, 0);
    this.scene.shadowsEnabled = true;
    this.scene.texturesEnabled = true;
    this.scene.probesEnabled = true;
    this.scene.renderTargetsEnabled = true;

    this.plotRoot = new TransformNode('plots-root', this.scene);
    this.lightRoot = new TransformNode('lights-root', this.scene);

    this.camera = new ArcRotateCamera('camera', -Math.PI / 3, 1.1, 20, new Vector3(0, 0, 1.5), this.scene);
    this.camera.upVector = new Vector3(0, 0, 1);
    this.camera.lowerRadiusLimit = 1;
    this.camera.upperRadiusLimit = 200;
    this.camera.wheelPrecision = 50;
    this.camera.attachControl(this.canvas, false);
    if (this.camera.inputs.attached.pointers) {
      const pointerInput = this.camera.inputs.attached.pointers as unknown as {
        buttons?: number[];
        panningMouseButton?: number;
      };
      pointerInput.buttons = [];
      pointerInput.panningMouseButton = -1;
    }

    this.ambientLight = new HemisphericLight('ambient-hemi', new Vector3(0, 0, 1), this.scene);
    this.ambientLight.intensity = 0.35;
    this.ambientLight.diffuse = Color3.White();
    this.ambientLight.specular = Color3.White().scale(0.15);
    this.ambientLight.groundColor = new Color3(0.08, 0.08, 0.1);

    this.directionalLight = new DirectionalLight('sun', new Vector3(-0.6, -0.4, -1).normalize(), this.scene);
    this.directionalLight.position = new Vector3(10, 10, 18);
    this.directionalLight.autoCalcShadowZBounds = true;
    this.directionalLight.shadowMinZ = 0.1;
    this.directionalLight.shadowMaxZ = 200;
    this.ensureDirectionalShadowGenerator(2048, 0.6);

    this.createGroundAndGrid();
    this.createAxes(6);
    this.attachInputHandlers();
    this.exposeDebugHandles();

    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    this.engine.runRenderLoop(() => {
      if (this.renderLoopFailed || this.disposed) {
        return;
      }
      try {
        const shouldRender = this.tickQualityMode();
        if (!shouldRender) {
          return;
        }
        this.syncCurveTubePixelWidth();
        this.scene?.render();
        this.advanceInteractiveReflectionProbeWarmup();
        this.maybeRebindAfterReflectionTextureReady();
        this.handleQualityFrameRendered();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown Babylon render error';
        if (this.tryRecoverFromRenderError(message, error)) {
          return;
        }
        this.renderLoopFailed = true;
        useAppStore.getState().setStatusMessage(`Render loop error: ${message}`);
        this.engine?.stopRenderLoop();
        console.error('Scene render loop failed', error);
      }
    });

    window.addEventListener('resize', this.handleResize);
    useAppStore.getState().setRenderDiagnostics({ webgpuReady: true });
  }

  dispose(): void {
    this.disposed = true;
    this.engine?.stopRenderLoop();
    window.removeEventListener('resize', this.handleResize);
    this.pointerObserver && this.scene?.onPointerObservable.remove(this.pointerObserver);
    this.pointerObserver = null;
    this.disposeQualityPipeline();
    this.qualityPreviewOverlayCanvas?.remove();
    this.qualityPreviewOverlayCanvas = null;
    this.qualityPreviewOverlayCtx = null;
    this.restoreProbeCaptureMaterials();
    this.detachProbeFromSceneRenderTargets();
    this.sceneReflectionProbe?.dispose();
    this.sceneReflectionProbe = null;
    this.sceneReflectionProbeSize = 0;
    if (this.scene?.environmentTexture && this.scene.environmentTexture === this.environmentFallbackTexture) {
      this.scene.environmentTexture = null;
    }
    this.environmentFallbackTexture?.dispose();
    this.environmentFallbackTexture = null;
    this.environmentFallbackTextureWasReady = false;
    this.environmentFallbackPendingFrames = 0;
    this.interactiveReflectionFallbackKind = 'none';
    this.interactiveReflectionFallbackEverUsable = false;
    this.groundMirror?.dispose();
    this.groundMirror = null;
    for (const visual of this.plotVisuals.values()) {
      visual.root.dispose(false, true);
      visual.wireframeLines.forEach((line) => line.dispose(false, true));
    }
    this.plotVisuals.clear();
    for (const visual of this.pointLightVisuals.values()) {
      visual.shadow?.dispose();
      visual.pickShell.dispose(false, true);
      visual.halo.dispose(false, true);
      visual.starLines.forEach((line) => line.dispose(false, true));
      visual.gizmo.dispose(false, true);
      visual.light.dispose();
    }
    this.pointLightVisuals.clear();
    this.axesMeshes.forEach((m) => m.dispose(false, true));
    this.axesMeshes = [];
    this.xyGridLines.forEach((m) => m.dispose(false, true));
    this.xyGridLines = [];
    this.xyGridKey = '';
    this.gridMesh?.dispose(false, true);
    this.groundMesh?.dispose(false, true);
    this.plotRoot?.dispose();
    this.lightRoot?.dispose();
    this.ambientLight?.dispose();
    try {
      this.scene?.dispose();
    } catch (error) {
      console.warn('Scene dispose failed', error);
    }
    this.safeDisposeEngine();
    this.scene = null;
    this.engine = null;
    this.engineInitialized = false;
    this.lastAppliedHardwareScalingLevel = Number.NaN;
    this.interactiveReflectionPath = 'none';
    this.interactiveReflectionFallbackReason = null;
    this.interactiveReflectionLastRefreshReason = null;
    this.interactiveReflectionProbeRefreshCount = 0;
    this.interactiveReflectionProbeWarmupFrames = 0;
    this.interactiveReflectionProbeUsable = false;
    this.interactiveReflectionProbeHasCapture = false;
    this.interactiveReflectionProbeManualKickRemaining = 0;
    this.interactiveReflectionProbeRetryCooldownFrames = 0;
    this.interactiveReflectionProbeErrorStreak = 0;
    this.interactiveReflectionProbeBackoffFrames = 0;
    this.interactiveReflectionProbeBlocked = false;
    this.interactiveReflectionSource = 'none';
    this.interactiveReflectionTexture = null;
    this.lastInteractiveReflectionSignature = '';
    this.environmentFallbackTextureWasReady = false;
    this.environmentFallbackPendingFrames = 0;
    this.interactiveReflectionFallbackKind = 'none';
    this.interactiveReflectionFallbackEverUsable = false;
    this.lastCurveTubeCameraRadius = Number.NaN;
    this.clearDebugHandles();
    useAppStore.getState().setRenderDiagnostics({ webgpuReady: false });
  }

  private exposeDebugHandles(): void {
    if (typeof window === 'undefined' || !import.meta.env.DEV) {
      return;
    }
    const w = window as Window & {
      __plotRenderSceneController?: SceneController;
      __plotRenderScene?: Scene | null;
      __plotRenderControllerId?: string;
    };
    w.__plotRenderSceneController = this;
    w.__plotRenderScene = this.scene;
    w.__plotRenderControllerId = this.debugInstanceId;
  }

  private clearDebugHandles(): void {
    if (typeof window === 'undefined' || !import.meta.env.DEV) {
      return;
    }
    const w = window as Window & {
      __plotRenderSceneController?: SceneController;
      __plotRenderScene?: Scene | null;
      __plotRenderControllerId?: string;
    };
    if (w.__plotRenderSceneController === this) {
      w.__plotRenderSceneController = undefined;
    }
    if (w.__plotRenderScene) {
      w.__plotRenderScene = null;
    }
    if (w.__plotRenderControllerId === this.debugInstanceId) {
      w.__plotRenderControllerId = undefined;
    }
  }

  getApi(): ViewportApi {
    return {
      exportPng: async (filename = '3dplot.png') => {
        if (!this.canvas) return;
        const waitResult = await this.waitForQualityReadyForExport(20_000);
        const { render } = useAppStore.getState();
        let exportCanvas =
          render.mode === 'quality' ? (this.qualityBackends?.getActiveBackendExportCanvas() ?? this.canvas) : this.canvas;
        if (exportCanvas !== this.canvas && canvasLooksBlank(exportCanvas)) {
          exportCanvas = this.canvas;
        }
        if (exportCanvas === this.canvas && this.engine && this.camera) {
          await exportScenePngViaRenderTarget(this.engine, this.camera, this.canvas, filename);
        } else {
          await exportCanvasPng(exportCanvas, filename);
        }
        if (render.mode === 'quality') {
          if (waitResult === 'timeout') {
            useAppStore.getState().setStatusMessage(
              `Exported PNG before quality accumulation finished (${render.qualityCurrentSamples}/${render.qualitySamplesTarget} samples)`,
            );
          } else if (
            waitResult === 'skipped'
            && render.qualityEarlyExportBehavior === 'immediate'
            && render.qualityCurrentSamples < render.qualitySamplesTarget
          ) {
            useAppStore.getState().setStatusMessage(
              `Exported quality PNG early (${render.qualityCurrentSamples}/${render.qualitySamplesTarget} samples)`,
            );
          } else {
            useAppStore.getState().setStatusMessage(`Exported quality PNG (${render.qualityCurrentSamples} samples)`);
          }
        } else {
          useAppStore.getState().setStatusMessage('Exported PNG');
        }
      },
    };
  }

  resizeViewport(): void {
    this.handleResize();
  }

  sync(state: Pick<AppState, 'scene' | 'render' | 'objects' | 'selectedId' | 'plotJobs'>): void {
    if (!this.scene || !this.camera || !this.directionalLight) {
      return;
    }

    this.syncSceneSettings(state);
    this.syncLights(state);
    this.syncInteractiveReflectionSetup(state);
    this.syncPlots(state);
    this.syncInteractiveReflectionProbe(state);
    this.syncSelection(state.selectedId, state.objects);

    this.syncQualityRenderer(state);

    const sceneSignature = JSON.stringify({
      objects: state.objects,
      scene: state.scene,
      render: {
        mode: state.render.mode,
        toneMapping: state.render.toneMapping,
        exposure: state.render.exposure,
        denoise: state.render.denoise,
        qualityRenderer: state.render.qualityRenderer,
        qualitySamplesTarget: state.render.qualitySamplesTarget,
        qualityResolutionScale: state.render.qualityResolutionScale,
        qualityMaxBounces: state.render.qualityMaxBounces,
        qualityClampFireflies: state.render.qualityClampFireflies,
      },
      plotMeshVersions: state.objects
        .filter((o): o is PlotObject => o.type === 'plot')
        .map((o) => [o.id, state.plotJobs[o.id]?.meshVersion ?? 0]),
    });
    if (sceneSignature !== this.lastQualitySignature) {
      this.resetQualityAccumulation({
        resetHistory: state.render.mode === 'quality',
        reason: 'scene_or_render_change',
      });
      this.lastQualitySignature = sceneSignature;
    }

    this.syncRenderDiagnostics(state);
  }

  private syncSceneSettings(state: Pick<AppState, 'scene' | 'render'>): void {
    if (!this.scene || !this.directionalLight || !this.groundMesh || !this.gridMesh) {
      return;
    }
    this.ensureDirectionalShadowGenerator(
      clamp(Math.round(state.scene.shadow.shadowMapResolution), 256, 4096),
      clamp01(state.scene.shadow.shadowSoftness),
    );

    if (this.ambientLight) {
      const ambientColor = color3(state.scene.ambient.color);
      this.ambientLight.intensity = state.scene.ambient.intensity;
      this.ambientLight.diffuse = ambientColor;
      this.ambientLight.specular = ambientColor.scale(0.15);
      this.ambientLight.groundColor = ambientColor.scale(0.08);
      this.ambientLight.setEnabled(state.scene.ambient.intensity > 0);
    }

    this.directionalLight.diffuse = color3(state.scene.directional.color);
    this.directionalLight.specular = color3(state.scene.directional.color);
    this.directionalLight.intensity = state.scene.directional.intensity;
    const dir = vec3(state.scene.directional.direction);
    if (dir.lengthSquared() > 1e-8) {
      dir.normalize();
      this.directionalLight.direction.copyFrom(dir);
      // Keep shadow/light position aligned with the direction vector relative to camera target.
      const target = this.camera?.target ?? Vector3.ZeroReadOnly;
      this.directionalLight.position.copyFrom(target.subtract(dir.scale(24)));
    }
    // Use a fixed frustum size in our z-up graphing space to avoid auto-fit misses.
    const graphBounds = state.scene.defaultGraphBounds;
    const graphSpanX = Math.abs(graphBounds.max.x - graphBounds.min.x);
    const graphSpanY = Math.abs(graphBounds.max.y - graphBounds.min.y);
    const graphSpanZ = Math.abs(graphBounds.max.z - graphBounds.min.z);
    const shadowFrustumSize = Math.max(
      12,
      state.scene.gridExtent * 2.4,
      state.scene.groundPlaneSize * 2.4,
      graphSpanX * 1.8,
      graphSpanY * 1.8,
    );
    this.directionalLight.shadowFrustumSize = shadowFrustumSize;
    this.directionalLight.shadowMinZ = 0.1;
    this.directionalLight.shadowMaxZ = Math.max(40, graphSpanZ * 6, shadowFrustumSize * 2);
    this.directionalLight.shadowOrthoScale = 0.2;
    this.directionalLight.setEnabled(state.scene.directional.intensity > 0 || state.scene.directional.castShadows);
    const directionalShadowsActive = state.scene.directional.castShadows && state.scene.shadow.directionalShadowEnabled;
    this.directionalLight.shadowEnabled = directionalShadowsActive;
    if (this.directionalShadow) {
      const shadowMap = this.directionalShadow.getShadowMap();
      if (shadowMap) {
        shadowMap.refreshRate = directionalShadowsActive ? 1 : 0;
      }
    }

    const clear = state.scene.backgroundMode === 'solid' ? state.scene.backgroundColor : state.scene.gradientBottomColor;
    this.scene.clearColor = Color4.FromColor3(color3(clear), 0);
    this.canvas.style.background =
      state.scene.backgroundMode === 'solid'
        ? state.scene.backgroundColor
        : `linear-gradient(${state.scene.gradientTopColor}, ${state.scene.gradientBottomColor})`;
    const ipc = this.scene.imageProcessingConfiguration;
    ipc.isEnabled = true;
    ipc.exposure = clamp(state.render.exposure, 0.01, 10);
    ipc.toneMappingEnabled = state.render.toneMapping !== 'none';
    ipc.toneMappingType =
      state.render.toneMapping === 'aces'
        ? ImageProcessingConfiguration.TONEMAPPING_ACES
        : ImageProcessingConfiguration.TONEMAPPING_STANDARD;

    this.groundMesh.isVisible = state.scene.groundPlaneVisible;
    this.groundMesh.receiveShadows = directionalShadowsActive;
    // Babylon ground geometry is created in local XZ; in our z-up app that means
    // we rotate it into XY and scale X/Z to keep it square.
    this.groundMesh.scaling = new Vector3(state.scene.groundPlaneSize, 1, state.scene.groundPlaneSize);
    // GridMaterial on a rotated ground is unreliable for an XY grid in this z-up scene.
    // We render explicit XY grid line meshes instead and keep this mesh hidden.
    this.gridMesh.isVisible = false;
    this.gridMesh.scaling = new Vector3(state.scene.gridExtent, 1, state.scene.gridExtent);
    this.syncXYGridLines(state);
    const groundMaterial = this.groundMesh.material;
    if (groundMaterial instanceof PBRMaterial) {
      groundMaterial.albedoColor = color3(state.scene.groundPlaneColor);
      groundMaterial.roughness = clamp01(state.scene.groundPlaneRoughness);
      groundMaterial.metallic = state.scene.groundPlaneReflective ? 0.05 : 0;
      groundMaterial.reflectionTexture = state.scene.groundPlaneReflective
        ? (this.groundMirror ?? this.scene.environmentTexture ?? null)
        : null;
      if (groundMaterial.reflectionTexture) {
        groundMaterial.reflectionTexture.level = state.scene.groundPlaneReflective ? 0.6 : 0;
      }
    }

    const gridMaterial = this.gridMesh.material;
    if (gridMaterial instanceof GridMaterial) {
      // Keep grid readable when the ground plane is hidden.
      gridMaterial.mainColor = state.scene.groundPlaneVisible
        ? color3(state.scene.groundPlaneColor)
        : new Color3(0.08, 0.1, 0.14);
      gridMaterial.lineColor = state.scene.groundPlaneVisible
        ? new Color3(0.15, 0.2, 0.3)
        : new Color3(0.72, 0.8, 0.95);
      gridMaterial.gridRatio = Math.max(0.05, state.scene.gridSpacing);
      gridMaterial.opacity = clamp01(state.scene.gridLineOpacity);
      gridMaterial.majorUnitFrequency = 5;
      gridMaterial.minorUnitVisibility = state.scene.groundPlaneVisible ? 0.3 : 0.45;
    }

    const axesVisible = state.scene.axesVisible;
    if (this.axesMeshes.length === 0 || Math.abs(this.axesMeshes[0].getBoundingInfo().boundingBox.extendSize.x - state.scene.axesLength / 2) > 1e-6) {
      this.createAxes(state.scene.axesLength);
    }
    this.axesMeshes.forEach((m) => {
      m.isVisible = axesVisible;
    });
  }

  private syncLights(state: Pick<AppState, 'scene' | 'objects'>): void {
    if (!this.scene) return;

    const pointLights = state.objects.filter((o): o is PointLightObject => o.type === 'point_light');
    const seen = new Set<string>();
    const interactiveQuality = useAppStore.getState().render.interactiveQuality;
    const selectedId = useAppStore.getState().selectedId;
    const shadowSettings = state.scene.shadow;
    const allowPointShadows =
      shadowSettings.pointShadowMode === 'on'
      || (shadowSettings.pointShadowMode === 'auto' && interactiveQuality !== 'performance');
    const pointShadowLimit = allowPointShadows ? clamp(Math.round(shadowSettings.pointShadowMaxLights), 0, 4) : 0;
    const pointShadowCandidates = pointLights
      .filter((light) => light.castShadows && light.intensity > 0)
      .sort((a, b) => {
        if (a.id === selectedId) return -1;
        if (b.id === selectedId) return 1;
        return b.intensity - a.intensity;
      })
      .slice(0, pointShadowLimit);
    const pointShadowIds = new Set(pointShadowCandidates.map((light) => light.id));

    pointLights.forEach((lightObj) => {
      seen.add(lightObj.id);
      let visual = this.pointLightVisuals.get(lightObj.id);
      if (!visual) {
        const light = new PointLight(`point-${lightObj.id}`, vec3(lightObj.position), this.scene!);
        const gizmo = MeshBuilder.CreateSphere(`gizmo-${lightObj.id}`, { diameter: 0.16, segments: 12 }, this.scene!);
        gizmo.parent = this.lightRoot;
        gizmo.metadata = { selectableId: lightObj.id, selectableType: 'point_light' };
        gizmo.isPickable = true;
        const mat = new StandardMaterial(`gizmo-mat-${lightObj.id}`, this.scene!);
        mat.emissiveColor = new Color3(1, 0.8, 0.4);
        mat.specularColor = Color3.Black();
        mat.disableLighting = true;
        gizmo.material = mat;

        const pickShell = MeshBuilder.CreateSphere(`gizmo-pick-${lightObj.id}`, { diameter: 1.1, segments: 6 }, this.scene!);
        pickShell.parent = gizmo;
        pickShell.metadata = { selectableId: lightObj.id, selectableType: 'point_light' };
        pickShell.isPickable = true;
        pickShell.visibility = 0.001;
        pickShell.renderingGroupId = 2;
        const pickMat = new StandardMaterial(`gizmo-pick-mat-${lightObj.id}`, this.scene!);
        pickMat.alpha = 0;
        pickMat.disableLighting = true;
        pickMat.specularColor = Color3.Black();
        pickShell.material = pickMat;

        const halo = MeshBuilder.CreateSphere(`gizmo-halo-${lightObj.id}`, { diameter: 0.38, segments: 8 }, this.scene!);
        halo.parent = gizmo;
        halo.isPickable = false;
        halo.renderingGroupId = 1;
        const haloMat = new StandardMaterial(`gizmo-halo-mat-${lightObj.id}`, this.scene!);
        haloMat.emissiveColor = new Color3(1, 0.8, 0.4);
        haloMat.specularColor = Color3.Black();
        haloMat.alpha = 0.28;
        haloMat.wireframe = true;
        haloMat.disableLighting = true;
        halo.material = haloMat;

        const starColor = new Color3(1, 0.8, 0.4);
        const starLines: LinesMesh[] = [];
        const lineSegments: Vector3[][] = [
          [new Vector3(-0.34, 0, 0), new Vector3(0.34, 0, 0)],
          [new Vector3(0, -0.34, 0), new Vector3(0, 0.34, 0)],
          [new Vector3(0, 0, -0.34), new Vector3(0, 0, 0.34)],
        ];
        lineSegments.forEach((points, idx) => {
          const line = MeshBuilder.CreateLines(`gizmo-star-${lightObj.id}-${idx}`, { points }, this.scene!);
          line.parent = gizmo;
          line.isPickable = false;
          line.color = starColor.clone();
          line.alpha = 0.9;
          starLines.push(line);
        });

        visual = { light, gizmo, pickShell, halo, starLines, shadow: null, shadowEnabled: false };
        this.pointLightVisuals.set(lightObj.id, visual);
      }

      // Light visibility only controls viewport gizmos. Emission remains active.
      visual.light.setEnabled(lightObj.intensity > 0);
      visual.gizmo.isVisible = lightObj.visible;
      visual.pickShell.isVisible = lightObj.visible;
      visual.halo.isVisible = lightObj.visible;
      visual.starLines.forEach((line) => {
        line.isVisible = lightObj.visible;
      });
      visual.light.position.copyFrom(vec3(lightObj.position));
      visual.gizmo.position.copyFrom(vec3(lightObj.position));
      visual.light.diffuse = color3(lightObj.color);
      visual.light.specular = color3(lightObj.color);
      visual.light.intensity = lightObj.intensity;
      visual.light.range = lightObj.range;
      visual.light.shadowMinZ = 0.1;
      visual.light.shadowMaxZ = Math.max(2, lightObj.range);
      const coreMat = visual.gizmo.material as StandardMaterial | null;
      if (coreMat) {
        coreMat.emissiveColor = color3(lightObj.color).scale(0.9).add(new Color3(0.1, 0.1, 0.1));
      }
      const haloMat = visual.halo.material as StandardMaterial | null;
      if (haloMat) {
        haloMat.emissiveColor = color3(lightObj.color);
      }
      visual.starLines.forEach((line) => {
        line.color = color3(lightObj.color);
      });

      const shouldUseShadow =
        pointShadowIds.has(lightObj.id)
        && shadowSettings.pointShadowMode !== 'off'
        && this.pointShadowCapability !== 'unavailable';

      if (shouldUseShadow && !visual.shadow) {
        try {
          visual.shadow = new ShadowGenerator(
            clamp(Math.round(shadowSettings.shadowMapResolution), 256, 4096),
            visual.light,
          );
          this.configureShadowGenerator(visual.shadow, clamp01(shadowSettings.shadowSoftness));
          this.pointShadowCapability = 'available';
        } catch (error) {
          this.pointShadowCapability = 'unavailable';
          visual.shadow?.dispose();
          visual.shadow = null;
          useAppStore.getState().setStatusMessage('Point-light shadows unavailable on this WebGPU/browser configuration');
          console.warn('Point-light shadow generator creation failed', error);
        }
      }
      if (shouldUseShadow && visual.shadow) {
        const desiredSize = clamp(Math.round(shadowSettings.shadowMapResolution), 256, 4096);
        const currentSize = visual.shadow.getShadowMap()?.getSize()?.width;
        if (currentSize !== desiredSize) {
          visual.shadow.dispose();
          visual.shadow = new ShadowGenerator(desiredSize, visual.light);
        }
      }
      if (!shouldUseShadow && visual.shadow) {
        visual.shadow.dispose();
        visual.shadow = null;
      }
      if (visual.shadow) {
        const map = visual.shadow.getShadowMap();
        if (map) {
          map.refreshRate = shouldUseShadow ? 1 : 0;
          map.renderList = map.renderList ?? [];
          map.renderList.length = 0;
        }
        this.configureShadowGenerator(visual.shadow, clamp01(shadowSettings.shadowSoftness));
      }
      visual.light.shadowEnabled = Boolean(visual.shadow && shouldUseShadow);
      visual.shadowEnabled = Boolean(visual.shadow && shouldUseShadow);
    });

    for (const [id, visual] of this.pointLightVisuals.entries()) {
      if (!seen.has(id)) {
        visual.shadow?.dispose();
        visual.pickShell.dispose(false, true);
        visual.halo.dispose(false, true);
        visual.starLines.forEach((line) => line.dispose(false, true));
        visual.gizmo.dispose(false, true);
        visual.light.dispose();
        this.pointLightVisuals.delete(id);
      }
    }
  }

  private syncPlots(state: Pick<AppState, 'scene' | 'objects' | 'plotJobs'>): void {
    if (!this.scene) return;
    const plots = state.objects.filter((obj): obj is PlotObject => obj.type === 'plot');
    const seen = new Set<string>();
    const directionalShadowsActive = Boolean(
      this.directionalShadow && state.scene.directional.castShadows && state.scene.shadow.directionalShadowEnabled,
    );
    if (this.directionalShadow) {
      const shadowMap = this.directionalShadow.getShadowMap();
      if (shadowMap) {
        shadowMap.renderList = shadowMap.renderList ?? [];
        shadowMap.renderList.length = 0;
      }
    }
    for (const pointLight of this.pointLightVisuals.values()) {
      if (pointLight.shadow) {
        const map = pointLight.shadow.getShadowMap();
        if (map) {
          map.renderList = map.renderList ?? [];
          map.renderList.length = 0;
        }
      }
    }

    for (const plot of plots) {
      seen.add(plot.id);
      const meshVersion = state.plotJobs[plot.id]?.meshVersion ?? 0;
      const geometryKey = buildGeometryKey(plot, meshVersion);
      const oldHash = this.meshHashCache.get(plot.id);

      let visual = this.plotVisuals.get(plot.id);
      const runtimeMesh = getRuntimePlotMesh(plot.id);
      const waitingForWorkerMesh = Boolean(
        !runtimeMesh
        && visual
        && plot.equation.source.parseStatus === 'ok'
        && isWorkerMeshPending(state.plotJobs[plot.id]),
      );
      if (waitingForWorkerMesh && oldHash !== geometryKey && visual) {
        // Keep the previous mesh on screen until preview/final worker output arrives.
        visual.root.parent = this.plotRoot;
        visual.root.isVisible = plot.visible;
        visual.root.position.copyFrom(vec3(plot.transform.position));
        visual.root.receiveShadows = directionalShadowsActive || this.hasAnyPointLightShadowsEnabled();
        this.applyPlotMaterial(plot, visual.root);
        if (plot.visible && directionalShadowsActive && this.directionalShadow) {
          this.directionalShadow.addShadowCaster(visual.root, true);
        }
        for (const pointLight of this.pointLightVisuals.values()) {
          if (plot.visible && pointLight.shadowEnabled) {
            pointLight.shadow?.addShadowCaster(visual.root, true);
          }
        }
        for (const wire of visual.wireframeLines) {
          wire.isVisible = plot.visible && Boolean(plot.material.wireframeVisible);
          wire.position.copyFrom(vec3(plot.transform.position));
        }
        continue;
      }
      if (!visual || oldHash !== geometryKey) {
        visual?.wireframeLines.forEach((line) => line.dispose(false, true));
        visual?.root.dispose(false, true);
        try {
          visual = this.buildPlotVisual(plot);
          this.plotVisuals.set(plot.id, visual);
          this.meshHashCache.set(plot.id, geometryKey);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Plot compile error';
          useAppStore.getState().setStatusMessage(message);
          continue;
        }
      }

      visual.root.parent = this.plotRoot;
      visual.root.isVisible = plot.visible;
      visual.root.position.copyFrom(vec3(plot.transform.position));
      visual.root.receiveShadows = directionalShadowsActive || this.hasAnyPointLightShadowsEnabled();
      this.applyPlotMaterial(plot, visual.root);
      if (plot.visible && directionalShadowsActive && this.directionalShadow) {
        this.directionalShadow.addShadowCaster(visual.root, true);
      }
      for (const pointLight of this.pointLightVisuals.values()) {
        if (plot.visible && pointLight.shadowEnabled) {
          pointLight.shadow?.addShadowCaster(visual.root, true);
        }
      }
      for (const wire of visual.wireframeLines) {
        wire.isVisible = plot.visible && Boolean(plot.material.wireframeVisible);
        wire.position.copyFrom(vec3(plot.transform.position));
      }
    }

    for (const [id, visual] of this.plotVisuals.entries()) {
      if (!seen.has(id)) {
        visual.wireframeLines.forEach((line) => line.dispose(false, true));
        visual.root.dispose(false, true);
        this.plotVisuals.delete(id);
        this.meshHashCache.delete(id);
      }
    }

    if (this.groundMirror) {
      this.groundMirror.renderList = [...this.plotVisuals.values()].map((visual) => visual.root);
    }

    if (this.groundMesh) {
      this.groundMesh.receiveShadows = state.scene.groundPlaneVisible && (directionalShadowsActive || this.hasAnyPointLightShadowsEnabled());
    }
  }

  private syncInteractiveReflectionSetup(state: Pick<AppState, 'scene' | 'render' | 'objects'>): void {
    if (!this.scene) {
      return;
    }
    this.scene.probesEnabled = true;
    this.scene.renderTargetsEnabled = true;
    this.scene.texturesEnabled = true;

    this.ensureEnvironmentFallbackTexture(state.scene);

    const hasReflectivePlot = state.objects.some((obj) => {
      if (obj.type !== 'plot' || !obj.visible) return false;
      const opacity = clamp01(obj.material.opacity);
      const transmission = clamp01(obj.material.transmission);
      const isRenderable = opacity > 0.02 || transmission > 0.02;
      return isRenderable && (obj.material.reflectiveness > 0.08 || obj.material.roughness < 0.25);
    });
    if (this.interactiveReflectionProbeBackoffFrames > 0) {
      this.interactiveReflectionProbeBackoffFrames -= 1;
    }
    if (this.interactiveReflectionProbeBlocked && this.interactiveReflectionProbeBackoffFrames <= 0) {
      this.interactiveReflectionProbeBlocked = false;
      this.interactiveReflectionProbeErrorStreak = 0;
    }
    const probeCoolingDown = this.interactiveReflectionProbeBackoffFrames > 0;
    const probeWouldBeUseful =
      state.render.mode === 'interactive'
      && state.render.interactiveQuality !== 'performance'
      && hasReflectivePlot;
    // Headless/WebDriver WebGPU contexts are prone to probe RTT validation hazards.
    // Keep probe support enabled for normal interactive sessions, but force fallback
    // in automated/headless runs for deterministic stability.
    const probeSupportedOnThisRenderer =
      !isHeadlessOrAutomatedBrowser()
      && !this.interactiveReflectionProbeBlocked
      && !probeCoolingDown;
    const wantsProbe =
      probeWouldBeUseful
      && probeSupportedOnThisRenderer;
    const desiredProbeSize = state.render.interactiveQuality === 'quality' ? 256 : 160;

    if (!wantsProbe) {
      this.restoreProbeCaptureMaterials();
      const usingProbeTexture = Boolean(
        this.sceneReflectionProbe
        && this.scene.environmentTexture === this.sceneReflectionProbe.cubeTexture,
      );
      if (usingProbeTexture) {
        this.scene.environmentTexture = null;
      }
      if (this.sceneReflectionProbe) {
        this.detachProbeFromSceneRenderTargets();
        this.sceneReflectionProbe.dispose();
        this.sceneReflectionProbe = null;
        this.sceneReflectionProbeSize = 0;
        this.lastInteractiveReflectionSignature = '';
      }
      this.interactiveReflectionLastRefreshReason = null;
      this.interactiveReflectionProbeWarmupFrames = 0;
      this.interactiveReflectionProbeUsable = false;
      this.interactiveReflectionProbeHasCapture = false;
      this.interactiveReflectionProbeManualKickRemaining = 0;
      this.interactiveReflectionProbeRetryCooldownFrames = 0;
      if (probeWouldBeUseful && !probeSupportedOnThisRenderer) {
        const reason = this.interactiveReflectionProbeBlocked
          ? `Reflection probe temporarily paused after repeated WebGPU validation errors; retrying in ~${Math.max(1, Math.ceil(this.interactiveReflectionProbeBackoffFrames / 60))}s`
          : probeCoolingDown
            ? `Reflection probe retry cooldown active (~${Math.max(1, Math.ceil(this.interactiveReflectionProbeBackoffFrames / 60))}s remaining); using environment fallback`
            : 'Reflection probe unavailable on this renderer; using environment fallback';
        this.activateEnvironmentFallback(reason);
      } else {
        this.activateEnvironmentFallback(null);
      }
      return;
    }

    if (!this.sceneReflectionProbe || this.sceneReflectionProbeSize !== desiredProbeSize) {
      try {
        this.restoreProbeCaptureMaterials();
        this.detachProbeFromSceneRenderTargets();
        this.sceneReflectionProbe?.dispose();
        this.sceneReflectionProbe = new ReflectionProbe(
          'interactive-scene-reflections',
          desiredProbeSize,
          this.scene,
          // WebGPU stability: generating probe mipmaps can trigger a texture
          // read/write validation hazard on some drivers in this app path.
          false,
          false,
          false,
        );
        this.sceneReflectionProbeSize = desiredProbeSize;
        this.sceneReflectionProbe.cubeTexture.gammaSpace = false;
        this.sceneReflectionProbe.cubeTexture.activeCamera = this.camera;
        this.sceneReflectionProbe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME;
        this.sceneReflectionProbe.cubeTexture.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME;
        this.attachProbeToSceneRenderTargets();
        this.sceneReflectionProbe.cubeTexture.onBeforeBindObservable.add(() => {
          this.prepareProbeCaptureMaterials();
        });
        this.sceneReflectionProbe.cubeTexture.onAfterUnbindObservable.add(() => {
          this.restoreProbeCaptureMaterials();
          const hasRenderableMeshes = (this.sceneReflectionProbe?.renderList?.length ?? 0) > 0;
          if (!hasRenderableMeshes) {
            return;
          }
          this.interactiveReflectionProbeHasCapture = true;
          this.interactiveReflectionProbeRetryCooldownFrames = 0;
          this.interactiveReflectionProbeErrorStreak = 0;
          this.interactiveReflectionProbeBackoffFrames = 0;
        });
        this.interactiveReflectionProbeUsable = false;
        this.interactiveReflectionProbeHasCapture = false;
        this.interactiveReflectionProbeManualKickRemaining = 2;
        this.interactiveReflectionProbeRetryCooldownFrames = 0;
        this.lastInteractiveReflectionSignature = '';
      } catch (error) {
        this.restoreProbeCaptureMaterials();
        this.detachProbeFromSceneRenderTargets();
        this.sceneReflectionProbe?.dispose();
        this.sceneReflectionProbe = null;
        this.sceneReflectionProbeSize = 0;
        this.interactiveReflectionLastRefreshReason = null;
        this.interactiveReflectionProbeWarmupFrames = 0;
        this.interactiveReflectionProbeUsable = false;
        this.interactiveReflectionProbeHasCapture = false;
        this.interactiveReflectionProbeManualKickRemaining = 0;
        this.interactiveReflectionProbeRetryCooldownFrames = 0;
        this.interactiveReflectionProbeErrorStreak = 0;
        this.interactiveReflectionProbeBackoffFrames = 0;
        this.activateEnvironmentFallback('Reflection probe unavailable; using environment fallback');
        console.warn('Interactive reflection probe creation failed', error);
        return;
      }
    }

    this.attachProbeToSceneRenderTargets();

    const bounds = state.scene.defaultGraphBounds;
    this.sceneReflectionProbe.position.set(
      (bounds.min.x + bounds.max.x) * 0.5,
      (bounds.min.y + bounds.max.y) * 0.5,
      (bounds.min.z + bounds.max.z) * 0.5,
    );

    if (this.interactiveReflectionProbeUsable && this.activateProbeEnvironment()) {
      return;
    }
    this.activateEnvironmentFallback('Refreshing reflection probe');
  }

  private syncInteractiveReflectionProbe(state: Pick<AppState, 'scene' | 'render' | 'objects' | 'plotJobs'>): void {
    if (!this.sceneReflectionProbe || !this.scene) {
      return;
    }

    this.attachProbeToSceneRenderTargets();

    const renderList: Mesh[] = [];
    if (state.scene.groundPlaneVisible && this.groundMesh) {
      renderList.push(this.groundMesh);
    }
    for (const obj of state.objects) {
      if (obj.type !== 'plot' || !obj.visible) {
        continue;
      }
      const visual = this.plotVisuals.get(obj.id);
      if (visual?.root) {
        renderList.push(visual.root);
      }
    }
    this.sceneReflectionProbe.renderList = renderList;

    const reflectionSignature = JSON.stringify({
      interactiveQuality: state.render.interactiveQuality,
      probeSize: this.sceneReflectionProbeSize,
      probePosition: {
        x: round3(this.sceneReflectionProbe.position.x),
        y: round3(this.sceneReflectionProbe.position.y),
        z: round3(this.sceneReflectionProbe.position.z),
      },
      scene: {
        backgroundMode: state.scene.backgroundMode,
        backgroundColor: state.scene.backgroundColor,
        gradientTopColor: state.scene.gradientTopColor,
        gradientBottomColor: state.scene.gradientBottomColor,
        groundPlaneVisible: state.scene.groundPlaneVisible,
        groundPlaneColor: state.scene.groundPlaneColor,
        groundPlaneRoughness: round3(state.scene.groundPlaneRoughness),
        ambientColor: state.scene.ambient.color,
        ambientIntensity: round3(state.scene.ambient.intensity),
        directionalColor: state.scene.directional.color,
        directionalIntensity: round3(state.scene.directional.intensity),
        directionalDirection: {
          x: round3(state.scene.directional.direction.x),
          y: round3(state.scene.directional.direction.y),
          z: round3(state.scene.directional.direction.z),
        },
      },
      plots: state.objects
        .filter((o): o is PlotObject => o.type === 'plot' && o.visible)
        .map((plot) => ({
          id: plot.id,
          meshVersion: state.plotJobs[plot.id]?.meshVersion ?? 0,
          pos: {
            x: round3(plot.transform.position.x),
            y: round3(plot.transform.position.y),
            z: round3(plot.transform.position.z),
          },
          material: {
            baseColor: plot.material.baseColor,
            opacity: round3(plot.material.opacity),
            transmission: round3(plot.material.transmission),
            reflectiveness: round3(plot.material.reflectiveness),
            roughness: round3(plot.material.roughness),
          },
        })),
      lights: state.objects
        .filter((o): o is PointLightObject => o.type === 'point_light')
        .map((light) => ({
          id: light.id,
          pos: {
            x: round3(light.position.x),
            y: round3(light.position.y),
            z: round3(light.position.z),
          },
          color: light.color,
          intensity: round3(light.intensity),
          range: round3(light.range),
        })),
    });

    if (reflectionSignature !== this.lastInteractiveReflectionSignature) {
      this.requestInteractiveReflectionProbeRefresh(this.lastInteractiveReflectionSignature ? 'scene_update' : 'probe_init');
      this.lastInteractiveReflectionSignature = reflectionSignature;
      this.rebindPlotMaterialsFromStateObjects(state.objects);
    }
  }

  private requestInteractiveReflectionProbeRefresh(reason: string): void {
    if (!this.sceneReflectionProbe) {
      return;
    }
    this.attachProbeToSceneRenderTargets();
    this.activateEnvironmentFallback(reason === 'probe_init' ? 'Building reflection probe' : 'Refreshing reflection probe');
    this.sceneReflectionProbe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME;
    this.sceneReflectionProbe.cubeTexture.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME;
    this.sceneReflectionProbe.cubeTexture.resetRefreshCounter();
    this.interactiveReflectionLastRefreshReason = reason;
    this.interactiveReflectionProbeRefreshCount += 1;
    // Avoid sampling the probe texture in the same frame it is refreshed (WebGPU read/write hazard).
    this.interactiveReflectionProbeWarmupFrames = 1;
    this.interactiveReflectionProbeUsable = false;
    this.interactiveReflectionProbeHasCapture = false;
    this.interactiveReflectionProbeManualKickRemaining = 3;
    this.interactiveReflectionProbeRetryCooldownFrames = 0;
  }

  private ensureEnvironmentFallbackTexture(sceneSettings: AppState['scene']): void {
    if (!this.scene || typeof document === 'undefined') {
      return;
    }

    const probeTexture = this.sceneReflectionProbe?.cubeTexture ?? null;
    const usingProbeTexture = Boolean(probeTexture && this.scene.environmentTexture === probeTexture);
    const hasExternalEnvironmentTexture = Boolean(
      this.scene.environmentTexture
      && this.scene.environmentTexture !== this.environmentFallbackTexture
      && !usingProbeTexture,
    );

    if (this.environmentFallbackTexture) {
      const fallbackReady = this.isUsableReflectionTexture(this.environmentFallbackTexture);
      if (fallbackReady) {
        this.environmentFallbackPendingFrames = 0;
        this.interactiveReflectionFallbackEverUsable = true;
      } else {
        this.environmentFallbackPendingFrames += 1;
      }
      const fallbackInternal = this.environmentFallbackTexture.getInternalTexture();
      const fallbackStuckNotReady =
        !fallbackReady
        && !fallbackInternal
        && this.environmentFallbackPendingFrames > 12;
      this.environmentFallbackTextureWasReady = fallbackReady;
      if (
        !usingProbeTexture
        && !hasExternalEnvironmentTexture
        && this.scene.environmentTexture !== this.environmentFallbackTexture
        && fallbackReady
      ) {
        this.scene.environmentTexture = this.environmentFallbackTexture;
      }
      if (fallbackStuckNotReady) {
        // Keep the same fallback instance alive to avoid asynchronous
        // spherical-polynomial completion racing with disposal.
      }
      return;
    }

    if (!this.environmentFallbackTexture) {
      try {
        const topBase = sceneSettings.backgroundMode === 'gradient'
          ? color3(sceneSettings.gradientTopColor)
          : color3(sceneSettings.backgroundColor);
        const bottomBase = sceneSettings.backgroundMode === 'gradient'
          ? color3(sceneSettings.gradientBottomColor)
          : color3(sceneSettings.backgroundColor);
        const groundBase = color3(sceneSettings.groundPlaneColor);
        const ambientTint = color3(sceneSettings.ambient.color).scale(clamp(sceneSettings.ambient.intensity * 0.2, 0, 0.3));
        const sunTint = color3(sceneSettings.directional.color).scale(clamp(sceneSettings.directional.intensity * 0.12, 0, 0.35));
        const sideColor = mixColor(mixColor(topBase, bottomBase, 0.55), ambientTint, 0.45);
        const upColor = mixColor(topBase, sunTint, 0.35);
        const downColor = mixColor(bottomBase.scale(0.55), groundBase.scale(0.9), 0.6);
        const neutralHorizon = mixColor(sideColor, mixColor(upColor, downColor, 0.5), 0.25);
        // Keep fallback neutral and seam-free so it does not look like a visible room cube.
        const fallbackTop = mixColor(neutralHorizon, upColor, 0.08);
        const fallbackBottom = mixColor(neutralHorizon, downColor, 0.08);

        const envWidth = 64;
        const envHeight = 32;
        const envData = makeEnvironmentEquirectBytes(
          fallbackTop,
          fallbackBottom,
          envWidth,
          envHeight,
        );
        const equirect = RawTexture.CreateRGBATexture(
          envData,
          envWidth,
          envHeight,
          this.scene,
          false,
          false,
          Texture.TRILINEAR_SAMPLINGMODE,
        );
        equirect.coordinatesMode = Texture.EQUIRECTANGULAR_MODE;
        equirect.wrapU = Texture.CLAMP_ADDRESSMODE;
        equirect.wrapV = Texture.CLAMP_ADDRESSMODE;
        equirect.level = 1;

        const fallbackTexture: BaseTexture = equirect;
        const fallbackKind: RenderDiagnostics['interactiveReflectionFallbackKind'] = 'raw_equirect';

        this.environmentFallbackTexture = fallbackTexture;
        this.interactiveReflectionFallbackKind = fallbackKind;
        this.environmentFallbackTexture.name = 'interactive-env-fallback';
        this.environmentFallbackTexture.gammaSpace = false;
        this.environmentFallbackTextureWasReady = this.isUsableReflectionTexture(this.environmentFallbackTexture);
        if (this.environmentFallbackTextureWasReady) {
          this.interactiveReflectionFallbackEverUsable = true;
        }
        this.environmentFallbackPendingFrames = this.environmentFallbackTextureWasReady ? 0 : 1;
        if (!usingProbeTexture && !hasExternalEnvironmentTexture && this.environmentFallbackTextureWasReady) {
          this.scene.environmentTexture = this.environmentFallbackTexture;
        }
        if (this.environmentFallbackTextureWasReady) {
          if (this.interactiveReflectionPath === 'probe') {
            this.activateProbeEnvironment();
          } else {
            this.activateEnvironmentFallback(this.interactiveReflectionFallbackReason);
          }
        }
      } catch (error) {
        if (this.scene.environmentTexture === this.environmentFallbackTexture) {
          this.scene.environmentTexture = null;
        }
        this.environmentFallbackTexture?.dispose();
        this.environmentFallbackTexture = null;
        this.environmentFallbackTextureWasReady = false;
        this.environmentFallbackPendingFrames = 0;
        this.interactiveReflectionFallbackKind = 'none';
        if (this.interactiveReflectionPath === 'probe') {
          this.activateProbeEnvironment();
        } else {
          this.activateEnvironmentFallback('Environment fallback unavailable');
        }
        console.warn('Interactive environment fallback texture creation failed', error);
      }
      return;
    }

  }

  private prepareProbeCaptureMaterials(): void {
    if (!this.sceneReflectionProbe) {
      return;
    }
    this.probeCaptureMaterialOverrides.length = 0;
    const probeTexture = this.sceneReflectionProbe.cubeTexture as BaseTexture;
    const fallbackTexture = this.environmentFallbackTexture;
    const readyFallbackTexture =
      fallbackTexture
      && fallbackTexture !== probeTexture
      && this.isUsableReflectionTexture(fallbackTexture)
        ? fallbackTexture
        : null;
    const sceneEnvironmentTexture = this.scene?.environmentTexture ?? null;
    const readyExternalEnvironmentTexture =
      sceneEnvironmentTexture
      && sceneEnvironmentTexture !== probeTexture
      && sceneEnvironmentTexture !== fallbackTexture
      && this.isUsableReflectionTexture(sceneEnvironmentTexture)
        ? sceneEnvironmentTexture
        : null;
    const captureSafeTexture = readyFallbackTexture ?? readyExternalEnvironmentTexture ?? null;
    const seenMaterials = new Set<PBRMaterial>();
    const renderList = this.sceneReflectionProbe.renderList ?? [];
    for (const mesh of renderList) {
      const material = mesh.material;
      if (!(material instanceof PBRMaterial) || seenMaterials.has(material)) {
        continue;
      }
      seenMaterials.add(material);
      if (material.reflectionTexture !== probeTexture) {
        continue;
      }
      this.probeCaptureMaterialOverrides.push({
        material,
        reflectionTexture: material.reflectionTexture,
      });
      material.reflectionTexture = captureSafeTexture;
    }
  }

  private restoreProbeCaptureMaterials(): void {
    for (const entry of this.probeCaptureMaterialOverrides) {
      entry.material.reflectionTexture = entry.reflectionTexture;
    }
    this.probeCaptureMaterialOverrides.length = 0;
  }

  private rebindPlotMaterialsFromStateObjects(objects: SceneObject[]): void {
    for (const obj of objects) {
      if (obj.type !== 'plot') continue;
      const visual = this.plotVisuals.get(obj.id);
      if (!visual) continue;
      this.applyPlotMaterial(obj, visual.root);
    }
  }

  private attachProbeToSceneRenderTargets(): void {
    if (!this.scene || !this.sceneReflectionProbe) {
      return;
    }
    this.scene.customRenderTargets ??= [];
    if (!this.scene.customRenderTargets.includes(this.sceneReflectionProbe.cubeTexture)) {
      this.scene.customRenderTargets.push(this.sceneReflectionProbe.cubeTexture);
    }
    if (this.camera) {
      this.camera.customRenderTargets ??= [];
      if (!this.camera.customRenderTargets.includes(this.sceneReflectionProbe.cubeTexture)) {
        this.camera.customRenderTargets.push(this.sceneReflectionProbe.cubeTexture);
      }
    }
  }

  private detachProbeFromSceneRenderTargets(): void {
    if (!this.sceneReflectionProbe) {
      return;
    }
    if (this.scene?.customRenderTargets?.length) {
      const sceneIndex = this.scene.customRenderTargets.indexOf(this.sceneReflectionProbe.cubeTexture);
      if (sceneIndex >= 0) {
        this.scene.customRenderTargets.splice(sceneIndex, 1);
      }
    }
    if (this.camera?.customRenderTargets?.length) {
      const cameraIndex = this.camera.customRenderTargets.indexOf(this.sceneReflectionProbe.cubeTexture);
      if (cameraIndex >= 0) {
        this.camera.customRenderTargets.splice(cameraIndex, 1);
      }
    }
  }

  private advanceInteractiveReflectionProbeWarmup(): void {
    if (this.interactiveReflectionProbeWarmupFrames > 0) {
      this.interactiveReflectionProbeWarmupFrames -= 1;
      if (this.interactiveReflectionProbeWarmupFrames > 0) {
        return;
      }
    }
    if (!this.sceneReflectionProbe || this.interactiveReflectionProbeUsable) {
      return;
    }
    this.attachProbeToSceneRenderTargets();
    if (!this.interactiveReflectionProbeHasCapture) {
      if (this.interactiveReflectionProbeManualKickRemaining > 0) {
        this.interactiveReflectionProbeManualKickRemaining -= 1;
        this.kickReflectionProbeCapture();
      } else if (this.interactiveReflectionProbeRetryCooldownFrames <= 0) {
        // Keep retrying until capture succeeds so reflections don't require a manual scene nudge.
        this.kickReflectionProbeCapture();
        this.interactiveReflectionProbeRetryCooldownFrames = 10;
      } else {
        this.interactiveReflectionProbeRetryCooldownFrames -= 1;
      }
      // Wait until the probe has completed at least one capture pass.
      return;
    }
    this.interactiveReflectionProbeRetryCooldownFrames = 0;
    this.interactiveReflectionProbeUsable = true;
    this.sceneReflectionProbe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    this.sceneReflectionProbe.cubeTexture.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    if (!this.activateProbeEnvironment()) {
      this.activateEnvironmentFallback('Reflection probe ready, but environment binding failed');
    }
  }

  private kickReflectionProbeCapture(): void {
    if (!this.sceneReflectionProbe || this.interactiveReflectionProbeHasCapture) {
      return;
    }
    const renderList = this.sceneReflectionProbe.renderList ?? [];
    if (renderList.length === 0) {
      return;
    }
    try {
      this.sceneReflectionProbe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
      this.sceneReflectionProbe.cubeTexture.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
      this.sceneReflectionProbe.cubeTexture.resetRefreshCounter();
      this.sceneReflectionProbe.cubeTexture.render(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Manual reflection probe capture failed';
      if (!this.tryRecoverFromRenderError(message, error)) {
        console.warn('Manual reflection probe capture failed', error);
      }
    }
  }

  private maybeRebindAfterReflectionTextureReady(): void {
    if (!this.environmentFallbackTexture) {
      this.environmentFallbackTextureWasReady = false;
      return;
    }
    const ready = this.isUsableReflectionTexture(this.environmentFallbackTexture);
    if (ready && !this.environmentFallbackTextureWasReady) {
      this.environmentFallbackTextureWasReady = true;
      if (this.interactiveReflectionPath === 'probe') {
        this.activateProbeEnvironment();
      } else {
        this.activateEnvironmentFallback(this.interactiveReflectionFallbackReason);
      }
      return;
    }
    if (!ready && this.environmentFallbackTextureWasReady) {
      if (this.scene?.environmentTexture === this.environmentFallbackTexture) {
        this.scene.environmentTexture = null;
      }
      if (this.interactiveReflectionPath === 'probe') {
        this.activateProbeEnvironment();
      } else {
        this.activateEnvironmentFallback(this.interactiveReflectionFallbackReason);
      }
    }
    this.environmentFallbackTextureWasReady = ready;
  }

  private tryRecoverFromRenderError(message: string, error: unknown): boolean {
    if (!this.sceneReflectionProbe || this.interactiveReflectionProbeBlocked) {
      return false;
    }
    const normalized = message.toLowerCase();
    const looksLikeWebGPUProbeHazard =
      normalized.includes('commandbuffer')
      || normalized.includes('gpuvalidationerror')
      || normalized.includes('renderattachment')
      || normalized.includes('synchronization scope')
      || normalized.includes('texturebinding');
    if (!looksLikeWebGPUProbeHazard) {
      return false;
    }

    this.restoreProbeCaptureMaterials();
    if (this.scene?.environmentTexture === this.sceneReflectionProbe.cubeTexture) {
      this.scene.environmentTexture = null;
    }
    this.detachProbeFromSceneRenderTargets();
    this.sceneReflectionProbe.dispose();
    this.sceneReflectionProbe = null;
    this.sceneReflectionProbeSize = 0;
    this.interactiveReflectionProbeUsable = false;
    this.interactiveReflectionProbeWarmupFrames = 0;
    this.interactiveReflectionProbeHasCapture = false;
    this.interactiveReflectionProbeManualKickRemaining = 0;
    this.interactiveReflectionProbeRetryCooldownFrames = 0;
    this.lastInteractiveReflectionSignature = '';
    this.interactiveReflectionProbeErrorStreak += 1;
    const shouldHardDisable = this.interactiveReflectionProbeErrorStreak >= INTERACTIVE_REFLECTION_PROBE_MAX_ERROR_STREAK;
    if (shouldHardDisable) {
      this.interactiveReflectionProbeBlocked = true;
      this.interactiveReflectionProbeBackoffFrames = INTERACTIVE_REFLECTION_PROBE_BLOCKED_COOLDOWN_FRAMES;
      this.interactiveReflectionLastRefreshReason = 'probe_runtime_error_blocked_retry';
      const retrySeconds = Math.max(1, Math.ceil(this.interactiveReflectionProbeBackoffFrames / 60));
      this.activateEnvironmentFallback(
        `Reflection probe temporarily paused after repeated WebGPU validation errors; retrying in ~${retrySeconds}s`,
      );
      useAppStore.getState().setStatusMessage(
        `Reflection probe hit repeated WebGPU validation errors; retrying in ~${retrySeconds}s.`,
      );
    } else {
      this.interactiveReflectionProbeBlocked = false;
      this.interactiveReflectionProbeBackoffFrames =
        INTERACTIVE_REFLECTION_PROBE_RETRY_BASE_BACKOFF_FRAMES
        * (2 ** (this.interactiveReflectionProbeErrorStreak - 1));
      this.interactiveReflectionLastRefreshReason = 'probe_runtime_error_retry';
      const retrySeconds = Math.max(1, Math.ceil(this.interactiveReflectionProbeBackoffFrames / 60));
      this.activateEnvironmentFallback(
        `Reflection probe paused after WebGPU validation error; retrying in ~${retrySeconds}s`,
      );
      useAppStore.getState().setStatusMessage(
        `Reflection probe capture failed; retrying in ~${retrySeconds}s (${this.interactiveReflectionProbeErrorStreak}/${INTERACTIVE_REFLECTION_PROBE_MAX_ERROR_STREAK}).`,
      );
    }
    console.warn('Recovered from WebGPU probe error via fallback/retry policy', error);
    return true;
  }

  private activateEnvironmentFallback(reason: string | null): boolean {
    if (!this.scene) {
      this.interactiveReflectionPath = 'none';
      this.interactiveReflectionFallbackReason = reason ?? 'Environment fallback unavailable';
      this.interactiveReflectionSource = 'none';
      this.interactiveReflectionTexture = null;
      return false;
    }
    const probeTexture = this.sceneReflectionProbe?.cubeTexture ?? null;
    const fallbackTexture = this.environmentFallbackTexture;
    if (fallbackTexture && this.isUsableReflectionTexture(fallbackTexture)) {
      return this.applyInteractiveReflectionSource(
        'fallback_ready',
        fallbackTexture,
        reason,
        fallbackTexture,
      );
    }
    const environmentTexture = this.scene.environmentTexture ?? null;
    if (
      environmentTexture
      && environmentTexture !== probeTexture
      && environmentTexture !== fallbackTexture
      && this.isUsableReflectionTexture(environmentTexture)
    ) {
      return this.applyInteractiveReflectionSource(
        'external_env',
        environmentTexture,
        reason,
        environmentTexture,
      );
    }
    return this.applyInteractiveReflectionSource('none', null, reason, null);
  }

  private activateProbeEnvironment(): boolean {
    if (!this.scene || !this.sceneReflectionProbe || !this.interactiveReflectionProbeHasCapture) {
      return false;
    }
    const probeTexture = this.sceneReflectionProbe.cubeTexture as BaseTexture;
    const fallbackTexture = this.environmentFallbackTexture;
    const readyFallbackTexture =
      fallbackTexture
      && fallbackTexture !== probeTexture
      && this.isUsableReflectionTexture(fallbackTexture)
        ? fallbackTexture
        : null;
    const environmentTexture = this.scene.environmentTexture ?? null;
    const readyExternalTexture =
      environmentTexture
      && environmentTexture !== probeTexture
      && environmentTexture !== fallbackTexture
      && this.isUsableReflectionTexture(environmentTexture)
        ? environmentTexture
        : null;
    const sceneEnvironmentTexture = readyFallbackTexture ?? readyExternalTexture ?? null;
    return this.applyInteractiveReflectionSource(
      'probe_ready',
      probeTexture,
      null,
      sceneEnvironmentTexture,
    );
  }

  private applyInteractiveReflectionSource(
    source: InteractiveReflectionSource,
    reflectionTexture: Nullable<BaseTexture>,
    reason: string | null,
    sceneEnvironmentTexture: Nullable<BaseTexture>,
  ): boolean {
    if (!this.scene) {
      this.interactiveReflectionSource = 'none';
      this.interactiveReflectionTexture = null;
      this.interactiveReflectionPath = 'none';
      this.interactiveReflectionFallbackReason = reason ?? 'Environment fallback unavailable';
      return false;
    }
    const nextPath: RenderDiagnostics['interactiveReflectionPath'] =
      source === 'probe_ready' ? 'probe' : source === 'none' ? 'none' : 'environment_fallback';
    const nextReason =
      nextPath === 'probe'
        ? null
        : reason ?? (nextPath === 'none' ? 'Environment fallback unavailable' : null);
    const sourceChanged = this.interactiveReflectionSource !== source;
    const textureChanged = this.interactiveReflectionTexture !== reflectionTexture;
    if (this.scene.environmentTexture !== sceneEnvironmentTexture) {
      this.scene.environmentTexture = sceneEnvironmentTexture;
    }
    this.interactiveReflectionSource = source;
    this.interactiveReflectionTexture = reflectionTexture;
    this.interactiveReflectionPath = nextPath;
    this.interactiveReflectionFallbackReason = nextReason;
    if (sourceChanged || textureChanged) {
      this.rebindPlotMaterialsFromStateObjects(useAppStore.getState().objects);
    }
    return source !== 'none';
  }

  private isUsableReflectionTexture(texture: Nullable<BaseTexture>): boolean {
    if (!texture) {
      return false;
    }
    if (texture.isReady()) {
      return true;
    }
    const internal = texture.getInternalTexture();
    if (!internal) {
      return false;
    }
    return !((internal as { isDisposed?: boolean }).isDisposed ?? false);
  }

  private resolvePlotReflectionTexture(): Nullable<BaseTexture> {
    if (
      this.interactiveReflectionPath === 'probe'
      && this.sceneReflectionProbe
      && this.interactiveReflectionProbeHasCapture
    ) {
      return this.sceneReflectionProbe.cubeTexture;
    }
    const sceneEnvironmentTexture = this.scene?.environmentTexture ?? null;
    if (
      sceneEnvironmentTexture
      && sceneEnvironmentTexture !== this.sceneReflectionProbe?.cubeTexture
      && this.isUsableReflectionTexture(sceneEnvironmentTexture)
    ) {
      return sceneEnvironmentTexture;
    }
    const fallback = this.environmentFallbackTexture ?? null;
    if (this.isUsableReflectionTexture(fallback)) {
      return fallback;
    }
    return null;
  }

  private buildPlotVisual(plot: PlotObject): PlotVisual {
    if (!this.scene) {
      throw new Error('Scene not initialized');
    }

    const runtimeMesh = getRuntimePlotMesh(plot.id);
    if (runtimeMesh) {
      return this.buildPlotVisualFromSerialized(plot, runtimeMesh);
    }

    const compiled = compilePlotObject(plot);

    let root: Mesh;
    const wireframeLines: LinesMesh[] = [];
    let curveTube: PlotVisual['curveTube'];

    if (compiled.kind === 'curve') {
      const sample = sampleCurve(
        compiled.spec.tDomain.min,
        compiled.spec.tDomain.max,
        compiled.spec.tDomain.samples,
        (t) => compiled.fn(t),
      );
      const path = sample.points.map((p) => new Vector3(p.x, p.y, p.z));
      if (compiled.spec.renderAsTube) {
        const referenceCameraRadius = Math.max(0.1, this.camera?.radius ?? 20);
        root = MeshBuilder.CreateTube(`plot-${plot.id}`, {
          path,
          radius: compiled.spec.tubeRadius,
          tessellation: 12,
          cap: Mesh.CAP_ALL,
          updatable: true,
        }, this.scene);
        curveTube = {
          path,
          baseRadius: compiled.spec.tubeRadius,
          referenceCameraRadius,
          currentRadius: compiled.spec.tubeRadius,
        };
      } else {
        root = MeshBuilder.CreateLines(`plot-${plot.id}`, { points: path, updatable: false }, this.scene) as unknown as Mesh;
      }
    } else if (compiled.kind === 'surface') {
      const meshData = buildSurfaceMesh(
        compiled.spec.domain,
        (u, v) => compiled.fn(u, v),
        plot.material.wireframeCellSize ?? 4,
      );
      root = new Mesh(`plot-${plot.id}`, this.scene);
      const vd = new VertexData();
      vd.positions = Array.from(meshData.positions);
      vd.indices = Array.from(meshData.indices);
      if (meshData.normals) {
        vd.normals = Array.from(meshData.normals);
      }
      if (meshData.uvs) {
        vd.uvs = Array.from(meshData.uvs);
      }
      vd.applyToMesh(root);

      if (meshData.lines) {
        meshData.lines.forEach((coords, idx) => {
          const points: Vector3[] = [];
          for (let i = 0; i < coords.length; i += 3) {
            const x = coords[i];
            const y = coords[i + 1];
            const z = coords[i + 2];
            if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
              points.push(new Vector3(x, y, z));
            }
          }
          if (points.length >= 2) {
            const line = MeshBuilder.CreateLines(`plot-${plot.id}-wire-${idx}`, { points }, this.scene);
            line.color = Color3.FromHexString('#0f172a');
            line.parent = this.plotRoot;
            line.isPickable = false;
            wireframeLines.push(line);
          }
        });
      }
    } else {
      const meshData = buildImplicitMeshFromScalarField(
        compiled.spec.bounds,
        (x, y, z) => compiled.fn(x, y, z),
        compiled.spec.quality,
        compiled.spec.isoValue,
      );
      root = new Mesh(`plot-${plot.id}`, this.scene);
      const vd = new VertexData();
      vd.positions = Array.from(meshData.positions);
      vd.indices = Array.from(meshData.indices);
      if (meshData.normals) {
        vd.normals = Array.from(meshData.normals);
      }
      vd.applyToMesh(root);
    }

    root.metadata = { selectableId: plot.id, selectableType: 'plot' };
    root.isPickable = true;
    root.parent = this.plotRoot;
    root.receiveShadows = true;
    root.renderOverlay = false;

    return { root, wireframeLines, geometryKey: buildGeometryKey(plot), curveTube };
  }

  private buildPlotVisualFromSerialized(plot: PlotObject, meshData: SerializedMesh): PlotVisual {
    if (!this.scene) {
      throw new Error('Scene not initialized');
    }

    let root: Mesh;
    const wireframeLines: LinesMesh[] = [];
    let curveTube: PlotVisual['curveTube'];

    if (meshData.curvePath && meshData.curvePath.length >= 6) {
      const path = floatArrayToVector3Path(meshData.curvePath);
      if (plot.equation.kind === 'parametric_curve' && plot.equation.renderAsTube) {
        const referenceCameraRadius = Math.max(0.1, this.camera?.radius ?? 20);
        root = MeshBuilder.CreateTube(
          `plot-${plot.id}`,
          {
            path,
            radius: plot.equation.tubeRadius,
            tessellation: 12,
            cap: Mesh.CAP_ALL,
            updatable: true,
          },
          this.scene,
        );
        curveTube = {
          path,
          baseRadius: plot.equation.tubeRadius,
          referenceCameraRadius,
          currentRadius: plot.equation.tubeRadius,
        };
      } else {
        root = MeshBuilder.CreateLines(`plot-${plot.id}`, { points: path, updatable: false }, this.scene) as unknown as Mesh;
      }
    } else {
      root = new Mesh(`plot-${plot.id}`, this.scene);
      applySerializedMeshToBabylonMesh(root, meshData);
    }

    if (meshData.lines) {
      meshData.lines.forEach((coords, idx) => {
        const points = floatArrayToVector3Path(coords);
        if (points.length >= 2) {
          const line = MeshBuilder.CreateLines(`plot-${plot.id}-wire-${idx}`, { points }, this.scene);
          line.color = Color3.FromHexString('#0f172a');
          line.parent = this.plotRoot;
          line.isPickable = false;
          wireframeLines.push(line);
        }
      });
    }

    root.metadata = { selectableId: plot.id, selectableType: 'plot' };
    root.isPickable = true;
    root.parent = this.plotRoot;
    root.receiveShadows = true;
    root.renderOverlay = false;

    return { root, wireframeLines, geometryKey: buildGeometryKey(plot), curveTube };
  }

  private applyPlotMaterial(plot: PlotObject, mesh: Mesh): void {
    if (!this.scene) return;
    let material = mesh.material;
    if (!(material instanceof PBRMaterial)) {
      material = new PBRMaterial(`mat-${plot.id}`, this.scene);
      mesh.material = material;
    }
    const pbr = material as PBRMaterial;
    const reflectiveness = clamp01(plot.material.reflectiveness);
    const roughness = clamp(plot.material.roughness, 0.02, 1);
    const opacity = clamp01(plot.material.opacity);
    const transmission = clamp01(plot.material.transmission);
    const isTransparent = opacity < 0.98 || transmission > 0.05;
    const isImplicitSurface = plot.equation.kind === 'implicit_surface';
    const metallicForOpaque = reflectiveness > 0.65 ? clamp((reflectiveness - 0.55) / 0.45, 0, 1) : reflectiveness * 0.16;
    const reflectionTexture = this.resolvePlotReflectionTexture();
    const hasUsableReflectionTexture = this.isUsableReflectionTexture(reflectionTexture);
    pbr.albedoColor = color3(plot.material.baseColor);
    pbr.metallic = isTransparent ? 0 : clamp01(metallicForOpaque);
    pbr.roughness = roughness;
    pbr.alpha = opacity;
    pbr.transparencyMode = isTransparent ? PBRMaterial.PBRMATERIAL_ALPHABLEND : PBRMaterial.PBRMATERIAL_OPAQUE;
    pbr.indexOfRefraction = FIXED_INTERACTIVE_IOR;
    // Interactive renderer simplification: keep transmission as an alpha/highlight cue,
    // but disable true refraction to avoid unstable transparent stacking behavior.
    pbr.subSurface.isRefractionEnabled = false;
    pbr.subSurface.isTranslucencyEnabled = false;
    pbr.subSurface.refractionIntensity = 0;
    pbr.subSurface.indexOfRefraction = FIXED_INTERACTIVE_IOR;
    pbr.metallicF0Factor = clamp(0.65 + reflectiveness * 1.35 + transmission * 0.4, 0.65, 2);
    pbr.specularIntensity = isTransparent ? 1.15 : 1;
    pbr.directIntensity = 1;
    pbr.environmentIntensity = clamp(0.75 + reflectiveness * 0.9 + (isTransparent ? 0.2 : 0), 0.7, 1.8);
    pbr.useRadianceOverAlpha = isTransparent && !isImplicitSurface;
    pbr.useAlphaFresnel = isTransparent && !isImplicitSurface;
    pbr.useLinearAlphaFresnel = false;
    pbr.reflectionTexture = hasUsableReflectionTexture ? reflectionTexture : null;
    if (!isTransparent && !hasUsableReflectionTexture) {
      // Keep highly reflective materials visible when the interactive reflection source is unavailable.
      pbr.metallic = Math.min(pbr.metallic, 0.08);
      pbr.roughness = Math.max(pbr.roughness, 0.35);
      pbr.environmentIntensity = Math.max(0.45, pbr.environmentIntensity * 0.55);
      pbr.emissiveColor = pbr.albedoColor.scale(0.08);
    } else {
      pbr.emissiveColor = Color3.Black();
    }
    pbr.realTimeFiltering = false;
    // Implicit meshes are generated with winding opposite Babylon's default LH
    // front-face expectation; pin sideOrientation so front/back classification
    // stays stable across transparent and opaque rendering paths.
    pbr.sideOrientation = isImplicitSurface ? Material.ClockWiseSideOrientation : null;
    if (isImplicitSurface && isTransparent) {
      // Transparent implicit surfaces can show dark patches when both front and
      // back shells are blended. Render only the front shell in this case.
      pbr.backFaceCulling = true;
      pbr.cullBackFaces = true;
      pbr.separateCullingPass = false;
      pbr.twoSidedLighting = false;
    } else {
      // For non-implicit and opaque implicit surfaces, keep two-sided behavior
      // to avoid "lit side is dark" artifacts with arbitrary input winding.
      pbr.backFaceCulling = false;
      pbr.cullBackFaces = true;
      pbr.separateCullingPass = isTransparent;
      pbr.twoSidedLighting = true;
    }
    pbr.enableSpecularAntiAliasing = true;
    pbr.forceDepthWrite = !isTransparent;
    pbr.needDepthPrePass = isTransparent;
    mesh.renderingGroupId = isTransparent ? 1 : 0;
    mesh.alphaIndex = isTransparent ? stableAlphaIndex(plot.id) : 0;
  }

  private syncCurveTubePixelWidth(): void {
    if (!this.scene || !this.camera) {
      return;
    }
    const cameraRadius = this.camera.radius;
    if (!Number.isFinite(cameraRadius)) {
      return;
    }
    if (Math.abs(cameraRadius - this.lastCurveTubeCameraRadius) <= 1e-4) {
      return;
    }
    this.lastCurveTubeCameraRadius = cameraRadius;

    const state = useAppStore.getState();
    for (const obj of state.objects) {
      if (obj.type !== 'plot' || obj.equation.kind !== 'parametric_curve' || !obj.equation.renderAsTube) {
        continue;
      }
      const visual = this.plotVisuals.get(obj.id);
      if (!visual?.curveTube) {
        continue;
      }
      const tube = visual.curveTube;
      const referenceRadius = Math.max(0.1, tube.referenceCameraRadius);
      const desiredRadius = Math.max(0.0002, obj.equation.tubeRadius * (cameraRadius / referenceRadius));
      const delta = Math.abs(desiredRadius - tube.currentRadius);
      if (delta <= Math.max(0.00005, tube.currentRadius * 0.03)) {
        continue;
      }

      const updated = MeshBuilder.CreateTube(
        `plot-${obj.id}`,
        {
          path: tube.path,
          radius: desiredRadius,
          tessellation: 12,
          cap: Mesh.CAP_ALL,
          instance: visual.root,
        },
        this.scene,
      );

      if (updated !== visual.root) {
        updated.metadata = visual.root.metadata;
        updated.isPickable = visual.root.isPickable;
        updated.parent = visual.root.parent;
        updated.receiveShadows = visual.root.receiveShadows;
        updated.renderOverlay = visual.root.renderOverlay;
        updated.renderOutline = visual.root.renderOutline;
        updated.outlineColor = visual.root.outlineColor.clone();
        updated.outlineWidth = visual.root.outlineWidth;
        updated.material = visual.root.material;
        if (obj.id === useAppStore.getState().selectedId) {
          this.applyPlotSelectionHalo(updated, obj);
        } else {
          this.clearPlotSelectionHalo(updated);
        }
        visual.root.dispose(false, true);
        visual.root = updated;
      }
      tube.currentRadius = desiredRadius;
    }
  }

  private clearPlotSelectionHalo(mesh: Mesh): void {
    mesh.renderOverlay = false;
    mesh.overlayAlpha = 0;
    mesh.renderOutline = false;
    mesh.outlineWidth = 0;
    mesh.disableEdgesRendering();
  }

  private applyPlotSelectionHalo(mesh: Mesh, plot: PlotObject): void {
    mesh.renderOverlay = false;
    mesh.overlayAlpha = 0;
    mesh.renderOutline = false;
    mesh.outlineWidth = 0;
    mesh.disableEdgesRendering();

    const kind = plot.equation.kind;
    if (kind === 'parametric_curve') {
      mesh.enableEdgesRendering(0.9, false);
      mesh.edgesColor = new Color4(0.8, 0.88, 1, 0.58);
      mesh.edgesWidth = 0.72;
      return;
    }
    if (kind === 'implicit_surface') {
      mesh.renderOutline = true;
      mesh.outlineColor = new Color3(0.88, 0.95, 1);
      mesh.outlineWidth = 0.019;
      return;
    }

    const isTransparent = plot.material.opacity < 0.98 || plot.material.transmission > 0.05;
    if (isTransparent) {
      // Babylon's outline pass can darken transparent/glass surfaces; keep a subtle edge-only fallback there.
      mesh.enableEdgesRendering(0.92, false);
      mesh.edgesColor = new Color4(0.82, 0.9, 1, 0.62);
      mesh.edgesWidth = 0.9;
      return;
    }

    mesh.renderOutline = true;
    mesh.outlineColor = new Color3(0.88, 0.95, 1);
    mesh.outlineWidth = 0.015;
  }

  private syncSelection(selectedId: string | null, objects: ReadonlyArray<SceneObject>): void {
    const plotsById = new Map(
      objects.filter((object): object is PlotObject => object.type === 'plot').map((plot) => [plot.id, plot]),
    );
    for (const [id, visual] of this.plotVisuals.entries()) {
      const selected = id === selectedId;
      const plot = plotsById.get(id);
      if (selected && plot) {
        this.applyPlotSelectionHalo(visual.root, plot);
      } else {
        this.clearPlotSelectionHalo(visual.root);
      }
    }
    for (const [id, visual] of this.pointLightVisuals.entries()) {
      const mat = visual.gizmo.material as StandardMaterial | null;
      const haloMat = visual.halo.material as StandardMaterial | null;
      const selected = id === selectedId;
      const accent = selected ? new Color3(1, 0.95, 0.3) : new Color3(1, 0.75, 0.35);
      if (mat) {
        mat.emissiveColor = accent;
      }
      if (haloMat) {
        haloMat.emissiveColor = accent;
        haloMat.alpha = selected ? 0.45 : 0.28;
      }
      visual.starLines.forEach((line) => {
        line.color = accent;
        line.alpha = selected ? 1 : 0.9;
      });
      const distance = this.camera ? Vector3.Distance(this.camera.position, visual.gizmo.position) : 10;
      const baseScale = clamp(distance * 0.03, 0.75, 3.5);
      const selectedScale = selected ? 1.25 : 1;
      visual.gizmo.scaling.setAll(baseScale * selectedScale);
    }
  }

  private createGroundAndGrid(): void {
    if (!this.scene) return;

    this.groundMesh?.dispose(false, true);
    this.gridMesh?.dispose(false, true);
    this.groundMesh = MeshBuilder.CreateGround('ground', { width: 1, height: 1, subdivisions: 1 }, this.scene);
    this.groundMesh.position.z = 0;
    this.groundMesh.rotationQuaternion = null;
    // Rotate Babylon's default XZ ground into the app's XY ground plane (z-up world).
    this.groundMesh.rotation = new Vector3(Math.PI / 2, 0, 0);
    const groundMaterial = new PBRMaterial('ground-pbr', this.scene);
    groundMaterial.albedoColor = new Color3(0.95, 0.93, 0.9);
    groundMaterial.roughness = 0.35;
    groundMaterial.metallic = 0.02;
    groundMaterial.backFaceCulling = false;
    groundMaterial.alpha = 1;
    this.groundMesh.material = groundMaterial;
    this.groundMesh.receiveShadows = true;

    this.gridMesh = MeshBuilder.CreateGround('grid', { width: 1, height: 1, subdivisions: 1 }, this.scene);
    this.gridMesh.position.z = 0.002;
    this.gridMesh.rotationQuaternion = null;
    this.gridMesh.rotation = new Vector3(Math.PI / 2, 0, 0);
    const gridMaterial = new GridMaterial('grid-mat', this.scene);
    gridMaterial.backFaceCulling = false;
    gridMaterial.majorUnitFrequency = 5;
    gridMaterial.minorUnitVisibility = 0.3;
    gridMaterial.gridRatio = 1;
    gridMaterial.opacity = 0.25;
    this.gridMesh.material = gridMaterial;
    this.gridMesh.isPickable = false;

    // Temporarily disable MirrorTexture creation on startup for WebGPU compatibility.
    this.groundMirror?.dispose();
    this.groundMirror = null;
    groundMaterial.reflectionTexture = null;
  }

  private createAxes(length: number): void {
    if (!this.scene) return;
    this.axesMeshes.forEach((m) => m.dispose(false, true));
    this.axesMeshes = [];

    const x = MeshBuilder.CreateLines('axis-x', { points: [new Vector3(0, 0, 0), new Vector3(length, 0, 0)] }, this.scene);
    x.color = Color3.FromHexString('#ef4444');
    x.isPickable = false;
    const y = MeshBuilder.CreateLines('axis-y', { points: [new Vector3(0, 0, 0), new Vector3(0, length, 0)] }, this.scene);
    y.color = Color3.FromHexString('#22c55e');
    y.isPickable = false;
    const z = MeshBuilder.CreateLines('axis-z', { points: [new Vector3(0, 0, 0), new Vector3(0, 0, length)] }, this.scene);
    z.color = Color3.FromHexString('#3b82f6');
    z.isPickable = false;

    this.axesMeshes = [x, y, z];
  }

  private syncXYGridLines(state: Pick<AppState, 'scene'>): void {
    if (!this.scene) return;

    const extent = Math.max(0.5, state.scene.gridExtent);
    const minSpacing = Math.max(0.05, state.scene.gridSpacing);
    const maxLineCount = 240;
    const lineCountEstimate = Math.ceil((2 * extent) / minSpacing) + 1;
    const spacing = lineCountEstimate > maxLineCount ? (2 * extent) / maxLineCount : minSpacing;
    const key = `${extent.toFixed(4)}|${spacing.toFixed(4)}`;

    if (this.xyGridKey !== key) {
      this.xyGridLines.forEach((line) => line.dispose(false, true));
      this.xyGridLines = [];
      this.xyGridKey = key;

      const z = 0.0025;
      const start = -extent;
      const end = extent;
      const steps = Math.max(1, Math.floor((end - start) / spacing));

      for (let i = 0; i <= steps; i += 1) {
        const v = start + i * spacing;
        const clamped = i === steps ? end : v;

        const vertical = MeshBuilder.CreateLines(
          `xy-grid-x-${i}`,
          { points: [new Vector3(clamped, start, z), new Vector3(clamped, end, z)] },
          this.scene,
        );
        vertical.isPickable = false;
        this.xyGridLines.push(vertical);

        const horizontal = MeshBuilder.CreateLines(
          `xy-grid-y-${i}`,
          { points: [new Vector3(start, clamped, z), new Vector3(end, clamped, z)] },
          this.scene,
        );
        horizontal.isPickable = false;
        this.xyGridLines.push(horizontal);
      }
    }

    const baseColor = state.scene.groundPlaneVisible
      ? new Color3(0.15, 0.2, 0.3)
      : new Color3(0.72, 0.8, 0.95);
    const majorColor = state.scene.groundPlaneVisible
      ? new Color3(0.25, 0.32, 0.46)
      : new Color3(0.88, 0.93, 1.0);
    const opacity = clamp01(state.scene.gridLineOpacity);
    const visible = state.scene.gridVisible;

    const spacingForMajor = Math.max(0.05, spacing);
    for (const line of this.xyGridLines) {
      line.isVisible = visible;
      line.alpha = opacity;
      // Classify major lines from their constant coordinate encoded in the first point.
      const p = line.getVerticesData('position');
      const coord = p ? (Math.abs(p[0] - p[3]) < 1e-6 ? p[0] : p[1]) : 0;
      const majorIndex = Math.round(coord / spacingForMajor);
      const isMajor = Number.isFinite(majorIndex) && majorIndex % 5 === 0;
      line.color = isMajor ? majorColor : baseColor;
    }
  }

  private attachInputHandlers(): void {
    if (!this.scene || !this.camera) return;

    this.pointerObserver = this.scene.onPointerObservable.add((pointerInfo) => {
      const event = pointerInfo.event as PointerEvent;
      switch (pointerInfo.type) {
        case PointerEventTypes.POINTERDOWN:
          this.handlePointerDown(event);
          break;
        case PointerEventTypes.POINTERUP:
          this.handlePointerUp(event);
          break;
        case PointerEventTypes.POINTERMOVE:
          this.handlePointerMove(event);
          break;
        default:
          break;
      }
    });

    this.canvas.addEventListener('wheel', (event) => {
      if (!this.camera) return;
      event.preventDefault();
      this.camera.radius *= Math.exp(event.deltaY * 0.0015);
      this.camera.radius = Math.max(this.camera.lowerRadiusLimit ?? 1, Math.min(this.camera.upperRadiusLimit ?? 200, this.camera.radius));
    }, { passive: false });
  }

  private handlePointerDown(event: PointerEvent): void {
    if (!this.scene || !this.camera) return;
    if (event.button === 2) {
      this.cameraDrag = {
        mode: event.shiftKey ? 'pan' : 'orbit',
        pointerId: event.pointerId,
        lastX: event.clientX,
        lastY: event.clientY,
      };
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }

    if (event.button !== 0) {
      return;
    }

    const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (mesh) => !!mesh.metadata?.selectableId);
    const selectableId = pick?.pickedMesh?.metadata?.selectableId as string | undefined;
    if (!selectableId) {
      useAppStore.getState().selectObject(null);
      return;
    }

    useAppStore.getState().selectObject(selectableId);

    if (!pick.pickedPoint) {
      return;
    }

    const selected = useAppStore.getState().objects.find((obj) => obj.id === selectableId);
    if (!selected) return;

    const startPosition = selected.type === 'plot' ? vec3(selected.transform.position) : vec3(selected.position);
    if (event.shiftKey) {
      const ray = this.scene.createPickingRay(this.scene.pointerX, this.scene.pointerY, Matrix.Identity(), this.camera);
      const axisZ = closestZOnVerticalAxisToRay(ray, startPosition.x, startPosition.y);
      this.dragState = {
        objectId: selectableId,
        mode: 'z',
        startPosition,
        fixedX: startPosition.x,
        fixedY: startPosition.y,
        zOffset: axisZ === null ? 0 : startPosition.z - axisZ,
        fallbackScale: this.camera.radius * 0.005,
        startClientY: event.clientY,
      };
      useAppStore.getState().beginObjectDragHistory(selectableId);
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }

    const hit = rayPlaneIntersectZ(this.scene.createPickingRay(this.scene.pointerX, this.scene.pointerY, Matrix.Identity(), this.camera), startPosition.z);
    if (!hit) {
      return;
    }

    this.dragState = {
      objectId: selectableId,
      mode: 'xy',
      startPosition,
      planeZ: startPosition.z,
      startPoint: hit,
    };
    useAppStore.getState().beginObjectDragHistory(selectableId);
    this.canvas.setPointerCapture(event.pointerId);
  }

  private handlePointerUp(event: PointerEvent): void {
    if (this.cameraDrag && this.cameraDrag.pointerId === event.pointerId) {
      this.cameraDrag = null;
      this.canvas.releasePointerCapture(event.pointerId);
    }
    if (this.dragState) {
      const dragObjectId = this.dragState.objectId;
      this.dragState = null;
      useAppStore.getState().commitObjectDragHistory(dragObjectId);
      this.canvas.releasePointerCapture(event.pointerId);
    }
  }

  private handlePointerMove(event: PointerEvent): void {
    if (!this.scene || !this.camera) return;

    if (this.cameraDrag && this.cameraDrag.pointerId === event.pointerId) {
      const dx = event.clientX - this.cameraDrag.lastX;
      const dy = event.clientY - this.cameraDrag.lastY;
      this.cameraDrag.lastX = event.clientX;
      this.cameraDrag.lastY = event.clientY;

      if (this.cameraDrag.mode === 'orbit') {
        this.camera.alpha -= dx * 0.01;
        this.camera.beta = clamp(this.camera.beta - dy * 0.01, 0.1, Math.PI - 0.1);
      } else {
        const panScale = this.camera.radius * 0.002;
        const right = this.camera.getDirection(new Vector3(1, 0, 0));
        const up = this.camera.getDirection(new Vector3(0, 1, 0));
        this.camera.target.addInPlace(right.scale(-dx * panScale));
        this.camera.target.addInPlace(up.scale(dy * panScale));
      }
      return;
    }

    if (!this.dragState) return;

    const current = useAppStore.getState().objects.find((obj) => obj.id === this.dragState?.objectId);
    if (!current) return;

    if (this.dragState.mode === 'xy') {
      const ray = this.scene.createPickingRay(this.scene.pointerX, this.scene.pointerY, Matrix.Identity(), this.camera);
      const hit = rayPlaneIntersectZ(ray, this.dragState.planeZ);
      if (!hit) return;
      const delta = hit.subtract(this.dragState.startPoint);
      const pos = this.dragState.startPosition.add(delta);
      useAppStore.getState().setObjectPosition(current.id, { x: pos.x, y: pos.y, z: pos.z });
    } else {
      const pos = this.dragState.startPosition.clone();
      const ray = this.scene.createPickingRay(this.scene.pointerX, this.scene.pointerY, Matrix.Identity(), this.camera);
      const axisZ = closestZOnVerticalAxisToRay(ray, this.dragState.fixedX, this.dragState.fixedY);
      if (axisZ === null) {
        const dy = event.clientY - this.dragState.startClientY;
        const dz = -dy * this.dragState.fallbackScale;
        pos.z += dz;
      } else {
        pos.z = axisZ + this.dragState.zOffset;
      }
      useAppStore.getState().setObjectPosition(current.id, { x: pos.x, y: pos.y, z: pos.z });
    }
  }

  private ensureDirectionalShadowGenerator(resolution: number, softness: number): void {
    if (!this.directionalLight) return;
    const targetSize = clamp(Math.round(resolution), 256, 4096);
    const currentSize = this.directionalShadow?.getShadowMap()?.getSize()?.width;
    if (!this.directionalShadow || currentSize !== targetSize) {
      this.directionalShadow?.dispose();
      this.directionalShadow = new ShadowGenerator(targetSize, this.directionalLight);
    }
    this.configureShadowGenerator(this.directionalShadow, softness);
  }

  private configureShadowGenerator(shadow: ShadowGenerator, softness: number): void {
    const s = clamp01(softness);
    const isCubeShadow = shadow.getLight().needCube();
    // Directional shadows need more bias to avoid acne/striping on smooth surfaces.
    // Point (cube) shadows are more sensitive; keep bias lower and prefer compatibility over filtering.
    if (isCubeShadow) {
      shadow.bias = 0.00005 + s * 0.0002;
      shadow.normalBias = 0.0006 + s * 0.0024;
      shadow.setDarkness(0.28);
      shadow.frustumEdgeFalloff = 0.05;
      shadow.forceBackFacesOnly = false;
      // Filtering modes on cube shadows can be inconsistent across WebGPU drivers.
      // Use unfiltered shadows first for correctness/visibility.
      shadow.usePercentageCloserFiltering = false;
      shadow.usePoissonSampling = false;
    } else {
      shadow.bias = 0.00008 + s * 0.00035;
      shadow.normalBias = 0.0012 + s * 0.0065;
      shadow.setDarkness(0.22);
      shadow.frustumEdgeFalloff = 0.1;
      // Back-face shadow casting reduces surface acne on thin parametric meshes.
      shadow.forceBackFacesOnly = true;
      shadow.usePercentageCloserFiltering = true;
      shadow.usePoissonSampling = false;
    }
    shadow.filteringQuality = s > 0.66 ? ShadowGenerator.QUALITY_HIGH : ShadowGenerator.QUALITY_MEDIUM;
    if (shadow.getShadowMap()) {
      shadow.getShadowMap()!.refreshRate = 1;
    }
  }

  private hasAnyPointLightShadowsEnabled(): boolean {
    for (const visual of this.pointLightVisuals.values()) {
      if (visual.shadowEnabled) {
        return true;
      }
    }
    return false;
  }

  private setQualityRendererStatus(active: RenderDiagnostics['qualityActiveRenderer'], fallbackReason: string | null): void {
    const activeChanged = this.qualityActiveRenderer !== active;
    const fallbackChanged = this.qualityFallbackReason !== fallbackReason;
    if (!activeChanged && !fallbackChanged) {
      return;
    }
    this.qualityActiveRenderer = active;
    this.qualityFallbackReason = fallbackReason;
    if (active === 'none') {
      this.resetQualityPerfTracking();
    }
    useAppStore.getState().setRenderDiagnostics({
      qualityActiveRenderer: this.qualityActiveRenderer,
      qualityRendererFallbackReason: this.qualityFallbackReason,
      qualitySamplesPerSecond: this.qualitySamplesPerSecond,
    });
  }

  private resetQualityPerfTracking(): void {
    this.qualityPerfWindowStartMs = 0;
    this.qualityPerfWindowStartSamples = 0;
    if (this.qualitySamplesPerSecond !== 0) {
      this.qualitySamplesPerSecond = 0;
      useAppStore.getState().setRenderDiagnostics({ qualitySamplesPerSecond: 0 });
    }
  }

  private ensureQualityPreviewOverlayCanvas(): void {
    if (this.qualityPreviewOverlayCanvas || typeof document === 'undefined') {
      return;
    }
    const parent = this.canvas.parentElement;
    if (!parent) {
      return;
    }
    const overlay = document.createElement('canvas');
    const ctx = overlay.getContext('2d', { alpha: true });
    if (!ctx) {
      return;
    }
    overlay.className = 'viewport-canvas';
    overlay.style.position = 'absolute';
    overlay.style.inset = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '2';
    overlay.style.display = 'none';
    overlay.style.background = 'transparent';
    parent.insertBefore(overlay, this.canvas.nextSibling);
    this.qualityPreviewOverlayCanvas = overlay;
    this.qualityPreviewOverlayCtx = ctx;
  }

  private hideQualityPreviewOverlay(): void {
    if (this.qualityPreviewOverlayCanvas) {
      this.qualityPreviewOverlayCanvas.style.display = 'none';
    }
  }

  private syncQualityPreviewOverlay(render: RenderSettings): void {
    const overlayEligible =
      this.qualityActiveRenderer === 'path'
      || this.qualityActiveRenderer === 'hybrid_gpu_preview';
    if (render.mode !== 'quality' || !overlayEligible || !this.qualityBackends) {
      this.hideQualityPreviewOverlay();
      return;
    }
    // Partial sub-pass previews (before the first full sample) are visually misleading:
    // sparse interleaved pixels + browser canvas scaling can look like ghost geometry.
    if (render.qualityCurrentSamples < 1) {
      this.hideQualityPreviewOverlay();
      return;
    }
    const exportCanvas = this.qualityBackends.getActiveBackendExportCanvas();
    if (!exportCanvas) {
      this.hideQualityPreviewOverlay();
      return;
    }
    this.ensureQualityPreviewOverlayCanvas();
    if (!this.qualityPreviewOverlayCanvas || !this.qualityPreviewOverlayCtx) {
      return;
    }
    const overlay = this.qualityPreviewOverlayCanvas;
    const ctx = this.qualityPreviewOverlayCtx;
    const w = Math.max(1, exportCanvas.width);
    const h = Math.max(1, exportCanvas.height);
    if (overlay.width !== w || overlay.height !== h) {
      overlay.width = w;
      overlay.height = h;
    }
    ctx.save();
    try {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(exportCanvas, 0, 0, w, h);
    } finally {
      ctx.restore();
    }
    overlay.style.display = 'block';
  }

  private updateQualitySamplesPerSecond(currentSamples: number, active: boolean): void {
    if (!active) {
      this.resetQualityPerfTracking();
      return;
    }
    const now = performance.now();
    if (this.qualityPerfWindowStartMs <= 0) {
      this.qualityPerfWindowStartMs = now;
      this.qualityPerfWindowStartSamples = currentSamples;
      return;
    }
    const elapsedMs = now - this.qualityPerfWindowStartMs;
    if (elapsedMs < 250) {
      return;
    }
    const deltaSamples = Math.max(0, currentSamples - this.qualityPerfWindowStartSamples);
    const rawSps = elapsedMs > 0 ? (deltaSamples * 1000) / elapsedMs : 0;
    const nextSps =
      rawSps >= 10
        ? Math.round(rawSps)
        : rawSps >= 1
          ? Math.round(rawSps * 10) / 10
          : rawSps >= 0.1
            ? Math.round(rawSps * 100) / 100
            : Math.round(rawSps * 1000) / 1000;
    if (nextSps !== this.qualitySamplesPerSecond) {
      this.qualitySamplesPerSecond = nextSps;
      useAppStore.getState().setRenderDiagnostics({ qualitySamplesPerSecond: nextSps });
    }
    if (elapsedMs >= 1000 || deltaSamples >= 32) {
      this.qualityPerfWindowStartMs = now;
      this.qualityPerfWindowStartSamples = currentSamples;
    }
  }

  private announceQualityStatusOnce(key: string, message: string): void {
    if (this.lastQualityStatusMessageKey === key) {
      return;
    }
    this.lastQualityStatusMessageKey = key;
    useAppStore.getState().setStatusMessage(message);
  }

  private syncRenderDiagnostics(state: Pick<AppState, 'scene' | 'objects' | 'render'>): void {
    const plots = state.objects.filter((o): o is PlotObject => o.type === 'plot');
    const pointLights = state.objects.filter((o): o is PointLightObject => o.type === 'point_light');
    const pointShadowsEnabled = Array.from(this.pointLightVisuals.values()).filter((v) => v.shadowEnabled).length;
    const directionalShadowCasterCount = this.directionalShadow?.getShadowMap()?.renderList?.length ?? 0;
    const pointShadowCasterCounts: Record<string, number> = {};
    for (const [id, visual] of this.pointLightVisuals.entries()) {
      pointShadowCasterCounts[id] = visual.shadowEnabled ? (visual.shadow?.getShadowMap()?.renderList?.length ?? 0) : 0;
    }
    const directionalShadowEnabled = Boolean(
      state.scene.directional.castShadows && state.scene.shadow.directionalShadowEnabled && this.directionalShadow,
    );
    const transparentPlotCount = plots.filter((plot) => plot.material.opacity < 0.98 || plot.material.transmission > 0.05).length;
    const shadowReceiver: RenderDiagnostics['shadowReceiver'] = state.scene.groundPlaneVisible
      ? 'ground'
      : 'none';
    const currentDiagnostics = useAppStore.getState().renderDiagnostics;
    const pathDiagnosticsActive = state.render.mode === 'quality' && this.qualityActiveRenderer === 'path';
    const probeTexture = this.sceneReflectionProbe?.cubeTexture as BaseTexture | null;
    const probeInternal = probeTexture?.getInternalTexture() ?? null;
    const fallbackTexture = this.environmentFallbackTexture;
    const fallbackReady = fallbackTexture?.isReady() ?? false;
    const fallbackUsable = this.isUsableReflectionTexture(fallbackTexture);

    useAppStore.getState().setRenderDiagnostics({
      webgpuReady: Boolean(this.engine && this.scene),
      plotCount: plots.length,
      pointLightCount: pointLights.length,
      directionalShadowEnabled,
      directionalShadowCasterCount,
      pointShadowsEnabled,
      pointShadowLimit: state.scene.shadow.pointShadowMaxLights,
      pointShadowCasterCounts,
      shadowReceiver,
      transparentPlotCount,
      shadowMapResolution: state.scene.shadow.shadowMapResolution,
      pointShadowMode: state.scene.shadow.pointShadowMode,
      pointShadowCapability: this.pointShadowCapability,
      interactiveReflectionPath: this.interactiveReflectionPath,
      interactiveReflectionSource: this.interactiveReflectionSource,
      interactiveReflectionFallbackReason: this.interactiveReflectionFallbackReason,
      interactiveReflectionProbeSize: this.sceneReflectionProbeSize,
      interactiveReflectionProbeRefreshCount: this.interactiveReflectionProbeRefreshCount,
      interactiveReflectionLastRefreshReason: this.interactiveReflectionLastRefreshReason,
      interactiveReflectionProbeHasCapture: this.interactiveReflectionProbeHasCapture,
      interactiveReflectionProbeUsable: this.interactiveReflectionProbeUsable,
      interactiveReflectionProbeTextureReady: probeTexture?.isReady() ?? false,
      interactiveReflectionProbeTextureAllocated: Boolean(
        probeInternal && !((probeInternal as { isDisposed?: boolean }).isDisposed ?? false),
      ),
      interactiveReflectionFallbackKind: this.interactiveReflectionFallbackKind,
      interactiveReflectionFallbackEverUsable: this.interactiveReflectionFallbackEverUsable,
      interactiveReflectionFallbackTexturePresent: Boolean(fallbackTexture),
      interactiveReflectionFallbackTextureReady: fallbackReady,
      interactiveReflectionFallbackTextureUsable: fallbackUsable,
      qualityActiveRenderer: state.render.mode === 'quality' ? this.qualityActiveRenderer : 'none',
      qualityRendererFallbackReason: state.render.mode === 'quality' ? this.qualityFallbackReason : null,
      qualityResolutionScale: state.render.mode === 'quality' ? clamp(state.render.qualityResolutionScale, 0.25, 4) : 1,
      qualitySamplesPerSecond: state.render.mode === 'quality' ? this.qualitySamplesPerSecond : 0,
      qualityLastResetReason: state.render.mode === 'quality' ? this.qualityLastResetReason : null,
      qualityPathExecutionMode: pathDiagnosticsActive ? currentDiagnostics.qualityPathExecutionMode : null,
      qualityPathAlignmentStatus: pathDiagnosticsActive ? currentDiagnostics.qualityPathAlignmentStatus : null,
      qualityPathAlignmentProbeCount: pathDiagnosticsActive ? currentDiagnostics.qualityPathAlignmentProbeCount : 0,
      qualityPathAlignmentHitMismatches: pathDiagnosticsActive ? currentDiagnostics.qualityPathAlignmentHitMismatches : 0,
      qualityPathAlignmentMaxPointError: pathDiagnosticsActive ? currentDiagnostics.qualityPathAlignmentMaxPointError : 0,
      qualityPathAlignmentMaxDistanceError: pathDiagnosticsActive ? currentDiagnostics.qualityPathAlignmentMaxDistanceError : 0,
      qualityPathWorkerBatchCount: pathDiagnosticsActive ? currentDiagnostics.qualityPathWorkerBatchCount : 0,
      qualityPathWorkerPixelCount: pathDiagnosticsActive ? currentDiagnostics.qualityPathWorkerPixelCount : 0,
      qualityPathWorkerBatchLatencyMs: pathDiagnosticsActive ? currentDiagnostics.qualityPathWorkerBatchLatencyMs : 0,
      qualityPathWorkerBatchPixelsPerBatch: pathDiagnosticsActive ? currentDiagnostics.qualityPathWorkerBatchPixelsPerBatch : 0,
      qualityPathWorkerPixelsPerSecond: pathDiagnosticsActive ? currentDiagnostics.qualityPathWorkerPixelsPerSecond : 0,
      qualityPathMainThreadBatchCount: pathDiagnosticsActive ? currentDiagnostics.qualityPathMainThreadBatchCount : 0,
      qualityPathMainThreadPixelCount: pathDiagnosticsActive ? currentDiagnostics.qualityPathMainThreadPixelCount : 0,
      qualityPathMainThreadPixelsPerSecond: pathDiagnosticsActive ? currentDiagnostics.qualityPathMainThreadPixelsPerSecond : 0,
    });
  }

  private syncQualityRenderer(state: Pick<AppState, 'render'>): void {
    this.syncQualityResolutionScale(state.render);
    this.syncQualityPipeline(state.render);
  }

  private syncQualityResolutionScale(render: AppState['render']): void {
    if (!this.engine) return;
    const scale = render.mode === 'quality' ? clamp(render.qualityResolutionScale, 0.25, 4) : 1;
    const targetLevel = this.baseHardwareScalingLevel / scale;
    if (Number.isFinite(this.lastAppliedHardwareScalingLevel) && Math.abs(this.lastAppliedHardwareScalingLevel - targetLevel) < 1e-6) {
      return;
    }
    this.engine.setHardwareScalingLevel(targetLevel);
    this.engine.resize();
    this.lastAppliedHardwareScalingLevel = targetLevel;
    this.resetQualityAccumulation({
      resetHistory: render.mode === 'quality',
      reason: render.mode === 'quality' ? 'resolution_scale_change' : null,
    });
  }

  private syncQualityPipeline(render: RenderSettings): void {
    if (!this.engine || !this.scene || !this.camera) return;
    this.qualityBackends ??= new QualityBackendRouter(this.engine, this.scene, this.camera);

    const result = this.qualityBackends.sync(render);
    const effectiveFallbackReason =
      result.activeRenderer !== 'none' && result.activeRenderer === render.qualityRenderer
        ? null
        : result.fallbackReason;
    this.setQualityRendererStatus(result.activeRenderer, effectiveFallbackReason);

    if (render.mode !== 'quality') {
      this.hideQualityPreviewOverlay();
      return;
    }

    if (render.qualityRenderer === 'path' && result.activeRenderer === 'hybrid_gpu_preview') {
      this.announceQualityStatusOnce(
        'quality-path-fallback-hybrid-gpu-preview',
        effectiveFallbackReason ?? 'Quality path renderer unavailable; using Hybrid GPU Preview fallback',
      );
    } else if (render.qualityRenderer === 'path' && result.activeRenderer === 'taa_preview') {
      this.announceQualityStatusOnce(
        'quality-path-fallback-taa',
        effectiveFallbackReason ?? 'Quality path renderer unavailable; using TAA preview fallback',
      );
    } else if (render.qualityRenderer === 'hybrid_gpu_preview' && result.activeRenderer === 'hybrid_gpu_preview') {
      this.announceQualityStatusOnce(
        'quality-hybrid-gpu-preview-phase5a',
        'Quality Hybrid GPU Preview is the Phase 5A fast GPU-backed accumulation path (advanced true path tracing remains in progress)',
      );
    } else if (render.qualityRenderer === 'hybrid_gpu_preview' && result.activeRenderer === 'taa_preview') {
      this.announceQualityStatusOnce(
        'quality-hybrid-gpu-preview-fallback-taa',
        effectiveFallbackReason ?? 'Hybrid GPU Preview unavailable; using TAA preview fallback',
      );
    } else if (render.qualityRenderer === 'path' && result.activeRenderer === 'path') {
      this.announceQualityStatusOnce(
        'quality-path-v1-experimental',
        'Quality path renderer is an experimental Phase 5B CPU path tracer prototype (true GPU path tracing is still in progress)',
      );
    } else if (result.activeRenderer === 'none' && effectiveFallbackReason) {
      this.announceQualityStatusOnce(`quality-unsupported-${render.qualityRenderer}`, effectiveFallbackReason);
    }

    if (result.enabledJustNow) {
      this.resetQualityAccumulation({ resetHistory: true, reason: 'quality_pipeline_enabled' });
    }
  }

  private tickQualityMode(): boolean {
    const { render, markQualityProgress } = useAppStore.getState();
    if (render.mode !== 'quality') {
      this.qualityBackends?.disableAll();
      this.setQualityRendererStatus('none', null);
      this.hideQualityPreviewOverlay();
      this.lastQualityCameraSignature = '';
      this.updateQualitySamplesPerSecond(0, false);
      if (render.qualityCurrentSamples !== 0 || render.qualityRunning) {
        markQualityProgress(0, false);
      }
      return true;
    }

    if (!this.qualityBackends || !this.qualityBackends.isActiveBackendEnabled()) {
      this.syncQualityPipeline(render);
      if (!this.qualityBackends || !this.qualityBackends.isActiveBackendEnabled()) {
        this.setQualityRendererStatus('none', this.qualityFallbackReason);
        this.hideQualityPreviewOverlay();
        this.updateQualitySamplesPerSecond(0, false);
        if (render.qualityCurrentSamples !== 0 || render.qualityRunning) {
          markQualityProgress(0, false);
        }
        return true;
      }
    }

    const cameraSig = this.computeQualityCameraSignature();
    if (cameraSig) {
      if (this.lastQualityCameraSignature && cameraSig !== this.lastQualityCameraSignature) {
        // Let the active quality backend handle history reset while we track a shared reset reason.
        this.resetQualityAccumulation({ resetHistory: false, reason: 'camera_change' });
      }
      this.lastQualityCameraSignature = cameraSig;
    }

    const tick = this.qualityBackends.tick(render);
    if (!tick.shouldRender) {
      markQualityProgress(Math.max(0, Math.floor(tick.progress.currentSamples)), tick.progress.running);
      this.updateQualitySamplesPerSecond(tick.progress.currentSamples, tick.progress.running);
    }
    return tick.shouldRender;
  }

  private handleQualityFrameRendered(): void {
    if (!this.qualityBackends) {
      return;
    }
    const { render, markQualityProgress } = useAppStore.getState();
    if (render.mode !== 'quality' || !this.qualityBackends.isActiveBackendEnabled()) {
      return;
    }
    this.qualityBackends.onFrameRendered(render, this.canvas);
    const progress = this.qualityBackends.getActiveBackendProgress(render);
    markQualityProgress(Math.max(0, Math.floor(progress.currentSamples)), progress.running);
    this.updateQualitySamplesPerSecond(progress.currentSamples, progress.running);
    this.syncQualityPreviewOverlay(render);
  }

  private computeQualityCameraSignature(): string {
    if (!this.camera) return '';
    const t = this.camera.target;
    const r = (n: number) => (Number.isFinite(n) ? n.toFixed(4) : 'nan');
    return [
      r(this.camera.alpha),
      r(this.camera.beta),
      r(this.camera.radius),
      r(t.x),
      r(t.y),
      r(t.z),
    ].join('|');
  }

  private resetQualityAccumulation(options: { resetHistory: boolean; reason?: string | null }): void {
    this.lastQualityCameraSignature = this.computeQualityCameraSignature();
    if (options.reason !== undefined) {
      this.qualityLastResetReason = options.reason;
      useAppStore.getState().setRenderDiagnostics({ qualityLastResetReason: this.qualityLastResetReason });
    }
    this.resetQualityPerfTracking();
    this.qualityBackends?.resetActiveBackendAccumulation();
    this.hideQualityPreviewOverlay();
    if (!options.resetHistory) {
      return;
    }
    this.qualityBackends?.resetActiveBackendHistory(options.reason ?? null);
  }

  private disposeQualityPipeline(): void {
    if (!this.qualityBackends) return;
    this.qualityBackends.dispose();
    this.qualityBackends = null;
    this.hideQualityPreviewOverlay();
    this.setQualityRendererStatus('none', null);
  }

  private async waitForQualityReadyForExport(timeoutMs: number): Promise<'skipped' | 'ready' | 'timeout'> {
    const started = performance.now();
    let announced = false;
    while (true) {
      if (this.disposed) {
        return 'skipped';
      }
      const { render } = useAppStore.getState();
      if (render.mode !== 'quality') {
        return 'skipped';
      }
      if (render.qualityEarlyExportBehavior === 'immediate') {
        return 'skipped';
      }
      if (!this.qualityBackends || !this.qualityBackends.isActiveBackendEnabled()) {
        this.syncQualityPipeline(render);
      }
      if (this.qualityBackends?.isActiveBackendReadyForExport(render)) {
        return 'ready';
      }
      if (this.qualityBackends && !this.qualityBackends.isActiveBackendEnabled() && this.qualityFallbackReason) {
        return 'skipped';
      }
      if (!announced) {
        useAppStore.getState().setStatusMessage('Waiting for quality accumulation before PNG export...');
        announced = true;
      }
      if (performance.now() - started >= timeoutMs) {
        return 'timeout';
      }
      await delay(50);
    }
  }

  private readonly handleResize = () => {
    this.engine?.resize();
    if (useAppStore.getState().render.mode === 'quality') {
      this.resetQualityAccumulation({ resetHistory: true, reason: 'resize' });
    }
  };

  private safeDisposeEngine(): void {
    if (!this.engine) return;
    try {
      // Babylon WebGPU dispose can throw if initialization was interrupted mid-flight.
      this.engine.dispose();
    } catch (error) {
      console.warn('Engine dispose failed (ignored)', error, { engineInitialized: this.engineInitialized });
    }
  }
}

function buildGeometryKey(plot: PlotObject, meshVersion = 0): string {
  const curveStyle =
    plot.equation.kind === 'parametric_curve'
      ? {
          renderAsTube: plot.equation.renderAsTube,
          tubeRadius: plot.equation.tubeRadius,
        }
      : undefined;
  return JSON.stringify({
    meshVersion,
    curveStyle,
    wireframeCellSize: plot.material.wireframeCellSize ?? 4,
  });
}

function color3(hex: string): Color3 {
  try {
    return Color3.FromHexString(hex);
  } catch {
    return Color3.White();
  }
}

function vec3(v: { x: number; y: number; z: number }): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isHeadlessOrAutomatedBrowser(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const ua = navigator.userAgent ?? '';
  return Boolean((navigator as Navigator & { webdriver?: boolean }).webdriver) || /HeadlessChrome/i.test(ua);
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function mixColor(a: Color3, b: Color3, t: number): Color3 {
  const tt = clamp01(t);
  return new Color3(
    a.r + (b.r - a.r) * tt,
    a.g + (b.g - a.g) * tt,
    a.b + (b.b - a.b) * tt,
  );
}

function makeEnvironmentEquirectBytes(top: Color3, bottom: Color3, width: number, height: number): Uint8Array {
  const w = Math.max(8, Math.floor(width));
  const h = Math.max(4, Math.floor(height));
  const data = new Uint8Array(w * h * 4);
  const glowX = w * 0.68;
  const glowY = h * 0.28;
  const glowRadius = Math.max(4, Math.min(w, h) * 0.42);
  for (let y = 0; y < h; y += 1) {
    const v = h <= 1 ? 0 : y / (h - 1);
    const baseR = top.r + (bottom.r - top.r) * v;
    const baseG = top.g + (bottom.g - top.g) * v;
    const baseB = top.b + (bottom.b - top.b) * v;
    for (let x = 0; x < w; x += 1) {
      const dx = x - glowX;
      const dy = y - glowY;
      const glowDist = Math.sqrt(dx * dx + dy * dy) / glowRadius;
      const glow = glowDist >= 1 ? 0 : (1 - glowDist) ** 2 * 0.2;
      const i = (y * w + x) * 4;
      data[i] = Math.round(clamp01(baseR + glow) * 255);
      data[i + 1] = Math.round(clamp01(baseG + glow) * 255);
      data[i + 2] = Math.round(clamp01(baseB + glow) * 255);
      data[i + 3] = 255;
    }
  }
  return data;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function stableAlphaIndex(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h % 1000);
}

function applySerializedMeshToBabylonMesh(mesh: Mesh, meshData: SerializedMesh): void {
  const vd = new VertexData();
  vd.positions = Array.from(meshData.positions);
  vd.indices = Array.from(meshData.indices);
  if (meshData.normals) {
    vd.normals = Array.from(meshData.normals);
  }
  if (meshData.uvs) {
    vd.uvs = Array.from(meshData.uvs);
  }
  vd.applyToMesh(mesh);
}

function floatArrayToVector3Path(coords: Float32Array): Vector3[] {
  const points: Vector3[] = [];
  for (let i = 0; i < coords.length; i += 3) {
    const x = coords[i];
    const y = coords[i + 1];
    const z = coords[i + 2];
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      points.push(new Vector3(x, y, z));
    }
  }
  return points;
}

function isWorkerMeshPending(status?: PlotJobStatus): boolean {
  if (!status) return false;
  return status.meshPhase === 'queued' || status.meshPhase === 'mesh_preview' || status.meshPhase === 'mesh_final';
}

function rayPlaneIntersectZ(ray: { origin: Vector3; direction: Vector3 }, z: number): Vector3 | null {
  const dz = ray.direction.z;
  if (Math.abs(dz) < 1e-6) return null;
  const t = (z - ray.origin.z) / dz;
  if (t < 0) return null;
  return ray.origin.add(ray.direction.scale(t));
}

function closestZOnVerticalAxisToRay(
  ray: { origin: Vector3; direction: Vector3 },
  x: number,
  y: number,
): number | null {
  const d = ray.direction;
  const o = ray.origin;
  const a = new Vector3(x, y, 0);

  // Axis line is A(t) = (x, y, 0) + t * (0,0,1)
  const dd = Vector3.Dot(d, d);
  const dk = d.z;
  const rhs1 = d.x * (a.x - o.x) + d.y * (a.y - o.y) + d.z * (a.z - o.z);
  const rhs2 = a.z - o.z;
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

async function exportCanvasPng(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
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

async function exportScenePngViaRenderTarget(
  engine: WebGPUEngine,
  camera: ArcRotateCamera,
  sourceCanvas: HTMLCanvasElement,
  filename: string,
): Promise<void> {
  const width = Math.max(1, sourceCanvas.width);
  const height = Math.max(1, sourceCanvas.height);
  try {
    const dataUrl = await CreateScreenshotUsingRenderTargetAsync(engine, camera, { width, height }, 'image/png');
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png')) {
      downloadDataUrl(dataUrl, filename);
      return;
    }
    throw new Error('Babylon screenshot returned unexpected data');
  } catch (error) {
    console.warn('Render-target PNG export failed; falling back to canvas.toBlob()', error);
    await exportCanvasPng(sourceCanvas, filename);
  }
}

function downloadDataUrl(dataUrl: string, filename: string): void {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

function canvasLooksBlank(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return false;
  }
  const w = canvas.width;
  const h = canvas.height;
  if (w <= 0 || h <= 0) {
    return true;
  }
  const probeCols = 5;
  const probeRows = 5;
  try {
    for (let ry = 0; ry < probeRows; ry += 1) {
      const y = Math.min(h - 1, Math.floor((ry + 0.5) * (h / probeRows)));
      for (let rx = 0; rx < probeCols; rx += 1) {
        const x = Math.min(w - 1, Math.floor((rx + 0.5) * (w / probeCols)));
        const p = ctx.getImageData(x, y, 1, 1).data;
        if (p[0] !== 0 || p[1] !== 0 || p[2] !== 0 || p[3] !== 0) {
          return false;
        }
      }
    }
  } catch {
    return false;
  }
  return true;
}
