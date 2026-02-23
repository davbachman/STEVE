import type { Axis, EquationClassification, ParseClassifyResult } from '../types/contracts';
import { collectIdentifiers, type Expression } from './ast';
import { explicitAxesFor } from './evaluator';
import { toLatex } from './latex';
import { parseMath } from './parser';

const CONSTANT_NAMES = new Set(['pi', 'e']);
const AXES: Axis[] = ['x', 'y', 'z'];

export function analyzeEquationText(rawText: string): ParseClassifyResult {
  const parsed = parseMath(rawText);
  const source = {
    rawText,
    parseStatus: parsed.status,
    parseErrors: parsed.diagnostics,
    formattedLatex: parsed.ast ? safeLatex(parsed.ast) : undefined,
  };

  if (!parsed.ast) {
    return {
      source: {
        ...source,
        classification: { kind: 'unknown', label: 'Unknown' },
      },
      inferredKind: 'unknown',
    };
  }

  const classificationInfo = classifyAst(parsed.ast);
  const classification: EquationClassification = {
    kind: classificationInfo.kind,
    label: classificationInfo.label,
    warning: classificationInfo.warning,
  };

  return {
    source: { ...source, classification },
    inferredKind: classificationInfo.kind,
    explicitAxis: classificationInfo.explicitAxis,
    explicitDomainAxes: classificationInfo.explicitDomainAxes,
    warning: classificationInfo.warning,
  };
}

function safeLatex(ast: Expression): string | undefined {
  try {
    return toLatex(ast);
  } catch {
    return undefined;
  }
}

function classifyAst(ast: Expression): {
  kind: ParseClassifyResult['inferredKind'];
  label: EquationClassification['label'];
  explicitAxis?: Axis;
  explicitDomainAxes?: [Axis, Axis];
  warning?: string;
} {
  if (ast.type === 'tuple' && ast.items.length === 3) {
    const vars = nonConstantNames(collectIdentifiers(ast));
    if (vars.size === 0 || isSubset(vars, ['t'])) {
      return { kind: 'parametric_curve', label: 'Curve' };
    }
    if (isSubset(vars, ['u', 'v'])) {
      return { kind: 'parametric_surface', label: 'Surface' };
    }
    return {
      kind: 'unknown',
      label: 'Unknown',
      warning: '3-tuple uses unsupported variable set. Use t or (u,v).',
    };
  }

  if (ast.type === 'equality') {
    if (ast.left.type === 'identifier' && AXES.includes(ast.left.name as Axis)) {
      const axis = ast.left.name as Axis;
      const domainAxes = explicitAxesFor(axis);
      const rhsVars = nonConstantNames(collectIdentifiers(ast.right));
      if (isSubset(rhsVars, domainAxes)) {
        return {
          kind: 'explicit_surface',
          label: 'Explicit->Parametric',
          explicitAxis: axis,
          explicitDomainAxes: domainAxes,
        };
      }
    }

    const vars = nonConstantNames(collectIdentifiers(ast));
    if ([...vars].some((v) => AXES.includes(v as Axis))) {
      return { kind: 'implicit_surface', label: 'Implicit' };
    }

    return {
      kind: 'unknown',
      label: 'Unknown',
      warning: 'Equation does not reference x/y/z for an implicit surface.',
    };
  }

  return {
    kind: 'unknown',
    label: 'Unknown',
    warning: 'Expected a 3-tuple or equality expression.',
  };
}

function nonConstantNames(names: Set<string>): Set<string> {
  const filtered = new Set<string>();
  for (const name of names) {
    if (!CONSTANT_NAMES.has(name)) {
      filtered.add(name);
    }
  }
  return filtered;
}

function isSubset(values: Set<string>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  for (const value of values) {
    if (!allowedSet.has(value)) {
      return false;
    }
  }
  return true;
}
