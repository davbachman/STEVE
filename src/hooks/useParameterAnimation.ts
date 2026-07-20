import { useEffect } from 'react';
import { curveParameterBounds, curveTraversalMode, pinnedCurveForLight } from '../math/curvePinning';
import { advanceAnimatedParameter, advanceLoopingParameter } from '../math/parameters';
import { isAnimationGifRecording } from '../renderer/animationRecordingState';
import { useAppStore } from '../state/store';

const MAX_FRAME_DT_SECONDS = 0.1;

/**
 * Drives all playing continuous equation parameters with a single
 * requestAnimationFrame loop. Values ping-pong between each parameter's min
 * and max; per-parameter bounce direction is runtime-only state and is never
 * persisted. Discrete playback is static and handled by mesh expansion.
 */
export function useParameterAnimation(): void {
  const hasAnimatingParameters = useAppStore((state) => state.objects.some((object) => {
    if (object.type === 'plot') {
      return object.equation.parameters.some(
        (parameter) => parameter.samplingMode === 'continuous' && parameter.animating,
      );
    }
    return (object.type === 'point_light' || object.type === 'directional_light')
      && object.curvePin.enabled
      && object.curvePin.animating
      && !!object.curvePin.curveId;
  }));

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
      if (isAnimationGifRecording()) {
        frame = window.requestAnimationFrame(tick);
        return;
      }
      const state = useAppStore.getState();
      const updates: Array<{ plotId: string; parameterName: string; value: number }> = [];
      const lightUpdates: Array<{ lightId: string; parameterValue: number }> = [];
      for (const object of state.objects) {
        if (object.type === 'plot') {
          for (const parameter of object.equation.parameters) {
            if (parameter.samplingMode !== 'continuous' || !parameter.animating) continue;
            const key = `${object.id}:${parameter.name}`;
            const step = advanceAnimatedParameter(parameter, dt, directions.get(key) ?? 1);
            directions.set(key, step.direction);
            if (step.value !== parameter.value) {
              updates.push({ plotId: object.id, parameterName: parameter.name, value: step.value });
            }
          }
          continue;
        }
        if (object.type !== 'point_light' && object.type !== 'directional_light') continue;
        if (!object.curvePin.animating) continue;
        const curve = pinnedCurveForLight(object, state.objects);
        const bounds = curve ? curveParameterBounds(curve) : null;
        if (!curve || !bounds) continue;
        const parameter = {
          value: object.curvePin.parameterValue,
          min: bounds.min,
          max: bounds.max,
          animationSpeed: object.curvePin.animationSpeed,
        };
        let parameterValue: number;
        if (curveTraversalMode(curve) === 'wrap') {
          parameterValue = advanceLoopingParameter(parameter, dt);
        } else {
          const key = `light:${object.id}`;
          const step = advanceAnimatedParameter(parameter, dt, directions.get(key) ?? 1);
          directions.set(key, step.direction);
          parameterValue = step.value;
        }
        if (parameterValue !== object.curvePin.parameterValue) {
          lightUpdates.push({ lightId: object.id, parameterValue });
        }
      }
      if (updates.length > 0) {
        state.applyParameterAnimationValues(updates);
      }
      if (lightUpdates.length > 0) {
        useAppStore.getState().applyLightCurveAnimationValues(lightUpdates);
      }
      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [hasAnimatingParameters]);
}
