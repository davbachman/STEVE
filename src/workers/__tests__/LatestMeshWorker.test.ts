import { describe, expect, it, vi } from 'vitest';
import { LatestMeshWorker, type MeshWorkerTransport } from '../LatestMeshWorker';
import type { WorkerRequest, WorkerResponse } from '../../types/contracts';
import { createDefaultCurve } from '../../state/defaults';

function request(id: string, objectId = 'plot'): WorkerRequest {
  const plot = createDefaultCurve(objectId);
  if (plot.equation.kind !== 'parametric_curve') throw new Error('Expected curve');
  return { type: 'build_curve_mesh', jobId: id, objectId, spec: plot.equation, priority: 'interactive' };
}

function harness() {
  const workers: MeshWorkerTransport[] = [];
  const onMessage = vi.fn();
  const onStart = vi.fn();
  const onDiscard = vi.fn();
  const queue = new LatestMeshWorker(() => {
    const worker: MeshWorkerTransport = {
      postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null, onmessageerror: null,
    };
    workers.push(worker);
    return worker;
  }, onMessage, onStart, onDiscard);
  const finish = (id: string, worker = workers.at(-1)!) => worker.onmessage?.({ data: {
    type: 'mesh_preview', jobId: id, objectId: 'plot',
    mesh: { positions: new Float32Array(), indices: new Uint32Array() },
  } } as MessageEvent<WorkerResponse>);
  return { workers, queue, onMessage, onStart, onDiscard, finish };
}

describe('latest mesh worker', () => {
  it('finishes the running animation frame and replaces all obsolete pending frames', () => {
    const h = harness();
    h.queue.postMessage(request('first'));
    for (let i = 0; i < 50; i++) h.queue.postMessage(request(`frame-${i}`));
    expect(h.workers[0].postMessage).toHaveBeenCalledTimes(1);
    h.finish('first');
    expect(h.onMessage).toHaveBeenCalledTimes(1);
    expect(h.onStart.mock.calls.map(([req]) => req.jobId)).toEqual(['first', 'frame-49']);
    h.finish('frame-49');
    expect(h.workers[0].postMessage).toHaveBeenCalledTimes(2);
    expect(h.onDiscard).toHaveBeenCalledTimes(49);
  });

  it('retains final refinement while allowing other objects to build', () => {
    const h = harness();
    h.queue.enqueue([request('preview'), request('final')]);
    h.queue.postMessage(request('other', 'other-plot'));
    h.finish('preview');
    h.finish('final');
    expect(h.onStart.mock.calls.map(([req]) => req.jobId)).toEqual(['preview', 'final', 'other']);
  });

  it('interrupts a canceled synchronous build and ignores messages from its old worker', () => {
    const h = harness();
    h.queue.postMessage(request('old'));
    h.queue.postMessage(request('next', 'other-plot'));
    h.queue.postMessage({ type: 'cancel_jobs', jobId: 'cancel', objectId: 'plot' });
    expect(h.workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(h.workers).toHaveLength(2);
    expect(h.onStart.mock.calls.map(([req]) => req.jobId)).toEqual(['old', 'next']);
    h.finish('old', h.workers[0]);
    expect(h.onMessage).not.toHaveBeenCalled();
  });

  it('reports a worker crash and continues pending work on a replacement', () => {
    const h = harness();
    h.queue.postMessage(request('old'));
    h.queue.postMessage(request('new'));
    h.workers[0].onerror?.({ preventDefault: vi.fn() } as unknown as ErrorEvent);
    expect(h.onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'job_error', jobId: 'old' }));
    expect(h.workers).toHaveLength(2);
    expect(h.onStart.mock.calls.map(([req]) => req.jobId)).toEqual(['old', 'new']);
  });

  it('does not resurrect workers or queued work after disposal', () => {
    const h = harness();
    h.queue.postMessage(request('old'));
    h.queue.postMessage(request('pending'));
    h.queue.terminate();
    h.finish('old');
    h.queue.postMessage(request('later'));
    expect(h.workers).toHaveLength(1);
    expect(h.onStart).toHaveBeenCalledTimes(1);
  });
});
