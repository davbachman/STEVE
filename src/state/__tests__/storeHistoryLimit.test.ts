import { beforeEach, describe, expect, it } from 'vitest';
import { updateEquationParameterValue } from '../../math/parameters';
import type { PlotObject, PointLightObject } from '../../types/contracts';
import { useAppStore } from '../store';

function plot(id: string): PlotObject {
  const object = useAppStore.getState().objects.find((candidate) => candidate.id === id);
  if (object?.type !== 'plot') throw new Error('Expected plot');
  return object;
}

function addPlot(template: 'curve' | 'surface' = 'surface'): string {
  useAppStore.getState().addPlot(template);
  const id = useAppStore.getState().selectedId;
  if (!id) throw new Error('Expected selected plot');
  return id;
}

function fillHistory(id: string, edits = 125): void {
  for (let index = 1; index <= edits; index += 1) {
    useAppStore.getState().setObjectName(id, `Edit ${index}`);
    expect(useAppStore.getState().historyPast.length).toBeLessThanOrEqual(100);
  }
}

describe('bounded document history', () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
  });

  it('retains the latest 100 edits and replays them in order after a long session', () => {
    const id = addPlot();
    fillHistory(id);
    expect(useAppStore.getState().historyPast).toHaveLength(100);

    for (let index = 124; index >= 25; index -= 1) {
      useAppStore.getState().undo();
      expect(plot(id).name).toBe(`Edit ${index}`);
    }
    expect(useAppStore.getState().historyPast).toHaveLength(0);
    expect(useAppStore.getState().historyFuture).toHaveLength(100);
    useAppStore.getState().undo();
    expect(plot(id).name).toBe('Edit 25');

    for (let index = 26; index <= 125; index += 1) {
      useAppStore.getState().redo();
      expect(plot(id).name).toBe(`Edit ${index}`);
    }
    expect(useAppStore.getState().historyPast).toHaveLength(100);
    expect(useAppStore.getState().historyFuture).toHaveLength(0);
    useAppStore.getState().redo();
    expect(plot(id).name).toBe('Edit 125');
  });

  it('discards the redo branch when editing after undo at the limit', () => {
    const id = addPlot();
    fillHistory(id);
    useAppStore.getState().undo();
    useAppStore.getState().undo();
    useAppStore.getState().setObjectName(id, 'New branch');
    expect(useAppStore.getState().historyPast).toHaveLength(99);
    expect(useAppStore.getState().historyFuture).toHaveLength(0);
    useAppStore.getState().redo();
    expect(plot(id).name).toBe('New branch');
    useAppStore.getState().undo();
    expect(plot(id).name).toBe('Edit 123');
    useAppStore.getState().redo();
    expect(plot(id).name).toBe('New branch');
  });

  it('keeps a coalesced object drag undoable when history is full', () => {
    const id = addPlot();
    fillHistory(id);
    const start = { ...plot(id).transform.position };
    const store = useAppStore.getState();
    store.beginObjectDragHistory(id);
    store.setObjectPosition(id, { x: 1, y: 2, z: 3 });
    store.setObjectPosition(id, { x: 4, y: 5, z: 6 });
    store.commitObjectDragHistory(id);
    expect(useAppStore.getState().historyPast).toHaveLength(100);
    store.undo();
    expect(plot(id).transform.position).toEqual(start);
    expect(plot(id).name).toBe('Edit 125');
    store.redo();
    expect(plot(id).transform.position).toEqual({ x: 4, y: 5, z: 6 });
    expect(useAppStore.getState().historyPast).toHaveLength(100);
  });

  it('keeps a coalesced equation parameter drag undoable when history is full', () => {
    const id = addPlot();
    const store = useAppStore.getState();
    store.updatePlotEquationText(id, 'z = a*sin(x)');
    fillHistory(id);
    store.beginEquationParameterDrag(id, 'a');
    for (const value of [2, 3]) {
      store.updatePlotSpec(id, (spec) => ({
        ...spec,
        parameters: updateEquationParameterValue(spec.parameters, 'a', value),
      }));
    }
    store.commitEquationParameterDrag(id, 'a');
    expect(useAppStore.getState().historyPast).toHaveLength(100);
    store.undo();
    expect(plot(id).equation.parameters[0]?.value).toBe(1);
    expect(plot(id).name).toBe('Edit 125');
    store.redo();
    expect(plot(id).equation.parameters[0]?.value).toBe(3);
    expect(useAppStore.getState().historyPast).toHaveLength(100);
  });

  it('keeps a coalesced light parameter drag undoable when history is full', () => {
    const id = addPlot('curve');
    const store = useAppStore.getState();
    store.addPointLight();
    const lightId = useAppStore.getState().selectedId!;
    const light = () => useAppStore.getState().objects.find(
      (object): object is PointLightObject => object.id === lightId && object.type === 'point_light',
    )!;
    store.setLightCurvePinEnabled(lightId, true);
    store.setLightCurveSource(lightId, id);
    const start = light().curvePin.parameterValue;
    fillHistory(id);
    store.beginLightCurveParameterDrag(lightId);
    store.setLightCurveParameter(lightId, 2);
    store.setLightCurveParameter(lightId, 3);
    store.commitLightCurveParameterDrag(lightId);
    expect(useAppStore.getState().historyPast).toHaveLength(100);
    store.undo();
    expect(light().curvePin.parameterValue).toBe(start);
    expect(plot(id).name).toBe('Edit 125');
    store.redo();
    expect(light().curvePin.parameterValue).toBe(3);
    expect(useAppStore.getState().historyPast).toHaveLength(100);
  });
});
