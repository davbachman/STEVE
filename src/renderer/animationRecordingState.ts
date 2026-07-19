let animationGifRecording = false;

export function isAnimationGifRecording(): boolean {
  return animationGifRecording;
}

export function setAnimationGifRecording(recording: boolean): void {
  animationGifRecording = recording;
}
