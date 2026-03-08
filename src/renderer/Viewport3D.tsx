import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../state/store';
import { useAppStore } from '../state/store';
import { SceneController, type ViewportApi } from './SceneController';

interface Viewport3DProps {
  onApiReady?: (api: ViewportApi | null) => void;
}

export function Viewport3D({ onApiReady }: Viewport3DProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controllerRef = useRef<SceneController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [controllerReady, setControllerReady] = useState(false);

  const scene = useAppStore((s) => s.scene);
  const render = useAppStore((s) => s.render);
  const objects = useAppStore((s) => s.objects);
  const selectedId = useAppStore((s) => s.selectedId);
  const plotJobs = useAppStore((s) => s.plotJobs);
  const diagnostics = useAppStore((s) => s.renderDiagnostics);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let controller: SceneController;
    try {
      controller = new SceneController(canvas);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initialize viewport');
      onApiReady?.(null);
      return;
    }
    controllerRef.current = controller;

    void controller
      .init()
      .then(() => {
        if (disposed) return;
        setControllerReady(true);
        controller.sync({ scene, render, objects, selectedId, plotJobs } as Pick<AppState, 'scene' | 'render' | 'objects' | 'selectedId' | 'plotJobs'>);
        onApiReady?.(controller.getApi());
      })
      .catch((err) => {
        if (disposed) return;
        setControllerReady(false);
        setError(err instanceof Error ? err.message : 'Failed to initialize WebGL2');
        onApiReady?.(null);
      });

    return () => {
      disposed = true;
      onApiReady?.(null);
      try {
        controller.dispose();
      } catch (err) {
        console.error('Viewport cleanup failed', err);
      }
      controllerRef.current = null;
      setControllerReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    controllerRef.current?.sync({ scene, render, objects, selectedId, plotJobs } as Pick<AppState, 'scene' | 'render' | 'objects' | 'selectedId' | 'plotJobs'>);
  }, [scene, render, objects, selectedId, plotJobs]);

  useEffect(() => {
    if (!controllerReady) return;
    const shell = shellRef.current;
    if (!shell || typeof ResizeObserver === 'undefined') return;

    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) {
        cancelAnimationFrame(frame);
      }
      frame = requestAnimationFrame(() => {
        frame = 0;
        controllerRef.current?.resizeViewport();
      });
    });
    observer.observe(shell);
    return () => {
      observer.disconnect();
      if (frame) {
        cancelAnimationFrame(frame);
      }
    };
  }, [controllerReady]);

  return (
    <div ref={shellRef} className="viewport-shell">
      <canvas ref={canvasRef} className="viewport-canvas" />
      {error ? (
        <div className="viewport-overlay viewport-overlay--error">
          <h3>WebGL2 Required</h3>
          <p>{error}</p>
          <p>Use a desktop browser with WebGL2 and floating color buffer support enabled.</p>
        </div>
      ) : null}
      {render.showDiagnostics ? (
        <div className="viewport-overlay viewport-overlay--diagnostics">
          <div><strong>Renderer Diagnostics</strong></div>
          <div>Backend: {diagnostics.backend}</div>
          <div>WebGL2: {diagnostics.webglReady ? 'ready' : 'not ready'}</div>
          <div>Plots: {diagnostics.plotCount}</div>
          <div>Point lights: {diagnostics.pointLightCount}</div>
          <div>Transparent plots: {diagnostics.transparentPlotCount}</div>
          <div>Frame: {diagnostics.frameTimeMs.toFixed(1)} ms</div>
          <div>FPS: {diagnostics.fps.toFixed(1)}</div>
          <div>Shadow map: {diagnostics.shadowMapResolution}px</div>
          <div>Shadow atlas: {(diagnostics.shadowAtlasUsage * 100).toFixed(0)}%</div>
          <div>Opaque casters: {diagnostics.opaqueShadowCasters}</div>
          <div>Transmittance casters: {diagnostics.transmittanceShadowCasters}</div>
          <div>Point shadows: {diagnostics.pointShadowCount} ({diagnostics.pointShadowMode})</div>
          <div>Reflection source: {diagnostics.reflectionSource}</div>
          <div>Reflection probes: {diagnostics.activeProbeCount}</div>
          <div>Probe refreshes: {diagnostics.reflectionProbeRefreshCount}</div>
          <div>SSR hit rate: {(diagnostics.ssrHitRate * 100).toFixed(0)}%</div>
          <div>Outline mode: {diagnostics.outlineMode}</div>
        </div>
      ) : null}
    </div>
  );
}
