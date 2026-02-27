import type { ProjectFileV1 } from '../types/contracts';

export function downloadProjectFile(project: ProjectFileV1, filename = 'scene.3dplot.json'): void {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
