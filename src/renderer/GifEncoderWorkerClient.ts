type GifWorkerRequest =
  | { type: 'start'; width: number; height: number; delayMs: number }
  | { type: 'frame'; pixels: ArrayBuffer }
  | { type: 'finish' };

type GifWorkerResponse =
  | { type: 'ready' }
  | { type: 'frame-complete' }
  | { type: 'finished'; bytes: ArrayBuffer }
  | { type: 'error'; message: string };

export class GifEncoderWorkerClient {
  private readonly worker = new Worker(new URL('../workers/gifEncoderWorker.ts', import.meta.url), { type: 'module' });
  private pending: {
    resolve: (message: GifWorkerResponse) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor() {
    this.worker.addEventListener('message', (event: MessageEvent<GifWorkerResponse>) => {
      const pending = this.pending;
      if (!pending) return;
      this.pending = null;
      if (event.data.type === 'error') {
        pending.reject(new Error(event.data.message));
      } else {
        pending.resolve(event.data);
      }
    });
    this.worker.addEventListener('error', (event) => {
      const pending = this.pending;
      if (!pending) return;
      this.pending = null;
      pending.reject(new Error(event.message || 'GIF encoding worker failed'));
    });
  }

  async start(width: number, height: number, delayMs: number): Promise<void> {
    const response = await this.request({ type: 'start', width, height, delayMs });
    if (response.type !== 'ready') throw new Error('GIF encoder failed to start');
  }

  async addFrame(pixels: Uint8ClampedArray): Promise<void> {
    const buffer = pixels.buffer as ArrayBuffer;
    const response = await this.request({ type: 'frame', pixels: buffer }, [buffer]);
    if (response.type !== 'frame-complete') throw new Error('GIF frame encoding failed');
  }

  async finish(): Promise<Uint8Array<ArrayBuffer>> {
    const response = await this.request({ type: 'finish' });
    if (response.type !== 'finished') throw new Error('GIF encoder did not return an output file');
    return new Uint8Array(response.bytes);
  }

  terminate(): void {
    this.worker.terminate();
    if (this.pending) {
      this.pending.reject(new Error('GIF encoding was interrupted'));
      this.pending = null;
    }
  }

  private request(message: GifWorkerRequest, transfer: Transferable[] = []): Promise<GifWorkerResponse> {
    if (this.pending) {
      return Promise.reject(new Error('GIF encoder is already processing a request'));
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.postMessage(message, transfer);
    });
  }
}
