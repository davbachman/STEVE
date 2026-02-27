import { beforeEach, describe, expect, it } from 'vitest';
import { createBlankPlot } from '../defaults';
import { useAppStore } from '../store';

function baseProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    appVersion: 'test',
    scene: {},
    render: {},
    objects: [],
    ...overrides,
  };
}

describe('project import normalization', () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
  });

  it('skips invalid objects and loads valid ones', () => {
    const validPlot = createBlankPlot('Imported Plot');
    const project = baseProject({
      objects: [
        {
          ...validPlot,
          equation: {
            kind: 'explicit_surface',
            source: { rawText: 'z = cos(x) * sin(y)' },
          },
          material: {
            baseColor: '#ff5533',
            opacity: 0.9,
            transmission: 0.1,
            ior: 1.45,
            reflectiveness: 0.35,
            roughness: 0.4,
          },
        },
        { id: 'broken-1', type: 'unknown' },
        42,
      ],
    });

    useAppStore.getState().replaceProject(project as never);
    const state = useAppStore.getState();

    expect(state.objects).toHaveLength(1);
    expect(state.objects[0]?.type).toBe('plot');
    if (state.objects[0]?.type !== 'plot') {
      throw new Error('Expected imported plot');
    }
    expect(state.objects[0].equation.source.rawText).toBe('z = cos(x) * sin(y)');
    expect(state.ui.statusMessage).toContain('skipped 2 invalid objects');
  });

  it('infers missing schema version as v1', () => {
    const project = {
      appVersion: 'legacy-test',
      scene: {},
      render: {},
      objects: [],
    };

    useAppStore.getState().replaceProject(project as never);
    expect(useAppStore.getState().ui.statusMessage).toContain('schema version inferred as 1');
  });
});
