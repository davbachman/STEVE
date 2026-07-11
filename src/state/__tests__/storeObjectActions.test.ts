import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store';

describe('store object row actions', () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
    // The default scene is empty; create a plot and a light to act on.
    useAppStore.getState().addPlot('surface');
    useAppStore.getState().addPointLight();
  });

  it('duplicates an object right after the original and selects the copy', () => {
    const original = useAppStore.getState().objects[0];
    useAppStore.getState().duplicateObject(original.id);

    const state = useAppStore.getState();
    const copy = state.objects[1];
    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe(`${original.name} Copy`);
    expect(copy.type).toBe(original.type);
    expect(state.selectedId).toBe(copy.id);

    useAppStore.getState().undo();
    expect(useAppStore.getState().objects.some((obj) => obj.id === copy.id)).toBe(false);
  });

  it('deletes an object by id and clears the selection when it was selected', () => {
    const target = useAppStore.getState().objects[0];
    useAppStore.getState().selectObject(target.id);
    const countBefore = useAppStore.getState().objects.length;

    useAppStore.getState().deleteObject(target.id);
    const state = useAppStore.getState();
    expect(state.objects).toHaveLength(countBefore - 1);
    expect(state.objects.some((obj) => obj.id === target.id)).toBe(false);
    expect(state.selectedId).toBeNull();

    useAppStore.getState().undo();
    expect(useAppStore.getState().objects.some((obj) => obj.id === target.id)).toBe(true);
  });

  it('keeps an unrelated selection when deleting another object', () => {
    const [first, second] = useAppStore.getState().objects;
    useAppStore.getState().selectObject(second.id);
    useAppStore.getState().deleteObject(first.id);
    expect(useAppStore.getState().selectedId).toBe(second.id);
  });
});
