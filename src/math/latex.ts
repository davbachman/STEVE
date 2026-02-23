import type { Expression } from './ast';

const functionLatexMap: Record<string, string> = {
  sin: '\\sin',
  cos: '\\cos',
  tan: '\\tan',
  asin: '\\arcsin',
  acos: '\\arccos',
  atan: '\\arctan',
  sinh: '\\sinh',
  cosh: '\\cosh',
  tanh: '\\tanh',
  exp: '\\exp',
  log: '\\log',
  ln: '\\ln',
  sqrt: '\\sqrt',
  abs: '\\left|',
};

const precedence: Record<string, number> = {
  equality: 0,
  '+': 1,
  '-': 1,
  '*': 2,
  '/': 2,
  '^': 3,
  unary: 4,
  atom: 5,
};

export function toLatex(expr: Expression): string {
  return format(expr, 0);
}

function format(expr: Expression, parentPrec: number): string {
  switch (expr.type) {
    case 'number':
      return expr.raw;
    case 'identifier':
      return escapeIdentifier(expr.name);
    case 'unary': {
      const prec = precedence.unary;
      const text = `${expr.operator}${format(expr.argument, prec)}`;
      return parenthesize(text, prec, parentPrec);
    }
    case 'binary': {
      if (expr.operator === '/') {
        return `\\frac{${format(expr.left, 0)}}{${format(expr.right, 0)}}`;
      }
      if (expr.operator === '^') {
        const base = format(expr.left, precedence['^']);
        const exponent = format(expr.right, 0);
        return `${base}^{${exponent}}`;
      }
      const prec = precedence[expr.operator];
      const op = expr.operator === '*' ? ' \\cdot ' : ` ${expr.operator} `;
      const text = `${format(expr.left, prec)}${op}${format(expr.right, prec + (expr.operator === '-' ? 1 : 0))}`;
      return parenthesize(text, prec, parentPrec);
    }
    case 'call': {
      const fnName = functionLatexMap[expr.callee.name] ?? `\\operatorname{${escapeIdentifier(expr.callee.name)}}`;
      if (expr.callee.name === 'sqrt' && expr.args.length === 1) {
        return `\\sqrt{${format(expr.args[0], 0)}}`;
      }
      if (expr.callee.name === 'abs' && expr.args.length === 1) {
        return `\\left|${format(expr.args[0], 0)}\\right|`;
      }
      const args = expr.args.map((arg) => format(arg, 0)).join(', ');
      return `${fnName}\\left(${args}\\right)`;
    }
    case 'tuple':
      return `\\left(${expr.items.map((item) => format(item, 0)).join(', ')}\\right)`;
    case 'equality':
      return `${format(expr.left, precedence.equality)} = ${format(expr.right, precedence.equality)}`;
  }
}

function parenthesize(text: string, myPrec: number, parentPrec: number): string {
  if (myPrec < parentPrec) {
    return `\\left(${text}\\right)`;
  }
  return text;
}

function escapeIdentifier(name: string): string {
  if (name === 'pi') {
    return '\\pi';
  }
  return name.replace(/_/g, '\\_');
}
