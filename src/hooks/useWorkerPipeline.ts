import { useEffect, useRef } from 'react';
import { useAppStore } from '../state/store';
import type {
  IntersectionObject,
  PlotJobStatus,
  PlotObject,
  SerializedMesh,
  WorkerRequest,
  WorkerResponse,
  UUID,
} from '../types/contracts';
import { isSurfacePlot } from '../types/guards';
import {
  clearRuntimePlotMesh,
  clearAllRuntimePlotMeshes,
  getRuntimePlotMesh,
  setRuntimePlotMesh,
} from '../workers/runtimeMeshCache';

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
  derivedIntersection?: boolean;
};

type WorkersRef = {
  math: Worker | null;
  mesh: Worker | null;
  intersection: Worker | null;
};

type MeshScheduleMode = 'interactive' | 'settled';

type MeshTimerEntry = {
  timer: number;
  mode: MeshScheduleMode;
  plot: PlotObject;
};

type IntersectionScheduleEntry = {
  timer: number | null;
  running: boolean;
  dirty: boolean;
  interactive: boolean;
};

const INTERACTIVE_MESH_THROTTLE_MS = 32;
const INTERACTIVE_INTERSECTION_THROTTLE_MS = 140;
const SETTLED_INTERSECTION_THROTTLE_MS = 48;

export function useWorkerPipeline(): void {
  const objects = useAppStore((s) => s.objects);
  const plotJobs = useAppStore((s) => s.plotJobs);
  const activeEquationParameterDrag = useAppStore((s) => s.activeEquationParameterDrag);
  const workersRef = useRef<WorkersRef>({ math: null, mesh: null, intersection: null });
  const sigsRef = useRef<Map<UUID, PlotSignatures>>(new Map());
  const parseTimerRef = useRef<Map<UUID, number>>(new Map());
  const meshTimerRef = useRef<Map<UUID, MeshTimerEntry>>(new Map());
  const intersectionScheduleRef = useRef<Map<UUID, IntersectionScheduleEntry>>(new Map());
  const latestParseJobRef = useRef<Map<UUID, string>>(new Map());
  const latestMeshPreviewJobRef = useRef<Map<UUID, string>>(new Map());
  const latestMeshFinalJobRef = useRef<Map<UUID, string>>(new Map());
  const jobMetaRef = useRef<Map<string, JobMeta>>(new Map());

  useEffect(() => {
    const mathWorker = new Worker(new URL('../workers/mathWorker.ts', import.meta.url), { type: 'module' });
    const meshWorker = new Worker(new URL('../workers/meshWorker.ts', import.meta.url), { type: 'module' });
    const intersectionWorker = new Worker(new URL('../workers/meshWorker.ts', import.meta.url), { type: 'module' });
    workersRef.current = { math: mathWorker, mesh: meshWorker, intersection: intersectionWorker };
    const parseTimers = parseTimerRef.current;
    const meshTimers = meshTimerRef.current;
    const intersectionSchedules = intersectionScheduleRef.current;
    const plotSignatures = sigsRef.current;
    const latestParseJobs = latestParseJobRef.current;
    const latestPreviewJobs = latestMeshPreviewJobRef.current;
    const latestFinalJobs = latestMeshFinalJobRef.current;
    const jobMeta = jobMetaRef.current;

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
        intersectionScheduleRef.current,
      );
    };
    intersectionWorker.onmessage = meshWorker.onmessage;

    return () => {
      for (const timer of parseTimers.values()) {
        window.clearTimeout(timer);
      }
      for (const timer of meshTimers.values()) {
        window.clearTimeout(timer.timer);
      }
      for (const entry of intersectionSchedules.values()) {
        if (entry.timer !== null) window.clearTimeout(entry.timer);
      }
      parseTimers.clear();
      meshTimers.clear();
      intersectionSchedules.clear();
      plotSignatures.clear();
      latestParseJobs.clear();
      latestPreviewJobs.clear();
      latestFinalJobs.clear();
      jobMeta.clear();
      clearAllRuntimePlotMeshes();
      mathWorker.terminate();
      meshWorker.terminate();
      intersectionWorker.terminate();
      workersRef.current = { math: null, mesh: null, intersection: null };
    };
  }, []);

  useEffect(() => {
    const renderableIds = new Set(
      objects.filter((object) => object.type === 'plot' || object.type === 'intersection').map((object) => object.id),
    );

    // Cleanup removed plots.
    for (const objectId of [...sigsRef.current.keys()]) {
      if (renderableIds.has(objectId)) continue;
      sigsRef.current.delete(objectId);
      clearTimer(parseTimerRef.current, objectId);
      clearTimer(meshTimerRef.current, objectId);
      clearIntersectionSchedule(intersectionScheduleRef.current, objectId);
      clearRuntimePlotMesh(objectId);
      useAppStore.getState().clearPlotJobStatus(objectId);
      invalidateObjectJobs(
        objectId,
        latestParseJobRef.current,
        latestMeshPreviewJobRef.current,
        latestMeshFinalJobRef.current,
        jobMetaRef.current,
      );
      postCancel(workersRef.current.math, objectId);
      postCancel(workersRef.current.mesh, objectId);
      postCancel(workersRef.current.intersection, objectId);
    }

    for (const object of objects) {
      if (object.type !== 'plot') continue;
      ensureJobStateExists(object.id);
      // Animated parameters stream value changes every frame, so they take the
      // same throttled interactive path as an active slider drag.
      const isInteractive = activeEquationParameterDrag?.plotId === object.id
        || object.equation.parameters.some(
          (parameter) => parameter.samplingMode === 'continuous' && parameter.animating,
        );
      const nextSigs = {
        parse: object.equation.source.rawText,
        mesh: buildMeshSignature(object, isInteractive),
      };
      const prev = sigsRef.current.get(object.id);
      if (!prev || prev.parse !== nextSigs.parse) {
        scheduleParse(workersRef.current, parseTimerRef.current, latestParseJobRef.current, jobMetaRef.current, object);
      }
      if (!prev || prev.mesh !== nextSigs.mesh) {
        scheduleMesh(
          workersRef.current,
          meshTimerRef.current,
          latestMeshPreviewJobRef.current,
          latestMeshFinalJobRef.current,
          jobMetaRef.current,
          object,
          { interactive: isInteractive },
        );
      }
      sigsRef.current.set(object.id, nextSigs);
    }

    for (const object of objects) {
      if (object.type !== 'intersection') continue;
      ensureJobStateExists(object.id);
      const sourceA = objects.find((candidate) => candidate.id === object.sourceSurfaceIds[0]);
      const sourceB = objects.find((candidate) => candidate.id === object.sourceSurfaceIds[1]);
      const sourcesValid = isSurfacePlot(sourceA)
        && isSurfacePlot(sourceB)
        && sourceA.id !== sourceB.id;
      const sourcesHaveValidEquations = sourcesValid
        && sourceA.equation.source.parseStatus === 'ok'
        && sourceB.equation.source.parseStatus === 'ok';
      const sourcesInteractive = sourcesValid && (
        sourceIsInteractive(sourceA, activeEquationParameterDrag?.plotId)
        || sourceIsInteractive(sourceB, activeEquationParameterDrag?.plotId)
      );
      const nextSigs: PlotSignatures = {
        parse: object.sourceSurfaceIds.join('|'),
        mesh: JSON.stringify({
          interactive: sourcesInteractive,
          sourceA: isSurfacePlot(sourceA) ? {
            equation: sourceA.equation,
            transform: sourceA.transform,
            meshVersion: plotJobs[sourceA.id]?.meshVersion ?? 0,
          } : null,
          sourceB: isSurfacePlot(sourceB) ? {
            equation: sourceB.equation,
            transform: sourceB.transform,
            meshVersion: plotJobs[sourceB.id]?.meshVersion ?? 0,
          } : null,
        }),
      };
      const prev = sigsRef.current.get(object.id);
      const sourcesChanged = !prev || prev.parse !== nextSigs.parse;
      const dependenciesChanged = !prev || prev.mesh !== nextSigs.mesh;
      if (sourcesChanged || !sourcesValid || !sourcesHaveValidEquations) {
        clearIntersectionSchedule(intersectionScheduleRef.current, object.id);
        markIntersectionWaiting(
          object.id,
          sourcesValid ? 'Waiting for valid source meshes' : 'Choose two surface objects',
          workersRef.current,
          latestMeshPreviewJobRef.current,
          latestMeshFinalJobRef.current,
          jobMetaRef.current,
        );
        if (sourcesHaveValidEquations) {
          requestIntersectionBuild(
            workersRef.current,
            intersectionScheduleRef.current,
            latestMeshPreviewJobRef.current,
            latestMeshFinalJobRef.current,
            jobMetaRef.current,
            object,
            sourceA,
            sourceB,
            plotJobs,
            sourcesInteractive,
          );
        }
      } else if (dependenciesChanged) {
        requestIntersectionBuild(
          workersRef.current,
          intersectionScheduleRef.current,
          latestMeshPreviewJobRef.current,
          latestMeshFinalJobRef.current,
          jobMetaRef.current,
          object,
          sourceA,
          sourceB,
          plotJobs,
          sourcesInteractive,
        );
      } else {
        const pending = intersectionScheduleRef.current.get(object.id);
        if (pending?.dirty && !pending.running && pending.timer === null) {
          requestIntersectionBuild(
            workersRef.current,
            intersectionScheduleRef.current,
            latestMeshPreviewJobRef.current,
            latestMeshFinalJobRef.current,
            jobMetaRef.current,
            object,
            sourceA,
            sourceB,
            plotJobs,
            sourcesInteractive,
          );
        }
      }
      sigsRef.current.set(object.id, nextSigs);
    }
  }, [activeEquationParameterDrag, objects, plotJobs]);
}

function requestIntersectionBuild(
  workers: WorkersRef,
  scheduleMap: Map<UUID, IntersectionScheduleEntry>,
  latestPreviewRef: Map<UUID, string>,
  latestFinalRef: Map<UUID, string>,
  jobMetaRef: Map<string, JobMeta>,
  intersection: IntersectionObject,
  sourceA: PlotObject,
  sourceB: PlotObject,
  plotJobs: Record<UUID, PlotJobStatus>,
  interactive: boolean,
): void {
  const existing = scheduleMap.get(intersection.id);
  if (existing) {
    existing.dirty = true;
    existing.interactive = interactive;
    scheduleMap.set(intersection.id, existing);
    if (existing.running || existing.timer !== null) return;
  }
  const entry = existing ?? { timer: null, running: false, dirty: true, interactive };
  scheduleMap.set(intersection.id, entry);
  const sourcesReady = sourceMeshIsCurrent(sourceA, plotJobs[sourceA.id], interactive)
    && sourceMeshIsCurrent(sourceB, plotJobs[sourceB.id], interactive);
  useAppStore.getState().upsertPlotJobStatus(intersection.id, {
    parsePhase: 'skipped',
    meshPhase: 'queued',
    progress: 0.03,
    message: sourcesReady ? 'Intersection queued' : 'Waiting for source meshes',
    lastError: undefined,
  });

  entry.timer = window.setTimeout(() => {
    const currentEntry = scheduleMap.get(intersection.id);
    if (!currentEntry) return;
    currentEntry.timer = null;
    const state = useAppStore.getState();
    const current = state.objects.find((object) => object.id === intersection.id);
    if (!current || current.type !== 'intersection') return;
    const currentA = state.objects.find((object) => object.id === current.sourceSurfaceIds[0]);
    const currentB = state.objects.find((object) => object.id === current.sourceSurfaceIds[1]);
    if (!isSurfacePlot(currentA) || !isSurfacePlot(currentB) || currentA.id === currentB.id) {
      markIntersectionWaiting(
        current.id,
        'Choose two surface objects',
        workers,
        latestPreviewRef,
        latestFinalRef,
        jobMetaRef,
      );
      clearIntersectionSchedule(scheduleMap, current.id);
      return;
    }
    const currentAJob = state.plotJobs[currentA.id];
    const currentBJob = state.plotJobs[currentB.id];
    const currentInteractive = sourceIsInteractive(currentA, state.activeEquationParameterDrag?.plotId)
      || sourceIsInteractive(currentB, state.activeEquationParameterDrag?.plotId);
    const meshA = getRuntimePlotMesh(currentA.id);
    const meshB = getRuntimePlotMesh(currentB.id);
    if (
      !sourceMeshIsCurrent(currentA, currentAJob, currentInteractive)
      || !sourceMeshIsCurrent(currentB, currentBJob, currentInteractive)
      || !meshA
      || !meshB
    ) {
      useAppStore.getState().upsertPlotJobStatus(current.id, {
        parsePhase: 'skipped',
        meshPhase: 'queued',
        progress: 0.03,
        message: 'Waiting for source meshes',
      });
      return;
    }

    currentEntry.running = true;
    currentEntry.dirty = false;
    scheduleMap.set(current.id, currentEntry);
    postCancel(workers.intersection, current.id);
    const finalBuild = currentAJob?.meshPhase === 'ready'
      && currentBJob?.meshPhase === 'ready';
    const jobId = newJobId();
    if (finalBuild) {
      latestFinalRef.set(current.id, jobId);
      latestPreviewRef.delete(current.id);
    } else {
      latestPreviewRef.set(current.id, jobId);
      latestFinalRef.delete(current.id);
    }
    jobMetaRef.set(jobId, {
      objectId: current.id,
      kind: finalBuild ? 'mesh_final' : 'mesh_preview',
      startedAt: performance.now(),
      derivedIntersection: true,
    });
    useAppStore.getState().upsertPlotJobStatus(current.id, {
      parsePhase: 'skipped',
      meshPhase: finalBuild ? 'mesh_final' : 'mesh_preview',
      progress: 0.08,
      message: finalBuild ? 'Building intersection' : 'Building intersection preview',
    });

    const positionsA = new Float32Array(meshA.positions);
    const indicesA = new Uint32Array(meshA.indices);
    const positionsB = new Float32Array(meshB.positions);
    const indicesB = new Uint32Array(meshB.indices);
    const req: WorkerRequest = {
      type: 'build_surface_intersection_mesh',
      jobId,
      objectId: current.id,
      sourceA: { positions: positionsA, indices: indicesA, translation: currentA.transform.position },
      sourceB: { positions: positionsB, indices: indicesB, translation: currentB.transform.position },
      priority: finalBuild ? 'refine' : 'preview',
    };
    workers.intersection?.postMessage(req, [positionsA.buffer, indicesA.buffer, positionsB.buffer, indicesB.buffer]);
  }, interactive
    ? INTERACTIVE_INTERSECTION_THROTTLE_MS
    : sourcesReady ? SETTLED_INTERSECTION_THROTTLE_MS : INTERACTIVE_MESH_THROTTLE_MS);

  scheduleMap.set(intersection.id, entry);
}

function markIntersectionWaiting(
  objectId: UUID,
  message: string,
  workers: WorkersRef,
  latestPreviewRef: Map<UUID, string>,
  latestFinalRef: Map<UUID, string>,
  jobMetaRef: Map<string, JobMeta>,
): void {
  postCancel(workers.intersection, objectId);
  invalidateMeshJobs(objectId, latestPreviewRef, latestFinalRef, jobMetaRef);
  const previous = getRuntimePlotMesh(objectId);
  setRuntimePlotMesh(objectId, emptyCurveMesh());
  const state = useAppStore.getState();
  if (previous && hasCurveData(previous)) {
    state.bumpPlotMeshVersion(objectId, {
      phase: 'skipped',
      progress: 0,
      hasPreview: false,
      message,
    });
  } else {
    state.upsertPlotJobStatus(objectId, {
      parsePhase: 'skipped',
      meshPhase: 'skipped',
      progress: 0,
      hasPreview: false,
      message,
      lastError: undefined,
    });
  }
}

function sourceMeshIsCurrent(
  source: PlotObject,
  job: PlotJobStatus | undefined,
  allowQueuedPreview = false,
): boolean {
  return source.equation.source.parseStatus === 'ok'
    && Boolean(job && job.meshVersion > 0)
    && (allowQueuedPreview
      || Boolean(job?.hasPreview)
        && (job?.meshPhase === 'mesh_preview' || job?.meshPhase === 'mesh_final' || job?.meshPhase === 'ready'));
}

function sourceIsInteractive(source: PlotObject, activeDragPlotId: UUID | undefined): boolean {
  return source.id === activeDragPlotId
    || source.equation.parameters.some(
      (parameter) => parameter.samplingMode === 'continuous' && parameter.animating,
    );
}

function hasCurveData(mesh: SerializedMesh): boolean {
  return Boolean(mesh.curvePath?.length)
    || Boolean(mesh.curvePaths?.some((path) => path.length >= 6));
}

function emptyCurveMesh(): SerializedMesh {
  return {
    positions: new Float32Array(0),
    indices: new Uint32Array(0),
    curvePaths: [],
    bounds: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 0, y: 0, z: 0 },
      center: { x: 0, y: 0, z: 0 },
      radius: 0,
    },
    boundaryEdges: new Float32Array(0),
    featureEdges: new Float32Array(0),
    topology: {
      isClosedManifold: false,
      hasBoundaryEdges: false,
      hasFeatureEdges: false,
      boundaryEdgeCount: 0,
      featureEdgeCount: 0,
    },
  };
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
      graphExpression: plot.equation.kind === 'explicit_surface' && plot.equation.graphExpression,
    };
    workers.math?.postMessage(req);
  }, 120);

  timerMap.set(plot.id, timer);
}

function scheduleMesh(
  workers: WorkersRef,
  timerMap: Map<UUID, MeshTimerEntry>,
  latestPreviewRef: Map<UUID, string>,
  latestFinalRef: Map<UUID, string>,
  jobMetaRef: Map<string, JobMeta>,
  plot: PlotObject,
  options: { interactive: boolean },
): void {
  if (plot.equation.source.parseStatus !== 'ok') {
    invalidateMeshJobs(plot.id, latestPreviewRef, latestFinalRef, jobMetaRef);
    postCancel(workers.mesh, plot.id);
    clearTimer(timerMap, plot.id);
    useAppStore.getState().upsertPlotJobStatus(plot.id, {
      meshPhase: 'skipped',
      progress: 0,
      message: 'Waiting for valid equation',
      hasPreview: false,
    });
    return;
  }

  if (options.interactive) {
    scheduleInteractiveMesh(timerMap, workers, latestPreviewRef, latestFinalRef, jobMetaRef, plot);
    return;
  }

  invalidateMeshJobs(plot.id, latestPreviewRef, latestFinalRef, jobMetaRef);
  postCancel(workers.mesh, plot.id);
  clearTimer(timerMap, plot.id);
  useAppStore.getState().upsertPlotJobStatus(plot.id, {
    meshPhase: 'queued',
    progress: 0.03,
    message: 'Meshing queued',
    hasPreview: false,
    lastError: undefined,
  });

  const timer = window.setTimeout(() => {
    timerMap.delete(plot.id);
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

    const [previewReq, finalReq] = buildSettledMeshRequests(plot, previewJobId, finalJobId);
    workers.mesh?.postMessage(previewReq);
    workers.mesh?.postMessage(finalReq);
  }, plot.equation.kind === 'implicit_surface' ? 220 : 140);

  timerMap.set(plot.id, {
    timer,
    mode: 'settled',
    plot,
  });
}

function scheduleInteractiveMesh(
  timerMap: Map<UUID, MeshTimerEntry>,
  workers: WorkersRef,
  latestPreviewRef: Map<UUID, string>,
  latestFinalRef: Map<UUID, string>,
  jobMetaRef: Map<string, JobMeta>,
  plot: PlotObject,
): void {
  const pending = timerMap.get(plot.id);
  if (pending?.mode === 'interactive') {
    pending.plot = plot;
    timerMap.set(plot.id, pending);
    return;
  }

  clearTimer(timerMap, plot.id);
  useAppStore.getState().upsertPlotJobStatus(plot.id, {
    meshPhase: 'queued',
    progress: 0.03,
    message: 'Interactive mesh queued',
    hasPreview: false,
    lastError: undefined,
  });

  const entry: MeshTimerEntry = {
    timer: 0,
    mode: 'interactive',
    plot,
  };
  entry.timer = window.setTimeout(() => {
    const latest = timerMap.get(plot.id);
    if (!latest || latest.mode !== 'interactive') {
      return;
    }
    timerMap.delete(plot.id);
    postCancel(workers.mesh, plot.id);
    const previewJobId = newJobId();
    latestPreviewRef.set(plot.id, previewJobId);
    latestFinalRef.delete(plot.id);
    jobMetaRef.set(previewJobId, { objectId: plot.id, kind: 'mesh_preview', startedAt: performance.now() });

    useAppStore.getState().upsertPlotJobStatus(plot.id, {
      meshPhase: 'mesh_preview',
      progress: 0.08,
      message: 'Meshing interactive preview',
      hasPreview: false,
    });

    workers.mesh?.postMessage(buildMeshRequest(latest.plot, previewJobId, 'interactive'));
  }, INTERACTIVE_MESH_THROTTLE_MS);

  timerMap.set(plot.id, entry);
}

function buildSettledMeshRequests(plot: PlotObject, previewJobId: string, finalJobId: string): [WorkerRequest, WorkerRequest] {
  return [
    buildMeshRequest(plot, previewJobId, 'preview'),
    buildMeshRequest(plot, finalJobId, 'refine'),
  ];
}

function buildMeshRequest(
  plot: PlotObject,
  jobId: string,
  priority: 'preview' | 'refine' | 'interactive',
): WorkerRequest {
  switch (plot.equation.kind) {
    case 'parametric_curve':
      return {
        type: 'build_curve_mesh',
        jobId,
        objectId: plot.id,
        spec: plot.equation,
        priority,
      };
    case 'parametric_surface':
    case 'explicit_surface':
      return {
        type: 'build_parametric_mesh',
        jobId,
        objectId: plot.id,
        spec: plot.equation,
        priority,
        wireframeCellSize: plot.material.wireframeCellSize ?? 4,
      };
    case 'implicit_surface':
      return {
        type: 'build_implicit_mesh',
        jobId,
        objectId: plot.id,
        spec: plot.equation,
        priority,
      };
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
  intersectionSchedules: Map<UUID, IntersectionScheduleEntry>,
): void {
  const actions = useAppStore.getState();
  switch (msg.type) {
    case 'mesh_progress': {
      const isPreview = latestPreviewJobs.get(msg.objectId) === msg.jobId;
      const isFinal = latestFinalJobs.get(msg.objectId) === msg.jobId;
      if (!isPreview && !isFinal) return;
      if (!actions.objects.some((object) => object.id === msg.objectId)) return;
      actions.upsertPlotJobStatus(msg.objectId, {
        meshPhase: isPreview ? 'mesh_preview' : 'mesh_final',
        progress: isPreview ? 0.1 + msg.progress * 0.35 : 0.55 + msg.progress * 0.35,
        message: `${isPreview ? 'Preview' : 'Final'}: ${msg.phase}`,
      });
      return;
    }
    case 'mesh_preview': {
      if (latestPreviewJobs.get(msg.objectId) !== msg.jobId) return;
      if (!actions.objects.some((object) => object.id === msg.objectId)) return;
      setRuntimePlotMesh(msg.objectId, msg.mesh);
      const meta = jobMeta.get(msg.jobId);
      if (meta?.derivedIntersection) settleIntersectionSchedule(msg.objectId, intersectionSchedules);
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
      if (!actions.objects.some((object) => object.id === msg.objectId)) return;
      setRuntimePlotMesh(msg.objectId, msg.mesh);
      const meta = jobMeta.get(msg.jobId);
      if (meta?.derivedIntersection) settleIntersectionSchedule(msg.objectId, intersectionSchedules);
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
      if (!actions.objects.some((object) => object.id === msg.objectId)) return;
      const meta = jobMeta.get(msg.jobId);
      if (meta?.derivedIntersection) settleIntersectionSchedule(msg.objectId, intersectionSchedules);
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

function settleIntersectionSchedule(
  objectId: UUID,
  scheduleMap: Map<UUID, IntersectionScheduleEntry>,
): void {
  const entry = scheduleMap.get(objectId);
  if (!entry) return;
  entry.running = false;
  scheduleMap.set(objectId, entry);
}

function invalidateMeshJobs(
  objectId: UUID,
  latestPreviewJobs: Map<UUID, string>,
  latestFinalJobs: Map<UUID, string>,
  jobMeta: Map<string, JobMeta>,
): void {
  const previewJobId = latestPreviewJobs.get(objectId);
  const finalJobId = latestFinalJobs.get(objectId);
  latestPreviewJobs.delete(objectId);
  latestFinalJobs.delete(objectId);
  if (previewJobId) jobMeta.delete(previewJobId);
  if (finalJobId) jobMeta.delete(finalJobId);
}

function invalidateObjectJobs(
  objectId: UUID,
  latestParseJobs: Map<UUID, string>,
  latestPreviewJobs: Map<UUID, string>,
  latestFinalJobs: Map<UUID, string>,
  jobMeta: Map<string, JobMeta>,
): void {
  const parseJobId = latestParseJobs.get(objectId);
  latestParseJobs.delete(objectId);
  if (parseJobId) jobMeta.delete(parseJobId);
  invalidateMeshJobs(objectId, latestPreviewJobs, latestFinalJobs, jobMeta);
  for (const [jobId, meta] of jobMeta) {
    if (meta.objectId === objectId) jobMeta.delete(jobId);
  }
}

function ensureJobStateExists(objectId: UUID): void {
  useAppStore.getState().upsertPlotJobStatus(objectId, {});
}

function buildMeshSignature(plot: PlotObject, interactive: boolean): string {
  return JSON.stringify({
    equation: plot.equation,
    interactive,
    wireframeCellSize: plot.material.wireframeCellSize ?? 4,
  });
}

function clearTimer<T extends number | MeshTimerEntry>(map: Map<UUID, T>, objectId: UUID): void {
  const timer = map.get(objectId);
  if (timer !== undefined) {
    window.clearTimeout(typeof timer === 'number' ? timer : timer.timer);
    map.delete(objectId);
  }
}

function clearIntersectionSchedule(
  map: Map<UUID, IntersectionScheduleEntry>,
  objectId: UUID,
): void {
  const entry = map.get(objectId);
  if (entry?.timer !== null && entry?.timer !== undefined) {
    window.clearTimeout(entry.timer);
  }
  map.delete(objectId);
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
