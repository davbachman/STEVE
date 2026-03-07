import {
  ArcRotateCamera,
  BaseTexture,
  Color3,
  Color4,
  Constants,
  DirectionalLight,
  HemisphericLight,
  ImageProcessingConfiguration,
  LinesMesh,
  Matrix,
  Material,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  PointLight,
  PointerEventTypes,
  RawCubeTexture,
  Scene,
  ShadowGenerator,
  SphericalPolynomial,
  StandardMaterial,
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
import {
  createRendererSceneSnapshot,
  INTERACTIVE_SHELL_RENDER_OPACITY_EPSILON,
  plotUsesTransparentShells,
  resolveDirectionalShadowFrustumSize,
  selectInteractiveReflectionSource,
  shouldUseTransparentBackShell,
  shouldUseShellSelectionHalo,
  type RendererPlotSnapshot,
  type RendererSceneSnapshot,
} from './renderSnapshot';

export interface ViewportApi {
  exportPng: (filename?: string) => Promise<void>;
}

interface PlotVisual {
  root: Mesh;
  wireframeLines: LinesMesh[];
  transparentBackShell: Mesh | null;
  geometryKey: string;
  topology?: SerializedMesh['topology'];
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
  private environmentFallbackTexture: BaseTexture | null = null;
  private environmentFallbackKey = '';
  private interactiveReflectionFallbackKind: RenderDiagnostics['interactiveReflectionFallbackKind'] = 'none';
  private interactiveReflectionFallbackEverUsable = false;
  private interactiveReflectionPath: RenderDiagnostics['interactiveReflectionPath'] = 'none';
  private interactiveReflectionFallbackReason: string | null = null;
  private interactiveReflectionLastRefreshReason: string | null = null;
  private interactiveReflectionProbeRefreshCount = 0;
  private interactiveReflectionSource: InteractiveReflectionSource = 'none';
  private interactiveReflectionTexture: Nullable<BaseTexture> = null;
  private shadowAlphaRestore = new WeakMap<Mesh, number>();
  private shadowAlphaHookedGenerators = new WeakSet<ShadowGenerator>();
  private latestSnapshot: RendererSceneSnapshot | null = null;
  private plotVisuals = new Map<string, PlotVisual>();
  private pointLightVisuals = new Map<string, PointLightVisual>();
  private pointerObserver: Nullable<Observer<PointerInfo>> = null;
  private dragState: DragState | null = null;
  private cameraDrag: { mode: 'orbit' | 'pan'; pointerId: number; lastX: number; lastY: number } | null = null;
  private lastQualitySignature = '';
  private lastQualityCameraSignature = '';
  private qualityBackends: QualityBackendRouter | null = null;
  private implicitSelectionHalos = new Map<string, Mesh>();
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
    // Preserve depth across later rendering groups so overlays (wireframe/selection halos)
    // can respect occlusion from already rendered geometry.
    this.scene.setRenderingAutoClearDepthStencil(1, false);
    this.scene.setRenderingAutoClearDepthStencil(2, false);
    this.scene.setRenderingAutoClearDepthStencil(3, false);
    this.scene.setRenderingAutoClearDepthStencil(4, false);

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
    this.canvas.style.outline = 'none';

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
        this.handleQualityFrameRendered();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown Babylon render error';
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
    for (const halo of this.implicitSelectionHalos.values()) {
      halo.material?.dispose(false, true);
      halo.dispose(false, true);
    }
    this.implicitSelectionHalos.clear();
    if (this.scene?.environmentTexture && this.scene.environmentTexture === this.environmentFallbackTexture) {
      this.scene.environmentTexture = null;
    }
    this.environmentFallbackTexture?.dispose();
    this.environmentFallbackTexture = null;
    this.interactiveReflectionFallbackKind = 'none';
    this.interactiveReflectionFallbackEverUsable = false;
    for (const visual of this.plotVisuals.values()) {
      visual.root.dispose(false, true);
      visual.wireframeLines.forEach((line) => line.dispose(false, true));
      visual.transparentBackShell?.dispose(false, true);
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
    this.interactiveReflectionSource = 'none';
    this.interactiveReflectionTexture = null;
    this.interactiveReflectionFallbackKind = 'none';
    this.interactiveReflectionFallbackEverUsable = false;
    this.latestSnapshot = null;
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

    const snapshot = createRendererSceneSnapshot(state, this.camera);
    this.latestSnapshot = snapshot;

    this.syncSceneSettings(snapshot);
    this.syncLights(snapshot);
    this.syncInteractiveReflectionSetup(snapshot);
    this.syncPlots(snapshot);
    this.syncInteractiveReflectionProbe(snapshot);
    this.syncSelection(snapshot.selectedId, snapshot.objects);

    this.syncQualityRenderer(snapshot);

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

    this.syncRenderDiagnostics(snapshot);
  }

  private syncSceneSettings(
    snapshot: RendererSceneSnapshot,
  ): void {
    if (!this.scene || !this.directionalLight || !this.groundMesh || !this.gridMesh) {
      return;
    }
    const { scene, render } = snapshot;
    this.ensureDirectionalShadowGenerator(
      clamp(Math.round(scene.shadow.shadowMapResolution), 256, 4096),
      clamp01(scene.shadow.shadowSoftness),
    );

    if (this.ambientLight) {
      const ambientColor = color3(scene.ambient.color);
      this.ambientLight.intensity = scene.ambient.intensity;
      this.ambientLight.diffuse = ambientColor;
      this.ambientLight.specular = ambientColor.scale(0.15);
      this.ambientLight.groundColor = ambientColor.scale(0.08);
      this.ambientLight.setEnabled(scene.ambient.intensity > 0);
    }

    const directionalColor = color3(scene.directional.color);
    this.directionalLight.diffuse = directionalColor;
    this.directionalLight.specular = directionalColor;
    const dir = vec3(scene.directional.direction);
    if (dir.lengthSquared() > 1e-8) {
      dir.normalize();
      this.directionalLight.direction.copyFrom(dir);
      // Keep shadow/light position aligned with the direction vector relative to camera target.
      const target = this.camera?.target ?? Vector3.ZeroReadOnly;
      this.directionalLight.position.copyFrom(target.subtract(dir.scale(24)));
    }
    // Keep the directional shadow frustum tight to actual receivers/casters instead of
    // hidden helper extents, which wastes shadow texels and causes visible banding.
    const graphBounds = scene.defaultGraphBounds;
    const graphSpanZ = Math.abs(graphBounds.max.z - graphBounds.min.z);
    const shadowFrustumSize = resolveDirectionalShadowFrustumSize(scene);
    this.directionalLight.shadowFrustumSize = shadowFrustumSize;
    this.directionalLight.shadowMinZ = 0.1;
    this.directionalLight.shadowMaxZ = Math.max(40, graphSpanZ * 6, shadowFrustumSize * 2);
    this.directionalLight.shadowOrthoScale = 0.2;
    const directionalShadowsActive = scene.directional.castShadows && scene.shadow.directionalShadowEnabled;
    this.directionalLight.intensity = scene.directional.intensity;
    this.directionalLight.setEnabled(scene.directional.intensity > 0 || scene.directional.castShadows);
    this.directionalLight.shadowEnabled = directionalShadowsActive;
    if (this.directionalShadow) {
      const shadowMap = this.directionalShadow.getShadowMap();
      if (shadowMap) {
        shadowMap.refreshRate = directionalShadowsActive ? 1 : 0;
      }
    }

    const clear = scene.backgroundMode === 'solid' ? scene.backgroundColor : scene.gradientBottomColor;
    this.scene.clearColor = Color4.FromColor3(color3(clear), 0);
    this.canvas.style.background =
      scene.backgroundMode === 'solid'
        ? scene.backgroundColor
        : `linear-gradient(${scene.gradientTopColor}, ${scene.gradientBottomColor})`;
    const ipc = this.scene.imageProcessingConfiguration;
    ipc.isEnabled = true;
    ipc.exposure = clamp(render.exposure, 0.01, 10);
    ipc.toneMappingEnabled = render.toneMapping !== 'none';
    ipc.toneMappingType =
      render.toneMapping === 'aces'
        ? ImageProcessingConfiguration.TONEMAPPING_ACES
        : ImageProcessingConfiguration.TONEMAPPING_STANDARD;

    this.groundMesh.isVisible = scene.groundPlaneVisible;
    this.groundMesh.receiveShadows = directionalShadowsActive;
    // Babylon ground geometry is created in local XZ; in our z-up app that means
    // we rotate it into XY and scale X/Z to keep it square.
    this.groundMesh.scaling = new Vector3(scene.groundPlaneSize, 1, scene.groundPlaneSize);
    // GridMaterial on a rotated ground is unreliable for an XY grid in this z-up scene.
    // We render explicit XY grid line meshes instead and keep this mesh hidden.
    this.gridMesh.isVisible = false;
    this.gridMesh.scaling = new Vector3(scene.gridExtent, 1, scene.gridExtent);
    this.syncXYGridLines(snapshot);
    const groundMaterial = this.groundMesh.material;
    if (groundMaterial instanceof PBRMaterial) {
      groundMaterial.albedoColor = color3(scene.groundPlaneColor);
      groundMaterial.roughness = clamp01(scene.groundPlaneRoughness);
      groundMaterial.metallic = scene.groundPlaneReflective ? 0.05 : 0;
      groundMaterial.reflectionTexture = scene.groundPlaneReflective
        ? (this.scene.environmentTexture ?? null)
        : null;
      if (groundMaterial.reflectionTexture) {
        groundMaterial.reflectionTexture.level = scene.groundPlaneReflective ? 0.6 : 0;
      }
    }

    const gridMaterial = this.gridMesh.material;
    if (gridMaterial instanceof GridMaterial) {
      // Keep grid readable when the ground plane is hidden.
      gridMaterial.mainColor = scene.groundPlaneVisible
        ? color3(scene.groundPlaneColor)
        : new Color3(0.08, 0.1, 0.14);
      gridMaterial.lineColor = scene.groundPlaneVisible
        ? new Color3(0.15, 0.2, 0.3)
        : new Color3(0.72, 0.8, 0.95);
      gridMaterial.gridRatio = Math.max(0.05, scene.gridSpacing);
      gridMaterial.opacity = clamp01(scene.gridLineOpacity);
      gridMaterial.majorUnitFrequency = 5;
      gridMaterial.minorUnitVisibility = scene.groundPlaneVisible ? 0.3 : 0.45;
    }

    const axesVisible = scene.axesVisible;
    if (this.axesMeshes.length === 0 || Math.abs(this.axesMeshes[0].getBoundingInfo().boundingBox.extendSize.x - scene.axesLength / 2) > 1e-6) {
      this.createAxes(scene.axesLength);
    }
    this.axesMeshes.forEach((m) => {
      m.isVisible = axesVisible;
    });
  }

  private syncLights(
    snapshot: RendererSceneSnapshot,
  ): void {
    if (!this.scene) return;

    const { scene, render, pointLights, selectedId } = snapshot;
    const pointLightObjects = pointLights.map((entry) => entry.light);
    const seen = new Set<string>();
    const shadowSettings = scene.shadow;
    const allowPointShadows =
      shadowSettings.pointShadowMode === 'on'
      || (shadowSettings.pointShadowMode === 'auto' && render.interactiveQuality !== 'performance');
    const pointShadowLimit = allowPointShadows ? clamp(Math.round(shadowSettings.pointShadowMaxLights), 0, 4) : 0;
    const pointShadowCandidates = pointLightObjects
      .filter((light) => light.castShadows && light.intensity > 0)
      .sort((a, b) => {
        if (a.id === selectedId) return -1;
        if (b.id === selectedId) return 1;
        return b.intensity - a.intensity;
      })
      .slice(0, pointShadowLimit);
    const pointShadowIds = new Set(pointShadowCandidates.map((light) => light.id));

    pointLightObjects.forEach((lightObj) => {
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

        visual = {
          light,
          gizmo,
          pickShell,
          halo,
          starLines,
          shadow: null,
          shadowEnabled: false,
        };
        this.pointLightVisuals.set(lightObj.id, visual);
      }

      // Light visibility only controls viewport gizmos. Emission remains active.
      visual.gizmo.isVisible = lightObj.visible;
      visual.pickShell.isVisible = lightObj.visible;
      visual.halo.isVisible = lightObj.visible;
      visual.starLines.forEach((line) => {
        line.isVisible = lightObj.visible;
      });
      visual.light.position.copyFrom(vec3(lightObj.position));
      visual.gizmo.position.copyFrom(vec3(lightObj.position));
      const pointLightColor = color3(lightObj.color);
      visual.light.diffuse = pointLightColor;
      visual.light.specular = pointLightColor;
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
      visual.light.intensity = lightObj.intensity;
      visual.light.setEnabled(lightObj.intensity > 0);
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

  private syncPlots(
    snapshot: RendererSceneSnapshot,
  ): void {
    if (!this.scene) return;
    const { scene, plotJobs, plots } = snapshot;
    const seen = new Set<string>();
    const directionalShadowsActive = Boolean(
      this.directionalShadow && scene.directional.castShadows && scene.shadow.directionalShadowEnabled,
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

    for (const plotSnapshot of plots) {
      const { plot } = plotSnapshot;
      seen.add(plot.id);
      const geometryKey = buildGeometryKey(plot, plotSnapshot.meshVersion);
      const oldHash = this.meshHashCache.get(plot.id);

      let visual = this.plotVisuals.get(plot.id);
      const runtimeMesh = getRuntimePlotMesh(plot.id);
      const waitingForWorkerMesh = Boolean(
        !runtimeMesh
        && visual
        && plot.equation.source.parseStatus === 'ok'
        && isWorkerMeshPending(plotJobs[plot.id]),
      );
      if (waitingForWorkerMesh && oldHash !== geometryKey && visual) {
        // Keep the previous mesh on screen until preview/final worker output arrives.
        this.syncPlotVisualState(visual, plotSnapshot, directionalShadowsActive);
        continue;
      }
      if (!visual || oldHash !== geometryKey) {
        this.disposeImplicitSelectionHalo(plot.id);
        visual?.wireframeLines.forEach((line) => line.dispose(false, true));
        visual?.transparentBackShell?.dispose(false, true);
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

      this.syncPlotVisualState(visual, plotSnapshot, directionalShadowsActive);
    }

    for (const [id, visual] of this.plotVisuals.entries()) {
      if (!seen.has(id)) {
        this.disposeImplicitSelectionHalo(id);
        visual.wireframeLines.forEach((line) => line.dispose(false, true));
        visual.transparentBackShell?.dispose(false, true);
        visual.root.dispose(false, true);
        this.plotVisuals.delete(id);
        this.meshHashCache.delete(id);
      }
    }

    if (this.groundMesh) {
      this.groundMesh.receiveShadows = scene.groundPlaneVisible && (directionalShadowsActive || this.hasAnyPointLightShadowsEnabled());
    }
  }

  private syncInteractiveReflectionSetup(snapshot: RendererSceneSnapshot): void {
    if (!this.scene) {
      return;
    }
    const { plots, scene } = snapshot;
    this.scene.probesEnabled = false;
    this.scene.texturesEnabled = true;
    this.interactiveReflectionLastRefreshReason = null;
    this.interactiveReflectionProbeRefreshCount = 0;

    this.ensureEnvironmentFallbackTexture(scene);

    const hasReflectivePlot = plots.some(
      ({ plot, isRenderable }) => isRenderable && plot.visible && (plot.material.reflectiveness > 0.08 || plot.material.roughness < 0.25),
    );
    if (!hasReflectivePlot) {
      this.applyInteractiveReflectionSource('none', null, null, null);
      return;
    }

    const externalEnvironmentTexture = this.scene.environmentTexture;
    const externalEnvironmentUsable = Boolean(
      externalEnvironmentTexture
      && externalEnvironmentTexture !== this.environmentFallbackTexture
      && this.isUsableReflectionTexture(externalEnvironmentTexture),
    );
    const fallbackEnvironmentUsable = this.isUsableReflectionTexture(this.environmentFallbackTexture);
    const source = selectInteractiveReflectionSource({
      externalEnvironmentUsable,
      fallbackEnvironmentUsable,
    });

    if (source === 'external_env' && externalEnvironmentTexture) {
      this.applyInteractiveReflectionSource(source, externalEnvironmentTexture, null, externalEnvironmentTexture);
      return;
    }
    if (source === 'fallback_ready' && this.environmentFallbackTexture) {
      this.applyInteractiveReflectionSource(source, this.environmentFallbackTexture, null, this.environmentFallbackTexture);
      return;
    }
    this.applyInteractiveReflectionSource('none', null, 'Environment fallback unavailable', null);
  }

  private syncInteractiveReflectionProbe(_snapshot: RendererSceneSnapshot): void {
    // Live scene probes are intentionally disabled in the correctness-first rewrite.
  }

  private ensureEnvironmentFallbackTexture(sceneSettings: AppState['scene']): void {
    if (!this.scene) {
      return;
    }
    const topBase = sceneSettings.backgroundMode === 'gradient'
      ? color3(sceneSettings.gradientTopColor)
      : color3(sceneSettings.backgroundColor);
    const bottomBase = sceneSettings.backgroundMode === 'gradient'
      ? color3(sceneSettings.gradientBottomColor)
      : color3(sceneSettings.backgroundColor);
    const groundBase = color3(sceneSettings.groundPlaneColor);
    const ambientTint = color3(sceneSettings.ambient.color).scale(clamp(sceneSettings.ambient.intensity * 0.2, 0, 0.3));
    const sunTint = color3(sceneSettings.directional.color).scale(clamp(sceneSettings.directional.intensity * 0.12, 0, 0.35));
    const horizonColor = mixColor(mixColor(topBase, bottomBase, 0.5), ambientTint, 0.4);
    const upColor = mixColor(topBase, sunTint, 0.35);
    const downColor = mixColor(bottomBase.scale(0.55), groundBase.scale(0.92), 0.6);
    const sideColor = mixColor(horizonColor, mixColor(upColor, downColor, 0.5), 0.18);
    const faceSize = 4;
    const fallbackKey = [
      sceneSettings.backgroundMode,
      sceneSettings.backgroundColor,
      sceneSettings.gradientTopColor,
      sceneSettings.gradientBottomColor,
      sceneSettings.groundPlaneColor,
      sceneSettings.ambient.color,
      sceneSettings.ambient.intensity.toFixed(4),
      sceneSettings.directional.color,
      sceneSettings.directional.intensity.toFixed(4),
    ].join('|');

    if (this.environmentFallbackTexture && this.environmentFallbackKey === fallbackKey) {
      return;
    }

    const previousFallback = this.environmentFallbackTexture;
    const sceneWasUsingFallback = this.scene.environmentTexture === previousFallback;
    try {
      const faceColors = [
        mixColor(sideColor, sunTint, 0.04),
        mixColor(sideColor, ambientTint, 0.08),
        mixColor(sideColor, upColor, 0.04),
        mixColor(sideColor, downColor, 0.05),
        mixColor(upColor, horizonColor, 0.22),
        mixColor(downColor, horizonColor, 0.18),
      ];
      const faceData = faceColors.map((color) => makeSolidCubeFaceBytes(color, faceSize));
      const fallbackTexture = new RawCubeTexture(
        this.scene,
        faceData,
        faceSize,
        Constants.TEXTUREFORMAT_RGBA,
        Constants.TEXTURETYPE_UNSIGNED_BYTE,
        false,
        false,
        Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
      );
      fallbackTexture.name = 'interactive-env-fallback';
      fallbackTexture.gammaSpace = false;
      fallbackTexture.level = 1;
      fallbackTexture.sphericalPolynomial = new SphericalPolynomial();
      this.environmentFallbackTexture = fallbackTexture;
      this.environmentFallbackKey = fallbackKey;
      this.interactiveReflectionFallbackKind = 'raw_cube';
      this.interactiveReflectionFallbackEverUsable = this.isUsableReflectionTexture(fallbackTexture);
      if (sceneWasUsingFallback) {
        this.scene.environmentTexture = fallbackTexture;
      }
      previousFallback?.dispose();
    } catch (error) {
      if (sceneWasUsingFallback && this.scene.environmentTexture === previousFallback) {
        this.scene.environmentTexture = null;
      }
      previousFallback?.dispose();
      this.environmentFallbackTexture = null;
      this.environmentFallbackKey = '';
      this.interactiveReflectionFallbackKind = 'none';
      console.warn('Interactive environment fallback texture creation failed', error);
    }
  }

  private rebindPlotMaterialsFromStateObjects(objects: SceneObject[]): void {
    for (const obj of objects) {
      if (obj.type !== 'plot') continue;
      const visual = this.plotVisuals.get(obj.id);
      if (!visual) continue;
      this.applyPlotMaterial(obj, visual);
    }
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
      this.rebindPlotMaterialsFromStateObjects([...(this.latestSnapshot?.objects ?? [])]);
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
    const sceneEnvironmentTexture = this.scene?.environmentTexture ?? null;
    if (
      sceneEnvironmentTexture
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
    let topology: PlotVisual['topology'];
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
            const line = MeshBuilder.CreateLines(`plot-${plot.id}-wire-${idx}`, { points, useVertexAlpha: true }, this.scene);
            line.parent = this.plotRoot;
            line.isPickable = false;
            this.configurePlotWireframeLine(line, plot);
            wireframeLines.push(line);
          }
        });
      }
    } else {
      const meshData = buildImplicitMeshFromScalarField(
        compiled.spec.bounds,
        (x, y, z) => compiled.fn(x, y, z),
        compiled.spec.quality,
      );
      topology = meshData.topology;
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

    return {
      root,
      wireframeLines,
      transparentBackShell: this.createTransparentBackShell(plot, root, topology),
      geometryKey: buildGeometryKey(plot),
      topology,
      curveTube,
    };
  }

  private buildPlotVisualFromSerialized(plot: PlotObject, meshData: SerializedMesh): PlotVisual {
    if (!this.scene) {
      throw new Error('Scene not initialized');
    }

    let root: Mesh;
    const wireframeLines: LinesMesh[] = [];
    let topology: PlotVisual['topology'];
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
      topology = meshData.topology;
      root = new Mesh(`plot-${plot.id}`, this.scene);
      applySerializedMeshToBabylonMesh(root, meshData);
    }

    if (meshData.lines) {
      meshData.lines.forEach((coords, idx) => {
        const points = floatArrayToVector3Path(coords);
        if (points.length >= 2) {
          const line = MeshBuilder.CreateLines(`plot-${plot.id}-wire-${idx}`, { points, useVertexAlpha: true }, this.scene);
          line.parent = this.plotRoot;
          line.isPickable = false;
          this.configurePlotWireframeLine(line, plot);
          wireframeLines.push(line);
        }
      });
    }

    root.metadata = { selectableId: plot.id, selectableType: 'plot' };
    root.isPickable = true;
    root.parent = this.plotRoot;
    root.receiveShadows = true;
    root.renderOverlay = false;

    return {
      root,
      wireframeLines,
      transparentBackShell: this.createTransparentBackShell(plot, root, topology),
      geometryKey: buildGeometryKey(plot),
      topology,
      curveTube,
    };
  }

  private createTransparentBackShell(
    plot: PlotObject,
    root: Mesh,
    topology?: SerializedMesh['topology'],
  ): Mesh | null {
    if (
      plot.equation.kind !== 'parametric_surface'
      && plot.equation.kind !== 'explicit_surface'
      && !(plot.equation.kind === 'implicit_surface' && topology?.isClosedManifold !== true)
    ) {
      return null;
    }
    const shell = root.clone(`plot-${plot.id}-back-shell`, null, false);
    if (!(shell instanceof Mesh)) {
      return null;
    }
    shell.parent = this.plotRoot;
    shell.isPickable = false;
    shell.receiveShadows = false;
    shell.renderOverlay = false;
    shell.metadata = { selectableId: null, selectableType: 'plot_back_shell', sourceId: plot.id };
    return shell;
  }

  private syncPlotVisualState(
    visual: PlotVisual,
    plotSnapshot: RendererPlotSnapshot,
    directionalShadowsActive: boolean,
  ): void {
    const {
      plot,
      isRenderable,
      showsWireframe,
      castsInteractiveShadows,
      interactiveShadowMode,
    } = plotSnapshot;
    const plotVisible = plot.visible && isRenderable;
    const shadowVisible = plot.visible && castsInteractiveShadows;
    const usesTransparentBackShell = shouldUseTransparentBackShell(plot, visual.topology);

    visual.root.parent = this.plotRoot;
    visual.root.isVisible = plotVisible || shadowVisible;
    visual.root.position.copyFrom(vec3(plot.transform.position));
    visual.root.receiveShadows = directionalShadowsActive || this.hasAnyPointLightShadowsEnabled();
    if (visual.transparentBackShell) {
      visual.transparentBackShell.parent = this.plotRoot;
      visual.transparentBackShell.position.copyFrom(vec3(plot.transform.position));
      visual.transparentBackShell.isVisible = (plotVisible || shadowVisible) && usesTransparentBackShell;
      visual.transparentBackShell.receiveShadows = false;
    }

    this.applyPlotMaterial(plot, visual);

    if (shadowVisible) {
      this.addInteractiveShadowCaster(visual.root);
      if (interactiveShadowMode === 'attenuated' && usesTransparentBackShell && visual.transparentBackShell?.isVisible) {
        this.addInteractiveShadowCaster(visual.transparentBackShell);
      }
    }

    for (const wire of visual.wireframeLines) {
      wire.isVisible = showsWireframe && plotVisible;
      wire.position.copyFrom(vec3(plot.transform.position));
      this.configurePlotWireframeLine(wire, plot);
    }
  }

  private addInteractiveShadowCaster(mesh: Mesh): void {
    this.directionalShadow?.addShadowCaster(mesh, true);
    for (const pointLight of this.pointLightVisuals.values()) {
      if (pointLight.shadowEnabled) {
        pointLight.shadow?.addShadowCaster(mesh, true);
      }
    }
  }

  private applyPlotMaterial(plot: PlotObject, visual: PlotVisual): void {
    if (!this.scene) return;
    const usesTransparentShells = shouldUseTransparentBackShell(plot, visual.topology);
    const reflectionTexture = this.resolvePlotReflectionTexture();
    const hasUsableReflectionTexture = this.isUsableReflectionTexture(reflectionTexture);
    this.applyInteractivePlotMaterialToMesh(plot, visual.root, {
      renderSide: usesTransparentShells ? 'front' : 'both',
      reflectionTexture: hasUsableReflectionTexture ? reflectionTexture : null,
    });
    if (visual.transparentBackShell) {
      if (usesTransparentShells) {
        this.applyInteractivePlotMaterialToMesh(plot, visual.transparentBackShell, {
          renderSide: 'back',
          reflectionTexture: hasUsableReflectionTexture ? reflectionTexture : null,
        });
      } else {
        visual.transparentBackShell.isVisible = false;
      }
    }
  }

  private applyInteractivePlotMaterialToMesh(
    plot: PlotObject,
    mesh: Mesh,
    options: { renderSide: 'both' | 'front' | 'back'; reflectionTexture: Nullable<BaseTexture> },
  ): void {
    const scene = this.scene;
    if (!scene) {
      return;
    }
    let material = mesh.material;
    if (!(material instanceof PBRMaterial)) {
      const suffix = options.renderSide === 'both' ? '' : `-${options.renderSide}`;
      material = new PBRMaterial(`mat-${plot.id}${suffix}`, scene);
      mesh.material = material;
    }
    const pbr = material as PBRMaterial;
    const reflectiveness = clamp01(plot.material.reflectiveness);
    const roughness = clamp(plot.material.roughness, 0.02, 1);
    const opacity = clamp01(plot.material.opacity);
    const opticalOpenness = clamp01(1 - opacity);
    const isImplicitSurface = plot.equation.kind === 'implicit_surface';
    const usesTransparentPipeline =
      options.renderSide !== 'both'
      || (isImplicitSurface && opacity < INTERACTIVE_SHELL_RENDER_OPACITY_EPSILON);
    // Transparent shell passes already preserve specular/radiance over alpha. Closed implicit
    // volumes also need that behavior; otherwise clear-glass highlights get washed out.
    const preservesTransparentHighlights = usesTransparentPipeline
      && (options.renderSide !== 'both' || isImplicitSurface);
    const usesTransparentSurfaceOptics = options.renderSide !== 'both';
    const baseColor = color3(plot.material.baseColor);
    const diffuseRetention = clamp(1 - opticalOpenness * 0.2, 0.55, 1);
    const shellCompositedAlpha = options.renderSide === 'both'
      ? opacity
      : resolveShellLayerAlpha(opacity);
    const shadowAlpha = usesTransparentPipeline
      ? resolveInteractiveShadowAlpha(opacity, options.renderSide)
      : 1;
    pbr.albedoColor = mixColor(baseColor, Color3.White(), opticalOpenness * 0.08).scale(diffuseRetention);
    pbr.metallic = clamp(reflectiveness * (usesTransparentSurfaceOptics ? 0.18 : 0.32), 0, 1);
    pbr.roughness = roughness;
    pbr.alpha = usesTransparentPipeline ? clamp(shellCompositedAlpha, 0, 1) : 1;
    pbr.transparencyMode = usesTransparentPipeline ? PBRMaterial.PBRMATERIAL_ALPHABLEND : PBRMaterial.PBRMATERIAL_OPAQUE;
    pbr.indexOfRefraction = FIXED_INTERACTIVE_IOR;
    pbr.subSurface.isRefractionEnabled = false;
    pbr.subSurface.isTranslucencyEnabled = false;
    pbr.subSurface.refractionIntensity = 0;
    pbr.subSurface.indexOfRefraction = FIXED_INTERACTIVE_IOR;
    pbr.metallicF0Factor = clamp(0.65 + reflectiveness * 0.9, 0.65, 1.8);
    pbr.specularIntensity = 1;
    pbr.directIntensity = 1;
    pbr.environmentIntensity = options.reflectionTexture ? clamp(0.6 + reflectiveness * 0.8, 0.45, 1.8) : 0.35;
    pbr.useRadianceOverAlpha = preservesTransparentHighlights;
    pbr.useAlphaFresnel = preservesTransparentHighlights;
    pbr.useLinearAlphaFresnel = false;
    pbr.useSpecularOverAlpha = preservesTransparentHighlights;
    pbr.reflectionTexture = options.reflectionTexture;
    pbr.emissiveColor = options.reflectionTexture ? Color3.Black() : pbr.albedoColor.scale(preservesTransparentHighlights ? 0.04 : 0.08);
    pbr.realTimeFiltering = false;
    pbr.sideOrientation = isImplicitSurface ? Material.ClockWiseSideOrientation : null;
    if (options.renderSide === 'front') {
      pbr.backFaceCulling = true;
      pbr.cullBackFaces = true;
      pbr.separateCullingPass = false;
      pbr.twoSidedLighting = false;
    } else if (options.renderSide === 'back') {
      pbr.backFaceCulling = true;
      pbr.cullBackFaces = false;
      pbr.separateCullingPass = false;
      pbr.twoSidedLighting = false;
    } else if (isImplicitSurface && usesTransparentPipeline) {
      pbr.backFaceCulling = true;
      pbr.cullBackFaces = true;
      pbr.separateCullingPass = false;
      pbr.twoSidedLighting = false;
    } else {
      pbr.backFaceCulling = false;
      pbr.cullBackFaces = true;
      pbr.separateCullingPass = false;
      pbr.twoSidedLighting = true;
    }
    pbr.enableSpecularAntiAliasing = true;
    pbr.forceDepthWrite = !usesTransparentPipeline;
    pbr.needDepthPrePass = false;
    mesh.renderingGroupId = usesTransparentPipeline ? 1 : 0;
    mesh.alphaIndex = usesTransparentPipeline
      ? stableAlphaIndex(plot.id) * 2 + (options.renderSide === 'front' ? 1 : 0)
      : 0;
    mesh.isPickable = options.renderSide !== 'back';
    mesh.metadata = {
      ...(mesh.metadata ?? {}),
      interactiveShadowAlpha: shadowAlpha,
    };
  }

  private configurePlotWireframeLine(line: LinesMesh, plot: PlotObject): void {
    const opacity = clamp01(plot.material.opacity);
    const isTransparent =
      plot.equation.kind === 'implicit_surface'
        ? opacity < INTERACTIVE_SHELL_RENDER_OPACITY_EPSILON
        : plotUsesTransparentShells(plot);
    line.color = new Color3(0.95, 0.98, 1);
    line.alpha = isTransparent ? 0.82 : 0.92;
    line.visibility = 1;
    line.renderingGroupId = isTransparent ? 2 : 1;
    line.alphaIndex = 10_000 + stableAlphaIndex(plot.id);
    const mat = line.material;
    if (mat) {
      mat.backFaceCulling = false;
      mat.disableDepthWrite = true;
      mat.depthFunction = Constants.LEQUAL;
    }
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

    const snapshot = this.latestSnapshot;
    if (!snapshot) {
      return;
    }
    for (const obj of snapshot.objects) {
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
        if (obj.id === snapshot.selectedId) {
          this.applyPlotSelectionHalo(updated, obj, visual);
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

  private applyPlotSelectionHalo(mesh: Mesh, plot: PlotObject, visual?: PlotVisual): void {
    mesh.renderOverlay = false;
    mesh.overlayAlpha = 0;
    mesh.renderOutline = false;
    mesh.outlineWidth = 0;
    mesh.disableEdgesRendering();

    const kind = plot.equation.kind;
    if (kind === 'parametric_curve') {
      this.disposeImplicitSelectionHalo(plot.id);
      mesh.enableEdgesRendering(0.9, false);
      mesh.edgesColor = new Color4(0.8, 0.88, 1, 0.58);
      mesh.edgesWidth = 0.72;
      return;
    }
    const isTransparent = transparencyBlendFromOpacity(plot.material.opacity) > 0.08;
    // The scaled shell halo only reads as an outline on closed volumes. On open surface
    // sheets and clipped implicits it turns into a one-sided translucent wash.
    const useShellHalo = shouldUseShellSelectionHalo(plot, visual?.topology);
    if (useShellHalo) {
      this.ensureImplicitSelectionHalo(plot.id, mesh, {
        scale: 1.02,
        alpha: 0.32,
      });
      return;
    }

    this.disposeImplicitSelectionHalo(plot.id);
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
        this.applyPlotSelectionHalo(visual.root, plot, visual);
      } else {
        this.disposeImplicitSelectionHalo(id);
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

  private disposeImplicitSelectionHalo(plotId: string): void {
    const halo = this.implicitSelectionHalos.get(plotId);
    if (!halo) {
      return;
    }
    halo.material?.dispose(false, true);
    halo.dispose(false, true);
    this.implicitSelectionHalos.delete(plotId);
  }

  private ensureImplicitSelectionHalo(
    plotId: string,
    source: Mesh,
    options: { scale: number; alpha: number },
  ): void {
    if (!this.scene) {
      return;
    }
    const key = `${plotId}|${round3(options.scale)}|${round3(options.alpha)}`;
    const existing = this.implicitSelectionHalos.get(plotId);
    if (existing && existing.parent === source && existing.metadata?.haloKey === key) {
      existing.isVisible = source.isVisible;
      return;
    }
    this.disposeImplicitSelectionHalo(plotId);
    const halo = source.clone(`plot-${plotId}-selection-halo`, null, false);
    if (!(halo instanceof Mesh)) {
      return;
    }
    halo.parent = source;
    halo.position.setAll(0);
    halo.rotationQuaternion = null;
    halo.rotation.setAll(0);
    halo.scaling.setAll(options.scale);
    halo.isPickable = false;
    halo.receiveShadows = false;
    halo.renderOverlay = false;
    halo.renderOutline = false;
    halo.renderingGroupId = 2;
    halo.alphaIndex = 20_000 + stableAlphaIndex(plotId);
    halo.metadata = { selectableId: null, selectableType: 'selectionHalo', sourceId: plotId, haloKey: key };
    const haloMaterial = new StandardMaterial(`plot-${plotId}-selection-halo-mat`, this.scene);
    haloMaterial.disableLighting = true;
    haloMaterial.emissiveColor = new Color3(0.86, 0.93, 1);
    haloMaterial.alpha = options.alpha;
    haloMaterial.backFaceCulling = true;
    haloMaterial.cullBackFaces = false;
    haloMaterial.sideOrientation = (source.material as Material | null)?.sideOrientation ?? Material.ClockWiseSideOrientation;
    haloMaterial.disableDepthWrite = true;
    haloMaterial.zOffset = -1;
    haloMaterial.zOffsetUnits = -1;
    halo.material = haloMaterial;
    halo.isVisible = source.isVisible;
    this.implicitSelectionHalos.set(plotId, halo);
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

  private syncXYGridLines(snapshot: RendererSceneSnapshot): void {
    if (!this.scene) return;
    const { scene } = snapshot;

    const extent = Math.max(0.5, scene.gridExtent);
    const minSpacing = Math.max(0.05, scene.gridSpacing);
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

    const baseColor = scene.groundPlaneVisible
      ? new Color3(0.15, 0.2, 0.3)
      : new Color3(0.72, 0.8, 0.95);
    const majorColor = scene.groundPlaneVisible
      ? new Color3(0.25, 0.32, 0.46)
      : new Color3(0.88, 0.93, 1.0);
    const opacity = clamp01(scene.gridLineOpacity);
    const visible = scene.gridVisible;

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
    shadow.transparencyShadow = true;
    shadow.enableSoftTransparentShadow = true;
    shadow.useOpacityTextureForTransparentShadow = false;
    this.ensureShadowAlphaHook(shadow);
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

  private ensureShadowAlphaHook(shadow: ShadowGenerator): void {
    if (this.shadowAlphaHookedGenerators.has(shadow)) {
      return;
    }
    shadow.onBeforeShadowMapRenderMeshObservable.add((mesh) => {
      const override = readInteractiveShadowAlpha(mesh);
      if (override === null) {
        return;
      }
      const material = mesh.material as (Material & { alpha?: number }) | null;
      if (!material || typeof material.alpha !== 'number') {
        return;
      }
      this.shadowAlphaRestore.set(mesh, material.alpha);
      material.alpha = override;
    });
    shadow.onAfterShadowMapRenderMeshObservable.add((mesh) => {
      const originalAlpha = this.shadowAlphaRestore.get(mesh);
      if (originalAlpha === undefined) {
        return;
      }
      const material = mesh.material as (Material & { alpha?: number }) | null;
      if (material && typeof material.alpha === 'number') {
        material.alpha = originalAlpha;
      }
      this.shadowAlphaRestore.delete(mesh);
    });
    this.shadowAlphaHookedGenerators.add(shadow);
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

  private syncRenderDiagnostics(snapshot: RendererSceneSnapshot): void {
    const { scene, render, plots, pointLights } = snapshot;
    const pointShadowsEnabled = Array.from(this.pointLightVisuals.values()).filter((v) => v.shadowEnabled).length;
    const directionalShadowCasterCount = this.directionalShadow?.getShadowMap()?.renderList?.length ?? 0;
    const pointShadowCasterCounts: Record<string, number> = {};
    for (const [id, visual] of this.pointLightVisuals.entries()) {
      pointShadowCasterCounts[id] = visual.shadowEnabled ? (visual.shadow?.getShadowMap()?.renderList?.length ?? 0) : 0;
    }
    const directionalShadowEnabled = Boolean(
      scene.directional.castShadows && scene.shadow.directionalShadowEnabled && this.directionalShadow,
    );
    const transparentPlotCount = plots.filter((plot) => plot.opacityClass === 'transparent').length;
    const shadowReceiver: RenderDiagnostics['shadowReceiver'] = scene.groundPlaneVisible
      ? 'ground'
      : 'none';
    const currentDiagnostics = useAppStore.getState().renderDiagnostics;
    const pathDiagnosticsActive = render.mode === 'quality' && this.qualityActiveRenderer === 'path';
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
      pointShadowLimit: scene.shadow.pointShadowMaxLights,
      pointShadowCasterCounts,
      shadowReceiver,
      transparentPlotCount,
      shadowMapResolution: scene.shadow.shadowMapResolution,
      pointShadowMode: scene.shadow.pointShadowMode,
      pointShadowCapability: this.pointShadowCapability,
      interactiveReflectionPath: this.interactiveReflectionPath,
      interactiveReflectionSource: this.interactiveReflectionSource,
      interactiveReflectionFallbackReason: this.interactiveReflectionFallbackReason,
      interactiveReflectionProbeSize: 0,
      interactiveReflectionProbeRefreshCount: this.interactiveReflectionProbeRefreshCount,
      interactiveReflectionLastRefreshReason: this.interactiveReflectionLastRefreshReason,
      interactiveReflectionProbeHasCapture: false,
      interactiveReflectionProbeUsable: false,
      interactiveReflectionProbeTextureReady: false,
      interactiveReflectionProbeTextureAllocated: false,
      interactiveReflectionFallbackKind: this.interactiveReflectionFallbackKind,
      interactiveReflectionFallbackEverUsable: this.interactiveReflectionFallbackEverUsable,
      interactiveReflectionFallbackTexturePresent: Boolean(fallbackTexture),
      interactiveReflectionFallbackTextureReady: fallbackReady,
      interactiveReflectionFallbackTextureUsable: fallbackUsable,
      qualityActiveRenderer: render.mode === 'quality' ? this.qualityActiveRenderer : 'none',
      qualityRendererFallbackReason: render.mode === 'quality' ? this.qualityFallbackReason : null,
      qualityResolutionScale: render.mode === 'quality' ? clamp(render.qualityResolutionScale, 0.25, 4) : 1,
      qualitySamplesPerSecond: render.mode === 'quality' ? this.qualitySamplesPerSecond : 0,
      qualityLastResetReason: render.mode === 'quality' ? this.qualityLastResetReason : null,
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

  private syncQualityRenderer(snapshot: RendererSceneSnapshot): void {
    this.syncQualityResolutionScale(snapshot.render);
    this.syncQualityPipeline(snapshot);
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

  private syncQualityPipeline(snapshot: RendererSceneSnapshot): void {
    if (!this.engine || !this.scene || !this.camera) return;
    const render = snapshot.render;
    this.qualityBackends ??= new QualityBackendRouter(this.engine, this.scene, this.camera, {
      getSnapshot: () => this.latestSnapshot,
      setStatusMessage: (message) => useAppStore.getState().setStatusMessage(message),
      setRenderDiagnostics: (diagnostics) => useAppStore.getState().setRenderDiagnostics(diagnostics),
    });

    const result = this.qualityBackends.sync(snapshot);
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
      if (this.latestSnapshot) {
        this.syncQualityPipeline(this.latestSnapshot);
      }
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
        if (this.latestSnapshot) {
          this.syncQualityPipeline(this.latestSnapshot);
        }
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

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function transparencyBlendFromOpacity(opacity: number): number {
  const openness = clamp01(1 - opacity);
  const t = clamp01(openness / 0.12);
  return t * t * (3 - 2 * t);
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

function resolveShellLayerAlpha(targetOpacity: number): number {
  const opacity = clamp01(targetOpacity);
  if (opacity >= 1) {
    return 1;
  }
  // Two shell layers should approximately compose back to the requested opacity:
  // combined = 1 - (1 - layerAlpha)^2
  return 1 - Math.sqrt(Math.max(0, 1 - opacity));
}

function resolveInteractiveShadowAlpha(opacity: number, renderSide: 'both' | 'front' | 'back'): number {
  const remappedOpacity = 0.25 + 0.75 * clamp01(opacity);
  return renderSide === 'both'
    ? remappedOpacity
    : resolveShellLayerAlpha(remappedOpacity);
}

function readInteractiveShadowAlpha(mesh: Mesh): number | null {
  const candidate = (mesh.metadata as { interactiveShadowAlpha?: unknown } | null | undefined)?.interactiveShadowAlpha;
  return typeof candidate === 'number' && Number.isFinite(candidate)
    ? clamp01(candidate)
    : null;
}

function makeSolidCubeFaceBytes(color: Color3, size: number): Uint8Array {
  const faceSize = Math.max(1, Math.floor(size));
  const data = new Uint8Array(faceSize * faceSize * 4);
  const r = Math.round(clamp01(color.r) * 255);
  const g = Math.round(clamp01(color.g) * 255);
  const b = Math.round(clamp01(color.b) * 255);
  for (let i = 0; i < faceSize * faceSize; i += 1) {
    const base = i * 4;
    data[base] = r;
    data[base + 1] = g;
    data[base + 2] = b;
    data[base + 3] = 255;
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
