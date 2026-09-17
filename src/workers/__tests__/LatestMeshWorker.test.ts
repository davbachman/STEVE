import { afterEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => vi.useRealTimers());

  it('starts workers only when a plot needs meshing', () => {
    const h = harness();
    expect(h.workers).toHaveLength(0);
    h.queue.postMessage({ type: 'cancel_jobs', jobId: 'cancel', objectId: 'plot' });
    expect(h.workers).toHaveLength(0);
    h.queue.postMessage(request('first'));
    expect(h.workers).toHaveLength(1);
  });

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

  it('retries an interrupted equation once and then continues pending work', () => {
    const h = harness();
    h.queue.postMessage(request('old'));
    h.queue.postMessage(request('new'));
    h.workers[0].onerror?.({ preventDefault: vi.fn() } as unknown as ErrorEvent);
    expect(h.onMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'job_error' }));
    expect(h.workers).toHaveLength(2);
    expect(h.workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(h.workers[1].postMessage).toHaveBeenCalledWith(request('old'), undefined);
    h.finish('old');
    expect(h.onStart.mock.calls.map(([req]) => req.jobId)).toEqual(['old', 'old', 'new']);
  });

  it('stops retrying persistent failures and preserves the browser error', () => {
    const h = harness();
    h.queue.postMessage(request('failed'));
    const failure = { preventDefault: vi.fn(), message: 'Worker script failed to load' } as unknown as ErrorEvent;
    h.workers[0].onerror?.(failure);
    h.workers[1].onerror?.(failure);
    expect(h.workers).toHaveLength(2);
    expect(h.onMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'job_error', jobId: 'failed', message: expect.stringContaining('Worker script failed to load'),
    }));
    h.queue.postMessage(request('later'));
    expect(h.workers).toHaveLength(3);
    h.finish('later');
  });

  it('does not respawn an idle worker after it fails', () => {
    const h = harness();
    h.queue.postMessage(request('first'));
    h.finish('first');
    h.workers[0].onerror?.({ preventDefault: vi.fn() } as unknown as ErrorEvent);
    expect(h.workers).toHaveLength(1);
    expect(h.workers[0].terminate).toHaveBeenCalledTimes(1);
    h.queue.postMessage(request('next'));
    expect(h.workers).toHaveLength(2);
  });

  it('releases the idle heap, but never terminates an active calculation', () => {
    vi.useFakeTimers();
    const h = harness();
    h.queue.postMessage(request('first'));
    h.finish('first');
    vi.advanceTimersByTime(29_000);
    expect(h.workers[0].terminate).not.toHaveBeenCalled();
    h.queue.postMessage(request('long-build'));
    vi.advanceTimersByTime(60_000);
    expect(h.workers[0].terminate).not.toHaveBeenCalled();
    h.finish('long-build');
    vi.advanceTimersByTime(30_000);
    expect(h.workers[0].terminate).toHaveBeenCalledTimes(1);
    h.queue.postMessage(request('next'));
    expect(h.workers).toHaveLength(2);
  });

  it('handles worker constructor failures without throwing or retrying indefinitely', () => {
    const onMessage = vi.fn();
    const createWorker = vi.fn(() => { throw new Error('Worker limit reached'); });
    const queue = new LatestMeshWorker(createWorker, onMessage, vi.fn(), vi.fn());
    const buffer = new ArrayBuffer(1024);
    const source = { positions: new Float32Array(buffer), indices: new Uint32Array(), translation: { x: 0, y: 0, z: 0 } };
    const req: WorkerRequest = { type: 'build_surface_intersection_mesh', jobId: 'first', objectId: 'plot', sourceA: source, sourceB: source, priority: 'refine' };
    expect(() => queue.postMessage(req, [buffer])).not.toThrow();
    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'job_error', message: expect.stringContaining('Worker limit reached'),
    }));
    expect(buffer.byteLength).toBe(1024);
    // Failed startup must release unsent buffers, rather than retaining them for
    // the entire session after the failed request has left the queue.
    expect(queue['transfers'].size).toBe(0);
  });

  it('never retries requests whose transferred buffers were detached', () => {
    const h = harness();
    const sourceA = { positions: new Float32Array([0, 0, 0]), indices: new Uint32Array([0]), translation: { x: 0, y: 0, z: 0 } };
    const sourceB = { positions: new Float32Array([1, 0, 0]), indices: new Uint32Array([0]), translation: { x: 0, y: 0, z: 0 } };
    const req: WorkerRequest = { type: 'build_surface_intersection_mesh', jobId: 'intersection', objectId: 'plot', sourceA, sourceB, priority: 'refine' };
    h.queue.postMessage(req, [sourceA.positions.buffer, sourceA.indices.buffer, sourceB.positions.buffer, sourceB.indices.buffer]);
    h.workers[0].onerror?.({ preventDefault: vi.fn() } as unknown as ErrorEvent);
    expect(h.workers).toHaveLength(1);
    expect(h.onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'job_error', jobId: 'intersection' }));
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
