import { useEffect, useRef } from 'react';
import { useAppStore } from '../state/store';
import type {
  PlotObject,
  WorkerRequest,
  WorkerResponse,
  UUID,
} from '../types/contracts';
import { clearRuntimePlotMesh, clearAllRuntimePlotMeshes, setRuntimePlotMesh } from '../workers/runtimeMeshCache';

type PlotSignatures = {
  parse: string;
  mesh: string;
};

type JobKind = 'parse' | 'mesh_preview' | 'mesh_final';

type JobMeta = {
  objectId: UUID;
  kind: JobKind;
  startedAt: number;
  rawText?: string;
};

type WorkersRef = {
  math: Worker | null;
  mesh: Worker | null;
};

export function useWorkerPipeline(): void {
  const objects = useAppStore((s) => s.objects);
  const workersRef = useRef<WorkersRef>({ math: null, mesh: null });
  const sigsRef = useRef<Map<UUID, PlotSignatures>>(new Map());
  const parseTimerRef = useRef<Map<UUID, number>>(new Map());
  const meshTimerRef = useRef<Map<UUID, number>>(new Map());
  const latestParseJobRef = useRef<Map<UUID, string>>(new Map());
  const latestMeshPreviewJobRef = useRef<Map<UUID, string>>(new Map());
  const latestMeshFinalJobRef = useRef<Map<UUID, string>>(new Map());
  const jobMetaRef = useRef<Map<string, JobMeta>>(new Map());

  useEffect(() => {
    const mathWorker = new Worker(new URL('../workers/mathWorker.ts', import.meta.url), { type: 'module' });
    const meshWorker = new Worker(new URL('../workers/meshWorker.ts', import.meta.url), { type: 'module' });
    workersRef.current = { math: mathWorker, mesh: meshWorker };

    mathWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      handleMathWorkerMessage(
        event.data,
        latestParseJobRef.current,
        jobMetaRef.current,
      );
    };
    meshWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      handleMeshWorkerMessage(
        event.data,
        latestMeshPreviewJobRef.current,
        latestMeshFinalJobRef.current,
        jobMetaRef.current,
      );
    };

    return () => {
      for (const timer of parseTimerRef.current.values()) {
        window.clearTimeout(timer);
      }
      for (const timer of meshTimerRef.current.values()) {
        window.clearTimeout(timer);
      }
      parseTimerRef.current.clear();
      meshTimerRef.current.clear();
      sigsRef.current.clear();
      latestParseJobRef.current.clear();
      latestMeshPreviewJobRef.current.clear();
      latestMeshFinalJobRef.current.clear();
      jobMetaRef.current.clear();
      clearAllRuntimePlotMeshes();
      mathWorker.terminate();
      meshWorker.terminate();
      workersRef.current = { math: null, mesh: null };
    };
  }, []);

  useEffect(() => {
    const plotIds = new Set(objects.filter((o): o is PlotObject => o.type === 'plot').map((o) => o.id));

    // Cleanup removed plots.
    for (const objectId of [...sigsRef.current.keys()]) {
      if (plotIds.has(objectId)) continue;
      sigsRef.current.delete(objectId);
      clearTimer(parseTimerRef.current, objectId);
      clearTimer(meshTimerRef.current, objectId);
      clearRuntimePlotMesh(objectId);
      useAppStore.getState().clearPlotJobStatus(objectId);
      postCancel(workersRef.current.math, objectId);
      postCancel(workersRef.current.mesh, objectId);
    }

    for (const object of objects) {
      if (object.type !== 'plot') continue;
      ensureJobStateExists(object.id);
      const nextSigs = {
        parse: object.equation.source.rawText,
        mesh: buildMeshSignature(object),
      };
      const prev = sigsRef.current.get(object.id);
      if (!prev || prev.parse !== nextSigs.parse) {
        scheduleParse(workersRef.current, parseTimerRef.current, latestParseJobRef.current, jobMetaRef.current, object);
      }
      if (!prev || prev.mesh !== nextSigs.mesh) {
        scheduleMesh(workersRef.current, meshTimerRef.current, latestMeshPreviewJobRef.current, latestMeshFinalJobRef.current, jobMetaRef.current, object);
      }
      sigsRef.current.set(object.id, nextSigs);
    }
  }, [objects]);
}

function scheduleParse(
  workers: WorkersRef,
  timerMap: Map<UUID, number>,
  latestParseJobRef: Map<UUID, string>,
  jobMetaRef: Map<string, JobMeta>,
  plot: PlotObject,
): void {
  clearTimer(timerMap, plot.id);
  useAppStore.getState().upsertPlotJobStatus(plot.id, {
    parsePhase: 'queued',
    progress: 0.02,
    message: 'Parse queued',
  });

  const timer = window.setTimeout(() => {
    postCancel(workers.math, plot.id);
    const jobId = newJobId();
    latestParseJobRef.set(plot.id, jobId);
    jobMetaRef.set(jobId, { objectId: plot.id, kind: 'parse', startedAt: performance.now(), rawText: plot.equation.source.rawText });
    useAppStore.getState().upsertPlotJobStatus(plot.id, {
      parsePhase: 'parsing',
      progress: 0.08,
      message: 'Parsing',
    });
    const req: WorkerRequest = {
      type: 'parse_and_classify',
      jobId,
      objectId: plot.id,
      rawText: plot.equation.source.rawText,
    };
    workers.math?.postMessage(req);
  }, 120);

  timerMap.set(plot.id, timer);
}

function scheduleMesh(
  workers: WorkersRef,
  timerMap: Map<UUID, number>,
  latestPreviewRef: Map<UUID, string>,
  latestFinalRef: Map<UUID, string>,
  jobMetaRef: Map<string, JobMeta>,
  plot: PlotObject,
): void {
  clearTimer(timerMap, plot.id);

  if (plot.equation.source.parseStatus !== 'ok') {
    useAppStore.getState().upsertPlotJobStatus(plot.id, {
      meshPhase: 'skipped',
      progress: 0,
      message: 'Waiting for valid equation',
    });
    return;
  }

  useAppStore.getState().upsertPlotJobStatus(plot.id, {
    meshPhase: 'queued',
    progress: 0.03,
    message: 'Meshing queued',
    hasPreview: false,
    lastError: undefined,
  });

  const timer = window.setTimeout(() => {
    postCancel(workers.mesh, plot.id);
    const previewJobId = newJobId();
    const finalJobId = newJobId();
    latestPreviewRef.set(plot.id, previewJobId);
    latestFinalRef.set(plot.id, finalJobId);
    jobMetaRef.set(previewJobId, { objectId: plot.id, kind: 'mesh_preview', startedAt: performance.now() });
    jobMetaRef.set(finalJobId, { objectId: plot.id, kind: 'mesh_final', startedAt: performance.now() });

    useAppStore.getState().upsertPlotJobStatus(plot.id, {
      meshPhase: 'mesh_preview',
      progress: 0.08,
      message: 'Meshing preview',
      hasPreview: false,
    });

    const [previewReq, finalReq] = buildMeshRequests(plot, previewJobId, finalJobId);
    workers.mesh?.postMessage(previewReq);
    workers.mesh?.postMessage(finalReq);
  }, plot.equation.kind === 'implicit_surface' ? 220 : 140);

  timerMap.set(plot.id, timer);
}

function buildMeshRequests(plot: PlotObject, previewJobId: string, finalJobId: string): [WorkerRequest, WorkerRequest] {
  switch (plot.equation.kind) {
    case 'parametric_curve':
      return [
        {
          type: 'build_curve_mesh',
          jobId: previewJobId,
          objectId: plot.id,
          spec: plot.equation,
          priority: 'preview',
        },
        {
          type: 'build_curve_mesh',
          jobId: finalJobId,
          objectId: plot.id,
          spec: plot.equation,
          priority: 'refine',
        },
      ];
    case 'parametric_surface':
    case 'explicit_surface':
      return [
        {
          type: 'build_parametric_mesh',
          jobId: previewJobId,
          objectId: plot.id,
          spec: plot.equation,
          priority: 'preview',
          wireframeCellSize: plot.material.wireframeCellSize ?? 4,
        },
        {
          type: 'build_parametric_mesh',
          jobId: finalJobId,
          objectId: plot.id,
          spec: plot.equation,
          priority: 'refine',
          wireframeCellSize: plot.material.wireframeCellSize ?? 4,
        },
      ];
    case 'implicit_surface':
      return [
        {
          type: 'build_implicit_mesh',
          jobId: previewJobId,
          objectId: plot.id,
          spec: plot.equation,
          priority: 'preview',
        },
        {
          type: 'build_implicit_mesh',
          jobId: finalJobId,
          objectId: plot.id,
          spec: plot.equation,
          priority: 'refine',
        },
      ];
  }
}

function handleMathWorkerMessage(
  msg: WorkerResponse,
  latestParseJobs: Map<UUID, string>,
  jobMeta: Map<string, JobMeta>,
): void {
  const actions = useAppStore.getState();
  switch (msg.type) {
    case 'parse_progress': {
      if (latestParseJobs.get(msg.objectId) !== msg.jobId) return;
      actions.upsertPlotJobStatus(msg.objectId, {
        parsePhase: 'parsing',
        progress: Math.min(0.45, 0.05 + msg.progress * 0.4),
        message: `Parsing: ${msg.phase}`,
      });
      return;
    }
    case 'parse_result': {
      if (latestParseJobs.get(msg.objectId) !== msg.jobId) return;
      const meta = jobMeta.get(msg.jobId);
      actions.applyAsyncPlotSource(msg.objectId, meta?.rawText ?? msg.result.source.rawText, msg.result.source);
      actions.upsertPlotJobStatus(msg.objectId, {
        parsePhase: 'ready',
        progress: 1,
        message: 'Parse ready',
      });
      jobMeta.delete(msg.jobId);
      return;
    }
    case 'job_error': {
      const meta = jobMeta.get(msg.jobId);
      if (!meta || meta.kind !== 'parse') return;
      if (latestParseJobs.get(msg.objectId) !== msg.jobId) return;
      actions.upsertPlotJobStatus(msg.objectId, {
        parsePhase: 'error',
        progress: 0,
        message: msg.message,
        lastError: msg.message,
      });
      jobMeta.delete(msg.jobId);
      return;
    }
    case 'cancel_ack':
    case 'mesh_preview':
    case 'mesh_final':
    case 'mesh_progress':
      return;
  }
}

function handleMeshWorkerMessage(
  msg: WorkerResponse,
  latestPreviewJobs: Map<UUID, string>,
  latestFinalJobs: Map<UUID, string>,
  jobMeta: Map<string, JobMeta>,
): void {
  const actions = useAppStore.getState();
  switch (msg.type) {
    case 'mesh_progress': {
      const isPreview = latestPreviewJobs.get(msg.objectId) === msg.jobId;
      const isFinal = latestFinalJobs.get(msg.objectId) === msg.jobId;
      if (!isPreview && !isFinal) return;
      actions.upsertPlotJobStatus(msg.objectId, {
        meshPhase: isPreview ? 'mesh_preview' : 'mesh_final',
        progress: isPreview ? 0.1 + msg.progress * 0.35 : 0.55 + msg.progress * 0.35,
        message: `${isPreview ? 'Preview' : 'Final'}: ${msg.phase}`,
      });
      return;
    }
    case 'mesh_preview': {
      if (latestPreviewJobs.get(msg.objectId) !== msg.jobId) return;
      setRuntimePlotMesh(msg.objectId, msg.mesh);
      const meta = jobMeta.get(msg.jobId);
      const buildMs = meta ? Math.round(performance.now() - meta.startedAt) : undefined;
      actions.bumpPlotMeshVersion(msg.objectId, {
        hasPreview: true,
        buildMs,
        phase: 'mesh_preview',
        progress: 0.78,
        message: 'Preview ready',
      });
      jobMeta.delete(msg.jobId);
      return;
    }
    case 'mesh_final': {
      if (latestFinalJobs.get(msg.objectId) !== msg.jobId) return;
      setRuntimePlotMesh(msg.objectId, msg.mesh);
      const meta = jobMeta.get(msg.jobId);
      const buildMs = meta ? Math.round(performance.now() - meta.startedAt) : undefined;
      actions.bumpPlotMeshVersion(msg.objectId, {
        hasPreview: true,
        buildMs,
        phase: 'ready',
        progress: 1,
        message: 'Mesh ready',
      });
      jobMeta.delete(msg.jobId);
      return;
    }
    case 'job_error': {
      const isPreview = latestPreviewJobs.get(msg.objectId) === msg.jobId;
      const isFinal = latestFinalJobs.get(msg.objectId) === msg.jobId;
      if (!isPreview && !isFinal) return;
      actions.setPlotJobError(msg.objectId, msg.message);
      jobMeta.delete(msg.jobId);
      return;
    }
    case 'cancel_ack':
    case 'parse_progress':
    case 'parse_result':
      return;
  }
}

function ensureJobStateExists(objectId: UUID): void {
  useAppStore.getState().upsertPlotJobStatus(objectId, {});
}

function buildMeshSignature(plot: PlotObject): string {
  return JSON.stringify({
    equation: plot.equation,
    wireframeCellSize: plot.material.wireframeCellSize ?? 4,
  });
}

function clearTimer(map: Map<UUID, number>, objectId: UUID): void {
  const timer = map.get(objectId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    map.delete(objectId);
  }
}

function postCancel(worker: Worker | null, objectId: UUID): void {
  if (!worker) return;
  const req: WorkerRequest = {
    type: 'cancel_jobs',
    jobId: newJobId(),
    objectId,
  };
  worker.postMessage(req);
}

let fallbackIdCounter = 0;
function newJobId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  fallbackIdCounter += 1;
  return `job-${Date.now()}-${fallbackIdCounter}`;
}
