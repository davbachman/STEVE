import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../state/store';
import { useAppStore } from '../state/store';
import { SceneController, type ViewPreset, type ViewportApi } from './SceneController';

interface Viewport3DProps {
  onApiReady?: (api: ViewportApi | null) => void;
}

const CONTROLS_HINT_DISMISSED_KEY = 'steve:viewportHintDismissed';

function readHintDismissed(): boolean {
  try {
    return window.localStorage.getItem(CONTROLS_HINT_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function Viewport3D({ onApiReady }: Viewport3DProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controllerRef = useRef<SceneController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [controllerReady, setControllerReady] = useState(false);
  const [hintVisible, setHintVisible] = useState(() => !readHintDismissed());
  const [objectDragging, setObjectDragging] = useState(false);

  const scene = useAppStore((s) => s.scene);
  const render = useAppStore((s) => s.render);
  const objects = useAppStore((s) => s.objects);
  const selectedId = useAppStore((s) => s.selectedId);
  const plotJobs = useAppStore((s) => s.plotJobs);
  const intersectionSourcePick = useAppStore((s) => s.ui.intersectionSourcePick);
  const cancelIntersectionSourcePick = useAppStore((s) => s.cancelIntersectionSourcePick);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let controller: SceneController;
    try {
      controller = new SceneController(canvas, setObjectDragging);
    } catch (err) {
      // The controller is created only after the canvas mounts, so initialization failures surface here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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

  useEffect(() => {
    if (!intersectionSourcePick) return;
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelIntersectionSourcePick();
    };
    window.addEventListener('keydown', cancelOnEscape);
    return () => window.removeEventListener('keydown', cancelOnEscape);
  }, [cancelIntersectionSourcePick, intersectionSourcePick]);

  const applyViewPreset = (preset: ViewPreset) => {
    controllerRef.current?.setViewPreset(preset);
  };

  const dismissHint = () => {
    setHintVisible(false);
    try {
      window.localStorage.setItem(CONTROLS_HINT_DISMISSED_KEY, '1');
    } catch {
      // localStorage may be unavailable; the hint just reappears next session.
    }
  };

  return (
    <div
      ref={shellRef}
      className={`viewport-shell${intersectionSourcePick ? ' viewport-shell--surface-pick' : ''}`}
    >
      <canvas ref={canvasRef} className="viewport-canvas" />
      {!error && controllerReady && intersectionSourcePick ? (
        <div className="viewport-pick-prompt" role="status" aria-live="polite">
          Click a surface for Surface {intersectionSourcePick.slot + 1} · Esc to cancel
        </div>
      ) : null}
      {!error && controllerReady && objectDragging ? (
        <div className="viewport-drag-prompt" role="status" aria-live="polite">
          Hold Shift while dragging to change elevation
        </div>
      ) : null}
      {!error && controllerReady ? (
        <div className="viewport-toolbar" role="toolbar" aria-label="View controls">
          <button onClick={() => applyViewPreset('top')} title="Top view (looking down the z axis)">Top</button>
          <button onClick={() => applyViewPreset('front')} title="Front view (looking along the y axis)">Front</button>
          <button onClick={() => applyViewPreset('side')} title="Side view (looking along the x axis)">Side</button>
          <button
            onClick={() => controllerRef.current?.frameObject(null)}
            title="Frame the selected object, or everything (also: double-click the viewport)"
            aria-label="Frame selection"
          >
            ⛶
          </button>
          <button onClick={() => applyViewPreset('default')} title="Reset camera to the default view" aria-label="Reset view">
            ⌂
          </button>
          <button
            onClick={() => setHintVisible((visible) => !visible)}
            title="Viewport controls"
            aria-label="Toggle viewport controls hint"
            aria-pressed={hintVisible}
          >
            ?
          </button>
        </div>
      ) : null}
      {!error && controllerReady && hintVisible ? (
        <div className="viewport-hint" role="note">
          <span>
            Right-drag orbit · Shift + right-drag pan · Scroll zoom · Left-drag move object · Shift + left-drag change elevation · Double-click frame
          </span>
          <button onClick={dismissHint} title="Dismiss" aria-label="Dismiss controls hint">×</button>
        </div>
      ) : null}
      {error ? (
        <div className="viewport-overlay viewport-overlay--error">
          <h3>WebGL2 Required</h3>
          <p>{error}</p>
          <p>Use a desktop browser with WebGL2 and floating color buffer support enabled.</p>
        </div>
      ) : null}
    </div>
  );
}
