import { useRef } from 'react';
import { loadAutosave } from '../../persistence/db';
import { downloadProjectFile, readProjectFile } from '../../persistence/projectFile';
import { useAppStore } from '../../state/store';
import type { ViewportApi } from '../../renderer/SceneController';

interface TopBarProps {
  viewportApi: ViewportApi | null;
}

export function TopBar({ viewportApi }: TopBarProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const exportProjectFile = useAppStore((s) => s.exportProjectFile);
  const replaceProject = useAppStore((s) => s.replaceProject);
  const newProject = useAppStore((s) => s.newProject);
  const render = useAppStore((s) => s.render);
  const updateRender = useAppStore((s) => s.updateRender);
  const status = useAppStore((s) => s.ui.statusMessage);
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);

  return (
    <header className="top-bar">
      <div className="top-bar__group">
        <button onClick={() => newProject()}>New</button>
        <button onClick={() => downloadProjectFile(exportProjectFile())}>Save</button>
        <button onClick={() => fileInputRef.current?.click()}>Open</button>
        <button
          onClick={() => {
            void (async () => {
              const autosave = await loadAutosave();
              if (!autosave) {
                setStatusMessage('No autosave found');
                return;
              }
              replaceProject(autosave);
            })();
          }}
        >
          Load Autosave
        </button>
        <button
          onClick={() => {
            if (!viewportApi) {
              setStatusMessage('Viewport not ready');
              return;
            }
            void viewportApi.exportPng();
          }}
        >
          Export PNG
        </button>
      </div>

      <div className="top-bar__group top-bar__group--center">
        <label>
          Render Mode
          <select value={render.mode} onChange={(e) => updateRender({ mode: e.target.value as 'interactive' | 'quality' })}>
            <option value="interactive">Interactive</option>
            <option value="quality">Quality (prototype)</option>
          </select>
        </label>
        {render.mode === 'quality' ? (
          <>
            <label>
              Samples
              <input
                type="number"
                min={16}
                max={4096}
                step={1}
                value={render.qualitySamplesTarget}
                onChange={(e) => updateRender({ qualitySamplesTarget: Number(e.target.value) })}
              />
            </label>
            <span className="top-bar__quality-status">
              {render.qualityCurrentSamples}/{render.qualitySamplesTarget} {render.qualityRunning ? 'running' : 'idle'}
            </span>
          </>
        ) : null}
      </div>

      <div className="top-bar__group top-bar__group--right">
        <span className="top-bar__hint">RMB orbit | Shift+RMB pan | LMB drag move | Shift+LMB drag Z</span>
        {status ? <span className="top-bar__status">{status}</span> : null}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.3dplot.json,application/json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          void (async () => {
            try {
              const project = await readProjectFile(file);
              replaceProject(project);
            } catch (err) {
              setStatusMessage(err instanceof Error ? err.message : 'Failed to open project');
            } finally {
              e.target.value = '';
            }
          })();
        }}
      />
    </header>
  );
}
