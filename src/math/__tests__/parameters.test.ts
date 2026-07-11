import { describe, expect, it } from 'vitest';
import type { EquationParameter } from '../../types/contracts';
import {
  DEFAULT_PARAMETER_ANIMATION_SPEED,
  MAX_PARAMETER_ANIMATION_SPEED,
  MIN_PARAMETER_ANIMATION_SPEED,
  adaptStepForSpan,
  advanceAnimatedParameter,
  clampAnimationSpeed,
  setEquationParameterBound,
} from '../parameters';

function parameter(overrides: Partial<EquationParameter> = {}): EquationParameter {
  return {
    name: 'a',
    value: 0,
    min: -10,
    max: 10,
    step: 0.1,
    animating: true,
    animationSpeed: 0.25,
    ...overrides,
  };
}

describe('advanceAnimatedParameter', () => {
  it('advances by speed as a fraction of the range per second', () => {
    const step = advanceAnimatedParameter(parameter({ value: 0, animationSpeed: 0.25 }), 0.5, 1);
    // range 20 * 0.25/s * 0.5s = 2.5
    expect(step.value).toBeCloseTo(2.5);
    expect(step.direction).toBe(1);
  });

  it('clamps at max and reverses direction', () => {
    const step = advanceAnimatedParameter(parameter({ value: 9.9, animationSpeed: 1 }), 0.5, 1);
    expect(step.value).toBe(10);
    expect(step.direction).toBe(-1);
  });

  it('clamps at min and reverses direction', () => {
    const step = advanceAnimatedParameter(parameter({ value: -9.9, animationSpeed: 1 }), 0.5, -1);
    expect(step.value).toBe(-10);
    expect(step.direction).toBe(1);
  });

  it('leaves degenerate ranges untouched', () => {
    const frozen = advanceAnimatedParameter(parameter({ value: 3, min: 3, max: 3 }), 0.5, 1);
    expect(frozen.value).toBe(3);
    expect(frozen.direction).toBe(1);
  });

  it('ignores invalid time deltas', () => {
    const step = advanceAnimatedParameter(parameter({ value: 1 }), Number.NaN, 1);
    expect(step.value).toBe(1);
  });

  it('stays within bounds across many ticks', () => {
    let value = 0;
    let direction: 1 | -1 = 1;
    for (let i = 0; i < 500; i += 1) {
      const step = advanceAnimatedParameter(parameter({ value, animationSpeed: 2 }), 0.13, direction);
      value = step.value;
      direction = step.direction;
      expect(value).toBeGreaterThanOrEqual(-10);
      expect(value).toBeLessThanOrEqual(10);
    }
  });
});

describe('setEquationParameterBound', () => {
  it('shrinks the minimum and pins the value to it', () => {
    const next = setEquationParameterBound([parameter({ value: -10 })], 'a', 'min', -2);
    expect(next[0]).toMatchObject({ min: -2, max: 10, value: -2 });
  });

  it('shrinks the maximum and pins the value to it', () => {
    const next = setEquationParameterBound([parameter({ value: 10 })], 'a', 'max', 3);
    expect(next[0]).toMatchObject({ min: -10, max: 3, value: 3 });
  });

  it('expands a bound outward too', () => {
    const next = setEquationParameterBound([parameter({ value: 10 })], 'a', 'max', 50);
    expect(next[0]).toMatchObject({ min: -10, max: 50, value: 50 });
  });

  it('rejects degenerate ranges and non-finite bounds', () => {
    const original = parameter({ value: -10 });
    expect(setEquationParameterBound([original], 'a', 'min', 10)[0]).toEqual(original);
    expect(setEquationParameterBound([original], 'a', 'min', 12)[0]).toEqual(original);
    expect(setEquationParameterBound([original], 'a', 'max', -10)[0]).toEqual(original);
    expect(setEquationParameterBound([original], 'a', 'min', Number.NaN)[0]).toEqual(original);
  });

  it('leaves other parameters untouched and preserves animation settings', () => {
    const other = parameter({ name: 'b' });
    const next = setEquationParameterBound([parameter({ value: -10, animating: true, animationSpeed: 0.7 }), other], 'a', 'min', -1);
    expect(next[0]).toMatchObject({ animating: true, animationSpeed: 0.7, min: -1 });
    expect(next[1]).toEqual(other);
  });

  it('refines the step when the new span would be too coarse for the slider', () => {
    const next = setEquationParameterBound([parameter({ value: -10, step: 0.5 })], 'a', 'min', 9.5);
    // span 0.5 at step 0.5 = one position; expect a fine 1/2/5 fraction instead
    expect(next[0].step).toBeLessThanOrEqual(0.005);
    expect(next[0].step).toBeGreaterThan(0);
  });
});

describe('adaptStepForSpan', () => {
  it('keeps steps that already give enough positions', () => {
    expect(adaptStepForSpan(0.1, 20)).toBe(0.1);
    expect(adaptStepForSpan(1, 20)).toBe(1);
  });

  it('refines coarse steps to nice decade fractions', () => {
    expect(adaptStepForSpan(1, 2)).toBe(0.02);
    expect(adaptStepForSpan(0.1, 0.4)).toBeCloseTo(0.005);
    expect(adaptStepForSpan(0.1, 0.1)).toBeCloseTo(0.001);
  });

  it('ignores invalid inputs', () => {
    expect(adaptStepForSpan(0.1, 0)).toBe(0.1);
    expect(adaptStepForSpan(0, 5)).toBe(0);
  });
});

describe('clampAnimationSpeed', () => {
  it('defaults missing or invalid speeds', () => {
    expect(clampAnimationSpeed(undefined)).toBe(DEFAULT_PARAMETER_ANIMATION_SPEED);
    expect(clampAnimationSpeed(Number.NaN)).toBe(DEFAULT_PARAMETER_ANIMATION_SPEED);
  });

  it('clamps to the supported range', () => {
    expect(clampAnimationSpeed(0)).toBe(MIN_PARAMETER_ANIMATION_SPEED);
    expect(clampAnimationSpeed(99)).toBe(MAX_PARAMETER_ANIMATION_SPEED);
    expect(clampAnimationSpeed(0.5)).toBe(0.5);
  });
});
