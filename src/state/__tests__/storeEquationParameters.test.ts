import { beforeEach, describe, expect, it } from 'vitest';
import type { PlotObject } from '../../types/contracts';
import { useAppStore } from '../store';
import { compileEquationSpec, expandEquationSpecVariants } from '../../math/compile';

function selectedPlot(): PlotObject {
  const plot = useAppStore.getState().objects.find((obj): obj is PlotObject => obj.type === 'plot');
  if (!plot) {
    throw new Error('Expected a plot');
  }
  return plot;
}

function addSurfacePlot(): PlotObject {
  const store = useAppStore.getState();
  store.addPlot('surface');
  return selectedPlot();
}

describe('store equation parameters', () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
  });

  it('detects constants and preserves existing values across equation edits', () => {
    const store = useAppStore.getState();
    const plot = addSurfacePlot();

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
    const plot = addSurfacePlot();
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
    const plot = addSurfacePlot();
    store.updatePlotEquationText(plot.id, 'z = a*sin(x)');
    useAppStore.getState().setParameterAnimation(plot.id, 'a', { animating: true, animationSpeed: 0.7 });

    useAppStore.getState().updatePlotEquationText(plot.id, 'z = a*sin(x) + b');
    const next = selectedPlot();
    expect(next.equation.parameters[0]).toMatchObject({ name: 'a', animating: true, animationSpeed: 0.7 });
    expect(next.equation.parameters[1]?.animating).toBeUndefined();
  });

  it.each([
    ['curve', 'A = 3*t + t^t\n(A, A*t, t)', 'curve', [2], [10, 20, 2]],
    ['surface', 'R = 2 + v\n(R*u, R, v)', 'surface', [3, 1], [9, 3, 1]],
    ['surface', 'A = x^2 + y^2\nz = A', 'surface', [3, 4], [3, 4, 25]],
    ['surface', 'A = y^2 + z^2\nx = A', 'surface', [3, 4], [25, 3, 4]],
    ['surface', 'A = x^2 + z^2\ny = A', 'surface', [3, 4], [3, 25, 4]],
    ['implicit', 'A = x^2 + y^2 + z^2\nA = 9', 'implicit', [1, 2, 2], 0],
    ['graph', 'A = x^2 + y^2\nA', 'surface', [3, 4], [3, 4, 25]],
  ] as const)('compiles and round-trips %s definitions: %s', (type, text, kind, args, expected) => {
    const store = useAppStore.getState();
    store.addPlot(type);
    const plot = selectedPlot();
    store.updatePlotEquationText(plot.id, text);
    const project = JSON.parse(JSON.stringify(useAppStore.getState().exportProjectFile()));
    store.newProject();
    store.replaceProject(project);
    const restored = selectedPlot();
    expect(restored.equation.source.rawText).toBe(text);
    expect(restored.equation.source.parseStatus).toBe('ok');
    expect(restored.equation.parameters).toEqual([]);
    const compiled = compileEquationSpec(restored.equation);
    expect(compiled.kind).toBe(kind);
    const value = compiled.kind === 'curve' ? compiled.fn(args[0])
      : compiled.kind === 'surface' ? compiled.fn(args[0], args[1]!)
        : compiled.fn(args[0], args[1]!, args[2]!);
    expect(value).toEqual(expected);
  });

  it('preserves free sliders through definitions, animation, and incomplete edits', () => {
    const plot = addSurfacePlot();
    const store = useAppStore.getState();
    store.updatePlotEquationText(plot.id, 'z = a*x');
    store.setParameterAnimation(plot.id, 'a', { animating: true, animationSpeed: 0.7 });
    store.updatePlotEquationText(plot.id, 'A = a*x\nz = A^2');
    store.applyParameterAnimationValues([{ plotId: plot.id, parameterName: 'a', value: 3 }]);
    expect(selectedPlot().equation.parameters).toHaveLength(1);
    expect(selectedPlot().equation.parameters[0]).toMatchObject({ name: 'a', value: 3, animating: true, animationSpeed: 0.7 });
    const compiled = compileEquationSpec(selectedPlot().equation);
    expect(compiled.kind === 'surface' && compiled.fn(2, 0)).toEqual([2, 0, 36]);
    for (const text of ['A = a*x\nz =', 'A = a*x\nB = A^2', 'A = B\nB = A\nz = A']) {
      store.updatePlotEquationText(plot.id, text);
      expect(selectedPlot().equation.parameters[0]).toMatchObject({ name: 'a', value: 3, animating: true });
    }
    store.updatePlotEquationText(plot.id, 'a = 2\nA = a*x\nz = A^2');
    expect(selectedPlot().equation.parameters).toEqual([]);
  });

  it('evaluates definitions independently for discrete parameter copies', () => {
    const plot = addSurfacePlot();
    const store = useAppStore.getState();
    store.updatePlotEquationText(plot.id, 'A = a*x\nz = A');
    store.updatePlotSpec(plot.id, (spec) => ({
      ...spec, parameters: spec.parameters.map((parameter) => ({
        ...parameter, min: 1, max: 3, discreteCount: 3, samplingMode: 'discrete', animating: true,
      })),
    }));
    const heights = expandEquationSpecVariants(selectedPlot().equation).map((spec) => {
      const compiled = compileEquationSpec(spec);
      return compiled.kind === 'surface' && compiled.fn(2, 0)[2];
    });
    expect(heights).toEqual([2, 4, 6]);
  });
});
