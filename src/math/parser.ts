import type { ParseDiagnostic } from '../types/contracts';
import type {
  BinaryExpression,
  CallExpression,
  EqualityExpression,
  Expression,
  IdentifierExpression,
  NumberLiteral,
  TupleExpression,
  UnaryExpression,
} from './ast';
import { tokenize, type Token } from './tokenizer';

export interface ParseResult {
  ast?: Expression;
  status: 'ok' | 'partial' | 'error';
  diagnostics: ParseDiagnostic[];
}

class ParseFailure extends Error {
  constructor(
    message: string,
    public readonly token: Token,
    public readonly partial: boolean,
  ) {
    super(message);
  }
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Expression {
    const expr = this.parseEquality();
    if (!this.is('eof')) {
      throw new ParseFailure(`Unexpected token '${this.peek().text}'`, this.peek(), false);
    }
    return expr;
  }

  private parseEquality(): Expression {
    let left = this.parseAddSub();
    if (this.match('equals')) {
      const eq = this.prev();
      const right = this.parseAddSub();
      const node: EqualityExpression = {
        type: 'equality',
        left,
        right,
        start: left.start,
        end: right.end || eq.end,
      };
      left = node;
    }
    return left;
  }

  private parseAddSub(): Expression {
    let expr = this.parseMulDiv();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.advance();
      const right = this.parseMulDiv();
      const node: BinaryExpression = {
        type: 'binary',
        operator: op.text as BinaryExpression['operator'],
        left: expr,
        right,
        start: expr.start,
        end: right.end,
      };
      expr = node;
    }
    return expr;
  }

  private parseMulDiv(): Expression {
    let expr = this.parsePow();
    while (this.isOp('*') || this.isOp('/')) {
      const op = this.advance();
      const right = this.parsePow();
      const node: BinaryExpression = {
        type: 'binary',
        operator: op.text as BinaryExpression['operator'],
        left: expr,
        right,
        start: expr.start,
        end: right.end,
      };
      expr = node;
    }
    return expr;
  }

  private parsePow(): Expression {
    let left = this.parseUnary();
    if (this.isOp('^')) {
      const op = this.advance();
      const right = this.parsePow();
      const node: BinaryExpression = {
        type: 'binary',
        operator: op.text as BinaryExpression['operator'],
        left,
        right,
        start: left.start,
        end: right.end,
      };
      left = node;
    }
    return left;
  }

  private parseUnary(): Expression {
    if (this.isOp('+') || this.isOp('-')) {
      const op = this.advance();
      const argument = this.parseUnary();
      const node: UnaryExpression = {
        type: 'unary',
        operator: op.text as UnaryExpression['operator'],
        argument,
        start: op.start,
        end: argument.end,
      };
      return node;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expression {
    const token = this.peek();

    if (token.type === 'number') {
      this.advance();
      const node: NumberLiteral = {
        type: 'number',
        value: Number(token.text),
        raw: token.text,
        start: token.start,
        end: token.end,
      };
      return node;
    }

    if (token.type === 'identifier') {
      this.advance();
      const ident: IdentifierExpression = {
        type: 'identifier',
        name: token.text,
        start: token.start,
        end: token.end,
      };
      if (this.match('lparen')) {
        const open = this.prev();
        const args: Expression[] = [];
        if (!this.is('rparen')) {
          do {
            args.push(this.parseEquality());
          } while (this.match('comma'));
        }
        const close = this.expect('rparen');
        const node: CallExpression = {
          type: 'call',
          callee: ident,
          args,
          start: ident.start,
          end: close.end,
        };
        if (close.start < open.end) {
          node.end = open.end;
        }
        return node;
      }
      return ident;
    }

    if (this.match('lparen')) {
      const open = this.prev();
      if (this.is('rparen')) {
        throw new ParseFailure('Empty parentheses are not supported', this.peek(), false);
      }
      const first = this.parseEquality();
      if (this.match('comma')) {
        const items = [first];
        do {
          items.push(this.parseEquality());
        } while (this.match('comma'));
        const close = this.expect('rparen');
        const node: TupleExpression = {
          type: 'tuple',
          items,
          start: open.start,
          end: close.end,
        };
        return node;
      }
      const close = this.expect('rparen');
      return { ...first, start: open.start, end: close.end };
    }

    if (token.type === 'eof') {
      throw new ParseFailure('Unexpected end of input', token, true);
    }

    throw new ParseFailure(`Unexpected token '${token.text}'`, token, false);
  }

  private expect(type: Token['type']): Token {
    if (this.is(type)) {
      return this.advance();
    }
    const token = this.peek();
    throw new ParseFailure(
      token.type === 'eof' ? 'Unexpected end of input' : `Expected ${type} but found '${token.text}'`,
      token,
      token.type === 'eof',
    );
  }

  private match(type: Token['type']): boolean {
    if (!this.is(type)) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private is(type: Token['type']): boolean {
    return this.peek().type === type;
  }

  private isOp(op: string): boolean {
    const token = this.peek();
    return token.type === 'operator' && token.text === op;
  }

  private advance(): Token {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }

  private peek(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1];
  }

  private prev(): Token {
    return this.tokens[Math.max(0, this.index - 1)];
  }
}

export function parseMath(input: string): ParseResult {
  if (!input.trim()) {
    return {
      status: 'partial',
      diagnostics: [{ message: 'Enter an equation', start: 0, end: 0, severity: 'warning' }],
    };
  }

  try {
    const tokens = tokenize(input);
    const parser = new Parser(tokens);
    const ast = parser.parse();
    return { ast, status: 'ok', diagnostics: [] };
  } catch (error) {
    if (error instanceof ParseFailure) {
      return {
        status: error.partial ? 'partial' : 'error',
        diagnostics: [
          {
            message: error.message,
            start: error.token.start,
            end: error.token.end,
            severity: error.partial ? 'warning' : 'error',
          },
        ],
      };
    }
    if (error instanceof Error) {
      return {
        status: 'error',
        diagnostics: [{ message: error.message, start: 0, end: 0, severity: 'error' }],
      };
    }
    return {
      status: 'error',
      diagnostics: [{ message: 'Unknown parser error', start: 0, end: 0, severity: 'error' }],
    };
  }
}
