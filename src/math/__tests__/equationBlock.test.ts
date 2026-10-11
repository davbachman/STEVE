import { describe, expect, it, vi } from 'vitest';
import katex from 'katex';
import { analyzeEquationText, analyzeGraphExpression } from '../classifier';
import { blockIdentifierCollector, compileBlockContext, parseEquationBlock } from '../equationBlock';
import { compileTuple3 } from '../evaluator';

describe('local equation definitions', () => {
  it.each([
    ['A = 3*t + t^t\n(A*cos(t), A*sin(t), A)', 'parametric_curve', []],
    ['R = 2 + a*cos(v)\n(R*cos(u), R*sin(u), a*sin(v))', 'parametric_surface', ['a']],
    ['A = x^2 + y^2\nz = sin(A)', 'explicit_surface', []],
    ['A = y^2 + z^2\nx = sin(A)', 'explicit_surface', []],
    ['A = x^2 + z^2\ny = sin(A)', 'explicit_surface', []],
    ['A = x^2 + y^2 + z^2\nA = r^2', 'implicit_surface', ['r']],
    ['A = z^2\nz = A + x', 'implicit_surface', []],
    ['A = u + v\n(A, A, A)', 'parametric_surface', []],
    ['unused = z + q\nA = a*t\nB = A^2\n(B, A, b)', 'parametric_curve', ['a', 'b']],
    ['a = 3\nA = a*t\n(A, t, 0)', 'parametric_curve', []],
  ])('classifies dependencies in %s', (text, kind, parameters) => {
    const result = analyzeEquationText(text);
    expect(result.source.parseStatus).toBe('ok');
    expect(result.inferredKind).toBe(kind);
    expect(result.parameterNames).toEqual(parameters);
  });

  it('resolves aliases in Graph mode and rejects hidden unsupported coordinates', () => {
    const graph = analyzeGraphExpression('A = a*x^2 + y^2\nsin(A)');
    expect(graph.inferredKind).toBe('explicit_surface');
    expect(graph.parameterNames).toEqual(['a']);
    expect(analyzeGraphExpression('A = x^2 + y^2\n-A').inferredKind).toBe('explicit_surface');
    expect(analyzeGraphExpression('A = z^2\nA').inferredKind).toBe('unknown');
    expect(analyzeEquationText('A = x\n(A, t, 0)').inferredKind).toBe('unknown');
  });

  it('supports blank lines, CRLF, and parenthesized multiline expressions', () => {
    const text = '\r\nA = (\r\n  a*t +\r\n  1\r\n)\r\n\r\n(\r\nA,\r\nt,\r\n0\r\n)\r\n';
    const result = analyzeEquationText(text);
    expect(result.source.parseStatus).toBe('ok');
    expect(result.parameterNames).toEqual(['a']);
    expect(result.source.rawText).toBe(text);
  });

  it('retains continuations after operators and equals', () => {
    const result = analyzeEquationText('A =\n  a*t +\n  1\n(A,t,0)');
    expect(result.source.parseStatus).toBe('ok');
    expect(result.inferredKind).toBe('parametric_curve');
  });

  it.each([
    ['A = A + 1\n(A,t,0)', 'itself', 'A +'],
    ['A = B + 1\nB = 2\n(A,t,0)', 'before using', 'B +'],
    ['A = B\nB = A\n(A,t,0)', 'circular', 'B\n'],
    ['A = t\nA = t^2\n(A,t,0)', 'Duplicate', 'A = t^2'],
    ['x = t\n(x,t,0)', 'reserved', 'x ='],
    ['pi = 3\n(pi,t,0)', 'reserved', 'pi ='],
    ['sin = t\n(sin,t,0)', 'reserved', 'sin ='],
    ['A = (t,t,0)\n(A,t,0)', 'scalar', '(t,t,0)'],
    ['A = sin(t=1)\n(A,t,0)', 'scalar', 't=1'],
    ['f(t) = t^2\n(f(t),t,0)', 'scalar definition', 'f(t)'],
    ['A = nope(t)\n(A,t,0)', 'Unsupported function', 'nope(t)'],
    ['A = sin(t,t)\n(A,t,0)', 'expects 1 argument', 'sin(t,t)'],
    ['A = t\nB = t@2\n(A,B,0)', 'Unexpected character', '@'],
  ])('rejects invalid definitions with original source positions: %s', (text, message, location) => {
    const result = parseEquationBlock(text);
    expect(result.status).toBe('error');
    expect(result.ast).toBeUndefined();
    expect(result.diagnostics[0].message).toContain(message);
    expect(result.diagnostics[0].start).toBe(text.indexOf(location));
  });

  it('reports unfinished definitions and plots as partial', () => {
    for (const text of ['A = t\nB = sin(', 'A = t\n(A,', 'A = t\nB = A^2', 'A = a*t\n']) {
      expect(analyzeEquationText(text).source.parseStatus).toBe('partial');
    }
    expect(analyzeGraphExpression('A = x^2\n').source.parseStatus).toBe('partial');
  });

  it('evaluates each reachable definition once per sample and skips unused definitions', () => {
    const parsed = parseEquationBlock('unused = sqrt(-1) + q\nA = sin(t)\nB = A^2\n(B + A, A, B)');
    const prepare = compileBlockContext(parsed.ast!, parsed.definitions);
    const tuple = compileTuple3(parsed.ast!);
    const readT = vi.fn(() => Math.PI / 2);
    expect(tuple(prepare({ get t() { return readT(); } }))).toEqual([2, 1, 1]);
    expect(readT).toHaveBeenCalledTimes(1);
    expect(tuple(prepare({ t: 0 }))).toEqual([0, 0, 0]);
  });

  it('handles repeated dependency chains without expanding expressions', () => {
    const text = ['A0 = a*t', ...Array.from({ length: 40 }, (_, i) => `A${i + 1} = A${i} + A${i}`), '(A40, t, 0)'].join('\n');
    const parsed = parseEquationBlock(text);
    expect([...blockIdentifierCollector(parsed.definitions)(parsed.ast!)].sort()).toEqual(['a', 't']);
    const tuple = compileTuple3(parsed.ast!);
    expect(tuple(compileBlockContext(parsed.ast!, parsed.definitions)({ a: 2, t: 1 }))).toEqual([2 ** 41, 1, 0]);
  });

  it('supports case-sensitive identifiers including names also present on Object.prototype', () => {
    const parsed = parseEquationBlock('__proto__ = a*t\nconstructor = __proto__ + 1\nA = constructor^2\n(A, a, t)');
    const vars = compileBlockContext(parsed.ast!, parsed.definitions)({ a: 2, t: 3 });
    expect(compileTuple3(parsed.ast!)(vars)).toEqual([49, 2, 3]);
    expect(Object.getPrototypeOf(vars)).toBe(Object.prototype);
  });

  it('renders the definitions and final expression as valid aligned LaTeX', () => {
    const latex = analyzeEquationText('R_1 = 2 + cos(v)\n(R_1*cos(u), R_1*sin(u), sin(v))').source.formattedLatex!;
    expect(latex).toContain('\\begin{aligned}');
    expect(latex).toContain('R\\_1 &=');
    expect(() => katex.renderToString(latex, { throwOnError: true })).not.toThrow();
  });
});
