import { describe, expect, test } from 'vitest';
import { assertVoiceText, formatReviewText } from '../src/voice-text.js';

describe('assertVoiceText', () => {
  test.each(['', ' ', '\t\r\n', '\u00a0'])('rejects empty or whitespace-only text %j', (text) => {
    expect(() => assertVoiceText(text)).toThrow();
  });

  test('accepts Spanish text and newlines without modifying it', () => {
    const text = '¡No cambies el número!\nMañana serán 42.';
    expect(() => assertVoiceText(text)).not.toThrow();
    expect(formatReviewText(text)).toBe(text);
  });

  test('accepts exactly 2000 Unicode code points including astral characters', () => {
    expect(() => assertVoiceText('😀'.repeat(2000))).not.toThrow();
  });

  test('rejects 2001 Unicode code points rather than truncating', () => {
    expect(() => assertVoiceText('😀'.repeat(2001))).toThrow();
    expect(() => assertVoiceText('a'.repeat(2001))).toThrow();
  });
});

describe('formatReviewText', () => {
  test('escapes terminal and bidi controls while retaining the original text', () => {
    const text = 'a\x1b[2J\r\u202eb';
    expect(formatReviewText('a\x1b[2J\r\u202eb')).toBe('a\\u001b[2J\\u000d\\u202eb');
    expect(text).toBe('a\x1b[2J\r\u202eb');
  });

  test.each([
    ['\u0000\u0009\u000b\u001f', '\\u0000\\u0009\\u000b\\u001f'],
    ['\u007f\u0080\u009f', '\\u007f\\u0080\\u009f'],
    ['\u202a\u202b\u202c\u202d\u202e', '\\u202a\\u202b\\u202c\\u202d\\u202e'],
    ['\u2066\u2067\u2068\u2069', '\\u2066\\u2067\\u2068\\u2069'],
  ])('renders control group %j as lowercase Unicode escapes', (text, expected) => {
    expect(formatReviewText(text)).toBe(expected);
  });

  test('leaves newlines and non-control Unicode intact', () => {
    const text = 'Español: acción, niño 😀\n`C:\\proyecto`\u2029\u202f\u2065\u206a';
    expect(formatReviewText(text)).toBe(text);
    expect(formatReviewText('')).toBe('');
  });
});
