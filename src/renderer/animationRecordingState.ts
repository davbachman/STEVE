let animationGifRecording = false;

export class GifSelectionGuard {
  private active = false;
  private selectedIdBeforeRecording: string | null = null;

  begin(selectedId: string | null): void {
    this.active = true;
    this.selectedIdBeforeRecording = selectedId;
  }

  selectedIdForRender(selectedId: string | null): string | null {
    return this.active ? null : selectedId;
  }

  finish(availableObjectIds: ReadonlySet<string>): string | null {
    const selectedId = this.selectedIdBeforeRecording;
    this.active = false;
    this.selectedIdBeforeRecording = null;
    return selectedId && availableObjectIds.has(selectedId) ? selectedId : null;
  }
}

export function isAnimationGifRecording(): boolean {
  return animationGifRecording;
}

export function setAnimationGifRecording(recording: boolean): void {
  animationGifRecording = recording;
}
