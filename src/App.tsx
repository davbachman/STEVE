import { useEffect, useState } from 'react';
import './index.css';
import { Viewport3D } from './renderer/Viewport3D';
import type { ViewportApi } from './renderer/SceneController';
import { useParameterAnimation } from './hooks/useParameterAnimation';
import { useWorkerPipeline } from './hooks/useWorkerPipeline';
import { useAppStore } from './state/store';
import { createBuiltInTestScene } from './testing/testScenes';
import { EquationEditor } from './ui/components/EquationEditor';
import { ObjectListPanel } from './ui/components/ObjectListPanel';
import { InspectorPanel } from './ui/components/InspectorPanel';
import { TopBar } from './ui/components/TopBar';

export default function App() {
  const [viewportApi, setViewportApi] = useState<ViewportApi | null>(null);
  const [leftSidebarVisible, setLeftSidebarVisible] = useState(true);
  const [rightSidebarVisible, setRightSidebarVisible] = useState(true);
  const deleteSelected = useAppStore((s) => s.deleteSelected);
  const copySelected = useAppStore((s) => s.copySelectedToClipboard);
  const pasteClipboard = useAppStore((s) => s.pasteClipboard);
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);
  const selectObject = useAppStore((s) => s.selectObject);
  const replaceProject = useAppStore((s) => s.replaceProject);
  const objects = useAppStore((s) => s.objects);
  const selectedId = useAppStore((s) => s.selectedId);
  const updatePlotEquationText = useAppStore((s) => s.updatePlotEquationText);

  useWorkerPipeline();
  useParameterAnimation();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const testScene = params.get('testScene');
    if (
      testScene === 'shadow-regression'
      || testScene === 'point-shadow-regression'
      || testScene === 'interactive-render-regression'
      || testScene === 'phase5b-path-mixed-geometry'
    ) {
      const builtIn = createBuiltInTestScene(testScene);
      replaceProject(builtIn);
    }
  }, [replaceProject]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      const metaOrCtrl = event.metaKey || event.ctrlKey;

      if (event.key === 'Escape') {
        selectObject(null);
        return;
      }

      if (isTypingTarget) {
        return;
      }

      if (!isTypingTarget && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        deleteSelected();
        return;
      }

      if (metaOrCtrl && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        void copySelected();
        return;
      }

      if (metaOrCtrl && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        void pasteClipboard();
        return;
      }

      if (metaOrCtrl && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
        return;
      }

      if (metaOrCtrl && ((event.key.toLowerCase() === 'z' && event.shiftKey) || event.key.toLowerCase() === 'y')) {
        event.preventDefault();
        redo();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [copySelected, deleteSelected, pasteClipboard, redo, selectObject, undo]);

  const selectedObject = selectedId ? objects.find((obj) => obj.id === selectedId) ?? null : null;
  const selectedEquationPlot = selectedObject?.type === 'plot' ? selectedObject : null;

  return (
    <div className="app-shell">
      <TopBar
        viewportApi={viewportApi}
        leftSidebarVisible={leftSidebarVisible}
        rightSidebarVisible={rightSidebarVisible}
        onToggleLeftSidebar={() => setLeftSidebarVisible((v) => !v)}
        onToggleRightSidebar={() => setRightSidebarVisible((v) => !v)}
      />
      <section className="equation-dock" aria-label="Selected equation editor">
        <div className="equation-dock__inner">
          {selectedEquationPlot ? (
            <EquationEditor
              equation={selectedEquationPlot.equation}
              onChange={(rawText) => updatePlotEquationText(selectedEquationPlot.id, rawText)}
            />
          ) : (
            <div className="equation-dock__blank" aria-hidden="true" />
          )}
        </div>
      </section>
      <div
        className={[
          'app-body',
          leftSidebarVisible ? '' : 'app-body--hide-left',
          rightSidebarVisible ? '' : 'app-body--hide-right',
        ].filter(Boolean).join(' ')}
      >
        {leftSidebarVisible ? <ObjectListPanel /> : null}
        <main className="viewport-panel">
          <Viewport3D onApiReady={setViewportApi} />
        </main>
        {rightSidebarVisible ? <InspectorPanel /> : null}
      </div>
    </div>
  );
}
