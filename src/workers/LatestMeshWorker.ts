import type { WorkerRequest, WorkerResponse } from '../types/contracts';

type MeshRequest = Exclude<WorkerRequest, { type: 'cancel_jobs' | 'parse_and_classify' }>;

export interface MeshWorkerTransport {
  postMessage(request: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}

/** Only one request enters the worker; each object keeps its newest pending batch.
 * Animation lets the running frame finish, while explicit cancellation replaces
 * the worker so even synchronous meshing can actually be interrupted.
 */
export class LatestMeshWorker {
  private worker: MeshWorkerTransport;
  private active: MeshRequest | null = null;
  private pending = new Map<string, MeshRequest[]>();
  private transfers = new Map<string, Transferable[]>();
  private disposed = false;

  constructor(
    private createWorker: () => MeshWorkerTransport,
    private onMessage: (message: WorkerResponse) => void,
    private onStart: (request: MeshRequest) => void,
    private onDiscard: (request: MeshRequest) => void,
  ) {
    this.worker = this.connect();
  }

  postMessage(request: WorkerRequest, transfer?: Transferable[]): void {
    if (this.disposed) return;
    if (request.type === 'cancel_jobs') {
      this.cancel(request.objectId);
    } else if (request.type !== 'parse_and_classify') {
      if (transfer) this.transfers.set(request.jobId, transfer);
      this.enqueue([request]);
    }
  }

  enqueue(requests: WorkerRequest[]): void {
    if (this.disposed) return;
    const batch = requests.filter((request): request is MeshRequest => (
      request.type !== 'cancel_jobs' && request.type !== 'parse_and_classify'
    ));
    if (!batch.length) return;
    const objectId = batch[0].objectId;
    for (const request of this.pending.get(objectId) ?? []) this.discard(request);
    this.pending.set(objectId, batch);
    this.pump();
  }

  terminate(): void {
    this.disposed = true;
    this.worker.terminate();
    this.active = null;
    this.pending.clear();
    this.transfers.clear();
  }

  private connect(): MeshWorkerTransport {
    const worker = this.createWorker();
    worker.onmessage = ({ data }) => {
      if (this.disposed || worker !== this.worker || data.jobId !== this.active?.jobId) return;
      this.onMessage(data);
      if (data.type === 'mesh_preview' || data.type === 'mesh_final' || data.type === 'job_error') {
        this.active = null;
        this.pump();
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.fail(worker, 'The mesh worker stopped unexpectedly. Try adjusting the equation or its sampling.');
    };
    worker.onmessageerror = () => this.fail(worker, 'The mesh result could not be read. Try rebuilding the plot.');
    return worker;
  }

  private fail(worker: MeshWorkerTransport, message: string): void {
    if (this.disposed || worker !== this.worker) return;
    const request = this.active;
    worker.terminate();
    this.active = null;
    this.worker = this.connect();
    if (request) {
      this.onMessage({ type: 'job_error', jobId: request.jobId, objectId: request.objectId, message, recoverable: true });
    }
    this.pump();
  }

  private cancel(objectId: string): void {
    if (this.disposed) return;
    for (const request of this.pending.get(objectId) ?? []) this.discard(request);
    this.pending.delete(objectId);
    if (this.active?.objectId === objectId) {
      this.discard(this.active);
      this.worker.terminate();
      this.active = null;
      this.worker = this.connect();
    }
    this.pump();
  }

  private pump(): void {
    if (this.disposed || this.active) return;
    const next = this.pending.entries().next().value;
    if (!next) return;
    const [objectId, batch] = next;
    const request = batch.shift()!;
    this.pending.delete(objectId);
    // Rotate objects between requests so one dense plot cannot monopolize the queue.
    if (batch.length) this.pending.set(objectId, batch);
    this.active = request;
    this.onStart(request);
    try {
      const transfer = this.transfers.get(request.jobId);
      this.transfers.delete(request.jobId);
      this.worker.postMessage(request, transfer);
    } catch {
      this.fail(this.worker, 'The plot could not be sent to the mesh worker. Reduce its sampling and try again.');
    }
  }

  private discard(request: MeshRequest): void {
    this.transfers.delete(request.jobId);
    this.onDiscard(request);
  }
}
