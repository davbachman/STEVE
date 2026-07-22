import { describe, expect, it, vi } from 'vitest';
import { SceneController } from '../SceneController';

describe('GIF viewport sizing', () => {
  it('keeps the GIF backing-store dimensions when a layout resize arrives during recording', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 300;
    Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 720 });
    Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 450 });

    const viewport = vi.fn();
    const controller = new SceneController(canvas);
    const internals = controller as unknown as {
      gl: WebGL2RenderingContext;
      recordingGif: boolean;
    };
    internals.gl = { viewport } as unknown as WebGL2RenderingContext;
    internals.recordingGif = true;

    controller.resizeViewport();

    expect(canvas.width).toBe(480);
    expect(canvas.height).toBe(300);
    expect(viewport).not.toHaveBeenCalled();
  });
});
