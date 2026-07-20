import type { ViewportApi } from '../renderer/SceneController';

export function handleEscapeShortcut(
  viewportApi: Pick<ViewportApi, 'cancelGifRecording'> | null,
  clearSelection: () => void,
  preventDefault: () => void,
): 'cancel-gif' | 'clear-selection' {
  if (viewportApi?.cancelGifRecording()) {
    preventDefault();
    return 'cancel-gif';
  }
  clearSelection();
  return 'clear-selection';
}
