import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../state/store';
import { InspectorPanel, RangeField } from '../InspectorPanel';

// React 19 expects the test environment to opt into act() support.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('RangeField numeric entry', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    useAppStore.getState().newProject();
    root = null;
    container = null;
  });

  it('allows clearing the full numeric draft before typing a replacement value', () => {
    const onChange = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <RangeField
          label="Value"
          min={-10}
          max={10}
          step={0.1}
          value={4.2}
          onChange={onChange}
        />,
      );
    });

    const numberInput = container.querySelector('input[type="number"]');
    expect(numberInput).toBeInstanceOf(HTMLInputElement);
    if (!(numberInput instanceof HTMLInputElement)) {
      throw new Error('Expected number input');
    }

    act(() => {
      numberInput.focus();
    });

    act(() => {
      setNativeInputValue(numberInput, '');
      numberInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(numberInput.value).toBe('');

    act(() => {
      setNativeInputValue(numberInput, '7');
      numberInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(numberInput.value).toBe('7');

    act(() => {
      numberInput.blur();
    });
    expect(onChange).toHaveBeenCalledWith(7);
  });

  it('uses a play button and discrete slider levels instead of always showing every copy', () => {
    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addPlot('surface');
      const plot = useAppStore.getState().objects.find((object) => object.type === 'plot');
      if (!plot) throw new Error('Expected plot');
      useAppStore.getState().updatePlotEquationText(plot.id, 'z = a*x');
      useAppStore.getState().setInspectorTab('object');
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<InspectorPanel />);
    });

    const modeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Continuous',
    );
    const plotBeforeToggle = useAppStore.getState().objects.find((object) => object.type === 'plot');
    expect(plotBeforeToggle?.equation.kind).toBe('explicit_surface');
    expect(modeButton).toBeInstanceOf(HTMLButtonElement);
    act(() => {
      modeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(modeButton?.textContent).toBe('Discrete');

    const playButton = container.querySelector('button[aria-label="Show all a copies"]');
    expect(playButton).toBeInstanceOf(HTMLButtonElement);
    expect(playButton?.getAttribute('aria-pressed')).toBe('false');

    const rangeFields = Array.from(container.querySelectorAll('.range-field'));
    const valueField = rangeFields.find((field) => field.firstElementChild?.textContent === 'Value');
    const copyCountField = rangeFields.find((field) => field.firstElementChild?.textContent === 'num copies');
    expect(valueField?.querySelector('input[type="range"]')?.getAttribute('step')).toBe('5');
    expect(copyCountField).toBeInstanceOf(HTMLLabelElement);

    act(() => {
      playButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(playButton?.getAttribute('aria-pressed')).toBe('true');
    const plot = useAppStore.getState().objects.find((object) => object.type === 'plot');
    expect(plot?.equation.parameters[0]?.animating).toBe(true);
  });

  it('uses compact numeric bounds tables while retaining sampling sliders', () => {
    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addPlot('curve');
      store.setInspectorTab('object');
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<InspectorPanel />);
    });

    const curveTable = container.querySelector('[aria-label="Curve parameter bounds"]');
    expect(curveTable).toBeInstanceOf(HTMLDivElement);
    expect(curveTable?.querySelectorAll('input[type="number"]')).toHaveLength(2);
    expect(curveTable?.querySelector('input[type="range"]')).toBeNull();
    expect(curveTable?.querySelector('input[aria-label="t min"]')).toBeInstanceOf(HTMLInputElement);
    expect(curveTable?.querySelector('input[aria-label="t max"]')).toBeInstanceOf(HTMLInputElement);
    expect(Array.from(container.querySelectorAll('.range-field')).some(
      (field) => field.firstElementChild?.textContent === 'Samples',
    )).toBe(true);

    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addPlot('graph');
    });

    const graphTable = container.querySelector('[aria-label="Graph parameter bounds"]');
    expect(graphTable).toBeInstanceOf(HTMLDivElement);
    expect(graphTable?.querySelectorAll('input[type="number"]')).toHaveLength(4);
    expect(graphTable?.querySelector('input[type="range"]')).toBeNull();
    for (const label of ['x min', 'x max', 'y min', 'y max']) {
      expect(graphTable?.querySelector(`input[aria-label="${label}"]`)).toBeInstanceOf(HTMLInputElement);
    }
    const samplingFields = Array.from(container.querySelectorAll('.range-field')).filter(
      (field) => field.firstElementChild?.textContent?.endsWith('samples'),
    );
    expect(samplingFields).toHaveLength(2);

    act(() => {
      const store = useAppStore.getState();
      store.newProject();
      store.addPlot('implicit');
    });

    const implicitTable = container.querySelector('[aria-label="Implicit surface object bounds"]');
    expect(implicitTable).toBeInstanceOf(HTMLDivElement);
    expect(implicitTable?.querySelectorAll('input[type="number"]')).toHaveLength(6);
    expect(implicitTable?.querySelector('input[type="range"]')).toBeNull();
    for (const label of ['x min', 'x max', 'y min', 'y max', 'z min', 'z max']) {
      expect(implicitTable?.querySelector(`input[aria-label="${label}"]`)).toBeInstanceOf(HTMLInputElement);
    }
  });
});

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(input, value);
}
