import { useEffect, useRef } from 'react';
import { saveAutosave } from '../persistence/db';
import { useAppStore } from '../state/store';

export function useAutosave(): void {
  const exportProjectFile = useAppStore((s) => s.exportProjectFile);
  const objects = useAppStore((s) => s.objects);
  const scene = useAppStore((s) => s.scene);
  const render = useAppStore((s) => s.render);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
    }
    timer.current = window.setTimeout(() => {
      void saveAutosave(exportProjectFile());
    }, 600);
    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    };
  }, [objects, scene, render, exportProjectFile]);
}
