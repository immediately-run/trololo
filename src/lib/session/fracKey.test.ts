import { describe, expect, it } from 'vitest';
import {
  generateKeyBetween,
  generateNKeysBetween,
  isValidKey,
  jitter,
  keyBetween,
  keyForDrop,
  MAX_KEY_LENGTH,
  rebalancedKeys,
} from './fracKey';

// The library's own vectors, verbatim from rocicorp/fractional-indexing v3.2.0 src/test.js.
const attempt = (f: () => string) => {
  try {
    return f();
  } catch (e) {
    return (e as Error).message;
  }
};

describe('vendored fractional-indexing 3.2.0 — the library test vectors', () => {
  it.each([
    [null, null, 'a0'],
    [null, 'a0', 'Zz'],
    [null, 'Zz', 'Zy'],
    ['a0', null, 'a1'],
    ['a1', null, 'a2'],
    ['a0', 'a1', 'a0V'],
    ['a1', 'a2', 'a1V'],
    ['a0V', 'a1', 'a0l'],
    ['Zz', 'a0', 'ZzV'],
    ['Zz', 'a1', 'a0'],
    [null, 'Y00', 'Xzzz'],
    ['bzz', null, 'c000'],
    ['a0', 'a0V', 'a0G'],
    ['a0', 'a0G', 'a08'],
    ['b125', 'b129', 'b127'],
    ['a0', 'a1V', 'a1'],
    ['Zz', 'a01', 'a0'],
    [null, 'a0V', 'a0'],
    [null, 'b999', 'b99'],
    [null, 'A00000000000000000000000000', 'invalid order key: A00000000000000000000000000'],
    [null, 'A000000000000000000000000001', 'A000000000000000000000000000V'],
    ['zzzzzzzzzzzzzzzzzzzzzzzzzzy', null, 'zzzzzzzzzzzzzzzzzzzzzzzzzzz'],
    ['zzzzzzzzzzzzzzzzzzzzzzzzzzz', null, 'zzzzzzzzzzzzzzzzzzzzzzzzzzzV'],
    ['a00', null, 'invalid order key: a00'],
    ['a00', 'a1', 'invalid order key: a00'],
    ['0', '1', 'invalid order key head: 0'],
    ['a1', 'a0', 'a1 >= a0'],
  ])('generateKeyBetween(%s, %s) = %s', (a, b, exp) => {
    expect(attempt(() => generateKeyBetween(a, b))).toBe(exp);
  });

  it.each([
    [null, null, 5, 'a0 a1 a2 a3 a4'],
    ['a4', null, 10, 'a5 a6 a7 a8 a9 b00 b01 b02 b03 b04'],
    [null, 'a0', 5, 'Z5 Z6 Z7 Z8 Z9'],
    ['a0', 'a2', 20, 'a01 a02 a03 a035 a04 a05 a06 a07 a08 a09 a1 a11 a12 a13 a14 a15 a16 a17 a18 a19'],
  ])('generateNKeysBetween(%s, %s, %i) base 10', (a, b, n, exp) => {
    expect(attempt(() => generateNKeysBetween(a, b, n, '0123456789').join(' '))).toBe(exp);
  });

  const BASE_95 =
    " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
  it.each([
    ['a00', 'a01', 'a00P'],
    ['a0/', 'a00', 'a0/P'],
    [null, null, 'a '],
    ['a ', null, 'a!'],
    [null, 'a ', 'Z~'],
    ['a0 ', 'a0!', 'invalid order key: a0 '],
    [null, 'A                          0', 'A                          ('],
    ['a~', null, 'b  '],
    ['Z~', null, 'a '],
    ['b   ', null, 'invalid order key: b   '],
    ['a0', 'a0V', 'a0;'],
    ['a  1', 'a  2', 'a  1P'],
    [null, 'A                          ', 'invalid order key: A                          '],
  ])('generateKeyBetween(%j, %j) base 95 = %j', (a, b, exp) => {
    expect(attempt(() => generateKeyBetween(a, b, BASE_95))).toBe(exp);
  });
});

describe('§3.4 keys', () => {
  let n = 0;
  const random = (k: number) => (n = (n * 31 + 7) % 9973) % k;

  it('validity: 1–128 characters, a valid head and integer part, no trailing zero', () => {
    expect(isValidKey('a0')).toBe(true);
    expect(isValidKey('a0V')).toBe(true);
    expect(isValidKey('a')).toBe(false);
    expect(isValidKey('a00')).toBe(false);
    expect(isValidKey('a0 ')).toBe(false);
    expect(isValidKey('')).toBe(false);
    expect(isValidKey('a0' + 'V'.repeat(MAX_KEY_LENGTH - 2))).toBe(true);
    expect(isValidKey('a0' + 'V'.repeat(MAX_KEY_LENGTH - 1))).toBe(false);
  });

  it('jitter is three digits whose last is not 0', () => {
    for (let i = 0; i < 200; i++) {
      const j = jitter(random);
      expect(j).toMatch(/^[0-9A-Za-z]{2}[1-9A-Za-z]$/);
    }
  });

  it('a jittered key stays strictly between its neighbours, including when the library returns a prefix of next', () => {
    for (const [a, b] of [
      [null, 'a0V'],
      ['a0', 'a1'],
      [null, null],
      ['a0', null],
      ['Zz', 'a0'],
    ] as Array<[string | null, string | null]>) {
      for (let i = 0; i < 50; i++) {
        const k = keyBetween(a, b, random)!;
        expect(isValidKey(k)).toBe(true);
        if (a !== null) expect(a < k).toBe(true);
        if (b !== null) expect(k < b).toBe(true);
      }
    }
  });

  it('equal neighbours: the new key lands after both, before the next strictly greater key', () => {
    const k = keyForDrop(['a0', 'a1', 'a1', 'a2'], 2, random)!;
    expect(k > 'a1').toBe(true);
    expect(k < 'a2').toBe(true);
    const end = keyForDrop(['a1', 'a1'], 1, random)!;
    expect(end > 'a1').toBe(true);
  });

  it('a key over the budget is refused (the app proposes an attended rebalancing)', () => {
    const long = 'a0' + 'V'.repeat(MAX_KEY_LENGTH - 3) + 'W';
    const longer = 'a0' + 'V'.repeat(MAX_KEY_LENGTH - 3) + 'X';
    expect(keyBetween(long, longer, random)).toBeNull();
  });

  it('rebalancing gives evenly spaced fresh keys', () => {
    expect(rebalancedKeys(3)).toEqual(['a0', 'a1', 'a2']);
  });
});
