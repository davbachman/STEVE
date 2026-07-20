import { beforeEach, describe, expect, it } from 'vitest';
import type { LightObject, PlotObject } from '../../types/contracts';
import { useAppStore } from '../store';

function curve(): PlotObject & { equation: Extract<PlotObject['equation'], { kind: 'parametric_curve' }> } {
  const result = useAppStore.getState().objects.find(
    (object): object is PlotObject & { equation: Extract<PlotObject['equation'], { kind: 'parametric_curve' }> } => (
      object.type === 'plot' && object.equation.kind === 'parametric_curve'
    ),
  );
  if (!result) throw new Error('Expected parameterized curve');
  return result;
}

function light(): LightObject {
  const result = useAppStore.getState().objects.find(
    (object): object is LightObject => object.type === 'point_light' || object.type === 'directional_light',
  );
  if (!result) throw new Error('Expected light');
  return result;
}

describe('light curve pin state', () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
  });

  it('defaults both light kinds to unpinned', () => {
    const store = useAppStore.getState();
    store.addPointLight();
    store.addDirectionalLight();
    const lights = useAppStore.getState().objects.filter(
      (object): object is LightObject => object.type === 'point_light' || object.type === 'directional_light',
    );
    for (const object of lights) {
      expect(object.curvePin).toMatchObject({
        enabled: false,
        curveId: null,
        parameterValue: 0,
        animating: false,
        animationSpeed: 0.25,
      });
    }
  });

  it('arms curve picking and accepts only a parameterized curve', () => {
    const store = useAppStore.getState();
    store.addPlot('curve');
    const path = curve();
    store.addPlot('graph');
    const graph = useAppStore.getState().objects.find(
      (object): object is PlotObject => object.type === 'plot' && object.equation.kind === 'explicit_surface',
    );
    store.addPointLight();
    const source = light();

    store.setLightCurvePinEnabled(source.id, true);
    store.beginLightCurveSourcePick(source.id);
    expect(useAppStore.getState().ui.lightCurveSourcePick).toEqual({ lightId: source.id });
    store.setLightCurveSource(source.id, graph?.id ?? 'missing');
    expect(light().curvePin.curveId).toBeNull();
    expect(useAppStore.getState().ui.lightCurveSourcePick).toEqual({ lightId: source.id });

    store.setLightCurveSource(source.id, path.id);
    expect(light().curvePin).toMatchObject({
      enabled: true,
      curveId: path.id,
      parameterValue: path.equation.tDomain.min,
      animating: false,
    });
    expect(useAppStore.getState().ui.lightCurveSourcePick).toBeNull();
  });

  it('coalesces slider edits and keeps animation ticks out of undo history', () => {
    const store = useAppStore.getState();
    store.addPlot('curve');
    const path = curve();
    store.addPointLight();
    const source = light();
    store.setLightCurvePinEnabled(source.id, true);
    store.setLightCurveSource(source.id, path.id);
    const historyCount = useAppStore.getState().historyPast.length;

    store.beginLightCurveParameterDrag(source.id);
    store.setLightCurveParameter(source.id, -4);
    store.setLightCurveParameter(source.id, 5);
    store.commitLightCurveParameterDrag(source.id);
    expect(light().curvePin.parameterValue).toBe(5);
    expect(useAppStore.getState().historyPast).toHaveLength(historyCount + 1);

    const afterDragHistory = useAppStore.getState().historyPast.length;
    store.setLightCurveAnimation(source.id, { animating: true, animationSpeed: 0.5 });
    store.applyLightCurveAnimationValues([{ lightId: source.id, parameterValue: 7 }]);
    expect(light().curvePin).toMatchObject({ animating: true, animationSpeed: 0.5, parameterValue: 7 });
    expect(useAppStore.getState().historyPast).toHaveLength(afterDragHistory);
  });

  it('preserves the last pinned position when unpinned or when the source is deleted', () => {
    const store = useAppStore.getState();
    store.addPlot('curve');
    const path = curve();
    store.addPointLight();
    const source = light();
    store.setLightCurvePinEnabled(source.id, true);
    store.setLightCurveSource(source.id, path.id);
    store.setLightCurveParameter(source.id, 0);
    store.setLightCurvePinEnabled(source.id, false);
    expect(light().position).toEqual({ x: 1, y: 0, z: 0 });

    store.setLightCurvePinEnabled(source.id, true);
    store.setLightCurveSource(source.id, path.id);
    store.setLightCurveAnimation(source.id, { animating: true });
    store.deleteObject(path.id);
    expect(light().curvePin).toMatchObject({ enabled: true, curveId: null, animating: false });
    expect(light().position).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('stops animation and holds the last position when curve bounds or parsing become invalid', () => {
    const store = useAppStore.getState();
    store.addPlot('curve');
    const path = curve();
    store.addPointLight();
    const source = light();
    store.setLightCurvePinEnabled(source.id, true);
    store.setLightCurveSource(source.id, path.id);
    store.setLightCurveParameter(source.id, 0);
    store.setLightCurveAnimation(source.id, { animating: true });

    store.updatePlotSpec(path.id, (spec) => spec.kind === 'parametric_curve'
      ? { ...spec, tDomain: { ...spec.tDomain, max: spec.tDomain.min } }
      : spec);
    expect(light().curvePin).toMatchObject({ curveId: path.id, animating: false });
    expect(light().position).toEqual({ x: 1, y: 0, z: 0 });
    store.setLightCurveAnimation(source.id, { animating: true });
    expect(light().curvePin.animating).toBe(false);

    store.updatePlotSpec(path.id, (spec) => spec.kind === 'parametric_curve'
      ? { ...spec, tDomain: { ...spec.tDomain, min: -12, max: 12 } }
      : spec);
    store.setLightCurveAnimation(source.id, { animating: true });
    expect(light().curvePin.animating).toBe(true);
    store.updatePlotEquationText(path.id, '(');
    expect(light().curvePin).toMatchObject({ curveId: path.id, animating: false });
    expect(light().position).toEqual({ x: 1, y: 0, z: 0 });
  });
});
