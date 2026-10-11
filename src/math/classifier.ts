import type { Axis, EquationClassification, ParseClassifyResult } from '../types/contracts';
import type { Expression } from './ast';
import { explicitAxesFor } from './evaluator';
import { blockIdentifierCollector, equationBlockLatex, parseEquationBlock, type EquationDefinition } from './equationBlock';

const CONSTANT_NAMES = new Set(['pi', 'e']);
const AXES: Axis[] = ['x', 'y', 'z'];

export function analyzeEquationText(rawText: string): ParseClassifyResult {
  return analyzeText(rawText, classifyAst);
}

export function analyzeGraphExpression(rawText: string): ParseClassifyResult {
  return analyzeText(rawText, classifyGraphAst);
}

type ClassificationInfo = {
  kind: ParseClassifyResult['inferredKind'];
  label: EquationClassification['label'];
  parameterNames: string[];
  explicitAxis?: Axis;
  explicitDomainAxes?: [Axis, Axis];
  warning?: string;
};

function analyzeText(
  rawText: string,
  classify: (ast: Expression, collect: (expr: Expression) => Set<string>) => ClassificationInfo,
): ParseClassifyResult {
  const parsed = parseEquationBlock(rawText);
  const source = {
    rawText,
    parseStatus: parsed.status,
    parseErrors: parsed.diagnostics,
    formattedLatex: parsed.ast ? safeLatex(parsed.ast, parsed.definitions) : undefined,
  };

  if (!parsed.ast) {
    return {
      source: {
        ...source,
        classification: { kind: 'unknown', label: 'Unknown' },
      },
      inferredKind: 'unknown',
      parameterNames: [],
    };
  }

  const collect = blockIdentifierCollector(parsed.definitions);
  const classificationInfo = classify(parsed.ast, collect);
  if (classificationInfo.kind === 'unknown' && parsed.ast.type === 'equality'
    && parsed.ast.left.type === 'identifier' && !['x', 'y', 'z'].includes(parsed.ast.left.name)
    && (pickNames(collect(parsed.ast), AXES).size === 0 || classify === classifyGraphAst)) {
    source.parseStatus = 'partial';
    source.parseErrors = [{
      message: 'Add a final plot expression after the definitions.',
      start: parsed.ast.end, end: parsed.ast.end, severity: 'warning',
    }];
  }
  const classification: EquationClassification = {
    kind: classificationInfo.kind,
    label: classificationInfo.label,
    warning: classificationInfo.warning,
  };

  return {
    source: { ...source, classification },
    inferredKind: classificationInfo.kind,
    parameterNames: classificationInfo.parameterNames,
    explicitAxis: classificationInfo.explicitAxis,
    explicitDomainAxes: classificationInfo.explicitDomainAxes,
    warning: classificationInfo.warning,
  };
}

function safeLatex(ast: Expression, definitions: EquationDefinition[]): string | undefined {
  try {
    return equationBlockLatex(ast, definitions);
  } catch {
    return undefined;
  }
}

function classifyAst(ast: Expression, collectIdentifiers: (expr: Expression) => Set<string>): ClassificationInfo {
  const identifiers = nonConstantNames(collectIdentifiers(ast));

  if (ast.type === 'tuple' && ast.items.length === 3) {
    const reservedVars = pickNames(identifiers, ['x', 'y', 'z', 't', 'u', 'v']);
    if (reservedVars.size === 0 || isSubset(reservedVars, ['t'])) {
      return {
        kind: 'parametric_curve',
        label: 'Curve',
        parameterNames: orderedNames(excludeNames(identifiers, ['t'])),
      };
    }
    if (isSubset(reservedVars, ['u', 'v'])) {
      return {
        kind: 'parametric_surface',
        label: 'Surface',
        parameterNames: orderedNames(excludeNames(identifiers, ['u', 'v'])),
      };
    }
    return {
      kind: 'unknown',
      label: 'Unknown',
      parameterNames: [],
      warning: '3-tuple uses unsupported variable set. Use t or (u,v).',
    };
  }

  if (ast.type === 'equality') {
    if (ast.left.type === 'identifier' && AXES.includes(ast.left.name as Axis)) {
      const axis = ast.left.name as Axis;
      const domainAxes = explicitAxesFor(axis);
      const rhsVars = pickNames(nonConstantNames(collectIdentifiers(ast.right)), ['x', 'y', 'z', 't', 'u', 'v']);
      if (isSubset(rhsVars, domainAxes)) {
        return {
          kind: 'explicit_surface',
          label: 'Explicit->Parametric',
          parameterNames: orderedNames(excludeNames(identifiers, [axis, ...domainAxes])),
          explicitAxis: axis,
          explicitDomainAxes: domainAxes,
        };
      }
    }

    const vars = pickNames(identifiers, AXES);
    if ([...vars].some((v) => AXES.includes(v as Axis))) {
      return {
        kind: 'implicit_surface',
        label: 'Implicit',
        parameterNames: orderedNames(excludeNames(identifiers, AXES)),
      };
    }

    return {
      kind: 'unknown',
      label: 'Unknown',
      parameterNames: [],
      warning: 'Equation does not reference x/y/z for an implicit surface.',
    };
  }

  return {
    kind: 'unknown',
    label: 'Unknown',
    parameterNames: [],
    warning: 'Expected a 3-tuple or equality expression.',
  };
}

function classifyGraphAst(ast: Expression, collectIdentifiers: (expr: Expression) => Set<string>): ClassificationInfo {
  const identifiers = nonConstantNames(collectIdentifiers(ast));
  const reservedVars = pickNames(identifiers, ['x', 'y', 'z', 't', 'u', 'v']);
  if (ast.type === 'equality' || ast.type === 'tuple' || !isSubset(reservedVars, ['x', 'y'])) {
    return {
      kind: 'unknown',
      label: 'Unknown',
      parameterNames: [],
      warning: 'Enter a function of x and y only; Graph objects supply z = automatically.',
    };
  }
  return {
    kind: 'explicit_surface',
    label: 'Graph',
    parameterNames: orderedNames(excludeNames(identifiers, ['x', 'y'])),
    explicitAxis: 'z',
    explicitDomainAxes: ['x', 'y'],
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

function pickNames(values: Set<string>, allowed: readonly string[]): Set<string> {
  const allowedSet = new Set(allowed);
  const picked = new Set<string>();
  for (const value of values) {
    if (allowedSet.has(value)) {
      picked.add(value);
    }
  }
  return picked;
}

function excludeNames(values: Set<string>, disallowed: readonly string[]): Set<string> {
  const disallowedSet = new Set(disallowed);
  const picked = new Set<string>();
  for (const value of values) {
    if (!disallowedSet.has(value)) {
      picked.add(value);
    }
  }
  return picked;
}

function orderedNames(values: Set<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}
