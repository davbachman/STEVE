import { beforeEach, describe, expect, it } from 'vitest';
import type { PlotObject } from '../../types/contracts';
import { useAppStore } from '../store';

function selectedPlot(): PlotObject {
  const plot = useAppStore.getState().objects.find((obj): obj is PlotObject => obj.type === 'plot');
  if (!plot) {
    throw new Error('Expected a plot');
  }
  return plot;
}

describe('store equation parameters', () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
  });

  it('detects constants and preserves existing values across equation edits', () => {
    const store = useAppStore.getState();
    const plot = selectedPlot();

    store.updatePlotEquationText(plot.id, 'z = a*sin(x)');
    let next = selectedPlot();
    expect(next.equation.parameters.map((parameter) => parameter.name)).toEqual(['a']);
    expect(next.equation.parameters[0]?.value).toBe(1);

    store.updatePlotSpec(plot.id, (spec) => ({
      ...spec,
      parameters: spec.parameters.map((parameter) => (parameter.name === 'a' ? { ...parameter, value: 2.5 } : parameter)),
    }));

    store.updatePlotEquationText(plot.id, 'z = a*sin(x) + b');
    next = selectedPlot();
    expect(next.equation.parameters.map((parameter) => ({ name: parameter.name, value: parameter.value }))).toEqual([
      { name: 'a', value: 2.5 },
      { name: 'b', value: 1 },
    ]);
  });
});
