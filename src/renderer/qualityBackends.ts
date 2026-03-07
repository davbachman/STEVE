import {
  ArcRotateCamera,
  Color3,
  DirectionalLight,
  HemisphericLight,
  LinesMesh,
  Matrix,
  Mesh,
  PBRMaterial,
  PointLight,
  Ray,
  StandardMaterial,
  Vector3,
} from '@babylonjs/core';
import type { AbstractMesh, Material, Scene, WebGPUEngine } from '@babylonjs/core';
import { TAARenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/taaRenderingPipeline';
import { CreateScreenshotUsingRenderTargetAsync } from '@babylonjs/core/Misc/screenshotTools';
import type { RenderDiagnostics, RenderSettings } from '../types/contracts';
import type {
  PathTraceWorkerLight,
  PathTraceWorkerLineAccel,
  PathTraceWorkerMaterial,
  PathTraceWorkerRenderParams,
  PathTraceWorkerRequest,
  PathTraceWorkerResponse,
  PathTraceWorkerSceneSnapshot,
  PathTraceWorkerTriangleAccel as WorkerTraceTriangleAccel,
  PathTraceWorkerTriangleBvhNode,
  PathTraceWorkerVec3,
} from '../workers/pathTraceQualityWorkerContracts';
import type { RendererSceneSnapshot } from './renderSnapshot';

type ActiveQualityRenderer = RenderDiagnostics['qualityActiveRenderer'];

interface BackendConfigureResult {
  enabled: boolean;
  enabledJustNow: boolean;
  unsupportedReason: string | null;
}

export interface QualityBackendSyncResult {
  activeRenderer: ActiveQualityRenderer;
  fallbackReason: string | null;
  enabledJustNow: boolean;
}

export interface QualityBackendProgress {
  currentSamples: number;
  running: boolean;
}

export interface QualityBackendTickResult {
  shouldRender: boolean;
  progress: QualityBackendProgress;
}

export interface QualityBackendRuntimeContext {
  getSnapshot: () => RendererSceneSnapshot | null;
  setStatusMessage: (message: string | null) => void;
  setRenderDiagnostics: (diagnostics: Partial<RenderDiagnostics>) => void;
}

interface HybridSurfaceMaterial {
  baseColor: Vector3;
  metallic: number;
  roughness: number;
  reflectance: number;
  ior: number;
  opacity: number;
}

interface HybridPixelSample {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface HybridBounceSample {
  direction: Vector3;
  throughput: Vector3;
  nextMediumIor: number;
  wasTransmission: boolean;
  wasGlossySpecular: boolean;
}

interface HybridEnvironmentSample {
  radiance: Vector3;
  alpha: number;
}

interface CpuPathWorkerPendingBatch {
  requestId: number;
  sceneVersion: number;
  generation: number;
  dispatchedAtMs: number;
  pixelIndices: Uint32Array;
  nextTracePixelCursor: number;
  totalPixels: number;
  targetSamples: number;
  renderSnapshot: RenderSettings;
}

interface HybridTracePixelContext {
  viewportX: number;
  viewportY: number;
  pixelScaleX: number;
  pixelScaleY: number;
  hardwareScale: number;
}

interface TraceMeshAccelEntry {
  mesh: AbstractMesh;
  hybridMaterial: HybridSurfaceMaterial;
  worldMatrixUpdateFlag: number;
  worldMatrixElements: Float32Array;
  triangleAccel: TraceTriangleAccel | null;
  lineAccel: TraceLineAccel | null;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  centerX: number;
  centerY: number;
  centerZ: number;
}

interface TraceMeshBvhNode {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  left: TraceMeshBvhNode | null;
  right: TraceMeshBvhNode | null;
  items: TraceMeshAccelEntry[] | null;
}

interface TraceTriangleBvhNode {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  left: TraceTriangleBvhNode | null;
  right: TraceTriangleBvhNode | null;
  triangleIndices: Uint32Array | null;
}

interface TraceTriangleAccel {
  positionsWorld: Float32Array;
  normalsWorld: Float32Array | null;
  triangleCount: number;
  triangleBvhRoot: TraceTriangleBvhNode | null;
}

interface TraceLineAccel {
  positionsWorld: Float32Array; // [ax, ay, az, bx, by, bz] per segment
  segmentCount: number;
  intersectionThreshold: number;
}

interface TracePickResult {
  hit: true;
  distance: number;
  pickedPoint: Vector3;
  pickedMesh: AbstractMesh;
  hybridMaterial: HybridSurfaceMaterial;
  getNormal(useWorldCoordinates?: boolean, useVerticesNormals?: boolean): Vector3 | null;
}

interface QualityBackend {
  configure(render: RenderSettings): BackendConfigureResult;
  disable(): void;
  isEnabled(): boolean;
  tick(render: RenderSettings): QualityBackendTickResult;
  onFrameRendered(render: RenderSettings, sourceCanvas: HTMLCanvasElement): void;
  getProgress(render: RenderSettings): QualityBackendProgress;
  isReadyForExport(render: RenderSettings): boolean;
  getExportCanvas(): HTMLCanvasElement | null;
  resetAccumulation(): void;
  resetHistory(reason?: string | null): void;
  dispose(): void;
}

class TaaPreviewQualityBackend implements QualityBackend {
  private pipeline: TAARenderingPipeline | null = null;
  private progressCounter = 0;

  constructor(
    private readonly scene: Scene,
    private readonly camera: ArcRotateCamera,
  ) {}

  configure(render: RenderSettings): BackendConfigureResult {
    if (!this.pipeline) {
      const pipeline = new TAARenderingPipeline('quality-taa', this.scene, [this.camera]);
      if (!pipeline.isSupported) {
        pipeline.dispose();
        return {
          enabled: false,
          enabledJustNow: false,
          unsupportedReason: 'Quality accumulation (TAA) is not supported on this GPU/browser',
        };
      }
      this.pipeline = pipeline;
    }

    const targetSamples = clamp(Math.round(render.qualitySamplesTarget), 1, 4096);
    this.pipeline.samples = targetSamples;
    this.pipeline.msaaSamples = 1;
    this.pipeline.disableOnCameraMove = true;
    this.pipeline.reprojectHistory = false;
    this.pipeline.clampHistory = true;
    this.pipeline.factor = qualityBlendFactor(targetSamples);

    const enabledJustNow = !this.pipeline.isEnabled;
    if (enabledJustNow) {
      this.pipeline.isEnabled = true;
    }

    return {
      enabled: this.pipeline.isEnabled,
      enabledJustNow,
      unsupportedReason: null,
    };
  }

  disable(): void {
    if (this.pipeline?.isEnabled) {
      this.pipeline.isEnabled = false;
    }
    this.progressCounter = 0;
  }

  isEnabled(): boolean {
    return Boolean(this.pipeline?.isEnabled);
  }

  tick(render: RenderSettings): QualityBackendTickResult {
    if (!this.pipeline?.isEnabled) {
      this.progressCounter = 0;
      return {
        shouldRender: true,
        progress: { currentSamples: 0, running: false },
      };
    }
    const target = clamp(Math.round(render.qualitySamplesTarget), 1, 4096);
    if (this.progressCounter >= target) {
      return {
        shouldRender: false,
        progress: { currentSamples: this.progressCounter, running: false },
      };
    }
    return {
      shouldRender: true,
      progress: { currentSamples: this.progressCounter, running: true },
    };
  }

  onFrameRendered(render: RenderSettings, _sourceCanvas: HTMLCanvasElement): void {
    if (!this.pipeline?.isEnabled) {
      return;
    }
    const target = clamp(Math.round(render.qualitySamplesTarget), 1, 4096);
    if (this.progressCounter < target) {
      this.progressCounter += 1;
    }
  }

  getProgress(render: RenderSettings): QualityBackendProgress {
    if (!this.pipeline?.isEnabled) {
      return { currentSamples: 0, running: false };
    }
    const target = clamp(Math.round(render.qualitySamplesTarget), 1, 4096);
    return {
      currentSamples: this.progressCounter,
      running: this.progressCounter < target,
    };
  }

  isReadyForExport(render: RenderSettings): boolean {
    const target = clamp(Math.round(render.qualitySamplesTarget), 1, 4096);
    const progress = this.getProgress(render);
    return !progress.running && progress.currentSamples >= target;
  }

  getExportCanvas(): HTMLCanvasElement | null {
    return null;
  }

  resetAccumulation(): void {
    this.progressCounter = 0;
  }

  resetHistory(_reason?: string | null): void {
    if (!this.pipeline?.isEnabled) {
      return;
    }
    this.pipeline.isEnabled = false;
    this.pipeline.isEnabled = true;
  }

  dispose(): void {
    if (!this.pipeline) {
      return;
    }
    try {
      this.pipeline.dispose();
    } catch (error) {
      console.warn('TAA pipeline dispose failed (ignored)', error);
    } finally {
      this.pipeline = null;
      this.progressCounter = 0;
    }
  }
}

type ExperimentalQualityBackendMode = 'cpu_path' | 'hybrid_gpu_preview';

class PathQualityBackendV1 implements QualityBackend {
  private enabled = false;
  private sampleCount = 0;
  private accumCanvas: HTMLCanvasElement | null = null;
  private accumCtx: CanvasRenderingContext2D | null = null;
  private sampleCanvas: HTMLCanvasElement | null = null;
  private sampleCtx: CanvasRenderingContext2D | null = null;
  private accumLinear: Float32Array | null = null;
  private pixelSampleCounts: Uint16Array | null = null;
  private previewImageData: ImageData | null = null;
  private runtimeFailureReason: string | null = null;
  private runtimeFailureRetryAfterMs = 0;
  private runtimeFailureCount = 0;
  private blankCaptureFrameCount = 0;
  private captureInFlight = false;
  private captureGeneration = 0;
  private captureCamera: ArcRotateCamera | null = null;
  private tracePixelCursor = 0;
  private lastPreviewWriteMs = 0;
  private traceMeshCache: AbstractMesh[] = [];
  private traceMeshAccelEntries: TraceMeshAccelEntry[] = [];
  private traceMeshBvhRoot: TraceMeshBvhNode | null = null;
  private traceMeshCacheMeshCount = -1;
  private traceMeshCacheValidationRenderId = -1;
  private traceMeshCacheBuilt = false;
  private cpuPathWorker: Worker | null = null;
  private cpuPathWorkerOffloadDisabled = false;
  private cpuPathWorkerSceneDirty = true;
  private cpuPathWorkerSceneUnsupported = false;
  private cpuPathWorkerSceneUnsupportedReason: string | null = null;
  private cpuPathWorkerUnsupportedAnnouncementKey: string | null = null;
  private cpuPathWorkerGeometrySignature = '';
  private cpuPathWorkerMaterialSignature = '';
  private cpuPathWorkerLightSignature = '';
  private cpuPathWorkerSceneVersion = 0;
  private cpuPathWorkerReadySceneVersion = -1;
  private cpuPathWorkerInitPendingSceneVersion = -1;
  private cpuPathWorkerRequestIdSeq = 0;
  private cpuPathWorkerPendingBatch: CpuPathWorkerPendingBatch | null = null;
  private cpuPathWorkerBatchPixelScratch: Uint32Array | null = null;
  private cpuPathWorkerBatchRayScratch: Float32Array | null = null;
  private cpuPathPrimaryRayScratch: Ray | null = null;
  private cpuPathShadowRayScratch: Ray | null = null;
  private cpuPathShadowTransmittanceScratch: Vector3 | null = null;
  private cpuPathShadowOccluderTransmittanceScratch: Vector3 | null = null;
  private cpuPathEnvironmentSampleScratch: HybridEnvironmentSample | null = null;
  private cpuPathDirectLightingScratch: Vector3 | null = null;
  private cpuPathTraceThroughputScratch: Vector3 | null = null;
  private cpuPathTraceRadianceScratch: Vector3 | null = null;
  private cpuPathTraceOutwardNormalScratch: Vector3 | null = null;
  private cpuPathTraceShadingNormalScratch: Vector3 | null = null;
  private cpuPathTraceViewDirScratch: Vector3 | null = null;
  private cpuPathContinuationBounceSampleScratch: HybridBounceSample | null = null;
  private cpuPathContinuationIncidentScratch: Vector3 | null = null;
  private cpuPathContinuationInterfaceNormalScratch: Vector3 | null = null;
  private cpuPathContinuationTangentScratch: Vector3 | null = null;
  private cpuPathContinuationBitangentScratch: Vector3 | null = null;
  private cpuPathExecutionMode: string | null = null;
  private cpuPathAlignmentProbeStatus: string | null = null;
  private cpuPathAlignmentProbeCount = 0;
  private cpuPathAlignmentProbeHitMismatches = 0;
  private cpuPathAlignmentProbeMaxPointError = 0;
  private cpuPathAlignmentProbeMaxDistanceError = 0;
  private cpuPathWorkerBatchCount = 0;
  private cpuPathWorkerPixelCount = 0;
  private cpuPathWorkerBatchLatencyEmaMs = 0;
  private cpuPathWorkerBatchPixelsEma = 0;
  private cpuPathMainThreadBatchCount = 0;
  private cpuPathMainThreadPixelCount = 0;
  private cpuPathWorkerPixelsPerSecond = 0;
  private cpuPathMainThreadPixelsPerSecond = 0;
  private cpuPathThroughputSnapshotMs = 0;
  private cpuPathThroughputSnapshotWorkerPixels = 0;
  private cpuPathThroughputSnapshotMainThreadPixels = 0;
  private cpuPathAlignmentProbeLastRunMs = 0;
  private cpuPathAlignmentProbeForceNext = true;

  constructor(
    private readonly engine: WebGPUEngine,
    private readonly scene: Scene,
    private readonly camera: ArcRotateCamera,
    private readonly mode: ExperimentalQualityBackendMode = 'cpu_path',
    private readonly runtimeContext: QualityBackendRuntimeContext,
  ) {}

  private backendLabel(): string {
    return this.mode === 'cpu_path'
      ? 'Path quality backend'
      : 'Hybrid GPU preview quality backend';
  }

  private backendTraceFailureMessage(): string {
    return this.mode === 'cpu_path'
      ? 'Path quality backend hybrid trace failed'
      : 'Hybrid GPU preview quality backend raster accumulation failed';
  }

  configure(_render: RenderSettings): BackendConfigureResult {
    void this.captureAndAccumulate;
    if (this.runtimeFailureReason) {
      const now = nowMs();
      if (now >= this.runtimeFailureRetryAfterMs) {
        this.runtimeFailureReason = null;
      } else {
        const retryMs = Math.max(0, Math.round(this.runtimeFailureRetryAfterMs - now));
        return {
          enabled: false,
          enabledJustNow: false,
          unsupportedReason: `${this.runtimeFailureReason} (retrying in ${retryMs} ms)`,
        };
      }
    }
    if (this.runtimeFailureReason) {
      return {
        enabled: false,
        enabledJustNow: false,
        unsupportedReason: this.runtimeFailureReason,
      };
    }
    if (!this.accumCanvas) {
      if (typeof document === 'undefined') {
        return {
          enabled: false,
          enabledJustNow: false,
          unsupportedReason: `${this.backendLabel()} is unavailable in this environment`,
        };
      }
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) {
        return {
          enabled: false,
          enabledJustNow: false,
          unsupportedReason: `${this.backendLabel()} could not create a 2D accumulation buffer`,
        };
      }
      this.accumCanvas = canvas;
      this.accumCtx = ctx;
    }
    if (!this.sampleCanvas) {
      const sampleCanvas = document.createElement('canvas');
      const sampleCtx = sampleCanvas.getContext('2d', { alpha: true, willReadFrequently: true });
      if (!sampleCtx) {
        return {
          enabled: false,
          enabledJustNow: false,
          unsupportedReason: `${this.backendLabel()} could not create a sample decode buffer`,
        };
      }
      this.sampleCanvas = sampleCanvas;
      this.sampleCtx = sampleCtx;
    }
    this.captureCamera ??= this.createCaptureCamera();

    const enabledJustNow = !this.enabled;
    this.enabled = true;
    return {
      enabled: true,
      enabledJustNow,
      unsupportedReason: null,
    };
  }

  disable(): void {
    this.enabled = false;
    this.sampleCount = 0;
    this.blankCaptureFrameCount = 0;
    this.captureInFlight = false;
    this.captureGeneration += 1;
    this.runtimeFailureReason = null;
    this.runtimeFailureRetryAfterMs = 0;
    this.cpuPathWorkerPendingBatch = null;
    this.cpuPathWorkerBatchPixelScratch = null;
    this.cpuPathWorkerBatchRayScratch = null;
    this.cpuPathPrimaryRayScratch = null;
    this.cpuPathShadowRayScratch = null;
    this.cpuPathShadowTransmittanceScratch = null;
    this.cpuPathShadowOccluderTransmittanceScratch = null;
    this.cpuPathEnvironmentSampleScratch = null;
    this.cpuPathDirectLightingScratch = null;
    this.cpuPathTraceThroughputScratch = null;
    this.cpuPathTraceRadianceScratch = null;
    this.cpuPathTraceOutwardNormalScratch = null;
    this.cpuPathTraceShadingNormalScratch = null;
    this.cpuPathTraceViewDirScratch = null;
    this.cpuPathContinuationBounceSampleScratch = null;
    this.cpuPathContinuationIncidentScratch = null;
    this.cpuPathContinuationInterfaceNormalScratch = null;
    this.cpuPathContinuationTangentScratch = null;
    this.cpuPathContinuationBitangentScratch = null;
    this.captureInFlight = false;
    this.invalidateTraceMeshAcceleration();
    this.terminateCpuPathWorker();
    this.resetCpuPathInstrumentationState();
    this.publishCpuPathInstrumentationDiagnostics();
    this.clearAccumCanvas();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  tick(render: RenderSettings): QualityBackendTickResult {
    if (!this.enabled) {
      return {
        shouldRender: true,
        progress: { currentSamples: 0, running: false },
      };
    }
    const target = clamp(Math.round(render.qualitySamplesTarget), 1, 4096);
    const totalPixels = Math.max(1, this.accumCanvas?.width ?? 1) * Math.max(1, this.accumCanvas?.height ?? 1);
    const fractional = totalPixels > 0 ? this.tracePixelCursor / totalPixels : 0;
    const progressSamples = Math.min(target, this.sampleCount + fractional);
    const running = this.sampleCount < target || this.captureInFlight;
    return {
      shouldRender: this.sampleCount < target && !this.captureInFlight,
      progress: { currentSamples: progressSamples, running },
    };
  }

  onFrameRendered(render: RenderSettings, sourceCanvas: HTMLCanvasElement): void {
    if (!this.enabled) {
      return;
    }
    const target = clamp(Math.round(render.qualitySamplesTarget), 1, 4096);
    if (this.sampleCount >= target) {
      return;
    }
    const width = Math.max(
      1,
      Math.round(
        Number.isFinite(this.engine.getRenderWidth())
          ? this.engine.getRenderWidth()
          : sourceCanvas.width,
      ),
    );
    const height = Math.max(
      1,
      Math.round(
        Number.isFinite(this.engine.getRenderHeight())
          ? this.engine.getRenderHeight()
          : sourceCanvas.height,
      ),
    );
    if (this.mode === 'hybrid_gpu_preview') {
      const generation = this.captureGeneration;
      this.captureInFlight = true;
      void this.captureAndAccumulate(width, height, generation, render)
        .finally(() => {
          if (generation === this.captureGeneration) {
            this.captureInFlight = false;
          }
        });
      return;
    }

    let dispatchedWorkerBatch = false;
    try {
      if (this.mode === 'cpu_path') {
        dispatchedWorkerBatch = this.tryDispatchCpuPathWorkerBatch(render, width, height);
        if (dispatchedWorkerBatch) {
          return;
        }
        if (this.cpuPathWorkerSceneUnsupported) {
          this.setCpuPathExecutionMode('main_thread_scene_unsupported');
        } else if (
          this.cpuPathWorkerSceneVersion > 0
          && this.cpuPathWorkerInitPendingSceneVersion === this.cpuPathWorkerSceneVersion
          && this.cpuPathWorkerReadySceneVersion !== this.cpuPathWorkerSceneVersion
        ) {
          this.setCpuPathExecutionMode('main_thread_worker_scene_init_pending');
        } else if (this.cpuPathWorkerOffloadDisabled || typeof Worker === 'undefined' || typeof window === 'undefined') {
          this.setCpuPathExecutionMode('main_thread_worker_unavailable');
        } else {
          this.setCpuPathExecutionMode('main_thread_fallback');
        }
      }
      this.captureInFlight = true;
      this.traceHybridBatch(render, width, height);
      this.runtimeFailureCount = 0;
      this.runtimeFailureRetryAfterMs = 0;
    } catch (error) {
      this.enabled = false;
      this.sampleCount = 0;
      this.tracePixelCursor = 0;
      this.clearAccumCanvas();
      this.runtimeFailureReason = this.backendTraceFailureMessage();
      this.scheduleRuntimeRetry();
      console.warn(`${this.backendTraceFailureMessage()}; disabling backend`, error);
    } finally {
      if (!dispatchedWorkerBatch) {
        this.captureInFlight = false;
      }
    }
  }

  getProgress(render: RenderSettings): QualityBackendProgress {
    if (!this.enabled) {
      return { currentSamples: 0, running: false };
    }
    const target = clamp(Math.round(render.qualitySamplesTarget), 1, 4096);
    const totalPixels = Math.max(1, this.accumCanvas?.width ?? 1) * Math.max(1, this.accumCanvas?.height ?? 1);
    const fractional = totalPixels > 0 ? this.tracePixelCursor / totalPixels : 0;
    const running = this.sampleCount < target || this.captureInFlight;
    return {
      currentSamples: Math.min(target, this.sampleCount + fractional),
      running,
    };
  }

  isReadyForExport(render: RenderSettings): boolean {
    const target = clamp(Math.round(render.qualitySamplesTarget), 1, 4096);
    return this.enabled && this.sampleCount >= target && this.sampleCount > 0;
  }

  getExportCanvas(): HTMLCanvasElement | null {
    return this.sampleCount > 0 || this.tracePixelCursor > 0 ? this.accumCanvas : null;
  }

  resetAccumulation(): void {
    this.sampleCount = 0;
    this.blankCaptureFrameCount = 0;
    this.captureInFlight = false;
    this.captureGeneration += 1;
    this.tracePixelCursor = 0;
    this.lastPreviewWriteMs = 0;
    this.runtimeFailureReason = null;
    this.runtimeFailureRetryAfterMs = 0;
    this.cpuPathWorkerPendingBatch = null;
    this.cpuPathAlignmentProbeForceNext = true;
    this.clearAccumCanvas();
  }

  resetHistory(reason?: string | null): void {
    // Distinguish history reset reasons so resize / quality resolution changes don't
    // force path BVH and worker-scene invalidation. Those changes affect accumulation
    // buffers and ray generation, but not traceable geometry/material/light snapshots.
    const preserveTraceAcceleration =
      this.mode === 'cpu_path'
      && (reason === 'resize' || reason === 'resolution_scale_change');
    if (!preserveTraceAcceleration) {
      this.invalidateTraceMeshAcceleration();
    }
    this.cpuPathAlignmentProbeForceNext = true;
  }

  dispose(): void {
    this.enabled = false;
    this.sampleCount = 0;
    this.blankCaptureFrameCount = 0;
    this.captureInFlight = false;
    this.captureGeneration += 1;
    this.clearAccumCanvas();
    this.captureCamera?.dispose();
    this.captureCamera = null;
    this.sampleCtx = null;
    this.sampleCanvas = null;
    this.accumLinear = null;
    this.previewImageData = null;
    this.accumCtx = null;
    this.accumCanvas = null;
    this.runtimeFailureReason = null;
    this.runtimeFailureRetryAfterMs = 0;
    this.runtimeFailureCount = 0;
    this.tracePixelCursor = 0;
    this.lastPreviewWriteMs = 0;
    this.cpuPathWorkerPendingBatch = null;
    this.cpuPathWorkerBatchPixelScratch = null;
    this.cpuPathWorkerBatchRayScratch = null;
    this.cpuPathPrimaryRayScratch = null;
    this.cpuPathShadowRayScratch = null;
    this.cpuPathShadowTransmittanceScratch = null;
    this.cpuPathShadowOccluderTransmittanceScratch = null;
    this.cpuPathEnvironmentSampleScratch = null;
    this.cpuPathDirectLightingScratch = null;
    this.cpuPathTraceThroughputScratch = null;
    this.cpuPathTraceRadianceScratch = null;
    this.cpuPathTraceOutwardNormalScratch = null;
    this.cpuPathTraceShadingNormalScratch = null;
    this.cpuPathTraceViewDirScratch = null;
    this.cpuPathContinuationBounceSampleScratch = null;
    this.cpuPathContinuationIncidentScratch = null;
    this.cpuPathContinuationInterfaceNormalScratch = null;
    this.cpuPathContinuationTangentScratch = null;
    this.cpuPathContinuationBitangentScratch = null;
    this.invalidateTraceMeshAcceleration();
    this.terminateCpuPathWorker();
    this.resetCpuPathInstrumentationState();
    this.publishCpuPathInstrumentationDiagnostics();
  }

  private ensureAccumCanvasSize(width: number, height: number): void {
    if (!this.accumCanvas || !this.accumCtx || !this.sampleCanvas || !this.sampleCtx) return;
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const sameSize =
      this.accumCanvas.width === w
      && this.accumCanvas.height === h
      && this.sampleCanvas.width === w
      && this.sampleCanvas.height === h
      && this.accumLinear?.length === w * h * 4
      && this.pixelSampleCounts?.length === w * h
      && this.previewImageData?.width === w
      && this.previewImageData?.height === h;
    if (sameSize) {
      return;
    }
    this.accumCanvas.width = w;
    this.accumCanvas.height = h;
    this.sampleCanvas.width = w;
    this.sampleCanvas.height = h;
    this.accumLinear = new Float32Array(w * h * 4);
    this.pixelSampleCounts = new Uint16Array(w * h);
    this.previewImageData = this.accumCtx.createImageData(w, h);
    this.sampleCount = 0;
    this.blankCaptureFrameCount = 0;
    this.tracePixelCursor = 0;
    this.accumCtx.clearRect(0, 0, w, h);
  }

  private clearAccumCanvas(): void {
    if (!this.accumCanvas || !this.accumCtx) return;
    if (this.accumCanvas.width <= 0 || this.accumCanvas.height <= 0) return;
    this.accumLinear?.fill(0);
    this.pixelSampleCounts?.fill(0);
    this.previewImageData?.data.fill(0);
    this.tracePixelCursor = 0;
    this.accumCtx.clearRect(0, 0, this.accumCanvas.width, this.accumCanvas.height);
  }

  private terminateCpuPathWorker(): void {
    if (!this.cpuPathWorker) {
      this.cpuPathWorkerPendingBatch = null;
      this.cpuPathWorkerReadySceneVersion = -1;
      this.cpuPathWorkerInitPendingSceneVersion = -1;
      return;
    }
    try {
      const disposeReq: PathTraceWorkerRequest = { type: 'dispose' };
      this.cpuPathWorker.postMessage(disposeReq);
    } catch {
      // Ignore worker shutdown errors.
    }
    try {
      this.cpuPathWorker.terminate();
    } catch {
      // Ignore termination errors.
    }
    this.cpuPathWorker = null;
    this.cpuPathWorkerPendingBatch = null;
    this.cpuPathWorkerReadySceneVersion = -1;
    this.cpuPathWorkerInitPendingSceneVersion = -1;
  }

  private disableCpuPathWorkerOffload(reason: string, error?: unknown): void {
    if (!this.cpuPathWorkerOffloadDisabled) {
      console.warn(`CPU path worker offload disabled: ${reason}`, error);
    }
    this.cpuPathWorkerOffloadDisabled = true;
    this.setCpuPathExecutionMode('main_thread_worker_offload_disabled');
    this.captureInFlight = false;
    this.cpuPathWorkerPendingBatch = null;
    this.terminateCpuPathWorker();
  }

  private announceCpuPathWorkerFallback(reason: string): void {
    if (this.mode !== 'cpu_path') {
      return;
    }
    const key = `scene:${reason}`;
    if (this.cpuPathWorkerUnsupportedAnnouncementKey === key) {
      return;
    }
    this.cpuPathWorkerUnsupportedAnnouncementKey = key;
    const message = `Quality Path worker offload unavailable for current scene (${reason}); using main-thread CPU tracing`;
    console.info(message);
    try {
      this.runtimeContext.setStatusMessage(message);
    } catch {
      // Ignore status messaging errors; console diagnostics are sufficient fallback.
    }
  }

  private clearCpuPathWorkerFallbackAnnouncement(): void {
    this.cpuPathWorkerUnsupportedAnnouncementKey = null;
  }

  private resetCpuPathInstrumentationState(): void {
    if (this.mode !== 'cpu_path') {
      return;
    }
    this.cpuPathExecutionMode = null;
    this.cpuPathAlignmentProbeStatus = null;
    this.cpuPathAlignmentProbeCount = 0;
    this.cpuPathAlignmentProbeHitMismatches = 0;
    this.cpuPathAlignmentProbeMaxPointError = 0;
    this.cpuPathAlignmentProbeMaxDistanceError = 0;
    this.cpuPathWorkerBatchCount = 0;
    this.cpuPathWorkerPixelCount = 0;
    this.cpuPathWorkerBatchLatencyEmaMs = 0;
    this.cpuPathWorkerBatchPixelsEma = 0;
    this.cpuPathMainThreadBatchCount = 0;
    this.cpuPathMainThreadPixelCount = 0;
    this.cpuPathWorkerPixelsPerSecond = 0;
    this.cpuPathMainThreadPixelsPerSecond = 0;
    this.cpuPathThroughputSnapshotMs = 0;
    this.cpuPathThroughputSnapshotWorkerPixels = 0;
    this.cpuPathThroughputSnapshotMainThreadPixels = 0;
    this.cpuPathAlignmentProbeLastRunMs = 0;
    this.cpuPathAlignmentProbeForceNext = true;
  }

  private publishCpuPathInstrumentationDiagnostics(): void {
    if (this.mode !== 'cpu_path') {
      return;
    }
    try {
      this.runtimeContext.setRenderDiagnostics({
        qualityPathExecutionMode: this.cpuPathExecutionMode,
        qualityPathAlignmentStatus: this.cpuPathAlignmentProbeStatus,
        qualityPathAlignmentProbeCount: this.cpuPathAlignmentProbeCount,
        qualityPathAlignmentHitMismatches: this.cpuPathAlignmentProbeHitMismatches,
        qualityPathAlignmentMaxPointError: this.cpuPathAlignmentProbeMaxPointError,
        qualityPathAlignmentMaxDistanceError: this.cpuPathAlignmentProbeMaxDistanceError,
        qualityPathWorkerBatchCount: this.cpuPathWorkerBatchCount,
        qualityPathWorkerPixelCount: this.cpuPathWorkerPixelCount,
        qualityPathWorkerBatchLatencyMs: this.cpuPathWorkerBatchLatencyEmaMs,
        qualityPathWorkerBatchPixelsPerBatch: this.cpuPathWorkerBatchPixelsEma,
        qualityPathMainThreadBatchCount: this.cpuPathMainThreadBatchCount,
        qualityPathMainThreadPixelCount: this.cpuPathMainThreadPixelCount,
        qualityPathWorkerPixelsPerSecond: this.cpuPathWorkerPixelsPerSecond,
        qualityPathMainThreadPixelsPerSecond: this.cpuPathMainThreadPixelsPerSecond,
      });
    } catch {
      // Diagnostics are best-effort only.
    }
  }

  private setCpuPathExecutionMode(mode: string | null): void {
    if (this.mode !== 'cpu_path') {
      return;
    }
    if (this.cpuPathExecutionMode === mode) {
      return;
    }
    this.cpuPathExecutionMode = mode;
    this.publishCpuPathInstrumentationDiagnostics();
  }

  private updateCpuPathThroughputRates(now = nowMs()): void {
    if (this.mode !== 'cpu_path') {
      return;
    }
    if (!Number.isFinite(now) || now <= 0) {
      return;
    }
    if (this.cpuPathThroughputSnapshotMs <= 0) {
      this.cpuPathThroughputSnapshotMs = now;
      this.cpuPathThroughputSnapshotWorkerPixels = this.cpuPathWorkerPixelCount;
      this.cpuPathThroughputSnapshotMainThreadPixels = this.cpuPathMainThreadPixelCount;
      return;
    }
    const dtMs = now - this.cpuPathThroughputSnapshotMs;
    if (dtMs < 250) {
      return;
    }
    const dWorkerPixels = Math.max(0, this.cpuPathWorkerPixelCount - this.cpuPathThroughputSnapshotWorkerPixels);
    const dMainPixels = Math.max(0, this.cpuPathMainThreadPixelCount - this.cpuPathThroughputSnapshotMainThreadPixels);
    const invDt = dtMs > 0 ? (1000 / dtMs) : 0;
    this.cpuPathWorkerPixelsPerSecond = dWorkerPixels * invDt;
    this.cpuPathMainThreadPixelsPerSecond = dMainPixels * invDt;
    this.cpuPathThroughputSnapshotMs = now;
    this.cpuPathThroughputSnapshotWorkerPixels = this.cpuPathWorkerPixelCount;
    this.cpuPathThroughputSnapshotMainThreadPixels = this.cpuPathMainThreadPixelCount;
  }

  private updateCpuPathWorkerBatchTelemetry(completedPixels: number, batchLatencyMs: number): void {
    if (this.mode !== 'cpu_path') {
      return;
    }
    const pixels = Math.max(0, Math.floor(completedPixels));
    if (pixels <= 0) {
      return;
    }
    const alpha = 0.2;
    if (Number.isFinite(batchLatencyMs) && batchLatencyMs > 0) {
      const latencyMs = clamp(batchLatencyMs, 0, 60000);
      this.cpuPathWorkerBatchLatencyEmaMs = this.cpuPathWorkerBatchLatencyEmaMs > 0
        ? (this.cpuPathWorkerBatchLatencyEmaMs * (1 - alpha) + latencyMs * alpha)
        : latencyMs;
    }
    this.cpuPathWorkerBatchPixelsEma = this.cpuPathWorkerBatchPixelsEma > 0
      ? (this.cpuPathWorkerBatchPixelsEma * (1 - alpha) + pixels * alpha)
      : pixels;
  }

  private refreshCpuPathWorkerSceneSignatures(): void {
    if (this.mode !== 'cpu_path') {
      return;
    }
    this.getTraceableMeshesForCurrentFrame();

    const geometryParts: string[] = [];
    const materialParts: string[] = [];
    const lightParts: string[] = [];
    let otherUnsupportedMeshCount = 0;

    for (const entry of this.traceMeshAccelEntries) {
      const mesh = entry.mesh;
      const className = safeMeshClassName(mesh);
      const isLineMesh = mesh instanceof LinesMesh;
      if (isLineMesh) {
        if (!entry.lineAccel) {
          otherUnsupportedMeshCount += 1;
        }
      } else if (!entry.triangleAccel) {
        otherUnsupportedMeshCount += 1;
      }

      const indicesLength = mesh instanceof Mesh ? (mesh.getIndices()?.length ?? 0) : 0;
      const positionLength = mesh instanceof Mesh ? (mesh.getVerticesData('position')?.length ?? 0) : 0;
      geometryParts.push([
        mesh.uniqueId,
        className,
        entry.triangleAccel?.triangleCount ?? 0,
        entry.lineAccel?.segmentCount ?? 0,
        sigNum(entry.lineAccel?.intersectionThreshold ?? 0),
        indicesLength,
        positionLength,
        ...Array.from(entry.worldMatrixElements, (value) => sigNum(value)),
        sigNum(entry.minX),
        sigNum(entry.minY),
        sigNum(entry.minZ),
        sigNum(entry.maxX),
        sigNum(entry.maxY),
        sigNum(entry.maxZ),
      ].join(','));

      const material = entry.hybridMaterial;
      materialParts.push([
        mesh.uniqueId,
        sigNum(material.baseColor.x),
        sigNum(material.baseColor.y),
        sigNum(material.baseColor.z),
        sigNum(material.metallic),
        sigNum(material.roughness),
        sigNum(material.reflectance),
        sigNum(material.ior),
        sigNum(material.opacity),
      ].join(','));
    }

    for (const light of this.scene.lights) {
      if (!light.isEnabled() || light.intensity <= 0) {
        continue;
      }
      if (light instanceof HemisphericLight) {
        const diffuse = light.diffuse ?? Color3.White();
        const ground = light.groundColor ?? Color3.Black();
        lightParts.push([
          'hemi',
          light.uniqueId,
          sigNum(light.direction.x),
          sigNum(light.direction.y),
          sigNum(light.direction.z),
          sigNum(diffuse.r),
          sigNum(diffuse.g),
          sigNum(diffuse.b),
          sigNum(ground.r),
          sigNum(ground.g),
          sigNum(ground.b),
          sigNum(light.intensity),
        ].join(','));
        continue;
      }
      if (light instanceof DirectionalLight) {
        const diffuse = light.diffuse ?? Color3.White();
        lightParts.push([
          'dir',
          light.uniqueId,
          sigNum(light.direction.x),
          sigNum(light.direction.y),
          sigNum(light.direction.z),
          sigNum(diffuse.r),
          sigNum(diffuse.g),
          sigNum(diffuse.b),
          sigNum(light.intensity),
        ].join(','));
        continue;
      }
      if (light instanceof PointLight) {
        const diffuse = light.diffuse ?? Color3.White();
        const resolvedRange = Number.isFinite(light.range) && light.range > 0
          ? light.range
          : Math.max(1, this.camera.radius * 2);
        lightParts.push([
          'point',
          light.uniqueId,
          sigNum(light.position.x),
          sigNum(light.position.y),
          sigNum(light.position.z),
          sigNum(diffuse.r),
          sigNum(diffuse.g),
          sigNum(diffuse.b),
          sigNum(light.intensity),
          sigNum(resolvedRange),
        ].join(','));
      }
    }

    // Environment/ambient affect worker path shading and are tracked alongside lights.
    const clear = this.scene.clearColor;
    const ambient = this.scene.ambientColor;
    lightParts.push([
      'env',
      sigNum(Number.isFinite(clear?.r) ? clear.r : 0),
      sigNum(Number.isFinite(clear?.g) ? clear.g : 0),
      sigNum(Number.isFinite(clear?.b) ? clear.b : 0),
      sigNum(Number.isFinite(ambient?.r) ? ambient.r : 0),
      sigNum(Number.isFinite(ambient?.g) ? ambient.g : 0),
      sigNum(Number.isFinite(ambient?.b) ? ambient.b : 0),
    ].join(','));

    const geometrySignature = geometryParts.join('|');
    const materialSignature = materialParts.join('|');
    const lightSignature = lightParts.join('|');
    const signaturesChanged =
      geometrySignature !== this.cpuPathWorkerGeometrySignature
      || materialSignature !== this.cpuPathWorkerMaterialSignature
      || lightSignature !== this.cpuPathWorkerLightSignature;
    if (signaturesChanged) {
      this.cpuPathWorkerGeometrySignature = geometrySignature;
      this.cpuPathWorkerMaterialSignature = materialSignature;
      this.cpuPathWorkerLightSignature = lightSignature;
      this.cpuPathWorkerSceneDirty = true;
    }

    let unsupportedReason: string | null = null;
    if (otherUnsupportedMeshCount > 0) {
      unsupportedReason = otherUnsupportedMeshCount === 1
        ? 'scene contains 1 unsupported trace mesh for worker offload (falling back to main-thread CPU path tracing)'
        : `scene contains ${otherUnsupportedMeshCount} unsupported trace meshes for worker offload (falling back to main-thread CPU path tracing)`;
    }

    this.cpuPathWorkerSceneUnsupportedReason = unsupportedReason;
    this.cpuPathWorkerSceneUnsupported = unsupportedReason !== null;
    if (unsupportedReason) {
      this.announceCpuPathWorkerFallback(unsupportedReason);
    } else {
      this.clearCpuPathWorkerFallbackAnnouncement();
    }
  }

  private ensureCpuPathWorker(): Worker | null {
    if (this.mode !== 'cpu_path' || this.cpuPathWorkerOffloadDisabled) {
      return null;
    }
    if (typeof Worker === 'undefined' || typeof window === 'undefined') {
      return null;
    }
    if (this.cpuPathWorker) {
      return this.cpuPathWorker;
    }
    try {
      const worker = new Worker(new URL('../workers/pathTraceQualityWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<PathTraceWorkerResponse>) => {
        this.handleCpuPathWorkerMessage(event.data);
      };
      worker.onerror = (event) => {
        this.disableCpuPathWorkerOffload(`worker runtime error: ${event.message || 'unknown error'}`);
      };
      worker.onmessageerror = () => {
        this.disableCpuPathWorkerOffload('worker message deserialization error');
      };
      this.cpuPathWorker = worker;
      this.cpuPathWorkerSceneDirty = true;
      this.cpuPathWorkerSceneUnsupported = false;
      this.cpuPathWorkerSceneUnsupportedReason = null;
      return worker;
    } catch (error) {
      this.disableCpuPathWorkerOffload('worker initialization failed', error);
      return null;
    }
  }

  private handleCpuPathWorkerMessage(message: PathTraceWorkerResponse): void {
    if (message.type === 'scene_ready') {
      if (message.sceneVersion === this.cpuPathWorkerSceneVersion) {
        this.cpuPathWorkerReadySceneVersion = message.sceneVersion;
        this.cpuPathWorkerInitPendingSceneVersion = -1;
      }
      return;
    }
    if (message.type === 'scene_error') {
      if (message.sceneVersion === this.cpuPathWorkerSceneVersion) {
        this.disableCpuPathWorkerOffload(`scene init failed: ${message.message}`);
      }
      return;
    }
    if (message.type === 'trace_batch_error') {
      const pending = this.cpuPathWorkerPendingBatch;
      if (!pending || pending.requestId !== message.requestId) {
        return;
      }
      this.cpuPathWorkerPendingBatch = null;
      this.captureInFlight = false;
      this.disableCpuPathWorkerOffload(`trace batch failed: ${message.message}`);
      return;
    }
    if (message.type === 'trace_batch_result') {
      const pending = this.cpuPathWorkerPendingBatch;
      if (!pending || pending.requestId !== message.requestId || pending.sceneVersion !== message.sceneVersion) {
        return;
      }
      this.cpuPathWorkerPendingBatch = null;
      this.captureInFlight = false;
      if (!this.enabled || pending.generation !== this.captureGeneration || this.mode !== 'cpu_path') {
        return;
      }
      const batchLatencyMs = pending.dispatchedAtMs > 0 ? (nowMs() - pending.dispatchedAtMs) : 0;
      this.updateCpuPathWorkerBatchTelemetry(pending.pixelIndices.length, batchLatencyMs);
      const expectedLength = pending.pixelIndices.length * 4;
      if (message.samples.length !== expectedLength) {
        this.disableCpuPathWorkerOffload(
          `trace batch result length mismatch (${message.samples.length} vs ${expectedLength})`,
        );
        return;
      }
      for (let i = 0; i < pending.pixelIndices.length; i += 1) {
        const base = i * 4;
        this.accumulateHybridPixelSampleValues(
          pending.pixelIndices[i],
          message.samples[base],
          message.samples[base + 1],
          message.samples[base + 2],
          message.samples[base + 3],
          pending.renderSnapshot,
        );
      }
      this.cpuPathWorkerBatchCount += 1;
      this.cpuPathWorkerPixelCount += pending.pixelIndices.length;
      this.updateCpuPathThroughputRates();
      this.publishCpuPathInstrumentationDiagnostics();

      this.tracePixelCursor = pending.nextTracePixelCursor;
      let sampleFinished = false;
      if (this.tracePixelCursor >= pending.totalPixels) {
        this.tracePixelCursor = 0;
        this.sampleCount = Math.min(pending.targetSamples, this.sampleCount + 1);
        sampleFinished = true;
      }
      const now = nowMs();
      if (sampleFinished || now - this.lastPreviewWriteMs >= 33) {
        this.writeFloatAccumulationPreview(Math.max(1, this.sampleCount));
        this.lastPreviewWriteMs = now;
      }
      this.runtimeFailureCount = 0;
      this.runtimeFailureRetryAfterMs = 0;
    }
  }

  private tryDispatchCpuPathWorkerBatch(
    render: RenderSettings,
    width: number,
    height: number,
  ): boolean {
    if (this.mode !== 'cpu_path' || this.cpuPathWorkerOffloadDisabled || this.cpuPathWorkerPendingBatch) {
      return false;
    }
    const worker = this.ensureCpuPathWorker();
    if (!worker) {
      return false;
    }
    if (!this.ensureCpuPathWorkerScene(worker)) {
      return false;
    }
    if (this.cpuPathWorkerReadySceneVersion !== this.cpuPathWorkerSceneVersion) {
      return false;
    }

    const batch = this.buildCpuPathWorkerBatch(render, width, height);
    if (!batch) {
      return false;
    }

    try {
      batch.pending.dispatchedAtMs = nowMs();
      const request: PathTraceWorkerRequest = {
        type: 'trace_batch',
        requestId: batch.pending.requestId,
        sceneVersion: batch.pending.sceneVersion,
        sampleIndex: batch.sampleIndex,
        render: batch.renderParams,
        pixelIndices: batch.pending.pixelIndices,
        rays: batch.rays,
      };
      worker.postMessage(request, { transfer: [batch.rays.buffer] });
      this.cpuPathWorkerPendingBatch = batch.pending;
      this.captureInFlight = true;
      this.setCpuPathExecutionMode('worker');
      return true;
    } catch (error) {
      this.disableCpuPathWorkerOffload('trace batch dispatch failed', error);
      return false;
    }
  }

  private ensureCpuPathWorkerScene(worker: Worker): boolean {
    this.refreshCpuPathWorkerSceneSignatures();
    if (this.cpuPathWorkerSceneUnsupported) {
      this.setCpuPathExecutionMode('main_thread_scene_unsupported');
      this.cpuPathWorkerSceneDirty = false;
      return false;
    }
    if (
      !this.cpuPathWorkerSceneDirty
      && this.cpuPathWorkerSceneVersion > 0
      && this.cpuPathWorkerReadySceneVersion === this.cpuPathWorkerSceneVersion
    ) {
      return true;
    }
    if (
      !this.cpuPathWorkerSceneDirty
      && this.cpuPathWorkerSceneVersion > 0
      && this.cpuPathWorkerInitPendingSceneVersion === this.cpuPathWorkerSceneVersion
    ) {
      this.setCpuPathExecutionMode('main_thread_worker_scene_init_pending');
      return false;
    }

    const nextVersion = this.cpuPathWorkerSceneVersion + 1;
    const snapshot = this.buildCpuPathWorkerSceneSnapshot(nextVersion);
    if (!snapshot) {
      this.cpuPathWorkerSceneUnsupported = true;
      this.cpuPathWorkerSceneUnsupportedReason ??= 'scene snapshot could not be serialized for worker offload';
      this.announceCpuPathWorkerFallback(this.cpuPathWorkerSceneUnsupportedReason);
      this.setCpuPathExecutionMode('main_thread_scene_unsupported');
      this.cpuPathWorkerSceneDirty = false;
      return false;
    }

    try {
      const req: PathTraceWorkerRequest = {
        type: 'init_scene',
        scene: snapshot,
      };
      worker.postMessage(req);
      this.cpuPathWorkerSceneVersion = nextVersion;
      this.cpuPathWorkerReadySceneVersion = -1;
      this.cpuPathWorkerInitPendingSceneVersion = nextVersion;
      this.cpuPathWorkerSceneDirty = false;
      this.cpuPathWorkerSceneUnsupported = false;
      this.cpuPathWorkerSceneUnsupportedReason = null;
      return false;
    } catch (error) {
      this.disableCpuPathWorkerOffload('scene snapshot dispatch failed', error);
      return false;
    }
  }

  private buildCpuPathWorkerSceneSnapshot(version: number): PathTraceWorkerSceneSnapshot | null {
    this.getTraceableMeshesForCurrentFrame();
    const meshes = this.traceMeshAccelEntries;
    const meshSnapshots: PathTraceWorkerSceneSnapshot['meshes'] = [];
    for (let i = 0; i < meshes.length; i += 1) {
      const entry = meshes[i];
      const triangleAccel = entry.triangleAccel;
      const lineAccel = entry.lineAccel;
      if (
        (!triangleAccel || !triangleAccel.positionsWorld || triangleAccel.triangleCount <= 0)
        && (!lineAccel || !lineAccel.positionsWorld || lineAccel.segmentCount <= 0)
      ) {
        return null;
      }
      const material = entry.hybridMaterial;
      const workerMaterial: PathTraceWorkerMaterial = {
        baseColor: vector3ToWorkerVec3(material.baseColor),
        metallic: material.metallic,
        roughness: material.roughness,
        reflectance: material.reflectance,
        ior: material.ior,
        opacity: material.opacity,
      };
      const workerTriangleAccel: WorkerTraceTriangleAccel | null = triangleAccel
        ? {
            positionsWorld: triangleAccel.positionsWorld,
            normalsWorld: triangleAccel.normalsWorld ?? null,
            triangleCount: triangleAccel.triangleCount,
            triangleBvhRoot: (triangleAccel.triangleBvhRoot as PathTraceWorkerTriangleBvhNode | null) ?? null,
          }
        : null;
      const workerLineAccel: PathTraceWorkerLineAccel | null = lineAccel
        ? {
            positionsWorld: lineAccel.positionsWorld,
            segmentCount: lineAccel.segmentCount,
            intersectionThreshold: lineAccel.intersectionThreshold,
          }
        : null;
      meshSnapshots.push({
        meshIndex: i,
        minX: entry.minX,
        minY: entry.minY,
        minZ: entry.minZ,
        maxX: entry.maxX,
        maxY: entry.maxY,
        maxZ: entry.maxZ,
        centerX: entry.centerX,
        centerY: entry.centerY,
        centerZ: entry.centerZ,
        material: workerMaterial,
        triangleAccel: workerTriangleAccel,
        lineAccel: workerLineAccel,
      });
    }

    const lightSnapshots: PathTraceWorkerLight[] = [];
    for (const light of this.scene.lights) {
      if (!light.isEnabled() || light.intensity <= 0) {
        continue;
      }
      if (light instanceof HemisphericLight) {
        lightSnapshots.push({
          kind: 'hemispheric',
          direction: vector3ToWorkerVec3(light.direction),
          diffuse: vector3ToWorkerVec3(color3ToVector(light.diffuse ?? Color3.White())),
          ground: vector3ToWorkerVec3(color3ToVector(light.groundColor ?? Color3.Black())),
          intensity: light.intensity,
        });
        continue;
      }
      if (light instanceof DirectionalLight) {
        lightSnapshots.push({
          kind: 'directional',
          direction: vector3ToWorkerVec3(light.direction),
          diffuse: vector3ToWorkerVec3(color3ToVector(light.diffuse ?? Color3.White())),
          intensity: light.intensity,
        });
        continue;
      }
      if (light instanceof PointLight) {
        const resolvedRange = Number.isFinite(light.range) && light.range > 0
          ? light.range
          : Math.max(1, this.camera.radius * 2);
        lightSnapshots.push({
          kind: 'point',
          position: vector3ToWorkerVec3(light.position),
          diffuse: vector3ToWorkerVec3(color3ToVector(light.diffuse ?? Color3.White())),
          intensity: light.intensity,
          range: resolvedRange,
        });
      }
    }

    const clear = this.scene.clearColor;
    const ambient = this.scene.ambientColor;
    return {
      version,
      clearColor: {
        x: Number.isFinite(clear?.r) ? clear.r : 0,
        y: Number.isFinite(clear?.g) ? clear.g : 0,
        z: Number.isFinite(clear?.b) ? clear.b : 0,
      },
      ambientColor: {
        x: Number.isFinite(ambient?.r) ? ambient.r : 0,
        y: Number.isFinite(ambient?.g) ? ambient.g : 0,
        z: Number.isFinite(ambient?.b) ? ambient.b : 0,
      },
      meshes: meshSnapshots,
      lights: lightSnapshots,
    };
  }

  private buildCpuPathWorkerBatch(
    render: RenderSettings,
    width: number,
    height: number,
  ): {
    rays: Float32Array;
    sampleIndex: number;
    renderParams: PathTraceWorkerRenderParams;
    pending: CpuPathWorkerPendingBatch;
  } | null {
    this.ensureAccumCanvasSize(width, height);
    if (
      !this.accumCanvas
      || !this.accumLinear
      || !this.pixelSampleCounts
      || !this.previewImageData
      || !this.accumCtx
    ) {
      return null;
    }

    const captureCamera = this.captureCamera ?? this.createCaptureCamera();
    this.captureCamera = captureCamera;
    this.copyLiveCameraToCaptureCamera(captureCamera);

    const w = this.accumCanvas.width;
    const h = this.accumCanvas.height;
    const tracePixelContext = this.buildHybridTracePixelContext(captureCamera, w, h);
    this.maybeRunCpuPathAlignmentProbe(captureCamera, tracePixelContext, w, h);
    const totalPixels = Math.max(1, w * h);
    const targetSamples = clamp(Math.round(render.qualitySamplesTarget), 1, 4096);
    const sampleIndex = this.sampleCount + 1;
    const traceOrder = buildTracePixelPermutation(totalPixels, sampleIndex);
    const frameBudgetMs = this.sampleCount === 0 ? 8 : 5;
    const hardMaxPixels = clamp(Math.round(totalPixels / 64), 256, 4096);
    const minPixelsBeforeBudgetCheck = 16;
    const batchStartMs = nowMs();

    const { pixelIndices, rays } = this.ensureCpuPathWorkerBatchScratch(hardMaxPixels);
    let localCursor = this.tracePixelCursor;
    let tracedPixels = 0;

    for (; localCursor < totalPixels; localCursor += 1) {
      const pixelIndex = permuteTracePixelIndex(localCursor, totalPixels, traceOrder.stride, traceOrder.offset);
      const x = pixelIndex % w;
      const y = Math.floor(pixelIndex / w);
      const ray = this.buildHybridPrimaryRay(captureCamera, x, y, w, sampleIndex, tracePixelContext);
      const rayBase = tracedPixels * 6;
      pixelIndices[tracedPixels] = pixelIndex;
      rays[rayBase] = ray.origin.x;
      rays[rayBase + 1] = ray.origin.y;
      rays[rayBase + 2] = ray.origin.z;
      rays[rayBase + 3] = ray.direction.x;
      rays[rayBase + 4] = ray.direction.y;
      rays[rayBase + 5] = ray.direction.z;
      tracedPixels += 1;

      if (tracedPixels >= hardMaxPixels) {
        break;
      }
      if (
        tracedPixels >= minPixelsBeforeBudgetCheck
        && (tracedPixels & 7) === 0
        && (nowMs() - batchStartMs) >= frameBudgetMs
      ) {
        break;
      }
    }

    if (tracedPixels <= 0) {
      return null;
    }

    // Always copy the populated ray subset into a dedicated transfer buffer because the
    // worker transfer detaches the underlying ArrayBuffer. This keeps our scratch buffers
    // reusable across batches and avoids one extra large allocation for the fill path.
    const rayBuffer = rays.slice(0, tracedPixels * 6);
    const pixelIndexBuffer = pixelIndices.subarray(0, tracedPixels);
    const requestId = ++this.cpuPathWorkerRequestIdSeq;
    const pending: CpuPathWorkerPendingBatch = {
      requestId,
      sceneVersion: this.cpuPathWorkerSceneVersion,
      generation: this.captureGeneration,
      dispatchedAtMs: 0,
      pixelIndices: pixelIndexBuffer,
      nextTracePixelCursor: localCursor,
      totalPixels,
      targetSamples,
      renderSnapshot: { ...render },
    };
    return {
      rays: rayBuffer,
      sampleIndex,
      renderParams: {
        qualityMaxBounces: render.qualityMaxBounces,
      },
      pending,
    };
  }

  private buildHybridPrimaryRay(
    captureCamera: ArcRotateCamera,
    x: number,
    y: number,
    width: number,
    sampleIndex: number,
    tracePixelContext: HybridTracePixelContext,
  ): Ray {
    const pixelIndex = y * width + x;
    const jx = sampleHash01(pixelIndex, sampleIndex, 0) - 0.5;
    const jy = sampleHash01(pixelIndex, sampleIndex, 1) - 0.5;
    const localX = (x + 0.5 + jx) * tracePixelContext.pixelScaleX;
    const localY = (y + 0.5 + jy) * tracePixelContext.pixelScaleY;
    const ray = this.cpuPathPrimaryRayScratch
      ?? (this.cpuPathPrimaryRayScratch = new Ray(new Vector3(0, 0, 0), new Vector3(0, 0, 1), 1e6));
    this.scene.createPickingRayToRef(
      (localX + tracePixelContext.viewportX) * tracePixelContext.hardwareScale,
      (localY + tracePixelContext.viewportY) * tracePixelContext.hardwareScale,
      PATH_PICK_WORLD_MATRIX,
      ray,
      captureCamera,
    );
    ray.length = 1e6;
    return ray;
  }

  private traceHybridBatch(render: RenderSettings, width: number, height: number): void {
    this.ensureAccumCanvasSize(width, height);
    if (
      !this.accumCanvas
      || !this.accumLinear
      || !this.pixelSampleCounts
      || !this.previewImageData
      || !this.accumCtx
    ) {
      return;
    }

    const captureCamera = this.captureCamera ?? this.createCaptureCamera();
    this.captureCamera = captureCamera;
    this.copyLiveCameraToCaptureCamera(captureCamera);

    const w = this.accumCanvas.width;
    const h = this.accumCanvas.height;
    const tracePixelContext = this.buildHybridTracePixelContext(captureCamera, w, h);
    this.maybeRunCpuPathAlignmentProbe(captureCamera, tracePixelContext, w, h);
    const totalPixels = Math.max(1, w * h);
    const targetSamples = clamp(Math.round(render.qualitySamplesTarget), 1, 4096);
    const sampleIndex = this.sampleCount + 1;
    const traceOrder = buildTracePixelPermutation(totalPixels, sampleIndex);
    const frameBudgetMs = this.sampleCount === 0 ? 18 : 12;
    const hardMaxPixels = clamp(Math.round(totalPixels / 64), 256, 4096);
    const minPixelsBeforeBudgetCheck = 16;
    const batchStartMs = nowMs();
    let tracedPixels = 0;

    for (; this.tracePixelCursor < totalPixels; this.tracePixelCursor += 1) {
      const pixelIndex = permuteTracePixelIndex(this.tracePixelCursor, totalPixels, traceOrder.stride, traceOrder.offset);
      const x = pixelIndex % w;
      const y = Math.floor(pixelIndex / w);
      const sample = this.traceHybridPixel(captureCamera, x, y, w, render, sampleIndex, tracePixelContext);
      this.accumulateHybridPixelSample(pixelIndex, sample, render);
      tracedPixels += 1;
      if (tracedPixels >= hardMaxPixels) {
        break;
      }
      if (
        tracedPixels >= minPixelsBeforeBudgetCheck
        && (tracedPixels & 7) === 0
        && (nowMs() - batchStartMs) >= frameBudgetMs
      ) {
        break;
      }
    }
    if (this.mode === 'cpu_path' && tracedPixels > 0) {
      this.cpuPathMainThreadBatchCount += 1;
      this.cpuPathMainThreadPixelCount += tracedPixels;
      this.updateCpuPathThroughputRates();
      this.publishCpuPathInstrumentationDiagnostics();
    }

    let sampleFinished = false;
    if (this.tracePixelCursor >= totalPixels) {
      this.tracePixelCursor = 0;
      this.sampleCount = Math.min(targetSamples, this.sampleCount + 1);
      sampleFinished = true;
    }

    const now = nowMs();
    if (sampleFinished || now - this.lastPreviewWriteMs >= 33) {
      this.writeFloatAccumulationPreview(Math.max(1, this.sampleCount));
      this.lastPreviewWriteMs = now;
    }
  }

  private traceHybridPixel(
    captureCamera: ArcRotateCamera,
    x: number,
    y: number,
    width: number,
    render: RenderSettings,
    sampleIndex: number,
    tracePixelContext: HybridTracePixelContext,
  ): HybridPixelSample {
    const pixelIndex = y * width + x;
    const ray = this.buildHybridPrimaryRay(captureCamera, x, y, width, sampleIndex, tracePixelContext);
    return this.traceHybridRay(ray, render, sampleIndex, pixelIndex);
  }

  private buildHybridTracePixelContext(
    captureCamera: ArcRotateCamera,
    width: number,
    height: number,
  ): HybridTracePixelContext {
    const engineRenderWidth = Math.max(1, this.engine.getRenderWidth());
    const engineRenderHeight = Math.max(1, this.engine.getRenderHeight());
    const viewportGlobal = captureCamera.viewport.toGlobal(engineRenderWidth, engineRenderHeight);
    const viewportWidth = Math.max(1, viewportGlobal.width);
    const viewportHeight = Math.max(1, viewportGlobal.height);
    return {
      viewportX: viewportGlobal.x,
      viewportY: engineRenderHeight - viewportGlobal.y - viewportHeight,
      pixelScaleX: viewportWidth / Math.max(1, width),
      pixelScaleY: viewportHeight / Math.max(1, height),
      hardwareScale: Math.max(1e-4, this.engine.getHardwareScalingLevel()),
    };
  }

  private tracePixelCenterToScreenCoords(
    x: number,
    y: number,
    tracePixelContext: HybridTracePixelContext,
  ): { screenX: number; screenY: number } {
    const localX = (x + 0.5) * tracePixelContext.pixelScaleX;
    const localY = (y + 0.5) * tracePixelContext.pixelScaleY;
    return {
      screenX: (localX + tracePixelContext.viewportX) * tracePixelContext.hardwareScale,
      screenY: (localY + tracePixelContext.viewportY) * tracePixelContext.hardwareScale,
    };
  }

  private maybeRunCpuPathAlignmentProbe(
    captureCamera: ArcRotateCamera,
    tracePixelContext: HybridTracePixelContext,
    width: number,
    height: number,
  ): void {
    if (this.mode !== 'cpu_path' || !this.enabled) {
      return;
    }
    const now = nowMs();
    const minIntervalMs = 1000;
    if (!this.cpuPathAlignmentProbeForceNext && now - this.cpuPathAlignmentProbeLastRunMs < minIntervalMs) {
      return;
    }
    this.cpuPathAlignmentProbeForceNext = false;
    this.cpuPathAlignmentProbeLastRunMs = now;

    try {
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));
      const probePoints = buildAlignmentProbePixels(w, h);
      let hitMismatches = 0;
      let maxPointError = 0;
      let maxDistanceError = 0;
      let validPointComparisons = 0;
      const rayPredicate = (mesh: AbstractMesh) => this.isTraceRenderableMesh(mesh, null);

      for (const point of probePoints) {
        const { screenX, screenY } = this.tracePixelCenterToScreenCoords(point.x, point.y, tracePixelContext);
        const ray = this.scene.createPickingRay(screenX, screenY, PATH_PICK_WORLD_MATRIX, captureCamera);
        const custom = this.pickTraceRayClosest(ray, null);
        const babylon = this.scene.pick(screenX, screenY, rayPredicate, false, captureCamera);

        const babylonHit = Boolean(
          babylon?.hit
          && typeof babylon.distance === 'number'
          && Number.isFinite(babylon.distance)
          && babylon.distance >= 0,
        );
        const customHit = Boolean(custom?.hit && Number.isFinite(custom.distance) && custom.distance >= 0);

        if (babylonHit !== customHit) {
          hitMismatches += 1;
          continue;
        }
        if (!babylonHit || !custom) {
          continue;
        }

        const babylonPoint = babylon?.pickedPoint
          ?? ray.origin.add(ray.direction.scale(Math.max(0, babylon?.distance ?? 0)));
        const pointError = Vector3.Distance(custom.pickedPoint, babylonPoint);
        const distanceError = Math.abs(custom.distance - (babylon?.distance ?? custom.distance));
        if (Number.isFinite(pointError)) {
          maxPointError = Math.max(maxPointError, pointError);
        }
        if (Number.isFinite(distanceError)) {
          maxDistanceError = Math.max(maxDistanceError, distanceError);
        }
        validPointComparisons += 1;
      }

      const radiusScale = Number.isFinite(this.camera.radius) ? Math.max(0.1, this.camera.radius) : 10;
      const warnPointThreshold = Math.max(0.003, radiusScale * 0.003);
      const errorPointThreshold = Math.max(0.02, radiusScale * 0.02);
      const warnDistanceThreshold = Math.max(0.003, radiusScale * 0.002);
      const errorDistanceThreshold = Math.max(0.03, radiusScale * 0.015);

      let status = 'ok';
      if (
        hitMismatches > 0
        || maxPointError > errorPointThreshold
        || maxDistanceError > errorDistanceThreshold
      ) {
        status = 'error';
      } else if (
        maxPointError > warnPointThreshold
        || maxDistanceError > warnDistanceThreshold
      ) {
        status = 'warning';
      }

      this.cpuPathAlignmentProbeStatus = status;
      this.cpuPathAlignmentProbeCount += 1;
      this.cpuPathAlignmentProbeHitMismatches += hitMismatches;
      this.cpuPathAlignmentProbeMaxPointError = Math.max(this.cpuPathAlignmentProbeMaxPointError, maxPointError);
      this.cpuPathAlignmentProbeMaxDistanceError = Math.max(this.cpuPathAlignmentProbeMaxDistanceError, maxDistanceError);
      this.publishCpuPathInstrumentationDiagnostics();

      if (status === 'error') {
        console.warn(
          'Quality path alignment probe reported mismatch',
          {
            probeCount: this.cpuPathAlignmentProbeCount,
            points: probePoints.length,
            validPointComparisons,
            hitMismatches,
            maxPointError,
            maxDistanceError,
            qualityResolutionScale: this.runtimeContext.getSnapshot()?.render.qualityResolutionScale ?? 1,
            hardwareScale: tracePixelContext.hardwareScale,
            viewportX: tracePixelContext.viewportX,
            viewportY: tracePixelContext.viewportY,
            pixelScaleX: tracePixelContext.pixelScaleX,
            pixelScaleY: tracePixelContext.pixelScaleY,
          },
        );
      }
    } catch (error) {
      this.cpuPathAlignmentProbeStatus = 'probe_error';
      this.cpuPathAlignmentProbeCount += 1;
      this.publishCpuPathInstrumentationDiagnostics();
      console.warn('Quality path alignment probe failed', error);
    }
  }

  private traceHybridRay(
    initialRay: Ray,
    render: RenderSettings,
    sampleIndex: number,
    pixelIndex: number,
  ): HybridPixelSample {
    const maxBounces = clamp(Math.round(render.qualityMaxBounces), 1, 6);
    let ray = initialRay;
    const throughput = this.cpuPathTraceThroughputScratch
      ?? (this.cpuPathTraceThroughputScratch = new Vector3(1, 1, 1));
    throughput.x = 1;
    throughput.y = 1;
    throughput.z = 1;
    const radiance = this.cpuPathTraceRadianceScratch
      ?? (this.cpuPathTraceRadianceScratch = new Vector3(0, 0, 0));
    radiance.x = 0;
    radiance.y = 0;
    radiance.z = 0;
    const outwardNormal = this.cpuPathTraceOutwardNormalScratch
      ?? (this.cpuPathTraceOutwardNormalScratch = new Vector3(0, 0, 1));
    outwardNormal.x = 0;
    outwardNormal.y = 0;
    outwardNormal.z = 1;
    const shadingNormal = this.cpuPathTraceShadingNormalScratch
      ?? (this.cpuPathTraceShadingNormalScratch = new Vector3(0, 0, 1));
    shadingNormal.x = 0;
    shadingNormal.y = 0;
    shadingNormal.z = 1;
    const viewDir = this.cpuPathTraceViewDirScratch
      ?? (this.cpuPathTraceViewDirScratch = new Vector3(0, 0, 1));
    viewDir.x = 0;
    viewDir.y = 0;
    viewDir.z = 1;
    let alpha = 0;
    let currentMediumIor = 1;
    let previousBounceWasTransmission = false;
    let previousBounceWasGlossySpecular = false;

    for (let bounce = 0; bounce < maxBounces; bounce += 1) {
      const pick = this.pickTraceRayClosest(ray, null);
      if (!pick?.hit || !pick.pickedPoint || !pick.pickedMesh) {
        const env = this.sampleHybridEnvironment(ray.direction);
        radiance.x += throughput.x * env.radiance.x;
        radiance.y += throughput.y * env.radiance.y;
        radiance.z += throughput.z * env.radiance.z;
        if (bounce === 0) {
          alpha = env.alpha;
        }
        break;
      }
      alpha = 1;

      const hitPoint = pick.pickedPoint;
      const pickedNormal = pick.getNormal(true, true);
      if (pickedNormal) {
        outwardNormal.x = pickedNormal.x;
        outwardNormal.y = pickedNormal.y;
        outwardNormal.z = pickedNormal.z;
      } else {
        outwardNormal.x = -ray.direction.x;
        outwardNormal.y = -ray.direction.y;
        outwardNormal.z = -ray.direction.z;
      }
      if (outwardNormal.lengthSquared() < 1e-10) {
        outwardNormal.x = -ray.direction.x;
        outwardNormal.y = -ray.direction.y;
        outwardNormal.z = -ray.direction.z;
      }
      outwardNormal.normalize();
      const frontFace = Vector3.Dot(outwardNormal, ray.direction) < 0;
      shadingNormal.x = frontFace ? outwardNormal.x : -outwardNormal.x;
      shadingNormal.y = frontFace ? outwardNormal.y : -outwardNormal.y;
      shadingNormal.z = frontFace ? outwardNormal.z : -outwardNormal.z;

      const material = pick.hybridMaterial;
      viewDir.x = -ray.direction.x;
      viewDir.y = -ray.direction.y;
      viewDir.z = -ray.direction.z;
      if (viewDir.lengthSquared() > 1e-12) {
        viewDir.normalize();
      }
      const direct = this.sampleHybridDirectLighting(
        hitPoint,
        shadingNormal,
        viewDir,
        material,
        pick.pickedMesh,
        sampleIndex,
        pixelIndex,
        bounce,
        previousBounceWasTransmission,
        previousBounceWasGlossySpecular,
      );
      radiance.x += throughput.x * direct.x;
      radiance.y += throughput.y * direct.y;
      radiance.z += throughput.z * direct.z;

      if (bounce >= maxBounces - 1) {
        break;
      }

      const bounceSample = this.sampleHybridContinuation(
        ray.direction,
        outwardNormal,
        shadingNormal,
        frontFace,
        currentMediumIor,
        material,
        sampleIndex,
        pixelIndex,
        bounce,
      );
      if (!bounceSample) {
        break;
      }

      multiplyVec3InPlace(throughput, bounceSample.throughput);
      currentMediumIor = bounceSample.nextMediumIor;
      previousBounceWasTransmission = bounceSample.wasTransmission;
      previousBounceWasGlossySpecular = bounceSample.wasGlossySpecular;
      const rrStartBounce = this.mode === 'cpu_path' ? 1 : 2;
      if (bounce >= rrStartBounce) {
        const rrMin = this.mode === 'cpu_path' ? 0.05 : 0.1;
        const rrMax = this.mode === 'cpu_path' ? 0.95 : 0.98;
        const continueProb = clamp(Math.max(throughput.x, throughput.y, throughput.z), rrMin, rrMax);
        if (sampleHash01(pixelIndex, sampleIndex + bounce * 13, 91) > continueProb) {
          break;
        }
        throughput.scaleInPlace(1 / continueProb);
      }

      ray.origin.x = hitPoint.x + bounceSample.direction.x * 0.0025;
      ray.origin.y = hitPoint.y + bounceSample.direction.y * 0.0025;
      ray.origin.z = hitPoint.z + bounceSample.direction.z * 0.0025;
      ray.direction.x = bounceSample.direction.x;
      ray.direction.y = bounceSample.direction.y;
      ray.direction.z = bounceSample.direction.z;
      ray.length = 1e6;
    }

    return {
      r: clampFinite(radiance.x),
      g: clampFinite(radiance.y),
      b: clampFinite(radiance.z),
      a: alpha,
    };
  }

  private sampleHybridEnvironment(direction: Vector3): HybridEnvironmentSample {
    const out = this.cpuPathEnvironmentSampleScratch
      ?? (this.cpuPathEnvironmentSampleScratch = { radiance: new Vector3(0, 0, 0), alpha: 1 });
    const dirLenSq = direction.lengthSquared();
    if (dirLenSq < 1e-10) {
      out.radiance.x = 0;
      out.radiance.y = 0;
      out.radiance.z = 0;
      out.alpha = 1;
      return out;
    }
    const invDirLen = 1 / Math.sqrt(dirLenSq);
    const dirX = direction.x * invDirLen;
    const dirY = direction.y * invDirLen;
    const dirZ = direction.z * invDirLen;

    const clear = this.scene.clearColor;
    let baseX = Number.isFinite(clear?.r) ? clear.r : 0;
    let baseY = Number.isFinite(clear?.g) ? clear.g : 0;
    let baseZ = Number.isFinite(clear?.b) ? clear.b : 0;
    // Quality path output should be visually self-contained during partial accumulation
    // previews and exports, so treat environment/background rays as opaque even if the
    // raster scene clear alpha is 0 (the raster viewport may rely on CSS compositing).
    const alpha = 1;

    const ambient = this.scene.ambientColor;
    if (ambient) {
      baseX += ambient.r * 0.35;
      baseY += ambient.g * 0.35;
      baseZ += ambient.b * 0.35;
    }

    for (const light of this.scene.lights) {
      if (!(light instanceof HemisphericLight) || !light.isEnabled() || light.intensity <= 0) {
        continue;
      }
      const hemiDir = light.direction;
      const hemiLenSq = hemiDir.lengthSquared();
      if (hemiLenSq < 1e-10) {
        continue;
      }
      const invHemiLen = 1 / Math.sqrt(hemiLenSq);
      const dot = (dirX * hemiDir.x + dirY * hemiDir.y + dirZ * hemiDir.z) * invHemiLen;
      const t = clamp(0.5 + 0.5 * dot, 0, 1);
      const li = light.intensity;
      const diffuse = light.diffuse;
      const groundColor = light.groundColor;
      const skyR = (diffuse?.r ?? 1) * li;
      const skyG = (diffuse?.g ?? 1) * li;
      const skyB = (diffuse?.b ?? 1) * li;
      const groundR = (groundColor?.r ?? 0) * li;
      const groundG = (groundColor?.g ?? 0) * li;
      const groundB = (groundColor?.b ?? 0) * li;
      baseX += groundR + (skyR - groundR) * t;
      baseY += groundG + (skyG - groundG) * t;
      baseZ += groundB + (skyB - groundB) * t;
    }

    out.radiance.x = clampFinite(baseX);
    out.radiance.y = clampFinite(baseY);
    out.radiance.z = clampFinite(baseZ);
    out.alpha = alpha;
    return out;
  }

  private sampleHybridDirectLighting(
    hitPoint: Vector3,
    normal: Vector3,
    viewDir: Vector3,
    material: HybridSurfaceMaterial,
    hitMesh: AbstractMesh,
    sampleIndex: number,
    pixelIndex: number,
    bounce: number,
    previousBounceWasTransmission: boolean,
    previousBounceWasGlossySpecular: boolean,
  ): Vector3 {
    const out = this.cpuPathDirectLightingScratch ?? (this.cpuPathDirectLightingScratch = new Vector3(0, 0, 0));
    out.x = 0;
    out.y = 0;
    out.z = 0;
    const diffuseWeight = clamp01Safe((1 - material.metallic) * material.opacity);
    const specWeight = clamp01Safe(Math.max(material.reflectance, material.metallic));
    const specColorX = 1 + (material.baseColor.x - 1) * material.metallic;
    const specColorY = 1 + (material.baseColor.y - 1) * material.metallic;
    const specColorZ = 1 + (material.baseColor.z - 1) * material.metallic;
    const roughness = clamp(material.roughness, 0.03, 1);
    const shininess = clamp(Math.round((1 - roughness) * 180 + 8), 8, 256);
    const ndv = Math.max(0, normal.x * viewDir.x + normal.y * viewDir.y + normal.z * viewDir.z);
    const dielectricDirectF0 = clamp(material.reflectance, 0.02, 0.25);
    const diffuseViewFresnelScale = 1 - schlickFresnel(ndv, dielectricDirectF0);
    const specBaseF0 = clamp(Math.max(material.reflectance, material.metallic), 0.02, 1);
    // CPU path backend is throughput-constrained; sample finite direct lights only on the first hit.
    // This is a preview-biased tradeoff (fewer shadow rays / less secondary-light accuracy).
    const allowExtraFiniteDirectAfterSpecular = this.mode === 'cpu_path'
      && bounce === 1
      && (previousBounceWasTransmission || previousBounceWasGlossySpecular);
    const sampleFiniteDirectThisBounce = !(this.mode === 'cpu_path' && bounce > 0 && !allowExtraFiniteDirectAfterSpecular);
    const useSingleFiniteLightSample = this.mode === 'cpu_path' && sampleFiniteDirectThisBounce;
    let finiteLightCount = 0;
    let finiteLightSampleWeightSum = 0;
    if (useSingleFiniteLightSample) {
      for (const light of this.scene.lights) {
        if (!light.isEnabled() || light.intensity <= 0) {
          continue;
        }
        if (light instanceof DirectionalLight || light instanceof PointLight) {
          finiteLightCount += 1;
          finiteLightSampleWeightSum += finiteDirectLightSamplingWeight(light);
        }
      }
    }
    const useWeightedFiniteLightSampling =
      useSingleFiniteLightSample && finiteLightCount > 1 && finiteLightSampleWeightSum > 1e-5;
    const selectedFiniteLightIndex = useSingleFiniteLightSample && finiteLightCount > 0
      ? Math.min(
        finiteLightCount - 1,
        Math.floor(sampleHash01(pixelIndex, sampleIndex + bounce * 71, 151) * finiteLightCount),
      )
      : -1;
    const selectedFiniteLightWeightTarget = useWeightedFiniteLightSampling
      ? sampleHash01(pixelIndex, sampleIndex + bounce * 71, 152) * finiteLightSampleWeightSum
      : -1;

    let dirIndex = 0;
    let pointIndex = 0;
    let finiteLightIndex = 0;
    let finiteLightSampleWeightAccum = 0;
    for (const light of this.scene.lights) {
      if (!light.isEnabled() || light.intensity <= 0) {
        continue;
      }

      if (light instanceof HemisphericLight) {
        const hemiDir = light.direction;
        const hemiLenSq = hemiDir.lengthSquared();
        if (hemiLenSq < 1e-10) {
          continue;
        }
        const invHemiLen = 1 / Math.sqrt(hemiLenSq);
        const dot = (normal.x * hemiDir.x + normal.y * hemiDir.y + normal.z * hemiDir.z) * invHemiLen;
        const t = clamp(0.5 + 0.5 * dot, 0, 1);
        const li = light.intensity;
        const diffuse = light.diffuse;
        const groundColor = light.groundColor;
        const skyR = (diffuse?.r ?? 1) * li;
        const skyG = (diffuse?.g ?? 1) * li;
        const skyB = (diffuse?.b ?? 1) * li;
        const groundR = (groundColor?.r ?? 0) * li;
        const groundG = (groundColor?.g ?? 0) * li;
        const groundB = (groundColor?.b ?? 0) * li;
        const hemiDiffuse = diffuseWeight * diffuseViewFresnelScale;
        out.x += (groundR + (skyR - groundR) * t) * material.baseColor.x * hemiDiffuse;
        out.y += (groundG + (skyG - groundG) * t) * material.baseColor.y * hemiDiffuse;
        out.z += (groundB + (skyB - groundB) * t) * material.baseColor.z * hemiDiffuse;
        continue;
      }

      if (light instanceof DirectionalLight) {
        if (!sampleFiniteDirectThisBounce) {
          continue;
        }
        const currentDirIndex = dirIndex;
        dirIndex += 1;
        const currentFiniteLightIndex = finiteLightIndex;
        finiteLightIndex += 1;
        let finiteLightCompensation = 1;
        if (useSingleFiniteLightSample && finiteLightCount > 1) {
          if (useWeightedFiniteLightSampling) {
            const sampleWeight = finiteDirectLightSamplingWeight(light);
            const intervalMin = finiteLightSampleWeightAccum;
            finiteLightSampleWeightAccum += sampleWeight;
            const isLastFiniteLight = currentFiniteLightIndex >= finiteLightCount - 1;
            const isSelected = selectedFiniteLightWeightTarget >= intervalMin
              && (selectedFiniteLightWeightTarget < finiteLightSampleWeightAccum || isLastFiniteLight);
            if (!isSelected) {
              continue;
            }
            finiteLightCompensation = finiteLightSampleWeightSum / Math.max(sampleWeight, 1e-5);
          } else if (currentFiniteLightIndex !== selectedFiniteLightIndex) {
            continue;
          } else {
            finiteLightCompensation = finiteLightCount;
          }
        }
        const jitteredDir =
          this.computeJitteredDirectionalLightDirection(
            light.direction,
            sampleIndex + bounce * 31 + pixelIndex,
            currentDirIndex,
          ) ?? light.direction;
        const jitteredLenSq = jitteredDir.lengthSquared();
        if (jitteredLenSq < 1e-10) {
          continue;
        }
        const invJitteredLen = 1 / Math.sqrt(jitteredLenSq);
        const lightDirX = -jitteredDir.x * invJitteredLen;
        const lightDirY = -jitteredDir.y * invJitteredLen;
        const lightDirZ = -jitteredDir.z * invJitteredLen;
        const ndl = Math.max(0, normal.x * lightDirX + normal.y * lightDirY + normal.z * lightDirZ);
        if (ndl <= 0) continue;
        const shadowTransmittance = this.computeShadowTransmittanceDirectional(
          hitPoint,
          normal,
          lightDirX,
          lightDirY,
          lightDirZ,
          hitMesh,
        );
        if (
          shadowTransmittance.x <= 1e-4
          && shadowTransmittance.y <= 1e-4
          && shadowTransmittance.z <= 1e-4
        ) {
          continue;
        }
        const li = light.intensity * finiteLightCompensation;
        const diffuseColor = light.diffuse;
        const lightColorX = (diffuseColor?.r ?? 1) * shadowTransmittance.x * li;
        const lightColorY = (diffuseColor?.g ?? 1) * shadowTransmittance.y * li;
        const lightColorZ = (diffuseColor?.b ?? 1) * shadowTransmittance.z * li;
        const halfX = lightDirX + viewDir.x;
        const halfY = lightDirY + viewDir.y;
        const halfZ = lightDirZ + viewDir.z;
        const halfLenSq = halfX * halfX + halfY * halfY + halfZ * halfZ;
        let specTerm = 0;
        if (specWeight > 0 && halfLenSq > 1e-10) {
          const invHalfLen = 1 / Math.sqrt(halfLenSq);
          const ndh = Math.max(0, normal.x * halfX * invHalfLen + normal.y * halfY * invHalfLen + normal.z * halfZ * invHalfLen);
          const vdh = Math.max(0, viewDir.x * halfX * invHalfLen + viewDir.y * halfY * invHalfLen + viewDir.z * halfZ * invHalfLen);
          const specFresnel = schlickFresnel(vdh, specBaseF0);
          const specFresnelGain = clamp(specFresnel / Math.max(specBaseF0, 1e-3), 0.75, 4);
          specTerm = Math.pow(ndh, shininess) * ndl * specFresnelGain;
        }
        const diffuseTerm = diffuseWeight * diffuseViewFresnelScale * ndl;
        out.x += lightColorX * (material.baseColor.x * diffuseTerm + specColorX * specTerm * specWeight);
        out.y += lightColorY * (material.baseColor.y * diffuseTerm + specColorY * specTerm * specWeight);
        out.z += lightColorZ * (material.baseColor.z * diffuseTerm + specColorZ * specTerm * specWeight);
        continue;
      }

      if (light instanceof PointLight) {
        if (!sampleFiniteDirectThisBounce) {
          continue;
        }
        const currentPointIndex = pointIndex;
        pointIndex += 1;
        const currentFiniteLightIndex = finiteLightIndex;
        finiteLightIndex += 1;
        let finiteLightCompensation = 1;
        if (useSingleFiniteLightSample && finiteLightCount > 1) {
          if (useWeightedFiniteLightSampling) {
            const sampleWeight = finiteDirectLightSamplingWeight(light);
            const intervalMin = finiteLightSampleWeightAccum;
            finiteLightSampleWeightAccum += sampleWeight;
            const isLastFiniteLight = currentFiniteLightIndex >= finiteLightCount - 1;
            const isSelected = selectedFiniteLightWeightTarget >= intervalMin
              && (selectedFiniteLightWeightTarget < finiteLightSampleWeightAccum || isLastFiniteLight);
            if (!isSelected) {
              continue;
            }
            finiteLightCompensation = finiteLightSampleWeightSum / Math.max(sampleWeight, 1e-5);
          } else if (currentFiniteLightIndex !== selectedFiniteLightIndex) {
            continue;
          } else {
            finiteLightCompensation = finiteLightCount;
          }
        }
        const samplePos =
          this.computeJitteredPointLightPosition(light, sampleIndex + bounce * 47 + pixelIndex, currentPointIndex) ?? light.position;
        const toLightX = samplePos.x - hitPoint.x;
        const toLightY = samplePos.y - hitPoint.y;
        const toLightZ = samplePos.z - hitPoint.z;
        const dist2 = toLightX * toLightX + toLightY * toLightY + toLightZ * toLightZ;
        if (dist2 <= 1e-8) continue;
        const dist = Math.sqrt(dist2);
        const invDist = 1 / dist;
        const lightDirX = toLightX * invDist;
        const lightDirY = toLightY * invDist;
        const lightDirZ = toLightZ * invDist;
        const ndl = Math.max(0, normal.x * lightDirX + normal.y * lightDirY + normal.z * lightDirZ);
        if (ndl <= 0) continue;
        const shadowTransmittance = this.computeShadowTransmittancePoint(
          hitPoint,
          normal,
          lightDirX,
          lightDirY,
          lightDirZ,
          dist,
          hitMesh,
        );
        if (
          shadowTransmittance.x <= 1e-4
          && shadowTransmittance.y <= 1e-4
          && shadowTransmittance.z <= 1e-4
        ) {
          continue;
        }
        const range = Number.isFinite(light.range) && light.range > 0 ? light.range : dist * 2;
        const rangeFalloff = clamp(1 - (dist / Math.max(range, 1e-3)) ** 2, 0, 1);
        const attenuation = rangeFalloff * rangeFalloff / (1 + dist2 * 0.03);
        if (attenuation <= 0) continue;
        const li = light.intensity * attenuation * finiteLightCompensation;
        const diffuseColor = light.diffuse;
        const lightColorX = (diffuseColor?.r ?? 1) * shadowTransmittance.x * li;
        const lightColorY = (diffuseColor?.g ?? 1) * shadowTransmittance.y * li;
        const lightColorZ = (diffuseColor?.b ?? 1) * shadowTransmittance.z * li;
        const halfX = lightDirX + viewDir.x;
        const halfY = lightDirY + viewDir.y;
        const halfZ = lightDirZ + viewDir.z;
        const halfLenSq = halfX * halfX + halfY * halfY + halfZ * halfZ;
        let specTerm = 0;
        if (specWeight > 0 && halfLenSq > 1e-10) {
          const invHalfLen = 1 / Math.sqrt(halfLenSq);
          const ndh = Math.max(0, normal.x * halfX * invHalfLen + normal.y * halfY * invHalfLen + normal.z * halfZ * invHalfLen);
          const vdh = Math.max(0, viewDir.x * halfX * invHalfLen + viewDir.y * halfY * invHalfLen + viewDir.z * halfZ * invHalfLen);
          const specFresnel = schlickFresnel(vdh, specBaseF0);
          const specFresnelGain = clamp(specFresnel / Math.max(specBaseF0, 1e-3), 0.75, 4);
          specTerm = Math.pow(ndh, shininess) * ndl * specFresnelGain;
        }
        const diffuseTerm = diffuseWeight * diffuseViewFresnelScale * ndl;
        out.x += lightColorX * (material.baseColor.x * diffuseTerm + specColorX * specTerm * specWeight);
        out.y += lightColorY * (material.baseColor.y * diffuseTerm + specColorY * specTerm * specWeight);
        out.z += lightColorZ * (material.baseColor.z * diffuseTerm + specColorZ * specTerm * specWeight);
      }
    }

    return out;
  }

  private sampleHybridContinuation(
    incomingDir: Vector3,
    outwardNormal: Vector3,
    shadingNormal: Vector3,
    frontFace: boolean,
    currentMediumIor: number,
    material: HybridSurfaceMaterial,
    sampleIndex: number,
    pixelIndex: number,
    bounce: number,
  ): HybridBounceSample | null {
    const incident = this.cpuPathContinuationIncidentScratch
      ?? (this.cpuPathContinuationIncidentScratch = new Vector3(0, 0, 1));
    incident.x = incomingDir.x;
    incident.y = incomingDir.y;
    incident.z = incomingDir.z;
    if (incident.lengthSquared() < 1e-10) {
      return null;
    }
    incident.normalize();
    const out = this.cpuPathContinuationBounceSampleScratch
      ?? (this.cpuPathContinuationBounceSampleScratch = {
        direction: new Vector3(0, 0, 1),
        throughput: new Vector3(1, 1, 1),
        nextMediumIor: 1,
        wasTransmission: false,
        wasGlossySpecular: false,
      });
    const tangentScratch = this.cpuPathContinuationTangentScratch
      ?? (this.cpuPathContinuationTangentScratch = new Vector3(1, 0, 0));
    const bitangentScratch = this.cpuPathContinuationBitangentScratch
      ?? (this.cpuPathContinuationBitangentScratch = new Vector3(0, 1, 0));
    const mediumIor = sanitizeIor(currentMediumIor);
    const materialIor = sanitizeIor(material.ior);
    const nextMediumIorForTransmission = frontFace ? materialIor : 1;
    const cosTheta = clamp(-Vector3.Dot(incident, shadingNormal), 0, 1);
    const dielectricF0 = fresnelF0FromIorPair(mediumIor, nextMediumIorForTransmission);
    const fresnel = schlickFresnel(cosTheta, Math.max(dielectricF0, material.reflectance));

    let reflectWeight = clamp01Safe(Math.max(material.reflectance, material.metallic));
    let transmitWeight = opacityDrivenTransmission(material.opacity);
    if (transmitWeight > 0) {
      reflectWeight = clamp01Safe(reflectWeight + transmitWeight * fresnel);
      transmitWeight = clamp01Safe(transmitWeight * (1 - fresnel));
    }
    const diffuseWeight = clamp01Safe((1 - material.metallic) * material.opacity);
    const total = reflectWeight + transmitWeight + diffuseWeight;
    if (total <= 1e-5) {
      return null;
    }

    const xi = sampleHash01(pixelIndex, sampleIndex + bounce * 19, 7) * total;
    const roughness = clamp(material.roughness, 0, 1);

    if (xi < transmitWeight) {
      const interfaceNormal = this.cpuPathContinuationInterfaceNormalScratch
        ?? (this.cpuPathContinuationInterfaceNormalScratch = new Vector3(0, 0, 1));
      interfaceNormal.x = frontFace ? outwardNormal.x : -outwardNormal.x;
      interfaceNormal.y = frontFace ? outwardNormal.y : -outwardNormal.y;
      interfaceNormal.z = frontFace ? outwardNormal.z : -outwardNormal.z;
      const refracted = refractDirectionAcrossInterfaceToRef(
        incident,
        interfaceNormal,
        mediumIor,
        nextMediumIorForTransmission,
        out.direction,
      );
      if (!refracted && !reflectDirectionToRef(incident, shadingNormal, out.direction)) {
        return null;
      }
      if (!jitterDirectionToRef(
        out.direction,
        clamp(roughness * 0.35, 0, 0.4),
        pixelIndex,
        sampleIndex,
        bounce,
        17,
        out.direction,
        tangentScratch,
        bitangentScratch,
      )) {
        return null;
      }
      const tintScale = Math.max(0.15, transmitWeight / total);
      out.throughput.x = (1 + (material.baseColor.x - 1) * 0.2) * tintScale;
      out.throughput.y = (1 + (material.baseColor.y - 1) * 0.2) * tintScale;
      out.throughput.z = (1 + (material.baseColor.z - 1) * 0.2) * tintScale;
      out.nextMediumIor = refracted ? nextMediumIorForTransmission : mediumIor;
      out.wasTransmission = refracted;
      out.wasGlossySpecular = !refracted || roughness <= 0.35;
      return out;
    }

    if (xi < transmitWeight + reflectWeight) {
      if (!reflectDirectionToRef(incident, shadingNormal, out.direction)) {
        return null;
      }
      if (!jitterDirectionToRef(
        out.direction,
        clamp(roughness * 0.6, 0, 0.75),
        pixelIndex,
        sampleIndex,
        bounce,
        23,
        out.direction,
        tangentScratch,
        bitangentScratch,
      )) {
        return null;
      }
      const specScale = Math.max(0.1, reflectWeight / total);
      out.throughput.x = (1 + (material.baseColor.x - 1) * material.metallic) * specScale;
      out.throughput.y = (1 + (material.baseColor.y - 1) * material.metallic) * specScale;
      out.throughput.z = (1 + (material.baseColor.z - 1) * material.metallic) * specScale;
      out.nextMediumIor = mediumIor;
      out.wasTransmission = false;
      out.wasGlossySpecular = roughness <= 0.35;
      return out;
    }

    if (!cosineSampleHemisphereToRef(
      shadingNormal,
      pixelIndex,
      sampleIndex,
      bounce,
      29,
      out.direction,
      tangentScratch,
      bitangentScratch,
    )) {
      return null;
    }
    const diffuseScale = Math.max(0.1, diffuseWeight / total);
    out.throughput.x = material.baseColor.x * diffuseScale;
    out.throughput.y = material.baseColor.y * diffuseScale;
    out.throughput.z = material.baseColor.z * diffuseScale;
    out.nextMediumIor = mediumIor;
    out.wasTransmission = false;
    out.wasGlossySpecular = false;
    return out;
  }

  private computeShadowTransmittanceDirectional(
    hitPoint: Vector3,
    normal: Vector3,
    lightDirX: number,
    lightDirY: number,
    lightDirZ: number,
    hitMesh: AbstractMesh,
  ): Vector3 {
    const shadowRay = this.cpuPathShadowRayScratch
      ?? (this.cpuPathShadowRayScratch = new Ray(new Vector3(0, 0, 0), new Vector3(0, 0, 1), 1e6));
    shadowRay.origin.x = hitPoint.x + normal.x * 0.0035;
    shadowRay.origin.y = hitPoint.y + normal.y * 0.0035;
    shadowRay.origin.z = hitPoint.z + normal.z * 0.0035;
    shadowRay.direction.x = lightDirX;
    shadowRay.direction.y = lightDirY;
    shadowRay.direction.z = lightDirZ;
    shadowRay.length = 1e6;
    return this.traceShadowTransmittance(shadowRay, hitMesh, undefined);
  }

  private computeShadowTransmittancePoint(
    hitPoint: Vector3,
    normal: Vector3,
    lightDirX: number,
    lightDirY: number,
    lightDirZ: number,
    lightDistance: number,
    hitMesh: AbstractMesh,
  ): Vector3 {
    const shadowRay = this.cpuPathShadowRayScratch
      ?? (this.cpuPathShadowRayScratch = new Ray(new Vector3(0, 0, 0), new Vector3(0, 0, 1), 1e6));
    shadowRay.origin.x = hitPoint.x + normal.x * 0.0035;
    shadowRay.origin.y = hitPoint.y + normal.y * 0.0035;
    shadowRay.origin.z = hitPoint.z + normal.z * 0.0035;
    shadowRay.direction.x = lightDirX;
    shadowRay.direction.y = lightDirY;
    shadowRay.direction.z = lightDirZ;
    const shadowMaxDistance = lightDistance - 0.005;
    shadowRay.length = Math.max(0, shadowMaxDistance);
    return this.traceShadowTransmittance(shadowRay, hitMesh, shadowMaxDistance);
  }

  private traceShadowTransmittance(
    ray: Ray,
    ignoreMesh: AbstractMesh | null,
    maxDistance?: number,
  ): Vector3 {
    const transmittance = this.cpuPathShadowTransmittanceScratch
      ?? (this.cpuPathShadowTransmittanceScratch = new Vector3(1, 1, 1));
    transmittance.x = 1;
    transmittance.y = 1;
    transmittance.z = 1;
    let remaining = Number.isFinite(maxDistance) ? Math.max(0, maxDistance ?? 0) : 1e6;
    let currentIgnoreMesh = ignoreMesh;
    const advanceEpsilon = 0.0045;
    const minTransmittance = 0.02;
    const maxOccluderHits = 4;

    if (remaining <= 1e-6) {
      return transmittance;
    }

    for (let step = 0; step < maxOccluderHits; step += 1) {
      ray.length = remaining;
      const hit = this.pickTraceRayClosest(ray, currentIgnoreMesh);
      if (!hit?.hit || !hit.pickedPoint || !hit.pickedMesh) {
        break;
      }
      if (!(hit.distance >= 0) || hit.distance > remaining) {
        break;
      }

      const occluderTransmittance = this.shadowOccluderTransmittanceToRef(hit.hybridMaterial);
      if (
        occluderTransmittance.x <= 1e-4
        && occluderTransmittance.y <= 1e-4
        && occluderTransmittance.z <= 1e-4
      ) {
        transmittance.x = 0;
        transmittance.y = 0;
        transmittance.z = 0;
        return transmittance;
      }
      transmittance.x *= occluderTransmittance.x;
      transmittance.y *= occluderTransmittance.y;
      transmittance.z *= occluderTransmittance.z;
      if (
        transmittance.x <= minTransmittance
        && transmittance.y <= minTransmittance
        && transmittance.z <= minTransmittance
      ) {
        transmittance.x = 0;
        transmittance.y = 0;
        transmittance.z = 0;
        return transmittance;
      }

      ray.origin.x = hit.pickedPoint.x + ray.direction.x * advanceEpsilon;
      ray.origin.y = hit.pickedPoint.y + ray.direction.y * advanceEpsilon;
      ray.origin.z = hit.pickedPoint.z + ray.direction.z * advanceEpsilon;
      remaining -= Math.max(0, hit.distance) + advanceEpsilon;
      if (remaining <= 1e-5) {
        break;
      }
      currentIgnoreMesh = hit.pickedMesh;
    }

    return transmittance;
  }

  private shadowOccluderTransmittanceToRef(material: HybridSurfaceMaterial): Vector3 {
    const out = this.cpuPathShadowOccluderTransmittanceScratch
      ?? (this.cpuPathShadowOccluderTransmittanceScratch = new Vector3(1, 1, 1));
    const transmittance = opacityDrivenTransmission(material.opacity);
    if (transmittance <= 0.02) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      return out;
    }
    const roughnessPenalty = 1 - clamp(material.roughness, 0, 1) * 0.2;
    const baseScale = transmittance * roughnessPenalty;
    out.x = clamp(baseScale * Math.sqrt(Math.max(0, material.baseColor.x)), 0, 1);
    out.y = clamp(baseScale * Math.sqrt(Math.max(0, material.baseColor.y)), 0, 1);
    out.z = clamp(baseScale * Math.sqrt(Math.max(0, material.baseColor.z)), 0, 1);
    return out;
  }

  private invalidateTraceMeshAcceleration(): void {
    this.traceMeshCache = [];
    this.traceMeshAccelEntries = [];
    this.traceMeshBvhRoot = null;
    this.traceMeshCacheMeshCount = -1;
    this.traceMeshCacheValidationRenderId = -1;
    this.traceMeshCacheBuilt = false;
    this.cpuPathWorkerSceneDirty = true;
    this.cpuPathWorkerSceneUnsupported = false;
    this.cpuPathWorkerSceneUnsupportedReason = null;
    this.clearCpuPathWorkerFallbackAnnouncement();
    this.cpuPathWorkerGeometrySignature = '';
    this.cpuPathWorkerMaterialSignature = '';
    this.cpuPathWorkerLightSignature = '';
    this.cpuPathAlignmentProbeForceNext = true;
    this.cpuPathWorkerReadySceneVersion = -1;
    this.cpuPathWorkerInitPendingSceneVersion = -1;
  }

  private getTraceableMeshesForCurrentFrame(): AbstractMesh[] {
    const renderId = typeof this.scene.getRenderId === 'function' ? this.scene.getRenderId() : -1;
    if (this.traceMeshCacheBuilt && this.traceMeshCacheValidationRenderId === renderId) {
      return this.traceMeshCache;
    }
    this.traceMeshCacheValidationRenderId = renderId;
    const meshCount = this.scene.meshes.length;
    let needsRebuild = !this.traceMeshCacheBuilt || this.traceMeshCacheMeshCount !== meshCount;
    if (!needsRebuild) {
      needsRebuild = this.isTraceMeshAccelerationStale();
    }
    if (needsRebuild) {
      this.traceMeshCache = this.scene.meshes.filter((mesh) => this.isTraceRenderableMesh(mesh, null));
      this.rebuildTraceMeshAcceleration(this.traceMeshCache);
      this.traceMeshCacheMeshCount = meshCount;
      this.traceMeshCacheBuilt = true;
    }
    return this.traceMeshCache;
  }

  private isTraceMeshAccelerationStale(): boolean {
    if (this.traceMeshAccelEntries.length !== this.traceMeshCache.length) {
      return true;
    }
    for (let i = 0; i < this.traceMeshAccelEntries.length; i += 1) {
      const entry = this.traceMeshAccelEntries[i];
      const mesh = this.traceMeshCache[i];
      if (!mesh || entry.mesh !== mesh) {
        return true;
      }
      if (!this.isTraceRenderableMesh(mesh, null)) {
        return true;
      }
      try {
        entry.hybridMaterial = extractHybridSurfaceMaterial(mesh.material);
        mesh.computeWorldMatrix(false);
        const worldMatrix = mesh.getWorldMatrix();
        const worldM = worldMatrix.m;
        const worldMatrixUpdateFlag = getMeshWorldMatrixUpdateFlag(mesh);
        if (worldMatrixUpdateFlag !== entry.worldMatrixUpdateFlag) {
          if (!matrixElementsApproxEqual(worldM, entry.worldMatrixElements)) {
            return true;
          }
          entry.worldMatrixUpdateFlag = worldMatrixUpdateFlag;
        }
        const bounds = mesh.getBoundingInfo()?.boundingBox;
        if (!bounds) {
          return true;
        }
        const min = bounds.minimumWorld;
        const max = bounds.maximumWorld;
        if (
          !approxEqual(min.x, entry.minX) || !approxEqual(min.y, entry.minY) || !approxEqual(min.z, entry.minZ)
          || !approxEqual(max.x, entry.maxX) || !approxEqual(max.y, entry.maxY) || !approxEqual(max.z, entry.maxZ)
        ) {
          return true;
        }
      } catch {
        return true;
      }
    }
    return false;
  }

  private rebuildTraceMeshAcceleration(meshes: AbstractMesh[]): void {
    const entries: TraceMeshAccelEntry[] = [];
    for (const mesh of meshes) {
      try {
        mesh.computeWorldMatrix(false);
        const bounds = mesh.getBoundingInfo()?.boundingBox;
        if (!bounds) {
          continue;
        }
        const min = bounds.minimumWorld;
        const max = bounds.maximumWorld;
        if (
          !Number.isFinite(min.x) || !Number.isFinite(min.y) || !Number.isFinite(min.z)
          || !Number.isFinite(max.x) || !Number.isFinite(max.y) || !Number.isFinite(max.z)
        ) {
          continue;
        }
        if (max.x < min.x || max.y < min.y || max.z < min.z) {
          continue;
        }
        entries.push({
          mesh,
          hybridMaterial: extractHybridSurfaceMaterial(mesh.material),
          worldMatrixUpdateFlag: getMeshWorldMatrixUpdateFlag(mesh),
          worldMatrixElements: new Float32Array(mesh.getWorldMatrix().m),
          triangleAccel: buildTraceTriangleAccel(mesh),
          lineAccel: buildTraceLineAccel(mesh),
          minX: min.x,
          minY: min.y,
          minZ: min.z,
          maxX: max.x,
          maxY: max.y,
          maxZ: max.z,
          centerX: (min.x + max.x) * 0.5,
          centerY: (min.y + max.y) * 0.5,
          centerZ: (min.z + max.z) * 0.5,
        });
      } catch {
        // Skip malformed/transient meshes; Babylon can transiently throw while geometry mutates.
      }
    }
    this.traceMeshAccelEntries = entries;
    this.traceMeshBvhRoot = buildTraceMeshBvh(entries);
    this.cpuPathWorkerSceneDirty = true;
    this.cpuPathWorkerSceneUnsupported = false;
    this.cpuPathWorkerSceneUnsupportedReason = null;
    this.cpuPathAlignmentProbeForceNext = true;
    this.cpuPathWorkerReadySceneVersion = -1;
    this.cpuPathWorkerInitPendingSceneVersion = -1;
  }

  private intersectTraceMeshClosest(
    entry: TraceMeshAccelEntry,
    ray: Ray,
    maxDistance: number,
  ): TracePickResult | null {
    if (entry.triangleAccel) {
      const triangleHit = intersectTraceTriangleSoupClosest(ray, entry.triangleAccel, maxDistance);
      if (!triangleHit) {
        return null;
      }
      return {
        hit: true,
        distance: triangleHit.distance,
        pickedPoint: triangleHit.point,
        pickedMesh: entry.mesh,
        hybridMaterial: entry.hybridMaterial,
        getNormal: () => triangleHit.normal.clone(),
      };
    }
    const pick = entry.mesh.intersects(ray, false);
    if (!pick?.hit || typeof pick.distance !== 'number' || !Number.isFinite(pick.distance)) {
      return null;
    }
    if (pick.distance < 0 || pick.distance >= maxDistance) {
      return null;
    }
    const pickedPoint = pick.pickedPoint
      ?? ray.origin.add(ray.direction.scale(pick.distance));
    return {
      hit: true,
      distance: pick.distance,
      pickedPoint,
      pickedMesh: pick.pickedMesh ?? entry.mesh,
      hybridMaterial: entry.hybridMaterial,
      getNormal: (useWorldCoordinates = true, useVerticesNormals = true) => {
        try {
          return pick.getNormal?.(useWorldCoordinates, useVerticesNormals) ?? null;
        } catch {
          return null;
        }
      },
    };
  }

  private ensureCpuPathWorkerBatchScratch(hardMaxPixels: number): {
    pixelIndices: Uint32Array;
    rays: Float32Array;
  } {
    const pixelScratch = this.cpuPathWorkerBatchPixelScratch;
    const rayScratch = this.cpuPathWorkerBatchRayScratch;
    if (!pixelScratch || pixelScratch.length < hardMaxPixels) {
      this.cpuPathWorkerBatchPixelScratch = new Uint32Array(hardMaxPixels);
    }
    if (!rayScratch || rayScratch.length < hardMaxPixels * 6) {
      this.cpuPathWorkerBatchRayScratch = new Float32Array(hardMaxPixels * 6);
    }
    return {
      pixelIndices: this.cpuPathWorkerBatchPixelScratch!,
      rays: this.cpuPathWorkerBatchRayScratch!,
    };
  }

  private pickTraceRayClosest(
    ray: Ray,
    ignoreMesh: AbstractMesh | null,
  ): TracePickResult | null {
    let bestPick: TracePickResult | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    this.getTraceableMeshesForCurrentFrame();
    const root = this.traceMeshBvhRoot;
    if (root) {
      const stack = traceMeshBvhStackScratch;
      stack.length = 0;
      stack.push(root);
      while (stack.length > 0) {
        const node = stack.pop()!;
        const nodeHitDist = rayIntersectsTraceAabb(ray, node.minX, node.minY, node.minZ, node.maxX, node.maxY, node.maxZ, bestDistance);
        if (nodeHitDist === null) {
          continue;
        }
        if (node.items) {
          for (const entry of node.items) {
            if (ignoreMesh && entry.mesh === ignoreMesh) {
              continue;
            }
            const entryHitDist = rayIntersectsTraceAabb(
              ray,
              entry.minX,
              entry.minY,
              entry.minZ,
              entry.maxX,
              entry.maxY,
              entry.maxZ,
              bestDistance,
            );
            if (entryHitDist === null) {
              continue;
            }
            const pick = this.intersectTraceMeshClosest(entry, ray, bestDistance);
            if (!pick) {
              continue;
            }
            bestDistance = pick.distance;
            bestPick = pick;
          }
          continue;
        }

        const left = node.left;
        const right = node.right;
        if (!left && !right) {
          continue;
        }
        if (left && right) {
          const leftHit = rayIntersectsTraceAabb(ray, left.minX, left.minY, left.minZ, left.maxX, left.maxY, left.maxZ, bestDistance);
          const rightHit = rayIntersectsTraceAabb(ray, right.minX, right.minY, right.minZ, right.maxX, right.maxY, right.maxZ, bestDistance);
          if (leftHit !== null && rightHit !== null) {
            if (leftHit < rightHit) {
              stack.push(right, left);
            } else {
              stack.push(left, right);
            }
            continue;
          }
          if (leftHit !== null) {
            stack.push(left);
          }
          if (rightHit !== null) {
            stack.push(right);
          }
          continue;
        }
        if (left) {
          stack.push(left);
        }
        if (right) {
          stack.push(right);
        }
      }
      return bestPick;
    }

    const meshes = this.traceMeshCache;
    for (const mesh of meshes) {
      if (ignoreMesh && mesh === ignoreMesh) {
        continue;
      }
      const pick = mesh.intersects(ray, false);
      if (!pick?.hit || typeof pick.distance !== 'number' || !Number.isFinite(pick.distance)) {
        continue;
      }
      if (pick.distance < 0 || pick.distance >= bestDistance) {
        continue;
      }
      const pickedPoint = pick.pickedPoint
        ?? ray.origin.add(ray.direction.scale(pick.distance));
      bestDistance = pick.distance;
      bestPick = {
        hit: true,
        distance: pick.distance,
        pickedPoint,
        pickedMesh: pick.pickedMesh ?? mesh,
        hybridMaterial: extractHybridSurfaceMaterial((pick.pickedMesh ?? mesh).material),
        getNormal: (useWorldCoordinates = true, useVerticesNormals = true) => {
          try {
            return pick.getNormal?.(useWorldCoordinates, useVerticesNormals) ?? null;
          } catch {
            return null;
          }
        },
      };
    }
    return bestPick;
  }

  private isTraceRenderableMesh(mesh: AbstractMesh, ignoreMesh: AbstractMesh | null): boolean {
    if (!mesh || (ignoreMesh && mesh === ignoreMesh)) {
      return false;
    }
    if (!mesh.isEnabled() || !mesh.isVisible || !mesh.isPickable) {
      return false;
    }
    if (typeof mesh.visibility === 'number' && mesh.visibility <= 0.001) {
      return false;
    }
    const meta = (mesh as { metadata?: { selectableType?: string } }).metadata;
    if (meta?.selectableType === 'point_light') {
      return false;
    }
    return true;
  }

  private accumulateHybridPixelSample(pixelIndex: number, sample: HybridPixelSample, render: RenderSettings): void {
    this.accumulateHybridPixelSampleValues(pixelIndex, sample.r, sample.g, sample.b, sample.a, render);
  }

  private accumulateHybridPixelSampleValues(
    pixelIndex: number,
    sampleR: number,
    sampleG: number,
    sampleB: number,
    sampleA: number,
    render: RenderSettings,
  ): void {
    if (!this.accumLinear || !this.pixelSampleCounts) {
      return;
    }
    const base4 = pixelIndex * 4;
    const count = this.pixelSampleCounts[pixelIndex];
    let r = sampleR;
    let g = sampleG;
    let b = sampleB;
    const a = clamp(sampleA, 0, 1);

    // Path mode is especially sensitive to early-sample highlight loss; delay clamp startup
    // slightly so legitimate bright reflections/translucency are visible sooner.
    if (render.qualityClampFireflies && count > 2) {
      const avgR = this.accumLinear[base4] / count;
      const avgG = this.accumLinear[base4 + 1] / count;
      const avgB = this.accumLinear[base4 + 2] / count;
      const maxBounces = clamp(Math.round(render.qualityMaxBounces), 1, 12);
      const scale = computeQualityFireflyClampScale(r, g, b, avgR, avgG, avgB, count, maxBounces);
      if (scale < 0.999999) {
        r *= scale;
        g *= scale;
        b *= scale;
      }
    }

    this.accumLinear[base4] += r;
    this.accumLinear[base4 + 1] += g;
    this.accumLinear[base4 + 2] += b;
    this.accumLinear[base4 + 3] += a;
    this.pixelSampleCounts[pixelIndex] = Math.min(65535, count + 1);
  }

  private async captureAndAccumulate(
    width: number,
    height: number,
    generation: number,
    render: RenderSettings,
  ): Promise<void> {
    const targetSamples = clamp(Math.round(render.qualitySamplesTarget), 1, 4096);
    let restoreCameraJitter: (() => void) | null = null;
    let restoreLightJitter: (() => void) | null = null;
    let restorePointLightJitter: (() => void) | null = null;
    try {
      const captureCamera = this.captureCamera ?? this.createCaptureCamera();
      this.captureCamera = captureCamera;
      this.copyLiveCameraToCaptureCamera(captureCamera);
      restoreCameraJitter = this.applySubpixelCameraJitter(captureCamera, width, height, this.sampleCount + 1);
      restoreLightJitter = this.applyDirectLightingJitter(this.sampleCount + 1);
      restorePointLightJitter = this.applyPointLightingJitter(this.sampleCount + 1);
      const dataUrl = await CreateScreenshotUsingRenderTargetAsync(this.engine, captureCamera, { width, height }, 'image/png');
      restorePointLightJitter?.();
      restorePointLightJitter = null;
      restoreLightJitter?.();
      restoreLightJitter = null;
      restoreCameraJitter?.();
      restoreCameraJitter = null;
      if (!this.enabled || generation !== this.captureGeneration) {
        return;
      }
      if (this.sampleCount >= targetSamples) {
        return;
      }
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) {
        throw new Error('Unexpected screenshot payload from Babylon render target');
      }
      const image = await loadImageFromDataUrl(dataUrl);
      if (!this.enabled || generation !== this.captureGeneration) {
        return;
      }
      this.ensureAccumCanvasSize(width, height);
      if (
        !this.accumCanvas
        || !this.accumCtx
        || !this.sampleCanvas
        || !this.sampleCtx
        || !this.accumLinear
        || !this.previewImageData
      ) {
        return;
      }
      const w = this.accumCanvas.width;
      const h = this.accumCanvas.height;
      this.sampleCtx.clearRect(0, 0, w, h);
      this.sampleCtx.drawImage(image, 0, 0, w, h);
      const sampleImageData = this.sampleCtx.getImageData(0, 0, w, h);
      if (this.looksLikeBlankCaptureFrame(sampleImageData.data, w, h)) {
        this.blankCaptureFrameCount += 1;
        if (this.blankCaptureFrameCount >= 3) {
          this.enabled = false;
          this.sampleCount = 0;
          this.clearAccumCanvas();
          this.runtimeFailureReason = `${this.backendLabel()} could not capture non-empty render-target frames`;
          this.scheduleRuntimeRetry();
          console.warn(`${this.backendLabel()} accumulation produced blank render-target captures; disabling backend`);
          return;
        }
      } else {
        this.blankCaptureFrameCount = 0;
      }
      const nextSample = Math.min(targetSamples, this.sampleCount + 1);
      this.accumulateSampleIntoFloatBuffer(sampleImageData.data, nextSample, render);
      this.writeFloatAccumulationPreview(nextSample);
      this.runtimeFailureCount = 0;
      this.runtimeFailureRetryAfterMs = 0;
      this.sampleCount = nextSample;
    } catch (error) {
      restorePointLightJitter?.();
      restoreLightJitter?.();
      restoreCameraJitter?.();
      if (generation !== this.captureGeneration) {
        return;
      }
      this.enabled = false;
      this.sampleCount = 0;
      this.blankCaptureFrameCount = 0;
      this.clearAccumCanvas();
      this.runtimeFailureReason = `${this.backendLabel()} render-target capture failed`;
      this.scheduleRuntimeRetry();
      console.warn(`${this.backendLabel()} render-target accumulation failed; disabling backend`, error);
    }
  }

  private scheduleRuntimeRetry(): void {
    this.runtimeFailureCount = clamp(Math.round(this.runtimeFailureCount) + 1, 1, 10);
    const backoffMs = Math.min(5000, 500 * 2 ** (this.runtimeFailureCount - 1));
    this.runtimeFailureRetryAfterMs = nowMs() + backoffMs;
  }

  private applyDirectLightingJitter(sampleIndex: number): (() => void) | null {
    const directionalLights = this.scene.lights.filter(
      (light): light is DirectionalLight => light instanceof DirectionalLight && light.isEnabled() && light.intensity > 0,
    );
    if (directionalLights.length === 0) {
      return null;
    }

    const restores: Array<() => void> = [];
    directionalLights.forEach((light, idx) => {
      const originalDirection = light.direction.clone();
      const jittered = this.computeJitteredDirectionalLightDirection(light.direction, sampleIndex, idx);
      if (!jittered) {
        return;
      }
      light.direction.copyFrom(jittered);
      restores.push(() => {
        light.direction.copyFrom(originalDirection);
      });
    });

    if (restores.length === 0) {
      return null;
    }

    return () => {
      for (let i = restores.length - 1; i >= 0; i -= 1) {
        restores[i]();
      }
    };
  }

  private applyPointLightingJitter(sampleIndex: number): (() => void) | null {
    const pointLights = this.scene.lights.filter(
      (light): light is PointLight => light instanceof PointLight && light.isEnabled() && light.intensity > 0,
    );
    if (pointLights.length === 0) {
      return null;
    }

    const restores: Array<() => void> = [];
    pointLights.forEach((light, idx) => {
      const originalPosition = light.position.clone();
      const jittered = this.computeJitteredPointLightPosition(light, sampleIndex, idx);
      if (!jittered) {
        return;
      }
      light.position.copyFrom(jittered);
      restores.push(() => {
        light.position.copyFrom(originalPosition);
      });
    });

    if (restores.length === 0) {
      return null;
    }

    return () => {
      for (let i = restores.length - 1; i >= 0; i -= 1) {
        restores[i]();
      }
    };
  }

  private computeJitteredPointLightPosition(
    light: PointLight,
    sampleIndex: number,
    lightIndex: number,
  ): Vector3 | null {
    const original = light.position;
    if (!original) {
      return null;
    }
    const range = Number.isFinite(light.range) && light.range > 0 ? light.range : this.camera.radius * 2;
    if (!Number.isFinite(range) || range <= 0) {
      return null;
    }

    // Exaggerated finite-emitter approximation so the current hybrid/raster path backend
    // produces a clearly visible penumbra difference before the true path integrator lands.
    // This should be tuned back down once a real transport solution is in place.
    const emitterRadius = clamp(range * 0.06, 0.08, 2.5);
    const baseIndex = sampleIndex + 1 + lightIndex * 131;
    const u = halton(baseIndex, 11);
    const v = halton(baseIndex, 13);
    const w = halton(baseIndex, 17);
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = emitterRadius * Math.cbrt(w);
    const sinPhi = Math.sin(phi);

    return new Vector3(
      original.x + r * sinPhi * Math.cos(theta),
      original.y + r * sinPhi * Math.sin(theta),
      original.z + r * Math.cos(phi),
    );
  }

  private computeJitteredDirectionalLightDirection(
    direction: Vector3,
    sampleIndex: number,
    lightIndex: number,
  ): Vector3 | null {
    const dir = direction.clone();
    if (dir.lengthSquared() < 1e-10) {
      return null;
    }
    dir.normalize();

    const worldUpA = new Vector3(0, 0, 1);
    const worldUpB = new Vector3(0, 1, 0);
    let tangent = Vector3.Cross(dir, Math.abs(Vector3.Dot(dir, worldUpA)) > 0.95 ? worldUpB : worldUpA);
    if (tangent.lengthSquared() < 1e-10) {
      tangent = Vector3.Cross(dir, new Vector3(1, 0, 0));
      if (tangent.lengthSquared() < 1e-10) {
        return null;
      }
    }
    tangent.normalize();
    const bitangent = Vector3.Cross(tangent, dir);
    if (bitangent.lengthSquared() < 1e-10) {
      return null;
    }
    bitangent.normalize();

    const baseIndex = sampleIndex + 1 + lightIndex * 97;
    const jx = halton(baseIndex, 5) * 2 - 1;
    const jy = halton(baseIndex, 7) * 2 - 1;
    // Exaggerated sun-disk approximation so the current path backend visibly differs from
    // interactive/TAA shadowing. Realistic values are smaller; this is a temporary Phase 5 bridge.
    const sunHalfAngleRad = 0.02; // ~1.15 degrees
    const coneScale = Math.tan(sunHalfAngleRad);
    const jittered = dir
      .add(tangent.scale(jx * coneScale))
      .add(bitangent.scale(jy * coneScale));
    if (jittered.lengthSquared() < 1e-10) {
      return null;
    }
    return jittered.normalize();
  }

  private createCaptureCamera(): ArcRotateCamera {
    const captureCamera = new ArcRotateCamera(
      'quality-path-capture-camera',
      this.camera.alpha,
      this.camera.beta,
      this.camera.radius,
      this.camera.target.clone(),
      this.scene,
    );
    // ArcRotateCamera.upVector must go through the setter so Babylon rebuilds
    // its internal Y-up <-> custom-up matrices (copyFrom() breaks Z-up scenes).
    captureCamera.upVector = this.camera.upVector.clone();
    captureCamera.fov = this.camera.fov;
    captureCamera.fovMode = this.camera.fovMode;
    captureCamera.minZ = this.camera.minZ;
    captureCamera.maxZ = this.camera.maxZ;
    captureCamera.mode = this.camera.mode;
    captureCamera.orthoLeft = this.camera.orthoLeft;
    captureCamera.orthoRight = this.camera.orthoRight;
    captureCamera.orthoTop = this.camera.orthoTop;
    captureCamera.orthoBottom = this.camera.orthoBottom;
    captureCamera.layerMask = this.camera.layerMask;
    captureCamera.viewport = this.camera.viewport.clone();
    this.syncCaptureCameraMatrices(captureCamera);
    return captureCamera;
  }

  private copyLiveCameraToCaptureCamera(captureCamera: ArcRotateCamera): void {
    captureCamera.alpha = this.camera.alpha;
    captureCamera.beta = this.camera.beta;
    captureCamera.radius = this.camera.radius;
    captureCamera.fov = this.camera.fov;
    captureCamera.fovMode = this.camera.fovMode;
    captureCamera.minZ = this.camera.minZ;
    captureCamera.maxZ = this.camera.maxZ;
    captureCamera.mode = this.camera.mode;
    captureCamera.orthoLeft = this.camera.orthoLeft;
    captureCamera.orthoRight = this.camera.orthoRight;
    captureCamera.orthoTop = this.camera.orthoTop;
    captureCamera.orthoBottom = this.camera.orthoBottom;
    // Keep using the setter here as well; mutating in-place bypasses ArcRotateCamera.setMatUp().
    captureCamera.upVector = this.camera.upVector.clone();
    captureCamera.layerMask = this.camera.layerMask;
    captureCamera.viewport = this.camera.viewport.clone();
    captureCamera.target.copyFrom(this.camera.target);
    this.syncCaptureCameraMatrices(captureCamera);
  }

  private syncCaptureCameraMatrices(captureCamera: ArcRotateCamera): void {
    try {
      captureCamera.computeWorldMatrix();
    } catch {
      // Ignore transient matrix errors during scene mutation.
    }
    try {
      captureCamera.getViewMatrix(true);
    } catch {
      // Ignore transient matrix errors during scene mutation.
    }
    try {
      captureCamera.getProjectionMatrix(true);
    } catch {
      // Ignore transient matrix errors during scene mutation.
    }
  }

  private applySubpixelCameraJitter(
    camera: ArcRotateCamera,
    width: number,
    height: number,
    sampleIndex: number,
  ): (() => void) | null {
    const target = camera.target;
    if (!target) {
      return null;
    }
    const h = Math.max(1, height);
    const w = Math.max(1, width);
    const radius = Number.isFinite(camera.radius) ? Math.max(0.001, camera.radius) : 10;
    const fov = Number.isFinite(camera.fov) ? Math.max(0.05, camera.fov) : Math.PI / 4;
    const worldPerPixelY = (2 * radius * Math.tan(fov * 0.5)) / h;
    const worldPerPixelX = worldPerPixelY * (w / h);
    if (!Number.isFinite(worldPerPixelX) || !Number.isFinite(worldPerPixelY) || worldPerPixelX <= 0 || worldPerPixelY <= 0) {
      return null;
    }

    const jitterX = halton(sampleIndex, 2) - 0.5;
    const jitterY = halton(sampleIndex, 3) - 0.5;
    const right = camera.getDirection(new Vector3(1, 0, 0));
    const up = camera.getDirection(new Vector3(0, 1, 0));
    if (right.lengthSquared() < 1e-8 || up.lengthSquared() < 1e-8) {
      return null;
    }
    right.normalize();
    up.normalize();

    const offset = right.scale(jitterX * worldPerPixelX).add(up.scale(jitterY * worldPerPixelY));
    const originalTarget = target.clone();
    target.addInPlace(offset);

    return () => {
      target.copyFrom(originalTarget);
    };
  }

  private accumulateSampleIntoFloatBuffer(
    samplePixels: Uint8ClampedArray,
    nextSample: number,
    render: RenderSettings,
  ): void {
    if (!this.accumLinear) return;
    const accum = this.accumLinear;
    const counts = this.pixelSampleCounts;
    const previousSamples = Math.max(0, nextSample - 1);
    const clampFireflies = Boolean(render.qualityClampFireflies);
    const maxBounces = clamp(Math.round(render.qualityMaxBounces), 1, 12);
    // Prototype mapping: more "bounces" relaxes the anti-firefly clamp to preserve more highlights.
    const fireflyThresholdScale = 2.0 + (maxBounces - 1) * 0.35;
    const fireflyFloor = 0.03;

    for (let i = 0, p = 0; i < samplePixels.length; i += 4, p += 1) {
      let r = srgbByteToLinear(samplePixels[i]);
      let g = srgbByteToLinear(samplePixels[i + 1]);
      let b = srgbByteToLinear(samplePixels[i + 2]);
      const a = samplePixels[i + 3] / 255;

      const priorCount = counts ? counts[p] : previousSamples;
      if (clampFireflies && priorCount > 0) {
        const invPriorCount = 1 / Math.max(1, priorCount);
        const avgR = accum[i] * invPriorCount;
        const avgG = accum[i + 1] * invPriorCount;
        const avgB = accum[i + 2] * invPriorCount;
        const effectiveThresholdScale = fireflyThresholdScale + Math.max(0, (10 - Math.min(priorCount, 10)) * 0.4);
        const effectiveFloor = fireflyFloor + Math.max(0, (6 - Math.min(priorCount, 6)) * 0.01);
        const scale = computeQualityFireflyClampScale(
          r,
          g,
          b,
          avgR,
          avgG,
          avgB,
          priorCount,
          maxBounces,
          effectiveThresholdScale,
          effectiveFloor,
        );
        if (scale < 0.999999) {
          r *= scale;
          g *= scale;
          b *= scale;
        }
      }

      accum[i] += r;
      accum[i + 1] += g;
      accum[i + 2] += b;
      accum[i + 3] += a;
      if (counts) {
        counts[p] = Math.min(65535, counts[p] + 1);
      }
    }
  }

  private writeFloatAccumulationPreview(currentSamples: number): void {
    if (!this.accumLinear || !this.previewImageData || !this.accumCtx) return;
    const invSamples = currentSamples > 0 ? 1 / currentSamples : 1;
    const accum = this.accumLinear;
    const counts = this.pixelSampleCounts;
    const out = this.previewImageData.data;
    for (let i = 0, p = 0; i < out.length; i += 4, p += 1) {
      const pixelInvSamples = counts ? (counts[p] > 0 ? 1 / counts[p] : 0) : invSamples;
      out[i] = linearToSrgbByte(accum[i] * pixelInvSamples);
      out[i + 1] = linearToSrgbByte(accum[i + 1] * pixelInvSamples);
      out[i + 2] = linearToSrgbByte(accum[i + 2] * pixelInvSamples);
      out[i + 3] = Math.round(clamp(accum[i + 3] * pixelInvSamples, 0, 1) * 255);
    }
    this.accumCtx.putImageData(this.previewImageData, 0, 0);
  }

  private looksLikeBlankCaptureFrame(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
  ): boolean {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    if (w <= 0 || h <= 0) return true;
    const probeCols = 5;
    const probeRows = 5;
    try {
      for (let ry = 0; ry < probeRows; ry += 1) {
        const y = Math.min(h - 1, Math.floor((ry + 0.5) * (h / probeRows)));
        for (let rx = 0; rx < probeCols; rx += 1) {
          const x = Math.min(w - 1, Math.floor((rx + 0.5) * (w / probeCols)));
          const base = (y * w + x) * 4;
          if (
            pixels[base] !== 0
            || pixels[base + 1] !== 0
            || pixels[base + 2] !== 0
            || pixels[base + 3] !== 0
          ) {
            return false;
          }
        }
      }
    } catch {
      // If pixel reads fail, treat capture as unusable and let the backend fall back.
      return true;
    }
    return true;
  }
}

export class QualityBackendRouter {
  private readonly taaPreview: QualityBackend;
  private readonly hybridGpuPreview: QualityBackend;
  private readonly path: QualityBackend;
  private _activeRenderer: ActiveQualityRenderer = 'none';

  constructor(
    engine: WebGPUEngine,
    scene: Scene,
    camera: ArcRotateCamera,
    runtimeContext: QualityBackendRuntimeContext,
  ) {
    this.taaPreview = new TaaPreviewQualityBackend(scene, camera);
    this.hybridGpuPreview = new PathQualityBackendV1(engine, scene, camera, 'hybrid_gpu_preview', runtimeContext);
    this.path = new PathQualityBackendV1(engine, scene, camera, 'cpu_path', runtimeContext);
  }

  get activeRenderer(): ActiveQualityRenderer {
    return this._activeRenderer;
  }

  sync(snapshot: RendererSceneSnapshot): QualityBackendSyncResult {
    const { render } = snapshot;
    if (render.mode !== 'quality') {
      this.disableAll();
      return { activeRenderer: 'none', fallbackReason: null, enabledJustNow: false };
    }

    if (render.qualityRenderer === 'path') {
      const pathResult = this.path.configure(render);
      if (pathResult.enabled) {
        this.hybridGpuPreview.disable();
        this.taaPreview.disable();
        this._activeRenderer = 'path';
        return {
          activeRenderer: 'path',
          fallbackReason: null,
          enabledJustNow: pathResult.enabledJustNow,
        };
      }

      const hybridResult = this.hybridGpuPreview.configure(render);
      if (hybridResult.enabled) {
        this.taaPreview.disable();
        const pathReason = pathResult.unsupportedReason ?? 'Path quality backend is unavailable';
        this._activeRenderer = 'hybrid_gpu_preview';
        return {
          activeRenderer: 'hybrid_gpu_preview',
          fallbackReason: `${pathReason} (using Hybrid GPU Preview fallback)`,
          enabledJustNow: hybridResult.enabledJustNow,
        };
      }

      const taaResult = this.taaPreview.configure(render);
      if (taaResult.enabled) {
        const pathReason = pathResult.unsupportedReason ?? 'Path quality backend is unavailable';
        const hybridReason = hybridResult.unsupportedReason ?? 'Hybrid GPU Preview backend is unavailable';
        this._activeRenderer = 'taa_preview';
        return {
          activeRenderer: 'taa_preview',
          fallbackReason: `${pathReason}; ${hybridReason} (using TAA preview fallback)`,
          enabledJustNow: taaResult.enabledJustNow,
        };
      }

      const pathReason = pathResult.unsupportedReason ?? 'Path quality backend is unavailable';
      const hybridReason = hybridResult.unsupportedReason ?? 'Hybrid GPU Preview backend is unavailable';
      this._activeRenderer = 'none';
      return {
        activeRenderer: 'none',
        fallbackReason: `${pathReason}; ${hybridReason}, and TAA preview fallback is not supported on this GPU/browser`,
        enabledJustNow: false,
      };
    }

    if (render.qualityRenderer === 'hybrid_gpu_preview') {
      this.path.disable();
      const hybridResult = this.hybridGpuPreview.configure(render);
      if (hybridResult.enabled) {
        this.taaPreview.disable();
        this._activeRenderer = 'hybrid_gpu_preview';
        return {
          activeRenderer: 'hybrid_gpu_preview',
          fallbackReason: null,
          enabledJustNow: hybridResult.enabledJustNow,
        };
      }

      const taaResult = this.taaPreview.configure(render);
      if (taaResult.enabled) {
        const hybridReason = hybridResult.unsupportedReason ?? 'Hybrid GPU Preview backend is unavailable';
        this._activeRenderer = 'taa_preview';
        return {
          activeRenderer: 'taa_preview',
          fallbackReason: `${hybridReason} (using TAA preview fallback)`,
          enabledJustNow: taaResult.enabledJustNow,
        };
      }

      this._activeRenderer = 'none';
      return {
        activeRenderer: 'none',
        fallbackReason: hybridResult.unsupportedReason ?? 'Hybrid GPU Preview backend is unavailable',
        enabledJustNow: false,
      };
    }

    this.path.disable();
    this.hybridGpuPreview.disable();
    const taaResult = this.taaPreview.configure(render);
    if (taaResult.enabled) {
      this._activeRenderer = 'taa_preview';
      return {
        activeRenderer: 'taa_preview',
        fallbackReason: null,
        enabledJustNow: taaResult.enabledJustNow,
      };
    }

    this._activeRenderer = 'none';
    return {
      activeRenderer: 'none',
      fallbackReason: taaResult.unsupportedReason,
      enabledJustNow: false,
    };
  }

  isActiveBackendEnabled(): boolean {
    if (this._activeRenderer === 'taa_preview') {
      return this.taaPreview.isEnabled();
    }
    if (this._activeRenderer === 'hybrid_gpu_preview') {
      return this.hybridGpuPreview.isEnabled();
    }
    if (this._activeRenderer === 'path') {
      return this.path.isEnabled();
    }
    return false;
  }

  tick(render: RenderSettings): QualityBackendTickResult {
    if (this._activeRenderer === 'taa_preview') {
      return this.taaPreview.tick(render);
    }
    if (this._activeRenderer === 'hybrid_gpu_preview') {
      return this.hybridGpuPreview.tick(render);
    }
    if (this._activeRenderer === 'path') {
      return this.path.tick(render);
    }
    return {
      shouldRender: true,
      progress: { currentSamples: 0, running: false },
    };
  }

  getActiveBackendProgress(render: RenderSettings): QualityBackendProgress {
    if (this._activeRenderer === 'taa_preview') {
      return this.taaPreview.getProgress(render);
    }
    if (this._activeRenderer === 'hybrid_gpu_preview') {
      return this.hybridGpuPreview.getProgress(render);
    }
    if (this._activeRenderer === 'path') {
      return this.path.getProgress(render);
    }
    return { currentSamples: 0, running: false };
  }

  onFrameRendered(render: RenderSettings, sourceCanvas: HTMLCanvasElement): void {
    if (this._activeRenderer === 'taa_preview') {
      this.taaPreview.onFrameRendered(render, sourceCanvas);
      return;
    }
    if (this._activeRenderer === 'hybrid_gpu_preview') {
      this.hybridGpuPreview.onFrameRendered(render, sourceCanvas);
      return;
    }
    if (this._activeRenderer === 'path') {
      this.path.onFrameRendered(render, sourceCanvas);
    }
  }

  isActiveBackendReadyForExport(render: RenderSettings): boolean {
    if (this._activeRenderer === 'taa_preview') {
      return this.taaPreview.isReadyForExport(render);
    }
    if (this._activeRenderer === 'hybrid_gpu_preview') {
      return this.hybridGpuPreview.isReadyForExport(render);
    }
    if (this._activeRenderer === 'path') {
      return this.path.isReadyForExport(render);
    }
    return false;
  }

  getActiveBackendExportCanvas(): HTMLCanvasElement | null {
    if (this._activeRenderer === 'taa_preview') {
      return this.taaPreview.getExportCanvas();
    }
    if (this._activeRenderer === 'hybrid_gpu_preview') {
      return this.hybridGpuPreview.getExportCanvas();
    }
    if (this._activeRenderer === 'path') {
      return this.path.getExportCanvas();
    }
    return null;
  }

  resetActiveBackendAccumulation(): void {
    if (this._activeRenderer === 'taa_preview') {
      this.taaPreview.resetAccumulation();
      return;
    }
    if (this._activeRenderer === 'hybrid_gpu_preview') {
      this.hybridGpuPreview.resetAccumulation();
      return;
    }
    if (this._activeRenderer === 'path') {
      this.path.resetAccumulation();
    }
  }

  resetActiveBackendHistory(reason?: string | null): void {
    if (this._activeRenderer === 'taa_preview') {
      this.taaPreview.resetHistory(reason);
      return;
    }
    if (this._activeRenderer === 'hybrid_gpu_preview') {
      this.hybridGpuPreview.resetHistory(reason);
      return;
    }
    if (this._activeRenderer === 'path') {
      this.path.resetHistory(reason);
    }
  }

  disableAll(): void {
    this.path.disable();
    this.hybridGpuPreview.disable();
    this.taaPreview.disable();
    this._activeRenderer = 'none';
  }

  dispose(): void {
    this.path.dispose();
    this.hybridGpuPreview.dispose();
    this.taaPreview.dispose();
    this._activeRenderer = 'none';
  }
}

const PATH_PICK_WORLD_MATRIX = Matrix.Identity();
const TRACE_MESH_BVH_LEAF_SIZE = 4;
const TRACE_TRIANGLE_ACCEL_MAX_TRIANGLES = 250_000;
const TRACE_TRIANGLE_BVH_LEAF_SIZE = 8;
const traceMeshBvhStackScratch: TraceMeshBvhNode[] = [];
const traceTriangleBvhStackScratch: TraceTriangleBvhNode[] = [];

function extractHybridSurfaceMaterial(material: Material | null | undefined): HybridSurfaceMaterial {
  if (material instanceof PBRMaterial) {
    return {
      baseColor: color3ToVector(material.albedoColor ?? Color3.White()),
      metallic: clamp(material.metallic ?? 0, 0, 1),
      roughness: clamp(material.roughness ?? 0.6, 0, 1),
      reflectance: clamp(Math.max(material.metallic ?? 0, (1 - (material.roughness ?? 0.6)) * 0.08), 0, 1),
      ior: Math.max(1, material.subSurface?.isRefractionEnabled ? (material.subSurface.indexOfRefraction ?? material.indexOfRefraction ?? 1.45) : (material.indexOfRefraction ?? 1.45)),
      opacity: clamp(material.alpha ?? 1, 0, 1),
    };
  }

  if (material instanceof StandardMaterial) {
    const base = material.diffuseColor ?? Color3.White();
    const spec = material.specularColor ?? Color3.Black();
    const metallicLike = clamp((spec.r + spec.g + spec.b) / 3, 0, 1);
    return {
      baseColor: color3ToVector(base),
      metallic: metallicLike * 0.15,
      roughness: 0.55,
      reflectance: metallicLike * 0.2,
      ior: 1.45,
      opacity: clamp(material.alpha ?? 1, 0, 1),
    };
  }

  return {
    baseColor: new Vector3(0.8, 0.82, 0.85),
    metallic: 0,
    roughness: 0.6,
    reflectance: 0.04,
    ior: 1.45,
    opacity: 1,
  };
}

interface TraceTriangleHitResult {
  distance: number;
  point: Vector3;
  normal: Vector3;
}

function buildTraceTriangleAccel(mesh: AbstractMesh): TraceTriangleAccel | null {
  if (!(mesh instanceof Mesh)) {
    return null;
  }
  if (mesh instanceof LinesMesh) {
    // Lines meshes are indexed as line segments, not triangles. Treating their index
    // buffer as triangle soup produces bogus path-traced hits (especially curve plots).
    // Fall back to Babylon ray picking for the CPU path tracer instead.
    return null;
  }

  const skinnedOrInstancedMesh = mesh as Mesh & { skeleton?: unknown; hasThinInstances?: boolean };
  if (skinnedOrInstancedMesh.skeleton || skinnedOrInstancedMesh.hasThinInstances) {
    return null;
  }

  const indices = mesh.getIndices();
  const positions = mesh.getVerticesData('position');
  if (!indices || !positions) {
    return null;
  }
  const triangleCount = Math.floor(indices.length / 3);
  if (triangleCount <= 0 || triangleCount > TRACE_TRIANGLE_ACCEL_MAX_TRIANGLES) {
    return null;
  }

  const world = mesh.getWorldMatrix();
  const worldM = world.m;
  const positionsWorld = new Float32Array(triangleCount * 9);
  const normals = mesh.getVerticesData('normal');
  let normalsWorld: Float32Array | null = null;
  let normalM: ArrayLike<number> | null = null;
  if (normals && normals.length >= positions.length) {
    try {
      const normalMatrix = world.clone();
      normalMatrix.invert();
      normalMatrix.transpose();
      normalM = normalMatrix.m;
      normalsWorld = new Float32Array(triangleCount * 9);
    } catch {
      normalM = worldM;
      normalsWorld = new Float32Array(triangleCount * 9);
    }
  }

  let outBase = 0;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;
    if (
      i0 < 0 || i1 < 0 || i2 < 0
      || i0 + 2 >= positions.length
      || i1 + 2 >= positions.length
      || i2 + 2 >= positions.length
    ) {
      return null;
    }

    writeTransformedPosition(positionsWorld, outBase + 0, positions[i0], positions[i0 + 1], positions[i0 + 2], worldM);
    writeTransformedPosition(positionsWorld, outBase + 3, positions[i1], positions[i1 + 1], positions[i1 + 2], worldM);
    writeTransformedPosition(positionsWorld, outBase + 6, positions[i2], positions[i2 + 1], positions[i2 + 2], worldM);

    if (normalsWorld && normals && normalM) {
      if (
        i0 + 2 >= normals.length
        || i1 + 2 >= normals.length
        || i2 + 2 >= normals.length
      ) {
        normalsWorld = null;
      } else {
        writeTransformedNormal(normalsWorld, outBase + 0, normals[i0], normals[i0 + 1], normals[i0 + 2], normalM);
        writeTransformedNormal(normalsWorld, outBase + 3, normals[i1], normals[i1 + 1], normals[i1 + 2], normalM);
        writeTransformedNormal(normalsWorld, outBase + 6, normals[i2], normals[i2 + 1], normals[i2 + 2], normalM);
        normalizeVec3ArrayInPlace(normalsWorld, outBase + 0);
        normalizeVec3ArrayInPlace(normalsWorld, outBase + 3);
        normalizeVec3ArrayInPlace(normalsWorld, outBase + 6);
      }
    }

    outBase += 9;
  }

  const triangleBvhRoot = triangleCount > TRACE_TRIANGLE_BVH_LEAF_SIZE
    ? buildTraceTriangleLocalBvh(positionsWorld, triangleCount)
    : null;

  return {
    positionsWorld,
    normalsWorld,
    triangleCount,
    triangleBvhRoot,
  };
}

function buildTraceLineAccel(mesh: AbstractMesh): TraceLineAccel | null {
  if (!(mesh instanceof LinesMesh)) {
    return null;
  }

  const lineLikeMesh = mesh as LinesMesh & { skeleton?: unknown; hasThinInstances?: boolean };
  if (lineLikeMesh.skeleton || lineLikeMesh.hasThinInstances) {
    return null;
  }

  const positions = mesh.getVerticesData('position');
  if (!positions || positions.length < 6) {
    return null;
  }

  const indices = mesh.getIndices();
  const indexed = Boolean(indices && indices.length >= 2);
  const segmentCount = indexed
    ? Math.floor((indices?.length ?? 0) / 2)
    : Math.floor(positions.length / 6);
  if (segmentCount <= 0) {
    return null;
  }

  const worldM = mesh.getWorldMatrix().m;
  const positionsWorld = new Float32Array(segmentCount * 6);
  let outBase = 0;

  if (indexed && indices) {
    for (let i = 0; i + 1 < indices.length; i += 2) {
      const i0 = indices[i] * 3;
      const i1 = indices[i + 1] * 3;
      if (
        i0 < 0 || i1 < 0
        || i0 + 2 >= positions.length
        || i1 + 2 >= positions.length
      ) {
        return null;
      }
      writeTransformedPosition(positionsWorld, outBase + 0, positions[i0], positions[i0 + 1], positions[i0 + 2], worldM);
      writeTransformedPosition(positionsWorld, outBase + 3, positions[i1], positions[i1 + 1], positions[i1 + 2], worldM);
      outBase += 6;
    }
  } else {
    for (let i = 0; i + 5 < positions.length; i += 6) {
      writeTransformedPosition(positionsWorld, outBase + 0, positions[i + 0], positions[i + 1], positions[i + 2], worldM);
      writeTransformedPosition(positionsWorld, outBase + 3, positions[i + 3], positions[i + 4], positions[i + 5], worldM);
      outBase += 6;
    }
  }

  return {
    positionsWorld,
    segmentCount,
    intersectionThreshold: Math.max(1e-4, Number.isFinite(mesh.intersectionThreshold) ? mesh.intersectionThreshold : 0.1),
  };
}

function intersectTraceTriangleSoupClosest(
  ray: Ray,
  accel: TraceTriangleAccel | null,
  maxDistance: number,
): TraceTriangleHitResult | null {
  if (!accel || accel.triangleCount <= 0) {
    return null;
  }
  if (accel.triangleBvhRoot) {
    return intersectTraceTriangleLocalBvhClosest(ray, accel, maxDistance);
  }

  const positions = accel.positionsWorld;
  const normals = accel.normalsWorld;
  const ox = ray.origin.x;
  const oy = ray.origin.y;
  const oz = ray.origin.z;
  const dx = ray.direction.x;
  const dy = ray.direction.y;
  const dz = ray.direction.z;
  const epsilon = 1e-8;
  const minT = 1e-5;
  let bestT = Number.isFinite(maxDistance) ? Math.max(minT, maxDistance) : Number.POSITIVE_INFINITY;
  let hitBase = -1;
  let hitU = 0;
  let hitV = 0;

  for (let base = 0; base < positions.length; base += 9) {
    const ax = positions[base];
    const ay = positions[base + 1];
    const az = positions[base + 2];
    const bx = positions[base + 3];
    const by = positions[base + 4];
    const bz = positions[base + 5];
    const cx = positions[base + 6];
    const cy = positions[base + 7];
    const cz = positions[base + 8];

    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;

    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) <= epsilon) {
      continue;
    }
    const invDet = 1 / det;

    const tx = ox - ax;
    const ty = oy - ay;
    const tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * invDet;
    if (u < -1e-6 || u > 1 + 1e-6) {
      continue;
    }

    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * invDet;
    if (v < -1e-6 || u + v > 1 + 1e-6) {
      continue;
    }

    const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
    if (!(t > minT) || t >= bestT) {
      continue;
    }
    bestT = t;
    hitBase = base;
    hitU = u;
    hitV = v;
  }

  if (hitBase < 0 || !Number.isFinite(bestT)) {
    return null;
  }

  const point = new Vector3(
    ox + dx * bestT,
    oy + dy * bestT,
    oz + dz * bestT,
  );
  const normal = sampleTraceTriangleNormal(positions, normals, hitBase, hitU, hitV);
  return {
    distance: bestT,
    point,
    normal,
  };
}

function buildTraceTriangleLocalBvh(
  positionsWorld: Float32Array,
  triangleCount: number,
): TraceTriangleBvhNode | null {
  if (triangleCount <= TRACE_TRIANGLE_BVH_LEAF_SIZE) {
    return null;
  }

  const centroidX = new Float32Array(triangleCount);
  const centroidY = new Float32Array(triangleCount);
  const centroidZ = new Float32Array(triangleCount);
  const triangleIndices = new Array<number>(triangleCount);
  for (let tri = 0; tri < triangleCount; tri += 1) {
    const base = tri * 9;
    centroidX[tri] = (positionsWorld[base] + positionsWorld[base + 3] + positionsWorld[base + 6]) / 3;
    centroidY[tri] = (positionsWorld[base + 1] + positionsWorld[base + 4] + positionsWorld[base + 7]) / 3;
    centroidZ[tri] = (positionsWorld[base + 2] + positionsWorld[base + 5] + positionsWorld[base + 8]) / 3;
    triangleIndices[tri] = tri;
  }

  return buildTraceTriangleLocalBvhRecursive(
    triangleIndices,
    positionsWorld,
    centroidX,
    centroidY,
    centroidZ,
  );
}

function buildTraceTriangleLocalBvhRecursive(
  triangleIndices: number[],
  positionsWorld: Float32Array,
  centroidX: Float32Array,
  centroidY: Float32Array,
  centroidZ: Float32Array,
): TraceTriangleBvhNode {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let centerMinX = Number.POSITIVE_INFINITY;
  let centerMinY = Number.POSITIVE_INFINITY;
  let centerMinZ = Number.POSITIVE_INFINITY;
  let centerMaxX = Number.NEGATIVE_INFINITY;
  let centerMaxY = Number.NEGATIVE_INFINITY;
  let centerMaxZ = Number.NEGATIVE_INFINITY;

  for (const triIndex of triangleIndices) {
    const base = triIndex * 9;
    const ax = positionsWorld[base];
    const ay = positionsWorld[base + 1];
    const az = positionsWorld[base + 2];
    const bx = positionsWorld[base + 3];
    const by = positionsWorld[base + 4];
    const bz = positionsWorld[base + 5];
    const cx = positionsWorld[base + 6];
    const cy = positionsWorld[base + 7];
    const cz = positionsWorld[base + 8];
    if (ax < minX) minX = ax;
    if (ay < minY) minY = ay;
    if (az < minZ) minZ = az;
    if (ax > maxX) maxX = ax;
    if (ay > maxY) maxY = ay;
    if (az > maxZ) maxZ = az;
    if (bx < minX) minX = bx;
    if (by < minY) minY = by;
    if (bz < minZ) minZ = bz;
    if (bx > maxX) maxX = bx;
    if (by > maxY) maxY = by;
    if (bz > maxZ) maxZ = bz;
    if (cx < minX) minX = cx;
    if (cy < minY) minY = cy;
    if (cz < minZ) minZ = cz;
    if (cx > maxX) maxX = cx;
    if (cy > maxY) maxY = cy;
    if (cz > maxZ) maxZ = cz;

    const centerX = centroidX[triIndex];
    const centerY = centroidY[triIndex];
    const centerZ = centroidZ[triIndex];
    if (centerX < centerMinX) centerMinX = centerX;
    if (centerY < centerMinY) centerMinY = centerY;
    if (centerZ < centerMinZ) centerMinZ = centerZ;
    if (centerX > centerMaxX) centerMaxX = centerX;
    if (centerY > centerMaxY) centerMaxY = centerY;
    if (centerZ > centerMaxZ) centerMaxZ = centerZ;
  }

  if (triangleIndices.length <= TRACE_TRIANGLE_BVH_LEAF_SIZE) {
    return {
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
      left: null,
      right: null,
      triangleIndices: Uint32Array.from(triangleIndices),
    };
  }

  const extentX = centerMaxX - centerMinX;
  const extentY = centerMaxY - centerMinY;
  const extentZ = centerMaxZ - centerMinZ;
  if (extentX <= 1e-9 && extentY <= 1e-9 && extentZ <= 1e-9) {
    return {
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
      left: null,
      right: null,
      triangleIndices: Uint32Array.from(triangleIndices),
    };
  }

  let axis: 'x' | 'y' | 'z' = 'x';
  if (extentY > extentX && extentY >= extentZ) {
    axis = 'y';
  } else if (extentZ > extentX && extentZ >= extentY) {
    axis = 'z';
  }

  triangleIndices.sort((a, b) => (
    axis === 'x' ? centroidX[a] - centroidX[b]
      : axis === 'y' ? centroidY[a] - centroidY[b]
        : centroidZ[a] - centroidZ[b]
  ));
  const split = Math.floor(triangleIndices.length / 2);
  if (split <= 0 || split >= triangleIndices.length) {
    return {
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
      left: null,
      right: null,
      triangleIndices: Uint32Array.from(triangleIndices),
    };
  }

  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    left: buildTraceTriangleLocalBvhRecursive(
      triangleIndices.slice(0, split),
      positionsWorld,
      centroidX,
      centroidY,
      centroidZ,
    ),
    right: buildTraceTriangleLocalBvhRecursive(
      triangleIndices.slice(split),
      positionsWorld,
      centroidX,
      centroidY,
      centroidZ,
    ),
    triangleIndices: null,
  };
}

function intersectTraceTriangleLocalBvhClosest(
  ray: Ray,
  accel: TraceTriangleAccel,
  maxDistance: number,
): TraceTriangleHitResult | null {
  const root = accel.triangleBvhRoot;
  if (!root) {
    return null;
  }

  const positions = accel.positionsWorld;
  const normals = accel.normalsWorld;
  const ox = ray.origin.x;
  const oy = ray.origin.y;
  const oz = ray.origin.z;
  const dx = ray.direction.x;
  const dy = ray.direction.y;
  const dz = ray.direction.z;
  const epsilon = 1e-8;
  const minT = 1e-5;
  let bestT = Number.isFinite(maxDistance) ? Math.max(minT, maxDistance) : Number.POSITIVE_INFINITY;
  let hitBase = -1;
  let hitU = 0;
  let hitV = 0;
  const stack = traceTriangleBvhStackScratch;
  stack.length = 0;
  stack.push(root);

  while (stack.length > 0) {
    const node = stack.pop()!;
    const nodeHitDist = rayIntersectsTraceAabb(
      ray,
      node.minX,
      node.minY,
      node.minZ,
      node.maxX,
      node.maxY,
      node.maxZ,
      bestT,
    );
    if (nodeHitDist === null) {
      continue;
    }

    if (node.triangleIndices) {
      for (let i = 0; i < node.triangleIndices.length; i += 1) {
        const triIndex = node.triangleIndices[i];
        const base = triIndex * 9;
        const ax = positions[base];
        const ay = positions[base + 1];
        const az = positions[base + 2];
        const bx = positions[base + 3];
        const by = positions[base + 4];
        const bz = positions[base + 5];
        const cx = positions[base + 6];
        const cy = positions[base + 7];
        const cz = positions[base + 8];

        const e1x = bx - ax;
        const e1y = by - ay;
        const e1z = bz - az;
        const e2x = cx - ax;
        const e2y = cy - ay;
        const e2z = cz - az;

        const px = dy * e2z - dz * e2y;
        const py = dz * e2x - dx * e2z;
        const pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) <= epsilon) {
          continue;
        }
        const invDet = 1 / det;

        const tx = ox - ax;
        const ty = oy - ay;
        const tz = oz - az;
        const u = (tx * px + ty * py + tz * pz) * invDet;
        if (u < -1e-6 || u > 1 + 1e-6) {
          continue;
        }

        const qx = ty * e1z - tz * e1y;
        const qy = tz * e1x - tx * e1z;
        const qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * invDet;
        if (v < -1e-6 || u + v > 1 + 1e-6) {
          continue;
        }

        const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
        if (!(t > minT) || t >= bestT) {
          continue;
        }
        bestT = t;
        hitBase = base;
        hitU = u;
        hitV = v;
      }
      continue;
    }

    const left = node.left;
    const right = node.right;
    if (!left && !right) {
      continue;
    }
    if (left && right) {
      const leftHit = rayIntersectsTraceAabb(ray, left.minX, left.minY, left.minZ, left.maxX, left.maxY, left.maxZ, bestT);
      const rightHit = rayIntersectsTraceAabb(ray, right.minX, right.minY, right.minZ, right.maxX, right.maxY, right.maxZ, bestT);
      if (leftHit !== null && rightHit !== null) {
        if (leftHit < rightHit) {
          stack.push(right, left);
        } else {
          stack.push(left, right);
        }
        continue;
      }
      if (leftHit !== null) {
        stack.push(left);
      }
      if (rightHit !== null) {
        stack.push(right);
      }
      continue;
    }
    if (left) {
      stack.push(left);
    }
    if (right) {
      stack.push(right);
    }
  }

  if (hitBase < 0 || !Number.isFinite(bestT)) {
    return null;
  }
  return {
    distance: bestT,
    point: new Vector3(
      ox + dx * bestT,
      oy + dy * bestT,
      oz + dz * bestT,
    ),
    normal: sampleTraceTriangleNormal(positions, normals, hitBase, hitU, hitV),
  };
}

function buildTraceMeshBvh(entries: TraceMeshAccelEntry[]): TraceMeshBvhNode | null {
  if (entries.length === 0) {
    return null;
  }
  return buildTraceMeshBvhRecursive(entries.slice());
}

function buildTraceMeshBvhRecursive(entries: TraceMeshAccelEntry[]): TraceMeshBvhNode {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let centerMinX = Number.POSITIVE_INFINITY;
  let centerMinY = Number.POSITIVE_INFINITY;
  let centerMinZ = Number.POSITIVE_INFINITY;
  let centerMaxX = Number.NEGATIVE_INFINITY;
  let centerMaxY = Number.NEGATIVE_INFINITY;
  let centerMaxZ = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    if (entry.minX < minX) minX = entry.minX;
    if (entry.minY < minY) minY = entry.minY;
    if (entry.minZ < minZ) minZ = entry.minZ;
    if (entry.maxX > maxX) maxX = entry.maxX;
    if (entry.maxY > maxY) maxY = entry.maxY;
    if (entry.maxZ > maxZ) maxZ = entry.maxZ;
    if (entry.centerX < centerMinX) centerMinX = entry.centerX;
    if (entry.centerY < centerMinY) centerMinY = entry.centerY;
    if (entry.centerZ < centerMinZ) centerMinZ = entry.centerZ;
    if (entry.centerX > centerMaxX) centerMaxX = entry.centerX;
    if (entry.centerY > centerMaxY) centerMaxY = entry.centerY;
    if (entry.centerZ > centerMaxZ) centerMaxZ = entry.centerZ;
  }

  if (entries.length <= TRACE_MESH_BVH_LEAF_SIZE) {
    return {
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
      left: null,
      right: null,
      items: entries,
    };
  }

  const extentX = centerMaxX - centerMinX;
  const extentY = centerMaxY - centerMinY;
  const extentZ = centerMaxZ - centerMinZ;
  let axis: 'x' | 'y' | 'z' = 'x';
  if (extentY > extentX && extentY >= extentZ) {
    axis = 'y';
  } else if (extentZ > extentX && extentZ >= extentY) {
    axis = 'z';
  }

  entries.sort((a, b) => (
    axis === 'x' ? a.centerX - b.centerX
      : axis === 'y' ? a.centerY - b.centerY
        : a.centerZ - b.centerZ
  ));
  const split = Math.floor(entries.length / 2);
  if (split <= 0 || split >= entries.length) {
    return {
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
      left: null,
      right: null,
      items: entries,
    };
  }

  const leftEntries = entries.slice(0, split);
  const rightEntries = entries.slice(split);
  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    left: buildTraceMeshBvhRecursive(leftEntries),
    right: buildTraceMeshBvhRecursive(rightEntries),
    items: null,
  };
}

function writeTransformedPosition(
  out: Float32Array,
  offset: number,
  x: number,
  y: number,
  z: number,
  m: ArrayLike<number>,
): void {
  const tx = x * m[0] + y * m[4] + z * m[8] + m[12];
  const ty = x * m[1] + y * m[5] + z * m[9] + m[13];
  const tz = x * m[2] + y * m[6] + z * m[10] + m[14];
  const tw = x * m[3] + y * m[7] + z * m[11] + m[15];
  if (Math.abs(tw) > 1e-12 && Math.abs(tw - 1) > 1e-12) {
    out[offset] = tx / tw;
    out[offset + 1] = ty / tw;
    out[offset + 2] = tz / tw;
    return;
  }
  out[offset] = tx;
  out[offset + 1] = ty;
  out[offset + 2] = tz;
}

function writeTransformedNormal(
  out: Float32Array,
  offset: number,
  x: number,
  y: number,
  z: number,
  m: ArrayLike<number>,
): void {
  out[offset] = x * m[0] + y * m[4] + z * m[8];
  out[offset + 1] = x * m[1] + y * m[5] + z * m[9];
  out[offset + 2] = x * m[2] + y * m[6] + z * m[10];
}

function normalizeVec3ArrayInPlace(out: Float32Array, offset: number): void {
  const x = out[offset];
  const y = out[offset + 1];
  const z = out[offset + 2];
  const len2 = x * x + y * y + z * z;
  if (len2 <= 1e-20) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 1;
    return;
  }
  const invLen = 1 / Math.sqrt(len2);
  out[offset] = x * invLen;
  out[offset + 1] = y * invLen;
  out[offset + 2] = z * invLen;
}

function sampleTraceTriangleNormal(
  positionsWorld: Float32Array,
  normalsWorld: Float32Array | null,
  base: number,
  u: number,
  v: number,
): Vector3 {
  if (normalsWorld) {
    const w = 1 - u - v;
    const nx = normalsWorld[base] * w + normalsWorld[base + 3] * u + normalsWorld[base + 6] * v;
    const ny = normalsWorld[base + 1] * w + normalsWorld[base + 4] * u + normalsWorld[base + 7] * v;
    const nz = normalsWorld[base + 2] * w + normalsWorld[base + 5] * u + normalsWorld[base + 8] * v;
    const len2 = nx * nx + ny * ny + nz * nz;
    if (len2 > 1e-20) {
      const invLen = 1 / Math.sqrt(len2);
      return new Vector3(nx * invLen, ny * invLen, nz * invLen);
    }
  }

  const ax = positionsWorld[base];
  const ay = positionsWorld[base + 1];
  const az = positionsWorld[base + 2];
  const bx = positionsWorld[base + 3];
  const by = positionsWorld[base + 4];
  const bz = positionsWorld[base + 5];
  const cx = positionsWorld[base + 6];
  const cy = positionsWorld[base + 7];
  const cz = positionsWorld[base + 8];
  const e1x = bx - ax;
  const e1y = by - ay;
  const e1z = bz - az;
  const e2x = cx - ax;
  const e2y = cy - ay;
  const e2z = cz - az;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const len2 = nx * nx + ny * ny + nz * nz;
  if (len2 <= 1e-20) {
    return new Vector3(0, 0, 1);
  }
  const invLen = 1 / Math.sqrt(len2);
  return new Vector3(nx * invLen, ny * invLen, nz * invLen);
}

function rayIntersectsTraceAabb(
  ray: Ray,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  maxDistance: number,
): number | null {
  const ox = ray.origin.x;
  const oy = ray.origin.y;
  const oz = ray.origin.z;
  const dx = ray.direction.x;
  const dy = ray.direction.y;
  const dz = ray.direction.z;
  let tMin = 0;
  let tMax = Number.isFinite(maxDistance) ? Math.max(0, maxDistance) : Number.POSITIVE_INFINITY;

  if (Math.abs(dx) < 1e-12) {
    if (ox < minX || ox > maxX) return null;
  } else {
    const invDx = 1 / dx;
    let t1 = (minX - ox) * invDx;
    let t2 = (maxX - ox) * invDx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMax < tMin) return null;
  }

  if (Math.abs(dy) < 1e-12) {
    if (oy < minY || oy > maxY) return null;
  } else {
    const invDy = 1 / dy;
    let t1 = (minY - oy) * invDy;
    let t2 = (maxY - oy) * invDy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMax < tMin) return null;
  }

  if (Math.abs(dz) < 1e-12) {
    if (oz < minZ || oz > maxZ) return null;
  } else {
    const invDz = 1 / dz;
    let t1 = (minZ - oz) * invDz;
    let t2 = (maxZ - oz) * invDz;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMax < tMin) return null;
  }

  if (tMax < 0) {
    return null;
  }
  return tMin >= 0 ? tMin : 0;
}

function getMeshWorldMatrixUpdateFlag(mesh: AbstractMesh): number {
  const worldMatrix = mesh.getWorldMatrix?.();
  const updateFlag = (worldMatrix as { updateFlag?: number } | undefined)?.updateFlag;
  return typeof updateFlag === 'number' && Number.isFinite(updateFlag) ? updateFlag : 0;
}

function approxEqual(a: number, b: number, epsilon = 1e-8): boolean {
  return Math.abs(a - b) <= epsilon;
}

function matrixElementsApproxEqual(a: ArrayLike<number>, b: ArrayLike<number>, epsilon = 1e-8): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (!approxEqual(a[i], b[i], epsilon)) {
      return false;
    }
  }
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01Safe(value: number): number {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1);
}

function opacityDrivenTransmission(opacity: number): number {
  return clamp01Safe(1 - opacity);
}

function clampFinite(value: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 64) : 0;
}

function color3ToVector(color: Color3): Vector3 {
  return new Vector3(color.r, color.g, color.b);
}

function vector3ToWorkerVec3(vector: Vector3): PathTraceWorkerVec3 {
  return { x: vector.x, y: vector.y, z: vector.z };
}

function multiplyVec3InPlace(a: Vector3, b: Vector3): Vector3 {
  a.x *= b.x;
  a.y *= b.y;
  a.z *= b.z;
  return a;
}

function srgbByteToLinear(value: number): number {
  const s = clamp(value, 0, 255) / 255;
  if (s <= 0.04045) {
    return s / 12.92;
  }
  return Math.pow((s + 0.055) / 1.055, 2.4);
}

function linearToSrgbByte(value: number): number {
  const l = clamp(value, 0, 1);
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.round(clamp(s, 0, 1) * 255);
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function finiteDirectLightSamplingWeight(light: DirectionalLight | PointLight): number {
  const intensity = Number.isFinite(light.intensity) ? Math.max(0, light.intensity) : 0;
  const diffuse = light.diffuse;
  const r = Number.isFinite(diffuse?.r) ? diffuse!.r : 1;
  const g = Number.isFinite(diffuse?.g) ? diffuse!.g : 1;
  const b = Number.isFinite(diffuse?.b) ? diffuse!.b : 1;
  const colorLum = Math.max(0.05, luminance(r, g, b));
  return Math.max(0.05, intensity * colorLum);
}

function computeQualityFireflyClampScale(
  sampleR: number,
  sampleG: number,
  sampleB: number,
  avgR: number,
  avgG: number,
  avgB: number,
  previousSamples: number,
  maxBounces: number,
  thresholdScaleOverride?: number,
  floorOverride?: number,
): number {
  const prior = Math.max(0, Math.floor(previousSamples));
  // Avoid over-clamping legitimate highlights during very early convergence.
  if (prior < 2) {
    return 1;
  }
  const sampleLum = luminance(sampleR, sampleG, sampleB);
  if (!(sampleLum > 1e-6)) {
    return 1;
  }
  const avgLum = luminance(avgR, avgG, avgB);
  const boundedBounces = clamp(Math.round(maxBounces), 1, 12);
  const baseThresholdScale = 2.4 + (boundedBounces - 1) * 0.4;
  const lowSampleRelax = Math.max(0, (10 - Math.min(prior, 10)) * 0.4);
  const thresholdScale = thresholdScaleOverride ?? (baseThresholdScale + lowSampleRelax);
  const baseFloor = 0.04 + (boundedBounces - 1) * 0.01;
  const lowSampleFloorBoost = Math.max(0, (6 - Math.min(prior, 6)) * 0.01);
  const floor = floorOverride ?? (baseFloor + lowSampleFloorBoost);
  const maxLum = Math.max(floor, avgLum * thresholdScale);
  if (sampleLum <= maxLum) {
    return 1;
  }
  return clamp(maxLum / sampleLum, 0, 1);
}

function sampleHash01(pixelIndex: number, sampleIndex: number, dimension: number): number {
  let x = (pixelIndex | 0) ^ Math.imul((sampleIndex + 1) | 0, 0x9e3779b1) ^ Math.imul((dimension + 1) | 0, 0x85ebca6b);
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return ((x >>> 0) + 0.5) / 4294967296;
}

function buildTracePixelPermutation(totalPixels: number, sampleIndex: number): { stride: number; offset: number } {
  const total = Math.max(1, Math.floor(totalPixels));
  if (total <= 1) {
    return { stride: 1, offset: 0 };
  }
  let stride = Math.floor(sampleHash01(total, sampleIndex, 301) * total) | 1;
  stride %= total;
  if (stride <= 0) {
    stride = 1;
  }
  stride = findNearestCoprimeStride(total, stride);
  const offset = Math.floor(sampleHash01(total, sampleIndex, 302) * total) % total;
  return { stride, offset };
}

function permuteTracePixelIndex(cursor: number, totalPixels: number, stride: number, offset: number): number {
  const total = Math.max(1, Math.floor(totalPixels));
  if (total <= 1) {
    return 0;
  }
  const i = Math.max(0, Math.floor(cursor)) % total;
  // Use normal JS integer math here, not Math.imul: imul wraps at 32 bits and
  // breaks the permutation for large frame sizes (causing duplicate pixels and holes).
  const value = (i * stride + offset) % total;
  return value < 0 ? value + total : value;
}

function findNearestCoprimeStride(modulus: number, start: number): number {
  const m = Math.max(1, Math.floor(modulus));
  if (m <= 2) {
    return 1;
  }
  let candidate = Math.max(1, Math.floor(start)) % m;
  if (candidate <= 0) {
    candidate = 1;
  }
  if ((candidate & 1) === 0) {
    candidate += 1;
  }
  for (let attempts = 0; attempts < m; attempts += 1) {
    if (gcdInt(candidate, m) === 1) {
      return candidate;
    }
    candidate += 2;
    if (candidate >= m) {
      candidate = ((candidate % m) | 1);
      if (candidate <= 0) {
        candidate = 1;
      }
    }
  }
  return 1;
}

function gcdInt(a: number, b: number): number {
  let x = Math.abs(Math.floor(a));
  let y = Math.abs(Math.floor(b));
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

function normalizeVec3ToRef(input: Vector3, out: Vector3): boolean {
  const x = input.x;
  const y = input.y;
  const z = input.z;
  const lenSq = x * x + y * y + z * z;
  if (lenSq < 1e-10) {
    return false;
  }
  const invLen = 1 / Math.sqrt(lenSq);
  out.x = x * invLen;
  out.y = y * invLen;
  out.z = z * invLen;
  return true;
}

function makeOrthonormalBasisToRef(normal: Vector3, tangentOut: Vector3, bitangentOut: Vector3): boolean {
  let nx = normal.x;
  let ny = normal.y;
  let nz = normal.z;
  const nLenSq = nx * nx + ny * ny + nz * nz;
  if (nLenSq < 1e-10) {
    return false;
  }
  const invNLen = 1 / Math.sqrt(nLenSq);
  nx *= invNLen;
  ny *= invNLen;
  nz *= invNLen;

  const upAx = 0;
  const upAy = Math.abs(nz) < 0.95 ? 0 : 1;
  const upAz = Math.abs(nz) < 0.95 ? 1 : 0;
  let tx = upAy * nz - upAz * ny;
  let ty = upAz * nx - upAx * nz;
  let tz = upAx * ny - upAy * nx;
  let tLenSq = tx * tx + ty * ty + tz * tz;
  if (tLenSq < 1e-10) {
    tx = 0;
    ty = -nz;
    tz = ny;
    tLenSq = tx * tx + ty * ty + tz * tz;
    if (tLenSq < 1e-10) {
      return false;
    }
  }
  const invTLen = 1 / Math.sqrt(tLenSq);
  tx *= invTLen;
  ty *= invTLen;
  tz *= invTLen;
  tangentOut.x = tx;
  tangentOut.y = ty;
  tangentOut.z = tz;

  let bx = ny * tz - nz * ty;
  let by = nz * tx - nx * tz;
  let bz = nx * ty - ny * tx;
  const bLenSq = bx * bx + by * by + bz * bz;
  if (bLenSq < 1e-10) {
    return false;
  }
  const invBLen = 1 / Math.sqrt(bLenSq);
  bitangentOut.x = bx * invBLen;
  bitangentOut.y = by * invBLen;
  bitangentOut.z = bz * invBLen;
  return true;
}

function cosineSampleHemisphereToRef(
  normal: Vector3,
  pixelIndex: number,
  sampleIndex: number,
  bounce: number,
  dimensionOffset: number,
  out: Vector3,
  tangentScratch: Vector3,
  bitangentScratch: Vector3,
): boolean {
  if (!normalizeVec3ToRef(normal, out)) {
    return false;
  }
  const nx = out.x;
  const ny = out.y;
  const nz = out.z;
  if (!makeOrthonormalBasisToRef(out, tangentScratch, bitangentScratch)) {
    return false;
  }
  const tx = tangentScratch.x;
  const ty = tangentScratch.y;
  const tz = tangentScratch.z;
  const bx = bitangentScratch.x;
  const by = bitangentScratch.y;
  const bz = bitangentScratch.z;

  const u1 = sampleHash01(pixelIndex, sampleIndex + bounce * 53, dimensionOffset);
  const u2 = sampleHash01(pixelIndex, sampleIndex + bounce * 53, dimensionOffset + 1);
  const r = Math.sqrt(u1);
  const theta = 2 * Math.PI * u2;
  const sx = r * Math.cos(theta);
  const sy = r * Math.sin(theta);
  const sz = Math.sqrt(Math.max(0, 1 - u1));
  const dx = tx * sx + bx * sy + nx * sz;
  const dy = ty * sx + by * sy + ny * sz;
  const dz = tz * sx + bz * sy + nz * sz;
  const dLenSq = dx * dx + dy * dy + dz * dz;
  if (dLenSq < 1e-10) {
    return false;
  }
  const invDLen = 1 / Math.sqrt(dLenSq);
  out.x = dx * invDLen;
  out.y = dy * invDLen;
  out.z = dz * invDLen;
  return true;
}

function jitterDirectionToRef(
  direction: Vector3,
  roughness: number,
  pixelIndex: number,
  sampleIndex: number,
  bounce: number,
  dimensionOffset: number,
  out: Vector3,
  tangentScratch: Vector3,
  bitangentScratch: Vector3,
): boolean {
  if (!normalizeVec3ToRef(direction, out)) {
    return false;
  }
  if (roughness <= 1e-4) {
    return true;
  }
  if (!makeOrthonormalBasisToRef(out, tangentScratch, bitangentScratch)) {
    return true;
  }
  const spread = roughness * roughness;
  const u1 = sampleHash01(pixelIndex, sampleIndex + bounce * 61, dimensionOffset) * 2 - 1;
  const u2 = sampleHash01(pixelIndex, sampleIndex + bounce * 61, dimensionOffset + 1) * 2 - 1;
  const dx = out.x + tangentScratch.x * (u1 * spread) + bitangentScratch.x * (u2 * spread);
  const dy = out.y + tangentScratch.y * (u1 * spread) + bitangentScratch.y * (u2 * spread);
  const dz = out.z + tangentScratch.z * (u1 * spread) + bitangentScratch.z * (u2 * spread);
  const dLenSq = dx * dx + dy * dy + dz * dz;
  if (dLenSq < 1e-10) {
    return true;
  }
  const invDLen = 1 / Math.sqrt(dLenSq);
  out.x = dx * invDLen;
  out.y = dy * invDLen;
  out.z = dz * invDLen;
  return true;
}

function reflectDirectionToRef(incident: Vector3, normal: Vector3, out: Vector3): boolean {
  if (!normalizeVec3ToRef(incident, out)) {
    return false;
  }
  let nx = normal.x;
  let ny = normal.y;
  let nz = normal.z;
  const nLenSq = nx * nx + ny * ny + nz * nz;
  if (nLenSq < 1e-10) {
    return false;
  }
  const invNLen = 1 / Math.sqrt(nLenSq);
  nx *= invNLen;
  ny *= invNLen;
  nz *= invNLen;
  const d = out.x * nx + out.y * ny + out.z * nz;
  const rx = out.x - nx * (2 * d);
  const ry = out.y - ny * (2 * d);
  const rz = out.z - nz * (2 * d);
  const rLenSq = rx * rx + ry * ry + rz * rz;
  if (rLenSq < 1e-10) {
    return false;
  }
  const invRLen = 1 / Math.sqrt(rLenSq);
  out.x = rx * invRLen;
  out.y = ry * invRLen;
  out.z = rz * invRLen;
  return true;
}

function sanitizeIor(ior: number): number {
  return Math.max(1, Number.isFinite(ior) ? ior : 1.45);
}

function fresnelF0FromIorPair(etaI: number, etaT: number): number {
  const n1 = sanitizeIor(etaI);
  const n2 = sanitizeIor(etaT);
  const f0 = ((n2 - n1) / (n2 + n1)) ** 2;
  return clamp(f0, 0, 1);
}

function schlickFresnel(cosTheta: number, f0: number): number {
  const c = clamp(cosTheta, 0, 1);
  const base = clamp(f0, 0, 1);
  const m = 1 - c;
  return clamp(base + (1 - base) * m * m * m * m * m, 0, 1);
}

function refractDirectionAcrossInterfaceToRef(
  incident: Vector3,
  faceNormal: Vector3,
  etaI: number,
  etaT: number,
  out: Vector3,
): boolean {
  if (!normalizeVec3ToRef(incident, out)) {
    return false;
  }
  let nx = faceNormal.x;
  let ny = faceNormal.y;
  let nz = faceNormal.z;
  const nLenSq = nx * nx + ny * ny + nz * nz;
  if (nLenSq < 1e-10) {
    return false;
  }
  const invNLen = 1 / Math.sqrt(nLenSq);
  nx *= invNLen;
  ny *= invNLen;
  nz *= invNLen;
  if (out.x * nx + out.y * ny + out.z * nz > 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const etaFrom = sanitizeIor(etaI);
  const etaTo = sanitizeIor(etaT);
  const eta = etaFrom / etaTo;
  const cosi = clamp(-(out.x * nx + out.y * ny + out.z * nz), 0, 1);
  const k = 1 - eta * eta * (1 - cosi * cosi);
  if (k < 0) {
    return false;
  }
  const dirX = out.x * eta + nx * (eta * cosi - Math.sqrt(k));
  const dirY = out.y * eta + ny * (eta * cosi - Math.sqrt(k));
  const dirZ = out.z * eta + nz * (eta * cosi - Math.sqrt(k));
  const dirLenSq = dirX * dirX + dirY * dirY + dirZ * dirZ;
  if (dirLenSq < 1e-10) {
    return false;
  }
  const invDirLen = 1 / Math.sqrt(dirLenSq);
  out.x = dirX * invDirLen;
  out.y = dirY * invDirLen;
  out.z = dirZ * invDirLen;
  return true;
}

function buildAlignmentProbePixels(width: number, height: number): Array<{ x: number; y: number }> {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const candidates: Array<{ x: number; y: number }> = [
    { x: Math.floor(w * 0.5), y: Math.floor(h * 0.5) },
    { x: Math.floor(w * 0.25), y: Math.floor(h * 0.25) },
    { x: Math.floor(w * 0.75), y: Math.floor(h * 0.25) },
    { x: Math.floor(w * 0.25), y: Math.floor(h * 0.75) },
    { x: Math.floor(w * 0.75), y: Math.floor(h * 0.75) },
    { x: Math.floor(w * 0.5), y: Math.floor(h * 0.15) },
    { x: Math.floor(w * 0.5), y: Math.floor(h * 0.85) },
    { x: Math.floor(w * 0.15), y: Math.floor(h * 0.5) },
    { x: Math.floor(w * 0.85), y: Math.floor(h * 0.5) },
  ];
  const seen = new Set<string>();
  const out: Array<{ x: number; y: number }> = [];
  for (const point of candidates) {
    const x = clamp(Math.floor(point.x), 0, w - 1);
    const y = clamp(Math.floor(point.y), 0, h - 1);
    const key = `${x},${y}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ x, y });
  }
  return out;
}

function sigNum(value: number, digits = 4): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'nan';
}

function safeMeshClassName(mesh: AbstractMesh): string {
  try {
    const getClassName = (mesh as { getClassName?: () => string }).getClassName;
    return typeof getClassName === 'function' ? getClassName.call(mesh) : 'AbstractMesh';
  } catch {
    return 'AbstractMesh';
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function qualityBlendFactor(samples: number): number {
  const n = clamp(Math.round(samples), 1, 4096);
  // Lower factor = slower but cleaner convergence for still-frame accumulation.
  return clamp(1 / Math.max(8, n), 0.01, 0.125);
}

function loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to decode screenshot image'));
    image.src = dataUrl;
  });
}

function halton(index: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = Math.max(1, Math.floor(index));
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}
