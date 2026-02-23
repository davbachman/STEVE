import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../state/store';
import { useAppStore } from '../state/store';
import { SceneController, type ViewportApi } from './SceneController';

interface Viewport3DProps {
  onApiReady?: (api: ViewportApi | null) => void;
}

export function Viewport3D({ onApiReady }: Viewport3DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controllerRef = useRef<SceneController | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sceneState = useAppStore((s) => ({
    scene: s.scene,
    render: s.render,
    objects: s.objects,
    selectedId: s.selectedId,
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    const controller = new SceneController(canvas);
    controllerRef.current = controller;

    void controller
      .init()
      .then(() => {
        if (disposed) return;
        controller.sync(sceneState as Pick<AppState, 'scene' | 'render' | 'objects' | 'selectedId'>);
        onApiReady?.(controller.getApi());
      })
      .catch((err) => {
        if (disposed) return;
        setError(err instanceof Error ? err.message : 'Failed to initialize WebGPU');
        onApiReady?.(null);
      });

    return () => {
      disposed = true;
      onApiReady?.(null);
      controller.dispose();
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    controllerRef.current?.sync(sceneState as Pick<AppState, 'scene' | 'render' | 'objects' | 'selectedId'>);
  }, [sceneState]);

  return (
    <div className="viewport-shell">
      <canvas ref={canvasRef} className="viewport-canvas" />
      {error ? (
        <div className="viewport-overlay viewport-overlay--error">
          <h3>WebGPU Required</h3>
          <p>{error}</p>
          <p>Use a desktop browser with WebGPU enabled (Chrome/Edge/Safari Technology Preview).</p>
        </div>
      ) : null}
      {sceneState.render.mode === 'quality' ? (
        <div className="viewport-overlay viewport-overlay--quality">
          <div>Quality Render Mode (progressive prototype)</div>
          <div>
            Samples: {sceneState.render.qualityCurrentSamples} / {sceneState.render.qualitySamplesTarget}
            {sceneState.render.qualityRunning ? ' (running)' : ' (idle)'}
          </div>
          <div>Path-traced quality mode is scaffolded; current build uses a progressive placeholder counter.</div>
        </div>
      ) : null}
    </div>
  );
}
