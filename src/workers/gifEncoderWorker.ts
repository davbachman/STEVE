/// <reference lib="webworker" />

import { GIFEncoder, applyPalette, quantize, type GifEncoderInstance } from 'gifenc';
import { ditherRgbaInPlace } from './gifDither';

type GifWorkerRequest =
  | { type: 'start'; width: number; height: number; delayMs: number }
  | { type: 'frame'; pixels: ArrayBuffer }
  | { type: 'finish' };

type GifWorkerResponse =
  | { type: 'ready' }
  | { type: 'frame-complete' }
  | { type: 'finished'; bytes: ArrayBuffer }
  | { type: 'error'; message: string };

const workerScope = self as DedicatedWorkerGlobalScope;
let gif: GifEncoderInstance | null = null;
let width = 0;
let height = 0;
let delayMs = 0;
let frameIndex = 0;

workerScope.onmessage = (event: MessageEvent<GifWorkerRequest>) => {
  try {
    const message = event.data;
    if (message.type === 'start') {
      width = message.width;
      height = message.height;
      delayMs = message.delayMs;
      frameIndex = 0;
      gif = GIFEncoder();
      post({ type: 'ready' });
      return;
    }
    if (!gif) {
      throw new Error('GIF encoder has not been initialized');
    }
    if (message.type === 'frame') {
      const pixels = new Uint8ClampedArray(message.pixels);
      const palette = quantize(pixels, 256);
      ditherRgbaInPlace(pixels, width);
      const indexedPixels = applyPalette(pixels, palette);
      gif.writeFrame(indexedPixels, width, height, {
        palette,
        delay: delayMs,
        repeat: frameIndex === 0 ? 0 : undefined,
      });
      frameIndex += 1;
      post({ type: 'frame-complete' });
      return;
    }
    gif.finish();
    const bytes = gif.bytes();
    const buffer = bytes.buffer as ArrayBuffer;
    post({ type: 'finished', bytes: buffer }, [buffer]);
    gif = null;
  } catch (error) {
    post({
      type: 'error',
      message: error instanceof Error ? error.message : 'GIF encoding failed',
    });
  }
};

function post(message: GifWorkerResponse, transfer: Transferable[] = []): void {
  workerScope.postMessage(message, transfer);
}

export {};
