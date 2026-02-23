import type { Axis } from '../types/contracts';
import type { BinaryExpression, Expression } from './ast';

export interface EvalContext {
  [name: string]: number;
}

export type CompiledNumericFn = (vars: EvalContext) => number;

const constants: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

const unaryFns: Record<string, (x: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  exp: Math.exp,
  log: Math.log10,
  ln: Math.log,
  sqrt: Math.sqrt,
  abs: Math.abs,
};

export function compileNumericExpression(expr: Expression): CompiledNumericFn {
  return (vars) => evaluateNumericExpression(expr, vars);
}

export function evaluateNumericExpression(expr: Expression, vars: EvalContext): number {
  switch (expr.type) {
    case 'number':
      return expr.value;
    case 'identifier': {
      if (expr.name in vars) {
        return vars[expr.name] as number;
      }
      if (expr.name in constants) {
        return constants[expr.name] as number;
      }
      throw new Error(`Unknown variable or constant: ${expr.name}`);
    }
    case 'unary': {
      const value = evaluateNumericExpression(expr.argument, vars);
      return expr.operator === '-' ? -value : value;
    }
    case 'binary':
      return evalBinary(expr, vars);
    case 'call': {
      const fn = unaryFns[expr.callee.name];
      if (!fn) {
        throw new Error(`Unsupported function: ${expr.callee.name}`);
      }
      if (expr.args.length !== 1) {
        throw new Error(`Function ${expr.callee.name} expects 1 argument`);
      }
      return fn(evaluateNumericExpression(expr.args[0], vars));
    }
    case 'tuple':
      throw new Error('Tuple cannot be evaluated as a scalar');
    case 'equality':
      throw new Error('Equality cannot be evaluated as a scalar');
  }
}

function evalBinary(expr: BinaryExpression, vars: EvalContext): number {
  const left = evaluateNumericExpression(expr.left, vars);
  const right = evaluateNumericExpression(expr.right, vars);
  switch (expr.operator) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      return left / right;
    case '^':
      return left ** right;
  }
}

export function compileTuple3(expr: Expression): (vars: EvalContext) => [number, number, number] {
  if (expr.type !== 'tuple' || expr.items.length !== 3) {
    throw new Error('Expected a 3-tuple expression');
  }
  const fns = expr.items.map(compileNumericExpression);
  return (vars) => [fns[0](vars), fns[1](vars), fns[2](vars)];
}

export function normalizeEqualityToImplicit(expr: Expression): Expression {
  if (expr.type !== 'equality') {
    return expr;
  }
  return {
    type: 'binary',
    operator: '-',
    left: expr.left,
    right: expr.right,
    start: expr.left.start,
    end: expr.right.end,
  };
}

export function estimateGradient(
  fn: (vars: EvalContext) => number,
  p: { x: number; y: number; z: number },
  eps = 1e-3,
): [number, number, number] {
  const base = { x: p.x, y: p.y, z: p.z };
  const fx1 = fn({ ...base, x: p.x + eps });
  const fx0 = fn({ ...base, x: p.x - eps });
  const fy1 = fn({ ...base, y: p.y + eps });
  const fy0 = fn({ ...base, y: p.y - eps });
  const fz1 = fn({ ...base, z: p.z + eps });
  const fz0 = fn({ ...base, z: p.z - eps });
  return [(fx1 - fx0) / (2 * eps), (fy1 - fy0) / (2 * eps), (fz1 - fz0) / (2 * eps)];
}

export function explicitAxesFor(axis: Axis): [Axis, Axis] {
  if (axis === 'x') return ['y', 'z'];
  if (axis === 'y') return ['x', 'z'];
  return ['x', 'y'];
}
