import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../state/store';
import { createProjectRecovery, projectFingerprint, RECOVERY_DELAY_MS, RECOVERY_STORAGE_KEY } from '../projectRecovery';

describe('local project recovery', () => {
  let stop: (() => void) | undefined;
  let data: Map<string, string>;
  const storage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    data = new Map();
    storage.getItem.mockClear();
    storage.setItem.mockClear();
    useAppStore.getState().newProject();
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
  });

  it('debounces edits, ignores renderer and parsing updates, and excludes runtime state', () => {
    const recovery = createProjectRecovery({ storage: () => storage });
    stop = recovery.start();
    useAppStore.getState().addPlot('graph');
    const plot = useAppStore.getState().objects.find((obj) => obj.type === 'plot');
    if (plot?.type !== 'plot') throw new Error('Expected plot');
    useAppStore.getState().setObjectName(plot.id, 'Recovered graph');
    expect(recovery.getSnapshot().dirty).toBe(true);
    expect(storage.setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RECOVERY_DELAY_MS);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    const json = data.get(RECOVERY_STORAGE_KEY) ?? '';
    expect(json).toContain('Recovered graph');
    expect(json).not.toMatch(/plotJobs|parseErrors|formattedLatex|renderDiagnostics|historyPast/);
    recovery.markClean();
    storage.setItem.mockClear();
    useAppStore.getState().setRenderDiagnostics({ frameTimeMs: 12 });
    useAppStore.getState().applyAsyncPlotSource(plot.id, plot.equation.source.rawText, {
      ...plot.equation.source, formattedLatex: 'worker result',
    });
    vi.advanceTimersByTime(1000);
    expect(recovery.getSnapshot().dirty).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('restores the latest draft and its camera as unsaved work', () => {
    const recovery = createProjectRecovery({ storage: () => storage });
    stop = recovery.start();
    useAppStore.getState().addPlot('graph');
    const camera = { alpha: 2, beta: 0.8, radius: 12, target: { x: 0, y: 1, z: 2 }, upVector: { x: 0, y: 0, z: 1 } };
    useAppStore.getState().setCameraState(camera);
    recovery.flush();
    stop();
    const expectedObjects = useAppStore.getState().objects.map((object) => object.id);
    useAppStore.getState().newProject();
    const restarted = createProjectRecovery({ storage: () => storage });
    stop = restarted.start();
    expect(useAppStore.getState().objects.map((object) => object.id)).toEqual(expectedObjects);
    expect(useAppStore.getState().scene.camera).toEqual(camera);
    expect(restarted.getSnapshot()).toMatchObject({ dirty: true, recoveryAvailable: true });
    expect(restarted.getSnapshot().notice?.message).toContain('Restored');
  });

  it('keeps newer edits dirty when an earlier snapshot finishes saving', () => {
    const recovery = createProjectRecovery({ storage: () => storage });
    stop = recovery.start();
    useAppStore.getState().addPlot('graph');
    const saved = useAppStore.getState().exportProjectFile();
    useAppStore.getState().addPlot('curve');
    recovery.markSaved(saved);
    expect(recovery.getSnapshot().dirty).toBe(true);
    useAppStore.getState().undo();
    expect(projectFingerprint(useAppStore.getState())).toBe(projectFingerprint(saved));
    expect(recovery.getSnapshot().dirty).toBe(false);
  });

  it('periodically saves continuous changes and flushes the latest change on cleanup', () => {
    const recovery = createProjectRecovery({ storage: () => storage });
    stop = recovery.start();
    for (let i = 0; i < 60; i++) {
      useAppStore.getState().updateRender({ exposure: 1 + i / 100 });
      vi.advanceTimersByTime(100);
    }
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    stop();
    stop = undefined;
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(JSON.parse(data.get(RECOVERY_STORAGE_KEY) ?? '{}').project.render.exposure).toBeCloseTo(1.59);
  });

  it('keeps the current project intact if recovery is corrupt', () => {
    data.set(RECOVERY_STORAGE_KEY, JSON.stringify({ version: 1, project: {} }));
    const before = useAppStore.getState();
    const recovery = createProjectRecovery({ storage: () => storage });
    stop = recovery.start();
    expect(useAppStore.getState()).toBe(before);
    expect(recovery.getSnapshot().notice?.kind).toBe('error');
  });

  it('reports unavailable browser storage without losing editable state', () => {
    const recovery = createProjectRecovery({ storage: () => { throw new Error('Storage blocked'); } });
    stop = recovery.start();
    useAppStore.getState().addPlot('graph');
    recovery.flush();
    expect(recovery.getSnapshot()).toMatchObject({ dirty: true, recoveryAvailable: false });
    expect(recovery.getSnapshot().notice?.message).toContain('Use File → Save');
    expect(useAppStore.getState().objects.some((obj) => obj.type === 'plot')).toBe(true);
  });
});
