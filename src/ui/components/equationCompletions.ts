import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { supportedConstantNames, supportedFunctionNames } from '../../math/evaluator';
import { equationStatements } from '../../math/equationBlock';
import { parseMath } from '../../math/parser';

const FUNCTION_DETAILS: Record<string, string> = {
  log: 'log base 10',
  ln: 'natural log',
  asin: 'inverse sine',
  acos: 'inverse cosine',
  atan: 'inverse tangent',
};

const MATH_COMPLETIONS = [
  ...supportedFunctionNames.map((name) => ({
    label: name,
    type: 'function',
    apply: `${name}(`,
    detail: FUNCTION_DETAILS[name],
  })),
  ...supportedConstantNames.map((name) => ({ label: name, type: 'constant' })),
];

export function mathCompletionSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_]*$/)
    ?? (context.explicit ? { from: context.pos, to: context.pos } : null);
  if (!word || (word.from === word.to && !context.explicit)) {
    return null;
  }
  const beforeLine = context.state.doc.sliceString(0, context.state.doc.lineAt(context.pos).from);
  const localNames = new Set<string>();
  for (const statement of equationStatements(beforeLine)) {
    const ast = parseMath(statement.text).ast;
    if (ast?.type === 'equality' && ast.left.type === 'identifier'
      && !['x', 'y', 'z', 't', 'u', 'v', ...supportedConstantNames, ...supportedFunctionNames].includes(ast.left.name)) {
      localNames.add(ast.left.name);
    }
  }
  return {
    from: word.from,
    options: [...MATH_COMPLETIONS, ...[...localNames].map((label) => ({ label, type: 'variable', detail: 'local definition' }))],
    validFor: /^(?:[A-Za-z_][A-Za-z0-9_]*)?$/,
  };
}

