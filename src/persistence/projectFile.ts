import type { ProjectFileV1 } from '../types/contracts';

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

export async function saveBlobFileWithDialog(blob: Blob, filename: string, fileType?: SaveFilePickerType): Promise<void> {
  const picker = (window as Window & { showSaveFilePicker?: ShowSaveFilePickerLike }).showSaveFilePicker;
  if (!picker) {
    throw new Error('This browser does not support choosing a save location for STL export');
  }
  const handle = await picker({
    suggestedName: filename,
    types: fileType ? [fileType] : undefined,
  });
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
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Project file must contain a JSON object');
    }
    return parsed as ProjectFileV1;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Invalid project JSON');
    }
    throw error instanceof Error ? error : new Error('Failed to parse project file');
  }
}
