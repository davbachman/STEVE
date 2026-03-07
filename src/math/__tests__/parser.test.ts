import { describe, expect, it } from 'vitest';
import { analyzeEquationText } from '../classifier';
import { parseMath } from '../parser';
import { toLatex } from '../latex';
import { compileNumericExpression } from '../evaluator';

describe('math parser and classifier', () => {
  it('parses a parametric curve tuple', () => {
    const parsed = parseMath('(cos(t), sin(t), t)');
    expect(parsed.status).toBe('ok');
    expect(parsed.ast?.type).toBe('tuple');
  });

  it('parses a parametric surface tuple', () => {
    const parsed = parseMath('(u*cos(v), u*sin(v), v)');
    expect(parsed.status).toBe('ok');
    expect(parsed.ast?.type).toBe('tuple');
  });

  it('classifies explicit z surface', () => {
    const result = analyzeEquationText('z = sin(x*y)');
    expect(result.inferredKind).toBe('explicit_surface');
    expect(result.explicitAxis).toBe('z');
  });

  it('keeps supported kinds when extra constants are present', () => {
    const curve = analyzeEquationText('(a*cos(t), a*sin(t), b*t)');
    expect(curve.inferredKind).toBe('parametric_curve');
    expect(curve.parameterNames).toEqual(['a', 'b']);

    const surface = analyzeEquationText('z = a*sin(b*x) + c*cos(y)');
    expect(surface.inferredKind).toBe('explicit_surface');
    expect(surface.parameterNames).toEqual(['a', 'b', 'c']);

    const implicit = analyzeEquationText('x^2 + y^2 + z^2 = r^2');
    expect(implicit.inferredKind).toBe('implicit_surface');
    expect(implicit.parameterNames).toEqual(['r']);
  });

  it('classifies implicit sphere surface', () => {
    const result = analyzeEquationText('x^2 + y^2 + z^2 = 1');
    expect(result.inferredKind).toBe('implicit_surface');
  });

  it('supports partial parse during typing', () => {
    const result = parseMath('z = sin(');
    expect(result.status).toBe('partial');
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('formats latex from AST', () => {
    const parsed = parseMath('z = sin(x*y)');
    expect(parsed.ast).toBeTruthy();
    expect(toLatex(parsed.ast!)).toContain('\\sin');
  });

  it('evaluates numeric expressions with precedence', () => {
    const parsed = parseMath('2 + 3 * x^2');
    const fn = compileNumericExpression(parsed.ast!);
    expect(fn({ x: 4 })).toBe(50);
  });
});
