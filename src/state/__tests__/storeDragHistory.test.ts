import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store';
import type { PlotObject } from '../../types/contracts';

function firstPlot(): PlotObject {
  const plot = useAppStore.getState().objects.find((obj): obj is PlotObject => obj.type === 'plot');
  if (!plot) {
    throw new Error('Expected default plot in initial scene');
  }
  return plot;
}

describe('store drag history', () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
  });

  it('coalesces drag movement into a single undo entry', () => {
    const store = useAppStore.getState();
    const plot = firstPlot();
    const start = { ...plot.transform.position };

    store.selectObject(plot.id);
    store.beginObjectDragHistory(plot.id);
    store.setObjectPosition(plot.id, { x: start.x + 1, y: start.y + 0.5, z: start.z });
    store.setObjectPosition(plot.id, { x: start.x + 2, y: start.y + 1, z: start.z + 0.25 });
    store.commitObjectDragHistory(plot.id);

    let state = useAppStore.getState();
    const movedPlot = state.objects.find((obj): obj is PlotObject => obj.id === plot.id && obj.type === 'plot');
    expect(movedPlot).toBeTruthy();
    expect(state.historyPast).toHaveLength(1);
    expect(state.activeObjectDragHistory).toBeNull();
    expect(movedPlot?.transform.position).toEqual({ x: start.x + 2, y: start.y + 1, z: start.z + 0.25 });

    state.undo();
    state = useAppStore.getState();
    const undonePlot = state.objects.find((obj): obj is PlotObject => obj.id === plot.id && obj.type === 'plot');
    expect(undonePlot?.transform.position).toEqual(start);

    state.redo();
    state = useAppStore.getState();
    const redonePlot = state.objects.find((obj): obj is PlotObject => obj.id === plot.id && obj.type === 'plot');
    expect(redonePlot?.transform.position).toEqual({ x: start.x + 2, y: start.y + 1, z: start.z + 0.25 });
  });

  it('does not create a history entry for a click without movement', () => {
    const store = useAppStore.getState();
    const plot = firstPlot();

    store.beginObjectDragHistory(plot.id);
    store.commitObjectDragHistory(plot.id);

    const state = useAppStore.getState();
    expect(state.historyPast).toHaveLength(0);
    expect(state.activeObjectDragHistory).toBeNull();
  });
});
