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
    expect('ior' in state.objects[0].material).toBe(false);
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

  it('preserves imported parameter values for detected constants', () => {
    const project = baseProject({
      objects: [
        {
          ...createBlankPlot('Parameterized Plot'),
          equation: {
            kind: 'explicit_surface',
            source: { rawText: 'z = a*sin(x)' },
            parameters: [
              { name: 'a', value: 3, min: -6, max: 6, step: 0.25 },
              { name: 'unused', value: 9, min: 0, max: 10, step: 1 },
            ],
          },
        },
      ],
    });

    useAppStore.getState().replaceProject(project as never);
    const state = useAppStore.getState();
    const plot = state.objects[0];
    expect(plot?.type).toBe('plot');
    if (plot?.type !== 'plot') {
      throw new Error('Expected imported plot');
    }
    expect(plot.equation.parameters).toEqual([
      { name: 'a', value: 3, min: -6, max: 6, step: 0.25 },
    ]);
  });

  it('drops legacy implicit iso values during import', () => {
    const project = baseProject({
      objects: [
        {
          ...createBlankPlot('Imported Implicit'),
          equation: {
            kind: 'implicit_surface',
            source: { rawText: 'x^2 + y^2 + z^2 = 4' },
            isoValue: 2,
            quality: 'medium',
          },
        },
      ],
    });

    useAppStore.getState().replaceProject(project as never);
    const state = useAppStore.getState();
    const plot = state.objects[0];
    expect(plot?.type).toBe('plot');
    if (plot?.type !== 'plot' || plot.equation.kind !== 'implicit_surface') {
      throw new Error('Expected imported implicit plot');
    }
    expect('isoValue' in plot.equation).toBe(false);
    expect(plot.equation.quality).toBe('medium');
  });
});
