import type { EquationParameter } from '../types/contracts';

const DEFAULT_PARAMETER_VALUE = 1;
const DEFAULT_PARAMETER_RANGE = 10;
const DEFAULT_PARAMETER_STEP = 0.1;

export const DEFAULT_PARAMETER_ANIMATION_SPEED = 0.25;
export const MIN_PARAMETER_ANIMATION_SPEED = 0.02;
export const MAX_PARAMETER_ANIMATION_SPEED = 2;

export interface ParameterAnimationStep {
  value: number;
  direction: 1 | -1;
}

/**
 * Advance an animated parameter by dtSeconds, bouncing between min and max.
 * Speed is a fraction of the range per second, so a speed of 0.25 sweeps
 * min→max in four seconds regardless of the range width.
 */
export function advanceAnimatedParameter(
  parameter: EquationParameter,
  dtSeconds: number,
  direction: 1 | -1,
): ParameterAnimationStep {
  const range = parameter.max - parameter.min;
  if (!Number.isFinite(range) || range <= 0 || !Number.isFinite(dtSeconds) || dtSeconds < 0) {
    return { value: parameter.value, direction };
  }
  const speed = clampAnimationSpeed(parameter.animationSpeed);
  let value = parameter.value + direction * speed * range * dtSeconds;
  let nextDirection = direction;
  if (value >= parameter.max) {
    value = parameter.max;
    nextDirection = -1;
  } else if (value <= parameter.min) {
    value = parameter.min;
    nextDirection = 1;
  }
  return { value, direction: nextDirection };
}

export function clampAnimationSpeed(speed: number | undefined): number {
  if (typeof speed !== 'number' || !Number.isFinite(speed)) {
    return DEFAULT_PARAMETER_ANIMATION_SPEED;
  }
  return Math.min(MAX_PARAMETER_ANIMATION_SPEED, Math.max(MIN_PARAMETER_ANIMATION_SPEED, speed));
}

export function createEquationParameter(name: string): EquationParameter {
  return {
    name,
    value: DEFAULT_PARAMETER_VALUE,
    min: -DEFAULT_PARAMETER_RANGE,
    max: DEFAULT_PARAMETER_RANGE,
    step: DEFAULT_PARAMETER_STEP,
  };
}

export function syncEquationParameters(
  names: readonly string[],
  existing: readonly EquationParameter[] = [],
): EquationParameter[] {
  const existingByName = new Map(existing.map((parameter) => [parameter.name, parameter] as const));
  return names.map((name) => {
    const existingParameter = existingByName.get(name);
    return existingParameter ? { ...existingParameter } : createEquationParameter(name);
  });
}

export function equationParameterContext(parameters: readonly EquationParameter[]): Record<string, number> {
  const values: Record<string, number> = {};
  for (const parameter of parameters) {
    values[parameter.name] = parameter.value;
  }
  return values;
}

export function updateEquationParameterValue(
  parameters: readonly EquationParameter[],
  name: string,
  value: number,
): EquationParameter[] {
  return parameters.map((parameter) => {
    if (parameter.name !== name) {
      return parameter;
    }
    return {
      ...parameter,
      value,
      min: Math.min(parameter.min, value),
      max: Math.max(parameter.max, value),
    };
  });
}
