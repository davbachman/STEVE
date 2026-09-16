import { useAppStore, type AppState } from '../state/store';
import type { ProjectFileV1 } from '../types/contracts';
import { validateProjectFile } from './projectFile';

export const RECOVERY_STORAGE_KEY = 'steve.project-recovery.v1';
export const RECOVERY_DELAY_MS = 700;
const RECOVERY_MAX_DELAY_MS = 5000;
const STORAGE_ERROR = 'Local recovery could not be saved. Use File → Save to keep your work.';

export interface ProjectNotice {
  message: string;
  kind: 'info' | 'error';
}

interface RecoveryStatus {
  dirty: boolean;
  recoveryAvailable: boolean;
  notice: ProjectNotice | null;
}

type ProjectState = Pick<AppState, 'objects' | 'scene' | 'render'>;

/** Parse results and job/renderer data are reproducible, and are not document edits. */
export function projectFingerprint(project: ProjectState): string {
  return JSON.stringify({
    scene: project.scene,
    render: project.render,
    objects: project.objects,
  }, (key, value: unknown) => {
    if (key === 'source' && value && typeof value === 'object' && 'rawText' in value) {
      return { rawText: value.rawText };
    }
    return value;
  });
}

export function createProjectRecovery(options: {
  storage?: () => Pick<Storage, 'getItem' | 'setItem'>;
  disabled?: boolean;
} = {}) {
  const storage = options.storage ?? (() => window.localStorage);
  const listeners = new Set<() => void>();
  let status: RecoveryStatus = { dirty: false, recoveryAvailable: false, notice: null };
  let initialized = false;
  let savedFingerprint: string | null = null;
  let currentFingerprint = '';
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let maximumTimer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;

  const publish = (patch: Partial<RecoveryStatus>) => {
    status = { ...status, ...patch };
    listeners.forEach((listener) => listener());
  };
  const clearTimers = () => {
    clearTimeout(debounceTimer);
    clearTimeout(maximumTimer);
    debounceTimer = undefined;
    maximumTimer = undefined;
  };
  const flush = () => {
    clearTimers();
    if (!pending || options.disabled) return;
    pending = false;
    try {
      // Capture only scene settings and objects. Runtime meshes, selection, undo,
      // diagnostics, and compiled equations never enter browser storage.
      const project = JSON.parse(currentFingerprint) as ProjectState;
      storage().setItem(RECOVERY_STORAGE_KEY, JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        dirty: status.dirty,
        project: { schemaVersion: 1, appVersion: 'recovery', ...project },
      }));
      if (!status.recoveryAvailable) publish({
        recoveryAvailable: true,
        notice: status.notice?.message === STORAGE_ERROR ? null : status.notice,
      });
    } catch {
      publish({
        recoveryAvailable: false,
        notice: { kind: 'error', message: STORAGE_ERROR },
      });
    }
  };
  const schedule = () => {
    pending = true;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, RECOVERY_DELAY_MS);
    // Continuous animation should still leave a recent recovery snapshot.
    maximumTimer ??= setTimeout(flush, RECOVERY_MAX_DELAY_MS);
  };
  const updateDirty = () => {
    const dirty = currentFingerprint !== savedFingerprint;
    if (dirty !== status.dirty) publish({ dirty });
  };

  return {
    getSnapshot: () => status,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start: () => {
      if (!initialized) {
        initialized = true;
        currentFingerprint = projectFingerprint(useAppStore.getState());
        savedFingerprint = currentFingerprint;
        if (!options.disabled) {
          try {
            const raw = storage().getItem(RECOVERY_STORAGE_KEY);
            if (raw) {
              const recovery = JSON.parse(raw) as { version?: unknown; dirty?: unknown; project?: unknown };
              if (recovery.version !== 1) throw new Error('Unsupported recovery version');
              validateProjectFile(recovery.project);
              useAppStore.getState().replaceProject(recovery.project);
              currentFingerprint = projectFingerprint(useAppStore.getState());
              savedFingerprint = recovery.dirty === false ? currentFingerprint : null;
              publish({
                dirty: currentFingerprint !== savedFingerprint,
                recoveryAvailable: true,
                notice: { kind: 'info', message: 'Restored your last local session. Use File → Save to keep a project file.' },
              });
            }
          } catch {
            publish({ notice: { kind: 'error', message: 'Local recovery could not be restored. You can still open a saved project file.' } });
          }
        }
      }
      const unsubscribe = useAppStore.subscribe((state, previous) => {
        if (state.objects === previous.objects && state.scene === previous.scene && state.render === previous.render) return;
        const fingerprint = projectFingerprint(state);
        if (fingerprint === currentFingerprint) return;
        currentFingerprint = fingerprint;
        updateDirty();
        if (!options.disabled) schedule();
      });
      return () => {
        unsubscribe();
        flush();
      };
    },
    markSaved: (savedProject: ProjectFileV1) => {
      savedFingerprint = projectFingerprint(savedProject);
      currentFingerprint = projectFingerprint(useAppStore.getState());
      updateDirty();
      pending = true;
      flush();
    },
    markClean: () => {
      currentFingerprint = projectFingerprint(useAppStore.getState());
      savedFingerprint = currentFingerprint;
      updateDirty();
      pending = true;
      flush();
    },
    dismissNotice: () => publish({ notice: null }),
    flush,
  };
}
