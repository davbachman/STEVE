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
});
