import { beforeEach, describe, expect, it } from 'vitest';
import { updateEquationParameterValue } from '../../math/parameters';
import type { PlotObject } from '../../types/contracts';
import { useAppStore } from '../store';

function firstPlot(): PlotObject {
  const plot = useAppStore.getState().objects.find((obj): obj is PlotObject => obj.type === 'plot');
  if (!plot) {
    throw new Error('Expected default plot in initial scene');
  }
  return plot;
}

function prepareParameterizedPlot(): PlotObject {
  const store = useAppStore.getState();
  const plot = firstPlot();
  store.updatePlotEquationText(plot.id, 'z = a*sin(x)');
  useAppStore.setState((state) => ({
    ...state,
    historyPast: [],
    historyFuture: [],
  }));
  const nextPlot = firstPlot();
  if (nextPlot.equation.parameters.length === 0) {
    throw new Error('Expected parameterized plot');
  }
  return nextPlot;
}

describe('store parameter drag history', () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
  });

  it('coalesces constant slider drags into a single undo entry', () => {
    const store = useAppStore.getState();
    const plot = prepareParameterizedPlot();

    store.beginEquationParameterDrag(plot.id, 'a');
    store.updatePlotSpec(plot.id, (spec) => ({
      ...spec,
      parameters: updateEquationParameterValue(spec.parameters, 'a', 2),
    }));
    store.updatePlotSpec(plot.id, (spec) => ({
      ...spec,
      parameters: updateEquationParameterValue(spec.parameters, 'a', 3),
    }));
    store.commitEquationParameterDrag(plot.id, 'a');

    let state = useAppStore.getState();
    let updatedPlot = firstPlot();
    expect(updatedPlot.equation.parameters[0]?.value).toBe(3);
    expect(state.historyPast).toHaveLength(1);
    expect(state.activeEquationParameterDrag).toBeNull();

    state.undo();
    state = useAppStore.getState();
    updatedPlot = firstPlot();
    expect(updatedPlot.equation.parameters[0]?.value).toBe(1);

    state.redo();
    updatedPlot = firstPlot();
    expect(updatedPlot.equation.parameters[0]?.value).toBe(3);
  });

  it('does not create a history entry when a constant drag does not change the value', () => {
    const store = useAppStore.getState();
    const plot = prepareParameterizedPlot();

    store.beginEquationParameterDrag(plot.id, 'a');
    store.commitEquationParameterDrag(plot.id, 'a');

    const state = useAppStore.getState();
    expect(state.historyPast).toHaveLength(0);
    expect(state.activeEquationParameterDrag).toBeNull();
  });
});
