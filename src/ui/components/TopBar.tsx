import { useEffect, useRef, useState } from 'react';
import { clearAutosave, getAutosaveMetadata, loadAutosave, type AutosaveMetadata } from '../../persistence/db';
import { downloadProjectFile, readProjectFile } from '../../persistence/projectFile';
import { useAppStore } from '../../state/store';
import { LEGACY_QUALITY_MODE_PARKED_MESSAGE } from '../../state/renderCompat';
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
  const [autosaveMeta, setAutosaveMeta] = useState<AutosaveMetadata | null>(null);
  const exportProjectFile = useAppStore((s) => s.exportProjectFile);
  const replaceProject = useAppStore((s) => s.replaceProject);
  const newProject = useAppStore((s) => s.newProject);
  const render = useAppStore((s) => s.render);
  const updateRender = useAppStore((s) => s.updateRender);
  const qualityModeImplemented = useAppStore((s) => s.ui.qualityModeImplemented);
  const status = useAppStore((s) => s.ui.statusMessage);
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);

  const refreshAutosaveMeta = async () => {
    try {
      setAutosaveMeta(await getAutosaveMetadata());
    } catch {
      setAutosaveMeta(null);
    }
  };

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await getAutosaveMetadata();
        if (!disposed) {
          setAutosaveMeta(next);
        }
      } catch {
        if (!disposed) {
          setAutosaveMeta(null);
        }
      }
    };
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  const autosaveSummary = autosaveMeta ? formatAutosaveSummary(autosaveMeta) : 'No autosave';
  const autosaveTitle = autosaveMeta ? formatAutosaveTitle(autosaveMeta) : 'No autosave saved yet';

  return (
    <header className="top-bar">
      <div className="top-bar__group">
        <button onClick={() => newProject()}>New</button>
        <button onClick={() => downloadProjectFile(exportProjectFile())}>Save</button>
        <button onClick={() => fileInputRef.current?.click()}>Open</button>
        <button
          className={leftSidebarVisible ? 'top-bar__toggle is-active' : 'top-bar__toggle'}
          onClick={onToggleLeftSidebar}
          title={leftSidebarVisible ? 'Hide left sidebar' : 'Show left sidebar'}
          aria-pressed={leftSidebarVisible}
        >
          Left Panel
        </button>
        <button
          className={rightSidebarVisible ? 'top-bar__toggle is-active' : 'top-bar__toggle'}
          onClick={onToggleRightSidebar}
          title={rightSidebarVisible ? 'Hide right sidebar' : 'Show right sidebar'}
          aria-pressed={rightSidebarVisible}
        >
          Right Panel
        </button>
        <button
          title={autosaveTitle}
          onClick={() => {
            void (async () => {
              const autosave = await loadAutosave();
              if (!autosave) {
                setStatusMessage('No autosave found');
                await refreshAutosaveMeta();
                return;
              }
              replaceProject(autosave);
              await refreshAutosaveMeta();
            })();
          }}
        >
          Load Autosave
        </button>
        <button
          title={autosaveTitle}
          onClick={() => {
            void (async () => {
              const meta = await getAutosaveMetadata();
              if (!meta) {
                setStatusMessage('No autosave to clear');
                setAutosaveMeta(null);
                return;
              }
              await clearAutosave();
              setStatusMessage('Autosave cleared');
              setAutosaveMeta(null);
            })();
          }}
        >
          Clear Autosave
        </button>
        <span className="top-bar__autosave-meta" title={autosaveTitle}>{autosaveSummary}</span>
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
        {!qualityModeImplemented ? (
          <span className="top-bar__quality-status" title={LEGACY_QUALITY_MODE_PARKED_MESSAGE}>
            Legacy quality parked
          </span>
        ) : null}
      </div>

      <div className="top-bar__group top-bar__group--right">
        <span className="top-bar__hint">RMB orbit | Shift+RMB pan | LMB drag move | Shift+LMB drag Z</span>
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

function formatAutosaveSummary(meta: AutosaveMetadata): string {
  const ageMs = Math.max(0, Date.now() - meta.updatedAt);
  const seconds = Math.round(ageMs / 1000);
  let ageLabel = `${seconds}s ago`;
  if (seconds >= 60) {
    const minutes = Math.round(seconds / 60);
    ageLabel = `${minutes}m ago`;
  }
  if (seconds >= 3600) {
    const hours = Math.round(seconds / 3600);
    ageLabel = `${hours}h ago`;
  }
  if (seconds >= 86400) {
    const days = Math.round(seconds / 86400);
    ageLabel = `${days}d ago`;
  }
  return `Autosave ${ageLabel} (${meta.objectCount} obj${meta.objectCount === 1 ? '' : 's'})`;
}

function formatAutosaveTitle(meta: AutosaveMetadata): string {
  return `Autosave: ${new Date(meta.updatedAt).toLocaleString()} • ${meta.objectCount} object${
    meta.objectCount === 1 ? '' : 's'
  } • ${meta.appVersion}`;
}
