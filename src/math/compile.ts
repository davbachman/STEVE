import type {
  EquationSpec,
  ExplicitSurfaceSpec,
  ImplicitSurfaceSpec,
  ParametricCurveSpec,
  ParametricSurfaceSpec,
  PlotObject,
} from '../types/contracts';
import type { Expression } from './ast';
import { compileNumericExpression, compileTuple3, normalizeEqualityToImplicit } from './evaluator';
import { applyEquationParameterContext, equationParameterContext, equationParameterValueContexts } from './parameters';
import { compileBlockContext, parseEquationBlock } from './equationBlock';

type PrepareContext = ReturnType<typeof compileBlockContext>;

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
  return compileEquationSpec(plot.equation);
}

export function compileEquationSpec(spec: EquationSpec): CompiledPlot {
  const parsed = parseEquationBlock(spec.source.rawText);
  if (!parsed.ast || parsed.status === 'error') {
    throw new Error(parsed.diagnostics[0]?.message ?? 'Invalid equation');
  }

  const prepareContext = compileBlockContext(parsed.ast, parsed.definitions);
  switch (spec.kind) {
    case 'parametric_curve':
      return {
        kind: 'curve',
        spec,
        fn: compileCurveFunction(spec, parsed.ast, prepareContext),
      };
    case 'parametric_surface':
      return {
        kind: 'surface',
        spec,
        fn: compileParametricSurfaceFunction(spec, parsed.ast, prepareContext),
      };
    case 'explicit_surface':
      return {
        kind: 'surface',
        spec,
        fn: compileExplicitSurfaceFunction(spec, parsed.ast, prepareContext),
      };
    case 'implicit_surface':
      return {
        kind: 'implicit',
        spec,
        fn: compileImplicitSurfaceFunction(spec, parsed.ast, prepareContext),
      };
  }
}

export function expandEquationSpecVariants(spec: EquationSpec): EquationSpec[] {
  const contexts = equationParameterValueContexts(spec.parameters);
  return contexts.map((context) => ({
    ...spec,
    parameters: applyEquationParameterContext(spec.parameters, context),
  }));
}

function compileCurveFunction(_spec: ParametricCurveSpec, ast: Expression, prepareContext: PrepareContext): (t: number) => [number, number, number] {
  const tuple = compileTuple3(ast);
  const parameterVars = equationParameterContext(_spec.parameters);
  return (t) => tuple(prepareContext({ ...parameterVars, t }));
}

function compileParametricSurfaceFunction(
  _spec: ParametricSurfaceSpec,
  ast: Expression,
  prepareContext: PrepareContext,
): (u: number, v: number) => [number, number, number] {
  const tuple = compileTuple3(ast);
  const parameterVars = equationParameterContext(_spec.parameters);
  return (u, v) => tuple(prepareContext({ ...parameterVars, u, v }));
}

function compileExplicitSurfaceFunction(
  spec: ExplicitSurfaceSpec,
  ast: Expression,
  prepareContext: PrepareContext,
): (u: number, v: number) => [number, number, number] {
  if (!spec.graphExpression && ast.type !== 'equality') {
    throw new Error('Explicit surface must be an equality');
  }
  if (spec.graphExpression && (ast.type === 'equality' || ast.type === 'tuple')) {
    throw new Error('Graph must be a function expression');
  }
  const expression = spec.graphExpression ? ast : ast.type === 'equality' ? ast.right : ast;
  const rhs = compileNumericExpression(expression);
  const parameterVars = equationParameterContext(spec.parameters);
  return (u, v) => {
    const [a1, a2] = spec.domainAxes;
    const vars: Record<string, number> = {
      ...parameterVars,
      [a1]: u,
      [a2]: v,
    };
    const solved = rhs(prepareContext(vars));

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
  spec: ImplicitSurfaceSpec,
  ast: Expression,
  prepareContext: PrepareContext,
): (x: number, y: number, z: number) => number {
  const normalized = normalizeEqualityToImplicit(ast);
  const scalar = compileNumericExpression(normalized);
  const parameterVars = equationParameterContext(spec.parameters);
  return (x, y, z) => scalar(prepareContext({ ...parameterVars, x, y, z }));
}
