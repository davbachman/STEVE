import {
  ArcRotateCamera,
  Color3,
  DirectionalLight,
  HemisphericLight,
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
  PathTraceWorkerMaterial,
  PathTraceWorkerRenderParams,
  PathTraceWorkerRequest,
  PathTraceWorkerResponse,
  PathTraceWorkerSceneSnapshot,
  PathTraceWorkerTriangleAccel as WorkerTraceTriangleAccel,
  PathTraceWorkerTriangleBvhNode,
  PathTraceWorkerVec3,
} from '../workers/pathTraceQualityWorkerContracts';

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

interface HybridSurfaceMaterial {
  baseColor: Vector3;
  metallic: number;
  roughness: number;
  reflectance: number;
  transmission: number;
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
}

interface HybridEnvironmentSample {
  radiance: Vector3;
  alpha: number;
}

interface CpuPathWorkerPendingBatch {
  requestId: number;
  sceneVersion: number;
  generation: number;
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
  worldMatrixUpdateFlag: number;
  triangleAccel: TraceTriangleAccel | null;
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

interface TracePickResult {
  hit: true;
  distance: number;
  pickedPoint: Vector3;
  pickedMesh: AbstractMesh;
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
  resetHistory(): void;
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

  resetHistory(): void {
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
  private cpuPathWorkerSceneVersion = 0;
  private cpuPathWorkerReadySceneVersion = -1;
  private cpuPathWorkerInitPendingSceneVersion = -1;
  private cpuPathWorkerRequestIdSeq = 0;
  private cpuPathWorkerPendingBatch: CpuPathWorkerPendingBatch | null = null;

  constructor(
    private readonly engine: WebGPUEngine,
    private readonly scene: Scene,
    private readonly camera: ArcRotateCamera,
    private readonly mode: ExperimentalQualityBackendMode = 'cpu_path',
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
    this.captureInFlight = false;
    this.invalidateTraceMeshAcceleration();
    this.terminateCpuPathWorker();
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
    this.invalidateTraceMeshAcceleration();
    this.clearAccumCanvas();
  }

  resetHistory(): void {}

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
    this.invalidateTraceMeshAcceleration();
    this.terminateCpuPathWorker();
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
    this.captureInFlight = false;
    this.cpuPathWorkerPendingBatch = null;
    this.terminateCpuPathWorker();
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
      const expectedLength = pending.pixelIndices.length * 4;
      if (message.samples.length !== expectedLength) {
        this.disableCpuPathWorkerOffload(
          `trace batch result length mismatch (${message.samples.length} vs ${expectedLength})`,
        );
        return;
      }
      for (let i = 0; i < pending.pixelIndices.length; i += 1) {
        const base = i * 4;
        this.accumulateHybridPixelSample(
          pending.pixelIndices[i],
          {
            r: message.samples[base],
            g: message.samples[base + 1],
            b: message.samples[base + 2],
            a: message.samples[base + 3],
          },
          pending.renderSnapshot,
        );
      }

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
      return true;
    } catch (error) {
      this.disableCpuPathWorkerOffload('trace batch dispatch failed', error);
      return false;
    }
  }

  private ensureCpuPathWorkerScene(worker: Worker): boolean {
    if (this.cpuPathWorkerSceneUnsupported) {
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
      return false;
    }

    const nextVersion = this.cpuPathWorkerSceneVersion + 1;
    const snapshot = this.buildCpuPathWorkerSceneSnapshot(nextVersion);
    if (!snapshot) {
      this.cpuPathWorkerSceneUnsupported = true;
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
      const accel = entry.triangleAccel;
      if (!accel || !accel.positionsWorld || accel.triangleCount <= 0) {
        return null;
      }
      const material = extractHybridSurfaceMaterial(entry.mesh.material);
      const workerMaterial: PathTraceWorkerMaterial = {
        baseColor: vector3ToWorkerVec3(material.baseColor),
        metallic: material.metallic,
        roughness: material.roughness,
        reflectance: material.reflectance,
        transmission: material.transmission,
        ior: material.ior,
        opacity: material.opacity,
      };
      const workerAccel: WorkerTraceTriangleAccel = {
        positionsWorld: accel.positionsWorld,
        normalsWorld: accel.normalsWorld ?? null,
        triangleCount: accel.triangleCount,
        triangleBvhRoot: (accel.triangleBvhRoot as PathTraceWorkerTriangleBvhNode | null) ?? null,
      };
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
        triangleAccel: workerAccel,
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
    const totalPixels = Math.max(1, w * h);
    const targetSamples = clamp(Math.round(render.qualitySamplesTarget), 1, 4096);
    const sampleIndex = this.sampleCount + 1;
    const traceOrder = buildTracePixelPermutation(totalPixels, sampleIndex);
    const frameBudgetMs = this.sampleCount === 0 ? 8 : 5;
    const hardMaxPixels = clamp(Math.round(totalPixels / 64), 256, 4096);
    const minPixelsBeforeBudgetCheck = 16;
    const batchStartMs = nowMs();

    const pixelIndices = new Uint32Array(hardMaxPixels);
    const rays = new Float32Array(hardMaxPixels * 6);
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

    const rayBuffer = tracedPixels === hardMaxPixels ? rays : rays.slice(0, tracedPixels * 6);
    const pixelIndexBuffer = tracedPixels === hardMaxPixels ? pixelIndices : pixelIndices.slice(0, tracedPixels);
    const requestId = ++this.cpuPathWorkerRequestIdSeq;
    const pending: CpuPathWorkerPendingBatch = {
      requestId,
      sceneVersion: this.cpuPathWorkerSceneVersion,
      generation: this.captureGeneration,
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
    return this.scene.createPickingRay(
      (localX + tracePixelContext.viewportX) * tracePixelContext.hardwareScale,
      (localY + tracePixelContext.viewportY) * tracePixelContext.hardwareScale,
      PATH_PICK_WORLD_MATRIX,
      captureCamera,
    );
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

  private traceHybridRay(
    initialRay: Ray,
    render: RenderSettings,
    sampleIndex: number,
    pixelIndex: number,
  ): HybridPixelSample {
    const maxBounces = clamp(Math.round(render.qualityMaxBounces), 1, 6);
    let ray = initialRay;
    let throughput = new Vector3(1, 1, 1);
    const radiance = new Vector3(0, 0, 0);
    let alpha = 0;
    let currentMediumIor = 1;

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
      let outwardNormal = pick.getNormal(true, true) ?? ray.direction.scale(-1);
      if (outwardNormal.lengthSquared() < 1e-10) {
        outwardNormal = ray.direction.scale(-1);
      }
      outwardNormal.normalize();
      const frontFace = Vector3.Dot(outwardNormal, ray.direction) < 0;
      const shadingNormal = outwardNormal.clone();
      if (!frontFace) {
        shadingNormal.scaleInPlace(-1);
      }

      const material = extractHybridSurfaceMaterial(pick.pickedMesh.material);
      const viewDir = ray.direction.scale(-1).normalize();
      const direct = this.sampleHybridDirectLighting(
        hitPoint,
        shadingNormal,
        viewDir,
        material,
        pick.pickedMesh,
        sampleIndex,
        pixelIndex,
        bounce,
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

      throughput = multiplyVec3(throughput, bounceSample.throughput);
      currentMediumIor = bounceSample.nextMediumIor;
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

      const nextOrigin = hitPoint.add(bounceSample.direction.scale(0.0025));
      ray = new Ray(nextOrigin, bounceSample.direction, 1e6);
    }

    return {
      r: clampFinite(radiance.x),
      g: clampFinite(radiance.y),
      b: clampFinite(radiance.z),
      a: alpha,
    };
  }

  private sampleHybridEnvironment(direction: Vector3): HybridEnvironmentSample {
    const dir = direction.clone();
    if (dir.lengthSquared() < 1e-10) {
      return { radiance: new Vector3(0, 0, 0), alpha: 1 };
    }
    dir.normalize();

    const clear = this.scene.clearColor;
    const base = new Vector3(
      Number.isFinite(clear?.r) ? clear.r : 0,
      Number.isFinite(clear?.g) ? clear.g : 0,
      Number.isFinite(clear?.b) ? clear.b : 0,
    );
    // Quality path output should be visually self-contained during partial accumulation
    // previews and exports, so treat environment/background rays as opaque even if the
    // raster scene clear alpha is 0 (the raster viewport may rely on CSS compositing).
    const alpha = 1;

    const ambient = this.scene.ambientColor;
    if (ambient) {
      base.x += ambient.r * 0.35;
      base.y += ambient.g * 0.35;
      base.z += ambient.b * 0.35;
    }

    for (const light of this.scene.lights) {
      if (!(light instanceof HemisphericLight) || !light.isEnabled() || light.intensity <= 0) {
        continue;
      }
      const hemiDir = light.direction.clone();
      if (hemiDir.lengthSquared() < 1e-10) {
        continue;
      }
      hemiDir.normalize();
      const t = clamp(0.5 + 0.5 * Vector3.Dot(dir, hemiDir), 0, 1);
      const sky = color3ToVector(light.diffuse ?? Color3.White()).scale(light.intensity);
      const ground = color3ToVector(light.groundColor ?? Color3.Black()).scale(light.intensity);
      const dome = lerpVec3(ground, sky, t);
      base.x += dome.x;
      base.y += dome.y;
      base.z += dome.z;
    }

    return {
      radiance: new Vector3(clampFinite(base.x), clampFinite(base.y), clampFinite(base.z)),
      alpha,
    };
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
  ): Vector3 {
    const out = new Vector3(0, 0, 0);
    const diffuseWeight = clamp01Safe((1 - material.metallic) * (1 - material.transmission) * material.opacity);
    const specWeight = clamp01Safe(Math.max(material.reflectance, material.metallic));
    const specColor = lerpVec3(new Vector3(1, 1, 1), material.baseColor, material.metallic);
    const roughness = clamp(material.roughness, 0.03, 1);
    const shininess = clamp(Math.round((1 - roughness) * 180 + 8), 8, 256);
    // CPU path backend is throughput-constrained; sample finite direct lights only on the first hit.
    // This is a preview-biased tradeoff (fewer shadow rays / less secondary-light accuracy).
    const sampleFiniteDirectThisBounce = !(this.mode === 'cpu_path' && bounce > 0);
    const useSingleFiniteLightSample = this.mode === 'cpu_path' && sampleFiniteDirectThisBounce;
    let finiteLightCount = 0;
    if (useSingleFiniteLightSample) {
      for (const light of this.scene.lights) {
        if (!light.isEnabled() || light.intensity <= 0) {
          continue;
        }
        if (light instanceof DirectionalLight || light instanceof PointLight) {
          finiteLightCount += 1;
        }
      }
    }
    const selectedFiniteLightIndex = useSingleFiniteLightSample && finiteLightCount > 0
      ? Math.min(
        finiteLightCount - 1,
        Math.floor(sampleHash01(pixelIndex, sampleIndex + bounce * 71, 151) * finiteLightCount),
      )
      : -1;
    const finiteLightWeight = useSingleFiniteLightSample && finiteLightCount > 0 ? finiteLightCount : 1;

    let dirIndex = 0;
    let pointIndex = 0;
    let finiteLightIndex = 0;
    for (const light of this.scene.lights) {
      if (!light.isEnabled() || light.intensity <= 0) {
        continue;
      }

      if (light instanceof HemisphericLight) {
        const hemiDir = light.direction.clone();
        if (hemiDir.lengthSquared() < 1e-10) {
          continue;
        }
        hemiDir.normalize();
        const t = clamp(0.5 + 0.5 * Vector3.Dot(normal, hemiDir), 0, 1);
        const sky = color3ToVector(light.diffuse ?? Color3.White()).scale(light.intensity);
        const ground = color3ToVector(light.groundColor ?? Color3.Black()).scale(light.intensity);
        const hemi = lerpVec3(ground, sky, t);
        out.x += hemi.x * material.baseColor.x * diffuseWeight;
        out.y += hemi.y * material.baseColor.y * diffuseWeight;
        out.z += hemi.z * material.baseColor.z * diffuseWeight;
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
        if (
          useSingleFiniteLightSample
          && finiteLightCount > 1
          && currentFiniteLightIndex !== selectedFiniteLightIndex
        ) {
          continue;
        }
        const jitteredDir =
          this.computeJitteredDirectionalLightDirection(
            light.direction,
            sampleIndex + bounce * 31 + pixelIndex,
            currentDirIndex,
          ) ?? light.direction.clone();
        if (jitteredDir.lengthSquared() < 1e-10) {
          continue;
        }
        jitteredDir.normalize();
        const lightDir = jitteredDir.scale(-1).normalize();
        const ndl = Math.max(0, Vector3.Dot(normal, lightDir));
        if (ndl <= 0) continue;
        if (this.isShadowedDirectional(hitPoint, normal, lightDir, hitMesh)) {
          continue;
        }
        const lightColor = color3ToVector(light.diffuse ?? Color3.White()).scale(light.intensity * finiteLightWeight);
        const h = lightDir.add(viewDir).normalize();
        const ndh = Math.max(0, Vector3.Dot(normal, h));
        const specTerm = specWeight > 0 ? Math.pow(ndh, shininess) * ndl : 0;
        out.x += lightColor.x * (material.baseColor.x * diffuseWeight * ndl + specColor.x * specTerm * specWeight);
        out.y += lightColor.y * (material.baseColor.y * diffuseWeight * ndl + specColor.y * specTerm * specWeight);
        out.z += lightColor.z * (material.baseColor.z * diffuseWeight * ndl + specColor.z * specTerm * specWeight);
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
        if (
          useSingleFiniteLightSample
          && finiteLightCount > 1
          && currentFiniteLightIndex !== selectedFiniteLightIndex
        ) {
          continue;
        }
        const samplePos =
          this.computeJitteredPointLightPosition(light, sampleIndex + bounce * 47 + pixelIndex, currentPointIndex) ?? light.position.clone();
        const toLight = samplePos.subtract(hitPoint);
        const dist2 = toLight.lengthSquared();
        if (dist2 <= 1e-8) continue;
        const dist = Math.sqrt(dist2);
        const lightDir = toLight.scale(1 / dist);
        const ndl = Math.max(0, Vector3.Dot(normal, lightDir));
        if (ndl <= 0) continue;
        if (this.isShadowedPoint(hitPoint, normal, lightDir, dist, hitMesh)) {
          continue;
        }
        const range = Number.isFinite(light.range) && light.range > 0 ? light.range : dist * 2;
        const rangeFalloff = clamp(1 - (dist / Math.max(range, 1e-3)) ** 2, 0, 1);
        const attenuation = rangeFalloff * rangeFalloff / (1 + dist2 * 0.03);
        if (attenuation <= 0) continue;
        const lightColor = color3ToVector(light.diffuse ?? Color3.White()).scale(light.intensity * attenuation * finiteLightWeight);
        const h = lightDir.add(viewDir).normalize();
        const ndh = Math.max(0, Vector3.Dot(normal, h));
        const specTerm = specWeight > 0 ? Math.pow(ndh, shininess) * ndl : 0;
        out.x += lightColor.x * (material.baseColor.x * diffuseWeight * ndl + specColor.x * specTerm * specWeight);
        out.y += lightColor.y * (material.baseColor.y * diffuseWeight * ndl + specColor.y * specTerm * specWeight);
        out.z += lightColor.z * (material.baseColor.z * diffuseWeight * ndl + specColor.z * specTerm * specWeight);
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
    const incident = incomingDir.clone().normalize();
    const mediumIor = sanitizeIor(currentMediumIor);
    const materialIor = sanitizeIor(material.ior);
    const nextMediumIorForTransmission = frontFace ? materialIor : 1;
    const cosTheta = clamp(-Vector3.Dot(incident, shadingNormal), 0, 1);
    const dielectricF0 = fresnelF0FromIorPair(mediumIor, nextMediumIorForTransmission);
    const fresnel = schlickFresnel(cosTheta, Math.max(dielectricF0, material.reflectance));

    let reflectWeight = clamp01Safe(Math.max(material.reflectance, material.metallic));
    let transmitWeight = clamp01Safe(material.transmission * material.opacity);
    if (transmitWeight > 0) {
      reflectWeight = clamp01Safe(reflectWeight + transmitWeight * fresnel);
      transmitWeight = clamp01Safe(transmitWeight * (1 - fresnel));
    }
    const diffuseWeight = clamp01Safe((1 - material.metallic) * (1 - material.transmission) * material.opacity);
    const total = reflectWeight + transmitWeight + diffuseWeight;
    if (total <= 1e-5) {
      return null;
    }

    const xi = sampleHash01(pixelIndex, sampleIndex + bounce * 19, 7) * total;
    const roughness = clamp(material.roughness, 0, 1);

    if (xi < transmitWeight) {
      const refracted = refractDirectionAcrossInterface(
        incident,
        frontFace ? outwardNormal : outwardNormal.scale(-1),
        mediumIor,
        nextMediumIorForTransmission,
      );
      const continuedDirection = refracted ?? reflectDirection(incident, shadingNormal);
      const direction = jitterDirection(
        continuedDirection,
        clamp(roughness * 0.35, 0, 0.4),
        pixelIndex,
        sampleIndex,
        bounce,
        17,
      );
      if (!direction) return null;
      const tint = lerpVec3(new Vector3(1, 1, 1), material.baseColor, 0.2);
      return {
        direction,
        throughput: tint.scale(Math.max(0.15, transmitWeight / total)),
        nextMediumIor: refracted ? nextMediumIorForTransmission : mediumIor,
      };
    }

    if (xi < transmitWeight + reflectWeight) {
      const reflected = reflectDirection(incident, shadingNormal);
      const direction = jitterDirection(
        reflected,
        clamp(roughness * 0.6, 0, 0.75),
        pixelIndex,
        sampleIndex,
        bounce,
        23,
      );
      if (!direction) return null;
      const specColor = lerpVec3(new Vector3(1, 1, 1), material.baseColor, material.metallic);
      return {
        direction,
        throughput: specColor.scale(Math.max(0.1, reflectWeight / total)),
        nextMediumIor: mediumIor,
      };
    }

    const diffuseDir = cosineSampleHemisphere(
      shadingNormal,
      pixelIndex,
      sampleIndex,
      bounce,
      29,
    );
    if (!diffuseDir) {
      return null;
    }
    return {
      direction: diffuseDir,
      throughput: material.baseColor.scale(Math.max(0.1, diffuseWeight / total)),
      nextMediumIor: mediumIor,
    };
  }

  private isShadowedDirectional(hitPoint: Vector3, normal: Vector3, lightDir: Vector3, hitMesh: AbstractMesh): boolean {
    const origin = hitPoint.add(normal.scale(0.0035));
    const shadowRay = new Ray(origin, lightDir, 1e6);
    return this.hasAnyTraceHit(shadowRay, hitMesh);
  }

  private isShadowedPoint(
    hitPoint: Vector3,
    normal: Vector3,
    lightDir: Vector3,
    lightDistance: number,
    hitMesh: AbstractMesh,
  ): boolean {
    const origin = hitPoint.add(normal.scale(0.0035));
    const shadowRay = new Ray(origin, lightDir, Math.max(0, lightDistance - 0.005));
    return this.hasAnyTraceHit(shadowRay, hitMesh, lightDistance - 0.005);
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
        mesh.computeWorldMatrix(false);
        const worldMatrixUpdateFlag = getMeshWorldMatrixUpdateFlag(mesh);
        if (worldMatrixUpdateFlag !== entry.worldMatrixUpdateFlag) {
          return true;
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
          worldMatrixUpdateFlag: getMeshWorldMatrixUpdateFlag(mesh),
          triangleAccel: buildTraceTriangleAccel(mesh),
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
      getNormal: (useWorldCoordinates = true, useVerticesNormals = true) => {
        try {
          return pick.getNormal?.(useWorldCoordinates, useVerticesNormals) ?? null;
        } catch {
          return null;
        }
      },
    };
  }

  private hasAnyTraceHitOnEntry(
    entry: TraceMeshAccelEntry,
    ray: Ray,
    maxDistance: number | null,
  ): boolean {
    if (entry.triangleAccel) {
      return intersectTraceTriangleSoupAny(ray, entry.triangleAccel, maxDistance);
    }
    const pick = entry.mesh.intersects(ray, true);
    if (!pick?.hit) {
      return false;
    }
    if (maxDistance !== null) {
      if (typeof pick.distance !== 'number' || !Number.isFinite(pick.distance)) {
        return false;
      }
      if (pick.distance >= maxDistance) {
        return false;
      }
    }
    return true;
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
      const stack: TraceMeshBvhNode[] = [root];
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

  private hasAnyTraceHit(ray: Ray, ignoreMesh: AbstractMesh | null, maxDistance?: number): boolean {
    const limit = Number.isFinite(maxDistance) ? Math.max(0, maxDistance ?? 0) : null;
    this.getTraceableMeshesForCurrentFrame();
    const root = this.traceMeshBvhRoot;
    if (root) {
      const stack: TraceMeshBvhNode[] = [root];
      const maxT = limit ?? Number.POSITIVE_INFINITY;
      while (stack.length > 0) {
        const node = stack.pop()!;
        const nodeHitDist = rayIntersectsTraceAabb(ray, node.minX, node.minY, node.minZ, node.maxX, node.maxY, node.maxZ, maxT);
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
              maxT,
            );
            if (entryHitDist === null) {
              continue;
            }
            if (!this.hasAnyTraceHitOnEntry(entry, ray, limit)) {
              continue;
            }
            return true;
          }
          continue;
        }

        const left = node.left;
        const right = node.right;
        if (!left && !right) {
          continue;
        }
        if (left && right) {
          const leftHit = rayIntersectsTraceAabb(ray, left.minX, left.minY, left.minZ, left.maxX, left.maxY, left.maxZ, maxT);
          const rightHit = rayIntersectsTraceAabb(ray, right.minX, right.minY, right.minZ, right.maxX, right.maxY, right.maxZ, maxT);
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
      return false;
    }

    const meshes = this.traceMeshCache;
    for (const mesh of meshes) {
      if (ignoreMesh && mesh === ignoreMesh) {
        continue;
      }
      const pick = mesh.intersects(ray, true);
      if (!pick?.hit) {
        continue;
      }
      if (limit !== null) {
        if (typeof pick.distance !== 'number' || !Number.isFinite(pick.distance)) {
          continue;
        }
        if (pick.distance >= limit) {
          continue;
        }
      }
      return true;
    }
    return false;
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
    if (!this.accumLinear || !this.pixelSampleCounts) {
      return;
    }
    const base4 = pixelIndex * 4;
    const count = this.pixelSampleCounts[pixelIndex];
    let r = sample.r;
    let g = sample.g;
    let b = sample.b;
    const a = clamp(sample.a, 0, 1);

    if (render.qualityClampFireflies && count > 0) {
      const avgR = this.accumLinear[base4] / count;
      const avgG = this.accumLinear[base4 + 1] / count;
      const avgB = this.accumLinear[base4 + 2] / count;
      const avgLum = luminance(avgR, avgG, avgB);
      const sampleLum = luminance(r, g, b);
      const maxBounces = clamp(Math.round(render.qualityMaxBounces), 1, 12);
      const maxLum = Math.max(0.03, avgLum * (2.2 + (maxBounces - 1) * 0.35));
      if (sampleLum > maxLum && sampleLum > 1e-6) {
        const scale = maxLum / sampleLum;
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
    captureCamera.minZ = this.camera.minZ;
    captureCamera.maxZ = this.camera.maxZ;
    captureCamera.mode = this.camera.mode;
    captureCamera.layerMask = this.camera.layerMask;
    captureCamera.viewport = this.camera.viewport.clone();
    return captureCamera;
  }

  private copyLiveCameraToCaptureCamera(captureCamera: ArcRotateCamera): void {
    captureCamera.alpha = this.camera.alpha;
    captureCamera.beta = this.camera.beta;
    captureCamera.radius = this.camera.radius;
    captureCamera.fov = this.camera.fov;
    captureCamera.minZ = this.camera.minZ;
    captureCamera.maxZ = this.camera.maxZ;
    captureCamera.mode = this.camera.mode;
    // Keep using the setter here as well; mutating in-place bypasses ArcRotateCamera.setMatUp().
    captureCamera.upVector = this.camera.upVector.clone();
    captureCamera.layerMask = this.camera.layerMask;
    captureCamera.viewport = this.camera.viewport.clone();
    captureCamera.target.copyFrom(this.camera.target);
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

      if (clampFireflies && previousSamples > 0) {
        const avgR = accum[i] / previousSamples;
        const avgG = accum[i + 1] / previousSamples;
        const avgB = accum[i + 2] / previousSamples;
        const avgLum = luminance(avgR, avgG, avgB);
        const sampleLum = luminance(r, g, b);
        const maxLum = Math.max(fireflyFloor, avgLum * fireflyThresholdScale);
        if (sampleLum > maxLum && sampleLum > 1e-6) {
          const scale = maxLum / sampleLum;
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

  constructor(engine: WebGPUEngine, scene: Scene, camera: ArcRotateCamera) {
    this.taaPreview = new TaaPreviewQualityBackend(scene, camera);
    this.hybridGpuPreview = new PathQualityBackendV1(engine, scene, camera, 'hybrid_gpu_preview');
    this.path = new PathQualityBackendV1(engine, scene, camera, 'cpu_path');
  }

  get activeRenderer(): ActiveQualityRenderer {
    return this._activeRenderer;
  }

  sync(render: RenderSettings): QualityBackendSyncResult {
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

  resetActiveBackendHistory(): void {
    if (this._activeRenderer === 'taa_preview') {
      this.taaPreview.resetHistory();
      return;
    }
    if (this._activeRenderer === 'hybrid_gpu_preview') {
      this.hybridGpuPreview.resetHistory();
      return;
    }
    if (this._activeRenderer === 'path') {
      this.path.resetHistory();
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

function extractHybridSurfaceMaterial(material: Material | null | undefined): HybridSurfaceMaterial {
  if (material instanceof PBRMaterial) {
    return {
      baseColor: color3ToVector(material.albedoColor ?? Color3.White()),
      metallic: clamp(material.metallic ?? 0, 0, 1),
      roughness: clamp(material.roughness ?? 0.6, 0, 1),
      reflectance: clamp(Math.max(material.metallic ?? 0, (1 - (material.roughness ?? 0.6)) * 0.08), 0, 1),
      transmission: clamp(material.subSurface?.isRefractionEnabled ? (material.subSurface.refractionIntensity ?? 0) : 0, 0, 1),
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
      transmission: 0,
      ior: 1.45,
      opacity: clamp(material.alpha ?? 1, 0, 1),
    };
  }

  return {
    baseColor: new Vector3(0.8, 0.82, 0.85),
    metallic: 0,
    roughness: 0.6,
    reflectance: 0.04,
    transmission: 0,
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

function intersectTraceTriangleSoupAny(
  ray: Ray,
  accel: TraceTriangleAccel | null,
  maxDistance: number | null,
): boolean {
  if (!accel || accel.triangleCount <= 0) {
    return false;
  }
  if (accel.triangleBvhRoot) {
    return intersectTraceTriangleLocalBvhAny(ray, accel, maxDistance);
  }

  const positions = accel.positionsWorld;
  const ox = ray.origin.x;
  const oy = ray.origin.y;
  const oz = ray.origin.z;
  const dx = ray.direction.x;
  const dy = ray.direction.y;
  const dz = ray.direction.z;
  const epsilon = 1e-8;
  const minT = 1e-5;
  const limit = maxDistance !== null && Number.isFinite(maxDistance)
    ? Math.max(minT, maxDistance)
    : Number.POSITIVE_INFINITY;

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
    if (t > minT && t < limit) {
      return true;
    }
  }

  return false;
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
  const stack: TraceTriangleBvhNode[] = [root];

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

function intersectTraceTriangleLocalBvhAny(
  ray: Ray,
  accel: TraceTriangleAccel,
  maxDistance: number | null,
): boolean {
  const root = accel.triangleBvhRoot;
  if (!root) {
    return false;
  }

  const positions = accel.positionsWorld;
  const ox = ray.origin.x;
  const oy = ray.origin.y;
  const oz = ray.origin.z;
  const dx = ray.direction.x;
  const dy = ray.direction.y;
  const dz = ray.direction.z;
  const epsilon = 1e-8;
  const minT = 1e-5;
  const maxT = maxDistance !== null && Number.isFinite(maxDistance)
    ? Math.max(minT, maxDistance)
    : Number.POSITIVE_INFINITY;
  const stack: TraceTriangleBvhNode[] = [root];

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
      maxT,
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
        if (t > minT && t < maxT) {
          return true;
        }
      }
      continue;
    }

    const left = node.left;
    const right = node.right;
    if (!left && !right) {
      continue;
    }
    if (left && right) {
      const leftHit = rayIntersectsTraceAabb(ray, left.minX, left.minY, left.minZ, left.maxX, left.maxY, left.maxZ, maxT);
      const rightHit = rayIntersectsTraceAabb(ray, right.minX, right.minY, right.minZ, right.maxX, right.maxY, right.maxZ, maxT);
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

  return false;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01Safe(value: number): number {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1);
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

function multiplyVec3(a: Vector3, b: Vector3): Vector3 {
  return new Vector3(a.x * b.x, a.y * b.y, a.z * b.z);
}

function lerpVec3(a: Vector3, b: Vector3, t: number): Vector3 {
  const k = clamp01Safe(t);
  return new Vector3(
    a.x + (b.x - a.x) * k,
    a.y + (b.y - a.y) * k,
    a.z + (b.z - a.z) * k,
  );
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

function makeOrthonormalBasis(n: Vector3): { tangent: Vector3; bitangent: Vector3 } | null {
  const normal = n.clone();
  if (normal.lengthSquared() < 1e-10) {
    return null;
  }
  normal.normalize();
  const upA = Math.abs(normal.z) < 0.95 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  let tangent = Vector3.Cross(upA, normal);
  if (tangent.lengthSquared() < 1e-10) {
    tangent = Vector3.Cross(new Vector3(1, 0, 0), normal);
    if (tangent.lengthSquared() < 1e-10) {
      return null;
    }
  }
  tangent.normalize();
  const bitangent = Vector3.Cross(normal, tangent);
  if (bitangent.lengthSquared() < 1e-10) {
    return null;
  }
  bitangent.normalize();
  return { tangent, bitangent };
}

function cosineSampleHemisphere(
  normal: Vector3,
  pixelIndex: number,
  sampleIndex: number,
  bounce: number,
  dimensionOffset: number,
): Vector3 | null {
  const basis = makeOrthonormalBasis(normal);
  if (!basis) {
    return null;
  }
  const u1 = sampleHash01(pixelIndex, sampleIndex + bounce * 53, dimensionOffset);
  const u2 = sampleHash01(pixelIndex, sampleIndex + bounce * 53, dimensionOffset + 1);
  const r = Math.sqrt(u1);
  const theta = 2 * Math.PI * u2;
  const x = r * Math.cos(theta);
  const y = r * Math.sin(theta);
  const z = Math.sqrt(Math.max(0, 1 - u1));
  const dir = basis.tangent.scale(x).add(basis.bitangent.scale(y)).add(normal.clone().normalize().scale(z));
  if (dir.lengthSquared() < 1e-10) {
    return null;
  }
  return dir.normalize();
}

function jitterDirection(
  direction: Vector3,
  roughness: number,
  pixelIndex: number,
  sampleIndex: number,
  bounce: number,
  dimensionOffset: number,
): Vector3 | null {
  const base = direction.clone();
  if (base.lengthSquared() < 1e-10) {
    return null;
  }
  base.normalize();
  if (roughness <= 1e-4) {
    return base;
  }
  const basis = makeOrthonormalBasis(base);
  if (!basis) {
    return base;
  }
  const u1 = sampleHash01(pixelIndex, sampleIndex + bounce * 61, dimensionOffset) * 2 - 1;
  const u2 = sampleHash01(pixelIndex, sampleIndex + bounce * 61, dimensionOffset + 1) * 2 - 1;
  const spread = roughness * roughness;
  const dir = base
    .add(basis.tangent.scale(u1 * spread))
    .add(basis.bitangent.scale(u2 * spread));
  if (dir.lengthSquared() < 1e-10) {
    return base;
  }
  return dir.normalize();
}

function reflectDirection(incident: Vector3, normal: Vector3): Vector3 {
  const i = incident.clone().normalize();
  const n = normal.clone().normalize();
  const d = Vector3.Dot(i, n);
  return i.subtract(n.scale(2 * d)).normalize();
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

function refractDirectionAcrossInterface(
  incident: Vector3,
  faceNormal: Vector3,
  etaI: number,
  etaT: number,
): Vector3 | null {
  const i = incident.clone().normalize();
  const n = faceNormal.clone().normalize();
  if (n.lengthSquared() < 1e-10 || i.lengthSquared() < 1e-10) {
    return null;
  }
  if (Vector3.Dot(i, n) > 0) {
    n.scaleInPlace(-1);
  }
  const etaFrom = sanitizeIor(etaI);
  const etaTo = sanitizeIor(etaT);
  const eta = etaFrom / etaTo;
  const cosi = clamp(-Vector3.Dot(i, n), 0, 1);
  const k = 1 - eta * eta * (1 - cosi * cosi);
  if (k < 0) {
    return null;
  }
  const dir = i.scale(eta).add(n.scale(eta * cosi - Math.sqrt(k)));
  if (dir.lengthSquared() < 1e-10) {
    return null;
  }
  return dir.normalize();
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
