import { useEffect } from 'react';
import { advanceAnimatedParameter } from '../math/parameters';
import { useAppStore } from '../state/store';

const MAX_FRAME_DT_SECONDS = 0.1;

/**
 * Drives all animating equation parameters with a single requestAnimationFrame
 * loop. Values ping-pong between each parameter's min and max; per-parameter
 * bounce direction is runtime-only state and is never persisted.
 */
export function useParameterAnimation(): void {
  const hasAnimatingParameters = useAppStore((state) =>
    state.objects.some(
      (object) => object.type === 'plot' && object.equation.parameters.some((parameter) => parameter.animating),
    ),
  );

  useEffect(() => {
    if (!hasAnimatingParameters) {
      return;
    }
    let frame = 0;
    let lastTimestamp = performance.now();
    const directions = new Map<string, 1 | -1>();

    const tick = (timestamp: number) => {
      const dt = Math.min(MAX_FRAME_DT_SECONDS, Math.max(0, (timestamp - lastTimestamp) / 1000));
      lastTimestamp = timestamp;
      const state = useAppStore.getState();
      const updates: Array<{ plotId: string; parameterName: string; value: number }> = [];
      for (const object of state.objects) {
        if (object.type !== 'plot') continue;
        for (const parameter of object.equation.parameters) {
          if (!parameter.animating) continue;
          const key = `${object.id}:${parameter.name}`;
          const step = advanceAnimatedParameter(parameter, dt, directions.get(key) ?? 1);
          directions.set(key, step.direction);
          if (step.value !== parameter.value) {
            updates.push({ plotId: object.id, parameterName: parameter.name, value: step.value });
          }
        }
      }
      if (updates.length > 0) {
        state.applyParameterAnimationValues(updates);
      }
      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [hasAnimatingParameters]);
}
