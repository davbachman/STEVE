import { beforeEach, describe, expect, it } from 'vitest';
import {
  createBlankPlot,
  createDefaultCurve,
  createDefaultGraph,
  createDirectionalLight,
  createPointLight,
} from '../defaults';
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
            emissionColor: '#fedcba',
            emissionStrength: 14,
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
    expect(state.objects[0].material.emissionEnabled).toBe(true);
    expect(state.objects[0].material.emissionColor).toBe('#fedcba');
    expect(state.objects[0].material.emissionStrength).toBe(10);
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

  it('normalizes imported bloom settings', () => {
    useAppStore.getState().replaceProject(baseProject({
      render: {
        bloomEnabled: false,
        bloomStrength: 12,
        bloomRadius: 0,
        bloomThreshold: -4,
        showDiagnostics: true,
      },
    }) as never);

    expect(useAppStore.getState().render).toMatchObject({
      bloomEnabled: false,
      bloomStrength: 2,
      bloomRadius: 0.25,
      bloomThreshold: 0,
    });
    expect(useAppStore.getState().render).not.toHaveProperty('showDiagnostics');
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
        discreteCount: 5,
      },
    ]);
  });

  it('imports parameter animation and turntable camera settings', () => {
    const project = baseProject({
      scene: { cameraProjection: 'orthographic', turntableEnabled: true, turntableSpeed: 200 },
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
    expect(state.scene.turntableEnabled).toBe(true);
    expect(state.scene.turntableSpeed).toBe(90);
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

  it('imports ambient settings and migrates the legacy directional source to an object', () => {
    const project = baseProject({
      scene: {
        ambient: {
          enabled: false,
          color: '#123456',
          intensity: 0.4,
        },
        directional: {
          enabled: true,
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
    const directional = state.objects.find((object) => object.type === 'directional_light');
    expect(directional).toMatchObject({
      color: '#abcdef',
      intensity: 1.8,
      castShadows: true,
    });
    expect(directional?.direction.x).toBeCloseTo(-3 / Math.sqrt(43));
    expect(directional?.direction.y).toBeCloseTo(3 / Math.sqrt(43));
    expect(directional?.direction.z).toBeCloseTo(-5 / Math.sqrt(43));
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

  it('preserves expression-only Graph objects during import', () => {
    const project = baseProject({ objects: [createDefaultGraph('Imported Graph')] });
    useAppStore.getState().replaceProject(project as never);

    const graph = useAppStore.getState().objects[0];
    expect(graph?.type).toBe('plot');
    if (graph?.type !== 'plot' || graph.equation.kind !== 'explicit_surface') {
      throw new Error('Expected imported graph');
    }
    expect(graph.equation.graphExpression).toBe(true);
    expect(graph.equation.source.rawText).toBe('x^2 - y^2');
    expect(graph.equation.source.classification?.label).toBe('Graph');
  });

  it('adds unpinned curve settings to legacy imported lights', () => {
    const legacyLight = createPointLight('Legacy Light') as unknown as Record<string, unknown>;
    delete legacyLight.curvePin;

    useAppStore.getState().replaceProject(baseProject({ objects: [legacyLight] }) as never);
    const light = useAppStore.getState().objects[0];
    if (light?.type !== 'point_light') throw new Error('Expected imported point light');
    expect(light.curvePin).toEqual({
      enabled: false,
      curveId: null,
      parameterValue: 0,
      animating: false,
      animationSpeed: 0.25,
    });
  });

  it('normalizes curve pin values and clears unusable imported animation states', () => {
    const curve = createDefaultCurve('Imported Curve');
    if (curve.equation.kind !== 'parametric_curve') throw new Error('Expected parametric curve');
    curve.equation.tDomain = { min: -2, max: 3, samples: 40 };

    const valid = createPointLight('Valid Pin');
    valid.curvePin = {
      enabled: true,
      curveId: curve.id,
      parameterValue: 99,
      animating: true,
      animationSpeed: 99,
    };
    const disabled = createDirectionalLight('Disabled Pin');
    disabled.curvePin = {
      enabled: false,
      curveId: curve.id,
      parameterValue: -99,
      animating: true,
      animationSpeed: -99,
    };
    const missing = createPointLight('Missing Pin');
    missing.curvePin = {
      enabled: true,
      curveId: 'missing-curve',
      parameterValue: 1,
      animating: true,
      animationSpeed: 0.5,
    };

    useAppStore.getState().replaceProject(baseProject({
      objects: [curve, valid, disabled, missing],
    }) as never);
    const importedLights = useAppStore.getState().objects.filter(
      (object) => object.type === 'point_light' || object.type === 'directional_light',
    );
    const validPin = importedLights.find((light) => light.name === 'Valid Pin')?.curvePin;
    const disabledPin = importedLights.find((light) => light.name === 'Disabled Pin')?.curvePin;
    const missingPin = importedLights.find((light) => light.name === 'Missing Pin')?.curvePin;

    expect(validPin).toMatchObject({
      enabled: true,
      curveId: curve.id,
      parameterValue: 3,
      animating: true,
      animationSpeed: 2,
    });
    expect(disabledPin).toMatchObject({
      enabled: false,
      curveId: curve.id,
      parameterValue: -2,
      animating: false,
      animationSpeed: 0.02,
    });
    expect(missingPin).toMatchObject({
      enabled: true,
      curveId: null,
      animating: false,
    });
  });
});
