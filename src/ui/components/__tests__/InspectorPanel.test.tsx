import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RangeField } from '../InspectorPanel';

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
});

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(input, value);
}
