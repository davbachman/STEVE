import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultCurve, createDefaultGraph, createDefaultIntersection, defaultRenderSettings, defaultSceneSettings } from '../../state/defaults';
import { useAppStore } from '../../state/store';
import type { WorkerRequest, WorkerResponse } from '../../types/contracts';
import { getRuntimePlotMesh } from '../../workers/runtimeMeshCache';
import { useWorkerPipeline } from '../useWorkerPipeline';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  requests: WorkerRequest[] = [];
  transfers: Array<Transferable[] | undefined> = [];
  terminated = false;
  constructor(readonly url: URL) { ControlledWorker.instances.push(this); }
  postMessage(request: WorkerRequest, transfer?: Transferable[]) { this.requests.push(request); this.transfers.push(transfer); }
  terminate() { this.terminated = true; }
  finish(request: WorkerRequest, marker: number) {
    if (request.type === 'cancel_jobs' || request.type === 'parse_and_classify') throw new Error('Expected mesh request');
    this.onmessage?.({ data: {
      type: request.priority === 'refine' ? 'mesh_final' : 'mesh_preview',
      jobId: request.jobId,
      objectId: request.objectId,
      mesh: { positions: new Float32Array([marker, 0, 0]), indices: new Uint32Array() },
    } } as MessageEvent<WorkerResponse>);
  }
}

function Pipeline() { useWorkerPipeline(); return null; }

describe('worker pipeline scheduling', () => {
  let root: Root;
  let host: HTMLDivElement;
  let plotId: string;

  beforeEach(() => {
    vi.useFakeTimers();
    ControlledWorker.instances = [];
    vi.stubGlobal('Worker', ControlledWorker);
    const curve = createDefaultCurve('Animated curve');
    plotId = curve.id;
    useAppStore.getState().replaceProject({ schemaVersion: 1, appVersion: 'test', scene: defaultSceneSettings(), render: defaultRenderSettings(), objects: [curve] });
    useAppStore.getState().updatePlotEquationText(plotId, '(a*cos(t), sin(t), t)');
    useAppStore.getState().setParameterAnimation(plotId, 'a', { animating: true });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Pipeline />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows completed animation frames while keeping only the latest pending value, then refines on pause', () => {
    act(() => vi.advanceTimersByTime(32));
    const firstWorker = ControlledWorker.instances[1];
    const first = firstWorker.requests[0];
    expect(first.type).toBe('build_curve_mesh');
    for (let value = 2; value <= 8; value++) {
      act(() => useAppStore.getState().applyParameterAnimationValues([{ plotId, parameterName: 'a', value }]));
      act(() => vi.advanceTimersByTime(32));
    }
    expect(firstWorker.requests).toHaveLength(1);
    act(() => firstWorker.finish(first, 1));
    expect(getRuntimePlotMesh(plotId)?.positions[0]).toBe(1);
    expect(useAppStore.getState().plotJobs[plotId]?.meshVersion).toBe(1);
    expect(firstWorker.requests).toHaveLength(2);
    const newest = firstWorker.requests[1];
    if (newest.type !== 'build_curve_mesh') throw new Error('Expected curve');
    expect(newest.spec.parameters.find((parameter) => parameter.name === 'a')?.value).toBe(8);

    act(() => useAppStore.getState().setParameterAnimation(plotId, 'a', { animating: false }));
    expect(firstWorker.terminated).toBe(true);
    act(() => firstWorker.finish(newest, 999));
    expect(getRuntimePlotMesh(plotId)?.positions[0]).toBe(1);
    act(() => vi.advanceTimersByTime(140));
    const replacement = ControlledWorker.instances.at(-1)!;
    const preview = replacement.requests[0];
    act(() => replacement.finish(preview, 2));
    const final = replacement.requests[1];
    expect(final).toMatchObject({ priority: 'refine', objectId: plotId });
    act(() => replacement.finish(final, 3));
    expect(getRuntimePlotMesh(plotId)?.positions[0]).toBe(3);
    expect(useAppStore.getState().plotJobs[plotId]?.meshPhase).toBe('ready');
  });

  it('clears runtime meshes and prevents late results after an object is deleted', () => {
    act(() => vi.advanceTimersByTime(32));
    const worker = ControlledWorker.instances[1];
    const request = worker.requests[0];
    act(() => useAppStore.getState().deleteObject(plotId));
    expect(worker.terminated).toBe(true);
    act(() => worker.finish(request, 999));
    expect(getRuntimePlotMesh(plotId)).toBeUndefined();
    expect(useAppStore.getState().plotJobs[plotId]).toBeUndefined();
    act(() => vi.advanceTimersByTime(1000));
    expect(ControlledWorker.instances).toHaveLength(2);
    expect(worker.requests).toHaveLength(1);
  });

  it('rebuilds after reopening a project with the same object IDs and equations', () => {
    act(() => useAppStore.getState().setParameterAnimation(plotId, 'a', { animating: false }));
    act(() => vi.advanceTimersByTime(140));
    const worker = ControlledWorker.instances[1];
    act(() => worker.finish(worker.requests[0], 1));
    act(() => worker.finish(worker.requests[1], 2));
    expect(useAppStore.getState().plotJobs[plotId]?.meshPhase).toBe('ready');
    const sameProject = useAppStore.getState().exportProjectFile();
    const dispatchedBeforeOpen = ControlledWorker.instances.reduce((count, instance) => count + instance.requests.filter((request) => request.type === 'build_curve_mesh').length, 0);
    act(() => useAppStore.getState().replaceProject(sameProject));
    act(() => vi.advanceTimersByTime(140));
    const dispatchedAfterOpen = ControlledWorker.instances.reduce((count, instance) => count + instance.requests.filter((request) => request.type === 'build_curve_mesh').length, 0);
    expect(dispatchedAfterOpen).toBeGreaterThan(dispatchedBeforeOpen);
    expect(useAppStore.getState().plotJobs[plotId]).toBeDefined();
  });

  it('transfers source snapshots and recovers intersection scheduling after a worker crash', () => {
    const sourceA = createDefaultGraph('Surface A');
    const sourceB = createDefaultGraph('Surface B');
    const intersection = createDefaultIntersection('Intersection');
    intersection.sourceSurfaceIds = [sourceA.id, sourceB.id];
    act(() => useAppStore.getState().replaceProject({ schemaVersion: 1, appVersion: 'test', scene: defaultSceneSettings(), render: defaultRenderSettings(), objects: [sourceA, sourceB, intersection] }));
    act(() => vi.advanceTimersByTime(140));
    const surfaceWorker = ControlledWorker.instances[1];
    for (let index = 0; index < 4; index++) {
      const request = surfaceWorker.requests[index];
      expect(request.type).toBe('build_parametric_mesh');
      act(() => surfaceWorker.finish(request, index + 1));
    }
    act(() => vi.advanceTimersByTime(140));
    const intersectionWorker = ControlledWorker.instances[2];
    const request = intersectionWorker.requests[0];
    if (request.type !== 'build_surface_intersection_mesh') throw new Error('Expected intersection request');
    expect(intersectionWorker.transfers[0]).toEqual([
      request.sourceA.positions.buffer, request.sourceA.indices.buffer,
      request.sourceB.positions.buffer, request.sourceB.indices.buffer,
    ]);
    expect(request.sourceA.positions).not.toBe(getRuntimePlotMesh(sourceA.id)?.positions);

    act(() => intersectionWorker.onerror?.({ preventDefault: vi.fn() } as unknown as ErrorEvent));
    expect(intersectionWorker.terminated).toBe(true);
    expect(useAppStore.getState().plotJobs[intersection.id]?.meshPhase).toBe('error');
    act(() => useAppStore.getState().setObjectPosition(sourceA.id, { x: 1, y: 0, z: 0 }));
    act(() => vi.advanceTimersByTime(140));
    const replacement = ControlledWorker.instances.at(-1)!;
    expect(replacement).not.toBe(intersectionWorker);
    expect(replacement.requests[0]).toMatchObject({ type: 'build_surface_intersection_mesh', objectId: intersection.id });
    act(() => replacement.finish(replacement.requests[0], 42));
    expect(useAppStore.getState().plotJobs[intersection.id]?.meshPhase).toBe('ready');
    expect(getRuntimePlotMesh(intersection.id)?.positions[0]).toBe(42);
  });
});
