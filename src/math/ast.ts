export type Expression =
  | NumberLiteral
  | IdentifierExpression
  | UnaryExpression
  | BinaryExpression
  | CallExpression
  | TupleExpression
  | EqualityExpression;

export interface BaseNode {
  start: number;
  end: number;
}

export interface NumberLiteral extends BaseNode {
  type: 'number';
  value: number;
  raw: string;
}

export interface IdentifierExpression extends BaseNode {
  type: 'identifier';
  name: string;
}

export interface UnaryExpression extends BaseNode {
  type: 'unary';
  operator: '+' | '-';
  argument: Expression;
}

export interface BinaryExpression extends BaseNode {
  type: 'binary';
  operator: '+' | '-' | '*' | '/' | '^';
  left: Expression;
  right: Expression;
}

export interface CallExpression extends BaseNode {
  type: 'call';
  callee: IdentifierExpression;
  args: Expression[];
}

export interface TupleExpression extends BaseNode {
  type: 'tuple';
  items: Expression[];
}

export interface EqualityExpression extends BaseNode {
  type: 'equality';
  left: Expression;
  right: Expression;
}

export function collectIdentifiers(expr: Expression, names = new Set<string>()): Set<string> {
  switch (expr.type) {
    case 'identifier':
      names.add(expr.name);
      return names;
    case 'number':
      return names;
    case 'unary':
      return collectIdentifiers(expr.argument, names);
    case 'binary':
      collectIdentifiers(expr.left, names);
      collectIdentifiers(expr.right, names);
      return names;
    case 'call':
      for (const arg of expr.args) {
        collectIdentifiers(arg, names);
      }
      return names;
    case 'tuple':
      for (const item of expr.items) {
        collectIdentifiers(item, names);
      }
      return names;
    case 'equality':
      collectIdentifiers(expr.left, names);
      collectIdentifiers(expr.right, names);
      return names;
  }
}
