import Dexie, { type Table } from 'dexie';
import type { ProjectFileV1 } from '../types/contracts';

interface StoredProject {
  id: string;
  updatedAt: number;
  project: ProjectFileV1;
}

class ProjectDatabase extends Dexie {
  projects!: Table<StoredProject, string>;

  constructor() {
    super('3dplotrender');
    this.version(1).stores({
      projects: 'id,updatedAt',
    });
  }
}

export const projectDb = new ProjectDatabase();

export async function saveAutosave(project: ProjectFileV1): Promise<void> {
  await projectDb.projects.put({ id: 'autosave', updatedAt: Date.now(), project });
}

export async function loadAutosave(): Promise<ProjectFileV1 | null> {
  const record = await projectDb.projects.get('autosave');
  return record?.project ?? null;
}
