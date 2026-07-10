import { describe, expect, it } from 'vitest';
import type { EquationParameter } from '../../types/contracts';
import {
  DEFAULT_PARAMETER_ANIMATION_SPEED,
  MAX_PARAMETER_ANIMATION_SPEED,
  MIN_PARAMETER_ANIMATION_SPEED,
  advanceAnimatedParameter,
  clampAnimationSpeed,
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
