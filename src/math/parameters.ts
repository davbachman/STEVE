import type { EquationParameter } from '../types/contracts';

const DEFAULT_PARAMETER_VALUE = 1;
const DEFAULT_PARAMETER_RANGE = 10;
const DEFAULT_PARAMETER_STEP = 0.1;
export const DEFAULT_DISCRETE_PARAMETER_COUNT = 5;
export const MIN_DISCRETE_PARAMETER_COUNT = 1;
export const MAX_DISCRETE_PARAMETER_COUNT = 64;

export function createEquationParameter(name: string): EquationParameter {
  return {
    name,
    value: DEFAULT_PARAMETER_VALUE,
    min: -DEFAULT_PARAMETER_RANGE,
    max: DEFAULT_PARAMETER_RANGE,
    step: DEFAULT_PARAMETER_STEP,
    samplingMode: 'continuous',
    discreteMin: -DEFAULT_PARAMETER_RANGE,
    discreteMax: DEFAULT_PARAMETER_RANGE,
    discreteCount: DEFAULT_DISCRETE_PARAMETER_COUNT,
  };
}

export function syncEquationParameters(
  names: readonly string[],
  existing: readonly EquationParameter[] = [],
): EquationParameter[] {
  const existingByName = new Map(existing.map((parameter) => [parameter.name, parameter] as const));
  return names.map((name) => {
    const existingParameter = existingByName.get(name);
    if (!existingParameter) {
      return createEquationParameter(name);
    }
    const discreteMin = Number.isFinite(existingParameter.discreteMin) ? existingParameter.discreteMin : existingParameter.min;
    const discreteMax = Number.isFinite(existingParameter.discreteMax) ? existingParameter.discreteMax : existingParameter.max;
    return {
      ...existingParameter,
      samplingMode: existingParameter.samplingMode === 'discrete' ? 'discrete' : 'continuous',
      discreteCount: clampDiscreteParameterCount(existingParameter.discreteCount),
      discreteMin: Math.min(discreteMin, discreteMax),
      discreteMax: Math.max(discreteMin, discreteMax),
    };
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

export function updateEquationParameterSamplingMode(
  parameters: readonly EquationParameter[],
  name: string,
  samplingMode: EquationParameter['samplingMode'],
): EquationParameter[] {
  return parameters.map((parameter) => {
    if (parameter.name !== name) {
      return parameter;
    }
    return {
      ...parameter,
      samplingMode,
      discreteMin: Math.min(parameter.discreteMin, parameter.discreteMax),
      discreteMax: Math.max(parameter.discreteMin, parameter.discreteMax),
      discreteCount: clampDiscreteParameterCount(parameter.discreteCount),
    };
  });
}

export function updateEquationParameterDiscreteSettings(
  parameters: readonly EquationParameter[],
  name: string,
  patch: Partial<Pick<EquationParameter, 'discreteMin' | 'discreteMax' | 'discreteCount'>>,
): EquationParameter[] {
  return parameters.map((parameter) => {
    if (parameter.name !== name) {
      return parameter;
    }
    const rawMin = patch.discreteMin ?? parameter.discreteMin;
    const rawMax = patch.discreteMax ?? parameter.discreteMax;
    return {
      ...parameter,
      discreteMin: Math.min(rawMin, rawMax),
      discreteMax: Math.max(rawMin, rawMax),
      discreteCount: clampDiscreteParameterCount(patch.discreteCount ?? parameter.discreteCount),
    };
  });
}

export function equationParameterValueContexts(parameters: readonly EquationParameter[]): Record<string, number>[] {
  let contexts: Array<Record<string, number>> = [{}];
  for (const parameter of parameters) {
    const values = parameter.samplingMode === 'discrete'
      ? discreteParameterValues(parameter.discreteMin, parameter.discreteMax, parameter.discreteCount)
      : [parameter.value];
    const nextContexts: Array<Record<string, number>> = [];
    for (const context of contexts) {
      for (const value of values) {
        nextContexts.push({
          ...context,
          [parameter.name]: value,
        });
      }
    }
    contexts = nextContexts;
  }
  return contexts;
}

export function applyEquationParameterContext(
  parameters: readonly EquationParameter[],
  context: Record<string, number>,
): EquationParameter[] {
  return parameters.map((parameter) => ({
    ...parameter,
    value: typeof context[parameter.name] === 'number' ? context[parameter.name] : parameter.value,
  }));
}

export function clampDiscreteParameterCount(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_DISCRETE_PARAMETER_COUNT;
  }
  return Math.min(MAX_DISCRETE_PARAMETER_COUNT, Math.max(MIN_DISCRETE_PARAMETER_COUNT, Math.round(value)));
}

function discreteParameterValues(min: number, max: number, count: number): number[] {
  const normalizedCount = clampDiscreteParameterCount(count);
  if (normalizedCount <= 1) {
    return [min];
  }
  const step = (max - min) / (normalizedCount - 1);
  return Array.from({ length: normalizedCount }, (_, index) => min + step * index);
}
