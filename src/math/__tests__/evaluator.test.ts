import { describe, expect, it } from 'vitest';
import { parseMath } from '../parser';
import { compileNumericExpression, evaluateNumericExpression } from '../evaluator';

describe('compiled numeric operations', () => {
  it.each(['-x + y*3/2 - x^2', 'sin(x)+cos(y)+tan(x)', 'sqrt(abs(x))+ln(y)+log(y)+exp(x)',
    'asin(x)+acos(x)+atan(y)+sinh(x)+cosh(x)+tanh(y)', 'pi*x+e', '1/(x-x)', 'sqrt(-1)'])('matches interpreter semantics for %s', (source) => {
    const ast = parseMath(source).ast!;
    const fn = compileNumericExpression(ast);
    for (const x of [-0.5, 0, 0.8]) {
      const vars = { x, y: 2 };
      expect(fn(vars)).toBe(evaluateNumericExpression(ast, vars));
    }
  });
  it('does not mistake inherited properties for variables or supported functions', () => {
    const fn = compileNumericExpression(parseMath('constructor').ast!);
    expect(() => fn({})).toThrow('Unknown variable');
    expect(fn({ constructor: 7 })).toBe(7);
    expect(() => compileNumericExpression(parseMath('constructor(1)').ast!)).toThrow('Unsupported function');
  });
});
