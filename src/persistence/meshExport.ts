import type { RenderableObject, SceneObject } from '../types/contracts';
import { saveBlobFileWithDialog } from './projectFile';
export { serializePlotGeometryAsAsciiStl } from './stlSerialization';

export async function exportPlotAsStl(plot: RenderableObject, objects: SceneObject[] = [plot]): Promise<void> {
  // Snapshot before the save dialog; animation and subsequent edits must not
  // change the meaning of an export already requested by the user.
  const snapshot = structuredClone({ plot, objects });
  await saveBlobFileWithDialog(
    `${sanitizeFileStem(plot.name)}.stl`,
    () => createStlBlob(snapshot),
  );
}

function createStlBlob(snapshot: { plot: RenderableObject; objects: SceneObject[] }): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/stlExportWorker.ts', import.meta.url), { type: 'module' });
    const finish = (error?: string, blob?: Blob) => {
      clearTimeout(timeout);
      worker.terminate();
      if (error || !blob) reject(new Error(error ?? 'The STL export did not produce a file.'));
      else resolve(blob);
    };
    const timeout = setTimeout(() => finish('STL export took too long. Reduce the sampling or number of copies and try again.'), 120_000);
    worker.onmessage = (event: MessageEvent<{ blob?: Blob; error?: string }>) => finish(event.data.error, event.data.blob);
    worker.onerror = (event) => {
      event.preventDefault();
      finish('The STL export worker stopped. Reduce the sampling and try again.');
    };
    worker.onmessageerror = () => finish('The STL export could not be read.');
    try {
      worker.postMessage(snapshot);
    } catch (error) {
      finish(error instanceof Error ? error.message : 'Unable to start STL export.');
    }
  });
}

function sanitizeFileStem(name: string): string {
  const sanitized = name.replace(/[<>:"/\\|?*]+/g, '-').trim().replace(/[. ]+$/g, '');
  return sanitized || 'plot';
}
