import type { ProjectFileV1 } from '../types/contracts';

/** Accept schema-v1 and recognizable legacy projects before any scene is replaced. */
export function validateProjectFile(value: unknown): asserts value is ProjectFileV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Project file must contain a JSON object');
  }
  const project = value as Record<string, unknown>;
  if (project.schemaVersion != null && project.schemaVersion !== 1) {
    throw new Error(`Unsupported schema version ${String(project.schemaVersion)}`);
  }
  const isRecord = (entry: unknown) => !!entry && typeof entry === 'object' && !Array.isArray(entry);
  const hasRecognizableObjects = Array.isArray(project.objects) && project.objects.some((entry: unknown) => (
    isRecord(entry) && ['plot', 'intersection', 'point_light', 'directional_light'].includes(String((entry as Record<string, unknown>).type))
  ));
  if (!Array.isArray(project.objects)
    || (project.schemaVersion == null && !hasRecognizableObjects && (!isRecord(project.scene) || !isRecord(project.render)))) {
    throw new Error('This is not a STEVE project. Choose a saved .3dplot.json file.');
  }
  if ((project.scene != null && !isRecord(project.scene))
    || (project.render != null && !isRecord(project.render))) {
    throw new Error('Invalid project settings. Your current scene has not been changed.');
  }
}

export interface SaveFilePickerType {
  description?: string;
  accept: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: SaveFilePickerType[];
}

interface FileSystemWritableFileStreamLike {
  write(data: Blob | BufferSource | string): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemFileHandleLike {
  createWritable(): Promise<FileSystemWritableFileStreamLike>;
}

type ShowSaveFilePickerLike = (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandleLike>;

export function downloadBlobFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function saveBlobFile(blob: Blob, filename: string, fileType?: SaveFilePickerType): Promise<void> {
  const picker = (window as Window & { showSaveFilePicker?: ShowSaveFilePickerLike }).showSaveFilePicker;
  if (!picker) {
    downloadBlobFile(blob, filename);
    return;
  }
  const handle = await picker({
    suggestedName: filename,
    types: fileType ? [fileType] : undefined,
  });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

export async function saveBlobFileWithDialog(
  filename: string,
  createBlob: () => Blob | Promise<Blob>,
  fileType?: SaveFilePickerType,
): Promise<void> {
  const picker = (window as Window & { showSaveFilePicker?: ShowSaveFilePickerLike }).showSaveFilePicker;
  if (!picker) {
    const blob = await createBlob();
    downloadBlobFile(blob, filename);
    return;
  }
  const handle = await picker({
    suggestedName: filename,
    types: fileType ? [fileType] : undefined,
  });
  const blob = await createBlob();
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

export function downloadProjectFile(project: ProjectFileV1, filename = 'scene.3dplot.json'): void {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  downloadBlobFile(blob, filename);
}

export async function saveProjectFile(project: ProjectFileV1, filename = 'scene.3dplot.json'): Promise<void> {
  const json = JSON.stringify(project, null, 2);
  await saveBlobFile(
    new Blob([json], { type: 'application/json' }),
    filename,
    {
      description: '3D Plot project',
      accept: {
        'application/json': ['.json'],
      },
    },
  );
}

export async function readProjectFile(file: File): Promise<ProjectFileV1> {
  const text = await file.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    validateProjectFile(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Invalid project JSON');
    }
    throw error instanceof Error ? error : new Error('Failed to parse project file');
  }
}
