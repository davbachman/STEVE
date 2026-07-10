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

  it('toggles parameter animation and applies tick values without touching undo history', () => {
    const store = useAppStore.getState();
    const plot = selectedPlot();
    store.updatePlotEquationText(plot.id, 'z = a*sin(x)');
    const historyDepth = useAppStore.getState().historyPast.length;

    useAppStore.getState().setParameterAnimation(plot.id, 'a', { animating: true, animationSpeed: 0.5 });
    let next = selectedPlot();
    expect(next.equation.parameters[0]).toMatchObject({ name: 'a', animating: true, animationSpeed: 0.5 });
    expect(useAppStore.getState().historyPast).toHaveLength(historyDepth);

    useAppStore.getState().applyParameterAnimationValues([
      { plotId: plot.id, parameterName: 'a', value: 4.2 },
    ]);
    next = selectedPlot();
    expect(next.equation.parameters[0]?.value).toBe(4.2);
    expect(useAppStore.getState().historyPast).toHaveLength(historyDepth);

    useAppStore.getState().setParameterAnimation(plot.id, 'a', { animating: false });
    next = selectedPlot();
    expect(next.equation.parameters[0]?.animating).toBe(false);
    expect(useAppStore.getState().historyPast).toHaveLength(historyDepth);
  });

  it('preserves animation settings across equation edits', () => {
    const store = useAppStore.getState();
    const plot = selectedPlot();
    store.updatePlotEquationText(plot.id, 'z = a*sin(x)');
    useAppStore.getState().setParameterAnimation(plot.id, 'a', { animating: true, animationSpeed: 0.7 });

    useAppStore.getState().updatePlotEquationText(plot.id, 'z = a*sin(x) + b');
    const next = selectedPlot();
    expect(next.equation.parameters[0]).toMatchObject({ name: 'a', animating: true, animationSpeed: 0.7 });
    expect(next.equation.parameters[1]?.animating).toBeUndefined();
  });
});
