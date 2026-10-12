import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store';
import type { PlotObject } from '../../types/contracts';

const state = () => useAppStore.getState();
const plot = () => state().objects.find((o) => o.id === state().selectedId) as PlotObject;
describe('editing history groups', () => {
  beforeEach(() => { state().newProject(); state().addPlot('surface'); });
  afterEach(() => vi.useRealTimers());
  it('undoes a slider gesture as one change and keeps the next gesture separate', () => {
    const id = plot().id, before = plot().material.roughness, count = state().historyPast.length;
    state().beginHistoryGroup('roughness');
    for (const value of [0.1, 0.2, 0.4, 0.6]) state().updatePlotMaterial(id, { roughness: value });
    state().endHistoryGroup();
    expect(state().historyPast.length).toBe(count + 1);
    state().undo(); expect(plot().material.roughness).toBe(before);
    state().redo(); expect(plot().material.roughness).toBe(0.6);
    state().beginHistoryGroup('roughness'); state().updatePlotMaterial(id, { roughness: 0.8 }); state().endHistoryGroup();
    state().undo(); expect(plot().material.roughness).toBe(0.6);
  });
  it('groups typing bursts, but splits on pauses, blur and other document edits', () => {
    vi.useFakeTimers();
    const id = plot().id, original = plot().equation.source.rawText;
    state().updatePlotEquationText(id, '(u,v,1)'); state().updatePlotEquationText(id, '(u,v,12)');
    state().undo(); expect(plot().equation.source.rawText).toBe(original);
    state().redo(); expect(plot().equation.source.rawText).toBe('(u,v,12)');
    vi.advanceTimersByTime(800); state().updatePlotEquationText(id, '(u,v,123)');
    state().endHistoryGroup(); state().updatePlotEquationText(id, '(u,v,1234)');
    state().undo(); expect(plot().equation.source.rawText).toBe('(u,v,123)');
    state().updatePlotMaterial(id, { roughness: 0.2 }); state().updatePlotEquationText(id, '(u,v,5)');
    state().undo(); expect(plot().equation.source.rawText).toBe('(u,v,123)');
    expect(plot().material.roughness).toBe(0.2);
  });
});
