import { useRef } from 'react';
import { downloadProjectFile, readProjectFile } from '../../persistence/projectFile';
import { useAppStore } from '../../state/store';
import type { ViewportApi } from '../../renderer/SceneController';

interface TopBarProps {
  viewportApi: ViewportApi | null;
  leftSidebarVisible: boolean;
  rightSidebarVisible: boolean;
  onToggleLeftSidebar: () => void;
  onToggleRightSidebar: () => void;
}

export function TopBar({
  viewportApi,
  leftSidebarVisible,
  rightSidebarVisible,
  onToggleLeftSidebar,
  onToggleRightSidebar,
}: TopBarProps) {
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
          Interactive Quality
          <select
            value={render.interactiveQuality}
            onChange={(e) => updateRender({ interactiveQuality: e.target.value as typeof render.interactiveQuality })}
          >
            <option value="performance">Performance</option>
            <option value="balanced">Balanced</option>
            <option value="quality">Quality</option>
          </select>
        </label>
      </div>

      <div className="top-bar__group top-bar__group--right">
        <button
          className={leftSidebarVisible ? 'top-bar__toggle top-bar__toggle--icon is-active' : 'top-bar__toggle top-bar__toggle--icon'}
          onClick={onToggleLeftSidebar}
          title={leftSidebarVisible ? 'Hide left panel' : 'Show left panel'}
          aria-label={leftSidebarVisible ? 'Hide left panel' : 'Show left panel'}
          aria-pressed={leftSidebarVisible}
        >
          <PanelToggleIcon side="left" />
        </button>
        <button
          className={rightSidebarVisible ? 'top-bar__toggle top-bar__toggle--icon is-active' : 'top-bar__toggle top-bar__toggle--icon'}
          onClick={onToggleRightSidebar}
          title={rightSidebarVisible ? 'Hide right panel' : 'Show right panel'}
          aria-label={rightSidebarVisible ? 'Hide right panel' : 'Show right panel'}
          aria-pressed={rightSidebarVisible}
        >
          <PanelToggleIcon side="right" />
        </button>
        {status ? <span className="top-bar__status" title={status}>{status}</span> : null}
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

function PanelToggleIcon({ side }: { side: 'left' | 'right' }) {
  const panelX = side === 'left' ? 2 : 13.5;
  return (
    <svg viewBox="0 0 20 14" width="16" height="14" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="18" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x={panelX} y="2" width="4.5" height="10" rx="1" fill="currentColor" opacity="0.5" />
    </svg>
  );
}
