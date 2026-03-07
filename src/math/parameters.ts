import type { EquationParameter } from '../types/contracts';

const DEFAULT_PARAMETER_VALUE = 1;
const DEFAULT_PARAMETER_RANGE = 10;
const DEFAULT_PARAMETER_STEP = 0.1;

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
