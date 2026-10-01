import { randomUUID } from 'node:crypto';

export type ProtectedLiterals = {
  maskedText: string;
  hasProse: boolean;
  literals: readonly { placeholder: string; value: string }[];
};

function runEnd(text: string, start: number): number {
  let end = start;
  while (text[end] === '`') end++;
  return end;
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  while (text[index - slashes - 1] === '\\') slashes++;
  return slashes % 2 === 1;
}

function readLine(text: string, start: number): { content: string; end: number } {
  let end = start;
  while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end++;
  const content = text.slice(start, end);
  if (text[end] === '\r') end++;
  if (text[end] === '\n') end++;
  return { content, end };
}

function fenceEnd(text: string, start: number, length: number): number {
  let cursor = readLine(text, start).end;
  while (cursor < text.length) {
    const line = readLine(text, cursor);
    const closing = /^ {0,3}(`{3,})[ \t]*$/.exec(line.content);
    if (closing && closing[1].length >= length) return line.end;
    cursor = line.end;
  }
  throw new Error('Unclosed backtick fence');
}

function inlineEnd(text: string, start: number): number {
  const openingEnd = runEnd(text, start);
  const length = openingEnd - start;
  let cursor = openingEnd;
  while (cursor < text.length) {
    if (text[cursor] !== '`') {
      cursor++;
      continue;
    }
    const end = runEnd(text, cursor);
    if (end - cursor === length) return end;
    cursor = end;
  }
  throw new Error('Unclosed inline backtick literal');
}

export function protectLiterals(text: string, createNonce: () => string = randomUUID): ProtectedLiterals {
  let namespace: string;
  do {
    namespace = `__PVB_${createNonce()}_`;
  } while (text.includes(namespace));

  const literals: { placeholder: string; value: string }[] = [];
  const parts: string[] = [];
  let hasProse = false;
  let proseStart = 0;
  let cursor = 0;
  while (cursor < text.length) {
    let end: number | undefined;
    const atLineStart = cursor === 0 || text[cursor - 1] === '\n' || text[cursor - 1] === '\r';
    if (atLineStart) {
      const opening = /^ {0,3}(`{3,})([^\r\n]*)/.exec(text.slice(cursor));
      if (opening) {
        if (opening[2].includes('`')) throw new Error('Invalid backtick fence information');
        end = fenceEnd(text, cursor, opening[1].length);
      }
    }
    if (end === undefined && text[cursor] === '`') {
      if (isEscaped(text, cursor)) {
        cursor = runEnd(text, cursor);
        continue;
      }
      end = inlineEnd(text, cursor);
    }
    if (end === undefined) {
      cursor++;
      continue;
    }

    const prose = text.slice(proseStart, cursor);
    hasProse ||= prose.trim().length > 0;
    const placeholder = `${namespace}${literals.length}__`;
    parts.push(prose, placeholder);
    literals.push({ placeholder, value: text.slice(cursor, end) });
    cursor = end;
    proseStart = end;
  }
  const prose = text.slice(proseStart);
  hasProse ||= prose.trim().length > 0;
  parts.push(prose);
  return { maskedText: parts.join(''), hasProse, literals };
}

export function restoreLiterals(translated: string, protectedText: ProtectedLiterals): string {
  const { literals } = protectedText;
  if (literals.length === 0) return translated;
  // The first generated marker always ends in "0__". Use literal string
  // matching so even an injected nonce cannot change the validation grammar.
  const namespace = literals[0].placeholder.slice(0, -3);
  const positions: number[] = [];
  let cursor = 0;
  for (const literal of literals) {
    const position = translated.indexOf(namespace, cursor);
    if (position === -1 || !translated.startsWith(literal.placeholder, position)) {
      throw new Error('Missing, unknown or reordered literal placeholder');
    }
    positions.push(position);
    cursor = position + literal.placeholder.length;
  }
  if (translated.indexOf(namespace, cursor) !== -1) {
    throw new Error('Duplicate or unknown literal placeholder');
  }

  // Validate every marker before inserting any source bytes. Never rescan
  // restored literals as translated text or interpret their content.
  const parts: string[] = [];
  cursor = 0;
  for (let index = 0; index < literals.length; index++) {
    const literal = literals[index];
    parts.push(translated.slice(cursor, positions[index]), literal.value);
    cursor = positions[index] + literal.placeholder.length;
  }
  parts.push(translated.slice(cursor));
  return parts.join('');
}
