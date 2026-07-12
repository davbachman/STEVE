import { compileNumericExpression } from './evaluator';
import { parseMath } from './parser';

/** Evaluate a scalar, variable-free math expression entered in a numeric UI field. */
export function evaluateNumericInputExpression(raw: string): number | null {
  const input = raw.trim();
  if (!input) return null;

  const parsed = parseMath(input);
  if (parsed.status !== 'ok' || !parsed.ast) return null;

  try {
    const value = compileNumericExpression(parsed.ast)({});
    if (!Number.isFinite(value)) return null;
    if (Math.abs(value) < 1e-14) return 0;
    return Number(value.toPrecision(15));
  } catch {
    return null;
  }
}
