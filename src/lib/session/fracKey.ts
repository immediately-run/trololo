// Fractional keys (COLLABORATION_SESSIONS §3.4).
//
// The first part of this file is VENDORED from rocicorp `fractional-indexing` 3.2.0
// (https://github.com/rocicorp/fractional-indexing, src/index.js), converted to TypeScript with
// no behavioural change. Its header, kept verbatim:
//
//   // License: CC0 (no rights reserved).
//
//   // This is based on https://observablehq.com/@dgreensp/implementing-fractional-indexing
//
// 3.2.0 is pinned on purpose: 4.x accepts its bounds in either order (it swaps them), and the
// spec relies on the classic `a >= b` refusal. `fracKey.test.ts` runs the library's own vectors.
//
// The second part — jitter, validity, equal neighbours, the length budget — is this repo's.

export const BASE_62_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// `a` may be empty string, `b` is null or non-empty string.
// `a < b` lexicographically if `b` is non-null.
// no trailing zeros allowed.
// digits is a string such as '0123456789' for base 10.  Digits must be in
// ascending character code order!
function midpoint(a: string, b: string | null | undefined, digits: string): string {
  const zero = digits[0];
  if (b != null && a >= b) {
    throw new Error(a + ' >= ' + b);
  }
  if (a.slice(-1) === zero || (b && b.slice(-1) === zero)) {
    throw new Error('trailing zero');
  }
  if (b) {
    // remove longest common prefix.  pad `a` with 0s as we
    // go.  note that we don't need to pad `b`, because it can't
    // end before `a` while traversing the common prefix.
    let n = 0;
    while ((a[n] || zero) === b[n]) {
      n++;
    }
    if (n > 0) {
      return b.slice(0, n) + midpoint(a.slice(n), b.slice(n), digits);
    }
  }
  // first digits (or lack of digit) are different
  const digitA = a ? digits.indexOf(a[0]) : 0;
  const digitB = b != null ? digits.indexOf(b[0]) : digits.length;
  if (digitB - digitA > 1) {
    const midDigit = Math.round(0.5 * (digitA + digitB));
    return digits[midDigit];
  } else {
    // first digits are consecutive
    if (b && b.length > 1) {
      return b.slice(0, 1);
    } else {
      // `b` is null or has length 1 (a single digit).
      // the first digit of `a` is the previous digit to `b`,
      // or 9 if `b` is null.
      // given, for example, midpoint('49', '5'), return
      // '4' + midpoint('9', null), which will become
      // '4' + '9' + midpoint('', null), which is '495'
      return digits[digitA] + midpoint(a.slice(1), null, digits);
    }
  }
}

function validateInteger(int: string): void {
  if (int.length !== getIntegerLength(int[0])) {
    throw new Error('invalid integer part of order key: ' + int);
  }
}

function getIntegerLength(head: string): number {
  if (head >= 'a' && head <= 'z') {
    return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  } else if (head >= 'A' && head <= 'Z') {
    return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  } else {
    throw new Error('invalid order key head: ' + head);
  }
}

function getIntegerPart(key: string): string {
  const integerPartLength = getIntegerLength(key[0]);
  if (integerPartLength > key.length) {
    throw new Error('invalid order key: ' + key);
  }
  return key.slice(0, integerPartLength);
}

function validateOrderKey(key: string, digits: string): void {
  if (key === 'A' + digits[0].repeat(26)) {
    throw new Error('invalid order key: ' + key);
  }
  // getIntegerPart will throw if the first character is bad,
  // or the key is too short.  we'd call it to check these things
  // even if we didn't need the result
  const i = getIntegerPart(key);
  const f = key.slice(i.length);
  if (f.slice(-1) === digits[0]) {
    throw new Error('invalid order key: ' + key);
  }
}

// note that this may return null, as there is a largest integer
function incrementInteger(x: string, digits: string): string | null {
  validateInteger(x);
  const [head, ...digs] = x.split('');
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) + 1;
    if (d === digits.length) {
      digs[i] = digits[0];
    } else {
      digs[i] = digits[d];
      carry = false;
    }
  }
  if (carry) {
    if (head === 'Z') {
      return 'a' + digits[0];
    }
    if (head === 'z') {
      return null;
    }
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    if (h > 'a') {
      digs.push(digits[0]);
    } else {
      digs.pop();
    }
    return h + digs.join('');
  } else {
    return head + digs.join('');
  }
}

// note that this may return null, as there is a smallest integer
function decrementInteger(x: string, digits: string): string | null {
  validateInteger(x);
  const [head, ...digs] = x.split('');
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) - 1;
    if (d === -1) {
      digs[i] = digits.slice(-1);
    } else {
      digs[i] = digits[d];
      borrow = false;
    }
  }
  if (borrow) {
    if (head === 'a') {
      return 'Z' + digits.slice(-1);
    }
    if (head === 'A') {
      return null;
    }
    const h = String.fromCharCode(head.charCodeAt(0) - 1);
    if (h < 'Z') {
      digs.push(digits.slice(-1));
    } else {
      digs.pop();
    }
    return h + digs.join('');
  } else {
    return head + digs.join('');
  }
}

// `a` is an order key or null (START).
// `b` is an order key or null (END).
// `a < b` lexicographically if both are non-null.
// digits is a string such as '0123456789' for base 10.  Digits must be in
// ascending character code order!
export function generateKeyBetween(
  a: string | null | undefined,
  b: string | null | undefined,
  digits: string = BASE_62_DIGITS,
): string {
  if (a != null) {
    validateOrderKey(a, digits);
  }
  if (b != null) {
    validateOrderKey(b, digits);
  }
  if (a != null && b != null && a >= b) {
    throw new Error(a + ' >= ' + b);
  }
  if (a == null) {
    if (b == null) {
      return 'a' + digits[0];
    }

    const ib = getIntegerPart(b);
    const fb = b.slice(ib.length);
    if (ib === 'A' + digits[0].repeat(26)) {
      return ib + midpoint('', fb, digits);
    }
    if (ib < b) {
      return ib;
    }
    const res = decrementInteger(ib, digits);
    if (res == null) {
      throw new Error('cannot decrement any more');
    }
    return res;
  }

  if (b == null) {
    const ia = getIntegerPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia, digits);
    return i == null ? ia + midpoint(fa, null, digits) : i;
  }

  const ia = getIntegerPart(a);
  const fa = a.slice(ia.length);
  const ib = getIntegerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) {
    return ia + midpoint(fa, fb, digits);
  }
  const i = incrementInteger(ia, digits);
  if (i == null) {
    throw new Error('cannot increment any more');
  }
  if (i < b) {
    return i;
  }
  return ia + midpoint(fa, null, digits);
}

// same preconditions as generateKeysBetween.
// n >= 0.
// Returns an array of n distinct keys in sorted order.
// If a and b are both null, returns [a0, a1, ...]
// If one or the other is null, returns consecutive "integer"
// keys.  Otherwise, returns relatively short keys between
// a and b.
export function generateNKeysBetween(
  a: string | null | undefined,
  b: string | null | undefined,
  n: number,
  digits: string = BASE_62_DIGITS,
): string[] {
  if (n === 0) {
    return [];
  }
  if (n === 1) {
    return [generateKeyBetween(a, b, digits)];
  }
  if (b == null) {
    let c = generateKeyBetween(a, b, digits);
    const result = [c];
    for (let i = 0; i < n - 1; i++) {
      c = generateKeyBetween(c, b, digits);
      result.push(c);
    }
    return result;
  }
  if (a == null) {
    let c = generateKeyBetween(a, b, digits);
    const result = [c];
    for (let i = 0; i < n - 1; i++) {
      c = generateKeyBetween(a, c, digits);
      result.push(c);
    }
    result.reverse();
    return result;
  }
  const mid = Math.floor(n / 2);
  const c = generateKeyBetween(a, b, digits);
  return [
    ...generateNKeysBetween(a, c, mid, digits),
    c,
    ...generateNKeysBetween(c, b, n - mid - 1, digits),
  ];
}

// ---------------------------------------------------------------------------------------------
// This repo's part (§3.4).

/** The length budget: a longer key asks for an attended rebalancing instead. */
export const MAX_KEY_LENGTH = 128;

/** A key is valid iff it is 1–128 characters and passes the library's key validation. */
export function isValidKey(key: string): boolean {
  if (key.length < 1 || key.length > MAX_KEY_LENGTH) return false;
  for (const ch of key) if (!BASE_62_DIGITS.includes(ch)) return false;
  try {
    validateOrderKey(key, BASE_62_DIGITS);
    return true;
  } catch {
    return false;
  }
}

/** A source of random integers in `[0, n)`; injected so the engine stays deterministic in tests. */
export type RandomInt = (n: number) => number;

/** Three random digits whose last is not `0`, so the jittered key stays valid. */
export function jitter(random: RandomInt): string {
  const d = BASE_62_DIGITS;
  return d[random(62)] + d[random(62)] + d[1 + random(61)];
}

/**
 * A new key strictly between `prev` and `next` (either may be null for an open end), jittered.
 * `prev` must be less than `next`. Returns null when the key would exceed the length budget —
 * the caller then proposes an attended rebalancing (never an automatic one).
 */
export function keyBetween(prev: string | null, next: string | null, random: RandomInt): string | null {
  let k = generateKeyBetween(prev, next);
  // The library may return a proper prefix of `next` (e.g. between null and "a0V" it returns
  // "a0"); a suffix would then sort after `next`. Narrow toward `next` until the jittered key
  // stays below it.
  for (;;) {
    const j = k + jitter(random);
    if (next === null || j < next) return j.length > MAX_KEY_LENGTH ? null : j;
    k = generateKeyBetween(k, next);
  }
}

/**
 * The key for an item dropped at `index` of a list whose current keys are `sorted` (ascending,
 * the item itself excluded): it lands after `sorted[index - 1]` and before `sorted[index]`.
 * Equal neighbours (§3.4): the new key goes between the lower one and the next strictly greater
 * key, so the item lands after both.
 */
export function keyForDrop(sorted: readonly string[], index: number, random: RandomInt): string | null {
  const prev = index > 0 ? sorted[index - 1] : null;
  let next: string | null = index < sorted.length ? sorted[index] : null;
  if (prev !== null && next !== null && next <= prev) {
    next = null;
    for (let i = index; i < sorted.length; i++) {
      if (sorted[i] > prev) {
        next = sorted[i];
        break;
      }
    }
  }
  return keyBetween(prev, next, random);
}

/** Evenly spaced fresh keys for an attended rebalancing of a list of `n` items. */
export function rebalancedKeys(n: number): string[] {
  return generateNKeysBetween(null, null, n);
}
