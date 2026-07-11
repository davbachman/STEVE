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

  it('lists Graph below Curve and creates an expression-only graph', () => {
    const host = document.createElement('div');
    container = host;
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(<ObjectListPanel />));

    const buttons = Array.from(host.querySelectorAll('.panel__actions button'));
    expect(buttons.map((button) => button.textContent)).toEqual([
      '+ Curve',
      '+ Graph',
      '+ Parametric',
      '+ Implicit',
      '+ Light',
    ]);

    act(() => {
      buttons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const graph = useAppStore.getState().objects.find((object) => object.type === 'plot');
    expect(graph?.name).toBe('Graph 1');
    expect(graph?.equation.kind).toBe('explicit_surface');
    if (graph?.equation.kind !== 'explicit_surface') throw new Error('Expected graph');
    expect(graph.equation.graphExpression).toBe(true);
    expect(graph.equation.source.rawText).toBe('x^2 - y^2');
  });
});
