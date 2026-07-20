import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectionalLightObject, PlotObject } from '../../types/contracts';
import { useAppStore } from '../store';

describe('store object row actions', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    useAppStore.getState().newProject();
    // Exercise row actions with each object kind present.
    useAppStore.getState().addDirectionalLight();
    useAppStore.getState().addPlot('surface');
    useAppStore.getState().addPointLight();
  });

  it('duplicates an object right after the original and selects the copy', () => {
    const original = useAppStore.getState().objects[0];
    useAppStore.getState().duplicateObject(original.id);

    const state = useAppStore.getState();
    const copy = state.objects[1];
    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe(`${original.name} Copy`);
    expect(copy.type).toBe(original.type);
    expect(state.selectedId).toBe(copy.id);

    useAppStore.getState().undo();
    expect(useAppStore.getState().objects.some((obj) => obj.id === copy.id)).toBe(false);
  });

  it('deletes an object by id and clears the selection when it was selected', () => {
    const target = useAppStore.getState().objects[0];
    useAppStore.getState().selectObject(target.id);
    const countBefore = useAppStore.getState().objects.length;

    useAppStore.getState().deleteObject(target.id);
    const state = useAppStore.getState();
    expect(state.objects).toHaveLength(countBefore - 1);
    expect(state.objects.some((obj) => obj.id === target.id)).toBe(false);
    expect(state.selectedId).toBeNull();

    useAppStore.getState().undo();
    expect(useAppStore.getState().objects.some((obj) => obj.id === target.id)).toBe(true);
  });

  it('keeps an unrelated selection when deleting another object', () => {
    const [first, second] = useAppStore.getState().objects;
    useAppStore.getState().selectObject(second.id);
    useAppStore.getState().deleteObject(first.id);
    expect(useAppStore.getState().selectedId).toBe(second.id);
  });

  it('aims a moved directional light from its handle toward world origin', () => {
    const light = useAppStore.getState().objects.find(
      (object): object is DirectionalLightObject => object.type === 'directional_light',
    );
    if (!light) throw new Error('Expected directional light');

    useAppStore.getState().setObjectPosition(light.id, { x: 4, y: 0, z: 3 });
    let moved = useAppStore.getState().objects.find(
      (object): object is DirectionalLightObject => object.id === light.id && object.type === 'directional_light',
    );
    expect(moved?.direction).toEqual({ x: -0.8, y: -0, z: -0.6 });

    useAppStore.getState().updateDirectionalLight(light.id, { direction: { x: 1, y: 0, z: 0 } });
    moved = useAppStore.getState().objects.find(
      (object): object is DirectionalLightObject => object.id === light.id && object.type === 'directional_light',
    );
    expect(moved?.direction).toEqual({ x: -0.8, y: -0, z: -0.6 });
  });

  it('re-aims a duplicated directional light after applying its position offset', () => {
    const original = useAppStore.getState().objects.find(
      (object): object is DirectionalLightObject => object.type === 'directional_light',
    );
    if (!original) throw new Error('Expected directional light');

    useAppStore.getState().duplicateObject(original.id);
    const duplicate = useAppStore.getState().objects.find(
      (object): object is DirectionalLightObject => (
        object.type === 'directional_light' && object.id !== original.id
      ),
    );
    if (!duplicate) throw new Error('Expected duplicated directional light');
    const length = Math.hypot(duplicate.position.x, duplicate.position.y, duplicate.position.z);
    expect(duplicate.direction.x).toBeCloseTo(-duplicate.position.x / length);
    expect(duplicate.direction.y).toBeCloseTo(-duplicate.position.y / length);
    expect(duplicate.direction.z).toBeCloseTo(-duplicate.position.z / length);
  });

  it('copy-pastes every plot property through the plain-text clipboard fallback', async () => {
    let clipboardText = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(async (text: string) => {
          clipboardText = text;
        }),
        readText: vi.fn(async () => clipboardText),
      },
    });

    const plot = useAppStore.getState().objects.find((object): object is PlotObject => object.type === 'plot');
    if (!plot) throw new Error('Expected plot');
    useAppStore.getState().updatePlotEquationText(plot.id, '(u, v, a*u)');
    useAppStore.getState().updatePlotSpec(plot.id, (spec) => {
      if (spec.kind !== 'parametric_surface') return spec;
      return {
        ...spec,
        domain: { ...spec.domain, uMin: -7, uMax: 9, vMin: -3, vMax: 5, uSamples: 47, vSamples: 53 },
        parameters: spec.parameters.map((parameter) => parameter.name === 'a' ? {
          ...parameter,
          value: 2.75,
          min: -8,
          max: 12,
          step: 0.25,
          animationSpeed: 1.75,
        } : parameter),
      };
    });
    useAppStore.getState().updatePlotMaterial(plot.id, {
      baseColor: '#c026d3',
      opacity: 0.63,
      roughness: 0.17,
      reflectiveness: 0.82,
      wireframeVisible: true,
      wireframeCellSize: 7,
      wireframeColor: '#22d3ee',
    });
    useAppStore.getState().setObjectVisibility(plot.id, false);
    useAppStore.getState().setObjectPosition(plot.id, { x: 3, y: -2, z: 1.5 });
    useAppStore.getState().selectObject(plot.id);

    const original = structuredClone(
      useAppStore.getState().objects.find((object) => object.id === plot.id),
    ) as PlotObject;
    await useAppStore.getState().copySelectedToClipboard();
    expect(clipboardText).toBe('(u, v, a*u)');
    await useAppStore.getState().pasteClipboard();

    const copy = useAppStore.getState().objects.at(-1) as PlotObject;
    expect(copy.id).not.toBe(original.id);
    expect(copy).toEqual({
      ...original,
      id: copy.id,
      name: `${original.name} Copy`,
    });
    expect(useAppStore.getState().selectedId).toBe(copy.id);
  });
});
