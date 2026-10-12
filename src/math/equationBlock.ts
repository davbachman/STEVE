import type { ParseDiagnostic } from '../types/contracts';
import { collectIdentifiers, type Expression, type IdentifierExpression } from './ast';
import { compileNumericExpression, supportedConstantNames, supportedFunctionNames, type EvalContext } from './evaluator';
import { toLatex } from './latex';
import { parseMath, type ParseResult } from './parser';

export interface EquationDefinition {
  name: IdentifierExpression;
  value: Expression;
}

export interface EquationBlockResult extends ParseResult {
  definitions: EquationDefinition[];
}

const reservedNames = new Set([
  'x', 'y', 'z', 't', 'u', 'v', ...supportedConstantNames, ...supportedFunctionNames,
]);

/** Split statements at top-level newlines; parentheses and trailing operators allow wrapping. */
export function equationStatements(input: string): Array<{ text: string; start: number }> {
  const statements: Array<{ text: string; start: number }> = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i <= input.length; i += 1) {
    const ch = input[i];
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (i !== input.length && (ch !== '\n' || depth !== 0)) continue;
    const text = input.slice(start, i);
    if (i !== input.length && /[=+\-*/^,]\s*$/.test(text)) continue;
    if (text.trim()) statements.push({ text, start });
    start = i + 1;
  }
  return statements;
}

/** Definitions are local scalars. The last statement is always the plot expression. */
export function parseEquationBlock(input: string): EquationBlockResult {
  const statements = equationStatements(input);
  const definitions: EquationDefinition[] = [];
  const expressions: Expression[] = [];
  for (const statement of statements) {
    const parsed = parseMath(statement.text, statement.start);
    if (!parsed.ast) return { ...parsed, definitions };
    expressions.push(parsed.ast);
  }
  const ast = expressions.pop();
  if (!ast) return { ...parseMath(input), definitions };

  const fail = (node: Expression, message: string): EquationBlockResult => ({
    definitions,
    status: 'error',
    diagnostics: [{ message, start: node.start, end: node.end, severity: 'error' }],
  });
  const declared = new Set<string>();
  for (const expression of expressions) {
    if (expression.type !== 'equality' || expression.left.type !== 'identifier') {
      return fail(expression, 'Before the final plot, use a scalar definition such as A = sin(t).');
    }
    const name = expression.left;
    if (reservedNames.has(name.name)) return fail(name, `'${name.name}' is reserved and cannot be defined.`);
    if (declared.has(name.name)) return fail(name, `Duplicate definition '${name.name}'.`);
    const diagnostic = scalarDiagnostic(expression.right);
    if (diagnostic) return { definitions, status: 'error', diagnostics: [diagnostic] };
    declared.add(name.name);
    definitions.push({ name, value: expression.right });
  }

  // Know every declaration before checking references so a later local is never mistaken for a slider.
  const available = new Set<string>();
  for (const definition of definitions) {
    const invalid = findIdentifier(definition.value, (name) => declared.has(name) && !available.has(name));
    if (invalid) {
      return fail(invalid, invalid.name === definition.name.name
        ? `Definition '${invalid.name}' cannot reference itself.`
        : `Define '${invalid.name}' before using it; forward or circular references are not supported.`);
    }
    available.add(definition.name.name);
  }
  return { ast, definitions, status: 'ok', diagnostics: [] };
}

function scalarDiagnostic(expr: Expression): ParseDiagnostic | undefined {
  const fail = (message: string): ParseDiagnostic => ({
    message, start: expr.start, end: expr.end, severity: 'error',
  });
  switch (expr.type) {
    case 'tuple':
    case 'equality':
      return fail('Definitions must contain a scalar expression, not a tuple or equation.');
    case 'call':
      if (!supportedFunctionNames.includes(expr.callee.name)) return fail(`Unsupported function: ${expr.callee.name}`);
      if (expr.args.length !== 1) return fail(`Function ${expr.callee.name} expects 1 argument`);
      return scalarDiagnostic(expr.args[0]);
    case 'unary':
      return scalarDiagnostic(expr.argument);
    case 'binary':
      return scalarDiagnostic(expr.left) ?? scalarDiagnostic(expr.right);
    default:
      return undefined;
  }
}

function findIdentifier(expr: Expression, predicate: (name: string) => boolean): IdentifierExpression | undefined {
  switch (expr.type) {
    case 'identifier': return predicate(expr.name) ? expr : undefined;
    case 'unary': return findIdentifier(expr.argument, predicate);
    case 'binary':
    case 'equality': return findIdentifier(expr.left, predicate) ?? findIdentifier(expr.right, predicate);
    case 'call':
    case 'tuple': {
      for (const child of expr.type === 'call' ? expr.args : expr.items) {
        const found = findIdentifier(child, predicate);
        if (found) return found;
      }
      return undefined;
    }
    default: return undefined;
  }
}

/** Resolve variable dependencies without expanding repeated expressions into a larger tree. */
export function blockIdentifierCollector(definitions: readonly EquationDefinition[]): (expr: Expression) => Set<string> {
  const dependencies = new Map<string, Set<string>>();
  const collect = (expr: Expression): Set<string> => {
    const names = new Set<string>();
    for (const name of collectIdentifiers(expr)) {
      for (const dependency of dependencies.get(name) ?? [name]) names.add(dependency);
    }
    return names;
  };
  for (const definition of definitions) dependencies.set(definition.name.name, collect(definition.value));
  return collect;
}

/** Compute only definitions reachable from the plot, once each per sample in its reusable context. */
export function compileBlockContext(ast: Expression, definitions: readonly EquationDefinition[]): (vars: EvalContext) => EvalContext {
  const needed = collectIdentifiers(ast);
  const active: EquationDefinition[] = [];
  for (let i = definitions.length - 1; i >= 0; i -= 1) {
    const definition = definitions[i];
    if (!needed.has(definition.name.name)) continue;
    active.push(definition);
    collectIdentifiers(definition.value, needed);
  }
  const steps = active.reverse().map(({ name, value }) => ({ name: name.name, fn: compileNumericExpression(value) }));
  return (vars) => {
    for (const { name, fn } of steps) {
      const value = fn(vars);
      // __proto__ is a valid math identifier, not a request to alter the context prototype.
      if (name === '__proto__') Object.defineProperty(vars, name, { value, writable: true, enumerable: true, configurable: true });
      else vars[name] = value;
    }
    return vars;
  };
}

export function equationBlockLatex(ast: Expression, definitions: readonly EquationDefinition[]): string {
  if (!definitions.length) return toLatex(ast);
  const rows = definitions.map(({ name, value }) => `${toLatex(name)} &= ${toLatex(value)}`);
  rows.push(`& ${toLatex(ast)}`);
  return `\\begin{aligned}${rows.join(' \\\\ ')}\\end{aligned}`;
}
