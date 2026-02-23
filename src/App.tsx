import { useEffect, useState } from 'react';
import './index.css';
import { Viewport3D } from './renderer/Viewport3D';
import type { ViewportApi } from './renderer/SceneController';
import { useAutosave } from './hooks/useAutosave';
import { useAppStore } from './state/store';
import { createBuiltInTestScene } from './testing/testScenes';
import { ObjectListPanel } from './ui/components/ObjectListPanel';
import { InspectorPanel } from './ui/components/InspectorPanel';
import { TopBar } from './ui/components/TopBar';

export default function App() {
  const [viewportApi, setViewportApi] = useState<ViewportApi | null>(null);
  const deleteSelected = useAppStore((s) => s.deleteSelected);
  const copySelected = useAppStore((s) => s.copySelectedToClipboard);
  const pasteClipboard = useAppStore((s) => s.pasteClipboard);
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);
  const selectObject = useAppStore((s) => s.selectObject);
  const replaceProject = useAppStore((s) => s.replaceProject);
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);

  useAutosave();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const testScene = params.get('testScene');
    if (testScene === 'shadow-regression' || testScene === 'point-shadow-regression') {
      replaceProject(createBuiltInTestScene(testScene));
      setStatusMessage(`Loaded test scene: ${testScene}`);
    }
  }, [replaceProject, setStatusMessage]);

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

  return (
    <div className="app-shell">
      <TopBar viewportApi={viewportApi} />
      <div className="app-body">
        <ObjectListPanel />
        <main className="viewport-panel">
          <Viewport3D onApiReady={setViewportApi} />
        </main>
        <InspectorPanel />
      </div>
    </div>
  );
}
