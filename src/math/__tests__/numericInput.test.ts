import { describe, expect, it } from 'vitest';
import { evaluateNumericInputExpression } from '../numericInput';

describe('numeric input expressions', () => {
  it('evaluates constants, arithmetic, and supported functions', () => {
    expect(evaluateNumericInputExpression('5*sqrt(2)')).toBeCloseTo(5 * Math.sqrt(2), 12);
    expect(evaluateNumericInputExpression('pi/2')).toBeCloseTo(Math.PI / 2, 12);
    expect(evaluateNumericInputExpression('cos(pi/2)')).toBe(0);
  });

  it('rejects variables, tuples, equalities, invalid syntax, and non-finite results', () => {
    expect(evaluateNumericInputExpression('x + 1')).toBeNull();
    expect(evaluateNumericInputExpression('(1, 2, 3)')).toBeNull();
    expect(evaluateNumericInputExpression('x = 1')).toBeNull();
    expect(evaluateNumericInputExpression('sqrt(')).toBeNull();
    expect(evaluateNumericInputExpression('1/0')).toBeNull();
  });
});
