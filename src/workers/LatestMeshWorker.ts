import type { WorkerRequest, WorkerResponse } from '../types/contracts';

type MeshRequest = Exclude<WorkerRequest, { type: 'cancel_jobs' | 'parse_and_classify' }>;

const IDLE_WORKER_TIMEOUT_MS = 30_000;

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
  private worker: MeshWorkerTransport | null = null;
  private active: MeshRequest | null = null;
  private activeRetries = 0;
  private activeTransferred = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, MeshRequest[]>();
  private transfers = new Map<string, Transferable[]>();
  private disposed = false;

  constructor(
    private createWorker: () => MeshWorkerTransport,
    private onMessage: (message: WorkerResponse) => void,
    private onStart: (request: MeshRequest) => void,
    private onDiscard: (request: MeshRequest) => void,
  ) {}

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
    this.releaseWorker();
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
      this.fail(worker, workerFailureMessage(event.message));
    };
    worker.onmessageerror = () => this.fail(worker, 'The mesh result could not be read. Try rebuilding the plot.');
    return worker;
  }

  private fail(worker: MeshWorkerTransport | null, message: string): void {
    if (this.disposed || worker !== this.worker) return;
    const request = this.active;
    this.releaseWorker();
    // A browser may evict a worker under memory pressure or fail to load it.
    // Equation requests are replayable, but transferred mesh buffers have been
    // detached and must never be posted again. Bound retries even if startup fails.
    if (request && !this.activeTransferred && this.activeRetries === 0) {
      this.activeRetries += 1;
      this.onMessage({
        type: 'mesh_progress', jobId: request.jobId, objectId: request.objectId,
        phase: 'restarting_worker', progress: 0,
      });
      this.dispatch();
      return;
    }
    this.active = null;
    if (request) {
      // Worker construction can fail before dispatch consumes this transfer list.
      this.transfers.delete(request.jobId);
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
      this.releaseWorker();
      this.active = null;
    }
    this.pump();
  }

  private pump(): void {
    if (this.disposed || this.active) return;
    const next = this.pending.entries().next().value;
    if (!next) {
      // Terminating an idle worker releases its JS heap, including the high-water
      // allocation from a dense implicit mesh. The next edit starts one on demand.
      if (this.worker && this.idleTimer === null) {
        this.idleTimer = setTimeout(() => this.releaseWorker(), IDLE_WORKER_TIMEOUT_MS);
      }
      return;
    }
    this.clearIdleTimer();
    const [objectId, batch] = next;
    const request = batch.shift()!;
    this.pending.delete(objectId);
    // Rotate objects between requests so one dense plot cannot monopolize the queue.
    if (batch.length) this.pending.set(objectId, batch);
    this.active = request;
    this.activeRetries = 0;
    this.activeTransferred = false;
    this.dispatch();
  }

  private dispatch(): void {
    const request = this.active;
    if (!request || this.disposed) return;
    this.onStart(request);
    try {
      this.worker ??= this.connect();
      const transfer = this.transfers.get(request.jobId);
      this.transfers.delete(request.jobId);
      this.activeTransferred = Boolean(transfer?.length);
      this.worker.postMessage(request, transfer);
    } catch (error) {
      this.fail(this.worker, workerFailureMessage(error instanceof Error ? error.message : undefined));
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private releaseWorker(): void {
    this.clearIdleTimer();
    if (!this.worker) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
    this.worker = null;
  }

  private discard(request: MeshRequest): void {
    this.transfers.delete(request.jobId);
    this.onDiscard(request);
  }
}

function workerFailureMessage(detail?: string): string {
  const message = 'The mesh worker could not finish this plot. Reload the app to try again.';
  return detail?.trim() ? `${message} Details: ${detail.trim()}` : message;
}
