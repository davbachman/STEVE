import { useEffect, useRef, useState } from 'react';
import { exportPlotAsStl } from '../../persistence/meshExport';
import { readProjectFile, saveProjectFile } from '../../persistence/projectFile';
import { useAppStore } from '../../state/store';
import type { ViewportApi } from '../../renderer/SceneController';
import type { PlotObject } from '../../types/contracts';

const APP_GITHUB_URL = 'https://github.com/davbachman/STEVE';

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
  const menuBarRef = useRef<HTMLDivElement | null>(null);
  const [exportScale, setExportScale] = useState(1);
  const [activeMenu, setActiveMenu] = useState<'steve' | 'file' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const exportProjectFile = useAppStore((s) => s.exportProjectFile);
  const replaceProject = useAppStore((s) => s.replaceProject);
  const newProject = useAppStore((s) => s.newProject);
  const objects = useAppStore((s) => s.objects);
  const render = useAppStore((s) => s.render);
  const selectedId = useAppStore((s) => s.selectedId);
  const updateRender = useAppStore((s) => s.updateRender);
  const selectedPlot = selectedId
    ? objects.find((obj): obj is PlotObject => obj.id === selectedId && obj.type === 'plot') ?? null
    : null;

  useEffect(() => {
    if (!activeMenu) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!menuBarRef.current?.contains(event.target as Node)) {
        setActiveMenu(null);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [activeMenu]);

  useEffect(() => {
    if (!activeMenu && !settingsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setActiveMenu(null);
      setSettingsOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape, true);
    return () => document.removeEventListener('keydown', closeOnEscape, true);
  }, [activeMenu, settingsOpen]);

  const handleSaveProject = () => {
    void (async () => {
      try {
        await saveProjectFile(exportProjectFile());
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.error(error instanceof Error ? error.message : 'Failed to save project');
      }
    })();
  };

  const handleExportPng = () => {
    void (async () => {
      if (!viewportApi) {
        return;
      }
      try {
        await viewportApi.exportPng(undefined, exportScale);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.error(error instanceof Error ? error.message : 'Failed to export PNG');
      }
    })();
  };

  const handleExportStl = () => {
    if (!selectedPlot) {
      return;
    }
    void (async () => {
      try {
        await exportPlotAsStl(selectedPlot);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.error(error instanceof Error ? error.message : 'Failed to export STL');
      }
    })();
  };

  const openSettings = () => {
    setActiveMenu(null);
    setSettingsOpen(true);
  };

  const closeMenusThen = (action: () => void) => {
    setActiveMenu(null);
    action();
  };

  return (
    <>
      <header className="top-bar">
        <div ref={menuBarRef} className="top-bar__menu-bar" aria-label="Application menus">
          <div className="top-bar__menu">
            <button
              type="button"
              className={activeMenu === 'steve' ? 'top-bar__menu-trigger is-active' : 'top-bar__menu-trigger'}
              aria-haspopup="menu"
              aria-expanded={activeMenu === 'steve'}
              onClick={() => setActiveMenu((menu) => menu === 'steve' ? null : 'steve')}
            >
              <strong>STEVE</strong>
              <span className="top-bar__menu-caret" aria-hidden="true">▾</span>
            </button>
            {activeMenu === 'steve' ? (
              <div className="top-bar__menu-popover" role="menu" aria-label="STEVE menu">
                <a
                  role="menuitem"
                  href={APP_GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setActiveMenu(null)}
                >
                  About
                </a>
                <button type="button" role="menuitem" onClick={openSettings}>Settings</button>
              </div>
            ) : null}
          </div>

          <div className="top-bar__menu">
            <button
              type="button"
              className={activeMenu === 'file' ? 'top-bar__menu-trigger is-active' : 'top-bar__menu-trigger'}
              aria-haspopup="menu"
              aria-expanded={activeMenu === 'file'}
              onClick={() => setActiveMenu((menu) => menu === 'file' ? null : 'file')}
            >
              File
              <span className="top-bar__menu-caret" aria-hidden="true">▾</span>
            </button>
            {activeMenu === 'file' ? (
              <div className="top-bar__menu-popover" role="menu" aria-label="File menu">
                <button type="button" role="menuitem" onClick={() => closeMenusThen(newProject)}>New</button>
                <button type="button" role="menuitem" onClick={() => closeMenusThen(handleSaveProject)}>Save</button>
                <button type="button" role="menuitem" onClick={() => closeMenusThen(() => fileInputRef.current?.click())}>Open</button>
                <button type="button" role="menuitem" disabled={!viewportApi} onClick={() => closeMenusThen(handleExportPng)}>Export PNG</button>
                <button type="button" role="menuitem" disabled={!selectedPlot} onClick={() => closeMenusThen(handleExportStl)}>Export STL</button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="top-bar__group top-bar__group--right">
          <div className="top-bar__sidebar-toggles" aria-label="Sidebar visibility">
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
          </div>
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
                console.error(err instanceof Error ? err.message : 'Failed to open project');
              } finally {
                e.target.value = '';
              }
            })();
          }}
        />
      </header>

      {settingsOpen ? (
        <div
          className="settings-overlay"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
          }}
        >
          <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <header className="settings-dialog__header">
              <h2 id="settings-title">Settings</h2>
              <button
                type="button"
                className="settings-dialog__close"
                aria-label="Close settings"
                title="Close settings"
                autoFocus
                onClick={() => setSettingsOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="settings-dialog__body">
              <label>
                <span>PNG Export Quality</span>
                <select
                  value={exportScale}
                  onChange={(e) => setExportScale(Number(e.target.value))}
                  aria-label="PNG Export Quality"
                >
                  <option value={1}>Standard (1×)</option>
                  <option value={2}>High (2×)</option>
                  <option value={4}>Ultra (4×)</option>
                </select>
              </label>
              <label>
                <span>Interactive Quality</span>
                <select
                  value={render.interactiveQuality}
                  onChange={(e) => updateRender({ interactiveQuality: e.target.value as typeof render.interactiveQuality })}
                  aria-label="Interactive Quality"
                >
                  <option value="performance">Performance</option>
                  <option value="balanced">Balanced</option>
                  <option value="quality">Quality</option>
                </select>
              </label>
            </div>
          </section>
        </div>
      ) : null}
    </>
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
