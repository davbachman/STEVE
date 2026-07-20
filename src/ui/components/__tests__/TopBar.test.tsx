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

  it('moves rendering and quality controls into Settings', async () => {
    const exportPng = vi.fn(async () => undefined);
    const viewportApi: ViewportApi = {
      exportPng,
      recordTurntableGif: vi.fn(async () => undefined),
      recordParameterGif: vi.fn(async () => undefined),
      recordLightCurveGif: vi.fn(async () => undefined),
      cancelGifRecording: vi.fn(() => false),
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
    expect(menuItemTexts(host, 'STEVE menu')).toEqual(['About', 'Instructions', 'Feedback', 'Settings']);
    const instructionsLink = host.querySelector('[role="menuitem"][href="https://github.com/davbachman/STEVE"]');
    expect(instructionsLink?.getAttribute('target')).toBe('_blank');
    expect(instructionsLink?.getAttribute('rel')).toBe('noopener noreferrer');

    act(() => buttonWithText(host, 'About').click());
    const aboutDialog = host.querySelector('[role="dialog"][aria-labelledby="about-title"]');
    expect(aboutDialog?.textContent).toContain('ST.E.V.E.');
    expect(aboutDialog?.textContent).toContain('STudio for Equation Visualization and Experimentation');
    expect(aboutDialog?.textContent).toContain('with GPT 5.4, 5.5, 5.6 Sol, and Fable 5.');
    expect(aboutDialog?.textContent).toContain('For more apps and AI info, subscribe to Entropy Bonus.');
    expect(aboutDialog?.querySelector('a[href="https://davidbachmandesign.com"]')?.textContent).toBe('David Bachman');
    expect(aboutDialog?.querySelector('a[href="https://profbachman.substack.com"]')?.textContent).toBe('Entropy Bonus');

    act(() => buttonWithText(host, 'Close about').click());
    act(() => steveButton.click());

    act(() => buttonWithText(host, 'Feedback').click());
    const feedbackDialog = host.querySelector('[role="dialog"][aria-labelledby="feedback-title"]');
    expect(feedbackDialog).toBeInstanceOf(HTMLElement);
    expect(Array.from(feedbackDialog?.querySelectorAll('input[type="checkbox"]') ?? []).map(
      (input) => input.parentElement?.textContent?.trim(),
    )).toEqual(['Feature Request', 'Bug Report', 'Contact']);
    const sendButton = buttonWithText(host, 'Send');
    expect(sendButton.disabled).toBe(true);
    const featureRequestCheckbox = feedbackDialog?.querySelector('input[type="checkbox"]');
    const message = feedbackDialog?.querySelector('textarea');
    if (!(featureRequestCheckbox instanceof HTMLInputElement) || !(message instanceof HTMLTextAreaElement)) {
      throw new Error('Expected feedback fields');
    }
    act(() => featureRequestCheckbox.click());
    act(() => {
      setNativeTextAreaValue(message, 'Please add a fourth dimension.');
      message.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(sendButton.disabled).toBe(false);
    const openEmail = vi.spyOn(window, 'open').mockImplementation(() => null);
    act(() => sendButton.click());
    expect(openEmail).toHaveBeenCalledWith(
      'mailto:bachman@pitzer.edu?subject=STEVE%3A%20Feature%20Request&body=Please%20add%20a%20fourth%20dimension.',
      '_self',
    );
    expect(host.querySelector('[role="dialog"][aria-labelledby="feedback-title"]')).toBeNull();
    openEmail.mockRestore();

    act(() => steveButton.click());
    act(() => buttonWithText(host, 'Settings').click());
    const settingsDialog = host.querySelector('[role="dialog"]');
    expect(settingsDialog).toBeInstanceOf(HTMLElement);
    expect(settingsDialog?.textContent).not.toContain('Render diagnostics overlay');
    const toneMapping = host.querySelector('select[aria-label="Tone Mapping"]');
    const pngQuality = host.querySelector('select[aria-label="PNG Export Quality"]');
    const gifMaximumSize = host.querySelector('select[aria-label="GIF Maximum Size"]');
    const gifFrameRate = host.querySelector('select[aria-label="GIF Frame Rate"]');
    const interactiveQuality = host.querySelector('select[aria-label="Interactive Quality"]');
    expect(toneMapping).toBeInstanceOf(HTMLSelectElement);
    expect(pngQuality).toBeInstanceOf(HTMLSelectElement);
    expect(gifMaximumSize).toBeInstanceOf(HTMLSelectElement);
    expect(gifFrameRate).toBeInstanceOf(HTMLSelectElement);
    expect(interactiveQuality).toBeInstanceOf(HTMLSelectElement);
    if (
      !(toneMapping instanceof HTMLSelectElement)
      || !(pngQuality instanceof HTMLSelectElement)
      || !(gifMaximumSize instanceof HTMLSelectElement)
      || !(gifFrameRate instanceof HTMLSelectElement)
      || !(interactiveQuality instanceof HTMLSelectElement)
    ) {
      throw new Error('Expected settings selects');
    }
    for (const label of ['Exposure', 'Halo strength', 'Halo radius', 'Halo threshold']) {
      expect(Array.from(settingsDialog?.querySelectorAll('.range-field') ?? []).some(
        (field) => field.firstElementChild?.textContent === label,
      )).toBe(true);
    }

    act(() => {
      setNativeSelectValue(toneMapping, 'filmic');
      toneMapping.dispatchEvent(new Event('change', { bubbles: true }));
      setNativeSelectValue(pngQuality, '4');
      pngQuality.dispatchEvent(new Event('change', { bubbles: true }));
      setNativeSelectValue(gifMaximumSize, '1080');
      gifMaximumSize.dispatchEvent(new Event('change', { bubbles: true }));
      setNativeSelectValue(gifFrameRate, '10');
      gifFrameRate.dispatchEvent(new Event('change', { bubbles: true }));
      setNativeSelectValue(interactiveQuality, 'performance');
      interactiveQuality.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(useAppStore.getState().render.toneMapping).toBe('filmic');
    expect(useAppStore.getState().render.gifMaxDimension).toBe(1080);
    expect(useAppStore.getState().render.gifFrameRate).toBe(10);
    expect(useAppStore.getState().render.interactiveQuality).toBe('performance');

    const haloCheckbox = Array.from(settingsDialog?.querySelectorAll('input[type="checkbox"]') ?? []).find(
      (input) => input.parentElement?.textContent?.includes('Halos'),
    );
    expect(haloCheckbox).toBeInstanceOf(HTMLInputElement);
    act(() => haloCheckbox?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(useAppStore.getState().render.bloomEnabled).toBe(false);
    expect(Array.from(settingsDialog?.querySelectorAll('.range-field') ?? []).some(
      (field) => field.firstElementChild?.textContent === 'Halo strength',
    )).toBe(false);
    expect(settingsDialog?.textContent).not.toContain('Bloom');

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

function setNativeTextAreaValue(textarea: HTMLTextAreaElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  descriptor?.set?.call(textarea, value);
}
