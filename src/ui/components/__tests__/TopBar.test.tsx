import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewportApi } from '../../../renderer/SceneController';
import { useAppStore } from '../../../state/store';
import { TopBar } from '../TopBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('TopBar menus', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container?.remove();
    useAppStore.getState().newProject();
    root = null;
    container = null;
  });

  it('moves app actions into menus and quality controls into Settings', async () => {
    const exportPng = vi.fn(async () => undefined);
    const viewportApi: ViewportApi = {
      exportPng,
      setViewPreset: vi.fn(),
      frameObject: vi.fn(),
    };
    const host = document.createElement('div');
    container = host;
    document.body.appendChild(host);
    root = createRoot(host);

    act(() => {
      root?.render(
        <TopBar
          viewportApi={viewportApi}
          leftSidebarVisible
          rightSidebarVisible
          onToggleLeftSidebar={vi.fn()}
          onToggleRightSidebar={vi.fn()}
        />,
      );
    });

    const steveButton = buttonWithText(host, 'STEVE');
    expect(steveButton.querySelector('strong')?.textContent).toBe('STEVE');
    act(() => steveButton.click());
    expect(menuItemTexts(host, 'STEVE menu')).toEqual(['About', 'Settings']);
    const aboutLink = host.querySelector('[role="menuitem"][href="https://github.com/davbachman/STEVE"]');
    expect(aboutLink?.getAttribute('target')).toBe('_blank');
    expect(aboutLink?.getAttribute('rel')).toBe('noopener noreferrer');

    act(() => buttonWithText(host, 'Settings').click());
    expect(host.querySelector('[role="dialog"]')).toBeInstanceOf(HTMLElement);
    const pngQuality = host.querySelector('select[aria-label="PNG Export Quality"]');
    const interactiveQuality = host.querySelector('select[aria-label="Interactive Quality"]');
    expect(pngQuality).toBeInstanceOf(HTMLSelectElement);
    expect(interactiveQuality).toBeInstanceOf(HTMLSelectElement);
    if (!(pngQuality instanceof HTMLSelectElement) || !(interactiveQuality instanceof HTMLSelectElement)) {
      throw new Error('Expected settings selects');
    }

    act(() => {
      setNativeSelectValue(pngQuality, '4');
      pngQuality.dispatchEvent(new Event('change', { bubbles: true }));
      setNativeSelectValue(interactiveQuality, 'performance');
      interactiveQuality.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(useAppStore.getState().render.interactiveQuality).toBe('performance');

    act(() => buttonWithText(host, 'Close settings').click());
    act(() => buttonWithText(host, 'File').click());
    expect(menuItemTexts(host, 'File menu')).toEqual([
      'New',
      'Save',
      'Open',
      'Export PNG',
      'Export STL',
    ]);

    await act(async () => {
      buttonWithText(host, 'Export PNG').click();
      await Promise.resolve();
    });
    expect(exportPng).toHaveBeenCalledWith(undefined, 4);
  });
});

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.replace('▾', '').trim() === text || candidate.getAttribute('aria-label') === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button: ${text}`);
  }
  return button;
}

function menuItemTexts(container: HTMLElement, label: string): string[] {
  const menu = container.querySelector(`[role="menu"][aria-label="${label}"]`);
  return Array.from(menu?.querySelectorAll('[role="menuitem"]') ?? []).map((item) => item.textContent?.trim() ?? '');
}

function setNativeSelectValue(select: HTMLSelectElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  descriptor?.set?.call(select, value);
}
