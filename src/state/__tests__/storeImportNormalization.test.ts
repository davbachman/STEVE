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
            ior: 1.6,
            legacyShaderModel: 'phong',
            reflectiveness: 0.35,
            roughness: 0.4,
            wireframeColor: '#123',
            xContoursVisible: true,
            xContourSpacing: 8,
            xContourColor: '#abcdef',
            yContoursVisible: true,
            yContourSpacing: -3,
            yContourColor: 'not-a-color',
            zContoursVisible: true,
            zContourSpacing: 0.75,
            zContourColor: '#456789',
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
    expect(state.objects[0].material.ior).toBe(1.6);
    expect(state.objects[0].material.refractionEnabled).toBe(false);
    expect('legacyShaderModel' in state.objects[0].material).toBe(false);
    expect(state.objects[0].material.wireframeColor).toBe('#112233');
    expect(state.objects[0].material.xContoursVisible).toBe(true);
    expect(state.objects[0].material.xContourSpacing).toBe(5);
    expect(state.objects[0].material.xContourColor).toBe('#abcdef');
    expect(state.objects[0].material.yContoursVisible).toBe(true);
    expect(state.objects[0].material.yContourSpacing).toBe(1);
    expect(state.objects[0].material.yContourColor).toBe('#000000');
    expect(state.objects[0].material.zContoursVisible).toBe(true);
    expect(state.objects[0].material.zContourSpacing).toBe(0.75);
    expect(state.objects[0].material.zContourColor).toBe('#456789');
    expect(state.selectedId).toBeNull();
  });

  it('infers missing schema version as v1', () => {
    const project = {
      appVersion: 'legacy-test',
      scene: {},
      render: {},
      objects: [],
    };

    useAppStore.getState().replaceProject(project as never);
    expect(useAppStore.getState().exportProjectFile().schemaVersion).toBe(1);
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
      {
        name: 'a',
        value: 3,
        min: -6,
        max: 6,
        step: 0.25,
        samplingMode: 'continuous',
        discreteMin: -10,
        discreteMax: 10,
        discreteCount: 5,
      },
    ]);
  });

  it('imports parameter animation settings and camera projection', () => {
    const project = baseProject({
      scene: { cameraProjection: 'orthographic' },
      objects: [
        {
          ...createBlankPlot('Animated Plot'),
          equation: {
            kind: 'explicit_surface',
            source: { rawText: 'z = a*sin(x)' },
            parameters: [
              { name: 'a', value: 2, min: -6, max: 6, step: 0.25, animating: true, animationSpeed: 99 },
            ],
          },
        },
      ],
    });

    useAppStore.getState().replaceProject(project as never);
    const state = useAppStore.getState();
    expect(state.scene.cameraProjection).toBe('orthographic');
    const plot = state.objects[0];
    if (plot?.type !== 'plot') {
      throw new Error('Expected imported plot');
    }
    expect(plot.equation.parameters[0]).toMatchObject({
      name: 'a',
      value: 2,
      animating: true,
      animationSpeed: 2,
    });
  });

  it('defaults camera projection to perspective for legacy projects', () => {
    useAppStore.getState().replaceProject(baseProject() as never);
    expect(useAppStore.getState().scene.cameraProjection).toBe('perspective');
  });

  it('imports ambient and directional enabled flags', () => {
    const project = baseProject({
      scene: {
        ambient: {
          enabled: false,
          color: '#123456',
          intensity: 0.4,
        },
        directional: {
          enabled: false,
          color: '#abcdef',
          intensity: 1.8,
          direction: { x: 0.5, y: -0.2, z: -1 },
          castShadows: true,
        },
      },
    });

    useAppStore.getState().replaceProject(project as never);
    const state = useAppStore.getState();

    expect(state.scene.ambient.enabled).toBe(false);
    expect(state.scene.ambient.color).toBe('#123456');
    expect(state.scene.ambient.intensity).toBe(0.4);
    expect(state.scene.directional.enabled).toBe(false);
    expect(state.scene.directional.color).toBe('#abcdef');
    expect(state.scene.directional.intensity).toBe(1.8);
    expect(state.scene.directional.direction).toEqual({ x: 0.5, y: -0.2, z: -1 });
    expect(state.scene.directional.castShadows).toBe(true);
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
