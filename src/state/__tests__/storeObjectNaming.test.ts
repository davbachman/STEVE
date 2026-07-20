import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store';
import type { DirectionalLightObject, PlotObject, PointLightObject } from '../../types/contracts';

function plotsByName() {
  return useAppStore.getState().objects.filter((obj): obj is PlotObject => obj.type === 'plot').map((plot) => plot.name);
}

function lightsByName() {
  return useAppStore.getState().objects.filter((obj): obj is PointLightObject => obj.type === 'point_light').map((light) => light.name);
}

function directionalLightsByName() {
  return useAppStore.getState().objects
    .filter((obj): obj is DirectionalLightObject => obj.type === 'directional_light')
    .map((light) => light.name);
}

describe('store object naming', () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
  });

  it('starts a new project with ambient light and an unchecked directional light', () => {
    expect(plotsByName()).toEqual([]);
    expect(lightsByName()).toEqual([]);
    expect(directionalLightsByName()).toEqual(['Directional Light 1']);
    const directional = useAppStore.getState().objects.find((object) => object.type === 'directional_light');
    expect(directional?.visible).toBe(false);
    expect(useAppStore.getState().scene.ambient.enabled).toBe(true);
  });

  it('increments names by object kind instead of by total object count', () => {
    const store = useAppStore.getState();

    store.addPlot('curve');
    store.addPlot('graph');
    store.addPlot('surface');
    store.addPointLight();
    store.addDirectionalLight();
    store.addPlot('curve');
    store.addPlot('graph');
    store.addPlot('surface');
    store.addPointLight();
    store.addDirectionalLight();

    expect(plotsByName()).toEqual([
      'Curve 1',
      'Graph 1',
      'Parametric 1',
      'Curve 2',
      'Graph 2',
      'Parametric 2',
    ]);
    expect(lightsByName()).toEqual(['Point Light 1', 'Point Light 2']);
    expect(directionalLightsByName()).toEqual([
      'Directional Light 1',
      'Directional Light 2',
      'Directional Light 3',
    ]);
  });
});
