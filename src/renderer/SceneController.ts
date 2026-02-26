import {
  ArcRotateCamera,
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
  Scene,
  ShadowGenerator,
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
import type { PlotJobStatus, PlotObject, PointLightObject, RenderDiagnostics, RenderSettings, SerializedMesh } from '../types/contracts';
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
        this.scene?.render();
        this.handleQualityFrameRendered();
      } catch (error) {
        this.renderLoopFailed = true;
        const message = error instanceof Error ? error.message : 'Unknown Babylon render error';
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
    useAppStore.getState().setRenderDiagnostics({ webgpuReady: false });
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

  sync(state: Pick<AppState, 'scene' | 'render' | 'objects' | 'selectedId' | 'plotJobs'>): void {
    if (!this.scene || !this.camera || !this.directionalLight) {
      return;
    }

    this.syncSceneSettings(state);
    this.syncLights(state);
    this.syncPlots(state);
    this.syncSelection(state.selectedId);

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
      groundMaterial.reflectionTexture = state.scene.groundPlaneReflective ? this.groundMirror : null;
      groundMaterial.reflectionTexture && (groundMaterial.reflectionTexture.level = state.scene.groundPlaneReflective ? 0.6 : 0);
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
      .filter((light) => light.visible && light.castShadows && light.intensity > 0)
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

      visual.light.setEnabled(lightObj.visible && lightObj.intensity > 0);
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

    if (compiled.kind === 'curve') {
      const sample = sampleCurve(
        compiled.spec.tDomain.min,
        compiled.spec.tDomain.max,
        compiled.spec.tDomain.samples,
        (t) => compiled.fn(t),
      );
      const path = sample.points.map((p) => new Vector3(p.x, p.y, p.z));
      if (compiled.spec.renderAsTube) {
        root = MeshBuilder.CreateTube(`plot-${plot.id}`, {
          path,
          radius: compiled.spec.tubeRadius,
          tessellation: 12,
          cap: Mesh.CAP_ALL,
        }, this.scene);
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

    return { root, wireframeLines, geometryKey: buildGeometryKey(plot) };
  }

  private buildPlotVisualFromSerialized(plot: PlotObject, meshData: SerializedMesh): PlotVisual {
    if (!this.scene) {
      throw new Error('Scene not initialized');
    }

    let root: Mesh;
    const wireframeLines: LinesMesh[] = [];

    if (meshData.curvePath && meshData.curvePath.length >= 6) {
      const path = floatArrayToVector3Path(meshData.curvePath);
      if (plot.equation.kind === 'parametric_curve' && plot.equation.renderAsTube) {
        root = MeshBuilder.CreateTube(
          `plot-${plot.id}`,
          {
            path,
            radius: plot.equation.tubeRadius,
            tessellation: 12,
            cap: Mesh.CAP_ALL,
          },
          this.scene,
        );
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

    return { root, wireframeLines, geometryKey: buildGeometryKey(plot) };
  }

  private applyPlotMaterial(plot: PlotObject, mesh: Mesh): void {
    if (!this.scene) return;
    let material = mesh.material;
    if (!(material instanceof PBRMaterial)) {
      material = new PBRMaterial(`mat-${plot.id}`, this.scene);
      mesh.material = material;
    }
    const pbr = material as PBRMaterial;
    pbr.albedoColor = color3(plot.material.baseColor);
    pbr.metallic = clamp01(plot.material.reflectiveness);
    pbr.roughness = clamp01(plot.material.roughness);
    pbr.alpha = clamp01(plot.material.opacity);
    pbr.transparencyMode = plot.material.opacity < 1 ? PBRMaterial.PBRMATERIAL_ALPHABLEND : PBRMaterial.PBRMATERIAL_OPAQUE;
    pbr.indexOfRefraction = Math.max(1, plot.material.ior);
    pbr.subSurface.isRefractionEnabled = plot.material.transmission > 0.05;
    pbr.subSurface.refractionIntensity = clamp01(plot.material.transmission);
    pbr.subSurface.indexOfRefraction = Math.max(1, plot.material.ior);
    // Implicit meshes are generated with a winding convention that ends up
    // inverted relative to Babylon's default LH front-face expectation.
    // Pinning sideOrientation fixes front/back classification so two-sided
    // lighting doesn't flip the visible shell normals.
    pbr.sideOrientation = plot.equation.kind === 'implicit_surface' ? Material.ClockWiseSideOrientation : null;
    const isTransparent = plot.material.opacity < 0.98 || plot.material.transmission > 0.05;
    // Keep culling disabled so Babylon can run the extra front/back pass when
    // `separateCullingPass` is enabled for transparent surfaces. Enabling
    // back-face culling here disables that path and can make implicit surfaces
    // look lit "inside out" / drop the expected front-facing shell.
    pbr.backFaceCulling = false;
    pbr.separateCullingPass = isTransparent;
    // Generated parametric/implicit meshes may have arbitrary winding (and users may
    // view the back side). Two-sided lighting prevents the \"lit side is dark\" issue.
    pbr.twoSidedLighting = true;
    pbr.environmentIntensity = 0.9;
    pbr.forceDepthWrite = !isTransparent;
    pbr.needDepthPrePass = isTransparent;
    mesh.renderingGroupId = isTransparent ? 1 : 0;
    mesh.alphaIndex = isTransparent ? stableAlphaIndex(plot.id) : 0;
  }

  private syncSelection(selectedId: string | null): void {
    for (const [id, visual] of this.plotVisuals.entries()) {
      visual.root.renderOverlay = id === selectedId;
      visual.root.overlayColor = id === selectedId ? new Color3(0.98, 0.78, 0.18) : new Color3(0, 0, 0);
      visual.root.overlayAlpha = id === selectedId ? 0.22 : 0;
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
    this.canvas.setPointerCapture(event.pointerId);
  }

  private handlePointerUp(event: PointerEvent): void {
    if (this.cameraDrag && this.cameraDrag.pointerId === event.pointerId) {
      this.cameraDrag = null;
      this.canvas.releasePointerCapture(event.pointerId);
    }
    if (this.dragState) {
      this.dragState = null;
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

function clamp01(value: number): number {
  return clamp(value, 0, 1);
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
