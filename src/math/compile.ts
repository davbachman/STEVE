import type {
  ExplicitSurfaceSpec,
  ImplicitSurfaceSpec,
  ParametricCurveSpec,
  ParametricSurfaceSpec,
  PlotObject,
} from '../types/contracts';
import type { Expression } from './ast';
import { compileNumericExpression, compileTuple3, normalizeEqualityToImplicit } from './evaluator';
import { parseMath } from './parser';

export interface CompiledCurve {
  kind: 'curve';
  spec: ParametricCurveSpec;
  fn: (t: number) => [number, number, number];
}

export interface CompiledSurface {
  kind: 'surface';
  spec: ParametricSurfaceSpec | ExplicitSurfaceSpec;
  fn: (u: number, v: number) => [number, number, number];
}

export interface CompiledImplicit {
  kind: 'implicit';
  spec: ImplicitSurfaceSpec;
  fn: (x: number, y: number, z: number) => number;
}

export type CompiledPlot = CompiledCurve | CompiledSurface | CompiledImplicit;

export function compilePlotObject(plot: PlotObject): CompiledPlot {
  const parsed = parseMath(plot.equation.source.rawText);
  if (!parsed.ast || parsed.status === 'error') {
    throw new Error(parsed.diagnostics[0]?.message ?? 'Invalid equation');
  }

  switch (plot.equation.kind) {
    case 'parametric_curve':
      return {
        kind: 'curve',
        spec: plot.equation,
        fn: compileCurveFunction(plot.equation, parsed.ast),
      };
    case 'parametric_surface':
      return {
        kind: 'surface',
        spec: plot.equation,
        fn: compileParametricSurfaceFunction(plot.equation, parsed.ast),
      };
    case 'explicit_surface':
      return {
        kind: 'surface',
        spec: plot.equation,
        fn: compileExplicitSurfaceFunction(plot.equation, parsed.ast),
      };
    case 'implicit_surface':
      return {
        kind: 'implicit',
        spec: plot.equation,
        fn: compileImplicitSurfaceFunction(plot.equation, parsed.ast),
      };
  }
}

function compileCurveFunction(_spec: ParametricCurveSpec, ast: Expression): (t: number) => [number, number, number] {
  const tuple = compileTuple3(ast);
  return (t) => tuple({ t });
}

function compileParametricSurfaceFunction(
  _spec: ParametricSurfaceSpec,
  ast: Expression,
): (u: number, v: number) => [number, number, number] {
  const tuple = compileTuple3(ast);
  return (u, v) => tuple({ u, v });
}

function compileExplicitSurfaceFunction(
  spec: ExplicitSurfaceSpec,
  ast: Expression,
): (u: number, v: number) => [number, number, number] {
  if (ast.type !== 'equality') {
    throw new Error('Explicit surface must be an equality');
  }
  const rhs = compileNumericExpression(ast.right);
  return (u, v) => {
    const [a1, a2] = spec.domainAxes;
    const vars: Record<string, number> = {
      [a1]: u,
      [a2]: v,
    };
    const solved = rhs(vars);

    if (spec.solvedAxis === 'x') {
      return [solved, vars.y, vars.z];
    }
    if (spec.solvedAxis === 'y') {
      return [vars.x, solved, vars.z];
    }
    return [vars.x, vars.y, solved];
  };
}

function compileImplicitSurfaceFunction(
  _spec: ImplicitSurfaceSpec,
  ast: Expression,
): (x: number, y: number, z: number) => number {
  const normalized = normalizeEqualityToImplicit(ast);
  const scalar = compileNumericExpression(normalized);
  return (x, y, z) => scalar({ x, y, z });
}
