export type TokenType = 'number' | 'identifier' | 'operator' | 'lparen' | 'rparen' | 'comma' | 'equals' | 'eof';

export interface Token {
  type: TokenType;
  text: string;
  start: number;
  end: number;
}

const numberPattern = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const identPattern = /^[A-Za-z_][A-Za-z0-9_]*/;

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const ch = input[index];

    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }

    if (ch === '(') {
      tokens.push({ type: 'lparen', text: ch, start: index, end: index + 1 });
      index += 1;
      continue;
    }

    if (ch === ')') {
      tokens.push({ type: 'rparen', text: ch, start: index, end: index + 1 });
      index += 1;
      continue;
    }

    if (ch === ',') {
      tokens.push({ type: 'comma', text: ch, start: index, end: index + 1 });
      index += 1;
      continue;
    }

    if (ch === '=') {
      tokens.push({ type: 'equals', text: ch, start: index, end: index + 1 });
      index += 1;
      continue;
    }

    if ('+-*/^'.includes(ch)) {
      tokens.push({ type: 'operator', text: ch, start: index, end: index + 1 });
      index += 1;
      continue;
    }

    const slice = input.slice(index);
    const numberMatch = slice.match(numberPattern);
    if (numberMatch) {
      const text = numberMatch[0];
      tokens.push({ type: 'number', text, start: index, end: index + text.length });
      index += text.length;
      continue;
    }

    const identMatch = slice.match(identPattern);
    if (identMatch) {
      const text = identMatch[0];
      tokens.push({ type: 'identifier', text, start: index, end: index + text.length });
      index += text.length;
      continue;
    }

    throw new Error(`Unexpected character '${ch}' at ${index}`);
  }

  tokens.push({ type: 'eof', text: '', start: input.length, end: input.length });
  return tokens;
}
