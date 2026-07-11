import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store';
import type { PlotObject, PointLightObject } from '../../types/contracts';

function plotsByName() {
  return useAppStore.getState().objects.filter((obj): obj is PlotObject => obj.type === 'plot').map((plot) => plot.name);
}

function lightsByName() {
  return useAppStore.getState().objects.filter((obj): obj is PointLightObject => obj.type === 'point_light').map((light) => light.name);
}

describe('store object naming', () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
  });

  it('starts a new project with no objects', () => {
    expect(plotsByName()).toEqual([]);
    expect(lightsByName()).toEqual([]);
  });

  it('increments names by object kind instead of by total object count', () => {
    const store = useAppStore.getState();

    store.addPlot('curve');
    store.addPlot('surface');
    store.addPointLight();
    store.addPlot('curve');
    store.addPlot('surface');
    store.addPointLight();

    expect(plotsByName()).toEqual(['Curve 1', 'Surface 1', 'Curve 2', 'Surface 2']);
    expect(lightsByName()).toEqual(['Point Light 1', 'Point Light 2']);
  });
});
