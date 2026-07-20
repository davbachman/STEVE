import { describe, expect, it, vi } from 'vitest';
import { handleEscapeShortcut } from '../keyboardShortcuts';

describe('Escape shortcut', () => {
  it('cancels an active GIF recording without clearing the selection', () => {
    const cancelGifRecording = vi.fn(() => true);
    const clearSelection = vi.fn();
    const preventDefault = vi.fn();

    expect(handleEscapeShortcut({ cancelGifRecording }, clearSelection, preventDefault)).toBe('cancel-gif');
    expect(cancelGifRecording).toHaveBeenCalledOnce();
    expect(clearSelection).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('retains the existing clear-selection behavior when no GIF is recording', () => {
    const cancelGifRecording = vi.fn(() => false);
    const clearSelection = vi.fn();
    const preventDefault = vi.fn();

    expect(handleEscapeShortcut({ cancelGifRecording }, clearSelection, preventDefault)).toBe('clear-selection');
    expect(cancelGifRecording).toHaveBeenCalledOnce();
    expect(clearSelection).toHaveBeenCalledOnce();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
