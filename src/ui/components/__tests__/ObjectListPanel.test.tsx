import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../../state/store';
import { ObjectListPanel } from '../ObjectListPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ObjectListPanel creation buttons', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    useAppStore.getState().newProject();
    root = null;
    container = null;
  });

  it('groups creators under Curve, Surface, and Lights and creates an expression-only graph', () => {
    const host = document.createElement('div');
    container = host;
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(<ObjectListPanel />));

    const startupDirectionalToggle = host.querySelector(
      'input[aria-label="Show gizmo for Directional Light 1"]',
    );
    expect(startupDirectionalToggle).toBeInstanceOf(HTMLInputElement);
    expect((startupDirectionalToggle as HTMLInputElement).checked).toBe(false);

    const groups = Array.from(host.querySelectorAll('.creator-group'));
    expect(groups.map((group) => group.querySelector('h3')?.textContent)).toEqual([
      'Curve',
      'Surface',
      'Lights',
    ]);

    const buttons = Array.from(host.querySelectorAll('.creator-group button'));
    expect(buttons.map((button) => button.textContent)).toEqual([
      '+ Parametric',
      '+ Intersection',
      '+ Graph',
      '+ Parametric',
      '+ Implicit',
      '+ Point',
      '+ Directional',
    ]);

    act(() => {
      buttons[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const graph = useAppStore.getState().objects.find((object) => object.type === 'plot');
    expect(graph?.name).toBe('Graph 1');
    expect(graph?.equation.kind).toBe('explicit_surface');
    if (graph?.equation.kind !== 'explicit_surface') throw new Error('Expected graph');
    expect(graph.equation.graphExpression).toBe(true);
    expect(graph.equation.source.rawText).toBe('x^2 - y^2');

    act(() => {
      buttons[5]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      buttons[6]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useAppStore.getState().objects.filter((object) => object.type === 'point_light')).toHaveLength(1);
    expect(useAppStore.getState().objects.filter((object) => object.type === 'directional_light')).toHaveLength(2);
  });

  it('creates intersections without making sidebar cards draggable', () => {
    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addPlot('curve');
      store.addPlot('graph');
      store.addPlot('surface');
      store.addPlot('implicit');
      store.addPointLight();
      store.addIntersection();
    });

    const host = document.createElement('div');
    container = host;
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(<ObjectListPanel />));

    const objects = useAppStore.getState().objects;
    const cardFor = (name: string) => Array.from(host.querySelectorAll<HTMLDivElement>('.object-card')).find(
      (card) => card.querySelector('.object-card__name')?.textContent === name,
    );

    for (const object of objects) {
      const card = cardFor(object.name);
      expect(card, `card for ${object.name}`).toBeInstanceOf(HTMLDivElement);
      expect(card?.draggable).toBe(false);
    }

    const intersection = objects.find((object) => object.type === 'intersection');
    expect(intersection).toBeDefined();
    const intersectionCard = intersection ? cardFor(intersection.name) : undefined;
    expect(intersectionCard?.querySelector('input[type="checkbox"]')).toBeInstanceOf(HTMLInputElement);
  });

  it('controls light illumination independently of handle visibility for both light types', () => {
    act(() => {
      useAppStore.getState().newProject();
      useAppStore.getState().addPointLight();
    });
    const host = document.createElement('div');
    container = host;
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(<ObjectListPanel />));

    for (const light of useAppStore.getState().objects.filter((object) => object.type === 'point_light' || object.type === 'directional_light')) {
      const power = host.querySelector<HTMLButtonElement>(`button[aria-label="Enable ${light.name}"]`);
      const handle = host.querySelector<HTMLInputElement>(`input[aria-label="Show gizmo for ${light.name}"]`);
      if (!power || !handle) throw new Error(`Missing controls for ${light.name}`);
      const originallyVisible = handle.checked;
      expect(power.getAttribute('aria-pressed')).toBe('true');
      act(() => power.click());
      let updated = useAppStore.getState().objects.find((object) => object.id === light.id);
      if (!updated || updated.type === 'plot' || updated.type === 'intersection') throw new Error('Expected light');
      expect(updated.enabled).toBe(false);
      expect(updated.visible).toBe(originallyVisible);
      expect(power.getAttribute('aria-pressed')).toBe('false');
      expect(handle.checked).toBe(originallyVisible);

      act(() => handle.click());
      updated = useAppStore.getState().objects.find((object) => object.id === light.id);
      if (!updated || updated.type === 'plot' || updated.type === 'intersection') throw new Error('Expected light');
      expect(updated.enabled).toBe(false);
      expect(updated.visible).toBe(!originallyVisible);

      act(() => power.click());
      updated = useAppStore.getState().objects.find((object) => object.id === light.id);
      if (!updated || updated.type === 'plot' || updated.type === 'intersection') throw new Error('Expected light');
      expect(updated.enabled).toBe(true);
      expect(updated.visible).toBe(!originallyVisible);
    }
  });

  it('exposes working duplicate and delete actions on the selected object', () => {
    act(() => {
      useAppStore.getState().newProject();
      useAppStore.getState().addPlot('graph');
    });
    const original = useAppStore.getState().objects.find((object) => object.type === 'plot');
    if (!original) throw new Error('Expected graph');
    const host = document.createElement('div');
    container = host;
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(<ObjectListPanel />));
    const duplicate = host.querySelector<HTMLButtonElement>(`button[aria-label="Duplicate ${original.name}"]`);
    if (!duplicate) throw new Error('Missing Duplicate action');
    act(() => duplicate.click());
    const copied = useAppStore.getState().objects.find((object) => object.id === useAppStore.getState().selectedId);
    if (!copied || copied.type !== 'plot') throw new Error('Expected selected duplicate');
    expect(copied.id).not.toBe(original.id);
    expect(copied.equation).toEqual(original.equation);
    expect(useAppStore.getState().objects.filter((object) => object.type === 'plot')).toHaveLength(2);
    expect(host.querySelectorAll('.object-card__actions')).toHaveLength(1);
    const remove = host.querySelector<HTMLButtonElement>(`button[aria-label="Delete ${copied.name}"]`);
    if (!remove) throw new Error('Missing Delete action');
    act(() => remove.click());
    expect(useAppStore.getState().objects.find((object) => object.id === copied.id)).toBeUndefined();
    expect(useAppStore.getState().objects.find((object) => object.id === original.id)).toBeDefined();
    expect(useAppStore.getState().objects.filter((object) => object.type === 'plot')).toHaveLength(1);
  });

});
