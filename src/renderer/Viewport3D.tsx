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
        controller.sync({ scene, render, objects, selectedId, plotJobs } as Pick<AppState, 'scene' | 'render' | 'objects' | 'selectedId' | 'plotJobs'>);
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
      try {
        controller.dispose();
      } catch (err) {
        console.error('Viewport cleanup failed', err);
      }
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    controllerRef.current?.sync({ scene, render, objects, selectedId, plotJobs } as Pick<AppState, 'scene' | 'render' | 'objects' | 'selectedId' | 'plotJobs'>);
  }, [scene, render, objects, selectedId, plotJobs]);

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
      {render.mode === 'quality' ? (
        <div className="viewport-overlay viewport-overlay--quality">
          <div>Quality Render Mode (progressive accumulation)</div>
          <div>
            Samples: {render.qualityCurrentSamples} / {render.qualitySamplesTarget}
            {render.qualityRunning ? ' (running)' : ' (idle)'}
          </div>
          <div>Uses temporal accumulation (TAA). Camera/scene changes restart accumulation.</div>
        </div>
      ) : null}
      {render.showDiagnostics ? (
        <div className="viewport-overlay viewport-overlay--diagnostics">
          <div><strong>Renderer Diagnostics</strong></div>
          <div>WebGPU: {diagnostics.webgpuReady ? 'ready' : 'not ready'}</div>
          <div>Plots: {diagnostics.plotCount}</div>
          <div>Point lights: {diagnostics.pointLightCount}</div>
          <div>Directional shadows: {diagnostics.directionalShadowEnabled ? 'on' : 'off'}</div>
          <div>Directional casters: {diagnostics.directionalShadowCasterCount}</div>
          <div>
            Point shadows: {diagnostics.pointShadowsEnabled}/{diagnostics.pointShadowLimit} ({diagnostics.pointShadowMode})
          </div>
          <div>
            Point casters:{' '}
            {diagnostics.pointShadowCasterCounts && Object.keys(diagnostics.pointShadowCasterCounts).length > 0
              ? Object.entries(diagnostics.pointShadowCasterCounts).map(([id, count]) => `${id.slice(0, 4)}:${count}`).join(', ')
              : 'none'}
          </div>
          <div>Receiver: {diagnostics.shadowReceiver}</div>
          <div>Transparent plots: {diagnostics.transparentPlotCount}</div>
          <div>Shadow map: {diagnostics.shadowMapResolution}px</div>
          <div>Point shadow support: {diagnostics.pointShadowCapability}</div>
        </div>
      ) : null}
    </div>
  );
}
