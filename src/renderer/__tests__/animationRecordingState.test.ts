import { describe, expect, it } from 'vitest';
import { GifSelectionGuard } from '../animationRecordingState';

describe('GIF recording selection guard', () => {
  it('suppresses selection throughout recording and restores the original object', () => {
    const guard = new GifSelectionGuard();

    guard.begin('curve-1');

    expect(guard.selectedIdForRender('curve-1')).toBeNull();
    expect(guard.selectedIdForRender('curve-2')).toBeNull();
    expect(guard.finish(new Set(['curve-1', 'curve-2']))).toBe('curve-1');
    expect(guard.selectedIdForRender('curve-2')).toBe('curve-2');
  });

  it('leaves selection clear when the original object no longer exists', () => {
    const guard = new GifSelectionGuard();

    guard.begin('deleted-light');

    expect(guard.finish(new Set(['curve-1']))).toBeNull();
  });
});
